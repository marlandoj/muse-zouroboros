import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeConveyorParity, observeConveyorParityCycle } from "./factory-conveyor-observer";
import { summarizeParity } from "./factory-conveyor-parity";
import type { LaneRow } from "./lane-utilization";
import type { ExecRecordLite } from "./flight-status";
import type { FlightEvent } from "./flight-recorder";

let parityRoot = "";
const savedEnv = { ...process.env };

beforeEach(() => {
  parityRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-observer-"));
  process.env.FACTORY_STATE_MODE = "test";
  process.env.FACTORY_STATE_DIR = parityRoot;
  process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
});

afterEach(() => {
  rmSync(parityRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

function lane(cycleId: string, reason: LaneRow["reason"] = "dispatched"): LaneRow[] {
  return [
    {
      schema: 1,
      cycle_id: cycleId,
      phase: "open",
      reason: null,
      ticket_id: null,
      identifier: null,
      execution_id: null,
      detail: null,
      ts: "2026-08-28T06:00:00.000Z",
    },
    {
      schema: 1,
      cycle_id: cycleId,
      phase: "outcome",
      reason,
      ticket_id: "linear-ticket-1",
      identifier: "ZOU-1530",
      execution_id: "exec-observer-1",
      detail: null,
      ts: "2026-08-28T06:10:00.000Z",
    },
  ];
}

function record(): ExecRecordLite {
  return {
    execution_id: "exec-observer-1",
    identifier: "ZOU-1530",
    ticket_id: "linear-ticket-1",
    status: "implementation_complete",
    started_at: "2026-08-28T06:01:00.000Z",
    completed_at: "2026-08-28T06:09:00.000Z",
  } as ExecRecordLite;
}

function events(includeExecutor = true): FlightEvent[] {
  const values: FlightEvent[] = [{
    ts: "2026-08-28T06:01:00.000Z",
    execution_id: "exec-observer-1",
    identifier: "ZOU-1530",
    kind: "exec.start",
  }];
  if (includeExecutor) values.push({
    ts: "2026-08-28T06:02:00.000Z",
    execution_id: "exec-observer-1",
    identifier: "ZOU-1530",
    kind: "executor.start",
  });
  return values;
}

function input(cycleId: string) {
  return {
    cycleId,
    incumbentVersion: "a".repeat(40),
    runnerVersion: `rel-${"b".repeat(24)}`,
    laneRows: lane(cycleId),
    records: [record()],
    events: events(),
    parityStateDir: parityRoot,
    observedAt: "2026-08-28T06:11:00.000Z",
  };
}

describe("factory conveyor production parity observer", () => {
  test("off mode returns before reading or writing observer state", () => {
    expect(observeConveyorParityCycle("cycle-off", { FACTORY_CONVEYOR_RUNNER_MODE: "off" })).toBeNull();
    expect(summarizeParity(parityRoot)).toMatchObject({ comparisons: 0, held_unmeasured: 0 });
  });

  test("records post-hoc lifecycle evidence only as a non-qualifying structural projection", () => {
    const result = observeConveyorParity(input("cycle-success"));
    expect(result.status).toBe("structural_projection");
    if (result.status === "structural_projection") {
      expect(result.comparison.match).toBe(true);
      expect(result.comparison.mismatches).toEqual([]);
      expect(result.comparison.evidence_class).toBe("structural_projection");
    }
    expect(summarizeParity(parityRoot)).toMatchObject({
      comparisons: 1,
      qualifying_comparisons: 0,
      structural_projections: 1,
      matching_cycles: 0,
      held_unmeasured: 0,
      eligible: false,
    });
  });

  test("holds unsupported lane outcomes outside the qualifying denominator", () => {
    const value = input("cycle-empty");
    value.laneRows = lane("cycle-empty", "empty_queue");
    const first = observeConveyorParity(value);
    const replay = observeConveyorParity({ ...value, observedAt: "2026-08-28T07:00:00.000Z" });
    expect(first.status).toBe("held_unmeasured");
    expect(replay).toEqual(first);
    expect(summarizeParity(parityRoot)).toMatchObject({ comparisons: 0, matching_cycles: 0, held_unmeasured: 1, eligible: false });
  });

  test("missing executor-start evidence becomes a mismatch, never a false match", () => {
    const value = input("cycle-missing-executor");
    value.events = events(false);
    const result = observeConveyorParity(value);
    expect(result.status).toBe("structural_projection");
    if (result.status === "structural_projection") {
      expect(result.comparison.match).toBe(false);
      expect(result.comparison.mismatches.map((entry) => entry.field)).toContain("decision");
      expect(result.comparison.mismatches.map((entry) => entry.field)).toContain("side_effect_keys");
    }
    expect(summarizeParity(parityRoot)).toMatchObject({ comparisons: 1, qualifying_comparisons: 0, structural_projections: 1, mismatched_cycles: 0, eligible: false });
  });

  test("rejects mutable or incomplete release identity", () => {
    expect(() => observeConveyorParity({ ...input("cycle-bad-incumbent"), incumbentVersion: "main" })).toThrow(/exact incumbent commit/);
    expect(() => observeConveyorParity({ ...input("cycle-bad-runner"), runnerVersion: "runner-v1" })).toThrow(/exact runner release id/);
  });

  test("lane completion reaches the observer in a separate process without changing its exit contract", async () => {
    const script = join(import.meta.dir, "lane-utilization.ts");
    const env = {
      ...process.env,
      FACTORY_STATE_MODE: "test",
      FACTORY_STATE_DIR: parityRoot,
      FACTORY_STATE_ALLOW_OUTSIDE_ROOT: "1",
      FACTORY_CONVEYOR_RUNNER_MODE: "parity_shadow",
      FACTORY_CONVEYOR_INCUMBENT_COMMIT: "a".repeat(40),
      FACTORY_CONVEYOR_RUNNER_RELEASE_ID: `rel-${"b".repeat(24)}`,
    };
    const run = async (args: string[]) => {
      const process = Bun.spawn(["bun", script, ...args], { env, stdout: "pipe", stderr: "pipe" });
      await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
      return process.exited;
    };
    expect(await run(["begin", "--cycle", "cycle-integration"])).toBe(0);
    writeFileSync(join(parityRoot, "exec-observer-1.json"), `${JSON.stringify(record())}\n`);
    const flight = join(parityRoot, "flight");
    mkdirSync(flight, { recursive: true });
    writeFileSync(join(flight, `journal-${new Date().toISOString().slice(0, 10)}.jsonl`), `${events().map((event) => JSON.stringify(event)).join("\n")}\n`);
    expect(await run([
      "record",
      "--reason", "dispatched",
      "--ticket", "linear-ticket-1",
      "--identifier", "ZOU-1530",
      "--execution", "exec-observer-1",
    ])).toBe(0);
    expect(summarizeParity(join(parityRoot, "conveyor-runner"))).toMatchObject({
      comparisons: 1,
      qualifying_comparisons: 0,
      structural_projections: 1,
      matching_cycles: 0,
      eligible: false,
    });
  });
});
