#!/usr/bin/env bun
/**
 * T5 (SF-P3 / ZOU-435) — Hermetic selftest for learned auto-approval.
 *
 * No real ledger, no Linear, no network. Builds synthetic LedgerEntry fixtures and
 * exercises: distinct-ticket dedup (re-dispatch inflation), cold-start, below-rate,
 * earned; the conservative taint rule; the autoPromoteEligible integration (reputation
 * widens / narrows the baseline but never overrides the blast-radius ceiling); and an
 * end-to-end run of reputation-report.ts against a temp ledger file. Exit 0 = all green.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry, OperatorVerdict } from "./approval-ledger";
import type { RiskVerdict, RiskTier, ClassifierInputs, ReputationBaselineLike } from "./risk-classifier";
import { autoPromoteEligible } from "./risk-classifier";
import {
  computeReputation,
  reputationGate,
  reputationBaselineForVerdict,
} from "./reputation-core";

let failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
}

function makeInputs(archetype: string, over: Partial<ClassifierInputs> = {}): ClassifierInputs {
  return {
    archetype,
    target_repo: "zouroboros",
    repro: "",
    acceptance_criteria: "",
    gate_decision: "SWARM",
    files_touched_estimate: 4,
    schema_contact: false,
    secret_contact: false,
    infra_contact: false,
    reversibility: "easy",
    seed_eval_score: null,
    ...over,
  };
}

function entry(
  archetype: string,
  ticketId: string,
  operator: OperatorVerdict,
  tier: RiskTier = "medium",
  inputsOver: Partial<ClassifierInputs> = {}
): LedgerEntry {
  const verdict: RiskVerdict = {
    verdict_id: `rv-${Math.random().toString(36).slice(2)}`,
    execution_id: `exec-${Math.random().toString(36).slice(2, 10)}`,
    ticket_id: ticketId,
    identifier: ticketId,
    tier,
    score: 0.5,
    reasons: [],
    inputs: makeInputs(archetype, inputsOver),
    classified_at: new Date().toISOString(),
    mode: "shadow",
    acted: false,
  };
  return {
    verdict,
    operator_verdict: operator,
    harvested_at: operator === "pending" ? null : new Date().toISOString(),
    harvest_source: operator === "pending" ? null : "pr",
    agreement: operator === "pending" ? null : tier === "low" ? operator === "approved" : operator !== "approved",
    flags: { SF002_CLASSIFY: true, SF002_ENFORCE: false, SF002_AUTO_PROMOTE: false },
    appended_at: new Date().toISOString(),
  };
}

function toMap(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const m = new Map<string, LedgerEntry>();
  for (const e of entries) m.set(e.verdict.verdict_id, e);
  return m;
}

// ── 1. distinct-ticket dedup: 20 approved rows across 3 tickets → distinct=3 ──────
{
  const rows: LedgerEntry[] = [];
  for (let i = 0; i < 20; i++) rows.push(entry("feature", `T${i % 3}`, "approved")); // re-dispatch inflation
  const table = computeReputation(toMap(rows));
  const b = table.get("feature")!;
  check("dedup: raw resolved counts all rows", b.resolved === 20, `resolved=${b.resolved}`);
  check("dedup: distinct collapses to 3 tickets", b.distinct_tickets === 3, `distinct=${b.distinct_tickets}`);
  check("dedup: distinct_rate 1.0 (all approved)", b.distinct_rate === 1, `rate=${b.distinct_rate}`);
}

// ── 2. cold-start: 3 distinct tickets < min 8 → ineligible + cold_start ───────────
{
  const rows = [0, 1, 2].map((i) => entry("docs", `D${i}`, "approved"));
  const table = computeReputation(toMap(rows));
  const g = reputationGate("docs", table);
  check("cold-start: ineligible", !g.eligible);
  check("cold-start: flagged cold_start", g.cold_start, g.reasons[0]);
}

// ── 3. below-rate: 10 tickets, 6 approved / 4 rejected = 0.6 < 0.9 → ineligible ────
{
  const rows: LedgerEntry[] = [];
  for (let i = 0; i < 6; i++) rows.push(entry("refactor", `R${i}`, "approved"));
  for (let i = 6; i < 10; i++) rows.push(entry("refactor", `R${i}`, "rejected"));
  const table = computeReputation(toMap(rows));
  const g = reputationGate("refactor", table);
  check("below-rate: ineligible", !g.eligible);
  check("below-rate: not cold_start (enough sample)", !g.cold_start, `rate=${g.distinct_rate}`);
}

// ── 4. earned: 10 tickets all approved → eligible ─────────────────────────────────
{
  const rows = Array.from({ length: 10 }, (_, i) => entry("bugfix", `B${i}`, "approved"));
  const table = computeReputation(toMap(rows));
  const g = reputationGate("bugfix", table);
  check("earned: eligible", g.eligible, g.reasons[0]);
  check("earned: distinct 10 @ 1.0", g.distinct_tickets === 10 && g.distinct_rate === 1);
}

// ── 5. conservative taint: a ticket approved AND rejected counts as rejected ───────
{
  const rows = [
    entry("feature", "TX", "approved"),
    entry("feature", "TX", "rejected"), // same ticket, later re-dispatch rejected
    ...Array.from({ length: 9 }, (_, i) => entry("feature", `TY${i}`, "approved")),
  ];
  const table = computeReputation(toMap(rows));
  const b = table.get("feature")!;
  check("taint: TX counted as rejected", b.distinct_rejected === 1, `rej=${b.distinct_rejected}`);
  check("taint: distinct_rate excludes tainted ticket", b.distinct_rate === Number((9 / 10).toFixed(3)), `rate=${b.distinct_rate}`);
}

// ── 6. autoPromoteEligible integration ───────────────────────────────────────────
{
  const mediumVerdict: RiskVerdict = {
    verdict_id: "rv-x",
    execution_id: "exec-x",
    ticket_id: "T",
    identifier: "T",
    tier: "medium",
    score: 0.5,
    reasons: [],
    inputs: makeInputs("feature"),
    classified_at: new Date().toISOString(),
    mode: "enforce",
    acted: false,
  };
  const earned: ReputationBaselineLike = { eligible: true, source: "reputation", reasons: ["earned: 10/10 @ 1.0"] };
  const cold: ReputationBaselineLike = { eligible: false, source: "reputation", reasons: ["cold-start: 2/8"] };
  // ZOU-1110: inject a clean calibration fixture so these checks stay deterministic
  // (omitting it would read the live ledger and fail closed on real miscalibration).
  const cleanCalib = { eligible: true, reasons: [] };

  // omitted → byte-identical legacy: flat baseline 5/20 blocks
  check("legacy omitted: flat baseline 5<20 blocks", !autoPromoteEligible(mediumVerdict, 5, undefined, cleanCalib).eligible);
  check("legacy omitted: flat baseline 25≥20 eligible", autoPromoteEligible(mediumVerdict, 25, undefined, cleanCalib).eligible);
  // reputation widens: flat baseline 0 but reputation earned → eligible
  check("reputation widens: flat 0 + earned → eligible", autoPromoteEligible(mediumVerdict, 0, earned, cleanCalib).eligible);
  // reputation narrows: flat baseline 99 but reputation cold → blocked
  check("reputation narrows: flat 99 + cold → blocked", !autoPromoteEligible(mediumVerdict, 99, cold, cleanCalib).eligible);
  // ceiling wins: reputation earned but schema contact → blocked
  const schemaV = { ...mediumVerdict, inputs: makeInputs("feature", { schema_contact: true }) };
  check("ceiling wins: earned + schema contact → blocked", !autoPromoteEligible(schemaV, 0, earned, cleanCalib).eligible);
  // reputationBaselineForVerdict wires archetype lookup
  const table = computeReputation(toMap(Array.from({ length: 10 }, (_, i) => entry("feature", `Z${i}`, "approved"))));
  const bl = reputationBaselineForVerdict(mediumVerdict, table);
  check("baselineForVerdict: earned feature → eligible", bl.eligible && bl.archetype === "feature");
}

// ── 7. reputation-report.ts E2E against a temp ledger file ────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "zou435-"));
  try {
    const rows = Array.from({ length: 10 }, (_, i) => entry("feature", `RT${i}`, "approved"));
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "reputation-report.ts"), "--ledger", path, "--json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    check("report E2E: exit 0", proc.exitCode === 0, `exit=${proc.exitCode}`);
    check("report E2E: emits feature row", out.includes('"archetype": "feature"'));
    check("report E2E: feature gate eligible", /"eligible":\s*true/.test(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — reputation selftest (${failed} failing)`);
process.exit(failed === 0 ? 0 : 1);
