import { factoryStateRoot } from "./factory-state-root";
import { readFlightEvents, type FlightEvent } from "./flight-recorder";
import { readExecRecords, type ExecRecordLite } from "./flight-status";
import { evaluateCycleContract, recordsForTicket } from "./cycle-contract";
import { readRows, type LaneRow } from "./lane-utilization";
import {
  createCycleObservation,
  recordParityComparison,
  recordParityHold,
  type ConveyorParityComparison,
  type ConveyorParityHold,
} from "./factory-conveyor-parity";
import { ConveyorRunnerError, canonicalJson, sha256 } from "./factory-conveyor-runner";

export const CONVEYOR_OBSERVER_MODE = "parity_shadow" as const;

export type ConveyorObserverResult =
  | { status: "structural_projection"; comparison: ConveyorParityComparison }
  | { status: "held_unmeasured"; hold: ConveyorParityHold };

export interface ConveyorObserverInput {
  cycleId: string;
  incumbentVersion: string;
  runnerVersion: string;
  laneRows: LaneRow[];
  records: ExecRecordLite[];
  events: FlightEvent[];
  parityStateDir?: string;
  observedAt?: string;
}

const GIT_SHA = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^rel-[0-9a-f]{24}$/;

function exactLaneRows(rows: LaneRow[], cycleId: string): { open: LaneRow | null; outcome: LaneRow | null } {
  const cycleRows = rows.filter((row) => row.cycle_id === cycleId);
  return {
    open: [...cycleRows].reverse().find((row) => row.phase === "open") ?? null,
    outcome: [...cycleRows].reverse().find((row) => row.phase === "outcome") ?? null,
  };
}

function significantActualSideEffects(executionId: string, events: FlightEvent[]): string[] {
  const keys = [`execution/${executionId}`];
  for (const kind of ["exec.start", "executor.start"] as const) {
    if (events.some((event) => event.execution_id === executionId && event.kind === kind)) {
      keys.push(`journal/${kind}/${executionId}`);
    }
  }
  return keys;
}

function expectedSuccessfulSideEffects(executionId: string): string[] {
  return [
    `execution/${executionId}`,
    `journal/exec.start/${executionId}`,
    `journal/executor.start/${executionId}`,
  ];
}

function hold(input: ConveyorObserverInput, reasonCode: string, evidence: unknown): ConveyorObserverResult {
  return {
    status: "held_unmeasured",
    hold: recordParityHold({
      cycleKey: input.cycleId,
      reasonCode,
      evidenceHash: sha256(canonicalJson(evidence)),
      stateDir: input.parityStateDir,
      observedAt: input.observedAt,
    }),
  };
}

export function observeConveyorParity(input: ConveyorObserverInput): ConveyorObserverResult {
  if (!GIT_SHA.test(input.incumbentVersion)) throw new ConveyorRunnerError("observer_incumbent_version", "observer requires an exact incumbent commit");
  if (!RELEASE_ID.test(input.runnerVersion)) throw new ConveyorRunnerError("observer_runner_version", "observer requires an exact runner release id");
  const lane = exactLaneRows(input.laneRows, input.cycleId);
  const laneEvidence = { open: lane.open, outcome: lane.outcome };
  if (!lane.open || !lane.outcome) return hold(input, "incomplete_lane_evidence", laneEvidence);
  if (lane.outcome.reason !== "dispatched") {
    return hold(input, `unsupported_${lane.outcome.reason ?? "unresolved"}`, laneEvidence);
  }
  if (!lane.outcome.ticket_id || !lane.outcome.execution_id) {
    return hold(input, "incomplete_dispatch_identity", laneEvidence);
  }

  const matched = recordsForTicket(input.records, {
    ticketId: lane.outcome.ticket_id,
    identifier: lane.outcome.identifier ?? undefined,
    executionId: lane.outcome.execution_id,
  }).filter((record) => record.execution_id === lane.outcome!.execution_id);
  const verdict = evaluateCycleContract({
    ticketId: lane.outcome.ticket_id,
    records: matched,
    events: input.events,
  });
  if (!verdict.execution_id) return hold(input, "missing_execution_record", { lane: laneEvidence, verdict });
  if (verdict.outcome === "parked") return hold(input, "unsupported_parked_dispatch", { lane: laneEvidence, verdict });

  const actualSideEffects = significantActualSideEffects(verdict.execution_id, input.events);
  const expectedSideEffects = expectedSuccessfulSideEffects(verdict.execution_id);
  const incumbent = createCycleObservation({
    source: "incumbent",
    cycleKey: input.cycleId,
    observedVersion: input.incumbentVersion,
    decision: "dispatched",
    ticketId: lane.outcome.ticket_id,
    identifier: lane.outcome.identifier,
    dispatchCount: 1,
    sideEffectKeys: actualSideEffects,
    evidenceHash: sha256(canonicalJson(laneEvidence)),
  });
  const runner = createCycleObservation({
    source: "runner",
    cycleKey: input.cycleId,
    observedVersion: input.runnerVersion,
    decision: verdict.outcome === "success" ? "dispatched" : "execution_failed",
    ticketId: verdict.ticket_id,
    identifier: verdict.identifier,
    dispatchCount: 1,
    sideEffectKeys: expectedSideEffects,
    evidenceHash: sha256(canonicalJson({ verdict, expected_side_effects: expectedSideEffects })),
  });
  return {
    status: "structural_projection",
    comparison: recordParityComparison({
      incumbent,
      runner,
      stateDir: input.parityStateDir,
      comparedAt: input.observedAt,
    }),
  };
}

export function observeConveyorParityCycle(
  cycleId: string,
  env: Record<string, string | undefined> = process.env,
): ConveyorObserverResult | null {
  const mode = env.FACTORY_CONVEYOR_RUNNER_MODE ?? "off";
  if (mode === "off") return null;
  if (mode !== CONVEYOR_OBSERVER_MODE) throw new ConveyorRunnerError("observer_mode_invalid", `unsupported conveyor runner mode ${mode}`);
  const incumbentVersion = env.FACTORY_CONVEYOR_INCUMBENT_COMMIT;
  const runnerVersion = env.FACTORY_CONVEYOR_RUNNER_RELEASE_ID;
  if (!incumbentVersion || !runnerVersion) throw new ConveyorRunnerError("observer_identity_missing", "parity observer identity is incomplete");
  return observeConveyorParity({
    cycleId,
    incumbentVersion,
    runnerVersion,
    laneRows: readRows().rows,
    records: readExecRecords(factoryStateRoot()),
    events: readFlightEvents({ days: 2 }),
  });
}
