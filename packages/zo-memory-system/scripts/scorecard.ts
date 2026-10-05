/**
 * scorecard.ts — Zouroboros Operational Health Scorecard event writer
 *
 * Thin, fire-and-forget SQLite logger. All writes are synchronous and
 * non-blocking to the caller. Import and call logGateDecision / logRetrieval
 * / logStore from any memory system code path.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";

const DB_PATH = "/home/workspace/.zo/memory/scorecard.db";
const DB_DIR = "/home/workspace/.zo/memory";

function getDb(): Database | null {
  try {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    const db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode=WAL");
    db.run(`CREATE TABLE IF NOT EXISTS gate_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      persona TEXT,
      message_hash TEXT,
      exit_code INTEGER NOT NULL,
      method TEXT NOT NULL,
      latency_ms INTEGER,
      memory_found INTEGER NOT NULL DEFAULT 0,
      session_id TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS memory_retrievals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      persona TEXT,
      query TEXT,
      chunks_returned INTEGER NOT NULL DEFAULT 0,
      method TEXT,
      latency_ms INTEGER,
      session_id TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS memory_stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      persona TEXT,
      entity TEXT,
      decay_class TEXT,
      category TEXT,
      session_id TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS swarm_handoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      swarm_id TEXT,
      from_agent TEXT,
      to_agent TEXT,
      context_keys TEXT,
      context_size INTEGER NOT NULL DEFAULT 0,
      session_id TEXT
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_gate_ts ON gate_decisions(ts)");
    db.run("CREATE INDEX IF NOT EXISTS idx_ret_ts ON memory_retrievals(ts)");
    db.run("CREATE INDEX IF NOT EXISTS idx_store_ts ON memory_stores(ts)");
    db.run("CREATE INDEX IF NOT EXISTS idx_handoff_ts ON swarm_handoffs(ts)");
    return db;
  } catch {
    return null;
  }
}

export function logGateDecision(opts: {
  persona?: string;
  messageHash?: string;
  exitCode: number;
  method: string;
  latencyMs?: number;
  memoryFound: boolean;
  sessionId?: string;
}): void {
  try {
    const db = getDb();
    if (!db) return;
    db.run(
      "INSERT INTO gate_decisions (ts, persona, message_hash, exit_code, method, latency_ms, memory_found, session_id) VALUES (?,?,?,?,?,?,?,?)",
      [Date.now(), opts.persona ?? null, opts.messageHash ?? null, opts.exitCode, opts.method, opts.latencyMs ?? null, opts.memoryFound ? 1 : 0, opts.sessionId ?? null]
    );
    db.close();
  } catch { /* non-fatal */ }
}

export function logRetrieval(opts: {
  persona?: string;
  query: string;
  chunksReturned: number;
  method?: string;
  latencyMs?: number;
  sessionId?: string;
}): void {
  try {
    const db = getDb();
    if (!db) return;
    db.run(
      "INSERT INTO memory_retrievals (ts, persona, query, chunks_returned, method, latency_ms, session_id) VALUES (?,?,?,?,?,?,?)",
      [Date.now(), opts.persona ?? null, opts.query, opts.chunksReturned, opts.method ?? null, opts.latencyMs ?? null, opts.sessionId ?? null]
    );
    db.close();
  } catch { /* non-fatal */ }
}

export function logSwarmHandoff(opts: {
  swarmId?: string;
  fromAgent?: string;
  toAgent?: string;
  contextKeys?: string[];
  contextSize?: number;
  sessionId?: string;
}): void {
  try {
    const db = getDb();
    if (!db) return;
    db.run(
      "INSERT INTO swarm_handoffs (ts, swarm_id, from_agent, to_agent, context_keys, context_size, session_id) VALUES (?,?,?,?,?,?,?)",
      [Date.now(), opts.swarmId ?? null, opts.fromAgent ?? null, opts.toAgent ?? null, opts.contextKeys ? opts.contextKeys.join(",") : null, opts.contextSize ?? 0, opts.sessionId ?? null]
    );
    db.close();
  } catch { /* non-fatal */ }
}

export function logStore(opts: {
  persona?: string;
  entity?: string;
  decayClass?: string;
  category?: string;
  sessionId?: string;
}): void {
  try {
    const db = getDb();
    if (!db) return;
    db.run(
      "INSERT INTO memory_stores (ts, persona, entity, decay_class, category, session_id) VALUES (?,?,?,?,?,?)",
      [Date.now(), opts.persona ?? null, opts.entity ?? null, opts.decayClass ?? null, opts.category ?? null, opts.sessionId ?? null]
    );
    db.close();
  } catch { /* non-fatal */ }
}
