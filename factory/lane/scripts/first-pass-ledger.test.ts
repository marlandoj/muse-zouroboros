import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFirstPassLedger, computeFirstPassMetrics, parseFirstPassLedger } from "./first-pass-ledger";
import { compileValidationContract } from "./validation-contract";
import { createValidatorAuthority, createValidatorVerdict, type ValidatorVerdictValue } from "./validator-authority";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function verdict(cycle: number, value: ValidatorVerdictValue, commitCharacter: string, contractCharacter: string) {
  const contract = compileValidationContract({
    execution_id: "exec-1",
    ticket: "ZOU-1529",
    candidate_cycle_id: `exec-1:${cycle}`,
    compiled_at: `2026-08-28T16:0${cycle}:00Z`,
    seed_digest: digest("a"),
    criteria: [{ id: "AC-1", behavior: "Behavior is valid", evidence: [{ kind: "command", locator: "bun test" }] }],
    environment: {
      repository: "repo",
      base_commit_digest: digest("b"),
      harness: "validator",
      validator_version: "v1",
      required_env_names: [],
    },
  });
  if (!contract.ok) throw new Error(contract.errors.join("; "));
  const executor = { id: "builder", harness: "codex", model: "gpt" };
  const validator = { id: "validator", harness: "validator", model: "v1" };
  const authority = createValidatorAuthority({
    executor,
    validator,
    candidate_worktree: "/candidate",
    validator_worktree: "/validator",
    environment_digest: digest("c"),
    fresh_context: true,
    filesystem_read_only: true,
    detached_head: true,
  });
  if (!authority.ok) throw new Error(authority.errors.join("; "));
  const result = createValidatorVerdict({
    contract: contract.contract,
    authority: authority.authority,
    execution_id: "exec-1",
    candidate_cycle_id: `exec-1:${cycle}`,
    candidate_commit_digest: digest(commitCharacter),
    validation_contract_digest: contract.contract.contract_digest,
    validator_environment_digest: digest("c"),
    evidence_digest: digest(contractCharacter),
    validator,
    verdict: value,
    defect_classes: value === "flaky" ? ["flaky_test"] : value === "pass" ? [] : ["behavioral_regression"],
    reasons: value === "pass" ? [] : ["validation failed"],
    decided_at: `2026-08-28T16:1${cycle}:00Z`,
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.verdict;
}

function recordInput(cycle: number, value: ValidatorVerdictValue, prior: ReturnType<typeof appendFirstPassLedger>["row"] | null = null) {
  return {
    ticket: "ZOU-1529",
    verdict: verdict(cycle, value, cycle === 0 ? "d" : "e", cycle === 0 ? "f" : "9"),
    cycle_number: cycle,
    prior_cycle: prior,
    stratum: { archetype: "feature", repository: "zouroboros", harness: "codex", validator_version: "v1" },
    recorded_at: `2026-08-28T16:2${cycle}:00Z`,
  };
}

describe("first-pass ledger", () => {
  test("records cycle zero and a repaired candidate as an immutable new cycle", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-ledger-"));
    roots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    const first = appendFirstPassLedger(path, recordInput(0, "fail"));
    const repaired = appendFirstPassLedger(path, recordInput(1, "pass", first.row));
    expect(first.appended).toBeTrue();
    expect(repaired.appended).toBeTrue();
    expect(repaired.row.supersedes_cycle_id).toBe(first.row.candidate_cycle_id);
    const parsed = parseFirstPassLedger(readFileSync(path, "utf8"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(computeFirstPassMetrics(parsed.rows)).toMatchObject({
      executions: 1,
      validation_cycles: 2,
      first_pass_passes: 0,
      repaired_executions: 1,
      first_pass_yield: 0,
      rework_rate: 1,
    });
  });

  test("is idempotent for an exact repeated record", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-ledger-"));
    roots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    const input = recordInput(0, "pass");
    const first = appendFirstPassLedger(path, input);
    const second = appendFirstPassLedger(path, input);
    expect(first.appended).toBeTrue();
    expect(second.appended).toBeFalse();
    expect(second.duplicate).toBeTrue();
    expect(parseFirstPassLedger(readFileSync(path, "utf8")).rows).toHaveLength(1);
  });

  test("rejects repair without a new commit and contract", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-ledger-"));
    roots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    const first = appendFirstPassLedger(path, recordInput(0, "fail"));
    const next = recordInput(1, "pass", first.row);
    next.verdict = {
      ...next.verdict,
      candidate_commit_digest: first.row.candidate_commit_digest,
      validation_contract_digest: first.row.validation_contract_digest,
    };
    expect(() => appendFirstPassLedger(path, next)).toThrow("new candidate commit");
  });

  test("fails closed on torn or forged ledger history", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-ledger-"));
    roots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    const first = appendFirstPassLedger(path, recordInput(0, "pass"));
    const torn = `${readFileSync(path, "utf8")}{torn\n`;
    const parsed = parseFirstPassLedger(torn);
    expect(parsed.errors.some((error) => error.includes("malformed JSON"))).toBeTrue();
    expect(parsed.rows).toEqual([]);
    expect(computeFirstPassMetrics(parsed.rows).executions).toBe(0);
    writeFileSync(path, torn);
    expect(() => appendFirstPassLedger(path, recordInput(1, "pass", first.row))).toThrow("ledger is invalid");
  });

  test("rejects unknown fields and defect classes without returning pass evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-ledger-"));
    roots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    appendFirstPassLedger(path, recordInput(0, "pass"));
    const [line] = readFileSync(path, "utf8").trim().split("\n");
    const row = JSON.parse(line!) as Record<string, unknown>;
    row.untrusted = true;
    row.defect_classes = ["invented_defect"];
    const parsed = parseFirstPassLedger(`${JSON.stringify(row)}\n`);
    expect(parsed.errors.some((error) => error.includes("unknown field untrusted"))).toBeTrue();
    expect(parsed.errors.some((error) => error.includes("known defect classes"))).toBeTrue();
    expect(parsed.rows).toEqual([]);
  });

  test("flaky cycles are retained but never counted as first-pass passes", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-ledger-"));
    roots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    appendFirstPassLedger(path, recordInput(0, "flaky"));
    const parsed = parseFirstPassLedger(readFileSync(path, "utf8"));
    const metrics = computeFirstPassMetrics(parsed.rows);
    expect(metrics.flaky_cycles).toBe(1);
    expect(metrics.first_pass_yield).toBe(0);
    expect(metrics.defect_classes.flaky_test).toBe(1);
  });
});
