#!/usr/bin/env bun
/**
 * test-tarjan.ts — Unit and integration tests for Tarjan's articulation point detection
 *
 * Tests:
 * 1. Core algorithm correctness on known graph structures
 * 2. Open loop protection integration
 * 3. Edge cases (empty graph, single node, disconnected components)
 * 4. Performance benchmarks
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildAdjacencyList,
  findArticulationPoints,
  isArticulationPoint,
  getArticulationPointDetails,
  getEntityArticulationPoints,
} from "./tarjan";
import {
  checkArticulationPointsForOpenLoop,
  getCriticalOpenLoops,
  protectArticulationPointLoops,
  upsertOpenLoop,
  ensureContinuationSchema,
} from "./continuation";

// Test configuration
const TEST_TIMEOUT_MS = 30000;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

class TestRunner {
  private results: TestResult[] = [];
  private db: Database;
  private tempDir: string;

  constructor() {
    this.tempDir = mkdtempSync(join(tmpdir(), "tarjan-test-"));
    const dbPath = join(this.tempDir, "test.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    // Initialize facts table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        persona TEXT NOT NULL DEFAULT 'shared',
        entity TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'fact',
        decay_class TEXT DEFAULT 'active',
        importance REAL DEFAULT 0.5,
        confidence REAL DEFAULT 0.8,
        source TEXT,
        metadata TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        expires_at INTEGER,
        last_accessed INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        entity UNINDEXED,
        key UNINDEXED,
        value
      );
    `);

    // Initialize fact_links table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fact_links (
        source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'related',
        weight REAL DEFAULT 1.0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (source_id, target_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
      CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);
    `);

    ensureContinuationSchema(this.db);
  }

  async runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
    const start = performance.now();
    try {
      await fn();
      this.results.push({
        name,
        passed: true,
        durationMs: performance.now() - start,
      });
    } catch (error) {
      this.results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: performance.now() - start,
      });
    }
  }

  cleanup(): void {
    this.db.close();
    rmSync(this.tempDir, { recursive: true });
  }

  getResults(): TestResult[] {
    return this.results;
  }

  // Helper: Create a test fact
  createFact(entity: string, key: string | null, value: string): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO facts (id, entity, key, value) VALUES (?, ?, ?, ?)
    `).run(id, entity, key, value);
    this.db.prepare(`INSERT INTO facts_fts (rowid, entity, key, value) VALUES (?, ?, ?, ?)`)
      .run((this.db.prepare("SELECT rowid FROM facts WHERE id = ?").get(id) as { rowid: number }).rowid, entity, key || "", value);
    return id;
  }

  // Helper: Create a link between facts
  linkFacts(sourceId: string, targetId: string, relation: string = "related"): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO fact_links (source_id, target_id, relation, weight)
      VALUES (?, ?, ?, 1.0)
    `).run(sourceId, targetId, relation);
  }

  // Helper: Create a simple line graph (no articulation points except endpoints)
  createLineGraph(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(this.createFact("test", `node${i}`, `Node ${i}`));
    }
    for (let i = 0; i < n - 1; i++) {
      this.linkFacts(ids[i], ids[i + 1]);
    }
    return ids;
  }

  // Helper: Create a star graph (center is articulation point)
  createStarGraph(centerLabel: string, leafCount: number): { center: string; leaves: string[] } {
    const center = this.createFact("test", centerLabel, `Center ${centerLabel}`);
    const leaves: string[] = [];
    for (let i = 0; i < leafCount; i++) {
      const leaf = this.createFact("test", `leaf${i}`, `Leaf ${i}`);
      this.linkFacts(center, leaf);
      leaves.push(leaf);
    }
    return { center, leaves };
  }

  // Helper: Create a cycle graph (no articulation points)
  createCycleGraph(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(this.createFact("test", `cycle${i}`, `Cycle node ${i}`));
    }
    for (let i = 0; i < n; i++) {
      this.linkFacts(ids[i], ids[(i + 1) % n]);
    }
    return ids;
  }

  // Helper: Create two cycles connected by a bridge (bridge nodes are articulation points)
  createBridgeGraph(): { cycle1: string[]; cycle2: string[]; bridge1: string; bridge2: string } {
    const cycle1 = this.createCycleGraph(3);
    const cycle2 = this.createCycleGraph(3);
    const bridge1 = this.createFact("test", "bridge1", "Bridge node 1");
    const bridge2 = this.createFact("test", "bridge2", "Bridge node 2");

    // Connect cycle1 to bridge1
    this.linkFacts(cycle1[0], bridge1);
    // Connect bridge1 to bridge2
    this.linkFacts(bridge1, bridge2);
    // Connect bridge2 to cycle2
    this.linkFacts(bridge2, cycle2[0]);

    return { cycle1, cycle2, bridge1, bridge2 };
  }
}

// Test cases
async function runTests(): Promise<TestResult[]> {
  const runner = new TestRunner();

  console.log("Running Tarjan Algorithm Tests...\n");

  // Test 1: Empty graph
  await runner.runTest("Empty graph has no articulation points", () => {
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    if (aps.size !== 0) throw new Error(`Expected 0 articulation points, got ${aps.size}`);
  });

  // Test 2: Single node
  await runner.runTest("Single node is not an articulation point", () => {
    const id = runner.createFact("test", "single", "Single node");
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    if (aps.has(id)) throw new Error("Single node should not be an articulation point");
  });

  // Test 3: Two connected nodes (neither is articulation point in 2-node graph)
  await runner.runTest("Two-node graph has no articulation points", () => {
    const id1 = runner.createFact("test", "node1", "Node 1");
    const id2 = runner.createFact("test", "node2", "Node 2");
    runner.linkFacts(id1, id2);
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);
    if (aps.size !== 0) throw new Error(`Expected 0 articulation points in 2-node graph, got ${aps.size}`);
  });

  // Test 4: Line graph (internal nodes are articulation points)
  await runner.runTest("Line graph: internal nodes are articulation points", () => {
    const ids = runner.createLineGraph(5);
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    // Internal nodes (1, 2, 3) should be articulation points
    // Endpoints (0, 4) should NOT be articulation points
    for (let i = 1; i <= 3; i++) {
      if (!aps.has(ids[i])) throw new Error(`Internal node ${i} should be articulation point`);
    }
    if (aps.has(ids[0])) throw new Error("Endpoint 0 should not be articulation point");
    if (aps.has(ids[4])) throw new Error("Endpoint 4 should not be articulation point");
  });

  // Test 5: Star graph (center is articulation point)
  await runner.runTest("Star graph: center is articulation point", () => {
    const { center, leaves } = runner.createStarGraph("hub", 5);
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    if (!aps.has(center)) throw new Error("Star center should be articulation point");
    for (const leaf of leaves) {
      if (aps.has(leaf)) throw new Error("Star leaf should not be articulation point");
    }
  });

  // Test 6: Cycle graph (no articulation points)
  await runner.runTest("Cycle graph: no articulation points", () => {
    const ids = runner.createCycleGraph(5);
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    for (const id of ids) {
      if (aps.has(id)) throw new Error("Cycle node should not be articulation point");
    }
  });

  // Test 7: Bridge graph (bridge nodes are articulation points)
  await runner.runTest("Bridge graph: bridge nodes are articulation points", () => {
    const { cycle1, cycle2, bridge1, bridge2 } = runner.createBridgeGraph();
    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    // Bridge nodes should be articulation points
    if (!aps.has(bridge1)) throw new Error("Bridge node 1 should be articulation point");
    if (!aps.has(bridge2)) throw new Error("Bridge node 2 should be articulation point");

    // Cycle nodes that are NOT connected to bridges should NOT be articulation points
    // But the specific cycle nodes connected to bridges ARE articulation points
    // because they are the connection points
    for (const id of cycle1.slice(1)) {
      if (aps.has(id)) throw new Error("Non-bridge cycle1 node should not be articulation point");
    }
    for (const id of cycle2.slice(1)) {
      if (aps.has(id)) throw new Error("Non-bridge cycle2 node should not be articulation point");
    }
  });

  // Test 8: isArticulationPoint helper
  await runner.runTest("isArticulationPoint helper works correctly", () => {
    const { center, leaves } = runner.createStarGraph("hub2", 3);
    const adj = buildAdjacencyList(runner["db"]);

    if (!isArticulationPoint(center, adj)) throw new Error("Should detect center as articulation point");
    for (const leaf of leaves) {
      if (isArticulationPoint(leaf, adj)) throw new Error("Should not detect leaf as articulation point");
    }
  });

  // Test 9: getArticulationPointDetails
  await runner.runTest("getArticulationPointDetails returns correct structure", () => {
    const { center } = runner.createStarGraph("hub3", 4);
    const adj = buildAdjacencyList(runner["db"]);
    const details = getArticulationPointDetails(runner["db"], adj);

    const centerDetail = details.find(d => d.factId === center);
    if (!centerDetail) throw new Error("Center should be in articulation point details");
    if (centerDetail.bridges < 1) throw new Error("Center should bridge at least 1 component");
  });

  // Test 10: getEntityArticulationPoints
  await runner.runTest("getEntityArticulationPoints filters by entity", () => {
    runner.createStarGraph("test", 3); // entity "test" from helper
    runner.createStarGraph("test", 3); // Another star with same entity

    const entityAPs = getEntityArticulationPoints(runner["db"], "test");

    if (entityAPs.length === 0) throw new Error("Should find articulation points for entity 'test'");

    for (const ap of entityAPs) {
      if (ap.entity !== "test") throw new Error("Entity filter should only return matching entity 'test'");
    }
  });

  // Test 11: Open loop protection - articulation point
  await runner.runTest("Open loop connected to articulation point is protected", () => {
    // Create a star graph
    const { center } = runner.createStarGraph("critical", 3);

    // Create an open loop related to the articulation point entity
    const loop = upsertOpenLoop(runner["db"], {
      title: "Critical blocker task",
      summary: "This blocks critical work",
      entity: "test", // Same entity as star graph
      kind: "task",
    });

    const check = checkArticulationPointsForOpenLoop(runner["db"], loop);
    if (!check.isProtected) throw new Error("Loop connected to articulation point should be protected");
  });

  // Test 12: Open loop protection - non-articulation point
  await runner.runTest("Open loop not connected to articulation point is not protected", () => {
    // Create an isolated fact (not in graph)
    runner.createFact("isolated", "fact", "Isolated fact");

    const loop = upsertOpenLoop(runner["db"], {
      title: "Regular task",
      summary: "This is a normal task",
      entity: "isolated",
      kind: "task",
    });

    const check = checkArticulationPointsForOpenLoop(runner["db"], loop);
    if (check.isProtected) throw new Error("Loop not connected to articulation point should not be protected");
  });

  // Test 13: protectArticulationPointLoops restores stale loops
  await runner.runTest("protectArticulationPointLoops restores critical stale loops", () => {
    // Create a star graph
    const { center } = runner.createStarGraph("restore-test", 3);

    // Create an open loop
    const loop = upsertOpenLoop(runner["db"], {
      title: "Restoration test task",
      summary: "This should be restored from stale",
      entity: "test",
      kind: "task",
    });

    // Mark it as stale
    runner["db"].prepare("UPDATE open_loops SET status = 'stale' WHERE id = ?").run(loop.id);

    // Run protection
    const result = protectArticulationPointLoops(runner["db"]);

    if (result.protected === 0) throw new Error("Should have protected at least one loop");
    if (!result.details.some(d => d.loopId === loop.id)) throw new Error("Should have protected our test loop");

    // Verify status was restored
    const restored = runner["db"].prepare("SELECT status FROM open_loops WHERE id = ?").get(loop.id) as { status: string };
    if (restored.status !== "open") throw new Error("Loop should be restored to 'open' status");
  });

  // Test 14: getCriticalOpenLoops returns only critical loops
  await runner.runTest("getCriticalOpenLoops filters correctly", () => {
    // Create a star graph (articulation point)
    runner.createStarGraph("critical-entity", 3);

    // Create critical loop
    const criticalLoop = upsertOpenLoop(runner["db"], {
      title: "Critical task",
      summary: "Important blocker",
      entity: "test",
      kind: "task",
    });

    // Create non-critical loop (isolated entity)
    runner.createFact("isolated-entity", "fact", "Isolated");
    const normalLoop = upsertOpenLoop(runner["db"], {
      title: "Normal task",
      summary: "Regular work",
      entity: "isolated-entity",
      kind: "task",
    });

    const criticalLoops = getCriticalOpenLoops(runner["db"]);

    const hasCritical = criticalLoops.some(l => l.id === criticalLoop.id);
    const hasNormal = criticalLoops.some(l => l.id === normalLoop.id);

    if (!hasCritical) throw new Error("Should include critical loop");
    if (hasNormal) throw new Error("Should not include non-critical loop");
  });

  // Test 15: Disconnected components are handled correctly
  await runner.runTest("Disconnected components handled correctly", () => {
    // Create two separate star graphs (disconnected)
    const { center: center1 } = runner.createStarGraph("comp1", 3);
    const { center: center2 } = runner.createStarGraph("comp2", 3);

    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    // Both centers should be articulation points (within their components)
    if (!aps.has(center1)) throw new Error("Center of component 1 should be articulation point");
    if (!aps.has(center2)) throw new Error("Center of component 2 should be articulation point");
  });

  // Test 16: Performance - large graph
  await runner.runTest("Performance: 100-node graph completes in <1s", () => {
    const start = performance.now();

    // Create a large line graph
    runner.createLineGraph(100);

    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    const duration = performance.now() - start;
    if (duration > 1000) throw new Error(`Took ${duration.toFixed(0)}ms, expected <1000ms`);
    if (aps.size === 0) throw new Error("Should find articulation points in line graph");
  });

  // Test 17: Error handling - invalid fact ID
  await runner.runTest("Error handling: invalid fact ID returns false", () => {
    const adj = buildAdjacencyList(runner["db"]);
    const result = isArticulationPoint("nonexistent-id", adj);
    if (result !== false) throw new Error("Invalid fact ID should return false");
  });

  // Test 18: Bridges count accuracy
  await runner.runTest("Bridges count is accurate for star graph", () => {
    const leafCount = 5;
    const { center } = runner.createStarGraph("bridge-count", leafCount);

    const adj = buildAdjacencyList(runner["db"]);
    const details = getArticulationPointDetails(runner["db"], adj);

    const centerDetail = details.find(d => d.factId === center);
    if (!centerDetail) throw new Error("Center should be in details");

    // Removing star center disconnects all leaves (5 separate components)
    if (centerDetail.bridges !== leafCount) {
      throw new Error(`Expected ${leafCount} bridges, got ${centerDetail.bridges}`);
    }
  });

  // Test 19: Multiple articulation points in complex graph
  await runner.runTest("Complex graph with multiple articulation points", () => {
    // Create: Cycle1 -- AP1 -- AP2 -- Cycle2 -- AP3 -- Cycle3
    // Note: cycle1[0], cycle2[0], and cycle2[1] become articulation points
    // because they're the connection points to the bridges
    const cycle1 = runner.createCycleGraph(3);
    const cycle2 = runner.createCycleGraph(3);
    const cycle3 = runner.createCycleGraph(3);

    const ap1 = runner.createFact("bridge", "ap1", "Articulation 1");
    const ap2 = runner.createFact("bridge", "ap2", "Articulation 2");
    const ap3 = runner.createFact("bridge", "ap3", "Articulation 3");

    // These connections make the specific cycle nodes into articulation points
    runner.linkFacts(cycle1[0], ap1);  // cycle1[0] is now an articulation point
    runner.linkFacts(ap1, ap2);
    runner.linkFacts(ap2, cycle2[0]);  // cycle2[0] is now an articulation point
    runner.linkFacts(cycle2[1], ap3);  // cycle2[1] is now an articulation point
    runner.linkFacts(ap3, cycle3[0]);  // cycle3[0] is now an articulation point

    const adj = buildAdjacencyList(runner["db"]);
    const aps = findArticulationPoints(adj);

    // All three bridge nodes should be articulation points
    if (!aps.has(ap1)) throw new Error("AP1 should be articulation point");
    if (!aps.has(ap2)) throw new Error("AP2 should be articulation point");
    if (!aps.has(ap3)) throw new Error("AP3 should be articulation point");

    // The specific cycle nodes that connect to bridges ARE articulation points
    if (!aps.has(cycle1[0])) throw new Error("cycle1[0] (connects to AP1) should be articulation point");
    if (!aps.has(cycle2[0])) throw new Error("cycle2[0] (connects to AP2) should be articulation point");
    if (!aps.has(cycle2[1])) throw new Error("cycle2[1] (connects to AP3) should be articulation point");
    if (!aps.has(cycle3[0])) throw new Error("cycle3[0] (connects to AP3) should be articulation point");

    // Other cycle nodes (not connected to bridges) should NOT be articulation points
    if (aps.has(cycle1[1])) throw new Error("cycle1[1] should not be articulation point");
    if (aps.has(cycle1[2])) throw new Error("cycle1[2] should not be articulation point");
    if (aps.has(cycle2[2])) throw new Error("cycle2[2] should not be articulation point");
    if (aps.has(cycle3[1])) throw new Error("cycle3[1] should not be articulation point");
    if (aps.has(cycle3[2])) throw new Error("cycle3[2] should not be articulation point");
  });

  // Test 20: Open loop with no related facts
  await runner.runTest("Open loop with no related facts is not protected", () => {
    const loop = upsertOpenLoop(runner["db"], {
      title: "Orphan task",
      summary: "No related facts in graph",
      entity: "nonexistent-entity",
      kind: "task",
    });

    const check = checkArticulationPointsForOpenLoop(runner["db"], loop);
    if (check.isProtected) throw new Error("Orphan loop should not be protected");
  });

  runner.cleanup();
  return runner.getResults();
}

// Run tests and report
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Tarjan Algorithm + Open Loop Protection Tests            ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  const startTime = performance.now();
  const results = await runTests();
  const totalTime = performance.now() - startTime;

  let passed = 0;
  let failed = 0;

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

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch(console.error);
}
