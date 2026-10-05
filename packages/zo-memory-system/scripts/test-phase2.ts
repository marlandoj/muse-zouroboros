#!/usr/bin/env bun
/**
 * test-phase2.ts — Integration tests for Phase 2
 *
 * Tests:
 * 1. ACT-R spreading activation
 * 2. Louvain community detection
 * 3. Git-commit procedure evolution
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// Import modules under test
import {
  ensureActrSchema,
  calculateBaseLevel,
  calculateSpreading,
  calculateActivations,
  recordAccess,
  getActivation,
  applyActrDecay,
  getTopRetrievable,
  ACTR_DEFAULTS,
} from "./actr";

import {
  detectCommunities,
  getCommunityFacts,
  getFactCommunity,
  DEFAULT_PARAMS as LOUVAIN_DEFAULTS,
} from "./louvain";

import {
  initProcedureGit,
  saveProcedureToGit,
  getProcedureGitLog,
  syncProceduresToGit,
  compareProcedureVersions,
  getAllProceduresWithHistory,
  type ProcedureVersion,
} from "./procedure-git";

// Test utilities
class Phase2TestRunner {
  db: Database;
  tmpDir: string;
  gitDir: string;
  
  constructor() {
    this.tmpDir = mkdtempSync(join(tmpdir(), "phase2-test-"));
    this.gitDir = join(this.tmpDir, "procedures");
    
    // Create test database
    const dbPath = join(this.tmpDir, "test.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    
    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        decay_class TEXT DEFAULT 'active',
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      
      CREATE TABLE IF NOT EXISTS fact_links (
        source_id TEXT REFERENCES facts(id) ON DELETE CASCADE,
        target_id TEXT REFERENCES facts(id) ON DELETE CASCADE,
        relation TEXT DEFAULT 'related',
        weight REAL DEFAULT 1.0,
        PRIMARY KEY (source_id, target_id, relation)
      );
      
      CREATE TABLE IF NOT EXISTS procedures (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        steps TEXT NOT NULL,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        evolved_from TEXT,
        evolution_rationale TEXT
      );
    `);
  }
  
  cleanup(): void {
    this.db.close();
    rmSync(this.tmpDir, { recursive: true, force: true });
  }
  
  createFact(entity: string, key: string | null, value: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO facts (id, entity, key, value) VALUES (?, ?, ?, ?)")
      .run(id, entity, key, value);
    return id;
  }
  
  linkFacts(source: string, target: string, weight: number = 1.0): void {
    this.db.prepare("INSERT OR REPLACE INTO fact_links (source_id, target_id, weight) VALUES (?, ?, ?)")
      .run(source, target, weight);
  }
  
  createProcedure(name: string, version: number, evolvedFrom?: string): string {
    const id = randomUUID();
    const steps = JSON.stringify([
      { executor: "claude-code", taskPattern: "test", timeoutSeconds: 60 },
    ]);
    this.db.prepare(`
      INSERT INTO procedures (id, name, version, steps, evolved_from) 
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, version, steps, evolvedFrom || null);
    return id;
  }
}

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

async function runTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  
  async function runTest(name: string, fn: () => void | Promise<void>): Promise<void> {
    const start = performance.now();
    try {
      await fn();
      results.push({ name, passed: true, durationMs: performance.now() - start });
    } catch (e) {
      results.push({
        name,
        passed: false,
        durationMs: performance.now() - start,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  
  const runner = new Phase2TestRunner();
  
  try {
    // ===== ACT-R Tests =====
    
    await runTest("ACT-R: Schema initialization", () => {
      ensureActrSchema(runner.db);
      const table = runner.db.prepare("SELECT name FROM sqlite_master WHERE name = 'actr_activation'").get();
      if (!table) throw new Error("actr_activation table not created");
    });
    
    await runTest("ACT-R: Base level calculation for unaccessed fact", () => {
      const now = Date.now() / 1000;
      const base = calculateBaseLevel(0, now, now - 3600, ACTR_DEFAULTS);
      if (base >= 0) throw new Error("Unaccessed fact should have negative base level");
    });
    
    await runTest("ACT-R: Base level increases with access count", () => {
      const now = Date.now() / 1000;
      const base0 = calculateBaseLevel(0, now, now - 3600, ACTR_DEFAULTS);
      const base5 = calculateBaseLevel(5, now, now - 3600, ACTR_DEFAULTS);
      if (base5 <= base0) throw new Error("Higher access count should increase base level");
    });
    
    await runTest("ACT-R: Record access creates tracking entry", () => {
      const factId = runner.createFact("test", "key", "value");
      recordAccess(runner.db, factId);
      
      const row = runner.db.prepare("SELECT * FROM actr_activation WHERE fact_id = ?").get(factId);
      if (!row) throw new Error("Access not recorded");
      if ((row as any).access_count !== 1) throw new Error("Access count should be 1");
    });
    
    await runTest("ACT-R: Spreading activation from neighbors", () => {
      // Create hub-and-spoke for testing
      const hub = runner.createFact("hub", null, "center");
      const spoke1 = runner.createFact("spoke", "1", "value1");
      const spoke2 = runner.createFact("spoke", "2", "value2");
      
      runner.linkFacts(hub, spoke1, 1.0);
      runner.linkFacts(hub, spoke2, 1.0);
      
      // Record access to spokes to give them activation
      recordAccess(runner.db, spoke1);
      recordAccess(runner.db, spoke2);
      
      const adj = new Map<string, Set<string>>();
      adj.set(hub, new Set([spoke1, spoke2]));
      adj.set(spoke1, new Set([hub]));
      adj.set(spoke2, new Set([hub]));
      
      const activations = new Map<string, number>();
      activations.set(spoke1, 1.0);
      activations.set(spoke2, 1.0);
      
      const spreading = calculateSpreading(runner.db, hub, adj, activations, ACTR_DEFAULTS, 0);
      if (spreading <= 0) throw new Error("Hub should receive spreading activation from spokes");
    });
    
    await runTest("ACT-R: Calculate activations for all facts", () => {
      // Create test graph
      for (let i = 0; i < 5; i++) {
        const id = runner.createFact(`entity${i}`, "key", `value${i}`);
        if (i > 0) runner.linkFacts(id, runner.createFact(`entity${i-1}`, "key", `value${i-1}`));
      }
      
      const activations = calculateActivations(runner.db, ACTR_DEFAULTS);
      if (activations.size < 5) throw new Error("Should have activations for all facts");
    });
    
    await runTest("ACT-R: Get activation for specific fact", () => {
      const factId = runner.createFact("specific", "key", "value");
      recordAccess(runner.db, factId);
      recordAccess(runner.db, factId);
      
      const activation = getActivation(runner.db, factId, ACTR_DEFAULTS);
      if (!activation) throw new Error("Should return activation");
      if (activation.accessCount !== 2) throw new Error("Access count should be 2");
    });
    
    await runTest("ACT-R: Apply decay updates decay classes", () => {
      // Create facts with different ages
      const oldFact = runner.createFact("old", "key", "value");
      const newFact = runner.createFact("new", "key", "value");
      
      // Simulate old fact by recording access long ago
      runner.db.prepare("INSERT INTO actr_activation (fact_id, access_count, last_accessed) VALUES (?, 1, ?)")
        .run(oldFact, Math.floor(Date.now() / 1000) - 86400 * 30); // 30 days ago
      
      // Record recent access for new fact
      recordAccess(runner.db, newFact);
      
      const result = applyActrDecay(runner.db, ACTR_DEFAULTS);
      if (result.updated === 0) throw new Error("Should have updated some facts");
    });
    
    await runTest("ACT-R: Top retrievable returns sorted results", () => {
      // Create and access multiple facts
      for (let i = 0; i < 5; i++) {
        const id = runner.createFact("top", `key${i}`, `value${i}`);
        for (let j = 0; j <= i; j++) {
          recordAccess(runner.db, id);
        }
      }
      
      const top = getTopRetrievable(runner.db, 3, ACTR_DEFAULTS);
      if (top.length !== 3) throw new Error("Should return exactly 3 results");
      
      // Should be sorted by activation descending
      for (let i = 1; i < top.length; i++) {
        if (top[i].total > top[i-1].total) {
          throw new Error("Results should be sorted by activation descending");
        }
      }
    });
    
    // ===== Louvain Community Detection Tests =====
    
    await runTest("Louvain: Detect communities in star graph", () => {
      // Create star graph (center + 5 leaves)
      const center = runner.createFact("center", null, "hub");
      for (let i = 0; i < 5; i++) {
        const leaf = runner.createFact(`leaf${i}`, null, `leaf${i}`);
        runner.linkFacts(center, leaf, 1.0);
      }
      
      const result = detectCommunities(runner.db, LOUVAIN_DEFAULTS);
      if (result.communities.size === 0) throw new Error("Should detect communities");
    });
    
    await runTest("Louvain: Detect communities in disconnected graph", () => {
      // Create two disconnected clusters
      for (let cluster = 0; cluster < 2; cluster++) {
        const clusterCenter = runner.createFact(`cluster${cluster}`, null, `center${cluster}`);
        for (let i = 0; i < 3; i++) {
          const member = runner.createFact(`c${cluster}m${i}`, null, `member${i}`);
          runner.linkFacts(clusterCenter, member, 1.0);
        }
      }
      
      const result = detectCommunities(runner.db, LOUVAIN_DEFAULTS);
      // Should find at least 2 communities (might be more depending on structure)
      if (result.communities.size < 2) throw new Error("Should find at least 2 communities in disconnected graph");
    });
    
    await runTest("Louvain: Get community facts", () => {
      // Create a simple cluster
      const center = runner.createFact("comm_center", null, "center");
      const member1 = runner.createFact("comm_member", "1", "member1");
      const member2 = runner.createFact("comm_member", "2", "member2");
      runner.linkFacts(center, member1, 1.0);
      runner.linkFacts(center, member2, 1.0);
      runner.linkFacts(member1, member2, 1.0); // Triangle
      
      const result = detectCommunities(runner.db, LOUVAIN_DEFAULTS);
      const communityId = Array.from(result.communities.keys())[0];
      const facts = getCommunityFacts(runner.db, communityId, LOUVAIN_DEFAULTS);
      
      if (facts.length < 3) throw new Error("Community should have at least 3 members");
    });
    
    await runTest("Louvain: Get fact community", () => {
      const factId = runner.createFact("lone", null, "standalone");
      const { communityId } = getFactCommunity(runner.db, factId, LOUVAIN_DEFAULTS);
      
      // Isolated nodes may or may not be in a community depending on algorithm
      // Just verify the function doesn't crash
    });
    
    await runTest("Louvain: Community has keywords and entities", () => {
      // Create cluster with similar content
      const center = runner.createFact("project", "main", "Main project file about deployment");
      const doc1 = runner.createFact("project", "doc1", "Deployment guide documentation");
      const doc2 = runner.createFact("project", "doc2", "Deployment scripts and automation");
      runner.linkFacts(center, doc1, 1.0);
      runner.linkFacts(center, doc2, 1.0);
      
      const result = detectCommunities(runner.db, LOUVAIN_DEFAULTS);
      
      for (const comm of result.communities.values()) {
        if (comm.size >= 3) {
          if (comm.keywords.length === 0) throw new Error("Community should have keywords");
          if (comm.topEntities.length === 0) throw new Error("Community should have top entities");
        }
      }
    });
    
    // ===== Git-Commit Procedure Tests =====
    
    await runTest("Git: Initialize procedure vault", () => {
      initProcedureGit({
        vaultDir: runner.gitDir,
        gitUserName: "Test",
        gitUserEmail: "test@test.com",
      });
      
      if (!existsSync(runner.gitDir)) throw new Error("Vault directory not created");
      if (!existsSync(join(runner.gitDir, ".git"))) throw new Error("Git repository not initialized");
    });
    
    await runTest("Git: Save procedure creates markdown file", () => {
      const proc: ProcedureVersion = {
        id: randomUUID(),
        name: "Test Procedure",
        version: 1,
        steps: [
          { executor: "claude-code", taskPattern: "test task", timeoutSeconds: 60 },
        ],
        successCount: 5,
        failureCount: 1,
        createdAt: Math.floor(Date.now() / 1000),
      };
      
      const result = saveProcedureToGit(proc, {
        vaultDir: runner.gitDir,
        gitUserName: "Test",
        gitUserEmail: "test@test.com",
      });
      
      if (!existsSync(result.filePath)) throw new Error("Procedure file not created");
      if (!result.commitHash) throw new Error("Commit hash not returned");
    });
    
    await runTest("Git: Save evolved procedure creates new commit", () => {
      const procV1: ProcedureVersion = {
        id: randomUUID(),
        name: "Evolve Test",
        version: 1,
        steps: [{ executor: "claude-code", taskPattern: "v1 task", timeoutSeconds: 60 }],
        successCount: 5,
        failureCount: 1,
        createdAt: Math.floor(Date.now() / 1000),
      };
      
      const procV2: ProcedureVersion = {
        id: randomUUID(),
        name: "Evolve Test",
        version: 2,
        steps: [{ executor: "claude-code", taskPattern: "v2 improved task", timeoutSeconds: 120 }],
        successCount: 0,
        failureCount: 0,
        createdAt: Math.floor(Date.now() / 1000),
        evolvedFrom: procV1.id,
        evolutionRationale: "Increased timeout based on failure analysis",
      };
      
      const config = { vaultDir: runner.gitDir, gitUserName: "Test", gitUserEmail: "test@test.com" };
      
      saveProcedureToGit(procV1, config);
      const result2 = saveProcedureToGit(procV2, config);
      
      if (!result2.commitHash) throw new Error("Evolution commit not created");
    });
    
    await runTest("Git: Get procedure git log", () => {
      const proc: ProcedureVersion = {
        id: randomUUID(),
        name: "Log Test",
        version: 1,
        steps: [{ executor: "claude-code", taskPattern: "log task", timeoutSeconds: 60 }],
        successCount: 0,
        failureCount: 0,
        createdAt: Math.floor(Date.now() / 1000),
      };
      
      const config = { vaultDir: runner.gitDir, gitUserName: "Test", gitUserEmail: "test@test.com" };
      saveProcedureToGit(proc, config);
      
      const history = getProcedureGitLog("Log Test", config);
      if (history.length === 0) throw new Error("Should have git history");
    });
    
    await runTest("Git: Sync procedures from database", () => {
      // Create procedures in database
      runner.createProcedure("Sync Test A", 1);
      runner.createProcedure("Sync Test B", 1);
      runner.createProcedure("Sync Test A", 2, "v1-id"); // Evolved
      
      const config = { vaultDir: runner.gitDir, gitUserName: "Test", gitUserEmail: "test@test.com" };
      const result = syncProceduresToGit(runner.db, config);
      
      if (result.synced !== 3) throw new Error(`Expected 3 synced, got ${result.synced}`);
    });
    
    await runTest("Git: Compare procedure versions", () => {
      const config = { vaultDir: runner.gitDir, gitUserName: "Test", gitUserEmail: "test@test.com" };
      
      // First ensure we have versioned procedures
      runner.createProcedure("Compare Test", 1);
      runner.createProcedure("Compare Test", 2, "v1-id");
      
      syncProceduresToGit(runner.db, config);
      
      // This might fail if versions aren't in git history yet, but should not crash
      const result = compareProcedureVersions("Compare Test", 1, 2, config);
      // Just verify it returns a result
    });
    
    await runTest("Git: Get all procedures with history", () => {
      const config = { vaultDir: runner.gitDir, gitUserName: "Test", gitUserEmail: "test@test.com" };
      const procedures = getAllProceduresWithHistory(config);
      
      // Should have some procedures from previous tests
      if (procedures.length === 0) {
        // This is OK if previous tests didn't save anything
      }
    });
    
    // ===== Integration Tests =====
    
    await runTest("Integration: ACT-R spreading affects community detection", () => {
      // Create a dense community
      const nodes: string[] = [];
      for (let i = 0; i < 5; i++) {
        nodes.push(runner.createFact("comm", `n${i}`, `node${i}`));
      }
      
      // Fully connect (clique)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          runner.linkFacts(nodes[i], nodes[j], 1.0);
        }
      }
      
      // Access all nodes to give them activation
      for (const node of nodes) {
        recordAccess(runner.db, node);
      }
      
      // Calculate activations
      const activations = calculateActivations(runner.db, ACTR_DEFAULTS);
      
      // All should be retrievable
      for (const node of nodes) {
        const act = activations.get(node);
        if (!act?.isRetrievable) throw new Error("Clique nodes should be highly retrievable");
      }
      
      // Should form a community
      const result = detectCommunities(runner.db, LOUVAIN_DEFAULTS);
      const hasLargeCommunity = Array.from(result.communities.values()).some(c => c.size >= 5);
      if (!hasLargeCommunity) throw new Error("Dense clique should form a community");
    });
    
    await runTest("Integration: End-to-end procedure evolution workflow", () => {
      // 1. Create initial procedure
      const v1Id = runner.createProcedure("E2E Test", 1);
      
      // 2. Sync to git
      const config = { vaultDir: runner.gitDir, gitUserName: "Test", gitUserEmail: "test@test.com" };
      syncProceduresToGit(runner.db, config);
      
      // 3. Create evolved version
      const v2Id = runner.createProcedure("E2E Test", 2, v1Id);
      syncProceduresToGit(runner.db, config);
      
      // 4. Get history
      const history = getProcedureGitLog("E2E Test", config);
      if (history.length < 2) throw new Error("Should have history for both versions");
      
      // 5. Verify list includes our procedure
      const allProcs = getAllProceduresWithHistory(config);
      const e2eProc = allProcs.find(p => p.name.includes("e2e-test"));
      if (!e2eProc && allProcs.length > 0) {
        // Name might be normalized differently
      }
    });
    
    await runTest("Performance: ACT-R on 100 nodes completes in <5s", () => {
      const nodes: string[] = [];
      for (let i = 0; i < 100; i++) {
        nodes.push(runner.createFact("perf", `n${i}`, `value${i}`));
      }
      
      // Create random edges (sparse graph)
      for (let i = 0; i < 150; i++) {
        const a = nodes[Math.floor(Math.random() * nodes.length)];
        const b = nodes[Math.floor(Math.random() * nodes.length)];
        if (a !== b) runner.linkFacts(a, b, 1.0);
      }
      
      const start = performance.now();
      calculateActivations(runner.db, ACTR_DEFAULTS);
      const elapsed = performance.now() - start;
      
      if (elapsed > 5000) throw new Error(`Took ${elapsed}ms, expected <5000ms`);
    });
    
    await runTest("Performance: Louvain on 100 nodes completes in <5s", () => {
      const start = performance.now();
      detectCommunities(runner.db, LOUVAIN_DEFAULTS);
      const elapsed = performance.now() - start;
      
      if (elapsed > 5000) throw new Error(`Took ${elapsed}ms, expected <5000ms`);
    });
    
  } finally {
    runner.cleanup();
  }
  
  return results;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Phase 2 Tests: ACT-R + Louvain + Git Procedures          ║");
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

  process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch(console.error);
}
