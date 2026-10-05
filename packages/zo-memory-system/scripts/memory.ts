#!/usr/bin/env bun
/**
 * zo-memory-system v3 — Hybrid SQLite + Vector Search + Episodic Memory
 * 
 * v2 enhancements (QMD research):
 * - Vector embeddings (OpenAI text-embedding-3-small by default)
 * - HyDE query expansion (optional)
 * - RRF fusion (BM25 + vectors)
 * - Composite scoring with decay awareness
 * 
 * v3 enhancements (Mengram-inspired):
 * - Episodic memory (event-based "what happened" with outcomes)
 * - Temporal queries (since/until filtering)
 * - Procedure memory (workflow patterns with evolution) [Phase 2]
 * - DB migration system
 * 
 * Backward compatible with v1/v2 facts DB.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { join } from "path";
import { readFileSync } from "fs";
import { computeGraphBoost, findGraphNeighbors } from "./graph-boost";
import { extractWikilinks, resolveWikilinkTargets, autoCorrectWikilinks, shouldExcludeFromWrapping, ENTITY_LIKE_PATTERN } from "./wikilink-utils";
import {
  createEpisodeRecord,
  detectContinuation,
  ensureContinuationSchema,
  renderContinuationContext,
  resolveMatchingOpenLoops,
  searchEpisodesForContinuation,
  searchOpenLoopsForContinuation,
  upsertOpenLoop,
} from "./continuation";
import { generate as mcGenerate, embeddings as mcEmbeddings } from "./model-client";

// --- Configuration ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
// Model config now handled by model-client.ts; this is kept for status display and SQL defaults
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";

// Decay class TTLs in seconds
const TTL_DEFAULTS: Record<string, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

type DecayClass = "permanent" | "stable" | "active" | "session" | "checkpoint";
type Category = "preference" | "fact" | "decision" | "convention" | "other" | "reference" | "project";

interface MemoryEntry {
  id: string;
  persona: string;
  entity: string;
  key: string | null;
  value: string;
  text: string;
  category: Category;
  decayClass: DecayClass;
  importance: number;
  source: string;
  createdAt: number;
  expiresAt: number | null;
  lastAccessed: number;
  confidence: number;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

type Outcome = "success" | "failure" | "resolved" | "ongoing";

interface Episode {
  id: string;
  summary: string;
  outcome: Outcome;
  happenedAt: number;
  durationMs?: number;
  procedureId?: string;
  entities: string[];
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

interface TemporalQuery {
  since?: string;
  until?: string;
  entity?: string;
  outcome?: Outcome;
  limit?: number;
}

interface ProcedureStep {
  executor: string;
  taskPattern: string;
  timeoutSeconds: number;
  fallbackExecutor?: string;
  notes?: string;
}

interface Procedure {
  id: string;
  name: string;
  version: number;
  steps: ProcedureStep[];
  successCount: number;
  failureCount: number;
  evolvedFrom?: string;
  createdAt?: number;
}

// --- Database Setup ---
let db: Database;
let dbInitialized = false;

async function initDb(): Promise<Database> {
  if (dbInitialized && db) return db;

  db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Core facts table + FTS (must exist before anything else)
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
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      text, entity, key, value, category,
      content='facts', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
      VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
    END;
    CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
      VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END;

    CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
    CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_links (
      source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);

    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'text-embedding-3-small',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);
    CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class, expires_at);

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','resolved','ongoing')),
      happened_at INTEGER NOT NULL,
      duration_ms INTEGER,
      procedure_id TEXT REFERENCES procedures(id),
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS episode_entities (
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      entity TEXT NOT NULL,
      PRIMARY KEY (episode_id, entity)
    );

    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      steps TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      evolved_from TEXT REFERENCES procedures(id),
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS procedure_episodes (
      procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      PRIMARY KEY (procedure_id, episode_id)
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
    CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
    CREATE INDEX IF NOT EXISTS idx_episode_entities_entity ON episode_entities(entity);
    CREATE INDEX IF NOT EXISTS idx_procedures_name ON procedures(name);
  `);

  ensureContinuationSchema(db);
  
  dbInitialized = true;
  return db;
}

async function runMigration(): Promise<void> {
  const db = await initDb();
  
  try {
    const sqlV2 = readFileSync(join(import.meta.dir, "migrate-v2.sql"), "utf-8");
    db.exec(sqlV2);

    const v3Path = join(import.meta.dir, "migrate-v3.sql");
    try {
      const sqlV3 = readFileSync(v3Path, "utf-8");
      db.exec(sqlV3);
    } catch {
    }
    
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('episodes','episode_entities','procedures','procedure_episodes','episode_documents','open_loops') ORDER BY name"
    ).all() as Array<{ name: string }>;
    
    console.log("Migration complete.");
    console.log(`  Tables created/verified: ${tables.map(t => t.name).join(", ")}`);
    
    const factCount = db.prepare("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number };
    const embCount = db.prepare("SELECT COUNT(*) as cnt FROM fact_embeddings").get() as { cnt: number };
    console.log(`  Existing facts: ${factCount.cnt}`);
    console.log(`  Existing embeddings: ${embCount.cnt}`);
  } catch (err) {
    console.error(`Migration failed: ${err}`);
    process.exit(1);
  }
}

// --- Embedding Service (via model-client) ---
async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await mcEmbeddings(text.slice(0, 8000));
    return result.embedding.length > 0 ? result.embedding : null;
  } catch (err) {
    console.warn(`Embedding failed: ${err}`);
    return null;
  }
}

async function hydeExpand(query: string): Promise<string[]> {
  try {
    const result = await mcGenerate({
      prompt: `Query: "${query}"\n\nHypothetical relevant keywords and context (2-3 sentences):`,
      workload: "hyde",
      temperature: 0.3,
      maxTokens: 80,
    });
    const expanded = result.content.trim();
    if (expanded && expanded.length > 10) {
      return [query, expanded];
    }
    return [query];
  } catch {
    return [query];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Store with Embedding ---

interface StoreOptions {
  skipWikilinkEnforcement?: boolean;
}

async function storeWithEmbedding(
  entry: Omit<MemoryEntry, "id" | "createdAt" | "expiresAt" | "lastAccessed">,
  options?: StoreOptions
): Promise<MemoryEntry | null> {
  const db = await initDb();
  const id = randomUUID();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);

  const decayClass = entry.decayClass || "stable";
  const expiresAt = TTL_DEFAULTS[decayClass] ? nowSec + TTL_DEFAULTS[decayClass]! : null;

  // Wikilink auto-correction (default ON, opt-out via options.skipWikilinkEnforcement)
  let storeValue = entry.value;
  let storeMetadata = entry.metadata ? { ...entry.metadata } : {};
  if (!options?.skipWikilinkEnforcement) {
    const correction = autoCorrectWikilinks(storeValue, db, entry.entity);
    if (correction) {
      storeMetadata.original_value = correction.original_value;
      storeValue = correction.corrected_value;
      console.error(
        `\x1b[36m[wikilink-autocorrect]\x1b[0m Wrapped ${correction.corrections_made.length} entity reference(s) in [[...]]: ` +
        `${correction.corrections_made.map(c => c.entity).join(", ")} [tier: ${correction.confidence_tier}]`
      );
    }
  }

  // Insert fact
  const metadataStr = Object.keys(storeMetadata).length > 0 ? JSON.stringify(storeMetadata) : null;
  db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                       importance, source, created_at, expires_at, last_accessed, confidence, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.persona,
    entry.entity,
    entry.key,
    storeValue,
    entry.text || `${entry.entity} ${entry.key || ""}: ${storeValue}`,
    entry.category,
    decayClass,
    entry.importance,
    entry.source,
    now,
    expiresAt,
    nowSec,
    entry.confidence,
    metadataStr
  );

  // Generate and store embedding
  const textToEmbed = entry.text || `${entry.entity} ${entry.key || ""}: ${storeValue}`;
  const embedding = await getEmbedding(textToEmbed);

  if (embedding) {
    db.prepare(`
      INSERT INTO fact_embeddings (fact_id, embedding, model)
      VALUES (?, ?, ?)
    `).run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
  }

  // Parse wikilinks from value and create fact_links edges
  const wikilinks = extractWikilinks(storeValue);
  if (wikilinks.length > 0) {
    const resolved = resolveWikilinkTargets(db, wikilinks, {
      sourcePersona: entry.persona,
      sourceId: id,
    });
    for (const link of resolved) {
      db.prepare(
        "INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'wikilink', 1.0)"
      ).run(id, link.targetId);
    }
  }

  return {
    ...entry,
    value: storeValue,
    id,
    createdAt: now,
    expiresAt,
    lastAccessed: nowSec,
    embedding: embedding ?? undefined,
  };
}

// --- Hybrid Search ---
async function hybridSearch(
  query: string,
  options: { persona?: string; limit?: number; useHyde?: boolean; useGraph?: boolean } = {}
): Promise<Array<{ entry: MemoryEntry; score: number; sources: string[] }>> {
  const db = await initDb();
  const { persona, limit = 10, useHyde = true, useGraph = true } = options;
  const nowSec = Math.floor(Date.now() / 1000);

  // PARALLEL: Run FTS for original query + HyDE + embedding simultaneously
  const [ftsBaseResults, queryVariants, queryEmbedding] = await Promise.all([
    // FTS for original query (fast, always needed)
    (async () => {
      const safeQuery = query
        .replace(/['"]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .map((w) => `"${w}"`)
        .join(" OR ");
      
      if (!safeQuery) return [];
      
      return db.prepare(`
        SELECT f.*, rank
        FROM facts f
        JOIN facts_fts fts ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ?
          AND (f.expires_at IS NULL OR f.expires_at > ?)
          ${persona ? "AND f.persona = ?" : ""}
        ORDER BY rank
        LIMIT ${limit * 2}
      `).all(...[safeQuery, nowSec, ...(persona ? [persona] : [])]) as Array<Record<string, unknown>>;
    })(),
    // HyDE expansion (slow, runs in parallel)
    useHyde ? hydeExpand(query) : Promise.resolve([query]),
    // Query embedding (runs in parallel)
    getEmbedding(query),
  ]);

  // Collect FTS results
  const ftsResults = new Map<string, { entry: MemoryEntry; rank: number; source: string }>();
  
  for (const row of ftsBaseResults) {
    const id = row.id as string;
    ftsResults.set(id, {
      entry: rowToEntry(row),
      rank: row.rank as number,
      source: `fts:${query.slice(0, 30)}`,
    });
  }

  // If HyDE expanded the query, run FTS for expanded variant (after parallel phase)
  if (queryVariants.length > 1) {
    const hydeQuery = queryVariants[1];
    const safeHydeQuery = hydeQuery
      .replace(/['"]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map((w) => `"${w}"`)
      .join(" OR ");
    
    if (safeHydeQuery) {
      const hydeRows = db.prepare(`
        SELECT f.*, rank
        FROM facts f
        JOIN facts_fts fts ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ?
          AND (f.expires_at IS NULL OR f.expires_at > ?)
          ${persona ? "AND f.persona = ?" : ""}
        ORDER BY rank
        LIMIT ${limit}
      `).all(...[safeHydeQuery, nowSec, ...(persona ? [persona] : [])]) as Array<Record<string, unknown>>;
      
      for (const row of hydeRows) {
        const id = row.id as string;
        if (!ftsResults.has(id)) {
          ftsResults.set(id, {
            entry: rowToEntry(row),
            rank: row.rank as number,
            source: `fts:hyde`,
          });
        }
      }
    }
  }
  
  // Get vector results
  const vectorResults = new Map<string, { entry: MemoryEntry; similarity: number }>();
  
  if (queryEmbedding) {
    // Get all embeddings and compute similarity
    const embeddings = db.prepare(`
      SELECT fe.fact_id, fe.embedding
      FROM fact_embeddings fe
      JOIN facts f ON fe.fact_id = f.id
      WHERE (f.expires_at IS NULL OR f.expires_at > ?)
        ${persona ? "AND f.persona = ?" : ""}
    `).all(...[nowSec, ...(persona ? [persona] : [])]) as Array<{ fact_id: string; embedding: Buffer }>;
    
    for (const row of embeddings) {
      const embedding = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.length / 4));
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      
      if (similarity > 0.35) { // Threshold (lowered from 0.5 to capture more semantic matches)
        const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(row.fact_id) as Record<string, unknown>;
        if (fact) {
          vectorResults.set(row.fact_id, {
            entry: rowToEntry(fact),
            similarity,
          });
        }
      }
    }
  }
  
  // RRF Fusion
  const scores = new Map<string, { entry: MemoryEntry; ftsRank?: number; vecScore?: number; sources: string[] }>();
  
  const k = 60;
  
  // Add FTS scores
  let ftsPos = 1;
  for (const [id, result] of Array.from(ftsResults.entries()).sort((a, b) => a[1].rank - b[1].rank)) {
    const existing = scores.get(id);
    if (existing) {
      existing.ftsRank = ftsPos;
      existing.sources.push(result.source);
    } else {
      scores.set(id, { entry: result.entry, ftsRank: ftsPos, sources: [result.source] });
    }
    ftsPos++;
  }
  
  // Add vector scores
  let vecPos = 1;
  for (const [id, result] of Array.from(vectorResults.entries()).sort((a, b) => b[1].similarity - a[1].similarity)) {
    const existing = scores.get(id);
    if (existing) {
      existing.vecScore = vecPos;
      existing.sources.push("vector");
    } else {
      scores.set(id, { entry: result.entry, vecScore: vecPos, sources: ["vector"] });
    }
    vecPos++;
  }
  
  // Calculate RRF scores and prepare for graph boost
  const preBoosted: Array<{ id: string; entry: MemoryEntry; rrfScore: number; freshness: number; confidence: number; sources: string[] }> = [];

  for (const [id, result] of scores) {
    let rrfScore = 0;
    if (result.ftsRank) rrfScore += 2 / (k + result.ftsRank);  // FTS weighted 2x over vector
    if (result.vecScore) rrfScore += 1 / (k + result.vecScore);
    // Multi-signal bonus: facts matching both FTS and vector are more relevant
    if (result.ftsRank && result.vecScore) rrfScore *= 1.5;

    const nowSec2 = Math.floor(Date.now() / 1000);
    let freshness = 1;
    if (result.entry.expiresAt) {
      freshness = Math.max(0, Math.min(1, (result.entry.expiresAt - nowSec2) / (14 * 24 * 3600)));
    }

    preBoosted.push({
      id,
      entry: result.entry,
      rrfScore,
      freshness,
      confidence: result.entry.confidence,
      sources: result.sources,
    });
  }

  // When --no-graph is set, skip graph boost and neighbor injection
  if (!useGraph) {
    const finalResults: Array<{ entry: MemoryEntry; score: number; sources: string[] }> = preBoosted.map(r => ({
      entry: (r as any).entry,
      score: r.rrfScore * 0.7 + r.freshness * 0.2 + r.confidence * 0.1,
      sources: r.sources,
    }));
    finalResults.sort((a, b) => b.score - a.score);
    return finalResults.slice(0, limit);
  }

  // Apply graph boost (reweights composite scores when links exist)
  const boosted = computeGraphBoost(db, preBoosted);

  // Inject graph-discovered neighbors (facts linked to top results but not in current set)
  const topIds = boosted
    .sort((a, b) => b.composite - a.composite)
    .slice(0, 3)
    .map(r => r.id);
  const existingIds = new Set(boosted.map(r => r.id));
  const neighbors = findGraphNeighbors(db, topIds, existingIds, 2);

  const finalResults: Array<{ entry: MemoryEntry; score: number; sources: string[] }> = boosted.map(r => ({
    entry: r.entry,
    score: r.composite,
    sources: r.graphBoost > 0 ? [...r.sources, "graph"] : r.sources,
  }));

  // Add injected neighbors with a graph-only score
  for (const neighbor of neighbors) {
    const fact = db.prepare("SELECT * FROM facts WHERE id = ?").get(neighbor.factId) as Record<string, unknown>;
    if (fact) {
      finalResults.push({
        entry: rowToEntry(fact),
        score: neighbor.weight * 0.15, // Graph-only score
        sources: [`graph:${neighbor.relation}`],
      });
    }
  }

  finalResults.sort((a, b) => b.score - a.score);
  return finalResults.slice(0, limit);
}

// --- FTS-only Search (v1 compatible) ---
async function ftsSearch(query: string, options: { persona?: string; limit?: number; entity?: string } = {}): Promise<Array<{ entry: MemoryEntry; score: number }>> {
  const db = await initDb();
  const { persona, limit = 5, entity } = options;
  const nowSec = Math.floor(Date.now() / 1000);

  const safeQuery = query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(" OR ");

  if (!safeQuery) return [];

  const params: SQLQueryBindings[] = [safeQuery, nowSec];
  let entityFilter = "";
  if (persona) { entityFilter += " AND f.persona = ?"; params.push(persona); }
  if (entity) { entityFilter += " AND f.entity = ?"; params.push(entity); }
  params.push(limit);

  const rows = db.prepare(`
    SELECT f.*, rank
    FROM facts f
    JOIN facts_fts fts ON f.rowid = fts.rowid
    WHERE facts_fts MATCH ?
      AND (f.expires_at IS NULL OR f.expires_at > ?)
      ${entityFilter}
    ORDER BY rank
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>;
  
  const minRank = rows.length > 0 ? Math.min(...rows.map((r) => r.rank as number)) : 0;
  const maxRank = rows.length > 0 ? Math.max(...rows.map((r) => r.rank as number)) : 1;
  const range = maxRank - minRank || 1;
  
  return rows.map((row) => ({
    entry: rowToEntry(row),
    score: 1 - ((row.rank as number) - minRank) / range || 0.8,
  }));
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    persona: row.persona as string,
    entity: row.entity as string,
    key: row.key as string | null,
    value: row.value as string,
    text: row.text as string,
    category: row.category as Category,
    decayClass: (row.decay_class as DecayClass) || "stable",
    importance: (row.importance as number) || 1.0,
    source: row.source as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number | null,
    lastAccessed: row.last_accessed as number,
    confidence: (row.confidence as number) || 1.0,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
  };
}

// --- Backfill Embeddings ---
async function backfillEmbeddings(batchSize: number = 50): Promise<{ processed: number; failed: number }> {
  const db = await initDb();
  
  // Find facts without embeddings (skip rows with null/empty text)
  const facts = db.prepare(`
    SELECT f.* FROM facts f
    LEFT JOIN fact_embeddings fe ON f.id = fe.fact_id
    WHERE fe.fact_id IS NULL
      AND f.text IS NOT NULL
      AND length(f.text) > 0
    LIMIT ?
  `).all(batchSize) as Array<Record<string, unknown>>;

  let processed = 0;
  let failed = 0;

  for (const row of facts) {
    const text = row.text as string;
    if (!text || text.length === 0) {
      failed++;
      process.stdout.write("x");
      continue;
    }
    const embedding = await getEmbedding(text);
    
    if (embedding) {
      db.prepare(`
        INSERT INTO fact_embeddings (fact_id, embedding, model)
        VALUES (?, ?, ?)
      `).run(row.id as string, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
      processed++;
      process.stdout.write(".");
    } else {
      failed++;
      process.stdout.write("x");
    }
  }
  
  console.log();
  return { processed, failed };
}

// --- Episode Storage ---
async function createEpisode(episode: Omit<Episode, "id" | "createdAt">): Promise<Episode> {
  const db = await initDb();
  const id = createEpisodeRecord(db, {
    summary: episode.summary,
    outcome: episode.outcome,
    happenedAt: episode.happenedAt,
    durationMs: episode.durationMs,
    procedureId: episode.procedureId,
    entities: episode.entities,
    metadata: episode.metadata,
  });
  const nowSec = Math.floor(Date.now() / 1000);
  return { ...episode, id, createdAt: nowSec };
}

async function continuationSearch(
  query: string,
  options: { persona?: string; limit?: number; windowDays?: number; useHyde?: boolean } = {}
): Promise<{ items: Array<{ kind: string; score: number; summary: string; title: string }>; context: string; detection: ReturnType<typeof detectContinuation> }> {
  const db = await initDb();
  const limit = options.limit || 6;
  const windowDays = options.windowDays || 14;
  const detection = detectContinuation(query);

  const factResults = await hybridSearch(query, {
    persona: options.persona,
    limit,
    useHyde: options.useHyde ?? false,
  });

  const queryTokens = detection.keywords.length > 0
    ? detection.keywords
    : Array.from(new Set(
        query
          .toLowerCase()
          .replace(/[^a-z0-9_./-]+/g, " ")
          .split(/\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length >= 3)
      ));

  const factItems = factResults
    .map(({ entry, score }) => {
      if (
        entry.entity.startsWith("chatgpt.") ||
        entry.entity.startsWith("obsidian.") ||
        entry.entity.startsWith("markdown.")
      ) return null;
      const haystack = `${entry.entity} ${entry.key || ""} ${entry.value} ${entry.text || ""}`.toLowerCase();
      const overlap = queryTokens.filter((token) => haystack.includes(token)).length;
      const minOverlap = queryTokens.length >= 3 ? 2 : 1;
      if (overlap < minOverlap) return null;
      const recencyBase = Math.max(entry.lastAccessed || 0, Math.floor(entry.createdAt / 1000) || 0);
      const recency = recencyBase > 0 ? Math.max(0, 1 - ((Date.now() / 1000 - recencyBase) / (windowDays * 86400))) : 0;
      const isWindowEligible = recency > 0 || entry.decayClass === "active" || entry.decayClass === "session";
      if (!isWindowEligible) return null;
      const adjustedScore = score * 0.6 + Math.min(1, overlap / Math.max(1, queryTokens.length)) * 0.3 + recency * 0.1;
      return {
        kind: "fact",
        score: adjustedScore,
        title: `${entry.entity}.${entry.key || "_"}`,
        summary: `${entry.entity}.${entry.key || "_"} = ${entry.value}`,
      };
    })
    .filter((item): item is { kind: string; score: number; title: string; summary: string } => Boolean(item));

  const episodeItems = searchEpisodesForContinuation(db, query, { limit, windowDays })
    .map((item) => ({ kind: item.kind, score: item.score, title: item.title, summary: item.summary }));

  const openLoopItems = searchOpenLoopsForContinuation(db, query, {
    limit,
    persona: options.persona,
    includeResolved: false,
  }).map((item) => ({ kind: item.kind, score: item.score, title: item.title, summary: item.summary }));

  const combined = [...factItems, ...episodeItems, ...openLoopItems]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const context = combined.length === 0
    ? ""
    : renderContinuationContext(
        combined.map((item, idx) => ({
          kind: item.kind as "fact" | "episode" | "open_loop",
          id: `${item.kind}-${idx}`,
          title: item.title,
          summary: item.summary,
          score: item.score,
          source: item.kind,
        })),
        limit
      );

  return { items: combined, context, detection };
}

// --- Temporal Query Helpers ---
function parseRelativeTime(input: string): number {
  const now = Math.floor(Date.now() / 1000);
  
  // Try ISO date first (YYYY-MM-DD)
  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return Math.floor(new Date(input).getTime() / 1000);
  }
  
  // Relative: "N days/hours/weeks/months ago"
  const relMatch = input.match(/^(\d+)\s+(second|minute|hour|day|week|month)s?\s+ago$/i);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      week: 604800,
      month: 2592000,
    };
    return now - (n * (multipliers[unit] || 86400));
  }
  
  // Named: "last week", "last month", "today", "yesterday"
  const named: Record<string, number> = {
    "today": now - 86400,
    "yesterday": now - 172800,
    "last week": now - 604800,
    "last month": now - 2592000,
    "last year": now - 31536000,
  };
  if (named[input.toLowerCase()]) {
    return named[input.toLowerCase()];
  }
  
  // Fallback: try parsing as timestamp
  const ts = parseInt(input);
  if (!isNaN(ts)) return ts;
  
  console.warn(`Could not parse time: "${input}", defaulting to 7 days ago`);
  return now - 604800;
}

async function findEpisodes(query: TemporalQuery): Promise<Episode[]> {
  const db = await initDb();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  
  if (query.since) {
    conditions.push("e.happened_at >= ?");
    params.push(parseRelativeTime(query.since));
  }
  if (query.until) {
    conditions.push("e.happened_at <= ?");
    params.push(parseRelativeTime(query.until));
  }
  if (query.outcome) {
    conditions.push("e.outcome = ?");
    params.push(query.outcome);
  }
  if (query.entity) {
    conditions.push("e.id IN (SELECT episode_id FROM episode_entities WHERE entity = ?)");
    params.push(query.entity);
  }
  
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit || 20;
  
  const rows = db.prepare(`
    SELECT e.* FROM episodes e
    ${where}
    ORDER BY e.happened_at DESC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;
  
  return rows.map(row => {
    const entities = db.prepare(
      "SELECT entity FROM episode_entities WHERE episode_id = ?"
    ).all(row.id as string) as Array<{ entity: string }>;
    
    return {
      id: row.id as string,
      summary: row.summary as string,
      outcome: row.outcome as Outcome,
      happenedAt: row.happened_at as number,
      durationMs: row.duration_ms as number | undefined,
      procedureId: row.procedure_id as string | undefined,
      entities: entities.map(e => e.entity),
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      createdAt: row.created_at as number,
    };
  });
}

async function calculateVelocity(
  entity: string,
  granularity: "day" | "week" | "month" = "week",
  since?: string
): Promise<Array<{ period: string; total: number; successes: number; failures: number }>> {
  const db = await initDb();
  const sinceTs = since ? parseRelativeTime(since) : parseRelativeTime("90 days ago");
  
  const formatStr: Record<string, string> = {
    day: "%Y-%m-%d",
    week: "%Y-W%W",
    month: "%Y-%m",
  };
  
  const rows = db.prepare(`
    SELECT 
      strftime('${formatStr[granularity]}', e.happened_at, 'unixepoch') as period,
      COUNT(*) as total,
      SUM(CASE WHEN e.outcome = 'success' THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN e.outcome = 'failure' THEN 1 ELSE 0 END) as failures
    FROM episodes e
    JOIN episode_entities ee ON e.id = ee.episode_id
    WHERE ee.entity = ? AND e.happened_at >= ?
    GROUP BY period
    ORDER BY period
  `).all(entity, sinceTs) as Array<{ period: string; total: number; successes: number; failures: number }>;
  
  return rows;
}

// --- Procedural Memory ---
async function createProcedure(procedure: Omit<Procedure, "id" | "createdAt" | "successCount" | "failureCount">): Promise<Procedure> {
  const db = await initDb();
  const id = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO procedures (id, name, version, steps, success_count, failure_count, evolved_from, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
  `).run(
    id,
    procedure.name,
    procedure.version,
    JSON.stringify(procedure.steps),
    procedure.evolvedFrom || null,
    nowSec
  );

  return { ...procedure, id, successCount: 0, failureCount: 0, createdAt: nowSec };
}

async function getProcedure(name: string, version?: number): Promise<Procedure | null> {
  const db = await initDb();

  const row = version
    ? db.prepare("SELECT * FROM procedures WHERE name = ? AND version = ?").get(name, version) as Record<string, unknown> | null
    : db.prepare("SELECT * FROM procedures WHERE name = ? ORDER BY version DESC LIMIT 1").get(name) as Record<string, unknown> | null;

  if (!row) return null;
  return rowToProcedure(row);
}

async function listProcedures(): Promise<Procedure[]> {
  const db = await initDb();
  const rows = db.prepare(
    "SELECT * FROM procedures ORDER BY name, version DESC"
  ).all() as Array<Record<string, unknown>>;
  return rows.map(rowToProcedure);
}

function rowToProcedure(row: Record<string, unknown>): Procedure {
  return {
    id: row.id as string,
    name: row.name as string,
    version: row.version as number,
    steps: JSON.parse(row.steps as string) as ProcedureStep[],
    successCount: row.success_count as number,
    failureCount: row.failure_count as number,
    evolvedFrom: row.evolved_from as string | undefined,
    createdAt: row.created_at as number,
  };
}

async function recordProcedureFeedback(
  procedureId: string,
  success: boolean,
  details?: { episodeId?: string; error?: string }
): Promise<void> {
  const db = await initDb();

  if (success) {
    db.prepare("UPDATE procedures SET success_count = success_count + 1, last_used_at = strftime('%s','now') WHERE id = ?").run(procedureId);
  } else {
    db.prepare("UPDATE procedures SET failure_count = failure_count + 1, last_used_at = strftime('%s','now') WHERE id = ?").run(procedureId);
  }

  // Link to episode if provided
  if (details?.episodeId) {
    db.prepare(
      "INSERT OR IGNORE INTO procedure_episodes (procedure_id, episode_id) VALUES (?, ?)"
    ).run(procedureId, details.episodeId);
  }
}

const MIN_RUNS_FOR_EVOLUTION = 3;

async function evolveProcedure(procedureName: string): Promise<Procedure | null> {
  const db = await initDb();
  const current = await getProcedure(procedureName);
  if (!current) {
    console.error(`Procedure not found: ${procedureName}`);
    return null;
  }

  // Validation gate: require minimum successful runs before allowing evolution
  const totalRuns = current.successCount + current.failureCount;
  if (totalRuns < MIN_RUNS_FOR_EVOLUTION) {
    console.warn(
      `Evolution blocked for "${procedureName}" v${current.version}: ` +
      `only ${totalRuns} run(s) recorded (need ${MIN_RUNS_FOR_EVOLUTION}). ` +
      `Run the procedure at least ${MIN_RUNS_FOR_EVOLUTION - totalRuns} more time(s) before evolving.`
    );
    return current;
  }

  // Get failure episodes linked to this procedure
  const failureEpisodes = db.prepare(`
    SELECT e.* FROM episodes e
    JOIN procedure_episodes pe ON e.id = pe.episode_id
    WHERE pe.procedure_id = ? AND e.outcome = 'failure'
    ORDER BY e.happened_at DESC
    LIMIT 5
  `).all(current.id) as Array<Record<string, unknown>>;

  // Also check general failure episodes with overlapping entities
  const stepExecutors = current.steps.map(s => s.executor);
  const generalFailures = db.prepare(`
    SELECT DISTINCT e.* FROM episodes e
    JOIN episode_entities ee ON e.id = ee.episode_id
    WHERE e.outcome = 'failure'
      AND ee.entity IN (${stepExecutors.map(() => "?").join(",")})
      AND e.happened_at > ?
    ORDER BY e.happened_at DESC
    LIMIT 5
  `).all(...stepExecutors, Math.floor(Date.now() / 1000) - 30 * 86400) as Array<Record<string, unknown>>;

  const allFailures = [...failureEpisodes, ...generalFailures];

  if (allFailures.length === 0) {
    console.log("No failure data to evolve from. Procedure is performing well.");
    return current;
  }

  console.log(`Evolving "${procedureName}" v${current.version} using ${allFailures.length} failure episodes...`);

  // Use the configured generation model to suggest improvements
  const failureSummaries = allFailures.map(f => (f.summary as string)).join("\n- ");
  const currentStepsJson = JSON.stringify(current.steps, null, 2);

  try {
    const result = await mcGenerate({
      prompt: `You are optimizing a multi-step workflow procedure. Given the current steps and recent failures, suggest an improved version.

Current procedure "${procedureName}" v${current.version}:
${currentStepsJson}

Recent failures:
- ${failureSummaries}

Success rate: ${current.successCount}/${current.successCount + current.failureCount}

Output ONLY a valid JSON array of improved steps. Each step has: executor (string), taskPattern (string), timeoutSeconds (number), fallbackExecutor (string, optional), notes (string, optional).
Keep the same general structure but adjust executors, timeouts, or add fallbacks based on failure patterns.`,
      workload: "extraction",
      model: process.env.ZO_EVOLUTION_MODEL,
      temperature: 0.3,
      maxTokens: 1500,
      json: true,
    });

    const text = result.content.trim();

    // Parse JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found in response");

    const newSteps = JSON.parse(jsonMatch[0]) as ProcedureStep[];
    if (!Array.isArray(newSteps) || newSteps.length === 0) throw new Error("Empty steps array");

    // Validate steps
    const validSteps = newSteps.map(s => ({
      executor: String(s.executor || "claude-code"),
      taskPattern: String(s.taskPattern || ""),
      timeoutSeconds: Number(s.timeoutSeconds) || 300,
      fallbackExecutor: s.fallbackExecutor ? String(s.fallbackExecutor) : undefined,
      notes: s.notes ? String(s.notes) : undefined,
    }));

    // Create evolved procedure (starts with 0 runs — must be validated before trusting)
    const evolved = await createProcedure({
      name: procedureName,
      version: current.version + 1,
      steps: validSteps,
      evolvedFrom: current.id,
    });

    console.log(
      `Evolved to v${evolved.version} with ${evolved.steps.length} steps. ` +
      `⚠️  Unvalidated — run at least ${MIN_RUNS_FOR_EVOLUTION} times before relying on this version.`
    );
    return evolved;
  } catch (err) {
    console.error(`Evolution failed: ${err}`);
    return null;
  }
}

// --- Auto-Procedure from Episodes ---
async function autoCreateProcedureFromEpisodes(
  entityPattern: string,
  sinceDate?: string,
  minSuccessCount: number = 2
): Promise<Procedure | null> {
  const db = await initDb();

  const since = sinceDate ? parseRelativeTime(sinceDate) : Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

  const episodes = db.prepare(`
    SELECT e.id, e.summary, e.outcome, e.duration_ms, e.metadata, e.happened_at
    FROM episodes e
    JOIN episode_entities ee ON e.id = ee.episode_id
    WHERE ee.entity LIKE ? AND e.outcome = 'success' AND e.happened_at >= ?
    ORDER BY e.happened_at DESC
  `).all(`%${entityPattern}%`, since) as Array<Record<string, unknown>>;

  if (episodes.length < minSuccessCount) {
    console.log(`Only ${episodes.length} successful episodes match "${entityPattern}" (need ${minSuccessCount}). Skipping.`);
    return null;
  }

  const steps: ProcedureStep[] = [];
  const executorCounts: Record<string, number> = {};

  for (const ep of episodes) {
    const meta = ep.metadata ? JSON.parse(ep.metadata as string) : {};
    if (meta.executors) {
      for (const exec of meta.executors as string[]) {
        executorCounts[exec] = (executorCounts[exec] || 0) + 1;
      }
    }
    if (meta.tasks && Array.isArray(meta.tasks)) {
      for (const task of meta.tasks as Array<{ executor?: string; category?: string; durationMs?: number }>) {
        if (task.executor && task.category) {
          steps.push({
            executor: task.executor,
            taskPattern: task.category,
            timeoutSeconds: task.durationMs ? Math.ceil(task.durationMs / 1000) * 2 : 300,
          });
        }
      }
    }
  }

  if (steps.length === 0) {
    const topExecutors = Object.entries(executorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    for (const [exec] of topExecutors) {
      steps.push({
        executor: exec,
        taskPattern: entityPattern,
        timeoutSeconds: 300,
        notes: `Inferred from ${executorCounts[exec]} successful episodes`,
      });
    }
  }

  if (steps.length === 0) {
    console.log("Could not infer procedure steps from episode metadata.");
    return null;
  }

  const deduped = steps.reduce<ProcedureStep[]>((acc, step) => {
    if (!acc.find(s => s.executor === step.executor && s.taskPattern === step.taskPattern)) {
      acc.push(step);
    }
    return acc;
  }, []);

  const name = `auto-${entityPattern.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
  const existing = await getProcedure(name);
  if (existing) {
    console.log(`Procedure "${name}" already exists (v${existing.version}). Use --evolve to update.`);
    return existing;
  }

  const proc = await createProcedure({ name, version: 1, steps: deduped });
  console.log(`Auto-created procedure: ${proc.name} v${proc.version} with ${deduped.length} steps from ${episodes.length} episodes`);
  return proc;
}

// --- Delete & Prune ---
async function deleteFact(factId: string): Promise<boolean> {
  const db = await initDb();
  const existing = db.prepare("SELECT id FROM facts WHERE id = ?").get(factId) as Record<string, unknown> | null;
  if (!existing) return false;
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("DELETE FROM facts WHERE id = ?").run(factId);
  return true;
}

interface PruneResult {
  deleted: number;
  ids: string[];
}

async function pruneExpired(dryRun: boolean = false): Promise<PruneResult> {
  const db = await initDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const rows = db.prepare(
    "SELECT id, entity, key, value FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?"
  ).all(nowSec) as Array<Record<string, unknown>>;
  if (!dryRun && rows.length > 0) {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?").run(nowSec);
  }
  return { deleted: dryRun ? 0 : rows.length, ids: rows.map(r => r.id as string) };
}

async function pruneBelowActivation(threshold: number, dryRun: boolean = false): Promise<PruneResult> {
  const db = await initDb();
  const hasActr = db.prepare(
    "SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'actr_activation\'"
  ).get();
  if (!hasActr) {
    console.error("ACT-R activation table not found. Run the system with ACT-R enabled first.");
    return { deleted: 0, ids: [] };
  }
  const rows = db.prepare(
    "SELECT f.id, f.entity, f.key, f.value, a.total_activation FROM facts f JOIN actr_activation a ON f.id = a.fact_id WHERE a.total_activation < ?"
  ).all(threshold) as Array<Record<string, unknown>>;
  if (!dryRun && rows.length > 0) {
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      "DELETE FROM facts WHERE id IN (SELECT f.id FROM facts f JOIN actr_activation a ON f.id = a.fact_id WHERE a.total_activation < ?)"
    ).run(threshold);
  }
  return { deleted: dryRun ? 0 : rows.length, ids: rows.map(r => r.id as string) };
}

// --- Stats ---
async function stats(): Promise<void> {
  const db = await initDb();
  
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM facts`).get() as { cnt: number };
  const withEmbeddings = db.prepare(`
    SELECT COUNT(*) as cnt FROM facts f
    JOIN fact_embeddings fe ON f.id = fe.fact_id
  `).get() as { cnt: number };
  const embeddingCount = db.prepare(`SELECT COUNT(*) as cnt FROM fact_embeddings`).get() as { cnt: number };
  
  console.log("Memory Statistics (v3):");
  console.log(`  Total facts: ${total.cnt}`);
  console.log(`  Facts with embeddings: ${withEmbeddings.cnt}`);
  console.log(`  Vector cache entries: ${embeddingCount.cnt}`);
  console.log(`  Embedding model: ${EMBEDDING_MODEL}`);
  
  // Check for v3 tables (episodes, procedures)
  const hasEpisodes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'"
  ).get();
  
  if (hasEpisodes) {
    const episodeCount = db.prepare("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number };
    const recentEpisodes = db.prepare(
      "SELECT COUNT(*) as cnt FROM episodes WHERE happened_at > ?"
    ).get(Math.floor(Date.now() / 1000) - 604800) as { cnt: number };
    console.log(`  Episodes: ${episodeCount.cnt} (${recentEpisodes.cnt} in last 7 days)`);
  }
  
  const hasProcedures = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='procedures'"
  ).get();
  
  if (hasProcedures) {
    const procCount = db.prepare("SELECT COUNT(*) as cnt FROM procedures").get() as { cnt: number };
    console.log(`  Procedures: ${procCount.cnt}`);
  }

  const hasOpenLoops = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='open_loops'"
  ).get();

  if (hasOpenLoops) {
    const openLoopCount = db.prepare("SELECT COUNT(*) as cnt FROM open_loops WHERE status IN ('open','stale')").get() as { cnt: number };
    const resolvedLoopCount = db.prepare("SELECT COUNT(*) as cnt FROM open_loops WHERE status = 'resolved'").get() as { cnt: number };
    console.log(`  Open loops: ${openLoopCount.cnt} open/stale, ${resolvedLoopCount.cnt} resolved`);
  }
  
  if (!hasEpisodes && !hasProcedures) {
    console.log("  (Run 'bun memory.ts migrate' to enable episodic + procedural memory)");
  }
}

// --- CLI Interface ---
function printUsage() {
  console.log(`
zo-memory-system v3 — Hybrid SQLite + Vector Search + Episodic Memory

Usage:
  bun memory.ts <command> [options]

Commands:
  init      Initialize/verify database schema
  store     Store a new fact with embedding
  search    FTS-only search (v1 compatible)
  hybrid    Hybrid search (FTS + vectors + HyDE)
  continuation  Blended continuation recall across facts, episodes, and open loops
  open-loops    List open loops
  resolve-loop  Resolve matching open loops from text
  index     Backfill embeddings for existing facts
  stats     Show memory statistics
  migrate   Run database migration (adds episodes + procedures tables)
  episodes  List/query episodic memory (--create to add)
  procedures  List/manage workflow procedures (--create, --show, --evolve, --auto, --feedback)
  trends    Show velocity trends for an entity
  delete    Delete a specific fact by ID (cascades to embeddings, links, activation)
  prune     Garbage-collect expired facts and/or low-activation facts


Delete options:
  --id <fact_id>       Fact ID to delete (required)

Prune options:
  --expired            Prune facts past their expires_at timestamp (default if no flag given)
  --below-activation <n>  Prune facts with ACT-R activation below threshold (e.g. -3.0)
  --dry-run            Preview what would be pruned without deleting

Store options:
  --entity <name>      Entity name (required)
  --key <name>         Key/attribute (optional)
  --value <text>       Value (required)
  --category <type>    preference|fact|decision|convention|other
  --decay <class>      permanent|stable|active|session|checkpoint
  --text <text>        Full context for embedding

Search options:
  --persona <name>     Filter by persona
  --limit <n>          Max results (default: 5/6)
  --no-hyde            Disable HyDE expansion
  --no-graph           Skip graph boost and neighbor injection
  --window <days>      Continuation lookback window in days (default: 14)

Episodes options:
  --create             Create a new episode
  --summary <text>     Episode summary (required for --create)
  --outcome <type>     Filter or set: success|failure|resolved|ongoing
  --entities <csv>     Comma-separated entity list (for --create)
  --duration <ms>      Duration in milliseconds (for --create)
  --entity <name>      Filter by entity (for listing)
  --since <time>       Since: "7 days ago", "2026-03-01", "last week"
  --until <time>       Until: same formats as --since
  --limit <n>          Max results (default: 20)

Procedures options:
  --create             Create a new procedure
  --name <name>        Procedure name (required for --create)
  --steps <json>       Steps as JSON array or path to JSON file (required for --create)
  --version <n>        Version number (default: 1)
  --show <name>        Show procedure details
  --evolve <name>      Evolve a procedure via model-client analysis
  --auto <pattern>     Auto-create procedure from successful episodes matching entity pattern
  --feedback <name>    Record feedback (requires --success or --failure)
  --min-success <n>    Min successful episodes for --auto (default: 2)

Open loop options:
  --status <state>     open|resolved|stale|superseded

Examples:
  bun memory.ts init
  bun memory.ts continuation "where did we leave off on the dashboard?"
  bun memory.ts open-loops --status open
  bun memory.ts resolve-loop "The dashboard issue is fixed now"
  bun memory.ts store --entity "user" --key "name" --value "Alice"
  bun memory.ts hybrid "router password"
  bun memory.ts migrate
  bun memory.ts episodes --entity "swarm.ffb" --since "7 days ago"
  bun memory.ts episodes --create --summary "Fixed auth bug" --outcome success --entities "auth,security"
  bun memory.ts procedures --create --name "deploy-flow" --steps '[{"executor":"claude-code","taskPattern":"build","timeoutSeconds":300}]'
  bun memory.ts procedures --auto "swarm" --since "7 days ago"
  bun memory.ts delete --id "abc-123-def"
  bun memory.ts prune --expired --dry-run
  bun memory.ts prune --below-activation -3.0
  bun memory.ts prune --expired --below-activation -3.0
  bun memory.ts stats
`);
}

async function main() {
  await initDb();
  
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }
  
  // Parse flags
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (args[i] === "--no-hyde") {
        flags.hyde = "false";
      } else if (args[i] === "--no-graph") {
        flags.graph = "false";
      } else if (args[i] === "--create" || args[i] === "--list" || args[i] === "--success" || args[i] === "--failure" || args[i] === "--dry-run" || args[i] === "--json" || args[i] === "--no-embed") {
        flags[args[i].slice(2)] = "true";
      } else {
        flags[args[i].slice(2)] = args[i + 1] || "";
        i++;
      }
    } else {
      positional.push(args[i]);
    }
  }
  
  switch (command) {
    case "init": {
      await initDb();
      console.log(`Initialized: ${DB_PATH}`);
      break;
    }

    case "store": {
      if (!flags.entity || !flags.value) {
        console.error("Error: --entity and --value are required");
        process.exit(1);
      }
      const entry = await storeWithEmbedding({
        persona: flags.persona || "shared",
        entity: flags.entity,
        key: flags.key || null,
        value: flags.value,
        text: flags.text || `${flags.entity} ${flags.key || ""}: ${flags.value}`,
        category: (flags.category as Category) || "fact",
        decayClass: (flags.decay as DecayClass) || "stable",
        importance: parseFloat(flags.importance) || 1.0,
        source: flags.source || "cli",
        confidence: 1.0,
      });
      if (entry) {
        console.log(`Stored: ${entry.id}`);
        console.log(`Embedding: ${entry.embedding ? "generated" : "failed"}`);
      }
      break;
    }

    case "batch-store": {
      // Read JSON array from stdin (pipe) or --file path
      // Each item: { entity, value, key?, category?, decay?, importance?, persona?, source?, text? }
      let input: string;
      if (flags.file) {
        input = readFileSync(flags.file, "utf-8");
      } else {
        // Read from stdin
        const chunks: Buffer[] = [];
        const reader = Bun.stdin.stream().getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        input = Buffer.concat(chunks).toString("utf-8");
      }

      let items: Array<Record<string, unknown>>;
      try {
        items = JSON.parse(input);
        if (!Array.isArray(items)) throw new Error("Input must be a JSON array");
      } catch (e: any) {
        console.error(`Error: Invalid JSON input: ${e.message}`);
        process.exit(1);
      }

      const db = await initDb();
      const noEmbed = flags["no-embed"] === "true";
      const nowSec = Math.floor(Date.now() / 1000);
      const ids: string[] = [];
      let embedCount = 0;

      // Phase 1: Insert all facts in a single transaction
      const insertStmt = db.prepare(`
        INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, expires_at, last_accessed, confidence, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec("BEGIN TRANSACTION");
      try {
        for (const item of items) {
          const id = randomUUID();
          const entity = item.entity as string;
          const value = item.value as string;
          if (!entity || !value) {
            console.error(`Skipping item: missing entity or value`);
            continue;
          }
          const key = (item.key as string) || null;
          const persona = (item.persona as string) || "shared";
          const text = (item.text as string) || `${entity} ${key || ""}: ${value}`;
          const category = (item.category as string) || "fact";
          const decayClass = (item.decay as string) || "stable";
          const importance = parseFloat(String(item.importance)) || 1.0;
          const source = (item.source as string) || "batch";
          const expiresAt = TTL_DEFAULTS[decayClass as DecayClass] ? nowSec + TTL_DEFAULTS[decayClass as DecayClass]! : null;

          insertStmt.run(id, persona, entity, key, value, text, category, decayClass, importance, source, nowSec, expiresAt, nowSec, 1.0, null);
          ids.push(id);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }

      console.error(`Inserted ${ids.length} facts`);

      // Phase 2: Generate embeddings (unless --no-embed)
      if (!noEmbed && ids.length > 0) {
        const embedStmt = db.prepare(`INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)`);
        const batchSize = 10;
        for (let i = 0; i < ids.length; i += batchSize) {
          const batch = ids.slice(i, i + batchSize);
          const facts = batch.map(id => db.prepare("SELECT id, text FROM facts WHERE id = ?").get(id) as { id: string; text: string });
          const embedResults = await Promise.all(
            facts.filter(Boolean).map(async (f) => {
              try {
                const emb = await getEmbedding(f.text);
                return emb ? { id: f.id, embedding: emb } : null;
              } catch { return null; }
            })
          );
          for (const result of embedResults) {
            if (result) {
              const buf = Buffer.from(new Float32Array(result.embedding).buffer);
              embedStmt.run(result.id, buf, EMBEDDING_MODEL);
              embedCount++;
            }
          }
          if (ids.length > 20) {
            console.error(`Embeddings: ${Math.min(i + batchSize, ids.length)}/${ids.length}`);
          }
        }
      }

      if (flags.json === "true") {
        console.log(JSON.stringify({ stored: ids.length, embedded: embedCount, ids }));
      } else {
        console.log(`Stored: ${ids.length} facts, Embedded: ${embedCount}`);
      }
      break;
    }

    case "search": {
      const query = positional[0];
      if (!query) {
        console.error("Error: search query required");
        process.exit(1);
      }
      const searchOpts: { persona?: string; limit?: number; entity?: string } = {
        persona: flags.persona,
        limit: parseInt(flags.limit) || 5,
      };
      if (flags.entity) searchOpts.entity = flags.entity;
      const results = await ftsSearch(query, searchOpts);
      if (flags.json === "true") {
        console.log(JSON.stringify(results.map(({ entry, score }) => ({
          id: entry.id, persona: entry.persona, entity: entry.entity,
          key: entry.key, value: entry.value, text: entry.text,
          category: entry.category, decayClass: entry.decayClass,
          importance: entry.importance, source: entry.source,
          createdAt: entry.createdAt, expiresAt: entry.expiresAt,
          confidence: entry.confidence, score,
        }))));
      } else {
        console.log(`Found ${results.length} results:\n`);
        for (const { entry, score } of results) {
          console.log(`[${entry.decayClass}] ${entry.entity}.${entry.key || "_"} = ${entry.value.slice(0, 80)}`);
          console.log(`    score: ${score.toFixed(3)}`);
          console.log();
        }
      }
      break;
    }
    
    case "hybrid": {
      const query = positional[0];
      if (!query) {
        console.error("Error: search query required");
        process.exit(1);
      }
      if (flags.json !== "true") {
        console.log(`Searching: "${query}" ${flags.hyde === "false" ? "(no HyDE)" : "(with HyDE)"}${flags.graph === "false" ? " (no graph)" : ""}\n`);
      }
      const results = await hybridSearch(query, {
        persona: flags.persona,
        limit: parseInt(flags.limit) || 6,
        useHyde: flags.hyde !== "false",
        useGraph: flags.graph !== "false",
      });
      if (flags.json === "true") {
        console.log(JSON.stringify(results.map(({ entry, score, sources }) => ({
          id: entry.id, persona: entry.persona, entity: entry.entity,
          key: entry.key, value: entry.value, text: entry.text,
          category: entry.category, decayClass: entry.decayClass,
          importance: entry.importance, source: entry.source,
          createdAt: entry.createdAt, expiresAt: entry.expiresAt,
          confidence: entry.confidence, score, sources,
        }))));
      } else {
        console.log(`Found ${results.length} results:\n`);
        for (const { entry, score, sources } of results) {
          console.log(`[${entry.decayClass}] ${entry.entity}.${entry.key || "_"} = ${entry.value.slice(0, 80)}`);
          console.log(`    score: ${score.toFixed(3)} | sources: ${sources.join(", ")}`);
          console.log();
        }
      }
      break;
    }
    
    case "continuation": {
      const query = positional[0];
      if (!query) {
        console.error("Error: continuation query required");
        process.exit(1);
      }
      const result = await continuationSearch(query, {
        persona: flags.persona,
        limit: parseInt(flags.limit) || 6,
        windowDays: parseInt(flags.window) || 14,
        useHyde: flags.hyde !== "false",
      });
      console.log(`[Continuation Detection] score=${result.detection.score} reason=${result.detection.reason}`);
      if (!result.context || result.items.length === 0) {
        console.log("No continuation context found.");
        break;
      }
      console.log(result.context);
      console.log();
      for (const item of result.items) {
        console.log(`- [${item.kind}] ${item.title}`);
        console.log(`    score: ${item.score.toFixed(3)}`);
        console.log(`    ${item.summary}`);
      }
      break;
    }

    case "open-loops": {
      const db = await initDb();
      const status = flags.status || "open";
      const rows = db.prepare(`
        SELECT * FROM open_loops
        WHERE status = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(status, parseInt(flags.limit) || 20) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        console.log("No open loops found.");
        break;
      }
      console.log(`Found ${rows.length} open loops:\n`);
      for (const row of rows) {
        console.log(`- [${row.status}] ${row.title}`);
        console.log(`    kind=${row.kind} priority=${Number(row.priority || 0).toFixed(2)} entity=${row.entity || "-"}`);
        console.log(`    ${row.summary}`);
      }
      break;
    }

    case "resolve-loop": {
      const text = positional[0];
      if (!text) {
        console.error("Error: resolve-loop text required");
        process.exit(1);
      }
      const db = await initDb();
      const resolved = resolveMatchingOpenLoops(db, text);
      console.log(`Resolved ${resolved} open loops.`);
      break;
    }

    case "index": {
      console.log("Backfilling embeddings...");
      const batch = parseInt(flags.batch) || 50;
      const { processed, failed } = await backfillEmbeddings(batch);
      console.log(`\nProcessed: ${processed}, Failed: ${failed}`);
      break;
    }
    
    case "migrate": {
      await runMigration();
      break;
    }
    
    case "episodes": {
      if (flags.create !== undefined) {
        if (!flags.summary) {
          console.error("Error: --summary is required for --create");
          process.exit(1);
        }
        const outcome = (flags.outcome as Outcome) || "success";
        const entities = flags.entities ? flags.entities.split(",").map((e: string) => e.trim()) : [];
        const durationMs = flags.duration ? parseInt(flags.duration) : undefined;
        const ep = await createEpisode({
          summary: flags.summary,
          outcome,
          happenedAt: Math.floor(Date.now() / 1000),
          durationMs,
          entities,
          metadata: flags.metadata ? JSON.parse(flags.metadata) : undefined,
        });
        console.log(`Created episode: ${ep.id}`);
        console.log(`  outcome: ${ep.outcome}`);
        console.log(`  summary: ${ep.summary}`);
        if (entities.length > 0) {
          console.log(`  entities: ${entities.join(", ")}`);
        }
        break;
      }
      const episodes = await findEpisodes({
        entity: flags.entity,
        outcome: flags.outcome as Outcome | undefined,
        since: flags.since,
        until: flags.until,
        limit: parseInt(flags.limit) || 20,
      });
      
      if (episodes.length === 0) {
        console.log("No episodes found.");
        break;
      }
      
      console.log(`Found ${episodes.length} episodes:\n`);
      for (const ep of episodes) {
        const date = new Date(ep.happenedAt * 1000).toISOString().slice(0, 16).replace("T", " ");
        const duration = ep.durationMs ? ` (${(ep.durationMs / 1000).toFixed(1)}s)` : "";
        const outcomeIcon = { success: "✓", failure: "✗", resolved: "~", ongoing: "…" }[ep.outcome];
        console.log(`${outcomeIcon} [${ep.outcome}] ${date}${duration}`);
        console.log(`  ${ep.summary}`);
        if (ep.entities.length > 0) {
          console.log(`  entities: ${ep.entities.join(", ")}`);
        }
        console.log();
      }
      break;
    }
    
    case "trends": {
      if (!flags.entity) {
        console.error("Error: --entity is required for trends");
        process.exit(1);
      }
      const granularity = (flags.granularity || "week") as "day" | "week" | "month";
      const velocity = await calculateVelocity(flags.entity, granularity, flags.since);
      
      if (velocity.length === 0) {
        console.log(`No episodes found for entity "${flags.entity}".`);
        break;
      }
      
      console.log(`Velocity trends for "${flags.entity}" (by ${granularity}):\n`);
      console.log("  Period        Total  OK  Fail  Rate");
      console.log("  ─────────────────────────────────────");
      for (const v of velocity) {
        const rate = v.total > 0 ? ((v.successes / v.total) * 100).toFixed(0) : "–";
        console.log(`  ${v.period.padEnd(12)}  ${String(v.total).padStart(5)}  ${String(v.successes).padStart(2)}  ${String(v.failures).padStart(4)}  ${rate}%`);
      }
      break;
    }
    
    case "stats": {
      await stats();
      break;
    }
    
    case "procedures": {
      if (flags.create !== undefined) {
        if (!flags.name) {
          console.error("Error: --name is required for --create");
          process.exit(1);
        }
        if (!flags.steps) {
          console.error("Error: --steps is required (JSON array or path to JSON file)");
          process.exit(1);
        }
        let steps: ProcedureStep[];
        try {
          if (flags.steps.startsWith("[")) {
            steps = JSON.parse(flags.steps);
          } else {
            steps = JSON.parse(readFileSync(flags.steps, "utf-8"));
          }
        } catch (e) {
          console.error(`Error parsing steps: ${e}`);
          process.exit(1);
        }
        const version = parseInt(flags.version) || 1;
        const proc = await createProcedure({ name: flags.name, version, steps });
        console.log(`Created procedure: ${proc.id}`);
        console.log(`  name: ${proc.name} v${proc.version}`);
        console.log(`  steps: ${proc.steps.length}`);
        for (let i = 0; i < proc.steps.length; i++) {
          const s = proc.steps[i];
          console.log(`    ${i + 1}. [${s.executor}] ${s.taskPattern} (${s.timeoutSeconds}s)`);
        }
        break;
      }
      if (flags.list !== undefined || (!flags.show && !flags.evolve && !flags.feedback && !flags.auto)) {
        const procs = await listProcedures();
        if (procs.length === 0) {
          console.log("No procedures found.");
          break;
        }
        console.log(`Found ${procs.length} procedures:\n`);
        const seen = new Set<string>();
        for (const p of procs) {
          if (seen.has(p.name)) continue;
          seen.add(p.name);
          const rate = (p.successCount + p.failureCount) > 0
            ? ((p.successCount / (p.successCount + p.failureCount)) * 100).toFixed(0)
            : "–";
          console.log(`  ${p.name} v${p.version}  (${p.successCount}/${p.successCount + p.failureCount} = ${rate}% success)  ${p.steps.length} steps`);
          if (p.evolvedFrom) console.log(`    evolved from: ${p.evolvedFrom}`);
        }
      } else if (flags.show) {
        const proc = await getProcedure(flags.show);
        if (!proc) {
          console.log(`Procedure not found: ${flags.show}`);
          break;
        }
        console.log(`Procedure: ${proc.name} v${proc.version}`);
        console.log(`Success rate: ${proc.successCount}/${proc.successCount + proc.failureCount}`);
        if (proc.evolvedFrom) console.log(`Evolved from: ${proc.evolvedFrom}`);
        console.log(`\nSteps:`);
        for (let i = 0; i < proc.steps.length; i++) {
          const s = proc.steps[i];
          console.log(`  ${i + 1}. [${s.executor}] ${s.taskPattern} (${s.timeoutSeconds}s)`);
          if (s.fallbackExecutor) console.log(`     fallback: ${s.fallbackExecutor}`);
          if (s.notes) console.log(`     note: ${s.notes}`);
        }
      } else if (flags.auto) {
        await autoCreateProcedureFromEpisodes(
          flags.auto,
          flags.since,
          parseInt(flags["min-success"]) || 2
        );
      } else if (flags.evolve) {
        await evolveProcedure(flags.evolve);
      } else if (flags.feedback) {
        const success = flags.success !== undefined;
        const failure = flags.failure !== undefined;
        if (!success && !failure) {
          console.error("Error: --feedback requires --success or --failure");
          process.exit(1);
        }
        await recordProcedureFeedback(flags.feedback, success);
        console.log(`Recorded ${success ? "success" : "failure"} for procedure ${flags.feedback}`);
      }
      break;
    }
    
    case "mcp": {
      console.log("Starting MCP server...");
      const { execSync } = require("child_process");
      const mcpPath = join(import.meta.dir, "mcp-server.ts");
      execSync(`bun ${mcpPath}`, { stdio: "inherit" });
      break;
    }

    case "profile": {
      if (!flags.executor) {
        console.error("Error: --executor is required for profile");
        process.exit(1);
      }
      const histPath = join(process.env.HOME || "/tmp", ".swarm", "executor-history.json");
      if (!require("fs").existsSync(histPath)) {
        console.log("No executor history found.");
        break;
      }
      const history = JSON.parse(readFileSync(histPath, "utf-8"));
      const prefix = `${flags.executor}:`;
      const entries = Object.entries(history).filter(([k]) => k.startsWith(prefix));

      if (entries.length === 0) {
        console.log(`No history found for executor: ${flags.executor}`);
        break;
      }

      console.log(`Cognitive profile for ${flags.executor}:\n`);
      for (const [key, entry] of entries as [string, any][]) {
        const category = key.split(":")[1] || "unknown";
        const rate = entry.attempts > 0
          ? ((entry.successes / entry.attempts) * 100).toFixed(0)
          : "–";
        console.log(`  ${category}: ${entry.successes}/${entry.attempts} = ${rate}% success, avg ${(entry.avgDurationMs / 1000).toFixed(1)}s`);
        if (entry.recent_episode_ids?.length) {
          console.log(`    recent episodes: ${entry.recent_episode_ids.slice(0, 5).join(", ")}`);
        }
        if (entry.failure_patterns?.length) {
          console.log(`    failure patterns: ${entry.failure_patterns.join(", ")}`);
        }
        if (entry.entity_affinities && Object.keys(entry.entity_affinities).length > 0) {
          const affinities = Object.entries(entry.entity_affinities)
            .sort((a: any, b: any) => b[1] - a[1])
            .slice(0, 5)
            .map(([e, s]: [string, any]) => `${e}=${(s as number).toFixed(2)}`)
            .join(", ");
          console.log(`    entity affinities: ${affinities}`);
        }
        console.log();
      }
      break;
    }

    case "import": {
      const source = flags.source;
      const path = flags.path;
      const dryRun = flags["dry-run"] !== undefined;

      if (!source || !path) {
        console.error("Error: --source and --path are required for import");
        console.error("  Sources: chatgpt, obsidian, markdown");
        process.exit(1);
      }

      const importPath = join(import.meta.dir, "import.ts");
      const { execSync } = require("child_process");
      try {
        execSync(`bun ${importPath} --source ${source} --path "${path}" ${dryRun ? "--dry-run" : ""}`, { stdio: "inherit" });
      } catch (e) {
        console.error(`Import failed: ${e}`);
        process.exit(1);
      }
      break;
    }

    case "metrics": {
      // Delegate to metrics.ts for MEM-101 dashboard
      const { execSync } = require("child_process");
      const metricsPath = join(import.meta.dir, "metrics.ts");
      const metricsArgs = process.argv.slice(3); // skip "memory.ts metrics"
      try {
        execSync(`bun "${metricsPath}" ${metricsArgs.join(" ")}`, { stdio: "inherit" });
      } catch (e) {
        console.error(`Metrics command failed: ${e}`);
        process.exit(1);
      }
      break;
    }

    case "delete": {
      const factId = flags.id || positional[0];
      if (!factId) {
        console.error("Error: --id <fact_id> is required");
        process.exit(1);
      }
      const deleted = await deleteFact(factId);
      if (deleted) {
        console.log(`Deleted fact: ${factId} (cascaded embeddings, links, activation)`);
      } else {
        console.error(`Fact not found: ${factId}`);
        process.exit(1);
      }
      break;
    }

    case "prune": {
      const dryRun = flags["dry-run"] === "true";
      const results: PruneResult[] = [];

      if (flags.expired === "true" || (!flags["below-activation"] && !flags.expired)) {
        const r = await pruneExpired(dryRun);
        if (r.ids.length > 0) {
          console.log(`${dryRun ? "[DRY RUN] Would prune" : "Pruned"} ${r.ids.length} expired facts`);
          if (dryRun) r.ids.slice(0, 10).forEach(id => console.log(`  - ${id}`));
        } else {
          console.log("No expired facts to prune.");
        }
        results.push(r);
      }

      if (flags["below-activation"]) {
        const threshold = parseFloat(flags["below-activation"]);
        if (isNaN(threshold)) {
          console.error("Error: --below-activation requires a numeric threshold (e.g. -1.5)");
          process.exit(1);
        }
        const r = await pruneBelowActivation(threshold, dryRun);
        if (r.ids.length > 0) {
          console.log(`${dryRun ? "[DRY RUN] Would prune" : "Pruned"} ${r.ids.length} facts below activation ${threshold}`);
          if (dryRun) r.ids.slice(0, 10).forEach(id => console.log(`  - ${id}`));
        } else {
          console.log(`No facts below activation threshold ${threshold}.`);
        }
        results.push(r);
      }

      const totalDeleted = results.reduce((sum, r) => sum + (dryRun ? r.ids.length : r.deleted), 0);
      if (dryRun) {
        console.log(`\n[DRY RUN] Total: ${totalDeleted} facts would be pruned. Re-run without --dry-run to execute.`);
      } else {
        console.log(`\nTotal pruned: ${totalDeleted} facts.`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(console.error);
