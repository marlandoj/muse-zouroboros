#!/usr/bin/env bun
/**
 * test-phase3.ts — Integration tests for Phase 3: Unified Decay System
 *
 * Tests:
 * 1. Unified activation calculation (B_i + S_i + P_i)
 * 2. ACT-R + Tarjan + 5-tier integration
 * 3. Retrievability threshold filtering
 * 4. Protection boost for articulation points
 * 5. Decay class rate mapping
 * 6. Performance benchmarks
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  calculateUnifiedActivation,
  runUnifiedDecay,
  getTopByUnifiedActivation,
  getProtectedFacts,
  recordAccessWithDecay,
  ensureUnifiedSchema,
  UNIFIED_DEFAULTS,
} from "./unified-decay";
import { buildAdjacencyList, findArticulationPoints } from "./tarjan";

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

class TestRunner {
  private results: TestResult[] = [];
  private db: Database;
  private tempDir: string;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), "zo-unified-test-"));
    const dbPath = join(this.tempDir, "test.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        decay_class TEXT DEFAULT 'active',
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER DEFAULT (strftime('%s','now')),
        created_at INTEGER DEFAULT (strftime('%s','now')),
        importance REAL DEFAULT 0.6
      );

      CREATE TABLE fact_links (
        source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'related',
        weight REAL DEFAULT 1.0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (source_id, target_id, relation)
      );
    `);
  }

  createFact(entity: string, key: string | null, value: string, decayClass = "active", accessCount = 0): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO facts (id, entity, key, value, decay_class, access_count, last_accessed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now') - ?)
    `).run(id, entity, key, value, decayClass, accessCount, accessCount * 86400);
    return id;
  }

  linkFacts(sourceId: string, targetId: string, weight = 1.0) {
    this.db.prepare(`
      INSERT OR REPLACE INTO fact_links (source_id, target_id, relation, weight)
      VALUES (?, ?, 'related', ?)
    `).run(sourceId, targetId, weight);
  }

  async runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
    const start = performance.now();
    try {
      await fn();
      this.results.push({ name, passed: true, durationMs: performance.now() - start });
    } catch (error) {
      this.results.push({
        name,
        passed: false,
        durationMs: performance.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  resetDb() {
    this.db.exec("DELETE FROM fact_links");
    this.db.exec("DELETE FROM facts");
    const hasTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unified_activation'").get();
    if (hasTable) this.db.exec("DELETE FROM unified_activation");
  }

  cleanup() {
    this.db.close();
    rmSync(this.tempDir, { recursive: true, force: true });
  }

  getResults(): TestResult[] {
    return this.results;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Phase 3 Tests: Unified Decay System (ACT-R + Tarjan)     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const runner = new TestRunner();

  // Test 1: Basic unified activation calculation
  await runner.runTest("Unified activation: A_i = B_i + S_i + P_i", () => {
    const fact = runner.createFact("test.entity", "key1", "Test value", "active", 5);
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    const result = calculateUnifiedActivation(runner["db"], fact, adj, aps, UNIFIED_DEFAULTS);
    if (!result) throw new Error("Failed to calculate activation");
    
    // Check formula: A_i = B_i + S_i + P_i
    const expectedTotal = result.baseLevel + result.spreading + result.protection;
    if (Math.abs(result.total - expectedTotal) > 0.001) {
      throw new Error(`Formula mismatch: ${result.total} != ${expectedTotal}`);
    }
    
    // Should have base level > 0 (accessed 5 times)
    if (result.baseLevel <= 0) throw new Error("Base level should be positive");
  });

  // Test 2: Permanent facts have high base level
  await runner.runTest("Permanent facts have high base level (no decay)", () => {
    const permanent = runner.createFact("identity", "name", "Critical identity", "permanent", 1);
    const normal = runner.createFact("regular", "data", "Regular data", "active", 1);
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    const permResult = calculateUnifiedActivation(runner["db"], permanent, adj, aps, UNIFIED_DEFAULTS);
    const normalResult = calculateUnifiedActivation(runner["db"], normal, adj, aps, UNIFIED_DEFAULTS);
    
    if (!permResult || !normalResult) throw new Error("Failed to calculate");
    
    // Permanent should have base level of 10.0 (effectively infinite)
    if (permResult.baseLevel < 9.0) {
      throw new Error(`Permanent base level too low: ${permResult.baseLevel}`);
    }
    
    // Normal should have lower base level
    if (normalResult.baseLevel >= permResult.baseLevel) {
      throw new Error("Permanent should have higher base level than active");
    }
  });

  // Test 3: Articulation points get protection boost
  await runner.runTest("Articulation points receive protection boost", () => {
    // Create star graph: center is articulation point
    const center = runner.createFact("hub", "center", "Hub node");
    const leaves: string[] = [];
    for (let i = 0; i < 3; i++) {
      leaves.push(runner.createFact("leaf", `leaf${i}`, `Leaf ${i}`));
      runner.linkFacts(center, leaves[i]);
    }
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    // Center should be articulation point
    if (!aps.has(center)) throw new Error("Center should be articulation point");
    
    const centerResult = calculateUnifiedActivation(runner["db"], center, adj, aps, UNIFIED_DEFAULTS);
    const leafResult = calculateUnifiedActivation(runner["db"], leaves[0], adj, aps, UNIFIED_DEFAULTS);
    
    if (!centerResult || !leafResult) throw new Error("Failed to calculate");
    
    // Center should have protection boost
    if (centerResult.protection <= 0) throw new Error("Center should have protection boost");
    
    // Leaves should not have protection
    if (leafResult.protection !== 0) throw new Error("Leaf should not have protection boost");
    
    // Center should be marked as articulation point
    if (!centerResult.isArticulationPoint) throw new Error("Center should be marked as AP");
  });

  // Test 4: Spreading activation from neighbors
  await runner.runTest("Spreading activation propagates from neighbors", () => {
    const hub = runner.createFact("hub", "center", "Hub", "active", 10);
    const spoke = runner.createFact("spoke", "node", "Spoke", "active", 0);
    
    runner.linkFacts(hub, spoke);
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    const hubResult = calculateUnifiedActivation(runner["db"], hub, adj, aps, UNIFIED_DEFAULTS);
    const spokeResult = calculateUnifiedActivation(runner["db"], spoke, adj, aps, UNIFIED_DEFAULTS);
    
    if (!hubResult || !spokeResult) throw new Error("Failed to calculate");
    
    // Hub has high activation (accessed 10 times)
    if (hubResult.baseLevel <= 0) throw new Error("Hub should have positive base level");
    
    // Spoke should have spreading activation from hub
    if (spokeResult.spreading <= 0) throw new Error("Spoke should have spreading activation");
  });

  // Test 5: Retrievability threshold filtering
  await runner.runTest("Retrievability threshold filters correctly", () => {
    // Create facts with varying activation levels
    const highAccess = runner.createFact("high", "key", "High access", "active", 20);
    const lowAccess = runner.createFact("low", "key", "Low access", "active", 0);
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    const highResult = calculateUnifiedActivation(runner["db"], highAccess, adj, aps, UNIFIED_DEFAULTS);
    const lowResult = calculateUnifiedActivation(runner["db"], lowAccess, adj, aps, UNIFIED_DEFAULTS);
    
    if (!highResult || !lowResult) throw new Error("Failed to calculate");
    
    // High access should be retrievable
    if (!highResult.isRetrievable) throw new Error("High access should be retrievable");
    
    // Low access may or may not be retrievable depending on threshold
    // Just verify the flag is set consistently
    if (lowResult.isRetrievable && lowResult.total < UNIFIED_DEFAULTS.retrievalThreshold) {
      throw new Error("Retrievable flag inconsistent with threshold");
    }
  });

  // Test 6: Decay class rate mapping
  await runner.runTest("Decay class rate mapping correct", () => {
    const checkpoint = runner.createFact("test", "cp", "Checkpoint", "checkpoint", 5);
    const session = runner.createFact("test", "sess", "Session", "session", 5);
    const active = runner.createFact("test", "act", "Active", "active", 5);
    const stable = runner.createFact("test", "stab", "Stable", "stable", 5);
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    const cpResult = calculateUnifiedActivation(runner["db"], checkpoint, adj, aps, UNIFIED_DEFAULTS);
    const sessResult = calculateUnifiedActivation(runner["db"], session, adj, aps, UNIFIED_DEFAULTS);
    const actResult = calculateUnifiedActivation(runner["db"], active, adj, aps, UNIFIED_DEFAULTS);
    const stabResult = calculateUnifiedActivation(runner["db"], stable, adj, aps, UNIFIED_DEFAULTS);
    
    if (!cpResult || !sessResult || !actResult || !stabResult) {
      throw new Error("Failed to calculate");
    }
    
    // Higher decay rate = lower base level (same access count)
    // checkpoint (0.9) < session (0.7) < active (0.5) < stable (0.3)
    if (cpResult.baseLevel >= sessResult.baseLevel) {
      throw new Error("Checkpoint should have lower base than session");
    }
    if (sessResult.baseLevel >= actResult.baseLevel) {
      throw new Error("Session should have lower base than active");
    }
    if (actResult.baseLevel >= stabResult.baseLevel) {
      throw new Error("Active should have lower base than stable");
    }
  });

  // Test 7: Run unified decay for all facts
  runner.resetDb();
  await runner.runTest("Run unified decay for all facts", () => {
    // Create test facts
    for (let i = 0; i < 10; i++) {
      runner.createFact("test", `fact${i}`, `Test fact ${i}`, "active", i);
    }
    
    const { results, stats } = runUnifiedDecay(runner["db"]);
    
    if (results.length !== 10) throw new Error(`Expected 10 results, got ${results.length}`);
    if (stats.total !== 10) throw new Error(`Expected total 10, got ${stats.total}`);
    
    // Verify results are stored in database
    const count = runner["db"].prepare("SELECT COUNT(*) as count FROM unified_activation").get() as { count: number };
    if (count.count !== 10) throw new Error(`Expected 10 rows in table, got ${count.count}`);
  });

  // Test 8: Get top facts by activation
  runner.resetDb();
  await runner.runTest("Get top facts by activation", () => {
    // Create facts with different access counts
    const low = runner.createFact("test", "low", "Low", "active", 1);
    const high = runner.createFact("test", "high", "High", "active", 100);
    
    runUnifiedDecay(runner["db"]);
    
    const top = getTopByUnifiedActivation(runner["db"], 5, false);
    
    if (top.length < 2) throw new Error("Should have at least 2 facts");
    
    // High should be before low
    const highIndex = top.findIndex(f => f.factId === high);
    const lowIndex = top.findIndex(f => f.factId === low);
    
    if (highIndex === -1 || lowIndex === -1) throw new Error("Both facts should be in results");
    if (highIndex >= lowIndex) throw new Error("High should be ranked before low");
  });

  // Test 9: Get protected facts
  await runner.runTest("Get protected facts (articulation points)", () => {
    // Create star graph
    const center = runner.createFact("hub", "center", "Hub");
    for (let i = 0; i < 3; i++) {
      const leaf = runner.createFact("leaf", `leaf${i}`, `Leaf ${i}`);
      runner.linkFacts(center, leaf);
    }
    
    runUnifiedDecay(runner["db"]);
    
    const protected_ = getProtectedFacts(runner["db"]);
    
    // Should find at least the center
    if (protected_.length === 0) throw new Error("Should have at least one protected fact");
    
    // Center should be in protected list
    const centerProtected = protected_.find(f => f.factId === center);
    if (!centerProtected) throw new Error("Center should be in protected list");
    if (!centerProtected.isArticulationPoint) throw new Error("Should be marked as AP");
  });

  // Test 10: Record access updates activation
  await runner.runTest("Record access updates activation", () => {
    const fact = runner.createFact("test", "record", "Record test", "active", 0);
    
    runUnifiedDecay(runner["db"]);
    
    const before = runner["db"].prepare("SELECT total FROM unified_activation WHERE fact_id = ?").get(fact) as { total: number };
    
    // Record access
    recordAccessWithDecay(runner["db"], fact);
    
    const after = runner["db"].prepare("SELECT total FROM unified_activation WHERE fact_id = ?").get(fact) as { total: number };
    
    // Activation should have increased (access count increased)
    if (after.total <= before.total) {
      throw new Error("Activation should increase after access");
    }
  });

  // Test 11: Unified schema ensures tables exist
  await runner.runTest("Unified schema ensures tables exist", () => {
    ensureUnifiedSchema(runner["db"]);
    
    const tables = runner["db"].prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='unified_activation'
    `).get() as { name: string } | null;
    
    if (!tables) throw new Error("unified_activation table should exist");
  });

  // Test 12: Priority calculation (sigmoid normalization)
  await runner.runTest("Priority is normalized 0-1 via sigmoid", () => {
    const fact = runner.createFact("test", "prio", "Priority test", "active", 10);
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    const result = calculateUnifiedActivation(runner["db"], fact, adj, aps, UNIFIED_DEFAULTS);
    if (!result) throw new Error("Failed to calculate");
    
    // Priority should be between 0 and 1
    if (result.priority < 0 || result.priority > 1) {
      throw new Error(`Priority out of range: ${result.priority}`);
    }
    
    // Higher activation = higher priority (sigmoid is monotonic)
    const highFact = runner.createFact("test", "highPrio", "High priority", "active", 100);
    const highResult = calculateUnifiedActivation(runner["db"], highFact, adj, aps, UNIFIED_DEFAULTS);
    if (!highResult) throw new Error("Failed to calculate");
    
    if (highResult.priority <= result.priority) {
      throw new Error("Higher activation should give higher priority");
    }
  });

  // Test 13: Complex graph with multiple articulation points
  await runner.runTest("Complex graph: multiple articulation points", () => {
    // Create graph: A - B - C - D (B and C are articulation points)
    const a = runner.createFact("chain", "a", "Node A");
    const b = runner.createFact("chain", "b", "Node B");
    const c = runner.createFact("chain", "c", "Node C");
    const d = runner.createFact("chain", "d", "Node D");
    
    runner.linkFacts(a, b);
    runner.linkFacts(b, c);
    runner.linkFacts(c, d);
    
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    
    // B and C should be articulation points
    if (!aps.has(b)) throw new Error("B should be articulation point");
    if (!aps.has(c)) throw new Error("C should be articulation point");
    
    // A and D should not be
    if (aps.has(a)) throw new Error("A should not be articulation point");
    if (aps.has(d)) throw new Error("D should not be articulation point");
  });

  // Test 14: Empty graph handling
  runner.resetDb();
  await runner.runTest("Empty graph returns empty results", () => {
    const { results, stats } = runUnifiedDecay(runner["db"]);
    
    if (results.length !== 0) throw new Error("Should have no results for empty graph");
    if (stats.total !== 0) throw new Error("Stats should show 0 facts");
  });

  // Performance benchmark
  await runner.runTest("Performance: 100 facts in <5s", () => {
    const start = performance.now();
    
    // Create 100 facts
    for (let i = 0; i < 100; i++) {
      runner.createFact("perf", `fact${i}`, `Performance test fact ${i}`, "active", Math.floor(Math.random() * 10));
    }
    
    // Add some random links
    const factIds = runner["db"].prepare("SELECT id FROM facts WHERE entity = 'perf'").all() as Array<{ id: string }>;
    for (let i = 0; i < 50; i++) {
      const source = factIds[Math.floor(Math.random() * factIds.length)].id;
      const target = factIds[Math.floor(Math.random() * factIds.length)].id;
      if (source !== target) {
        runner.linkFacts(source, target);
      }
    }
    
    runUnifiedDecay(runner["db"]);
    
    const duration = performance.now() - start;
    if (duration > 5000) throw new Error(`Too slow: ${duration.toFixed(0)}ms > 5000ms`);
  });

  // Print results
  const results = runner.getResults();
  let passed = 0, failed = 0;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

  for (const result of results) {
    if (result.passed) {
      passed++;
      console.log(`✅ ${result.name} (${result.durationMs.toFixed(0)}ms)`);
    } else {
      failed++;
      console.log(`\n❌ ${result.name} (${result.durationMs.toFixed(0)}ms)`);
      console.log(`   Error: ${result.error}`);
    }
  }

  console.log("\n" + "═".repeat(64));
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
  console.log(`Duration: ${totalTime.toFixed(0)}ms`);
  console.log("═".repeat(64));

  runner.cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch(console.error);
}
