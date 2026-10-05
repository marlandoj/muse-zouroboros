#!/usr/bin/env bun
/**
 * Hermetic selftest for cycle-contract.ts — pure evaluateCycleContract only,
 * no fs/network. Prints "cycle-contract self-test: N/N passed"; exit 1 on fail.
 *
 * Guards the ZOU-619 regression: a successful cycle now ends in the canonical
 * delivery state `implementation_complete` (renamed from legacy `complete`),
 * which the validator must classify as success/silent — NOT a Step-5 failure.
 */

import { evaluateCycleContract, recordsForTicket } from "./cycle-contract";
import type { ExecRecordLite } from "./flight-status";
import type { FlightEvent } from "./flight-recorder";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const DONE = "2026-07-13T23:00:47.564Z";
const START = "2026-07-13T22:52:00.000Z";

const rec = (over: Partial<ExecRecordLite>): ExecRecordLite => ({
  execution_id: "exec-cd07fb0e",
  identifier: "ZOU-619",
  status: "implementation_complete",
  started_at: START,
  completed_at: DONE,
  ...over,
});

const ev = (kind: string, execution_id = "exec-cd07fb0e"): FlightEvent => ({
  ts: START,
  execution_id,
  identifier: "ZOU-619",
  kind,
});

const startEvents = [ev("exec.start"), ev("executor.start")];

// 1. The ZOU-619 shape: implementation_complete + completed_at + executor.start
//    is the canonical successful cycle → silent, no email.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({})],
    events: startEvents,
  });
  check("implementation_complete → success", v.outcome === "success", v.outcome);
  check("success is ok", v.ok === true && v.needs_email === false);
  check("success carries no email reason", v.email_reason === null);
  check("success exposes lifecycle state", v.evidence.lifecycle_state === "implementation_complete");
}

// 2. Legacy raw status `complete` normalizes to implementation_complete → success.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "complete" })],
    events: startEvents,
  });
  check("legacy 'complete' still succeeds", v.outcome === "success" && !v.needs_email, v.outcome);
}

// 3. A delivery target met with contiguous proven evidence → success, target
//    flagged. The canonical lifecycle requires proven delivery evidence (not
//    just state rank) before target_reached is true, so the record must carry
//    evidence for its target state.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [
      rec({
        status: "implementation_complete",
        delivery_target: "implementation_complete",
        evidence: { implementation_complete: ["executor:codex"] },
      }),
    ],
    events: startEvents,
  });
  check("delivery target reached → success", v.outcome === "success" && !v.needs_email, v.outcome);
  check("target_reached evidence", v.evidence.target_reached === true);
}

// 4. Terminal failure → email failure evidence.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "failed", error: "executor chain exhausted" })],
    events: startEvents,
  });
  check("failed → failed outcome", v.outcome === "failed", v.outcome);
  check("failed needs email", v.needs_email === true && v.ok === false);
}

// 5. Forbidden torn hand-off `pending-implementation` (raw) → contract violation.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "pending-implementation" })],
    events: startEvents,
  });
  check("pending-implementation → contract_violation", v.outcome === "contract_violation", v.outcome);
  check("torn hand-off needs email", v.needs_email === true);
  check("torn hand-off flagged in evidence", v.evidence.pending_implementation === true);
}

// 6. held → parked (owned by hold-notify), silent.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "held" })],
    events: startEvents,
  });
  check("held → parked", v.outcome === "parked" && v.ok === true && !v.needs_email, v.outcome);
}

// 7. Evidence-free pool_enqueued is an orphan contract violation.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "pool_enqueued" })],
    events: startEvents,
  });
  check("evidence-free pool_enqueued → contract_violation", v.outcome === "contract_violation" && v.needs_email, v.outcome);
}

// 8. A persisted active assignment plus matching flight evidence is a valid handoff.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({
      status: "pool_enqueued",
      pool_handoff: {
        campaign_id: "ZOU-619",
        reachability: "active_assignment",
        assignment_id: "asg-ZOU-619-T1-a0",
      },
    })],
    events: [...startEvents, ev("exec.pool-handoff.active_assignment")],
  });
  check("proven pool_enqueued → parked", v.outcome === "parked" && !v.needs_email, v.outcome);
  check("pool handoff evidence exposed", v.evidence.pool_handoff_event_present && v.evidence.pool_handoff_reachability === "active_assignment");
}

// 9. dry_run → parked, silent.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "pool_enqueued" })],
    events: [...startEvents, ev("exec.pool-handoff.reconcile_attempted")],
  });
  check("append-only reconcile evidence recovers legacy pool record", v.outcome === "parked" && !v.needs_email, v.outcome);
  check("event-derived handoff evidence is exposed", v.evidence.pool_handoff_event_present && v.evidence.pool_handoff_reachability === "reconcile_attempted");
}

// 10. A visible retry park is a valid non-running handoff.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({
      status: "pool_enqueued",
      pool_handoff: { campaign_id: "ZOU-619", reachability: "parked_with_retry" },
    })],
    events: [...startEvents, ev("exec.pool-handoff.parked_with_retry")],
  });
  check("visible retry park satisfies pool handoff", v.outcome === "parked" && !v.needs_email, v.outcome);
}

// 11. dry_run → parked, silent.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "dry-run" })],
    events: startEvents,
  });
  check("dry_run → parked", v.outcome === "parked" && !v.needs_email, v.outcome);
}

// 12. Delivery state with a torn null completed_at → contract violation.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ completed_at: null })],
    events: startEvents,
  });
  check("null completed_at → contract_violation", v.outcome === "contract_violation", v.outcome);
  check("null completed_at flagged", v.evidence.completed_at_null === true && v.needs_email);
}

// 13. Delivery state without executor.start journal evidence → contract violation.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({})],
    events: [ev("exec.start")], // no executor.start
  });
  check("missing executor.start → contract_violation", v.outcome === "contract_violation", v.outcome);
  check("missing evidence needs email", v.needs_email === true && v.evidence.executor_start_present === false);
}

// 14. No record for the dispatched ticket → email (swarm-exec produced nothing).
{
  const v = evaluateCycleContract({ ticketId: "ZOU-619", records: [], events: [] });
  check("no_record outcome", v.outcome === "no_record" && v.needs_email === true, v.outcome);
  check("no_record not matched", v.matched === false && v.execution_id === null);
}

// 15. Still 'executing' after swarm-exec returned → torn contract violation.
{
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [rec({ status: "executing", completed_at: null })],
    events: startEvents,
  });
  check("still executing → contract_violation", v.outcome === "contract_violation", v.outcome);
  check("still executing needs email", v.needs_email === true);
}

// 16. Freshest record wins when swarm-exec left more than one row for a ticket.
{
  const stale = rec({ execution_id: "exec-old", status: "failed", started_at: "2026-07-13T20:00:00.000Z" });
  const fresh = rec({ execution_id: "exec-new", started_at: "2026-07-13T22:52:00.000Z" });
  const v = evaluateCycleContract({
    ticketId: "ZOU-619",
    records: [stale, fresh],
    events: [ev("exec.start", "exec-new"), ev("executor.start", "exec-new")],
  });
  check("freshest record picked", v.execution_id === "exec-new" && v.outcome === "success", v.outcome);
}

// 17. recordsForTicket matches by execution_id / ticket_id / identifier.
{
  const all: ExecRecordLite[] = [
    rec({ execution_id: "exec-a", identifier: "ZOU-1", ticket_id: "lin-1" } as Partial<ExecRecordLite>),
    rec({ execution_id: "exec-b", identifier: "ZOU-619", ticket_id: "lin-619" } as Partial<ExecRecordLite>),
  ];
  check("match by identifier", recordsForTicket(all, { identifier: "ZOU-619" }).length === 1);
  check("match by ticket_id", recordsForTicket(all, { ticketId: "lin-1" })[0]?.execution_id === "exec-a");
  check("match by execution_id", recordsForTicket(all, { executionId: "exec-b" })[0]?.identifier === "ZOU-619");
  check("no spurious match", recordsForTicket(all, { identifier: "ZOU-999" }).length === 0);
}

console.log(`cycle-contract self-test: ${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
