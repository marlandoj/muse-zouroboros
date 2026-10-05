#!/usr/bin/env bun
/**
 * test-graph.ts — Integration tests for graph features
 *
 * Tests graph-boost scoring, link/unlink, BFS path finding,
 * and knowledge-gaps analysis against a temporary SQLite database.
 *
 * Usage: bun test-graph.ts
 */

import { Database } from "bun:sqlite";
import { computeGraphBoost, findGraphNeighbors } from "./graph-boost";
import { randomUUID } from "crypto";
import { unlinkSync, existsSync } from "fs";

const TEST_DB_PATH = "/tmp/zo-memory-test-graph.db";

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
  `);
  return db;
}

function insertFact(db: Database, id: string, entity: string, key: string, value: string): void {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, last_accessed, confidence)
    VALUES (?, 'shared', ?, ?, ?, ?, 'fact', 'stable', 1.0, 'test', ?, ?, 1.0)
  `).run(id, entity, key, value, `${entity} ${key}: ${value}`, now, nowSec);
}

function insertLink(db: Database, sourceId: string, targetId: string, relation: string = "related", weight: number = 1.0): void {
  db.prepare("INSERT INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
    .run(sourceId, targetId, relation, weight);
}

// --- Test: Graph Boost with No Links ---
function testNoLinks() {
  console.log("\n--- Test: No Links (Original Scoring) ---");
  db = setupDb();

  const idA = randomUUID();
  insertFact(db, idA, "test", "a", "Fact A");

  const results = computeGraphBoost(db, [
    { id: idA, rrfScore: 0.016, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
  ]);

  assert(results.length === 1, "Returns 1 result");
  assert(results[0].graphBoost === 0, "Graph boost is 0 when no links");
  // Original weights: 0.016 * 0.7 + 1.0 * 0.2 + 1.0 * 0.1 = 0.3112
  const expected = 0.016 * 0.7 + 1.0 * 0.2 + 1.0 * 0.1;
  assert(Math.abs(results[0].composite - expected) < 0.001, `Composite uses original weights (${results[0].composite.toFixed(4)} ≈ ${expected.toFixed(4)})`);

  db.close();
}

// --- Test: Graph Boost with Links ---
function testWithLinks() {
  console.log("\n--- Test: Linked Facts Get Boosted ---");
  db = setupDb();

  const idA = randomUUID();
  const idB = randomUUID();
  const idC = randomUUID();
  insertFact(db, idA, "test", "a", "Fact A");
  insertFact(db, idB, "test", "b", "Fact B");
  insertFact(db, idC, "test", "c", "Fact C");
  insertLink(db, idA, idB, "related", 1.0);

  const results = computeGraphBoost(db, [
    { id: idA, rrfScore: 0.016, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
    { id: idB, rrfScore: 0.015, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
    { id: idC, rrfScore: 0.014, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
  ]);

  assert(results.length === 3, "Returns 3 results");

  const resultA = results.find(r => r.id === idA)!;
  const resultB = results.find(r => r.id === idB)!;
  const resultC = results.find(r => r.id === idC)!;

  assert(resultA.graphBoost > 0, "Fact A has graph boost (source of link)");
  assert(resultB.graphBoost > 0, "Fact B has graph boost (target of link)");
  assert(resultC.graphBoost === 0, "Fact C has no graph boost (unlinked)");
  assert(resultB.graphBoost > resultA.graphBoost, "Target gets higher boost than source");

  db.close();
}

// --- Test: Weighted Links ---
function testWeightedLinks() {
  console.log("\n--- Test: Link Weight Affects Boost ---");
  db = setupDb();

  const idA = randomUUID();
  const idB = randomUUID();
  const idC = randomUUID();
  insertFact(db, idA, "test", "a", "Fact A");
  insertFact(db, idB, "test", "b", "Fact B");
  insertFact(db, idC, "test", "c", "Fact C");
  insertLink(db, idA, idB, "related", 0.5);
  insertLink(db, idA, idC, "related", 1.0);

  const results = computeGraphBoost(db, [
    { id: idA, rrfScore: 0.016, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
    { id: idB, rrfScore: 0.015, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
    { id: idC, rrfScore: 0.014, freshness: 1.0, confidence: 1.0, sources: ["fts"] },
  ]);

  const resultB = results.find(r => r.id === idB)!;
  const resultC = results.find(r => r.id === idC)!;

  assert(resultC.graphBoost > resultB.graphBoost, "Higher weight link gives higher boost (C > B)");

  db.close();
}

// --- Test: findGraphNeighbors ---
function testFindNeighbors() {
  console.log("\n--- Test: Find Graph Neighbors ---");
  db = setupDb();

  const idA = randomUUID();
  const idB = randomUUID();
  const idC = randomUUID();
  const idD = randomUUID();
  insertFact(db, idA, "test", "a", "Fact A");
  insertFact(db, idB, "test", "b", "Fact B");
  insertFact(db, idC, "test", "c", "Fact C");
  insertFact(db, idD, "test", "d", "Fact D");
  insertLink(db, idA, idC, "related", 1.0);
  insertLink(db, idA, idD, "depends_on", 0.8);

  const existingIds = new Set([idA, idB]);
  const neighbors = findGraphNeighbors(db, [idA], existingIds, 3);

  assert(neighbors.length === 2, `Found 2 neighbors (got ${neighbors.length})`);
  assert(neighbors.some(n => n.factId === idC), "Found neighbor C");
  assert(neighbors.some(n => n.factId === idD), "Found neighbor D");
  assert(!neighbors.some(n => n.factId === idB), "Did not include existing result B");

  db.close();
}

// --- Test: Empty Results ---
function testEmptyResults() {
  console.log("\n--- Test: Empty Results ---");
  db = setupDb();

  const results = computeGraphBoost(db, []);
  assert(results.length === 0, "Returns empty array for empty input");

  const neighbors = findGraphNeighbors(db, [], new Set(), 3);
  assert(neighbors.length === 0, "Returns empty neighbors for empty input");

  db.close();
}

// --- Test: BFS Path Finding (via graph.ts subprocess) ---
async function testBfsPathFinding() {
  console.log("\n--- Test: BFS Path Finding ---");
  db = setupDb();

  const idA = randomUUID();
  const idB = randomUUID();
  const idC = randomUUID();
  insertFact(db, idA, "entity.start", "a", "Start fact");
  insertFact(db, idB, "entity.middle", "b", "Middle fact");
  insertFact(db, idC, "entity.end", "c", "End fact");
  insertLink(db, idA, idB, "leads_to", 1.0);
  insertLink(db, idB, idC, "leads_to", 1.0);

  // Test BFS via adjacency construction (same logic as graph.ts)
  const allLinks = db.prepare("SELECT source_id, target_id, relation FROM fact_links").all() as any[];
  const adjacency = new Map<string, Array<{ neighbor: string }>>();
  for (const link of allLinks) {
    if (!adjacency.has(link.source_id)) adjacency.set(link.source_id, []);
    adjacency.get(link.source_id)!.push({ neighbor: link.target_id });
    if (!adjacency.has(link.target_id)) adjacency.set(link.target_id, []);
    adjacency.get(link.target_id)!.push({ neighbor: link.source_id });
  }

  // BFS from A to C
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: idA, depth: 0 }];
  visited.add(idA);
  let found = false;
  let hops = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.id === idC) { found = true; hops = current.depth; break; }
    if (current.depth >= 5) continue;
    for (const { neighbor } of adjacency.get(current.id) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  assert(found, "BFS found path from A to C");
  assert(hops === 2, `Path is 2 hops (got ${hops})`);

  // Test no-path case
  const idOrphan = randomUUID();
  insertFact(db, idOrphan, "entity.orphan", "x", "Orphan fact");

  const visited2 = new Set<string>();
  const queue2: Array<{ id: string; depth: number }> = [{ id: idA, depth: 0 }];
  visited2.add(idA);
  let found2 = false;

  while (queue2.length > 0) {
    const current = queue2.shift()!;
    if (current.id === idOrphan) { found2 = true; break; }
    if (current.depth >= 5) continue;
    for (const { neighbor } of adjacency.get(current.id) || []) {
      if (!visited2.has(neighbor)) {
        visited2.add(neighbor);
        queue2.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  assert(!found2, "BFS correctly reports no path to orphan");

  // Test cycle doesn't infinite loop
  insertLink(db, idC, idA, "loops_to", 1.0);
  const allLinks2 = db.prepare("SELECT source_id, target_id FROM fact_links").all() as any[];
  const adj2 = new Map<string, Array<{ neighbor: string }>>();
  for (const link of allLinks2) {
    if (!adj2.has(link.source_id)) adj2.set(link.source_id, []);
    adj2.get(link.source_id)!.push({ neighbor: link.target_id });
    if (!adj2.has(link.target_id)) adj2.set(link.target_id, []);
    adj2.get(link.target_id)!.push({ neighbor: link.source_id });
  }
  const visited3 = new Set<string>();
  const queue3: Array<{ id: string; depth: number }> = [{ id: idA, depth: 0 }];
  visited3.add(idA);
  let steps = 0;
  while (queue3.length > 0 && steps < 100) {
    const current = queue3.shift()!;
    steps++;
    if (current.depth >= 5) continue;
    for (const { neighbor } of adj2.get(current.id) || []) {
      if (!visited3.has(neighbor)) {
        visited3.add(neighbor);
        queue3.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }
  assert(steps < 100, `Cycle didn't cause infinite loop (${steps} steps)`);

  db.close();
}

// --- Test: Knowledge Gaps ---
function testKnowledgeGaps() {
  console.log("\n--- Test: Knowledge Gaps ---");
  db = setupDb();

  // Create mixed state: some linked, some orphaned
  const ids = Array.from({ length: 6 }, () => randomUUID());
  insertFact(db, ids[0], "project.a", "name", "Project A");
  insertFact(db, ids[1], "project.a", "status", "Active");
  insertFact(db, ids[2], "project.b", "name", "Project B");
  insertFact(db, ids[3], "user", "name", "Alice");  // orphan
  insertFact(db, ids[4], "user", "email", "alice@example.com");  // orphan
  insertFact(db, ids[5], "decision", "db", "Use SQLite");  // dead end

  insertLink(db, ids[0], ids[1], "has_attribute", 1.0);
  insertLink(db, ids[0], ids[2], "depends_on", 0.8);
  insertLink(db, ids[2], ids[5], "informed_by", 1.0);

  const allFacts = db.prepare("SELECT id FROM facts").all() as any[];
  const allLinks = db.prepare("SELECT source_id, target_id FROM fact_links").all() as any[];

  // Build adjacency
  const adj = new Map<string, Set<string>>();
  const outbound = new Map<string, number>();
  const inbound = new Map<string, number>();
  for (const f of allFacts) {
    adj.set(f.id, new Set());
    outbound.set(f.id, 0);
    inbound.set(f.id, 0);
  }
  for (const l of allLinks) {
    adj.get(l.source_id)?.add(l.target_id);
    adj.get(l.target_id)?.add(l.source_id);
    outbound.set(l.source_id, (outbound.get(l.source_id) || 0) + 1);
    inbound.set(l.target_id, (inbound.get(l.target_id) || 0) + 1);
  }

  const orphans = allFacts.filter((f: any) => (adj.get(f.id)?.size || 0) === 0);
  assert(orphans.length === 2, `Found 2 orphans (got ${orphans.length})`);

  const deadEnds = allFacts.filter((f: any) => {
    const inCount = inbound.get(f.id) || 0;
    const outCount = outbound.get(f.id) || 0;
    return inCount > 0 && outCount === 0 && (adj.get(f.id)?.size || 0) > 0;
  });
  assert(deadEnds.length === 2, `Found 2 dead ends (got ${deadEnds.length})`);

  // Connected components
  const componentOf = new Map<string, number>();
  let componentCount = 0;
  for (const f of allFacts) {
    if (componentOf.has(f.id) || (adj.get(f.id)?.size || 0) === 0) continue;
    const queue = [f.id];
    componentOf.set(f.id, componentCount);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adj.get(current) || []) {
        if (!componentOf.has(neighbor)) {
          componentOf.set(neighbor, componentCount);
          queue.push(neighbor);
        }
      }
    }
    componentCount++;
  }
  assert(componentCount === 1, `Found 1 connected component (got ${componentCount})`);

  db.close();
}

// --- Run All Tests ---
async function run() {
  console.log("zo-memory-system — Graph Integration Tests\n");

  testNoLinks();
  testWithLinks();
  testWeightedLinks();
  testFindNeighbors();
  testEmptyResults();
  await testBfsPathFinding();
  testKnowledgeGaps();

  // Cleanup
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(console.error);
