import { describe, expect, test } from "bun:test";
import { classifyCascadeFailure } from "./coding-cascade";

const blockingReview = (personaReviews: {
  mode: string;
  pass: boolean;
  summary: string;
  invoked_count?: number;
}) => ({
  blocking: true,
  deterministic: { pass: true, summary: "git diff --check passed" },
  consensus: null,
  persona_reviews: personaReviews,
});

describe("classifyCascadeFailure persona review classification (ZOU-1576 defect 3)", () => {
  test("a persona gate that blocked with no reviewer invoked is retryable transport", () => {
    const failure = classifyCascadeFailure({
      cause: "worker_failure",
      detail: "The operation was aborted.",
      review: blockingReview({
        mode: "enforce",
        pass: false,
        summary: "required persona review failed",
        invoked_count: 0,
      }),
    });
    expect(failure).toEqual({
      kind: "transport",
      retryable: true,
      detail: "The operation was aborted.",
    });
  });

  test("a persona gate that actually reviewed stays terminal governance", () => {
    const failure = classifyCascadeFailure({
      cause: "worker_failure",
      review: blockingReview({
        mode: "enforce",
        pass: false,
        summary: "4/4 reviewers returned fail",
        invoked_count: 4,
      }),
    });
    expect(failure).toEqual({
      kind: "governance",
      retryable: false,
      detail: "4/4 reviewers returned fail",
    });
  });

  test("an absent invoked_count keeps the pre-existing terminal classification", () => {
    const failure = classifyCascadeFailure({
      cause: "worker_failure",
      review: blockingReview({ mode: "enforce", pass: false, summary: "persona diversity review did not pass" }),
    });
    expect(failure.kind).toBe("governance");
    expect(failure.retryable).toBe(false);
  });

  test("deterministic and consensus failures are unaffected by the reviewer count", () => {
    const mechanical = classifyCascadeFailure({
      cause: "worker_failure",
      review: {
        blocking: true,
        deterministic: { pass: false, summary: "trailing whitespace" },
        consensus: null,
        persona_reviews: { mode: "enforce", pass: false, summary: "skipped", invoked_count: 0 },
      },
    });
    expect(mechanical).toEqual({ kind: "mechanical_validation", retryable: true, detail: "trailing whitespace" });

    const governance = classifyCascadeFailure({
      cause: "worker_failure",
      review: {
        blocking: true,
        deterministic: { pass: true, summary: "clean" },
        consensus: { pass: false, summary: "consensus rejected the change" },
        persona_reviews: { mode: "enforce", pass: false, summary: "skipped", invoked_count: 0 },
      },
    });
    expect(governance).toEqual({ kind: "governance", retryable: false, detail: "consensus rejected the change" });
  });
});

describe("classifyCascadeFailure dispatch kind (F-003)", () => {
  test("a dispatch-time failure is retryable", () => {
    const failure = classifyCascadeFailure({
      cause: "dispatch",
      detail: "harness never started; failing the stale claim",
    });
    expect(failure).toEqual({
      kind: "dispatch",
      retryable: true,
      detail: "harness never started; failing the stale claim",
    });
  });
});
