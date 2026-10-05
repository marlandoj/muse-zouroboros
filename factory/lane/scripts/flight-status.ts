#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * Observation Deck P3 — flight-status aggregator.
 *
 * Joins the flight journal (state/flight/journal-*.jsonl) with the factory's
 * exec-*.json records into a single "what is the factory doing right now"
 * view: live runs (current executor, last-event age, streamed bytes, raw log
 * tail) plus recently-terminal runs. Pure by construction — computeFlightStatus
 * takes injected events/records/now/tail so the selftest is hermetic; the CLI
 * wires the real readers and prints SINGLE-LINE JSON on stdout (conveyor
 * scripts' stdout is consumed by shell pipes — keep the contract).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readFlightEvents, tailExecLog, type FlightEvent } from "./flight-recorder";
import { isExecutionRecordFileName, isTerminalExecution, normalizeExecutionLifecycle } from "./execution-lifecycle";

/** Lifecycle kinds after which a run is no longer in-flight in THIS process. */
export const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  "exec.complete",
  "exec.implementation_complete",
  "exec.failed",
  "exec.dry-run",
  "exec.held",
  "exec.queued", // DIRECT hand-off: this process is done; inline agent takes over
  "exec.pool-enqueued", // SF-003 hand-off: pool-manager owns it from here
  // Bookkeeping pseudo-executions. The serial promoter and the post-merge
  // reconciler write flight events under synthetic ids (serial-<twin>,
  // reconcile-<ticket>) but are not executor runs, so they never emit an
  // exec.* lifecycle kind and carry no completed_at. Without these entries
  // every promotion and every reconcile pass accrued as a permanently "live,
  // stale" run — 16 of them by 2026-07-26, all finished work — burying any
  // genuine hang in phantoms and defeating the point of the stale flag.
  "serial-promotion.canonical-complete", // closes serial-<twin>, opened by .promoted
  "serial-promotion.no-reachable-lane", // self-contained: opens and closes serial-lanes
  "reconcile.enforced", // last recordFlight of an enforcing pass
  "reconcile.shadow", // same, shadow mode
]);

/** Subset of PipelineExecution the aggregator enriches from (tolerates old rows). */
export interface ExecRecordLite extends Record<string, unknown> {
  execution_id: string;
  identifier?: string;
  gate_decision?: string;
  status?: string;
  started_at?: string;
  completed_at?: string | null;
  result_summary?: string | null;
  error?: string | null;
  model_used?: string;
  state?: unknown;
  stage?: unknown;
  delivery_target?: unknown;
  state_updated_at?: unknown;
  evidence?: unknown;
  post_merge_survivability?: unknown;
  post_merge_survivability_reason?: unknown;
  post_merge_survivability_checks?: unknown;
}

export interface FlightRunView {
  execution_id: string;
  identifier: string;
  live: boolean;
  /** live && last event older than staleAfterMs — likely a dead/hung run. */
  stale: boolean;
  status: string | null;
  gate_decision: string | null;
  current_executor: string | null;
  executors_tried: string[];
  fell_back_to_ask: boolean;
  streamed_bytes: number | null;
  event_count: number;
  first_event_ts: string | null;
  last_event_ts: string | null;
  last_event_kind: string | null;
  last_event_detail: string | null;
  last_event_age_s: number | null;
  result_summary: string | null;
  error: string | null;
  log_tail: string[];
}

export interface FlightStatus {
  generated_at: string;
  live: FlightRunView[];
  recent: FlightRunView[];
  counts: {
    executions: number;
    live: number;
    stale: number;
    recent: number;
    events: number;
    by_kind: Record<string, number>;
  };
}

export interface ComputeFlightStatusArgs {
  events: FlightEvent[];
  execRecords: ExecRecordLite[];
  nowMs: number;
  /** Raw-output tail reader; injected so the core stays fs-free. */
  tail: (executionId: string) => string[];
  /** live runs quieter than this are flagged stale (default 10 min). */
  staleAfterMs?: number;
  /** cap on terminal runs returned (default 20, newest first). */
  recentCap?: number;
}

function parseTs(ts: string | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

export function computeFlightStatus(args: ComputeFlightStatusArgs): FlightStatus {
  const staleAfterMs = args.staleAfterMs ?? 10 * 60_000;
  const recentCap = args.recentCap ?? 20;

  const byExec = new Map<string, FlightEvent[]>();
  const byKind: Record<string, number> = {};
  for (const e of args.events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const list = byExec.get(e.execution_id);
    if (list) list.push(e);
    else byExec.set(e.execution_id, [e]);
  }

  const recById = new Map(args.execRecords.map((r) => [r.execution_id, r]));

  const views: FlightRunView[] = [];
  for (const [execution_id, evs] of byExec) {
    evs.sort((a, b) => (parseTs(a.ts) ?? 0) - (parseTs(b.ts) ?? 0));
    const rec = recById.get(execution_id);

    let currentExecutor: string | null = null;
    const tried: string[] = [];
    let streamedBytes: number | null = null;
    let fellBack = false;
    let sawTerminal = false;
    for (const e of evs) {
      const ex = typeof e.data?.executor === "string" ? (e.data.executor as string) : null;
      switch (e.kind) {
        case "executor.start":
          currentExecutor = ex;
          if (ex && !tried.includes(ex)) tried.push(ex);
          break;
        case "executor.ok":
        case "executor.fail":
        case "executor.throw":
          currentExecutor = null;
          break;
        case "executor.heartbeat":
          if (typeof e.data?.bytes === "number") streamedBytes = e.data.bytes as number;
          break;
        case "fallback.zo-ask":
          fellBack = true;
          currentExecutor = null;
          break;
      }
      if (TERMINAL_KINDS.has(e.kind)) sawTerminal = true;
    }

    const last = evs[evs.length - 1];
    const lastMs = parseTs(last.ts);
    const lifecycle = rec ? normalizeExecutionLifecycle(rec) : null;
    // A pool enqueue is a hand-off terminal for this process even though the
    // campaign remains live under pool-manager. completed_at remains a torn-
    // journal compatibility guard for legacy records.
    const processTerminal = lifecycle !== null && (
      lifecycle.state === "pool_enqueued" || isTerminalExecution(lifecycle)
    );
    const live = !sawTerminal && !processTerminal && !(rec?.completed_at);
    const ageMs = lastMs === null ? null : args.nowMs - lastMs;

    views.push({
      execution_id,
      identifier: last.identifier ?? rec?.identifier ?? "unknown",
      live,
      stale: live && ageMs !== null && ageMs > staleAfterMs,
      status: lifecycle?.state ?? rec?.status ?? null,
      gate_decision: rec?.gate_decision ?? null,
      current_executor: live ? currentExecutor : null,
      executors_tried: tried,
      fell_back_to_ask: fellBack,
      streamed_bytes: streamedBytes,
      event_count: evs.length,
      first_event_ts: evs[0].ts ?? null,
      last_event_ts: last.ts ?? null,
      last_event_kind: last.kind,
      last_event_detail: last.detail ?? null,
      last_event_age_s: ageMs === null ? null : Math.round(ageMs / 1000),
      result_summary: rec?.result_summary ?? null,
      error: rec?.error ?? null,
      log_tail: live ? args.tail(execution_id) : [],
    });
  }

  const byLastDesc = (a: FlightRunView, b: FlightRunView) =>
    (b.last_event_ts ?? "").localeCompare(a.last_event_ts ?? "");
  const liveRuns = views.filter((v) => v.live).sort(byLastDesc);
  const recent = views
    .filter((v) => !v.live)
    .sort(byLastDesc)
    .slice(0, recentCap)
    // terminal runs keep a short tail too — the last thing the executor said
    .map((v) => ({ ...v, log_tail: args.tail(v.execution_id).slice(-10) }));

  return {
    generated_at: new Date(args.nowMs).toISOString(),
    live: liveRuns,
    recent,
    counts: {
      executions: views.length,
      live: liveRuns.length,
      stale: liveRuns.filter((v) => v.stale).length,
      recent: recent.length,
      events: args.events.length,
      by_kind: byKind,
    },
  };
}

// ─── Real readers (CLI seam) ────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();

export function readExecRecords(stateDir: string = STATE_DIR): ExecRecordLite[] {
  const out: ExecRecordLite[] = [];
  try {
    if (!existsSync(stateDir)) return out;
    for (const name of readdirSync(stateDir)) {
      if (!isExecutionRecordFileName(name)) continue;
      try {
        const rec = JSON.parse(readFileSync(join(stateDir, name), "utf-8"));
        if (rec && typeof rec.execution_id === "string") out.push(rec);
      } catch {
        // corrupt record — skip, never blind the window
      }
    }
  } catch {
    // missing/unreadable dir — empty view beats a crash
  }
  return out;
}

export function collectFlightStatus(opts: { days?: number; tailLines?: number } = {}): FlightStatus {
  const tailLines = opts.tailLines ?? 30;
  return computeFlightStatus({
    events: readFlightEvents({ days: opts.days ?? 2 }),
    execRecords: readExecRecords(),
    nowMs: Date.now(),
    tail: (id) => tailExecLog(id, tailLines),
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const num = (flag: string, dflt: number): number => {
    const i = args.indexOf(flag);
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const status = collectFlightStatus({ days: num("--days", 2), tailLines: num("--tail", 30) });
  // single-line JSON — conveyor stdout contract
  console.log(JSON.stringify(status));
}
