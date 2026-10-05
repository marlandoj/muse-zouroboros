import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LifecycleTransitionError,
  createExecutionLifecycle,
  hasProvenDeliveryState,
  hasReachedTarget,
  isExecutionRecordFileName,
  isInFlightExecution,
  isTerminalExecution,
  normalizeExecutionLifecycle,
  recordSurvivabilityCheck,
  transitionExecutionLifecycle,
  wouldDowngradeDelivery,
} from "./execution-lifecycle";

const T0 = "2026-07-13T04:00:00.000Z";
const T1 = "2026-07-13T04:01:00.000Z";

const proof = (reference: string, recorded_at = T1) => ({
  kind: "test",
  reference,
  recorded_at,
});

describe("canonical lifecycle transitions", () => {
  test("accepts the ordered evidence-bearing delivery path", () => {
    let lifecycle = createExecutionLifecycle("accepted", T0);
    for (const state of [
      "implementation_complete",
      "verified",
      "pr_ready",
      "ci_green",
      "merged",
      "deployed",
      "accepted",
    ] as const) {
      lifecycle = transitionExecutionLifecycle(lifecycle, state, proof(`${state}:1`), {
        now: new Date(Date.parse(lifecycle.state_updated_at) + 60_000).toISOString(),
      });
    }

    expect(lifecycle.state).toBe("accepted");
    expect(lifecycle.target_reached).toBe(true);
    expect(lifecycle.evidence.accepted).toHaveLength(1);
    expect(isTerminalExecution(lifecycle)).toBe(true);
    expect(isInFlightExecution(lifecycle)).toBe(false);
  });

  test("fails closed on skipped and backward transitions without mutating input", () => {
    const original = createExecutionLifecycle("accepted", T0);
    const before = JSON.stringify(original);

    expect(() => transitionExecutionLifecycle(original, "verified", proof("verify:1"), { now: T1 }))
      .toThrow(LifecycleTransitionError);
    expect(JSON.stringify(original)).toBe(before);

    const implemented = transitionExecutionLifecycle(
      original,
      "implementation_complete",
      proof("commit:1"),
      { now: T1 },
    );
    expect(() => transitionExecutionLifecycle(implemented, "executing", proof("backward:1")))
      .toThrow(LifecycleTransitionError);
  });

  test("requires contiguous proof and does not skip deployment", () => {
    const unproven = normalizeExecutionLifecycle({
      state: "implementation_complete",
      delivery_target: "verified",
      state_updated_at: T0,
      evidence: {},
    }, { now: T1 });
    expect(() => transitionExecutionLifecycle(unproven, "verified", proof("verify:unproven"), { now: T1 }))
      .toThrow("lacks contiguous evidence");

    const merged = normalizeExecutionLifecycle({
      state: "merged",
      delivery_target: "accepted",
      state_updated_at: T1,
      evidence: {
        implementation_complete: [proof("commit:1", T0)],
        verified: [proof("verify:1", T0)],
        pr_ready: [proof("pr:1", T0)],
        ci_green: [proof("ci:1", T0)],
        merged: [proof("merge:1", T1)],
      },
    }, { now: T1 });
    expect(() => transitionExecutionLifecycle(merged, "accepted", proof("accept:1"), { now: T1 }))
      .toThrow("transition is not allowed");
  });

  test("terminal outcomes remain distinct from accepted delivery", () => {
    const failed = transitionExecutionLifecycle(
      createExecutionLifecycle("implementation_complete", T0),
      "failed",
      proof("error:1"),
      { now: T1 },
    );

    expect(failed.state).toBe("failed");
    expect(failed.target_reached).toBe(false);
    expect(isTerminalExecution(failed)).toBe(true);
  });

  test("post-merge defects are survivability outcomes, not execution rewrites", () => {
    const merged = normalizeExecutionLifecycle({
      state: "merged",
      delivery_target: "accepted",
      state_updated_at: T1,
      evidence: { merged: [proof("pr:42", T1)] },
    });

    expect(() => transitionExecutionLifecycle(merged, "failed", proof("defect:1")))
      .toThrow(LifecycleTransitionError);
    expect(merged.post_merge_survivability).toBe("pending");
  });
});

describe("legacy normalization and targets", () => {
  test("normalizes legacy complete conservatively unless evidence proves a later state", () => {
    const legacy = normalizeExecutionLifecycle({
      status: "complete",
      stage: "complete",
      completed_at: T0,
    }, { delivery_target: "accepted", now: T1 });
    expect(legacy.state).toBe("implementation_complete");
    expect(legacy.target_reached).toBe(false);

    const provenMerged = normalizeExecutionLifecycle({
      status: "complete",
      completed_at: T0,
      delivery_target: "merged",
      evidence: {
        implementation_complete: [proof("commit:1", T0)],
        verified: [proof("verification:1", T0)],
        pr_ready: [proof("pr-ready:42", T0)],
        ci_green: [proof("ci:42", T0)],
        merged: [proof("pr:42", T1)],
      },
    });
    expect(provenMerged.state).toBe("merged");
    expect(provenMerged.target_reached).toBe(true);
  });

  test("distinguishes legacy inline work from pool handoffs", () => {
    const direct = normalizeExecutionLifecycle({
      status: "pending-implementation",
      stage: "executing",
      started_at: T0,
    }, { now: T1 });
    const pooled = normalizeExecutionLifecycle({
      status: "pool-enqueued",
      stage: "pool-enqueued",
      started_at: T0,
      completed_at: T1,
    }, { now: T1 });

    expect(direct.state).toBe("executing");
    expect(pooled.state).toBe("pool_enqueued");
  });

  test("does not accept an evidence-free canonical target", () => {
    const malformed = normalizeExecutionLifecycle({
      state: "accepted",
      delivery_target: "accepted",
      state_updated_at: T1,
      evidence: {},
    }, { now: T1 });

    expect(malformed.state).toBe("accepted");
    expect(malformed.target_reached).toBe(false);
    expect(hasProvenDeliveryState(malformed, "verified")).toBe(false);
    expect(isTerminalExecution(malformed)).toBe(false);
    expect(isInFlightExecution(malformed)).toBe(true);
  });

  test("does not skip delivery stages from non-contiguous evidence", () => {
    const malformed = normalizeExecutionLifecycle({
      status: "complete",
      delivery_target: "accepted",
      state_updated_at: T1,
      evidence: { accepted: [proof("acceptance:1", T1)] },
    }, { now: T1 });

    expect(malformed.state).toBe("implementation_complete");
    expect(malformed.target_reached).toBe(false);
  });

  test("target is reached at or beyond the configured delivery state, never before", () => {
    const executing = createExecutionLifecycle("verified", T0);
    const implemented = transitionExecutionLifecycle(
      executing,
      "implementation_complete",
      proof("commit:1"),
      { now: T1 },
    );
    const verified = transitionExecutionLifecycle(
      implemented,
      "verified",
      proof("verification:1"),
      { now: "2026-07-13T04:02:00.000Z" },
    );

    expect(hasReachedTarget(executing)).toBe(false);
    expect(implemented.target_reached).toBe(false);
    expect(verified.target_reached).toBe(true);
    expect(hasProvenDeliveryState(verified, "verified")).toBe(true);
    expect(isTerminalExecution(verified)).toBe(true);
  });

  test("normalization is byte-stable across three runs", () => {
    const first = normalizeExecutionLifecycle({
      status: "complete",
      completed_at: T0,
      delivery_target: "verified",
      evidence: { complete: [proof("commit:1", T0), proof("commit:1", T0)] },
    }, { now: T1 });
    const second = normalizeExecutionLifecycle(first as unknown as Record<string, unknown>, { now: T1 });
    const third = normalizeExecutionLifecycle(second as unknown as Record<string, unknown>, { now: T1 });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(third.evidence.implementation_complete).toHaveLength(1);
  });
});

describe("post-merge survivability", () => {
  test("unmerged execution is not applicable and retains a terminal reason", () => {
    const failed = normalizeExecutionLifecycle({
      status: "failed",
      completed_at: T0,
      error: "executor exhausted before merge",
      delivery_target: "accepted",
    }, { now: T1 });

    expect(failed.post_merge_survivability).toBe("not_applicable");
    expect(failed.post_merge_survivability_reason).toBe("executor exhausted before merge");
    expect(failed.post_merge_survivability_checks).toEqual([]);
  });

  test("merge schedules pending 7-day and 30-day checks", () => {
    let lifecycle = createExecutionLifecycle("accepted", T0);
    for (const [index, state] of [
      "implementation_complete",
      "verified",
      "pr_ready",
      "ci_green",
      "merged",
    ].entries()) {
      const at = new Date(Date.parse(T0) + (index + 1) * 60_000).toISOString();
      lifecycle = transitionExecutionLifecycle(
        lifecycle,
        state as "implementation_complete" | "verified" | "pr_ready" | "ci_green" | "merged",
        proof(`${state}:1`, at),
        { now: at },
      );
    }

    expect(lifecycle.post_merge_survivability).toBe("pending");
    expect(lifecycle.post_merge_survivability_reason).toBeNull();
    expect(lifecycle.post_merge_survivability_checks.map((check) => check.window_days)).toEqual([7, 30]);
    expect(lifecycle.post_merge_survivability_checks.every((check) => check.status === "pending")).toBe(true);

    const day7 = recordSurvivabilityCheck(
      lifecycle,
      7,
      "passed",
      proof("survival:7d", "2026-07-20T04:05:00.000Z"),
      "2026-07-20T04:05:00.000Z",
    );
    const day30 = recordSurvivabilityCheck(
      day7,
      30,
      "passed",
      proof("survival:30d", "2026-08-12T04:05:00.000Z"),
      "2026-08-12T04:05:00.000Z",
    );
    expect(day7.post_merge_survivability).toBe("pending");
    expect(day30.post_merge_survivability).toBe("passed");
  });

  test("rejects survivability results before their due window", () => {
    let lifecycle = createExecutionLifecycle("merged", T0);
    for (const [index, state] of ["implementation_complete", "verified", "pr_ready", "ci_green", "merged"].entries()) {
      const at = new Date(Date.parse(T0) + (index + 1) * 60_000).toISOString();
      lifecycle = transitionExecutionLifecycle(
        lifecycle,
        state as "implementation_complete" | "verified" | "pr_ready" | "ci_green" | "merged",
        proof(`${state}:1`, at),
        { now: at },
      );
    }

    expect(() => recordSurvivabilityCheck(lifecycle, 7, "passed", proof("too-early", T1), T1))
      .toThrow("not due until");
  });

  test("invalid legacy survivability proof degrades to pending", () => {
    const normalized = normalizeExecutionLifecycle({
      state: "merged",
      delivery_target: "merged",
      state_updated_at: T1,
      evidence: { merged: [proof("pr:42", T1)] },
      post_merge_survivability_checks: [
        { window_days: 7, due_at: T1, status: "passed", checked_at: null, evidence: [] },
        { window_days: 30, due_at: T1, status: "failed", checked_at: "not-a-date", evidence: [proof("bad")] },
      ],
    }, { now: T1 });

    expect(normalized.post_merge_survivability).toBe("pending");
    expect(normalized.post_merge_survivability_checks.every((check) => check.status === "pending")).toBe(true);
    expect(normalized.post_merge_survivability_checks.every((check) => check.checked_at === null)).toBe(true);
  });

  test("derives due dates from merge evidence instead of persisted input", () => {
    const normalized = normalizeExecutionLifecycle({
      state: "merged",
      delivery_target: "merged",
      state_updated_at: T1,
      evidence: {
        implementation_complete: [proof("commit:1", T0)],
        verified: [proof("verify:1", T0)],
        pr_ready: [proof("pr:1", T0)],
        ci_green: [proof("ci:1", T0)],
        merged: [proof("merge:1", T1)],
      },
      post_merge_survivability_checks: [
        { window_days: 7, due_at: T1, status: "pending", checked_at: null, evidence: [] },
        { window_days: 30, due_at: T1, status: "pending", checked_at: null, evidence: [] },
      ],
    }, { now: T1 });

    expect(normalized.post_merge_survivability_checks.map((check) => check.due_at)).toEqual([
      "2026-07-20T04:01:00.000Z",
      "2026-08-12T04:01:00.000Z",
    ]);
  });
});

describe("wouldDowngradeDelivery", () => {
  test("blocks a stale writer from reverting a shipped execution", () => {
    expect(wouldDowngradeDelivery("merged", "implementation_complete")).toBe(true);
    expect(wouldDowngradeDelivery("pr_ready", "verified")).toBe(true);
    expect(wouldDowngradeDelivery("ci_green", "pr_ready")).toBe(true);
  });

  test("allows forward progress and idempotent rewrites", () => {
    expect(wouldDowngradeDelivery("implementation_complete", "merged")).toBe(false);
    expect(wouldDowngradeDelivery("verified", "pr_ready")).toBe(false);
    expect(wouldDowngradeDelivery("merged", "merged")).toBe(false);
  });

  test("never suppresses a non-delivery outcome in either direction", () => {
    for (const state of ["failed", "held", "executing", "dry_run", "pool_enqueued"]) {
      expect(wouldDowngradeDelivery("merged", state)).toBe(false);
      expect(wouldDowngradeDelivery(state, "merged")).toBe(false);
    }
  });

  test("treats missing or malformed persisted state as writable", () => {
    for (const state of [null, undefined, "", "nonsense", 7, {}]) {
      expect(wouldDowngradeDelivery(state, "implementation_complete")).toBe(false);
    }
  });
});

describe("ZOU-1450 execution-record admission is a closed class", () => {
  const scriptsDir = import.meta.dir;
  const definitionFile = "execution-lifecycle.ts";

  const sources = readdirSync(scriptsDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== definitionFile)
    .map((name) => ({ name, text: readFileSync(join(scriptsDir, name), "utf8") }));

  test("no script enumerates state files with a raw exec- prefix filter", () => {
    const offenders: string[] = [];
    for (const { name, text } of sources) {
      const flat = text.replace(/\s+/g, " ");
      if (/startsWith\("exec-"\)[^;]{0,120}endsWith\("\.json"\)/.test(flat)) offenders.push(name);
      if (/endsWith\("\.json"\)[^;]{0,120}startsWith\("exec-"\)/.test(flat)) offenders.push(name);
    }
    expect(offenders, `use isExecutionRecordFileName from ${definitionFile} instead`).toEqual([]);
  });

  test("no script parses an execution id with a dot-permissive filename regex", () => {
    const offenders: string[] = [];
    for (const { name, text } of sources) {
      if (/\^exec-\((?:\.\+|\.\*|\[\^\]]*\.[^)]*)\)\\?\.json/.test(text)) offenders.push(name);
    }
    expect(offenders, `a greedy capture admits exec-<id>.autopsy.json as id "<id>.autopsy"`).toEqual([]);
  });

  test("the shared predicate rejects every sidecar class found in production state", () => {
    expect(isExecutionRecordFileName("exec-abc123.json")).toBe(true);
    for (const sidecar of [
      "exec-abc123.autopsy.json",
      "exec-abc123.a1b2c3.evidence.json",
      "exec-abc123-before-2026-08-14T14-21-46.749Z.json",
    ]) {
      expect(isExecutionRecordFileName(sidecar), sidecar).toBe(false);
    }
  });
});
