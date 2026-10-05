import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  CERTIFICATION_VALIDATION_CLASSES,
  validateCertificationValidationEvidence,
  type CertificationValidationEvidenceBinding,
} from "../../../Skills/zouroboros-governance/scripts/certification-validation-evidence";

export {
  CERTIFICATION_VALIDATION_CLASSES,
  validateCertificationValidationEvidence,
} from "../../../Skills/zouroboros-governance/scripts/certification-validation-evidence";
export type {
  CertificationValidationClass,
  CertificationValidationCommandReceipt,
  CertificationValidationEvidence,
  CertificationValidationEvidenceBinding,
  CertificationValidationTarget,
} from "../../../Skills/zouroboros-governance/scripts/certification-validation-evidence";

export interface PromotionExecutionContext {
  repository: string;
  repoDir: string;
  pullRequest: number;
  baseRef: string;
  headRef: string;
  headSha: string;
  diff: string;
  operatorApprovalPath: string;
  operatorApprovalKeyPath: string;
  rollbackEvidencePath: string;
  certificationValidationEvidencePath?: string;
  personaAttestationPath: string;
  personaKeyPath: string;
}

export interface PromotionExecutionContextClaim {
  schema: "zouroboros.promotion-execution-context-claim/v1";
  executionId: string;
  ticket: string;
  templatePath: string;
  claimPath: string;
  lockPath: string;
  templateSha256: string;
  claimedAt: string;
}

export interface PromotionExecutionBinding {
  context: PromotionExecutionContext;
  claim: PromotionExecutionContextClaim | null;
}

export interface PromotionExecutionCarrier {
  execution_id: string;
  identifier: string;
  promotion_context?: PromotionExecutionContext;
  promotion_context_claim?: PromotionExecutionContextClaim;
}

export interface PromotionExecutionContextTestHooks {
  afterValidate?: (templatePath: string) => void;
  afterLock?: (lockPath: string) => void;
  afterClaim?: (claimPath: string) => void;
}

export interface LoadPromotionExecutionBindingInput {
  configuredPath: string | undefined;
  executionId: string;
  ticketIdentifier: string;
  expectedRepoDir?: string | null;
  expectedPullRequest?: number | null;
  expectedHeadRef?: string | null;
  testHooks?: PromotionExecutionContextTestHooks;
  now?: () => string;
}

const BOUND_SCHEMA = "zouroboros.promotion-execution-context/v1";
const TEMPLATE_SCHEMA = "zouroboros.promotion-execution-context-template/v1";
const CLAIM_SCHEMA = "zouroboros.promotion-execution-context-claim/v1";
const CONTEXT_KEYS = [
  "baseRef",
  "certificationValidationEvidencePath",
  "diff",
  "headRef",
  "headSha",
  "operatorApprovalKeyPath",
  "operatorApprovalPath",
  "personaAttestationPath",
  "personaKeyPath",
  "pullRequest",
  "repoDir",
  "repository",
  "rollbackEvidencePath",
] as const;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function parseJson(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(bytes.toString("utf8")), label);
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be a JSON object")) throw error;
    throw new Error(`${label} is not valid JSON`);
  }
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function requireAbsoluteCanonical(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an absolute canonical path`);
  return path;
}

function requireOwnerDirectory(path: string, label: string, exactMode?: number): void {
  requireAbsoluteCanonical(path, label);
  if (!existsSync(path)) throw new Error(`${label} is unavailable`);
  const stat = lstatSync(path);
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (uid !== null && stat.uid !== uid)) {
    throw new Error(`${label} must be a canonical owner-controlled directory without symlinks`);
  }
  const mode = stat.mode & 0o777;
  if (exactMode !== undefined ? mode !== exactMode : (mode & 0o022) !== 0) {
    throw new Error(`${label} has unsafe permissions`);
  }
}

function requireOwnerFile(path: string, label: string, exactMode = 0o600): void {
  requireAbsoluteCanonical(path, label);
  if (!existsSync(path)) throw new Error(`${label} is unavailable`);
  const stat = lstatSync(path);
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path || (uid !== null && stat.uid !== uid)) {
    throw new Error(`${label} must be a canonical owner-controlled regular file without symlinks`);
  }
  if ((stat.mode & 0o777) !== exactMode) throw new Error(`${label} must have mode ${exactMode.toString(8)}`);
}

function contextShape(value: unknown, strict: boolean): PromotionExecutionContext {
  const context = record(value, "promotion context");
  if (strict) exactKeys(context, CONTEXT_KEYS, "promotion context");
  const pathFields = [
    context.repoDir,
    context.operatorApprovalPath,
    context.operatorApprovalKeyPath,
    context.rollbackEvidencePath,
    context.personaAttestationPath,
    context.personaKeyPath,
  ];
  if (typeof context.repository !== "string"
    || (strict ? !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) : context.repository.trim().length === 0)) {
    throw new Error("promotion context repository is invalid");
  }
  if (typeof context.repoDir !== "string"
    || !Number.isInteger(context.pullRequest) || Number(context.pullRequest) <= 0
    || typeof context.baseRef !== "string" || context.baseRef.trim().length === 0
    || typeof context.headRef !== "string" || context.headRef.trim().length === 0
    || typeof context.headSha !== "string" || !/^[a-f0-9]{40}$/.test(context.headSha)
    || typeof context.diff !== "string" || context.diff.trim().length === 0
    || pathFields.some((path) => typeof path !== "string" || !isAbsolute(path))
    || (strict && (typeof context.certificationValidationEvidencePath !== "string"
      || !isAbsolute(context.certificationValidationEvidencePath)))) {
    throw new Error("promotion context is incomplete or invalid");
  }
  return context as unknown as PromotionExecutionContext;
}

function validateLegacyEnvelope(
  envelope: Record<string, unknown>,
  input: LoadPromotionExecutionBindingInput,
): PromotionExecutionBinding {
  const context = contextShape(envelope.context, false);
  const requiredInputs = [
    context.repoDir,
    context.operatorApprovalPath,
    context.operatorApprovalKeyPath,
    context.rollbackEvidencePath,
    context.personaKeyPath,
  ];
  if (envelope.schema !== BOUND_SCHEMA
    || envelope.executionId !== input.executionId
    || typeof envelope.ticket !== "string"
    || envelope.ticket.toUpperCase() !== input.ticketIdentifier.toUpperCase()
    || requiredInputs.some((path) => !existsSync(path))) {
    throw new Error("promotion context is incomplete, mismatched, or references unavailable production inputs");
  }
  if (process.env.SF010_CERTIFY === "1") {
    if (!context.certificationValidationEvidencePath) {
      throw new Error("certification context is missing certification validation evidence");
    }
    validateCertificationValidationEvidence(
      context.certificationValidationEvidencePath,
      context,
      input.now?.(),
      { requireV2: true },
    );
  }
  return { context, claim: null };
}

function validateStrictContextInputs(context: PromotionExecutionContext, now?: string): void {
  requireOwnerDirectory(context.repoDir, "promotion repository directory");
  requireOwnerFile(context.operatorApprovalPath, "operator approval");
  requireOwnerFile(context.operatorApprovalKeyPath, "operator approval key");
  requireOwnerFile(context.rollbackEvidencePath, "rollback evidence");
  requireOwnerFile(context.personaKeyPath, "persona attestation key");
  const attestationParent = dirname(requireAbsoluteCanonical(context.personaAttestationPath, "persona attestation path"));
  requireOwnerDirectory(attestationParent, "persona attestation parent");
  if (existsSync(context.personaAttestationPath)) {
    requireOwnerFile(context.personaAttestationPath, "persona attestation");
  }
  if (!context.certificationValidationEvidencePath) {
    throw new Error("promotion context is missing certification validation evidence");
  }
  validateCertificationValidationEvidence(
    context.certificationValidationEvidencePath,
    context,
    now,
    { requireV2: true },
  );
}

function validateTemplateTarget(
  context: PromotionExecutionContext,
  input: LoadPromotionExecutionBindingInput,
): void {
  if (input.expectedRepoDir && context.repoDir !== input.expectedRepoDir) {
    throw new Error("promotion context repository target does not match the execution");
  }
  if (input.expectedPullRequest !== null && input.expectedPullRequest !== undefined
    && context.pullRequest !== input.expectedPullRequest) {
    throw new Error("promotion context pull request target does not match the execution");
  }
  if (input.expectedHeadRef && context.headRef !== input.expectedHeadRef) {
    throw new Error("promotion context head target does not match the execution");
  }
}

function ensureTestHooksAllowed(hooks: PromotionExecutionContextTestHooks | undefined): void {
  if (hooks && process.env.FACTORY_STATE_MODE !== "test") {
    throw new Error("promotion context test hooks are disabled outside FACTORY_STATE_MODE=test");
  }
}

function claimPaths(templatePath: string, executionId: string): { lockPath: string; claimPath: string } {
  if (!/^[A-Za-z0-9._-]+$/.test(executionId)) throw new Error("execution ID is unsafe for a durable claim path");
  const parent = dirname(templatePath);
  const name = basename(templatePath);
  return {
    lockPath: join(parent, `${name}.lock`),
    claimPath: join(parent, `${name}.claimed-${executionId}`),
  };
}

function existingClaim(parent: string, name: string): string | null {
  return readdirSync(parent).find((entry) => entry.startsWith(`${name}.claimed-`)) ?? null;
}

function writeDurableLock(path: string, claim: PromotionExecutionContextClaim): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(claim, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  requireOwnerFile(path, "promotion context lock");
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function claimTemplate(
  templatePath: string,
  templateBytes: Buffer,
  context: PromotionExecutionContext,
  input: LoadPromotionExecutionBindingInput,
): PromotionExecutionBinding {
  if (process.env.SF010_CERTIFY !== "1") {
    throw new Error("ticket-bound promotion context templates require SF010_CERTIFY=1");
  }
  ensureTestHooksAllowed(input.testHooks);
  const parent = dirname(templatePath);
  const name = basename(templatePath);
  requireOwnerDirectory(parent, "promotion context template parent", 0o700);
  requireOwnerFile(templatePath, "promotion context template");
  validateStrictContextInputs(context, input.now?.());
  validateTemplateTarget(context, input);
  const { lockPath, claimPath } = claimPaths(templatePath, input.executionId);
  if (existsSync(lockPath)) throw new Error("promotion context lock already exists; automatic recovery is prohibited");
  const priorClaim = existingClaim(parent, name);
  if (priorClaim) throw new Error(`promotion context claim already exists: ${priorClaim}`);
  input.testHooks?.afterValidate?.(templatePath);
  requireOwnerFile(templatePath, "promotion context template");
  const validatedSha256 = sha256(templateBytes);
  const currentBytes = readFileSync(templatePath);
  if (sha256(currentBytes) !== validatedSha256) throw new Error("promotion context template bytes drifted before claim");
  const claimedAt = (input.now ?? (() => new Date().toISOString()))();
  const claim: PromotionExecutionContextClaim = {
    schema: CLAIM_SCHEMA,
    executionId: input.executionId,
    ticket: input.ticketIdentifier.toUpperCase(),
    templatePath,
    claimPath,
    lockPath,
    templateSha256: validatedSha256,
    claimedAt,
  };
  writeDurableLock(lockPath, claim);
  input.testHooks?.afterLock?.(lockPath);
  requireOwnerFile(templatePath, "promotion context template");
  if (sha256(readFileSync(templatePath)) !== validatedSha256) {
    throw new Error("promotion context template bytes drifted after lock acquisition");
  }
  if (existsSync(claimPath)) throw new Error("promotion context execution claim already exists");
  renameSync(templatePath, claimPath);
  syncDirectory(parent);
  input.testHooks?.afterClaim?.(claimPath);
  requireOwnerFile(claimPath, "claimed promotion context");
  if (sha256(readFileSync(claimPath)) !== validatedSha256) {
    throw new Error("claimed promotion context digest does not match the validated template");
  }
  return { context, claim };
}

export function loadPromotionExecutionBinding(input: LoadPromotionExecutionBindingInput): PromotionExecutionBinding {
  const configuredPath = input.configuredPath?.trim();
  if (!configuredPath) throw new Error("SF010_PROMOTION_CONTEXT_PATH is required for certification");
  const path = requireAbsoluteCanonical(configuredPath, "SF010_PROMOTION_CONTEXT_PATH");
  const { lockPath } = claimPaths(path, input.executionId);
  if (!existsSync(path)) {
    if (existsSync(lockPath)) throw new Error("promotion context lock exists while the source template is absent");
    const priorClaim = existsSync(dirname(path)) ? existingClaim(dirname(path), basename(path)) : null;
    if (priorClaim) throw new Error(`promotion context source is absent after claim: ${priorClaim}`);
    throw new Error(`promotion context is unavailable: ${path}`);
  }
  requireOwnerFile(path, "promotion context");
  const bytes = readFileSync(path);
  const envelope = parseJson(bytes, "promotion context envelope");
  if (envelope.schema === BOUND_SCHEMA) {
    return validateLegacyEnvelope(envelope, input);
  }
  if (envelope.schema !== TEMPLATE_SCHEMA) throw new Error("promotion context schema is unsupported");
  exactKeys(envelope, ["schema", "ticket", "context"], "promotion context template");
  if (typeof envelope.ticket !== "string"
    || envelope.ticket.toUpperCase() !== input.ticketIdentifier.toUpperCase()) {
    throw new Error("promotion context template ticket does not match the execution");
  }
  const context = contextShape(envelope.context, true);
  return claimTemplate(path, bytes, context, input);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function persistedClaim(value: unknown, executionId: string, ticketIdentifier: string): PromotionExecutionContextClaim {
  const claim = record(value, "persisted promotion context claim");
  exactKeys(claim, [
    "schema",
    "executionId",
    "ticket",
    "templatePath",
    "claimPath",
    "lockPath",
    "templateSha256",
    "claimedAt",
  ], "persisted promotion context claim");
  if (claim.schema !== CLAIM_SCHEMA
    || claim.executionId !== executionId
    || typeof claim.ticket !== "string" || claim.ticket.toUpperCase() !== ticketIdentifier.toUpperCase()
    || typeof claim.templatePath !== "string" || !isAbsolute(claim.templatePath)
    || typeof claim.claimPath !== "string" || !isAbsolute(claim.claimPath)
    || typeof claim.lockPath !== "string" || !isAbsolute(claim.lockPath)
    || typeof claim.templateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(claim.templateSha256)
    || typeof claim.claimedAt !== "string" || claim.claimedAt.length === 0) {
    throw new Error("persisted promotion context claim is invalid or mismatched");
  }
  return claim as unknown as PromotionExecutionContextClaim;
}

export function preservePersistedPromotionExecutionBinding(
  incoming: PromotionExecutionCarrier,
  persistedValue: unknown,
): void {
  const persisted = record(persistedValue, "persisted execution record");
  const hasContext = persisted.promotion_context !== undefined;
  const hasClaim = persisted.promotion_context_claim !== undefined;
  if (!hasContext && !hasClaim) return;
  if (persisted.execution_id !== incoming.execution_id
    || typeof persisted.identifier !== "string"
    || persisted.identifier.toUpperCase() !== incoming.identifier.toUpperCase()) {
    throw new Error("persisted promotion context belongs to a different execution");
  }
  if (!hasContext) throw new Error("persisted promotion claim is missing its bound context");
  const context = contextShape(persisted.promotion_context, false);
  const claim = hasClaim ? persistedClaim(persisted.promotion_context_claim, incoming.execution_id, incoming.identifier) : undefined;
  if (incoming.promotion_context && canonicalJson(incoming.promotion_context) !== canonicalJson(context)) {
    throw new Error("incoming promotion context conflicts with the persisted execution binding");
  }
  if (incoming.promotion_context_claim && canonicalJson(incoming.promotion_context_claim) !== canonicalJson(claim)) {
    throw new Error("incoming promotion claim conflicts with the persisted execution binding");
  }
  incoming.promotion_context ??= context;
  if (claim) incoming.promotion_context_claim ??= claim;
}
