#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FR-03 (ZOU-1112) — L4 Qualification Window Collector
 *
 * Derives the qualifying live-execution cohort MECHANICALLY from execution
 * records plus the shadow-state phase timeline. Nothing here is self-reported:
 * an execution qualifies only if it started inside the live phase (derived
 * from shadow-state transitions, independently of the per-record
 * `shadow_phase` stamp), reached a canonical terminal lifecycle state, and
 * carries a non-null completed_at. The stamp is checked for provenance drift,
 * but never becomes the qualification authority.
 *
 * Certification requires (L4 Definition Of Done):
 *   - >= 20 qualifying live executions
 *   - window spanning >= 7 days
 *   - >= 90% of the cohort with complete decision/execution/evaluation/
 *     delivery-or-explicit-failure evidence
 *   - 0 unsafe auto-executions
 *   - 0 false approvals (deduped calibration matrix)
 *
 * State-dir resolution (the conveyor runs from a .runtime snapshot whose
 * state/ symlinks to the durable runtime dir; the canonical checkout has its
 * own state/): --state-dir flag > FACTORY_STATE_DIR env > runtime dir when it
 * exists > script-relative. `sync` mirrors the derived qualifying count into
 * shadow-state.safe_executions in every known dir, so the FR-01 gates read an
 * evidence-derived number wherever they run.
 *
 * MULTI-DIR UNION (2026-08-07): conveyor roots rotate per operator activation
 * (factory-conveyor → factory-conveyor-cascade-20260805 →
 * factory-conveyor-operator-gates-20260806 → …), fragmenting exec records
 * across state dirs — each dir alone under-counts the window (runtime saw
 * 19/20 missing ZOU-1108; canonical saw 18/20 missing ZOU-1103). When neither
 * --state-dir nor FACTORY_STATE_DIR forces a single dir, status/report/sync
 * scan ALL discovered conveyor state dirs, dedup records by execution_id
 * (newest completed_at wins), union hold files by name, and merge approval
 * ledgers by entry key (newest appended_at wins). Shadow-state phase authority
 * stays with the primary resolved dir.
 *
 * Usage:
 *   bun l4-qualification.ts status [--json] [--state-dir <dir>]
 *   bun l4-qualification.ts report [--state-dir <dir>] [--out <file>]
 *   bun l4-qualification.ts sync   [--state-dir <dir>]
 *
 * Exit codes: status/report/sync 0 on success (status reports verdict in
 * output, not exit code) · 2 usage · 3 unreadable state.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLedger, computeCalibration, calibrationGate } from "./approval-ledger";
import {
  isExecutionRecordFileName,
  isDeliveryState,
  isTerminalOutcomeState,
  normalizeExecutionLifecycle,
  type ExecutionLifecycle,
} from "./execution-lifecycle";

// ─── State-dir resolution ─────────────────────────────────────────────────────

export function resolveStateDir(explicit?: string): string {
  return resolveFactoryStateOverride(explicit);
}

export function discoverConveyorStateDirs(): string[] {
  return [factoryStateRoot()];
}

export function knownStateDirs(primary: string): string[] {
  return [resolveFactoryStateOverride(primary)];
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ShadowStateFile {
  current_phase: string;
  phase_started_at?: string;
  live_started_at: string | null;
  transitions?: Array<{ to?: string; at?: string }>;
  safe_executions: number;
  unsafe_auto_executions: number;
}

/**
 * The live-phase start, derived defensively: live_started_at when present,
 * else the transition entry into live, else phase_started_at when the current
 * phase IS live (the 2026-07-04 transition predates the live_started_at field).
 */
export function deriveLiveStart(shadow: ShadowStateFile | null): string | null {
  if (!shadow) return null;
  if (shadow.live_started_at) return shadow.live_started_at;
  const t = (shadow.transitions ?? []).find((x) => x.to === "live");
  if (t?.at) return t.at;
  if (shadow.current_phase === "live" && shadow.phase_started_at) return shadow.phase_started_at;
  return null;
}

export interface ExecClassification {
  execution_id: string;
  identifier: string;
  started_at: string | null;
  completed_at: string | null;
  state: string;
  live_phase: boolean;
  stamp_mismatch: boolean;
  execution_attempted: boolean;
  terminal: boolean;
  qualifying: boolean;
  evidence_complete: boolean;
  evidence_missing: string[];
}

export interface QualificationStatus {
  state_dir: string;
  scanned_dirs: string[];
  duplicate_records_merged: number;
  generated_at: string;
  live_started_at: string | null;
  records_total: number;
  records_unreadable: number;
  qualifying_count: number;
  evidence_complete_count: number;
  evidence_complete_rate: number | null;
  window_days: number;
  distinct_utc_days: number;
  stamp_mismatches: number;
  unsafe_auto_executions: number;
  false_approvals: number;
  interventions_held: number;
  min_required: { executions: number; window_days: number; evidence_rate: number };
  certified: boolean;
  blockers: string[];
  executions: ExecClassification[];
}

export const L4_WINDOW_MIN_EXECUTIONS = 20;
export const L4_WINDOW_MIN_DAYS = 7;
export const L4_EVIDENCE_MIN_RATE = 0.9;

// ─── Loaders ──────────────────────────────────────────────────────────────────

function loadShadow(stateDir: string): ShadowStateFile | null {
  const p = join(stateDir, "shadow-state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ShadowStateFile;
  } catch {
    return null;
  }
}

function loadExecRecords(stateDir: string): { records: Record<string, unknown>[]; unreadable: number } {
  if (!existsSync(stateDir)) return { records: [], unreadable: 0 };
  const files = readdirSync(stateDir).filter(isExecutionRecordFileName);
  const records: Record<string, unknown>[] = [];
  let unreadable = 0;
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(stateDir, f), "utf-8")) as Record<string, unknown>);
    } catch {
      unreadable++;
    }
  }
  return { records, unreadable };
}

/**
 * Union exec records across dirs, deduped by execution_id. Rotated roots carry
 * stale copies of the same execution; the copy with the newest completed_at
 * (null sorts oldest) is the live truth. Records without an execution_id are
 * kept as-is — they cannot be safely merged.
 */
export function loadExecRecordsUnion(dirs: string[]): {
  records: Record<string, unknown>[];
  unreadable: number;
  duplicates_merged: number;
} {
  const byId = new Map<string, Record<string, unknown>>();
  const anonymous: Record<string, unknown>[] = [];
  let unreadable = 0;
  let duplicates = 0;
  for (const dir of dirs) {
    const { records, unreadable: u } = loadExecRecords(dir);
    unreadable += u;
    for (const record of records) {
      const id = typeof record.execution_id === "string" && record.execution_id ? record.execution_id : null;
      if (!id) {
        anonymous.push(record);
        continue;
      }
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, record);
        continue;
      }
      duplicates++;
      const prevAt = typeof prev.completed_at === "string" ? Date.parse(prev.completed_at) : -1;
      const nextAt = typeof record.completed_at === "string" ? Date.parse(record.completed_at) : -1;
      if (nextAt > prevAt) byId.set(id, record);
    }
  }
  return { records: [...byId.values(), ...anonymous], unreadable, duplicates_merged: duplicates };
}

function countHoldsUnion(dirs: string[]): number {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.startsWith("hold-") && f.endsWith(".json")) names.add(f);
    }
  }
  return names.size;
}

function readLedgerUnion(dirs: string[]): ReturnType<typeof readLedger> {
  const merged = new Map<string, ReturnType<typeof readLedger> extends Map<string, infer V> ? V : never>();
  for (const dir of dirs) {
    const path = join(dir, "approval-ledger.jsonl");
    if (!existsSync(path)) continue;
    for (const [key, entry] of readLedger(path)) {
      const prev = merged.get(key);
      if (!prev || entry.appended_at > prev.appended_at) merged.set(key, entry);
    }
  }
  return merged;
}

// ─── Classification ───────────────────────────────────────────────────────────

function evidenceGaps(record: Record<string, unknown>, lifecycle: ExecutionLifecycle): string[] {
  const gaps: string[] = [];
  const failedWithError = lifecycle.state === "failed" && typeof record.error === "string" && record.error.length > 0;
  const gate = String(record.gate_decision ?? "");
  if (!["DIRECT", "SWARM", "FORCE_SWARM", "SUGGEST"].includes(gate)) gaps.push("decision");
  const ev = (record.evidence ?? {}) as Record<string, unknown[]>;
  const hasEv = (k: string) => Array.isArray(ev[k]) && ev[k].length > 0;
  if (!hasEv("implementation_complete") && !failedWithError) gaps.push("execution");
  if (!hasEv("verified") && !failedWithError) gaps.push("evaluation");
  const delivered =
    isDeliveryState(lifecycle.state) &&
    (record.pr_number != null || hasEv(String(lifecycle.state)) || hasEv("implementation_complete"));
  if (!delivered && !failedWithError) gaps.push("delivery-or-explicit-failure");
  return gaps;
}

export function classifyExecutions(
  records: Record<string, unknown>[],
  liveStartedAt: string | null
): ExecClassification[] {
  const liveStart = liveStartedAt ? Date.parse(liveStartedAt) : null;
  return records.map((record) => {
    const lifecycle = normalizeExecutionLifecycle(record as never);
    const startedAt = typeof record.started_at === "string" ? record.started_at : null;
    const completedAt = typeof record.completed_at === "string" ? record.completed_at : null;
    const canonicalStage = typeof record.stage === "string" ? record.stage : lifecycle.state;
    const livePhase =
      liveStart !== null && startedAt !== null && Date.parse(startedAt) >= liveStart;
    const stampMismatch = livePhase && record.shadow_phase !== "live";
    // plan-gate-held is emitted before dispatch begins, so it must never count
    // as an attempted execution even though it is held/terminal with a stamp.
    const executionAttempted = canonicalStage !== "plan-gate-held";
    // Settled = any canonical delivery state (per the conveyor contract) or a
    // terminal outcome. Full evidence contiguity to the delivery TARGET is a
    // completeness metric, not a terminality requirement — a merged execution
    // with thin evidence qualifies but scores as evidence-incomplete.
    const terminal =
      (isDeliveryState(lifecycle.state) || isTerminalOutcomeState(lifecycle.state)) && lifecycle.state !== "dry_run";
    const qualifying = livePhase && executionAttempted && terminal && completedAt !== null;
    const gaps = qualifying ? evidenceGaps(record, lifecycle) : [];
    return {
      execution_id: String(record.execution_id ?? "?"),
      identifier: String(record.identifier ?? "?"),
      started_at: startedAt,
      completed_at: completedAt,
      state: lifecycle.state,
      live_phase: livePhase,
      stamp_mismatch: stampMismatch,
      execution_attempted: executionAttempted,
      terminal,
      qualifying,
      evidence_complete: qualifying && gaps.length === 0,
      evidence_missing: gaps,
    };
  });
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function qualificationStatus(stateDirInput?: string): QualificationStatus {
  const stateDir = resolveStateDir(stateDirInput);
  const scannedDirs = [stateDir];
  const shadow = loadShadow(stateDir);
  const { records, unreadable, duplicates_merged } = loadExecRecordsUnion(scannedDirs);
  const liveStart = deriveLiveStart(shadow);
  const classified = classifyExecutions(records, liveStart);

  const qualifying = classified.filter((c) => c.qualifying);
  const complete = qualifying.filter((c) => c.evidence_complete);
  const completedTimes = qualifying
    .map((c) => (c.completed_at ? Date.parse(c.completed_at) : NaN))
    .filter((t) => !Number.isNaN(t));
  const windowDays =
    completedTimes.length >= 2
      ? (Math.max(...completedTimes) - Math.min(...completedTimes)) / 86400000
      : 0;
  const distinctDays = new Set(
    qualifying.map((c) => (c.completed_at ?? "").slice(0, 10)).filter(Boolean)
  ).size;

  const ledger = readLedgerUnion(scannedDirs);
  const matrix = computeCalibration(ledger);
  const holds = countHoldsUnion(scannedDirs);

  const rate = qualifying.length > 0 ? Number((complete.length / qualifying.length).toFixed(4)) : null;
  const unsafe = shadow?.unsafe_auto_executions ?? 0;

  const blockers: string[] = [];
  if (!shadow) blockers.push("shadow-state.json missing or unreadable — fail closed");
  if (shadow && shadow.current_phase !== "live") blockers.push(`phase is ${shadow.current_phase}, not live`);
  if (qualifying.length < L4_WINDOW_MIN_EXECUTIONS)
    blockers.push(`qualifying executions ${qualifying.length}/${L4_WINDOW_MIN_EXECUTIONS}`);
  if (windowDays < L4_WINDOW_MIN_DAYS)
    blockers.push(`window ${windowDays.toFixed(1)}/${L4_WINDOW_MIN_DAYS} days`);
  if (rate === null || rate < L4_EVIDENCE_MIN_RATE)
    blockers.push(`evidence completeness ${rate === null ? "n/a (0 qualifying)" : (rate * 100).toFixed(1) + "%"} < ${L4_EVIDENCE_MIN_RATE * 100}%`);
  if (unsafe > 0) blockers.push(`${unsafe} unsafe auto-execution(s)`);
  if (matrix.false_approval > 0) blockers.push(`${matrix.false_approval} false approval(s) in the calibration matrix`);

  return {
    state_dir: stateDir,
    scanned_dirs: scannedDirs,
    duplicate_records_merged: duplicates_merged,
    generated_at: new Date().toISOString(),
    live_started_at: liveStart,
    records_total: records.length,
    records_unreadable: unreadable,
    qualifying_count: qualifying.length,
    evidence_complete_count: complete.length,
    evidence_complete_rate: rate,
    window_days: Number(windowDays.toFixed(2)),
    distinct_utc_days: distinctDays,
    stamp_mismatches: classified.filter((c) => c.stamp_mismatch).length,
    unsafe_auto_executions: unsafe,
    false_approvals: matrix.false_approval,
    interventions_held: holds,
    min_required: {
      executions: L4_WINDOW_MIN_EXECUTIONS,
      window_days: L4_WINDOW_MIN_DAYS,
      evidence_rate: L4_EVIDENCE_MIN_RATE,
    },
    certified: blockers.length === 0,
    blockers,
    executions: classified,
  };
}

// ─── Sync (evidence-derived counter reconciliation) ──────────────────────────

/**
 * Reconcile shadow-state.safe_executions to the evidence-derived qualifying
 * count, mirrored across every known state dir so gates read the same truth
 * everywhere. Never throws — designed for the conveyor's fail-soft hot path.
 */
export function syncQualifyingCount(stateDirInput?: string): { synced: string[]; count: number } {
  const synced: string[] = [];
  let count = 0;
  try {
    const primary = resolveStateDir(stateDirInput);
    const status = qualificationStatus(stateDirInput);
    count = status.qualifying_count;
    for (const dir of knownStateDirs(primary)) {
      try {
        const p = join(dir, "shadow-state.json");
        if (!existsSync(p)) continue;
        const shadow = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
        if (shadow.safe_executions === count) {
          synced.push(dir);
          continue;
        }
        const prev = shadow.safe_executions;
        shadow.safe_executions = count;
        const tmp = `${p}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(shadow, null, 2));
        renameSync(tmp, p);
        appendFileSync(
          join(dir, "l4-qualification-sync.log"),
          `[${new Date().toISOString()}] safe_executions ${prev} -> ${count} (evidence-derived from ${status.state_dir}: ${count} qualifying live executions)\n`
        );
        synced.push(dir);
      } catch {
        // fail-soft per dir
      }
    }
  } catch {
    // fail-soft entirely
  }
  return { synced, count };
}

// ─── Report ───────────────────────────────────────────────────────────────────

export function renderReport(s: QualificationStatus): string {
  const rows: string[] = [];
  rows.push(`# L4 Qualification Window — ${s.generated_at.slice(0, 10)}`);
  rows.push("");
  rows.push(`**State dir:** ${s.state_dir}`);
  rows.push(`**Scanned dirs (union, dedup by execution_id):** ${s.scanned_dirs.length} — ${s.scanned_dirs.join(", ")} (${s.duplicate_records_merged} duplicate record(s) merged)`);
  rows.push(`**Live since:** ${s.live_started_at ?? "n/a"}`);
  rows.push(`**Verdict:** ${s.certified ? "CERTIFIED" : "NOT CERTIFIED"}`);
  rows.push("");
  rows.push("| Criterion | Observed | Required |");
  rows.push("|---|---|---|");
  rows.push(`| Qualifying live executions | ${s.qualifying_count} | >= ${s.min_required.executions} |`);
  rows.push(`| Window span | ${s.window_days} days (${s.distinct_utc_days} distinct UTC days) | >= ${s.min_required.window_days} days |`);
  rows.push(`| Evidence completeness | ${s.evidence_complete_rate === null ? "n/a" : (s.evidence_complete_rate * 100).toFixed(1) + "%"} (${s.evidence_complete_count}/${s.qualifying_count}) | >= ${s.min_required.evidence_rate * 100}% |`);
  rows.push(`| Unsafe auto-executions | ${s.unsafe_auto_executions} | 0 |`);
  rows.push(`| False approvals (deduped) | ${s.false_approvals} | 0 |`);
  rows.push("");
  rows.push(`Records scanned: ${s.records_total} (${s.records_unreadable} unreadable). Stamp mismatches (live-phase records still stamped dry-run by swarm-exec): ${s.stamp_mismatches}. Operator holds on file: ${s.interventions_held}.`);
  rows.push("");
  if (s.blockers.length > 0) {
    rows.push("## Blockers");
    rows.push("");
    for (const b of s.blockers) rows.push(`- ${b}`);
    rows.push("");
  }
  rows.push("## Qualifying cohort");
  rows.push("");
  const q = s.executions.filter((e) => e.qualifying);
  if (q.length === 0) {
    rows.push("(none yet — the window accrues as live executions reach terminal states)");
  } else {
    rows.push("| Identifier | State | Completed | Evidence |");
    rows.push("|---|---|---|---|");
    for (const e of q) {
      rows.push(`| ${e.identifier} | ${e.state} | ${e.completed_at} | ${e.evidence_complete ? "complete" : "missing: " + e.evidence_missing.join(", ")} |`);
    }
  }
  rows.push("");
  return rows.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const argv = Bun.argv.slice(2);
  const cmd = argv[0] ?? "status";
  const stateDir = flagValue(argv, "--state-dir");

  if (cmd === "status") {
    const s = qualificationStatus(stateDir);
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ ...s, executions: undefined }));
    } else {
      console.log(`L4 qualification (${s.state_dir}):`);
      console.log(`  Qualifying : ${s.qualifying_count}/${s.min_required.executions} live executions across ${s.window_days}d (need ${s.min_required.window_days}d)`);
      console.log(`  Evidence   : ${s.evidence_complete_rate === null ? "n/a" : (s.evidence_complete_rate * 100).toFixed(1) + "%"} complete (need ${s.min_required.evidence_rate * 100}%)`);
      console.log(`  Unsafe     : ${s.unsafe_auto_executions} | False approvals: ${s.false_approvals} | Stamp mismatches: ${s.stamp_mismatches}`);
      console.log(`  Verdict    : ${s.certified ? "CERTIFIED" : `NOT CERTIFIED — ${s.blockers.join("; ")}`}`);
    }
    process.exit(0);
  }

  if (cmd === "report") {
    const s = qualificationStatus(stateDir);
    const out =
      flagValue(argv, "--out") ??
      join(dirname(import.meta.dir), "reports", `l4-qualification-${s.generated_at.slice(0, 10)}.md`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderReport(s));
    console.log(out);
    process.exit(0);
  }

  if (cmd === "sync") {
    const r = syncQualifyingCount(stateDir);
    console.log(`synced safe_executions=${r.count} to ${r.synced.length} state dir(s): ${r.synced.join(", ") || "none"}`);
    process.exit(0);
  }

  console.error("Commands: status [--json] [--state-dir <dir>] | report [--state-dir <dir>] [--out <file>] | sync [--state-dir <dir>]");
  process.exit(2);
}

if (import.meta.main) main();
