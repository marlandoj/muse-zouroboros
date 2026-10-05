import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { buildReceiptShadowReport, hasExactCohortVolume } from "./run-receipt-shadow-report";
import {
  beginShadowRun,
  completeShadowRun,
  harvestEdgeProofs,
  RECEIPT_SHADOW_WRITE_HIGH_WATER_BYTES,
  shadowAuthority,
  type BeginShadowRunInput,
  type ReceiptShadowRunClass,
} from "./run-receipt-shadow";
import type { EdgeProofAdapter } from "./run-edge-proof";
import { OperationJournal, type JournalAuthority, type ObservationalEffectWriter } from "./run-operation-journal";
import {
  receiptShadowExternalConfigHash,
  type ReceiptShadowExternalConfig,
} from "./runtime-config";

const FACTORY_DIR = join(import.meta.dir, "..");
const REGISTRY_SOURCE = join(FACTORY_DIR, "config", "run-receipt-shadow-adapters.json");
const REPORT_CLI = join(import.meta.dir, "run-receipt-shadow-report.ts");
const LANE_CLI = join(import.meta.dir, "lane-utilization.ts");
const CYCLE_CLI = join(import.meta.dir, "cycle-contract.ts");
let root = "";
let dbPath = "";
let registryPath = "";
let policyPath = "";
let configPath = "";
let env: Record<string, string> = {};

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeShadowConfig(overrides: Partial<ReceiptShadowExternalConfig> = {}): ReceiptShadowExternalConfig {
  const draft: ReceiptShadowExternalConfig = {
    contract_id: "zouroboros-run-receipt-shadow-config/v1",
    version: 1,
    updated_at: "2026-08-11T19:00:00.000Z",
    updated_by: "test",
    mode: "shadow",
    activation_manifest_sha256: "a".repeat(64),
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
    write_high_water_bytes: RECEIPT_SHADOW_WRITE_HIGH_WATER_BYTES,
    github_readback_enabled: true,
    ...overrides,
  };
  if (draft.mode === "shadow" && !("effective_config_sha256" in overrides)) {
    draft.effective_config_sha256 = receiptShadowExternalConfigHash(draft);
  }
  writeFileSync(configPath, `${JSON.stringify(draft, null, 2)}\n`);
  env.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = draft.activation_manifest_sha256;
  env.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = draft.effective_config_sha256;
  return draft;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zou-1055-shadow-"));
  dbPath = join(root, "journal.sqlite");
  registryPath = join(root, "registry.json");
  policyPath = join(root, "autonomy-policy.json");
  configPath = join(root, "receipt-config.json");
  writeFileSync(registryPath, readFileSync(REGISTRY_SOURCE));
  writeFileSync(policyPath, readFileSync(join(import.meta.dir, "../../../Skills/zouroboros-governance/config/autonomy-policy.json")));
  writeShadowConfig();
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

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function authority(): JournalAuthority {
  return shadowAuthority(env);
}

function writerFor(runClass: ReceiptShadowRunClass): ObservationalEffectWriter {
  if (runClass === "scheduled_agent") return "factory-conveyor-scheduled";
  if (runClass === "factory_execution") return "factory-cycle-contract";
  return "factory-github-shipping";
}

function producerFor(runClass: ReceiptShadowRunClass): string {
  return writerFor(runClass);
}

function beginInput(runClass: ReceiptShadowRunClass, key: string, attemptN = 1): BeginShadowRunInput {
  const writer = writerFor(runClass);
  const adapterKind = runClass === "external_side_effect" ? "github" : "workspace";
  return {
    producerId: producerFor(runClass),
    runClass,
    idempotencyKey: key,
    intent: { key, class: runClass },
    triggerIdentity: key,
    authority: authority(),
    attemptN,
    observedEffect: {
      adapterKind,
      sideEffectKind: runClass === "external_side_effect" ? "git_push" : "file_write",
      target: `${key}:attempt:${attemptN}:accepted`,
      input: { state_hash: "a".repeat(64) },
      authorityScope: `observe:${adapterKind}`,
      source: { writer, eventId: `${key}:attempt:${attemptN}:accepted` },
      evidence: { durable: true },
    },
    edge: {
      targetId: `${key}:edge`,
      expectedState: { state: "complete" },
      createdAt: "2026-08-11T19:00:00.000Z",
      deadline: "2026-08-11T19:05:00.000Z",
      pollIntervalMs: 0,
    },
  };
}

function completeInput(runClass: ReceiptShadowRunClass, key: string, attemptN = 1) {
  const writer = writerFor(runClass);
  const adapterKind = runClass === "external_side_effect" ? "github" : "workspace";
  return {
    producerId: producerFor(runClass),
    runClass,
    idempotencyKey: key,
    authority: authority(),
    attemptN,
    attemptStatus: "success" as const,
    terminalOutcome: "success" as const,
    reasonCode: "complete",
    sourceRevision: "d2435fe51bfc6fcc4781c30a325792731c70c74c",
    observedEffect: {
      adapterKind,
      sideEffectKind: runClass === "external_side_effect" ? "git_push" as const : "file_write" as const,
      target: `${key}:attempt:${attemptN}:terminal`,
      input: { state_hash: "b".repeat(64) },
      authorityScope: `observe:${adapterKind}`,
      source: { writer, eventId: `${key}:attempt:${attemptN}:terminal` },
      evidence: { durable: true },
    },
  };
}

describe("default-off and registry boundaries", () => {
  test("missing and off mode return before any path or storage access", () => {
    const input = beginInput("scheduled_agent", "off");
    expect(beginShadowRun(input, {})).toEqual({ mode: "off", status: "off" });
    expect(beginShadowRun(input, {
      FACTORY_RECEIPT_SHADOW_MODE: "off",
      FACTORY_RECEIPT_SHADOW_DB_PATH: dbPath,
      FACTORY_RECEIPT_SHADOW_REGISTRY_PATH: join(root, "missing.json"),
    })).toEqual({ mode: "off", status: "off" });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("invalid mode and producer fail before journal mutation", () => {
    writeFileSync(configPath, `${JSON.stringify({ ...writeShadowConfig(), mode: "enforce" })}\n`);
    const invalidMode = beginShadowRun(beginInput("scheduled_agent", "invalid-mode"), {
      ...env,
    });
    expect(invalidMode.status).toBe("error");
    expect(existsSync(dbPath)).toBe(false);
    writeShadowConfig();
    const input = { ...beginInput("scheduled_agent", "bad-producer"), producerId: "unknown" };
    expect(beginShadowRun(input, env).status).toBe("error");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("zero or missing authority hashes never grant receipt authority", () => {
    expect(shadowAuthority({ FACTORY_RECEIPT_SHADOW_MODE: "shadow" }).envelopeKind).toBe("none");
    writeShadowConfig({ activation_manifest_sha256: "0".repeat(64), effective_config_sha256: "0".repeat(64) });
    expect(shadowAuthority(env).envelopeKind).toBe("none");
    writeShadowConfig({ policy_sha256: "c".repeat(64) });
    expect(shadowAuthority(env).envelopeKind).toBe("none");
    writeShadowConfig();
    expect(shadowAuthority(env)).toMatchObject({
      envelopeKind: "receipt_authority",
      scopes: ["operation.reserve", "observe:workspace", "observe:github"],
    });
    expect(shadowAuthority({ ...env, FACTORY_RECEIPT_SHADOW_AUTOMATION_ID: "5fe149b9-c520-4ecf-a96f-bc82ae145cc1" }).envelopeKind).toBe("none");
    expect(shadowAuthority({ ...env, FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: "d".repeat(64) }).envelopeKind).toBe("none");
    expect(shadowAuthority({ ...env, FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: "e".repeat(64) }).envelopeKind).toBe("none");
  });

  test("surplus runtime or automation grants fail closed before storage", () => {
    const original = JSON.parse(readFileSync(policyPath, "utf8")) as Record<string, any>;
    writeFileSync(policyPath, `${JSON.stringify({
      ...original,
      receipt_shadow: { ...original.receipt_shadow, allowed_runtimes: ["zo-native", "codex"] },
    }, null, 2)}\n`);
    writeShadowConfig();
    expect(shadowAuthority(env).envelopeKind).toBe("none");
    expect(beginShadowRun(beginInput("scheduled_agent", "surplus-runtime"), env).status).toBe("error");
    expect(existsSync(dbPath)).toBe(false);

    writeFileSync(policyPath, `${JSON.stringify({
      ...original,
      receipt_shadow: { ...original.receipt_shadow, automation_ids: [original.receipt_shadow.automation_ids[0], "5fe149b9-c520-4ecf-a96f-bc82ae145cc1"] },
    }, null, 2)}\n`);
    writeShadowConfig();
    expect(shadowAuthority(env).envelopeKind).toBe("none");
    expect(beginShadowRun(beginInput("scheduled_agent", "surplus-automation"), env).status).toBe("error");
    expect(existsSync(dbPath)).toBe(false);
  });

  test("cycle CLI is byte- and exit-identical for missing versus off mode", () => {
    const run = (mode?: string) => Bun.spawnSync({
      cmd: ["bun", CYCLE_CLI, "--ticket-id", "no-such-ticket"],
      env: { ...process.env, ...(mode ? { FACTORY_RECEIPT_SHADOW_MODE: mode } : {}) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const missing = run();
    const off = run("off");
    expect(off.exitCode).toBe(missing.exitCode);
    expect(off.stdout.toString()).toBe(missing.stdout.toString());
    expect(off.stderr.toString()).toBe(missing.stderr.toString());
    expect(existsSync(dbPath)).toBe(false);
  });

  test("lane CLI is byte- and exit-identical for missing versus off mode", () => {
    const invoke = (mode: "missing" | "off", lanePath: string, args: string[]) => {
      const childEnv: Record<string, string | undefined> = { ...process.env, LANE_UTILIZATION_PATH: lanePath };
      if (mode === "off") childEnv.FACTORY_RECEIPT_SHADOW_MODE = "off";
      else delete childEnv.FACTORY_RECEIPT_SHADOW_MODE;
      return Bun.spawnSync({ cmd: ["bun", LANE_CLI, ...args], env: childEnv, stdout: "pipe", stderr: "pipe" });
    };
    const missingLane = join(root, "missing-lane.jsonl");
    const offLane = join(root, "off-lane.jsonl");
    const beginArgs = ["begin", "--cycle", "cycle-off-parity"];
    const missingBegin = invoke("missing", missingLane, beginArgs);
    const offBegin = invoke("off", offLane, beginArgs);
    expect({ code: offBegin.exitCode, stdout: offBegin.stdout.toString(), stderr: offBegin.stderr.toString() })
      .toEqual({ code: missingBegin.exitCode, stdout: missingBegin.stdout.toString(), stderr: missingBegin.stderr.toString() });
    const recordArgs = ["record", "--cycle", "cycle-off-parity", "--reason", "empty_queue"];
    const missingRecord = invoke("missing", missingLane, recordArgs);
    const offRecord = invoke("off", offLane, recordArgs);
    expect({ code: offRecord.exitCode, stdout: offRecord.stdout.toString(), stderr: offRecord.stderr.toString() })
      .toEqual({ code: missingRecord.exitCode, stdout: missingRecord.stdout.toString(), stderr: missingRecord.stderr.toString() });
    const normalizedRows = (path: string) => readFileSync(path, "utf8").trim().split("\n")
      .map((line) => ({ ...JSON.parse(line), ts: "<normalized>" }));
    expect(normalizedRows(offLane)).toEqual(normalizedRows(missingLane));
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("facade lifecycle and read-only harvesting", () => {
  test("requires exactly 30 operations per class for the frozen cohort", () => {
    expect(hasExactCohortVolume({ scheduled_agent: 30, factory_execution: 30, external_side_effect: 30 })).toBe(true);
    expect(hasExactCohortVolume({ scheduled_agent: 31, factory_execution: 30, external_side_effect: 30 })).toBe(false);
  });

  test("records restart-stable receipts without letting confirmed plans starve the bounded harvester", async () => {
    const started = beginShadowRun(beginInput("scheduled_agent", "scheduled:1"), env);
    expect(started.status).toBe("recorded");
    const completed = completeShadowRun(completeInput("scheduled_agent", "scheduled:1"), env);
    expect(completed).toMatchObject({ status: "recorded" });
    const before = buildReceiptShadowReport(dbPath);
    expect(before.classes.scheduled_agent).toMatchObject({ operations: 1, receipts: 1, complete: 1, edgeBound: 0 });

    const adapter: EdgeProofAdapter = {
      kind: "workspace",
      version: "workspace-artifact/v1",
      probe: (request) => ({
        status: "confirmed",
        acknowledgementTier: "durable_confirmed",
        operationId: request.operationId,
        actorHash: request.actorHash,
        targetHash: request.targetHash,
        observedStateHash: request.expectedStateHash,
        observedAt: "2026-08-11T19:00:10.000Z",
        sourceRevision: "workspace-revision-1",
        providerEventId: null,
        payloadHash: "c".repeat(64),
        reasonCode: null,
      }),
    };
    const harvested = await harvestEdgeProofs({
      adapters: [adapter],
      authority: authority(),
      now: () => "2026-08-11T19:00:10.000Z",
    }, env);
    expect(harvested).toMatchObject({ appended: 1, supplemented: 1, errors: [] });
    const reopened = buildReceiptShadowReport(dbPath);
    expect(reopened.classes.scheduled_agent.edgeBound).toBe(1);
    expect(reopened.producer_overhead_ms.count).toBe(2);

    expect(beginShadowRun(beginInput("scheduled_agent", "scheduled:2"), env).status).toBe("recorded");
    expect(completeShadowRun(completeInput("scheduled_agent", "scheduled:2"), env).status).toBe("recorded");
    const secondHarvest = await harvestEdgeProofs({
      adapters: [adapter],
      authority: authority(),
      now: () => "2026-08-11T19:00:11.000Z",
      maxPlans: 1,
    }, env);
    expect(secondHarvest).toMatchObject({ scanned: 1, appended: 1, supplemented: 1, errors: [] });
    expect(buildReceiptShadowReport(dbPath).classes.scheduled_agent.edgeBound).toBe(2);

    const child = Bun.spawn(["bun", REPORT_CLI, "--db", dbPath], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).classes.scheduled_agent.receipts).toBe(2);
  });

  test("keeps retryable shipping attempts nonterminal across explicit requeue", () => {
    const key = "github:repo:execution-1";
    expect(beginShadowRun(beginInput("external_side_effect", key), env).status).toBe("recorded");
    const retry = completeShadowRun({
      ...completeInput("external_side_effect", key),
      attemptStatus: "failure",
      error: "transient",
      retryReason: "explicit_requeue",
      retryable: true,
      terminalOutcome: null,
    }, env);
    expect(retry.status).toBe("nonterminal");
    expect(beginShadowRun(beginInput("external_side_effect", key, 2), env).status).toBe("recorded");
    expect(completeShadowRun(completeInput("external_side_effect", key, 2), env)).toMatchObject({ status: "recorded" });
    const db = new Database(dbPath, { readonly: true });
    try {
      expect((db.query("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count).toBe(1);
      expect((db.query("SELECT COUNT(*) AS count FROM receipts").get() as { count: number }).count).toBe(1);
    } finally {
      db.close();
    }
  });

  test("rejects authority drift even when completion carries no observed effect", () => {
    const key = "github:repo:authority-drift";
    expect(beginShadowRun(beginInput("external_side_effect", key), env).status).toBe("recorded");
    const result = completeShadowRun({
      ...completeInput("external_side_effect", key),
      authority: { ...authority(), approvalRef: "different-approval" },
      observedEffect: undefined,
      terminalOutcome: "held",
    }, env);
    expect(result).toMatchObject({ status: "error", reasonCode: "receipt shadow authority mismatch" });
    expect(buildReceiptShadowReport(dbPath).classes.external_side_effect.receipts).toBe(0);
  });

  test("freezes a diagnostic 4/4/4 incident sample with bounded artifacts and clean integrity", async () => {
    for (const runClass of ["scheduled_agent", "factory_execution", "external_side_effect"] as const) {
      for (let index = 1; index <= 4; index++) {
        const key = `${runClass}:incident:${index}`;
        expect(beginShadowRun(beginInput(runClass, key), env).status).toBe("recorded");
        expect(completeShadowRun(completeInput(runClass, key), env).status).toBe("recorded");
      }
    }
    const adapters: EdgeProofAdapter[] = [
      {
        kind: "workspace",
        version: "workspace-artifact/v1",
        probe: (request) => ({
          status: "confirmed",
          acknowledgementTier: "durable_confirmed",
          operationId: request.operationId,
          actorHash: request.actorHash,
          targetHash: request.targetHash,
          observedStateHash: request.expectedStateHash,
          observedAt: "2026-08-11T19:00:10.000Z",
          sourceRevision: "workspace-revision-incident",
          providerEventId: null,
          payloadHash: "d".repeat(64),
          reasonCode: null,
        }),
      },
      {
        kind: "github",
        version: "github-readback/v1",
        probe: (request) => ({
          status: "confirmed",
          acknowledgementTier: "user_visible_confirmed",
          operationId: request.operationId,
          actorHash: request.actorHash,
          targetHash: request.targetHash,
          observedStateHash: request.expectedStateHash,
          observedAt: "2026-08-11T19:00:10.000Z",
          sourceRevision: "github-revision-incident",
          providerEventId: "github-event-incident",
          payloadHash: "e".repeat(64),
          reasonCode: null,
        }),
      },
    ];
    expect(await harvestEdgeProofs({
      adapters,
      authority: authority(),
      now: () => "2026-08-11T19:00:10.000Z",
      maxPlans: 12,
    }, env)).toMatchObject({ scanned: 12, appended: 12, supplemented: 12, errors: [] });

    const report = buildReceiptShadowReport(dbPath);
    expect(report.incident_sample).toHaveLength(12);
    for (const runClass of ["scheduled_agent", "factory_execution", "external_side_effect"] as const) {
      expect(report.incident_sample.filter((sample) => sample.runClass === runClass)).toHaveLength(4);
      expect(report.classes[runClass]).toMatchObject({
        operations: 4,
        receipts: 4,
        complete: 4,
        edgeBound: 4,
      });
    }
    expect(report.incident_sample.every((sample) => sample.score >= 8)).toBe(true);
    expect(report.gates).toMatchObject({
      producerLatency: true,
      bundleSize: true,
      databaseSize: true,
      integrity: true,
      incidentDiagnosis: true,
    });
    expect(report.restart_state).toEqual({ openOperations: 0, incompleteAttempts: 0 });
    expect(report.duplicates).toEqual({ idempotency: 0, committedEffects: 0 });
    expect(report.max_bundle_bytes_gzip).toBeLessThanOrEqual(65_536);
    expect(report.producer_overhead_ms.p95).toBeLessThanOrEqual(250);
  });

  test("holds before opening a near-ceiling journal and stays within the producer budget", () => {
    const journal = new OperationJournal(dbPath);
    journal.db.exec("CREATE TABLE ceiling_fixture (payload BLOB NOT NULL)");
    journal.db.query("INSERT INTO ceiling_fixture(payload) VALUES (zeroblob(?))").run(60 * 1024 * 1024);
    journal.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    journal.close();
    expect(statSync(dbPath).size).toBeGreaterThan(60 * 1024 * 1024);
    expect(statSync(dbPath).size).toBeLessThan(64 * 1024 * 1024);
    expect(statSync(dbPath).size).toBeGreaterThan(RECEIPT_SHADOW_WRITE_HIGH_WATER_BYTES);

    const result = beginShadowRun(beginInput("scheduled_agent", "scheduled:near-ceiling"), env);
    expect(result).toMatchObject({ status: "held", reasonCode: "receipt_shadow_database_high_water" });
    expect(result.mode === "shadow" ? result.producerOverheadMs : Infinity).toBeLessThanOrEqual(250);
    expect(buildReceiptShadowReport(dbPath).totals.operations).toBe(0);
  });

  test("reports completion without durable acceptance as dangling", () => {
    const result = completeShadowRun(completeInput("factory_execution", "factory:missing"), env);
    expect(result).toMatchObject({ status: "dangling", reasonCode: "accepted_operation_missing" });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("lane begin and record resume across real CLI processes", () => {
    const lanePath = join(root, "lane.jsonl");
    const childEnv = { ...process.env, ...env, LANE_UTILIZATION_PATH: lanePath };
    const begin = Bun.spawnSync({
      cmd: ["bun", LANE_CLI, "begin", "--cycle", "cycle-cli-1"],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(begin.exitCode).toBe(0);
    expect(begin.stdout.toString()).toBe("cycle-cli-1\n");
    const record = Bun.spawnSync({
      cmd: ["bun", LANE_CLI, "record", "--cycle", "cycle-cli-1", "--reason", "empty_queue"],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(record.exitCode).toBe(0);
    expect(record.stdout.toString()).toBe("");
    expect(buildReceiptShadowReport(dbPath).classes.scheduled_agent).toMatchObject({
      operations: 1,
      receipts: 1,
      complete: 1,
    });
  });

  test("lane begin reaps a stale cycle with a cancelled receipt", () => {
    const lanePath = join(root, "lane-reap.jsonl");
    const childEnv = { ...process.env, ...env, LANE_UTILIZATION_PATH: lanePath };
    const first = Bun.spawnSync({
      cmd: ["bun", LANE_CLI, "begin", "--cycle", "cycle-cli-stale"],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(first.exitCode).toBe(0);

    const open = JSON.parse(readFileSync(lanePath, "utf8").trim());
    writeFileSync(lanePath, `${JSON.stringify({ ...open, ts: "2026-08-18T00:00:00.000Z" })}\n`);
    const second = Bun.spawnSync({
      cmd: ["bun", LANE_CLI, "begin", "--cycle", "cycle-cli-new"],
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString()).toBe("cycle-cli-new\n");

    const rows = readFileSync(lanePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toContainEqual(expect.objectContaining({
      cycle_id: "cycle-cli-stale",
      phase: "outcome",
      reason: "superseded",
    }));

    const db = new Database(dbPath, { readonly: true });
    const receiptRow = db.query("SELECT canonical_receipt FROM receipts").get() as { canonical_receipt: string };
    const terminal = db.query("SELECT outcome, reason_code FROM terminal_records").get() as {
      outcome: string;
      reason_code: string;
    };
    const receipt = JSON.parse(receiptRow.canonical_receipt);
    db.close();
    expect(receipt.terminal).toMatchObject({ outcome: "cancelled" });
    expect(terminal).toEqual({ outcome: "cancelled", reason_code: "lane_superseded" });
    expect(receipt.attempts[0]).toMatchObject({ status: "cancelled" });
  });

  test("factory CLI requires a matching unresolved durable lane open row", () => {
    const cycleId = "cycle-cli-factory";
    const ticketId = "linear-cli-factory";
    const lanePath = join(root, "factory-lane.jsonl");
    const accepted = beginInput("factory_execution", `factory:${cycleId}:${ticketId}`);
    accepted.authority = shadowAuthority(env);
    accepted.observedEffect.target = `lane:${cycleId}:accepted`;
    accepted.observedEffect.source.eventId = `factory:${cycleId}:${ticketId}:accepted`;
    expect(beginShadowRun(accepted, env).status).toBe("recorded");
    writeFileSync(lanePath, `${JSON.stringify({
      schema: 1,
      cycle_id: cycleId,
      phase: "open",
      reason: null,
      ticket_id: null,
      identifier: null,
      execution_id: null,
      detail: null,
      ts: "2026-08-11T19:00:00.000Z",
    })}\n`);
    const run = Bun.spawnSync({
      cmd: ["bun", CYCLE_CLI, "--ticket-id", ticketId, "--cycle-id", cycleId],
      env: { ...process.env, ...env, LANE_UTILIZATION_PATH: lanePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout.toString())).toMatchObject({ outcome: "no_record", needs_email: true });
    expect(buildReceiptShadowReport(dbPath).classes.factory_execution.receipts).toBe(1);

    const staleDb = join(root, "stale.sqlite");
    writeFileSync(lanePath, `${readFileSync(lanePath, "utf8")}${JSON.stringify({
      schema: 1,
      cycle_id: cycleId,
      phase: "outcome",
      reason: "empty_queue",
      ticket_id: ticketId,
      identifier: null,
      execution_id: null,
      detail: null,
      ts: "2026-08-11T19:01:00.000Z",
    })}\n`);
    const stale = Bun.spawnSync({
      cmd: ["bun", CYCLE_CLI, "--ticket-id", ticketId, "--cycle-id", cycleId],
      env: { ...process.env, ...env, FACTORY_RECEIPT_SHADOW_DB_PATH: staleDb, LANE_UTILIZATION_PATH: lanePath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(stale.exitCode).toBe(1);
    expect(existsSync(staleDb)).toBe(false);
  });

  test("freezes the declared adversarial case matrix", () => {
    const fixture = JSON.parse(readFileSync(join(FACTORY_DIR, "fixtures", "run-receipt-shadow", "cases.json"), "utf8"));
    expect(fixture.contract_id).toBe("zouroboros-run-receipt-shadow/v1");
    expect(fixture.cases).toHaveLength(16);
  });
});
