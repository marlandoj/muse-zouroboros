import { describe, expect, test } from "bun:test";
import {
  classifyFailure,
  countsTowardHalt,
  dispositionFor,
  formatVerdict,
  isBlindRetryable,
  isDeterministic,
} from "./failure-policy";

/** The literal error the ZBRE run retried unchanged across four tickets. */
const ROLE_CHAIN_DEFECT =
  "consensus gate failed: JSON.parse: Unrecognized token '`' in LINEUP_ROLE_CHAINS";

describe("failure policy", () => {
  test("classifies the ZBRE role-chain defect as configuration_error and refuses blind retry", () => {
    const verdict = classifyFailure({ reason_code: "gate_error", message: ROLE_CHAIN_DEFECT });
    expect(verdict.failure_class).toBe("configuration_error");
    expect(verdict.disposition).toBe("repair");
    expect(isBlindRetryable(verdict.failure_class)).toBe(false);
    expect(verdict.subject).toBe("LINEUP_ROLE_CHAINS");
  });

  test("classifies a stub-scan rejection as a deterministic quality rejection (ZOU-1103)", () => {
    const verdict = classifyFailure({
      reason_code: "stub_rejected",
      message: "stub scan rejected 1 finding(s): src/x.ts:2 stub-body (function body is only `return;`)",
      stage: "consensus",
    });
    expect(verdict.failure_class).toBe("quality_rejection");
    expect(verdict.disposition).toBe("repair");
    expect(isBlindRetryable(verdict.failure_class)).toBe(false);
  });

  test("gives the same defect a stable fingerprint across tickets and executions", () => {
    const first = classifyFailure({
      message: "ZOU-929 exec-dc65b3e3: Unrecognized token '`' in LINEUP_ROLE_CHAINS at 2026-07-24T10:00:00Z",
    });
    const second = classifyFailure({
      message: "ZOU-930 exec-8f36d6b4: Unrecognized token '`' in LINEUP_ROLE_CHAINS at 2026-07-24T14:22:11Z",
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(countsTowardHalt(first)).toBe(true);
  });

  test("a configuration defect outranks a transport signature in the same message", () => {
    // A malformed policy can surface downstream as a timeout. Retrying that
    // would repeat the original defect, so the deterministic class must win.
    const verdict = classifyFailure({
      message: "request timed out after 30000ms; LINEUP_PIN_AGGREGATOR must contain exactly one model id",
    });
    expect(verdict.failure_class).toBe("configuration_error");
    expect(isBlindRetryable(verdict.failure_class)).toBe(false);
  });

  test("classifies execution transport failures as transient", () => {
    for (const message of [
      "executor chain exhausted (executor:codex=fail(12s):transport:503 Service Unavailable)",
      "executor chain exhausted (executor:codex=throw:transport:ACP session timed out after 30000ms)",
      "executor chain exhausted (executor:codex=fail(1s):transport:socket hang up: ECONNRESET)",
    ]) {
      const verdict = classifyFailure({ stage: "executor", message });
      expect(verdict.failure_class).toBe("transient");
      expect(isBlindRetryable(verdict.failure_class)).toBe(true);
      expect(countsTowardHalt(verdict)).toBe(false);
    }
  });

  test("does not infer transport from arbitrary executor output containing a 5xx number", () => {
    const verdict = classifyFailure({
      stage: "executor",
      message: "executor chain exhausted (executor:codex=fail(2s):execution:unit test expected status 500 but got 200)",
    });
    expect(verdict.failure_class).not.toBe("transient");
  });

  test("keeps provider rotation failures separate from execution replay", () => {
    for (const message of [
      "openrouter rate-limit exceeded",
      "consensus gate emitted no machine result",
    ]) {
      expect(classifyFailure({ message }).failure_class).toBe("provider_unavailable");
    }
  });

  test("treats auth and routing failures as provider_unavailable so re-lineup can route around", () => {
    const verdict = classifyFailure({ message: "API error: 401 Unauthorized from opencode" });
    expect(verdict.failure_class).toBe("provider_unavailable");
    expect(verdict.disposition).toBe("retry");
  });

  test("maps gate reason codes to quality classes", () => {
    expect(classifyFailure({ reason_code: "quality_rejected" }).failure_class).toBe("quality_rejection");
    expect(classifyFailure({ reason_code: "quality_rejected" }).disposition).toBe("repair");
    expect(classifyFailure({ reason_code: "quality_split" }).failure_class).toBe("quality_split");
    expect(classifyFailure({ reason_code: "quality_split" }).disposition).toBe("escalate");
    expect(classifyFailure({ reason_code: "vendor_unavailable" }).failure_class).toBe("provider_unavailable");
  });

  test("names the offending policy field even when the wording is novel", () => {
    const verdict = classifyFailure({ message: "FACTORY_MODEL_CHAIN produced an empty resolution set" });
    expect(verdict.failure_class).toBe("configuration_error");
    expect(verdict.subject).toBe("FACTORY_MODEL_CHAIN");
  });

  test("routes stage-attributed failures to their own classes", () => {
    expect(classifyFailure({ stage: "shipping", message: "merge queue rejected the branch" }).failure_class)
      .toBe("shipping_failure");
    expect(classifyFailure({ stage: "executor", message: "harness exited non-zero" }).failure_class)
      .toBe("executor_failure");
  });

  test("an unclassified failure escalates rather than retrying silently", () => {
    const verdict = classifyFailure({ message: "something entirely novel happened" });
    expect(verdict.failure_class).toBe("unknown");
    expect(verdict.disposition).toBe("escalate");
    expect(isBlindRetryable(verdict.failure_class)).toBe(false);
    expect(isDeterministic(verdict.failure_class)).toBe(true);
  });

  test("disposition table covers every class and only retry is blind-retryable", () => {
    expect(dispositionFor("configuration_error")).toBe("repair");
    expect(dispositionFor("transient")).toBe("retry");
    expect(formatVerdict(classifyFailure({ message: ROLE_CHAIN_DEFECT })))
      .toContain("configuration_error/repair [LINEUP_ROLE_CHAINS]");
  });
});
