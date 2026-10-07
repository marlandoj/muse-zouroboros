import { describe, expect, test } from "bun:test";
import {
  decideProfileEscalation,
  isConsensusSnapshot,
  isValidRoutingPolicyOptions,
  type ConsensusSnapshot,
} from "./profile-escalation-policy";

const options = { minConfidence: 0.8 };

function snapshot(overrides: Partial<ConsensusSnapshot> = {}): ConsensusSnapshot {
  return {
    status: "passed",
    consensus: { unanimous: true, confidence: 0.9 },
    ...overrides,
  };
}

describe("decideProfileEscalation", () => {
  test("keeps a unanimous high-confidence Fast result on Fast", () => {
    expect(decideProfileEscalation(snapshot(), options)).toEqual({
      escalate: false,
      trigger: "none",
      confidence: 0.9,
      minConfidence: 0.8,
    });
  });

  test("does not escalate confidence exactly at the threshold", () => {
    const input = snapshot({ consensus: { unanimous: true, confidence: 0.8 } });
    expect(decideProfileEscalation(input, options).trigger).toBe("none");
  });

  test("escalates a non-unanimous result as dissent", () => {
    const input = snapshot({ consensus: { unanimous: false, confidence: 0.95 } });
    expect(decideProfileEscalation(input, options)).toMatchObject({ escalate: true, trigger: "dissent" });
  });

  test("escalates status=escalate as a split", () => {
    const input = snapshot({ status: "escalate", consensus: { unanimous: false, confidence: 0.95 } });
    expect(decideProfileEscalation(input, options)).toMatchObject({ escalate: true, trigger: "split" });
  });

  test("escalates confidence below the threshold", () => {
    const input = snapshot({ consensus: { unanimous: true, confidence: 0.79 } });
    expect(decideProfileEscalation(input, options)).toMatchObject({ escalate: true, trigger: "low_confidence" });
  });

  test("classifies an execution failure as panel failure", () => {
    expect(decideProfileEscalation({ executionFailure: true }, options)).toEqual({
      escalate: true,
      trigger: "panel_failure",
      confidence: null,
      minConfidence: 0.8,
    });
  });

  test("fails closed on malformed output", () => {
    const malformed = { status: "passed", consensus: { unanimous: true, confidence: "high" } } as unknown as ConsensusSnapshot;
    expect(decideProfileEscalation(malformed, options)).toMatchObject({
      escalate: true,
      trigger: "malformed",
      confidence: null,
    });
  });

  test("applies panel failure > malformed > split > dissent > low-confidence precedence", () => {
    const panelFailure = { executionFailure: true, status: "unknown" } as unknown as ConsensusSnapshot;
    expect(decideProfileEscalation(panelFailure, options).trigger).toBe("panel_failure");

    const malformedSplit = { status: "escalate", consensus: { unanimous: false } } as unknown as ConsensusSnapshot;
    expect(decideProfileEscalation(malformedSplit, options).trigger).toBe("malformed");

    const split = snapshot({ status: "escalate", consensus: { unanimous: false, confidence: 0.1 } });
    expect(decideProfileEscalation(split, options).trigger).toBe("split");

    const dissent = snapshot({ consensus: { unanimous: false, confidence: 0.1 } });
    expect(decideProfileEscalation(dissent, options).trigger).toBe("dissent");
  });

  test("rejects invalid policy thresholds", () => {
    expect(() => decideProfileEscalation(snapshot(), { minConfidence: 1.1 })).toThrow(RangeError);
    expect(() => decideProfileEscalation(snapshot(), { minConfidence: Number.NaN })).toThrow(RangeError);
  });
});

describe("profile escalation validation", () => {
  test("validates snapshots without mutating them", () => {
    const input = snapshot();
    expect(isConsensusSnapshot(input)).toBe(true);
    expect(input).toEqual(snapshot());
    expect(isConsensusSnapshot(null)).toBe(false);
    expect(isConsensusSnapshot({ status: "validating", consensus: { unanimous: true, confidence: 0.9 } })).toBe(false);
  });

  test("validates policy option bounds", () => {
    expect(isValidRoutingPolicyOptions({ minConfidence: 0 })).toBe(true);
    expect(isValidRoutingPolicyOptions({ minConfidence: 1 })).toBe(true);
    expect(isValidRoutingPolicyOptions({ minConfidence: -0.1 })).toBe(false);
    expect(isValidRoutingPolicyOptions({ minConfidence: Infinity })).toBe(false);
  });
});
