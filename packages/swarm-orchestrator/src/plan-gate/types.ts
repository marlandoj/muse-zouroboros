/**
 * Plan Consensus Gate – canonical workflow contracts.
 *
 * Covers: plan artifacts, typed findings, consensus decisions, provider health,
 * call accounting, actor assertions, policy, approval receipts, trust metadata,
 * and ledger records.
 *
 * Revision, signing, and ledger persistence are implemented in subsequent phases.
 */

// ---------------------------------------------------------------------------
// Primitive enumerations
// ---------------------------------------------------------------------------

/** Separately-typed finding categories (AC-04). */
export type FindingType =
  | 'substantive'
  | 'infrastructure'
  | 'formatting'
  | 'out_of_scope'
  | 'provider_failure'
  | 'abstention'
  | 'malformed_output';

export type FindingSeverity = 'blocker' | 'high' | 'medium' | 'low' | 'info';

/**
 * Named consensus outcomes.  'unavailable' signals a complete infrastructure
 * failure; 'overridden' records an operator-authorised exception after rejection
 * or escalation.
 */
export type ConsensusDecision =
  | 'passed'
  | 'rejected'
  | 'escalate'
  | 'unavailable'
  | 'overridden';

export type PlanRisk = 'high' | 'medium' | 'low';

/** When plan consensus is mandatory, advisory, or not required. */
export type PolicyMode = 'mandatory' | 'advisory' | 'exempt';

export type ProviderHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unreachable'
  | 'unknown';

export type ReceiptType =
  | 'approval'
  | 'override'
  | 'infrastructure_limited_acceptance';

// ---------------------------------------------------------------------------
// Plan artifact
// ---------------------------------------------------------------------------

export interface PlanTask {
  id: string;
  title: string;
  paths?: string[];
  depends_on?: string[];
  [key: string]: unknown;
}

export interface PlanExitCondition {
  name: string;
  criteria: string;
}

export interface PlanAcceptanceCriterion {
  id?: string;
  criterion: string;
}

export interface PlanRepositoryPin {
  repository: string;
  ref: string;
  commit_sha: string;
}

export interface BuildPlumbingAllowance {
  max_changed_lines: number;
  path_patterns: string[];
}

export interface HardwarePerformanceBaseline {
  mode: 'hardware';
  environment: string;
}

export interface HostRelativePerformanceBaseline {
  mode: 'host-relative';
  environment: string;
  release_verification: {
    environment: string;
  };
}

export type PerformanceBaseline =
  | HardwarePerformanceBaseline
  | HostRelativePerformanceBaseline;

/**
 * Canonical seed or project plan.  The open index signature allows YAML/JSON
 * round-trips to preserve extra fields without type errors while keeping
 * mandatory structure explicit.
 */
export interface PlanArtifact {
  id: string;
  title: string;
  risk?: PlanRisk;
  tasks: PlanTask[];
  acceptance_criteria: Array<string | PlanAcceptanceCriterion>;
  exit_conditions: PlanExitCondition[];
  rollback: string | Record<string, unknown> | null;
  description?: string;
  revision?: number;
  created?: string;
  protected_behavior?: string[];
  archetype?: string;
  target_repo?: string;
  repositories?: PlanRepositoryPin[];
  build_plumbing_allowance?: BuildPlumbingAllowance;
  performance_baseline?: PerformanceBaseline;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Deterministic validation
// ---------------------------------------------------------------------------

export interface DeterministicFinding {
  rule_id: string;
  severity: FindingSeverity;
  /** Typed finding category — maps infrastructure, parse, and structural issues separately. */
  category?: FindingType;
  message: string;
  evidence?: string;
  /** Task ID context when the finding is scoped to a specific task. */
  task_id?: string;
  /** Path context when the finding is scoped to a specific file path. */
  path?: string;
}

export interface DeterministicReport {
  passed: boolean;
  findings: DeterministicFinding[];
}

// ---------------------------------------------------------------------------
// Provider review
// ---------------------------------------------------------------------------

export interface FindingClaim {
  claim: string;
  evidence?: string;
  severity: FindingSeverity | null;
  finding_type_actual?: FindingType;
}

export interface ProviderError {
  http_status?: number;
  message: string;
  failover_attempted?: boolean;
  failover_chain?: string[];
  all_failover_exhausted?: boolean;
}

/**
 * A single reviewer's verdict.  Infrastructure failures, abstentions, and
 * out-of-scope objections are captured via finding_type rather than pass=false
 * so they are excluded from the substantive vote tally.
 */
export interface ReviewerVerdict {
  model: string;
  pass: boolean | null;
  confidence: number;
  finding_type: FindingType | 'none';
  claims: FindingClaim[];
  provider_error?: ProviderError;
  abstention_reason?: string;
  malformed_reason?: string;
}

/** Per-model health map returned by the provider on each review call. */
export interface ProviderHealth {
  [model: string]: ProviderHealthStatus;
}

/** Tracks provider call budget consumption across revision rounds. */
export interface CallAccounting {
  calls_made: number;
  calls_remaining: number;
  estimated_cost_usd: number;
  max_calls: number;
  max_cost_usd: number;
}

// ---------------------------------------------------------------------------
// Aggregated findings
// ---------------------------------------------------------------------------

/** A finding surfaced by the gate (deterministic or provider-derived). */
export interface PlanFinding {
  finding_type: FindingType;
  severity: FindingSeverity | null;
  message: string;
  model?: string;
  evidence?: string;
  rule_id?: string;
}

// ---------------------------------------------------------------------------
// Actor assertions and receipts
// ---------------------------------------------------------------------------

/**
 * Authenticated operator identity, authorization source, and execution context.
 * Required for every approval or override.
 */
export interface ActorAssertion {
  id: string;
  source: string;
  authorization: string;
  context?: Record<string, unknown>;
}

/**
 * Artifact-bound gate result consumed by swarm preflight.
 * Enforcement receipts require key_id + signature (Ed25519); unsigned receipts
 * are shadow/advisory only (enforcement_eligible: false).
 *
 * Signing and cryptographic verification are implemented in PCG-005.
 */
export interface ApprovalReceipt {
  receipt_type: ReceiptType;
  artifact_sha256: string;
  gate_run_ids: string[];
  decision: ConsensusDecision | 'accepted' | 'overridden';
  actor: ActorAssertion;
  reason?: string;
  timestamp: string;
  expiry: string;
  key_id?: string;
  signature?: string;
  signed: boolean;
  enforcement_eligible: boolean;
  revision?: number;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PlanGatePolicy {
  mode: PolicyMode;
  rationale: string;
  triggered_by?: string[];
}

// ---------------------------------------------------------------------------
// Gate result
// ---------------------------------------------------------------------------

export interface PlanGateResult {
  gate_run_id: string;
  artifact_sha256: string;
  revision: number;
  deterministic_report: DeterministicReport;
  reviewer_verdicts: ReviewerVerdict[];
  provider_health: ProviderHealth;
  call_accounting: CallAccounting;
  decision: ConsensusDecision;
  pass: boolean | null;
  findings: PlanFinding[];
  timestamp: string;
  policy: PlanGatePolicy;
}

// ---------------------------------------------------------------------------
// Trust metadata (used by verifier, implemented in PCG-005)
// ---------------------------------------------------------------------------

export interface TrustMetadata {
  key_id: string;
  algorithm: 'Ed25519';
  not_before: string;
  not_after?: string;
  revoked?: boolean;
}

export type PlanGateMode = 'disabled' | 'advisory' | 'shadow' | 'enforce';

export interface TrustedPublicKey {
  public_key: string;
  metadata?: TrustMetadata;
}

export interface ReceiptVerificationResult {
  valid: boolean;
  enforcement_eligible: boolean;
  reason?: string;
  key_id?: string;
}

export interface PlanGatePreflightResult {
  action: 'proceed' | 'hold';
  mode: PlanGateMode;
  required: boolean;
  would_hold: boolean;
  artifact_sha256: string;
  policy: PlanGatePolicy;
  deterministic_report: DeterministicReport;
  receipt_verification?: ReceiptVerificationResult;
  reason: string;
  audit_event: string;
}

// ---------------------------------------------------------------------------
// Ledger record (persistence implemented in PCG-005)
// ---------------------------------------------------------------------------

/**
 * Hash-chained append-only record written on every gate decision or override.
 * prev_record_hash chains entries; tamper detection is implemented in PCG-005.
 */
export interface LedgerRecord {
  record_id: string;
  artifact_sha256: string;
  revision: number;
  gate_run_id: string;
  decision: ConsensusDecision;
  policy_mode: PolicyMode;
  timestamp: string;
  actor_id?: string;
  receipt_type?: ReceiptType;
  override_reason?: string;
  provider_health_summary: Record<string, ProviderHealthStatus>;
  call_count: number;
  cost_usd: number;
  finding_counts: Record<FindingType, number>;
  execution_action?: 'proceed' | 'hold';
  would_hold?: boolean;
  reason?: string;
  audit_event?: string;
  ticket_id?: string;
  identifier?: string;
  execution_id?: string;
  execution_mode?: string;
  prev_record_hash?: string;
}
