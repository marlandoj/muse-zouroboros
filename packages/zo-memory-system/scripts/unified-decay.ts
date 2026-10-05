#!/usr/bin/env bun
/**
 * unified-decay.ts — Unified Decay System for Zouroboros Memory
 *
 * Combines three decay models into a single cohesive framework:
 *
 * 1. ACT-R Spreading Activation (from Phase 2)
 *    - Base-level activation with power-law decay
 *    - Spreading activation from linked neighbors
 *    - Fan penalty for highly connected nodes
 *
 * 2. Tarjan Articulation Point Protection (from Phase 1)
 *    - Critical blockers protected from decay
 *    - Structural bridges preserved
 *    - "This bug blocks three workstreams → must not fade"
 *
 * 3. 5-Tier Adaptive Decay (legacy compatibility)
 *    - permanent / stable / active / session / checkpoint
 *    - Migration path from simple TTL to ACT-R activation
 *
 * Unified Formula:
 *   A_i = B_i + S_i + P_i
 *   Where:
 *     A_i = Total activation (used for ranking/retrieval)
 *     B_i = Base-level activation (ACT-R power-law decay)
 *     S_i = Spreading activation from neighbors
 *     P_i = Protection boost (Tarjan articulation points)
 *
 * Decay Class Mapping:
 *   permanent   → No decay (B_i = ∞)
 *   stable      → Slow decay (d=0.3, long time constant)
 *   active      → Normal decay (d=0.5, standard ACT-R)
 *   session     → Fast decay (d=0.7, rapid forgetting)
 *   checkpoint  → Very fast decay (d=0.9, ephemeral)
 */

import { Database } from "bun:sqlite";
import { buildAdjacencyList, findArticulationPoints, getArticulationPointDetails } from "./tarjan";
import { calculateBaseLevel, calculateSpreading, ACTR_DEFAULTS } from "./actr";
import { autoResolveStaleLoops } from "./continuation";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Decay class time constants (seconds)
const DECAY_CLASS_TTL: Record<string, number | null> = {
  permanent: null,      // Never decay
  stable: 90 * 24 * 3600,    // 90 days
  active: 14 * 24 * 3600,    // 14 days
  session: 24 * 3600,        // 1 day
  checkpoint: 4 * 3600,      // 4 hours
};

// Decay rate per class (lower = slower decay)
const DECAY_CLASS_RATE: Record<string, number> = {
  permanent: 0.0,   // No decay
  stable: 0.3,      // Slow
  active: 0.5,      // Normal (ACT-R default)
  session: 0.7,     // Fast
  checkpoint: 0.9,  // Very fast
};

// Protection boost for articulation points
const ARTICULATION_BOOST = 2.0;

// Minimum activation threshold for retrievability
const RETRIEVAL_THRESHOLD = -1.5;

export interface UnifiedDecayConfig {
  // ACT-R parameters
  decayRate: number;           // Base decay rate (d)
  spreadingFactor: number;     // How much activation spreads (W)
  fanFactor: number;           // Fan penalty coefficient
  retrievalThreshold: number;  // Minimum activation for retrieval

  // Tarjan protection
  protectionBoost: number;     // Boost for articulation points

  // Decay class weights
  classRates: Record<string, number>;
}

export const UNIFIED_DEFAULTS: UnifiedDecayConfig = {
  decayRate: ACTR_DEFAULTS.decayRate,
  spreadingFactor: ACTR_DEFAULTS.spreadingStrength,
  fanFactor: ACTR_DEFAULTS.fanFactor,
  retrievalThreshold: RETRIEVAL_THRESHOLD,
  protectionBoost: ARTICULATION_BOOST,
  classRates: DECAY_CLASS_RATE,
};

export interface UnifiedActivationResult {
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  decayClass: string;
  
  // Component activations
  baseLevel: number;      // B_i: ACT-R base-level
  spreading: number;      // S_i: Spreading from neighbors
  protection: number;     // P_i: Tarjan protection boost
  total: number;          // A_i = B_i + S_i + P_i
  
  // Status
  isRetrievable: boolean;
  isArticulationPoint: boolean;
  priority: number;       // Normalized 0-1 for ranking
}

export interface DecayClassDistribution {
  class: string;
  count: number;
  avgActivation: number;
  retrievableCount: number;
  protectedCount: number;
}

/**
 * Ensure unified decay schema exists
 */
export function ensureUnifiedSchema(db: Database): void {
  // Migration: Add access_count column if not exists
  try {
    db.prepare("SELECT access_count FROM facts LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE facts ADD COLUMN access_count INTEGER DEFAULT 0");
    console.log("Migration: Added access_count column to facts table");
  }

  db.exec(`
    -- Unified activation tracking
    CREATE TABLE IF NOT EXISTS unified_activation (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      base_level REAL DEFAULT 0,
      spreading REAL DEFAULT 0,
      protection REAL DEFAULT 0,
      total REAL DEFAULT 0,
      is_retrievable INTEGER DEFAULT 0,
      is_articulation_point INTEGER DEFAULT 0,
      calculated_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(fact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_unified_total ON unified_activation(total DESC);
    CREATE INDEX IF NOT EXISTS idx_unified_retrievable ON unified_activation(is_retrievable, total DESC);
    CREATE INDEX IF NOT EXISTS idx_unified_articulation ON unified_activation(is_articulation_point DESC);

    -- Decay class mapping for legacy compatibility
    CREATE TABLE IF NOT EXISTS decay_class_mapping (
      decay_class TEXT PRIMARY KEY,
      decay_rate REAL NOT NULL,
      ttl_seconds INTEGER,
      description TEXT
    );

    -- Insert default mappings if not exists
    INSERT OR IGNORE INTO decay_class_mapping (decay_class, decay_rate, ttl_seconds, description) VALUES
      ('permanent', 0.0, NULL, 'Never decay - identity, critical decisions'),
      ('stable', 0.3, 7776000, 'Slow decay - important facts (90 days)'),
      ('active', 0.5, 1209600, 'Normal decay - standard facts (14 days)'),
      ('session', 0.7, 86400, 'Fast decay - temporary data (1 day)'),
      ('checkpoint', 0.9, 14400, 'Very fast decay - ephemeral (4 hours)');
  `);
}

/**
 * Calculate unified activation for a single fact
 */
export function calculateUnifiedActivation(
  db: Database,
  factId: string,
  adj: Map<string, Set<string>>,
  articulationPoints: Set<string>,
  config: UnifiedDecayConfig = UNIFIED_DEFAULTS
): UnifiedActivationResult | null {
  const row = db.prepare(`
    SELECT f.id, f.entity, f.key, f.value, f.decay_class, f.access_count, 
           f.last_accessed, f.created_at, f.importance
    FROM facts f
    WHERE f.id = ?
  `).get(factId) as Record<string, unknown> | null;

  if (!row) return null;

  const decayClass = (row.decay_class as string) || 'active';
  const decayRate = config.classRates[decayClass] ?? config.decayRate;

  // Base-level activation (ACT-R)
  let baseLevel: number;
  if (decayClass === 'permanent') {
    baseLevel = 10.0; // Effectively infinite
  } else {
    baseLevel = calculateBaseLevel(
      row.access_count as number,
      row.last_accessed as number,
      row.created_at as number,
      { ...ACTR_DEFAULTS, decayRate }
    );
  }

  // Spreading activation from neighbors - create activations map for neighbors
  const neighborActivations = new Map<string, number>();
  const neighbors = adj.get(factId);
  if (neighbors) {
    for (const neighborId of neighbors) {
      const neighborRow = db.prepare(`
        SELECT access_count, last_accessed, created_at, decay_class
        FROM facts WHERE id = ?
      `).get(neighborId) as Record<string, unknown> | null;
      
      if (neighborRow) {
        const neighborDecayClass = (neighborRow.decay_class as string) || 'active';
        const neighborDecayRate = config.classRates[neighborDecayClass] ?? config.decayRate;
        
        if (neighborDecayClass === 'permanent') {
          neighborActivations.set(neighborId, 10.0);
        } else {
          const neighborBase = calculateBaseLevel(
            neighborRow.access_count as number,
            neighborRow.last_accessed as number,
            neighborRow.created_at as number,
            { ...ACTR_DEFAULTS, decayRate: neighborDecayRate }
          );
          neighborActivations.set(neighborId, neighborBase);
        }
      }
    }
  }
  
  const spreading = calculateSpreading(db, factId, adj, neighborActivations, {
    decayRate: config.decayRate,
    spreadingStrength: config.spreadingFactor,
    maxSpreadDepth: 2,
    retrievalThreshold: config.retrievalThreshold,
    timeScale: 1.0,
    fanFactor: config.fanFactor,
  }, 0);

  // Guard: ensure spreading is a valid number (never undefined/NaN)
  const validSpreading = (typeof spreading === 'number' && !isNaN(spreading)) ? spreading : 0;

  // Tarjan protection boost
  const isArticulationPoint = articulationPoints.has(factId);
  const protection = isArticulationPoint ? config.protectionBoost : 0;

  // Total activation
  const rawTotal = baseLevel + validSpreading + protection;
  const total = isNaN(rawTotal) ? 0 : rawTotal;

  // Retrievability
  const isRetrievable = total >= config.retrievalThreshold;

  // Priority (normalized 0-1 using sigmoid)
  const priority = 1 / (1 + Math.exp(-total));

  return {
    factId: row.id as string,
    entity: row.entity as string,
    key: row.key as string | null,
    value: row.value as string,
    decayClass,
    baseLevel,
    spreading,
    protection,
    total,
    isRetrievable,
    isArticulationPoint,
    priority,
  };
}

/**
 * Run unified decay calculation for all facts
 */
export function runUnifiedDecay(
  db: Database,
  config: UnifiedDecayConfig = UNIFIED_DEFAULTS
): {
  results: UnifiedActivationResult[];
  stats: {
    total: number;
    retrievable: number;
    protected: number;
    avgActivation: number;
    byClass: DecayClassDistribution[];
  };
} {
  ensureUnifiedSchema(db);

  // Build graph
  const adj = buildAdjacencyList(db);
  const articulationPoints = findArticulationPoints(adj);

  // Get all facts
  const facts = db.prepare("SELECT id FROM facts").all() as Array<{ id: string }>;

  const results: UnifiedActivationResult[] = [];
  const insert = db.prepare(`
    INSERT OR REPLACE INTO unified_activation 
    (fact_id, base_level, spreading, protection, total, is_retrievable, is_articulation_point, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
  `);

  db.transaction(() => {
    for (const { id } of facts) {
      const result = calculateUnifiedActivation(db, id, adj, articulationPoints, config);
      if (result) {
        results.push(result);
        insert.run(
          result.factId,
          result.baseLevel,
          result.spreading,
          result.protection,
          result.total,
          result.isRetrievable ? 1 : 0,
          result.isArticulationPoint ? 1 : 0
        );
      }
    }
  })();

  // Calculate statistics
  const byClass: Record<string, DecayClassDistribution> = {};
  for (const r of results) {
    if (!byClass[r.decayClass]) {
      byClass[r.decayClass] = {
        class: r.decayClass,
        count: 0,
        avgActivation: 0,
        retrievableCount: 0,
        protectedCount: 0,
      };
    }
    byClass[r.decayClass].count++;
    byClass[r.decayClass].avgActivation += r.total;
    if (r.isRetrievable) byClass[r.decayClass].retrievableCount++;
    if (r.isArticulationPoint) byClass[r.decayClass].protectedCount++;
  }

  for (const cls of Object.values(byClass)) {
    if (cls.count > 0) cls.avgActivation /= cls.count;
  }

  return {
    results,
    stats: {
      total: results.length,
      retrievable: results.filter(r => r.isRetrievable).length,
      protected: results.filter(r => r.isArticulationPoint).length,
      avgActivation: results.length > 0 
        ? results.reduce((sum, r) => sum + r.total, 0) / results.length 
        : 0,
      byClass: Object.values(byClass).sort((a, b) => b.avgActivation - a.avgActivation),
    },
  };
}

/**
 * Get top facts by unified activation
 */
export function getTopByUnifiedActivation(
  db: Database,
  limit: number = 20,
  onlyRetrievable: boolean = true
): UnifiedActivationResult[] {
  ensureUnifiedSchema(db);

  const whereClause = onlyRetrievable ? "WHERE is_retrievable = 1" : "";
  
  const rows = db.prepare(`
    SELECT 
      ua.*,
      f.entity, f.key, f.value, f.decay_class
    FROM unified_activation ua
    JOIN facts f ON f.id = ua.fact_id
    ${whereClause}
    ORDER BY ua.total DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    factId: row.fact_id as string,
    entity: row.entity as string,
    key: row.key as string | null,
    value: row.value as string,
    decayClass: row.decay_class as string,
    baseLevel: row.base_level as number,
    spreading: row.spreading as number,
    protection: row.protection as number,
    total: row.total as number,
    isRetrievable: Boolean(row.is_retrievable),
    isArticulationPoint: Boolean(row.is_articulation_point),
    priority: 1 / (1 + Math.exp(-(row.total as number))),
  }));
}

/**
 * Get protected facts (articulation points)
 */
export function getProtectedFacts(
  db: Database,
  limit: number = 20
): UnifiedActivationResult[] {
  ensureUnifiedSchema(db);

  const rows = db.prepare(`
    SELECT 
      ua.*,
      f.entity, f.key, f.value, f.decay_class
    FROM unified_activation ua
    JOIN facts f ON f.id = ua.fact_id
    WHERE ua.is_articulation_point = 1
    ORDER BY ua.protection DESC, ua.total DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  return rows.map(row => ({
    factId: row.fact_id as string,
    entity: row.entity as string,
    key: row.key as string | null,
    value: row.value as string,
    decayClass: row.decay_class as string,
    baseLevel: row.base_level as number,
    spreading: row.spreading as number,
    protection: row.protection as number,
    total: row.total as number,
    isRetrievable: Boolean(row.is_retrievable),
    isArticulationPoint: Boolean(row.is_articulation_point),
    priority: 1 / (1 + Math.exp(-(row.total as number))),
  }));
}

/**
 * Record access and update activation
 */
export function recordAccessWithDecay(
  db: Database,
  factId: string,
  config: UnifiedDecayConfig = UNIFIED_DEFAULTS
): UnifiedActivationResult | null {
  ensureUnifiedSchema(db);

  // Record access in facts table
  db.prepare(`
    UPDATE facts 
    SET access_count = access_count + 1, last_accessed = strftime('%s','now')
    WHERE id = ?
  `).run(factId);

  // Recalculate unified activation
  const adj = buildAdjacencyList(db);
  const articulationPoints = findArticulationPoints(adj);
  
  const result = calculateUnifiedActivation(db, factId, adj, articulationPoints, config);
  
  if (result) {
    db.prepare(`
      INSERT OR REPLACE INTO unified_activation 
      (fact_id, base_level, spreading, protection, total, is_retrievable, is_articulation_point, calculated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `).run(
      result.factId,
      result.baseLevel,
      result.spreading,
      result.protection,
      result.total,
      result.isRetrievable ? 1 : 0,
      result.isArticulationPoint ? 1 : 0
    );
  }

  return result;
}

// --- CLI ---

function printUsage() {
  console.log(`
zo-memory-system unified-decay — Unified Decay System

Combines ACT-R spreading activation + Tarjan articulation protection + 5-tier decay

Usage:
  bun unified-decay.ts <command> [options]

Commands:
  run                Run unified decay calculation for all facts
  top                Show top facts by activation
  protected          Show articulation-point protected facts
  stats              Show unified decay statistics
  record             Record access for a fact and recalculate
  auto-resolve-stale Auto-resolve stale open loops (no living project, no graph protection)

Options:
  --limit <n>        Limit results (default: 20)
  --only-retrievable Only show retrievable facts (default: true)
  --id <fact-id>     Fact ID for record command

Examples:
  bun unified-decay.ts run
  bun unified-decay.ts top --limit 50
  bun unified-decay.ts protected
  bun unified-decay.ts record --id abc123
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");

  // Parse flags
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] || "";
      i++;
    }
  }

  switch (command) {
    case "run": {
      console.log("Running unified decay calculation...\n");
      const start = performance.now();
      const { stats } = runUnifiedDecay(db);
      const duration = (performance.now() - start).toFixed(0);
      
      console.log(`Completed in ${duration}ms\n`);
      console.log("Statistics:");
      console.log(`  Total facts: ${stats.total}`);
      console.log(`  Retrievable: ${stats.retrievable} (${((stats.retrievable / stats.total) * 100).toFixed(1)}%)`);
      console.log(`  Protected (articulation points): ${stats.protected}`);
      console.log(`  Average activation: ${stats.avgActivation.toFixed(3)}`);
      console.log("\nBy decay class:");
      for (const cls of stats.byClass) {
        console.log(`  ${cls.class}: ${cls.count} facts, avg=${cls.avgActivation.toFixed(2)}, retrievable=${cls.retrievableCount}, protected=${cls.protectedCount}`);
      }
      break;
    }

    case "top": {
      const limit = parseInt(flags.limit) || 20;
      const onlyRetrievable = flags["only-retrievable"] !== "false";
      
      console.log(`Top ${limit} facts by unified activation${onlyRetrievable ? " (retrievable only)" : ""}:\n`);
      
      const facts = getTopByUnifiedActivation(db, limit, onlyRetrievable);
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        console.log(`${i + 1}. [${f.entity}.${f.key || "_"}] "${f.value.slice(0, 60)}${f.value.length > 60 ? "..." : ""}"`);
        console.log(`   A=${f.total.toFixed(2)} B=${f.baseLevel.toFixed(2)} S=${f.spreading.toFixed(2)} P=${f.protection.toFixed(2)} ${f.isArticulationPoint ? "[PROTECTED]" : ""}`);
      }
      break;
    }

    case "protected": {
      const limit = parseInt(flags.limit) || 20;
      
      console.log(`Articulation-point protected facts (top ${limit}):\n`);
      
      const facts = getProtectedFacts(db, limit);
      for (let i = 0; i < facts.length; i++) {
        const f = facts[i];
        console.log(`${i + 1}. [${f.entity}.${f.key || "_"}] "${f.value.slice(0, 60)}${f.value.length > 60 ? "..." : ""}"`);
        console.log(`   Total activation: ${f.total.toFixed(2)} (protection boost: +${f.protection.toFixed(2)})`);
        console.log(`   Decay class: ${f.decayClass}`);
      }
      
      if (facts.length === 0) {
        console.log("No articulation points found. Run 'unified-decay.ts run' first.");
      }
      break;
    }

    case "stats": {
      ensureUnifiedSchema(db);
      
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN is_retrievable = 1 THEN 1 ELSE 0 END) as retrievable,
          SUM(CASE WHEN is_articulation_point = 1 THEN 1 ELSE 0 END) as protected,
          AVG(total) as avg_activation,
          MIN(total) as min_activation,
          MAX(total) as max_activation
        FROM unified_activation
      `).get() as Record<string, number>;
      
      console.log("Unified Decay Statistics\n");
      console.log(`Total calculated: ${stats.total}`);
      console.log(`Retrievable: ${stats.retrievable} (${((stats.retrievable / stats.total) * 100).toFixed(1)}%)`);
      console.log(`Protected (articulation points): ${stats.protected}`);
      console.log(`\nActivation range: ${stats.min_activation.toFixed(2)} to ${stats.max_activation.toFixed(2)}`);
      console.log(`Average activation: ${stats.avg_activation.toFixed(3)}`);
      
      const distribution = db.prepare(`
        SELECT 
          CASE 
            WHEN total < -2 THEN 'Very Low (< -2)'
            WHEN total < 0 THEN 'Low (-2 to 0)'
            WHEN total < 2 THEN 'Medium (0 to 2)'
            ELSE 'High (> 2)'
          END as range,
          COUNT(*) as count
        FROM unified_activation
        GROUP BY range
        ORDER BY MIN(total)
      `).all() as Array<{ range: string; count: number }>;
      
      console.log("\nActivation distribution:");
      for (const row of distribution) {
        console.log(`  ${row.range}: ${row.count}`);
      }
      break;
    }

    case "record": {
      if (!flags.id) {
        console.error("Error: --id is required");
        process.exit(1);
      }
      
      const result = recordAccessWithDecay(db, flags.id);
      if (result) {
        console.log(`Recorded access for: [${result.entity}.${result.key || "_"}]`);
        console.log(`  New activation: ${result.total.toFixed(2)}`);
        console.log(`    Base: ${result.baseLevel.toFixed(2)}`);
        console.log(`    Spreading: ${result.spreading.toFixed(2)}`);
        console.log(`    Protection: ${result.protection.toFixed(2)}`);
        console.log(`  Retrievable: ${result.isRetrievable ? "Yes" : "No"}`);
        console.log(`  Protected: ${result.isArticulationPoint ? "Yes" : "No"}`);
      } else {
        console.error(`Fact not found: ${flags.id}`);
        process.exit(1);
      }
      break;
    }

    case "auto-resolve-stale": {
      const staleDays = parseInt(flags.stale_days || "30");
      const livingDays = parseInt(flags.living_days || "30");

      console.log(`Auto-resolving stale open loops (${staleDays}+ days, living project window: ${livingDays} days)...\n`);

      const result = autoResolveStaleLoops(db, staleDays, livingDays);

      console.log(`Stale loops auto-resolved: ${result.resolved}`);
      console.log(`Stale loops skipped (living project or graph-protected): ${result.skipped}`);

      if (result.details.length > 0) {
        console.log(`\nResolved:`);
        for (const d of result.details) {
          const title = d.title.length > 60 ? d.title.slice(0, 57) + "..." : d.title;
          console.log(`  - ${title}`);
          console.log(`    ${d.reason}`);
        }
      }

      if (result.skipped > 0) {
        console.log(`\nSkipped (protected): ${result.skipped} stale loop(s)`);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }

  db.close();
}

if (import.meta.main) {
  main().catch(console.error);
}
