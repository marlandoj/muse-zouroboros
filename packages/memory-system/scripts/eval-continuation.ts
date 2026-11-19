#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { ensureContinuationSchema, createEpisodeRecord, upsertOpenLoop, detectContinuation } from "./continuation";

const FIXTURE_PATH = new URL("../assets/continuation-eval-fixture-set.json", import.meta.url).pathname;
const TEST_DB_PATH = "/tmp/zo-memory-continuation-eval.db";

interface FixtureFact {
  entity: string;
  key: string;
  value: string;
  text: string;
  category: string;
  decayClass: string;
  createdDaysAgo: number;
  lastAccessedDaysAgo: number;
}

interface FixtureEpisode {
  summary: string;
  outcome: "success" | "failure" | "resolved" | "ongoing";
  happenedDaysAgo: number;
  entities: string[];
  metadata?: Record<string, unknown>;
}

interface FixtureOpenLoop {
  title: string;
  summary: string;
  kind: "task" | "bug" | "incident" | "approval" | "commitment" | "other";
  status: "open" | "resolved" | "stale" | "superseded";
  priority: number;
  entity: string;
  createdDaysAgo: number;
  updatedDaysAgo: number;
}

interface FixtureCase {
  id: string;
  query: string;
  expectDetection: boolean;
  expectAny: string[];
}

interface FixtureSet {
  name: string;
  windowDays: number;
  threshold: number;
  facts: FixtureFact[];
  episodes: FixtureEpisode[];
  openLoops: FixtureOpenLoop[];
  cases: FixtureCase[];
}

function loadFixtures(): FixtureSet {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as FixtureSet;
}

function ageToMs(daysAgo: number): number {
  return Date.now() - daysAgo * 24 * 3600 * 1000;
}

function ageToSec(daysAgo: number): number {
  return Math.floor(Date.now() / 1000) - daysAgo * 24 * 3600;
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
    CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
      VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
    END;
    CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
      VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
      INSERT INTO facts_fts(rowid, text, entity, key, value, category)
      VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
    END;
    CREATE TABLE fact_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE TABLE fact_embeddings (
      fact_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'text-embedding-3-small',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
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
    CREATE TABLE episode_entities (
      episode_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      PRIMARY KEY (episode_id, entity)
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
    CREATE INDEX idx_facts_lookup ON facts(entity, key);
    CREATE INDEX idx_facts_expires ON facts(expires_at);
  `);
  ensureContinuationSchema(db);
  return db;
}

function seedDb(db: Database, fixture: FixtureSet): void {
  for (const fact of fixture.facts) {
    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, expires_at, last_accessed, confidence, metadata)
      VALUES (?, 'shared', ?, ?, ?, ?, ?, ?, 1.0, 'fixture', ?, NULL, ?, 1.0, ?)
    `).run(
      crypto.randomUUID(),
      fact.entity,
      fact.key,
      fact.value,
      fact.text,
      fact.category,
      fact.decayClass,
      ageToMs(fact.createdDaysAgo),
      ageToSec(fact.lastAccessedDaysAgo),
      JSON.stringify({ fixture: true })
    );
  }

  for (const episode of fixture.episodes) {
    createEpisodeRecord(db, {
      summary: episode.summary,
      outcome: episode.outcome,
      happenedAt: ageToSec(episode.happenedDaysAgo),
      entities: episode.entities,
      metadata: { ...episode.metadata, fixture: true },
    });
  }

  for (const loop of fixture.openLoops) {
    const createdAt = ageToSec(loop.createdDaysAgo);
    const updatedAt = ageToSec(loop.updatedDaysAgo);
    const record = upsertOpenLoop(db, {
      persona: "shared",
      title: loop.title,
      summary: loop.summary,
      kind: loop.kind,
      status: loop.status,
      priority: loop.priority,
      entity: loop.entity,
      source: "fixture",
      metadata: { fixture: true },
    });
    db.prepare(`UPDATE open_loops SET created_at = ?, updated_at = ? WHERE id = ?`).run(createdAt, updatedAt, record.id);
  }
}

function runContinuation(db: Database, query: string, windowDays: number): string[] {
  const detection = detectContinuation(query);
  if (!detection.needsMemory) return [];

  const tokens = (detection.keywords.length > 0 ? detection.keywords : query.toLowerCase().split(/\s+/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3);

  const factRows = db.prepare(`
    SELECT entity, key, value, text, last_accessed, created_at
    FROM facts
    WHERE (last_accessed >= ? OR created_at >= ?)
  `).all(ageToSec(windowDays), ageToMs(windowDays)) as Array<Record<string, unknown>>;

  const episodeRows = db.prepare(`
    SELECT e.summary, group_concat(ee.entity, ' ') as entities
    FROM episodes e
    LEFT JOIN episode_entities ee ON ee.episode_id = e.id
    WHERE e.happened_at >= ?
    GROUP BY e.id
  `).all(ageToSec(windowDays)) as Array<Record<string, unknown>>;

  const loopRows = db.prepare(`
    SELECT title, summary, status, entity, updated_at
    FROM open_loops
    WHERE updated_at >= ? AND status IN ('open','stale','resolved')
  `).all(ageToSec(windowDays)) as Array<Record<string, unknown>>;

  const results: Array<{ score: number; text: string }> = [];

  for (const row of factRows) {
    const text = `${row.entity}.${row.key || "_"} = ${row.value}`;
    const haystack = `${row.entity} ${row.key || ""} ${row.value} ${row.text || ""}`.toLowerCase();
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) results.push({ score: overlap + 0.2, text });
  }

  for (const row of episodeRows) {
    const text = String(row.summary);
    const haystack = `${row.summary} ${row.entities || ""}`.toLowerCase();
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) results.push({ score: overlap + 0.5, text });
  }

  for (const row of loopRows) {
    const text = `${row.title} — ${row.summary}`;
    const haystack = `${row.title} ${row.summary} ${row.entity || ""}`.toLowerCase();
    const overlap = tokens.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) results.push({ score: overlap + 0.8, text });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 6).map((r) => r.text.toLowerCase());
}

function evaluateCase(db: Database, fixture: FixtureSet, testCase: FixtureCase) {
  const detection = detectContinuation(testCase.query);
  const lines = runContinuation(db, testCase.query, fixture.windowDays);
  const passedDetection = detection.needsMemory === testCase.expectDetection;
  const passedContent = !testCase.expectDetection || testCase.expectAny.length === 0
    ? true
    : testCase.expectAny.some((needle) => lines.some((line) => line.includes(needle.toLowerCase())));
  return {
    id: testCase.id,
    passed: passedDetection && passedContent,
    passedDetection,
    passedContent,
    detectionScore: detection.score,
    lines,
  };
}

async function main() {
  const fixture = loadFixtures();
  const db = setupDb();
  seedDb(db, fixture);

  const results = fixture.cases.map((testCase) => evaluateCase(db, fixture, testCase));
  const passed = results.filter((r) => r.passed).length;
  const rate = results.length === 0 ? 0 : passed / results.length;

  console.log(`Continuation Eval: ${fixture.name}`);
  console.log(`Cases: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Rate: ${(rate * 100).toFixed(1)}%`);
  console.log(`Threshold: ${(fixture.threshold * 100).toFixed(1)}%`);
  console.log();

  for (const result of results) {
    console.log(`${result.passed ? "✓" : "✗"} ${result.id} (detect=${result.passedDetection}, content=${result.passedContent}, score=${result.detectionScore})`);
  }

  db.close();
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
  process.exit(rate >= fixture.threshold ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
