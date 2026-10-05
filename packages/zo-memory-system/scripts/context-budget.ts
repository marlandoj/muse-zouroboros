#!/usr/bin/env bun
/**
 * context-budget.ts — Token Budget Tracking for Swarm Orchestration
 * MEM-001: Context Budget Awareness
 *
 * Implements MemGPT-style context budget awareness:
 * - Tracks current token usage vs. model limits
 * - Warning/critical thresholds trigger proactive checkpointing
 * - Compresses or paginates retrieved facts before context overflow
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const CHECKPOINT_DIR = process.env.ZO_CHECKPOINT_DIR || "/home/workspace/.zo/memory/checkpoints";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ContextBudget {
  maxTokens: number;
  warningThreshold: number;
  criticalThreshold: number;
  currentUsage: number;
  warningFired: boolean;
  criticalFired: boolean;
  lastUpdated: number;
}

export interface BudgetCheckpoint {
  id: string;
  swarmId: string;
  summary: string;
  facts: CompressedFact[];
  openLoops: string[];
  pendingEpisodes: string[];
  tokenEstimate: number;
  compressedFrom: number;
  compressionRatio: number;
  createdAt: number;
}

export interface CompressedFact {
  entity: string;
  key: string | null;
  value: string;
  isSummary: boolean;
  originalIds?: string[];
}

export interface BudgetMetrics {
  checkpointsCreated: number;
  compressionsTriggered: number;
  warningFires: number;
  criticalFires: number;
  totalTokensTracked: number;
  avgTokensPerOperation: number;
}

export interface CompressionPlan {
  includeFacts: CompressedFact[];
  excludeCount: number;
  estimatedTokens: number;
  withinBudget: boolean;
}

export interface RetrievalBudgetResult {
  includeFacts: CompressedFact[];
  checkpointRecommended: boolean;
  checkpoint?: BudgetCheckpoint;
  withinBudget: boolean;
  estimatedTokens: number;
  compressed: boolean;
  excludedCount: number;
}

// ─── Database Setup ──────────────────────────────────────────────────────────

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_budget_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      max_tokens INTEGER NOT NULL DEFAULT 8000,
      warning_threshold REAL NOT NULL DEFAULT 0.70,
      critical_threshold REAL NOT NULL DEFAULT 0.90,
      current_usage INTEGER NOT NULL DEFAULT 0,
      warning_fired INTEGER NOT NULL DEFAULT 0,
      critical_fired INTEGER NOT NULL DEFAULT 0,
      last_updated INTEGER DEFAULT (strftime('%s','now'))
    );
    INSERT OR IGNORE INTO context_budget_state (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS budget_checkpoints (
      id TEXT PRIMARY KEY,
      swarm_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      compressed_from INTEGER NOT NULL DEFAULT 0,
      compression_ratio REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_budget_checkpoints_swarm ON budget_checkpoints(swarm_id);
  `);
  return db;
}

// ─── Token Estimation ─────────────────────────────────────────────────────────
// ~4 chars per token is a common heuristic for English text
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateFactTokens(fact: { entity: string; key: string | null; value: string }): number {
  return estimateTokens(`${fact.entity} ${fact.key || ""} ${fact.value}`.trim());
}

// ─── Budget State ─────────────────────────────────────────────────────────────

export function getBudget(db?: Database): ContextBudget {
  const _db = db || getDb();
  const row = _db.prepare("SELECT * FROM context_budget_state WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!row) return { maxTokens: 8000, warningThreshold: 0.70, criticalThreshold: 0.90, currentUsage: 0, warningFired: false, criticalFired: false, lastUpdated: Date.now() / 1000 };
  return {
    maxTokens: row.max_tokens as number,
    warningThreshold: row.warning_threshold as number,
    criticalThreshold: row.critical_threshold as number,
    currentUsage: row.current_usage as number,
    warningFired: Boolean(row.warning_fired),
    criticalFired: Boolean(row.critical_fired),
    lastUpdated: row.last_updated as number,
  };
}

export function updateBudget(currentUsage: number, db?: Database): { level: "ok" | "warning" | "critical"; budget: ContextBudget } {
  const _db = db || getDb();
  const budget = getBudget(_db);
  const usage = Math.max(0, currentUsage);
  const ratio = budget.maxTokens > 0 ? usage / budget.maxTokens : 0;
  let warningFired = budget.warningFired;
  let criticalFired = budget.criticalFired;
  if (ratio >= budget.criticalThreshold && !budget.criticalFired) {
    warningFired = true; criticalFired = true;
    console.warn(`[context-budget] CRITICAL: ${Math.round(ratio * 100)}% (${usage}/${budget.maxTokens} tokens)`);
  } else if (ratio >= budget.warningThreshold && !budget.warningFired) {
    warningFired = true;
    console.warn(`[context-budget] WARNING: ${Math.round(ratio * 100)}% (${usage}/${budget.maxTokens} tokens)`);
  }
  _db.prepare(`UPDATE context_budget_state SET current_usage = ?, warning_fired = ?, critical_fired = ?, last_updated = strftime('%s','now') WHERE id = 1`).run(usage, warningFired ? 1 : 0, criticalFired ? 1 : 0);
  return { level: ratio >= budget.criticalThreshold ? "critical" : ratio >= budget.warningThreshold ? "warning" : "ok", budget: getBudget(_db) };
}

export function resetBudget(db?: Database): void {
  const _db = db || getDb();
  _db.prepare(`UPDATE context_budget_state SET current_usage = 0, warning_fired = 0, critical_fired = 0, last_updated = strftime('%s','now') WHERE id = 1`).run();
}

export function initBudget(maxTokens: number, warningThreshold: number, criticalThreshold: number, db?: Database): void {
  const _db = db || getDb();
  _db.prepare(`UPDATE context_budget_state SET max_tokens = ?, warning_threshold = ?, critical_threshold = ?, last_updated = strftime('%s','now') WHERE id = 1`).run(maxTokens, warningThreshold, criticalThreshold);
  console.log(`Context budget initialized: max=${maxTokens}, warning=${Math.round(warningThreshold * 100)}%, critical=${Math.round(criticalThreshold * 100)}%`);
}

// ─── Fact Compression ─────────────────────────────────────────────────────────

export function planCompression(
  facts: Array<{ id: string; entity: string; key: string | null; value: string; importance?: number; confidence?: number }>,
  availableTokens: number
): CompressionPlan {
  if (facts.length === 0) return { includeFacts: [], excludeCount: 0, estimatedTokens: 0, withinBudget: true };
  const scored = facts.map((f) => {
    const tokens = estimateFactTokens(f);
    const priority = (f.importance ?? 1.0) * (f.confidence ?? 1.0);
    return { fact: f, tokens, score: priority / Math.max(1, tokens) };
  });
  scored.sort((a, b) => b.score - a.score);
  let totalTokens = 0;
  const includeFacts: CompressedFact[] = [];
  for (const item of scored) {
    if (totalTokens + item.tokens <= availableTokens) {
      includeFacts.push({ entity: item.fact.entity, key: item.fact.key, value: item.fact.value, isSummary: false, originalIds: [item.fact.id] });
      totalTokens += item.tokens;
    }
  }
  return { includeFacts, excludeCount: facts.length - includeFacts.length, estimatedTokens: totalTokens, withinBudget: totalTokens <= availableTokens };
}

// ─── Checkpoint Management ────────────────────────────────────────────────────

function ensureCheckpointDir(): void {
  if (!existsSync(CHECKPOINT_DIR)) mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

export function createCheckpoint(swarmId: string, summary: string, facts: CompressedFact[], openLoopIds: string[], pendingEpisodeIds: string[]): BudgetCheckpoint {
  ensureCheckpointDir();
  const id = `ckpt-${randomUUID().slice(0, 8)}`;
  const compressedFrom = facts.length;
  const tokenEstimate = facts.reduce((sum, f) => sum + estimateTokens(f.value), 0);
  const compressionRatio = compressedFrom > 0 ? Math.max(0, 1 - (tokenEstimate / Math.max(1, compressedFrom * 200))) : 1.0;
  const checkpoint: BudgetCheckpoint = { id, swarmId, summary, facts, openLoops: openLoopIds, pendingEpisodes: pendingEpisodeIds, tokenEstimate, compressedFrom, compressionRatio, createdAt: Math.floor(Date.now() / 1000) };
  const db = getDb();
  db.prepare(`INSERT INTO budget_checkpoints (id, swarm_id, summary, token_estimate, compressed_from, compression_ratio) VALUES (?, ?, ?, ?, ?, ?)`).run(id, swarmId, summary, tokenEstimate, compressedFrom, compressionRatio);
  writeFileSync(join(CHECKPOINT_DIR, `${id}.json`), JSON.stringify(checkpoint, null, 2));
  return checkpoint;
}

export function loadCheckpoint(checkpointId: string): BudgetCheckpoint | null {
  const p = join(CHECKPOINT_DIR, `${checkpointId}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

export function listCheckpoints(swarmId?: string, limit = 10): BudgetCheckpoint[] {
  const db = getDb();
  let query = "SELECT * FROM budget_checkpoints";
  const args: SQLQueryBindings[] = [];
  if (swarmId) { query += " WHERE swarm_id = ?"; args.push(swarmId); }
  query += " ORDER BY created_at DESC LIMIT ?"; args.push(limit);
  return (db.prepare(query).all(...args) as Array<Record<string, unknown>>).map((row) => {
    const cp = loadCheckpoint(row.id as string);
    if (cp) return cp;
    return { id: row.id, swarmId: row.swarm_id, summary: row.summary, tokenEstimate: row.token_estimate, compressedFrom: row.compressed_from, compressionRatio: row.compression_ratio, createdAt: row.created_at, facts: [], openLoops: [], pendingEpisodes: [] } as BudgetCheckpoint;
  });
}

// ─── Integration with memory retrieval ────────────────────────────────────────

export function retrievalWithBudget(
  facts: Array<{ id: string; entity: string; key: string | null; value: string; importance?: number; confidence?: number }>,
  swarmId: string, operationSummary: string, maxTokens?: number
): RetrievalBudgetResult {
  const budget = getBudget();
  const availableTokens = maxTokens ?? Math.floor(budget.maxTokens * (1 - budget.criticalThreshold));
  const plan = planCompression(facts, availableTokens);
  const { level } = updateBudget(budget.currentUsage + plan.estimatedTokens);
  let checkpoint: BudgetCheckpoint | undefined;
  if (plan.excludeCount > 0 && plan.excludeCount >= Math.ceil(facts.length * 0.3)) {
    checkpoint = createCheckpoint(swarmId, operationSummary, plan.includeFacts, [], []);
  }
  if (level !== "ok") console.warn(`[context-budget] ${level.toUpperCase()}: ${plan.excludeCount} facts excluded, ${plan.estimatedTokens} tokens of ${availableTokens} budget`);
  return { includeFacts: plan.includeFacts, checkpointRecommended: plan.excludeCount > 0, checkpoint, withinBudget: plan.withinBudget, estimatedTokens: plan.estimatedTokens, compressed: plan.excludeCount > 0, excludedCount: plan.excludeCount };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Context Budget CLI - v1.0

Commands:
  init --maxTokens <n> --warning <0.0-1.0> --critical <0.0-1.0>
  status
  track --operation <name> --inputTokens <n> --outputTokens <n>
  compress --factCount <n> --availableTokens <n>
  checkpoints --swarmId <id>
  reset
`);
    process.exit(0);
  }
  const command = args[0];
  switch (command) {
    case "init": {
      let maxTokens = 8000, warning = 0.70, critical = 0.90;
      for (let i = 1; i < args.length - 1; i++) {
        if (args[i] === "--maxTokens" || args[i] === "-m") maxTokens = parseInt(args[i + 1]);
        if (args[i] === "--warning" || args[i] === "-w") warning = parseFloat(args[i + 1]);
        if (args[i] === "--critical" || args[i] === "-c") critical = parseFloat(args[i + 1]);
      }
      initBudget(maxTokens, warning, critical); break;
    }
    case "status": {
      const budget = getBudget();
      const ratio = budget.maxTokens > 0 ? (budget.currentUsage / budget.maxTokens) : 0;
      const level = ratio >= budget.criticalThreshold ? "CRITICAL" : ratio >= budget.warningThreshold ? "WARNING" : "OK";
      console.log(`Context Budget Status\n  Max tokens: ${budget.maxTokens}\n  Current: ${budget.currentUsage} (${Math.round(ratio * 100)}%)\n  Warning at: ${Math.round(budget.warningThreshold * 100)}%\n  Critical at: ${Math.round(budget.criticalThreshold * 100)}%\n  Level: ${level}\n  Warning fired: ${budget.warningFired}\n  Critical fired: ${budget.criticalFired}\n  Last updated: ${new Date(budget.lastUpdated * 1000).toISOString()}`); break;
    }
    case "track": {
      let operation = "unknown", inputTokens = 0, outputTokens = 0;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--operation" || args[i] === "-o") operation = args[i + 1] || "unknown";
        if (args[i] === "--inputTokens" || args[i] === "-i") inputTokens = parseInt(args[i + 1] || "0");
        if (args[i] === "--outputTokens") outputTokens = parseInt(args[i + 1] || "0");
      }
      const totalTokens = inputTokens + outputTokens;
      const budget = getBudget();
      const newUsage = budget.currentUsage + totalTokens;
      const { level } = updateBudget(newUsage);
      console.log(`Tracked: ${operation} +${totalTokens} tokens | Budget: ${newUsage}/${budget.maxTokens} | Level: ${level}`); break;
    }
    case "compress": {
      let factCount = 0, availableTokens = 1000;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--factCount" || args[i] === "-n") factCount = parseInt(args[i + 1] || "0");
        if (args[i] === "--availableTokens" || args[i] === "-t") availableTokens = parseInt(args[i + 1] || "0");
      }
      const mockFacts = Array.from({ length: factCount }, (_, i) => ({ id: `mock-${i}`, entity: "mock.entity", key: `key${i}`, value: "Sample fact value with reasonable content for token estimation. ".repeat(5), importance: 1.0, confidence: 1.0 }));
      const plan = planCompression(mockFacts, availableTokens);
      console.log(`Compression Plan\n  Total facts: ${factCount}\n  Available: ${availableTokens}\n  Estimated: ${plan.estimatedTokens}\n  Included: ${plan.includeFacts.length}\n  Excluded: ${plan.excludeCount}\n  Within budget: ${plan.withinBudget ? "YES" : "NO"}`); break;
    }
    case "checkpoints": {
      let swarmId: string | undefined;
      for (let i = 1; i < args.length; i++) if (args[i] === "--swarmId" || args[i] === "-s") swarmId = args[i + 1];
      const checkpoints = listCheckpoints(swarmId);
      if (checkpoints.length === 0) { console.log("No checkpoints found."); break; }
      console.log(`Budget Checkpoints (${checkpoints.length})`);
      for (const cp of checkpoints) console.log(`  ${cp.id} | ${cp.swarmId} | ${cp.tokenEstimate}t | ${cp.compressedFrom} facts | ${new Date(cp.createdAt * 1000).toISOString()}`);
      break;
    }
    case "reset": { resetBudget(); console.log("Budget reset to zero."); break; }
    default: console.error(`Unknown command: ${command}`); process.exit(1);
  }
}

if (import.meta.main) main();
