#!/usr/bin/env bun
/**
 * FH-06 (P0-6) — Append every recovery transition to the journal.
 *
 * `swarm-exec.ts` appends `consensus.complete` after it gates an execution.
 * `factory-review-recovery.ts` — the retry and manual-approval path — did not.
 * So when the ZOU-933 consensus retry finally passed, the mutable execution
 * JSON was updated and the append-only journal was left holding only the
 * original configuration failure. The journal preserved the failure and lost
 * the recovery, which is the worst possible asymmetry in an audit trail.
 *
 * These helpers are the single place recovery transitions are recorded, so the
 * retry path emits the same event shape the primary path does and the FH-05
 * projection sees both. Every write inherits `recordFlight`'s fail-open
 * contract: recording can never fail or slow a recovery.
 */

import { recordFlight } from "./flight-recorder";
import type { FactoryConsensusRecord } from "./factory-consensus";

export interface RecoverySubject {
  execution_id: string;
  identifier: string;
}

/**
 * Emitted after a consensus retry, in the same shape `swarm-exec.ts` uses, so
 * the projection cannot tell a first-pass gate from a recovered one — which is
 * the point. `recovery: true` marks provenance without forking the event kind.
 */
export function recordConsensusOutcome(
  subject: RecoverySubject,
  consensus: FactoryConsensusRecord,
  options: { recovery?: boolean; by?: string; dir?: string } = {},
): void {
  recordFlight({
    execution_id: subject.execution_id,
    identifier: subject.identifier,
    kind: "consensus.complete",
    detail: consensus.reason ?? consensus.status,
    data: {
      status: consensus.status,
      reason_code: consensus.reason_code,
      failure_class: consensus.failure_class ?? null,
      fingerprint: consensus.fingerprint ?? null,
      gate_status: consensus.gate_status,
      gate_id: consensus.gate_id,
      trace_id: consensus.trace_id,
      attempts: consensus.attempts,
      lineup: consensus.lineup,
      serving_providers: consensus.serving_providers,
      chain_attempts: consensus.chain_attempts,
      dissent: consensus.dissent,
      ...(options.recovery ? { recovery: true } : {}),
      ...(options.by ? { by: options.by } : {}),
    },
  }, options.dir);
}

/**
 * Emitted when an operator releases a hold. Without this the projection can
 * see `manual-review.requested` and never see it answered, so a resolved hold
 * reads identically to an indefinite one.
 */
export function recordManualResolution(
  subject: RecoverySubject,
  input: { by: string; note: string; resolution: string; state: string },
  options: { dir?: string } = {},
): void {
  recordFlight({
    execution_id: subject.execution_id,
    identifier: subject.identifier,
    kind: "recovery.resolved",
    detail: `${input.resolution} by ${input.by}`,
    data: {
      by: input.by,
      note: input.note,
      resolution: input.resolution,
      state: input.state,
    },
  }, options.dir);
}

/**
 * Emitted when a recovery advances the lifecycle. The kind mirrors the
 * `exec.<state>` vocabulary the projection already maps, so a recovered
 * transition raises the projection exactly like a primary-path one.
 */
export function recordRecoveryTransition(
  subject: RecoverySubject,
  input: { state: string; by: string; resolution: string },
  options: { dir?: string } = {},
): void {
  recordFlight({
    execution_id: subject.execution_id,
    identifier: subject.identifier,
    kind: `exec.${input.state}`,
    detail: `recovered to ${input.state} via ${input.resolution}`,
    data: { by: input.by, resolution: input.resolution, recovery: true },
  }, options.dir);
}
