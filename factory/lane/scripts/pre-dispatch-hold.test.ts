import { describe, expect, test } from "bun:test";
import { persistPreDispatchHold, type PreDispatchHoldRecord } from "./pre-dispatch-hold";

describe("pre-dispatch HOLD persistence", () => {
  test("falls back to an independent durable HOLD record when execution binding preservation throws", () => {
    const execution = { execution_id: "exec-r14", identifier: "ZOU-307", result_summary: "verified" };
    const holds: PreDispatchHoldRecord[] = [];
    const result = persistPreDispatchHold(execution, "incoming promotion context conflicts with persisted binding", {
      now: () => "2026-08-25T16:00:00.000Z",
      saveExecution: () => { throw new Error("incoming promotion context conflicts with the persisted execution binding"); },
      saveHold: (hold) => { holds.push(hold); },
    });

    expect(result).toEqual({
      mode: "hold_record",
      executionSaveError: "incoming promotion context conflicts with the persisted execution binding",
    });
    expect(execution.result_summary).toContain("SF010 HOLD");
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      execution_id: "exec-r14",
      tier: "high",
      notified: "none",
      reason: "promotion_context",
    });
    expect(holds[0].failure_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("does not create a second HOLD artifact when the execution record persists", () => {
    const execution = { execution_id: "exec-r14", identifier: "ZOU-307" };
    let executionSaves = 0;
    let holdSaves = 0;
    const result = persistPreDispatchHold(execution, "preflight drift", {
      now: () => "2026-08-25T16:00:00.000Z",
      saveExecution: () => { executionSaves++; },
      saveHold: () => { holdSaves++; },
    });

    expect(result).toEqual({ mode: "execution" });
    expect(executionSaves).toBe(1);
    expect(holdSaves).toBe(0);
  });
});
