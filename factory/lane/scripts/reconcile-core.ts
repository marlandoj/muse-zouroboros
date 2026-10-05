#!/usr/bin/env bun
/**
 * FH-03 / ZOU-597 — idempotent post-merge reconciliation (pure planner + applier).
 *
 * Acceptance criterion #4: "A CI-green merge reconciles Linear status, labels,
 * execution records, progress, and the next dependency-ready ticket idempotently.
 * 3 consecutive replays produce one identical terminal state and no duplicate
 * issue, PR, label, or notification."
 *
 * The design that makes that provable:
 *   - Every reconciliation action carries a `needed` flag computed purely from the
 *     CURRENTLY-OBSERVED world. Move-to-Done is needed only if the twin is not
 *     already Done; strip-label only if the label is still present; and so on.
 *   - `applyReconciliation` runs ONLY needed actions. After the first pass the
 *     world is terminal, so a re-observe makes every `needed` false and a replay
 *     is a pure no-op.
 *   - `terminal_fingerprint` encodes the DESIRED end state (not the observation),
 *     so all three replays report the same fingerprint regardless of how much work
 *     each one actually did.
 *
 * Effects are injected: the pure decision logic is exercised against an in-memory
 * fake in tests; production wires real Linear/GitHub/exec-record effects behind an
 * explicit enforce flag (shadow by default — merge and reconciliation stay opt-in).
 */

import { createHash } from "node:crypto";
import type { ExecutionState } from "./execution-lifecycle";

/** Linear workflow-state type that means "Done". */
export const DONE_STATE_TYPE = "completed";

export type ReconcileActionKind =
  | "move_linear_done"
  | "strip_factory_ready_label"
  | "mark_execution_merged"
  | "record_progress"
  | "post_merge_comment"
  | "promote_next_ticket";

export const RECONCILE_ACTION_ORDER: readonly ReconcileActionKind[] = [
  "move_linear_done",
  "strip_factory_ready_label",
  "mark_execution_merged",
  "record_progress",
  "post_merge_comment",
  "promote_next_ticket",
] as const;

export interface ReconcileObserved {
  identifier: string;
  issue_id: string;
  /** Twin workflow-state type; "completed" once Done. null ⇒ unknown (Linear unreachable). */
  linear_state_type: string | null;
  has_factory_ready_label: boolean;
  execution_state: ExecutionState;
  progress_recorded: boolean;
  merge_comment_present: boolean;
  /** Next dependency-ready ticket to promote, or null when there is none. */
  next_ready_identifier: string | null;
  next_ready_already_pulled: boolean;
}

export interface ReconcileAction {
  kind: ReconcileActionKind;
  needed: boolean;
  detail: string;
}

export interface ReconcilePlan {
  identifier: string;
  actions: ReconcileAction[];
  pending: ReconcileActionKind[];
  terminal_fingerprint: string;
}

export interface ReconcileEffects {
  moveLinearDone(o: ReconcileObserved): Promise<void>;
  stripFactoryReadyLabel(o: ReconcileObserved): Promise<void>;
  markExecutionMerged(o: ReconcileObserved): Promise<void>;
  recordProgress(o: ReconcileObserved): Promise<void>;
  postMergeComment(o: ReconcileObserved): Promise<void>;
  promoteNextTicket(o: ReconcileObserved): Promise<void>;
}

export interface ReconcileResult {
  identifier: string;
  applied: ReconcileActionKind[];
  skipped: ReconcileActionKind[];
  terminal_fingerprint: string;
}

const EFFECT_BY_KIND: Record<ReconcileActionKind, keyof ReconcileEffects> = {
  move_linear_done: "moveLinearDone",
  strip_factory_ready_label: "stripFactoryReadyLabel",
  mark_execution_merged: "markExecutionMerged",
  record_progress: "recordProgress",
  post_merge_comment: "postMergeComment",
  promote_next_ticket: "promoteNextTicket",
};

/** A merged execution is at or beyond the `merged` delivery state. */
export function isMergedOrBeyond(state: ExecutionState): boolean {
  return state === "merged" || state === "deployed" || state === "accepted";
}

/**
 * Stable key for the DESIRED terminal state. Independent of the current observation
 * so three replays of the same (identifier, next-ticket) yield the same fingerprint.
 */
export function reconcileTerminalFingerprint(identifier: string, nextReadyIdentifier: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify(["reconciled", identifier, nextReadyIdentifier ?? null]))
    .digest("hex")
    .slice(0, 16);
}

export function planReconciliation(o: ReconcileObserved): ReconcilePlan {
  const linearKnown = o.linear_state_type !== null;
  const actions: ReconcileAction[] = [
    {
      kind: "move_linear_done",
      // Fail-safe: if Linear state is unknown we do NOT act blindly (avoids
      // moving an issue we cannot read); the next cycle retries once it is known.
      needed: linearKnown && o.linear_state_type !== DONE_STATE_TYPE,
      detail: !linearKnown
        ? "linear state unknown → defer"
        : o.linear_state_type === DONE_STATE_TYPE
          ? "already Done"
          : `${o.linear_state_type} → Done`,
    },
    {
      kind: "strip_factory_ready_label",
      needed: o.has_factory_ready_label,
      detail: o.has_factory_ready_label ? "factory-ready present → strip" : "no factory-ready label",
    },
    {
      kind: "mark_execution_merged",
      needed: !isMergedOrBeyond(o.execution_state),
      detail: isMergedOrBeyond(o.execution_state) ? `execution ${o.execution_state}` : `execution ${o.execution_state} → merged`,
    },
    {
      kind: "record_progress",
      needed: !o.progress_recorded,
      detail: o.progress_recorded ? "progress recorded" : "progress missing → record",
    },
    {
      kind: "post_merge_comment",
      needed: !o.merge_comment_present,
      detail: o.merge_comment_present ? "merge comment present" : "post one merge comment",
    },
    {
      kind: "promote_next_ticket",
      needed: o.next_ready_identifier !== null && !o.next_ready_already_pulled,
      detail: o.next_ready_identifier
        ? o.next_ready_already_pulled
          ? `${o.next_ready_identifier} already pulled`
          : `promote ${o.next_ready_identifier}`
        : "no next-ready ticket",
    },
  ];
  // Keep a canonical action order regardless of construction order.
  actions.sort((a, b) => RECONCILE_ACTION_ORDER.indexOf(a.kind) - RECONCILE_ACTION_ORDER.indexOf(b.kind));
  return {
    identifier: o.identifier,
    actions,
    pending: actions.filter((a) => a.needed).map((a) => a.kind),
    terminal_fingerprint: reconcileTerminalFingerprint(o.identifier, o.next_ready_identifier),
  };
}

/**
 * Apply only the needed actions. Idempotent by construction, resting on two
 * invariants the AC#4 replay test depends on:
 *
 *   1. The six reconcile facets are mutually ORTHOGONAL within a single pass — the
 *      Linear move, label strip, exec-merge stamp, progress record, merge comment,
 *      and next-ticket promotion touch disjoint slices of the world, so their
 *      `needed` flags are independent and applying one never re-arms another.
 *   2. Idempotency across REPLAYS comes from the CALLER re-observing the world
 *      before each apply: this function acts only on the `ReconcileObserved` it is
 *      handed. Once the first pass drives the world terminal, a fresh observation
 *      makes every `needed` false and the replay is a pure no-op. Reusing a stale
 *      observation would (correctly) re-apply — the contract is "observe, then apply".
 *
 * `terminal_fingerprint` encodes the DESIRED end state, not the observation, so all
 * three replays report an identical fingerprint regardless of how much each did.
 */
export async function applyReconciliation(o: ReconcileObserved, effects: ReconcileEffects): Promise<ReconcileResult> {
  const plan = planReconciliation(o);
  const applied: ReconcileActionKind[] = [];
  const skipped: ReconcileActionKind[] = [];
  for (const action of plan.actions) {
    if (!action.needed) {
      skipped.push(action.kind);
      continue;
    }
    await effects[EFFECT_BY_KIND[action.kind]](o);
    applied.push(action.kind);
  }
  return { identifier: o.identifier, applied, skipped, terminal_fingerprint: plan.terminal_fingerprint };
}
