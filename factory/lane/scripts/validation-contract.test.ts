import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidationContractFrozen,
  compileValidationContract,
  criteriaFromAcceptanceText,
  parseValidationContract,
  persistValidationContract,
  serializeValidationContract,
  type CompileValidationContractInput,
} from "./validation-contract";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function input(): CompileValidationContractInput {
  return {
    execution_id: "exec-zou-1529",
    ticket: "ZOU-1529",
    candidate_cycle_id: "exec-zou-1529:0",
    compiled_at: "2026-08-28T15:09:01.000Z",
    seed_digest: digest("a"),
    criteria: [
      {
        id: "AC-2",
        behavior: "A repaired candidate creates a new validation cycle.",
        evidence: [
          { kind: "artifact", locator: "state/first-pass-ledger.jsonl" },
          { kind: "command", locator: "bun test scripts/first-pass-ledger.test.ts" },
        ],
      },
      {
        id: "AC-1",
        behavior: "The validator cannot mutate the candidate worktree.",
        evidence: [{ kind: "invariant", locator: "validator-authority:no-write-capabilities" }],
      },
    ],
    environment: {
      repository: "marlandoj/zouroboros-workspace",
      base_commit_digest: digest("b"),
      harness: "codex",
      validator_version: "first-pass-validator-v1",
      required_env_names: ["CI", "BUN_VERSION", "CI"],
    },
    heldout_refs: [{ id: "typescript-boundary", digest: digest("c") }],
  };
}

describe("validation contract", () => {
  test("compiles acceptance behaviors against repository-bound commands", () => {
    const criteria = criteriaFromAcceptanceText(
      "- preserves difficult archetypes\n2. rejects forged evidence",
      [{ label: "focused", command: "bun", args: ["test", "focused.test.ts"] }],
    );
    expect(criteria.map((criterion) => criterion.behavior)).toEqual([
      "preserves difficult archetypes",
      "rejects forged evidence",
    ]);
    expect(criteria[0]?.evidence[0]?.locator).toContain("focused.test.ts");
  });

  test("freezes a contract once and rejects a different digest at the same path", () => {
    const root = mkdtempSync(join(tmpdir(), "validation-contract-"));
    try {
      const compiled = compileValidationContract(input());
      if (!compiled.ok) throw new Error(compiled.errors.join("; "));
      const path = join(root, "contract.json");
      expect(persistValidationContract(path, compiled.contract)).toMatchObject({ created: true });
      expect(persistValidationContract(path, compiled.contract)).toMatchObject({ created: false });
      expect(parseValidationContract(JSON.parse(readFileSync(path, "utf8"))).ok).toBeTrue();
      expect(() => persistValidationContract(path, { ...compiled.contract, execution_id: "different" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compiles deterministic criteria, environment, and held-out references", () => {
    const first = compileValidationContract(input());
    const reordered = input();
    reordered.criteria = [...(reordered.criteria as unknown[])].reverse();
    reordered.heldout_refs = [...(reordered.heldout_refs as unknown[])].reverse();
    const second = compileValidationContract(reordered);
    expect(first.ok).toBeTrue();
    expect(second.ok).toBeTrue();
    if (!first.ok || !second.ok) return;
    expect(first.contract.criteria.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-2"]);
    expect(first.contract.environment.required_env_names).toEqual(["BUN_VERSION", "CI"]);
    expect(first.contract.contract_digest).toBe(second.contract.contract_digest);
    expect(serializeValidationContract(first.contract)).toBe(serializeValidationContract(second.contract));
  });

  test("fails closed when a criterion has no behavioral evidence", () => {
    const invalid = input();
    invalid.criteria = [{ id: "AC-1", behavior: "It should work", evidence: [] }];
    const result = compileValidationContract(invalid);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("at least one evidence locator"))).toBeTrue();
  });

  test("rejects unknown fields and duplicate criterion identifiers", () => {
    const invalid = input();
    invalid.criteria = [
      { id: "AC-1", behavior: "First", evidence: [{ kind: "command", locator: "one" }] },
      { id: "AC-1", behavior: "Second", evidence: [{ kind: "command", locator: "two" }], surprise: true },
    ];
    const result = compileValidationContract(invalid);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.errors).toContain("contract.criteria[1].surprise: unknown field");
    expect(result.errors.some((error) => error.includes("duplicate criterion id AC-1"))).toBeTrue();
  });

  test("detects any mutation after dispatch", () => {
    const result = compileValidationContract(input());
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    const mutated = {
      ...result.contract,
      criteria: result.contract.criteria.map((criterion, index) => index === 0
        ? { ...criterion, behavior: "A builder changed the criterion after dispatch." }
        : criterion),
    };
    const parsed = parseValidationContract(mutated);
    expect(parsed.ok).toBeFalse();
    expect(() => assertValidationContractFrozen(mutated, result.contract.contract_digest)).toThrow();
  });

  test("rejects invalid digests, timestamps, and held-out contents", () => {
    const invalid = input();
    invalid.compiled_at = "not-a-time";
    invalid.seed_digest = "abc";
    invalid.heldout_refs = [{ id: "secret", digest: "not-a-digest", suite_contents: "leak" }];
    const result = compileValidationContract(invalid);
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("ISO-8601"))).toBeTrue();
    expect(result.errors.some((error) => error.includes("sha256:<64 lowercase hex>"))).toBeTrue();
    expect(result.errors).toContain("contract.heldout_refs[0].suite_contents: unknown field");
  });
});
