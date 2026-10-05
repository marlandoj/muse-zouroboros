#!/usr/bin/env bun
import { factoryWorktreesRoot, factoryWorktreeReadRoots } from "../../../packages/swarm/src/transport/factory-path-profile";
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FR-09 (ZOU-1118) — Factory Observatory and outcome metrics.
 *
 * One read-only surface over the assembly line: queue, worker rooms, leases,
 * worktrees, gates, blocked handoffs, dead letters, and campaign rollups,
 * plus outcome metrics (cost per accepted outcome, first-pass yield, rework,
 * escaped defects, cycle time, post-merge survival).
 *
 * Honesty invariants (inherits SF-004 discipline):
 *  - every rate carries numerator + denominator; null (never 0 or 1) when the
 *    denominator is empty — missing data is reported, not treated as success;
 *  - unmeasured / unjoined / undatable counts are first-class fields;
 *  - every surface carries a mode tag (advisory | shadow | canary | live |
 *    off | measurement) derived mechanically from runtime-flags.json, and the
 *    export groups action surfaces by mode;
 *  - alert thresholds cover stale reconciliation and evidence/config drift;
 *    alerts fire on measured values, never on absence of measurement alone —
 *    absence raises its own explicit alert.
 *
 * Read-only by contract: never writes state/, never mutates flags.
 * shadow-state.ts is not imported (it executes main() on import); the shadow
 * phase is read from state/shadow-state.json directly.
 *
 * Usage:
 *   bun factory-observatory.ts report [--json] [--window <days>]
 *     [--stale-hours <h>] [--cost-file <path>] [--worktrees-root <path>]
 *
 * Exit codes: 0 = no critical alerts, 1 = critical alerts present.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sf003Snapshot, type SF003Snapshot } from "./pool-manager";
import { qualificationStatus, type QualificationStatus, L4_EVIDENCE_MIN_RATE, L4_WINDOW_MIN_EXECUTIONS } from "./l4-qualification";
import {
  computeFactoryMetrics,
  loadFirstPassQualityMetrics,
  loadOutcomeEvidenceMetrics,
  type FactoryMetrics,
  type FirstPassQualityReport,
  type OutcomeEvidenceMetrics,
} from "./factory-metrics";
import { readFactoryLog, defaultSources } from "./factory-collect";
import { computeSurvivability, loadSurvivabilityConfig, readFateLedger, type SurvivalBucket } from "./survivability-core";
import { readLedger, type LedgerEntry } from "./approval-ledger";
import { loadRuntimeConfig, divergenceFrom, configHash, TICKS_PATH, type RuntimeConfigFile } from "./runtime-config";

// ─── Config ───────────────────────────────────────────────────────────────────

const PROJECT_DIR = dirname(import.meta.dir);
const STATE_DIR = factoryStateRoot();

export const DEFAULT_STALE_HOURS = 24;
export const DEFAULT_WINDOW_DAYS = 14;
export const COST_STALE_DAYS = 7;

export type SurfaceMode = "advisory" | "shadow" | "canary" | "live" | "off" | "measurement";
export type AlertSeverity = "critical" | "warning";

export interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null };
}

export interface ModeSurface {
  id: string;
  label: string;
  mode: SurfaceMode;
  source: string;
}

export interface ObservatoryAlert {
  id: string;
  severity: AlertSeverity;
  surface: string;
  mode: SurfaceMode;
  message: string;
  value: number | string | null;
  threshold: number | string;
}

export interface WorktreeEntry {
  path: string;
  age_hours: number | null;
}

export interface CostPerOutcome {
  available: boolean;
  path: string;
  generated_at: string | null;
  age_days: number | null;
  cost_per_accepted_outcome_usd: number | null;
  accepted_runs: number;
  joined_runs: number;
  unjoined_cost_runs: number;
  unjoined_verdicts: number;
  by_outcome: Record<string, { runs: number; total_usd: number; usd_per_run: number }>;
  note: string;
}

export interface GateSection {
  approval_ledger: {
    available: boolean;
    entries: number;
    operator_approved: number;
    operator_rejected: number;
    operator_pending: number;
    operator_excluded: number;
    agreement: Rate;
    agreement_unmeasured: number;
  };
  auto_merge_audit: {
    available: boolean;
    records: number;
    by_method: Record<string, number>;
    live_merges: number;
    last_at: string | null;
  };
  qualification: QualificationStatus | { available: false; error: string };
}

export interface ObservatorySnapshot {
  schema_version: 1;
  generated_at: string;
  sources: {
    project_dir: string;
    pool_state_dir: string;
    config_path: string | null;
    cost_path: string;
    worktrees_root: string;
    read_errors: string[];
  };
  modes: {
    shadow_phase: string | null;
    surfaces: ModeSurface[];
    actions_by_mode: Record<SurfaceMode, string[]>;
  };
  line: SF003Snapshot | { available: false; error: string };
  worktrees: { root: string; count: number; entries: WorktreeEntry[] };
  gates: GateSection;
  outcomes: {
    metrics: FactoryMetrics | { available: false; error: string };
    first_pass_quality: FirstPassQualityReport;
    evidence: OutcomeEvidenceMetrics;
    survivability: {
      available: boolean;
      global: SurvivalBucket | null;
      escaped_defects: number;
      reverted: number;
      hotfixed: number;
      torn_lines: number;
      note: string;
    };
    cost: CostPerOutcome;
  };
  alerts: ObservatoryAlert[];
}

// ─── Mode derivation ──────────────────────────────────────────────────────────

function flagValue(config: RuntimeConfigFile | null, key: string): string | null {
  if (!config) return null;
  return Object.prototype.hasOwnProperty.call(config.flags, key) ? config.flags[key] : null;
}

function boolMode(v: string | null, on: SurfaceMode, offMode: SurfaceMode = "off"): SurfaceMode {
  if (v === null) return offMode;
  return v === "1" ? on : offMode;
}

function enumMode(v: string | null): SurfaceMode {
  if (v === "enforce") return "live";
  if (v === "shadow") return "shadow";
  if (v === "advisory") return "advisory";
  return "off";
}

/**
 * Every mode is a mechanical function of runtime-flags.json — no judgment
 * calls at render time. Auto-merge maps 1 -> canary by charter: the L4 plan
 * only ever authorizes one-at-a-time canary merges; expansion past canary
 * requires a new operator decision and a new mapping here.
 */
export function deriveSurfaces(config: RuntimeConfigFile | null): ModeSurface[] {
  const pool = flagValue(config, "SF003_POOL");
  const poolMode = flagValue(config, "SF003_POOL_MODE");
  const assemblyMode: SurfaceMode =
    pool !== "1" || poolMode === "off" ? "off" : poolMode === "act" ? "live" : "shadow";
  return [
    { id: "assembly_line", label: "Assembly line (SF-003 pool)", mode: assemblyMode, source: "SF003_POOL+SF003_POOL_MODE" },
    { id: "auto_merge", label: "Auto-merge lane (SF-010)", mode: boolMode(flagValue(config, "SF010_AUTOMERGE"), "canary", "advisory"), source: "SF010_AUTOMERGE" },
    { id: "scenario_gate", label: "Digital-twin scenario gate (SF-009)", mode: boolMode(flagValue(config, "SF009_SCENARIOS"), "live", "advisory"), source: "SF009_SCENARIOS" },
    { id: "dedup_gate", label: "Dedup gate (SF-006)", mode: flagValue(config, "SF006_ENFORCE") === "1" ? "live" : boolMode(flagValue(config, "SF006_DEDUP"), "advisory"), source: "SF006_DEDUP+SF006_ENFORCE" },
    { id: "consensus_review", label: "Legacy model consensus review", mode: enumMode(flagValue(config, "FACTORY_MODEL_REVIEW")), source: "FACTORY_MODEL_REVIEW" },
    { id: "diversity_review", label: "Persona Diversity of Thought review", mode: enumMode(flagValue(config, "FACTORY_PERSONA_ROUTING_MODE")), source: "FACTORY_PERSONA_ROUTING_MODE" },
    { id: "review_gate", label: "Review gate", mode: enumMode(flagValue(config, "FACTORY_REVIEW_GATE_MODE")), source: "FACTORY_REVIEW_GATE_MODE" },
    { id: "first_pass_validation", label: "Independent first-pass validation", mode: enumMode(process.env.FIRST_PASS_VALIDATION_MODE ?? flagValue(config, "FIRST_PASS_VALIDATION_MODE")), source: "FIRST_PASS_VALIDATION_MODE" },
    { id: "serial_promotion", label: "Serial promotion", mode: enumMode(flagValue(config, "FACTORY_SERIAL_PROMOTION")), source: "FACTORY_SERIAL_PROMOTION" },
    { id: "plan_gate", label: "Plan gate", mode: enumMode(flagValue(config, "PLAN_GATE_MODE")), source: "PLAN_GATE_MODE" },
    { id: "product_gate", label: "Product gate", mode: flagValue(config, "FACTORY_PRODUCT_GATE_ENFORCE") === "1" ? "live" : boolMode(flagValue(config, "FACTORY_PRODUCT_GATE"), "shadow"), source: "FACTORY_PRODUCT_GATE(+_ENFORCE)" },
    { id: "qualification_window", label: "L4 qualification window", mode: "measurement", source: "derived from exec evidence" },
    { id: "outcome_metrics", label: "Outcome metrics (SF-004/SF-012)", mode: "measurement", source: "factory-log + fate ledger" },
  ];
}

// ─── Section collectors (each failure-isolated) ───────────────────────────────

function readShadowPhase(errors: string[]): string | null {
  const p = join(STATE_DIR, "shadow-state.json");
  try {
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return typeof parsed.current_phase === "string" ? parsed.current_phase : null;
  } catch (err) {
    errors.push(`shadow-state.json: ${String(err)}`);
    return null;
  }
}

function collectLine(errors: string[]): SF003Snapshot | { available: false; error: string } {
  try {
    return sf003Snapshot();
  } catch (err) {
    errors.push(`sf003Snapshot: ${String(err)}`);
    return { available: false, error: String(err) };
  }
}

function collectWorktrees(root: string, errors: string[]): { root: string; count: number; entries: WorktreeEntry[] } {
  const entries: WorktreeEntry[] = [];
  try {
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const p = join(root, name);
        let age: number | null = null;
        try {
          const st = statSync(p);
          if (!st.isDirectory()) continue;
          age = Math.round(((Date.now() - st.mtimeMs) / 3_600_000) * 10) / 10;
        } catch {
          continue;
        }
        entries.push({ path: p, age_hours: age });
      }
    }
  } catch (err) {
    errors.push(`worktrees: ${String(err)}`);
  }
  return { root, count: entries.length, entries };
}

function collectGates(ledgerPath: string, auditDir: string, errors: string[]): GateSection {
  let ledger: Map<string, LedgerEntry> | null = null;
  try {
    ledger = readLedger(ledgerPath);
  } catch (err) {
    errors.push(`approval-ledger: ${String(err)}`);
  }
  const entries = ledger ? [...ledger.values()] : [];
  const measuredAgreement = entries.filter((e) => e.agreement !== null);

  let auditRecords: { method: string; ts: string | null }[] = [];
  let auditAvailable = false;
  try {
    if (existsSync(auditDir)) {
      auditAvailable = true;
      for (const f of readdirSync(auditDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(auditDir, f), "utf8"));
          auditRecords.push({
            method: String(parsed?.merge_result?.method ?? "unknown"),
            ts: typeof parsed?.ts === "string" ? parsed.ts : null,
          });
        } catch (err) {
          errors.push(`auto-merge-audit/${f}: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(`auto-merge-audit: ${String(err)}`);
  }
  const byMethod: Record<string, number> = {};
  for (const r of auditRecords) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  const stamps = auditRecords.map((r) => r.ts).filter((t): t is string => t !== null).sort();

  let qualification: QualificationStatus | { available: false; error: string };
  try {
    qualification = qualificationStatus();
  } catch (err) {
    errors.push(`qualification: ${String(err)}`);
    qualification = { available: false, error: String(err) };
  }

  return {
    approval_ledger: {
      available: ledger !== null,
      entries: entries.length,
      operator_approved: entries.filter((e) => e.operator_verdict === "approved").length,
      operator_rejected: entries.filter((e) => e.operator_verdict === "rejected").length,
      operator_pending: entries.filter((e) => e.operator_verdict === "pending" && !e.calibration_exclusion).length,
      operator_excluded: entries.filter((e) => Boolean(e.calibration_exclusion)).length,
      agreement: rate(measuredAgreement.filter((e) => e.agreement === true).length, measuredAgreement.length),
      agreement_unmeasured: entries.length - measuredAgreement.length,
    },
    auto_merge_audit: {
      available: auditAvailable,
      records: auditRecords.length,
      by_method: byMethod,
      live_merges: auditRecords.filter((r) => r.method !== "dry-run").length,
      last_at: stamps.length > 0 ? stamps[stamps.length - 1] : null,
    },
    qualification,
  };
}

function collectMetrics(windowDays: number, errors: string[]): FactoryMetrics | { available: false; error: string } {
  try {
    const records = [...readFactoryLog(defaultSources().logPath).values()];
    return computeFactoryMetrics(records, { windowDays });
  } catch (err) {
    errors.push(`factory-metrics: ${String(err)}`);
    return { available: false, error: String(err) };
  }
}

function collectOutcomeEvidence(errors: string[]): OutcomeEvidenceMetrics {
  try {
    return loadOutcomeEvidenceMetrics(join(STATE_DIR, "outcome-evidence-ledger.jsonl"));
  } catch (err) {
    errors.push(`outcome-evidence: ${String(err)}`);
    return {
      ledger_available: false,
      ledger_rows: 0,
      ledger_errors: 1,
      terminal_count: 0,
      eligible_terminal_count: 0,
      measured_count: 0,
      excluded_count: 0,
      held_unmeasured_count: 0,
      evidence_coverage: null,
      coverage_floor: 0.95,
      minimum_eligible_sample: 30,
      promotion_ready: false,
      successful_eligible_count: 0,
      successful_measured_count: 0,
      successful_evidence_coverage: null,
      by_terminal_state: { accepted: 0, failed: 0, held: 0, dry_run: 0 },
      exclusions: { invalid: 0, duplicate: 0, canceled: 0, superseded: 0, operator_aborted: 0, pre_instrumentation: 0 },
      evidence_failures: { missing: 0, stale: 0, malformed: 0, duplicate: 0, forged: 0, mismatched: 0 },
    };
  }
}

function collectFirstPassQuality(errors: string[]): FirstPassQualityReport {
  try {
    const records = [...readFactoryLog(defaultSources().logPath).values()];
    return loadFirstPassQualityMetrics(join(STATE_DIR, "first-pass-ledger.jsonl"), records);
  } catch (err) {
    errors.push(`first-pass-quality: ${String(err)}`);
    return {
      ledger_available: false,
      ledger_rows: 0,
      ledger_errors: [String(err)],
      candidate_count: 0,
      contract_complete_count: 0,
      contract_completeness: null,
      by_stratum: {},
      metrics: null,
    };
  }
}

function collectSurvivability(errors: string[]): ObservatorySnapshot["outcomes"]["survivability"] {
  try {
    const loaded = loadSurvivabilityConfig();
    const ledger = readFateLedger();
    const report = computeSurvivability(ledger.records, loaded.config, ledger.torn_lines);
    const g = report.global;
    return {
      available: true,
      global: g,
      escaped_defects: g.reverted + g.hotfixed,
      reverted: g.reverted,
      hotfixed: g.hotfixed,
      torn_lines: ledger.torn_lines,
      note: g.n === 0 ? "fate ledger empty — post-merge survival unmeasured, not perfect" : `escaped defect = merged then reverted or hotfixed; denominator n=${g.n} fated merges`,
    };
  } catch (err) {
    errors.push(`survivability: ${String(err)}`);
    return { available: false, global: null, escaped_defects: 0, reverted: 0, hotfixed: 0, torn_lines: 0, note: String(err) };
  }
}

function collectCost(costPath: string, now: Date, errors: string[]): CostPerOutcome {
  const empty: CostPerOutcome = {
    available: false,
    path: costPath,
    generated_at: null,
    age_days: null,
    cost_per_accepted_outcome_usd: null,
    accepted_runs: 0,
    joined_runs: 0,
    unjoined_cost_runs: 0,
    unjoined_verdicts: 0,
    by_outcome: {},
    note: "cost-per-outcome store missing — cost per accepted outcome unmeasured",
  };
  try {
    if (!existsSync(costPath)) return empty;
    const parsed = JSON.parse(readFileSync(costPath, "utf8"));
    const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : null;
    const ageDays = generatedAt === null ? null : Math.round(((now.getTime() - new Date(generatedAt).getTime()) / 86_400_000) * 10) / 10;
    const byOutcome: CostPerOutcome["by_outcome"] = {};
    for (const [k, v] of Object.entries(parsed.byOutcome ?? {})) {
      const o = v as { runs?: number; totalUsd?: number; usdPerRun?: number };
      byOutcome[k] = { runs: o.runs ?? 0, total_usd: o.totalUsd ?? 0, usd_per_run: o.usdPerRun ?? 0 };
    }
    const accepted = byOutcome.passed?.runs ?? 0;
    return {
      available: true,
      path: costPath,
      generated_at: generatedAt,
      age_days: ageDays,
      cost_per_accepted_outcome_usd: accepted > 0 ? byOutcome.passed.usd_per_run : null,
      accepted_runs: accepted,
      joined_runs: typeof parsed.joinedRuns === "number" ? parsed.joinedRuns : 0,
      unjoined_cost_runs: typeof parsed.unjoinedCostRuns === "number" ? parsed.unjoinedCostRuns : 0,
      unjoined_verdicts: typeof parsed.unjoinedVerdicts === "number" ? parsed.unjoinedVerdicts : 0,
      by_outcome: byOutcome,
      note: "denominator = joined runs (cost row matched to a verdict); unjoined rows are excluded from every rate and reported here",
    };
  } catch (err) {
    errors.push(`cost-per-outcome: ${String(err)}`);
    return { ...empty, note: `cost store unreadable: ${String(err)}` };
  }
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export function deriveAlerts(
  snapshot: Omit<ObservatorySnapshot, "alerts">,
  config: RuntimeConfigFile | null,
  configErrors: string[],
  staleHours: number,
  now: Date,
): ObservatoryAlert[] {
  const alerts: ObservatoryAlert[] = [];
  const line = snapshot.line as SF003Snapshot;

  if ("available" in snapshot.line && snapshot.line.available === false) {
    alerts.push({ id: "line_unreadable", severity: "critical", surface: "assembly_line", mode: modeOf(snapshot, "assembly_line"), message: "pool snapshot unreadable — line state unknown", value: null, threshold: "readable" });
  } else {
    const last = line.last_reconcile;
    const ageHours = last === null ? null : (now.getTime() - new Date(last).getTime()) / 3_600_000;
    if (ageHours === null) {
      alerts.push({ id: "stale_reconciliation", severity: "critical", surface: "assembly_line", mode: modeOf(snapshot, "assembly_line"), message: "no reconcile event recorded — reconciliation liveness unmeasured", value: null, threshold: `${staleHours}h` });
    } else if (ageHours > staleHours) {
      alerts.push({ id: "stale_reconciliation", severity: "critical", surface: "assembly_line", mode: modeOf(snapshot, "assembly_line"), message: `last reconcile ${Math.round(ageHours * 10) / 10}h ago exceeds ${staleHours}h`, value: Math.round(ageHours * 10) / 10, threshold: `${staleHours}h` });
    }
    if (line.supervisor.dead_letters.length > 0) {
      alerts.push({ id: "dead_letters", severity: "warning", surface: "assembly_line", mode: modeOf(snapshot, "assembly_line"), message: `${line.supervisor.dead_letters.length} dead-letter record(s) awaiting operator review`, value: line.supervisor.dead_letters.length, threshold: 0 });
    }
    if (!line.fleet_separation_ok) {
      alerts.push({ id: "fleet_separation", severity: "critical", surface: "assembly_line", mode: modeOf(snapshot, "assembly_line"), message: line.fleet_separation_reason, value: null, threshold: "0 scheduled-agent references" });
    }
  }

  const q = snapshot.gates.qualification;
  if ("available" in q && q.available === false) {
    alerts.push({ id: "evidence_drift", severity: "critical", surface: "qualification_window", mode: "measurement", message: "qualification status unreadable — evidence completeness unmeasured", value: null, threshold: `${L4_EVIDENCE_MIN_RATE}` });
  } else {
    const qs = q as QualificationStatus;
    if (qs.evidence_complete_rate !== null && qs.evidence_complete_rate < L4_EVIDENCE_MIN_RATE) {
      alerts.push({ id: "evidence_drift", severity: "critical", surface: "qualification_window", mode: "measurement", message: `evidence completeness ${(qs.evidence_complete_rate * 100).toFixed(1)}% below required ${(L4_EVIDENCE_MIN_RATE * 100).toFixed(0)}%`, value: qs.evidence_complete_rate, threshold: L4_EVIDENCE_MIN_RATE });
    }
  }

  if (config === null) {
    alerts.push({ id: "config_drift", severity: "critical", surface: "runtime_config", mode: "live", message: `runtime-flags.json unreadable or invalid: ${configErrors.join("; ") || "unknown"}`, value: null, threshold: "valid config" });
  } else {
    const divergence = divergenceFrom(config);
    if (divergence.length > 0) {
      alerts.push({ id: "config_drift", severity: "critical", surface: "runtime_config", mode: "live", message: `${divergence.length} flag(s) diverge between runtime-flags.json and this environment: ${divergence.map((d) => d.flag).join(", ")}`, value: divergence.length, threshold: 0 });
    }
    try {
      if (existsSync(TICKS_PATH)) {
        const lines = readFileSync(TICKS_PATH, "utf8").trim().split("\n").filter(Boolean);
        if (lines.length > 0) {
          const lastTick = JSON.parse(lines[lines.length - 1]);
          const currentHash = configHash(config.flags);
          if (typeof lastTick.config_hash === "string" && lastTick.config_hash !== currentHash) {
            alerts.push({ id: "config_drift_tick", severity: "warning", surface: "runtime_config", mode: "live", message: "last conveyor tick recorded a different config hash than the current file — activation pending or unrecorded", value: lastTick.config_hash, threshold: currentHash });
          }
        }
      }
    } catch {
      // tick file unreadable is not config drift; sources.read_errors carries IO detail
    }
  }

  const cost = snapshot.outcomes.cost;
  if (!cost.available) {
    alerts.push({ id: "cost_unmeasured", severity: "warning", surface: "outcome_metrics", mode: "measurement", message: cost.note, value: null, threshold: "store present" });
  } else if (cost.age_days !== null && cost.age_days > COST_STALE_DAYS) {
    alerts.push({ id: "cost_stale", severity: "warning", surface: "outcome_metrics", mode: "measurement", message: `cost-per-outcome store is ${cost.age_days}d old (threshold ${COST_STALE_DAYS}d) — treat $/accepted-outcome as historical`, value: cost.age_days, threshold: COST_STALE_DAYS });
  }

  const evidence = snapshot.outcomes.evidence;
  if (!evidence.ledger_available) {
    alerts.push({ id: "outcome_evidence_unavailable", severity: "warning", surface: "outcome_metrics", mode: "measurement", message: "outcome evidence ledger is unavailable — coverage is unmeasured", value: null, threshold: "ledger present" });
  } else if (evidence.ledger_errors > 0) {
    alerts.push({ id: "outcome_evidence_invalid", severity: "critical", surface: "outcome_metrics", mode: "measurement", message: "outcome evidence ledger failed integrity validation", value: evidence.ledger_errors, threshold: 0 });
  } else if (evidence.eligible_terminal_count > 0 && (evidence.evidence_coverage ?? 0) < evidence.coverage_floor) {
    alerts.push({ id: "outcome_evidence_below_floor", severity: "warning", surface: "outcome_metrics", mode: "measurement", message: "eligible-terminal evidence coverage is below the shadow promotion floor", value: evidence.evidence_coverage, threshold: evidence.coverage_floor });
  }

  const firstPass = snapshot.outcomes.first_pass_quality;
  if (firstPass.ledger_available && firstPass.ledger_errors.length > 0) {
    alerts.push({ id: "first_pass_ledger_invalid", severity: "critical", surface: "first_pass_validation", mode: modeOf(snapshot, "first_pass_validation"), message: "first-pass ledger failed integrity validation; independent quality metrics withheld", value: firstPass.ledger_errors.length, threshold: 0 });
  } else if (firstPass.candidate_count > 0 && firstPass.contract_complete_count < firstPass.candidate_count) {
    alerts.push({ id: "first_pass_contract_incomplete", severity: "warning", surface: "first_pass_validation", mode: modeOf(snapshot, "first_pass_validation"), message: "one or more shadow candidates lack an immutable validation contract", value: firstPass.contract_complete_count, threshold: firstPass.candidate_count });
  }

  return alerts;
}

function modeOf(snapshot: Omit<ObservatorySnapshot, "alerts">, id: string): SurfaceMode {
  return snapshot.modes.surfaces.find((s) => s.id === id)?.mode ?? "off";
}

// ─── Snapshot assembly ────────────────────────────────────────────────────────

export interface ObservatoryOptions {
  windowDays?: number;
  staleHours?: number;
  costFile?: string;
  worktreesRoot?: string;
  now?: Date;
}

export function createObservatorySnapshot(opts: ObservatoryOptions = {}): ObservatorySnapshot {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const staleHours = opts.staleHours ?? DEFAULT_STALE_HOURS;
  const costPath = opts.costFile ?? process.env.FACTORY_COST_PER_OUTCOME_PATH ?? join(process.env.HOME ?? "/root", ".zouroboros", "cost-per-outcome.json");
  const worktreesRoot = factoryWorktreesRoot(opts.worktreesRoot);
  const errors: string[] = [];
  const worktreeEntries = factoryWorktreeReadRoots(opts.worktreesRoot).flatMap(root => collectWorktrees(root, errors).entries);

  const loaded = loadRuntimeConfig();
  const config = loaded.ok ? loaded.config : null;
  const configErrors = loaded.ok ? [] : loaded.errors;
  if (!loaded.ok) errors.push(...loaded.errors.map((e) => `runtime-config: ${e}`));

  const surfaces = deriveSurfaces(config);
  const actionsByMode: Record<SurfaceMode, string[]> = { advisory: [], shadow: [], canary: [], live: [], off: [], measurement: [] };
  for (const s of surfaces) actionsByMode[s.mode].push(s.id);

  const ledgerPath = resolveFactoryStateOverride(process.env.FACTORY_APPROVAL_LEDGER_PATH, "approval-ledger.jsonl");
  const auditDir = resolveFactoryStateOverride(process.env.FACTORY_AUTOMERGE_AUDIT_DIR, "auto-merge-audit");

  const partial: Omit<ObservatorySnapshot, "alerts"> = {
    schema_version: 1,
    generated_at: now.toISOString(),
    sources: {
      project_dir: PROJECT_DIR,
      pool_state_dir: resolveFactoryStateOverride(process.env.SF003_POOL_STATE_DIR, "pool"),
      config_path: loaded.ok ? "config/runtime-flags.json" : null,
      cost_path: costPath,
      worktrees_root: worktreesRoot,
      read_errors: errors,
    },
    modes: {
      shadow_phase: readShadowPhase(errors),
      surfaces,
      actions_by_mode: actionsByMode,
    },
    line: collectLine(errors),
    worktrees: { root: worktreesRoot, count: worktreeEntries.length, entries: worktreeEntries },
    gates: collectGates(ledgerPath, auditDir, errors),
    outcomes: {
      metrics: collectMetrics(windowDays, errors),
      first_pass_quality: collectFirstPassQuality(errors),
      evidence: collectOutcomeEvidence(errors),
      survivability: collectSurvivability(errors),
      cost: collectCost(costPath, now, errors),
    },
  };

  return { ...partial, alerts: deriveAlerts(partial, config, configErrors, staleHours, now) };
}

// ─── Render ───────────────────────────────────────────────────────────────────

function fmtRate(r: Rate): string {
  return r.rate === null ? `unmeasured (0/${r.denominator})` : `${(r.rate * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`;
}

function fmtNullable(v: number | null, suffix = ""): string {
  return v === null ? "unmeasured" : `${v}${suffix}`;
}

export function renderObservatory(s: ObservatorySnapshot): string {
  const out: string[] = [];
  const tag = (id: string) => `[${(s.modes.surfaces.find((x) => x.id === id)?.mode ?? "off").toUpperCase()}]`;
  out.push(`Factory Observatory — ${s.generated_at}`);
  out.push(`Shadow machine phase: ${s.modes.shadow_phase ?? "unknown"}`);
  out.push("");

  out.push("MODES");
  for (const m of s.modes.surfaces) out.push(`  [${m.mode.toUpperCase().padEnd(11)}] ${m.label}  (${m.source})`);
  out.push("");

  out.push(`ASSEMBLY LINE ${tag("assembly_line")}`);
  if ("available" in s.line && s.line.available === false) {
    out.push(`  UNAVAILABLE: ${s.line.error}`);
  } else {
    const l = s.line as SF003Snapshot;
    out.push(`  queue ready=${l.queue_depth_ready} in-flight=${l.in_flight} external=${l.external_in_flight} capacity=${l.capacity_used}/${l.global_cap}`);
    out.push(`  campaigns=${l.campaigns.length} parked=${l.parked.length} retried=${l.retried_items} failover=${l.failover_dispatches}`);
    out.push(`  blocked handoffs (upstream): ${l.upstream_blocked.length}${l.upstream_blocked.length > 0 ? " — " + l.upstream_blocked.map((b) => `${b.task_id}<-[${b.waiting_on.join(",")}]`).join(" ") : ""}`);
    out.push(`  oldest ready wait: ${fmtNullable(l.oldest_ready_wait_min, " min")}`);
    out.push(`  last reconcile: ${l.last_reconcile ?? "never recorded"}`);
    out.push(`  workers=${l.supervisor.workers.length} active leases=${l.supervisor.active_leases.length} expired=${l.supervisor.expired_leases} checkpoints=${l.supervisor.checkpoints} dead letters=${l.supervisor.dead_letters.length}`);
    for (const c of l.campaigns) {
      const chain = c.depends_on_campaigns.length > 0 ? ` deps=[${c.depends_on_campaigns.join(",")}]${c.waiting_on_upstream.length > 0 ? ` WAITING[${c.waiting_on_upstream.join(",")}]` : ""}` : "";
      out.push(`    ${c.identifier} (${c.state}) done=${c.tasks_done}/${c.tasks_total} failed=${c.tasks_failed} parked=${c.tasks_parked} cost=$${c.cost_spent_usd.toFixed(2)}/$${c.cost_ceiling_usd.toFixed(2)}${chain}`);
    }
  }
  out.push("");

  out.push(`WORKTREES (${s.worktrees.root})`);
  out.push(`  count=${s.worktrees.count}${s.worktrees.count > 0 ? " — " + s.worktrees.entries.map((w) => `${w.path.split("/").pop()}@${fmtNullable(w.age_hours, "h")}`).join(" ") : ""}`);
  out.push("");

  out.push(`GATES ${tag("auto_merge")}`);
  const al = s.gates.approval_ledger;
  out.push(`  approval ledger: entries=${al.entries} approved=${al.operator_approved} rejected=${al.operator_rejected} pending=${al.operator_pending} excluded=${al.operator_excluded} agreement=${fmtRate(al.agreement)} unmeasured=${al.agreement_unmeasured}`);
  const am = s.gates.auto_merge_audit;
  out.push(`  auto-merge audit: records=${am.records} live merges=${am.live_merges} methods=${JSON.stringify(am.by_method)} last=${am.last_at ?? "never"}`);
  const q = s.gates.qualification;
  if ("available" in q && q.available === false) {
    out.push(`  qualification: UNAVAILABLE (${q.error})`);
  } else {
    const qs = q as QualificationStatus;
    out.push(`  qualification: ${qs.qualifying_count}/${L4_WINDOW_MIN_EXECUTIONS} qualifying, evidence ${qs.evidence_complete_rate === null ? "unmeasured" : (qs.evidence_complete_rate * 100).toFixed(1) + "%"}, verdict: ${qs.certified ? "CERTIFIED" : "NOT CERTIFIED"}`);
  }
  out.push("");

  out.push(`OUTCOMES ${tag("outcome_metrics")}`);
  const m = s.outcomes.metrics;
  if ("available" in m && m.available === false) {
    out.push(`  metrics: UNAVAILABLE (${m.error})`);
  } else {
    const fm = m as FactoryMetrics;
    out.push(`  units=${fm.total_units} measured=${fm.measured_count} UNMEASURED=${fm.unmeasured_count} undatable=${fm.undatable_units}`);
    out.push(`  first-pass yield: ${fm.first_pass_yield === null ? "unmeasured" : (fm.first_pass_yield * 100).toFixed(1) + "%"} (${fm.first_pass_count}/${fm.measured_count})`);
    out.push(`  rework rate: ${fm.rework_rate === null ? "unmeasured" : (fm.rework_rate * 100).toFixed(1) + "%"} (${fm.rework_count}/${fm.measured_count})`);
    out.push(`  cycle time: ${fm.mean_cycle_time_hours === null ? "unmeasured" : fm.mean_cycle_time_hours.toFixed(1) + "h mean"} (n=${fm.cycle_time_count})`);
  }
  const sv = s.outcomes.survivability;
  const fp = s.outcomes.first_pass_quality;
  out.push(`  independent first-pass ${tag("first_pass_validation")}: contracts=${fp.contract_completeness === null ? "unmeasured" : (fp.contract_completeness * 100).toFixed(1) + "%"} (${fp.contract_complete_count}/${fp.candidate_count}) ledger=${fp.ledger_available ? fp.ledger_rows + " rows" : "unavailable"} errors=${fp.ledger_errors.length}`);
  if (fp.metrics) {
    out.push(`  independent yield: ${fp.metrics.first_pass_yield === null ? "unmeasured" : (fp.metrics.first_pass_yield * 100).toFixed(1) + "%"} (${fp.metrics.first_pass_passes}/${fp.metrics.executions}) rework=${fp.metrics.rework_rate === null ? "unmeasured" : (fp.metrics.rework_rate * 100).toFixed(1) + "%"} flaky=${fp.metrics.flaky_cycles} held=${fp.metrics.held_cycles}`);
    out.push(`  independent defects: ${JSON.stringify(fp.metrics.defect_classes)} strata=${JSON.stringify(fp.metrics.strata)}`);
  }
  const ev = s.outcomes.evidence;
  out.push(`  evidence coverage: ${ev.evidence_coverage === null ? "unmeasured" : (ev.evidence_coverage * 100).toFixed(1) + "%"} (${ev.measured_count}/${ev.eligible_terminal_count} eligible; excluded=${ev.excluded_count} held=${ev.held_unmeasured_count}; promotion=${ev.promotion_ready ? "READY" : "NOT READY"})`);
  out.push(`  evidence health: ledger=${ev.ledger_available ? "available" : "unavailable"} rows=${ev.ledger_rows} errors=${ev.ledger_errors} failures=${JSON.stringify(ev.evidence_failures)} exclusions=${JSON.stringify(ev.exclusions)}`);
  out.push(`  post-merge survival: ${sv.global === null || sv.global.survival_rate === null ? "unmeasured" : (sv.global.survival_rate * 100).toFixed(1) + "%"} (n=${sv.global?.n ?? 0}) escaped defects=${sv.escaped_defects} (reverted=${sv.reverted} hotfixed=${sv.hotfixed}) torn=${sv.torn_lines}`);
  const c = s.outcomes.cost;
  out.push(`  cost per accepted outcome: ${c.cost_per_accepted_outcome_usd === null ? "unmeasured" : "$" + c.cost_per_accepted_outcome_usd.toFixed(4)} (accepted=${c.accepted_runs} joined=${c.joined_runs} unjoined cost rows=${c.unjoined_cost_runs} unjoined verdicts=${c.unjoined_verdicts} as-of=${c.generated_at ?? "n/a"})`);
  out.push("");

  out.push(`ALERTS (${s.alerts.length})`);
  if (s.alerts.length === 0) out.push("  none");
  for (const a of s.alerts) out.push(`  ${a.severity.toUpperCase().padEnd(8)} ${a.id} [${a.mode}] ${a.message}`);
  if (s.sources.read_errors.length > 0) {
    out.push("");
    out.push(`READ ERRORS (${s.sources.read_errors.length})`);
    for (const e of s.sources.read_errors) out.push(`  ${e}`);
  }
  return out.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      window: { type: "string" },
      "stale-hours": { type: "string" },
      "cost-file": { type: "string" },
      "worktrees-root": { type: "string" },
    },
  });
  const command = positionals[0] ?? "report";
  if (command !== "report") {
    console.error(`Unknown command: ${command}\nUsage: factory-observatory.ts report [--json] [--window <days>] [--stale-hours <h>] [--cost-file <path>] [--worktrees-root <path>]`);
    process.exit(2);
  }
  const snapshot = createObservatorySnapshot({
    windowDays: values.window !== undefined ? Number(values.window) : undefined,
    staleHours: values["stale-hours"] !== undefined ? Number(values["stale-hours"]) : undefined,
    costFile: values["cost-file"],
    worktreesRoot: values["worktrees-root"],
  });
  console.log(values.json ? JSON.stringify(snapshot, null, 2) : renderObservatory(snapshot));
  process.exit(snapshot.alerts.some((a) => a.severity === "critical") ? 1 : 0);
}

if (import.meta.main) main();
