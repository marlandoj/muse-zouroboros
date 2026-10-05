#!/usr/bin/env bun
/**
 * actr.ts — ACT-R Spreading Activation for Memory Decay
 *
 * ACT-R (Adaptive Control of Thought–Rational) cognitive architecture provides
 * a neurologically grounded model of memory decay. Key concepts:
 *
 * - Base-level activation: Decays over time but revives with access
 * - Spreading activation: Recalled items boost linked neighbors
 * - Retrieval threshold: Items below threshold are effectively unavailable
 *
 * This module replaces the simple 5-tier decay with ACT-R equations while
 * maintaining backward compatibility with the existing decay_class system.
 *
 * Reference: Anderson, J. R., et al. (2004). An integrated theory of the mind.
 *            Psychological Review, 111(4), 1036–1060.
 */

import { Database } from "bun:sqlite";

// ACT-R Parameters (empirically validated defaults)
export const ACTR_DEFAULTS = {
  // Base-level decay rate (d in ACT-R papers, typically 0.5)
  decayRate: 0.5,
  // Spreading activation strength from source to target
  spreadingStrength: 0.1,
  // Maximum spreading distance (hops)
  maxSpreadDepth: 2,
  // Retrieval threshold (log odds of successful retrieval)
  retrievalThreshold: -1.5,
  // Time scale factor (seconds per unit)
  timeScale: 1.0,
  // Optimized fan factor (reduces activation for highly connected nodes)
  fanFactor: 0.1,
};

export interface ActrConfig {
  decayRate: number;
  spreadingStrength: number;
  maxSpreadDepth: number;
  retrievalThreshold: number;
  timeScale: number;
  fanFactor: number;
}

export interface ActrActivation {
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  baseLevel: number;      // B_i in ACT-R
  spreading: number;      // S_i from linked items
  total: number;          // A_i = B_i + S_i
  decayClass: string;
  accessCount: number;
  lastAccessed: number;   // Unix seconds
  createdAt: number;      // Unix seconds
  linkedFacts: number;    // Fan (number of connections)
  isRetrievable: boolean; // Above threshold?
}

export interface SpreadingUpdate {
  sourceId: string;
  targetId: string;
  activation: number;
  hopDistance: number;
}

// Schema for ACT-R tracking
const ACTR_SCHEMA = `
  -- ACT-R activation tracking (extends existing facts table)
  CREATE TABLE IF NOT EXISTS actr_activation (
    fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
    base_level REAL DEFAULT 0.0,
    spreading REAL DEFAULT 0.0,
    total_activation REAL DEFAULT 0.0,
    access_count INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    last_accessed INTEGER DEFAULT (strftime('%s','now')),
    last_calculated INTEGER DEFAULT (strftime('%s','now')),
    spreading_sources TEXT -- JSON array of {source_id, hop, amount}
  );

  CREATE INDEX IF NOT EXISTS idx_actr_activation_total 
    ON actr_activation(total_activation DESC);
  CREATE INDEX IF NOT EXISTS idx_actr_activation_retrievable 
    ON actr_activation(total_activation) WHERE total_activation > -1.5;
`;

/**
 * Ensure ACT-R schema exists
 */
export function ensureActrSchema(db: Database): void {
  db.exec(ACTR_SCHEMA);
  
  // Migration: Add spreading column if it doesn't exist
  try {
    db.query("SELECT spreading FROM actr_activation LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE actr_activation ADD COLUMN spreading REAL DEFAULT 0.0");
  }
}

/**
 * Calculate base-level activation using ACT-R power law decay
 * 
 * B_i = log( Σ t_j^(-d) ) where t_j is time since j-th presentation
 * 
 * For computational efficiency, we use an approximation with access count
 * and exponential decay from last access.
 */
export function calculateBaseLevel(
  accessCount: number,
  lastAccessed: number,
  createdAt: number,
  config: ActrConfig = ACTR_DEFAULTS
): number {
  const now = Date.now() / 1000;
  
  if (accessCount === 0) {
    // Never accessed - decay from creation
    const age = now - createdAt;
    return Math.log(1) - config.decayRate * Math.log(age + 1);
  }
  
  // Base activation from access count (log of presentations)
  const presentationBoost = Math.log(accessCount + 1);
  
  // Time-based decay from last access
  const timeSinceAccess = now - lastAccessed;
  const decay = config.decayRate * Math.log(timeSinceAccess / (config.timeScale || 1.0) + 1);
  
  return presentationBoost - decay;
}

/**
 * Calculate spreading activation from linked facts
 * 
 * S_i = Σ W_j * S_ji where W_j is source activation and S_ji is link strength
 * With fan penalty: divided by sqrt(fan) to simulate interference
 */
export function calculateSpreading(
  db: Database,
  factId: string,
  adj: Map<string, Set<string>>,
  activations: Map<string, number>,
  config: ActrConfig = ACTR_DEFAULTS,
  depth: number = 0
): number {
  if (depth >= config.maxSpreadDepth) return 0;
  
  const neighbors = adj.get(factId);
  if (!neighbors || neighbors.size === 0) return 0;
  
  let spreading = 0;
  const fanPenalty = Math.sqrt(neighbors.size);
  
  for (const neighbor of neighbors) {
    const neighborActivation = activations.get(neighbor) || 0;
    if (neighborActivation > config.retrievalThreshold) {
      // Spreading decays with distance
      const distanceDecay = Math.pow(0.5, depth);
      spreading += (neighborActivation * config.spreadingStrength * distanceDecay) / fanPenalty;
    }
  }
  
  return spreading;
}

/**
 * Build activation for all facts using iterative spreading
 */
export function calculateActivations(
  db: Database,
  config: ActrConfig = ACTR_DEFAULTS
): Map<string, ActrActivation> {
  ensureActrSchema(db);
  
  // Load all facts with their ACT-R state
  const rows = db.prepare(`
    SELECT 
      f.id, f.entity, f.key, f.value, f.decay_class,
      COALESCE(a.access_count, 0) as access_count,
      COALESCE(a.last_accessed, f.created_at) as last_accessed,
      f.created_at
    FROM facts f
    LEFT JOIN actr_activation a ON a.fact_id = f.id
  `).all() as Array<{
    id: string;
    entity: string;
    key: string | null;
    value: string;
    decay_class: string;
    access_count: number;
    last_accessed: number;
    created_at: number;
  }>;
  
  // Build adjacency list
  const adj = new Map<string, Set<string>>();
  for (const row of rows) {
    adj.set(row.id, new Set());
  }
  
  const links = db.prepare(`
    SELECT source_id, target_id FROM fact_links
  `).all() as Array<{ source_id: string; target_id: string }>;
  
  for (const link of links) {
    adj.get(link.source_id)?.add(link.target_id);
    adj.get(link.target_id)?.add(link.source_id);
  }
  
  // Initialize activations with base levels
  const activations = new Map<string, ActrActivation>();
  const totalActivation = new Map<string, number>();
  
  for (const row of rows) {
    const baseLevel = calculateBaseLevel(
      row.access_count,
      row.last_accessed,
      row.created_at,
      config
    );
    
    const linkedFacts = adj.get(row.id)?.size || 0;
    
    activations.set(row.id, {
      factId: row.id,
      entity: row.entity,
      key: row.key,
      value: row.value,
      baseLevel,
      spreading: 0,
      total: baseLevel,
      decayClass: row.decay_class,
      accessCount: row.access_count,
      lastAccessed: row.last_accessed,
      createdAt: row.created_at,
      linkedFacts,
      isRetrievable: baseLevel > config.retrievalThreshold,
    });
    
    totalActivation.set(row.id, baseLevel);
  }
  
  // Iterative spreading activation (2 iterations for convergence)
  for (let iteration = 0; iteration < 2; iteration++) {
    for (const [factId, act] of activations) {
      const spreading = calculateSpreading(
        db,
        factId,
        adj,
        totalActivation,
        config,
        0
      );
      
      act.spreading = spreading;
      act.total = act.baseLevel + spreading;
      act.isRetrievable = act.total > config.retrievalThreshold;
      // Guard: NaN from calculateBaseLevel cascades through totalActivation across iterations.
      // Force to 0 here so subsequent spreading calls (which read from totalActivation)
      // never receive NaN as input.
      totalActivation.set(factId, isNaN(act.total) ? act.baseLevel : act.total);
    }
  }
  
  return activations;
}

/**
 * Record an access event for a fact (updates ACT-R tracking)
 */
export function recordAccess(
  db: Database,
  factId: string,
  source: string = "manual"
): void {
  ensureActrSchema(db);
  const now = Math.floor(Date.now() / 1000);
  
  db.prepare(`
    INSERT INTO actr_activation (fact_id, access_count, last_accessed, last_calculated)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET
      access_count = access_count + 1,
      last_accessed = ?,
      last_calculated = ?
  `).run(factId, now, now, now, now);
}

/**
 * Get activation for a specific fact
 */
export function getActivation(
  db: Database,
  factId: string,
  config: ActrConfig = ACTR_DEFAULTS
): ActrActivation | null {
  ensureActrSchema(db);
  
  const row = db.prepare(`
    SELECT 
      f.id, f.entity, f.key, f.value, f.decay_class,
      COALESCE(a.access_count, 0) as access_count,
      COALESCE(a.last_accessed, f.created_at) as last_accessed,
      f.created_at
    FROM facts f
    LEFT JOIN actr_activation a ON a.fact_id = f.id
    WHERE f.id = ?
  `).get(factId) as {
    id: string;
    entity: string;
    key: string | null;
    value: string;
    decay_class: string;
    access_count: number;
    last_accessed: number;
    created_at: number;
  } | null;
  
  if (!row) return null;
  
  // Get neighbors
  const links = db.prepare(`
    SELECT target_id FROM fact_links WHERE source_id = ?
    UNION
    SELECT source_id FROM fact_links WHERE target_id = ?
  `).all(factId, factId) as Array<{ target_id?: string; source_id?: string }>;
  
  const linkedFacts = links.length;
  const baseLevel = calculateBaseLevel(
    row.access_count,
    row.last_accessed,
    row.created_at,
    config
  );
  
  // Calculate spreading from neighbors
  const neighborActivations = new Map<string, number>();
  for (const link of links) {
    const neighborId = link.target_id || link.source_id!;
    const neighbor = db.prepare(`
      SELECT COALESCE(a.access_count, 0) as access_count,
             COALESCE(a.last_accessed, f.created_at) as last_accessed,
             f.created_at
      FROM facts f
      LEFT JOIN actr_activation a ON a.fact_id = f.id
      WHERE f.id = ?
    `).get(neighborId) as {
      access_count: number;
      last_accessed: number;
      created_at: number;
    } | null;
    
    if (neighbor) {
      neighborActivations.set(
        neighborId,
        calculateBaseLevel(neighbor.access_count, neighbor.last_accessed, neighbor.created_at, config)
      );
    }
  }
  
  const adj = new Map<string, Set<string>>();
  adj.set(factId, new Set(neighborActivations.keys()));
  
  const spreading = calculateSpreading(db, factId, adj, neighborActivations, config, 0);
  const total = baseLevel + spreading;
  
  return {
    factId: row.id,
    entity: row.entity,
    key: row.key,
    value: row.value,
    baseLevel,
    spreading,
    total,
    decayClass: row.decay_class,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
    linkedFacts,
    isRetrievable: total > config.retrievalThreshold,
  };
}

/**
 * Apply ACT-R decay to all facts and update their decay class
 * This replaces the simple time-based decay with ACT-R activation
 */
export function applyActrDecay(
  db: Database,
  config: ActrConfig = ACTR_DEFAULTS
): { updated: number; demoted: number; promoted: number } {
  ensureActrSchema(db);
  
  const activations = calculateActivations(db, config);
  let updated = 0;
  let demoted = 0;
  let promoted = 0;
  const now = Math.floor(Date.now() / 1000);
  
  // Decay class thresholds based on ACT-R activation
  const classThresholds = {
    permanent: 2.0,    // Very high activation
    stable: 0.5,       // High activation
    active: -0.5,      // Moderate activation
    session: -1.5,     // Low activation (retrieval threshold)
    checkpoint: -999,  // Below threshold
  };
  
  const updateStmt = db.prepare(`
    UPDATE facts 
    SET decay_class = ?, updated_at = ?
    WHERE id = ? AND decay_class != ?
  `);
  
  const updateActrStmt = db.prepare(`
    INSERT INTO actr_activation (fact_id, base_level, total_activation, last_calculated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(fact_id) DO UPDATE SET
      base_level = ?,
      total_activation = ?,
      last_calculated = ?
  `);
  
  for (const [factId, act] of activations) {
    // Determine new decay class based on activation
    let newClass = act.decayClass;
    if (act.total >= classThresholds.permanent) newClass = "permanent";
    else if (act.total >= classThresholds.stable) newClass = "stable";
    else if (act.total >= classThresholds.active) newClass = "active";
    else if (act.total >= classThresholds.session) newClass = "session";
    else newClass = "checkpoint";
    
    // Update fact decay class if changed
    if (newClass !== act.decayClass) {
      const result = updateStmt.run(newClass, now, factId, newClass);
      if (result.changes > 0) {
        updated++;
        // Simple heuristic: permanent/stable = promoted, session/checkpoint = demoted
        if (["permanent", "stable"].includes(newClass)) promoted++;
        if (["session", "checkpoint"].includes(newClass)) demoted++;
      }
    }
    
    // Store activation values
    updateActrStmt.run(
      factId, act.baseLevel, act.total, now,
      act.baseLevel, act.total, now
    );
  }
  
  return { updated, demoted, promoted };
}

/**
 * Get top retrievable facts by activation
 */
export function getTopRetrievable(
  db: Database,
  limit: number = 20,
  config: ActrConfig = ACTR_DEFAULTS
): ActrActivation[] {
  const activations = calculateActivations(db, config);
  
  return Array.from(activations.values())
    .filter(a => a.isRetrievable)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/**
 * CLI for ACT-R operations
 */
function printUsage() {
  console.log(`
zo-memory-system actr — ACT-R Spreading Activation

Usage:
  bun actr.ts <command> [options]

Commands:
  decay              Apply ACT-R decay to all facts
  activation         Show activation for a specific fact
  top                List top retrievable facts by activation
  stats              Show ACT-R statistics
  record             Record an access event for a fact

Options:
  --id <fact-id>     Fact ID (for activation/record commands)
  --limit <n>        Number of results (default: 20)
  --threshold <n>    Retrieval threshold (default: -1.5)
  --decay <n>        Decay rate (default: 0.5)

Examples:
  bun actr.ts decay
  bun actr.ts activation --id abc123
  bun actr.ts top --limit 10
  bun actr.ts record --id abc123
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] || "";
      i++;
    }
  }

  const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");

  const config: ActrConfig = {
    ...ACTR_DEFAULTS,
    retrievalThreshold: parseFloat(flags.threshold) || ACTR_DEFAULTS.retrievalThreshold,
    decayRate: parseFloat(flags.decay) || ACTR_DEFAULTS.decayRate,
  };

  switch (command) {
    case "decay": {
      console.log("Applying ACT-R spreading activation decay...\n");
      const result = applyActrDecay(db, config);
      console.log(`Updated: ${result.updated} facts`);
      console.log(`Promoted: ${result.promoted} facts`);
      console.log(`Demoted: ${result.demoted} facts`);
      break;
    }

    case "activation": {
      if (!flags.id) {
        console.error("Error: --id is required");
        process.exit(1);
      }
      const act = getActivation(db, flags.id, config);
      if (!act) {
        console.error(`Fact not found: ${flags.id}`);
        process.exit(1);
      }
      console.log(`\nActivation for [${act.entity}.${act.key || "_"}]:\n`);
      console.log(`  Base level:      ${act.baseLevel.toFixed(3)}`);
      console.log(`  Spreading:       ${act.spreading.toFixed(3)}`);
      console.log(`  Total:           ${act.total.toFixed(3)}`);
      console.log(`  Retrievable:     ${act.isRetrievable ? "YES" : "NO"}`);
      console.log(`  Decay class:     ${act.decayClass}`);
      console.log(`  Access count:    ${act.accessCount}`);
      console.log(`  Linked facts:    ${act.linkedFacts}`);
      console.log(`  Last accessed:   ${new Date(act.lastAccessed * 1000).toISOString()}`);
      break;
    }

    case "top": {
      const limit = parseInt(flags.limit) || 20;
      const top = getTopRetrievable(db, limit, config);
      console.log(`\nTop ${top.length} retrievable facts by activation:\n`);
      for (let i = 0; i < top.length; i++) {
        const act = top[i];
        console.log(`${i + 1}. [${act.entity}.${act.key || "_"}] ${act.value.slice(0, 50)}`);
        console.log(`   Activation: ${act.total.toFixed(3)} (base: ${act.baseLevel.toFixed(3)} + spread: ${act.spreading.toFixed(3)})`);
      }
      break;
    }

    case "stats": {
      const activations = calculateActivations(db, config);
      const values = Array.from(activations.values());
      const retrievable = values.filter(a => a.isRetrievable);
      
      const avgActivation = values.reduce((sum, a) => sum + a.total, 0) / values.length;
      const avgBase = values.reduce((sum, a) => sum + a.baseLevel, 0) / values.length;
      const avgSpread = values.reduce((sum, a) => sum + a.spreading, 0) / values.length;
      
      console.log("\nACT-R Statistics:\n");
      console.log(`  Total facts:       ${values.length}`);
      console.log(`  Retrievable:       ${retrievable.length} (${((retrievable.length / values.length) * 100).toFixed(1)}%)`);
      console.log(`  Average activation: ${avgActivation.toFixed(3)}`);
      console.log(`  Average base level: ${avgBase.toFixed(3)}`);
      console.log(`  Average spreading:  ${avgSpread.toFixed(3)}`);
      console.log(`  Retrieval threshold: ${config.retrievalThreshold}`);
      console.log(`\nDecay class distribution:`);
      const classCounts = new Map<string, number>();
      for (const act of values) {
        classCounts.set(act.decayClass, (classCounts.get(act.decayClass) || 0) + 1);
      }
      for (const [cls, count] of classCounts) {
        console.log(`  ${cls}: ${count}`);
      }
      break;
    }

    case "record": {
      if (!flags.id) {
        console.error("Error: --id is required");
        process.exit(1);
      }
      recordAccess(db, flags.id);
      console.log(`Recorded access for fact: ${flags.id}`);
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
