import { describe, expect, test } from "bun:test";
import {
  PlanConsensus,
  classifyVerdictIssues,
  detectPlanFormat,
  toPlanReviewResult,
  type PlanVendorCaller,
} from "./plan-consensus-gate";

function caller(verdicts: Array<{ pass: boolean; issues?: string[] }>): PlanVendorCaller {
  let index = 0;
  return async (role) => {
    const verdict = verdicts[index++] ?? verdicts.at(-1) ?? { pass: true };
    const model = typeof role === "string" ? role : role.primary;
    return {
      model,
      pass: verdict.pass,
      issues: verdict.issues ?? [],
      confidence: 0.9,
      latencyMs: 1,
    };
  };
}

describe("plan input handling", () => {
  test("detects YAML, JSON, and Markdown without code parsing", () => {
    expect(detectPlanFormat("id: plan-1\ntasks: []")).toBe("yaml");
    expect(detectPlanFormat('{"id":"plan-1"}')).toBe("json");
    expect(detectPlanFormat("# Plan\n\nDo the work.")).toBe("markdown");
  });

  test("classifies provider failures ahead of pass/fail", () => {
    expect(classifyVerdictIssues(["Call failed: The operation was aborted."], false)).toBe("timeout");
    expect(classifyVerdictIssues(["Empty response from vendor"], false)).toBe("empty_output");
    expect(classifyVerdictIssues(["Missing rollback procedure"], false)).toBe("substantive_rejection");
  });
});

describe("PlanConsensus", () => {
  test("excludes provider failures from a passing substantive consensus", async () => {
    const gate = new PlanConsensus({
      models: ["model-a", "model-b", "model-c"],
      _vendorCaller: caller([
        { pass: true },
        { pass: true },
        { pass: false, issues: ["API error: upstream unavailable"] },
      ]),
    });
    const result = await gate.evaluate("id: plan-1");
    expect(result.status).toBe("passed");
    expect(result.findings).toEqual([]);
    const providerResult = toPlanReviewResult(result);
    expect(providerResult.decision).toBe("passed");
    expect(providerResult.verdicts[2]?.finding_type).toBe("provider_failure");
    expect(providerResult.verdicts[2]?.pass).toBeNull();
  });

  test("returns unavailable when every seat has infrastructure failure", async () => {
    const gate = new PlanConsensus({
      models: ["model-a", "model-b"],
      _vendorCaller: caller([
        { pass: false, issues: ["API error: upstream unavailable"] },
        { pass: false, issues: ["Empty response from vendor"] },
      ]),
    });
    const result = await gate.evaluate("id: plan-1");
    expect(result.status).toBe("escalate");
    expect(toPlanReviewResult(result).decision).toBe("unavailable");
  });

  test("preserves substantive claims as typed findings", async () => {
    const gate = new PlanConsensus({
      models: ["model-a"],
      _vendorCaller: caller([{ pass: false, issues: ["Rollback is not measurable"] }]),
    });
    const result = await gate.evaluate("id: plan-1");
    const providerResult = toPlanReviewResult(result);
    expect(providerResult.decision).toBe("rejected");
    expect(providerResult.verdicts[0]?.finding_type).toBe("substantive");
    expect(providerResult.verdicts[0]?.claims[0]?.claim).toBe("Rollback is not measurable");
  });
});
