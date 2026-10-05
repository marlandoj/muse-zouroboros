import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activeTransientHoldForTicket,
  attemptTransientRecovery,
  transientRecoveryJournalPath,
} from "./transient-recovery";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-transient-recovery-"));
  roots.push(root);
  return root;
}

function options(stateDir: string) {
  return {
    subject: { execution_id: "exec-one", ticket_id: "linear-uuid", identifier: "ZOU-1074" },
    stateDir,
    failure: "executor chain exhausted (executor:primary=fail(1s):transport:HTTP 504 Gateway Timeout)",
    prompt: "recover",
    workdir: stateDir,
    timeoutMs: 1_000,
    chain: ["primary", "fallback-a", "fallback-b"],
    healthProbe: async (route: string) => ({ healthy: route !== "primary", message: route }),
    harnessRun: async (route: string) => ({
      executorId: route,
      success: true,
      output: "recovered",
      durationMs: 10,
    }),
    now: () => "2026-08-01T00:00:00.000Z",
    recoveryId: () => "recovery-fixed",
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("typed transient recovery", () => {
  test("production DIRECT and SWARM paths invoke the same bounded recovery", () => {
    const conveyor = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    expect(conveyor.match(/await attemptTransientRecovery\(/g)).toHaveLength(2);
    expect(conveyor).toContain("return holdAfterTransientRecovery(exec, ticket, recovery)");
    const holdStart = conveyor.indexOf("function holdAfterTransientRecovery(");
    const holdEnd = conveyor.indexOf("function evidenceFiles(", holdStart);
    const holdPath = conveyor.slice(holdStart, holdEnd);
    expect(holdPath).toContain('transitionExecution(exec, "held", "transient-recovery"');
    expect(holdPath).toContain('reason: "transient_recovery"');
    expect(holdPath).toContain("saveHold({");
    const activeHoldGate = conveyor.indexOf("const activeTransientHold = activeTransientHoldForTicket(");
    const claimGate = conveyor.indexOf("const claim = acquireTicketClaim(", activeHoldGate);
    expect(activeHoldGate).toBeGreaterThan(0);
    expect(claimGate).toBeGreaterThan(activeHoldGate);

    const recovery = readFileSync(join(import.meta.dir, "transient-recovery.ts"), "utf8");
    expect(recovery).not.toContain("process.env.FACTORY_MODEL_CHAIN =");
  });

  test("journals before dispatch and retries only pre-validated routes", async () => {
    const root = sandbox();
    const calls: string[] = [];
    const configured = options(root);
    const timestamps = ["2026-08-01T00:00:00.000Z", "2026-08-01T00:00:10.000Z"];
    configured.now = () => timestamps.shift()!;
    configured.harnessRun = async (route: string) => {
      calls.push(route);
      const rows = readFileSync(transientRecoveryJournalPath(root), "utf8").trim().split("\n");
      expect(JSON.parse(rows[0]).phase).toBe("started");
      return { executorId: route, success: true, output: "recovered", durationMs: 10 };
    };

    const result = await attemptTransientRecovery(configured);

    expect(result.status).toBe("recovered");
    expect(calls).toEqual(["fallback-a"]);
    const rows = readFileSync(transientRecoveryJournalPath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => [row.phase, row.outcome ?? null])).toEqual([
      ["started", null],
      ["completed", "recovered"],
    ]);
    expect(rows.map((row) => row.at)).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:10.000Z",
    ]);
    expect(rows[0].preflight).toEqual([]);
    expect(rows[1].preflight.map((route: { route: string; healthy: boolean }) => [route.route, route.healthy])).toEqual([
      ["primary", false],
      ["fallback-a", true],
      ["fallback-b", true],
    ]);
  });

  test("the attempt is durable before asynchronous route validation begins", async () => {
    const root = sandbox();
    const configured = options(root);
    configured.healthProbe = async () => {
      const rows = readFileSync(transientRecoveryJournalPath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ phase: "started", preflight: [] });
      return { healthy: false, message: "down" };
    };

    expect((await attemptTransientRecovery(configured)).status).toBe("blocked");
  });

  test("one execution can consume only one recovery attempt", async () => {
    const root = sandbox();
    let calls = 0;
    const configured = options(root);
    configured.harnessRun = async (route: string) => {
      calls++;
      return { executorId: route, success: true, output: "recovered", durationMs: 10 };
    };

    expect((await attemptTransientRecovery(configured)).status).toBe("recovered");
    const repeated = await attemptTransientRecovery(configured);
    expect(repeated.status).toBe("blocked");
    expect(calls).toBe(1);
  });

  test("a failed replay returns the complete fallback trail for operator parking", async () => {
    const root = sandbox();
    const configured = options(root);
    configured.harnessRun = async (route: string) => ({
      executorId: route,
      success: false,
      output: `${route} HTTP 503`,
      durationMs: 10,
    });

    const result = await attemptTransientRecovery(configured);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed transient recovery");
    expect(result.result.trail).toHaveLength(2);
    expect(result.result.error).toContain("fallback-a");
    expect(result.result.error).toContain("fallback-b");
  });

  test("deterministic failures never reserve, journal, probe, or dispatch", async () => {
    const root = sandbox();
    let probes = 0;
    const configured = options(root);
    configured.failure = "LINEUP_ROLE_CHAINS must contain exactly one model id";
    configured.healthProbe = async () => {
      probes++;
      return { healthy: true, message: "unexpected" };
    };

    const result = await attemptTransientRecovery(configured);
    expect(result.status).toBe("not_applicable");
    expect(probes).toBe(0);
    expect(existsSync(transientRecoveryJournalPath(root))).toBe(false);
  });

  test("failed work mentioning a 5xx assertion is not replayed as transport", async () => {
    const root = sandbox();
    let probes = 0;
    const configured = options(root);
    configured.failure = "executor chain exhausted (executor:codex=fail(2s):execution:unit test expected status 500 but got 200)";
    configured.healthProbe = async () => {
      probes++;
      return { healthy: true, message: "unexpected" };
    };

    expect((await attemptTransientRecovery(configured)).status).toBe("not_applicable");
    expect(probes).toBe(0);
    expect(existsSync(transientRecoveryJournalPath(root))).toBe(false);
  });

  test("a corrupt journal fails closed before probing or dispatch", async () => {
    const root = sandbox();
    writeFileSync(transientRecoveryJournalPath(root), "not-json\n");
    let probes = 0;
    const configured = options(root);
    configured.healthProbe = async () => {
      probes++;
      return { healthy: true, message: "unexpected" };
    };

    const result = await attemptTransientRecovery(configured);
    expect(result.status).toBe("blocked");
    expect(probes).toBe(0);
  });

  test("a semantically incomplete completion row fails closed", async () => {
    const root = sandbox();
    writeFileSync(transientRecoveryJournalPath(root), `${JSON.stringify({
      schema_version: 1,
      recovery_id: "recovery-old",
      execution_id: "exec-old",
      ticket_id: "linear-old",
      identifier: "ZOU-old",
      phase: "completed",
      at: "2026-08-01T00:00:00.000Z",
      failure_class: "transient",
      original_error: "old",
      preflight: [],
    })}\n`);
    let probes = 0;
    const configured = options(root);
    configured.healthProbe = async () => {
      probes++;
      return { healthy: true, message: "unexpected" };
    };

    expect((await attemptTransientRecovery(configured)).status).toBe("blocked");
    expect(probes).toBe(0);
  });

  test("an active transient hold blocks every cycle until operator release", () => {
    const root = sandbox();
    const holdPath = join(root, "hold-exec-held.json");
    writeFileSync(holdPath, JSON.stringify({
      execution_id: "exec-held",
      tier: "high",
      held_at: "2026-08-01T00:00:00.000Z",
      notified: "none",
      released_by: null,
      released_at: null,
      reason: "transient_recovery",
    }));
    writeFileSync(join(root, "exec-exec-held.json"), JSON.stringify({
      execution_id: "exec-held",
      ticket_id: "linear-uuid",
      identifier: "ZOU-1074",
      state: "held",
    }));

    expect(activeTransientHoldForTicket(root, "linear-uuid")?.hold.execution_id).toBe("exec-held");
    expect(activeTransientHoldForTicket(root, "linear-uuid")?.hold.execution_id).toBe("exec-held");

    const released = JSON.parse(readFileSync(holdPath, "utf8"));
    released.released_by = "operator";
    released.released_at = "2026-08-01T00:05:00.000Z";
    writeFileSync(holdPath, JSON.stringify(released));
    expect(activeTransientHoldForTicket(root, "linear-uuid")).toBeNull();
  });

  test("no healthy route produces a journaled operator block without dispatch", async () => {
    const root = sandbox();
    let dispatches = 0;
    const configured = options(root);
    configured.healthProbe = async (route: string) => ({ healthy: false, message: `${route} down` });
    configured.harnessRun = async (route: string) => {
      dispatches++;
      return { executorId: route, success: true, output: "unexpected", durationMs: 10 };
    };

    const result = await attemptTransientRecovery(configured);
    expect(result.status).toBe("blocked");
    expect(dispatches).toBe(0);
    const rows = readFileSync(transientRecoveryJournalPath(root), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.at(-1).outcome).toBe("blocked");
  });
});
