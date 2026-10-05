import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoldoutFingerprint, finalizeHoldoutManifest, type HoldoutState } from "./heldout-cohort";
import { runFirstPassShadow, runFirstPassValidatorRuntime, type FirstPassCheckResult } from "./first-pass-shadow";
import { compileValidationContract } from "./validation-contract";
import { createValidatorAuthority } from "./validator-authority";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const heldoutText = "evaluator-only adversarial behavior proving the builder cannot see hidden validation fixtures before implementation completes";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): HoldoutState {
  return {
    manifest: finalizeHoldoutManifest([
      createHoldoutFingerprint({
        itemId: "heldout-zou-1529",
        version: "v1",
        plaintext: heldoutText,
        createdAt: "2026-08-01T00:00:00Z",
      }),
    ]),
    accessLedger: [],
  };
}

function setup() {
  const holdoutState = state();
  const contract = compileValidationContract({
    execution_id: "exec-1",
    ticket: "ZOU-1529",
    candidate_cycle_id: "exec-1:0",
    compiled_at: "2026-08-28T15:00:00Z",
    seed_digest: digest("a"),
    criteria: [
      { id: "AC-1", behavior: "Behavior passes", evidence: [{ kind: "command", locator: "bun test" }] },
      { id: "AC-2", behavior: "Held-out behavior passes", evidence: [{ kind: "heldout", locator: "heldout-zou-1529" }] },
    ],
    environment: {
      repository: "repo",
      base_commit_digest: digest("b"),
      harness: "validator",
      validator_version: "v1",
      required_env_names: ["CI"],
    },
    heldout_refs: [{ id: "heldout-zou-1529", digest: `sha256:${holdoutState.manifest.items[0]!.contentSha256}` }],
  });
  if (!contract.ok) throw new Error(contract.errors.join("; "));
  const authority = createValidatorAuthority({
    executor: { id: "builder", harness: "codex", model: "gpt" },
    validator: { id: "validator", harness: "validator", model: "v1" },
    candidate_worktree: "/candidate",
    validator_worktree: "/validator",
    environment_digest: digest("c"),
    fresh_context: true,
    filesystem_read_only: true,
    detached_head: true,
  });
  if (!authority.ok) throw new Error(authority.errors.join("; "));
  return { contract: contract.contract, authority: authority.authority, holdoutState };
}

function checks(): FirstPassCheckResult[] {
  return [
    { criterion_id: "AC-1", pass: true, flaky: false, evidence_digest: digest("d") },
    { criterion_id: "AC-2", pass: true, flaky: false, evidence_digest: digest("e") },
  ];
}

function candidateRepository(): { repository: string; commit: string } {
  const repository = mkdtempSync(join(tmpdir(), "first-pass-candidate-"));
  roots.push(repository);
  chmodSync(repository, 0o755);
  const git = (args: string[]) => spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  expect(git(["init", "-q"]).status).toBe(0);
  expect(git(["config", "user.email", "validator@example.invalid"]).status).toBe(0);
  expect(git(["config", "user.name", "Validator Fixture"]).status).toBe(0);
  writeFileSync(join(repository, "marker.txt"), "candidate\n");
  expect(git(["add", "marker.txt"]).status).toBe(0);
  expect(git(["commit", "-qm", "candidate"]).status).toBe(0);
  const head = git(["rev-parse", "HEAD"]);
  expect(head.status).toBe(0);
  return { repository, commit: head.stdout.trim() };
}

describe("first-pass shadow validator", () => {
  test("off is byte-independent of validation and never executes", () => {
    const fixture = setup();
    const result = runFirstPassShadow({
      mode: "off",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      authority: fixture.authority,
      candidate_commit_digest: digest("f"),
      checks: checks(),
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.executed).toBeFalse();
    expect(result.verdict).toBeNull();
    expect(result.holdout_state).toEqual(fixture.holdoutState);
  });

  test("passes complete exact evidence and audits evaluator-only held-out access", () => {
    const fixture = setup();
    const result = runFirstPassShadow({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      authority: fixture.authority,
      candidate_commit_digest: digest("f"),
      checks: checks(),
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.errors).toEqual([]);
    expect(result.verdict?.verdict).toBe("pass");
    expect(result.enforcement_active).toBeFalse();
    expect(result.holdout_state.accessLedger[0]).toMatchObject({ actor: "validator", purpose: "evaluate", decision: "allow" });
    expect(JSON.stringify(result)).not.toContain(heldoutText);
  });

  test("quarantines flaky results and never converts them to pass evidence", () => {
    const fixture = setup();
    const flaky = checks();
    flaky[1] = { ...flaky[1]!, pass: false, flaky: true, reason: "intermittent timing" };
    const result = runFirstPassShadow({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      authority: fixture.authority,
      candidate_commit_digest: digest("f"),
      checks: flaky,
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.verdict?.verdict).toBe("flaky");
    expect(result.verdict?.defect_classes).toContain("flaky_test");
  });

  test("holds missing criteria, forged contract digests, and stale candidate bindings", () => {
    const fixture = setup();
    const result = runFirstPassShadow({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: digest("9"),
      authority: fixture.authority,
      candidate_commit_digest: "stale-commit",
      checks: checks().slice(0, 1),
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.verdict).toBeNull();
    expect(result.errors.some((error) => error.includes("changed after dispatch"))).toBeTrue();
    expect(result.errors.some((error) => error.includes("candidate_commit_digest"))).toBeTrue();
    expect(result.errors.some((error) => error.includes("missing criterion AC-2"))).toBeTrue();
  });

  test("holds a leaked or mismatched held-out reference before evaluation", () => {
    const fixture = setup();
    const forgedContract = {
      ...fixture.contract,
      heldout_refs: [{ id: "heldout-zou-1529", digest: digest("9") }],
    };
    const result = runFirstPassShadow({
      mode: "shadow",
      contract: forgedContract,
      expected_contract_digest: fixture.contract.contract_digest,
      authority: fixture.authority,
      candidate_commit_digest: digest("f"),
      checks: checks(),
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.verdict).toBeNull();
    expect(result.errors.some((error) => error.includes("validation contract is invalid"))).toBeTrue();
    expect(result.holdout_state.accessLedger).toEqual([]);
  });

  test("rejects runtime-mutated validator authority before held-out access", () => {
    const fixture = setup();
    const result = runFirstPassShadow({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      authority: { ...fixture.authority, filesystem_read_only: false as true },
      candidate_commit_digest: digest("f"),
      checks: checks(),
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.verdict).toBeNull();
    expect(result.errors.some((error) => error.includes("filesystem_read_only"))).toBeTrue();
    expect(result.holdout_state.accessLedger).toEqual([]);
  });

  test("quarantines a contaminated held-out item and records the denied access", () => {
    const fixture = setup();
    const result = runFirstPassShadow({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      authority: fixture.authority,
      candidate_commit_digest: digest("f"),
      checks: checks(),
      holdout_state: fixture.holdoutState,
      contaminated_holdout_ids: ["heldout-zou-1529"],
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.verdict?.verdict).toBe("held");
    expect(result.verdict?.defect_classes).toContain("heldout_failure");
    expect(result.errors.some((error) => error.includes("rotation_required"))).toBeTrue();
    expect(result.holdout_state.accessLedger[0]).toMatchObject({ decision: "hold" });
  });

  test("runs validation in a detached non-root worktree and removes it afterward", () => {
    const fixture = setup();
    const candidate = candidateRepository();
    const runtimeRoot = mkdtempSync(join(tmpdir(), "first-pass-runtime-"));
    roots.push(runtimeRoot);
    const result = runFirstPassValidatorRuntime({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      candidate_repository: candidate.repository,
      candidate_commit_sha: candidate.commit,
      commands: [{ label: "marker", command: "/usr/bin/test", args: ["-f", "marker.txt"] }],
      executor: fixture.authority.executor,
      validator: fixture.authority.validator,
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
      runtime_root: runtimeRoot,
    });
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      expect(result.shadow.verdict).toBeNull();
      expect(result.shadow.errors).toContain("independent validator requires root to drop filesystem authority");
      return;
    }
    expect(result.shadow.verdict?.verdict).toBe("pass");
    expect(result.command_results).toMatchObject([{ label: "marker", pass: true }]);
    expect(result.cleanup_ok).toBeTrue();
    expect(result.validator_worktree).not.toBeNull();
    expect(existsSync(result.validator_worktree!)).toBeFalse();
  });

  test("a validator command cannot write into its detached candidate worktree", () => {
    const fixture = setup();
    const candidate = candidateRepository();
    const runtimeRoot = mkdtempSync(join(tmpdir(), "first-pass-runtime-"));
    roots.push(runtimeRoot);
    const result = runFirstPassValidatorRuntime({
      mode: "shadow",
      contract: fixture.contract,
      expected_contract_digest: fixture.contract.contract_digest,
      candidate_repository: candidate.repository,
      candidate_commit_sha: candidate.commit,
      commands: [{ label: "forbidden-write", command: "/usr/bin/touch", args: ["forbidden.txt"] }],
      executor: fixture.authority.executor,
      validator: fixture.authority.validator,
      holdout_state: fixture.holdoutState,
      decided_at: "2026-08-28T16:00:00Z",
      runtime_root: runtimeRoot,
    });
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    expect(result.command_results[0]?.pass).toBeFalse();
    expect(result.shadow.verdict?.verdict).toBe("fail");
    expect(result.shadow.verdict?.defect_classes).toContain("deterministic_test_failure");
    expect(existsSync(join(candidate.repository, "forbidden.txt"))).toBeFalse();
  });
});
