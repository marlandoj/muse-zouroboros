import { describe, expect, test } from "bun:test";
import { evaluateHoldouts, parseHoldoutScenarios } from "./factory-holdouts";
import { parseSeedContractDocument } from "./pool-queue";
import { attachHoldoutEvaluation } from "./factory-consensus";

describe("factory hidden holdouts", () => {
  const holdouts = parseHoldoutScenarios([
    { id: "H1", expect: "regression remains fixed", rationale: "negative regression", weight: 0.5 },
    { id: "H2", expect: "executor never sees this text", rationale: "anti-Goodhart", weight: 0.5 },
  ], "fixture");

  test("parses weighted scenarios and rejects malformed contracts", () => {
    expect(holdouts.map((item) => item.weight)).toEqual([0.5, 0.5]);
    expect(() => parseHoldoutScenarios([{ id: "H", expect: "x", rationale: "y", weight: 0 }], "bad")).toThrow();
    expect(() => parseHoldoutScenarios([{ id: "H", expect: "x", rationale: "y" }, { id: "H", expect: "z", rationale: "y" }], "bad")).toThrow("duplicate");
  });

  test("scores public and holdout criteria independently and together", () => {
    const result = evaluateHoldouts({
      mode: "shadow",
      holdouts,
      publicOutcomes: [{ id: "P1", passed: true, weight: 1 }, { id: "P2", passed: false, weight: 1 }],
      holdoutOutcomes: [{ id: "H1", passed: true, weight: 0.5 }, { id: "H2", passed: true, weight: 0.5 }],
      threshold: 0.65,
    });
    expect(result.public_score).toBe(0.5);
    expect(result.holdout_score).toBe(1);
    expect(result.combined_score).toBeCloseTo(2 / 3);
    expect(result.would_pass).toBe(true);
    expect(result.enforced).toBe(false);
    expect(result.holdout_digest).toHaveLength(64);
  });

  test("fails closed when holdout outcomes are incomplete", () => {
    const result = evaluateHoldouts({
      mode: "shadow",
      holdouts,
      publicOutcomes: [{ id: "P1", passed: true, weight: 1 }],
      holdoutOutcomes: [{ id: "H1", passed: true, weight: 0.5 }],
    });
    expect(result.would_pass).toBe(false);
  });

  test("seed parsing keeps holdout text outside every executor work item", () => {
    const contract = parseSeedContractDocument({
      tasks: [{ id: "T1", name: "Implement", description: "public brief", deps: [] }],
      holdout_scenarios: [{
        id: "H-secret",
        expect: "SECRET_NEGATIVE_REGRESSION_TEXT",
        rationale: "executor-hidden",
        weight: 0.5,
      }],
    }, "fixture");
    expect(JSON.stringify(contract.tasks)).not.toContain("SECRET_NEGATIVE_REGRESSION_TEXT");
    expect(contract.holdout_scenarios[0]?.expect).toBe("SECRET_NEGATIVE_REGRESSION_TEXT");
  });

  test("consensus sidecar carries public, holdout, and combined scores", () => {
    const evaluation = evaluateHoldouts({
      mode: "shadow",
      holdouts,
      publicOutcomes: [{ id: "P1", passed: true, weight: 1 }],
      holdoutOutcomes: holdouts.map((item) => ({ id: item.id, passed: true, weight: item.weight })),
    });
    const record = attachHoldoutEvaluation({
      status: "passed",
      gate_status: "passed",
      gate_id: "gate-1",
      trace_id: "trace-1",
      lineup: null,
      serving_providers: [],
      chain_attempts: [],
      dissent: null,
      reason_code: null,
      reason: null,
      attempts: [],
    }, evaluation);
    expect(record.holdout_evaluation).toMatchObject({
      mode: "shadow",
      public_score: 1,
      holdout_score: 1,
      combined_score: 1,
      enforced: false,
    });
  });
});
