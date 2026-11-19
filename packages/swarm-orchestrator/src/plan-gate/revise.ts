/**
 * PCG-005: Revision controller for plan consensus review.
 *
 * Drives up to maxRevisionRounds of provider review for a single plan,
 * stopping early on pass and escalating on budget exhaustion or after
 * max rounds without a resolved decision.
 */

import { randomUUID } from 'node:crypto';
import { validatePlanArtifact } from './validate.js';
import { hashPlanArtifact } from './canonicalize.js';
import {
  isBudgetExceeded,
  DEFAULT_MAX_REVISION_ROUNDS,
  DEFAULT_MAX_PROVIDER_CALLS_PER_PLAN,
  DEFAULT_MAX_COST_USD_PER_PLAN,
} from './provider.js';
import { evaluatePlanGatePolicy } from './policy.js';
import type {
  PlanArtifact,
  PlanGateResult,
  PlanFinding,
  ConsensusDecision,
  CallAccounting,
  DeterministicReport,
  ReviewerVerdict,
  FindingType,
} from './types.js';
import type { PlanReviewProvider } from './provider.js';
import type { PlanValidationOptions } from './validate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum revision rounds before escalation.
 * Re-exported with explicit name so callers can reference it symbolically.
 */
export const maxRevisionRounds: number = DEFAULT_MAX_REVISION_ROUNDS;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface RevisionRound {
  round: number;
  gate_run_id: string;
  decision: ConsensusDecision;
  call_accounting: CallAccounting;
  timestamp: string;
}

export interface RevisionControllerOptions {
  /**
   * Maximum number of revision rounds.
   * Default: maxRevisionRounds (3, from SEED.yaml provider_budget).
   */
  maxRevisionRounds?: number;
  /**
   * Carry-forward accounting from earlier phases of the same plan session.
   * Used to enforce cumulative budget ceilings across revision loops.
   */
  initialAccounting?: Partial<
    Pick<
      CallAccounting,
      'calls_made' | 'estimated_cost_usd' | 'max_calls' | 'max_cost_usd'
    >
  >;
  validationOptions?: PlanValidationOptions;
}

export interface RevisionControllerResult {
  artifact_sha256: string;
  revision: number;
  decision: ConsensusDecision;
  rounds: RevisionRound[];
  /** Full PlanGateResult for every round executed. */
  gate_results: PlanGateResult[];
  escalated: boolean;
  escalation_reason?: string;
  total_accounting: CallAccounting;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPlanFindings(
  deterministicReport: DeterministicReport,
  verdicts: ReviewerVerdict[]
): PlanFinding[] {
  const findings: PlanFinding[] = [];

  for (const df of deterministicReport.findings) {
    findings.push({
      finding_type: (df.category ?? 'substantive') as FindingType,
      severity: df.severity,
      message: df.message,
      evidence: df.evidence,
      rule_id: df.rule_id,
    });
  }

  for (const verdict of verdicts) {
    for (const claim of verdict.claims) {
      findings.push({
        finding_type: (claim.finding_type_actual ?? 'substantive') as FindingType,
        severity: claim.severity,
        message: claim.claim,
        model: verdict.model,
        evidence: claim.evidence,
      });
    }
  }

  return findings;
}

function decisionToPass(decision: ConsensusDecision): boolean | null {
  if (decision === 'passed') return true;
  if (decision === 'rejected') return false;
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run up to maxRevisionRounds of provider review for a plan artifact.
 *
 * - Stops early when decision is 'passed' (no further rounds needed).
 * - Stops early on 'rejected' (definitive consensus; remaining rounds skipped).
 * - Escalates immediately when the provider call or cost ceiling would be
 *   exceeded before the next call.
 * - Escalates if the decision is still 'escalate' after all rounds are used.
 *
 * Budget ceilings are checked BEFORE each provider call via isBudgetExceeded.
 */
export async function runRevisionController(
  artifact: PlanArtifact,
  provider: PlanReviewProvider,
  revision: number = 1,
  options: RevisionControllerOptions = {}
): Promise<RevisionControllerResult> {
  const roundLimit = options.maxRevisionRounds ?? maxRevisionRounds;
  if (!Number.isInteger(roundLimit) || roundLimit < 1) {
    throw new Error('maxRevisionRounds must be a positive integer');
  }
  const artifact_sha256 = hashPlanArtifact(artifact);
  const deterministicReport = validatePlanArtifact(artifact, options.validationOptions);
  const policy = evaluatePlanGatePolicy(artifact);

  const revisionRounds: RevisionRound[] = [];
  const gate_results: PlanGateResult[] = [];

  // Accumulated accounting
  let totalCalls = options.initialAccounting?.calls_made ?? 0;
  let totalCost = options.initialAccounting?.estimated_cost_usd ?? 0;
  const maxCalls =
    options.initialAccounting?.max_calls ?? DEFAULT_MAX_PROVIDER_CALLS_PER_PLAN;
  const maxCostUsd =
    options.initialAccounting?.max_cost_usd ?? DEFAULT_MAX_COST_USD_PER_PLAN;

  let lastDecision: ConsensusDecision = 'unavailable';

  if (!deterministicReport.passed) {
    return {
      artifact_sha256,
      revision,
      decision: 'rejected',
      rounds: revisionRounds,
      gate_results,
      escalated: false,
      escalation_reason: 'Deterministic validation failed before provider review.',
      total_accounting: {
        calls_made: totalCalls,
        calls_remaining: Math.max(0, maxCalls - totalCalls),
        estimated_cost_usd: totalCost,
        max_calls: maxCalls,
        max_cost_usd: maxCostUsd,
      },
    };
  }

  for (let round = 1; round <= roundLimit; round++) {
    // Enforce budget ceiling before each provider call
    const rawEstimatedNextCost = await provider.estimateCost(artifact).catch(() => 0);
    const estimatedNextCost = Number.isFinite(rawEstimatedNextCost) && rawEstimatedNextCost > 0
      ? rawEstimatedNextCost
      : 0;
    const currentAccounting: CallAccounting = {
      calls_made: totalCalls,
      calls_remaining: Math.max(0, maxCalls - totalCalls),
      estimated_cost_usd: totalCost,
      max_calls: maxCalls,
      max_cost_usd: maxCostUsd,
    };

    if (isBudgetExceeded(currentAccounting, estimatedNextCost)) {
      const escalation_reason =
        `Budget ceiling reached before round ${round}: ` +
        `${totalCalls}/${maxCalls} calls used, ` +
        `$${totalCost.toFixed(4)}/$${maxCostUsd.toFixed(2)} cost.`;
      return {
        artifact_sha256,
        revision,
        decision: 'escalate',
        rounds: revisionRounds,
        gate_results,
        escalated: true,
        escalation_reason,
        total_accounting: currentAccounting,
      };
    }

    const gate_run_id = randomUUID();

    const reviewResult = await provider.review({
      artifact,
      artifact_sha256,
      deterministic_report: deterministicReport,
      revision,
      gate_run_id,
    });

    totalCalls += reviewResult.call_accounting.calls_made;
    totalCost += reviewResult.call_accounting.estimated_cost_usd;

    const timestamp = new Date().toISOString();

    const gateResult: PlanGateResult = {
      gate_run_id,
      artifact_sha256,
      revision,
      deterministic_report: deterministicReport,
      reviewer_verdicts: reviewResult.verdicts,
      provider_health: reviewResult.provider_health,
      call_accounting: reviewResult.call_accounting,
      decision: reviewResult.decision,
      pass: decisionToPass(reviewResult.decision),
      findings: buildPlanFindings(deterministicReport, reviewResult.verdicts),
      timestamp,
      policy,
    };

    gate_results.push(gateResult);
    lastDecision = reviewResult.decision;

    revisionRounds.push({
      round,
      gate_run_id,
      decision: reviewResult.decision,
      call_accounting: reviewResult.call_accounting,
      timestamp,
    });

    // Stop early on unambiguous pass
    if (reviewResult.decision === 'passed') {
      return {
        artifact_sha256,
        revision,
        decision: 'passed',
        rounds: revisionRounds,
        gate_results,
        escalated: false,
        total_accounting: {
          calls_made: totalCalls,
          calls_remaining: Math.max(0, maxCalls - totalCalls),
          estimated_cost_usd: totalCost,
          max_calls: maxCalls,
          max_cost_usd: maxCostUsd,
        },
      };
    }

    // Stop on definitive rejection without exhausting remaining rounds
    if (reviewResult.decision === 'rejected') {
      break;
    }
    // 'escalate' or 'unavailable' → continue to next round
  }

  const finalDecision: ConsensusDecision =
    lastDecision === 'rejected' ? 'rejected' : 'escalate';

  return {
    artifact_sha256,
    revision,
    decision: finalDecision,
    rounds: revisionRounds,
    gate_results,
    escalated: finalDecision === 'escalate',
    escalation_reason:
      finalDecision === 'escalate'
        ? `Plan did not pass after ${revisionRounds.length} revision round(s); decision unresolved.`
        : undefined,
    total_accounting: {
      calls_made: totalCalls,
      calls_remaining: Math.max(0, maxCalls - totalCalls),
      estimated_cost_usd: totalCost,
      max_calls: maxCalls,
      max_cost_usd: maxCostUsd,
    },
  };
}
