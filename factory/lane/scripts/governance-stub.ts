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
 */

const NOT_VENDORED =
  "zouroboros-governance is not vendored in this distribution — cannot verify";

export const DEFAULT_PERSONA_REVIEW_KEY_PATH =
  "/home/workspace/.zouroboros/governance/persona-review.key";
export const DEFAULT_OPERATOR_APPROVAL_KEY_PATH =
  "/home/workspace/.zouroboros/governance/operator-approval.key";

// ─── Types (structural subsets of the upstream shapes) ───────────────────────

export interface PullRequestBinding {
  repository: string;
  baseRef: string;
  headSha: string;
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

export interface OperatorPromotionApproval {
  ticket: string;
  approvedAt: string;
}

export interface EvidenceGenerationApproval {
  ticket: string;
  approvedAt: string;
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
