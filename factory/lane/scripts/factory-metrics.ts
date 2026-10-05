#!/usr/bin/env bun
/**
 * T3 (SF-004) — Factory Metrics Aggregation
 *
 * Pure computeFactoryMetrics(records, opts) over FactoryRecords from
 * state/factory-log.jsonl. Every rate carries its explicit denominator and
 * null (never 0 or 1) when the denominator is empty — no silent division.
 *
 * Honesty invariants:
 *  - first_pass_yield / rework_rate use ONLY sidecar-derived verdict fields
 *    (record.measured / record.verdict); unmeasured runs sit in
 *    unmeasured_count and can never inflate yield.
 *  - throughput counts only units with a known ISO activity stamp inside the
 *    window; undatable units (all stamps "unknown") are reported separately,
 *    never guessed into a day bucket.
 *  - stage drop-off separates reached-with-timestamp from reached-unknown-time.
 *
 * Usage:
 *   bun factory-metrics.ts report [--window <days>] [--json]
 */

import {
  defaultSources,
  readFactoryLog,
  type FactoryRecord,
  type StageName,
} from "./factory-collect";
import {
  computeSurvivability,
  loadSurvivabilityConfig,
  readFateLedger,
  sf012Flags,
  type SurvivabilityReport,
  type SurvivalBucket,
} from "./survivability-core";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readOutcomeEvidenceLedger, reconcileOutcomeEvidence } from "./outcome-evidence-reconcile";
import { factoryStatePath } from "./factory-state-root";
import {
  computeFirstPassMetrics,
  parseFirstPassLedger,
  type FirstPassMetrics,
} from "./first-pass-ledger";
import {
  OUTCOME_EVIDENCE_FAILURES,
  OUTCOME_EXCLUSION_CODES,
  OUTCOME_TERMINAL_STATES,
  type OutcomeEnvelope,
  type OutcomeEvidenceFailure,
  type OutcomeExclusionCode,
  type OutcomeTerminalState,
} from "./outcome-envelope";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StageDropoff {
  reached: number;
  timestamped: number;
  unknown_time: number;
}

export interface FactoryMetrics {
  window_days: number;
  total_units: number;
  measured_count: number;
  unmeasured_count: number;
  // throughput
  throughput_window_units: number;
  throughput_per_day: number;
  undatable_units: number;
  // yield (denominator: measured_count)
  first_pass_count: number;
  first_pass_yield: number | null;
  rework_count: number;
  rework_rate: number | null;
  fail_count: number;
  // gate (denominator: gate_classified_count = units with a recorded gate decision)
  gate_classified_count: number;
  held_count: number;
  gate_rejection_rate: number | null;
  auto_approval_ratio: number | null;
  // cycle time (denominator: cycle_time_count)
  cycle_time_count: number;
  mean_cycle_time_hours: number | null;
  // stages
  stage_dropoff: Record<StageName, StageDropoff>;
  // SF-011: per-archetype drill-down; records without a recorded archetype
  // bucket under "unrecorded" (pre-SF-011 runs / flag off), never guessed.
  by_archetype: Record<string, ArchetypeSlice>;
  computed_at: string;
}

export interface ArchetypeSlice {
  units: number;
  measured: number;
  first_pass: number;
  first_pass_yield: number | null;
  rework: number;
  failed: number;
}

export const OUTCOME_COVERAGE_FLOOR = 0.95;
export const OUTCOME_MINIMUM_ELIGIBLE_SAMPLE = 30;

export interface OutcomeEvidenceMetrics {
  ledger_available: boolean;
  ledger_rows: number;
  ledger_errors: number;
  terminal_count: number;
  eligible_terminal_count: number;
  measured_count: number;
  excluded_count: number;
  held_unmeasured_count: number;
  evidence_coverage: number | null;
  coverage_floor: number;
  minimum_eligible_sample: number;
  promotion_ready: boolean;
  successful_eligible_count: number;
  successful_measured_count: number;
  successful_evidence_coverage: number | null;
  by_terminal_state: Record<OutcomeTerminalState, number>;
  exclusions: Record<OutcomeExclusionCode, number>;
  evidence_failures: Record<OutcomeEvidenceFailure, number>;
}

export interface FirstPassCompletenessSlice {
  candidates: number;
  contract_complete: number;
  contract_completeness: number | null;
}

export interface FirstPassQualityReport {
  ledger_available: boolean;
  ledger_rows: number;
  ledger_errors: string[];
  candidate_count: number;
  contract_complete_count: number;
  contract_completeness: number | null;
  by_stratum: Record<string, FirstPassCompletenessSlice>;
  metrics: FirstPassMetrics | null;
}

const STAGE_ORDER: StageName[] = ["decision", "seed", "execute", "postflight", "pr"];

// ─── Pure aggregation ─────────────────────────────────────────────────────────

/** Latest known ISO stamp across stages; null when every stamp is unknown/null. */
export function latestActivity(rec: FactoryRecord): string | null {
  let latest: string | null = null;
  for (const stage of STAGE_ORDER) {
    const stamp = rec.stages[stage];
    if (stamp === null || stamp === "unknown") continue;
    if (Number.isNaN(Date.parse(stamp))) continue;
    if (latest === null || Date.parse(stamp) > Date.parse(latest)) latest = stamp;
  }
  return latest;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export function computeOutcomeEvidenceMetrics(
  envelopes: OutcomeEnvelope[],
  options: { ledgerAvailable?: boolean; ledgerRows?: number; ledgerErrors?: number } = {},
): OutcomeEvidenceMetrics {
  const current = new Map<string, OutcomeEnvelope>();
  for (const envelope of envelopes) current.set(envelope.execution_id, envelope);
  const rows = [...current.values()];
  const measured = rows.filter((row) => row.disposition === "measured");
  const excluded = rows.filter((row) => row.disposition === "excluded");
  const held = rows.filter((row) => row.disposition === "held_unmeasured");
  const eligible = measured.length + held.length;
  const successfulEligible = rows.filter((row) => row.terminal_state === "accepted" && row.disposition !== "excluded");
  const successfulMeasured = successfulEligible.filter(
    (row) => row.disposition === "measured" && row.verification?.verdict === "pass",
  );
  const evidenceCoverage = ratio(measured.length, eligible);

  const byTerminalState = Object.fromEntries(OUTCOME_TERMINAL_STATES.map((state) => [state, 0])) as Record<OutcomeTerminalState, number>;
  const exclusions = Object.fromEntries(OUTCOME_EXCLUSION_CODES.map((code) => [code, 0])) as Record<OutcomeExclusionCode, number>;
  const evidenceFailures = Object.fromEntries(OUTCOME_EVIDENCE_FAILURES.map((code) => [code, 0])) as Record<OutcomeEvidenceFailure, number>;
  for (const row of rows) {
    byTerminalState[row.terminal_state]++;
    if (row.exclusion) exclusions[row.exclusion.code]++;
    if (row.hold) evidenceFailures[row.hold.code]++;
  }

  return {
    ledger_available: options.ledgerAvailable ?? true,
    ledger_rows: options.ledgerRows ?? envelopes.length,
    ledger_errors: options.ledgerErrors ?? 0,
    terminal_count: rows.length,
    eligible_terminal_count: eligible,
    measured_count: measured.length,
    excluded_count: excluded.length,
    held_unmeasured_count: held.length,
    evidence_coverage: evidenceCoverage,
    coverage_floor: OUTCOME_COVERAGE_FLOOR,
    minimum_eligible_sample: OUTCOME_MINIMUM_ELIGIBLE_SAMPLE,
    promotion_ready: eligible >= OUTCOME_MINIMUM_ELIGIBLE_SAMPLE
      && evidenceCoverage !== null
      && evidenceCoverage >= OUTCOME_COVERAGE_FLOOR
      && (successfulEligible.length === 0 || successfulMeasured.length === successfulEligible.length),
    successful_eligible_count: successfulEligible.length,
    successful_measured_count: successfulMeasured.length,
    successful_evidence_coverage: ratio(successfulMeasured.length, successfulEligible.length),
    by_terminal_state: byTerminalState,
    exclusions,
    evidence_failures: evidenceFailures,
  };
}

export function loadOutcomeEvidenceMetrics(path: string): OutcomeEvidenceMetrics {
  const ledger = readOutcomeEvidenceLedger(path);
  const preview = ledger.available ? null : reconcileOutcomeEvidence({ apply: false });
  const current = ledger.available
    ? ledger.current
    : preview?.generated.map((row) => row.envelope) ?? [];
  return computeOutcomeEvidenceMetrics(current, {
    ledgerAvailable: ledger.available,
    ledgerRows: ledger.rows.length,
    ledgerErrors: ledger.errors.length + (preview?.source_errors.length ?? 0),
  });
}

export function loadFirstPassQualityMetrics(
  path: string,
  records: readonly FactoryRecord[] = [],
): FirstPassQualityReport {
  const candidates = records.filter((record) => record.first_pass_validation !== undefined);
  const complete = candidates.filter((record) => record.first_pass_validation?.contract_digest !== null);
  const byStratum: Record<string, FirstPassCompletenessSlice> = {};
  for (const record of candidates) {
    const fp = record.first_pass_validation!;
    const key = [record.archetype ?? "unrecorded", fp.repository, fp.harness, fp.validator_version].join("|");
    const slice = (byStratum[key] ??= { candidates: 0, contract_complete: 0, contract_completeness: null });
    slice.candidates++;
    if (fp.contract_digest !== null) slice.contract_complete++;
  }
  for (const slice of Object.values(byStratum)) {
    slice.contract_completeness = ratio(slice.contract_complete, slice.candidates);
  }
  if (!existsSync(path)) {
    return {
      ledger_available: false,
      ledger_rows: 0,
      ledger_errors: [],
      candidate_count: candidates.length,
      contract_complete_count: complete.length,
      contract_completeness: ratio(complete.length, candidates.length),
      by_stratum: byStratum,
      metrics: null,
    };
  }
  const parsed = parseFirstPassLedger(readFileSync(path, "utf8"));
  return {
    ledger_available: true,
    ledger_rows: parsed.rows.length,
    ledger_errors: parsed.errors,
    candidate_count: candidates.length,
    contract_complete_count: complete.length,
    contract_completeness: ratio(complete.length, candidates.length),
    by_stratum: byStratum,
    metrics: parsed.errors.length === 0 ? computeFirstPassMetrics(parsed.rows) : null,
  };
}

export function computeFactoryMetrics(
  records: FactoryRecord[],
  opts: { windowDays?: number; now?: string } = {},
): FactoryMetrics {
  const windowDays = opts.windowDays ?? 7;
  const nowIso = opts.now ?? new Date().toISOString();
  const windowStart = Date.parse(nowIso) - windowDays * 86_400_000;

  const measured = records.filter((r) => r.measured && r.verdict !== null);
  const firstPass = measured.filter((r) => r.verdict!.verdict === "pass" && !r.verdict!.rework);
  const rework = measured.filter((r) => r.verdict!.rework);
  const failed = measured.filter((r) => r.verdict!.verdict === "fail");

  let windowUnits = 0;
  let undatable = 0;
  for (const rec of records) {
    const activity = latestActivity(rec);
    if (activity === null) {
      undatable++;
      continue;
    }
    const t = Date.parse(activity);
    if (t >= windowStart && t <= Date.parse(nowIso)) windowUnits++;
  }

  const gateClassified = records.filter((r) => r.gate_decision !== "unknown");
  const held = gateClassified.filter((r) => r.status === "held");

  const cycles = records
    .map((r) => r.cycle_time_hours)
    .filter((c): c is number => c !== null);

  const by_archetype: Record<string, ArchetypeSlice> = {};
  for (const rec of records) {
    const key = rec.archetype ?? "unrecorded";
    const slice = (by_archetype[key] ??= { units: 0, measured: 0, first_pass: 0, first_pass_yield: null, rework: 0, failed: 0 });
    slice.units++;
    if (rec.measured && rec.verdict !== null) {
      slice.measured++;
      if (rec.verdict.verdict === "pass" && !rec.verdict.rework) slice.first_pass++;
      if (rec.verdict.rework) slice.rework++;
      if (rec.verdict.verdict === "fail") slice.failed++;
    }
  }
  for (const slice of Object.values(by_archetype)) {
    slice.first_pass_yield = ratio(slice.first_pass, slice.measured);
  }

  const stage_dropoff = {} as Record<StageName, StageDropoff>;
  for (const stage of STAGE_ORDER) {
    const reachedRecs = records.filter((r) => r.stages[stage] !== null);
    const unknownTime = reachedRecs.filter((r) => r.stages[stage] === "unknown");
    stage_dropoff[stage] = {
      reached: reachedRecs.length,
      timestamped: reachedRecs.length - unknownTime.length,
      unknown_time: unknownTime.length,
    };
  }

  return {
    window_days: windowDays,
    total_units: records.length,
    measured_count: measured.length,
    unmeasured_count: records.length - measured.length,
    throughput_window_units: windowUnits,
    throughput_per_day: windowDays > 0 ? Math.round((windowUnits / windowDays) * 100) / 100 : 0,
    undatable_units: undatable,
    first_pass_count: firstPass.length,
    first_pass_yield: ratio(firstPass.length, measured.length),
    rework_count: rework.length,
    rework_rate: ratio(rework.length, measured.length),
    fail_count: failed.length,
    gate_classified_count: gateClassified.length,
    held_count: held.length,
    gate_rejection_rate: ratio(held.length, gateClassified.length),
    auto_approval_ratio: ratio(gateClassified.length - held.length, gateClassified.length),
    cycle_time_count: cycles.length,
    mean_cycle_time_hours:
      cycles.length === 0
        ? null
        : Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100,
    stage_dropoff,
    by_archetype,
    computed_at: nowIso,
  };
}

// ─── Report rendering ─────────────────────────────────────────────────────────

function pct(v: number | null): string {
  return v === null ? "n/a (0 denominator)" : `${(v * 100).toFixed(1)}%`;
}

export function renderReport(
  m: FactoryMetrics,
  evidence?: OutcomeEvidenceMetrics,
  firstPass?: FirstPassQualityReport,
): string {
  const lines: string[] = [];
  lines.push(`# Factory Metrics — last ${m.window_days}d (computed ${m.computed_at})`);
  lines.push("");
  lines.push(`| Metric | Value | Denominator |`);
  lines.push(`|--------|-------|-------------|`);
  lines.push(`| Units (all-time) | ${m.total_units} | — |`);
  lines.push(`| Throughput | ${m.throughput_per_day}/day (${m.throughput_window_units} in window) | dated units; ${m.undatable_units} undatable excluded |`);
  lines.push(`| First-pass yield | ${pct(m.first_pass_yield)} (${m.first_pass_count}) | ${m.measured_count} measured |`);
  lines.push(`| Rework rate | ${pct(m.rework_rate)} (${m.rework_count}) | ${m.measured_count} measured |`);
  lines.push(`| Failed | ${m.fail_count} | ${m.measured_count} measured |`);
  lines.push(`| Unmeasured | ${m.unmeasured_count} | ${m.total_units} units — never counted as passed |`);
  lines.push(`| Gate rejection (held) | ${pct(m.gate_rejection_rate)} (${m.held_count}) | ${m.gate_classified_count} gate-classified |`);
  lines.push(`| Auto-approval ratio | ${pct(m.auto_approval_ratio)} | ${m.gate_classified_count} gate-classified |`);
  lines.push(`| Mean cycle time | ${m.mean_cycle_time_hours === null ? "n/a" : `${m.mean_cycle_time_hours}h`} | ${m.cycle_time_count} with full decision→postflight stamps |`);
  lines.push("");
  lines.push(`## Stage drop-off (decision → seed → execute → post-flight → PR)`);
  lines.push("");
  lines.push(`| Stage | Reached | Timestamped | Unknown time |`);
  lines.push(`|-------|---------|-------------|--------------|`);
  for (const stage of STAGE_ORDER) {
    const d = m.stage_dropoff[stage];
    lines.push(`| ${stage} | ${d.reached} | ${d.timestamped} | ${d.unknown_time} |`);
  }
  const archetypeKeys = Object.keys(m.by_archetype).filter((k) => k !== "unrecorded").sort();
  if (archetypeKeys.length > 0) {
    lines.push("");
    lines.push(`## By archetype (SF-011 assembly lines)`);
    lines.push("");
    lines.push(`| Line | Units | Measured | First-pass yield | Rework | Failed |`);
    lines.push(`|------|-------|----------|------------------|--------|--------|`);
    for (const key of [...archetypeKeys, ...(m.by_archetype.unrecorded ? ["unrecorded"] : [])]) {
      const s = m.by_archetype[key];
      lines.push(`| ${key} | ${s.units} | ${s.measured} | ${pct(s.first_pass_yield)} (${s.first_pass}) | ${s.rework} | ${s.failed} |`);
    }
  }
  if (evidence) {
    lines.push("");
    lines.push(`## Outcome evidence coverage`);
    lines.push("");
    lines.push(`| Metric | Value | Denominator |`);
    lines.push(`|--------|-------|-------------|`);
    lines.push(`| Current terminal envelopes | ${evidence.terminal_count} | ${evidence.ledger_rows} append-only rows |`);
    lines.push(`| Measured | ${evidence.measured_count} | ${evidence.eligible_terminal_count} eligible terminals |`);
    lines.push(`| Excluded | ${evidence.excluded_count} | never eligible and never counted as success |`);
    lines.push(`| Held unmeasured | ${evidence.held_unmeasured_count} | eligible but never counted as success |`);
    lines.push(`| Evidence coverage | ${pct(evidence.evidence_coverage)} | ${evidence.measured_count}/${evidence.eligible_terminal_count} eligible terminals |`);
    lines.push(`| Successful-terminal evidence | ${pct(evidence.successful_evidence_coverage)} | ${evidence.successful_measured_count}/${evidence.successful_eligible_count} eligible accepted terminals |`);
    lines.push(`| Promotion readiness | ${evidence.promotion_ready ? "READY" : "NOT READY"} | ≥${Math.round(evidence.coverage_floor * 100)}% across ≥${evidence.minimum_eligible_sample} eligible terminals |`);
    lines.push(`| Evidence failures | ${JSON.stringify(evidence.evidence_failures)} | held_unmeasured only |`);
    lines.push(`| Typed exclusions | ${JSON.stringify(evidence.exclusions)} | excluded only |`);
    if (!evidence.ledger_available) lines.push(`| Ledger health | unavailable | missing ledger is not treated as zero defects |`);
    else if (evidence.ledger_errors > 0) lines.push(`| Ledger health | INVALID (${evidence.ledger_errors} errors) | fail closed |`);
  }
  if (firstPass) {
    lines.push("");
    lines.push("## Independent first-pass validation (ZOU-1529 shadow)");
    lines.push("");
    lines.push("| Metric | Value | Denominator |");
    lines.push("|--------|-------|-------------|");
    lines.push(`| Contract completeness | ${pct(firstPass.contract_completeness)} | ${firstPass.contract_complete_count}/${firstPass.candidate_count} shadow candidates |`);
    lines.push(`| Validator ledger | ${firstPass.ledger_available ? firstPass.ledger_rows + " valid rows" : "unavailable"} | malformed data never counts as pass evidence |`);
    if (firstPass.metrics) {
      lines.push(`| First-pass yield | ${pct(firstPass.metrics.first_pass_yield)} | ${firstPass.metrics.first_pass_passes}/${firstPass.metrics.executions} independently validated executions |`);
      lines.push(`| Rework rate | ${pct(firstPass.metrics.rework_rate)} | ${firstPass.metrics.repaired_executions}/${firstPass.metrics.executions} independently validated executions |`);
      lines.push(`| Validation cycles | ${firstPass.metrics.validation_cycles} | failed=${firstPass.metrics.failed_cycles}, flaky=${firstPass.metrics.flaky_cycles}, held=${firstPass.metrics.held_cycles} |`);
      lines.push(`| Defect classes | ${JSON.stringify(firstPass.metrics.defect_classes)} | all retained cycles |`);
      lines.push(`| Outcome strata | ${JSON.stringify(firstPass.metrics.strata)} | archetype\|repository\|harness\|validator version |`);
    }
    lines.push(`| Contract strata | ${JSON.stringify(firstPass.by_stratum)} | archetype\|repository\|harness\|validator version |`);
    if (firstPass.ledger_errors.length > 0) {
      lines.push(`| Ledger health | INVALID (${firstPass.ledger_errors.length} errors) | metrics withheld; fail closed |`);
    }
  }
  return lines.join("\n");
}

// ─── SF-012 trailing quality (behind SF012_SURVIVAL — flag off ⇒ byte-identical) ─

/**
 * TRAILING quality = post-merge fate (did the code survive out there?), a
 * deliberately separate axis from FIRST-PASS yield above (did it pass its own
 * post-flight?). Min-sample honesty: no rate renders below min_sample.
 */
export function renderTrailingQuality(report: SurvivabilityReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`## Trailing quality (SF-012 post-merge survivability — distinct from first-pass yield)`);
  lines.push("");
  const rate = (b: SurvivalBucket) =>
    b.insufficient_data
      ? `insufficient data (n=${b.n} < ${report.min_sample})`
      : `${((b.survival_rate ?? 0) * 100).toFixed(1)}%`;
  lines.push(`| Bucket | n | Survived | Reverted | Hotfixed | Survival rate |`);
  lines.push(`|--------|---|----------|----------|----------|---------------|`);
  lines.push(
    `| global | ${report.global.n} | ${report.global.survived} | ${report.global.reverted} | ${report.global.hotfixed} | ${rate(report.global)} |`,
  );
  for (const key of Object.keys(report.by_archetype).sort()) {
    const b = report.by_archetype[key];
    lines.push(`| ${key} | ${b.n} | ${b.survived} | ${b.reverted} | ${b.hotfixed} | ${rate(b)} |`);
  }
  if (report.distinct_prs === 0) {
    lines.push("");
    lines.push(`_No merged agent PRs probed yet — trailing quality is unmeasurable by design (no synthetic data)._`);
  }
  return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd] = args;
  if (cmd !== "report") {
    console.error("usage: factory-metrics.ts report [--window <days>] [--json]");
    process.exit(2);
  }
  const wIdx = args.indexOf("--window");
  let windowDays = 7;
  if (wIdx !== -1) {
    windowDays = Number(args[wIdx + 1]);
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      console.error(`--window must be a positive number of days (got ${JSON.stringify(args[wIdx + 1])})`);
      process.exit(2);
    }
  }
  const records = [...readFactoryLog(defaultSources().logPath).values()];
  const metrics = computeFactoryMetrics(records, { windowDays });
  const outcomeEvidence = loadOutcomeEvidenceMetrics(factoryStatePath("outcome-evidence-ledger.jsonl"));
  const firstPassQuality = loadFirstPassQualityMetrics(factoryStatePath("first-pass-ledger.jsonl"), records);
  // SF-012: trailing-quality section rides the same report ONLY when
  // SF012_SURVIVAL=1 — flag off keeps output byte-identical to baseline.
  let trailing: SurvivabilityReport | null = null;
  if (sf012Flags().survival) {
    const loaded = loadSurvivabilityConfig();
    const ledger = readFateLedger();
    trailing = computeSurvivability(ledger.records, loaded.config, ledger.torn_lines);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(trailing === null
      ? { ...metrics, outcome_evidence: outcomeEvidence, first_pass_quality: firstPassQuality }
      : { ...metrics, outcome_evidence: outcomeEvidence, first_pass_quality: firstPassQuality, trailing_quality: trailing }, null, 2));
  } else {
    console.log(trailing === null
      ? renderReport(metrics, outcomeEvidence, firstPassQuality)
      : renderReport(metrics, outcomeEvidence, firstPassQuality) + renderTrailingQuality(trailing));
  }
  process.exit(0);
}
