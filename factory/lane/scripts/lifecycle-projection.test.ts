import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlightEvent } from "./flight-recorder";
import {
  divergentExecutions,
  isAliasExecutionId,
  projectExecution,
  projectLifecycle,
  readExecutionRecords,
  resolveAliases,
} from "./lifecycle-projection";

const NOW = "2026-07-26T18:00:00.000Z";

function event(kind: string, ts: string, overrides: Partial<FlightEvent> = {}): FlightEvent {
  return { execution_id: "exec-d50452ec", identifier: "ZOU-933", kind, ts, ...overrides };
}

describe("lifecycle projection (FH-05)", () => {
  test("resolves the ZOU-933 cross-store disagreement to one canonical state", () => {
    // The audit's worked example: record says pr_ready, journal proves merged.
    const projection = projectExecution(
      "exec-d50452ec",
      [event("exec.start", "2026-07-26T10:00:00.000Z"), event("reconcile.execution-merged", "2026-07-26T12:30:00.000Z")],
      { execution_id: "exec-d50452ec", identifier: "ZOU-933", state: "pr_ready", evidence: {} },
      NOW,
    );
    expect(projection.lifecycle.state).toBe("merged");
    expect(projection.sources).toEqual({ journal: "merged", record: "pr_ready" });
    expect(projection.divergence.diverged).toBe(true);
    expect(projection.divergence.reason).toContain("projection takes merged");
  });

  test("is idempotent under duplicate appends from resumed conveyor cycles", () => {
    // ZOU-913 and ZOU-931 each re-emitted gate.decision four times.
    const once = [event("exec.start", "2026-07-26T10:00:00.000Z"), event("gate.decision", "2026-07-26T10:05:00.000Z")];
    const replayed = [...once, ...once, ...once, ...once];
    const a = projectExecution("exec-d50452ec", once, null, NOW);
    const b = projectExecution("exec-d50452ec", replayed, null, NOW);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(b.events_applied).toBe(2);
  });

  test("is order-free — shuffled events produce an identical projection", () => {
    const ordered = [
      event("exec.start", "2026-07-26T10:00:00.000Z"),
      event("exec.implementation_complete", "2026-07-26T11:00:00.000Z"),
      event("exec.verified", "2026-07-26T11:30:00.000Z"),
      event("reconcile.execution-merged", "2026-07-26T12:30:00.000Z"),
    ];
    const shuffled = [ordered[3], ordered[0], ordered[2], ordered[1]];
    expect(JSON.stringify(projectExecution("exec-d50452ec", shuffled, null, NOW)))
      .toBe(JSON.stringify(projectExecution("exec-d50452ec", ordered, null, NOW)));
  });

  test("target_reached still requires contiguous evidence — a merge event alone does not prove delivery", () => {
    const projection = projectExecution(
      "exec-d50452ec",
      [event("reconcile.execution-merged", "2026-07-26T12:30:00.000Z")],
      { execution_id: "exec-d50452ec", delivery_target: "accepted", evidence: {} },
      NOW,
    );
    expect(projection.lifecycle.state).toBe("merged");
    expect(projection.lifecycle.target_reached).toBe(false);
  });

  test("folds reconcile and serial aliases into the canonical execution", () => {
    const identifierOf = (id: string) =>
      ({ "exec-ed5547e3": "ZOU-902", "reconcile-ZOU-902": "ZOU-902", "serial-ZOU-902": "ZOU-902" })[id] ?? null;
    const mapping = resolveAliases(["exec-ed5547e3", "reconcile-ZOU-902", "serial-ZOU-902"], identifierOf);
    expect(mapping.get("reconcile-ZOU-902")).toBe("exec-ed5547e3");
    expect(mapping.get("serial-ZOU-902")).toBe("exec-ed5547e3");
    expect(mapping.get("exec-ed5547e3")).toBe("exec-ed5547e3");
    expect(isAliasExecutionId("reconcile-ZOU-902")).toBe(true);
    expect(isAliasExecutionId("exec-ed5547e3")).toBe(false);
  });

  test("merge proof recorded under an alias reaches the canonical execution", () => {
    const events: FlightEvent[] = [
      { execution_id: "exec-ed5547e3", identifier: "ZOU-902", kind: "exec.verified", ts: "2026-07-26T11:00:00.000Z" },
      { execution_id: "reconcile-ZOU-902", identifier: "ZOU-902", kind: "reconcile.execution-merged", ts: "2026-07-26T12:00:00.000Z" },
    ];
    const result = projectLifecycle({ events, records: [], now: NOW });
    expect(result.ok).toBe(true);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].execution_id).toBe("exec-ed5547e3");
    expect(result.executions[0].lifecycle.state).toBe("merged");
  });

  test("an alias with no canonical execution stands on its own rather than vanishing", () => {
    const events: FlightEvent[] = [
      { execution_id: "reconcile-ZOU-904", identifier: "ZOU-904", kind: "reconcile.execution-merged", ts: "2026-07-26T12:00:00.000Z" },
    ];
    const result = projectLifecycle({ events, records: [], now: NOW });
    expect(result.executions.map((e) => e.execution_id)).toEqual(["reconcile-ZOU-904"]);
  });

  test("attaches consensus and approval as markers, never as states", () => {
    const projection = projectExecution(
      "exec-d50452ec",
      [
        event("exec.start", "2026-07-26T10:00:00.000Z"),
        event("consensus.complete", "2026-07-26T11:00:00.000Z", { data: { status: "passed", gate_id: "cg-abc" } }),
        event("manual-review.requested", "2026-07-26T11:10:00.000Z", { detail: "quorum unavailable" }),
      ],
      null,
      NOW,
    );
    expect(projection.lifecycle.state).toBe("executing");
    expect(projection.markers.consensus).toEqual({ status: "passed", gate_id: "cg-abc", at: "2026-07-26T11:00:00.000Z" });
    expect(projection.markers.manual_review?.detail).toBe("quorum unavailable");
  });

  test("delivery progress after a hold clears the manual-review marker", () => {
    const projection = projectExecution(
      "exec-d50452ec",
      [
        event("manual-review.requested", "2026-07-26T11:10:00.000Z"),
        event("reconcile.execution-merged", "2026-07-26T12:30:00.000Z"),
      ],
      null,
      NOW,
    );
    expect(projection.markers.manual_review).toBeNull();
    expect(projection.lifecycle.state).toBe("merged");
  });

  test("a recovery append raises the projection — the successful retry is not lost", () => {
    // The ZOU-933 consensus retry updated the mutable record but appended no
    // journal event. FH-06 requires the append; FH-05 must then reflect it.
    const before = projectExecution("exec-d50452ec", [event("exec.verified", "2026-07-26T11:00:00.000Z")], null, NOW);
    const after = projectExecution(
      "exec-d50452ec",
      [event("exec.verified", "2026-07-26T11:00:00.000Z"), event("reconcile.execution-merged", "2026-07-26T12:30:00.000Z")],
      null,
      NOW,
    );
    expect(before.lifecycle.state).toBe("verified");
    expect(after.lifecycle.state).toBe("merged");
  });

  test("materialization failure is explicit so gating consumers can fail closed", () => {
    const result = projectLifecycle({
      events: [{ get execution_id(): string { throw new Error("torn read"); }, identifier: "x", kind: "exec.start" } as unknown as FlightEvent],
      records: [],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.degraded_reason).toContain("torn read");
    expect(result.executions).toEqual([]);
  });

  test("a corrupt execution record does not blind the rest of the projection", () => {
    const result = projectLifecycle({
      events: [event("reconcile.execution-merged", "2026-07-26T12:00:00.000Z")],
      records: [{ execution_id: "exec-d50452ec", state: 42, evidence: "not-an-object" }],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.executions[0].lifecycle.state).toBe("merged");
  });

  test("divergent executions are enumerable for the consistency measure", () => {
    const result = projectLifecycle({
      events: [event("reconcile.execution-merged", "2026-07-26T12:00:00.000Z")],
      records: [{ execution_id: "exec-d50452ec", identifier: "ZOU-933", state: "pr_ready" }],
      now: NOW,
    });
    expect(divergentExecutions(result)).toHaveLength(1);
  });

  test("an execution with no journal events still projects from its record", () => {
    const result = projectLifecycle({
      events: [],
      records: [{ execution_id: "exec-quiet", identifier: "ZOU-999", state: "pr_ready" }],
      now: NOW,
    });
    expect(result.executions[0].lifecycle.state).toBe("pr_ready");
    expect(result.executions[0].divergence.diverged).toBe(false);
  });
});

describe("recovery appends (FH-06 → FH-05)", () => {
  test("a recovery.resolved append clears the hold even with no delivery advance", () => {
    const projection = projectExecution(
      "exec-d50452ec",
      [
        event("manual-review.requested", "2026-07-26T11:10:00.000Z"),
        event("recovery.resolved", "2026-07-26T11:40:00.000Z", { data: { by: "marlandoj", resolution: "manual-approval" } }),
      ],
      null,
      NOW,
    );
    expect(projection.markers.manual_review).toBeNull();
  });

  test("a recovered consensus success is indistinguishable from a first-pass one", () => {
    const recovered = projectExecution(
      "exec-d50452ec",
      [event("consensus.complete", "2026-07-26T13:00:00.000Z", { data: { status: "passed", gate_id: "cg-retry", recovery: true } })],
      null,
      NOW,
    );
    expect(recovered.markers.consensus?.status).toBe("passed");
    expect(recovered.markers.consensus?.gate_id).toBe("cg-retry");
  });

  test("a later consensus append supersedes the earlier failure", () => {
    const projection = projectExecution(
      "exec-d50452ec",
      [
        event("consensus.complete", "2026-07-26T10:00:00.000Z", { data: { status: "needs-review", gate_id: null } }),
        event("consensus.complete", "2026-07-26T13:00:00.000Z", { data: { status: "passed", gate_id: "cg-retry" } }),
      ],
      null,
      NOW,
    );
    expect(projection.markers.consensus?.status).toBe("passed");
  });

  test("an exec.merged recovery transition raises the projection", () => {
    const projection = projectExecution(
      "exec-d50452ec",
      [event("exec.merged", "2026-07-26T14:00:00.000Z", { data: { recovery: true } })],
      { execution_id: "exec-d50452ec", state: "pr_ready" },
      NOW,
    );
    expect(projection.lifecycle.state).toBe("merged");
  });
});

describe("execution record admission (ZOU-1450)", () => {
  // The four dredge autopsies that sat in production state from 2026-08-14 wrote
  // `evidence` as an array. Admitted as records, they made the evidence merge
  // spread a non-iterable and every conveyor preflight that materializes the
  // projection aborted with `projection fold failed: Spread syntax ...`.
  function autopsy(executionId: string): Record<string, unknown> {
    return {
      execution_id: executionId,
      identifier: "ZOU-1186",
      state: "failed",
      evidence: [{ finding: "dredge autopsy", severity: "high" }],
    };
  }

  function sandbox(): string {
    const root = mkdtempSync(join(tmpdir(), "lifecycle-projection-admission-"));
    mkdirSync(join(root, "state"));
    return root;
  }

  function withCompatibilityState<T>(run: () => T): T {
    const previous = process.env.FACTORY_STATE_MODE;
    process.env.FACTORY_STATE_MODE = "compatibility";
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.FACTORY_STATE_MODE;
      else process.env.FACTORY_STATE_MODE = previous;
    }
  }

  test("sidecars beside a record are not admitted as records", () => {
    const root = sandbox();
    const record = { execution_id: "exec-live", identifier: "ZOU-1186", state: "executing", evidence: {} };
    writeFileSync(join(root, "state", "exec-exec-live.json"), JSON.stringify(record));
    for (const suffix of ["autopsy", "scanner", "receipt"]) {
      writeFileSync(join(root, "state", `exec-exec-live.${suffix}.json`), JSON.stringify(autopsy("exec-live")));
    }
    const records = withCompatibilityState(() => readExecutionRecords(root));
    expect(records.map((entry) => entry.execution_id)).toEqual(["exec-live"]);
  });

  test("a file whose name disagrees with its execution_id is not admitted", () => {
    const root = sandbox();
    writeFileSync(
      join(root, "state", "exec-renamed.json"),
      JSON.stringify({ execution_id: "exec-original", identifier: "ZOU-1186", state: "executing" }),
    );
    expect(withCompatibilityState(() => readExecutionRecords(root))).toEqual([]);
  });

  test("an autopsy in state no longer degrades the projection to executions: []", () => {
    const root = sandbox();
    const record = { execution_id: "exec-live", identifier: "ZOU-1186", state: "executing", evidence: {} };
    writeFileSync(join(root, "state", "exec-exec-live.json"), JSON.stringify(record));
    writeFileSync(join(root, "state", "exec-exec-live.autopsy.json"), JSON.stringify(autopsy("exec-live")));

    const result = withCompatibilityState(() => projectLifecycle({ base: root, events: [], now: NOW }));
    expect(result.ok).toBe(true);
    expect(result.degraded_reason).toBeNull();
    expect(result.executions.map((execution) => execution.execution_id)).toEqual(["exec-live"]);
  });

  test("array-shaped evidence reaching the fold still degrades explicitly, never silently", () => {
    // Defence in depth: if a malformed record is ever handed in directly, the
    // projection must still report `ok: false` with a reason rather than an
    // empty success.
    const result = projectLifecycle({ records: [autopsy("exec-live")], events: [], now: NOW });
    expect(result.ok).toBe(false);
    expect(result.degraded_reason).toContain("projection fold failed");
    expect(result.executions).toEqual([]);
  });
});
