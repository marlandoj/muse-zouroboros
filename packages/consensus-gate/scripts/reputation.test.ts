import { describe, expect, test } from "bun:test";
import { calculateJoinHealth, type OutcomeRecord } from "./reputation";

describe("reputation join health", () => {
  test("reports matched and unmatched trace IDs with source counts", () => {
    const outcomes: OutcomeRecord[] = [
      { trace_id: "factory:1", outcome: "success", source: "factory", timestamp: "2026-07-17T00:00:00.000Z" },
      { trace_id: "fixture:1", outcome: "failure", source: "test", timestamp: "2026-07-17T00:00:01.000Z" },
    ];
    const health = calculateJoinHealth([
      { trace_id: "factory:1" },
      { trace_id: "factory:2" },
      {},
    ], outcomes);

    expect(health).toEqual({
      consensus_rows: 3,
      traced_gate_rows: 2,
      outcome_rows: 2,
      matched_unique_trace_ids: 1,
      join_status: "failed",
      pending_gate_ids: ["factory:2"],
      unmatched_gate_ids: ["factory:2"],
      unmatched_outcome_ids: ["fixture:1"],
      source_counts: { factory: 1, test: 1 },
    });
  });

  test("deduplicates trace IDs while retaining row counts", () => {
    const duplicate: OutcomeRecord = {
      trace_id: "factory:1",
      outcome: "success",
      source: "factory",
      timestamp: "2026-07-17T00:00:00.000Z",
    };
    const health = calculateJoinHealth([{ trace_id: "factory:1" }, { trace_id: "factory:1" }], [duplicate, duplicate]);
    expect(health.traced_gate_rows).toBe(2);
    expect(health.outcome_rows).toBe(2);
    expect(health.matched_unique_trace_ids).toBe(1);
  });

  test("classifies gate-only traces as pending, not failed", () => {
    const health = calculateJoinHealth([{ trace_id: "factory:pending" }], []);

    expect(health.join_status).toBe("pending");
    expect(health.pending_gate_ids).toEqual(["factory:pending"]);
    expect(health.unmatched_outcome_ids).toEqual([]);
  });
});
