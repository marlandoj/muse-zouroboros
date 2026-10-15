/**
 * Plan Consensus Gate – runtime-neutral provider interface.
 *
 * Defines the PlanReviewProvider contract, provider health taxonomy,
 * call accounting, and consensus computation that any adapter
 * (Zo consensus, mock, future adapters) must satisfy.
 *
 * No hard-coded Skills paths are referenced here; the Zo adapter lives
 * at Skills/consensus-gate/scripts/plan-consensus-gate.ts and is wired
 * at the integration boundary (PCG-004).
 */

import type {
  PlanArtifact,
  DeterministicReport,
  ReviewerVerdict,
  ProviderHealth,
  ProviderHealthStatus,
  CallAccounting,
  ConsensusDecision,
} from './types.js';

// ---------------------------------------------------------------------------
// Provider failure taxonomy
// ---------------------------------------------------------------------------

export const PROVIDER_FAILURE_REASONS = [
  'http_error',
  'timeout',
  'malformed_response',
  'all_failover_exhausted',
  'no_keys_configured',
  'network_unreachable',
] as const;

export type ProviderFailureReason = (typeof PROVIDER_FAILURE_REASONS)[number];

// ---------------------------------------------------------------------------
// Budget constants (from SEED.yaml provider_budget)
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_REVISION_ROUNDS = 3;
export const DEFAULT_MAX_PROVIDER_CALLS_PER_PLAN = 12;
export const DEFAULT_MAX_COST_USD_PER_PLAN = 2.0;

// ---------------------------------------------------------------------------
// Request / result types
// ---------------------------------------------------------------------------

export interface PlanReviewRequest {
  artifact: PlanArtifact;
  artifact_sha256: string;
  deterministic_report: DeterministicReport;
  revision: number;
  gate_run_id: string;
}

export interface PlanReviewResult {
  verdicts: ReviewerVerdict[];
  provider_health: ProviderHealth;
  call_accounting: CallAccounting;
  decision: ConsensusDecision;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Runtime-neutral plan-review provider.
 *
 * Implementations must:
 *   - Separately type provider_failure, abstention, malformed_output, and
 *     out_of_scope findings so they are excluded from the substantive tally.
 *   - Enforce call and cost ceilings before each paid call.
 *   - Never conflate infrastructure failures with substantive objections.
 */
export interface PlanReviewProvider {
  /**
   * Submit a plan for multi-provider consensus review.
   * Returns separately-typed verdicts, provider health, and accounting.
   */
  review(request: PlanReviewRequest): Promise<PlanReviewResult>;

  /**
   * Estimate the cost in USD for reviewing this artifact.
   * Must be called before each paid call to enforce the cost ceiling.
   */
  estimateCost(artifact: PlanArtifact): Promise<number>;

  /**
   * Probe the current health of all configured provider seats.
   */
  checkHealth(): Promise<ProviderHealth>;
}

// ---------------------------------------------------------------------------
// Verdict classification helpers
// ---------------------------------------------------------------------------

export interface VerdictClassification {
  isSubstantive: boolean;
  isInfrastructure: boolean;
  isAbstention: boolean;
  isOutOfScope: boolean;
}

/**
 * Classify a reviewer verdict so infrastructure and off-topic findings are
 * excluded from the substantive vote tally (AC-04).
 *
 * Only 'substantive' and 'none' (reviewer passed with no findings) count
 * as substantive votes.
 */
export function classifyVerdictForAggregation(
  verdict: ReviewerVerdict
): VerdictClassification {
  const ft = verdict.finding_type;
  return {
    isSubstantive: ft === 'substantive' || ft === 'none',
    isInfrastructure: ft === 'provider_failure' || ft === 'infrastructure',
    isAbstention: ft === 'abstention',
    isOutOfScope:
      ft === 'out_of_scope' || ft === 'formatting' || ft === 'malformed_output',
  };
}

/**
 * Compute the consensus decision from a set of reviewer verdicts, excluding
 * non-substantive seats (infrastructure failures, abstentions, out-of-scope).
 *
 * Rules (N = substantive seat count, threshold = N − 1):
 *   - No seats at all, or all infrastructure → 'unavailable'
 *   - passCount ≥ max(threshold, 1) → 'passed'
 *   - failCount ≥ max(threshold, 1) → 'rejected'
 *   - Otherwise (split) → 'escalate'
 */
export function computePlanConsensus(
  verdicts: ReviewerVerdict[]
): ConsensusDecision {
  if (verdicts.length === 0) return 'unavailable';

  const classified = verdicts.map((v) => ({
    v,
    ...classifyVerdictForAggregation(v),
  }));

  const allInfrastructure = classified.every((c) => c.isInfrastructure);
  if (allInfrastructure) return 'unavailable';

  const substantive = classified.filter((c) => c.isSubstantive);
  if (substantive.length === 0) return 'unavailable';

  const passCount = substantive.filter((c) => c.v.pass === true).length;
  const failCount = substantive.filter((c) => c.v.pass === false).length;
  const n = substantive.length;
  const threshold = Math.max(n - 1, 1);

  if (n > 1 && passCount === failCount) return 'escalate';
  if (passCount >= threshold) return 'passed';
  if (failCount >= threshold) return 'rejected';
  return 'escalate';
}

/**
 * Map a provider failure reason to a ProviderHealthStatus.
 */
export function classifyProviderHealth(
  reason: ProviderFailureReason
): ProviderHealthStatus {
  switch (reason) {
    case 'http_error':
    case 'timeout':
    case 'malformed_response':
      return 'degraded';
    case 'all_failover_exhausted':
    case 'no_keys_configured':
    case 'network_unreachable':
      return 'unreachable';
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return 'unknown';
    }
  }
}

/**
 * Check whether a plan's call accounting would exceed either budget ceiling
 * before making another provider call.
 *
 * Returns true when the plan should stop and escalate to the operator.
 */
export function isBudgetExceeded(
  accounting: CallAccounting,
  estimatedNextCallCost: number
): boolean {
  if (accounting.calls_made >= accounting.max_calls) return true;
  if (accounting.estimated_cost_usd + estimatedNextCallCost > accounting.max_cost_usd) {
    return true;
  }
  return false;
}
