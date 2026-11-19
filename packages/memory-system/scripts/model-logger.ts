// model-logger.ts — Append-only CSV logger for model calls
// Tracks workload, provider, model, latency_ms, cost_usd, timestamp

import { Database } from "bun:sqlite";
import { generate as gGen } from "./model-client";

const LOG_PATH = process.env.ZO_MODEL_LOG || "/home/workspace/.zo/memory/model-call-log.db";

let _db: Database | null = null;

function getDb(): Database {
  if (!_db) {
    _db = new Database(LOG_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        workload TEXT,
        provider TEXT,
        model TEXT,
        latency_ms INTEGER,
        cost_usd REAL,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_model_calls_ts ON model_calls(ts);
    `);
  }
  return _db;
}

export interface LogEntry {
  workload: string;
  provider: string;
  model: string;
  latency_ms: number;
  cost_usd: number;
  notes?: string;
}

export function logModelCall(entry: LogEntry): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO model_calls (workload, provider, model, latency_ms, cost_usd, notes) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(entry.workload, entry.provider, entry.model, entry.latency_ms, entry.cost_usd, entry.notes || null);
  } catch { /* non-fatal */ }
}

export function getModelStats(workload?: string, days = 7): {
  total_calls: number; avg_latency_ms: number; total_cost_usd: number; by_provider: Record<string, number>
} {
  const db = getDb();
  const where = workload ? `WHERE workload = '${workload}' AND ts >= datetime('now', '-${days} days')` : `WHERE ts >= datetime('now', '-${days} days')`;
  const row = db.prepare(`SELECT COUNT(*) as total_calls, AVG(latency_ms) as avg_latency_ms, SUM(cost_usd) as total_cost_usd FROM model_calls ${where}`).get() as Record<string, number>;
  const byProvider: Record<string, number> = {};
  const rows = db.prepare(`SELECT provider, COUNT(*) as cnt FROM model_calls ${where} GROUP BY provider`).all() as Array<Record<string, number>>;
  for (const r of rows) byProvider[r.provider] = r.cnt;
  return { total_calls: row.total_calls || 0, avg_latency_ms: Math.round(row.avg_latency_ms || 0), total_cost_usd: row.total_cost_usd || 0, by_provider: byProvider };
}

// Budget check — returns true if OVER budget
export function isOverBudget(workload: string, monthlyBudgetUsd = 10): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT SUM(cost_usd) as total FROM model_calls WHERE workload = '${workload}' AND ts >= datetime('now', 'start of month')`).get() as { total: number | null };
  return (row.total || 0) >= monthlyBudgetUsd;
}
