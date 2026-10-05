/**
 * ACPTransport — executes tasks via the Agent Client Protocol over stdio.
 *
 * Spawns the ACP adapter binary (e.g., claude-agent-acp) as a subprocess,
 * communicates via JSON-RPC 2.0 over stdio, and captures streaming session
 * updates for episode system integration.
 *
 * Security invariants (from seed spec):
 * - Per-task session isolation: newSession() per task, no session reuse
 * - setsid for process isolation
 * - Env scrubbing: CLAUDE_CODE_IS_LOGGED_IN etc stripped before spawn
 * - Tool allowlist passed via CLAUDE_AGENT_TOOLS env var at spawn time
 */

import { spawn, ChildProcess } from 'child_process';
import { Writable, Readable } from 'stream';
import type { Task, TaskResult, ExecutorRegistryEntry } from '../types.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import type {
  ExecutorTransport,
  TransportOptions,
  SessionUpdate,
  HealthStatus,
} from './types.js';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Client, Agent } from '@agentclientprotocol/sdk';
import type { SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { getWorkspaceRoot } from 'zouroboros-core';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { FileCassetteRecorder } from 'zouroboros-selfheal';
import {
  prepareFilesystemContainedSpawn,
  type AdapterSpawnSpec,
} from './agent-containment.js';
import { readManagedFactoryBoundary, prepareManagedFactorySpawn } from './factory-systemd-containment.js';
const managedAdapters = new WeakSet<ChildProcess>();

// Env vars to strip before spawning the ACP adapter (session detection suppression)
const SCRUBBED_ENV_VARS = [
  'CLAUDE_CODE_IS_LOGGED_IN',
  'ANTHROPIC_AUTH_TOKEN',
];

const CODEX_SKILL_BUDGET_WARNING_PREFIX =
  'Warning: Skill descriptions were shortened to fit the ';
const CODEX_SKILL_BUDGET_WARNING_SUFFIX =
  '% skills context budget. Codex can still see every skill, but some descriptions are shorter. ' +
  'Disable unused skills or plugins to leave more room for the rest.';

export function replayPathSegment(value: string): string {
  const prefix = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'id';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

export type { AdapterSpawnSpec } from './agent-containment.js';

interface ExecutorResourceCgroup {
  memoryDir: string;
  pidsDir: string;
  killAll(signal: NodeJS.Signals): void;
  cleanup(): boolean;
}

export interface ExecutorResourceUsage {
  memory_bytes: number;
  process_count: number;
  source: 'cgroup' | 'process-tree-pss' | 'process-tree-rss' | 'process-tree-mixed';
}

const adapterResourceGroups = new WeakMap<ChildProcess, ExecutorResourceCgroup>();

function guardedInteger(value: string | undefined, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function cgroupTaskPids(dir: string): number[] {
  try {
    return readFileSync(join(dir, 'cgroup.procs'), 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(pid => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function createExecutorResourceCgroup(env: Record<string, string>): ExecutorResourceCgroup | null {
  if (env.SWARM_EXEC_RESOURCE_GUARD_REQUIRED !== '1') return null;
  const memoryLimitMib = guardedInteger(
    env.SWARM_EXEC_MEMORY_LIMIT_MIB,
    'SWARM_EXEC_MEMORY_LIMIT_MIB',
    2_048,
    65_536,
  );
  const processLimit = guardedInteger(env.SWARM_EXEC_PROCESS_LIMIT, 'SWARM_EXEC_PROCESS_LIMIT', 16, 512);
  const token = `zouroboros-${process.pid}-${randomUUID()}`;
  const memoryDir = join('/sys/fs/cgroup/memory', token);
  const pidsDir = join('/sys/fs/cgroup/pids', token);
  let memoryCreated = false;
  let pidsCreated = false;
  try {
    mkdirSync(memoryDir, { mode: 0o700 });
    memoryCreated = true;
    mkdirSync(pidsDir, { mode: 0o700 });
    pidsCreated = true;
    writeFileSync(join(memoryDir, 'memory.limit_in_bytes'), String(memoryLimitMib * 1024 * 1024));
    writeFileSync(join(pidsDir, 'pids.max'), String(processLimit));
  } catch (error) {
    if (pidsCreated) {
      try { rmdirSync(pidsDir); } catch {}
    }
    if (memoryCreated) {
      try { rmdirSync(memoryDir); } catch {}
    }
    throw new Error(`failed to establish executor kernel cgroups: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    memoryDir,
    pidsDir,
    killAll(signal) {
      const pids = new Set([...cgroupTaskPids(memoryDir), ...cgroupTaskPids(pidsDir)]);
      for (const pid of pids) {
        try { process.kill(pid, signal); } catch {}
      }
    },
    cleanup() {
      let clean = true;
      for (const dir of [pidsDir, memoryDir]) {
        try {
          rmdirSync(dir);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') clean = false;
        }
      }
      return clean;
    },
  };
}

export function buildCgroupGuardedAdapterSpawn(
  spawnSpec: AdapterSpawnSpec,
  cgroup: Pick<ExecutorResourceCgroup, 'memoryDir' | 'pidsDir'>,
): AdapterSpawnSpec {
  const launcher = [
    'printf "%s\\n" "$$" > "$1" || exit 125',
    'printf "%s\\n" "$$" > "$2" || exit 125',
    'shift 2',
    'exec "$@"',
  ].join('\n');
  return {
    ...spawnSpec,
    command: '/bin/sh',
    args: [
      '-c',
      launcher,
      'zouroboros-resource-launcher',
      join(cgroup.memoryDir, 'cgroup.procs'),
      join(cgroup.pidsDir, 'cgroup.procs'),
      spawnSpec.command,
      ...spawnSpec.args,
    ],
  };
}

function scheduleResourceCgroupCleanup(cgroup: ExecutorResourceCgroup): void {
  let attempts = 0;
  const cleanup = () => {
    if (cgroup.cleanup()) return;
    attempts += 1;
    if (attempts < 20) setTimeout(cleanup, 250);
  };
  cleanup();
}

export function buildResourceGuardedAdapterSpawn(
  bin: string,
  args: string[],
  env: Record<string, string>,
): AdapterSpawnSpec {
  if (env.SWARM_EXEC_RESOURCE_GUARD_REQUIRED !== '1') {
    return { command: bin, args: [...args] };
  }
  guardedInteger(env.SWARM_EXEC_MEMORY_LIMIT_MIB, 'SWARM_EXEC_MEMORY_LIMIT_MIB', 2_048, 65_536);
  const nice = guardedInteger(env.SWARM_EXEC_NICE, 'SWARM_EXEC_NICE', 0, 19);
  const cpuSet = env.SWARM_EXEC_CPU_SET;
  if (!cpuSet || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpuSet)) {
    throw new Error('SWARM_EXEC_CPU_SET must be a comma-separated CPU or CPU-range list');
  }
  guardedInteger(env.SWARM_EXEC_PROCESS_LIMIT, 'SWARM_EXEC_PROCESS_LIMIT', 16, 512);
  return {
    command: '/usr/bin/taskset',
    args: ['-c', cpuSet, '/usr/bin/nice', '-n', String(nice), bin, ...args],
  };
}

function parseNonNegativeInteger(content: string, field: string): number {
  const value = Number(content.trim());
  if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${field}`);
  return value;
}

export function parseProcStatmRssBytes(content: string, pageSize = 4096): number {
  const fields = content.trim().split(/\s+/);
  const residentPages = Number(fields[1]);
  if (!Number.isFinite(residentPages) || residentPages < 0) {
    throw new Error('invalid /proc statm resident-page field');
  }
  return residentPages * pageSize;
}

export function parseProcSmapsRollupPssBytes(content: string): number {
  const match = content.match(/^Pss:\s+(\d+)\s+kB$/m);
  if (!match) throw new Error('invalid /proc smaps_rollup Pss field');
  return Number(match[1]) * 1024;
}

export function processTreeUsage(
  rootPid: number,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): ExecutorResourceUsage {
  const pending = [rootPid];
  const visited = new Set<number>();
  let memoryBytes = 0;
  let pssReads = 0;
  let rssReads = 0;
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (!Number.isInteger(pid) || pid <= 0 || visited.has(pid)) continue;
    visited.add(pid);
    try {
      memoryBytes += parseProcSmapsRollupPssBytes(readText(`/proc/${pid}/smaps_rollup`));
      pssReads += 1;
    } catch {
      try {
        memoryBytes += parseProcStatmRssBytes(readText(`/proc/${pid}/statm`));
        rssReads += 1;
      } catch {}
    }
    try {
      for (const child of readText(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/)) {
        if (child) pending.push(Number(child));
      }
    } catch {}
  }
  const source = pssReads > 0 && rssReads > 0
    ? 'process-tree-mixed'
    : pssReads > 0
      ? 'process-tree-pss'
      : 'process-tree-rss';
  return { memory_bytes: memoryBytes, process_count: visited.size, source };
}

export function readExecutorResourceUsage(
  rootPid: number,
  cgroup: Pick<ExecutorResourceCgroup, 'memoryDir' | 'pidsDir'> | null,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): ExecutorResourceUsage {
  if (cgroup) {
    try {
      return {
        memory_bytes: parseNonNegativeInteger(
          readText(join(cgroup.memoryDir, 'memory.usage_in_bytes')),
          'cgroup memory usage',
        ),
        process_count: parseNonNegativeInteger(
          readText(join(cgroup.pidsDir, 'pids.current')),
          'cgroup process count',
        ),
        source: 'cgroup',
      };
    } catch {}
  }
  return processTreeUsage(rootPid, readText);
}

function stringifyAcpContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    'text' in content &&
    typeof content.text === 'string'
  ) {
    return content.text;
  }
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return String(content ?? '');
  }
}

function isCompleteCodexSkillBudgetWarning(content: string): boolean {
  if (!content.startsWith(CODEX_SKILL_BUDGET_WARNING_PREFIX)) return false;
  const remainder = content.slice(CODEX_SKILL_BUDGET_WARNING_PREFIX.length);
  const percentIndex = remainder.indexOf('%');
  return (
    percentIndex > 0 &&
    /^\d+$/.test(remainder.slice(0, percentIndex)) &&
    remainder.slice(percentIndex) === CODEX_SKILL_BUDGET_WARNING_SUFFIX
  );
}

function isPotentialCodexSkillBudgetWarning(content: string): boolean {
  if (content.length <= CODEX_SKILL_BUDGET_WARNING_PREFIX.length) {
    return CODEX_SKILL_BUDGET_WARNING_PREFIX.startsWith(content);
  }
  if (!content.startsWith(CODEX_SKILL_BUDGET_WARNING_PREFIX)) return false;

  const remainder = content.slice(CODEX_SKILL_BUDGET_WARNING_PREFIX.length);
  const percentIndex = remainder.indexOf('%');
  if (percentIndex < 0) return /^\d*$/.test(remainder);
  if (!/^\d+$/.test(remainder.slice(0, percentIndex))) return false;
  return CODEX_SKILL_BUDGET_WARNING_SUFFIX.startsWith(remainder.slice(percentIndex));
}

export class AcpAgentMessageClassifier {
  private pending = '';

  consume(content: unknown): Pick<SessionUpdate, 'type' | 'content'> | null {
    const candidate = this.pending + stringifyAcpContent(content);
    const normalized = candidate.trim();
    if (!normalized && !this.pending) {
      return { type: 'text', content: candidate };
    }

    if (isCompleteCodexSkillBudgetWarning(normalized)) {
      this.pending = '';
      return { type: 'progress', content: candidate };
    }
    if (isPotentialCodexSkillBudgetWarning(normalized)) {
      this.pending = candidate;
      return null;
    }

    this.pending = '';
    return { type: 'text', content: candidate };
  }

  flush(): Pick<SessionUpdate, 'type' | 'content'> | null {
    if (!this.pending) return null;
    const content = this.pending;
    this.pending = '';
    return { type: 'text', content };
  }
}

async function* yieldUpdates(
  queue: SessionUpdate[],
  done: Promise<void>,
): AsyncIterable<SessionUpdate> {
  let resolve: () => void;
  let pending = new Promise<void>(r => { resolve = r; });
  const notify = () => { const r = resolve; resolve = () => {}; pending = new Promise(r2 => { resolve = r2; }); r(); };

  // Attach notifier to queue
  (queue as SessionUpdate[] & { _notify?: () => void })._notify = notify;

  const isDone = done.then(() => null).catch(() => null);
  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    const result = await Promise.race([pending, isDone]);
    if (result === null) {
      // Drain remaining
      while (queue.length > 0) yield queue.shift()!;
      return;
    }
  }
}

class SwarmClient implements Client {
  private updateQueue: SessionUpdate[] & { _notify?: () => void };
  private onUpdate?: (update: SessionUpdate) => void;
  private agentMessageClassifier = new AcpAgentMessageClassifier();
  private pendingTools = new Map<string, { name: string; arguments: unknown; started: number }>();
  private textChunks: string[] = [];

  constructor(
    queue: SessionUpdate[] & { _notify?: () => void },
    onUpdate?: (update: SessionUpdate) => void,
    private recorder?: FileCassetteRecorder,
    private onActivity?: () => void,
  ) {
    this.updateQueue = queue;
    this.onUpdate = onUpdate;
  }

  private pushUpdate(type: SessionUpdate['type'], content: string): void {
    const su: SessionUpdate = { type, content, timestamp: Date.now() };
    if (type === 'text') this.textChunks.push(content);
    this.updateQueue.push(su);
    this.updateQueue._notify?.();
    if (this.onUpdate) {
      try {
        this.onUpdate(su);
      } catch {
      }
    }
  }

  getTextOutput(): string {
    return this.textChunks.join('');
  }

  flushPendingAgentMessage(): void {
    const pending = this.agentMessageClassifier.flush();
    if (pending) this.pushUpdate(pending.type, pending.content);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    // Buffered/filtered chunks are still real adapter activity.
    this.onActivity?.();
    const update = params.update;
    let type: SessionUpdate['type'] = 'text';
    let content = '';

    if ('sessionUpdate' in update && update.sessionUpdate === 'agent_message_chunk') {
      const messageUpdate = update as { content?: unknown };
      const classified = this.agentMessageClassifier.consume(messageUpdate.content);
      if (!classified) return;
      this.pushUpdate(classified.type, classified.content);
      return;
    }

    this.flushPendingAgentMessage();
    if ('sessionUpdate' in update) {
      switch (update.sessionUpdate) {
        case 'tool_call':
          type = 'tool_call';
          {
            const raw = update as any;
            const id = String(raw.toolCallId ?? raw.id ?? `${raw.title ?? 'tool'}-${Date.now()}`);
            this.pendingTools.set(id, {
              name: String(raw.title ?? raw.kind ?? 'unknown-tool'),
              arguments: raw.rawInput ?? raw.input ?? raw.content ?? {},
              started: Date.now(),
            });
            content = JSON.stringify({ toolCallId: id, title: raw.title, kind: raw.kind, status: raw.status });
          }
          break;
        case 'tool_call_update':
          type = 'tool_result';
          {
            const raw = update as any;
            const id = String(raw.toolCallId ?? raw.id ?? 'unknown');
            const status = String(raw.status ?? 'updated');
            const pending = this.pendingTools.get(id);
            if (pending && ['completed', 'failed', 'error'].includes(status.toLowerCase())) {
              this.recorder?.recordTool({
                name: pending.name,
                arguments: pending.arguments,
                result: raw.rawOutput ?? raw.output ?? raw.content ?? { status },
                error: ['failed', 'error'].includes(status.toLowerCase()) ? status : undefined,
                durationMs: Date.now() - pending.started,
                metadata: { tool_call_id: id, status },
              });
              this.pendingTools.delete(id);
            }
            content = JSON.stringify({ toolCallId: id, status });
          }
          break;
        default:
          type = 'progress';
          content = JSON.stringify(update);
      }
    }

    this.pushUpdate(type, content);
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return selectAcpPermissionOption(params);
  }

  async writeTextFile(_params: any) { return {}; }
  async readTextFile(_params: any) { return { content: '' }; }

  flushPending(reason: string): void {
    for (const [id, pending] of this.pendingTools) {
      this.recorder?.recordTool({
        name: pending.name,
        arguments: pending.arguments,
        error: reason,
        durationMs: Date.now() - pending.started,
        metadata: { tool_call_id: id, status: 'incomplete' },
      });
    }
    this.pendingTools.clear();
  }
}

export interface AcpUsageResult {
  inputTokens?: number;
  outputTokens?: number;
  tokensUsed?: number;
}

interface AcpModelConfig {
  id: string;
  currentValue: string;
}

export function findAcpModelConfig(
  configOptions: Array<{
    id: string;
    type: string;
    category?: string | null;
    currentValue?: unknown;
  }> | null | undefined,
): AcpModelConfig | undefined {
  const option = configOptions?.find(
    candidate =>
      candidate.type === 'select' &&
      (candidate.category === 'model' || candidate.id === 'model') &&
      typeof candidate.currentValue === 'string',
  );
  return option
    ? { id: option.id, currentValue: option.currentValue as string }
    : undefined;
}
export function resolveHermesSessionModel(
  provider: string | undefined,
  model: string | undefined,
  currentModelId: string | undefined,
): string | undefined {
  const requestedProvider = provider?.trim();
  const requestedModel = model?.trim();
  if (!requestedProvider && !requestedModel) return undefined;
  if (requestedProvider && requestedModel) return `${requestedProvider}:${requestedModel}`;
  if (requestedModel) return requestedModel;

  const current = currentModelId?.trim();
  if (!current) {
    throw new Error('Hermes provider override requires an ACP current model');
  }
  const separator = current.indexOf(':');
  const currentModel = separator >= 0 ? current.slice(separator + 1) : current;
  if (!currentModel) {
    throw new Error('Hermes ACP current model is empty');
  }
  return `${requestedProvider}:${currentModel}`;
}

export function resolveACPModel(
  provider: string | undefined,
  model: string | undefined,
  currentModel: string | undefined,
  separator: '/' | ':' | undefined,
): string | undefined {
  const requestedProvider = provider?.trim();
  const requestedModel = model?.trim();
  if (requestedModel?.startsWith('byok:')) {
    throw new Error(`ACP model identifier '${requestedModel}' is not provider-native`);
  }
  if (!requestedProvider && !requestedModel) return undefined;
  if (!separator) {
    if (requestedProvider) {
      throw new Error('ACP provider override requires a provider separator in the registry');
    }
    return requestedModel;
  }
  if (requestedProvider && requestedModel) {
    if (requestedModel.includes(separator)) {
      const modelProvider = requestedModel.slice(0, requestedModel.indexOf(separator));
      if (modelProvider !== requestedProvider) {
        throw new Error(
          `ACP provider '${requestedProvider}' conflicts with model '${requestedModel}'`,
        );
      }
      return requestedModel;
    }
    return `${requestedProvider}${separator}${requestedModel}`;
  }
  if (requestedModel) return requestedModel;

  const current = currentModel?.trim();
  if (!current) throw new Error('ACP provider override requires a current session model');
  const separatorIndex = current.indexOf(separator);
  const currentModelName = separatorIndex >= 0 ? current.slice(separatorIndex + 1) : current;
  if (!currentModelName) throw new Error('ACP current session model is empty');
  return `${requestedProvider}${separator}${currentModelName}`;
}

function mergeLaunchConfig(
  existing: string | undefined,
  injected: Record<string, unknown>,
): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed = JSON.parse(existing) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ACP provider launch config must be a JSON object');
    }
    base = parsed as Record<string, unknown>;
  }

  const merge = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ): Record<string, unknown> => {
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) {
      const current = result[key];
      result[key] = current && value
        && typeof current === 'object' && !Array.isArray(current)
        && typeof value === 'object' && !Array.isArray(value)
        ? merge(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
    }
    return result;
  };

  return JSON.stringify(merge(base, injected));
}
export function isAcpSuccessfulOutput(stopReason: string, output: string): boolean {
  return stopReason === 'end_turn' && output.trim().length > 0;
}

export function selectAcpPermissionOption(
  params: RequestPermissionRequest,
): RequestPermissionResponse {
  const option = params.options.find(candidate => candidate.kind === 'allow_once')
    ?? params.options.find(candidate => candidate.kind === 'allow_always');
  if (!option) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/**
 * Extract token usage from an ACP prompt result. The SDK `Usage` field is
 * @experimental (v0.18.0) and may be absent. A count of 0 is treated as absent
 * because it signals the usage_update notification never fired for the session,
 * not a genuine zero-token turn. Cache tokens (cachedReadTokens/cachedWriteTokens)
 * are intentionally ignored — they are separate billing line-items, accounted
 * for instead by the bridge transport's total_cost_usd path.
 */
export function parseAcpUsage(promptResult: unknown): AcpUsageResult {
  const usage = (promptResult as { usage?: unknown } | null | undefined)?.usage;
  if (!usage || typeof usage !== 'object') return {};
  const toNum = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const inputTokens = toNum((usage as { inputTokens?: unknown }).inputTokens);
  const outputTokens = toNum((usage as { outputTokens?: unknown }).outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return {};
  return {
    inputTokens,
    outputTokens,
    tokensUsed: (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

export interface ACPTransportConfig {
  /** Path to the ACP adapter binary. Defaults to 'claude-agent-acp'. */
  adapterBin?: string;
  /** Extra CLI args passed to the adapter binary (e.g., ['--acp'] for gemini). */
  adapterArgs?: string[];
  /** Additional env vars forwarded to the adapter. */
  extraEnv?: Record<string, string>;
  /** Tool names passed in ALLOWED_TOOLS env var. */
  allowedTools?: string[];
  mcpConfig?: {
    configPath?: string;
    includeShared?: boolean;
    includeZo?: boolean;
    includeMemoryBriefing?: boolean;
  };
}

type JsonMcpServer = {
  type?: string;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function objectEntries(value: unknown): Array<{ name: string; value: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, item]) => ({ name, value: String(item) }));
}

function parseMcpServer(name: string, raw: JsonMcpServer): McpServer | undefined {
  if (typeof raw.command === 'string') {
    return {
      name,
      command: raw.command,
      args: stringArray(raw.args),
      env: objectEntries(raw.env),
    };
  }

  if (typeof raw.url === 'string') {
    const type = raw.type === 'sse' ? 'sse' : 'http';
    return { type, name, url: raw.url, headers: objectEntries(raw.headers) } as McpServer;
  }

  return undefined;
}

function findMcpConfigPath(configPath: string, workdir: string): string {
  if (isAbsolute(configPath)) return configPath;

  let directory = workdir;
  while (true) {
    const candidate = join(directory, configPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return join(workdir, configPath);
    directory = parent;
  }
}

function terminateAdapterGroup(adapter: ChildProcess, signal: NodeJS.Signals): void {
  adapterResourceGroups.get(adapter)?.killAll(signal);
  if (adapter.pid && process.platform !== 'win32') {
    try {
      process.kill(-adapter.pid, signal);
      return;
    } catch {}
  }
  try {
    adapter.kill(signal);
  } catch {}
}

async function shutdownAdapterGroup(adapter: ChildProcess): Promise<void> {
  const cgroup = adapterResourceGroups.get(adapter);
  terminateAdapterGroup(adapter, 'SIGTERM');
  if (adapter.exitCode === null && adapter.signalCode === null) {
    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 500);
      adapter.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  terminateAdapterGroup(adapter, 'SIGKILL');
  if (cgroup) scheduleResourceCgroupCleanup(cgroup);
}

export function loadAcpMcpServers(
  config: ACPTransportConfig['mcpConfig'],
  options: { workdir?: string; env?: Record<string, string> } = {},
): McpServer[] {
  if (!config) return [];

  const env = options.env ?? (process.env as Record<string, string>);
  const servers: McpServer[] = [];
  if (config.includeShared !== false) {
    const configPath = findMcpConfigPath(
      config.configPath ?? '.mcp.json',
      options.workdir ?? getWorkspaceRoot(),
    );
    if (!existsSync(configPath)) {
      throw new Error(`ACP MCP config does not exist: ${configPath}`);
    }
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers?: Record<string, JsonMcpServer>;
    };
    for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
      const server = parseMcpServer(name, raw);
      if (server) servers.push(server);
    }
  }

  if (config.includeZo) {
    const token = [env.ZO_CLIENT_IDENTITY_TOKEN, env.ZO_API_KEY, env.ZO_MCP_API_KEY]
      .find(value => value?.trim());
    if (!token) {
      console.warn(
        '[ACP MCP] Skipping optional Zo server: no ZO_CLIENT_IDENTITY_TOKEN, ZO_API_KEY, or ZO_MCP_API_KEY is available',
      );
      return servers;
    }
    const url = new URL(env.ZO_MCP_URL ?? 'https://api.zo.computer/mcp');
    const conversationId = env.ZO_CONVERSATION_ID ?? env.ZO_MCP_CONVERSATION_ID;
    if (conversationId && !url.searchParams.has('conversation_id')) {
      url.searchParams.set('conversation_id', conversationId);
    }
    servers.push({
      type: 'http',
      name: 'zo',
      url: url.toString(),
      headers: [
        { name: 'Authorization', value: `Bearer ${token}` },
        { name: 'Content-Type', value: 'application/json' },
      ],
    });
  }

  return servers;
}

export async function buildAcpPrompt(
  task: Task,
  config: ACPTransportConfig['mcpConfig'],
  env: Record<string, string>,
): Promise<string> {
  if (!config?.includeMemoryBriefing) return task.task;
  const baseUrl = (env.MEMORY_GATE_URL ?? 'http://localhost:7820').replace(/\/$/, '');
  const gateUrl = baseUrl.endsWith('/gate') ? baseUrl : `${baseUrl}/gate`;
  try {
    const response = await fetch(gateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'session context', persona: task.persona }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return task.task;
    const context = (await response.text()).trim();
    if (!context || context === 'null') return task.task;
    return `${task.task}\n\n[SESSION BRIEFING - Zo Shared Memory]\n${context}`;
  } catch {
    return task.task;
  }
}

export class ACPTransport implements ExecutorTransport {
  private entry: ExecutorRegistryEntry;
  private circuitBreaker: CircuitBreaker;
  private config: ACPTransportConfig;

  constructor(
    entry: ExecutorRegistryEntry,
    circuitBreaker: CircuitBreaker,
    config: ACPTransportConfig = {},
  ) {
    this.entry = entry;
    this.circuitBreaker = circuitBreaker;
    this.config = config;
  }

  private buildEnv(options: TransportOptions): Record<string, string> {
    const base: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(options.env ?? {}),
      ...(this.config.extraEnv ?? {}),
    };

    const modelSelection = this.entry.acp?.modelSelection;
    const providerSeparator = modelSelection?.providerSeparator;
    const requestedProvider = base.SWARM_PROVIDER
      ?? (providerSeparator && base.SWARM_RESOLVED_MODEL?.includes(providerSeparator)
        ? base.SWARM_RESOLVED_MODEL.slice(0, base.SWARM_RESOLVED_MODEL.indexOf(providerSeparator))
        : undefined);
    const providerLaunchConfig = requestedProvider
      ? this.entry.acp?.providerTemplates?.[requestedProvider]?.launchConfig
      : undefined;
    if (providerLaunchConfig) {
      base[providerLaunchConfig.envVar] = mergeLaunchConfig(
        base[providerLaunchConfig.envVar],
        providerLaunchConfig.value,
      );
    }

    if (modelSelection?.method === 'env' && (base.SWARM_PROVIDER || base.SWARM_RESOLVED_MODEL)) {
      if (!modelSelection.envVar) {
        throw new Error(`Executor '${this.entry.id}' ACP env model selection has no envVar`);
      }
      const resolvedModel = resolveACPModel(
        base.SWARM_PROVIDER,
        base.SWARM_RESOLVED_MODEL,
        undefined,
        modelSelection.providerSeparator,
      );
      if (resolvedModel) base[modelSelection.envVar] = resolvedModel;
    }

    // Tool allowlist
    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      base.ALLOWED_TOOLS = this.config.allowedTools.join(',');
    }

    // Scrub session detection vars
    for (const key of SCRUBBED_ENV_VARS) {
      delete base[key];
    }

    return base;
  }

  private spawnAdapter(env: Record<string, string>, workdir: string): ChildProcess {
    const bin = this.config.adapterBin ?? 'claude-agent-acp';
    const args = (this.config.adapterArgs ?? []).map(arg => {
      if (isAbsolute(arg) || !arg.includes('/')) return arg;
      const candidate = join(getWorkspaceRoot(), arg);
      return existsSync(candidate) ? candidate : arg;
    });
    const managed = readManagedFactoryBoundary();
    const containedSpawnSpec = managed
      ? prepareManagedFactorySpawn({ command: bin, args }, workdir, env, managed)
      : prepareFilesystemContainedSpawn(buildResourceGuardedAdapterSpawn(bin, args, env), workdir, env);
    // The managed capability verifies the actual nondelegated kernel limits.
    // It cannot be selected with a worker environment flag.
    const cgroup = managed ? null : createExecutorResourceCgroup(env);
    const guardedSpawnSpec = cgroup ? buildCgroupGuardedAdapterSpawn(containedSpawnSpec, cgroup) : containedSpawnSpec;
    let adapter: ChildProcess;
    try {
      adapter = spawn(guardedSpawnSpec.command, guardedSpawnSpec.args, {
        stdio: ['pipe', 'pipe', 'pipe', ...(guardedSpawnSpec.passFds ?? [])],
        env,
        // setsid equivalent: detached creates a new process group for isolation
        detached: true,
      });
      guardedSpawnSpec.closeAfterSpawn?.();
      if (managed) managedAdapters.add(adapter);
    } catch (error) {
      guardedSpawnSpec.closeAfterSpawn?.();
      guardedSpawnSpec.cleanupAfterExit?.();
      cgroup?.cleanup();
      throw error;
    }
    adapter.once('exit', () => guardedSpawnSpec.cleanupAfterExit?.());
    if (cgroup) {
      adapterResourceGroups.set(adapter, cgroup);
      adapter.once('exit', () => scheduleResourceCgroupCleanup(cgroup));
    }
    return adapter;
  }

  executeWithUpdates(task: Task, options: TransportOptions): {
    updates: AsyncIterable<SessionUpdate>;
    result: Promise<TaskResult>;
  } {
    const queue: SessionUpdate[] & { _notify?: () => void } = [];
    let doneResolve!: () => void;
    let doneReject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => { doneResolve = res; doneReject = rej; });
    // `done` signals the updates generator to stop. When a caller uses execute()
    // it discards `updates`, so yieldUpdates never runs and never attaches its own
    // rejection handler — swallow here so a doneReject() (e.g. adapter death) can
    // never surface as an unhandled rejection.
    done.catch(() => {});

    const result = this._runSession(task, options, queue, doneResolve, doneReject);
    const updates = yieldUpdates(queue, done);

    return { updates, result };
  }

  async execute(task: Task, options: TransportOptions): Promise<TaskResult> {
    const { result } = this.executeWithUpdates(task, options);
    return result;
  }

  private async _runSession(
    task: Task,
    options: TransportOptions,
    queue: SessionUpdate[] & { _notify?: () => void },
    doneResolve: () => void,
    doneReject: (e: Error) => void,
  ): Promise<TaskResult> {
    if (!this.circuitBreaker.canAttempt()) {
      const err = `Circuit breaker OPEN for ACP executor ${this.entry.id}`;
      doneResolve();
      return { task, success: false, error: err, durationMs: 0, retries: 0 };
    }

    const startTime = Date.now();
    const env = this.buildEnv(options);
    env.SWARM_EXECUTOR_ID = this.entry.id;
    const adapter = this.spawnAdapter(env, options.workdir ?? getWorkspaceRoot());

    let stderrOutput = '';
    adapter.stderr?.on('data', (d: Buffer) => { stderrOutput += d.toString(); });

    const input = Writable.toWeb(adapter.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(adapter.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(input, output);

    const traceId = options.env?.ZO_TRACE_ID ?? process.env.ZO_TRACE_ID;
    const traceRecording = traceId && process.env.ZOUROBOROS_TRACE_RECORD !== '0';
    const replayRoot = process.env.ZOUROBOROS_REPLAY_ROOT
      ?? join(process.env.HOME ?? '/tmp', '.zouroboros', 'replay');
    const recorder = traceRecording
      ? new FileCassetteRecorder({
          mode: 'record',
          path: join(
            replayRoot,
            'traces',
            replayPathSegment(traceId),
            `${replayPathSegment(task.id)}.json`,
          ),
          traceId,
          source: `acp:${this.entry.id}`,
          metadata: { task_id: task.id, executor: this.entry.id },
        })
      : undefined;
    let sessionId = '';
    const modelSelection = this.entry.acp?.modelSelection;
    let appliedModel = modelSelection?.method === 'env'
      ? resolveACPModel(
          env.SWARM_PROVIDER,
          env.SWARM_RESOLVED_MODEL,
          undefined,
          modelSelection.providerSeparator,
        )
      : undefined;
    let idleTimedOut = false;
    let idleTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = () => {
      if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) return;
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
      idleTimeoutHandle = setTimeout(() => {
        idleTimedOut = true;
        if (sessionId) connection.cancel({ sessionId }).catch(() => {});
        terminateAdapterGroup(adapter, 'SIGTERM');
      }, options.idleTimeoutMs);
    };
    const onUpdate = (update: SessionUpdate) => {
      resetIdleTimeout();
      try {
        options.onUpdate?.(update);
      } catch {
        // Observation is untrusted and must never fail the session.
      }
    };
    const client = new SwarmClient(queue, onUpdate, recorder, resetIdleTimeout);
    const connection = new ClientSideConnection((_agent: Agent) => client, stream);

    // Total timeout and no-progress timeout enforcement.
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (sessionId) connection.cancel({ sessionId }).catch(() => {});
      terminateAdapterGroup(adapter, 'SIGTERM');
    }, options.timeoutMs);
    resetIdleTimeout();

    let settled = false;
    // Set the instant the child adapter dies, independent of promise settlement.
    // Lets the catch below deterministically attribute a session failure to
    // adapter death even when the ACP SDK's own stream-closed rejection wins the
    // race against the watchdog (both settle the promise; only the cause differs).
    let adapterDied = false;

    // Adapter-death watchdog. If the child adapter dies mid-request (EOF/crash),
    // the ACP SDK may never reject the in-flight JSON-RPC promise, so the awaited
    // call below would hang forever, the event loop would drain, and the host
    // would exit 0 without ever writing a terminal execution state (ZOU-568).
    // Tie process death to promise settlement by racing it against the session.
    let onProcExit: (() => void) | undefined;
    let onProcError: ((e: Error) => void) | undefined;
    const processDied = new Promise<never>((_, reject) => {
      onProcExit = () => {
        adapterDied = true;
        if (settled) return;
        reject(new Error(
          `ACP adapter exited before session completed (code=${adapter.exitCode ?? 'null'}, signal=${adapter.signalCode ?? 'null'})`,
        ));
      };
      onProcError = (e: Error) => {
        adapterDied = true;
        if (settled) return;
        reject(new Error(`ACP adapter process error: ${e.message}`));
      };
      adapter.once('exit', onProcExit);
      adapter.once('error', onProcError);
    });
    // The happy path and timeout path both kill the adapter, which fires 'exit'.
    // Swallow that late rejection so it never surfaces as an unhandled rejection.
    processDied.catch(() => {});

    try {
      const promptResult = await Promise.race([
        (async () => {
          // Phase 1: Initialize
          await connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
            },
          });

          // Phase 2: New session (per-task isolation)
          const cwd = options.workdir ?? getWorkspaceRoot();
          const sessionResult = await connection.newSession({
            cwd,
            mcpServers: managedAdapters.has(adapter) ? [] : loadAcpMcpServers(this.config.mcpConfig, { workdir: cwd, env }),
          });
          sessionId = sessionResult.sessionId;

          if (
            modelSelection &&
            modelSelection.method !== 'env' &&
            (env.SWARM_PROVIDER || env.SWARM_RESOLVED_MODEL)
          ) {
            const configOption = sessionResult.configOptions?.find(option =>
              option.id === modelSelection.configId ||
              (modelSelection.category && option.category === modelSelection.category),
            );
            const legacyModels = (sessionResult as {
              models?: { currentModelId?: string };
            }).models;
            const currentModel = configOption && 'currentValue' in configOption
              ? String(configOption.currentValue)
              : legacyModels?.currentModelId;
            appliedModel = resolveACPModel(
              env.SWARM_PROVIDER,
              env.SWARM_RESOLVED_MODEL,
              currentModel,
              modelSelection.providerSeparator,
            );
            if (appliedModel && modelSelection.method === 'session-config') {
              if (!configOption || configOption.type !== 'select') {
                throw new Error(
                  `Executor '${this.entry.id}' did not advertise ACP model config '${modelSelection.configId ?? modelSelection.category ?? 'model'}'`,
                );
              }
              const values = configOption.options.flatMap(option =>
                'options' in option ? option.options.map(item => item.value) : [option.value],
              );
              if (!values.includes(appliedModel)) {
                throw new Error(
                  `ACP model '${appliedModel}' is not advertised by executor '${this.entry.id}'`,
                );
              }
              const configured = await connection.setSessionConfigOption({
                sessionId,
                configId: configOption.id,
                value: appliedModel,
              });
              const readback = configured.configOptions?.find(option => option.id === configOption.id);
              if (!readback || !('currentValue' in readback) || String(readback.currentValue) !== appliedModel) {
                throw new Error(`Executor '${this.entry.id}' did not confirm selected ACP model '${appliedModel}'`);
              }
            } else if (appliedModel && configOption && modelSelection.method === 'extension') {
              await connection.setSessionConfigOption({
                sessionId,
                configId: configOption.id,
                value: appliedModel,
              });
            } else if (appliedModel && modelSelection.method === 'extension') {
              if (!modelSelection.extensionMethod) {
                throw new Error(`Executor '${this.entry.id}' ACP model extension has no method`);
              }
              await connection.extMethod(modelSelection.extensionMethod, {
                sessionId,
                modelId: appliedModel,
              });
            }
          } else if (!modelSelection && (env.SWARM_PROVIDER || env.SWARM_RESOLVED_MODEL)) {
            throw new Error(
              `Executor '${this.entry.id}' does not declare ACP model selection in the registry`,
            );
          }

          // Phase 3: Prompt
          return connection.prompt({
            sessionId,
            prompt: [{
              type: 'text',
              text: managedAdapters.has(adapter) ? task.task : await buildAcpPrompt(task, this.config.mcpConfig, env),
            }],
          });
        })(),
        processDied,
      ]);

      client.flushPendingAgentMessage();
      client.flushPending('tool call ended without a terminal ACP update');
      settled = true;
      clearTimeout(timeoutHandle);
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
      doneResolve();

      const durationMs = Date.now() - startTime;
      // Collect text output from session updates
      const textOutput = client.getTextOutput();
      const endedNormally = promptResult.stopReason === 'end_turn';
      const success = isAcpSuccessfulOutput(promptResult.stopReason, textOutput);

      if (success) {
        this.circuitBreaker.recordSuccess();
      } else {
        this.circuitBreaker.recordFailure(
          promptResult.stopReason === 'cancelled' ? 'timeout' : 'runtime_error',
        );
      }

      const usage = parseAcpUsage(promptResult);
      const resolvedModel = appliedModel ?? env.SWARM_RESOLVED_MODEL;
      const servingProvider = appliedModel && modelSelection?.providerSeparator
        ? appliedModel.split(modelSelection.providerSeparator, 1)[0]
        : env.SWARM_PROVIDER;
      const providerTemplate = servingProvider
        ? this.entry.acp?.providerTemplates?.[servingProvider]
        : undefined;
      const modelFamily = resolvedModel && modelSelection?.providerSeparator
        ? resolvedModel.slice(resolvedModel.indexOf(modelSelection.providerSeparator) + 1)
        : resolvedModel;

      return {
        task,
        success,
        output: textOutput,
        error: success
          ? undefined
          : endedNormally
            ? 'ACP session ended without non-empty agent output'
            : `ACP stop reason: ${promptResult.stopReason}`,
        durationMs,
        retries: 0,
        tokensUsed: usage.tokensUsed,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        modelUsed: appliedModel ?? env.SWARM_RESOLVED_MODEL,
        modelProvenance: {
          harness: this.entry.id,
          requestedProvider: env.SWARM_PROVIDER,
          requestedModel: env.SWARM_RESOLVED_MODEL,
          resolvedModel,
          modelFamily,
          servingProvider,
          endpointClass: providerTemplate?.endpointClass ?? this.entry.acp?.endpointClass,
          credentialEnvironment: providerTemplate?.credentialEnv,
        },
      };
    } catch (err: any) {
      client.flushPendingAgentMessage();
      settled = true;
      clearTimeout(timeoutHandle);
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
      doneReject(err);

      const durationMs = Date.now() - startTime;
      const category = timedOut || idleTimedOut ? 'timeout' : 'runtime_error';
      this.circuitBreaker.recordFailure(category);
      client.flushPending(
        idleTimedOut ? 'ACP session idle timed out' : timedOut ? 'ACP session timed out' : 'ACP session failed',
      );

      // A stream-closed rejection from the ACP SDK means the adapter's stdout hit
      // EOF — i.e. the child has died (or is about to). Give its 'exit' a brief
      // moment to reap so we can surface the exit code/signal as the actionable
      // root cause rather than the downstream "connection closed" symptom. This
      // makes the terminal error deterministic regardless of which rejection
      // (watchdog vs. SDK) won the race above, and across host/CI event-loop timing.
      if (!timedOut && !idleTimedOut && !adapterDied && adapter.exitCode === null && adapter.signalCode === null) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          adapter.once('exit', () => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      const procDead =
        adapterDied || adapter.exitCode !== null || adapter.signalCode !== null;
      const resourceUsage = adapter.pid
        ? readExecutorResourceUsage(adapter.pid, adapterResourceGroups.get(adapter) ?? null)
        : null;
      const resourceDetail = resourceUsage
        ? ` [resource source=${resourceUsage.source}, memory=${Math.ceil(resourceUsage.memory_bytes / 1024 / 1024)} MiB, processes=${resourceUsage.process_count}]`
        : '';

      return {
        task,
        success: false,
        error: idleTimedOut
          ? `ACP session idle timed out after ${options.idleTimeoutMs}ms without an update`
          : timedOut
            ? `ACP session timed out after ${options.timeoutMs}ms`
          : procDead
            ? `ACP adapter exited before session completed (code=${adapter.exitCode ?? 'null'}, signal=${adapter.signalCode ?? 'null'})${resourceDetail}: ${err.message ?? String(err)}\n${stderrOutput}`
            : `ACP session error: ${err.message ?? String(err)}\n${stderrOutput}`,
        durationMs,
        retries: 0,
      };
    } finally {
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle);
      if (onProcExit) adapter.off('exit', onProcExit);
      if (onProcError) adapter.off('error', onProcError);
      await shutdownAdapterGroup(adapter);
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const bin = this.config.adapterBin ?? 'claude-agent-acp';
    const adapterScript = bin === 'bash' && this.config.adapterArgs?.[0]?.includes('/')
      ? this.config.adapterArgs[0]
      : null;
    if (adapterScript) {
      const scriptPath = isAbsolute(adapterScript)
        ? adapterScript
        : join(getWorkspaceRoot(), adapterScript);
      if (!existsSync(scriptPath)) {
        return { healthy: false, message: `ACP adapter script not found: ${scriptPath}` };
      }
    }
    const label = this.config.adapterArgs?.length
      ? `${bin} ${this.config.adapterArgs.join(' ')}`
      : bin;
    return new Promise<HealthStatus>((resolve) => {
      // Use `which` to check binary presence — don't invoke the adapter
      // (it has no --version flag; invocation immediately starts an ACP session)
      const proc = spawn('which', [bin], { stdio: 'pipe', timeout: 3000 });
      let out = '';
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ healthy: true, message: `${label} at ${out.trim()}` });
        } else {
          resolve({ healthy: false, message: `${label} not found — install adapter to enable ACP transport` });
        }
      });
      proc.on('error', (e) => {
        resolve({ healthy: false, message: `which ${bin} failed: ${e.message}` });
      });
    });
  }

  async shutdown(): Promise<void> {
    // Per-task sessions are isolated — nothing to tear down globally.
  }
}
