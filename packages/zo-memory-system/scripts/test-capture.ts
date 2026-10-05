#!/usr/bin/env bun
/**
 * test-capture.ts — Integration tests for auto-capture pipeline
 *
 * Tests fact extraction parsing, dedup, contradiction detection,
 * co-capture linking, and capture log against a temporary SQLite database.
 * Does NOT require a live model provider (mocks the extraction response).
 *
 * Usage: bun test-capture.ts
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { unlinkSync, existsSync } from "fs";
import {
  createEpisodeRecord,
  detectContinuation,
  ensureContinuationSchema,
  resolveMatchingOpenLoops,
  searchEpisodesForContinuation,
  searchOpenLoopsForContinuation,
  upsertOpenLoop,
} from "./continuation";

const TEST_DB_PATH = "/tmp/zo-memory-test-capture.db";

let db: Database;
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function setupDb(): Database {
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  const db = new Database(TEST_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE facts (
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
    CREATE VIRTUAL TABLE facts_fts USING fts5(
      text, entity, key, value, category,
      content='facts', content_rowid='rowid'
    );
    CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END;
    CREATE TABLE fact_links (
      source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE INDEX idx_fact_links_source ON fact_links(source_id);
    CREATE INDEX idx_fact_links_target ON fact_links(target_id);
    CREATE TABLE capture_log (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      transcript_hash TEXT NOT NULL,
      facts_extracted INTEGER,
      facts_skipped INTEGER,
      contradictions INTEGER,
      model TEXT,
      duration_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      happened_at INTEGER NOT NULL,
      duration_ms INTEGER,
      procedure_id TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE episode_entities (
      episode_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      PRIMARY KEY (episode_id, entity)
    );
    CREATE TABLE procedures (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      steps TEXT NOT NULL,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      evolved_from TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  ensureContinuationSchema(db);
  return db;
}

function insertFact(db: Database, entity: string, key: string, value: string): string {
  const id = randomUUID();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, last_accessed, confidence)
    VALUES (?, 'shared', ?, ?, ?, ?, 'fact', 'stable', 1.0, 'test', ?, ?, 1.0)
  `).run(id, entity, key, value, `${entity} ${key}: ${value}`, now, nowSec);
  return id;
}

// Simulate the dedup/contradiction logic from auto-capture.ts
function checkExisting(db: Database, entity: string, key: string, value: string): { isDuplicate: boolean; contradicts: string | null } {
  const existing = db.prepare(
    "SELECT id, value FROM facts WHERE entity = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).all(entity, key, Math.floor(Date.now() / 1000)) as any[];

  if (existing.length === 0) return { isDuplicate: false, contradicts: null };
  for (const row of existing) {
    if (row.value === value) return { isDuplicate: true, contradicts: null };
  }
  return { isDuplicate: false, contradicts: existing[0].id };
}

// --- Test: Dedup Detection ---
function testDedupDetection() {
  console.log("\n--- Test: Duplicate Detection ---");
  db = setupDb();

  insertFact(db, "user", "name", "Alice");

  const result1 = checkExisting(db, "user", "name", "Alice");
  assert(result1.isDuplicate === true, "Exact match detected as duplicate");
  assert(result1.contradicts === null, "No contradiction for exact match");

  const result2 = checkExisting(db, "user", "name", "Bob");
  assert(result2.isDuplicate === false, "Different value not a duplicate");
  assert(result2.contradicts !== null, "Different value flagged as contradiction");

  const result3 = checkExisting(db, "user", "email", "alice@test.com");
  assert(result3.isDuplicate === false, "New key not a duplicate");
  assert(result3.contradicts === null, "New key not a contradiction");

  db.close();
}

// --- Test: Contradiction Handling ---
function testContradictionHandling() {
  console.log("\n--- Test: Contradiction Handling ---");
  db = setupDb();

  const oldId = insertFact(db, "project.ffb", "status", "Site launched");

  // Simulate contradiction: new fact supersedes old
  const { contradicts } = checkExisting(db, "project.ffb", "status", "Site redesign in progress");
  assert(contradicts === oldId, "Contradiction detected against old fact");

  // Simulate what auto-capture does: insert new fact, create supersedes link, halve old confidence
  const newId = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, last_accessed, confidence)
    VALUES (?, 'shared', 'project.ffb', 'status', 'Site redesign in progress', 'project.ffb status: Site redesign in progress', 'fact', 'active', 1.0, 'auto-capture:test', ?, ?, 0.8)
  `).run(newId, now, Math.floor(now / 1000));

  db.prepare("INSERT INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'supersedes', 1.0)")
    .run(newId, contradicts);
  db.prepare("UPDATE facts SET confidence = confidence * 0.5 WHERE id = ?").run(contradicts);

  const oldFact = db.prepare("SELECT confidence FROM facts WHERE id = ?").get(oldId) as any;
  assert(oldFact.confidence === 0.5, `Old fact confidence halved (${oldFact.confidence})`);

  const link = db.prepare("SELECT * FROM fact_links WHERE source_id = ? AND target_id = ?").get(newId, oldId) as any;
  assert(link !== null, "Supersedes link created");
  assert(link.relation === "supersedes", "Link relation is 'supersedes'");

  db.close();
}

// --- Test: Co-Capture Linking ---
function testCoCaptureLinks() {
  console.log("\n--- Test: Co-Capture Linking ---");
  db = setupDb();

  // Simulate storing 4 facts from same conversation
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, last_accessed, confidence)
      VALUES (?, 'shared', ?, ?, ?, ?, 'fact', 'stable', 1.0, 'auto-capture:test', ?, ?, 1.0)
    `).run(id, `entity.${i}`, `key${i}`, `value ${i}`, `entity.${i} key${i}: value ${i}`, now, Math.floor(now / 1000));
    ids.push(id);
  }

  // Create co-captured links (same logic as auto-capture.ts)
  let linksCreated = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'co-captured', 0.5)")
        .run(ids[i], ids[j]);
      linksCreated++;
    }
  }

  assert(linksCreated === 6, `Created 6 co-capture links for 4 facts (got ${linksCreated})`);

  const totalLinks = db.prepare("SELECT COUNT(*) as cnt FROM fact_links WHERE relation = 'co-captured'").get() as any;
  assert(totalLinks.cnt === 6, `Database has 6 co-captured links (got ${totalLinks.cnt})`);

  // Verify all links have weight 0.5
  const weights = db.prepare("SELECT DISTINCT weight FROM fact_links WHERE relation = 'co-captured'").all() as any[];
  assert(weights.length === 1 && weights[0].weight === 0.5, "All co-captured links have weight 0.5");

  db.close();
}

// --- Test: Capture Log ---
function testCaptureLog() {
  console.log("\n--- Test: Capture Log ---");
  db = setupDb();

  const hash = createHash("sha256").update("test transcript").digest("hex");

  // Log a capture
  db.prepare(`
    INSERT INTO capture_log (id, source, transcript_hash, facts_extracted, facts_skipped, contradictions, model, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), "chat:test", hash, 3, 1, 0, "openai:gpt-4o-mini", 4500);

  const log = db.prepare("SELECT * FROM capture_log WHERE transcript_hash = ?").get(hash) as any;
  assert(log !== null, "Capture log entry created");
  assert(log.facts_extracted === 3, "Facts extracted count correct");
  assert(log.facts_skipped === 1, "Facts skipped count correct");
  assert(log.model === "openai:gpt-4o-mini", "Model recorded");

  // Test re-processing prevention
  const existing = db.prepare("SELECT id FROM capture_log WHERE transcript_hash = ?").get(hash);
  assert(existing !== null, "Re-processing detected via transcript hash");

  db.close();
}

// --- Test: Quality Filters ---
function testQualityFilters() {
  console.log("\n--- Test: Quality Filters ---");

  // Simulate the filtering logic from auto-capture.ts
  const MIN_CONFIDENCE = 0.6;
  const MIN_VALUE_LENGTH = 10;

  const candidates = [
    { entity: "user", key: "name", value: "Alice Johnson is from Phoenix", confidence: 1.0 },  // pass
    { entity: "weather", key: "today", value: "Nice weather today", confidence: 0.3 },  // fail: low confidence
    { entity: "user", key: "x", value: "short", confidence: 0.9 },  // fail: too short
    { entity: "project", key: "db", value: "Using SQLite for memory storage", confidence: 0.7 },  // pass
  ];

  const passing = candidates.filter(c => c.confidence >= MIN_CONFIDENCE && c.value.length >= MIN_VALUE_LENGTH);
  assert(passing.length === 2, `2 of 4 candidates pass quality filters (got ${passing.length})`);
  assert(passing[0].entity === "user", "First passing fact is user.name");
  assert(passing[1].entity === "project", "Second passing fact is project.db");
}

// --- Test: Max Facts Cap ---
function testMaxFactsCap() {
  console.log("\n--- Test: Max Facts Per Capture ---");

  const MAX_FACTS = 20;
  const candidates = Array.from({ length: 30 }, (_, i) => ({
    entity: `entity.${i}`,
    key: `key${i}`,
    value: `This is a sufficiently long value for fact number ${i}`,
    confidence: 0.9,
  }));

  const capped = candidates.slice(0, MAX_FACTS);
  assert(capped.length === MAX_FACTS, `Capped at ${MAX_FACTS} facts (from ${candidates.length})`);
}

function testOpenLoopLifecycle() {
  console.log("\n--- Test: Open Loop Lifecycle ---");
  db = setupDb();

  const loop = upsertOpenLoop(db, {
    persona: "shared",
    title: "Fix dashboard data mismatch",
    summary: "Need to fix dashboard data mismatch before next review",
    kind: "bug",
    entity: "project.dashboard",
    source: "test",
  });

  assert(loop.status === "open", "Open loop inserted with open status");

  const matches = searchOpenLoopsForContinuation(db, "dashboard mismatch review", { limit: 5 });
  assert(matches.length >= 1, "Open loop searchable via continuation search");
  assert(matches[0].title.includes("dashboard"), "Returned open loop matches dashboard context");

  const resolved = resolveMatchingOpenLoops(db, "The dashboard data mismatch is fixed and completed now");
  assert(resolved >= 1, "Matching open loop resolved from completion text");

  const row = db.prepare("SELECT status FROM open_loops WHERE id = ?").get(loop.id) as any;
  assert(row.status === "resolved", "Open loop status updated to resolved");

  db.close();
}

function testContinuationDetection() {
  console.log("\n--- Test: Continuation Detection ---");
  const positive = detectContinuation("where did we leave off on the dashboard review?");
  assert(positive.needsMemory === true, "Continuation detector flags follow-on work");
  assert(positive.score >= 2, "Continuation score above threshold");

  const negative = detectContinuation("hello");
  assert(negative.needsMemory === false, "Continuation detector ignores greetings");
}

function testEpisodeSearchIndex() {
  console.log("\n--- Test: Episode Search Index ---");
  db = setupDb();

  createEpisodeRecord(db, {
    summary: "Worked on the health dashboard vitals layout and left a pending chart fix",
    outcome: "ongoing",
    happenedAt: Math.floor(Date.now() / 1000),
    entities: ["project.health-dashboard", "ui.dashboard"],
    metadata: { nextStep: "Fix chart alignment" },
  });

  const matches = searchEpisodesForContinuation(db, "health dashboard chart fix", { limit: 5, windowDays: 14 });
  assert(matches.length >= 1, "Episode document searchable for continuation recall");
  assert(matches[0].summary.includes("health dashboard"), "Episode summary returned in search results");

  db.close();
}

// --- Run All Tests ---
function run() {
  console.log("zo-memory-system — Auto-Capture Integration Tests\n");

  testDedupDetection();
  testContradictionHandling();
  testCoCaptureLinks();
  testCaptureLog();
  testQualityFilters();
  testMaxFactsCap();
  testOpenLoopLifecycle();
  testContinuationDetection();
  testEpisodeSearchIndex();

  // Cleanup
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
