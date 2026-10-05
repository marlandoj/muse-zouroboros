#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FH-06 / ZOU-600 — Execution telemetry report (advisory CLI)
 *
 * Read-side, advisory-only. Assembles per-execution telemetry from artifacts
 * that already exist (exec-*.json lifecycle, verdict sidecars, pool campaign
 * spend, hold records) via the pure `execution-telemetry` core, then prints a
 * yield/cost/intervention rollup plus the 7/30-day survivability work list.
 *
 * Honesty (charter mandate): unknown cost/intervention are reported `null` and
 * named in each row's `unknowns[]` — never a fabricated zero. Cost is joined at
 * campaign granularity and attributed to a campaign exactly once. Operator
 * intervention is derived only from a released hold record; absent ⇒ unknown.
 *
 * Mutates nothing. Conveyor entry (`tick`) is a no-op unless FH06_TELEMETRY=1,
 * keeping factory behavior byte-identical when the flag is off.
 *
 * Usage:
 *   bun execution-telemetry-report.ts report [--json]
 *   bun execution-telemetry-report.ts tick        # no-op unless FH06_TELEMETRY=1
 *   bun execution-telemetry-report.ts --selftest
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  computeTelemetry,
  summarizeTelemetry,
  survivabilitySchedule,
  type ExecutionTelemetry,
  type TelemetryJoins,
  type TelemetryRecord,
} from "./execution-telemetry";
import { resolveVerdict, EVALUATIONS_DIR } from "./factory-verdict";
import { loadCampaigns, type Campaign } from "./pool-queue";
import { isExecutionRecordFileName } from "./execution-lifecycle";

const STATE_DIR = factoryStateRoot();

interface HoldRecordLite {
  held_at?: unknown;
  released_at?: unknown;
}

/** exec-*.json, torn-file tolerant — a bad file never aborts the report. */
function loadExecRecords(stateDir: string, warnings: string[]): TelemetryRecord[] {
  if (!existsSync(stateDir)) return [];
  const out: TelemetryRecord[] = [];
  for (const f of readdirSync(stateDir).sort()) {
    if (!isExecutionRecordFileName(f)) continue;
    try {
      const rec = JSON.parse(readFileSync(join(stateDir, f), "utf-8")) as TelemetryRecord;
      if (typeof rec.execution_id === "string" && rec.execution_id !== "") out.push(rec);
      else warnings.push(`skipped ${f}: missing execution_id`);
    } catch (e) {
      warnings.push(`skipped ${f}: malformed JSON (${(e as Error).message})`);
    }
  }
  return out;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/** Minutes a released hold sat awaiting operator action; null if none/unreleased. */
function interventionMinutes(stateDir: string, executionId: string): number | null {
  const path = join(stateDir, `hold-${executionId}.json`);
  if (!existsSync(path)) return null;
  try {
    const hold = JSON.parse(readFileSync(path, "utf-8")) as HoldRecordLite;
    const from = isoOrNull(hold.held_at);
    const to = isoOrNull(hold.released_at);
    if (from === null || to === null) return null;
    const mins = (Date.parse(to) - Date.parse(from)) / 60_000;
    return mins >= 0 ? Math.round(mins * 100) / 100 : null;
  } catch {
    return null;
  }
}

/**
 * Campaign spend attributed to one execution per campaign. A campaign's total
 * spend is honest only at campaign granularity, so it is claimed by the first
 * exec bearing its identifier and reported `null` for the rest (never split,
 * never double-counted). DIRECT/inline execs with no campaign ⇒ null.
 */
function buildCostJoin(execs: TelemetryRecord[]): (exec: TelemetryRecord) => number | null {
  let campaigns: Record<string, Campaign> = {};
  try {
    campaigns = loadCampaigns();
  } catch {
    campaigns = {};
  }
  const spendByIdentifier = new Map<string, number>();
  for (const c of Object.values(campaigns)) {
    if (typeof c.cost_spent_usd === "number" && c.cost_spent_usd > 0) {
      spendByIdentifier.set(c.identifier, c.cost_spent_usd);
    }
  }
  const claimed = new Set<string>();
  return (exec) => {
    const spend = spendByIdentifier.get(exec.identifier);
    if (spend === undefined || claimed.has(exec.identifier)) return null;
    claimed.add(exec.identifier);
    return spend;
  };
}

export interface TelemetryReport {
  telemetries: ExecutionTelemetry[];
  warnings: string[];
}

export function buildReport(
  stateDir: string = STATE_DIR,
  evaluationsDir: string = EVALUATIONS_DIR,
  now: string = new Date().toISOString(),
): TelemetryReport {
  const warnings: string[] = [];
  const execs = loadExecRecords(stateDir, warnings);
  const costFor = buildCostJoin(execs);

  const telemetries = execs.map((exec) => {
    const res = resolveVerdict({ executionId: exec.execution_id, ticket: exec.identifier }, evaluationsDir);
    const joins: TelemetryJoins = {
      verdict: res.measured ? { verdict: res.verdict.verdict, rework: res.verdict.rework } : null,
      model_cost_usd: costFor(exec),
      operator_intervention_minutes: interventionMinutes(stateDir, exec.execution_id),
    };
    return computeTelemetry(exec, joins, now);
  });

  return { telemetries, warnings };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function fmt(value: number | null, unit = ""): string {
  return value === null ? "—" : `${value}${unit}`;
}

function printReport(report: TelemetryReport, now: string): void {
  const { telemetries } = report;
  const summary = summarizeTelemetry(telemetries);
  const schedule = survivabilitySchedule(telemetries, now);

  console.log(`[fh06-telemetry] ${summary.total} execution(s)`);
  console.log(
    `  yield:        first-pass ${summary.first_pass_count}/${summary.measured} ` +
      `(rate ${summary.first_pass_rate === null ? "— (unmeasured)" : summary.first_pass_rate}), ` +
      `rework ${summary.rework_count}`,
  );
  console.log(
    `  cost:         total ${fmt(summary.cost_total_usd, " usd")} ` +
      `(known ${summary.cost_known}, unknown ${summary.cost_unknown})`,
  );
  console.log(
    `  intervention: total ${fmt(summary.intervention_total_minutes, " min")} ` +
      `(known ${summary.intervention_known}, unknown ${summary.intervention_unknown})`,
  );
  console.log(
    `  survivability: ${schedule.due.length} due, ${schedule.upcoming.length} upcoming, ` +
      `${schedule.not_applicable.length} not_applicable (${summary.survivability_overdue} overdue)`,
  );

  if (schedule.due.length > 0) {
    console.log(`  due survivability checks:`);
    for (const d of schedule.due) {
      console.log(`    ! ${d.identifier} (${d.execution_id}) ${d.window_days}d — due ${d.due_at}`);
    }
  }

  for (const t of telemetries) {
    const v = t.first_pass === null ? "unmeasured" : t.first_pass ? "first-pass" : t.rework ? "rework" : "fail";
    console.log(
      `  · ${t.identifier.padEnd(8)} ${t.execution_id.padEnd(16)} state=${t.state.padEnd(24)} ` +
        `cycle=${fmt(t.cycle_time_minutes, "m")} retries=${fmt(t.retry_count)} ` +
        `cost=${fmt(t.model_cost_usd)} interv=${fmt(t.operator_intervention_minutes)} ` +
        `${v} surviv=${t.survivability.status}`,
    );
    if (t.unknowns.length > 0) console.log(`      unknown: ${t.unknowns.join(", ")}`);
  }
  for (const w of report.warnings) console.error(`  ⚠ ${w}`);
}

// ─── Self-test (hermetic; proves honesty + scheduling invariants) ────────────

function selftest(): number {
  const now = "2026-07-13T00:00:00.000Z";
  const merged: TelemetryRecord = {
    execution_id: "exec-self0001",
    identifier: "ZOU-000",
    ticket_id: "issue-self",
    state: "merged",
    started_at: "2026-07-01T00:00:00.000Z",
    completed_at: "2026-07-01T01:00:00.000Z",
  } as TelemetryRecord;
  const failed: TelemetryRecord = {
    execution_id: "exec-self0002",
    identifier: "ZOU-001",
    ticket_id: "issue-self2",
    state: "failed",
    started_at: "2026-07-01T00:00:00.000Z",
    completed_at: null,
    error: "harness timeout",
  } as TelemetryRecord;

  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? "  ok  " : "  FAIL"} ${label}`);
    if (!cond) failures.push(label);
  };

  // 1) Honest nulls: no joins ⇒ cost/intervention unknown, never zero.
  const bare = computeTelemetry(merged, {}, now);
  check("unknown cost is null, not 0", bare.model_cost_usd === null);
  check("unknown intervention is null, not 0", bare.operator_intervention_minutes === null);
  check("unknowns names both", bare.unknowns.includes("model_cost_usd") && bare.unknowns.includes("operator_intervention_minutes"));

  // 2) Cycle time + first-pass derive from real fields.
  const measured = computeTelemetry(merged, { verdict: { verdict: "pass", rework: false } }, now);
  check("cycle time 60m", measured.cycle_time_minutes === 60);
  check("first-pass true", measured.first_pass === true);

  // 3) Survivability: merged schedules 7/30; unmerged is not_applicable.
  check("merged schedules two checks", measured.survivability.checks.length === 2);
  const failT = computeTelemetry(failed, {}, now);
  check("failed is not_applicable", failT.survivability.status === "not_applicable");
  check("not_applicable carries reason", failT.survivability.reason === "harness timeout");

  // 4) Schedule split + idempotent (recomputing yields identical work list).
  const s1 = survivabilitySchedule([measured, failT], now);
  const s2 = survivabilitySchedule([measured, failT], now);
  check("7-day check is due at NOW", s1.due.some((d) => d.window_days === 7 && d.overdue));
  check("30-day check is upcoming", s1.upcoming.some((d) => d.window_days === 30));
  check("one not_applicable", s1.not_applicable.length === 1);
  check("schedule is deterministic", JSON.stringify(s1) === JSON.stringify(s2));

  // 5) Rollup honesty: unmeasured-only ⇒ rate & totals null, never 0.
  const rollup = summarizeTelemetry([failT]);
  check("first_pass_rate null when unmeasured", rollup.first_pass_rate === null);
  check("cost_total_usd null when none known", rollup.cost_total_usd === null);

  const passed = failures.length === 0;
  console.log(`\n${passed ? "PASS" : "FAIL"} — ${17 - failures.length}/17 checks`);
  return passed ? 0 : 1;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--selftest" || cmd === "selftest") process.exit(selftest());

  switch (cmd) {
    case "report": {
      const now = new Date().toISOString();
      const report = buildReport(STATE_DIR, EVALUATIONS_DIR, now);
      if (rest.includes("--json")) {
        console.log(
          JSON.stringify(
            {
              summary: summarizeTelemetry(report.telemetries),
              schedule: survivabilitySchedule(report.telemetries, now),
              telemetries: report.telemetries,
              warnings: report.warnings,
            },
            null,
            2,
          ),
        );
      } else {
        printReport(report, now);
      }
      process.exit(0);
    }
    case "tick": {
      // Conveyor entry: flags-off byte-identical (no output, no reads).
      if (process.env.FH06_TELEMETRY !== "1") process.exit(0);
      printReport(buildReport(), new Date().toISOString());
      process.exit(0);
    }
    default:
      console.error("usage: execution-telemetry-report.ts report [--json] | tick | --selftest");
      process.exit(2);
  }
}
