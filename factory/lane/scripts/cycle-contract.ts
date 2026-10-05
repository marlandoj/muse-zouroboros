#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * Post-execution cycle-contract validator (conveyor Step 5).
 *
 * The scheduled conveyor must decide, after swarm-exec returns, whether the
 * resulting execution record is a healthy cycle (stay silent), a genuine
 * failure (email the operator), or a contract violation (email the operator).
 *
 * Historically that decision lived as prose in the conveyor automation and
 * hard-coded the legacy terminal status `complete`. The lifecycle resolver
 * (execution-lifecycle.ts) renamed `complete` -> `implementation_complete`
 * and made the delivery pipeline explicit, so the prose drifted and every
 * successful cycle began failing Step 5 (ZOU-619, 2026-07-13).
 *
 * This validator derives the contract FROM the resolver — the single source of
 * truth — so it can never drift from the lifecycle again. Pure by construction:
 * evaluateCycleContract takes injected records + journal events; the CLI wires
 * the real readers and prints SINGLE-LINE JSON on stdout (conveyor stdout is
 * consumed by shell pipes — keep the contract). Exit 0 = healthy/silent,
 * exit 1 = the operator must be emailed.
 */

import { readExecRecords, type ExecRecordLite } from "./flight-status";
import { readFlightEvents, type FlightEvent } from "./flight-recorder";
import {
  hasReachedTarget,
  isDeliveryState,
  isTerminalOutcomeState,
  normalizeExecutionLifecycle,
  type ExecutionState,
} from "./execution-lifecycle";
import { join } from "node:path";

/** A raw record status the conveyor treats as a forbidden torn hand-off. */
const FORBIDDEN_RAW_STATUS = "pending-implementation";

/** Outcome of one conveyor cycle's post-execution state check. */
export type CycleOutcome =
  | "success" // implementation done (or advanced further) — silent
  | "parked" // held / pool-enqueued / dry-run hand-off — silent, owned elsewhere
  | "failed" // executor exhausted — email failure evidence
  | "contract_violation" // torn / forbidden / evidence-less record — email
  | "no_record"; // swarm-exec produced no record for the ticket — email

export interface CycleContractEvidence {
  raw_status: string | null;
  lifecycle_state: ExecutionState | null;
  completed_at_null: boolean;
  pending_implementation: boolean;
  target_reached: boolean;
  exec_start_present: boolean;
  executor_start_present: boolean;
  failover_trail: string | null;
  error: string | null;
  retry_eligible: boolean | null;
  pool_handoff_reachability: string | null;
  pool_handoff_event_present: boolean;
}

export interface CycleContractVerdict {
  ticket_id: string;
  execution_id: string | null;
  identifier: string | null;
  branch_name: string | null;
  matched: boolean;
  outcome: CycleOutcome;
  /** true => conveyor cycle satisfied the contract; stay silent. */
  ok: boolean;
  /** true => the operator must be emailed this cycle. */
  needs_email: boolean;
  email_reason: string | null;
  reason: string;
  evidence: CycleContractEvidence;
}

function parseTs(ts: string | undefined | null): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Freshest record for a ticket (SF006 dedup means usually exactly one). */
function pickRecord(records: ExecRecordLite[]): ExecRecordLite | null {
  if (records.length === 0) return null;
  return [...records].sort(
    (a, b) =>
      parseTs(b.started_at as string) - parseTs(a.started_at as string) ||
      parseTs(b.state_updated_at as string) - parseTs(a.state_updated_at as string),
  )[0];
}

export interface EvaluateCycleContractArgs {
  ticketId: string;
  /** Records already filtered to this ticket_id (top-level linear_id match). */
  records: ExecRecordLite[];
  /** Flight journal events (any executions — filtered here by execution_id). */
  events: FlightEvent[];
}

export function evaluateCycleContract(args: EvaluateCycleContractArgs): CycleContractVerdict {
  const rec = pickRecord(args.records);

  if (!rec) {
    return {
      ticket_id: args.ticketId,
      execution_id: null,
      identifier: null,
      branch_name: null,
      matched: false,
      outcome: "no_record",
      ok: false,
      needs_email: true,
      email_reason: "swarm-exec produced no execution record for the dispatched ticket_id",
      reason: "no execution record matched the dispatched ticket_id",
      evidence: {
        raw_status: null,
        lifecycle_state: null,
        completed_at_null: true,
        pending_implementation: false,
        target_reached: false,
        exec_start_present: false,
        executor_start_present: false,
        failover_trail: null,
        error: null,
        retry_eligible: null,
        pool_handoff_reachability: null,
        pool_handoff_event_present: false,
      },
    };
  }

  const executionId = rec.execution_id;
  const rawStatus = typeof rec.status === "string" ? rec.status : null;
  const lifecycle = normalizeExecutionLifecycle(rec);
  const state = lifecycle.state;
  const completedAtNull = rec.completed_at === null || rec.completed_at === undefined;
  const pendingImplementation = rawStatus === FORBIDDEN_RAW_STATUS;

  const execEvents = args.events.filter((e) => e.execution_id === executionId);
  const execStart = execEvents.some((e) => e.kind === "exec.start");
  const executorStart = execEvents.some((e) => e.kind === "executor.start");
  const poolHandoff = typeof rec.pool_handoff === "object" && rec.pool_handoff !== null
    ? rec.pool_handoff as Record<string, unknown>
    : null;
  const recordedPoolHandoffReachability = typeof poolHandoff?.reachability === "string"
    ? poolHandoff.reachability
    : null;
  const poolHandoffEvent = [...execEvents].reverse().find(
    (event) => event.kind.startsWith("exec.pool-handoff."),
  );
  const eventPoolHandoffReachability = poolHandoffEvent?.kind.slice("exec.pool-handoff.".length) || null;
  const poolHandoffReachability = recordedPoolHandoffReachability ?? eventPoolHandoffReachability;
  const poolHandoffEventPresent = poolHandoffReachability !== null && execEvents.some(
    (event) => event.kind === `exec.pool-handoff.${poolHandoffReachability}`,
  );

  const retryEligible =
    typeof rec.retry_eligible === "boolean" ? (rec.retry_eligible as boolean) : null;
  const failoverTrail = typeof rec.failover_trail === "string" ? rec.failover_trail : null;
  const error = typeof rec.error === "string" ? rec.error : null;

  const evidence: CycleContractEvidence = {
    raw_status: rawStatus,
    lifecycle_state: state,
    completed_at_null: completedAtNull,
    pending_implementation: pendingImplementation,
    target_reached: hasReachedTarget(lifecycle),
    exec_start_present: execStart,
    executor_start_present: executorStart,
    failover_trail: failoverTrail,
    error,
    retry_eligible: retryEligible,
    pool_handoff_reachability: poolHandoffReachability,
    pool_handoff_event_present: poolHandoffEventPresent,
  };

  const base = {
    ticket_id: args.ticketId,
    execution_id: executionId,
    identifier: typeof rec.identifier === "string" ? rec.identifier : null,
    branch_name: typeof rec.branch_name === "string" ? (rec.branch_name as string) : null,
    matched: true,
    evidence,
  };

  // 1. Forbidden torn hand-off — always a contract violation.
  if (pendingImplementation) {
    return {
      ...base,
      outcome: "contract_violation",
      ok: false,
      needs_email: true,
      email_reason: "forbidden pending-implementation hand-off",
      reason: `record status is the forbidden torn state '${FORBIDDEN_RAW_STATUS}'`,
    };
  }

  // 2. Terminal outcome states resolved by the lifecycle model.
  if (isTerminalOutcomeState(state)) {
    if (state === "failed") {
      return {
        ...base,
        outcome: "failed",
        ok: false,
        needs_email: true,
        email_reason: "execution failed",
        reason: "executor chain exhausted; lifecycle terminal state 'failed'",
      };
    }
    // held / dry_run are terminal-but-not-error hand-offs; owned elsewhere
    // (hold-notify for held; dry_run should not occur in a --dry-run-free
    // production cycle but is harmless if it does).
    return {
      ...base,
      outcome: "parked",
      ok: true,
      needs_email: false,
      email_reason: null,
      reason: `lifecycle terminal outcome '${state}' — parked, not a cycle failure`,
    };
  }

  // 3. Pool hand-off (real SF-003 enqueue, not the forbidden torn status).
  if (state === "pool_enqueued") {
    const reachableHandoffs = new Set(["active_assignment", "reconcile_attempted", "parked_with_retry"]);
    if (!poolHandoffReachability || !reachableHandoffs.has(poolHandoffReachability) || !poolHandoffEventPresent) {
      return {
        ...base,
        outcome: "contract_violation",
        ok: false,
        needs_email: true,
        email_reason: "pool-enqueued record lacks reachable handoff evidence",
        reason: "lifecycle 'pool_enqueued' requires an active assignment, reconcile attempt, or visible retry park with matching flight evidence",
      };
    }
    return {
      ...base,
      outcome: "parked",
      ok: true,
      needs_email: false,
      email_reason: null,
      reason: `lifecycle 'pool_enqueued' — handoff '${poolHandoffReachability}' is proven; parked, not a cycle failure`,
    };
  }

  // 4. Delivery states — the successful post-execution outcomes.
  //    implementation_complete is the normal result of one cycle; verified+
  //    means downstream lanes advanced it further. All are success.
  if (isDeliveryState(state)) {
    // A claimed success must carry live-run journal evidence; a delivery state
    // with a torn completed_at or no executor.start is a contract violation.
    if (completedAtNull) {
      return {
        ...base,
        outcome: "contract_violation",
        ok: false,
        needs_email: true,
        email_reason: "delivery-state record with null completed_at (torn write)",
        reason: `state '${state}' but completed_at is null`,
      };
    }
    if (!executorStart) {
      return {
        ...base,
        outcome: "contract_violation",
        ok: false,
        needs_email: true,
        email_reason: "delivery-state record without executor.start journal evidence",
        reason: `state '${state}' but no executor.start in the flight journal`,
      };
    }
    return {
      ...base,
      outcome: "success",
      ok: true,
      needs_email: false,
      email_reason: null,
      reason: hasReachedTarget(lifecycle)
        ? `delivery target reached at '${state}'`
        : `implementation delivered — lifecycle '${state}', progressing toward '${lifecycle.delivery_target}'`,
    };
  }

  // 5. Anything else (still 'executing' after swarm-exec returned) is torn.
  return {
    ...base,
    outcome: "contract_violation",
    ok: false,
    needs_email: true,
    email_reason: "record is not in a post-execution state after swarm-exec returned",
    reason: `unexpected non-terminal lifecycle state '${state}' after swarm-exec returned`,
  };
}

// ─── Real readers (CLI seam) ────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();

/** Match records to a ticket by top-level ticket_id (linear_id) or identifier. */
export function recordsForTicket(
  all: ExecRecordLite[],
  opts: { ticketId?: string; identifier?: string; executionId?: string },
): ExecRecordLite[] {
  return all.filter((r) => {
    if (opts.executionId && r.execution_id === opts.executionId) return true;
    if (opts.ticketId && (r as Record<string, unknown>).ticket_id === opts.ticketId) return true;
    if (opts.identifier && r.identifier === opts.identifier) return true;
    return false;
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────────

async function writeFactoryShadow(
  cycleId: string,
  ticketId: string,
  verdict: CycleContractVerdict,
): Promise<void> {
  if (process.env.FACTORY_RECEIPT_SHADOW_MODE !== "shadow") return;
  try {
    const lane = require("./lane-utilization") as typeof import("./lane-utilization");
    const rows = lane.readRows().rows;
    const open = rows.some((row) => row.cycle_id === cycleId && row.phase === "open");
    const resolved = rows.some((row) => row.cycle_id === cycleId && row.phase === "outcome");
    if (!open || resolved) return;
    const shadow: typeof import("./run-receipt-shadow") = await import("./run-receipt-shadow");
    const completedAt = new Date().toISOString();
    shadow.completeShadowRun({
      producerId: "factory-cycle-contract",
      runClass: "factory_execution",
      idempotencyKey: `factory:${cycleId}:${ticketId}`,
      authority: shadow.shadowAuthority(),
      attemptStatus: verdict.ok ? "success" : "failure",
      error: verdict.ok ? null : verdict.reason,
      observedEffect: {
        adapterKind: "workspace-execution-record",
        sideEffectKind: "file_write",
        target: `execution:${verdict.execution_id ?? `missing:${cycleId}`}`,
        input: {
          cycle_id: cycleId,
          linear_id: ticketId,
          execution_id: verdict.execution_id,
          outcome: verdict.outcome,
          ok: verdict.ok,
        },
        authorityScope: "observe:workspace",
        source: {
          writer: "factory-cycle-contract",
          eventId: `cycle-contract:${cycleId}:${ticketId}:terminal`,
        },
        evidence: { evaluated_at: completedAt, matched: verdict.matched, durable: verdict.matched },
      },
      terminalOutcome: verdict.ok ? "success" : "failure",
      reasonCode: `cycle_contract_${verdict.outcome}`,
      artifacts: [{
        kind: "file",
        ref: `execution:${verdict.execution_id ?? `missing:${cycleId}`}`,
        hash: null,
        description: "Factory execution lifecycle record",
      }],
    });
  } catch {
    return;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ticketId = flag("--ticket-id");
  const identifier = flag("--identifier");
  const executionId = flag("--execution-id");
  const cycleId = flag("--cycle-id");

  if (!ticketId && !identifier && !executionId) {
    console.error(
      "usage: bun cycle-contract.ts (--ticket-id <linear_id> | --identifier <ZOU-###> | --execution-id <exec-...>)",
    );
    process.exit(2);
  }

  const all = readExecRecords(STATE_DIR);
  const matched = recordsForTicket(all, { ticketId, identifier, executionId });
  const verdict = evaluateCycleContract({
    ticketId: ticketId ?? identifier ?? executionId ?? "",
    records: matched,
    events: readFlightEvents({ days: 2 }),
  });

  const finish = () => {
    console.log(JSON.stringify(verdict));
    process.exit(verdict.needs_email ? 1 : 0);
  };
  if (process.env.FACTORY_RECEIPT_SHADOW_MODE === "shadow" && cycleId && ticketId) {
    void writeFactoryShadow(cycleId, ticketId, verdict).then(finish, finish);
  } else {
    finish();
  }
}
