#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T7 — Shadow Validation Harness
 *
 * After ≥1 week of shadow operation, this script reads the shadow-state.json
 * and all exec-*.json records, compiles a shadow-validation report, and
 * verifies the exit condition: 0 unsafe auto-executions across dry-run + shadow-pr.
 *
 * Usage:
 *   bun shadow-validate.ts                  # Generate full validation report
 *   bun shadow-validate.ts --json           # Output JSON only
 *   bun shadow-validate.ts --help
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { sf002Snapshot, type SF002Snapshot } from "./agreement-baseline";
import { sf003Snapshot, type SF003Snapshot } from "./pool-manager";
import { sf006Snapshot, type SF006Snapshot } from "./dedup-gate";
import { sf007Snapshot, type SF007Snapshot } from "./signal-intake";
import { ROLLUP_CAVEAT, sf008Snapshot, type SF008Snapshot } from "./fleet-status";
import { sf009Snapshot, type SF009Snapshot } from "./scenario-run";
import { sf011Snapshot, type SF011Snapshot } from "./line-config";
import { sf012Snapshot, type SF012Snapshot } from "./decision-signals";
import { hasReachedDeliveryTarget, isExecutionRecordFileName, isInFlightExecution, normalizeExecutionLifecycle } from "./execution-lifecycle";
import { DRY_RUN_MIN_EXECUTIONS, L4_MIN_QUALIFYING_EXECUTIONS } from "./shadow-state";
import { runtimeConfigSnapshot, type RuntimeConfigSnapshot } from "./runtime-config";

// ─── Config ────────────────────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();
const REPORTS_DIR = join(dirname(import.meta.dir), "reports");

// ─── Types ────────────────────────────────────────────────────────────────────

interface ShadowState {
  current_phase: string;
  phase_started_at: string;
  dry_run_started_at: string | null;
  shadow_pr_started_at: string | null;
  live_started_at: string | null;
  transitions: { from: string; to: string; at: string; reason: string }[];
  safe_executions: number;
  unsafe_auto_executions: number;
}

interface PipelineExecution extends Record<string, unknown> {
  execution_id: string;
  ticket_id: string;
  identifier: string;
  gate_decision: string;
  stage: string;
  branch_name: string | null;
  pr_number: number | null;
  shadow_phase: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  error: string | null;
}

interface ValidationReport {
  generated_at: string;
  shadow_phase: string;
  phase_started_at: string;
  phase_elapsed_hours: number;
  transitions: number;
  safe_executions: number;
  unsafe_auto_executions: number;
  execution_summary: {
    total: number;
    complete: number;
    pending: number;
    implementation_complete: number;
    target_reached: number;
    failed: number;
    dry_run: number;
    in_flight: number;
  };
  decisions: Record<string, number>;
  exit_passed: boolean;
  exit_reason: string;
  executions: PipelineExecution[];
  sf002: SF002Snapshot;
  sf003: SF003Snapshot;
  sf006: SF006Snapshot;
  sf007: SF007Snapshot;
  sf008: SF008Snapshot;
  sf009: SF009Snapshot;
  sf011: SF011Snapshot;
  sf012: SF012Snapshot;
  sf013_runtime_config: RuntimeConfigSnapshot;
}

// ─── Loaders ──────────────────────────────────────────────────────────────────

function loadShadowState(): ShadowState | null {
  const path = join(STATE_DIR, "shadow-state.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadExecutions(): PipelineExecution[] {
  if (!existsSync(STATE_DIR)) return [];
  const files = readdirSync(STATE_DIR).filter(isExecutionRecordFileName);
  return files.map((f) => JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")));
}

// ─── Report generator ─────────────────────────────────────────────────────────

function generateReport(): ValidationReport {
  const state = loadShadowState();
  const executions = loadExecutions();

  if (!state) {
    return {
      generated_at: new Date().toISOString(),
      shadow_phase: "not-initialized",
      phase_started_at: "",
      phase_elapsed_hours: 0,
      transitions: 0,
      safe_executions: 0,
      unsafe_auto_executions: 0,
      execution_summary: { total: 0, complete: 0, pending: 0, implementation_complete: 0, target_reached: 0, failed: 0, dry_run: 0, in_flight: 0 },
      decisions: {},
      exit_passed: false,
      exit_reason: "Shadow state not initialized (no state/shadow-state.json). Start shadow with: bun shadow-state.ts transition dry-run",
      executions: [],
      sf002: sf002Snapshot(),
      sf003: sf003Snapshot(),
      sf006: sf006Snapshot(),
      sf007: sf007Snapshot(),
      sf008: sf008Snapshot(),
      sf009: sf009Snapshot(),
      sf011: sf011Snapshot(),
      sf012: sf012Snapshot(),
    sf013_runtime_config: runtimeConfigSnapshot(),
    };
  }

  const elapsed = (new Date().getTime() - new Date(state.phase_started_at).getTime()) / 3600000;

  const lifecycles = executions.map((execution) => normalizeExecutionLifecycle(execution));
  const implementationComplete = lifecycles.filter((lifecycle) =>
    hasReachedDeliveryTarget(lifecycle.state, "implementation_complete")
  ).length;
  const pending = lifecycles.filter((lifecycle) => lifecycle.state === "executing").length;
  const executionSummary = {
    total: executions.length,
    complete: implementationComplete,
    pending,
    implementation_complete: implementationComplete,
    target_reached: lifecycles.filter((lifecycle) => lifecycle.target_reached).length,
    failed: lifecycles.filter((lifecycle) => lifecycle.state === "failed").length,
    dry_run: lifecycles.filter((lifecycle) => lifecycle.state === "dry_run").length,
    in_flight: lifecycles.filter((lifecycle) => lifecycle.state !== "pool_enqueued" && isInFlightExecution(lifecycle)).length,
  };

  const decisions: Record<string, number> = {};
  for (const e of executions) {
    const d = e.gate_decision || "unknown";
    decisions[d] = (decisions[d] || 0) + 1;
  }

  // Exit condition (ZOU-1110): 0 unsafe auto-executions AND a non-vacuous
  // qualifying sample for the current phase. 741.2 live hours with 0 safe
  // executions must read as FAIL, not PASS.
  const minSample =
    state.current_phase === "dry-run"
      ? DRY_RUN_MIN_EXECUTIONS
      : state.current_phase === "shadow-pr" || state.current_phase === "live"
        ? L4_MIN_QUALIFYING_EXECUTIONS
        : 0;
  const unsafeOk = state.unsafe_auto_executions === 0;
  const sampleOk = state.safe_executions >= minSample;
  const exitPassed = unsafeOk && sampleOk;
  const exitReason = !unsafeOk
    ? `❌ FAIL: ${state.unsafe_auto_executions} unsafe auto-execution(s) detected. Phase blocked — manual review required.`
    : !sampleOk
      ? `❌ FAIL: qualifying sample ${state.safe_executions}/${minSample} safe executions in ${state.current_phase} phase (${elapsed.toFixed(1)}h) — elapsed time alone is vacuous evidence.`
      : `✅ PASS: 0 unsafe auto-executions across ${state.current_phase} phase (${elapsed.toFixed(1)}h). ${state.safe_executions} qualifying safe executions (≥${minSample}).`;

  return {
    generated_at: new Date().toISOString(),
    shadow_phase: state.current_phase,
    phase_started_at: state.phase_started_at,
    phase_elapsed_hours: parseFloat(elapsed.toFixed(1)),
    transitions: state.transitions.length,
    safe_executions: state.safe_executions,
    unsafe_auto_executions: state.unsafe_auto_executions,
    execution_summary: executionSummary,
    decisions,
    exit_passed: exitPassed,
    exit_reason: exitReason,
    executions,
    sf002: sf002Snapshot(),
    sf003: sf003Snapshot(),
    sf006: sf006Snapshot(),
    sf007: sf007Snapshot(),
    sf008: sf008Snapshot(),
    sf009: sf009Snapshot(),
    sf011: sf011Snapshot(),
    sf012: sf012Snapshot(),
    sf013_runtime_config: runtimeConfigSnapshot(),
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function formatReport(report: ValidationReport): string {
  const rows: string[] = [];

  rows.push("# Shadow Validation Report");
  rows.push("");
  rows.push(`**Generated:** ${report.generated_at}`);
  rows.push(`**Phase:** ${report.shadow_phase} (${report.phase_elapsed_hours}h elapsed)`);
  rows.push("");
  rows.push("## Exit Condition");
  rows.push("");
  rows.push(report.exit_reason);
  rows.push("");
  rows.push("## Summary");
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Shadow phase | ${report.shadow_phase} |`);
  rows.push(`| Phase started | ${report.phase_started_at} |`);
  rows.push(`| Elapsed hours | ${report.phase_elapsed_hours} |`);
  rows.push(`| Phase transitions | ${report.transitions} |`);
  rows.push(`| Safe executions | ${report.safe_executions} |`);
  rows.push(`| **Unsafe auto-executions** | **${report.unsafe_auto_executions}** |`);
  rows.push(`| Total executions | ${report.execution_summary.total} |`);
  rows.push(`| Implementation complete | ${report.execution_summary.implementation_complete} |`);
  rows.push(`| Delivery target reached | ${report.execution_summary.target_reached} |`);
  rows.push(`| Failed | ${report.execution_summary.failed} |`);
  rows.push(`| Dry-run | ${report.execution_summary.dry_run} |`);
  rows.push(`| In flight | ${report.execution_summary.in_flight} |`);
  rows.push("");

  if (Object.keys(report.decisions).length > 0) {
    rows.push("## Decision Gate Routing");
    rows.push("");
    rows.push("| Decision | Count |");
    rows.push("|----------|-------|");
    for (const [dec, count] of Object.entries(report.decisions)) {
      rows.push(`| ${dec} | ${count} |`);
    }
    rows.push("");
  }

  if (report.executions.length > 0) {
    rows.push("## Execution Log");
    rows.push("");
    rows.push("| ID | Ticket | Decision | Branch | Status |");
    rows.push("|----|--------|----------|--------|--------|");
    for (const e of report.executions) {
      rows.push(
        `| ${e.execution_id} | ${e.identifier} | ${e.gate_decision} | ${e.branch_name || "—"} | ${e.status} |`
      );
    }
    rows.push("");
  }

  rows.push("## SF-002 Approval Gate (shadow-parity)");
  rows.push("");
  rows.push(report.sf002.parity_reason);
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Ledger entries | ${report.sf002.ledger_entries} |`);
  rows.push(`| Exec records classified | ${report.sf002.exec_records_classified}/${report.sf002.exec_records_total} |`);
  rows.push(`| Active holds | ${report.sf002.holds_active} |`);
  rows.push(`| Acted verdicts | ${report.sf002.verdicts_acted} |`);
  rows.push(`| Operator verdicts resolved | ${report.sf002.resolved} |`);
  rows.push(`| Agreement rate | ${report.sf002.agreement_rate !== null ? `${(report.sf002.agreement_rate * 100).toFixed(1)}%` : "n/a"} |`);
  rows.push(`| Auto-lane | ${report.sf002.auto_lane_status} |`);
  rows.push("");

  rows.push("## SF-003 Coder-Agent Pool");
  rows.push("");
  const p = report.sf003;
  rows.push(
    p.pool_enabled
      ? `Pool ENABLED (mode: ${p.mode}) — logical pool: state, not processes.`
      : `Pool DISABLED (SF003_POOL off) — snapshot is read-only; no pool state created.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Queue depth (ready) | ${p.queue_depth_ready} |`);
  rows.push(`| In-flight (pool) | ${p.in_flight} |`);
  rows.push(`| In-flight (external) | ${p.external_in_flight} |`);
  rows.push(`| Capacity | ${p.capacity_used}/${p.global_cap} |`);
  rows.push(`| Parked items | ${p.parked.length} |`);
  rows.push(`| Retried items | ${p.retried_items} |`);
  rows.push(`| Failover dispatches | ${p.failover_dispatches} |`);
  rows.push(`| Registered workers | ${p.supervisor.workers.length} |`);
  rows.push(`| Active worker leases | ${p.supervisor.active_leases.length} |`);
  rows.push(`| Expired leases | ${p.supervisor.expired_leases} |`);
  rows.push(`| Worker checkpoints | ${p.supervisor.checkpoints} |`);
  rows.push(`| Dead letters | ${p.supervisor.dead_letters.length} |`);
  rows.push(`| Reconcile events | ${p.reconcile_events} |`);
  rows.push(`| Last reconcile | ${p.last_reconcile ?? "—"} |`);
  rows.push(`| Fleet separation | ${p.fleet_separation_ok ? "✅" : "❌"} ${p.fleet_separation_reason} |`);
  rows.push("");

  if (p.supervisor.active_leases.length > 0 || p.supervisor.dead_letters.length > 0) {
    rows.push("| Worker | Assignment | Lease expiry | State |");
    rows.push("|--------|------------|--------------|-------|");
    for (const lease of p.supervisor.active_leases) {
      rows.push(`| ${lease.worker_id} | ${lease.assignment_id} | ${lease.expires_at} | active |`);
    }
    for (const dead of p.supervisor.dead_letters) {
      rows.push(`| ${dead.worker_id} | ${dead.assignment_id} | ${dead.detected_at} | dead-letter (${dead.cleanup}) |`);
    }
    rows.push("");
  }

  if (p.campaigns.length > 0) {
    rows.push("| Campaign | Ticket | State | Done/Total | Failed | Parked | Cost |");
    rows.push("|----------|--------|-------|------------|--------|--------|------|");
    for (const c of p.campaigns) {
      rows.push(
        `| ${c.campaign_id} | ${c.identifier} | ${c.state} | ${c.tasks_done}/${c.tasks_total} | ${c.tasks_failed} | ${c.tasks_parked} | $${c.cost_spent_usd.toFixed(2)}/$${c.cost_ceiling_usd.toFixed(2)} |`
      );
    }
    rows.push("");
  }

  if (p.parked.length > 0) {
    rows.push("**Parked (with reason):**");
    rows.push("");
    for (const pk of p.parked) {
      rows.push(`- ${pk.campaign_id}/${pk.task_id} — ${pk.reason}`);
    }
    rows.push("");
  }

  rows.push("## SF-006 Intake Dedup + Idempotency");
  rows.push("");
  const d6 = report.sf006;
  rows.push(
    d6.dedup_enabled
      ? `Dedup gate ENABLED (${d6.enforce_enabled ? "ENFORCE — skips/resumes/parks take effect" : "shadow log-only — decisions computed, routing untouched"}).`
      : `Dedup gate DISABLED (SF006_DEDUP=0) — snapshot is read-only; no dedup state created.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Ledger rows | ${d6.ledger_rows} |`);
  rows.push(`| Tickets tracked | ${d6.ledger_tickets} |`);
  rows.push(`| Executions tracked | ${d6.ledger_executions} |`);
  rows.push(`| Distinct seed hashes | ${d6.ledger_seed_hashes} |`);
  rows.push(`| Torn lines tolerated | ${d6.ledger_torn_lines} |`);
  rows.push(`| Dedup decisions | ${d6.decisions_total} (proceed=${d6.decisions_by_type.proceed}, skip=${d6.decisions_by_type.skip_duplicate}, resume=${d6.decisions_by_type.resume_from_checkpoint}, park=${d6.decisions_by_type.park_verify_failed}) |`);
  rows.push(`| Shadow would-act | would-skip=${d6.shadow_would.would_skip}, would-resume=${d6.shadow_would.would_resume}, would-park=${d6.shadow_would.would_park} |`);
  rows.push(`| Enforced actions | skipped=${d6.enforced.skipped}, resumed=${d6.enforced.resumed}, parked=${d6.enforced.parked} |`);
  rows.push(`| Last decision | ${d6.last_decision ?? "—"} |`);
  rows.push("");

  rows.push("## SF-007 Multi-Source Signal Intake");
  rows.push("");
  const d7 = report.sf007;
  rows.push(
    d7.signals_enabled
      ? `Signal intake ENABLED, autofile rung **${d7.autofile_rung}** (${d7.autofile_rung === "off" ? "shadow — decisions logged, zero Linear writes" : "auto-filing active"}).`
      : `Signal intake DISABLED (SF007_SIGNALS=0) — snapshot is read-only; no signal state created.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Ledger rows | ${d7.ledger_rows} |`);
  rows.push(`| Distinct fingerprints | ${d7.ledger_fingerprints} |`);
  rows.push(`| Torn lines tolerated | ${d7.ledger_torn_lines} |`);
  rows.push(
    `| Signals by source | ${Object.entries(d7.signals_by_source).map(([s, n]) => `${s}=${n}`).join(", ") || "—"} |`
  );
  rows.push(
    `| Decisions | ${d7.decisions_total} (would_file=${d7.decisions_by_type.would_file}, filed=${d7.decisions_by_type.filed}, skip=${d7.decisions_by_type.skip_duplicate}, park_human=${d7.decisions_by_type.park_human_triage}, park_probe=${d7.decisions_by_type.park_probe_failed}, cooldown=${d7.decisions_by_type.cooldown_suppressed}) |`
  );
  rows.push(`| Would-file (shadow) vs filed (acted) | ${d7.would_file} / ${d7.filed_acted} |`);
  rows.push(`| Last decision | ${d7.last_decision ?? "—"} |`);
  rows.push("");

  rows.push("## SF-008 Fleet Campaigns");
  rows.push("");
  const d8 = report.sf008;
  rows.push(
    d8.fleet_enabled
      ? `Fleet lane ENABLED (compiler + rollup only — dispatch still requires the SF-003 pool lane).`
      : `Fleet lane DISABLED (SF008_FLEET=0) — snapshot is read-only; no fleet state created.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Fleets on disk | ${d8.fleets.length} |`);
  rows.push(
    `| Park rows (ledger, cumulative) | ${d8.park_rows} (${Object.entries(d8.parks_by_reason).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}) |`
  );
  rows.push(`| Audit rows | ${d8.audit_rows} |`);
  rows.push(`| Torn lines tolerated | parks=${d8.torn_park_lines}, audit=${d8.torn_audit_lines} |`);
  rows.push("");

  if (d8.fleets.length > 0) {
    rows.push("| Fleet | Repos | Enq | In-flight | Done | Failed | Parked(pool) | Parked(compile) | PRs claimed | Passed |");
    rows.push("|-------|-------|-----|-----------|------|--------|--------------|-----------------|-------------|--------|");
    for (const f of d8.fleets) {
      rows.push(
        `| ${f.fleet_id} | ${f.repos_total} | ${f.enqueued} | ${f.in_flight} | ${f.done} | ${f.failed} | ${f.parked_pool} | ${f.parked_compile} | ${f.prs_opened} | ${f.passed_postflight} |`
      );
    }
    rows.push("");
    rows.push(`_${ROLLUP_CAVEAT}_`);
    rows.push("");
  }

  if (d8.invalid.length > 0) {
    rows.push("**INVALID (corrupt fleet/pool files — tolerated, counted):**");
    rows.push("");
    for (const inv of d8.invalid) rows.push(`- ${inv}`);
    rows.push("");
  }

  rows.push("## SF-009 Scenario Verification");
  rows.push("");
  const d9 = report.sf009;
  rows.push(
    d9.scenarios_enabled
      ? `Scenario lane ENABLED (on-demand ephemeral runs — twin is loopback-only, never a real API).`
      : `Scenario lane DISABLED (SF009_SCENARIOS=0) — snapshot is read-only; no scenario state created.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(
    `| Runs (ledger, cumulative) | ${d9.runs_total} (${Object.entries(d9.by_verdict).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}) |`
  );
  rows.push(
    `| Last run | ${d9.last_run ? `${d9.last_run.scenario_id} → ${d9.last_run.verdict} @ ${d9.last_run.ts}` : "—"} |`
  );
  rows.push(`| Last twin transcript | ${d9.last_run?.twin_transcript_sha256?.slice(0, 12) ?? "—"} |`);
  rows.push(`| Torn lines tolerated | ${d9.torn_lines} |`);
  rows.push("");

  if (d9.invalid.length > 0) {
    rows.push("**INVALID (corrupt scenario ledger — tolerated, counted):**");
    rows.push("");
    for (const inv of d9.invalid) rows.push(`- ${inv}`);
    rows.push("");
  }

  rows.push("## SF-011 Assembly Lines");
  rows.push("");
  const d11 = report.sf011;
  rows.push(
    d11.flag_lines
      ? `Lines ENABLED (SF011_LINES=1${d11.flag_enforce ? ", ENFORCE=1 — lane skip + fail-closed active" : ", advisory — logs only"}).`
      : `Lines DISABLED (SF011_LINES off) — classification not running; snapshot is read-only.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Line config | ${d11.config_source}${d11.config_hash ? ` (${d11.config_hash})` : ""}${d11.config_error ? ` — INVALID: ${d11.config_error}` : ""} |`);
  rows.push(`| Stamped executions | ${d11.stamped_execs} / ${d11.total_execs} |`);
  rows.push(`| By line | ${Object.entries(d11.by_line).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} |`);
  rows.push(`| By source | ${Object.entries(d11.by_source).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} |`);
  rows.push(`| Declared-vs-inferred disagreements | ${d11.declared_vs_inferred_disagreements} |`);
  rows.push(`| Unreadable exec files (tolerated) | ${d11.unreadable_execs} |`);
  rows.push("");

  rows.push("## SF-012 Survivability & Decision Signals");
  rows.push("");
  const d12 = report.sf012;
  rows.push(
    d12.flag_survival
      ? `Survivability ENABLED (SF012_SURVIVAL=1${d12.flag_feedback ? ", FEEDBACK=1 — advisory blend logs" : ""}) — fate + signal harvest ride conveyor step 5h.`
      : `Survivability DISABLED (SF012_SURVIVAL off) — no probing; snapshot is read-only.`
  );
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Survivability config | ${d12.config_source}${d12.config_hash ? ` (${d12.config_hash})` : ""}${d12.config_error ? ` — INVALID: ${d12.config_error}` : ""} |`);
  rows.push(`| Probed PRs (distinct) | ${d12.distinct_prs}${d12.distinct_prs === 0 ? " — no merged agent PRs yet (honest empty)" : ""} |`);
  rows.push(`| By fate | ${Object.entries(d12.by_fate).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} |`);
  rows.push(`| Global min-sample met | ${d12.global_sufficient ? "yes" : `no (min_sample=${d12.min_sample ?? "?"}) — no rate renders`} |`);
  rows.push(`| Decision signals | ${d12.signals_total} (${Object.entries(d12.signals_by_source).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}) |`);
  rows.push(`| Torn lines (tolerated) | fates=${d12.fate_torn_lines} signals=${d12.signal_torn_lines} |`);
  rows.push("");

  rows.push("## FR-02 Runtime Configuration (ZOU-1111)");
  rows.push("");
  const cfg = report.sf013_runtime_config;
  rows.push(
    cfg.valid
      ? `Authoritative config VALID — v${cfg.version}, hash ${cfg.hash}, ${cfg.divergence_count} divergent flag(s) in this shell.`
      : cfg.present
        ? `Authoritative config INVALID — fail closed: ${cfg.errors.join("; ")}`
        : `Authoritative config MISSING (config/runtime-flags.json) — fail closed, no defaults.`
  );
  rows.push("");

  if (report.executions.filter((e) => e.error).length > 0) {
    rows.push("## Errors");
    rows.push("");
    for (const e of report.executions) {
      if (e.error) {
        rows.push(`- **${e.identifier}:** ${e.error}`);
      }
    }
    rows.push("");
  }

  return rows.join("\n");
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
shadow-validate — Generate shadow-validation report

USAGE:
  bun shadow-validate.ts                # Generate markdown report
  bun shadow-validate.ts --json         # Output JSON only
  bun shadow-validate.ts --help

Reads:
  state/shadow-state.json               # Shadow phase state
  state/exec-*.json                      # Individual execution records

Outputs:
  Markdown report to stdout (default) or JSON (--json).
  The report proves whether the exit condition (0 unsafe auto-executions) is met.
`);
    process.exit(0);
  }

  const report = generateReport();

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  // Exit 0 if validation passes, 1 if unsafe execs found
  process.exit(report.exit_passed ? 0 : 1);
}

main();
