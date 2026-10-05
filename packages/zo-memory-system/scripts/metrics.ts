#!/usr/bin/env bun
/**
 * metrics.ts — Memory System Metrics Collection & Reporting
 * MEM-101: Memory System Metrics Dashboard
 *
 * Tracks operational metrics: facts by decay, search latency, capture stats,
 * episode outcomes, open loop resolution time, and memory gate accuracy.
 *
 * Usage:
 *   bun metrics.ts report
 *   bun metrics.ts record --operation hybrid --latencyMs 230 --resultCount 5
 *   bun metrics.ts record --operation capture --factsStored 12 --factsSkipped 3 --contradictions 1
 *   bun metrics.ts clear
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryMetrics {
  factsByDecay: Record<string, number>;
  totalFacts: number;
  totalEmbeddings: number;
  totalEpisodes: number;
  episodeOutcomes: Record<string, number>;
  totalOpenLoops: number;
  openLoopsByStatus: Record<string, number>;
  totalProcedures: number;
  captureStats: CaptureStats;
  searchMetrics: SearchMetrics;
  gateMetrics: GateMetrics;
}

export interface CaptureStats {
  totalCaptures: number;
  totalFactsStored: number;
  totalFactsSkipped: number;
  totalContradictions: number;
  avgFactsPerCapture: number;
  lastCaptureAt?: number;
}

export interface SearchMetrics {
  totalSearches: number;
  byOperation: Record<string, OperationStats>;
  avgLatencyMs: number;
  totalResults: number;
  avgResultsPerSearch: number;
}

export interface OperationStats {
  count: number; totalLatencyMs: number; avgLatencyMs: number;
  totalResults: number; minLatencyMs: number; maxLatencyMs: number;
}

export interface GateMetrics {
  totalClassifications: number; injections: number;
  noMemoryNeeded: number; errors: number; injectionRate: number;
}

// ─── Database ─────────────────────────────────────────────────────────────────

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_metrics (
      id TEXT PRIMARY KEY,
      metric TEXT NOT NULL UNIQUE,
      value REAL NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS search_operations (
      id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      hyde_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_search_ops_operation ON search_operations(operation);
    CREATE INDEX IF NOT EXISTS idx_search_ops_created ON search_operations(created_at);

    CREATE TABLE IF NOT EXISTS capture_operations (
      id TEXT PRIMARY KEY,
      facts_stored INTEGER NOT NULL DEFAULT 0,
      facts_skipped INTEGER NOT NULL DEFAULT 0,
      contradictions INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS gate_operations (
      id TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      reason TEXT,
      keywords TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gate_created ON gate_operations(created_at);
  `);
  return db;
}

// ─── Metric helpers ────────────────────────────────────────────────────────────

function upsertMetric(metric: string, value: number, db: Database): void {
  db.prepare(`
    INSERT INTO memory_metrics (id, metric, value, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(metric) DO UPDATE SET
      value = memory_metrics.value + excluded.value,
      updated_at = strftime('%s','now')
  `).run(randomUUID(), metric, value);
}

function getMetric(metric: string, db: Database): number {
  const row = db.prepare("SELECT value FROM memory_metrics WHERE metric = ?").get(metric) as { value: number } | undefined;
  return row?.value ?? 0;
}

// ─── Record operations ─────────────────────────────────────────────────────────

export function recordSearchOperation(
  operation: string,
  latencyMs: number,
  resultCount: number,
  hydeUsed = false,
  db?: Database
): void {
  const _db = db || getDb();
  _db.prepare(`INSERT INTO search_operations (id, operation, latency_ms, result_count, hyde_used) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), operation, latencyMs, resultCount, hydeUsed ? 1 : 0);
  upsertMetric(`search_ops_${operation}`, 1, _db);
  upsertMetric(`search_latency_${operation}_sum`, latencyMs, _db);
  upsertMetric(`search_results_${operation}_sum`, resultCount, _db);
}

export function recordCaptureOperation(
  factsStored: number,
  factsSkipped: number,
  contradictions: number,
  durationMs: number,
  db?: Database
): void {
  const _db = db || getDb();
  _db.prepare(`INSERT INTO capture_operations (id, facts_stored, facts_skipped, contradictions, duration_ms) VALUES (?, ?, ?, ?, ?)`).run(randomUUID(), factsStored, factsSkipped, contradictions, durationMs);
  upsertMetric("capture_total", 1, _db);
  upsertMetric("capture_facts_stored", factsStored, _db);
  upsertMetric("capture_facts_skipped", factsSkipped, _db);
  upsertMetric("capture_contradictions", contradictions, _db);
}

export function recordGateDecision(
  decision: "inject" | "skip" | "error",
  reason?: string,
  keywords?: string[],
  db?: Database
): void {
  const _db = db || getDb();
  _db.prepare(`INSERT INTO gate_operations (id, decision, reason, keywords) VALUES (?, ?, ?, ?)`).run(randomUUID(), decision, reason || null, keywords ? JSON.stringify(keywords) : null);
  upsertMetric(`gate_${decision}`, 1, _db);
}

// ─── Collect all metrics ─────────────────────────────────────────────────────

export function collectMetrics(db?: Database): MemoryMetrics {
  const _db = db || getDb();

  const decayRows = _db.prepare("SELECT decay_class, COUNT(*) as cnt FROM facts GROUP BY decay_class").all() as Array<{ decay_class: string; cnt: number }>;
  const factsByDecay: Record<string, number> = {};
  for (const row of decayRows) factsByDecay[row.decay_class] = row.cnt;

  const totalFacts = (_db.prepare("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number }).cnt;
  const totalEmbeddings = (_db.prepare("SELECT COUNT(*) as cnt FROM fact_embeddings").get() as { cnt: number }).cnt;
  const totalEpisodes = (_db.prepare("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number }).cnt;

  const outcomeRows = _db.prepare("SELECT outcome, COUNT(*) as cnt FROM episodes GROUP BY outcome").all() as Array<{ outcome: string; cnt: number }>;
  const episodeOutcomes: Record<string, number> = {};
  for (const row of outcomeRows) episodeOutcomes[row.outcome] = row.cnt;

  const totalOpenLoops = (_db.prepare("SELECT COUNT(*) as cnt FROM open_loops").get() as { cnt: number }).cnt;
  const loopStatusRows = _db.prepare("SELECT status, COUNT(*) as cnt FROM open_loops GROUP BY status").all() as Array<{ status: string; cnt: number }>;
  const openLoopsByStatus: Record<string, number> = {};
  for (const row of loopStatusRows) openLoopsByStatus[row.status] = row.cnt;

  const totalProcedures = (_db.prepare("SELECT COUNT(*) as cnt FROM procedures").get() as { cnt: number }).cnt;

  const captureStats: CaptureStats = {
    totalCaptures: getMetric("capture_total", _db),
    totalFactsStored: getMetric("capture_facts_stored", _db),
    totalFactsSkipped: getMetric("capture_facts_skipped", _db),
    totalContradictions: getMetric("capture_contradictions", _db),
    avgFactsPerCapture: 0,
    lastCaptureAt: undefined,
  };
  if (captureStats.totalCaptures > 0) captureStats.avgFactsPerCapture = captureStats.totalFactsStored / captureStats.totalCaptures;
  const lastCapture = _db.prepare("SELECT created_at FROM capture_operations ORDER BY created_at DESC LIMIT 1").get() as { created_at: number } | undefined;
  if (lastCapture) captureStats.lastCaptureAt = lastCapture.created_at;

  const operations = ["hybrid", "fts", "vector", "continuation"];
  const byOperation: Record<string, OperationStats> = {};
  for (const op of operations) {
    const count = getMetric(`search_ops_${op}`, _db);
    if (count === 0) continue;
    const latencySum = getMetric(`search_latency_${op}_sum`, _db);
    const resultsSum = getMetric(`search_results_${op}_sum`, _db);
    const latRows = _db.prepare("SELECT MIN(latency_ms) as min, MAX(latency_ms) as max FROM search_operations WHERE operation = ?").get(op) as { min: number; max: number } | undefined;
    byOperation[op] = { count, totalLatencyMs: latencySum, avgLatencyMs: latencySum / count, totalResults: resultsSum, minLatencyMs: latRows?.min ?? 0, maxLatencyMs: latRows?.max ?? 0 };
  }
  const totalSearches = operations.reduce((sum, op) => sum + getMetric(`search_ops_${op}`, _db), 0);
  const totalResults = operations.reduce((sum, op) => sum + getMetric(`search_results_${op}_sum`, _db), 0);
  const totalLatency = operations.reduce((sum, op) => sum + getMetric(`search_latency_${op}_sum`, _db), 0);

  const searchMetrics: SearchMetrics = {
    totalSearches,
    byOperation,
    avgLatencyMs: totalSearches > 0 ? totalLatency / totalSearches : 0,
    totalResults,
    avgResultsPerSearch: totalSearches > 0 ? totalResults / totalSearches : 0,
  };

  const gi = getMetric("gate_inject", _db), gs = getMetric("gate_skip", _db), ge = getMetric("gate_error", _db);
  const gateTotal = gi + gs + ge;
  const gateMetrics: GateMetrics = {
    totalClassifications: gateTotal, injections: gi, noMemoryNeeded: gs, errors: ge,
    injectionRate: gateTotal > 0 ? gi / gateTotal : 0,
  };

  return { factsByDecay, totalFacts, totalEmbeddings, totalEpisodes, episodeOutcomes, totalOpenLoops, openLoopsByStatus, totalProcedures, captureStats, searchMetrics, gateMetrics };
}

// ─── Print formatted report ───────────────────────────────────────────────────

export function printReport(m: MemoryMetrics): void {
  const cs = m.captureStats;
  const gm = m.gateMetrics;
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`   ZO MEMORY SYSTEM — METRICS REPORT`);
  console.log(`══════════════════════════════════════════════════════════\n`);
  console.log(`  FACTS         Total: ${m.totalFacts}  Embeddings: ${m.totalEmbeddings}`);
  for (const [d, n] of Object.entries(m.factsByDecay)) console.log(`              ${d.padEnd(10)} ${n}`);
  console.log();
  console.log(`  EPISODES      Total: ${m.totalEpisodes}`);
  for (const [o, n] of Object.entries(m.episodeOutcomes)) console.log(`              ${o.padEnd(10)} ${n}`);
  console.log();
  console.log(`  OPEN LOOPS    Total: ${m.totalOpenLoops}`);
  for (const [s, n] of Object.entries(m.openLoopsByStatus)) console.log(`              ${s.padEnd(10)} ${n}`);
  console.log();
  console.log(`  PROCEDURES    Total: ${m.totalProcedures}`);
  console.log();
  console.log(`  SEARCH        Total: ${m.searchMetrics.totalSearches}  Avg: ${m.searchMetrics.avgLatencyMs.toFixed(1)}ms  Results/search: ${m.searchMetrics.avgResultsPerSearch.toFixed(1)}`);
  for (const [op, s] of Object.entries(m.searchMetrics.byOperation)) console.log(`              ${op.padEnd(10)} ${s.count} searches | ${s.avgLatencyMs.toFixed(0)}ms avg | ${s.minLatencyMs.toFixed(0)}-${s.maxLatencyMs.toFixed(0)}ms`);
  console.log();
  console.log(`  CAPTURE       Captures: ${cs.totalCaptures}  Stored: ${cs.totalFactsStored}  Skipped: ${cs.totalFactsSkipped}  Contradictions: ${cs.totalFactsSkipped}  Avg/capture: ${cs.avgFactsPerCapture.toFixed(1)}`);
  console.log();
  console.log(`  MEMORY GATE   Total: ${gm.totalClassifications}  Injections: ${gm.injections} (${(gm.injectionRate*100).toFixed(1)}%)  Skip: ${gm.noMemoryNeeded}  Errors: ${gm.errors}`);
  console.log(`\n══════════════════════════════════════════════════════════\n`);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "report") {
    printReport(collectMetrics());
    process.exit(0);
  }

  const command = args[0];
  switch (command) {
    case "record": {
      const db = getDb();
      let operation = "unknown", latencyMs = 0, resultCount = 0, hydeUsed = false;
      let factsStored = 0, factsSkipped = 0, contradictions = 0, durationMs = 0;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--operation" || args[i] === "-o") operation = args[i + 1] || "unknown";
        if (args[i] === "--latencyMs" || args[i] === "-l") latencyMs = parseFloat(args[i + 1] || "0");
        if (args[i] === "--resultCount" || args[i] === "-r") resultCount = parseInt(args[i + 1] || "0");
        if (args[i] === "--hydeUsed") hydeUsed = args[i + 1] === "true" || args[i + 1] === "1";
        if (args[i] === "--factsStored") factsStored = parseInt(args[i + 1] || "0");
        if (args[i] === "--factsSkipped") factsSkipped = parseInt(args[i + 1] || "0");
        if (args[i] === "--contradictions") contradictions = parseInt(args[i + 1] || "0");
        if (args[i] === "--durationMs") durationMs = parseInt(args[i + 1] || "0");
      }
      if (operation !== "unknown" && latencyMs > 0) recordSearchOperation(operation, latencyMs, resultCount, hydeUsed, db);
      if (factsStored > 0 || factsSkipped > 0) recordCaptureOperation(factsStored, factsSkipped, contradictions, durationMs, db);
      console.log(`Recorded: search[${operation}] latency=${latencyMs}ms, capture stored=${factsStored} skipped=${factsSkipped}`);
      break;
    }
    case "clear": {
      const db = getDb();
      db.exec("DELETE FROM memory_metrics");
      db.exec("DELETE FROM search_operations");
      db.exec("DELETE FROM capture_operations");
      db.exec("DELETE FROM gate_operations");
      console.log("All metrics cleared.");
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.log("Usage: bun metrics.ts report | record --operation <op> --latencyMs <n> | clear");
      process.exit(1);
  }
}

if (import.meta.main) main();