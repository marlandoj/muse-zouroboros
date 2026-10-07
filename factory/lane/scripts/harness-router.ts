#!/usr/bin/env bun
/**
 * ZOU-436 SF-P3 — Multi-harness router for the SF-003 coder pool.
 *
 * The pool currently rotates /zo/ask MODELS (pool-worker.ts MODEL_FALLBACK_CHAIN).
 * ECC-007 shipped an executor registry + ACP transport (packages/zo-swarm-orchestrator) that makes
 * real coder HARNESSES — Claude Code, OpenCode, Codex, Gemini, Pi, and Kimi —
 * dispatchable. This module
 * is the pure routing + health-preflight seam that pool-worker.ts wires in behind
 * SF_MULTI_HARNESS (advisory) / SF_MULTI_HARNESS_ENFORCE (real dispatch).
 *
 * Pure by construction: selectHarness takes an INJECTED healthProbe, so the selftest
 * runs fully hermetic (fake probe, zero binaries/network/spend). defaultHealthProbe()
 * is the only real-binary seam — it lazy-imports ExecutorClient so importing this
 * module costs nothing.
 */

import { join } from "node:path";
import { enterFactoryExecutorGuard, loadHostResourcePolicy, waitForMemoryHeadroom } from "./host-resource-guard";
import { readSharedCatalog, selectShared } from "../../../packages/zo-swarm-orchestrator/src/routing/shared-catalog";

/** Every coder harness the factory is allowed to dispatch to. */
export const KNOWN_CODER_HARNESSES: ReadonlyArray<string> = [
  "claude-code",
  "opencode",
  "codex",
  "gemini",
  "pi",
  "kimi",
];

/**
 * Parse `SF_EXEC_HARNESS_CHAIN` — a project Model Policy's executor pin.
 *
 * A tiered Model Policy can choose the consensus lineup but not who writes the
 * code: `coderHarnessChain()` hard-orders capability first, so an open-weights
 * project still gets its implementation from the frontier harness at the head of
 * the chain. This knob closes that gap by letting a per-run policy reorder (or
 * narrow) the chain.
 *
 * Bounded by construction: ids are matched against KNOWN_CODER_HARNESSES, so a
 * typo or an injected value can never dispatch to an unregistered executor. An
 * unset, empty, or fully-invalid value returns null and the caller keeps the
 * governed six-harness default chain.
 */
export function parseHarnessChainOverride(value: string | undefined): ReadonlyArray<string> | null {
  if (typeof value !== "string") return null;
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const id = part.trim();
    if (id && KNOWN_CODER_HARNESSES.includes(id)) seen.add(id);
  }
  return seen.size > 0 ? [...seen] : null;
}

/** Coder harnesses with `code-generation` expertise, in the governed failover order. */
export function coderHarnessChain(
  env: Record<string, string | undefined> = process.env,
): ReadonlyArray<string> {
  const pinned = parseHarnessChainOverride(env.SF_EXEC_HARNESS_CHAIN);
  if (pinned) return pinned;
  return [...KNOWN_CODER_HARNESSES];
}

export const CODER_HARNESS_CHAIN: ReadonlyArray<string> = coderHarnessChain();

export interface HealthResult {
  healthy: boolean;
  message: string;
}

/** Probes one executor's health. Injected in tests; real seam = defaultHealthProbe(). */
export type HealthProbe = (executorId: string) => Promise<HealthResult>;

export interface HarnessCandidate {
  id: string;
  healthy: boolean;
  message: string;
  reason: "selected" | "unhealthy";
}

export interface HarnessDecision {
  selected: string | null;
  candidates: HarnessCandidate[];
  fellBackToAsk: boolean;
  attempt: number;
}

/** Clamp attempt to a valid chain index; non-finite (NaN/±Inf) coerces to 0. */
function clampAttemptIndex(attempt: number, len: number): number {
  const a = Number.isFinite(attempt) ? Math.trunc(attempt) : 0;
  return Math.min(Math.max(a, 0), len - 1);
}

/**
 * Attempt-indexed harness pick (clamped), mirroring pool-worker.ts modelForAttempt.
 * Pure — no health check. Use selectHarness for a health-aware decision.
 * Throws on an empty chain (a misconfiguration, never a runtime input).
 */
export function harnessForAttempt(attempt: number, chain: ReadonlyArray<string> = CODER_HARNESS_CHAIN): string {
  if (chain.length === 0) throw new Error("harnessForAttempt: empty harness chain");
  return chain[clampAttemptIndex(attempt, chain.length)];
}

/** Rotate the chain so the attempt's preferred harness is first, remainder follow (wrap). */
function chainFromAttempt(attempt: number, chain: ReadonlyArray<string>): string[] {
  if (chain.length === 0) return [];
  const start = clampAttemptIndex(attempt, chain.length);
  return [...chain.slice(start), ...chain.slice(0, start)];
}

export interface SelectHarnessArgs {
  attempt: number;
  healthProbe: HealthProbe;
  chain?: ReadonlyArray<string>;
}

/**
 * Health-aware harness selection. Walks the chain starting at the attempt's rung
 * (wrapping) and returns the FIRST healthy harness. Every harness probed before the
 * pick is recorded as `unhealthy`. If none is healthy, selected=null and
 * fellBackToAsk=true — the caller demotes to /zo/ask. Never throws: a probe that
 * rejects is treated as unhealthy so a flaky harness can never fail a task.
 */
export async function selectHarness(args: SelectHarnessArgs): Promise<HarnessDecision> {
  const chain = args.chain ?? CODER_HARNESS_CHAIN;
  const order = chainFromAttempt(args.attempt, chain);
  const candidates: HarnessCandidate[] = [];

  for (const id of order) {
    let health: HealthResult;
    try {
      health = await args.healthProbe(id);
    } catch (e) {
      health = { healthy: false, message: `probe threw: ${(e as Error).message}` };
    }
    if (health.healthy) {
      candidates.push({ id, healthy: true, message: health.message, reason: "selected" });
      return { selected: id, candidates, fellBackToAsk: false, attempt: args.attempt };
    }
    candidates.push({ id, healthy: false, message: health.message, reason: "unhealthy" });
  }

  return { selected: null, candidates, fellBackToAsk: true, attempt: args.attempt };
}

// ─── Real-binary seam (lazy) ────────────────────────────────────────────────────

// Fixed repo-relative paths into packages/zo-swarm-orchestrator. NOT env-derived on purpose: the
// executor-client path is fed to a dynamic import(), so an env-controlled path would
// be an arbitrary-module-load / RCE surface. The module's location is a fixed repo
// fact, not an operator knob.
const SWARM_SRC_DIR = join(import.meta.dir, "..", "..", "..", "packages", "swarm", "src");

export function swarmRuntimeRoot(): string {
  return join(SWARM_SRC_DIR, "..", "..", "..");
}

/**
 * Repo-relative path to executor-registry.json. Exported so SF-P4's
 * expertise-router loads the SAME RCE-safe path (never env-derived — see the
 * SWARM_SRC_DIR note above).
 */
export function swarmRegistryPath(): string {
  return join(SWARM_SRC_DIR, "executor", "registry", "executor-registry.json");
}

function swarmExecutorClientPath(): string {
  return join(SWARM_SRC_DIR, "client", "executor-client.ts");
}

/**
 * The real health probe: lazy-imports ExecutorClient from packages/zo-swarm-orchestrator source
 * (Bun runs the TS directly — no dist needed) and calls .health(), which for ACP
 * executors is a cheap side-effect-free `which <bin>` (it does NOT start a session).
 * Any failure to import/instantiate/probe is folded into { healthy:false }.
 */
export function defaultHealthProbe(): HealthProbe {
  const registryPath = swarmRegistryPath();
  const ecPath = swarmExecutorClientPath();
  const workspaceRoot = swarmRuntimeRoot();
  return async (executorId: string): Promise<HealthResult> => {
    try {
      const mod = (await import(ecPath)) as {
        ExecutorClient: { for(id: string, opts: { registryPath: string; workspaceRoot?: string }): Promise<{ health(): Promise<HealthResult>; dispose(): Promise<unknown> }> };
      };
      const client = await mod.ExecutorClient.for(executorId, { registryPath, workspaceRoot });
      try {
        return await client.health();
      } finally {
        await client.dispose().catch(() => {});
      }
    } catch (e) {
      return { healthy: false, message: `executor-client unavailable: ${(e as Error).message}` };
    }
  };
}

// ─── Real dispatch seam (lazy) — used ONLY under SF_MULTI_HARNESS_ENFORCE ─────────

export interface HarnessRunResult {
  output: string;
  success: boolean;
  executorId: string;
  durationMs: number;
  failureKind?: "transport" | "execution";
  failureDetail?: string;
  modelUsed?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  modelProvenance?: {
    harness: string;
    requestedProvider?: string;
    requestedModel?: string;
    resolvedModel?: string;
    modelFamily?: string;
    servingProvider?: string;
    endpointClass?: string;
    credentialEnvironment?: string;
  };
}

export function classifyHarnessFailureDetail(detail: string): "transport" | "execution" {
  const message = detail.trim();
  if (
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up)\b/i.test(message)
    || /\bACP (?:session (?:idle )?timed out|adapter exited|session error)\b/i.test(message)
    || /\bFailed to spawn process\b/i.test(message)
    || /\b(?:408\s+Request Timeout|500\s+Internal Server Error|502\s+Bad Gateway|503\s+Service Unavailable|504\s+Gateway Timeout|529\s+(?:Site )?Overloaded)\b/i.test(message)
  ) {
    return "transport";
  }
  return "execution";
}

export interface HarnessRunOptions {
  workdir?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  env?: Record<string, string>;
  onOutput?: (text: string) => void;
  /**
   * F-002: invoked exactly when the harness executor actually launches (memory
   * gates passed, ExecutorClient created, about to run). Lets the dispatcher
   * stamp harness start so a later reclaim can tell "dispatched" apart from
   * "claimed but never launched". Called synchronously before client.run; a
   * throw fails the dispatch before any launch happened.
   */
  onLaunch?: (info: { executorId: string }) => void;
}

/**
 * Dispatch a prompt through a real coder harness via ExecutorClient.run. Spawns a
 * REAL agent (spends, edits workdir) — callers MUST gate this behind
 * SF_MULTI_HARNESS_ENFORCE and fall back to /zo/ask on any throw.
 *
 * opts.onOutput is the Observation Deck live tap: it receives streamed text
 * chunks as the executor produces them (ACP transports only; end-only
 * transports never call it). Non-text session updates (tool calls, progress)
 * arrive as single bracketed lines so a raw tail of the tee'd log reads as a
 * narrative. Observer errors are swallowed — a broken tap never fails a run.
 */
export async function runHarness(
  executorId: string,
  prompt: string,
  opts: HarnessRunOptions = {},
): Promise<HarnessRunResult> {
  // Preserve explicit per-run model/provider pins. Automatic escalation requires
  // evidence through this consumer's ACP route, not a chat or bridge-only pass.
  if (!opts.env?.SWARM_RESOLVED_MODEL && readSharedCatalog()) {
    const route = selectShared('factory', { harness: executorId })[0];
    if (!route) throw new Error(`No qualified native Factory route for ${executorId}`);
    opts = { ...opts, env: { ...opts.env, SWARM_RESOLVED_MODEL: route.model } };
  }
  const registryPath = swarmRegistryPath();
  const ecPath = swarmExecutorClientPath();
  const workspaceRoot = swarmRuntimeRoot();
  // Bounded memory-headroom wait: on this shared-memory container the floor
  // is flaky because MemAvailable swings with other tenants. Wait for a
  // passing reading (bounded, explicit timeout) instead of failing the
  // first dispatch that samples a low moment. The floor itself is unchanged.
  const memoryWaitMs = Number(process.env.FACTORY_MEMORY_WAIT_MS);
  const policy = loadHostResourcePolicy();
  await waitForMemoryHeadroom({
    policy,
    timeoutMs: Number.isFinite(memoryWaitMs) && memoryWaitMs > 0 ? memoryWaitMs : 120_000,
  }).catch((error) => {
    throw error;
  });
  const guard = enterFactoryExecutorGuard();
  type Update = { type: string; content: string; timestamp: number };
  type Client = {
    run(
      prompt: string,
      opts: { workdir?: string; timeoutMs?: number; idleTimeoutMs?: number; env?: Record<string, string>; onUpdate?: (u: Update) => void },
    ): Promise<{
      output: string;
      success: boolean;
      executorId: string;
      durationMs: number;
      raw: {
        error?: string;
        modelUsed?: string;
        tokensUsed?: number;
        inputTokens?: number;
        outputTokens?: number;
        costUsd?: number;
        modelProvenance?: HarnessRunResult["modelProvenance"];
      };
    }>;
    dispose(): Promise<unknown>;
  };
  type ExecutorClientModule = {
    ExecutorClient: {
      for(id: string, opts: { registryPath: string; workspaceRoot?: string }): Promise<Client>;
    };
  };
  let client: Client | null = null;
  try {
    const mod = (await import(ecPath)) as ExecutorClientModule;
    client = await mod.ExecutorClient.for(executorId, { registryPath, workspaceRoot });
    const tap = opts.onOutput;
    const onUpdate = tap
      ? (u: Update) => {
          try {
            tap(u.type === "text" ? u.content : `\n[${u.type}] ${u.content}\n`);
          } catch {
            // observation must never fail the run
          }
        }
      : undefined;
    // F-002: the memory gates passed and the executor is about to launch —
    // stamp harness start now, before any launch, so a later reclaim can
    // distinguish "dispatched" from "claimed but never launched".
    opts.onLaunch?.({ executorId });
    const r = await client.run(prompt, {
      workdir: opts.workdir,
      timeoutMs: opts.timeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      env: { ...(opts.env ?? {}), ...guard.executorEnv },
      onUpdate,
    });
    const rawFailure = r.success ? undefined : r.raw.error;
    const failureDetail = r.success ? undefined : rawFailure ?? r.output;
    return {
      output: r.output,
      success: r.success,
      executorId: r.executorId,
      durationMs: r.durationMs,
      failureKind: r.success ? undefined : rawFailure ? classifyHarnessFailureDetail(rawFailure) : "execution",
      failureDetail,
      modelUsed: r.raw.modelUsed,
      tokensUsed: r.raw.tokensUsed,
      inputTokens: r.raw.inputTokens,
      outputTokens: r.raw.outputTokens,
      costUsd: r.raw.costUsd,
      modelProvenance: r.raw.modelProvenance,
    };
  } finally {
    if (client) await client.dispose().catch(() => {});
    guard.lease.release();
  }
}
