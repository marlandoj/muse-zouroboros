import { describe, expect, test } from "bun:test";
import { compileValidationContract } from "./validation-contract";
import {
  createValidatorAuthority,
  createValidatorVerdict,
  sanitizedValidatorEnvironment,
  verdictCanAdvance,
} from "./validator-authority";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const executor = { id: "builder-1", harness: "codex", model: "gpt-5.6" };
const validator = { id: "validator-1", harness: "validator-runtime", model: "deterministic-v1" };

function contract() {
  const result = compileValidationContract({
    execution_id: "exec-1",
    ticket: "ZOU-1529",
    candidate_cycle_id: "exec-1:0",
    compiled_at: "2026-08-28T15:09:01Z",
    seed_digest: digest("a"),
    criteria: [{ id: "AC-1", behavior: "Validate behavior", evidence: [{ kind: "command", locator: "bun test" }] }],
    environment: {
      repository: "repo",
      base_commit_digest: digest("b"),
      harness: "validator-runtime",
      validator_version: "v1",
      required_env_names: ["CI"],
    },
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.contract;
}

function authority() {
  const result = createValidatorAuthority({
    executor,
    validator,
    candidate_worktree: "/work/candidate",
    validator_worktree: "/work/validator-detached",
    environment_digest: digest("c"),
    fresh_context: true,
    filesystem_read_only: true,
    detached_head: true,
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.authority;
}

describe("validator authority", () => {
  test("creates a fresh, detached, read-only authority with absent write credentials", () => {
    const result = createValidatorAuthority({
      executor,
      validator,
      candidate_worktree: "/work/candidate",
      validator_worktree: "/work/validator-detached",
      environment_digest: digest("c"),
      fresh_context: true,
      filesystem_read_only: true,
      detached_head: true,
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.authority.credential_policy).toEqual({ github: "absent", linear: "absent", git_write: "absent" });
    expect(result.authority.allowed_capabilities).not.toContain("candidate_repair");
  });

  test("rejects self-validation, shared worktrees, and any write capability", () => {
    const result = createValidatorAuthority({
      executor,
      validator: executor,
      candidate_worktree: "/work/shared",
      validator_worktree: "/work/shared",
      environment_digest: digest("c"),
      fresh_context: false,
      filesystem_read_only: false,
      detached_head: false,
      allowed_capabilities: ["read_candidate", "github_write"],
      credential_policy: { github: "present" as never },
    });
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("must differ from executor"))).toBeTrue();
    expect(result.errors.some((error) => error.includes("distinct fresh-context"))).toBeTrue();
    expect(result.errors.some((error) => error.includes("github_write"))).toBeTrue();
    expect(result.errors.some((error) => error.includes("must be absent"))).toBeTrue();
  });

  test("binds a pass verdict to exact contract, commit, environment, evidence, and validator", () => {
    const validationContract = contract();
    const validatorAuthority = authority();
    const result = createValidatorVerdict({
      contract: validationContract,
      authority: validatorAuthority,
      execution_id: validationContract.execution_id,
      candidate_cycle_id: validationContract.candidate_cycle_id,
      candidate_commit_digest: digest("d"),
      validation_contract_digest: validationContract.contract_digest,
      validator_environment_digest: validatorAuthority.environment_digest,
      evidence_digest: digest("e"),
      validator,
      verdict: "pass",
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(verdictCanAdvance(result.verdict)).toBeTrue();
  });

  test("holds mismatched bindings and never advances flaky evidence", () => {
    const validationContract = contract();
    const validatorAuthority = authority();
    const mismatched = createValidatorVerdict({
      contract: validationContract,
      authority: validatorAuthority,
      execution_id: validationContract.execution_id,
      candidate_cycle_id: "exec-1:1",
      candidate_commit_digest: digest("d"),
      validation_contract_digest: digest("f"),
      validator_environment_digest: digest("9"),
      evidence_digest: digest("e"),
      validator: executor,
      verdict: "flaky",
      defect_classes: ["flaky_test"],
      reasons: ["nondeterministic suite"],
      decided_at: "2026-08-28T16:00:00Z",
    });
    expect(mismatched.ok).toBeFalse();
    expect(verdictCanAdvance(mismatched.ok ? mismatched.verdict : null)).toBeFalse();
  });

  test("strips credentials even when an allowlist accidentally names them", () => {
    const sanitized = sanitizedValidatorEnvironment({
      CI: "1",
      PATH: "/usr/bin",
      LINEAR_API_KEY: "sensitive",
      GITHUB_TOKEN: "sensitive",
      OTHER_SECRET: "sensitive",
    }, ["CI", "PATH", "LINEAR_API_KEY", "GITHUB_TOKEN", "OTHER_SECRET"]);
    expect(sanitized).toEqual({ CI: "1", PATH: "/usr/bin" });
  });
});
