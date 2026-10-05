import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptFactoryShadow, frozenFactoryAutomationDiff } from "./run-receipt-shadow-accept";
import { receiptShadowExternalConfigHash, type ReceiptShadowExternalConfig } from "./runtime-config";

const FACTORY_DIR = join(import.meta.dir, "..");
const POLICY_SOURCE = join(import.meta.dir, "../../../Skills/zouroboros-governance/config/autonomy-policy.json");
const REGISTRY_SOURCE = join(FACTORY_DIR, "config", "run-receipt-shadow-adapters.json");
const CLI = join(import.meta.dir, "run-receipt-shadow-accept.ts");
const TICKET = "5fe149b9-c520-4ecf-a96f-bc82ae145cc1";
let root = "";
let ticketsPath = "";
let lanePath = "";
let configPath = "";
let dbPath = "";
let env: Record<string, string> = {};

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ticketWrapper(count = 1): unknown {
  return {
    valid: Array.from({ length: count }, (_, index) => ({ linear_id: index === 0 ? TICKET : "eb331d52-ab73-46d6-838f-934535bf4750", identifier: index === 0 ? "ZOU-1055" : "ZOU-OTHER" })),
    rejected: [],
  };
}

function writeConfig(mode: "off" | "shadow"): void {
  const policyPath = join(root, "policy.json");
  const registryPath = join(root, "registry.json");
  const draft: ReceiptShadowExternalConfig = {
    contract_id: "zouroboros-run-receipt-shadow-config/v1",
    version: 1,
    updated_at: "2026-08-11T20:00:00.000Z",
    updated_by: "test",
    mode,
    activation_manifest_sha256: mode === "off" ? "0".repeat(64) : "a".repeat(64),
    effective_config_sha256: "0".repeat(64),
    automation_id: "7760679f-6ac8-461c-a567-43fae21c3eee",
    runtime: "zo-native",
    policy_path: policyPath,
    policy_sha256: hashFile(policyPath),
    database_path: dbPath,
    registry_path: registryPath,
    registry_sha256: hashFile(registryPath),
    cohort_amendment_sha256: "b".repeat(64),
    qualification_window_days: 225,
    required_operations_per_class: 30,
    max_plans_per_harvest: 12,
    max_database_bytes: 64 * 1024 * 1024,
    write_high_water_bytes: 56 * 1024 * 1024,
    github_readback_enabled: true,
  };
  if (mode === "shadow") draft.effective_config_sha256 = receiptShadowExternalConfigHash(draft);
  writeFileSync(configPath, `${JSON.stringify(draft, null, 2)}\n`);
  env.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = draft.activation_manifest_sha256;
  env.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = draft.effective_config_sha256;
}

function writeLane(rows: unknown[], cycle = "cycle-1"): void {
  writeFileSync(lanePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(`${lanePath}.current-cycle`, `${cycle}\n`);
}

function openRow(cycle = "cycle-1", patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, cycle_id: cycle, phase: "open", reason: null, ticket_id: null, identifier: null, execution_id: null, detail: null, ts: new Date().toISOString(), ...patch };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zou-1055-accept-"));
  ticketsPath = join(root, "tickets.json");
  lanePath = join(root, "lane.jsonl");
  configPath = join(root, "config.json");
  dbPath = join(root, "receipt.sqlite");
  writeFileSync(join(root, "policy.json"), readFileSync(POLICY_SOURCE));
  writeFileSync(join(root, "registry.json"), readFileSync(REGISTRY_SOURCE));
  writeFileSync(ticketsPath, JSON.stringify(ticketWrapper()));
  writeLane([openRow()]);
  writeConfig("shadow");
  env = {
    NODE_ENV: "test",
    FACTORY_RECEIPT_SHADOW_TEST_ROOT: root,
    FACTORY_RECEIPT_SHADOW_CONFIG_PATH: configPath,
    FACTORY_RECEIPT_SHADOW_MODE: "shadow",
    FACTORY_RECEIPT_SHADOW_AUTOMATION_ID: "7760679f-6ac8-461c-a567-43fae21c3eee",
    FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: "a".repeat(64),
    FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: JSON.parse(readFileSync(configPath, "utf8")).effective_config_sha256,
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("factory acceptance CLI", () => {
  test("returns off before ticket, lane, or database access", () => {
    writeConfig("off");
    const result = acceptFactoryShadow({ ticketsPath: join(root, "missing-ticket.json"), laneLedgerPath: join(root, "missing-lane.jsonl"), env });
    expect(result).toEqual({ mode: "off", status: "off", cycleId: null, ticketId: null, operationId: null, reasonCode: null });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("accepts exactly one validated ticket on the current unresolved lane", () => {
    const result = acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env });
    expect(result).toMatchObject({ mode: "shadow", status: "recorded", cycleId: "cycle-1", ticketId: TICKET });
    expect(result.operationId).toMatch(/^op-/);
    expect(existsSync(dbPath)).toBe(true);
  });

  test("holds on missing, duplicate, conflicting, or resolved lane evidence", () => {
    writeFileSync(ticketsPath, JSON.stringify(ticketWrapper(2)));
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env }).reasonCode).toBe("exactly_one_validated_ticket_required");
    writeFileSync(ticketsPath, JSON.stringify(ticketWrapper()));
    writeLane([openRow(), openRow()]);
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env }).reasonCode).toBe("lane_open_row_not_unique");
    writeLane([openRow("cycle-1", { ticket_id: "eb331d52-ab73-46d6-838f-934535bf4750" })]);
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env }).reasonCode).toBe("lane_ticket_conflict");
    writeLane([openRow(), { ...openRow(), phase: "outcome", reason: "empty_queue", ticket_id: TICKET }]);
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env }).reasonCode).toBe("lane_cycle_already_resolved");
    rmSync(`${lanePath}.current-cycle`);
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env }).reasonCode).toBe("current_lane_cycle_missing");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("rejects stale and future lane opens before storage", () => {
    writeLane([openRow("cycle-1", { ts: "2026-08-11T18:00:00.000Z" })]);
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env, now: () => "2026-08-11T20:00:00.000Z" }).reasonCode).toBe("lane_open_timestamp_stale");
    writeLane([openRow("cycle-1", { ts: "2026-08-11T20:00:01.000Z" })]);
    expect(acceptFactoryShadow({ ticketsPath, laneLedgerPath: lanePath, env, now: () => "2026-08-11T20:00:00.000Z" }).reasonCode).toBe("lane_open_timestamp_future");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("is fail-soft across real processes and freezes valued future commands", () => {
    const first = Bun.spawnSync({ cmd: ["bun", CLI, "--tickets", ticketsPath, "--lane-ledger", lanePath], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const second = Bun.spawnSync({ cmd: ["bun", CLI, "--tickets", ticketsPath, "--lane-ledger", lanePath], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.toString())).toMatchObject({ status: "recorded" });
    expect(["recorded", "held"]).toContain(JSON.parse(second.stdout.toString()).status);
    const diff = frozenFactoryAutomationDiff(
      "/home/workspace/.runtime/factory-conveyor-receipt-shadow-deadbeef",
      "a".repeat(64),
      "b".repeat(64),
    );
    expect(diff.environment).toContain("FACTORY_RECEIPT_SHADOW_CONFIG_PATH=/home/workspace/.runtime/evidence-substrate/config/run-receipt-shadow-runtime.json");
    expect(diff.environment).toContain(`FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH=${"a".repeat(64)}`);
    expect(diff.environment).toContain(`FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH=${"b".repeat(64)}`);
    expect(diff.beforeSwarmExec).toContain("--tickets \"$VALIDATED_TICKETS\"");
    expect(diff.cycleContract).toContain("--ticket-id \"$LINEAR_ID\" --cycle-id \"$CYCLE_ID\"");
    expect(diff.harvester).toContain("--max-plans 12");
  });
});
