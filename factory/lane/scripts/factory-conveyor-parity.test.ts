import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareCycleObservations,
  createCycleObservation,
  recordParityComparison,
  recordParityHold,
  summarizeParity,
} from "./factory-conveyor-parity";
import { sha256 } from "./factory-conveyor-runner";

const savedEnv = { ...process.env };
let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-parity-"));
  process.env.FACTORY_STATE_MODE = "test";
  process.env.FACTORY_STATE_DIR = stateRoot;
  process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
});

function observation(source: "incumbent" | "runner", cycle: number, overrides: Partial<Parameters<typeof createCycleObservation>[0]> = {}) {
  return createCycleObservation({
    source,
    cycleKey: `schedule:2026-08-28T${String(cycle).padStart(2, "0")}:00:00Z`,
    observedVersion: source === "incumbent" ? "57d19544" : "2b3d1607",
    decision: "dispatched",
    ticketId: `linear-${cycle}`,
    identifier: `ZOU-${1500 + cycle}`,
    dispatchCount: 1,
    sideEffectKeys: [`linear:${cycle}:dispatch`, `state:exec-${cycle}:create`],
    evidenceHash: sha256(`evidence:${source}:${cycle}`),
    ...overrides,
  });
}

describe("factory conveyor parity", () => {
  test("matches decision and side-effect identity across different runner versions", () => {
    const comparison = compareCycleObservations({
      incumbent: observation("incumbent", 1),
      runner: observation("runner", 1),
      comparedAt: "2026-08-28T05:00:00.000Z",
    });
    expect(comparison.match).toBe(true);
    expect(comparison.mismatches).toEqual([]);
  });

  test("reports hashed field-level drift without copying evidence payloads", () => {
    const comparison = compareCycleObservations({
      incumbent: observation("incumbent", 2),
      runner: observation("runner", 2, { decision: "dedup_skip", dispatchCount: 0, sideEffectKeys: [] }),
      comparedAt: "2026-08-28T05:01:00.000Z",
    });
    expect(comparison.match).toBe(false);
    expect(comparison.mismatches.map((mismatch) => mismatch.field)).toEqual(["decision", "dispatch_count", "side_effect_keys"]);
    expect(comparison.mismatches.every((mismatch) => mismatch.incumbent_hash.length === 64 && mismatch.runner_hash.length === 64)).toBe(true);
  });

  test("records 20 immutable matching projections without creating qualification", () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const incumbent = observation("incumbent", cycle);
      const runner = observation("runner", cycle);
      const first = recordParityComparison({ incumbent, runner, stateDir: stateRoot, comparedAt: new Date(Date.UTC(2026, 7, 28, 6, cycle)).toISOString() });
      const replay = recordParityComparison({ incumbent, runner, stateDir: stateRoot, comparedAt: new Date(Date.UTC(2026, 7, 28, 7, cycle)).toISOString() });
      expect(replay).toEqual(first);
    }
    expect(summarizeParity(stateRoot)).toMatchObject({
      comparisons: 20,
      qualifying_comparisons: 0,
      structural_projections: 20,
      matching_cycles: 0,
      mismatched_cycles: 0,
      remaining: 20,
      eligible: false,
    });
  });

  test("one mismatched cycle keeps the parity window ineligible", () => {
    recordParityComparison({ incumbent: observation("incumbent", 1), runner: observation("runner", 1), stateDir: stateRoot });
    recordParityComparison({ incumbent: observation("incumbent", 2), runner: observation("runner", 2, { decision: "empty_queue", dispatchCount: 0, sideEffectKeys: [] }), stateDir: stateRoot });
    expect(summarizeParity(stateRoot, 1)).toMatchObject({ qualifying_comparisons: 0, structural_projections: 2, matching_cycles: 0, mismatched_cycles: 0, eligible: false });
  });

  test("fails closed on tampered comparison evidence", () => {
    recordParityComparison({ incumbent: observation("incumbent", 3), runner: observation("runner", 3), stateDir: stateRoot });
    const directory = join(stateRoot, "parity", "comparisons");
    const path = join(directory, readdirSync(directory)[0]);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.match = false;
    writeFileSync(path, JSON.stringify(record));
    expect(() => summarizeParity(stateRoot)).toThrow(/record hash mismatch/);
  });

  test("rejects conflicting evidence for an already-recorded cycle", () => {
    recordParityComparison({ incumbent: observation("incumbent", 4), runner: observation("runner", 4), stateDir: stateRoot });
    expect(() => recordParityComparison({
      incumbent: observation("incumbent", 4),
      runner: observation("runner", 4, { decision: "execution_failed" }),
      stateDir: stateRoot,
    })).toThrow(/different parity evidence/);
  });

  test("holds unmeasured cycles idempotently and fails closed on hold tampering", () => {
    const first = recordParityHold({
      cycleKey: "schedule:held:1",
      reasonCode: "unsupported_empty_queue",
      evidenceHash: sha256("held-evidence"),
      stateDir: stateRoot,
      observedAt: "2026-08-28T06:00:00.000Z",
    });
    expect(recordParityHold({
      cycleKey: "schedule:held:1",
      reasonCode: "unsupported_empty_queue",
      evidenceHash: sha256("held-evidence"),
      stateDir: stateRoot,
      observedAt: "2026-08-28T07:00:00.000Z",
    })).toEqual(first);
    expect(summarizeParity(stateRoot)).toMatchObject({ comparisons: 0, held_unmeasured: 1, eligible: false });
    const directory = join(stateRoot, "parity", "holds");
    const path = join(directory, readdirSync(directory)[0]);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.reason_code = "tampered_reason";
    writeFileSync(path, JSON.stringify(record));
    expect(() => summarizeParity(stateRoot)).toThrow(/hold hash mismatch/);
  });

  test("a cycle cannot acquire both held and compared dispositions", () => {
    recordParityHold({
      cycleKey: "schedule:2026-08-28T05:00:00Z",
      reasonCode: "unsupported_empty_queue",
      evidenceHash: sha256("held-once"),
      stateDir: stateRoot,
    });
    expect(() => recordParityComparison({
      incumbent: observation("incumbent", 5),
      runner: observation("runner", 5),
      stateDir: stateRoot,
    })).toThrow(/already has a held disposition/);

    const otherRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-parity-disposition-"));
    recordParityComparison({ incumbent: observation("incumbent", 6), runner: observation("runner", 6), stateDir: otherRoot });
    expect(() => recordParityHold({
      cycleKey: "schedule:2026-08-28T06:00:00Z",
      reasonCode: "unsupported_empty_queue",
      evidenceHash: sha256("compared-once"),
      stateDir: otherRoot,
    })).toThrow(/already has a comparison disposition/);
    rmSync(otherRoot, { recursive: true, force: true });
  });

  test("structural projections never enter the qualifying denominator", () => {
    recordParityComparison({
      incumbent: observation("incumbent", 7),
      runner: observation("runner", 7),
      stateDir: stateRoot,
    });
    expect(summarizeParity(stateRoot, 1)).toMatchObject({
      comparisons: 1,
      qualifying_comparisons: 0,
      structural_projections: 1,
      matching_cycles: 0,
      eligible: false,
    });
  });

  test("a held writer lock rejects concurrent append before sequence allocation", () => {
    const lock = join(stateRoot, "parity", ".write-lock");
    mkdirSync(lock, { recursive: true });
    expect(() => recordParityComparison({
      incumbent: observation("incumbent", 8),
      runner: observation("runner", 8),
      stateDir: stateRoot,
    })).toThrow(/writer lock is already held/);
  });
});
