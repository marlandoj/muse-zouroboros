import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyExecutions,
  L4_WINDOW_MIN_EXECUTIONS,
  loadExecRecordsUnion,
  qualificationStatus,
  syncQualifyingCount,
} from "./l4-qualification";

const LIVE_START = "2026-07-04T17:18:00.616Z";
const tempDirs: string[] = [];

function tempStateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr03-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

let seq = 0;

function execRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return {
    execution_id: `exec-${seq}`,
    identifier: `ZOU-${9000 + seq}`,
    ticket_id: `t-${seq}`,
    state: "implementation_complete",
    delivery_target: "implementation_complete",
    target_reached: true,
    gate_decision: "DIRECT",
    shadow_phase: "dry-run",
    started_at: "2026-08-01T10:00:00.000Z",
    completed_at: "2026-08-01T11:00:00.000Z",
    pr_number: 400 + seq,
    error: null,
    evidence: {
      implementation_complete: [{ kind: "commit", reference: `commit:${seq}`, recorded_at: "2026-08-01T11:00:00.000Z" }],
      verified: [{ kind: "post-flight", reference: `evaluations/e-${seq}.md`, recorded_at: "2026-08-01T11:00:00.000Z" }],
    },
    ...overrides,
  };
}

function writeStateDir(records: Record<string, unknown>[], shadow: Record<string, unknown> = {}): string {
  const d = tempStateDir();
  writeFileSync(
    join(d, "shadow-state.json"),
    JSON.stringify({
      current_phase: "live",
      phase_started_at: LIVE_START,
      live_started_at: LIVE_START,
      transitions: [],
      safe_executions: 0,
      unsafe_auto_executions: 0,
      ...shadow,
    })
  );
  records.forEach((r, i) => writeFileSync(join(d, `exec-${i}.json`), JSON.stringify(r)));
  return d;
}

describe("live-phase derivation from the timeline (stamp is unreliable)", () => {
  test("an execution started after live_started_at is live even when stamped dry-run", () => {
    const [c] = classifyExecutions([execRecord({ shadow_phase: "dry-run" })], LIVE_START);
    expect(c.live_phase).toBe(true);
    expect(c.stamp_mismatch).toBe(true);
    expect(c.qualifying).toBe(true);
  });

  test("an execution started before the live phase never qualifies", () => {
    const [c] = classifyExecutions(
      [execRecord({ started_at: "2026-07-01T00:00:00.000Z", completed_at: "2026-07-01T01:00:00.000Z" })],
      LIVE_START
    );
    expect(c.live_phase).toBe(false);
    expect(c.qualifying).toBe(false);
  });

  test("no live phase yet — nothing qualifies", () => {
    const [c] = classifyExecutions([execRecord()], null);
    expect(c.qualifying).toBe(false);
  });

  test("dry_run lifecycle state and non-terminal executing are excluded", () => {
    const cs = classifyExecutions(
      [
        execRecord({ state: "dry_run", target_reached: false, delivery_target: "accepted" }),
        execRecord({ state: "executing", target_reached: false, delivery_target: "accepted", completed_at: null }),
      ],
      LIVE_START
    );
    expect(cs[0].qualifying).toBe(false);
    expect(cs[1].qualifying).toBe(false);
  });

  test("a terminal failure with an explicit error qualifies (explicit-failure evidence)", () => {
    const [c] = classifyExecutions(
      [execRecord({ state: "failed", target_reached: false, delivery_target: "accepted", error: "cascade exhausted", evidence: {} })],
      LIVE_START
    );
    expect(c.qualifying).toBe(true);
    expect(c.evidence_complete).toBe(true);
  });

  test("plan-gate-held never counts as an attempted execution even with terminal state and full evidence", () => {
    const [c] = classifyExecutions(
      [
        execRecord({
          execution_id: "exec-plan-gate-held",
          stage: "plan-gate-held",
          state: "implementation_complete",
          evidence: {
            implementation_complete: [{ kind: "commit", reference: "commit:plan-held", recorded_at: "2026-08-01T11:00:00.000Z" }],
            verified: [{ kind: "post-flight", reference: "evaluations/plan-held.md", recorded_at: "2026-08-01T11:00:00.000Z" }],
          },
        }),
      ],
      LIVE_START
    );
    expect(c.terminal).toBe(true);
    expect(c.execution_attempted).toBe(false);
    expect(c.qualifying).toBe(false);
  });

  test("a failed prespec executor record still counts as attempted and evidence-complete when error is explicit", () => {
    const [c] = classifyExecutions(
      [
        execRecord({
          execution_id: "prespec-1",
          state: "failed",
          target_reached: false,
          delivery_target: "accepted",
          error: "executor crashed",
          evidence: {},
        }),
      ],
      LIVE_START
    );
    expect(c.execution_attempted).toBe(true);
    expect(c.qualifying).toBe(true);
    expect(c.evidence_complete).toBe(true);
    expect(c.evidence_missing).toEqual([]);
  });

  test("missing verification evidence is reported as an evaluation gap", () => {
    const [c] = classifyExecutions(
      [execRecord({ evidence: { implementation_complete: [{ kind: "commit", reference: "c", recorded_at: "2026-08-01T11:00:00.000Z" }] } })],
      LIVE_START
    );
    expect(c.execution_attempted).toBe(true);
    expect(c.qualifying).toBe(true);
    expect(c.evidence_complete).toBe(false);
    expect(c.evidence_missing).toContain("evaluation");
  });
});

describe("qualification status verdict", () => {
  test("REGRESSION: an empty live window is NOT certified regardless of elapsed time", () => {
    const d = writeStateDir([]);
    const s = qualificationStatus(d);
    expect(s.certified).toBe(false);
    expect(s.qualifying_count).toBe(0);
    expect(s.blockers.join(" ")).toContain("qualifying executions 0/");
  });

  test("20 complete executions across 8 days with clean ledger certifies", () => {
    const records = Array.from({ length: L4_WINDOW_MIN_EXECUTIONS }, (_, i) =>
      execRecord({
        started_at: `2026-08-0${(i % 8) + 1}T10:00:00.000Z`,
        completed_at: `2026-08-0${(i % 8) + 1}T12:00:00.000Z`,
      })
    );
    const d = writeStateDir(records);
    const s = qualificationStatus(d);
    expect(s.qualifying_count).toBe(20);
    expect(s.window_days).toBeGreaterThanOrEqual(7);
    expect(s.evidence_complete_rate).toBe(1);
    expect(s.false_approvals).toBe(0);
    expect(s.certified).toBe(true);
    expect(s.blockers).toEqual([]);
  });

  test("a too-short window blocks certification", () => {
    const records = Array.from({ length: 20 }, () => execRecord());
    const d = writeStateDir(records);
    const s = qualificationStatus(d);
    expect(s.certified).toBe(false);
    expect(s.blockers.join(" ")).toContain("window");
  });

  test("unsafe executions and evidence gaps block certification", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      execRecord({
        started_at: `2026-08-0${(i % 8) + 1}T10:00:00.000Z`,
        completed_at: `2026-08-0${(i % 8) + 1}T12:00:00.000Z`,
        evidence:
          i < 15
            ? {
                implementation_complete: [{ kind: "commit", reference: `c${i}`, recorded_at: "2026-08-01T11:00:00.000Z" }],
                verified: [{ kind: "post-flight", reference: `e${i}`, recorded_at: "2026-08-01T11:00:00.000Z" }],
              }
            : {
                implementation_complete: [{ kind: "commit", reference: `c${i}`, recorded_at: "2026-08-01T11:00:00.000Z" }],
              },
      })
    );
    const d = writeStateDir(records, { unsafe_auto_executions: 1 });
    const s = qualificationStatus(d);
    expect(s.certified).toBe(false);
    expect(s.blockers.join(" ")).toContain("unsafe");
    expect(s.blockers.join(" ")).toContain("evidence completeness");
  });

  test("unreadable exec files are tolerated and counted", () => {
    const d = writeStateDir([execRecord()]);
    writeFileSync(join(d, "exec-corrupt.json"), "{ nope");
    const s = qualificationStatus(d);
    expect(s.records_unreadable).toBe(1);
    expect(s.records_total).toBe(1);
  });
});

describe("sync reconciles the counter from evidence", () => {
  test("safe_executions is set to the derived qualifying count with an audit log", () => {
    const records = [execRecord(), execRecord()];
    const d = writeStateDir(records, { safe_executions: 99 });
    const r = syncQualifyingCount(d);
    expect(r.count).toBe(2);
    expect(r.synced).toContain(d);
    const shadow = JSON.parse(readFileSync(join(d, "shadow-state.json"), "utf-8"));
    expect(shadow.safe_executions).toBe(2);
    expect(readFileSync(join(d, "l4-qualification-sync.log"), "utf-8")).toContain("99 -> 2");
  });

  test("sync is idempotent — a matching counter writes no new log line", () => {
    const d = writeStateDir([execRecord()], { safe_executions: 1 });
    const r = syncQualifyingCount(d);
    expect(r.count).toBe(1);
    expect(() => readFileSync(join(d, "l4-qualification-sync.log"), "utf-8")).toThrow();
  });
});

describe("multi-dir union (rotated conveyor roots)", () => {
  test("records fragmented across dirs union by execution_id; stale duplicates lose to newest completed_at", () => {
    const only1 = execRecord({ execution_id: "exec-u1" });
    const only2 = execRecord({ execution_id: "exec-u2" });
    const staleCopy = execRecord({ execution_id: "exec-u3", state: "executing", completed_at: null });
    const freshCopy = { ...execRecord({ execution_id: "exec-u3" }), state: "failed", error: "boom", completed_at: "2026-08-04T12:00:00.000Z" };
    const d1 = writeStateDir([only1, staleCopy]);
    const d2 = writeStateDir([only2, freshCopy]);
    const { records, duplicates_merged } = loadExecRecordsUnion([d1, d2]);
    expect(records.length).toBe(3);
    expect(duplicates_merged).toBe(1);
    const merged = records.find((r) => r.execution_id === "exec-u3");
    expect(merged?.state).toBe("failed");
  });

  test("explicit state dir stays single-dir; no cross-dir bleed", () => {
    const d1 = writeStateDir([execRecord()]);
    writeStateDir([execRecord(), execRecord()]);
    const s = qualificationStatus(d1);
    expect(s.scanned_dirs).toEqual([d1]);
    expect(s.records_total).toBe(1);
  });
});
