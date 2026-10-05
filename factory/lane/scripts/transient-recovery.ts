import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { runExecutorChain, type ExecutorChainResult, type ExecutorLifecycleEvent } from "./executor-runner";
import { classifyFailure, type FailureVerdict } from "./failure-policy";
import type { HarnessRunResult, HealthProbe } from "./harness-router";

export interface TransientRecoverySubject {
  execution_id: string;
  ticket_id: string;
  identifier: string;
}

export interface RecoveryRouteProbe {
  route: string;
  healthy: boolean;
  message: string;
}

export interface TransientRecoveryJournalRow {
  schema_version: 1;
  recovery_id: string;
  execution_id: string;
  ticket_id: string;
  identifier: string;
  phase: "started" | "completed";
  at: string;
  failure_class: "transient";
  original_error: string;
  preflight: RecoveryRouteProbe[];
  outcome?: "recovered" | "failed" | "blocked";
  trail?: string[];
  detail?: string;
}

export interface ActiveTransientHold {
  hold: {
    execution_id: string;
    reason: "transient_recovery";
    released_at: null;
  } & Record<string, unknown>;
  execution: {
    execution_id: string;
    ticket_id: string;
    identifier: string;
  } & Record<string, unknown>;
}

export type TransientRecoveryResult =
  | { status: "not_applicable"; verdict: FailureVerdict }
  | {
      status: "blocked";
      verdict: FailureVerdict;
      recovery_id: string | null;
      reason: string;
      preflight: RecoveryRouteProbe[];
      result?: ExecutorChainResult;
    }
  | {
      status: "recovered" | "failed";
      verdict: FailureVerdict;
      recovery_id: string;
      preflight: RecoveryRouteProbe[];
      result: ExecutorChainResult;
    };

export interface AttemptTransientRecoveryOptions {
  subject: TransientRecoverySubject;
  stateDir: string;
  failure: string;
  prompt: string;
  workdir: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  chain: ReadonlyArray<string>;
  healthProbe: HealthProbe;
  harnessRun: (executorId: string, prompt: string, options?: {
    workdir?: string;
    timeoutMs?: number;
    idleTimeoutMs?: number;
    env?: Record<string, string>;
    onOutput?: (text: string) => void;
  }) => Promise<HarnessRunResult>;
  onEvent?: (event: ExecutorLifecycleEvent) => void;
  onOutput?: (executorId: string, text: string) => void;
  now?: () => string;
  recoveryId?: () => string;
}

export function transientRecoveryJournalPath(stateDir: string): string {
  return join(stateDir, "transient-recovery.jsonl");
}

export function activeTransientHoldForTicket(stateDir: string, ticketId: string): ActiveTransientHold | null {
  if (!existsSync(stateDir)) return null;
  const matches: ActiveTransientHold[] = [];
  for (const file of readdirSync(stateDir).filter((name) => name.startsWith("hold-") && name.endsWith(".json"))) {
    const path = join(stateDir, file);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`transient hold gate could not parse ${file}`);
    }
    if (!value || typeof value !== "object") throw new Error(`transient hold gate found an invalid record in ${file}`);
    const hold = value as Record<string, unknown>;
    if (hold.reason !== "transient_recovery") continue;
    if (typeof hold.execution_id !== "string" || (hold.released_at !== null && typeof hold.released_at !== "string")) {
      throw new Error(`transient hold gate found an invalid transient hold in ${file}`);
    }
    if (hold.released_at !== null) continue;
    const executionFile = `exec-${hold.execution_id}.json`;
    const executionPath = join(stateDir, executionFile);
    if (!existsSync(executionPath)) throw new Error(`active transient hold ${file} has no ${executionFile}`);
    let executionValue: unknown;
    try {
      executionValue = JSON.parse(readFileSync(executionPath, "utf8"));
    } catch {
      throw new Error(`transient hold gate could not parse ${executionFile}`);
    }
    if (!executionValue || typeof executionValue !== "object") {
      throw new Error(`transient hold gate found an invalid execution in ${executionFile}`);
    }
    const execution = executionValue as Record<string, unknown>;
    if (
      execution.execution_id !== hold.execution_id
      || typeof execution.ticket_id !== "string"
      || typeof execution.identifier !== "string"
    ) {
      throw new Error(`transient hold gate found inconsistent ownership in ${executionFile}`);
    }
    if (execution.ticket_id === ticketId) {
      matches.push({
        hold: hold as ActiveTransientHold["hold"],
        execution: execution as ActiveTransientHold["execution"],
      });
    }
  }
  if (matches.length > 1) throw new Error(`ticket ${ticketId} has multiple active transient holds`);
  return matches[0] ?? null;
}

function attemptKey(executionId: string): string {
  return createHash("sha256").update(executionId).digest("hex");
}

function validProbe(value: unknown): value is RecoveryRouteProbe {
  if (!value || typeof value !== "object") return false;
  const probe = value as Partial<RecoveryRouteProbe>;
  return typeof probe.route === "string"
    && probe.route.length > 0
    && typeof probe.healthy === "boolean"
    && typeof probe.message === "string";
}

function validJournalRow(value: unknown): value is TransientRecoveryJournalRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TransientRecoveryJournalRow>;
  const common = row.schema_version === 1
    && typeof row.recovery_id === "string"
    && typeof row.execution_id === "string"
    && typeof row.ticket_id === "string"
    && typeof row.identifier === "string"
    && (row.phase === "started" || row.phase === "completed")
    && typeof row.at === "string"
    && Number.isFinite(Date.parse(row.at))
    && row.failure_class === "transient"
    && typeof row.original_error === "string"
    && Array.isArray(row.preflight)
    && row.preflight.every(validProbe)
    && (row.trail === undefined || (Array.isArray(row.trail) && row.trail.every((item) => typeof item === "string")))
    && (row.detail === undefined || typeof row.detail === "string");
  if (!common) return false;
  if (row.phase === "started") return row.outcome === undefined;
  return row.outcome === "recovered" || row.outcome === "failed" || row.outcome === "blocked";
}

function validateJournal(stateDir: string): void {
  const path = transientRecoveryJournalPath(stateDir);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("transient recovery journal contains malformed JSON");
    }
    if (!validJournalRow(parsed)) throw new Error("transient recovery journal contains an invalid row");
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function appendJournal(stateDir: string, row: TransientRecoveryJournalRow): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = transientRecoveryJournalPath(stateDir);
  const descriptor = openSync(path, "a", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(row)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(stateDir);
}

function reserveAttempt(stateDir: string, executionId: string): boolean {
  const root = join(stateDir, "transient-recovery-attempts");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(join(root, attemptKey(executionId)), { mode: 0o700 });
    syncDirectory(root);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function attemptTransientRecovery(
  options: AttemptTransientRecoveryOptions,
): Promise<TransientRecoveryResult> {
  const verdict = classifyFailure({ stage: "executor", message: options.failure });
  if (verdict.failure_class !== "transient") return { status: "not_applicable", verdict };

  try {
    validateJournal(options.stateDir);
    if (!reserveAttempt(options.stateDir, options.subject.execution_id)) {
      return {
        status: "blocked",
        verdict,
        recovery_id: null,
        reason: "the bounded transient recovery attempt was already consumed",
        preflight: [],
      };
    }
  } catch (error) {
    return {
      status: "blocked",
      verdict,
      recovery_id: null,
      reason: `transient recovery state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      preflight: [],
    };
  }

  const recoveryId = options.recoveryId?.() ?? `recovery-${randomUUID().slice(0, 8)}`;
  const timestamp = options.now?.() ?? new Date().toISOString();
  const started: TransientRecoveryJournalRow = {
    schema_version: 1,
    recovery_id: recoveryId,
    ...options.subject,
    phase: "started",
    at: timestamp,
    failure_class: "transient",
    original_error: options.failure,
    preflight: [],
  };
  try {
    appendJournal(options.stateDir, started);
  } catch (error) {
    return {
      status: "blocked",
      verdict,
      recovery_id: recoveryId,
      reason: `transient recovery could not be journaled: ${error instanceof Error ? error.message : String(error)}`,
      preflight: [],
    };
  }

  const preflight: RecoveryRouteProbe[] = [];
  for (const route of options.chain) {
    try {
      const health = await options.healthProbe(route);
      preflight.push({ route, healthy: health.healthy, message: health.message });
    } catch (error) {
      preflight.push({
        route,
        healthy: false,
        message: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const completedBase = { ...started, preflight };

  const healthyRoutes = preflight.filter((route) => route.healthy).map((route) => route.route);
  if (healthyRoutes.length === 0) {
    const reason = "no pre-validated executor route is healthy";
    try {
      appendJournal(options.stateDir, {
        ...completedBase,
        phase: "completed",
        at: options.now?.() ?? new Date().toISOString(),
        outcome: "blocked",
        detail: reason,
      });
    } catch (error) {
      return {
        status: "blocked",
        verdict,
        recovery_id: recoveryId,
        reason: `${reason}; completion journal failed: ${error instanceof Error ? error.message : String(error)}`,
        preflight,
      };
    }
    return { status: "blocked", verdict, recovery_id: recoveryId, reason, preflight };
  }

  const health = new Map(preflight.map((route) => [route.route, route]));
  const result = await runExecutorChain({
    prompt: options.prompt,
    workdir: options.workdir,
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    chain: healthyRoutes,
    healthProbe: async (route) => {
      const probe = health.get(route);
      return probe ? { healthy: probe.healthy, message: probe.message } : { healthy: false, message: "route was not pre-validated" };
    },
    harnessRun: options.harnessRun,
    onEvent: options.onEvent,
    onOutput: options.onOutput,
  });
  const status = result.success ? "recovered" : "failed";
  try {
    appendJournal(options.stateDir, {
      ...completedBase,
      phase: "completed",
      at: options.now?.() ?? new Date().toISOString(),
      outcome: status,
      trail: result.trail,
      detail: result.error ?? result.output.slice(0, 200),
    });
  } catch (error) {
    return {
      status: "blocked",
      verdict,
      recovery_id: recoveryId,
      reason: `transient recovery outcome could not be journaled: ${error instanceof Error ? error.message : String(error)}`,
      preflight,
      result,
    };
  }
  return { status, verdict, recovery_id: recoveryId, preflight, result };
}
