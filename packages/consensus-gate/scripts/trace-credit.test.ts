/**
 * Learned credit assignment — unit tests.
 *
 * Verifies: outcome capture (idempotent first-write-wins), the trace_id→outcome
 * join in computeReputationFrom, the cold-start fallback (λ=0 below
 * MIN_OUTCOME_SAMPLES), and the blended effective_weight when evidence accrues.
 *
 * Run: bun test packages/consensus-gate/scripts/trace-credit.test.ts
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { captureOutcome, readOutcomes, getOutcomesPath } from "../../../packages/zo-swarm-orchestrator/src/standalone/trace-outcome";
import { computeReputationFrom } from "./reputation";

let tmpHome: string;
let tmpOutcomes: string;
let tmpLog: string;

function gateEntry(id: string, traceId: string | null, models: Record<string, { pass: boolean; issues: string[] }>, status = "passed", consensusPass: boolean | null = true) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    consensus_id: id,
    trace_id: traceId,
    status,
    verdict: { pass: consensusPass, confidence: 0.9, models },
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "zbr-cred-"));
  // captureOutcome resolves HOME at call time → writes under tmpHome/.zouroboros/.
  tmpOutcomes = path.join(tmpHome, ".zouroboros", "trace-outcomes.jsonl");
  tmpLog = path.join(tmpHome, "consensus-gate.log");
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("captureOutcome is idempotent (first write wins)", () => {
  captureOutcome("trace-A", "success", "test");
  captureOutcome("trace-A", "failure", "test"); // replay — must NOT overwrite
  const m = readOutcomes();
  expect(m.get("trace-A")?.outcome).toBe("success");
  expect(m.size).toBe(1);
});

test("captureOutcome skips when traceId is undefined", () => {
  captureOutcome(undefined, "success", "test");
  expect(readOutcomes().size).toBe(0);
});

test("reputation is cold-start safe: no outcomes → effective_weight = local agreement", () => {
  // Two voters; claude-sonnet agrees, gpt-4o-mini dissents.
  fs.writeFileSync(tmpLog, gateEntry("cg-1", "trace-1", {
    "claude-sonnet": { pass: true, issues: [] },
    "gpt-4o-mini": { pass: false, issues: ["x"] },
  }) + "\n");
  // No outcomes file — no resolved traces.
  const rep = computeReputationFrom(tmpLog, tmpOutcomes);
  const cs = rep.voters["claude-sonnet"];
  const gm = rep.voters["gpt-4o-mini"];
  expect(cs.outcome_votes).toBe(0);
  expect(cs.outcome_credit).toBe(0);
  // λ=0 → effective_weight = agreement_rate * (1 - vendor_error_rate)
  expect(cs.effective_weight).toBeCloseTo(cs.agreement_rate * (1 - cs.vendor_error_rate), 5);
  expect(gm.effective_weight).toBeCloseTo(gm.agreement_rate * (1 - gm.vendor_error_rate), 5);
});

test("outcome_credit assigns blame correctly: dissent-then-failure is CREDITED", () => {
  // claude-sonnet says PASS, gpt-4o-mini says FAIL. Downstream outcome = failure.
  // So gpt-4o-mini (FAIL↔failure) is CORRECT; claude-sonnet (PASS↔failure) is WRONG.
  fs.writeFileSync(tmpLog, gateEntry("cg-1", "trace-1", {
    "claude-sonnet": { pass: true, issues: [] },
    "gpt-4o-mini": { pass: false, issues: ["x"] },
  }) + "\n");
  captureOutcome("trace-1", "failure", "test");
  const rep = computeReputationFrom(tmpLog, tmpOutcomes);
  expect(rep.voters["claude-sonnet"].outcome_credits).toBe(0); // wrong call
  expect(rep.voters["gpt-4o-mini"].outcome_credits).toBe(1);  // right call
  expect(rep.voters["claude-sonnet"].outcome_credit).toBe(0);
  expect(rep.voters["gpt-4o-mini"].outcome_credit).toBe(1);
});

test("cold-start ramp: below MIN_OUTCOME_SAMPLES, outcome_credit does not move effective_weight", () => {
  // 3 resolved traces, all PASS↔success for claude-sonnet → outcome_credit=1.0
  // but below MIN_OUTCOME_SAMPLES (10), so λ=0 and effective_weight stays local.
  let log = "";
  for (let i = 0; i < 3; i++) {
    log += gateEntry(`cg-${i}`, `trace-${i}`, { "claude-sonnet": { pass: true, issues: [] } }) + "\n";
    captureOutcome(`trace-${i}`, "success", "test");
  }
  fs.writeFileSync(tmpLog, log);
  const rep = computeReputationFrom(tmpLog, tmpOutcomes);
  const cs = rep.voters["claude-sonnet"];
  expect(cs.outcome_votes).toBe(3);
  expect(cs.outcome_credit).toBe(1.0);
  // λ=0 → effective_weight is pure local, NOT pulled toward outcome_credit (1.0)
  const local = cs.agreement_rate * (1 - cs.vendor_error_rate);
  expect(cs.effective_weight).toBeCloseTo(local, 5);
});

test("blended effective_weight: above MIN_OUTCOME_SAMPLES, outcome_credit pulls effective_weight", () => {
  // 12 traces; claude-sonnet always PASSES but outcomes are mostly FAILURE.
  // High agreement_rate (1.0) but low outcome_credit → effective_weight should
  // drop BELOW pure-local, demonstrating learned credit assignment.
  let log = "";
  for (let i = 0; i < 12; i++) {
    log += gateEntry(`cg-${i}`, `trace-${i}`, { "claude-sonnet": { pass: true, issues: [] } }) + "\n";
    // 10 failures, 2 successes → outcome_credit = 2/12 ≈ 0.167
    captureOutcome(`trace-${i}`, i < 10 ? "failure" : "success", "test");
  }
  fs.writeFileSync(tmpLog, log);
  const rep = computeReputationFrom(tmpLog, tmpOutcomes);
  const cs = rep.voters["claude-sonnet"];
  expect(cs.outcome_votes).toBe(12);
  expect(cs.outcome_credit).toBeCloseTo(2 / 12, 3);
  const local = cs.agreement_rate * (1 - cs.vendor_error_rate); // 1.0
  // λ = min(12/50,1)*0.5 = 0.12
  // effective_weight = 0.88*1.0 + 0.12*0.167 ≈ 0.90 (dropped from 1.0)
  expect(cs.effective_weight).toBeLessThan(local);
  expect(cs.effective_weight).toBeGreaterThan(0.85);
  expect(cs.effective_weight).toBeLessThan(0.95);
});

test("blended weight stays in [0,1] for extreme outcome_credit", () => {
  // 50 resolved traces (RAMP_TARGET) all PASS but all FAILURE → outcome_credit=0
  let log = "";
  for (let i = 0; i < 50; i++) {
    log += gateEntry(`cg-${i}`, `trace-${i}`, { "claude-sonnet": { pass: true, issues: [] } }) + "\n";
    captureOutcome(`trace-${i}`, "failure", "test");
  }
  fs.writeFileSync(tmpLog, log);
  const rep = computeReputationFrom(tmpLog, tmpOutcomes);
  const cs = rep.voters["claude-sonnet"];
  // λ = min(50/50,1)*0.5 = 0.5; local=1.0; outcome_credit=0
  // effective_weight = 0.5*1.0 + 0.5*0 = 0.5 (quarantine threshold)
  expect(cs.outcome_credit).toBe(0);
  expect(cs.effective_weight).toBeCloseTo(0.5, 3);
  expect(cs.effective_weight).toBeGreaterThanOrEqual(0);
  expect(cs.effective_weight).toBeLessThanOrEqual(1);
});
