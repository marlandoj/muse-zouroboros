import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIncumbentAdapterCatalog,
  executeAdapterPhase,
  runAdapterCycle,
  type AdapterCommandExecutor,
  type ConveyorAdapterCommand,
} from "./factory-conveyor-adapters";
import { CONVEYOR_PHASES, inspectCycle } from "./factory-conveyor-runner";

const factoryRoot = join(import.meta.dir, "..", "..", "..");
const savedEnv = { ...process.env };
let stateRoot = "";
let runnerRoot = "";
let artifactRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-adapters-"));
  runnerRoot = join(stateRoot, "runner");
  artifactRoot = join(stateRoot, "artifacts");
  process.env.FACTORY_STATE_MODE = "test";
  process.env.FACTORY_STATE_DIR = stateRoot;
  process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
});

function catalog() {
  return buildIncumbentAdapterCatalog({
    factoryRoot,
    stateDir: stateRoot,
    artifactRoot,
    cycleToken: "test-001",
  });
}

describe("factory conveyor adapters", () => {
  test("maps every runner phase to the incumbent command boundary", () => {
    const built = catalog();
    expect(built.adapters.map((adapter) => adapter.phase)).toEqual([...CONVEYOR_PHASES]);
    expect(built.runtime_config_script.endsWith("/scripts/runtime-config.ts")).toBe(true);
    expect(new Set(built.adapters.flatMap((adapter) => adapter.commands.map((command) => command.id))).size).toBe(
      built.adapters.flatMap((adapter) => adapter.commands).length,
    );
  });

  test("uses argv arrays and cycle-scoped artifacts instead of shell interpolation", () => {
    const built = catalog();
    for (const command of built.adapters.flatMap((adapter) => adapter.commands)) {
      expect(command.args.some((arg) => /[><|;&`]/.test(arg))).toBe(false);
      for (const path of [command.stdout_path, command.stderr_path]) {
        if (path) expect(path.startsWith(`${artifactRoot}/factory-`)).toBe(true);
      }
      expect(command.kind === "bun" ? command.load_runtime_config : !command.load_runtime_config).toBe(true);
    }
    const validator = built.adapters.find((adapter) => adapter.phase === "validate")!.commands[0];
    expect(validator.args).toContain("{{ticket_id}}");
    expect(validator.required_bindings).toEqual(["ticket_id"]);
    const smoke = built.adapters.find((adapter) => adapter.phase === "preflight")!.commands.find((entry) => entry.id === "conveyor-smoke")!;
    expect(smoke.env.FACTORY_STATE_MODE).toBe("production");
    expect(smoke.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT).toBeUndefined();
  });

  test("defaults to a no-subprocess plan for every phase", async () => {
    let calls = 0;
    const executor: AdapterCommandExecutor = { run: async () => {
      calls += 1;
      return { exit_code: 0, stdout_hash: null, stderr_hash: null };
    } };
    for (const adapter of catalog().adapters) {
      const result = await executeAdapterPhase({ adapter, executor });
      expect(result.event).toBe("skipped");
      expect(result.commands.every((command) => command.status === "planned")).toBe(true);
    }
    expect(calls).toBe(0);
  });

  test("read-only policy executes safe commands and blocks mutation-capable commands", async () => {
    const seen: ConveyorAdapterCommand[] = [];
    const executor: AdapterCommandExecutor = { run: async (command) => {
      seen.push(command);
      return { exit_code: 0, stdout_hash: null, stderr_hash: null };
    } };
    const built = catalog();
    const preflight = await executeAdapterPhase({ adapter: built.adapters[0], policy: "read_only", executor });
    expect(seen.map((command) => command.id)).toEqual(["runtime-config-check"]);
    expect(preflight.event).toBe("skipped");
    expect(preflight.commands.find((command) => command.command_id === "conveyor-smoke")?.status).toBe("blocked");
  });

  test("default shadow cycle writes receipts but invokes no incumbent command", async () => {
    let calls = 0;
    const executor: AdapterCommandExecutor = { run: async () => {
      calls += 1;
      return { exit_code: 0, stdout_hash: null, stderr_hash: null };
    } };
    const result = await runAdapterCycle({
      mode: "shadow",
      cycleId: "cyc-adapter-001",
      idempotencyKey: "schedule:adapter:test-001",
      runnerStateDir: runnerRoot,
      catalog: catalog(),
      executor,
    });
    expect(calls).toBe(0);
    expect(result?.status).toBe("complete");
    expect(result?.receipts).toHaveLength(CONVEYOR_PHASES.length * 2);
    expect(existsSync(artifactRoot)).toBe(false);
  });

  test("completed shadow cycle replays without duplicate receipts", async () => {
    const input = {
      mode: "shadow" as const,
      cycleId: "cyc-adapter-002",
      idempotencyKey: "schedule:adapter:test-002",
      runnerStateDir: runnerRoot,
      catalog: catalog(),
    };
    await runAdapterCycle(input);
    await runAdapterCycle(input);
    expect(inspectCycle(input.cycleId, runnerRoot).receipts).toHaveLength(CONVEYOR_PHASES.length * 2);
  });

  test("resumes deterministically after a crash at every phase boundary", async () => {
    const boundaries = ["before_start", "after_start", "after_adapter", "after_terminal"] as const;
    for (const [phaseIndex, phase] of CONVEYOR_PHASES.entries()) {
      for (const boundary of boundaries) {
        const cycleId = `cyc-fault-${phaseIndex}-${boundary}`;
        let injected = false;
        const input = {
          mode: "shadow" as const,
          cycleId,
          idempotencyKey: `fault:${phase}:${boundary}`,
          runnerStateDir: runnerRoot,
          catalog: catalog(),
          boundaryHook: ({ phase: currentPhase, boundary: currentBoundary }: { phase: string; boundary: string }) => {
            if (!injected && currentPhase === phase && currentBoundary === boundary) {
              injected = true;
              throw new Error(`injected:${phase}:${boundary}`);
            }
          },
        };
        await expect(runAdapterCycle(input)).rejects.toThrow(`injected:${phase}:${boundary}`);
        const resumed = await runAdapterCycle(input);
        expect(resumed?.status).toBe("complete");
        expect(resumed?.receipts).toHaveLength(CONVEYOR_PHASES.length * 2);
      }
    }
  }, 120_000);

  test("fails closed when a required incumbent script is absent", () => {
    const missingRoot = join(stateRoot, "missing-factory");
    expect(() => buildIncumbentAdapterCatalog({
      factoryRoot: missingRoot,
      stateDir: stateRoot,
      artifactRoot,
      cycleToken: "test-003",
    })).toThrow(/runtime-config\.ts source|adapter script is missing/);
  });

  test("requires and materializes dynamic command bindings without shell expansion", async () => {
    const built = catalog();
    const validate = built.adapters.find((adapter) => adapter.phase === "validate")!;
    const seen: ConveyorAdapterCommand[] = [];
    const executor: AdapterCommandExecutor = { run: async (command) => {
      seen.push(command);
      return { exit_code: 0, stdout_hash: null, stderr_hash: null };
    } };
    await expect(executeAdapterPhase({ adapter: validate, policy: "read_only", executor })).rejects.toThrow(/binding ticket_id/);
    await expect(executeAdapterPhase({
      adapter: validate,
      policy: "read_only",
      executor,
      bindings: { ticket_id: "--state-dir=/tmp/escape" },
    })).rejects.toThrow(/path-safe argument token/);
    await expect(executeAdapterPhase({
      adapter: validate,
      policy: "read_only",
      executor,
      bindings: { ticket_id: "ticket value with spaces" },
    })).rejects.toThrow(/path-safe argument token/);
    const result = await executeAdapterPhase({ adapter: validate, policy: "read_only", executor, bindings: { ticket_id: "linear-ticket-123" } });
    expect(result.event).toBe("succeeded");
    expect(seen[0].args).toEqual(["--ticket-id", "linear-ticket-123"]);
  });

  test("propagates a fail-closed read-only adapter failure", async () => {
    const built = catalog();
    const result = await executeAdapterPhase({
      adapter: built.adapters.find((adapter) => adapter.phase === "preflight")!,
      policy: "read_only",
      executor: { run: async () => ({ exit_code: 9, stdout_hash: null, stderr_hash: null }) },
    });
    expect(result.event).toBe("failed");
    expect(result.commands[0].status).toBe("failed");
  });
});
