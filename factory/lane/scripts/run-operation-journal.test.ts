import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonicalize, validateRunReceipt, type RunReceipt } from "./run-receipt-contract";
import {
  assertDatabaseResourceCeiling,
  createVerifiedBackup,
  JOURNAL_SCHEMA_VERSION,
  JournalStorageError,
  openJournalDatabase,
  qualifyJournalStorage,
  resolveJournalPath,
} from "./run-operation-journal-schema";
import {
  InMemoryEffectAdapter,
  MAX_EVENT_PAYLOAD_BYTES,
  OperationJournal,
  OperationJournalError,
  runOperationJournalSelfTest,
  type AdapterEffect,
  type AdapterObservation,
  type EffectAdapter,
  type JournalAuthority,
} from "./run-operation-journal";

const FACTORY_DIR = join(import.meta.dir, "..");
const STATE_DIR = join(FACTORY_DIR, "state");
const WORKER = join(import.meta.dir, "run-operation-journal-worker.ts");
const TEMPLATE = JSON.parse(readFileSync(join(FACTORY_DIR, "fixtures", "run-receipt", "valid-success.json"), "utf8")) as RunReceipt;
let root = "";

beforeAll(() => {
  mkdirSync(STATE_DIR, { recursive: true });
  root = mkdtempSync(join(STATE_DIR, "zou-1053-test-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function pathFor(name: string): string {
  return join(root, `${name}.sqlite`);
}

function authority(scopes = ["operation.reserve", "tool:test", "compensate:test"]): JournalAuthority {
  return {
    envelopeKind: "operator_approval",
    approvingAuthority: "test",
    approvalTs: new Date(0).toISOString(),
    approvalRef: "test",
    autonomyTier: "T0",
    authorizationEvidenceRef: "test",
    scopes,
    expiresAt: null,
  };
}

function reservation(journal: OperationJournal, key: string, auth = authority()) {
  return journal.reserve({
    scope: "test",
    idempotencyKey: key,
    intent: { key, api_token: "secret-value" },
    triggerKind: "factory",
    triggerIdentity: "test",
    authority: auth,
  });
}

async function worker(args: string[]) {
  const process = Bun.spawn(["bun", WORKER, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("operation journal storage contract", () => {
  test("requires an explicit absolute path and verified pragmas", () => {
    expect(() => resolveJournalPath({ env: {} })).toThrow(JournalStorageError);
    expect(() => resolveJournalPath({ path: "relative.sqlite", env: {} })).toThrow("absolute");
    const path = pathFor("pragmas");
    const db = openJournalDatabase(path);
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: JOURNAL_SCHEMA_VERSION });
      expect((db.query("SELECT COUNT(*) AS count FROM edge_proof_plans").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("fails closed on schema checksum drift and newer versions", () => {
    const drift = pathFor("checksum-drift");
    openJournalDatabase(drift).close();
    const raw = new Database(drift);
    raw.exec("DROP TRIGGER journal_meta_no_update");
    raw.query("UPDATE journal_meta SET value = ? WHERE key = 'schema_checksum'").run("f".repeat(64));
    raw.close();
    expect(() => openJournalDatabase(drift, { create: false })).toThrow("checksums differ");

    const newer = pathFor("newer");
    openJournalDatabase(newer).close();
    const newerRaw = new Database(newer);
    newerRaw.exec("PRAGMA user_version = 99");
    newerRaw.close();
    expect(() => openJournalDatabase(newer, { create: false })).toThrow("newer than supported");
  });

  test("rejects updates, deletes, sequence gaps, and invalid effect transitions", async () => {
    const journal = new OperationJournal(pathFor("constraints"));
    try {
      const reserved = reservation(journal, "constraints");
      expect(reserved.status).toBe("reserved");
      if (reserved.status !== "reserved") return;
      expect(() => journal.db.query("UPDATE operations SET trigger_identity = 'changed'").run()).toThrow("insert_only");
      expect(() => journal.db.query("DELETE FROM journal_events").run()).toThrow("insert_only");
      journal.beginAttempt(reserved.operationId, 1);
      const result = await journal.executeEffect(reserved.operationId, {
        attemptN: 1,
        adapterKind: "test",
        sideEffectKind: "api_call",
        target: "constraints",
        input: { value: 1 },
        reversible: true,
        rollbackRef: "constraints:rollback",
        authorityScope: "tool:test",
      }, authority(), new InMemoryEffectAdapter());
      expect(result.state).toBe("committed");
      expect(() => journal.db.query(`
        INSERT INTO effect_states
          (state_id, effect_id, state_sequence, state, canonical_evidence, evidence_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("bad-state", result.effectId, 9, "committed", "{}", "0".repeat(64), new Date(0).toISOString())).toThrow("effect_state_sequence_gap");
    } finally {
      journal.close();
    }
  });

  test("qualifies same-mount reopen, checkpoint, backup, and restore", () => {
    const result = qualifyJournalStorage(pathFor("qualification-target"));
    expect(result).toMatchObject({ ok: true, sameMount: true, walReopened: true, checkpointed: true, backupRestored: true });
  });

  test("creates a coherent verified backup and enforces the size ceiling", () => {
    const path = pathFor("backup-source");
    const backup = pathFor("backup-copy");
    const db = openJournalDatabase(path);
    try {
      createVerifiedBackup(db, backup);
      expect(existsSync(backup)).toBe(true);
      expect(() => assertDatabaseResourceCeiling(path, 1)).toThrow("ceiling");
    } finally {
      db.close();
    }
  });
});

describe("operation identity, authority, effects, and receipts", () => {
  test("converges same key and input and rejects conflicting input", () => {
    const journal = new OperationJournal(pathFor("idempotency"));
    try {
      const first = reservation(journal, "same");
      const second = reservation(journal, "same");
      expect(first.status).toBe("reserved");
      expect(second.status).toBe("reserved");
      if (first.status === "reserved" && second.status === "reserved") {
        expect(second.operationId).toBe(first.operationId);
        expect(second.existing).toBe(true);
      }
      expect(() => journal.reserve({
        scope: "test",
        idempotencyKey: "same",
        intent: { key: "different" },
        triggerKind: "factory",
        triggerIdentity: "test",
        authority: authority(),
      })).toThrow(OperationJournalError);
      expect((journal.db.query("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count).toBe(1);
    } finally {
      journal.close();
    }
  });

  test("records invalid authority as held and dispatches no effect", () => {
    const journal = new OperationJournal(pathFor("authority-hold"));
    try {
      const held = reservation(journal, "held", { ...authority([]), envelopeKind: "none" });
      expect(held).toMatchObject({ status: "held", reasonCode: "authority_missing" });
      expect((journal.db.query("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count).toBe(0);
      expect((journal.db.query("SELECT COUNT(*) AS count FROM effect_definitions").get() as { count: number }).count).toBe(0);
    } finally {
      journal.close();
    }
  });

  test("redacts secrets before hashing and persistence", () => {
    const journal = new OperationJournal(pathFor("redaction"));
    try {
      const reserved = reservation(journal, "redaction");
      expect(reserved.status).toBe("reserved");
      const row = journal.db.query("SELECT canonical_input FROM operations").get() as { canonical_input: string };
      expect(row.canonical_input).not.toContain("secret-value");
      expect(row.canonical_input).toContain("[REDACTED]");
    } finally {
      journal.close();
    }
  });

  test("guards attempt boundaries idempotently and rejects conflicting completion", () => {
    const journal = new OperationJournal(pathFor("attempt-guards"));
    try {
      const reserved = reservation(journal, "attempt-guards");
      if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
      const firstStart = journal.beginAttempt(reserved.operationId, 1);
      const replayedStart = journal.beginAttempt(reserved.operationId, 1);
      expect(replayedStart.event_id).toBe(firstStart.event_id);
      const firstCompletion = journal.completeAttempt(reserved.operationId, 1, "failure", "retryable", "explicit_requeue");
      const replayedCompletion = journal.completeAttempt(reserved.operationId, 1, "failure", "retryable", "explicit_requeue");
      expect(replayedCompletion.event_id).toBe(firstCompletion.event_id);
      expect(() => journal.completeAttempt(reserved.operationId, 1, "success")).toThrow("different content");
      expect(() => journal.completeAttempt(reserved.operationId, 2, "success")).toThrow("has not started");
    } finally {
      journal.close();
    }
  });

  test("imports already-durable effects without an execution adapter", () => {
    const journal = new OperationJournal(pathFor("observational-import"));
    try {
      const auth = authority(["operation.reserve", "observe:workspace"]);
      const reserved = reservation(journal, "observational-import", auth);
      if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
      journal.beginAttempt(reserved.operationId, 1);
      const spec = {
        attemptN: 1,
        adapterKind: "workspace",
        sideEffectKind: "file_write" as const,
        target: "state/lane-utilization.jsonl",
        input: { row_hash: "a".repeat(64) },
        reversible: false,
        rollbackRef: null,
        authorityScope: "observe:workspace",
      };
      const source = {
        writer: "factory-conveyor-scheduled" as const,
        eventId: "lane-row-1",
      };
      const first = journal.importObservedEffect(reserved.operationId, spec, auth, source, { durable: true });
      const replay = journal.importObservedEffect(reserved.operationId, spec, auth, source, { durable: true });
      expect(replay).toEqual(first);
      expect(() => journal.importObservedEffect(
        reserved.operationId,
        spec,
        { ...auth, approvalRef: "different-approval" },
        source,
        { durable: true },
      )).toThrow("authority differs");
      expect(() => journal.importObservedEffect(
        reserved.operationId,
        spec,
        auth,
        { ...source, eventId: "lane-row-2" },
        { durable: true },
      )).toThrow("different source event");
      expect(() => journal.importObservedEffect(
        reserved.operationId,
        { ...spec, input: { row_hash: "b".repeat(64) } },
        auth,
        source,
        { durable: true },
      )).toThrow("committed effect already exists");
      expect(() => journal.importObservedEffect(
        reserved.operationId,
        spec,
        auth,
        { writer: "unregistered-writer", eventId: "lane-row-3" } as never,
        { durable: true },
      )).toThrow("not registered");
      journal.completeAttempt(reserved.operationId, 1, "success");
      const receipt = journal.terminalize(reserved.operationId, "success", "complete", TEMPLATE);
      expect(receipt.attempts[0].side_effects).toHaveLength(1);
      expect(receipt.attempts[0].side_effects[0].committed).toBe(true);
      expect((journal.db.query("SELECT COUNT(*) AS count FROM effect_definitions").get() as { count: number }).count).toBe(1);
    } finally {
      journal.close();
    }
  });

  test("persists intent before dispatch and materializes a restart-stable receipt", async () => {
    const path = pathFor("receipt");
    const adapter = new InMemoryEffectAdapter();
    const journal = new OperationJournal(path);
    let operationId = "";
    let canonical = "";
    try {
      const reserved = reservation(journal, "receipt");
      if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
      operationId = reserved.operationId;
      journal.beginAttempt(operationId, 1);
      const result = await journal.executeEffect(operationId, {
        attemptN: 1,
        adapterKind: "test",
        sideEffectKind: "api_call",
        target: "receipt",
        input: { value: 1 },
        reversible: true,
        rollbackRef: "receipt:rollback",
        authorityScope: "tool:test",
      }, authority(), adapter);
      expect(result.state).toBe("committed");
      journal.completeAttempt(operationId, 1, "success");
      const receipt = journal.terminalize(operationId, "success", "complete", TEMPLATE);
      expect(validateRunReceipt(receipt)).toEqual({ ok: true, errors: [] });
      expect(receipt.attempts[0].side_effects[0].committed).toBe(true);
      canonical = canonicalize(receipt);
    } finally {
      journal.close();
    }
    const reopened = new OperationJournal(path, { create: false });
    try {
      expect(canonicalize(reopened.receipt(operationId))).toBe(canonical);
      expect(canonicalize(reopened.terminalize(operationId, "success", "complete", TEMPLATE))).toBe(canonical);
    } finally {
      reopened.close();
    }
  });

  test("holds unresolved external ambiguity and forbids a false failure", async () => {
    const ambiguous: EffectAdapter = {
      dispatch: () => ({ state: "ambiguous", evidence: { unknown: true } }),
      probe: () => ({ state: "ambiguous", evidence: { unknown: true } }),
    };
    const journal = new OperationJournal(pathFor("ambiguous"));
    try {
      const reserved = reservation(journal, "ambiguous");
      if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
      journal.beginAttempt(reserved.operationId, 1);
      const result = await journal.executeEffect(reserved.operationId, {
        attemptN: 1,
        adapterKind: "test",
        sideEffectKind: "api_call",
        target: "ambiguous",
        input: { value: 1 },
        reversible: false,
        rollbackRef: null,
        authorityScope: "tool:test",
      }, authority(), ambiguous);
      expect(result).toMatchObject({ status: "held", state: "ambiguous" });
      journal.completeAttempt(reserved.operationId, 1, "failure", "external state unknown");
      expect(() => journal.terminalize(reserved.operationId, "failure", "adapter_error", TEMPLATE)).toThrow("requires held");
      expect(validateRunReceipt(journal.terminalize(reserved.operationId, "held", "external_state_ambiguous", TEMPLATE)).ok).toBe(true);
    } finally {
      journal.close();
    }
  });

  test("compensates committed reversible effects in reverse order", async () => {
    const adapter = new InMemoryEffectAdapter();
    const journal = new OperationJournal(pathFor("compensation"));
    try {
      const reserved = reservation(journal, "compensation");
      if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
      journal.beginAttempt(reserved.operationId, 1);
      const effects: string[] = [];
      for (const target of ["first", "second"]) {
        const result = await journal.executeEffect(reserved.operationId, {
          attemptN: 1,
          adapterKind: "test",
          sideEffectKind: "api_call",
          target,
          input: { target },
          reversible: true,
          rollbackRef: `${target}:rollback`,
          authorityScope: "tool:test",
        }, authority(), adapter);
        effects.push(result.effectId!);
      }
      const compensated = await journal.compensateOperation(reserved.operationId, 1, authority(), (kind) => kind === "test" ? adapter : undefined);
      expect(compensated.every((result) => result.state === "compensated")).toBe(true);
      expect(adapter.compensationOrder).toEqual([...effects].reverse());
    } finally {
      journal.close();
    }
  });

  test("rejects an oversized event before persistence", () => {
    const journal = new OperationJournal(pathFor("payload-ceiling"));
    try {
      const reserved = reservation(journal, "payload-ceiling");
      if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
      journal.beginAttempt(reserved.operationId, 1);
      expect(() => journal.completeAttempt(reserved.operationId, 1, "failure", "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1))).toThrow("exceeds");
    } finally {
      journal.close();
    }
  });
});

describe("fresh-process contention and crash recovery", () => {
  test("converges concurrent reservations on one operation", async () => {
    const db = pathFor("race");
    const runs = await Promise.all(Array.from({ length: 6 }, () => worker([
      "--scenario", "reserve", "--db", db, "--key", "race", "--intent", "same",
    ])));
    expect(runs.filter((run) => run.code !== 0).map((run) => ({ code: run.code, stderr: run.stderr }))).toEqual([]);
    const ids = runs.map((run) => JSON.parse(run.stdout).operationId);
    expect(new Set(ids).size).toBe(1);
    const verify = new OperationJournal(db, { create: false });
    try {
      expect((verify.db.query("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count).toBe(1);
    } finally {
      verify.close();
    }
  });

  test("bounds lock contention by the configured timeout", async () => {
    const db = pathFor("contention");
    openJournalDatabase(db).close();
    const ready = join(root, "contention.ready");
    const holder = Bun.spawn(["bun", WORKER, "--scenario", "hold-lock", "--db", db, "--ready", ready, "--hold-ms", "600"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let index = 0; index < 100 && !existsSync(ready); index++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const started = performance.now();
    expect(() => new OperationJournal(db, { create: false, busyTimeoutMs: 50, writeDeadlineMs: 100, maxBusyRetries: 0 })).toThrow();
    expect(performance.now() - started).toBeLessThan(500);
    await holder.exited;
  });

  test("recovers a committed WAL row after SIGKILL", async () => {
    const db = pathFor("wal-kill");
    const run = await worker(["--scenario", "wal-kill", "--db", db]);
    expect(run.code).not.toBe(0);
    const reopened = openJournalDatabase(db, { create: false });
    try {
      expect((reopened.query("SELECT COUNT(*) AS count FROM authority_holds WHERE hold_id = 'wal-kill'").get() as { count: number }).count).toBe(1);
      expect(reopened.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    } finally {
      reopened.close();
    }
  });

  test("probes before retry when the external commit survived a process crash", async () => {
    const db = pathFor("external-crash");
    const sidecar = join(root, "external-crash.effects");
    const crashed = await worker(["--scenario", "effect-flow", "--db", db, "--sidecar", sidecar, "--kill-after-external"]);
    expect(crashed.code).not.toBe(0);
    const recovered = await worker(["--scenario", "effect-flow", "--db", db, "--sidecar", sidecar]);
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout).result.state).toBe("committed");
    expect(readFileSync(sidecar, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("survives every declared fresh-process crash boundary without duplicate effects", async () => {
    for (const boundary of ["reservation", "effect_intent", "dispatch_start", "adapter_result", "terminal_event", "receipt_publish", "checkpoint"] as const) {
      const db = pathFor(`boundary-${boundary}`);
      const sidecar = join(root, `boundary-${boundary}.effects`);
      const flags = ["--scenario", "effect-flow", "--db", db, "--sidecar", sidecar, "--kill-boundary", boundary, "--terminalize"];
      if (boundary === "checkpoint") flags.push("--checkpoint");
      const crashed = await worker(flags);
      expect(crashed.code).not.toBe(0);
      const recovered = await worker(["--scenario", "effect-flow", "--db", db, "--sidecar", sidecar, "--terminalize", "--checkpoint"]);
      expect(recovered.code).toBe(0);
      const output = JSON.parse(recovered.stdout);
      expect(output.result.state).toBe("committed");
      expect(output.receiptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(sidecar, "utf8").trim().split("\n")).toHaveLength(1);
      const verify = new OperationJournal(db, { create: false });
      try {
        expect(validateRunReceipt(verify.receipt(output.reserved.operationId)!).ok).toBe(true);
        expect((verify.db.query("SELECT COUNT(*) AS count FROM receipts").get() as { count: number }).count).toBe(1);
      } finally {
        verify.close();
      }
    }
  });
});

describe("fixtures, reachability, and source immutability", () => {
  test("declares the complete canonical fixture matrix", () => {
    const fixture = JSON.parse(readFileSync(join(FACTORY_DIR, "fixtures", "run-operation-journal", "cases.json"), "utf8"));
    expect(fixture.fixture_version).toBe(1);
    expect(fixture.cases).toHaveLength(16);
    expect(new Set(fixture.cases.map((entry: { name: string }) => entry.name)).size).toBe(16);
  });

  test("does not rewrite an observational JSONL source", async () => {
    const source = join(root, "source-ledger.jsonl");
    writeFileSync(source, '{"event":"before"}\n', "utf8");
    const before = hashFile(source);
    await runOperationJournalSelfTest(pathFor("jsonl-immutable"));
    expect(hashFile(source)).toBe(before);
  });

  test("runs the exported hermetic selftest with an explicit database", async () => {
    const result = await runOperationJournalSelfTest(pathFor("selftest"));
    expect(result.ok).toBe(true);
    expect(result.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
