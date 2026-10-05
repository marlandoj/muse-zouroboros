import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordHoldoutAccess, type HoldoutState } from "./heldout-cohort";
import { assertValidationContractFrozen, type ValidationContract } from "./validation-contract";
import type { CascadeValidationCommand } from "./coding-cascade";
import type { OutcomeActor } from "./outcome-envelope";
import { commitDigest } from "./outcome-evidence-emission";
import {
  createValidatorAuthority,
  createValidatorVerdict,
  sanitizedValidatorEnvironment,
  type ValidatorAuthority,
  type ValidatorDefectClass,
  type ValidatorVerdict,
} from "./validator-authority";

export const FIRST_PASS_VALIDATION_MODES = ["off", "shadow"] as const;
export type FirstPassValidationMode = (typeof FIRST_PASS_VALIDATION_MODES)[number];

export interface FirstPassCheckResult {
  criterion_id: string;
  pass: boolean;
  flaky: boolean;
  evidence_digest: string;
  defect_class?: ValidatorDefectClass;
  reason?: string;
}

export interface FirstPassShadowInput {
  mode: FirstPassValidationMode;
  contract: ValidationContract;
  expected_contract_digest: string;
  authority: ValidatorAuthority;
  candidate_commit_digest: string;
  checks: FirstPassCheckResult[];
  holdout_state: HoldoutState;
  contaminated_holdout_ids?: string[];
  decided_at: string;
}

export interface FirstPassShadowResult {
  mode: FirstPassValidationMode;
  executed: boolean;
  enforcement_active: false;
  verdict: ValidatorVerdict | null;
  holdout_state: HoldoutState;
  errors: string[];
}

export interface FirstPassRuntimeInput {
  mode: FirstPassValidationMode;
  contract: ValidationContract;
  expected_contract_digest: string;
  candidate_repository: string;
  candidate_commit_sha: string;
  commands: CascadeValidationCommand[];
  executor: OutcomeActor;
  validator: OutcomeActor;
  holdout_state: HoldoutState;
  contaminated_holdout_ids?: string[];
  decided_at: string;
  runtime_root: string;
  environment?: Record<string, string | undefined>;
}

export interface FirstPassRuntimeCommandResult {
  label: string;
  status: number | null;
  pass: boolean;
  timed_out: boolean;
  evidence_digest: string;
}

export interface FirstPassRuntimeResult {
  shadow: FirstPassShadowResult;
  command_results: FirstPassRuntimeCommandResult[];
  validator_worktree: string | null;
  cleanup_ok: boolean;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

export function resolveFirstPassValidationMode(
  env: Record<string, string | undefined> = process.env,
): FirstPassValidationMode {
  const value = env.FIRST_PASS_VALIDATION_MODE ?? "off";
  if (!(FIRST_PASS_VALIDATION_MODES as readonly string[]).includes(value)) {
    throw new Error(`FIRST_PASS_VALIDATION_MODE must be off|shadow, got ${value}`);
  }
  return value as FirstPassValidationMode;
}

function classifyChecks(contract: ValidationContract, checks: readonly FirstPassCheckResult[]): {
  verdict: ValidatorVerdict["verdict"];
  defectClasses: ValidatorDefectClass[];
  reasons: string[];
  errors: string[];
} {
  const errors: string[] = [];
  const expected = new Set(contract.criteria.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const defectClasses: ValidatorDefectClass[] = [];
  const reasons: string[] = [];
  for (const [index, check] of checks.entries()) {
    if (!expected.has(check.criterion_id)) errors.push(`checks[${index}]: unknown criterion ${check.criterion_id}`);
    if (seen.has(check.criterion_id)) errors.push(`checks[${index}]: duplicate criterion ${check.criterion_id}`);
    seen.add(check.criterion_id);
    if (!SHA256_PATTERN.test(check.evidence_digest)) errors.push(`checks[${index}].evidence_digest: invalid digest`);
    if (!check.pass || check.flaky) {
      if (!check.reason?.trim()) errors.push(`checks[${index}].reason: required for non-pass result`);
      else reasons.push(check.reason.trim());
      defectClasses.push(check.flaky ? "flaky_test" : check.defect_class ?? "behavioral_regression");
    }
  }
  for (const criterionId of expected) if (!seen.has(criterionId)) errors.push(`checks: missing criterion ${criterionId}`);
  if (errors.length > 0) return { verdict: "held", defectClasses: ["evidence_invalid"], reasons: errors, errors };
  if (checks.some((check) => check.flaky)) return { verdict: "flaky", defectClasses: [...new Set(defectClasses)], reasons: [...new Set(reasons)], errors };
  if (checks.some((check) => !check.pass)) return { verdict: "fail", defectClasses: [...new Set(defectClasses)], reasons: [...new Set(reasons)], errors };
  return { verdict: "pass", defectClasses: [], reasons: [], errors };
}

function authorizeHeldouts(
  contract: ValidationContract,
  initial: HoldoutState,
  actor: string,
  decidedAt: string,
  contaminatedHoldoutIds: readonly string[],
): { state: HoldoutState; errors: string[] } {
  let state = structuredClone(initial);
  const errors: string[] = [];
  const contaminated = new Set(contaminatedHoldoutIds);
  const referenced = new Set(contract.heldout_refs.map((reference) => reference.id));
  for (const id of contaminated) if (!referenced.has(id)) errors.push(`contaminated holdout ${id}: not referenced by contract`);
  for (const reference of contract.heldout_refs) {
    const item = state.manifest.items.find((candidate) => candidate.itemId === reference.id);
    if (!item) {
      errors.push(`heldout ${reference.id}: not found`);
      continue;
    }
    if (`sha256:${item.contentSha256}` !== reference.digest) {
      errors.push(`heldout ${reference.id}: contract digest mismatch`);
      continue;
    }
    const accessed = recordHoldoutAccess(state, {
      itemId: reference.id,
      actor,
      purpose: "evaluate",
      ts: decidedAt,
      contaminationSignal: contaminated.has(reference.id),
    });
    state = { manifest: accessed.manifest, accessLedger: accessed.accessLedger };
    if (accessed.decision !== "allow") errors.push(`heldout ${reference.id}: ${accessed.reasons.join("; ")}`);
  }
  return { state, errors };
}

export function runFirstPassShadow(input: FirstPassShadowInput): FirstPassShadowResult {
  if (input.mode === "off") {
    return {
      mode: "off",
      executed: false,
      enforcement_active: false,
      verdict: null,
      holdout_state: structuredClone(input.holdout_state),
      errors: [],
    };
  }
  const errors: string[] = [];
  let contractFrozen = true;
  try {
    assertValidationContractFrozen(input.contract, input.expected_contract_digest);
  } catch (error) {
    errors.push((error as Error).message);
    contractFrozen = false;
  }
  const candidateDigestValid = SHA256_PATTERN.test(input.candidate_commit_digest);
  if (!candidateDigestValid) errors.push("candidate_commit_digest: invalid digest");
  const decidedAtValid = Number.isFinite(Date.parse(input.decided_at));
  if (!decidedAtValid) errors.push("decided_at: must be an ISO-8601 timestamp");
  const authority = createValidatorAuthority({
    executor: input.authority.executor,
    validator: input.authority.validator,
    candidate_worktree: input.authority.candidate_worktree,
    validator_worktree: input.authority.validator_worktree,
    environment_digest: input.authority.environment_digest,
    fresh_context: input.authority.fresh_context,
    filesystem_read_only: input.authority.filesystem_read_only,
    detached_head: input.authority.detached_head,
    allowed_capabilities: input.authority.allowed_capabilities,
    credential_policy: input.authority.credential_policy,
  });
  if (!authority.ok) errors.push(...authority.errors);
  const mayAccessHeldouts = contractFrozen && candidateDigestValid && decidedAtValid && authority.ok;
  const heldouts = mayAccessHeldouts
    ? authorizeHeldouts(
      input.contract,
      input.holdout_state,
      input.authority.validator.id,
      input.decided_at,
      input.contaminated_holdout_ids ?? [],
    )
    : { state: structuredClone(input.holdout_state), errors: [] };
  errors.push(...heldouts.errors);
  const classified = classifyChecks(input.contract, input.checks);
  errors.push(...classified.errors);
  const verdictValue: ValidatorVerdict["verdict"] = errors.length > 0 ? "held" : classified.verdict;
  const boundaryDefects: ValidatorDefectClass[] = [];
  if (!contractFrozen || !candidateDigestValid || !decidedAtValid || classified.errors.length > 0) boundaryDefects.push("evidence_invalid");
  if (!authority.ok) boundaryDefects.push("authority_violation");
  if (heldouts.errors.length > 0) boundaryDefects.push("heldout_failure");
  const defectClasses: ValidatorDefectClass[] = errors.length > 0
    ? [...new Set<ValidatorDefectClass>([...classified.defectClasses, ...boundaryDefects])]
    : classified.defectClasses;
  const reasons = errors.length > 0 ? [...new Set([...classified.reasons, ...errors])] : classified.reasons;
  const evidenceDigest = digest({
    contract_digest: input.contract.contract_digest,
    candidate_commit_digest: input.candidate_commit_digest,
    validator_environment_digest: input.authority.environment_digest,
    checks: [...input.checks].sort((left, right) => left.criterion_id.localeCompare(right.criterion_id)),
    holdout_manifest_hash: heldouts.state.manifest.manifestHash,
    holdout_access_hash: heldouts.state.accessLedger.at(-1)?.recordHash ?? null,
  });
  const verdict = createValidatorVerdict({
    contract: input.contract,
    authority: input.authority,
    execution_id: input.contract.execution_id,
    candidate_cycle_id: input.contract.candidate_cycle_id,
    candidate_commit_digest: input.candidate_commit_digest,
    validation_contract_digest: input.contract.contract_digest,
    validator_environment_digest: input.authority.environment_digest,
    evidence_digest: evidenceDigest,
    validator: input.authority.validator,
    verdict: verdictValue,
    defect_classes: defectClasses,
    reasons,
    decided_at: input.decided_at,
  });
  if (!verdict.ok) errors.push(...verdict.errors);
  return {
    mode: "shadow",
    executed: true,
    enforcement_active: false,
    verdict: verdict.ok ? verdict.verdict : null,
    holdout_state: heldouts.state,
    errors: [...new Set(errors)],
  };
}

function failedRuntimeResult(
  input: FirstPassRuntimeInput,
  error: string,
  validatorWorktree: string | null = null,
  cleanupOk = true,
): FirstPassRuntimeResult {
  return {
    shadow: {
      mode: input.mode,
      executed: input.mode !== "off",
      enforcement_active: false,
      verdict: null,
      holdout_state: structuredClone(input.holdout_state),
      errors: [error],
    },
    command_results: [],
    validator_worktree: validatorWorktree,
    cleanup_ok: cleanupOk,
  };
}

export function runFirstPassValidatorRuntime(input: FirstPassRuntimeInput): FirstPassRuntimeResult {
  if (input.mode === "off") {
    return {
      shadow: runFirstPassShadow({
        mode: "off",
        contract: input.contract,
        expected_contract_digest: input.expected_contract_digest,
        authority: {} as ValidatorAuthority,
        candidate_commit_digest: "",
        checks: [],
        holdout_state: input.holdout_state,
        decided_at: input.decided_at,
      }),
      command_results: [],
      validator_worktree: null,
      cleanup_ok: true,
    };
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return failedRuntimeResult(input, "independent validator requires root to drop filesystem authority");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.candidate_commit_sha)) {
    return failedRuntimeResult(input, "candidate_commit_sha must be a full commit SHA");
  }
  if (input.commands.length === 0) return failedRuntimeResult(input, "validator commands are missing");
  mkdirSync(input.runtime_root, { recursive: true, mode: 0o755 });
  chmodSync(input.runtime_root, 0o755);
  const runtimeParent = mkdtempSync(join(input.runtime_root, "validator-"));
  chmodSync(runtimeParent, 0o755);
  const validatorWorktree = join(runtimeParent, "worktree");
  const scratch = join(runtimeParent, "scratch");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  chownSync(scratch, 65534, 65534);
  let worktreeCreated = false;
  let cleanupOk = true;
  let outcome: FirstPassRuntimeResult | null = null;
  try {
    const added = spawnSync("git", ["worktree", "add", "--detach", validatorWorktree, input.candidate_commit_sha], {
      cwd: input.candidate_repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (added.status !== 0) {
      outcome = failedRuntimeResult(input, `validator worktree creation failed: ${(added.stderr || added.stdout).trim()}`, validatorWorktree);
      return outcome;
    }
    worktreeCreated = true;
    const head = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: validatorWorktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (head.status !== 0 || head.stdout.trim().toLowerCase() !== input.candidate_commit_sha.toLowerCase()) {
      outcome = failedRuntimeResult(input, "validator worktree does not bind the requested candidate commit", validatorWorktree);
      return outcome;
    }
    const allowed = sanitizedValidatorEnvironment(input.environment ?? process.env, input.contract.environment.required_env_names);
    const environment = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: scratch,
      TMPDIR: scratch,
      CI: "1",
      ...allowed,
    };
    const environmentDigest = digest(environment);
    const authority = createValidatorAuthority({
      executor: input.executor,
      validator: input.validator,
      candidate_worktree: input.candidate_repository,
      validator_worktree: validatorWorktree,
      environment_digest: environmentDigest,
      fresh_context: true,
      filesystem_read_only: true,
      detached_head: true,
    });
    if (!authority.ok) {
      outcome = failedRuntimeResult(input, authority.errors.join("; "), validatorWorktree);
      return outcome;
    }
    const commandResults: FirstPassRuntimeCommandResult[] = input.commands.map((command) => {
      const result = spawnSync("/usr/bin/setpriv", [
        "--reuid=65534",
        "--regid=65534",
        "--clear-groups",
        "--no-new-privs",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        command.command,
        ...command.args,
      ], {
        cwd: validatorWorktree,
        encoding: "utf8",
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: command.timeout_ms ?? 300_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const timedOut = result.error?.name === "ETIMEDOUT";
      const evidenceDigest = digest({
        label: command.label,
        command: command.command,
        args: command.args,
        status: result.status,
        signal: result.signal,
        timed_out: timedOut,
        stdout_digest: digest(result.stdout ?? ""),
        stderr_digest: digest(result.stderr ?? ""),
      });
      return {
        label: command.label,
        status: result.status,
        pass: result.status === 0 && !result.error,
        timed_out: timedOut,
        evidence_digest: evidenceDigest,
      };
    });
    const pass = commandResults.every((result) => result.pass);
    const aggregateEvidence = digest(commandResults);
    const reason = pass
      ? undefined
      : commandResults.filter((result) => !result.pass)
        .map((result) => `${result.label} failed (${result.timed_out ? "timeout" : `exit ${result.status ?? "spawn-error"}`})`)
        .join("; ");
    const checks: FirstPassCheckResult[] = input.contract.criteria.map((criterion) => ({
      criterion_id: criterion.id,
      pass,
      flaky: false,
      evidence_digest: aggregateEvidence,
      ...(pass ? {} : { defect_class: "deterministic_test_failure" as const, reason }),
    }));
    const shadow = runFirstPassShadow({
      mode: input.mode,
      contract: input.contract,
      expected_contract_digest: input.expected_contract_digest,
      authority: authority.authority,
      candidate_commit_digest: commitDigest(input.candidate_commit_sha),
      checks,
      holdout_state: input.holdout_state,
      contaminated_holdout_ids: input.contaminated_holdout_ids,
      decided_at: input.decided_at,
    });
    outcome = { shadow, command_results: commandResults, validator_worktree: validatorWorktree, cleanup_ok: true };
    return outcome;
  } finally {
    if (worktreeCreated) {
      const removed = spawnSync("git", ["worktree", "remove", "--force", validatorWorktree], {
        cwd: input.candidate_repository,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      cleanupOk = removed.status === 0;
    }
    if (outcome) outcome.cleanup_ok = cleanupOk;
    rmSync(runtimeParent, { recursive: true, force: true });
    if (!cleanupOk) spawnSync("git", ["worktree", "prune"], { cwd: input.candidate_repository, stdio: "ignore" });
  }
}
