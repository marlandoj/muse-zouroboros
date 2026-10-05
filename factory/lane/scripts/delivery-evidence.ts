#!/usr/bin/env bun
/**
 * FH-11 (P1-8) — Delivery evidence for exactly-once serial promotion.
 *
 * After ZOU-913 delivered ZBRE-008 through merged PR #393, the promoter created
 * ZOU-921 for the same stable ticket. ZOU-921 had no legitimate diff and was
 * closed as a duplicate, but the canonical ticket now records promotion by both
 * twins.
 *
 * The idempotency key was never the problem. `serial-intake-promoter.ts`
 * already keys on `stable_key` and already treats a completed twin as canonical
 * completion. The problem is narrower and worse: `effectiveCompleted` is
 * derived *only* from Linear state. A ticket whose work is merged, deployed and
 * live still reads as incomplete until a human — or a reconciliation cycle that
 * had not yet run — flips the Linear state. In that window the promoter is
 * correct by its own inputs and wrong about the world.
 *
 * This module supplies the missing input: proof, independent of Linear, that a
 * stable key has already been delivered.
 *
 * The evidence comes from the FH-05 lifecycle projection rather than a new
 * store. The projection already reduces the append-only journal and the mutable
 * execution records into one state per execution, and it already folds
 * `reconcile-*` aliases so merge proof lands on the execution that did the
 * work. Asking it "did this twin's execution reach `merged`?" is the same
 * question with no new machinery — which is the point, because a second
 * evidence store is the fragmentation this program is removing.
 *
 * Reachability: `planSerialPromotion()` accepts the returned map and adds it to
 * the completion test before selecting a candidate.
 */

import {
  DELIVERY_STATES,
  isDeliveryState,
  type ExecutionState,
} from "./execution-lifecycle";
import { projectLifecycle, type LifecycleProjectionResult } from "./lifecycle-projection";

/** A twin is delivered once its execution reaches this state. */
export const DELIVERED_AT: ExecutionState = "merged";

const DELIVERY_RANK = new Map<string, number>(DELIVERY_STATES.map((state, index) => [state, index]));

function atLeastDelivered(state: ExecutionState): boolean {
  if (!isDeliveryState(state)) return false;
  return (DELIVERY_RANK.get(state) ?? -1) >= (DELIVERY_RANK.get(DELIVERED_AT) ?? Number.MAX_SAFE_INTEGER);
}

export interface DeliveryEvidence {
  /** The Intake twin identifier the execution ran under, e.g. `ZOU-913`. */
  twin_identifier: string;
  execution_id: string;
  state: ExecutionState;
  /** Where the proof came from, so an operator can audit the decision. */
  source: "lifecycle_projection";
  observed_at: string | null;
}

export interface DeliveryEvidenceResult {
  /**
   * True when the evidence set is trustworthy. A degraded projection yields
   * `ok: false` and an EMPTY map — never a partial one. Partial delivery
   * evidence is worse than none: it would let the promoter conclude "not
   * delivered" from missing data and mint exactly the duplicate this closes.
   */
  ok: boolean;
  degraded_reason: string | null;
  /** Keyed by twin identifier. */
  byTwin: Map<string, DeliveryEvidence>;
}

/**
 * Reduce a lifecycle projection into per-twin delivery proof.
 *
 * Fail-closed by construction: if the projection could not materialize, the
 * caller receives no evidence *and* an explicit reason, so it can refuse to
 * promote rather than promote on silence.
 */
export function deliveryEvidenceFrom(projection: LifecycleProjectionResult): DeliveryEvidenceResult {
  if (!projection.ok) {
    return {
      ok: false,
      degraded_reason: projection.degraded_reason ?? "lifecycle projection did not materialize",
      byTwin: new Map(),
    };
  }

  const byTwin = new Map<string, DeliveryEvidence>();
  for (const execution of projection.executions) {
    const twin = execution.identifier;
    if (!twin || !atLeastDelivered(execution.lifecycle.state)) continue;
    const candidate: DeliveryEvidence = {
      twin_identifier: twin,
      execution_id: execution.execution_id,
      state: execution.lifecycle.state,
      source: "lifecycle_projection",
      observed_at: execution.last_event_at,
    };
    // A twin with two executions keeps the one that got furthest; ties break on
    // the later observation so the record reflects the most recent truth.
    const existing = byTwin.get(twin);
    if (
      !existing
      || (DELIVERY_RANK.get(candidate.state) ?? -1) > (DELIVERY_RANK.get(existing.state) ?? -1)
      || ((DELIVERY_RANK.get(candidate.state) ?? -1) === (DELIVERY_RANK.get(existing.state) ?? -1)
        && (candidate.observed_at ?? "") > (existing.observed_at ?? ""))
    ) {
      byTwin.set(twin, candidate);
    }
  }

  return { ok: true, degraded_reason: null, byTwin };
}

export function collectDeliveryEvidence(
  options: { days?: number; base?: string; now?: string } = {},
): DeliveryEvidenceResult {
  return deliveryEvidenceFrom(projectLifecycle({
    days: options.days ?? 30,
    base: options.base,
    now: options.now,
  }));
}

/**
 * Map delivery evidence onto canonical identifiers using the twins the caller
 * already read from Linear. Returns the canonical identifiers a promoter must
 * treat as complete even when Linear has not caught up.
 *
 * `canonicalOfTwin` is injected rather than re-derived here: the promoter
 * already owns twin→canonical resolution and its marker format, and duplicating
 * that parse is how the two would drift apart.
 */
export function deliveredCanonicals(
  evidence: DeliveryEvidenceResult,
  twins: ReadonlyArray<{ identifier: string }>,
  canonicalOfTwin: (twinIdentifier: string) => string | null,
): Map<string, DeliveryEvidence> {
  const delivered = new Map<string, DeliveryEvidence>();
  if (!evidence.ok) return delivered;
  for (const twin of twins) {
    const proof = evidence.byTwin.get(twin.identifier);
    if (!proof) continue;
    const canonical = canonicalOfTwin(twin.identifier);
    if (!canonical) continue;
    const existing = delivered.get(canonical);
    if (!existing || (proof.observed_at ?? "") > (existing.observed_at ?? "")) {
      delivered.set(canonical, proof);
    }
  }
  return delivered;
}
