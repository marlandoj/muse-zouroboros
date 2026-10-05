#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * Lever Board — one mechanical answer sheet for every SF factory lever.
 *
 * For each lever (SF-001..SF-012) the board reports three things:
 *   STATE       — flag values as THIS process sees them (same env a spawned
 *                 conveyor CLI inherits; route-spawned CLIs must still pass
 *                 env explicitly — the board cannot see a route's env).
 *   ELIGIBILITY — date gates + evidence counts for the next operator flip.
 *   FUNCTIONING — liveness: ledger rows, last-write age, coherence anomalies,
 *                 so "on" is distinguishable from "on but silently dead".
 *
 * Read-only by contract: the board never writes state/, never mutates flags,
 * never touches frozen modules. `--selftest` spawns the per-lever selftests
 * (each sandboxes its own state per the approval-ledger sandbox fix).
 *
 * shadow-state.ts is NOT imported (it executes main() on import); the board
 * reads state/shadow-state.json directly and mirrors its 48h/96h phase math.
 *
 * Usage:
 *   bun lever-board.ts               # markdown board
 *   bun lever-board.ts --json        # JSON snapshot
 *   bun lever-board.ts --selftest    # also run per-lever selftests (slow)
 *   bun lever-board.ts --stale-hours 72
 *
 * Exit codes: 0 = no anomalies, 1 = anomalies found (see ANOMALIES section).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { sf002Snapshot, AUTO_LANE_THRESHOLD, type SF002Snapshot } from "./agreement-baseline";
import { sf003Snapshot, type SF003Snapshot } from "./pool-manager";
import { sf006Snapshot, type SF006Snapshot } from "./dedup-gate";
import { sf007Snapshot, type SF007Snapshot } from "./signal-intake";
import { sf008Snapshot, type SF008Snapshot } from "./fleet-status";
import { sf009Snapshot, type SF009Snapshot } from "./scenario-run";
import { sf011Snapshot, type SF011Snapshot } from "./line-config";
import { sf012Snapshot, type SF012Snapshot } from "./decision-signals";
import { loadRegistry, registryHash, selectShadowAblation, staleAssumptions } from "./harness-assumptions";
import { isExecutionRecordFileName } from "./execution-lifecycle";

// ─── Config ───────────────────────────────────────────────────────────────────

const PROJECT_DIR = dirname(import.meta.dir);
const STATE_DIR = factoryStateRoot();

/** Earliest operator-flip eligibility for the levers shipped 2026-07-02 (+≥1wk shadow). */
export const SHADOW_WINDOW_OPENS = "2026-07-09T00:00:00Z";

/** Mirrors shadow-state.ts (not importable: unconditional main() on import). */
const DRY_RUN_MIN_HOURS = 48;
const SHADOW_PR_MIN_HOURS = 96;

const DEFAULT_STALE_LAG_HOURS = 72;
const SELFTEST_TIMEOUT_MS = 300_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type Posture = "live" | "enforcing" | "shadow" | "advisory" | "dark" | "phase";

export interface FlagReading {
  name: string;
  value: string | null;
  on: boolean;
}

export interface Anomaly {
  lever: string;
  severity: "critical" | "warn";
  reason: string;
}

export interface LeverRow {
  id: string;
  name: string;
  posture: Posture;
  posture_detail: string;
  flags: FlagReading[];
  eligibility: string;
  eligible_now: boolean | null; // null = no gate (pure operator choice)
  functioning: string;
  rows: number | null;
  last_write: string | null;
  last_write_age_hours: number | null;
  selftest: string | null;
  selftest_result?: { exit_code: number; duration_ms: number } | null;
}

export interface LeverBoardSnapshot {
  generated_at: string;
  stale_lag_hours: number;
  conveyor_last_activity: string | null;
  levers: LeverRow[];
  anomalies: Anomaly[];
  assumption_registry: { hash: string; total: number; stale: string[]; shadow_candidate: string | null; ablations: number; last_decision: string | null } | null;
}

interface ShadowStateFile {
  current_phase: string;
  phase_started_at: string;
  safe_executions: number;
  unsafe_auto_executions: number;
  transitions: unknown[];
}

// ─── Probe helpers (all read-only, all tolerant of absence) ──────────────────

function flag(name: string): FlagReading {
  const value = process.env[name] ?? null;
  return { name, value, on: value === "1" };
}

function mtimeISO(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function ageHours(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

function newestISO(...isos: (string | null)[]): string | null {
  const valid = isos.filter((i): i is string => i !== null).sort();
  return valid.length > 0 ? valid[valid.length - 1] : null;
}

function countLines(path: string): number {
  try {
    return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Newest mtime across state/exec-*.json = last real conveyor activity. */
function conveyorLastActivity(): string | null {
  if (!existsSync(STATE_DIR)) return null;
  let newest: string | null = null;
  for (const f of readdirSync(STATE_DIR)) {
    if (!isExecutionRecordFileName(f)) continue;
    newest = newestISO(newest, mtimeISO(join(STATE_DIR, f)));
  }
  return newest;
}

function loadShadowStateFile(): ShadowStateFile | null {
  const p = join(STATE_DIR, "shadow-state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ShadowStateFile;
  } catch {
    return null;
  }
}

function fmtAge(h: number | null): string {
  if (h === null) return "never";
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

function windowGate(now: Date): { open: boolean; text: string } {
  const opens = new Date(SHADOW_WINDOW_OPENS);
  if (now >= opens) return { open: true, text: `window open since ${SHADOW_WINDOW_OPENS.slice(0, 10)}` };
  const days = ((opens.getTime() - now.getTime()) / 86400000).toFixed(1);
  return { open: false, text: `window opens ${SHADOW_WINDOW_OPENS.slice(0, 10)} (${days}d left)` };
}

// ─── Board assembly ───────────────────────────────────────────────────────────

export function leverBoardSnapshot(staleLagHours = DEFAULT_STALE_LAG_HOURS): LeverBoardSnapshot {
  const now = new Date();
  const anomalies: Anomaly[] = [];
  const levers: LeverRow[] = [];
  const convLast = conveyorLastActivity();
  const gate = windowGate(now);
  let assumptionRegistry: LeverBoardSnapshot["assumption_registry"] = null;
  try {
    const registry = loadRegistry();
    const stale = staleAssumptions(registry, now).map((assumption) => assumption.id);
    const candidate = selectShadowAblation(registry, now);
    const ablationLedger = join(STATE_DIR, "harness-ablation-ledger.jsonl");
    const ablations = existsSync(ablationLedger) ? readFileSync(ablationLedger, "utf8").split("\n").filter(Boolean) : [];
    let lastDecision: string | null = null;
    if (ablations.length) {
      try { lastDecision = JSON.parse(ablations[ablations.length - 1]).decision ?? null; } catch { anomalies.push({ lever: "HARNESS", severity: "warn", reason: "latest ablation ledger row is corrupt" }); }
    }
    assumptionRegistry = { hash: registryHash(registry), total: registry.assumptions.length, stale, shadow_candidate: candidate?.id ?? null, ablations: ablations.length, last_decision: lastDecision };
    for (const id of stale) anomalies.push({ lever: "HARNESS", severity: "warn", reason: `assumption review overdue: ${id}` });
  } catch (err) {
    anomalies.push({ lever: "HARNESS", severity: "critical", reason: (err as Error).message });
  }

  // Snapshots can touch missing state safely — every sf0XXSnapshot() is
  // documented never-throw, but the board must survive even a broken module.
  const snap = <T>(fn: () => T, leverId: string): T | null => {
    try {
      return fn();
    } catch (e) {
      anomalies.push({ lever: leverId, severity: "critical", reason: `snapshot threw: ${e instanceof Error ? e.message : String(e)}` });
      return null;
    }
  };

  // Staleness heuristic (advisory): a shadow lever that rides conveyor cycles
  // should have written within staleLagHours of the newest exec record.
  const laggedBehindConveyor = (lastWrite: string | null): boolean => {
    if (!convLast || !lastWrite) return false;
    return new Date(convLast).getTime() - new Date(lastWrite).getTime() > staleLagHours * 3600000;
  };

  // ── SF-001 Conveyor (phase machine, not a flag) ──
  {
    const st = loadShadowStateFile();
    const phase = st?.current_phase ?? "not-initialized";
    const phaseStartMs = st ? new Date(st.phase_started_at).getTime() : NaN;
    const elapsedH = Number.isFinite(phaseStartMs) ? (now.getTime() - phaseStartMs) / 3600000 : 0;
    if (st && !Number.isFinite(phaseStartMs)) {
      anomalies.push({ lever: "SF-001", severity: "warn", reason: `corrupt phase_started_at ${JSON.stringify(st.phase_started_at)} in shadow-state.json — elapsed treated as 0h` });
    }
    let eligibility = "—";
    let eligibleNow: boolean | null = null;
    if (st) {
      if (phase === "dry-run") {
        const rem = Math.max(0, DRY_RUN_MIN_HOURS - elapsedH);
        eligibleNow = rem <= 0 && st.unsafe_auto_executions === 0;
        eligibility = eligibleNow
          ? "eligible → shadow-pr (manual: bun scripts/shadow-state.ts transition shadow-pr)"
          : rem > 0
            ? `shadow-pr in ${rem.toFixed(1)}h`
            : `BLOCKED: ${st.unsafe_auto_executions} unsafe auto-execution(s)`;
      } else if (phase === "shadow-pr") {
        const rem = Math.max(0, SHADOW_PR_MIN_HOURS - elapsedH);
        eligibleNow = rem <= 0 && st.unsafe_auto_executions === 0;
        eligibility = eligibleNow ? "eligible → live (manual transition)" : rem > 0 ? `live in ${rem.toFixed(1)}h` : `BLOCKED: unsafe auto-executions`;
      } else if (phase === "live") {
        eligibility = "terminal (live)";
        eligibleNow = null;
      } else if (phase === "idle") {
        eligibility = "start: transition dry-run";
        eligibleNow = true;
      } else {
        eligibility = `unknown phase ${JSON.stringify(phase)} — inspect state/shadow-state.json`;
        eligibleNow = null;
        anomalies.push({ lever: "SF-001", severity: "warn", reason: `unrecognized conveyor phase ${JSON.stringify(phase)} in shadow-state.json` });
      }
      if (st.unsafe_auto_executions > 0) {
        anomalies.push({ lever: "SF-001", severity: "critical", reason: `${st.unsafe_auto_executions} unsafe auto-execution(s) recorded in ${phase}` });
      }
    } else {
      anomalies.push({ lever: "SF-001", severity: "warn", reason: "state/shadow-state.json missing or unreadable — conveyor phase unknown" });
    }
    const lastWrite = convLast;
    levers.push({
      id: "SF-001",
      name: "Conveyor (shadow phases)",
      posture: "phase",
      posture_detail: `${phase} (${elapsedH.toFixed(1)}h, safe=${st?.safe_executions ?? 0}, unsafe=${st?.unsafe_auto_executions ?? 0})`,
      flags: [],
      eligibility,
      eligible_now: eligibleNow,
      functioning: `exec records + factory log; last conveyor activity ${fmtAge(ageHours(lastWrite))}`,
      rows: null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: null,
    });
  }

  // ── SF-002 Approval gate ──
  {
    const s = snap<SF002Snapshot>(sf002Snapshot, "SF-002");
    const fClassify = flag("SF002_CLASSIFY");
    const fEnforce = flag("SF002_ENFORCE");
    const fPromote = flag("SF002_AUTO_PROMOTE");
    const lastWrite = mtimeISO(join(STATE_DIR, "approval-ledger.jsonl"));
    const resolved = s?.resolved ?? 0;
    const evidenceOk = resolved >= AUTO_LANE_THRESHOLD;
    const parityOk = s?.shadow_parity_ok ?? false;
    const enforceEligible = gate.open && parityOk;
    const promoteEligible = enforceEligible && evidenceOk;

    if (s && !parityOk) anomalies.push({ lever: "SF-002", severity: "critical", reason: s.parity_reason });
    if (fEnforce.on && !enforceEligible) anomalies.push({ lever: "SF-002", severity: "critical", reason: "SF002_ENFORCE=1 before eligibility (window/parity)" });
    if (fPromote.on && !promoteEligible) anomalies.push({ lever: "SF-002", severity: "critical", reason: `SF002_AUTO_PROMOTE=1 without evidence (${resolved}/${AUTO_LANE_THRESHOLD} resolved)` });
    if (fPromote.on && !fEnforce.on) anomalies.push({ lever: "SF-002", severity: "warn", reason: "SF002_AUTO_PROMOTE=1 while SF002_ENFORCE=0 (incoherent combo)" });
    if (fClassify.on && (s?.ledger_entries ?? 0) === 0) anomalies.push({ lever: "SF-002", severity: "warn", reason: "classify ON but approval ledger empty — shadow layer may be dead" });
    else if (fClassify.on && laggedBehindConveyor(lastWrite)) anomalies.push({ lever: "SF-002", severity: "warn", reason: `approval ledger lagging conveyor by >${staleLagHours}h — shadow layer may be dead` });

    levers.push({
      id: "SF-002",
      name: "Tiered auto-approval gate",
      posture: fEnforce.on ? "enforcing" : fClassify.on ? "shadow" : "dark",
      posture_detail: fEnforce.on ? "enforce active" : fClassify.on ? "classify+log, act on nothing" : "off",
      flags: [fClassify, fEnforce, fPromote],
      eligibility: `enforce: ${enforceEligible ? "ELIGIBLE" : gate.text + (parityOk ? "" : " + parity FAIL")}; auto-promote: ${resolved}/${AUTO_LANE_THRESHOLD} resolved decisions${promoteEligible ? " — ELIGIBLE" : ""}`,
      eligible_now: enforceEligible,
      functioning: s ? `${s.ledger_entries} verdicts, ${s.exec_records_classified}/${s.exec_records_total} execs classified, ${s.holds_active} holds, ${s.verdicts_acted} acted; ${parityOk ? "parity ✅" : "parity ❌"}` : "snapshot failed",
      rows: s?.ledger_entries ?? null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: null, // parity is proven by shadow-validate + agreement-baseline
    });
  }

  // ── SF-003 Coder-agent pool ──
  {
    const s = snap<SF003Snapshot>(sf003Snapshot, "SF-003");
    const fPool = flag("SF003_POOL");
    const lastWrite = mtimeISO(join(STATE_DIR, "pool", "events.jsonl"));
    if (s && fPool.on && !s.fleet_separation_ok) anomalies.push({ lever: "SF-003", severity: "critical", reason: s.fleet_separation_reason });
    levers.push({
      id: "SF-003",
      name: "Coder-agent pool",
      posture: fPool.on ? "live" : "dark",
      posture_detail: fPool.on ? `mode=${s?.mode ?? "?"}` : "off (plan-mode enable is operator-only)",
      flags: [fPool, flag("SF003_POOL_MODE")],
      eligibility: gate.open ? "ELIGIBLE (operator-only plan-mode enable)" : gate.text,
      eligible_now: gate.open,
      functioning: s ? `queue=${s.queue_depth_ready}, in-flight=${s.in_flight}+${s.external_in_flight}ext, cap=${s.capacity_used}/${s.global_cap}, parked=${s.parked.length}, reconciles=${s.reconcile_events}` : "snapshot failed",
      rows: s ? s.queue_depth_ready + s.in_flight : null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/pool-selftest.ts",
    });
  }

  // ── SF-004 Yield dashboard (collector + metrics) ──
  {
    const f = flag("SF004_METRICS");
    const logPath = join(STATE_DIR, "factory-log.jsonl");
    const rows = countLines(logPath);
    const lastWrite = mtimeISO(logPath);
    if (f.on && rows === 0) anomalies.push({ lever: "SF-004", severity: "warn", reason: "SF004_METRICS=1 but factory-log.jsonl empty — collector never ran" });
    if (f.on && laggedBehindConveyor(lastWrite)) anomalies.push({ lever: "SF-004", severity: "warn", reason: `factory-log lagging conveyor by >${staleLagHours}h — collector tick may be dead` });
    levers.push({
      id: "SF-004",
      name: "Yield dashboard (collect + metrics)",
      posture: f.on ? "live" : "dark",
      posture_detail: f.on ? "collector tick active" : "off (tick is a no-op)",
      flags: [f],
      eligibility: "no date gate — operator choice",
      eligible_now: null,
      functioning: `factory-log rows=${rows}, last write ${fmtAge(ageHours(lastWrite))}`,
      rows,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/factory-selftest.ts",
    });
  }

  // ── SF-005 SLOs + alerting ──
  {
    const f = flag("SF005_SLO");
    const statusPath = join(STATE_DIR, "slo-status.md");
    const lastWrite = mtimeISO(statusPath);
    let breaches = 0;
    try {
      // Exact breach-line marker from factory-slo.ts renderStatusMd — the file's
      // header comment contains the word "breach", so a bare substring over-counts.
      breaches = readFileSync(statusPath, "utf-8").split("\n").filter((l) => l.includes("❌ BREACH ")).length;
    } catch { /* absent until first tick */ }
    if (f.on && lastWrite === null) anomalies.push({ lever: "SF-005", severity: "warn", reason: "SF005_SLO=1 but state/slo-status.md absent — tick never wrote" });
    levers.push({
      id: "SF-005",
      name: "SLOs + alerting",
      posture: f.on ? "live" : "dark",
      posture_detail: f.on ? `tick active${breaches > 0 ? `, ${breaches} breach line(s)` : ""}` : "off (tick is a no-op)",
      flags: [f],
      eligibility: "no date gate — operator choice (breach lines will block the auto-approval lane once live)",
      eligible_now: null,
      functioning: lastWrite ? `slo-status.md present, last write ${fmtAge(ageHours(lastWrite))}, breach-lines=${breaches}` : "no status file yet",
      rows: breaches,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/slo-selftest.ts",
    });
  }

  // ── SF-006 Dedup + idempotency ──
  {
    const s = snap<SF006Snapshot>(sf006Snapshot, "SF-006");
    const fDedup = flag("SF006_DEDUP");
    const fEnforce = flag("SF006_ENFORCE");
    const lastWrite = newestISO(mtimeISO(join(STATE_DIR, "dedup-decisions.jsonl")), mtimeISO(join(STATE_DIR, "intake-ledger.jsonl")));
    const decisions = s?.decisions_total ?? 0;
    if (fEnforce.on && !fDedup.on) anomalies.push({ lever: "SF-006", severity: "warn", reason: "SF006_ENFORCE=1 while SF006_DEDUP=0 (incoherent combo)" });
    if (fEnforce.on && decisions === 0) anomalies.push({ lever: "SF-006", severity: "warn", reason: "enforce ON with zero shadow decisions as evidence" });
    if (fDedup.on && !fEnforce.on && decisions === 0) anomalies.push({ lever: "SF-006", severity: "warn", reason: "dedup shadow ON but zero decisions recorded — shadow layer may be dead" });
    if (fDedup.on && decisions > 0 && laggedBehindConveyor(lastWrite)) anomalies.push({ lever: "SF-006", severity: "warn", reason: `dedup ledger lagging conveyor by >${staleLagHours}h — shadow layer may be dead` });
    levers.push({
      id: "SF-006",
      name: "Intake dedup + idempotency",
      posture: fEnforce.on ? "enforcing" : fDedup.on ? "shadow" : "dark",
      posture_detail: fEnforce.on ? "skips/resumes/parks take effect" : fDedup.on ? "decisions computed, routing untouched" : "off",
      flags: [fDedup, fEnforce],
      eligibility: gate.open ? `enforce ELIGIBLE (evidence: ${decisions} shadow decisions)` : `enforce: ${gate.text}`,
      eligible_now: gate.open && decisions > 0,
      functioning: s ? `${s.ledger_rows} ledger rows, ${decisions} decisions (would-skip=${s.shadow_would.would_skip}, would-resume=${s.shadow_would.would_resume}, would-park=${s.shadow_would.would_park}), enforced=${s.enforced.skipped + s.enforced.resumed + s.enforced.parked}` : "snapshot failed",
      rows: s?.ledger_rows ?? null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/dedup-selftest.ts",
    });
  }

  // ── SF-007 Signal intake ──
  {
    const s = snap<SF007Snapshot>(sf007Snapshot, "SF-007");
    const fSignals = flag("SF007_SIGNALS");
    const rung = process.env.SF007_AUTOFILE ?? "off";
    const lastWrite = newestISO(mtimeISO(join(STATE_DIR, "signal-ledger.jsonl")), mtimeISO(join(STATE_DIR, "signal-decisions.jsonl")));
    if (rung !== "off" && !fSignals.on) anomalies.push({ lever: "SF-007", severity: "warn", reason: `SF007_AUTOFILE=${rung} while SF007_SIGNALS=0 (incoherent combo)` });
    if (fSignals.on && (s?.ledger_rows ?? 0) === 0) anomalies.push({ lever: "SF-007", severity: "warn", reason: "signals ON but ledger empty — intake may be dead" });
    levers.push({
      id: "SF-007",
      name: "Multi-source signal intake",
      posture: rung !== "off" && fSignals.on ? "enforcing" : fSignals.on ? "shadow" : "dark",
      posture_detail: fSignals.on ? `autofile rung=${rung}` : "off",
      flags: [fSignals, { name: "SF007_AUTOFILE", value: process.env.SF007_AUTOFILE ?? null, on: rung !== "off" }],
      eligibility: gate.open ? `rung raise ELIGIBLE (off → unlabeled; operator-only; evidence: ${s?.decisions_total ?? 0} decisions)` : `rung raise: ${gate.text}`,
      eligible_now: gate.open && (s?.ledger_rows ?? 0) > 0,
      functioning: s ? `${s.ledger_rows} signals (${Object.entries(s.signals_by_source).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}), ${s.decisions_total} decisions, would-file=${s.would_file}, filed=${s.filed_acted}` : "snapshot failed",
      rows: s?.ledger_rows ?? null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/signal-selftest.ts",
    });
  }

  // ── SF-008 Fleet campaigns ──
  {
    const s = snap<SF008Snapshot>(sf008Snapshot, "SF-008");
    const f = flag("SF008_FLEET");
    // Same path resolution as fleet-spec.ts fleetParksPath()/fleetAuditPath()
    const lastWrite = newestISO(
      mtimeISO(resolveFactoryStateOverride(process.env.SF008_PARKS_PATH, "fleet-parks.jsonl")),
      mtimeISO(resolveFactoryStateOverride(process.env.SF008_AUDIT_PATH, "fleet-audit.jsonl")),
    );
    if (f.on && !flag("SF003_POOL").on) anomalies.push({ lever: "SF-008", severity: "warn", reason: "SF008_FLEET=1 while SF003_POOL=0 — fleet dispatch requires the pool lane" });
    levers.push({
      id: "SF-008",
      name: "Fleet campaigns",
      posture: f.on ? "live" : "dark",
      posture_detail: f.on ? "compiler + rollup active" : "off",
      flags: [f],
      eligibility: "no date gate — operator choice (prereq: SF-003 pool lane)",
      eligible_now: null,
      functioning: s ? `${s.fleets.length} fleets on disk, park-rows=${s.park_rows}, audit-rows=${s.audit_rows}` : "snapshot failed",
      rows: s?.fleets.length ?? null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/fleet-selftest.ts",
    });
  }

  // ── SF-009 Scenario runner ──
  {
    const s = snap<SF009Snapshot>(sf009Snapshot, "SF-009");
    const f = flag("SF009_SCENARIOS");
    const runsPath = resolveFactoryStateOverride(process.env.SF009_RUNS_PATH, "scenario-runs.jsonl");
    const lastWrite = mtimeISO(runsPath);
    levers.push({
      id: "SF-009",
      name: "Scenario verification",
      posture: f.on ? "live" : "dark",
      posture_detail: f.on ? "on-demand ephemeral runs" : "off",
      flags: [f],
      eligibility: "no date gate — operator choice",
      eligible_now: null,
      functioning: s ? `${s.runs_total} runs (${Object.entries(s.by_verdict).map(([k, v]) => `${k}=${v}`).join(", ") || "none yet"}), last: ${s.last_run ? `${s.last_run.scenario_id} → ${s.last_run.verdict}` : "—"}` : "snapshot failed",
      rows: s?.runs_total ?? null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/scenario-selftest.ts",
    });
  }

  // ── SF-010 Auto-merge lane ──
  {
    const f = flag("SF010_AUTOMERGE");
    const auditDir = join(STATE_DIR, "auto-merge-audit");
    let auditCount = 0;
    let lastWrite: string | null = null;
    if (existsSync(auditDir)) {
      for (const file of readdirSync(auditDir)) {
        if (!file.endsWith(".json")) continue;
        auditCount++;
        lastWrite = newestISO(lastWrite, mtimeISO(join(auditDir, file)));
      }
    }
    if (f.on && !flag("SF009_SCENARIOS").on) anomalies.push({ lever: "SF-010", severity: "warn", reason: "SF010_AUTOMERGE=1 while SF009_SCENARIOS=0 — scenario gate cannot run" });
    levers.push({
      id: "SF-010",
      name: "Auto-merge lane",
      posture: f.on ? "enforcing" : "advisory",
      posture_detail: f.on ? "LIVE MERGE enabled" : "advisory dry-run (decisions logged, no merges)",
      flags: [f],
      eligibility: "no date gate — operator choice (postflight backfill still owed)",
      eligible_now: null,
      functioning: `${auditCount} audit records, last ${fmtAge(ageHours(lastWrite))}`,
      rows: auditCount,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/auto-merge-selftest.ts",
    });
  }

  // ── SF-011 Assembly lines ──
  {
    const s = snap<SF011Snapshot>(() => sf011Snapshot(), "SF-011");
    const fLines = flag("SF011_LINES");
    const fEnforce = flag("SF011_ENFORCE");
    if (s?.config_error) anomalies.push({ lever: "SF-011", severity: "warn", reason: `line-config INVALID: ${s.config_error}` });
    if (fEnforce.on && !fLines.on) anomalies.push({ lever: "SF-011", severity: "warn", reason: "SF011_ENFORCE=1 while SF011_LINES=0 (incoherent combo)" });
    if (fEnforce.on) anomalies.push({ lever: "SF-011", severity: "warn", reason: "SF011_ENFORCE=1 but rung cap has NO dispatcher call site in v1 — enforce is a misleading no-op" });
    levers.push({
      id: "SF-011",
      name: "Per-archetype assembly lines",
      posture: fEnforce.on ? "enforcing" : fLines.on ? "advisory" : "dark",
      posture_detail: fLines.on ? "classify + stamp + advisory logs" : "off (classification not running)",
      flags: [fLines, fEnforce],
      eligibility: "no date gate — operator choice (rung-cap enforce needs a future dispatcher ticket to mean anything)",
      eligible_now: null,
      functioning: s ? `config=${s.config_source}${s.config_hash ? ` (${s.config_hash})` : ""}, stamped ${s.stamped_execs}/${s.total_execs} execs, disagreements=${s.declared_vs_inferred_disagreements}` : "snapshot failed",
      rows: s?.stamped_execs ?? null,
      last_write: null,
      last_write_age_hours: null,
      selftest: "scripts/lines-selftest.ts",
    });
  }

  // ── SF-012 Survivability + decision signals ──
  {
    const s = snap<SF012Snapshot>(sf012Snapshot, "SF-012");
    const fSurvival = flag("SF012_SURVIVAL");
    const fFeedback = flag("SF012_FEEDBACK");
    const lastWrite = newestISO(
      mtimeISO(resolveFactoryStateOverride(process.env.SF012_LEDGER_PATH, "survivability-ledger.jsonl")),
      mtimeISO(resolveFactoryStateOverride(process.env.SF012_SIGNALS_PATH, "decision-signals.jsonl"))
    );
    if (s?.config_error) anomalies.push({ lever: "SF-012", severity: "warn", reason: `survivability-config INVALID: ${s.config_error}` });
    if (fFeedback.on && !fSurvival.on) anomalies.push({ lever: "SF-012", severity: "warn", reason: "SF012_FEEDBACK=1 while SF012_SURVIVAL=0 (incoherent combo)" });
    levers.push({
      id: "SF-012",
      name: "Survivability + decision signals",
      posture: fSurvival.on ? (fFeedback.on ? "advisory" : "live") : "dark",
      posture_detail: fSurvival.on ? `fate probe + harvest${fFeedback.on ? " + advisory λ-blend" : ""}` : "off (no probing)",
      flags: [fSurvival, fFeedback],
      eligibility: `no date gate — prereq: merged agent PRs (currently ${s?.distinct_prs ?? 0}; honest-empty until SF-010 enforce merges something)`,
      eligible_now: null,
      functioning: s ? `${s.distinct_prs} PRs probed, min-sample ${s.global_sufficient ? "met" : `not met (n<${s.min_sample ?? "?"})`}, ${s.signals_total} decision signals, rubric cohorts ${s.rubric_governance ? `${s.rubric_governance.train}/${s.rubric_governance.calibration}/${s.rubric_governance.holdout}` : "unavailable"}` : "snapshot failed",
      rows: s?.signals_total ?? null,
      last_write: lastWrite,
      last_write_age_hours: ageHours(lastWrite),
      selftest: "scripts/survivability-selftest.ts",
    });
  }

  return {
    generated_at: now.toISOString(),
    stale_lag_hours: staleLagHours,
    conveyor_last_activity: convLast,
    levers,
    anomalies,
    assumption_registry: assumptionRegistry,
  };
}

// ─── Selftest runner (opt-in, spawns per-lever selftests) ────────────────────

export function runSelftests(board: LeverBoardSnapshot): void {
  for (const lever of board.levers) {
    if (!lever.selftest) {
      lever.selftest_result = null;
      continue;
    }
    const path = join(PROJECT_DIR, lever.selftest);
    if (!existsSync(path)) {
      lever.selftest_result = { exit_code: -1, duration_ms: 0 };
      board.anomalies.push({ lever: lever.id, severity: "warn", reason: `selftest missing: ${lever.selftest}` });
      continue;
    }
    const started = Date.now();
    const proc = Bun.spawnSync(["bun", path], {
      cwd: PROJECT_DIR,
      timeout: SELFTEST_TIMEOUT_MS,
      stdout: "ignore",
      stderr: "ignore",
    });
    const duration = Date.now() - started;
    lever.selftest_result = { exit_code: proc.exitCode ?? -1, duration_ms: duration };
    if (proc.exitCode !== 0) {
      board.anomalies.push({ lever: lever.id, severity: "critical", reason: `selftest FAILED (exit ${proc.exitCode}, ${(duration / 1000).toFixed(1)}s): ${lever.selftest}` });
    }
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatLeverBoard(board: LeverBoardSnapshot): string {
  const rows: string[] = [];
  rows.push("## Lever Board");
  rows.push("");
  if (board.assumption_registry) {
    rows.push(`**Harness assumptions:** ${board.assumption_registry.total} registered · ${board.assumption_registry.stale.length} stale · shadow candidate ${board.assumption_registry.shadow_candidate ?? "none"} · ablations ${board.assumption_registry.ablations} (latest ${board.assumption_registry.last_decision ?? "none"}) · ${board.assumption_registry.hash}`);
    rows.push("");
  }
  rows.push(`**Generated:** ${board.generated_at} · conveyor last active ${fmtAge(ageHours(board.conveyor_last_activity))} · stale-lag threshold ${board.stale_lag_hours}h`);
  rows.push("");

  if (board.anomalies.length > 0) {
    rows.push("### ⚠ ANOMALIES");
    rows.push("");
    for (const a of board.anomalies.filter((x) => x.severity === "critical")) rows.push(`- 🔴 **${a.lever}** — ${a.reason}`);
    for (const a of board.anomalies.filter((x) => x.severity === "warn")) rows.push(`- 🟡 **${a.lever}** — ${a.reason}`);
    rows.push("");
  } else {
    rows.push("✅ No anomalies — every flag coherent, no shadow layer silently dead, no enforce without evidence.");
    rows.push("");
  }

  rows.push("| Lever | Posture | Flags | Eligibility | Functioning | Last write |");
  rows.push("|-------|---------|-------|-------------|-------------|------------|");
  for (const l of board.levers) {
    const flags = l.flags.length > 0 ? l.flags.map((f) => `${f.name}=${f.value ?? "∅"}`).join("<br>") : "(phase machine)";
    const selftest = l.selftest_result ? (l.selftest_result.exit_code === 0 ? " · selftest ✅" : ` · selftest ❌(${l.selftest_result.exit_code})`) : "";
    rows.push(
      `| **${l.id}** ${l.name} | ${postureIcon(l.posture)} ${l.posture} — ${l.posture_detail} | ${flags} | ${l.eligibility} | ${l.functioning}${selftest} | ${fmtAge(l.last_write_age_hours)} |`
    );
  }
  rows.push("");
  rows.push("_Read-only board: flags shown are this process's env (what a spawned conveyor CLI inherits). Route-spawned CLIs must pass env explicitly — the board cannot see a route's env._");
  return rows.join("\n");
}

function postureIcon(p: Posture): string {
  switch (p) {
    case "live": return "🟢";
    case "enforcing": return "🟠";
    case "shadow": return "🔵";
    case "advisory": return "🟣";
    case "dark": return "⚫";
    case "phase": return "🌗";
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      selftest: { type: "boolean", default: false },
      "stale-hours": { type: "string", default: String(DEFAULT_STALE_LAG_HOURS) },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
lever-board — one mechanical answer sheet for every SF factory lever

USAGE:
  bun lever-board.ts                 # markdown board (state + eligibility + liveness)
  bun lever-board.ts --json          # JSON snapshot
  bun lever-board.ts --selftest      # also run per-lever selftests (slow, ~minutes)
  bun lever-board.ts --stale-hours 72

EXIT CODES:
  0  no anomalies
  1  anomalies found (parity violation, incoherent flags, dead shadow layer,
     enforce-without-evidence, selftest failure)
`);
    process.exit(0);
  }

  const staleRaw = values["stale-hours"] === undefined ? NaN : parseFloat(String(values["stale-hours"]));
  const staleHours = Number.isFinite(staleRaw) && staleRaw >= 0 ? staleRaw : DEFAULT_STALE_LAG_HOURS;
  const board = leverBoardSnapshot(staleHours);
  if (values.selftest) runSelftests(board);

  if (values.json) {
    console.log(JSON.stringify(board, null, 2));
  } else {
    console.log(formatLeverBoard(board));
  }

  process.exit(board.anomalies.length === 0 ? 0 : 1);
}
