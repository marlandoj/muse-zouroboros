import { describe, expect, test } from "bun:test";
import {
  applyReconciliation,
  DONE_STATE_TYPE,
  planReconciliation,
  reconcileTerminalFingerprint,
  type ReconcileEffects,
  type ReconcileObserved,
} from "./reconcile-core";

function observed(over: Partial<ReconcileObserved> = {}): ReconcileObserved {
  return {
    identifier: "ZOU-901",
    issue_id: "issue-1",
    linear_state_type: "started",
    has_factory_ready_label: true,
    execution_state: "ci_green",
    progress_recorded: false,
    merge_comment_present: false,
    next_ready_identifier: "ZOU-902",
    next_ready_already_pulled: false,
    ...over,
  };
}

/**
 * Mutable fake world: each effect flips the corresponding observed flag to its
 * terminal value AND tallies the call, so re-observing shows the terminal state
 * and duplicate effects are detectable.
 */
function fakeWorld(initial: ReconcileObserved) {
  const world = { ...initial };
  const calls: Record<string, number> = {};
  const bump = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const effects: ReconcileEffects = {
    async moveLinearDone() {
      bump("moveLinearDone");
      world.linear_state_type = DONE_STATE_TYPE;
    },
    async stripFactoryReadyLabel() {
      bump("stripFactoryReadyLabel");
      world.has_factory_ready_label = false;
    },
    async markExecutionMerged() {
      bump("markExecutionMerged");
      world.execution_state = "merged";
    },
    async recordProgress() {
      bump("recordProgress");
      world.progress_recorded = true;
    },
    async postMergeComment() {
      bump("postMergeComment");
      world.merge_comment_present = true;
    },
    async promoteNextTicket() {
      bump("promoteNextTicket");
      world.next_ready_already_pulled = true;
    },
  };
  return { world, calls, effects };
}

describe("planReconciliation", () => {
  test("a fully-unreconciled merge needs every action", () => {
    const plan = planReconciliation(observed());
    expect(plan.pending).toEqual([
      "move_linear_done",
      "strip_factory_ready_label",
      "mark_execution_merged",
      "record_progress",
      "post_merge_comment",
      "promote_next_ticket",
    ]);
  });

  test("a fully-reconciled world needs nothing", () => {
    const plan = planReconciliation(
      observed({
        linear_state_type: DONE_STATE_TYPE,
        has_factory_ready_label: false,
        execution_state: "merged",
        progress_recorded: true,
        merge_comment_present: true,
        next_ready_already_pulled: true,
      }),
    );
    expect(plan.pending).toEqual([]);
  });

  test("does not move Linear when its state is unknown (fail-safe)", () => {
    const plan = planReconciliation(observed({ linear_state_type: null }));
    expect(plan.pending).not.toContain("move_linear_done");
  });

  test("deployed/accepted count as merged-or-beyond", () => {
    expect(planReconciliation(observed({ execution_state: "deployed" })).pending).not.toContain("mark_execution_merged");
    expect(planReconciliation(observed({ execution_state: "accepted" })).pending).not.toContain("mark_execution_merged");
  });

  test("no next ticket ⇒ no promotion", () => {
    const plan = planReconciliation(observed({ next_ready_identifier: null }));
    expect(plan.pending).not.toContain("promote_next_ticket");
  });

  test("terminal fingerprint is independent of the current observation", () => {
    const a = planReconciliation(observed()).terminal_fingerprint;
    const b = planReconciliation(
      observed({ linear_state_type: DONE_STATE_TYPE, has_factory_ready_label: false, execution_state: "merged", progress_recorded: true, merge_comment_present: true, next_ready_already_pulled: true }),
    ).terminal_fingerprint;
    expect(a).toBe(b);
    expect(a).toBe(reconcileTerminalFingerprint("ZOU-901", "ZOU-902"));
  });
});

describe("applyReconciliation — idempotency (AC#4)", () => {
  test("three consecutive replays: one terminal state, no duplicate effects", async () => {
    const { world, calls, effects } = fakeWorld(observed());

    const r1 = await applyReconciliation(world, effects);
    const r2 = await applyReconciliation(world, effects);
    const r3 = await applyReconciliation(world, effects);

    // First pass does all the work; replays are pure no-ops.
    expect(r1.applied).toHaveLength(6);
    expect(r2.applied).toHaveLength(0);
    expect(r3.applied).toHaveLength(0);

    // No duplicate issue move, label strip, comment, or promotion.
    for (const k of Object.keys(calls)) expect(calls[k]).toBe(1);

    // One identical terminal fingerprint across all three replays.
    expect(new Set([r1.terminal_fingerprint, r2.terminal_fingerprint, r3.terminal_fingerprint]).size).toBe(1);

    // The world is genuinely terminal.
    expect(world.linear_state_type).toBe(DONE_STATE_TYPE);
    expect(world.has_factory_ready_label).toBe(false);
    expect(world.execution_state).toBe("merged");
    expect(world.progress_recorded).toBe(true);
    expect(world.merge_comment_present).toBe(true);
    expect(world.next_ready_already_pulled).toBe(true);
  });

  test("partially-reconciled world only finishes the remainder", async () => {
    const { world, calls, effects } = fakeWorld(
      observed({ linear_state_type: DONE_STATE_TYPE, has_factory_ready_label: false, execution_state: "merged" }),
    );
    const res = await applyReconciliation(world, effects);
    expect(res.applied.sort()).toEqual(["post_merge_comment", "promote_next_ticket", "record_progress"]);
    expect(calls.moveLinearDone).toBeUndefined();
    expect(calls.stripFactoryReadyLabel).toBeUndefined();
    expect(calls.markExecutionMerged).toBeUndefined();
  });
});
