#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T6 (SF-002) — Agreement-Baseline Report
 *
 * Reads the approval ledger, computes classifier-vs-operator agreement
 * (n, rate, per-tier breakdown, disagreement list), and enforces the
 * ≥20-decision gate: below threshold the report states AUTO-LANE BLOCKED.
 * The gate is a hard precondition for ever enabling SF002_AUTO_PROMOTE.
 *
 * Usage:
 *   bun agreement-baseline.ts                 # markdown report to stdout
 *   bun agreement-baseline.ts --write         # also write evaluations/agreement-baseline-<date>.md
 *   bun agreement-baseline.ts --json          # JSON report
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agreementStats, readLedger, type AgreementStats, type LedgerEntry } from "./approval-ledger";
import { isExecutionRecordFileName } from "./execution-lifecycle";

const ROOT = join(import.meta.dir, "..");
const STATE_DIR = factoryStateRoot();
const EVAL_DIR = join(ROOT, "evaluations");

export const AUTO_LANE_THRESHOLD = 20;

// ─── Report model ─────────────────────────────────────────────────────────────

export interface Disagreement {
  verdict_id: string;
  identifier: string;
  tier: string;
  score: number;
  operator_verdict: string;
  harvest_source: string | null;
  classified_at: string;
}

export interface BaselineReport {
  generated_at: string;
  stats: AgreementStats;
  auto_lane: { threshold: number; eligible: boolean; status: string };
  disagreements: Disagreement[];
}

export function buildBaseline(entries?: Map<string, LedgerEntry>): BaselineReport {
  const map = entries ?? readLedger();
  const stats = agreementStats(map);

  const disagreements: Disagreement[] = [];
  for (const e of map.values()) {
    if (e.agreement === false) {
      disagreements.push({
        verdict_id: e.verdict.verdict_id,
        identifier: e.verdict.identifier,
        tier: e.verdict.tier,
        score: e.verdict.score,
        operator_verdict: e.operator_verdict,
        harvest_source: e.harvest_source,
        classified_at: e.verdict.classified_at,
      });
    }
  }

  const eligible = stats.resolved >= AUTO_LANE_THRESHOLD;
  return {
    generated_at: new Date().toISOString(),
    stats,
    auto_lane: {
      threshold: AUTO_LANE_THRESHOLD,
      eligible,
      status: eligible
        ? `AUTO-LANE ELIGIBLE — ${stats.resolved} decisions baselined (≥${AUTO_LANE_THRESHOLD}); enabling remains an explicit operator action (SF002_AUTO_PROMOTE)`
        : `AUTO-LANE BLOCKED — ${stats.resolved}/${AUTO_LANE_THRESHOLD} classifier-vs-operator decisions baselined`,
    },
    disagreements,
  };
}

export function formatBaseline(r: BaselineReport): string {
  const rows: string[] = [];
  rows.push("# SF-002 Agreement Baseline");
  rows.push("");
  rows.push(`**Generated:** ${r.generated_at}`);
  rows.push("");
  rows.push(`## Auto-Lane Gate`);
  rows.push("");
  rows.push(`**${r.auto_lane.status}**`);
  rows.push("");
  rows.push("## Agreement");
  rows.push("");
  rows.push("| Metric | Value |");
  rows.push("|--------|-------|");
  rows.push(`| Ledger entries | ${r.stats.total} |`);
  rows.push(`| Resolved (operator verdict in) | ${r.stats.resolved} |`);
  rows.push(`| Distinct tickets resolved | ${r.stats.distinct_tickets_resolved} |`);
  rows.push(`| Pending | ${r.stats.pending} |`);
  rows.push(`| Excluded (explicit supersession) | ${r.stats.excluded} |`);
  rows.push(`| Agree | ${r.stats.agree} |`);
  rows.push(`| Agreement rate | ${r.stats.rate !== null ? `${(r.stats.rate * 100).toFixed(1)}%` : "n/a"} |`);
  rows.push("");
  rows.push("### Per-tier");
  rows.push("");
  rows.push("| Tier | Agree | Resolved |");
  rows.push("|------|-------|----------|");
  for (const tier of ["low", "medium", "high"] as const) {
    rows.push(`| ${tier} | ${r.stats.by_tier[tier].agree} | ${r.stats.by_tier[tier].n} |`);
  }
  rows.push("");
  if (r.disagreements.length > 0) {
    rows.push("## Disagreements");
    rows.push("");
    rows.push("| Verdict | Ticket | Tier | Score | Operator | Source | Classified |");
    rows.push("|---------|--------|------|-------|----------|--------|------------|");
    for (const d of r.disagreements) {
      rows.push(
        `| ${d.verdict_id} | ${d.identifier} | ${d.tier} | ${d.score} | ${d.operator_verdict} | ${d.harvest_source ?? "—"} | ${d.classified_at} |`
      );
    }
    rows.push("");
  }
  return rows.join("\n");
}

// ─── SF-002 snapshot for shadow-validate ──────────────────────────────────────

export interface SF002Snapshot {
  ledger_entries: number;
  resolved: number;
  agreement_rate: number | null;
  auto_lane_status: string;
  exec_records_total: number;
  exec_records_classified: number;
  holds_active: number;
  verdicts_acted: number;
  shadow_parity_ok: boolean;
  parity_reason: string;
}

export function sf002Snapshot(): SF002Snapshot {
  const baseline = buildBaseline();

  let execTotal = 0;
  let execClassified = 0;
  let holdsActive = 0;
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR)) {
      if (isExecutionRecordFileName(f)) {
        execTotal++;
        try {
          const rec = JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8"));
          if (rec.risk) execClassified++;
        } catch {
          // unreadable record — counted in total only
        }
      }
      if (f.startsWith("hold-") && f.endsWith(".json")) {
        try {
          const h = JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8"));
          if (h.released_at === null) holdsActive++;
        } catch {
          holdsActive++;
        }
      }
    }
  }

  let acted = 0;
  for (const e of readLedger().values()) {
    if (e.verdict.acted) acted++;
  }

  // Shadow-parity: every decision logged, none acted on.
  const parityOk = holdsActive === 0 && acted === 0;
  return {
    ledger_entries: baseline.stats.total,
    resolved: baseline.stats.resolved,
    agreement_rate: baseline.stats.rate,
    auto_lane_status: baseline.auto_lane.status,
    exec_records_total: execTotal,
    exec_records_classified: execClassified,
    holds_active: holdsActive,
    verdicts_acted: acted,
    shadow_parity_ok: parityOk,
    parity_reason: parityOk
      ? `✅ shadow-parity holding: ${baseline.stats.total} verdict(s) logged, 0 holds, 0 acted`
      : `❌ shadow-parity VIOLATED: ${holdsActive} active hold(s), ${acted} acted verdict(s)`,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    strict: false,
  });

  const report = buildBaseline();

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatBaseline(report));
  }

  if (values.write) {
    if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
    const path = join(EVAL_DIR, `agreement-baseline-${new Date().toISOString().slice(0, 10)}.md`);
    writeFileSync(path, formatBaseline(report) + "\n");
    console.error(`[baseline] written: ${path}`);
  }

  process.exit(0);
}

if (import.meta.main) main();
