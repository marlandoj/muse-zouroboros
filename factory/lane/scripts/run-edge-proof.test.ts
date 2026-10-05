import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonicalize, type RunReceipt } from "./run-receipt-contract";
import {
  buildEdgeProofRecord,
  createEdgeProofPlan,
  createGitHubEdgeProofAdapter,
  createLinearEdgeProofAdapter,
  createWorkspaceEdgeProofAdapter,
  edgeBindingMetrics,
  EdgeProofError,
  probeEdgeOnce,
  recordLateEdgeConfirmation,
  validateEdgeProofPlan,
  validateEdgeProofRecord,
  type EdgeProofObservation,
  type EdgeProofPlan,
  type EdgeProbeResponse,
} from "./run-edge-proof";
import { OperationJournal, type JournalAuthority } from "./run-operation-journal";
import { createVerifiedBackup, JOURNAL_SCHEMA_VERSION, openJournalDatabase, restoreVerifiedBackup } from "./run-operation-journal-schema";

const FACTORY_DIR = join(import.meta.dir, "..");
const STATE_DIR = join(FACTORY_DIR, "state");
const TEMPLATE = JSON.parse(readFileSync(join(FACTORY_DIR, "fixtures", "run-receipt", "valid-success.json"), "utf8")) as RunReceipt;
const FIXTURE = JSON.parse(readFileSync(join(FACTORY_DIR, "fixtures", "run-edge-proof", "cases.json"), "utf8")) as { cases: Array<{ id: string; expect: string }> };
const HASH_A = createHash("sha256").update("actor").digest("hex");
const HASH_VERIFIER = createHash("sha256").update("verifier").digest("hex");
const HASH_STATE = createHash("sha256").update("expected-state").digest("hex");
const HASH_PAYLOAD = createHash("sha256").update("payload").digest("hex");
const T0 = "2026-08-11T00:00:00.000Z";
const T1 = "2026-08-11T00:01:00.000Z";
let root = "";

beforeAll(() => {
  mkdirSync(STATE_DIR, { recursive: true });
  root = mkdtempSync(join(STATE_DIR, "zou-1054-test-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function pathFor(name: string): string {
  return join(root, `${name}.sqlite`);
}

function authority(scopes = ["operation.reserve", "observe:github", "observe:linear", "observe:workspace"]): JournalAuthority {
  return {
    envelopeKind: "operator_approval",
    approvingAuthority: "test",
    approvalTs: T0,
    approvalRef: "test",
    autonomyTier: "T0",
    authorizationEvidenceRef: "test",
    scopes,
    expiresAt: null,
  };
}

function reserve(journal: OperationJournal, key: string): string {
  const result = journal.reserve({
    scope: "edge-proof-test",
    idempotencyKey: key,
    intent: { key },
    triggerKind: "factory",
    triggerIdentity: "edge-proof-test",
    authority: authority(),
  });
  if (result.status !== "reserved") throw new Error(result.reasonCode);
  journal.beginAttempt(result.operationId, 1);
  journal.completeAttempt(result.operationId, 1, "success");
  return result.operationId;
}

function planInput(
  operationId: string,
  adapterKind: "github" | "linear" | "workspace" = "github",
  overrides: Partial<Parameters<typeof createEdgeProofPlan>[0]> = {},
): Parameters<typeof createEdgeProofPlan>[0] {
  return {
    operationId,
    traceId: `trace-${operationId}`,
    actorHash: HASH_A,
    verifierIdentityHash: HASH_VERIFIER,
    adapterKind,
    adapterVersion: "1.0.0",
    targetId: `${adapterKind}:target`,
    expectedStateHash: HASH_STATE,
    requirement: "required",
    preRegisteredNoSideEffects: false,
    declaredExternalEffects: 1,
    createdAt: T0,
    deadline: T1,
    maxAttempts: 3,
    probeTimeoutMs: 50,
    pollIntervalMs: 1_000,
    ...overrides,
  };
}

function plan(operationId: string, adapterKind: "github" | "linear" | "workspace" = "github", overrides: Partial<Parameters<typeof createEdgeProofPlan>[0]> = {}): EdgeProofPlan {
  return createEdgeProofPlan(planInput(operationId, adapterKind, overrides));
}

function confirmed(planValue: EdgeProofPlan, observedAt = "2026-08-11T00:00:30.000Z"): EdgeProbeResponse {
  return {
    status: "confirmed",
    acknowledgementTier: "user_visible_confirmed",
    operationId: planValue.operation_id,
    actorHash: planValue.actor_hash,
    targetHash: planValue.target_hash,
    observedStateHash: planValue.expected_state_hash,
    observedAt,
    sourceRevision: "revision-1",
    providerEventId: `provider-${planValue.adapter.kind}-${observedAt}`,
    payloadHash: HASH_PAYLOAD,
    reasonCode: null,
  };
}

function binding() {
  return {
    receiptId: "rr-00000000000000000000000000",
    receiptHash: "a".repeat(64),
    terminalEventId: "evt-00000000000000000000000000",
    terminalSourceRef: "terminal-source",
  };
}

describe("edge proof contract and read-only adapters", () => {
  test("freezes classification and rejects post-hoc notApplicable", () => {
    expect(() => createEdgeProofPlan(planInput("op-00000000000000000000000000", "github", {
      requirement: "notApplicable",
      preRegisteredNoSideEffects: false,
      declaredExternalEffects: 1,
      maxAttempts: 1,
      probeTimeoutMs: 10,
      pollIntervalMs: 0,
      traceId: "trace",
    }))).toThrow("preregistered no-side-effect");
    expect(() => createEdgeProofPlan(planInput("op-00000000000000000000000000", "github", {
      traceId: "trace",
      verifierIdentityHash: HASH_A,
      maxAttempts: 1,
      probeTimeoutMs: 10,
      pollIntervalMs: 0,
    }))).toThrow("verifier identity must differ");
    expect(() => createEdgeProofPlan(planInput("op-U0000000000000000000000000", "github", {
      adapterKind: "email" as never,
    }))).toThrow("unsupported adapter email");
    expect(() => createEdgeProofPlan(planInput("op-R0000000000000000000000000", "github", {
      traceId: "x".repeat(9_000),
    }))).toThrow("exceeds 8 KiB");
    expect(() => createEdgeProofPlan(planInput("op-P0000000000000000000000000", "github", {
      maxAttempts: 13,
    }))).toThrow("max attempts must be 1-12");
    expect(() => createEdgeProofPlan(planInput("op-D0000000000000000000000000", "github", {
      deadline: "2026-08-11T00:05:00.001Z",
    }))).toThrow("300000ms total polling ceiling");
    for (const targetId of [
      "https://github.com/o/r",
      "/home/workspace/repo",
      "../../etc/passwd",
      "file:etc-passwd",
      "ssh:host",
      "repo\\secret",
      "target\nsecret",
      "github:token:value",
      "github:user@host",
      "github:target?state=open",
      "github:target#fragment",
      "github:key=value",
    ]) {
      expect(() => createEdgeProofPlan(planInput("op-S0000000000000000000000000", "github", { targetId }))).toThrow("target ref must be opaque");
    }
    const current = plan("op-H0000000000000000000000000");
    expect(current.target_ref).toBe("github:target");
    expect(() => validateEdgeProofPlan({ ...current, target_ref: "github:other" })).toThrow("target ref does not match target hash");
  });

  test("excludes only preregistered no-side-effect plans from the denominator", () => {
    const current = plan("op-N0000000000000000000000000", "workspace", {
      requirement: "notApplicable",
      preRegisteredNoSideEffects: true,
      declaredExternalEffects: 0,
    });
    const record = buildEdgeProofRecord(current, binding(), null, null);
    expect(record).toMatchObject({
      classification: "notApplicable",
      acknowledgement_tier: "none",
      timeliness: "not_applicable",
    });
    expect(edgeBindingMetrics([record])).toEqual({ numerator: 0, denominator: 0, ratio: 1 });
  });

  test("confirms GitHub, Linear, and workspace targets through injected read clients", async () => {
    for (const kind of ["github", "linear", "workspace"] as const) {
      const current = plan(`op-${kind === "github" ? "A" : kind === "linear" ? "B" : "C"}`.padEnd(29, "0"), kind);
      let calls = 0;
      const client = { read: () => {
        calls++;
        return { ...confirmed(current), acknowledgementTier: kind === "github" ? "user_visible_confirmed" as const : "durable_confirmed" as const };
      } };
      const adapter = kind === "github"
        ? createGitHubEdgeProofAdapter("1.0.0", client)
        : kind === "linear"
          ? createLinearEdgeProofAdapter("1.0.0", client)
          : createWorkspaceEdgeProofAdapter("1.0.0", client);
      const observation = await probeEdgeOnce(current, [], adapter, { scopes: [`observe:${kind}`], expiresAt: null }, "2026-08-11T00:00:20.000Z");
      expect(observation.status).toBe("confirmed");
      expect(observation.acknowledgement_tier).toBe(kind === "github" ? "user_visible_confirmed" : "durable_confirmed");
      expect(calls).toBe(1);
    }
  });

  test("does not call adapters without narrow read authority", async () => {
    const current = plan("op-D0000000000000000000000000");
    let calls = 0;
    const adapter = createGitHubEdgeProofAdapter("1.0.0", { read: () => { calls++; return confirmed(current); } });
    const observation = await probeEdgeOnce(current, [], adapter, { scopes: [], expiresAt: null }, "2026-08-11T00:00:20.000Z");
    expect(observation).toMatchObject({ status: "unavailable", reason_code: "read_authority_unavailable" });
    expect(calls).toBe(0);
  });

  test("keeps transport acceptance, durable state, and user visibility separate", async () => {
    const current = plan("op-E0000000000000000000000000", "github", { maxAttempts: 1 });
    const adapter = createGitHubEdgeProofAdapter("1.0.0", { read: () => ({
      ...confirmed(current),
      status: "retryable",
      acknowledgementTier: "transport_accepted",
      observedStateHash: null,
      reasonCode: "readback_missing",
    }) });
    const observation = await probeEdgeOnce(current, [], adapter, { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
    const record = buildEdgeProofRecord(current, binding(), observation, null);
    expect(record).toMatchObject({ classification: "unavailable", acknowledgement_tier: "transport_accepted" });
    expect(edgeBindingMetrics([record])).toEqual({ numerator: 0, denominator: 1, ratio: 0 });
  });

  test("persists the next poll time and rejects early retries without another call", async () => {
    const current = plan("op-P0000000000000000000000000", "github", { maxAttempts: 2 });
    let calls = 0;
    const adapter = createGitHubEdgeProofAdapter("1.0.0", { read: () => {
      calls++;
      return {
        ...confirmed(current),
        status: "retryable",
        acknowledgementTier: "transport_accepted",
        observedStateHash: null,
        reasonCode: "readback_missing",
      };
    } });
    const first = await probeEdgeOnce(current, [], adapter, { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
    expect(first.next_poll_at).toBe("2026-08-11T00:00:21.000Z");
    expect(calls).toBe(1);
    expect(probeEdgeOnce(current, [first], adapter, { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.500Z")).rejects.toThrow("persisted next_poll_at");
    expect(calls).toBe(1);
  });

  test("fails closed on operation, actor, target, result, stale, and timeout faults", async () => {
    const faults: Array<[string, Partial<EdgeProbeResponse>]> = [
      ["operation_mismatch", { operationId: "op-Z0000000000000000000000000" }],
      ["actor_mismatch", { actorHash: "b".repeat(64) }],
      ["target_mismatch", { targetHash: "c".repeat(64) }],
      ["result_mismatch", { observedStateHash: "d".repeat(64) }],
      ["stale_observation", { observedAt: "2026-08-10T23:59:59.000Z" }],
    ];
    for (const [code, override] of faults) {
      const current = plan(`op-${code.slice(0, 1).toUpperCase()}`.padEnd(29, "0"));
      const adapter = createGitHubEdgeProofAdapter("1.0.0", { read: () => ({ ...confirmed(current), ...override }) });
      const observation = await probeEdgeOnce(current, [], adapter, { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
      expect(observation).toMatchObject({ status: "unavailable", reason_code: code });
      await expect(probeEdgeOnce(current, [observation], adapter, { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:21.000Z")).rejects.toThrow("only a transient retryable observation");
    }
    const timeoutPlan = plan("op-T0000000000000000000000000", "github", { probeTimeoutMs: 1 });
    const timeoutAdapter = createGitHubEdgeProofAdapter("1.0.0", { read: () => new Promise(() => undefined) });
    const timeout = await probeEdgeOnce(timeoutPlan, [], timeoutAdapter, { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
    expect(timeout).toMatchObject({ status: "unavailable", reason_code: "probe_timeout" });
    const retryTierPlan = plan("op-Q0000000000000000000000000");
    const inflated = await probeEdgeOnce(
      retryTierPlan,
      [],
      createGitHubEdgeProofAdapter("1.0.0", { read: () => ({
        ...confirmed(retryTierPlan),
        status: "retryable",
        acknowledgementTier: "durable_confirmed",
      }) }),
      { scopes: ["observe:github"], expiresAt: null },
      "2026-08-11T00:00:20.000Z",
    );
    expect(inflated).toMatchObject({ status: "unavailable", reason_code: "tier_invalid" });
  });

  test("rejects secret-bearing and tampered records", async () => {
    const current = plan("op-F0000000000000000000000000");
    const observation = await probeEdgeOnce(current, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(current) }), { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
    const record = buildEdgeProofRecord(current, binding(), observation, null);
    expect(() => validateEdgeProofRecord({ ...record, record_hash: "f".repeat(64) })).toThrow("hash does not match");
    expect(() => validateEdgeProofRecord({ ...record, api_token: "plaintext" } as typeof record)).toThrow(EdgeProofError);
  });
});

describe("journal v2 integration and immutable supplements", () => {
  test("atomically publishes terminal, delivery, receipt, and on-time proof", async () => {
    const journal = new OperationJournal(pathFor("atomic"), { now: () => "2026-08-11T00:00:30.000Z" });
    try {
      const operationId = reserve(journal, "atomic");
      const current = plan(operationId);
      journal.registerEdgeProofPlan(current);
      const observation = await probeEdgeOnce(current, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(current) }), { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:30.000Z");
      journal.appendEdgeProofObservation(current, observation);
      const receipt = journal.terminalize(operationId, "success", "complete", TEMPLATE, { plan: current, observation });
      expect(receipt.acknowledgements.user_visible?.kind).toBe("user_visible");
      expect(journal.edgeProofRecords(operationId)).toHaveLength(1);
      expect(journal.edgeProofRecords(operationId)[0]).toMatchObject({ classification: "required", timeliness: "within_deadline" });
    } finally {
      journal.close();
    }
  });

  test("appends late confirmation without mutating the immutable receipt", async () => {
    const journal = new OperationJournal(pathFor("late"), { now: () => "2026-08-11T00:00:30.000Z" });
    try {
      const operationId = reserve(journal, "late");
      const current = plan(operationId, "github", { deadline: "2026-08-11T00:00:40.000Z" });
      journal.registerEdgeProofPlan(current);
      const unavailable = await probeEdgeOnce(current, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(current) }), { scopes: [], expiresAt: null }, "2026-08-11T00:00:30.000Z");
      journal.appendEdgeProofObservation(current, unavailable);
      const receipt = journal.terminalize(operationId, "success", "complete", TEMPLATE, { plan: current, observation: unavailable });
      const before = canonicalize(receipt);
      const late = recordLateEdgeConfirmation(current, [unavailable], confirmed(current, "2026-08-11T00:01:30.000Z"));
      journal.appendEdgeProofObservation(current, late);
      const lateRecord = journal.appendEdgeProofSupplement(current, late);
      expect(lateRecord).toMatchObject({ classification: "required", timeliness: "late" });
      expect(canonicalize(journal.receipt(operationId))).toBe(before);
      expect(journal.receipt(operationId)?.acknowledgements.user_visible).toBeNull();
      expect(journal.edgeProofRecords(operationId)).toHaveLength(2);
      expect(() => journal.appendEdgeProofSupplement(current, late)).toThrow();
    } finally {
      journal.close();
    }
  });

  test("enforces observation order and insert-only proof state", async () => {
    const journal = new OperationJournal(pathFor("order"));
    try {
      const operationId = reserve(journal, "order");
      const current = plan(operationId);
      journal.registerEdgeProofPlan(current);
      const observation = await probeEdgeOnce(current, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(current) }), { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
      expect(() => journal.db.query(`
        INSERT INTO edge_proof_observations
          (observation_id, plan_id, attempt, status, acknowledgement_tier, canonical_observation,
           observation_hash, predecessor_hash, observed_at, next_poll_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("epo-OUTOFORDER000000000000000", current.plan_id, 2, "confirmed", "user_visible_confirmed", JSON.stringify(observation), "e".repeat(64), null, T0, null)).toThrow("edge_proof_attempt_gap");
      journal.appendEdgeProofObservation(current, observation);
      expect(() => journal.db.query("UPDATE edge_proof_plans SET requirement = 'notApplicable'").run()).toThrow("insert_only");
    } finally {
      journal.close();
    }
  });

  test("rejects replay of one authoritative source binding across operations", async () => {
    const journal = new OperationJournal(pathFor("source-replay"));
    try {
      const firstPlan = plan(reserve(journal, "source-replay-first"));
      const secondPlan = plan(reserve(journal, "source-replay-second"));
      journal.registerEdgeProofPlan(firstPlan);
      journal.registerEdgeProofPlan(secondPlan);
      const first = await probeEdgeOnce(firstPlan, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(firstPlan) }), { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
      const replay = await probeEdgeOnce(secondPlan, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(secondPlan) }), { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
      journal.appendEdgeProofObservation(firstPlan, first);
      expect(() => journal.appendEdgeProofObservation(secondPlan, replay)).toThrow("source binding was already consumed");
    } finally {
      journal.close();
    }
  });

  test("migrates v1 only after a verified backup and preserves existing rows", () => {
    const path = pathFor("migration");
    const backup = pathFor("migration-v1-backup");
    const restore = pathFor("migration-v1-restore");
    const created = new OperationJournal(path);
    const operationId = reserve(created, "migration");
    created.close();

    const raw = new Database(path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("DROP TRIGGER edge_proof_records_no_update; DROP TRIGGER edge_proof_records_no_delete; DROP TRIGGER edge_proof_records_chain");
    raw.exec("DROP TRIGGER edge_proof_observations_no_update; DROP TRIGGER edge_proof_observations_no_delete; DROP TRIGGER edge_proof_observations_contiguous");
    raw.exec("DROP TRIGGER edge_proof_plans_no_update; DROP TRIGGER edge_proof_plans_no_delete");
    raw.exec("DROP TABLE edge_proof_records; DROP TABLE edge_proof_observations; DROP TABLE edge_proof_plans");
    raw.exec("DROP TRIGGER journal_meta_no_update; DROP TRIGGER journal_meta_no_delete; DROP TRIGGER schema_migrations_no_update; DROP TRIGGER schema_migrations_no_delete");
    raw.query("DELETE FROM journal_meta WHERE key = 'schema_checksum_v2'").run();
    raw.query("DELETE FROM schema_migrations WHERE version = 2").run();
    raw.exec("CREATE TRIGGER journal_meta_no_update BEFORE UPDATE ON journal_meta BEGIN SELECT RAISE(ABORT, 'journal_meta_is_insert_only'); END; CREATE TRIGGER journal_meta_no_delete BEFORE DELETE ON journal_meta BEGIN SELECT RAISE(ABORT, 'journal_meta_is_insert_only'); END");
    raw.exec("CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema_migrations_is_insert_only'); END; CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema_migrations_is_insert_only'); END");
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    expect(() => openJournalDatabase(path, { create: false })).toThrow("verified backup path is required");
    const v1 = new Database(path);
    createVerifiedBackup(v1, backup, 1);
    v1.close();
    const migrated = openJournalDatabase(path, { create: false, backupPath: backup });
    try {
      expect((migrated.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(JOURNAL_SCHEMA_VERSION);
      expect((migrated.query("SELECT COUNT(*) AS count FROM operations WHERE operation_id = ?").get(operationId) as { count: number }).count).toBe(1);
      expect(existsSync(backup)).toBe(true);
      const backupDb = new Database(backup, { readonly: true });
      expect((backupDb.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(1);
      backupDb.close();
      restoreVerifiedBackup(backup, restore, 1);
      expect(readFileSync(restore)).toEqual(readFileSync(backup));
      expect(() => restoreVerifiedBackup(backup, restore, 1)).toThrow("restore path already exists");
    } finally {
      migrated.close();
    }
  });

  test("reopens with byte-identical proof chains and converges duplicate plan registration", async () => {
    const path = pathFor("restart");
    let operationId = "";
    let canonical = "";
    const first = new OperationJournal(path);
    try {
      operationId = reserve(first, "restart");
      const current = plan(operationId);
      first.registerEdgeProofPlan(current);
      first.registerEdgeProofPlan(current);
      const observation = await probeEdgeOnce(current, [], createGitHubEdgeProofAdapter("1.0.0", { read: () => confirmed(current) }), { scopes: ["observe:github"], expiresAt: null }, "2026-08-11T00:00:20.000Z");
      first.appendEdgeProofObservation(current, observation);
      first.terminalize(operationId, "success", "complete", TEMPLATE, { plan: current, observation });
      canonical = JSON.stringify(first.edgeProofRecords(operationId));
    } finally {
      first.close();
    }
    const reopened = new OperationJournal(path, { create: false });
    try {
      expect(JSON.stringify(reopened.edgeProofRecords(operationId))).toBe(canonical);
      expect((reopened.db.query("SELECT COUNT(*) AS count FROM edge_proof_plans").get() as { count: number }).count).toBe(1);
    } finally {
      reopened.close();
    }
  });

  test("converges concurrent edge-plan writers across fresh processes", async () => {
    const path = pathFor("concurrent-plan");
    const journal = new OperationJournal(path);
    const operationId = reserve(journal, "concurrent-plan");
    const current = plan(operationId);
    journal.close();
    const journalModule = join(import.meta.dir, "run-operation-journal.ts");
    const program = `
      import { OperationJournal } from ${JSON.stringify(journalModule)};
      const journal = new OperationJournal(process.env.EDGE_DB, { create: false });
      try { journal.registerEdgeProofPlan(JSON.parse(process.env.EDGE_PLAN)); }
      finally { journal.close(); }
    `;
    const spawn = () => Bun.spawn(["bun", "--eval", program], {
      env: {
        PATH: process.env.PATH ?? "",
        EDGE_DB: path,
        EDGE_PLAN: JSON.stringify(current),
        FACTORY_STATE_MODE: "test",
        FACTORY_STATE_ALLOW_OUTSIDE_ROOT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const children = [spawn(), spawn()];
    const codes = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(codes).toEqual([0, 0]);
    expect(errors).toEqual(["", ""]);
    const verify = new OperationJournal(path, { create: false });
    try {
      expect((verify.db.query("SELECT COUNT(*) AS count FROM edge_proof_plans").get() as { count: number }).count).toBe(1);
    } finally {
      verify.close();
    }
  });
});

describe("fixture and schema coverage", () => {
  test("enumerates every required held-out case", () => {
    expect(FIXTURE.cases.map((entry) => entry.id)).toEqual([
      "github-user-visible-success", "linear-durable-success", "workspace-artifact-success",
      "unsupported-email-readback", "unsupported-service-readback", "unsupported-ui-readback",
      "transport-success-missing-readback", "operation-mismatch", "actor-mismatch", "target-mismatch",
      "result-mismatch", "stale-provider-event", "replayed-proof-id", "missing-read-authority",
      "probe-timeout", "post-hoc-not-applicable", "secret-redaction", "tampered-record-hash",
      "late-confirmation", "out-of-order-observation", "restart-replay-identity",
      "multi-process-convergence", "v1-v2-backup-migration-restore", "existing-ledger-immutability",
    ]);
  });

  test("keeps the contract JSON Schema parseable", () => {
    const schema = JSON.parse(readFileSync(join(FACTORY_DIR, "contracts", "run-edge-proof-v1.schema.json"), "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
  });
});
