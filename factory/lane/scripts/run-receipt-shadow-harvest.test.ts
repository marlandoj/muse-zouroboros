import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReceiptShadowHarvester } from "./run-receipt-shadow-harvest";
import { beginShadowRun, shadowAuthority } from "./run-receipt-shadow";
import { receiptShadowExternalConfigHash, type ReceiptShadowExternalConfig } from "./runtime-config";

const POLICY_SOURCE = join(import.meta.dir, "../../../Skills/zouroboros-governance/config/autonomy-policy.json");
const REGISTRY_SOURCE = join(import.meta.dir, "..", "config", "run-receipt-shadow-adapters.json");
const CLI = join(import.meta.dir, "run-receipt-shadow-harvest.ts");
const NOW = "2026-08-11T20:00:00.000Z";
let root = "";
let dbPath = "";
let lanePath = "";
let configPath = "";
let policyPath = "";
let registryPath = "";
let env: Record<string, string> = {};

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeConfig(mode: "off" | "shadow", overrides: Partial<ReceiptShadowExternalConfig> = {}): void {
  const config: ReceiptShadowExternalConfig = {
    contract_id: "zouroboros-run-receipt-shadow-config/v1",
    version: 1,
    updated_at: NOW,
    updated_by: "test",
    mode,
    activation_manifest_sha256: mode === "off" ? "0".repeat(64) : "a".repeat(64),
    effective_config_sha256: "0".repeat(64),
    automation_id: "7760679f-6ac8-461c-a567-43fae21c3eee",
    runtime: "zo-native",
    policy_path: policyPath,
    policy_sha256: fileHash(policyPath),
    database_path: dbPath,
    registry_path: registryPath,
    registry_sha256: fileHash(registryPath),
    cohort_amendment_sha256: "b".repeat(64),
    qualification_window_days: 225,
    required_operations_per_class: 30,
    max_plans_per_harvest: 12,
    max_database_bytes: 64 * 1024 * 1024,
    write_high_water_bytes: 56 * 1024 * 1024,
    github_readback_enabled: true,
    ...overrides,
  };
  if (mode === "shadow" && !("effective_config_sha256" in overrides)) config.effective_config_sha256 = receiptShadowExternalConfigHash(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  env.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = config.activation_manifest_sha256;
  env.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = config.effective_config_sha256;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zou-1055-harvest-"));
  dbPath = join(root, "journal.sqlite");
  lanePath = join(root, "lane.jsonl");
  configPath = join(root, "config.json");
  policyPath = join(root, "policy.json");
  registryPath = join(root, "registry.json");
  writeFileSync(policyPath, readFileSync(POLICY_SOURCE));
  writeFileSync(registryPath, readFileSync(REGISTRY_SOURCE));
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

function acceptScheduled(index: number): void {
  const cycle = `cycle-${index}`;
  const authority = shadowAuthority(env);
  const result = beginShadowRun({
    producerId: "factory-conveyor-scheduled",
    runClass: "scheduled_agent",
    idempotencyKey: `scheduled:${cycle}`,
    intent: { cycle_id: cycle },
    triggerIdentity: "7760679f-6ac8-461c-a567-43fae21c3eee",
    authority,
    observedEffect: {
      adapterKind: "workspace-lane-ledger",
      sideEffectKind: "file_write",
      target: `lane:${cycle}:open`,
      input: { cycle_id: cycle, phase: "open" },
      authorityScope: "observe:workspace",
      source: { writer: "factory-conveyor-scheduled", eventId: `lane:${cycle}:open` },
      evidence: { durable: true },
    },
    edge: {
      targetId: `lane:${cycle}:outcome`,
      expectedState: { cycle_id: cycle, phase: "outcome" },
      createdAt: NOW,
      deadline: "2026-08-11T20:05:00.000Z",
    },
  }, env);
  expect(result.status).toBe("recorded");
}

describe("receipt shadow harvester CLI", () => {
  test("off mode performs zero database, state, lane, or command work", async () => {
    writeConfig("off");
    let commands = 0;
    const missing = join(root, "missing");
    const result = await runReceiptShadowHarvester({ env, stateDir: missing, laneLedgerPath: missing, command: () => { commands++; return { status: 1, stdout: "", stderr: "" }; } });
    expect(result).toEqual({ mode: "off", scanned: 0, appended: 0, supplemented: 0, errors: [] });
    expect(commands).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("advances at most twelve durable plans and resumes the remainder", async () => {
    for (let index = 1; index <= 13; index++) acceptScheduled(index);
    writeFileSync(lanePath, Array.from({ length: 13 }, (_, offset) => JSON.stringify({ schema: 1, cycle_id: `cycle-${offset + 1}`, phase: "outcome", reason: "empty_queue", ticket_id: null, identifier: null, execution_id: null, detail: null, ts: NOW })).join("\n") + "\n");
    const first = await runReceiptShadowHarvester({ env, stateDir: root, laneLedgerPath: lanePath, maxPlans: 99, now: () => NOW });
    expect(first).toEqual({ mode: "shadow", scanned: 12, appended: 12, supplemented: 0, errors: [] });
    const second = await runReceiptShadowHarvester({ env, stateDir: root, laneLedgerPath: lanePath, maxPlans: 12, now: () => NOW });
    expect(second).toEqual({ mode: "shadow", scanned: 1, appended: 1, supplemented: 0, errors: [] });
  });

  test("makes the GitHub command path unreachable when readback is disabled", async () => {
    writeConfig("shadow", { github_readback_enabled: false });
    const authority = shadowAuthority(env);
    const repositoryHash = createHash("sha256").update("/repo/private").digest("hex");
    expect(beginShadowRun({
      producerId: "factory-github-shipping",
      runClass: "external_side_effect",
      idempotencyKey: "shipping:disabled:1",
      intent: { execution_id: "exec-disabled" },
      triggerIdentity: "7760679f-6ac8-461c-a567-43fae21c3eee",
      authority,
      observedEffect: {
        adapterKind: "github",
        sideEffectKind: "git_push",
        target: "shipping:exec-disabled:accepted",
        input: { execution_id: "exec-disabled" },
        authorityScope: "observe:github",
        source: { writer: "factory-github-shipping", eventId: "shipping:exec-disabled:accepted" },
        evidence: { durable: true },
      },
      edge: {
        targetId: `github:${repositoryHash}:exec-disabled`,
        expectedState: { repository_hash: repositoryHash, execution_id: "exec-disabled", user_visible: true },
        createdAt: NOW,
        deadline: "2026-08-11T20:05:00.000Z",
      },
    }, env).status).toBe("recorded");
    let commands = 0;
    const result = await runReceiptShadowHarvester({
      env,
      stateDir: root,
      laneLedgerPath: lanePath,
      now: () => NOW,
      command: () => { commands++; return { status: 0, stdout: "{}", stderr: "" }; },
    });
    expect(commands).toBe(0);
    expect(result).toMatchObject({ mode: "shadow", scanned: 1, appended: 0 });
  });

  test("returns deterministic fail-soft JSON for config drift in a real process", () => {
    writeConfig("shadow", { policy_sha256: "c".repeat(64) });
    const run = () => Bun.spawnSync({ cmd: ["bun", CLI, "--state-dir", root, "--lane-ledger", lanePath], env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const first = run();
    const second = run();
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout.toString()).toBe(second.stdout.toString());
    expect(JSON.parse(first.stdout.toString())).toMatchObject({ mode: "shadow", scanned: 0, appended: 0, supplemented: 0 });
  });
});
