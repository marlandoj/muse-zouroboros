import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CascadeValidationCommand } from "./coding-cascade";

export const VALIDATION_CONTRACT_SCHEMA = "zsf.validation-contract.v1" as const;
export const VALIDATION_CONTRACT_VERSION = 1 as const;
export const VALIDATION_EVIDENCE_KINDS = ["command", "artifact", "invariant", "heldout"] as const;

export type ValidationEvidenceKind = (typeof VALIDATION_EVIDENCE_KINDS)[number];

export interface ValidationEvidence {
  kind: ValidationEvidenceKind;
  locator: string;
}

export interface ValidationCriterion {
  id: string;
  behavior: string;
  evidence: ValidationEvidence[];
}

export interface ValidationEnvironment {
  repository: string;
  base_commit_digest: string;
  harness: string;
  validator_version: string;
  required_env_names: string[];
}

export interface HeldoutReference {
  id: string;
  digest: string;
}

export interface ValidationContract {
  schema: typeof VALIDATION_CONTRACT_SCHEMA;
  schema_version: typeof VALIDATION_CONTRACT_VERSION;
  execution_id: string;
  ticket: string;
  candidate_cycle_id: string;
  compiled_at: string;
  seed_digest: string;
  criteria: ValidationCriterion[];
  environment: ValidationEnvironment;
  heldout_refs: HeldoutReference[];
  contract_digest: string;
}

export interface CompileValidationContractInput {
  execution_id: unknown;
  ticket: unknown;
  candidate_cycle_id: unknown;
  compiled_at: unknown;
  seed_digest: unknown;
  criteria: unknown;
  environment: unknown;
  heldout_refs?: unknown;
}

export interface PersistValidationContractResult {
  created: boolean;
  contract: ValidationContract;
}

export type ValidationContractResult =
  | { ok: true; contract: ValidationContract }
  | { ok: false; errors: string[] };

const CONTRACT_KEYS = new Set([
  "schema",
  "schema_version",
  "execution_id",
  "ticket",
  "candidate_cycle_id",
  "compiled_at",
  "seed_digest",
  "criteria",
  "environment",
  "heldout_refs",
  "contract_digest",
]);
const CRITERION_KEYS = new Set(["id", "behavior", "evidence"]);
const EVIDENCE_KEYS = new Set(["kind", "locator"]);
const ENVIRONMENT_KEYS = new Set([
  "repository",
  "base_commit_digest",
  "harness",
  "validator_version",
  "required_env_names",
]);
const HELDOUT_KEYS = new Set(["id", "digest"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function requiredString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: required non-empty string`);
    return "";
  }
  return value.trim();
}

function timestamp(value: unknown, path: string, errors: string[]): string {
  const result = requiredString(value, path, errors);
  if (result && !Number.isFinite(Date.parse(result))) errors.push(`${path}: must be an ISO-8601 timestamp`);
  return result;
}

function digest(value: unknown, path: string, errors: string[]): string {
  const result = requiredString(value, path, errors);
  if (result && !SHA256_PATTERN.test(result)) errors.push(`${path}: must be sha256:<64 lowercase hex>`);
  return result;
}

function stringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`);
    return [];
  }
  const result = value.map((entry, index) => requiredString(entry, `${path}[${index}]`, errors));
  return [...new Set(result.filter(Boolean))].sort();
}

function evidence(value: unknown, path: string, errors: string[]): ValidationEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: must contain at least one evidence locator`);
    return [];
  }
  const parsed: ValidationEvidence[] = [];
  for (const [index, entry] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath}: must be an object`);
      continue;
    }
    unknownKeys(entry, EVIDENCE_KEYS, entryPath, errors);
    const kind = typeof entry.kind === "string" && VALIDATION_EVIDENCE_KINDS.includes(entry.kind as ValidationEvidenceKind)
      ? entry.kind as ValidationEvidenceKind
      : null;
    if (!kind) errors.push(`${entryPath}.kind: invalid evidence kind`);
    const locator = requiredString(entry.locator, `${entryPath}.locator`, errors);
    if (kind && locator) parsed.push({ kind, locator });
  }
  return parsed.sort((left, right) => `${left.kind}:${left.locator}`.localeCompare(`${right.kind}:${right.locator}`));
}

function criteria(value: unknown, errors: string[]): ValidationCriterion[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("contract.criteria: must contain at least one behavioral criterion");
    return [];
  }
  const parsed: ValidationCriterion[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const path = `contract.criteria[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    unknownKeys(entry, CRITERION_KEYS, path, errors);
    const id = requiredString(entry.id, `${path}.id`, errors);
    const behavior = requiredString(entry.behavior, `${path}.behavior`, errors);
    const criterionEvidence = evidence(entry.evidence, `${path}.evidence`, errors);
    if (id && ids.has(id)) errors.push(`${path}.id: duplicate criterion id ${id}`);
    ids.add(id);
    if (id && behavior && criterionEvidence.length > 0) parsed.push({ id, behavior, evidence: criterionEvidence });
  }
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}

function environment(value: unknown, errors: string[]): ValidationEnvironment | null {
  if (!isRecord(value)) {
    errors.push("contract.environment: must be an object");
    return null;
  }
  unknownKeys(value, ENVIRONMENT_KEYS, "contract.environment", errors);
  const repository = requiredString(value.repository, "contract.environment.repository", errors);
  const base_commit_digest = digest(value.base_commit_digest, "contract.environment.base_commit_digest", errors);
  const harness = requiredString(value.harness, "contract.environment.harness", errors);
  const validator_version = requiredString(value.validator_version, "contract.environment.validator_version", errors);
  const required_env_names = stringArray(value.required_env_names, "contract.environment.required_env_names", errors);
  return repository && base_commit_digest && harness && validator_version
    ? { repository, base_commit_digest, harness, validator_version, required_env_names }
    : null;
}

function heldoutReferences(value: unknown, errors: string[]): HeldoutReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push("contract.heldout_refs: must be an array");
    return [];
  }
  const parsed: HeldoutReference[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const path = `contract.heldout_refs[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    unknownKeys(entry, HELDOUT_KEYS, path, errors);
    const id = requiredString(entry.id, `${path}.id`, errors);
    const referenceDigest = digest(entry.digest, `${path}.digest`, errors);
    if (id && ids.has(id)) errors.push(`${path}.id: duplicate held-out reference ${id}`);
    ids.add(id);
    if (id && referenceDigest) parsed.push({ id, digest: referenceDigest });
  }
  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function contractPayload(contract: Omit<ValidationContract, "contract_digest">): string {
  return JSON.stringify(canonicalize(contract));
}

export function validationContractDigest(contract: Omit<ValidationContract, "contract_digest">): string {
  return `sha256:${createHash("sha256").update(contractPayload(contract)).digest("hex")}`;
}

export function criteriaFromAcceptanceText(
  acceptanceText: string,
  commands: readonly CascadeValidationCommand[],
): ValidationCriterion[] {
  const behaviors = acceptanceText
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line));
  if (behaviors.length === 0) throw new Error("acceptance criteria must contain at least one behavior");
  if (commands.length === 0) throw new Error("at least one repository-bound validation command is required");
  const evidence = commands
    .map((command) => ({
      kind: "command" as const,
      locator: JSON.stringify({ label: command.label, command: command.command, args: command.args }),
    }))
    .sort((left, right) => left.locator.localeCompare(right.locator));
  return behaviors.map((behavior, index) => ({ id: `AC-${index + 1}`, behavior, evidence: structuredClone(evidence) }));
}

export function compileValidationContract(input: CompileValidationContractInput): ValidationContractResult {
  const errors: string[] = [];
  const execution_id = requiredString(input.execution_id, "contract.execution_id", errors);
  const ticket = requiredString(input.ticket, "contract.ticket", errors);
  const candidate_cycle_id = requiredString(input.candidate_cycle_id, "contract.candidate_cycle_id", errors);
  const compiled_at = timestamp(input.compiled_at, "contract.compiled_at", errors);
  const seed_digest = digest(input.seed_digest, "contract.seed_digest", errors);
  const parsedCriteria = criteria(input.criteria, errors);
  const parsedEnvironment = environment(input.environment, errors);
  const heldout_refs = heldoutReferences(input.heldout_refs, errors);
  if (errors.length > 0 || !parsedEnvironment) return { ok: false, errors };
  const payload: Omit<ValidationContract, "contract_digest"> = {
    schema: VALIDATION_CONTRACT_SCHEMA,
    schema_version: VALIDATION_CONTRACT_VERSION,
    execution_id,
    ticket,
    candidate_cycle_id,
    compiled_at,
    seed_digest,
    criteria: parsedCriteria,
    environment: parsedEnvironment,
    heldout_refs,
  };
  return { ok: true, contract: { ...payload, contract_digest: validationContractDigest(payload) } };
}

export function parseValidationContract(value: unknown): ValidationContractResult {
  if (!isRecord(value)) return { ok: false, errors: ["contract: must be an object"] };
  const errors: string[] = [];
  unknownKeys(value, CONTRACT_KEYS, "contract", errors);
  if (value.schema !== VALIDATION_CONTRACT_SCHEMA) errors.push(`contract.schema: must be ${VALIDATION_CONTRACT_SCHEMA}`);
  if (value.schema_version !== VALIDATION_CONTRACT_VERSION) errors.push(`contract.schema_version: must be ${VALIDATION_CONTRACT_VERSION}`);
  const result = compileValidationContract({
    execution_id: value.execution_id,
    ticket: value.ticket,
    candidate_cycle_id: value.candidate_cycle_id,
    compiled_at: value.compiled_at,
    seed_digest: value.seed_digest,
    criteria: value.criteria,
    environment: value.environment,
    heldout_refs: value.heldout_refs,
  });
  if (result.ok === false) errors.push(...result.errors);
  const suppliedDigest = digest(value.contract_digest, "contract.contract_digest", errors);
  if (result.ok && suppliedDigest && suppliedDigest !== result.contract.contract_digest) {
    errors.push("contract.contract_digest: does not match canonical contract payload");
  }
  return errors.length > 0 || result.ok === false ? { ok: false, errors } : result;
}

export function serializeValidationContract(contract: ValidationContract): string {
  const parsed = parseValidationContract(contract);
  if (parsed.ok === false) throw new Error(`invalid validation contract: ${parsed.errors.join("; ")}`);
  return `${JSON.stringify(canonicalize(parsed.contract))}\n`;
}

export function persistValidationContract(path: string, contract: ValidationContract): PersistValidationContractResult {
  const serialized = serializeValidationContract(contract);
  if (existsSync(path)) {
    const parsed = parseValidationContract(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.ok) throw new Error(`existing validation contract is invalid: ${parsed.errors.join("; ")}`);
    if (parsed.contract.contract_digest !== contract.contract_digest) {
      throw new Error(`validation contract already frozen with different digest at ${path}`);
    }
    return { created: false, contract: parsed.contract };
  }
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { created: true, contract };
}

export function assertValidationContractFrozen(contract: ValidationContract, expectedDigest: string): void {
  const parsed = parseValidationContract(contract);
  if (parsed.ok === false) throw new Error(`validation contract is invalid: ${parsed.errors.join("; ")}`);
  if (parsed.contract.contract_digest !== expectedDigest) {
    throw new Error(`validation contract changed after dispatch: expected ${expectedDigest}, got ${parsed.contract.contract_digest}`);
  }
}
