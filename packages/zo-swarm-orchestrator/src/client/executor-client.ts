/**
 * ExecutorClient — RAG-enriched per-executor SDK
 *
 * Thin wrapper over ExecutorTransport that:
 *   1. Loads the executor entry from the registry
 *   2. Wires a CircuitBreaker + creates the correct transport
 *   3. Auto-enriches prompts with RAG context before dispatch
 *      (keyword-triggered by default, forceable via options.forceRAG)
 *
 * Usage:
 *   const client = await ExecutorClient.for('claude-code');
 *   const result = await client.run('Refactor the router to support streaming');
 */

import { randomUUID } from 'crypto';
import { isAbsolute, resolve } from 'node:path';
import { CircuitBreaker } from '../circuit/breaker.js';
import { loadRegistry, findExecutor } from '../registry/loader.js';
import { createTransport } from '../transport/factory.js';
import { enrichTaskWithRAG, shouldEnrichWithRAG } from '../rag/enrichment.js';
import { appendDecisionRow } from '../ledger/decision-ledger.js';
import type { ExecutorTransport, SessionUpdate } from '../transport/types.js';
import type { ExecutorRegistryEntry, Task, TaskResult } from '../types.js';

export interface ExecutorClientOptions {
  /** Persona identity for this call (seat-keyed). Default: 'alaric' (back-compat). */
  persona?: string;
  /** Model the harness should run. Execution metadata, passed to Task.model. */
  model?: string;
  /** Seat name when this call serves one seat of a panel/set. Enables seatDispatch recording. */
  seat?: string;
  /** Skip RAG enrichment entirely, even when keywords/forceRAG would trigger it. Unset = unchanged. */
  skipRAG?: boolean;
  /** Append one seat-keyed decision row per run to this JSONL ledger (G2). Also via env ZOUROBOROS_DECISION_LEDGER. Append failure throws (fail closed). */
  ledgerPath?: string;
  /** Correlation id for the ledger row. Default: the generated taskId. */
  traceId?: string;
  /** Force RAG enrichment even when keywords don't trigger it. Default: false */
  forceRAG?: boolean;
  /** Override RAG collections. Defaults to all 5 local collections. */
  ragCollections?: string[];
  /** RAG top-K results. Default: 5 */
  ragTopK?: number;
  /** Minimum RAG score threshold. Default: 0.65 */
  ragMinScore?: number;
  /** Task timeout in ms. Default: 120_000 */
  timeoutMs?: number;
  /** Cancel an ACP session after this long without a session update. */
  idleTimeoutMs?: number;
  /** Working directory passed to the executor. */
  workdir?: string;
  /** Custom env vars merged into executor env. */
  env?: Record<string, string>;
  /** Custom registry path override. */
  registryPath?: string;
  /** Root used to resolve registry-relative bridge and adapter script paths. */
  workspaceRoot?: string;
  /** Live-observation tap for streaming session updates (ACP transports only). */
  onUpdate?: (update: SessionUpdate) => void;
}

export interface RunResult {
  output: string;
  ragContext: string;
  ragPatterns: number;
  ragLatencyMs: number;
  executorId: string;
  taskId: string;
  persona: string;
  modelId?: string;
  seatDispatch: { enabled: boolean; bindings: Array<{ seat: string; harness: string; modelId?: string }> };
  success: boolean;
  durationMs: number;
  raw: TaskResult;
}

function resolveExecutorPaths(entry: ExecutorRegistryEntry, workspaceRoot?: string): ExecutorRegistryEntry {
  if (!workspaceRoot) return entry;
  const bridge = entry.bridge && !isAbsolute(entry.bridge)
    ? resolve(workspaceRoot, entry.bridge)
    : entry.bridge;
  const adapterArgs = entry.acp?.adapterBin === 'bash' && entry.acp.adapterArgs?.length
    ? entry.acp.adapterArgs.map((arg, index) => index === 0 && !isAbsolute(arg) && arg.includes('/')
      ? resolve(workspaceRoot, arg)
      : arg)
    : entry.acp?.adapterArgs;
  return {
    ...entry,
    ...(bridge ? { bridge } : {}),
    ...(entry.acp ? { acp: { ...entry.acp, ...(adapterArgs ? { adapterArgs } : {}) } } : {}),
  };
}

export class ExecutorClient {
  readonly executorId: string;

  private constructor(
    private readonly entry: ExecutorRegistryEntry,
    private readonly transport: ExecutorTransport,
  ) {
    this.executorId = entry.id;
  }

  /**
   * Create a client for the named executor.
   * Throws if the executor is not found in the registry.
   */
  static async for(
    executorId: string,
    opts: Pick<ExecutorClientOptions, 'registryPath' | 'workspaceRoot'> = {},
  ): Promise<ExecutorClient> {
    const registry = loadRegistry(opts.registryPath);
    const entry = findExecutor(registry, executorId);
    if (!entry) {
      const available = registry.executors.map(e => e.id).join(', ');
      throw new Error(
        `Executor '${executorId}' not found in registry. Available: ${available}`,
      );
    }
    const resolvedEntry = resolveExecutorPaths(entry, opts.workspaceRoot);
    const cb = new CircuitBreaker();
    const transport = createTransport(resolvedEntry, cb);
    return new ExecutorClient(resolvedEntry, transport);
  }

  /** Test-only factory — inject transport directly without loading the registry. */
  static _withTransport(entry: ExecutorRegistryEntry, transport: ExecutorTransport): ExecutorClient {
    return new ExecutorClient(entry, transport);
  }

  /** Convenience factories */
  static claudeCode(opts?: Pick<ExecutorClientOptions, 'registryPath' | 'workspaceRoot'>) {
    return ExecutorClient.for('claude-code', opts);
  }
  static codex(opts?: Pick<ExecutorClientOptions, 'registryPath' | 'workspaceRoot'>) {
    return ExecutorClient.for('codex', opts);
  }
  static gemini(opts?: Pick<ExecutorClientOptions, 'registryPath' | 'workspaceRoot'>) {
    return ExecutorClient.for('gemini', opts);
  }
  static hermes(opts?: Pick<ExecutorClientOptions, 'registryPath' | 'workspaceRoot'>) {
    return ExecutorClient.for('hermes', opts);
  }
  static openCode(opts?: Pick<ExecutorClientOptions, 'registryPath' | 'workspaceRoot'>) {
    return ExecutorClient.for('opencode', opts);
  }
  /**
   * Run a prompt through the executor with optional RAG enrichment.
   * RAG triggers automatically on keyword match unless forceRAG=true.
   */
  async run(prompt: string, opts: ExecutorClientOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const taskId = randomUUID();
    const persona = opts.persona ?? 'alaric';
    const seatDispatch = {
      enabled: Boolean(opts.seat),
      bindings: [{ seat: opts.seat ?? persona, harness: this.executorId, ...(opts.model ? { modelId: opts.model } : {}) }],
    };

    const shouldEnrich = !opts.skipRAG && (opts.forceRAG || shouldEnrichWithRAG(prompt));
    let ragContext = '';
    let ragPatterns = 0;
    let ragLatencyMs = 0;

    if (shouldEnrich) {
      const ragResult = await enrichTaskWithRAG(prompt, {
        collections: opts.ragCollections,
        topK: opts.ragTopK ?? 5,
        minScore: opts.ragMinScore ?? 0.65,
      });
      ragContext = ragResult.context;
      ragPatterns = ragResult.patterns;
      ragLatencyMs = ragResult.latencyMs;
    }

    const enrichedPrompt = ragContext ? `${ragContext}\n\n${prompt}` : prompt;

    const task: Task = {
      id: taskId,
      persona,
      task: enrichedPrompt,
      priority: 'medium',
      executor: this.executorId,
      ...(opts.model ? { model: opts.model } : {}),
      ragContext,
    };

    const result = await this.transport.execute(task, {
      timeoutMs: opts.timeoutMs ?? 120_000,
      idleTimeoutMs: opts.idleTimeoutMs,
      workdir: opts.workdir,
      env: opts.env,
      onUpdate: opts.onUpdate,
    });

    const durationMs = Date.now() - start;

    // G2: one ledger, written on the production path. When a ledger is
    // configured, persisting is part of the call — an append failure throws
    // rather than letting a decision vanish silently.
    const ledgerPath = opts.ledgerPath ?? process.env.ZOUROBOROS_DECISION_LEDGER;
    if (ledgerPath) {
      appendDecisionRow(ledgerPath, {
        traceId: opts.traceId ?? taskId,
        ...(opts.seat ? { seat: opts.seat } : {}),
        personaId: persona,
        harness: this.executorId,
        ...(opts.model ? { modelId: opts.model } : {}),
        status: result.success ? 'success' : 'failure',
        latencyMs: durationMs,
        seatDispatch,
      });
    }

    return {
      output: result.output ?? '',
      ragContext,
      ragPatterns,
      ragLatencyMs,
      executorId: this.executorId,
      taskId,
      persona,
      ...(opts.model ? { modelId: opts.model } : {}),
      seatDispatch,
      success: result.success,
      durationMs,
      raw: result,
    };
  }

  /** Health check passthrough. */
  async health() {
    return this.transport.healthCheck();
  }

  /** Release transport resources. */
  async dispose() {
    return this.transport.shutdown();
  }
}
