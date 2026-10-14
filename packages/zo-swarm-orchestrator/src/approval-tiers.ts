/**
 * Approval tiers — the policy engine of the decision factory.
 *
 * Every proposal is classified by blast radius, mapped to an approval tier
 * (auto / delegate / human), and decided. The invariants are:
 *
 *   - Deny by default. An approval requires a positive policy match AND an
 *     authority able to grant that tier. Uncertainty — an unknown tool, an
 *     unmapped kind, a throwing store — denies.
 *   - Tier escalation is one-way (up only). Nothing can re-evaluate a
 *     proposal at a lower tier than policy assigned it.
 *   - Denial is terminal for that proposal. Re-submitting an already-denied
 *     proposal denies again (recorded as `retry_after_denial`) regardless of
 *     tier or authority.
 *   - The record comes first. `DecisionGate.decide()` persists the proposal
 *     before returning any verdict; if persisting fails, the verdict is a
 *     denial. Allowed decisions are recorded too.
 */

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import {
  newDecisionEvent,
  type ApprovalTier,
  type BlastRadius,
  type DecisionGranularity,
  type DecisionOrigin,
  type DecisionRecord,
  type DecisionRecordStore,
  type ProposedAction,
} from './decision-record.js';

export const TIER_ORDER: readonly ApprovalTier[] = ['auto', 'delegate', 'human'];

export function tierRank(tier: ApprovalTier): number {
  const rank = TIER_ORDER.indexOf(tier);
  if (rank < 0) throw new Error(`unknown approval tier: ${tier}`);
  return rank;
}

/**
 * One-way escalation. Moving a proposal to a lower tier is not escalation —
 * it is privilege laundering, and it throws.
 */
export function escalateTier(from: ApprovalTier, to: ApprovalTier): ApprovalTier {
  if (tierRank(to) < tierRank(from)) {
    throw new Error(`tier escalation is one-way: cannot move '${from}' down to '${to}'`);
  }
  return to;
}

export interface TierBudgets {
  /** Approvals grantable at the auto tier before escalation. */
  maxAutoApprovals: number;
  /** Approvals grantable at the delegate tier before escalation. */
  maxDelegateApprovals: number;
}

export interface TierPolicy {
  policy_version: string;
  /**
   * ACP tool-call kind → blast radius. A kind absent from this map is
   * `destructive` (fail closed), never read_only.
   */
  kindClassification: Record<string, BlastRadius>;
  /**
   * Tool-title overrides (normalized: lowercased, separators stripped).
   * Checked before kindClassification so a dangerous tool with a benign kind
   * stays dangerous.
   */
  toolClassification: Record<string, BlastRadius>;
  /** Blast radius → tier that must approve it. Every radius MUST be mapped. */
  tierForBlastRadius: Record<BlastRadius, ApprovalTier>;
  budgets: TierBudgets;
}

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Default policy. ACP tool kinds per the Agent Client Protocol: read, edit,
 * delete, move, search, execute, think, fetch, other.
 *
 *   read_only / local_write → auto (policy approves, recorded)
 *   network / delegated     → delegate (requires a delegation grant — in
 *                             practice the approved dispatch record)
 *   destructive             → human (no human is on this path: denied)
 */
export const DEFAULT_TIER_POLICY: TierPolicy = {
  policy_version: 'decision-factory/1',
  kindClassification: {
    read: 'read_only',
    search: 'read_only',
    think: 'read_only',
    edit: 'local_write',
    move: 'local_write',
    fetch: 'network',
    execute: 'delegated',
    delete: 'destructive',
  },
  toolClassification: {},
  tierForBlastRadius: {
    read_only: 'auto',
    local_write: 'auto',
    network: 'delegate',
    delegated: 'delegate',
    destructive: 'human',
  },
  budgets: {
    maxAutoApprovals: 512,
    maxDelegateApprovals: 256,
  },
};

/**
 * Classify a proposal's blast radius. Executor dispatches are always
 * `delegated`. Tool calls match the tool override first, then the kind map.
 * Anything unmatched is `destructive` — unknown means maximum caution.
 */
export function classifyBlastRadius(
  policy: TierPolicy,
  action: ProposedAction,
  kind?: string,
): BlastRadius {
  if (action.kind === 'executor_dispatch') return 'delegated';
  const toolOverride = policy.toolClassification[normalizeToolName(action.tool)];
  if (toolOverride) return toolOverride;
  if (kind) {
    const byKind = policy.kindClassification[kind.toLowerCase()];
    if (byKind) return byKind;
  }
  return 'destructive';
}

/** Tier verdict for one proposal: blast radius plus the tier that must approve it. */
export function tierFor(
  policy: TierPolicy,
  action: ProposedAction,
  kind?: string,
): { blastRadius: BlastRadius; tier: ApprovalTier } {
  const blastRadius = classifyBlastRadius(policy, action, kind);
  const tier = policy.tierForBlastRadius[blastRadius];
  if (!tier) throw new Error(`tier policy has no tier for blast radius '${blastRadius}'`);
  return { blastRadius, tier };
}

/** Human approval callback. Absent (the normal case) means human tier always denies. */
export type HumanApprover = (record: Omit<DecisionRecord, 'outcome' | 'reason' | 'decided_by' | 'decided_at'>) => { approved: boolean; approver: string };

export interface DecisionGateOptions {
  store: DecisionRecordStore;
  actor: string;
  origin: DecisionOrigin;
  /**
   * Highest tier this gate can grant on its own: 'auto' for an undelegated
   * context, 'delegate' when operating under an approved dispatch record.
   * Never 'human' — human authority only enters through `humanApprover`.
   */
  authority: Extract<ApprovalTier, 'auto' | 'delegate'>;
  policy?: TierPolicy;
  /** Record verbosity: 'fine' = full record per decision; 'coarse' = events on the parent record for approvals, full records for denials. */
  granularity?: DecisionGranularity;
  /** Dispatch record this gate's decisions execute under. */
  parentDecisionId?: string;
  traceId?: string;
  taskId?: string;
  /** Tool-title allowlist (e.g. the executor registry's allowedTools). When set, a tool call outside it is denied. */
  allowedTools?: string[];
  humanApprover?: HumanApprover;
}

function proposalKey(actor: string, action: ProposedAction): string {
  return createHash('sha256')
    .update(JSON.stringify([actor, action.kind, normalizeToolName(action.tool), action.target ?? '']))
    .digest('hex');
}

/**
 * The decision gate: proposals in, records + verdicts out.
 *
 * One gate instance scopes one authority context (a session's tool calls, or
 * a transport's dispatches). Budgets and terminal denials are tracked per
 * instance AND persisted, so an in-process retry and a replayed proposal both
 * stay denied.
 */
export class DecisionGate {
  private readonly policy: TierPolicy;
  private readonly granularity: DecisionGranularity;
  private readonly deniedProposals = new Set<string>();
  private readonly tierUse: Record<ApprovalTier, number> = { auto: 0, delegate: 0, human: 0 };
  private sessionId?: string;

  constructor(private readonly options: DecisionGateOptions) {
    if (!options.actor || !options.actor.trim()) {
      throw new Error('decision gate: actor is required (fail closed on anonymous proposals)');
    }
    if (options.authority !== 'auto' && options.authority !== 'delegate') {
      throw new Error(`decision gate: authority must be 'auto' or 'delegate', got '${String(options.authority)}'`);
    }
    this.policy = options.policy ?? DEFAULT_TIER_POLICY;
    this.granularity = options.granularity ?? 'fine';
  }

  /** Stamp a live ACP session id onto subsequent records. */
  bindSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * Decide one proposal. Always returns a record carrying the verdict; never
   * throws for a policy denial. A store failure or an internal error denies
   * (fail closed) and the returned record says so.
   */
  decide(action: ProposedAction, kind?: string): DecisionRecord {
    const createdAt = new Date().toISOString();
    const decisionId = randomUUID();
    try {
      return this.evaluate(decisionId, createdAt, action, kind);
    } catch (error) {
      // Fail closed: any ambiguity — a throwing store, a malformed policy —
      // is a denial. Recording the denial is best-effort here; the verdict
      // does not depend on it.
      const denial = this.buildRecord(decisionId, createdAt, action, 'destructive', 'human', {
        outcome: 'denied',
        reason: `decision gate error (fail closed): ${error instanceof Error ? error.message : String(error)}`,
        decided_by: 'fail-closed',
      });
      try {
        this.options.store.appendRecord(denial);
      } catch {
        // The store already failed once; the denial stands regardless.
      }
      this.deniedProposals.add(proposalKey(this.options.actor, action));
      return denial;
    }
  }

  private evaluate(
    decisionId: string,
    createdAt: string,
    action: ProposedAction,
    kind?: string,
  ): DecisionRecord {
    const store = this.options.store;
    const key = proposalKey(this.options.actor, action);

    // The record of the proposal comes before any verdict can exist.
    store.appendEvent(newDecisionEvent(decisionId, 'proposed', {
      actor: this.options.actor,
      tool: action.tool,
      action_kind: action.kind,
      ...(action.target ? { target: action.target } : {}),
    }));

    // Denial is terminal: a retried proposal never gets a second evaluation.
    if (this.deniedProposals.has(key)) {
      store.appendEvent(newDecisionEvent(decisionId, 'retry_after_denial', { proposal_key: key }));
      return this.finalize(decisionId, createdAt, action, 'destructive', 'human', {
        outcome: 'denied',
        reason: 'proposal was previously denied; denial is terminal',
        decided_by: 'fail-closed',
      }, key);
    }

    const { blastRadius, tier: policyTier } = tierFor(this.policy, action, kind);
    store.appendEvent(newDecisionEvent(decisionId, 'tier_assigned', { tier: policyTier, blast_radius: blastRadius }));

    // Allowlist: a tool call outside the configured allowlist is denied
    // outright — the allowlist is a boundary, not a suggestion.
    if (
      action.kind === 'tool_call' &&
      this.options.allowedTools &&
      this.options.allowedTools.length > 0 &&
      !this.options.allowedTools.some(allowed => normalizeToolName(allowed) === normalizeToolName(action.tool))
    ) {
      return this.finalize(decisionId, createdAt, action, blastRadius, policyTier, {
        outcome: 'denied',
        reason: `tool '${action.tool}' is not in the allowlist for this executor`,
        decided_by: `policy:${this.policy.policy_version}`,
      }, key);
    }

    // Budget caps escalate (one-way) when exhausted.
    let tier = policyTier;
    const cap = tier === 'auto'
      ? this.policy.budgets.maxAutoApprovals
      : tier === 'delegate'
        ? this.policy.budgets.maxDelegateApprovals
        : Number.POSITIVE_INFINITY;
    if (Number.isFinite(cap) && this.tierUse[tier] >= cap) {
      const escalated = escalateTier(tier, tier === 'auto' ? 'delegate' : 'human');
      store.appendEvent(newDecisionEvent(decisionId, 'escalated', {
        from: tier,
        to: escalated,
        reason: `tier budget exhausted (${this.tierUse[tier]}/${cap})`,
      }));
      tier = escalated;
    }

    const budget: DecisionRecord['budget'] = Number.isFinite(cap)
      ? { tier: policyTier, used: this.tierUse[policyTier], cap }
      : undefined;

    // Grant logic, deny by default:
    //   auto     → policy grants when this gate holds at least auto authority.
    //   delegate → requires delegate authority (an approved dispatch grant).
    //   human    → requires a live human approver; absent one, denied.
    if (tier === 'auto') {
      this.tierUse.auto += 1;
      return this.finalize(decisionId, createdAt, action, blastRadius, tier, {
        outcome: 'approved',
        reason: `auto tier: ${blastRadius} action approved by policy`,
        decided_by: `policy:${this.policy.policy_version}`,
        budget,
      }, key);
    }

    if (tier === 'delegate') {
      if (this.options.authority === 'delegate') {
        this.tierUse.delegate += 1;
        return this.finalize(decisionId, createdAt, action, blastRadius, tier, {
          outcome: 'approved',
          reason: `delegate tier: ${blastRadius} action approved under delegation`,
          decided_by: this.options.parentDecisionId
            ? `delegated:${this.options.parentDecisionId}`
            : `delegated:${this.options.actor}`,
          budget,
        }, key);
      }
      return this.finalize(decisionId, createdAt, action, blastRadius, tier, {
        outcome: 'denied',
        reason: `delegate tier requires delegated authority; this gate holds '${this.options.authority}'`,
        decided_by: `policy:${this.policy.policy_version}`,
        budget,
      }, key);
    }

    // Human tier.
    if (this.options.humanApprover) {
      const skeleton = this.buildRecord(decisionId, createdAt, action, blastRadius, tier, {
        outcome: 'denied',
        reason: 'pending human verdict',
        decided_by: 'fail-closed',
      });
      const { outcome: _o, reason: _r, decided_by: _d, decided_at: _a, ...pending } = skeleton;
      const verdict = this.options.humanApprover(pending);
      if (verdict.approved) {
        this.tierUse.human += 1;
        return this.finalize(decisionId, createdAt, action, blastRadius, tier, {
          outcome: 'approved',
          reason: `human tier: approved by ${verdict.approver}`,
          decided_by: `human:${verdict.approver}`,
        }, key);
      }
      return this.finalize(decisionId, createdAt, action, blastRadius, tier, {
        outcome: 'denied',
        reason: `human tier: denied by ${verdict.approver}`,
        decided_by: `human:${verdict.approver}`,
      }, key);
    }

    return this.finalize(decisionId, createdAt, action, blastRadius, tier, {
      outcome: 'denied',
      reason: 'human tier with no human approver on this path (fail closed)',
      decided_by: 'fail-closed',
    }, key);
  }

  private buildRecord(
    decisionId: string,
    createdAt: string,
    action: ProposedAction,
    blastRadius: BlastRadius,
    tier: ApprovalTier,
    verdict: { outcome: DecisionRecord['outcome']; reason: string; decided_by: string; budget?: DecisionRecord['budget'] },
  ): DecisionRecord {
    return {
      schema_version: 1,
      decision_id: decisionId,
      actor: this.options.actor,
      origin: this.options.origin,
      granularity: this.granularity,
      tier,
      blast_radius: blastRadius,
      proposed_action: action,
      outcome: verdict.outcome,
      reason: verdict.reason,
      decided_by: verdict.decided_by,
      decided_at: new Date().toISOString(),
      created_at: createdAt,
      ...(this.options.parentDecisionId ? { parent_decision_id: this.options.parentDecisionId } : {}),
      policy_version: this.policy.policy_version,
      ...(this.options.traceId ? { trace_id: this.options.traceId } : {}),
      ...(this.options.taskId ? { task_id: this.options.taskId } : {}),
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      ...(verdict.budget ? { budget: verdict.budget } : {}),
    };
  }

  private finalize(
    decisionId: string,
    createdAt: string,
    action: ProposedAction,
    blastRadius: BlastRadius,
    tier: ApprovalTier,
    verdict: { outcome: DecisionRecord['outcome']; reason: string; decided_by: string; budget?: DecisionRecord['budget'] },
    key: string,
  ): DecisionRecord {
    const record = this.buildRecord(decisionId, createdAt, action, blastRadius, tier, verdict);
    const store = this.options.store;

    // Coarse mode (factory-origin tool calls): approvals log as cheap events
    // on the parent delegated record. Denials are never coarse — a terminal
    // denial is always a durable full record.
    if (this.granularity === 'coarse' && record.outcome === 'approved' && this.options.parentDecisionId) {
      store.appendEvent(newDecisionEvent(this.options.parentDecisionId, 'delegated_child', {
        child_decision_id: decisionId,
        tool: action.tool,
        blast_radius: blastRadius,
        tier,
        outcome: record.outcome,
        decided_by: record.decided_by,
      }));
    } else {
      store.appendRecord(record);
    }
    store.appendEvent(newDecisionEvent(decisionId, record.outcome, { reason: record.reason }));

    if (record.outcome === 'denied') this.deniedProposals.add(key);
    return record;
  }
}

/**
 * Lane discrimination at the transport. The factory's executor guard already
 * stamps its dispatch env with containment/resource-guard markers
 * (factory/lane/scripts/host-resource-guard.ts), and
 * managed-unit workers run under the managed factory boundary. Either marks
 * the dispatch as factory-lane; `SWARM_DECISION_ORIGIN` is the explicit
 * override. Everything else is the swarm lane.
 */
export function resolveDecisionOrigin(env: Record<string, string | undefined>): DecisionOrigin {
  const explicit = env.SWARM_DECISION_ORIGIN?.trim().toLowerCase();
  if (explicit === 'factory' || explicit === 'swarm') return explicit;
  if (env.SWARM_EXEC_CONTAINMENT_REQUIRED === '1' || env.SWARM_EXEC_RESOURCE_GUARD_REQUIRED === '1') {
    return 'factory';
  }
  return 'swarm';
}
