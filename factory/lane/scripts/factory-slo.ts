#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T1+T2 (SF-005) — Factory SLOs: evaluation core + change-gate surface
 *
 * Three service levels evaluated from the SF-004 factory log against
 * committed policy in slo-config.json:
 *   cycle_time           mean cycle time (h)          value ≤ threshold
 *   yield_floor          first-pass yield             value ≥ threshold
 *   auto_approval_error  fail rate of auto-approved   value ≤ threshold
 *
 * Honesty invariants:
 *  - Three-valued status ok|breach|insufficient_data. Below min_samples the
 *    status is insufficient_data — it can NEVER breach and never reports ok.
 *  - Verdict sidecars remain the only ground truth (via FactoryRecord.measured
 *    / .verdict); unmeasured units count in neither numerator nor denominator
 *    of the error rate.
 *  - Corrupt/invalid slo-config.json is fail-loud (CLI exit 1, no state written).
 *
 * Change gating: state/slo-status.md is a GFM task list watched by the
 * EXISTING build-watchdog engine (Skills/build-watchdog/scripts/watchdog.ts).
 * Blocker identity there is exact line text, so breach lines freeze the value
 * observed at the breach transition (stable while the breach persists), the
 * reviewed marker lives on a separate plain line (reviewing never re-fires
 * BLOCKER), and a permanent unchecked sentinel line prevents a false COMPLETE.
 *
 * Lane authority: only yield_floor blocks the SF-002 auto-approval lane, and
 * only while breach ∧ ¬reviewed. laneBlockDecision() is pure; absent state =
 * never blocked, corrupt state = blocked (fail-closed, consumed by swarm-exec
 * in enforce mode only).
 *
 * Usage:
 *   bun factory-slo.ts status [--json]           # evaluate only, no writes
 *   bun factory-slo.ts check  [--json]           # evaluate + persist state + render md
 *   bun factory-slo.ts tick                      # conveyor entry: no-op unless SF005_SLO=1
 *   bun factory-slo.ts review <slo> --by <op> [--note "why"]
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { readFactoryLog, type FactoryRecord } from "./factory-collect";
import { computeFactoryMetrics, latestActivity } from "./factory-metrics";
import { loadBenchmarkSloIntake, type BenchmarkSloIntakeReport } from "./benchmark-slo-intake";
import {
  readFactoryStateMutationCycleId,
  recordFactoryStateAtomicReplacement,
} from "./factory-state-mutation-evidence";

// ─── Types ────────────────────────────────────────────────────────────────────

export const SLO_IDS = ["cycle_time", "yield_floor", "auto_approval_error"] as const;
export type SloId = (typeof SLO_IDS)[number];
export type SloStatusValue = "ok" | "breach" | "insufficient_data";

export interface SloRule {
  enabled: boolean;
  threshold: number;
  min_samples: number;
  window_days: number;
}

export interface SloConfig {
  version: number;
  slos: Record<SloId, SloRule>;
}

export interface SloEvaluation {
  id: SloId;
  status: SloStatusValue;
  value: number | null;
  threshold: number;
  denominator: number;
  min_samples: number;
  window_days: number;
}

export interface SloTransition {
  slo: SloId;
  from: SloStatusValue | null;
  to: SloStatusValue;
  at: string;
  by: string;
  note: string;
}

export interface ReviewMark {
  reviewed: boolean;
  by: string | null;
  at: string | null;
  note: string | null;
}

export interface BreachMeta {
  started_at: string;
  value_at_breach: number | null;
  denominator_at_breach: number;
}

export interface SloState {
  version: 1;
  evaluated_at: string;
  evaluations: Partial<Record<SloId, SloEvaluation>>;
  reviewed: Partial<Record<SloId, ReviewMark>>;
  breach_meta: Partial<Record<SloId, BreachMeta>>;
  transitions: SloTransition[];
  benchmark_reliability?: BenchmarkSloIntakeReport;
}

export interface SloSources {
  configPath: string;
  logPath: string;
  statePath: string;
  statusMdPath: string;
  benchmarkRunsDir?: string;
}

const PROJECT_DIR = join(import.meta.dir, "..");
const MAX_TRANSITIONS = 500;

export function defaultSloSources(): SloSources {
  return {
    configPath: join(PROJECT_DIR, "slo-config.json"),
    logPath: factoryStatePath("factory-log.jsonl"),
    statePath: factoryStatePath("slo-state.json"),
    statusMdPath: factoryStatePath("slo-status.md"),
    benchmarkRunsDir: join(PROJECT_DIR, "..", "..", "packages", "bench", "data", "runs"),
  };
}

// ─── Config (fail-loud) ───────────────────────────────────────────────────────

export class SloConfigError extends Error {}

function assertCfg(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new SloConfigError(`slo-config invalid: ${msg}`);
}

export function parseSloConfig(text: string): SloConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    throw new SloConfigError(`slo-config invalid: not JSON — ${err.message}`);
  }
  assertCfg(typeof raw === "object" && raw !== null && !Array.isArray(raw), "root must be an object");
  const cfg = raw as Record<string, unknown>;
  assertCfg(cfg.version === 1, `version must be 1 (got ${JSON.stringify(cfg.version)})`);
  assertCfg(
    typeof cfg.slos === "object" && cfg.slos !== null && !Array.isArray(cfg.slos),
    "slos must be an object",
  );
  const slos = cfg.slos as Record<string, unknown>;
  for (const key of Object.keys(slos)) {
    assertCfg((SLO_IDS as readonly string[]).includes(key), `unknown slo "${key}"`);
  }
  for (const id of SLO_IDS) {
    assertCfg(id in slos, `missing slo "${id}" (set enabled:false to disable, don't omit)`);
    const r = slos[id] as Record<string, unknown>;
    assertCfg(typeof r === "object" && r !== null, `${id} must be an object`);
    assertCfg(typeof r.enabled === "boolean", `${id}.enabled must be boolean`);
    assertCfg(typeof r.threshold === "number" && Number.isFinite(r.threshold), `${id}.threshold must be a finite number`);
    assertCfg(
      Number.isInteger(r.min_samples) && (r.min_samples as number) >= 1,
      `${id}.min_samples must be an integer ≥ 1`,
    );
    assertCfg(
      typeof r.window_days === "number" && Number.isFinite(r.window_days) && (r.window_days as number) > 0,
      `${id}.window_days must be a positive number`,
    );
    if (id === "yield_floor" || id === "auto_approval_error") {
      assertCfg(
        (r.threshold as number) >= 0 && (r.threshold as number) <= 1,
        `${id}.threshold must be within [0,1]`,
      );
    } else {
      assertCfg((r.threshold as number) > 0, `${id}.threshold must be > 0 hours`);
    }
  }
  return cfg as unknown as SloConfig;
}

export function loadSloConfig(configPath: string): SloConfig {
  if (!existsSync(configPath)) throw new SloConfigError(`slo-config invalid: file not found at ${configPath}`);
  return parseSloConfig(readFileSync(configPath, "utf-8"));
}

// ─── Evaluation (pure) ────────────────────────────────────────────────────────

/** Units whose latest known activity falls inside the window; undatable units
 *  (all stamps unknown) are excluded — they cannot be attributed to a period. */
export function windowRecords(records: FactoryRecord[], windowDays: number, nowIso: string): FactoryRecord[] {
  const nowMs = Date.parse(nowIso);
  const startMs = nowMs - windowDays * 86_400_000;
  return records.filter((r) => {
    const activity = latestActivity(r);
    if (activity === null) return false;
    const t = Date.parse(activity);
    return t >= startMs && t <= nowMs;
  });
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Auto-approved = gate-classified ∧ not held. Numerator and denominator are
 *  measured-only: an unmeasured auto-approval is neither an error nor a success. */
export function autoApprovalError(records: FactoryRecord[]): { value: number | null; denominator: number } {
  const autoApprovedMeasured = records.filter(
    (r) => r.gate_decision !== "unknown" && r.status !== "held" && r.measured && r.verdict !== null,
  );
  const failures = autoApprovedMeasured.filter((r) => r.verdict!.verdict === "fail");
  if (autoApprovedMeasured.length === 0) return { value: null, denominator: 0 };
  return { value: round4(failures.length / autoApprovedMeasured.length), denominator: autoApprovedMeasured.length };
}

/** insufficient_data below min_samples — structurally unable to breach or pass. */
function statusOf(id: SloId, value: number | null, denominator: number, rule: SloRule): SloStatusValue {
  if (denominator < rule.min_samples || value === null) return "insufficient_data";
  switch (id) {
    case "cycle_time":
      return value <= rule.threshold ? "ok" : "breach";
    case "yield_floor":
      return value >= rule.threshold ? "ok" : "breach";
    case "auto_approval_error":
      return value <= rule.threshold ? "ok" : "breach";
  }
}

export function evaluateSlos(
  records: FactoryRecord[],
  config: SloConfig,
  nowIso: string,
): Partial<Record<SloId, SloEvaluation>> {
  const out: Partial<Record<SloId, SloEvaluation>> = {};
  for (const id of SLO_IDS) {
    const rule = config.slos[id];
    if (!rule.enabled) continue;
    const windowed = windowRecords(records, rule.window_days, nowIso);
    let value: number | null;
    let denominator: number;
    if (id === "auto_approval_error") {
      ({ value, denominator } = autoApprovalError(windowed));
    } else {
      const m = computeFactoryMetrics(windowed, { windowDays: rule.window_days, now: nowIso });
      if (id === "cycle_time") {
        value = m.mean_cycle_time_hours;
        denominator = m.cycle_time_count;
      } else {
        value = m.first_pass_yield;
        denominator = m.measured_count;
      }
    }
    out[id] = {
      id,
      status: statusOf(id, value, denominator, rule),
      value,
      threshold: rule.threshold,
      denominator,
      min_samples: rule.min_samples,
      window_days: rule.window_days,
    };
  }
  return out;
}

// ─── State transitions (pure) ─────────────────────────────────────────────────

const NO_REVIEW: ReviewMark = { reviewed: false, by: null, at: null, note: null };

export function applyEvaluations(
  prev: SloState | null,
  evaluations: Partial<Record<SloId, SloEvaluation>>,
  nowIso: string,
): { state: SloState; newTransitions: SloTransition[] } {
  const newTransitions: SloTransition[] = [];
  const reviewed: Partial<Record<SloId, ReviewMark>> = {};
  const breach_meta: Partial<Record<SloId, BreachMeta>> = {};

  for (const id of SLO_IDS) {
    const ev = evaluations[id];
    if (!ev) continue; // disabled — carries no review/breach state
    const from = prev?.evaluations[id]?.status ?? null;
    if (from !== ev.status) {
      newTransitions.push({ slo: id, from, to: ev.status, at: nowIso, by: "system", note: "evaluation" });
    }
    if (ev.status === "breach") {
      if (from === "breach") {
        // persisting breach: review mark and frozen breach meta carry over
        reviewed[id] = prev?.reviewed[id] ?? NO_REVIEW;
        breach_meta[id] = prev?.breach_meta?.[id] ?? {
          started_at: nowIso,
          value_at_breach: ev.value,
          denominator_at_breach: ev.denominator,
        };
      } else {
        // NEW breach: always starts unreviewed
        reviewed[id] = NO_REVIEW;
        breach_meta[id] = { started_at: nowIso, value_at_breach: ev.value, denominator_at_breach: ev.denominator };
      }
    } else {
      reviewed[id] = NO_REVIEW; // recovery clears the review — next breach starts unreviewed
    }
  }

  const transitions = [...(prev?.transitions ?? []), ...newTransitions].slice(-MAX_TRANSITIONS);
  return {
    state: { version: 1, evaluated_at: nowIso, evaluations, reviewed, breach_meta, transitions },
    newTransitions,
  };
}

/** Watchdog blocker identity is exact line text — a newline in operator input
 *  could inject a fake breach (or checked) line into the rendered status doc. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function applyReview(
  state: SloState,
  slo: SloId,
  by: string,
  note: string,
  nowIso: string,
): SloState {
  const ev = state.evaluations[slo];
  if (!ev) throw new Error(`cannot review "${slo}" — not evaluated (disabled or unknown)`);
  if (ev.status !== "breach") throw new Error(`cannot review "${slo}" — status is ${ev.status}, not breach`);
  const safeBy = oneLine(by);
  const safeNote = oneLine(note);
  return {
    ...state,
    reviewed: { ...state.reviewed, [slo]: { reviewed: true, by: safeBy, at: nowIso, note: safeNote } },
    transitions: [
      ...state.transitions,
      { slo, from: "breach" as const, to: "breach" as const, at: nowIso, by: safeBy, note: `review: ${safeNote}` },
    ].slice(-MAX_TRANSITIONS),
  };
}

// ─── Lane block (pure decision + tolerant reader) ─────────────────────────────

const STATUS_VALUES: readonly string[] = ["ok", "breach", "insufficient_data"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-validates the fields the lane decision depends on. A structurally
 *  plausible file with a malformed evaluation (e.g. hand-edited status) must
 *  read as "corrupt" — silently treating it as non-breach would fail-OPEN. */
export function readSloStateFile(statePath: string): SloState | null | "corrupt" {
  if (!existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as SloState;
    if (raw.version !== 1) return "corrupt";
    if (!isRecord(raw.evaluations) || !isRecord(raw.reviewed) || !isRecord(raw.breach_meta)) return "corrupt";
    if (!Array.isArray(raw.transitions)) return "corrupt";
    for (const id of SLO_IDS) {
      const ev = raw.evaluations[id];
      if (ev !== undefined && (!isRecord(ev) || !STATUS_VALUES.includes(ev.status as string))) return "corrupt";
      const mark = raw.reviewed[id];
      if (mark !== undefined && (!isRecord(mark) || typeof mark.reviewed !== "boolean")) return "corrupt";
    }
    return raw;
  } catch {
    return "corrupt";
  }
}

/** Only yield_floor has lane authority, only while breach ∧ ¬reviewed.
 *  Absent state = never blocked; corrupt state = blocked (fail-closed). */
export function laneBlockDecision(state: SloState | null | "corrupt"): { blocked: boolean; reason: string } {
  if (state === null) return { blocked: false, reason: "no slo state (SF-005 inactive or never evaluated)" };
  if (state === "corrupt") return { blocked: true, reason: "slo-state.json unreadable — fail-closed" };
  const yf = state.evaluations.yield_floor;
  if (!yf) return { blocked: false, reason: "yield_floor not evaluated (disabled)" };
  if (yf.status !== "breach") return { blocked: false, reason: `yield_floor ${yf.status}` };
  const mark = state.reviewed.yield_floor;
  if (mark?.reviewed) return { blocked: false, reason: `yield_floor breach reviewed by ${mark.by} at ${mark.at}` };
  const meta = state.breach_meta.yield_floor;
  return {
    blocked: true,
    reason: `yield_floor breach unreviewed — first-pass yield ${meta?.value_at_breach ?? yf.value} below floor ${yf.threshold} since ${meta?.started_at ?? state.evaluated_at}`,
  };
}

export function certificationLaneBlockDecision(
  state: SloState | null | "corrupt",
  now: Date | string = new Date(),
  maxAgeMs = 24 * 60 * 60_000,
): { blocked: boolean; reason: string } {
  if (state === null) return { blocked: true, reason: "certification requires current slo state" };
  if (state === "corrupt") return { blocked: true, reason: "slo-state.json unreadable — certification fails closed" };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const evaluatedAt = Date.parse(state.evaluated_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(evaluatedAt) || evaluatedAt > nowMs || nowMs - evaluatedAt > maxAgeMs) {
    return { blocked: true, reason: "certification requires fresh slo state" };
  }
  const yieldFloor = state.evaluations.yield_floor;
  if (!yieldFloor) return { blocked: true, reason: "certification requires enabled yield_floor evaluation" };
  if (yieldFloor.status !== "ok") {
    return { blocked: true, reason: `certification requires yield_floor ok; observed ${yieldFloor.status}` };
  }
  return { blocked: false, reason: `yield_floor ok at ${state.evaluated_at}` };
}

// ─── Rendered status doc (build-watchdog change-gate source) ──────────────────

function fmtVal(id: SloId, v: number | null): string {
  if (v === null) return "n/a";
  return id === "cycle_time" ? `${v}h` : `${v}`;
}

export function renderStatusMd(state: SloState): string {
  const lines: string[] = [];
  lines.push("# Factory SLOs — service-level status");
  lines.push("");
  lines.push("<!-- Rendered by scripts/factory-slo.ts (SF-005). Canonical state: state/slo-state.json.");
  lines.push("     Watched by build-watchdog (change-gated). Do not hand-edit.");
  lines.push("     Breach lines freeze the value observed at the breach transition so their text stays");
  lines.push("     stable while the breach persists (watchdog blocker identity = exact line text). -->");
  lines.push("");
  for (const id of SLO_IDS) {
    const ev = state.evaluations[id];
    if (!ev) continue;
    if (ev.status === "ok") {
      const rel = id === "yield_floor" ? "at or above floor" : "within limit";
      lines.push(`- [x] ${id} ok — ${rel} ${fmtVal(id, ev.threshold)} (window ${ev.window_days}d)`);
    } else if (ev.status === "insufficient_data") {
      lines.push(
        `- [ ] ${id} — insufficient data (n=${ev.denominator} < min ${ev.min_samples}, window ${ev.window_days}d)`,
      );
    } else {
      const meta = state.breach_meta[id];
      lines.push(
        `- [ ] ❌ BREACH ${id} — ${fmtVal(id, meta?.value_at_breach ?? ev.value)} vs threshold ${fmtVal(id, ev.threshold)} (n=${meta?.denominator_at_breach ?? ev.denominator}, window ${ev.window_days}d), breached ${meta?.started_at ?? state.evaluated_at}`,
      );
      const mark = state.reviewed[id];
      if (mark?.reviewed) {
        lines.push(`  - reviewed by ${mark.by} at ${mark.at} — lane released, breach persists (${mark.note})`);
      }
    }
  }
  const lane = laneBlockDecision(state);
  if (lane.blocked) lines.push(`BLOCKED: ${lane.reason}`);
  if (state.benchmark_reliability) {
    for (const benchmark of state.benchmark_reliability.benchmarks) {
      lines.push(
        `- [${benchmark.distribution.status === "publishable" ? "x" : " "}] benchmark_reliability ${benchmark.benchmark} — ` +
        `${benchmark.distribution.status} N=${benchmark.distribution.n}/${benchmark.distribution.minimumN}, ` +
        `spread=${benchmark.reliability_spread_points ?? "n/a"}pt, truncation=${benchmark.truncation_rate}, ` +
        `timeout=${benchmark.timeout_calibration.selectedTimeoutMs ?? "uncalibrated"}ms`,
      );
    }
  }
  lines.push("- [ ] standing SLO monitor (this list never finishes by design; live values: factory-slo.ts status)");
  lines.push("");
  return lines.join("\n");
}

// ─── Persistence (atomic — a torn slo-state.json would fail-closed the lane) ──

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function recordSloStateReplacement(path: string, beforePayload: string, afterPayload: string, recordedAt: string): void {
  const stateDir = dirname(path);
  const laneLogPath = join(stateDir, "lane-utilization.jsonl");
  const currentCyclePath = `${laneLogPath}.current-cycle`;
  const evidence = recordFactoryStateAtomicReplacement({
    stateDir,
    producerId: "factory-slo",
    requestedCycleId: readFactoryStateMutationCycleId(currentCyclePath),
    sentinelPath: currentCyclePath,
    laneLogPath,
    targetPath: basename(path),
    targetSchema: "slo-state/v1",
    beforePayload,
    afterPayload,
    recordedAt,
  });
  if (evidence.would_reject && evidence.mode === "shadow") {
    console.error(`factory-slo: mutation evidence would reject (${evidence.reason})`);
  }
}

export interface CheckResult {
  state: SloState;
  newTransitions: SloTransition[];
  md_written: boolean;
  lane: { blocked: boolean; reason: string };
  warnings: string[];
}

export function check(sources: SloSources, opts: { now?: string } = {}): CheckResult {
  const nowIso = opts.now ?? new Date().toISOString();
  const warnings: string[] = [];
  const config = loadSloConfig(sources.configPath); // fail-loud before any write
  const records = existsSync(sources.logPath) ? [...readFactoryLog(sources.logPath).values()] : [];

  const loaded = readSloStateFile(sources.statePath);
  const prev: SloState | null = loaded === "corrupt" ? null : loaded;
  if (loaded === "corrupt") {
    warnings.push("slo-state.json was corrupt — rebaselined (transition history restarted)");
  }

  const evaluations = evaluateSlos(records, config, nowIso);
  const { state, newTransitions } = applyEvaluations(prev, evaluations, nowIso);
  if (sources.benchmarkRunsDir && existsSync(sources.benchmarkRunsDir)) {
    try {
      state.benchmark_reliability = loadBenchmarkSloIntake(sources.benchmarkRunsDir, nowIso);
    } catch (err) {
      warnings.push(`benchmark reliability intake failed: ${(err as Error).message}`);
    }
  }
  const serializedState = JSON.stringify(state, null, 2);
  if (existsSync(sources.statePath)) {
    recordSloStateReplacement(sources.statePath, readFileSync(sources.statePath, "utf8"), serializedState, nowIso);
  }
  writeAtomic(sources.statePath, serializedState);

  const md = renderStatusMd(state);
  const existing = existsSync(sources.statusMdPath) ? readFileSync(sources.statusMdPath, "utf-8") : null;
  const md_written = existing !== md;
  if (md_written) writeAtomic(sources.statusMdPath, md);

  return { state, newTransitions, md_written, lane: laneBlockDecision(state), warnings };
}

export function review(sources: SloSources, slo: SloId, by: string, note: string, nowIso?: string): SloState {
  const at = nowIso ?? new Date().toISOString();
  const current = readSloStateFile(sources.statePath);
  if (current === null) throw new Error(`no slo state at ${sources.statePath} — run check first`);
  if (current === "corrupt") throw new Error(`slo-state.json is corrupt — run check to rebaseline before reviewing`);
  const state: SloState = current;
  const next = applyReview(state, slo, by, note, at);
  const serializedNext = JSON.stringify(next, null, 2);
  recordSloStateReplacement(sources.statePath, readFileSync(sources.statePath, "utf8"), serializedNext, at);
  writeAtomic(sources.statePath, serializedNext);
  const md = renderStatusMd(next);
  const existing = existsSync(sources.statusMdPath) ? readFileSync(sources.statusMdPath, "utf-8") : null;
  if (existing !== md) writeAtomic(sources.statusMdPath, md);
  return next;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function renderStatusTable(evaluations: Partial<Record<SloId, SloEvaluation>>): string {
  const lines: string[] = [];
  lines.push("| SLO | Status | Value | Threshold | n / min | Window |");
  lines.push("|-----|--------|-------|-----------|---------|--------|");
  for (const id of SLO_IDS) {
    const ev = evaluations[id];
    if (!ev) {
      lines.push(`| ${id} | disabled | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${id} | ${ev.status} | ${fmtVal(id, ev.value)} | ${fmtVal(id, ev.threshold)} | ${ev.denominator} / ${ev.min_samples} | ${ev.window_days}d |`,
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);

  try {
    if (cmd === "tick") {
      // Conveyor entry — MUST exit before any read/write when the flag is off.
      if (process.env.SF005_SLO !== "1") process.exit(0);
      const result = check(defaultSloSources());
      console.log(
        JSON.stringify(
          {
            transitions: result.newTransitions,
            md_written: result.md_written,
            lane: result.lane,
            warnings: result.warnings,
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }

    if (cmd === "status") {
      const sources = defaultSloSources();
      const config = loadSloConfig(sources.configPath);
      const records = existsSync(sources.logPath) ? [...readFactoryLog(sources.logPath).values()] : [];
      const evaluations = evaluateSlos(records, config, new Date().toISOString());
      if (rest.includes("--json")) console.log(JSON.stringify(evaluations, null, 2));
      else console.log(renderStatusTable(evaluations));
      process.exit(0);
    }

    if (cmd === "check") {
      const result = check(defaultSloSources());
      if (rest.includes("--json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderStatusTable(result.state.evaluations));
        for (const t of result.newTransitions) console.log(`transition: ${t.slo} ${t.from ?? "∅"} → ${t.to}`);
        console.log(`md_written: ${result.md_written} · lane: ${result.lane.blocked ? "BLOCKED" : "open"} (${result.lane.reason})`);
        for (const w of result.warnings) console.error(`warning: ${w}`);
      }
      process.exit(0);
    }

    if (cmd === "review") {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { by: { type: "string" }, note: { type: "string" } },
        allowPositionals: true,
        strict: false,
      });
      const slo = positionals[0] as SloId | undefined;
      if (!slo || !(SLO_IDS as readonly string[]).includes(slo)) {
        console.error(`usage: factory-slo.ts review <${SLO_IDS.join("|")}> --by <operator> [--note "why"]`);
        process.exit(2);
      }
      if (!values.by || typeof values.by !== "string") {
        console.error("--by <operator> is required — reviews carry provenance");
        process.exit(2);
      }
      const note = typeof values.note === "string" ? values.note : "reviewed";
      const state = review(defaultSloSources(), slo, values.by, note);
      const mark = state.reviewed[slo]!;
      console.log(`reviewed: ${slo} by ${mark.by} at ${mark.at} — lane released while breach persists`);
      console.log(`lane: ${JSON.stringify(laneBlockDecision(state))}`);
      process.exit(0);
    }

    console.error("usage: factory-slo.ts <status|check|tick|review> — see file header");
    process.exit(2);
  } catch (err: any) {
    console.error(err instanceof SloConfigError ? err.message : `factory-slo: ${err.message}`);
    process.exit(1);
  }
}
