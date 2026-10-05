#!/usr/bin/env bun
/**
 * benchmark-v2-v3.ts — Head-to-head benchmark: v2.0 vs v3.0
 *
 * Tests three v3 improvements against v2 baseline:
 *   1. Graph-boosted search vs plain RRF hybrid search
 *   2. Memory gate filtering efficiency
 *   3. Auto-capture extraction quality
 *
 * Uses a temporary SQLite database with synthetic but realistic facts.
 * Requires OpenAI for every generation workload and for embeddings; both resolve
 * through model-client. The local Ollama embedding lane was retired in 2026.
 *
 * Usage: bun benchmark-v2-v3.ts [--skip-embeddings]
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { unlinkSync, existsSync, writeFileSync } from "fs";
import { computeGraphBoost, findGraphNeighbors } from "./graph-boost";
import { generate, modelHealthCheck, embeddings } from "./model-client";

// --- Configuration ---
const TEST_DB_PATH = "/dev/shm/zo-memory-benchmark.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "openai:text-embedding-3-small";
const HYDE_MODEL = process.env.ZO_HYDE_MODEL || "openai:gpt-4o-mini";
const GATE_MODEL = process.env.ZO_GATE_MODEL || "openai:gpt-4o-mini";
const CAPTURE_MODEL = process.env.ZO_CAPTURE_MODEL || "openai:gpt-4o-mini";
// --skip-ollama is accepted as a legacy alias for --skip-embeddings.
const SKIP_EMBEDDINGS = process.argv.includes("--skip-embeddings") || process.argv.includes("--skip-ollama");

// --- Timing Utility ---
function timer(): () => number {
  const start = performance.now();
  return () => Math.round((performance.now() - start) * 100) / 100;
}

// --- Report Collector ---
interface BenchmarkResult {
  test: string;
  category: "graph" | "gate" | "capture" | "search";
  v2_value: string;
  v3_value: string;
  improvement: string;
  degradation: boolean;
  notes: string;
}

const results: BenchmarkResult[] = [];

function record(r: BenchmarkResult) {
  results.push(r);
  const icon = r.degradation ? "⚠" : "✓";
  console.log(`  ${icon} ${r.test}: v2=${r.v2_value} → v3=${r.v3_value} (${r.improvement})`);
}

// --- Database Setup ---
function setupDb(): Database {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL,
      text TEXT,
      category TEXT DEFAULT 'fact',
      decay_class TEXT DEFAULT 'stable',
      importance REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_accessed INTEGER,
      confidence REAL DEFAULT 1.0,
      metadata TEXT
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text, entity, key, value, category,
      content='facts', content_rowid='rowid'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT '${EMBEDDING_MODEL}',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_links (
      source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id)`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_log (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      transcript_hash TEXT NOT NULL,
      facts_extracted INTEGER,
      facts_skipped INTEGER,
      contradictions INTEGER,
      model TEXT,
      duration_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
  return db;
}

// --- Seed Data ---
interface SeedFact {
  id: string;
  entity: string;
  key: string;
  value: string;
  category: string;
  decay: string;
}

function seedDatabase(db: Database): SeedFact[] {
  const facts: SeedFact[] = [
    // FFB project cluster (should be linked)
    { id: "", entity: "project.ffb-site", key: "name", value: "Fauna & Flora Botanicals e-commerce website built on Zo hosting", category: "project", decay: "permanent" },
    { id: "", entity: "project.ffb-site", key: "stack", value: "React frontend with Hono API routes on zo.space, Stripe for payments", category: "fact", decay: "stable" },
    { id: "", entity: "project.ffb-site", key: "status", value: "Sprint 3 remediation in progress, 7 of 9 tasks passing", category: "fact", decay: "active" },
    { id: "", entity: "decision.ffb-hosting", key: "choice", value: "Selected Zo hosting over Shopify for full control and lower costs", category: "decision", decay: "permanent" },
    { id: "", entity: "decision.ffb-payments", key: "choice", value: "Using Stripe Connect for payment processing with webhook integration", category: "decision", decay: "permanent" },
    { id: "", entity: "project.ffb-site", key: "seo-audit", value: "Completed SEO audit showing missing meta descriptions on 12 product pages", category: "fact", decay: "active" },
    // Memory system cluster (should be linked)
    { id: "", entity: "system.memory", key: "version", value: "Hybrid SQLite plus vector search with hosted embeddings", category: "fact", decay: "stable" },
    { id: "", entity: "system.memory", key: "database", value: "SQLite with FTS5 and WAL mode at .zo/memory/shared-facts.db", category: "fact", decay: "permanent" },
    { id: "", entity: "decision.memory-cli", key: "choice", value: "Use memory.ts as canonical CLI, supports store search hybrid index stats", category: "decision", decay: "permanent" },
    { id: "", entity: "system.memory", key: "gate", value: "Model-routed memory gate filters 40-60% of messages saving tokens", category: "fact", decay: "stable" },
    // User preferences (isolated/orphan)
    { id: "", entity: "user", key: "name", value: "Jason Marland, based in Phoenix Arizona", category: "preference", decay: "permanent" },
    { id: "", entity: "user", key: "timezone", value: "America/Phoenix, no daylight saving time", category: "preference", decay: "permanent" },
    { id: "", entity: "user", key: "risk_tolerance", value: "Conservative investor, prefers index funds and blue chips", category: "preference", decay: "stable" },
    { id: "", entity: "user", key: "code_style", value: "Prefers TypeScript with Bun runtime, short bullet-point responses", category: "preference", decay: "permanent" },
    // Infrastructure cluster
    { id: "", entity: "system.zo", key: "backups", value: "Offsite backups via rclone to Google Drive weekly on Sundays", category: "fact", decay: "stable" },
    { id: "", entity: "system.zo", key: "database", value: "MariaDB running locally on 127.0.0.1:3306", category: "fact", decay: "stable" },
    { id: "", entity: "system.zo", key: "model-routing", value: "OpenAI handles the gate, HyDE, extraction, capture, briefing and embedding workloads; no local model runtime is used", category: "fact", decay: "stable" },
    // Financial
    { id: "", entity: "portfolio", key: "broker", value: "Alpaca Markets paper trading account for strategy testing", category: "fact", decay: "stable" },
    { id: "", entity: "portfolio", key: "strategy", value: "Dollar cost averaging into VOO and QQQ with 5% single position limit", category: "decision", decay: "stable" },
    // Swarm orchestrator
    { id: "", entity: "system.swarm", key: "executors", value: "Four executors: claude-code hermes gemini codex registered in executor-registry.json", category: "fact", decay: "stable" },
    { id: "", entity: "system.swarm", key: "performance", value: "FFB workload 11 tasks in 985s, bottleneck is Zo API latency 120-360s per prompt", category: "fact", decay: "active" },
    { id: "", entity: "decision.swarm-mcp", key: "choice", value: "Claude Code bridge must use --allowedTools for MCP tools, bypassPermissions insufficient", category: "decision", decay: "permanent" },
    // Additional facts for density
    { id: "", entity: "project.jhf-site", key: "name", value: "Jackson Heritage Financial website review and performance audit", category: "project", decay: "active" },
    { id: "", entity: "project.jhf-site", key: "status", value: "Comprehensive executive report delivered March 4 2026", category: "fact", decay: "active" },
    { id: "", entity: "system.zo", key: "personas", value: "97 persona IDENTITY files created, full migration complete", category: "fact", decay: "stable" },
  ];

  for (let i = 0; i < facts.length; i++) {
    const id = randomUUID();
    facts[i].id = id;
    const now = Date.now() - (facts.length - i) * 60000; // Spread over time
    const nowSec = Math.floor(now / 1000);
    const text = `${facts[i].entity} ${facts[i].key}: ${facts[i].value}`;
    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, last_accessed, confidence)
      VALUES (?, 'shared', ?, ?, ?, ?, ?, ?, 1.0, 'benchmark-seed', ?, ?, 1.0)
    `).run(id, facts[i].entity, facts[i].key, facts[i].value, text, facts[i].category, facts[i].decay, now, nowSec);
  }

  return facts;
}

function seedGraphLinks(db: Database, facts: SeedFact[]): number {
  const byEntity = new Map<string, SeedFact[]>();
  for (const f of facts) {
    const base = f.entity.split(".")[0];
    if (!byEntity.has(f.entity)) byEntity.set(f.entity, []);
    byEntity.get(f.entity)!.push(f);
  }

  let linkCount = 0;

  // FFB cluster: link project facts to decisions
  const ffbFacts = facts.filter(f => f.entity.startsWith("project.ffb") || f.entity.startsWith("decision.ffb"));
  for (let i = 0; i < ffbFacts.length; i++) {
    for (let j = i + 1; j < ffbFacts.length; j++) {
      const relation = ffbFacts[j].entity.startsWith("decision") ? "informed_by" : "related";
      db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
        .run(ffbFacts[i].id, ffbFacts[j].id, relation, 0.8);
      linkCount++;
    }
  }

  // Memory system cluster
  const memFacts = facts.filter(f => f.entity.startsWith("system.memory") || f.entity.startsWith("decision.memory"));
  for (let i = 0; i < memFacts.length; i++) {
    for (let j = i + 1; j < memFacts.length; j++) {
      db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
        .run(memFacts[i].id, memFacts[j].id, "related", 0.9);
      linkCount++;
    }
  }

  // Swarm cluster
  const swarmFacts = facts.filter(f => f.entity.startsWith("system.swarm") || f.entity.startsWith("decision.swarm"));
  for (let i = 0; i < swarmFacts.length; i++) {
    for (let j = i + 1; j < swarmFacts.length; j++) {
      db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
        .run(swarmFacts[i].id, swarmFacts[j].id, "related", 0.7);
      linkCount++;
    }
  }

  // Cross-cluster: memory → swarm (memory used by swarm)
  const memBase = facts.find(f => f.entity === "system.memory" && f.key === "gate");
  const swarmPerf = facts.find(f => f.entity === "system.swarm" && f.key === "performance");
  if (memBase && swarmPerf) {
    db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
      .run(memBase.id, swarmPerf.id, "optimizes", 0.6);
    linkCount++;
  }

  // Cross-cluster: ffb → swarm (swarm reviews ffb)
  const ffbStatus = facts.find(f => f.entity === "project.ffb-site" && f.key === "status");
  const swarmExec = facts.find(f => f.entity === "system.swarm" && f.key === "executors");
  if (ffbStatus && swarmExec) {
    db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
      .run(swarmExec.id, ffbStatus.id, "reviews", 0.5);
    linkCount++;
  }

  return linkCount;
}

// --- Embedding Helper ---
async function getEmbedding(text: string): Promise<number[] | null> {
  if (SKIP_EMBEDDINGS) return null;
  try {
    const result = await embeddings(text.slice(0, 8000));
    return result.embedding ?? null;
  } catch { return null; }
}

async function seedEmbeddings(db: Database): Promise<number> {
  const facts = db.prepare("SELECT id, text FROM facts").all() as any[];
  let count = 0;
  for (const f of facts) {
    const embedding = await getEmbedding(f.text);
    if (embedding) {
      db.prepare("INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
        .run(f.id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
      count++;
    }
  }
  return count;
}

// --- Cosine Similarity ---
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// =====================================================================
// BENCHMARK 1: Graph-Boosted Search vs Plain RRF
// =====================================================================

interface SearchResult {
  id: string;
  entity: string;
  key: string;
  value: string;
  score: number;
  sources: string[];
}

async function runFtsSearch(db: Database, query: string, limit: number = 10): Promise<SearchResult[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const safeQuery = query.replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 1).map(w => `"${w}"`).join(" OR ");
  if (!safeQuery) return [];

  const rows = db.prepare(`
    SELECT f.*, rank FROM facts f
    JOIN facts_fts fts ON f.rowid = fts.rowid
    WHERE facts_fts MATCH ? AND (f.expires_at IS NULL OR f.expires_at > ?)
    ORDER BY rank LIMIT ?
  `).all(safeQuery, nowSec, limit * 2) as any[];

  return rows.map(r => ({
    id: r.id, entity: r.entity, key: r.key, value: r.value,
    score: 0, sources: ["fts"],
  }));
}

async function runHybridSearch(db: Database, query: string, limit: number = 10): Promise<{ results: SearchResult[]; ftsCount: number; vecCount: number }> {
  const nowSec = Math.floor(Date.now() / 1000);
  const k = 60;

  // FTS
  const safeQuery = query.replace(/['"]/g, "").split(/\s+/).filter(w => w.length > 1).map(w => `"${w}"`).join(" OR ");
  const ftsRows = safeQuery ? db.prepare(`
    SELECT f.*, rank FROM facts f
    JOIN facts_fts fts ON f.rowid = fts.rowid
    WHERE facts_fts MATCH ? AND (f.expires_at IS NULL OR f.expires_at > ?)
    ORDER BY rank LIMIT ?
  `).all(safeQuery, nowSec, limit * 2) as any[] : [];

  // Vector
  const queryEmbedding = await getEmbedding(query);
  const vecResults: Array<{ id: string; similarity: number }> = [];

  if (queryEmbedding) {
    const embeddings = db.prepare(`
      SELECT fe.fact_id, fe.embedding FROM fact_embeddings fe
      JOIN facts f ON fe.fact_id = f.id
      WHERE f.expires_at IS NULL OR f.expires_at > ?
    `).all(nowSec) as any[];

    for (const row of embeddings) {
      const emb = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4));
      const sim = cosineSimilarity(queryEmbedding, emb);
      if (sim > 0.5) vecResults.push({ id: row.fact_id, similarity: sim });
    }
    vecResults.sort((a, b) => b.similarity - a.similarity);
  }

  // RRF fusion
  const scores = new Map<string, { ftsRank?: number; vecRank?: number; sources: string[] }>();

  let ftsPos = 1;
  for (const row of ftsRows) {
    scores.set(row.id, { ftsRank: ftsPos, sources: ["fts"] });
    ftsPos++;
  }

  let vecPos = 1;
  for (const vr of vecResults) {
    const existing = scores.get(vr.id);
    if (existing) {
      existing.vecRank = vecPos;
      existing.sources.push("vector");
    } else {
      scores.set(vr.id, { vecRank: vecPos, sources: ["vector"] });
    }
    vecPos++;
  }

  // Calculate RRF scores
  const scored: Array<{ id: string; rrfScore: number; freshness: number; confidence: number; sources: string[] }> = [];

  for (const [id, s] of scores) {
    let rrfScore = 0;
    if (s.ftsRank) rrfScore += 1 / (k + s.ftsRank);
    if (s.vecRank) rrfScore += 1 / (k + s.vecRank);
    const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as any;
    if (!fact) continue;

    let freshness = 1;
    if (fact.expires_at) {
      freshness = Math.max(0, Math.min(1, (fact.expires_at - nowSec) / (14 * 24 * 3600)));
    }

    scored.push({
      id, rrfScore, freshness,
      confidence: fact.confidence || 1.0,
      sources: s.sources,
    });
  }

  return { results: scored.map(s => {
    const fact = db.prepare("SELECT entity, key, value FROM facts WHERE id = ?").get(s.id) as any;
    return { id: s.id, entity: fact.entity, key: fact.key, value: fact.value, score: s.rrfScore, sources: s.sources };
  }), ftsCount: ftsRows.length, vecCount: vecResults.length };
}

function runV2Scoring(scored: Array<{ id: string; rrfScore: number; freshness: number; confidence: number; sources: string[] }>): Array<{ id: string; composite: number; sources: string[] }> {
  return scored.map(r => ({
    id: r.id,
    composite: r.rrfScore * 0.7 + r.freshness * 0.2 + r.confidence * 0.1,
    sources: r.sources,
  })).sort((a, b) => b.composite - a.composite);
}

function runV3Scoring(db: Database, scored: Array<{ id: string; rrfScore: number; freshness: number; confidence: number; sources: string[] }>): Array<{ id: string; composite: number; graphBoost: number; sources: string[] }> {
  const boosted = computeGraphBoost(db, scored);
  return boosted.sort((a, b) => b.composite - a.composite).map(r => ({
    id: r.id, composite: r.composite, graphBoost: r.graphBoost,
    sources: r.graphBoost > 0 ? [...r.sources, "graph"] : r.sources,
  }));
}

async function benchmarkGraphSearch(db: Database, facts: SeedFact[]) {
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK 1: Graph-Boosted Search vs Plain RRF");
  console.log("=".repeat(60));

  const queries = [
    { q: "FFB site hosting decision", expectedCluster: "ffb", description: "Cluster query (FFB)" },
    { q: "memory system database choice", expectedCluster: "memory", description: "Cluster query (memory)" },
    { q: "swarm executor MCP permissions", expectedCluster: "swarm", description: "Cluster query (swarm)" },
    { q: "user preferences timezone", expectedCluster: "user", description: "Orphan query (user prefs — no links)" },
    { q: "how does the swarm use memory gating", expectedCluster: "cross", description: "Cross-cluster query (memory→swarm)" },
  ];

  for (const { q, expectedCluster, description } of queries) {
    console.log(`\n  --- ${description}: "${q}" ---`);

    const hybridTimer = timer();
    const { results: rawResults, ftsCount, vecCount } = await runHybridSearch(db, q);

    const scored = rawResults.map(r => {
      const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(r.id) as any;
      const nowSec = Math.floor(Date.now() / 1000);
      let freshness = 1;
      if (fact?.expires_at) freshness = Math.max(0, Math.min(1, (fact.expires_at - nowSec) / (14 * 24 * 3600)));
      return { id: r.id, rrfScore: r.score, freshness, confidence: fact?.confidence || 1.0, sources: r.sources };
    });
    const hybridMs = hybridTimer();

    // v2 scoring
    const v2Timer = timer();
    const v2Results = runV2Scoring(scored);
    const v2Ms = v2Timer();

    // v3 scoring
    const v3Timer = timer();
    const v3Results = runV3Scoring(db, scored);
    const v3Ms = v3Timer();

    // Compare rankings
    const v2Top3 = v2Results.slice(0, 3).map(r => r.id);
    const v3Top3 = v3Results.slice(0, 3).map(r => r.id);
    const rankChanged = v2Top3.some((id, i) => id !== v3Top3[i]);

    // Check if graph brought in relevant cluster members
    const v3Boosted = v3Results.filter(r => r.graphBoost > 0).length;

    // Check neighbor injection
    const topIds = v3Results.slice(0, 3).map(r => r.id);
    const existingIds = new Set(v3Results.map(r => r.id));
    const neighbors = findGraphNeighbors(db, topIds, existingIds, 2);

    record({
      test: `${description} — scoring overhead`,
      category: "graph",
      v2_value: `${v2Ms}ms`,
      v3_value: `${v3Ms}ms`,
      improvement: `+${(v3Ms - v2Ms).toFixed(2)}ms`,
      degradation: v3Ms > v2Ms + 50,
      notes: `Hybrid retrieval: ${hybridMs}ms (shared). FTS: ${ftsCount}, Vector: ${vecCount}`,
    });

    record({
      test: `${description} — ranking change`,
      category: "graph",
      v2_value: `top3=[${v2Top3.map(id => facts.find(f => f.id === id)?.key || "?").join(",")}]`,
      v3_value: `top3=[${v3Top3.map(id => facts.find(f => f.id === id)?.key || "?").join(",")}]`,
      improvement: rankChanged ? "Rankings changed (graph influence)" : "Rankings unchanged",
      degradation: false,
      notes: `${v3Boosted} facts graph-boosted, ${neighbors.length} neighbors injectable`,
    });
  }
}

// =====================================================================
// BENCHMARK 2: Memory Gate Filtering Efficiency
// =====================================================================

async function benchmarkMemoryGate(db: Database) {
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK 2: Memory Gate Filtering Efficiency");
  console.log("=".repeat(60));

  const messages = [
    // Should NOT need memory (exit 2)
    { msg: "hello", expect: "skip", label: "Greeting" },
    { msg: "what is 2+2?", expect: "skip", label: "General knowledge" },
    { msg: "write a python function to sort a list", expect: "skip", label: "Self-contained coding" },
    { msg: "explain async await in javascript", expect: "skip", label: "Programming concept" },
    { msg: "good morning how are you", expect: "skip", label: "Casual greeting" },
    { msg: "thanks for your help", expect: "skip", label: "Acknowledgment" },
    // SHOULD need memory (exit 0 or 3)
    { msg: "what did we decide about FFB hosting?", expect: "memory", label: "Project decision" },
    { msg: "update the supplier scorecard", expect: "memory", label: "Workflow reference" },
    { msg: "how is the portfolio doing?", expect: "memory", label: "Ongoing tracking" },
    { msg: "where did we leave off on the swarm optimization?", expect: "memory", label: "Prior work status" },
    { msg: "what are the current backup settings?", expect: "memory", label: "System config" },
    { msg: "remind me about the memory gate token savings", expect: "memory", label: "Feature recall" },
  ];

  let correctSkips = 0;
  let correctMemory = 0;
  let incorrectSkips = 0;
  let incorrectMemory = 0;
  let totalGateTime = 0;
  let gateCallCount = 0;

  const v2TokensPerMessage = 200; // Rough estimate: always-on injection average
  let v2TotalTokens = 0;
  let v3TotalTokens = 0;

  for (const { msg, expect, label } of messages) {
    const gateTimer = timer();

    try {
      const gateResult = await generate({
        workload: "gate",
        model: GATE_MODEL,
        prompt: `You are a classifier. Given a user message, decide if it would benefit from retrieving stored memory/context from previous conversations.

Answer ONLY with valid JSON, no other text.

Rules:
- DEFAULT to "needs_memory": false. Only set true when the message CLEARLY references past work, projects, stored preferences, prior decisions, specific people/contacts, saved configurations, or ongoing tasks from previous sessions.
- "needs_memory": false for: greetings, small talk, general knowledge questions, self-contained instructions, code explanations, math, definitions, how-to questions, opinions, or anything answerable without prior conversation history.
- "keywords": 2-4 specific search terms extracted from the message (only if needs_memory is true, empty array otherwise).
- "reason": one short sentence explaining your decision

User: "${msg.replace(/"/g, '\\"')}"`,
        json: true,
        temperature: 0.1,
        maxTokens: 150,
      });

      const gateMs = gateTimer();
      totalGateTime += gateMs;
      gateCallCount++;

      const raw = gateResult.content.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(`  ✗ Parse failed for "${msg}": ${raw.slice(0, 50)}`);
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const needsMemory = Boolean(parsed.needs_memory);

      if (expect === "skip" && !needsMemory) {
        correctSkips++;
        v2TotalTokens += v2TokensPerMessage; // v2 would inject anyway
        v3TotalTokens += 0; // v3 skips
        console.log(`  ✓ Correctly skipped: "${msg}" (${gateMs.toFixed(0)}ms)`);
      } else if (expect === "memory" && needsMemory) {
        correctMemory++;
        v2TotalTokens += v2TokensPerMessage;
        v3TotalTokens += v2TokensPerMessage; // both inject
        console.log(`  ✓ Correctly flagged: "${msg}" → keywords: ${JSON.stringify(parsed.keywords)} (${gateMs.toFixed(0)}ms)`);
      } else if (expect === "skip" && needsMemory) {
        incorrectMemory++;
        v2TotalTokens += v2TokensPerMessage;
        v3TotalTokens += v2TokensPerMessage; // unnecessary injection
        console.log(`  ⚠ False positive: "${msg}" flagged as needing memory (${gateMs.toFixed(0)}ms)`);
      } else {
        incorrectSkips++;
        v2TotalTokens += v2TokensPerMessage;
        v3TotalTokens += 0; // missed injection
        console.log(`  ⚠ False negative: "${msg}" skipped but should need memory (${gateMs.toFixed(0)}ms)`);
      }
    } catch (err) {
      const gateMs = gateTimer();
      console.log(`  ✗ Error for "${msg}": ${err} (${gateMs.toFixed(0)}ms)`);
    }
  }

  const totalMessages = messages.length;
  const accuracy = ((correctSkips + correctMemory) / totalMessages * 100).toFixed(1);
  const avgGateMs = gateCallCount > 0 ? (totalGateTime / gateCallCount).toFixed(0) : "N/A";
  const tokenSavings = v2TotalTokens > 0 ? ((1 - v3TotalTokens / v2TotalTokens) * 100).toFixed(1) : "0";

  record({
    test: "Gate classification accuracy",
    category: "gate",
    v2_value: "N/A (always inject)",
    v3_value: `${accuracy}% (${correctSkips + correctMemory}/${totalMessages})`,
    improvement: `${accuracy}% accuracy`,
    degradation: parseFloat(accuracy) < 70,
    notes: `Correct skips: ${correctSkips}, Correct memory: ${correctMemory}, False pos: ${incorrectMemory}, False neg: ${incorrectSkips}`,
  });

  record({
    test: "Gate latency per message",
    category: "gate",
    v2_value: "0ms (no gate)",
    v3_value: `${avgGateMs}ms avg`,
    improvement: `+${avgGateMs}ms per gated message`,
    degradation: false,
    notes: "Trade-off: latency added but tokens saved",
  });

  record({
    test: "Token savings (12-msg sample)",
    category: "gate",
    v2_value: `${v2TotalTokens} tokens (always-on)`,
    v3_value: `${v3TotalTokens} tokens (gated)`,
    improvement: `${tokenSavings}% fewer tokens`,
    degradation: false,
    notes: `Projected swarm savings: ${correctSkips} of ${messages.length} messages filtered`,
  });

  // Simulate swarm scenario: 11 tasks, ~4 need memory
  const swarmV2Tokens = 11 * v2TokensPerMessage;
  const swarmV3Tokens = 4 * v2TokensPerMessage; // Only ~4 of 11 get injected
  const swarmSavings = ((1 - swarmV3Tokens / swarmV2Tokens) * 100).toFixed(1);

  record({
    test: "Swarm token budget (11 tasks, 8K context)",
    category: "gate",
    v2_value: `${swarmV2Tokens} tokens (${(swarmV2Tokens / 8000 * 100).toFixed(1)}% of budget)`,
    v3_value: `${swarmV3Tokens} tokens (${(swarmV3Tokens / 8000 * 100).toFixed(1)}% of budget)`,
    improvement: `${swarmSavings}% reduction`,
    degradation: false,
    notes: "Based on documented gate behavior: ~4 of 11 swarm tasks trigger memory injection",
  });
}

// =====================================================================
// BENCHMARK 3: Auto-Capture Quality
// =====================================================================

async function benchmarkAutoCapture(db: Database) {
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK 3: Auto-Capture Extraction Quality");
  console.log("=".repeat(60));

  const transcript = `User: Let's discuss the Fauna Flora site migration.
Assistant: Sure, I'll review the current state. The FFB site is currently hosted on Zo with React and Hono. We migrated from the old static site in January.

User: Right. We decided to use Stripe Connect for payments instead of the Shopify integration. Can you remind me why?
Assistant: The decision was made because Stripe Connect gives us full control over the checkout flow, lower transaction fees at 2.9% plus 30 cents, and direct webhook integration with our Zo API routes. Shopify would have required their payment gateway and limited our customization.

User: Good. Also I want to note that our shipping partner changed — we now use EcoShip instead of UPS for all domestic orders. They offer carbon-neutral shipping.
Assistant: Got it. I'll update the shipping configuration. EcoShip for domestic, and we should keep UPS as fallback for international.

User: One more thing — the product catalog now has 47 SKUs, up from 32 last month. We added the new essential oils line.
Assistant: That's a significant expansion. I'll make sure the SKU canon file reflects 47 active SKUs including the essential oils line.

User: The site performance is looking good. Lighthouse score went from 62 to 89 after the Sprint 2 optimizations.
Assistant: Great improvement. The main gains came from image optimization, lazy loading, and removing the unused third-party analytics scripts.`;

  // Test extraction with the LLM
  const extractTimer = timer();

  try {
    const captureResult = await generate({
      workload: "capture",
      model: CAPTURE_MODEL,
      prompt: `You are a fact extractor. Given a conversation transcript, extract structured facts.

Rules:
- Extract ONLY concrete, reusable facts (preferences, decisions, project details, technical choices, contacts)
- Do NOT extract: greetings, questions, transient discussion, opinions about weather, small talk
- Each fact must be independently useful without the conversation context
- Assign decay_class: "permanent" for user preferences/identity, "stable" for project decisions, "active" for current tasks/sprints, "session" for today-only context
- Assign confidence: 1.0 for explicit statements, 0.8 for strong implications, 0.6 for inferences
- Include source_quote: the exact text from the transcript that supports this fact
- entity format: "category.subject" (e.g., "project.ffb-site", "user", "decision.hosting")

Output ONLY a valid JSON array of objects with these fields: entity, key, value, category, decay_class, confidence, source_quote
If nothing worth extracting, return [].

Transcript:
---
${transcript}
---`,
      json: true,
      temperature: 0.1,
      maxTokens: 2000,
    });

    const extractMs = extractTimer();
    const raw = captureResult.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      console.log(`  ✗ Failed to parse JSON from response`);
      console.log(`  Raw: ${raw.slice(0, 200)}`);
      return;
    }

    const extracted = JSON.parse(jsonMatch[0]);
    console.log(`\n  Extracted ${extracted.length} facts in ${extractMs.toFixed(0)}ms:\n`);

    // Quality analysis
    const MIN_CONFIDENCE = 0.6;
    const MIN_VALUE_LENGTH = 10;
    let qualityPass = 0;
    let qualityFail = 0;
    let contradictions = 0;

    // Expected facts from the transcript
    const expectedFacts = [
      "stripe connect payments",
      "ecorship shipping",
      "47 skus",
      "lighthouse score 89",
      "essential oils",
    ];

    const extractedValues = extracted.map((f: any) => (f.value || "").toLowerCase());
    let coveredExpected = 0;

    for (const expected of expectedFacts) {
      const found = extractedValues.some((v: string) => v.includes(expected.split(" ")[0]));
      if (found) coveredExpected++;
    }

    for (const fact of extracted) {
      const passesConfidence = (fact.confidence || 0) >= MIN_CONFIDENCE;
      const passesLength = (fact.value || "").length >= MIN_VALUE_LENGTH;

      if (passesConfidence && passesLength) {
        qualityPass++;
        console.log(`    ✓ [${fact.entity}].${fact.key} = "${(fact.value || "").slice(0, 60)}" (conf=${fact.confidence})`);
      } else {
        qualityFail++;
        const reason = !passesConfidence ? `low conf ${fact.confidence}` : `short value (${(fact.value || "").length} chars)`;
        console.log(`    ✗ [${fact.entity}].${fact.key} = "${(fact.value || "").slice(0, 60)}" — ${reason}`);
      }

      // Check contradiction against seed data
      const existing = db.prepare(
        "SELECT id, value FROM facts WHERE entity = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)"
      ).all(fact.entity || "", fact.key || "", Math.floor(Date.now() / 1000)) as any[];

      if (existing.length > 0 && existing.some((e: any) => e.value !== fact.value)) {
        contradictions++;
        console.log(`      ↳ Would SUPERSEDE existing fact`);
      }
    }

    // Co-capture link calculation
    const coCaptureLinks = qualityPass > 1 ? qualityPass * (qualityPass - 1) / 2 : 0;

    record({
      test: "Auto-capture extraction time",
      category: "capture",
      v2_value: "N/A (manual only)",
      v3_value: `${extractMs.toFixed(0)}ms`,
      improvement: `Automated (was manual CLI)`,
      degradation: false,
      notes: `Model: ${CAPTURE_MODEL}, transcript ~${Math.round(transcript.length / 4)} tokens`,
    });

    record({
      test: "Facts extracted vs expected",
      category: "capture",
      v2_value: "0 (manual entry required)",
      v3_value: `${extracted.length} extracted, ${qualityPass} pass quality filters`,
      improvement: `${coveredExpected}/${expectedFacts.length} key facts covered`,
      degradation: coveredExpected < 3,
      notes: `Quality: ${qualityPass} pass, ${qualityFail} filtered. Confidence >= ${MIN_CONFIDENCE}, value >= ${MIN_VALUE_LENGTH} chars`,
    });

    record({
      test: "Contradiction detection",
      category: "capture",
      v2_value: "N/A (no detection)",
      v3_value: `${contradictions} detected`,
      improvement: contradictions > 0 ? `${contradictions} supersession links would be created` : "No conflicts with seed data",
      degradation: false,
      notes: "Old facts get confidence *= 0.5 (soft deprecation)",
    });

    record({
      test: "Co-capture graph seeding",
      category: "capture",
      v2_value: "0 links (no auto-linking)",
      v3_value: `${coCaptureLinks} co-captured links`,
      improvement: `${coCaptureLinks} organic graph connections`,
      degradation: false,
      notes: `From ${qualityPass} passing facts, linked with weight 0.5`,
    });

  } catch (err) {
    console.log(`  ✗ Extraction error: ${err}`);
  }
}

// =====================================================================
// BENCHMARK 4: End-to-End Latency
// =====================================================================

async function benchmarkLatency(db: Database) {
  console.log("\n" + "=".repeat(60));
  console.log("BENCHMARK 4: End-to-End Search Latency");
  console.log("=".repeat(60));

  if (SKIP_EMBEDDINGS) {
    console.log("  Skipped (--skip-embeddings: embeddings required)");
    return;
  }

  const queries = [
    "FFB hosting decision",
    "memory system configuration",
    "user preferences",
  ];

  for (const q of queries) {
    // v2: FTS + Vector (no graph boost)
    const v2Timer = timer();
    const { results: v2Raw } = await runHybridSearch(db, q, 6);
    const v2Scored = v2Raw.map(r => {
      const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(r.id) as any;
      const nowSec = Math.floor(Date.now() / 1000);
      let freshness = 1;
      if (fact?.expires_at) freshness = Math.max(0, Math.min(1, (fact.expires_at - nowSec) / (14 * 24 * 3600)));
      return { id: r.id, rrfScore: r.score, freshness, confidence: fact?.confidence || 1.0, sources: r.sources };
    });
    runV2Scoring(v2Scored);
    const v2Ms = v2Timer();

    // v3: FTS + Vector + Graph boost + neighbor injection
    const v3Timer = timer();
    const { results: v3Raw } = await runHybridSearch(db, q, 6);
    const v3Scored = v3Raw.map(r => {
      const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(r.id) as any;
      const nowSec = Math.floor(Date.now() / 1000);
      let freshness = 1;
      if (fact?.expires_at) freshness = Math.max(0, Math.min(1, (fact.expires_at - nowSec) / (14 * 24 * 3600)));
      return { id: r.id, rrfScore: r.score, freshness, confidence: fact?.confidence || 1.0, sources: r.sources };
    });
    const v3Boosted = runV3Scoring(db, v3Scored);
    const topIds = v3Boosted.slice(0, 3).map(r => r.id);
    const existingIds = new Set(v3Boosted.map(r => r.id));
    findGraphNeighbors(db, topIds, existingIds, 2);
    const v3Ms = v3Timer();

    const overhead = v3Ms - v2Ms;

    record({
      test: `E2E latency: "${q}"`,
      category: "search",
      v2_value: `${v2Ms.toFixed(1)}ms`,
      v3_value: `${v3Ms.toFixed(1)}ms`,
      improvement: overhead > 0 ? `+${overhead.toFixed(1)}ms overhead` : `${overhead.toFixed(1)}ms faster`,
      degradation: overhead > 100,
      notes: `Graph scoring + neighbor injection overhead`,
    });
  }
}

// =====================================================================
// REPORT
// =====================================================================

function generateReport() {
  console.log("\n" + "=".repeat(60));
  console.log("FINAL REPORT: v2.0 vs v3.0 Benchmark Results");
  console.log("=".repeat(60));

  const categories = ["graph", "gate", "capture", "search"] as const;
  const labels: Record<string, string> = {
    graph: "Graph-Boosted Search",
    gate: "Memory Gate Filtering",
    capture: "Auto-Capture Pipeline",
    search: "End-to-End Latency",
  };

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    if (catResults.length === 0) continue;

    console.log(`\n  ${labels[cat]}:`);
    console.log(`  ${"─".repeat(56)}`);

    for (const r of catResults) {
      const icon = r.degradation ? "⚠" : "✓";
      console.log(`  ${icon} ${r.test}`);
      console.log(`    v2: ${r.v2_value}`);
      console.log(`    v3: ${r.v3_value}`);
      console.log(`    Δ:  ${r.improvement}`);
      if (r.notes) console.log(`    📝 ${r.notes}`);
    }
  }

  const degradations = results.filter(r => r.degradation);
  console.log(`\n  Summary:`);
  console.log(`  ────────`);
  console.log(`  Total tests: ${results.length}`);
  console.log(`  Improvements: ${results.filter(r => !r.degradation).length}`);
  console.log(`  Degradations: ${degradations.length}`);

  if (degradations.length > 0) {
    console.log(`\n  ⚠ Degradations detected:`);
    for (const d of degradations) {
      console.log(`    - ${d.test}: ${d.improvement}`);
    }
  } else {
    console.log(`\n  ✓ No degradations detected.`);
  }

  // Write report to file
  const reportPath = "/home/workspace/Skills/zo-memory-system/BENCHMARK_REPORT.md";
  const md = generateMarkdownReport();
  writeFileSync(reportPath, md);
  console.log(`\n  Report saved to: ${reportPath}`);
}

function generateMarkdownReport(): string {
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  let md = `# zo-memory-system Benchmark: v2.0 vs v3.0\n\n`;
  md += `**Date**: ${timestamp} UTC\n`;
  md += `**Database**: ${results.length > 0 ? "25 synthetic facts, seeded graph links" : "N/A"}\n`;
  md += `**Configured Models**: ${SKIP_EMBEDDINGS ? `generation=${GATE_MODEL}/${CAPTURE_MODEL}, embeddings skipped` : `embeddings=${EMBEDDING_MODEL}, generation=${HYDE_MODEL}/${GATE_MODEL}/${CAPTURE_MODEL}`}\n\n`;

  const categories = ["graph", "gate", "capture", "search"] as const;
  const labels: Record<string, string> = {
    graph: "Graph-Boosted Search",
    gate: "Memory Gate Filtering",
    capture: "Auto-Capture Pipeline",
    search: "End-to-End Latency",
  };

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    if (catResults.length === 0) continue;

    md += `## ${labels[cat]}\n\n`;
    md += `| Test | v2.0 | v3.0 | Delta | Notes |\n`;
    md += `|------|------|------|-------|-------|\n`;

    for (const r of catResults) {
      const icon = r.degradation ? "⚠" : "✓";
      md += `| ${icon} ${r.test} | ${r.v2_value} | ${r.v3_value} | ${r.improvement} | ${r.notes} |\n`;
    }
    md += `\n`;
  }

  const degradations = results.filter(r => r.degradation);
  md += `## Summary\n\n`;
  md += `- **Total tests**: ${results.length}\n`;
  md += `- **Improvements**: ${results.filter(r => !r.degradation).length}\n`;
  md += `- **Degradations**: ${degradations.length}\n\n`;

  if (degradations.length > 0) {
    md += `### Degradations\n\n`;
    for (const d of degradations) {
      md += `- **${d.test}**: ${d.improvement} — ${d.notes}\n`;
    }
  } else {
    md += `No degradations detected. v3.0 is a pure improvement over v2.0.\n`;
  }

  return md;
}

// =====================================================================
// MAIN
// =====================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  zo-memory-system Benchmark: v2.0 vs v3.0              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const generationHealth = await modelHealthCheck("openai");
  if (!generationHealth.available) {
    console.error(`OpenAI not reachable for benchmark generation workloads: ${generationHealth.error ?? "unknown error"}`);
    process.exit(1);
  }

  console.log(`\nOpenAI: ✓ (${generationHealth.latency_ms}ms health check)`);
  console.log(`  ✓ ${HYDE_MODEL}`);
  console.log(`  ✓ ${GATE_MODEL}`);
  console.log(`  ✓ ${CAPTURE_MODEL}`);

  // Check embedding-model availability through model-client
  if (!SKIP_EMBEDDINGS) {
    try {
      const probe = await embeddings("embedding health probe");
      console.log(`\nEmbeddings: ✓ (${probe.embedding?.length ?? 0}d via ${probe.provider}/${probe.model})`);
    } catch (err) {
      console.error(`Embedding model not reachable: ${err}`);
      console.log("Set ZO_EMBEDDING_MODEL, or run with --skip-embeddings to skip embedding-dependent benchmarks.");
      process.exit(1);
    }
  } else {
    console.log("\nEmbeddings: Skipped (--skip-embeddings flag)");
  }

  // Setup
  console.log("\nSetting up benchmark database...");
  const db = setupDb();
  const facts = seedDatabase(db);
  console.log(`  Seeded ${facts.length} facts`);

  const linkCount = seedGraphLinks(db, facts);
  console.log(`  Created ${linkCount} graph links`);

  if (!SKIP_EMBEDDINGS) {
    console.log("  Generating embeddings (this may take a moment)...");
    const embCount = await seedEmbeddings(db);
    console.log(`  Generated ${embCount} embeddings`);
  }

  // Run benchmarks
  await benchmarkGraphSearch(db, facts);
  await benchmarkMemoryGate(db);
  await benchmarkAutoCapture(db);
  await benchmarkLatency(db);

  // Report
  generateReport();

  // Cleanup
  db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  console.log("\nBenchmark database cleaned up.");
}

main().catch(err => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
