#!/usr/bin/env bun
/**
 * cross-db-sync.ts — Cross-DB fact promotion (Alaric → Mimir)
 *
 * Syncs high-confidence facts from a source DB to a target DB.
 * Deduplicates by (entity, key, value) to avoid double-inserts.
 * Tags synced facts with source origin for traceability.
 *
 * Usage:
 *   bun cross-db-sync.ts                          # run sync (default: alaric → mimir, last 24h)
 *   bun cross-db-sync.ts --lookback 7d            # sync last 7 days
 *   bun cross-db-sync.ts --lookback 30d           # sync last 30 days
 *   bun cross-db-sync.ts --all                    # sync all facts (no time filter)
 *   bun cross-db-sync.ts --dry-run                # preview only
 *   bun cross-db-sync.ts --min-confidence 0.9     # only facts with confidence >= 0.9
 *   bun cross-db-sync.ts --source /path/to/a.db --target /path/to/b.db
 *   bun cross-db-sync.ts --stats                  # show sync statistics
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { appendFileSync } from "fs";

const LOG_PATH = "/dev/shm/cross-db-sync.log";

const DEFAULT_SOURCE = "/home/workspace/.zo/memory/shared-facts.db";
const DEFAULT_TARGET = "/home/workspace/.zo/memory/mimir.db";
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_CONFIDENCE = 0.7;
const MAX_SYNC_PER_RUN = 100;

// Exclude session-scoped and low-value facts
const EXCLUDED_DECAY = ["session", "checkpoint"];
const EXCLUDED_ENTITIES = ["test", "swarm-test", "swarm_test", "bench-test", "workspace"];

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch {}
}

function parseLookback(s: string): number {
  const match = s.match(/^(\d+)(d|h|m)$/);
  if (!match) throw new Error(`Invalid lookback format: ${s} (use e.g. 24h, 7d, 30d)`);
  const n = parseInt(match[1]);
  const unit = match[2];
  if (unit === "d") return n * 86400_000;
  if (unit === "h") return n * 3600_000;
  return n * 60_000;
}

function showStats(sourceDb: Database, targetDb: Database) {
  const sourceCount = (sourceDb.query("SELECT COUNT(*) as c FROM facts").get() as any)?.c ?? 0;
  const targetCount = (targetDb.query("SELECT COUNT(*) as c FROM facts").get() as any)?.c ?? 0;
  const syncedCount = (targetDb.query("SELECT COUNT(*) as c FROM facts WHERE source LIKE 'cross-db-sync:%'").get() as any)?.c ?? 0;
  const lastSync = (targetDb.query("SELECT MAX(created_at) as t FROM facts WHERE source LIKE 'cross-db-sync:%'").get() as any)?.t;

  console.log("\n  Cross-DB Sync Statistics");
  console.log("  ───────────────────────");
  console.log(`  Source facts:    ${sourceCount}`);
  console.log(`  Target facts:    ${targetCount}`);
  console.log(`  Synced facts:    ${syncedCount}`);
  if (lastSync) {
    console.log(`  Last sync:       ${new Date(lastSync).toISOString()}`);
  } else {
    console.log(`  Last sync:       never`);
  }
  console.log();
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
cross-db-sync — Promote facts across memory backends

Usage:
  bun cross-db-sync.ts [options]

Options:
  --source <path>          Source DB (default: shared-facts.db / alaric)
  --target <path>          Target DB (default: mimir.db)
  --lookback <duration>    Time window: 24h, 7d, 30d (default: 24h)
  --all                    Sync all facts regardless of age
  --min-confidence <n>     Minimum confidence threshold (default: 0.7)
  --dry-run                Preview without writing
  --stats                  Show sync statistics and exit
  --verbose                Detailed output per fact
  -h, --help               Show this help
`);
    process.exit(0);
  }

  const sourcePath = args.includes("--source") ? args[args.indexOf("--source") + 1] : DEFAULT_SOURCE;
  const targetPath = args.includes("--target") ? args[args.indexOf("--target") + 1] : DEFAULT_TARGET;
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");
  const syncAll = args.includes("--all");
  const minConfidence = args.includes("--min-confidence")
    ? parseFloat(args[args.indexOf("--min-confidence") + 1])
    : DEFAULT_MIN_CONFIDENCE;

  let lookbackMs = DEFAULT_LOOKBACK_MS;
  if (args.includes("--lookback")) {
    lookbackMs = parseLookback(args[args.indexOf("--lookback") + 1]);
  }

  if (!existsSync(sourcePath)) {
    log(`ERROR: Source DB not found: ${sourcePath}`);
    process.exit(1);
  }
  if (!existsSync(targetPath)) {
    log(`ERROR: Target DB not found: ${targetPath}`);
    process.exit(1);
  }

  const sourceDb = new Database(sourcePath, { readonly: true });
  const targetDb = new Database(targetPath);

  if (args.includes("--stats")) {
    showStats(sourceDb, targetDb);
    sourceDb.close();
    targetDb.close();
    process.exit(0);
  }

  // Ensure target has access_count column
  try {
    targetDb.run("ALTER TABLE facts ADD COLUMN access_count INTEGER DEFAULT 0");
  } catch { /* already exists */ }

  const sinceTs = syncAll ? 0 : Date.now() - lookbackMs;
  const excludeDecayPlaceholders = EXCLUDED_DECAY.map(() => "?").join(",");
  const excludeEntityPlaceholders = EXCLUDED_ENTITIES.map(() => "?").join(",");

  const candidates = sourceDb.query(`
    SELECT id, persona, entity, key, value, text, category, decay_class,
           importance, source, created_at, expires_at, confidence, metadata
    FROM facts
    WHERE created_at > ?
      AND confidence >= ?
      AND decay_class NOT IN (${excludeDecayPlaceholders})
      AND entity NOT IN (${excludeEntityPlaceholders})
    ORDER BY confidence DESC, importance DESC
    LIMIT ?
  `).all(
    sinceTs,
    minConfidence,
    ...EXCLUDED_DECAY,
    ...EXCLUDED_ENTITIES,
    MAX_SYNC_PER_RUN * 3 // fetch extra to account for dedup filtering
  ) as any[];

  log(`Source: ${sourcePath}`);
  log(`Target: ${targetPath}`);
  log(`Lookback: ${syncAll ? "ALL" : `${lookbackMs / 3600_000}h`} | Min confidence: ${minConfidence}`);
  log(`Candidates found: ${candidates.length}`);

  // Build dedup set from target: (entity, key, value) normalized
  const existingKeys = new Set<string>();
  const existingRows = targetDb.query("SELECT entity, key, value FROM facts").all() as any[];
  for (const row of existingRows) {
    existingKeys.add(`${row.entity}|${row.key}|${(row.value || "").slice(0, 200)}`);
  }

  const insertStmt = targetDb.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                       importance, source, created_at, expires_at, confidence, metadata, access_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);

  let synced = 0;
  let skippedDup = 0;
  let skippedLimit = 0;
  const syncedFacts: string[] = [];

  const transaction = targetDb.transaction(() => {
    for (const fact of candidates) {
      if (synced >= MAX_SYNC_PER_RUN) {
        skippedLimit = candidates.length - synced - skippedDup;
        break;
      }

      const dedupKey = `${fact.entity}|${fact.key}|${(fact.value || "").slice(0, 200)}`;
      if (existingKeys.has(dedupKey)) {
        skippedDup++;
        if (verbose) log(`  SKIP (dup): ${fact.entity}/${fact.key}`);
        continue;
      }

      const newId = randomUUID();
      const source = `cross-db-sync:${sourcePath.split("/").pop()}:${fact.id}`;

      if (!dryRun) {
        insertStmt.run(
          newId,
          fact.persona || "shared",
          fact.entity,
          fact.key,
          fact.value,
          fact.text,
          fact.category || "fact",
          fact.decay_class || "stable",
          fact.importance ?? 1.0,
          source,
          Date.now(),
          fact.expires_at,
          fact.confidence ?? 1.0,
          fact.metadata
        );
      }

      existingKeys.add(dedupKey);
      synced++;
      syncedFacts.push(`${fact.entity}/${fact.key}: ${(fact.value || "").slice(0, 80)}`);
      if (verbose) log(`  SYNC: ${fact.entity}/${fact.key} (confidence=${fact.confidence})`);
    }
  });

  if (!dryRun) {
    transaction();
  } else {
    // Still run the loop logic without transaction for dry-run preview
    for (const fact of candidates) {
      if (synced >= MAX_SYNC_PER_RUN) { skippedLimit = candidates.length - synced - skippedDup; break; }
      const dedupKey = `${fact.entity}|${fact.key}|${(fact.value || "").slice(0, 200)}`;
      if (existingKeys.has(dedupKey)) { skippedDup++; continue; }
      existingKeys.add(dedupKey);
      synced++;
      syncedFacts.push(`${fact.entity}/${fact.key}: ${(fact.value || "").slice(0, 80)}`);
    }
  }

  log(`\nResults${dryRun ? " (DRY RUN)" : ""}:`);
  log(`  Synced:      ${synced}`);
  log(`  Skipped dup: ${skippedDup}`);
  if (skippedLimit > 0) log(`  Skipped cap: ${skippedLimit}`);

  if (synced > 0 && syncedFacts.length <= 20) {
    log(`\nSynced facts:`);
    for (const f of syncedFacts) log(`  • ${f}`);
  } else if (synced > 20) {
    log(`\nFirst 20 synced facts:`);
    for (const f of syncedFacts.slice(0, 20)) log(`  • ${f}`);
    log(`  ... and ${synced - 20} more`);
  }

  sourceDb.close();
  targetDb.close();

  log(`\nDone.`);
}

main();
