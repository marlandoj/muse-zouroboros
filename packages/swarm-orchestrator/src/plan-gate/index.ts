/**
 * Plan Consensus Gate – public barrel export.
 *
 * Consumers (swarm preflight, self-heal) import from this module via the
 * `zouroboros-workflow/plan-gate` subpath export.
 */

export type {
  PlanArtifact,
  PlanAcceptanceCriterion,
  PlanTask,
  PlanExitCondition,
  ApprovalReceipt,
  ActorAssertion,
  PlanGatePolicy,
  PlanGateResult,
  PolicyMode,
  PlanRisk,
  ConsensusDecision,
  ReceiptType,
  FindingType,
  FindingSeverity,
  DeterministicFinding,
  DeterministicReport,
  PlanFinding,
  ReviewerVerdict,
  PlanGateMode,
  PlanGatePreflightResult,
  ReceiptVerificationResult,
  LedgerRecord,
} from './types.js';

export { evaluatePlanGatePolicy, isMandatoryGate } from './policy.js';
export type { PlanGateContext } from './policy.js';

export {
  canonicalizePlanArtifact,
  hashPlanArtifact,
  parsePlanArtifactInput,
  canonicalizePlanInput,
  hashPlanInput,
} from './canonicalize.js';
export type { CanonicalizeFormat } from './canonicalize.js';

export {
  canonicalizeReceiptPayload,
  signApprovalReceipt,
  verifyApprovalReceipt,
  parseTrustedPublicKeys,
} from './receipt.js';
export type {
  TrustedPublicKeys,
  SignReceiptOptions,
  VerifyReceiptOptions,
} from './receipt.js';

export {
  validatePlanArtifact,
  validatePlanArtifactFromString,
} from './validate.js';
export type { PlanValidationOptions } from './validate.js';

export {
  runRevisionController,
  maxRevisionRounds,
} from './revise.js';
export type {
  RevisionRound,
  RevisionControllerOptions,
  RevisionControllerResult,
} from './revise.js';

export {
  PlanGateLedger,
  computeRecordHash,
  hashChain,
} from './ledger.js';
export type {
  StoredLedgerRecord,
  LedgerOptions,
  HashChainResult,
} from './ledger.js';

export { evaluatePlanGatePreflight } from './preflight.js';
export type { PlanGatePreflightOptions } from './preflight.js';

export {
  computePlanConsensus,
  classifyProviderHealth,
  classifyVerdictForAggregation,
  isBudgetExceeded,
  DEFAULT_MAX_REVISION_ROUNDS,
  DEFAULT_MAX_PROVIDER_CALLS_PER_PLAN,
  DEFAULT_MAX_COST_USD_PER_PLAN,
} from './provider.js';
export type {
  PlanReviewProvider,
  PlanReviewRequest,
  PlanReviewResult,
  ProviderFailureReason,
  VerdictClassification,
} from './provider.js';
