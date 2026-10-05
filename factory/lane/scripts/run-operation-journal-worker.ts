import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunReceipt } from "./run-receipt-contract";
import { openJournalDatabase } from "./run-operation-journal-schema";
import {
  InMemoryEffectAdapter,
  OperationJournal,
  type AdapterEffect,
  type AdapterObservation,
  type CrashBoundary,
  type EffectAdapter,
  type JournalAuthority,
} from "./run-operation-journal";

function value(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`);
  return process.argv[index + 1];
}

function authority(): JournalAuthority {
  return {
    envelopeKind: "operator_approval",
    approvingAuthority: "worker",
    approvalTs: new Date(0).toISOString(),
    approvalRef: "worker",
    autonomyTier: "T0",
    authorizationEvidenceRef: "worker",
    scopes: ["operation.reserve", "tool:test"],
    expiresAt: null,
  };
}

class FileEffectAdapter implements EffectAdapter {
  constructor(private readonly path: string, private readonly killAfterCommit: boolean) {}

  dispatch(effect: AdapterEffect): AdapterObservation {
    const committed = new Set(existsSync(this.path) ? readFileSync(this.path, "utf8").split("\n").filter(Boolean) : []);
    if (!committed.has(effect.effectId)) appendFileSync(this.path, `${effect.effectId}\n`, { encoding: "utf8", flush: true });
    if (this.killAfterCommit) process.kill(process.pid, "SIGKILL");
    return { state: "committed", evidence: { effect_id: effect.effectId } };
  }

  probe(effect: AdapterEffect): AdapterObservation {
    const committed = new Set(existsSync(this.path) ? readFileSync(this.path, "utf8").split("\n").filter(Boolean) : []);
    return committed.has(effect.effectId)
      ? { state: "committed", evidence: { effect_id: effect.effectId, probe: true } }
      : { state: "not_committed", evidence: { effect_id: effect.effectId, probe: true } };
  }
}

const scenario = value("--scenario");
const dbPath = value("--db");

if (scenario === "reserve") {
  const journal = new OperationJournal(dbPath);
  try {
    const result = journal.reserve({
      scope: "worker",
      idempotencyKey: value("--key"),
      intent: { value: value("--intent") },
      triggerKind: "factory",
      triggerIdentity: "worker",
      authority: authority(),
    });
    console.log(JSON.stringify(result));
  } finally {
    journal.close();
  }
} else if (scenario === "hold-lock") {
  const readyPath = value("--ready");
  const holdMs = Number(value("--hold-ms"));
  const db = openJournalDatabase(dbPath);
  try {
    db.exec("BEGIN IMMEDIATE");
    writeFileSync(readyPath, "ready", { encoding: "utf8", flush: true });
    await Bun.sleep(holdMs);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
} else if (scenario === "wal-kill") {
  const db = openJournalDatabase(dbPath);
  db.query("INSERT INTO authority_holds VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "wal-kill", "worker", "wal-kill", "0".repeat(64), "wal-kill", "{}", new Date(0).toISOString(),
  );
  process.kill(process.pid, "SIGKILL");
} else if (scenario === "effect-flow") {
  const sidecar = value("--sidecar");
  const mode = process.argv.includes("--kill-after-external") ? "kill-after-external" : "complete";
  const boundaryIndex = process.argv.indexOf("--kill-boundary");
  const killBoundary = boundaryIndex >= 0 ? process.argv[boundaryIndex + 1] as CrashBoundary : null;
  const journal = new OperationJournal(dbPath, {
    crashInjector: killBoundary ? (boundary) => {
      if (boundary === killBoundary) process.kill(process.pid, "SIGKILL");
    } : undefined,
  });
  try {
    const reserved = journal.reserve({
      scope: "worker-effect",
      idempotencyKey: "worker-effect",
      intent: { value: 1 },
      triggerKind: "factory",
      triggerIdentity: "worker-effect",
      authority: authority(),
    });
    if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
    const started = journal.db.query("SELECT COUNT(*) AS count FROM journal_events WHERE operation_id = ? AND kind = 'attempt.started'")
      .get(reserved.operationId) as { count: number };
    if (started.count === 0) journal.beginAttempt(reserved.operationId, 1);
    const adapter = mode === "kill-after-external"
      ? new FileEffectAdapter(sidecar, true)
      : new FileEffectAdapter(sidecar, false);
    const result = await journal.executeEffect(reserved.operationId, {
      attemptN: 1,
      adapterKind: "test",
      sideEffectKind: "api_call",
      target: "worker-effect",
      input: { value: 1 },
      reversible: true,
      rollbackRef: "worker-effect:rollback",
      authorityScope: "tool:test",
    }, authority(), adapter);
    let receiptHash: string | null = null;
    if (process.argv.includes("--terminalize") && result.state === "committed") {
      const completed = journal.db.query("SELECT COUNT(*) AS count FROM journal_events WHERE operation_id = ? AND kind = 'attempt.completed'")
        .get(reserved.operationId) as { count: number };
      if (completed.count === 0) journal.completeAttempt(reserved.operationId, 1, "success");
      const template = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "run-receipt", "valid-success.json"), "utf8")) as RunReceipt;
      receiptHash = journal.terminalize(reserved.operationId, "success", "worker_complete", template).receipt_hash;
    }
    if (process.argv.includes("--checkpoint")) journal.checkpoint();
    console.log(JSON.stringify({ reserved, result, receiptHash }));
  } finally {
    journal.close();
  }
} else if (scenario === "memory-effect") {
  const journal = new OperationJournal(dbPath);
  try {
    const reserved = journal.reserve({
      scope: "memory-effect",
      idempotencyKey: "memory-effect",
      intent: { value: 1 },
      triggerKind: "factory",
      triggerIdentity: "memory-effect",
      authority: authority(),
    });
    if (reserved.status !== "reserved") throw new Error(reserved.reasonCode);
    const started = journal.db.query("SELECT COUNT(*) AS count FROM journal_events WHERE operation_id = ? AND kind = 'attempt.started'")
      .get(reserved.operationId) as { count: number };
    if (started.count === 0) journal.beginAttempt(reserved.operationId, 1);
    const result = await journal.executeEffect(reserved.operationId, {
      attemptN: 1,
      adapterKind: "test",
      sideEffectKind: "api_call",
      target: "memory-effect",
      input: { value: 1 },
      reversible: true,
      rollbackRef: "memory-effect:rollback",
      authorityScope: "tool:test",
    }, authority(), new InMemoryEffectAdapter());
    console.log(JSON.stringify({ reserved, result }));
  } finally {
    journal.close();
  }
} else {
  throw new Error(`unknown scenario ${scenario}`);
}
