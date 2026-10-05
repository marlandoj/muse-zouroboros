#!/usr/bin/env bun
/**
 * FH-04 (P0-4) — Bounded consensus repair-and-recheck loop.
 *
 * ZOU-913 produced the run's one substantive consensus rejection: a quadratic
 * category-comparison path. It was repaired in `fc5c48e0` and then passed
 * build, TypeScript, 212 Playwright checks and 17 benchmark-boundary checks.
 * That is exactly the loop the factory should run — but every step of it was
 * human-operated. Consensus claims were recorded as prose and never became a
 * bounded repair task with claim-specific acceptance checks.
 *
 * This module makes that loop a state the factory can occupy:
 *
 *   quality_rejection  → actionable claims become a repair task, focused checks
 *                        run, consensus is retried within a strict budget
 *   quality_split      → human adjudication; never auto-repaired
 *   provider_unavailable → route health and re-lineup, never a code change
 *
 * The third arm matters as much as the first. After ZOU-913's repair, two real
 * consensus retries still failed because reviewers aborted or returned non-JSON.
 * Repairing code in response to an unavailable panel would have been damage, not
 * recovery, so `planRepair` refuses to treat unavailability as a claim.
 *
 * Every dependency is injected — no executor, gate, or test runner is called
 * from this module directly — so the loop is exercised without a harness.
 *
 * Reachability: `factory-review-recovery.ts` invokes `runRepairLoop()` on a
 * `quality_rejection`; unresolved outcomes flow to the existing
 * `requestManualReview()` escalation path.
 */

import { classifyFailure, type FailureClass } from "./failure-policy";
import type { FactoryConsensusRecord, GateVerdict } from "./factory-consensus";

/** Attempts are expensive and repeated failure is evidence, not bad luck. */
export const DEFAULT_REPAIR_BUDGET = 2;

export type ClaimDisposition = "actionable" | "adjudicate";

export interface RepairClaim {
  /** Stable identity so the same claim is not repaired twice. */
  id: string;
  text: string;
  /** Reviewers that raised it. A claim raised by one seat of four is weak. */
  raised_by: string[];
  disposition: ClaimDisposition;
  /** Why the disposition was chosen — surfaced in the escalation packet. */
  rationale: string;
}

export interface RepairPlan {
  /** Whether a repair should be attempted at all. */
  repairable: boolean;
  reason: string;
  failure_class: FailureClass;
  claims: RepairClaim[];
  actionable: RepairClaim[];
  adjudicate: RepairClaim[];
}

function claimId(text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
  return normalized || "unspecified";
}

/**
 * A claim is actionable when reviewers agree it is real and it is specific
 * enough to check. Contradiction between seats is the signal for adjudication:
 * the factory must not pick a side between reviewers.
 */
export function classifyClaims(verdicts: readonly GateVerdict[]): RepairClaim[] {
  const llm = verdicts.filter((verdict) => !verdict.model.startsWith("non-llm/"));
  const byId = new Map<string, RepairClaim>();

  for (const verdict of llm) {
    for (const issue of verdict.issues ?? []) {
      const text = String(issue).trim();
      if (!text) continue;
      const id = claimId(text);
      const existing = byId.get(id);
      if (existing) {
        if (!existing.raised_by.includes(verdict.model)) existing.raised_by.push(verdict.model);
        continue;
      }
      byId.set(id, { id, text, raised_by: [verdict.model], disposition: "actionable", rationale: "" });
    }
  }

  const passing = llm.filter((verdict) => verdict.pass).map((verdict) => verdict.model);
  const claims = [...byId.values()];

  for (const claim of claims) {
    // A claim raised by a seat while other seats explicitly passed is a split
    // opinion, not an agreed defect.
    if (claim.raised_by.length === 1 && passing.length > 0) {
      claim.disposition = "adjudicate";
      claim.rationale = `raised by ${claim.raised_by[0]} while ${passing.length} seat(s) passed — reviewers disagree`;
      continue;
    }
    // Vague claims cannot produce a check, so they cannot be verified as fixed.
    if (claim.text.length < 12 || !/[a-z]{3}/i.test(claim.text)) {
      claim.disposition = "adjudicate";
      claim.rationale = "claim is too vague to convert into an acceptance check";
      continue;
    }
    claim.disposition = "actionable";
    claim.rationale = `raised by ${claim.raised_by.length} seat(s) with specific detail`;
  }

  return claims;
}

/**
 * Decide whether the loop should run. Provider unavailability and split
 * verdicts exit here — repairing code against either would be a false fix.
 */
export function planRepair(record: FactoryConsensusRecord, verdicts: readonly GateVerdict[] = []): RepairPlan {
  const verdict = classifyFailure({
    reason_code: record.reason_code,
    message: record.reason,
    stage: "consensus",
  });

  const empty = { claims: [], actionable: [], adjudicate: [] };

  if (record.status === "passed") {
    return { repairable: false, reason: "consensus passed — nothing to repair", failure_class: verdict.failure_class, ...empty };
  }
  if (verdict.failure_class === "provider_unavailable") {
    return {
      repairable: false,
      reason: "no responsive panel — this is a routing problem, not an implementation defect",
      failure_class: verdict.failure_class,
      ...empty,
    };
  }
  if (verdict.failure_class === "configuration_error") {
    return {
      repairable: false,
      reason: `deterministic configuration defect (${verdict.subject ?? "unknown field"}) — repair the policy, not the code`,
      failure_class: verdict.failure_class,
      ...empty,
    };
  }
  if (verdict.failure_class === "quality_split") {
    return {
      repairable: false,
      reason: "reviewers are split — requires human adjudication",
      failure_class: verdict.failure_class,
      ...empty,
    };
  }
  if (verdict.failure_class !== "quality_rejection") {
    return { repairable: false, reason: `failure class ${verdict.failure_class} is not repairable`, failure_class: verdict.failure_class, ...empty };
  }

  const claims = classifyClaims(verdicts);
  const actionable = claims.filter((claim) => claim.disposition === "actionable");
  const adjudicate = claims.filter((claim) => claim.disposition === "adjudicate");

  return {
    repairable: actionable.length > 0,
    reason: actionable.length > 0
      ? `${actionable.length} actionable claim(s) can be converted into a repair task`
      : "rejection carries no actionable claim — escalating for adjudication",
    failure_class: verdict.failure_class,
    claims,
    actionable,
    adjudicate,
  };
}

/** Render the repair brief handed to the executor. */
export function repairTask(plan: RepairPlan, context: { identifier: string; branch: string | null }): string {
  return [
    `Repair task for ${context.identifier}${context.branch ? ` on ${context.branch}` : ""}.`,
    "",
    "Consensus rejected this implementation. Fix ONLY the claims below. Do not",
    "refactor unrelated code, and do not change tests to make a claim pass.",
    "",
    ...plan.actionable.map((claim, index) =>
      `${index + 1}. ${claim.text}\n   raised by: ${claim.raised_by.join(", ")}`),
    "",
    "For each claim, state the change that addresses it and the check that proves it.",
  ].join("\n");
}

export type RepairExecutor = (task: string, plan: RepairPlan) => Promise<{
  ok: boolean;
  summary: string;
  /** Claim ids the executor believes it addressed. */
  addressed: string[];
  error?: string;
}>;

export type ClaimCheck = (plan: RepairPlan) => Promise<{ ok: boolean; summary: string }>;

export type ConsensusRetry = (attempt: number) => Promise<FactoryConsensusRecord>;

export interface RepairAttempt {
  attempt: number;
  executor_ok: boolean;
  executor_summary: string;
  checks_ok: boolean;
  checks_summary: string;
  consensus_status: FactoryConsensusRecord["status"] | "not-run";
  consensus_reason: string | null;
}

export type RepairOutcome = "repaired" | "escalate" | "not_repairable";

export interface RepairResult {
  outcome: RepairOutcome;
  reason: string;
  attempts: RepairAttempt[];
  plan: RepairPlan;
  /** Present when the outcome is `escalate`. */
  escalation: EscalationPacket | null;
  /** The final consensus record, when consensus was reached. */
  consensus: FactoryConsensusRecord | null;
}

/**
 * The audit's acceptance criterion: "any human escalation includes the failure
 * class, attempts, route telemetry, remediation already attempted, and one
 * explicit decision requested."
 */
export interface EscalationPacket {
  identifier: string;
  failure_class: FailureClass;
  attempts: RepairAttempt[];
  route_telemetry: {
    serving_providers: string[];
    chain_attempts: FactoryConsensusRecord["chain_attempts"];
  };
  remediation_attempted: string[];
  unresolved_claims: RepairClaim[];
  /** Exactly one question. An escalation that asks two is two escalations. */
  decision_requested: string;
}

export function buildEscalation(input: {
  identifier: string;
  plan: RepairPlan;
  attempts: readonly RepairAttempt[];
  consensus: FactoryConsensusRecord | null;
  unresolved: readonly RepairClaim[];
  decision: string;
}): EscalationPacket {
  return {
    identifier: input.identifier,
    failure_class: input.plan.failure_class,
    attempts: [...input.attempts],
    route_telemetry: {
      serving_providers: input.consensus?.serving_providers ?? [],
      chain_attempts: input.consensus?.chain_attempts ?? [],
    },
    remediation_attempted: input.attempts.map((attempt) =>
      `attempt ${attempt.attempt}: executor ${attempt.executor_ok ? "ok" : "failed"}`
      + `, checks ${attempt.checks_ok ? "ok" : "failed"}`
      + `, consensus ${attempt.consensus_status}`),
    unresolved_claims: [...input.unresolved],
    decision_requested: input.decision,
  };
}

export interface RepairLoopOptions {
  identifier: string;
  branch?: string | null;
  budget?: number;
  executor: RepairExecutor;
  checks: ClaimCheck;
  retryConsensus: ConsensusRetry;
}

/**
 * Run the bounded loop. At most `budget` attempts; each attempt must repair,
 * pass claim-specific checks, and clear consensus. Anything else escalates with
 * a complete packet rather than looping.
 */
export async function runRepairLoop(
  record: FactoryConsensusRecord,
  verdicts: readonly GateVerdict[],
  options: RepairLoopOptions,
): Promise<RepairResult> {
  const budget = Math.max(1, Math.min(3, options.budget ?? DEFAULT_REPAIR_BUDGET));
  const plan = planRepair(record, verdicts);
  const attempts: RepairAttempt[] = [];

  if (!plan.repairable) {
    const unresolved = plan.adjudicate.length > 0 ? plan.adjudicate : plan.claims;
    return {
      outcome: plan.failure_class === "quality_split" || plan.adjudicate.length > 0 ? "escalate" : "not_repairable",
      reason: plan.reason,
      attempts,
      plan,
      escalation: buildEscalation({
        identifier: options.identifier,
        plan,
        attempts,
        consensus: record,
        unresolved,
        decision: decisionFor(plan),
      }),
      consensus: record,
    };
  }

  const task = repairTask(plan, { identifier: options.identifier, branch: options.branch ?? null });
  let lastConsensus: FactoryConsensusRecord | null = record;

  for (let attempt = 1; attempt <= budget; attempt++) {
    const execution = await options.executor(task, plan);
    const entry: RepairAttempt = {
      attempt,
      executor_ok: execution.ok,
      executor_summary: execution.summary || execution.error || "",
      checks_ok: false,
      checks_summary: "not run",
      consensus_status: "not-run",
      consensus_reason: null,
    };

    if (!execution.ok) {
      attempts.push(entry);
      continue;
    }

    const checks = await options.checks(plan);
    entry.checks_ok = checks.ok;
    entry.checks_summary = checks.summary;
    if (!checks.ok) {
      // A failed check means the repair is unproven. Retrying consensus here
      // would spend a panel on work we already know is incomplete.
      attempts.push(entry);
      continue;
    }

    const consensus = await options.retryConsensus(attempt);
    lastConsensus = consensus;
    entry.consensus_status = consensus.status;
    entry.consensus_reason = consensus.reason;
    attempts.push(entry);

    if (consensus.status === "passed") {
      return {
        outcome: "repaired",
        reason: `repaired and re-verified on attempt ${attempt}`,
        attempts,
        plan,
        escalation: null,
        consensus,
      };
    }

    // Consensus became unavailable mid-loop: stop repairing. The code is not
    // the problem and further attempts would burn budget on a dead panel.
    const followUp = classifyFailure({
      reason_code: consensus.reason_code,
      message: consensus.reason,
      stage: "consensus",
    });
    if (followUp.failure_class !== "quality_rejection") {
      return {
        outcome: "escalate",
        reason: `retry after repair failed with ${followUp.failure_class}, not a quality rejection`,
        attempts,
        plan,
        escalation: buildEscalation({
          identifier: options.identifier,
          plan,
          attempts,
          consensus,
          unresolved: plan.actionable,
          decision: followUp.failure_class === "provider_unavailable"
            ? "Approve the repaired implementation without a consensus verdict, or hold until a panel is available?"
            : `Resolve the ${followUp.failure_class} and resume, or hold this ticket?`,
        }),
        consensus,
      };
    }
  }

  return {
    outcome: "escalate",
    reason: `repair budget of ${budget} attempt(s) exhausted without a passing verdict`,
    attempts,
    plan,
    escalation: buildEscalation({
      identifier: options.identifier,
      plan,
      attempts,
      consensus: lastConsensus,
      unresolved: [...plan.actionable, ...plan.adjudicate],
      decision: "Approve the current implementation, request a different fix, or abandon this ticket?",
    }),
    consensus: lastConsensus,
  };
}

function decisionFor(plan: RepairPlan): string {
  if (plan.failure_class === "quality_split") {
    return "Which reviewer position should stand — approve or reject this implementation?";
  }
  if (plan.failure_class === "provider_unavailable") {
    return "Approve without a consensus verdict, or hold until a panel is available?";
  }
  if (plan.failure_class === "configuration_error") {
    return "Confirm the corrected policy value so the lane can resume?";
  }
  if (plan.adjudicate.length > 0) {
    return "Are the disputed claims real defects that must be fixed before merge?";
  }
  return "Approve this implementation, or return it for rework?";
}
