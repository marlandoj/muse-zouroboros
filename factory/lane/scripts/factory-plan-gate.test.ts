import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFactoryPlanGate } from "./factory-plan-gate";
import type { RepositoryDriftDecision } from "./repository-drift";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "factory-plan-gate-"));
  tempDirs.push(dir);
  const planPath = join(dir, "seed-zou-test.yaml");
  const ledgerPath = join(dir, "audit.jsonl");
  writeFileSync(planPath, [
    "id: ZOU-TEST",
    "title: Factory shadow fixture",
    "risk: low",
    "revision: 1",
    "tasks:",
    "  - id: T1",
    "    title: Verify factory reachability",
    "    depends_on: []",
    "acceptance_criteria:",
    "  - The factory writes one shadow record.",
    "exit_conditions:",
    "  - name: recorded",
    "    criteria: The ledger contains the artifact hash.",
    "rollback: Disable PLAN_GATE_MODE.",
    "",
  ].join("\n"));
  return { dir, planPath, ledgerPath };
}

function driftDecision(
  overrides: Partial<RepositoryDriftDecision> = {},
): RepositoryDriftDecision {
  return {
    action: "proceed",
    status: "exact",
    reason: "repository_state_matches_pin",
    repository: "marlandoj/zouroboros",
    expected_ref: "refs/heads/main",
    pinned_commit: "c490c7a600eea2d66db689aeb33e2192fdfc67e3",
    remote_commit: "c490c7a600eea2d66db689aeb33e2192fdfc67e3",
    head_before: "c490c7a600eea2d66db689aeb33e2192fdfc67e3",
    head_after: "c490c7a600eea2d66db689aeb33e2192fdfc67e3",
    branch: null,
    changed_paths: [],
    journaled: true,
    journal_path: "/tmp/repository-drift.jsonl",
    ...overrides,
  };
}

describe("factory plan gate", () => {
  test("is inert for DIRECT work", async () => {
    const { dir, planPath, ledgerPath } = fixture();
    const result = await runFactoryPlanGate({
      decision: "DIRECT", seedPath: planPath, workspaceRoot: dir,
      mode: "shadow", ledgerPath,
    });
    expect(result).toBeNull();
  });

  test("enforces declared repository pins even when the plan gate is disabled", async () => {
    const { dir, planPath } = fixture();
    const exact = await runFactoryPlanGate({
      decision: "SWARM", seedPath: planPath, workspaceRoot: dir, mode: "disabled",
    }, { repositoryDrift: () => driftDecision() });
    expect(exact?.action).toBe("proceed");
    expect(exact?.auditEvent).toBe("repository_drift_checked");
    expect(exact?.repository_drift?.status).toBe("exact");

    const held = await runFactoryPlanGate({
      decision: "SWARM", seedPath: planPath, workspaceRoot: dir, mode: "disabled",
    }, { repositoryDrift: () => driftDecision({
      action: "hold",
      status: "held",
      reason: "repository_drift_overlaps_declared_scope",
      journal_error: "ledger unavailable",
    }) });
    expect(held?.action).toBe("hold");
    expect(held?.auditEvent).toBe("repository_drift_hold");
    expect(held?.auditError).toBe("ledger unavailable");
  });

  test("records a valid SWARM seed in shadow without blocking", async () => {
    const { dir, planPath, ledgerPath } = fixture();
    const result = await runFactoryPlanGate({
      decision: "SWARM", seedPath: planPath, workspaceRoot: dir,
      mode: "shadow", ledgerPath,
      ticketId: "linear-ticket-1", identifier: "ZOU-TEST", executionId: "exec-1",
    });
    expect(result?.action).toBe("proceed");
    expect(result?.plan_path).toBe(planPath);
    expect(result?.auditError).toBeUndefined();
    const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].artifact_sha256).not.toBe("0".repeat(64));
    expect(records[0].execution_action).toBe("proceed");
    expect(records[0].policy_mode).toBe("mandatory");
    expect(records[0].execution_mode).toBe("SWARM");
    expect(records[0].ticket_id).toBe("linear-ticket-1");
    expect(records[0].identifier).toBe("ZOU-TEST");
    expect(records[0].execution_id).toBe("exec-1");
  });

  test("records the factory's generated seed schema with a nonzero artifact hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-generated-seed-"));
    tempDirs.push(dir);
    const planPath = join(dir, "seed-zou-generated.yaml");
    const ledgerPath = join(dir, "audit.jsonl");
    writeFileSync(planPath, [
      "project_id: ZOU-GENERATED",
      "project_name: Factory generated seed",
      "repo: /home/workspace/example",
      "risk_level: high",
      "tasks:",
      "  - id: task-1",
      "    name: Verify generated artifact reachability",
      "    files:",
      "      - src/index.ts",
      "    deps: []",
      "acceptance:",
      "  - name: Shadow evidence",
      "    expect: The ledger contains a nonzero artifact hash.",
      "exit_conditions:",
      "  - All tests pass.",
      "",
    ].join("\n"));

    const result = await runFactoryPlanGate({
      decision: "SWARM", seedPath: planPath, workspaceRoot: dir,
      mode: "shadow", ledgerPath,
    });

    expect(result?.action).toBe("proceed");
    expect(result?.auditError).toBeUndefined();
    const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].artifact_sha256).not.toBe("0".repeat(64));
    expect(records[0].execution_action).toBe("proceed");
  });

  test("stamps ticket and execution provenance on shadow records", async () => {
    const { dir, planPath, ledgerPath } = fixture();
    const result = await runFactoryPlanGate({
      decision: "SWARM", seedPath: planPath, workspaceRoot: dir,
      mode: "shadow", ledgerPath,
      ticketId: "lin-uuid-123", identifier: "ZOU-742", executionId: "exec-abc",
    });
    expect(result?.action).toBe("proceed");
    expect(result?.auditError).toBeUndefined();
    const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].ticket_id).toBe("lin-uuid-123");
    expect(records[0].identifier).toBe("ZOU-742");
    expect(records[0].execution_id).toBe("exec-abc");
    expect(records[0].execution_mode).toBe("SWARM");
  });

  test("stamps FORCE_SWARM execution mode on shadow records", async () => {
    const { dir, planPath, ledgerPath } = fixture();
    await runFactoryPlanGate({
      decision: "FORCE_SWARM", seedPath: planPath, workspaceRoot: dir,
      mode: "shadow", ledgerPath,
      ticketId: "lin-uuid-456", identifier: "ZOU-743", executionId: "exec-def",
    });
    const records = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(records[0].execution_mode).toBe("FORCE_SWARM");
  });

  test("records missing SWARM seeds as instrumentation", async () => {
    const { dir, ledgerPath } = fixture();
    const result = await runFactoryPlanGate({
      decision: "FORCE_SWARM", seedPath: join(dir, "missing.yaml"), workspaceRoot: dir,
      mode: "shadow", ledgerPath,
    });
    expect(result?.action).toBe("proceed");
    expect(result?.auditError).toBeUndefined();
    expect(result?.reason).toBe("plan_artifact_missing");
    expect(result?.plan_path).toBeNull();
  });

  test("live factory invokes the gate before implementation routing", () => {
    const source = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    const gateCall = source.indexOf("await runFactoryPlanGate({");
    expect(gateCall).toBeGreaterThan(source.indexOf("const sf006SeedPath"));
    expect(gateCall).toBeLessThan(source.indexOf("const ticketPolicy", gateCall));
    expect(gateCall).toBeLessThan(source.indexOf("switch (d.decision)", gateCall));
    expect(source).toContain("exec.plan_gate = planGate");
    expect(source).toContain("ticketId: d.ticket.linear_id");
    expect(source).toContain("identifier: d.ticket.identifier");
    expect(source).toContain("executionId: execution_id");
  });
});
