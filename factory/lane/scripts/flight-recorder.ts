#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * Observation Deck P0 — flight recorder.
 *
 * Append-only, fail-open JSONL journal of in-flight factory activity
 * (state/flight/journal-<YYYY-MM-DD>.jsonl) plus a raw per-execution output
 * log (state/flight/exec-<id>.log) that the P2 streaming seam tees executor
 * chunks into. This is the factory's window, not a control surface:
 *
 *   - Every write is wrapped — recording can NEVER fail or slow a run.
 *   - Nothing here writes to stdout: conveyor scripts' stdout is consumed by
 *     shell pipes in the agent prompt (single-line JSON contract).
 *   - Events are single-line JSON, one per line; readers tolerate corrupt
 *     lines (a torn concurrent append must not blind the whole window).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface FlightEvent {
  /** ISO timestamp (stamped by recordFlight when absent). */
  ts?: string;
  execution_id: string;
  /** Ticket identifier, e.g. ZOU-544. */
  identifier: string;
  /**
   * Lifecycle kind. Producers use:
   *   gate.decision | exec.start | exec.queued | exec.dry-run | exec.held | exec.pool-enqueued |
   *   probe.ok | probe.unhealthy | executor.start | executor.heartbeat |
   *   executor.ok | executor.fail | executor.throw | fallback.zo-ask |
   *   exec.complete | exec.failed
   */
  kind: string;
  /** Short human-readable line (capped at DETAIL_CAP on write). */
  detail?: string;
  /** Small structured extras (executor id, durations, scores). */
  data?: Record<string, unknown>;
}

export const DETAIL_CAP = 500;
const JOURNAL_RETENTION_DAYS = 14;
const EXEC_LOG_RETENTION_DAYS = 14;

const DEFAULT_DIR = factoryStatePath("flight");

let warnedOnce = false;
function warn(msg: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.error(`[flight] recorder degraded (non-blocking, further warnings suppressed) — ${msg}`);
}

export function flightDir(dir?: string): string {
  return dir ?? DEFAULT_DIR;
}

function dayStamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function journalPath(dir?: string, d: Date = new Date()): string {
  return join(flightDir(dir), `journal-${dayStamp(d)}.jsonl`);
}

export function execLogPath(executionId: string, dir?: string): string {
  // execution_id is factory-generated (exec-<hex8>) but sanitize anyway —
  // this path is derived from data that transited Linear.
  const safe = executionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return join(flightDir(dir), `${safe}.log`);
}

/** Append one event to today's journal. Fail-open: never throws. */
export function recordFlight(event: FlightEvent, dir?: string): void {
  try {
    const d = flightDir(dir);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const e: FlightEvent = {
      ...event,
      ts: event.ts ?? new Date().toISOString(),
      detail: event.detail !== undefined ? event.detail.slice(0, DETAIL_CAP) : undefined,
    };
    appendFileSync(journalPath(dir), JSON.stringify(e) + "\n");
    pruneOncePerProcess(d);
  } catch (err: any) {
    warn(err?.message ?? String(err));
  }
}

/** Append raw streamed executor output to the per-exec log. Fail-open. */
export function appendExecLog(executionId: string, text: string, dir?: string): void {
  if (!text) return;
  try {
    const d = flightDir(dir);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    appendFileSync(execLogPath(executionId, dir), text);
  } catch (err: any) {
    warn(err?.message ?? String(err));
  }
}

/**
 * Read journal events for the last `days` journal files (default 2: today +
 * yesterday — a run that crosses midnight stays visible). Corrupt lines are
 * skipped. Never throws; missing dir → [].
 */
export function readFlightEvents(opts: { dir?: string; days?: number } = {}): FlightEvent[] {
  const days = opts.days ?? 2;
  const events: FlightEvent[] = [];
  try {
    const d = flightDir(opts.dir);
    if (!existsSync(d)) return [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000);
      const p = journalPath(opts.dir, date);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as FlightEvent;
          if (e && typeof e.execution_id === "string" && typeof e.kind === "string") events.push(e);
        } catch {
          // torn/corrupt line — skip, never blind the window
        }
      }
    }
  } catch (err: any) {
    warn(err?.message ?? String(err));
  }
  return events;
}

/** Last `maxLines` lines of an execution's raw output log. Never throws. */
export function tailExecLog(executionId: string, maxLines = 60, dir?: string): string[] {
  try {
    const p = execLogPath(executionId, dir);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf-8").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

// ─── Retention ────────────────────────────────────────────────────────────────

let pruned = false;
function pruneOncePerProcess(dir: string): void {
  if (pruned) return;
  pruned = true;
  try {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      const journal = f.match(/^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (journal) {
        const age = now - Date.parse(journal[1] + "T00:00:00Z");
        if (age > JOURNAL_RETENTION_DAYS * 86_400_000) unlinkSync(join(dir, f));
        continue;
      }
      if (/^exec-[a-zA-Z0-9_-]+\.log$/.test(f)) {
        const { mtimeMs } = statSync(join(dir, f));
        if (now - mtimeMs > EXEC_LOG_RETENTION_DAYS * 86_400_000) unlinkSync(join(dir, f));
      }
    }
  } catch {
    // retention is best-effort
  }
}

/** Test seam: reset the once-per-process latches. */
export function _resetForTest(): void {
  pruned = false;
  warnedOnce = false;
}
