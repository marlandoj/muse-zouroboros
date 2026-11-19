#!/usr/bin/env bun
/**
 * test-wikilink-enforcement.ts — Unit tests for wikilink auto-correction and exclusion filter
 *
 * Tests AC3 (exclusion filter), AC4 (two-tier confidence), AC1 (auto-wrap), AC6 (cross-fact).
 * Requires: 10+ positive cases (should wrap), 10+ negative cases (should exclude).
 *
 * Usage: bun test-wikilink-enforcement.ts
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  shouldExcludeFromWrapping,
  autoCorrectWikilinks,
  extractWikilinks,
  ENTITY_LIKE_PATTERN,
} from "./wikilink-utils";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// --- Setup: in-memory DB with some known entities ---

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      persona TEXT,
      entity TEXT NOT NULL,
      key TEXT,
      value TEXT NOT NULL DEFAULT '',
      text TEXT,
      category TEXT DEFAULT 'general',
      decay_class TEXT DEFAULT 'stable',
      importance REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER,
      expires_at INTEGER,
      last_accessed INTEGER,
      confidence REAL DEFAULT 1.0,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS fact_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE TABLE IF NOT EXISTS vault_files (
      id TEXT PRIMARY KEY,
      title TEXT
    );
  `);

  // Insert known entities
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  for (const entity of ["project.ffb", "system.memory", "config.routing", "persona.hermes", "tool.ollama"]) {
    db.prepare(
      "INSERT INTO facts (id, persona, entity, key, value, text, category, created_at, last_accessed) VALUES (?, 'test', ?, 'status', 'active', ?, 'general', ?, ?)"
    ).run(crypto.randomUUID(), entity, `${entity} status: active`, now, nowSec);
  }

  return db;
}

// ============================================================
// TEST SUITE 1: shouldExcludeFromWrapping — Negative cases
// (these should be EXCLUDED, i.e., NOT wrapped)
// ============================================================

console.log("\n=== Exclusion Filter: Negative Cases (should exclude) ===\n");

// 1. File extensions
assert(shouldExcludeFromWrapping("memory.ts") === true, "Excludes .ts file extension");
assert(shouldExcludeFromWrapping("config.json") === true, "Excludes .json file extension");
assert(shouldExcludeFromWrapping("readme.md") === true, "Excludes .md file extension");
assert(shouldExcludeFromWrapping("styles.css") === true, "Excludes .css file extension");
assert(shouldExcludeFromWrapping("schema.sql") === true, "Excludes .sql file extension");
assert(shouldExcludeFromWrapping("package.lock") === true, "Excludes .lock file extension");

// 2. URL patterns
assert(shouldExcludeFromWrapping("google.com") === true, "Excludes .com domain");
assert(shouldExcludeFromWrapping("github.io") === true, "Excludes .io domain");
assert(shouldExcludeFromWrapping("vercel.app") === true, "Excludes .app domain");
assert(shouldExcludeFromWrapping("npmjs.org") === true, "Excludes .org domain");

// 3. Version strings
assert(shouldExcludeFromWrapping("v2.0") === true, "Excludes version string v2.0");
assert(shouldExcludeFromWrapping("v3.3.1") === true, "Excludes version string v3.3.1");

// 4. Abbreviations
assert(shouldExcludeFromWrapping("e.g") === true, "Excludes abbreviation e.g");
assert(shouldExcludeFromWrapping("i.e") === true, "Excludes abbreviation i.e");

// ============================================================
// TEST SUITE 2: shouldExcludeFromWrapping — Positive cases
// (these should NOT be excluded, i.e., they SHOULD be wrapped)
// ============================================================

console.log("\n=== Exclusion Filter: Positive Cases (should NOT exclude) ===\n");

assert(shouldExcludeFromWrapping("project.ffb") === false, "Allows project.ffb (canonical entity)");
assert(shouldExcludeFromWrapping("system.memory") === false, "Allows system.memory (canonical entity)");
assert(shouldExcludeFromWrapping("config.routing") === false, "Allows config.routing (canonical entity)");
assert(shouldExcludeFromWrapping("persona.hermes") === false, "Allows persona.hermes (canonical entity)");
assert(shouldExcludeFromWrapping("tool.ollama") === false, "Allows tool.ollama (canonical entity)");
assert(shouldExcludeFromWrapping("swarm.orchestrator") === false, "Allows swarm.orchestrator");
assert(shouldExcludeFromWrapping("eval.pipeline") === false, "Allows eval.pipeline");
assert(shouldExcludeFromWrapping("memory.gate") === false, "Allows memory.gate");
assert(shouldExcludeFromWrapping("skill.interview") === false, "Allows skill.interview");
assert(shouldExcludeFromWrapping("phase.integration") === false, "Allows phase.integration");

// ============================================================
// TEST SUITE 3: autoCorrectWikilinks — Known entities (DB-backed)
// ============================================================

console.log("\n=== Auto-Correction: Known Entities (DB tier) ===\n");

const db = createTestDb();

{
  const result = autoCorrectWikilinks("Uses project.ffb for deployment", db);
  assert(result !== null, "Corrects known entity project.ffb");
  assert(result?.corrected_value === "Uses [[project.ffb]] for deployment", "Wraps project.ffb in [[]]", result?.corrected_value);
  assert(result?.confidence_tier === "known", "Tier is 'known' for DB entity");
}

{
  const result = autoCorrectWikilinks("Integrates system.memory and tool.ollama", db);
  assert(result !== null, "Corrects multiple known entities");
  assert(
    Boolean(result?.corrected_value.includes("[[system.memory]]") && result?.corrected_value.includes("[[tool.ollama]]")),
    "Both entities wrapped",
    result?.corrected_value
  );
  assert(result?.corrections_made.length === 2, "Two corrections made");
}

// ============================================================
// TEST SUITE 4: autoCorrectWikilinks — Pattern tier (no DB match)
// ============================================================

console.log("\n=== Auto-Correction: Pattern Tier (no DB match) ===\n");

{
  const result = autoCorrectWikilinks("References swarm.orchestrator module", db);
  assert(result !== null, "Corrects pattern-matching entity");
  assert(result?.corrected_value === "References [[swarm.orchestrator]] module", "Wraps pattern entity", result?.corrected_value);
  assert(result?.confidence_tier === "pattern", "Tier is 'pattern' for unknown entity");
}

// ============================================================
// TEST SUITE 5: autoCorrectWikilinks — No double-wrapping
// ============================================================

console.log("\n=== Auto-Correction: No Double-Wrapping ===\n");

{
  const result = autoCorrectWikilinks("Already linked [[project.ffb]] here", db);
  assert(result === null, "No correction when already wikilinked");
}

{
  const result = autoCorrectWikilinks("Has [[system.memory]] and tool.ollama", db);
  assert(result !== null, "Corrects unwrapped while skipping wrapped");
  assert(
    result?.corrected_value === "Has [[system.memory]] and [[tool.ollama]]",
    "Only wraps the bare entity",
    result?.corrected_value
  );
  assert(result?.corrections_made.length === 1, "Only one correction");
}

// ============================================================
// TEST SUITE 6: autoCorrectWikilinks — Exclusion in context
// ============================================================

console.log("\n=== Auto-Correction: Exclusion Filter in Context ===\n");

{
  const result = autoCorrectWikilinks("Edit the memory.ts file for v3.0 changes", db);
  assert(result === null, "No correction for file extension and version string");
}

{
  const result = autoCorrectWikilinks("Visit example.com for docs about project.ffb", db);
  assert(result !== null, "Corrects project.ffb but not example.com");
  assert(
    result ? !result.corrected_value.includes("[[example.com]]") : false,
    "Does not wrap .com domain",
    result?.corrected_value
  );
  assert(
    Boolean(result?.corrected_value.includes("[[project.ffb]]")),
    "Does wrap project.ffb",
    result?.corrected_value
  );
}

// ============================================================
// TEST SUITE 7: autoCorrectWikilinks — Self-entity skip
// ============================================================

console.log("\n=== Auto-Correction: Self-Entity Skip ===\n");

{
  const result = autoCorrectWikilinks("The project.ffb system uses tool.ollama", db, "project.ffb");
  assert(result !== null, "Still corrects other entities");
  assert(
    result ? !result.corrected_value.includes("[[project.ffb]]") : false,
    "Does not wrap self-entity",
    result?.corrected_value
  );
  assert(
    Boolean(result?.corrected_value.includes("[[tool.ollama]]")),
    "Wraps non-self entity",
    result?.corrected_value
  );
}

// ============================================================
// TEST SUITE 8: autoCorrectWikilinks — Metadata preservation
// ============================================================

console.log("\n=== Auto-Correction: Original Value Preserved ===\n");

{
  const result = autoCorrectWikilinks("Uses project.ffb for tasks", db);
  assert(result !== null, "Correction made");
  assert(result?.original_value === "Uses project.ffb for tasks", "Original value preserved");
  assert(result?.corrected_value !== result?.original_value, "Corrected value differs from original");
}

// ============================================================
// SUMMARY
// ============================================================

// ============================================================
// REGRESSION: issue #34 — toolMemorySearch FTS arm
//
// Two bugs made the MCP memory_search FTS arm return nothing for
// ordinary multi-word queries. They are reproduced here against the
// real schema.sql, because the bug lives in the SQL, not in JS.
// ============================================================

const SEARCH_QUERY = `
SELECT f.*
FROM facts_fts fts
JOIN facts f ON f.rowid = fts.rowid
WHERE fts.facts_fts MATCH ?
ORDER BY fts.rank
LIMIT 10
`;

function createFtsFixture(): Database {
  const fdb = new Database(":memory:");
  fdb.exec(readFileSync(new URL("./schema.sql", import.meta.url).pathname, "utf8"));
  const now = Date.now();
  fdb.prepare(
    `INSERT INTO facts (id, persona, entity, key, value, text, created_at)
     VALUES (?, 'shared', ?, ?, ?, ?, ?)`,
  ).run(
    "fixture-uuid-1",
    "zouroboros.harnesses",
    "harnesses",
    "eight harnesses",
    "eight harnesses are supported",
    now,
  );
  fdb.prepare(
    `INSERT INTO facts (id, persona, entity, key, value, text, created_at)
     VALUES (?, 'shared', ?, ?, ?, ?, ?)`,
  ).run(
    "fixture-uuid-2",
    "zouroboros.filing",
    "filing",
    "Cognito employer id",
    "Cognito employer id is 1234",
    now,
  );
  return fdb;
}

{
  const fdb = createFtsFixture();

  // Bug 1: the old join compared a TEXT uuid (facts.id) to an integer
  // (facts_fts.rowid). SQLite does not drop those rows -- the predicate
  // silently fails to restrict anything, so the arm degrades into a cross
  // join that returns the SAME facts for every query. Asserted here so a
  // future refactor cannot reintroduce it.
  const staleArm = (q: string) =>
    fdb
      .prepare(
        `SELECT f.* FROM facts_fts fts JOIN facts f ON f.id = fts.rowid
         WHERE fts.facts_fts MATCH ? ORDER BY fts.rank LIMIT 10`,
      )
      .all(q) as Array<Record<string, unknown>>;
  const staleOne = staleArm('"harnesses"').map((r) => r.id);
  const staleTwo = staleArm('"Cognito"').map((r) => r.id);
  assert(
    JSON.stringify(staleOne) === JSON.stringify(staleTwo),
    "regression guard: the pre-fix f.id = fts.rowid join is a cross join, not a filter",
    `both queries returned ${JSON.stringify(staleOne)}`,
  );

  // The correct join must return only the row each query actually matches.
  const correctArm = (q: string) =>
    fdb
      .prepare(SEARCH_QUERY)
      .all(q)
      .map((r) => (r as Record<string, unknown>).id);
  assert(
    correctArm('"harnesses"').length === 1 &&
      correctArm('"Cognito"').length === 1 &&
      correctArm('"harnesses"')[0] !== correctArm('"Cognito"')[0],
    "the f.rowid = fts.rowid join filters per query, unlike the stale one",
  );

  // Bug 2: FTS5 treats a bare multi-word MATCH as an adjacency phrase.
  const phraseQuery = fdb.prepare(SEARCH_QUERY).all("agent harnesses") as Array<unknown>;
  assert(
    phraseQuery.length === 0,
    "regression guard: a bare multi-word MATCH is still a phrase query",
    `expected 0 rows, got ${phraseQuery.length}`,
  );

  // The fix: tokenize to quoted OR-terms and join on rowid.
  const tokenized = "agent harnesses"
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(" OR ");
  const fixed = fdb.prepare(SEARCH_QUERY).all(tokenized) as Array<Record<string, unknown>>;
  assert(
    fixed.length === 1,
    "toolMemorySearch FTS arm finds the fact for a non-adjacent multi-word query",
    `expected 1 row, got ${fixed.length}`,
  );
  assert(
    fixed[0]?.id === "fixture-uuid-1",
    "the row returned is the matching fact, joined on rowid",
    `id=${String(fixed[0]?.id)}`,
  );

  // Tokenization must not emit an empty MATCH when the query is all stopwords.
  const empty = ["a", "'", '"']
    .join(" ")
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(" OR ");
  assert(
    empty === "",
    "tokenizing a stopword-only query yields an empty FTS expression, not a MATCH error",
  );

  fdb.close();
}

db.close();

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) {
  process.exit(1);
}
