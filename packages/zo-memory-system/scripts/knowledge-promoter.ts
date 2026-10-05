#!/usr/bin/env bun
/**
 * knowledge-promoter.ts — T6: Cross-Persona Knowledge Promotion
 *
 * Scheduled job that scans persona pools and promotes high-confidence
 * facts across persona boundaries via fact_links.
 *
 * Usage:
 *   bun knowledge-promoter.ts              # run promotion
 *   bun knowledge-promoter.ts --dry-run    # preview only
 *   bun knowledge-promoter.ts --verbose    # detailed output
 */

import { Database } from "bun:sqlite";
import { appendFileSync } from "fs";
import { listPools, getAccessiblePersonas } from "./cross-persona.ts";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const LOG_PATH = "/dev/shm/knowledge-promoter.log";
const CONFIDENCE_FLOOR = 0.8; // lowered from 0.9 — most facts have 1.0 or 0.8
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60; // 7 days (was 24h — too narrow for sparse data)
const MAX_PROMOTIONS_PER_CYCLE = 30;

interface PromotionCandidate {
  fact_id: string;
  entity: string;
  key: string;
  value: string;
  persona: string;
  confidence: number;
  created_at: number;
}

interface PromotionResult {
  promoted: number;
  skipped: number;
  candidates: number;
  dry_run: boolean;
  timestamp: string;
  details: string[];
}

function log(message: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
}

function run(dryRun: boolean, verbose: boolean): PromotionResult {
  const db = new Database(DB_PATH);
  const result: PromotionResult = {
    promoted: 0,
    skipped: 0,
    candidates: 0,
    dry_run: dryRun,
    timestamp: new Date().toISOString(),
    details: [],
  };

  try {
    // Ensure cross-persona tables exist before querying
    db.exec(`
      CREATE TABLE IF NOT EXISTS persona_pools (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS persona_pool_members (
        pool_id TEXT NOT NULL, persona TEXT NOT NULL,
        added_at INTEGER DEFAULT (strftime('%s','now')),
        PRIMARY KEY (pool_id, persona)
      );
      CREATE TABLE IF NOT EXISTS persona_inheritance (
        child_persona TEXT PRIMARY KEY, parent_persona TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 1, created_at INTEGER DEFAULT (strftime('%s','now'))
      );
    `);
    const pools = listPools(db);
    if (pools.length === 0) {
      result.details.push("No persona pools configured. Create pools to enable cross-persona promotion.");
      return result;
    }

    const cutoff = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

    // Collect all pool member personas
    const allPoolPersonas = new Set<string>();
    for (const pool of pools) {
      const members = db.prepare(
        "SELECT persona FROM persona_pool_members WHERE pool_id = ?"
      ).all(pool.id) as { persona: string }[];
      for (const m of members) allPoolPersonas.add(m.persona);
    }

    if (allPoolPersonas.size === 0) {
      result.details.push("No personas in any pool. Add personas to pools first.");
      return result;
    }

    // Find recent high-confidence facts from pool members OR "shared" facts
    // with domain-relevant entities. This ensures the 99% of facts tagged "shared"
    // still get promoted across pools based on their entity content.
    const personaList = [...allPoolPersonas];
    const placeholders = personaList.map(() => "?").join(",");
    const candidates = db.prepare(`
      SELECT id as fact_id, entity, key, value, persona, confidence, created_at
      FROM facts
      WHERE (persona IN (${placeholders}) OR persona = 'shared')
        AND confidence >= ?
        AND created_at > ?
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `).all(...personaList, CONFIDENCE_FLOOR, cutoff, MAX_PROMOTIONS_PER_CYCLE * 3) as PromotionCandidate[];

    result.candidates = candidates.length;

    if (verbose) {
      result.details.push(`Found ${candidates.length} candidate facts from ${allPoolPersonas.size} pool personas + shared`);
    }

    // Check each candidate for existing promotion links
    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight)
      VALUES (?, ?, 'promoted_from', 1.0)
    `);

    for (const c of candidates) {
      if (result.promoted >= MAX_PROMOTIONS_PER_CYCLE) break;

      // Check if already promoted
      const existing = db.prepare(
        "SELECT 1 FROM fact_links WHERE source_id = ? AND relation = 'promoted_from'"
      ).get(c.fact_id);

      if (existing) {
        result.skipped++;
        continue;
      }

      // For persona-tagged facts: use pool accessibility
      // For "shared" facts: promote as cross-pool reference (visible to leadership pool)
      let peers: string[];
      if (c.persona !== "shared") {
        const accessible = getAccessiblePersonas(db, c.persona);
        peers = accessible.filter(p => p !== c.persona && allPoolPersonas.has(p));
      } else {
        // Shared facts get promoted to the leadership pool (alaric, project-shepherd, etc.)
        // since leaders need broad awareness across all domains
        const leadershipPool = pools.find(p => p.name === "leadership");
        if (leadershipPool) {
          const leaderMembers = db.prepare(
            "SELECT persona FROM persona_pool_members WHERE pool_id = ?"
          ).all(leadershipPool.id) as { persona: string }[];
          peers = leaderMembers.map(m => m.persona);
        } else {
          peers = [];
        }
      }

      if (peers.length === 0) {
        result.skipped++;
        continue;
      }

      // Create a standalone promotion link (self-referential for "shared" facts,
      // or to a matching peer entity fact for persona-tagged facts)
      const peerPlaceholders = peers.map(() => "?").join(",");
      const peerFact = db.prepare(`
        SELECT id FROM facts
        WHERE persona IN (${peerPlaceholders})
          AND entity = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(...peers, c.entity) as { id: string } | null;

      if (peerFact) {
        if (!dryRun) {
          insertLink.run(c.fact_id, peerFact.id);
        }
        result.promoted++;
        if (verbose) {
          result.details.push(
            `${dryRun ? "[DRY] " : ""}Promoted: ${c.entity}/${c.key} (${c.persona} → peers, conf=${c.confidence})`
          );
        }
      } else {
        if (!dryRun) {
          insertLink.run(c.fact_id, c.fact_id);
        }
        result.promoted++;
        if (verbose) {
          result.details.push(
            `${dryRun ? "[DRY] " : ""}Promoted (standalone): ${c.entity}/${c.key} (${c.persona}, conf=${c.confidence})`
          );
        }
      }
    }

    return result;
  } finally {
    db.close();
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const verbose = args.has("--verbose") || args.has("-v");

  if (args.has("--help") || args.has("-h")) {
    console.log(`Usage:
  bun knowledge-promoter.ts              Run promotion cycle
  bun knowledge-promoter.ts --dry-run    Preview without writing
  bun knowledge-promoter.ts --verbose    Detailed output`);
    process.exit(0);
  }

  const result = run(dryRun, verbose);

  log(`Cycle complete: ${result.promoted} promoted, ${result.skipped} skipped, ${result.candidates} candidates (dry_run=${result.dry_run})`);

  console.log(JSON.stringify(result, null, 2));
}
