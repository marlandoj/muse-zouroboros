/**
 * governance-stub.ts — Local stand-ins for the zouroboros-governance and
 * skill-security-gate skill modules.
 *
 * The upstream modules (Skills/zouroboros-governance/scripts/*,
 * Skills/skill-security-gate/scripts/*, Skills/consensus-gate/scripts/*)
 * perform cryptographic verification of promotion attestations, operator
 * approvals, and constitution gates. They are not vendored in this
 * distribution.
 *
 * Fail-closed contract (never silently pass):
 * - VERIFY functions return { passed: false, reason: "<…> not vendored" }.
 *   Call sites feed {passed, reason} directly into lane gate records, so a
 *   missing verifier surfaces as a failed gate, not a crash and not a pass.
 * - ISSUE / LOAD functions THROW. They are only reached when actually trying
 *   to mint an attestation or load a promotion authority — actions that must
 *   not proceed without the real verifier.
 * - evaluateConstitution returns { decision: "BLOCK", … }.
 *
 * Constants (key paths) are provided as inert defaults; they are only
 * defaults for arguments and carry no authority on their own.
 *
 * If governance verification is needed, vendor the upstream skill modules
 * and repoint the importers at them.
 *
 * Exception: the "promotion approval issuance" section below reimplements
 * pure-local HMAC/file operations faithfully (no network, no external
 * authority) so self-tests can mint fixtures. Fail-closed is preserved
 * end-to-end: the VERIFY functions above still return {passed:false}, so a
 * locally-minted approval can never pass a gate in this distribution.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const NOT_VENDORED =
  "zouroboros-governance is not vendored in this distribution — cannot verify";

export const DEFAULT_PERSONA_REVIEW_KEY_PATH =
  "/home/workspace/.zouroboros/governance/persona-review.key";
export const DEFAULT_OPERATOR_APPROVAL_KEY_PATH =
  "/home/workspace/.zouroboros/governance/operator-approval.key";

// ─── Types (structural subsets of the upstream shapes) ───────────────────────

export interface PullRequestBinding {
  repository: string;
  number: number;
  headSha: string;
  baseRef: string;
  headRef: string;
}

export interface PromotionAuthorityConfig {
  attestationKeyPath: string;
  keyPath: string;
  ledgerPath: string;
  operatorApprovalKeyPath: string;
  providerContractPath: string;
  providerContractSha256: string;
  requiredPersonaAttestationSchemaVersion: 2 | 3;
}

export interface PromotionCertificationAttemptStore {
  ledgerPath: string;
  keyPath: string;
}

export interface ConsumedAuthorizationReceipt {
  receiptSha256: string;
}

export interface HumanPromotionReviewSubstitution {
  replacesPersonaId: string;
  replacesPersonaName: string;
  commitSha: string;
  evidenceSha256: string;
  verdict: "approve" | "reject";
  rationale: string;
  evidence: string[];
  findings: string[];
  reviewedAt: string;
}

export interface OperatorPromotionApproval {
  schemaVersion: 1 | 2;
  ticket: string;
  target: PullRequestBinding;
  approvedBy: string;
  rationale: string;
  budgetUsd: number;
  sourceRef: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  humanReviewSubstitution?: HumanPromotionReviewSubstitution;
  signature: string;
}

export interface EvidenceGenerationApproval {
  schemaVersion: 1;
  issuer: "zouroboros-software-factory:auto-merge-lane";
  scope: "factory-evidence-only";
  ticket: string;
  target: PullRequestBinding;
  approvedBy: string;
  rationale: string;
  sourceRef: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

// ─── persona-promotion-review ────────────────────────────────────────────────

export function verifyPersonaPromotionAttestation(
  _attestationPath: string | undefined,
  _expectedTicket: string,
  _repoDir: string | undefined,
  _expectedTarget: PullRequestBinding,
  _keyPath?: string,
  _operatorApprovalKeyPath?: string,
): { passed: boolean; reason: string; attestation: null } {
  return { passed: false, reason: `${NOT_VENDORED}: persona promotion attestation`, attestation: null };
}

export async function runPersonaPromotionReview(_input: unknown): Promise<never> {
  throw new Error(`${NOT_VENDORED}: cannot run persona promotion review`);
}

// ─── provider-native-promotion-attestation ───────────────────────────────────

export interface ProviderNativeContract {
  schema: "zouroboros.provider-native-review-contract/v2";
  snapshotSha256: string;
  version: string;
  harnesses: {
    "Claude Code": {
      authentication: {
        loggedIn: true;
        authMethod: "claude.ai";
        apiProvider: "firstParty";
      };
      harnessModels: ["claude-opus-5", "claude-haiku-4-5-20251001"];
      executableSha256: string;
    };
    "Codex CLI": {
      authentication: {
        loggedIn: true;
        authMethod: "chatgpt";
        apiProvider: "openai";
      };
      harnessModels: ["gpt-5.6-sol"];
      executableSha256: string;
    };
  };
  personas: Array<{
    id: string;
    name: string;
    promptSha256: string;
  }>;
}

export function resolveUniqueRepositoryRemote(
  _repoDir: string,
  _repository: string,
): string {
  throw new Error(`${NOT_VENDORED}: cannot resolve repository remote`);
}

export function verifyProviderNativePromotionAttestation(
  _attestationPath: string | undefined,
  _options: unknown,
): { passed: boolean; reason: string; attestation: null } {
  return {
    passed: false,
    reason: `${NOT_VENDORED}: provider-native promotion attestation`,
    attestation: null,
  };
}

// ─── provider-native-promotion-issuer ────────────────────────────────────────

export async function issueProviderNativePromotionAttestation(_input: unknown): Promise<never> {
  throw new Error(`${NOT_VENDORED}: cannot issue provider-native promotion attestation`);
}

// ─── operator-promotion-approval ─────────────────────────────────────────────

export function verifyOperatorPromotionApproval(
  _approvalPath: string | undefined,
  _expectedTicket: string,
  _expectedTarget: PullRequestBinding,
  _keyPath?: string,
): { passed: boolean; reason: string; approval: null } {
  return { passed: false, reason: `${NOT_VENDORED}: operator promotion approval`, approval: null };
}

export function verifyEvidenceGenerationApproval(
  _approvalPath: string | undefined,
  _expectedTicket: string,
  _expectedTarget: PullRequestBinding,
  _keyPath?: string,
): { passed: boolean; reason: string; approval: null } {
  return { passed: false, reason: `${NOT_VENDORED}: evidence generation approval`, approval: null };
}

// ─── promotion approval issuance (pure-local HMAC, reimplemented faithfully) ─
// The functions below are pure local HMAC/file operations — no network, no
// external authority. They are reimplemented faithfully from the upstream
// modules so self-tests can mint fixtures. Fail-closed is preserved
// end-to-end: verifyOperatorPromotionApproval / verifyEvidenceGenerationApproval
// above still return {passed:false}, so a locally-minted approval can never
// pass a gate in this distribution.

const HUMAN_REVIEW_SUBSTITUTABLE_PERSONA = {
  id: "c9fef4df-091b-4e41-a51a-23479d9cf3eb",
  name: "Claude Code",
} as const;

export const REQUIRED_PROMOTION_PERSONAS = [
  {
    ...HUMAN_REVIEW_SUBSTITUTABLE_PERSONA,
    modelName: "byok:63a73cf2-224a-4641-8dcb-c3313270d08a",
  },
  {
    id: "beb55a68-6918-4245-b20b-2b8b143113e1",
    name: "Codex CLI",
    modelName: "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
  },
] as const;

const EVIDENCE_GENERATION_APPROVAL_SCHEMA_VERSION = 1 as const;
const EVIDENCE_GENERATION_APPROVAL_ISSUER =
  "zouroboros-software-factory:auto-merge-lane" as const;
const EVIDENCE_GENERATION_APPROVAL_SCOPE = "factory-evidence-only" as const;
const EVIDENCE_GENERATION_APPROVAL_MAX_VALIDITY_MS = 2 * 60 * 60 * 1000;
const EVIDENCE_GENERATION_SIGNATURE_DOMAIN =
  "zouroboros-evidence-generation-approval\n";

function keyMaterial(keyPath: string): Buffer {
  if (!existsSync(keyPath))
    throw new Error(`operator approval key is unavailable: ${keyPath}`);
  const mode = statSync(keyPath).mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw new Error("operator approval key must not be group/world accessible");
  const key = readFileSync(keyPath);
  if (key.length < 32)
    throw new Error("operator approval key must contain at least 32 bytes");
  return key;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validBinding(value: unknown): value is PullRequestBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<PullRequestBinding>;
  return (
    nonEmpty(binding.repository) &&
    Number.isInteger(binding.number) &&
    Number(binding.number) > 0 &&
    typeof binding.headSha === "string" &&
    /^[a-f0-9]{40}$/i.test(binding.headSha) &&
    nonEmpty(binding.baseRef) &&
    nonEmpty(binding.headRef)
  );
}

function normalizeRepository(value: string): string {
  return value
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function signApproval(
  approval: Omit<OperatorPromotionApproval, "signature">,
  keyPath: string,
): string {
  return createHmac("sha256", keyMaterial(keyPath))
    .update(JSON.stringify(approval))
    .digest("hex");
}

function signEvidenceApproval(
  approval: Omit<EvidenceGenerationApproval, "signature">,
  keyPath: string,
): string {
  return createHmac("sha256", keyMaterial(keyPath))
    .update(EVIDENCE_GENERATION_SIGNATURE_DOMAIN)
    .update(JSON.stringify(approval))
    .digest("hex");
}

function humanReviewFailures(
  value: unknown,
  target: PullRequestBinding,
  issuedAt: string,
  expiresAt: string,
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["humanReviewSubstitution must be an object"];
  }
  const review = value as Partial<HumanPromotionReviewSubstitution>;
  const failures: string[] = [];
  if (!nonEmpty(review.replacesPersonaId) || !nonEmpty(review.replacesPersonaName)) {
    failures.push("human review replacement persona identity is required");
  } else if (
    review.replacesPersonaId !== HUMAN_REVIEW_SUBSTITUTABLE_PERSONA.id ||
    review.replacesPersonaName !== HUMAN_REVIEW_SUBSTITUTABLE_PERSONA.name
  ) {
    failures.push("human review may replace only Claude Code");
  }
  if (review.commitSha !== target.headSha)
    failures.push("human review commit must match the promotion target head");
  if (
    typeof review.evidenceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(review.evidenceSha256)
  ) {
    failures.push("human review evidenceSha256 must be a SHA-256 digest");
  }
  if (review.verdict !== "approve" && review.verdict !== "reject")
    failures.push("human review verdict must be approve|reject");
  if (!nonEmpty(review.rationale)) failures.push("human review rationale is required");
  const validStringArray = (v: unknown, allowEmpty: boolean): v is string[] =>
    Array.isArray(v) &&
    (allowEmpty || v.length > 0) &&
    v.every((item) => nonEmpty(item));
  if (!validStringArray(review.evidence, false))
    failures.push("human review must cite evidence");
  if (!validStringArray(review.findings, true))
    failures.push("human review findings must be a string array");
  const reviewed = Date.parse(review.reviewedAt ?? "");
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(reviewed)) failures.push("human review reviewedAt is invalid");
  if (Number.isFinite(reviewed) && Number.isFinite(issued) && reviewed < issued - 5 * 60_000) {
    failures.push("human review predates the request-scoped approval window");
  }
  if (Number.isFinite(reviewed) && Number.isFinite(expires) && reviewed >= expires) {
    failures.push("human review falls outside the request-scoped approval window");
  }
  return failures;
}

export function initializePersonaReviewKey(
  keyPath = DEFAULT_PERSONA_REVIEW_KEY_PATH,
): string {
  mkdirSync(dirname(keyPath), { recursive: true });
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(48), { flag: "wx", mode: 0o600 });
  chmodSync(keyPath, 0o600);
  keyMaterial(keyPath);
  return keyPath;
}

export function initializeOperatorApprovalKey(
  keyPath = DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
): string {
  mkdirSync(dirname(keyPath), { recursive: true });
  if (!existsSync(keyPath))
    writeFileSync(keyPath, randomBytes(48), { flag: "wx", mode: 0o600 });
  chmodSync(keyPath, 0o600);
  keyMaterial(keyPath);
  return keyPath;
}

export function recordOperatorPromotionApproval(input: {
  ticket: string;
  target: PullRequestBinding;
  approvedBy: string;
  rationale: string;
  budgetUsd: number;
  sourceRef: string;
  expiresAt: string;
  outputPath: string;
  keyPath?: string;
  issuedAt?: string;
  humanReviewSubstitution?: HumanPromotionReviewSubstitution;
}): OperatorPromotionApproval {
  if (!nonEmpty(input.ticket) || !validBinding(input.target))
    throw new Error("ticket and a complete pull-request binding are required");
  if (!nonEmpty(input.approvedBy) || !nonEmpty(input.rationale) || !nonEmpty(input.sourceRef)) {
    throw new Error("approvedBy, rationale, and sourceRef are required");
  }
  if (!Number.isFinite(input.budgetUsd) || input.budgetUsd < 0)
    throw new Error("budgetUsd must be a non-negative number");
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    throw new Error("expiresAt must be later than issuedAt");
  }
  if (expires - issued > 24 * 60 * 60 * 1000)
    throw new Error("operator approval may not remain valid longer than 24 hours");
  if (input.humanReviewSubstitution) {
    const failures = humanReviewFailures(
      input.humanReviewSubstitution,
      input.target,
      issuedAt,
      input.expiresAt,
    );
    if (failures.length > 0) throw new Error(failures.join("; "));
  }

  const keyPath = resolve(input.keyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH);
  keyMaterial(keyPath);
  const unsigned: Omit<OperatorPromotionApproval, "signature"> = {
    schemaVersion: input.humanReviewSubstitution ? 2 : 1,
    ticket: input.ticket.trim(),
    target: {
      ...input.target,
      repository: normalizeRepository(input.target.repository),
    },
    approvedBy: input.approvedBy.trim(),
    rationale: input.rationale.trim(),
    budgetUsd: input.budgetUsd,
    sourceRef: input.sourceRef.trim(),
    issuedAt,
    expiresAt: input.expiresAt,
    nonce: randomUUID(),
    ...(input.humanReviewSubstitution
      ? { humanReviewSubstitution: input.humanReviewSubstitution }
      : {}),
  };
  const approval: OperatorPromotionApproval = {
    ...unsigned,
    signature: signApproval(unsigned, keyPath),
  };
  const outputPath = resolve(input.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(approval, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
  return approval;
}

export function recordEvidenceGenerationApproval(input: {
  ticket: string;
  target: PullRequestBinding;
  approvedBy: string;
  rationale: string;
  sourceRef: string;
  expiresAt: string;
  outputPath: string;
  keyPath?: string;
  issuedAt?: string;
}): EvidenceGenerationApproval {
  if (!nonEmpty(input.ticket) || !validBinding(input.target))
    throw new Error("ticket and a complete pull-request binding are required");
  if (!nonEmpty(input.approvedBy) || !nonEmpty(input.rationale) || !nonEmpty(input.sourceRef)) {
    throw new Error("approvedBy, rationale, and sourceRef are required");
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    throw new Error("expiresAt must be later than issuedAt");
  }
  if (expires - issued > EVIDENCE_GENERATION_APPROVAL_MAX_VALIDITY_MS) {
    throw new Error("evidence-generation approval may not remain valid longer than 2 hours");
  }
  const keyPath = resolve(input.keyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH);
  keyMaterial(keyPath);
  const unsigned: Omit<EvidenceGenerationApproval, "signature"> = {
    schemaVersion: EVIDENCE_GENERATION_APPROVAL_SCHEMA_VERSION,
    issuer: EVIDENCE_GENERATION_APPROVAL_ISSUER,
    scope: EVIDENCE_GENERATION_APPROVAL_SCOPE,
    ticket: input.ticket.trim(),
    target: {
      ...input.target,
      repository: normalizeRepository(input.target.repository),
    },
    approvedBy: input.approvedBy.trim(),
    rationale: input.rationale.trim(),
    sourceRef: input.sourceRef.trim(),
    issuedAt,
    expiresAt: input.expiresAt,
    nonce: randomUUID(),
  };
  const approval: EvidenceGenerationApproval = {
    ...unsigned,
    signature: signEvidenceApproval(unsigned, keyPath),
  };
  const outputPath = resolve(input.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(approval, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, outputPath);
  chmodSync(outputPath, 0o600);
  return approval;
}

// ─── constitution-gate ───────────────────────────────────────────────────────

export interface ConstitutionInput {
  [key: string]: unknown;
}

export function evaluateConstitution(
  _rawInput: unknown,
  _phase: string,
  _options?: unknown,
): { decision: "ALLOW" | "BLOCK"; reason: string; authorization?: undefined } {
  return { decision: "BLOCK", reason: `${NOT_VENDORED}: constitution evaluation` };
}

// ─── certification-validation-evidence ───────────────────────────────────────

export const CERTIFICATION_VALIDATION_CLASSES = [
  "constitutional_verification",
  "strict_typescript",
  "focused_governance_tests",
  "focused_factory_tests",
  "repository_ci",
  "monorepo_build",
  "diff_hygiene",
  "secret_scan",
  "portable_state_core",
  "portable_state_cli",
  "factory_control_heldout",
] as const;

export type CertificationValidationClass = (typeof CERTIFICATION_VALIDATION_CLASSES)[number];

export interface CertificationValidationEvidenceBinding {
  path: string;
  sha256: string;
  evidence: unknown;
}

export interface CertificationValidationTarget {
  repository: string;
  repoDir: string;
  pullRequest: number;
  baseRef: string;
}

export interface CertificationValidationCommandReceipt {
  class: CertificationValidationClass;
  command: string;
  args: string[];
  exitCode: number;
  startedAt: string;
  completedAt: string;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface CertificationValidationEvidence {
  schema: string;
  repository: string;
  pullRequest: number;
  [key: string]: unknown;
}

/**
 * Fail-closed: without the upstream verifier we cannot validate
 * certification evidence. Throws rather than returning a passing binding.
 */
export function validateCertificationValidationEvidence(
  _path: string,
  _target: CertificationValidationTarget,
  _now?: Date | string,
  _options: { requireV2?: boolean } = {},
): CertificationValidationEvidenceBinding {
  throw new Error(`${NOT_VENDORED}: cannot validate certification validation evidence`);
}

// ─── autonomy-classifier (pure policy parser, reimplemented faithfully) ──────

export interface ReceiptShadowPolicy {
  schema_version: 1;
  mode: "shadow";
  enabled: true;
  allowed_runtimes: string[];
  automation_ids: string[];
  scopes: string[];
  deny_unknown: true;
}

export interface AutonomyPolicy {
  schema_version: 1;
  policy_version: string;
  mode: "shadow" | "enforce";
  supported_runtimes: string[];
  t0_actions: string[];
  t1_actions: string[];
  deny_unknown: true;
  enforcement_enabled: boolean;
  receipt_shadow?: ReceiptShadowPolicy;
}

const RECEIPT_SHADOW_AUTOMATION_ID = "7760679f-6ac8-461c-a567-43fae21c3eee";
const RECEIPT_SHADOW_SCOPES = ["observe:github", "observe:workspace", "operation.reserve"];

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function parseReceiptShadowPolicy(value: unknown): ReceiptShadowPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Partial<ReceiptShadowPolicy>;
  const keys = Object.keys(value).sort();
  const expected = ["allowed_runtimes", "automation_ids", "deny_unknown", "enabled", "mode", "schema_version", "scopes"];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || policy.schema_version !== 1
    || policy.mode !== "shadow"
    || policy.enabled !== true
    || !stringArray(policy.allowed_runtimes)
    || policy.allowed_runtimes.length !== 1
    || policy.allowed_runtimes[0] !== "zo-native"
    || !stringArray(policy.automation_ids)
    || policy.automation_ids.length !== 1
    || policy.automation_ids[0] !== RECEIPT_SHADOW_AUTOMATION_ID
    || !stringArray(policy.scopes)
    || JSON.stringify([...policy.scopes].sort()) !== JSON.stringify(RECEIPT_SHADOW_SCOPES)
    || policy.deny_unknown !== true
  ) return null;
  return policy as ReceiptShadowPolicy;
}

export function parsePolicy(value: unknown): AutonomyPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Partial<AutonomyPolicy>;
  const keys = Object.keys(value).sort();
  const expected = ["deny_unknown", "enforcement_enabled", "mode", "policy_version", "schema_version", "supported_runtimes", "t0_actions", "t1_actions"];
  const allowed = "receipt_shadow" in policy ? [...expected, "receipt_shadow"].sort() : expected.sort();
  const receiptShadow = "receipt_shadow" in policy ? parseReceiptShadowPolicy(policy.receipt_shadow) : undefined;
  if (
    keys.length !== allowed.length
    || keys.some((key, index) => key !== allowed[index])
    || policy.schema_version !== 1
    || typeof policy.policy_version !== "string"
    || !["shadow", "enforce"].includes(policy.mode as string)
    || !stringArray(policy.supported_runtimes)
    || !stringArray(policy.t0_actions)
    || !stringArray(policy.t1_actions)
    || policy.deny_unknown !== true
    || typeof policy.enforcement_enabled !== "boolean"
    || (policy.mode === "enforce") !== policy.enforcement_enabled
    || ("receipt_shadow" in policy && !receiptShadow)
  ) return null;
  return { ...policy, ...(receiptShadow ? { receipt_shadow: receiptShadow } : {}) } as AutonomyPolicy;
}

// ─── promotion-authorization-ledger ──────────────────────────────────────────

export function loadPromotionAuthorityConfig(_path?: string): PromotionAuthorityConfig {
  throw new Error(`${NOT_VENDORED}: cannot load promotion authority config`);
}

export function promotionCertificationAttemptStore(
  _authority: PromotionAuthorityConfig,
): PromotionCertificationAttemptStore {
  throw new Error(`${NOT_VENDORED}: cannot open promotion certification attempt store`);
}
