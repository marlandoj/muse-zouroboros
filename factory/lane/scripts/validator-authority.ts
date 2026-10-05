import type { OutcomeActor } from "./outcome-envelope";
import { parseValidationContract, type ValidationContract } from "./validation-contract";

export const VALIDATOR_VERDICT_SCHEMA = "zsf.validator-verdict.v1" as const;
export const VALIDATOR_VERDICT_VERSION = 1 as const;
export const VALIDATOR_VERDICTS = ["pass", "fail", "flaky", "held"] as const;
export const VALIDATOR_DEFECT_CLASSES = [
  "acceptance_gap",
  "behavioral_regression",
  "deterministic_test_failure",
  "flaky_test",
  "environment_mismatch",
  "evidence_invalid",
  "authority_violation",
  "heldout_failure",
] as const;
export const VALIDATOR_ALLOWED_CAPABILITIES = [
  "read_candidate",
  "execute_validation",
  "read_evaluator_heldout",
  "write_evidence_scratch",
] as const;
export const VALIDATOR_PROHIBITED_CAPABILITIES = [
  "workspace_write",
  "git_ref_write",
  "github_write",
  "linear_write",
  "candidate_repair",
] as const;

export type ValidatorVerdictValue = (typeof VALIDATOR_VERDICTS)[number];
export type ValidatorDefectClass = (typeof VALIDATOR_DEFECT_CLASSES)[number];
export type ValidatorAllowedCapability = (typeof VALIDATOR_ALLOWED_CAPABILITIES)[number];

export interface ValidatorAuthority {
  executor: OutcomeActor;
  validator: OutcomeActor;
  candidate_worktree: string;
  validator_worktree: string;
  fresh_context: true;
  filesystem_read_only: true;
  detached_head: true;
  allowed_capabilities: ValidatorAllowedCapability[];
  credential_policy: {
    github: "absent";
    linear: "absent";
    git_write: "absent";
  };
  environment_digest: string;
}

export interface ValidatorVerdict {
  schema: typeof VALIDATOR_VERDICT_SCHEMA;
  schema_version: typeof VALIDATOR_VERDICT_VERSION;
  execution_id: string;
  candidate_cycle_id: string;
  candidate_commit_digest: string;
  validation_contract_digest: string;
  validator_environment_digest: string;
  evidence_digest: string;
  validator: OutcomeActor;
  verdict: ValidatorVerdictValue;
  defect_classes: ValidatorDefectClass[];
  reasons: string[];
  decided_at: string;
}

export interface CreateValidatorAuthorityInput {
  executor: OutcomeActor;
  validator: OutcomeActor;
  candidate_worktree: string;
  validator_worktree: string;
  environment_digest: string;
  fresh_context?: boolean;
  filesystem_read_only?: boolean;
  detached_head?: boolean;
  allowed_capabilities?: string[];
  credential_policy?: Partial<ValidatorAuthority["credential_policy"]>;
}

export interface CreateValidatorVerdictInput {
  contract: ValidationContract;
  authority: ValidatorAuthority;
  execution_id: string;
  candidate_cycle_id: string;
  candidate_commit_digest: string;
  validation_contract_digest: string;
  validator_environment_digest: string;
  evidence_digest: string;
  validator: OutcomeActor;
  verdict: ValidatorVerdictValue;
  defect_classes?: ValidatorDefectClass[];
  reasons?: string[];
  decided_at: string;
}

export type ValidatorAuthorityResult =
  | { ok: true; authority: ValidatorAuthority }
  | { ok: false; errors: string[] };

export type ValidatorVerdictResult =
  | { ok: true; verdict: ValidatorVerdict }
  | { ok: false; errors: string[] };

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function actorKey(actor: OutcomeActor): string {
  return `${actor.id}\u0000${actor.harness}\u0000${actor.model}`;
}

function validateActor(actor: OutcomeActor, path: string, errors: string[]): void {
  for (const key of ["id", "harness", "model"] as const) {
    if (typeof actor[key] !== "string" || actor[key].trim() === "") errors.push(`${path}.${key}: required non-empty string`);
  }
}

function requireString(value: string, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: required non-empty string`);
    return "";
  }
  return value.trim();
}

function requireDigest(value: string, path: string, errors: string[]): string {
  const result = requireString(value, path, errors);
  if (result && !SHA256_PATTERN.test(result)) errors.push(`${path}: must be sha256:<64 lowercase hex>`);
  return result;
}

function requireTimestamp(value: string, path: string, errors: string[]): string {
  const result = requireString(value, path, errors);
  if (result && !Number.isFinite(Date.parse(result))) errors.push(`${path}: must be an ISO-8601 timestamp`);
  return result;
}

export function createValidatorAuthority(input: CreateValidatorAuthorityInput): ValidatorAuthorityResult {
  const errors: string[] = [];
  validateActor(input.executor, "authority.executor", errors);
  validateActor(input.validator, "authority.validator", errors);
  if (actorKey(input.executor) === actorKey(input.validator)) errors.push("authority.validator: must differ from executor identity");
  const candidate_worktree = requireString(input.candidate_worktree, "authority.candidate_worktree", errors);
  const validator_worktree = requireString(input.validator_worktree, "authority.validator_worktree", errors);
  if (candidate_worktree && validator_worktree && candidate_worktree === validator_worktree) {
    errors.push("authority.validator_worktree: must be a distinct fresh-context worktree");
  }
  if (input.fresh_context !== true) errors.push("authority.fresh_context: must be true");
  if (input.filesystem_read_only !== true) errors.push("authority.filesystem_read_only: must be true");
  if (input.detached_head !== true) errors.push("authority.detached_head: must be true");
  const requested = input.allowed_capabilities ?? [...VALIDATOR_ALLOWED_CAPABILITIES];
  const allowed = new Set<string>(VALIDATOR_ALLOWED_CAPABILITIES);
  const capabilities = [...new Set(requested)].sort();
  for (const capability of capabilities) {
    if (!allowed.has(capability)) errors.push(`authority.allowed_capabilities: prohibited or unknown capability ${capability}`);
  }
  const credentialPolicy = {
    github: input.credential_policy?.github ?? "absent",
    linear: input.credential_policy?.linear ?? "absent",
    git_write: input.credential_policy?.git_write ?? "absent",
  };
  for (const [name, value] of Object.entries(credentialPolicy)) {
    if (value !== "absent") errors.push(`authority.credential_policy.${name}: must be absent`);
  }
  const environment_digest = requireDigest(input.environment_digest, "authority.environment_digest", errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    authority: {
      executor: structuredClone(input.executor),
      validator: structuredClone(input.validator),
      candidate_worktree,
      validator_worktree,
      fresh_context: true,
      filesystem_read_only: true,
      detached_head: true,
      allowed_capabilities: capabilities as ValidatorAllowedCapability[],
      credential_policy: { github: "absent", linear: "absent", git_write: "absent" },
      environment_digest,
    },
  };
}

export function createValidatorVerdict(input: CreateValidatorVerdictInput): ValidatorVerdictResult {
  const errors: string[] = [];
  const parsedContract = parseValidationContract(input.contract);
  if (!parsedContract.ok) errors.push(...parsedContract.errors.map((error) => `verdict.contract: ${error}`));
  const parsedAuthority = createValidatorAuthority({
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
  if (!parsedAuthority.ok) errors.push(...parsedAuthority.errors.map((error) => `verdict.authority: ${error}`));
  const execution_id = requireString(input.execution_id, "verdict.execution_id", errors);
  const candidate_cycle_id = requireString(input.candidate_cycle_id, "verdict.candidate_cycle_id", errors);
  const candidate_commit_digest = requireDigest(input.candidate_commit_digest, "verdict.candidate_commit_digest", errors);
  const validation_contract_digest = requireDigest(input.validation_contract_digest, "verdict.validation_contract_digest", errors);
  const validator_environment_digest = requireDigest(input.validator_environment_digest, "verdict.validator_environment_digest", errors);
  const evidence_digest = requireDigest(input.evidence_digest, "verdict.evidence_digest", errors);
  const decided_at = requireTimestamp(input.decided_at, "verdict.decided_at", errors);
  validateActor(input.validator, "verdict.validator", errors);
  if (execution_id !== input.contract.execution_id) errors.push("verdict.execution_id: does not match validation contract");
  if (candidate_cycle_id !== input.contract.candidate_cycle_id) errors.push("verdict.candidate_cycle_id: does not match validation contract");
  if (validation_contract_digest !== input.contract.contract_digest) errors.push("verdict.validation_contract_digest: does not match validation contract");
  if (validator_environment_digest !== input.authority.environment_digest) errors.push("verdict.validator_environment_digest: does not match validator authority");
  if (actorKey(input.validator) !== actorKey(input.authority.validator)) errors.push("verdict.validator: does not match validator authority");
  if (actorKey(input.validator) === actorKey(input.authority.executor)) errors.push("verdict.validator: executor cannot validate its own candidate");
  const defectClasses = [...new Set(input.defect_classes ?? [])].sort();
  for (const defectClass of defectClasses) {
    if (!(VALIDATOR_DEFECT_CLASSES as readonly string[]).includes(defectClass)) errors.push(`verdict.defect_classes: invalid defect class ${defectClass}`);
  }
  const reasons = [...new Set((input.reasons ?? []).map((reason) => reason.trim()).filter(Boolean))].sort();
  if (input.verdict === "pass" && (defectClasses.length > 0 || reasons.length > 0)) {
    errors.push("verdict.pass: cannot carry defects or failure reasons");
  }
  if (input.verdict !== "pass" && reasons.length === 0) errors.push(`verdict.${input.verdict}: requires at least one reason`);
  if (input.verdict === "flaky" && !defectClasses.includes("flaky_test")) {
    errors.push("verdict.flaky: requires flaky_test defect class");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    verdict: {
      schema: VALIDATOR_VERDICT_SCHEMA,
      schema_version: VALIDATOR_VERDICT_VERSION,
      execution_id,
      candidate_cycle_id,
      candidate_commit_digest,
      validation_contract_digest,
      validator_environment_digest,
      evidence_digest,
      validator: structuredClone(input.validator),
      verdict: input.verdict,
      defect_classes: defectClasses,
      reasons,
      decided_at,
    },
  };
}

export function verdictCanAdvance(value: ValidatorVerdict | null | undefined): boolean {
  return value?.verdict === "pass";
}

export function sanitizedValidatorEnvironment(
  source: Record<string, string | undefined>,
  allowNames: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowNames);
  const prohibited = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|LINEAR|GITHUB|GH_|API_KEY)/i;
  return Object.fromEntries(Object.entries(source)
    .filter(([name, value]) => allowed.has(name) && value !== undefined && !prohibited.test(name))
    .map(([name, value]) => [name, value as string])
    .sort(([left], [right]) => left.localeCompare(right)));
}
