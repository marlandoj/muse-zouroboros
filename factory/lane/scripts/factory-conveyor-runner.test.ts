import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVEYOR_PHASES,
  CONVEYOR_RUNNER_SCHEMA_VERSION,
  type ConveyorPhase,
  ConveyorRunnerError,
  createCycle,
  inspectCycle,
  recordPhase,
  runCycleScaffold,
  sha256,
} from "./factory-conveyor-runner";

const savedEnv = { ...process.env };
let stateRoot = "";
let runnerRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-runner-"));
  runnerRoot = join(stateRoot, "runner");
  process.env.FACTORY_STATE_MODE = "test";
  process.env.FACTORY_STATE_DIR = stateRoot;
  process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
});

function create(id = "cyc-test-001", key = "schedule:2026-08-27T07:13:00Z") {
  return createCycle({
    cycleId: id,
    idempotencyKey: key,
    mode: "shadow",
    stateDir: runnerRoot,
    createdAt: "2026-08-27T07:13:00.000Z",
  });
}

function start(phase: ConveyorPhase = CONVEYOR_PHASES[0]) {
  return recordPhase({
    cycleId: "cyc-test-001",
    phase,
    event: "started",
    stateDir: runnerRoot,
    at: "2026-08-27T07:13:01.000Z",
    inputHash: sha256(`input:${phase}`),
  });
}

function succeed(phase = CONVEYOR_PHASES[0]) {
  return recordPhase({
    cycleId: "cyc-test-001",
    phase,
    event: "succeeded",
    stateDir: runnerRoot,
    at: "2026-08-27T07:13:02.000Z",
    outputHash: sha256(`output:${phase}`),
  });
}

describe("factory conveyor runner", () => {
  test("off mode is a byte-free no-op", () => {
    const report = runCycleScaffold({ mode: "off", stateDir: runnerRoot });
    expect(report).toEqual({ ok: true, mode: "off", mutated: false, snapshot: null });
    expect(readdirSync(stateRoot)).toEqual([]);
  });

  test("creates one versioned shadow cycle and replays the same intent", () => {
    const first = create();
    const second = create();
    expect(first).toEqual(second);
    expect(first.identity.schema_version).toBe(CONVEYOR_RUNNER_SCHEMA_VERSION);
    expect(first.status).toBe("ready");
    expect(first.next_phase).toBe("preflight");
  });

  test("rejects idempotency reuse across cycle ids", () => {
    create();
    expect(() => create("cyc-test-002")).toThrow(ConveyorRunnerError);
    expect(() => create("cyc-test-002")).toThrow(/another cycle/);
  });

  test("repairs a torn identity-to-idempotency index write before replay", () => {
    create();
    const index = join(runnerRoot, "idempotency", `${sha256("schedule:2026-08-27T07:13:00Z")}.json`);
    unlinkSync(index);
    expect(create().identity.cycle_id).toBe("cyc-test-001");
    expect(() => create("cyc-test-002")).toThrow(/another cycle/);
  });

  test("records a hash-chained phase boundary and resumes at the next phase", () => {
    create();
    const started = start();
    const completed = succeed();
    expect(started.sequence).toBe(1);
    expect(completed.sequence).toBe(2);
    expect(completed.previous_hash).toBe(started.record_hash);
    const state = inspectCycle("cyc-test-001", runnerRoot);
    expect(state.status).toBe("ready");
    expect(state.next_phase).toBe("recovery");
    expect(state.receipts).toHaveLength(2);
  });

  test("replays an identical transition without appending a duplicate", () => {
    create();
    const first = start();
    const replay = start();
    expect(replay).toEqual(first);
    expect(inspectCycle("cyc-test-001", runnerRoot).receipts).toHaveLength(1);
  });

  test("fails closed on out-of-order and overlapping phases", () => {
    create();
    expect(() => start("pull")).toThrow(/expected preflight/);
    start();
    expect(() => recordPhase({
      cycleId: "cyc-test-001",
      phase: "recovery",
      event: "started",
      stateDir: runnerRoot,
      inputHash: sha256("recovery"),
    })).toThrow(/expected no phase|phase_order/);
  });

  test("preserves failed and held terminal evidence", () => {
    create();
    start();
    recordPhase({
      cycleId: "cyc-test-001",
      phase: "preflight",
      event: "failed",
      stateDir: runnerRoot,
      reason: "runtime config mismatch",
      at: "2026-08-27T07:13:02.000Z",
    });
    const state = inspectCycle("cyc-test-001", runnerRoot);
    expect(state.status).toBe("failed");
    expect(state.terminal_receipt?.reason).toBe("runtime config mismatch");
    expect(() => recordPhase({
      cycleId: "cyc-test-001",
      phase: "recovery",
      event: "started",
      stateDir: runnerRoot,
      inputHash: sha256("blocked"),
    })).toThrow(/already failed/);
  });

  test("detects receipt tampering and incompatible schemas", () => {
    create();
    start();
    const receiptDir = join(runnerRoot, "cycles", "cyc-test-001", "receipts");
    const receiptPath = join(receiptDir, readdirSync(receiptDir)[0]);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    receipt.input_hash = sha256("tampered");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(() => inspectCycle("cyc-test-001", runnerRoot)).toThrow(/hash mismatch/);

    const identityPath = join(runnerRoot, "cycles", "cyc-test-001", "cycle.json");
    const identity = JSON.parse(readFileSync(identityPath, "utf8"));
    identity.schema_version = 999;
    writeFileSync(identityPath, JSON.stringify(identity));
    expect(() => inspectCycle("cyc-test-001", runnerRoot)).toThrow(/unsupported cycle schema/);
  });

  test("recovers a stale lock while preserving it as evidence", () => {
    create();
    const directory = join(runnerRoot, "cycles", "cyc-test-001");
    const lockDir = join(directory, ".lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), "{}\n");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockDir, old, old);
    const receipt = recordPhase({
      cycleId: "cyc-test-001",
      phase: "preflight",
      event: "started",
      stateDir: runnerRoot,
      inputHash: sha256("stale-lock-recovery"),
      staleLockMs: 1,
    });
    expect(receipt.event).toBe("started");
    expect(readdirSync(directory).some((name) => name.startsWith(".lock.stale."))).toBe(true);
  });

  test("fails closed on an active lock and leaves receipts untouched", () => {
    create();
    const directory = join(runnerRoot, "cycles", "cyc-test-001");
    const lockDir = join(directory, ".lock");
    mkdirSync(lockDir);
    expect(() => start()).toThrow(/cycle lock is active/);
    expect(existsReceiptDir(directory)).toBe(false);
  });

  test("creates immutable owner-only files", () => {
    create();
    start();
    const identity = join(runnerRoot, "cycles", "cyc-test-001", "cycle.json");
    const receiptDir = join(runnerRoot, "cycles", "cyc-test-001", "receipts");
    const receipt = join(receiptDir, readdirSync(receiptDir)[0]);
    expect(statSync(identity).mode & 0o777).toBe(0o600);
    expect(statSync(receipt).mode & 0o777).toBe(0o600);
  });
});

function existsReceiptDir(directory: string): boolean {
  try {
    return statSync(join(directory, "receipts")).isDirectory();
  } catch {
    return false;
  }
}
