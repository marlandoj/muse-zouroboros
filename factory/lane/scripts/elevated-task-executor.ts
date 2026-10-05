#!/usr/bin/env bun
/**
 * Bounded executor for elevated tasks (threat-model R3, R6).
 *
 * Runs one `ElevatedCommand` without a shell under an explicit environment
 * allowlist, a per-category timeout with SIGTERM→SIGKILL escalation, a hard
 * output ceiling that kills a runaway child, and a retained-output cap. The
 * full output is redacted once (value match plus key-name patterns) and hashed;
 * the caller persists the full redacted text 0600 and keeps only the capped
 * prefix in the durable request record.
 *
 * Both the Command Center broker (categories that execute in-process) and the
 * privileged helper (production / full-VPS) use this module, so the bounds are
 * identical on both sides of the handoff.
 */

import {
  redactSecrets,
  sha256Hex,
  truncateAndHashOutput,
  OUTPUT_CAP_BYTES,
  type ElevatedCommand,
  type ElevatedExecutionResult,
} from "./elevated-task-contract";

// ─── Environment allowlist ────────────────────────────────────────────────────

/** Keys copied from the broker environment when present (mirrors terminal.ts). */
export const BASE_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "SHELL", "TZ", "TERM"] as const;

/** Never forwarded to a child, regardless of allowlists or request env_keys. */
export const DENIED_ENV_KEYS = new Set([
  "CC_OPERATOR_TOKEN",
  "CC_LAUNCH_TOKEN",
  "SWARM_API_TOKEN",
  "QDRANT_API_KEY",
  "CC_ELEVATED_HELPER_TOKEN",
  "CC_ELEVATED_AUTOMATION_TOKEN",
  "RESTIC_PASSWORD",
  "RESTIC_PASSWORD_FILE",
]);

/** Key names that look like credentials are denied even when an allowlist names them. */
export const DENIED_ENV_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|_KEY$|^KEY$|AUTH)/i;

export interface BuildEnvOptions {
  /** Keys the request asked for (already syntax-validated by the contract). */
  requested_keys: readonly string[];
  /** Keys the operator permits elevated tasks to receive, beyond BASE_ENV_KEYS. */
  allowed_keys: readonly string[];
  /** Source environment (never mutated). */
  source: Record<string, string | undefined>;
  /** Extra fixed values (CI=1, NO_COLOR=1 by default). */
  fixed?: Record<string, string>;
}

export interface BuildEnvResult {
  env: Record<string, string>;
  /** Requested keys that were not forwarded and why. */
  refused: Array<{ key: string; reason: "denied" | "not_allowed" | "unset" }>;
}

export function buildExecutionEnv(options: BuildEnvOptions): BuildEnvResult {
  const env: Record<string, string> = { CI: "1", NO_COLOR: "1", ...(options.fixed ?? {}) };
  for (const key of BASE_ENV_KEYS) {
    const value = options.source[key];
    if (value !== undefined) env[key] = value;
  }
  const allowed = new Set(options.allowed_keys);
  const refused: BuildEnvResult["refused"] = [];
  for (const key of options.requested_keys) {
    if (DENIED_ENV_KEYS.has(key) || DENIED_ENV_KEY_PATTERN.test(key)) {
      refused.push({ key, reason: "denied" });
      continue;
    }
    if (!allowed.has(key) && !(BASE_ENV_KEYS as readonly string[]).includes(key)) {
      refused.push({ key, reason: "not_allowed" });
      continue;
    }
    const value = options.source[key];
    if (value === undefined) {
      refused.push({ key, reason: "unset" });
      continue;
    }
    env[key] = value;
  }
  return { env, refused };
}

/** Values present in the source environment that must never appear in output. */
export function collectSecretValues(source: Record<string, string | undefined>, extra: Iterable<string> = []): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    if (!value || value.length < 8) continue;
    if (DENIED_ENV_KEYS.has(key) || DENIED_ENV_KEY_PATTERN.test(key)) values.add(value);
  }
  for (const value of extra) if (value && value.length >= 8) values.add(value);
  return [...values];
}

// ─── Bounded execution ────────────────────────────────────────────────────────

export const DEFAULT_GRACE_MS = 2_000;
export const DEFAULT_HARD_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
export const MAX_TIMEOUT_MS = 900_000;

export type ExecutionFailureCode =
  | "spawn_failed"
  | "timed_out"
  | "output_limit_exceeded"
  | "killed"
  | "nonzero_exit";

export interface BoundedExecutionOptions {
  timeout_ms: number;
  output_cap_bytes?: number;
  hard_output_limit_bytes?: number;
  grace_ms?: number;
  env: Record<string, string>;
  /** Secret values to scrub from output (value match). */
  secrets: Iterable<string>;
  now?: () => Date;
  /** Observes the spawned child so a caller can terminate it on shutdown. */
  onSpawn?: (child: Bun.Subprocess) => void;
  onExit?: (child: Bun.Subprocess) => void;
}

export interface BoundedExecutionOutcome extends ElevatedExecutionResult {
  pid: number | null;
  /** Escalation actually sent by the executor, if any. */
  kill_signal: "SIGTERM" | "SIGKILL" | null;
  timed_out: boolean;
  output_limit_exceeded: boolean;
  /** Full redacted output (the hash in `output_sha256` covers exactly this text). */
  full_output: string;
  failure: ExecutionFailureCode | null;
  error_message: string | null;
}

async function drain(
  stream: ReadableStream<Uint8Array> | number | undefined | null,
  sink: { chunks: Uint8Array[]; bytes: number },
  limit: number,
  onLimit: () => void,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (sink.bytes + value.byteLength > limit) {
        const remaining = Math.max(0, limit - sink.bytes);
        if (remaining > 0) sink.chunks.push(value.subarray(0, remaining));
        sink.bytes = limit;
        onLimit();
        // Keep draining so the child cannot block on a full pipe before the kill lands.
        continue;
      }
      sink.chunks.push(value);
      sink.bytes += value.byteLength;
    }
  } catch {
    // Stream errors after a kill are expected.
  } finally {
    reader.releaseLock();
  }
}

function decode(sink: { chunks: Uint8Array[] }): string {
  return Buffer.concat(sink.chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** Executes one argv without a shell under the configured bounds. Never throws. */
export async function executeBounded(
  command: ElevatedCommand,
  request_id: string,
  options: BoundedExecutionOptions,
): Promise<BoundedExecutionOutcome> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, options.timeout_ms));
  const graceMs = Math.max(100, options.grace_ms ?? DEFAULT_GRACE_MS);
  const capBytes = options.output_cap_bytes ?? OUTPUT_CAP_BYTES;
  const hardLimit = Math.max(capBytes, options.hard_output_limit_bytes ?? DEFAULT_HARD_OUTPUT_LIMIT_BYTES);
  const secrets = [...options.secrets];
  const executedAt = now();
  const startedMs = Date.now();

  const finish = (partial: {
    exit_code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    pid: number | null;
    kill_signal: "SIGTERM" | "SIGKILL" | null;
    timed_out: boolean;
    output_limit_exceeded: boolean;
    failure: ExecutionFailureCode | null;
    error_message: string | null;
  }): BoundedExecutionOutcome => {
    const combined = partial.stderr
      ? `${partial.stdout}${partial.stdout && !partial.stdout.endsWith("\n") ? "\n" : ""}--- stderr ---\n${partial.stderr}`
      : partial.stdout;
    const fullOutput = redactSecrets(combined, secrets);
    const capped = truncateAndHashOutput(fullOutput, capBytes);
    const completedAt = now();
    return {
      request_id,
      exit_code: partial.exit_code,
      signal: partial.signal,
      output: capped.output,
      output_sha256: capped.sha256,
      output_bytes: capped.originalLength,
      truncated: capped.truncated,
      duration_ms: Math.max(0, Date.now() - startedMs),
      executed_at: executedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      pid: partial.pid,
      kill_signal: partial.kill_signal,
      timed_out: partial.timed_out,
      output_limit_exceeded: partial.output_limit_exceeded,
      full_output: fullOutput,
      failure: partial.failure,
      error_message: partial.error_message ? redactSecrets(partial.error_message, secrets) : null,
    };
  };

  let child: Bun.Subprocess;
  try {
    child = Bun.spawn(command.argv, {
      cwd: command.cwd,
      env: options.env,
      stdin: command.stdin === null ? "ignore" : Buffer.from(command.stdin, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return finish({
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      pid: null,
      kill_signal: null,
      timed_out: false,
      output_limit_exceeded: false,
      failure: "spawn_failed",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
  options.onSpawn?.(child);

  let killSignal: "SIGTERM" | "SIGKILL" | null = null;
  let timedOut = false;
  let limitExceeded = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const escalate = (): void => {
    if (killSignal === null) {
      killSignal = "SIGTERM";
      try { child.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        killSignal = "SIGKILL";
        try { child.kill("SIGKILL"); } catch {}
      }, graceMs);
    }
  };
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    escalate();
  }, timeoutMs);

  const stdoutSink = { chunks: [] as Uint8Array[], bytes: 0 };
  const stderrSink = { chunks: [] as Uint8Array[], bytes: 0 };
  const onLimit = (): void => {
    if (!limitExceeded) {
      limitExceeded = true;
      escalate();
    }
  };

  try {
    const [exitCode] = await Promise.all([
      child.exited,
      drain(child.stdout as ReadableStream<Uint8Array>, stdoutSink, hardLimit, onLimit),
      drain(child.stderr as ReadableStream<Uint8Array>, stderrSink, hardLimit, onLimit),
    ]);
    const signal = child.signalCode ?? null;
    const exit = signal === null ? exitCode : null;
    let failure: ExecutionFailureCode | null = null;
    let message: string | null = null;
    if (timedOut) {
      failure = "timed_out";
      message = `command exceeded ${timeoutMs}ms and was terminated with ${killSignal ?? "SIGTERM"}`;
    } else if (limitExceeded) {
      failure = "output_limit_exceeded";
      message = `command produced more than ${hardLimit} bytes and was terminated`;
    } else if (signal !== null) {
      failure = "killed";
      message = `command was terminated by ${signal}`;
    } else if (exit !== 0) {
      failure = "nonzero_exit";
      message = `command exited with code ${exit}`;
    }
    return finish({
      exit_code: exit,
      signal,
      stdout: decode(stdoutSink),
      stderr: decode(stderrSink),
      pid: child.pid,
      kill_signal: killSignal,
      timed_out: timedOut,
      output_limit_exceeded: limitExceeded,
      failure,
      error_message: message,
    });
  } finally {
    clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    options.onExit?.(child);
  }
}

/** Convenience for callers that only need the contract result and the full text. */
export function toExecutionResult(outcome: BoundedExecutionOutcome): ElevatedExecutionResult {
  return {
    request_id: outcome.request_id,
    exit_code: outcome.exit_code,
    signal: outcome.signal,
    output: outcome.output,
    output_sha256: outcome.output_sha256,
    output_bytes: outcome.output_bytes,
    truncated: outcome.truncated,
    duration_ms: outcome.duration_ms,
    executed_at: outcome.executed_at,
    completed_at: outcome.completed_at,
  };
}

/** Recomputes the hash a persisted full-output file must match. */
export function hashFullOutput(text: string): string {
  return sha256Hex(text);
}
