#!/usr/bin/env bun
/**
 * graph-traversal.ts — Enhanced Knowledge Graph Traversal
 * MEM-105: Enhanced Knowledge Graph
 *
 * Usage:
 *   bun graph-traversal.ts ancestors --entity <name>
 *   bun graph-traversal.ts descendants --entity <name>
 *   bun graph-traversal.ts cycles
 *   bun graph-traversal.ts infer --entity <name>
 *   bun graph-traversal.ts export-dot --entity <name> --output /tmp/graph.dot
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS relation_types (
      relation TEXT PRIMARY KEY,
      description TEXT,
      inverse TEXT,
      directed INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    INSERT OR IGNORE INTO relation_types (relation, description, inverse, directed, category) VALUES
      ('depends_on', 'A requires B', 'required_by', 1, 'dependency'),
      ('supersedes', 'A replaces B', 'superseded_by', 1, 'temporal'),
      ('caused_by', 'A was caused by B', 'causes', 1, 'causal'),
      ('part_of', 'A is part of B', 'contains', 0, 'structural'),
      ('related_to', 'A is related to B', 'related_to', 0, 'general'),
      ('implements', 'A implements B', 'implemented_by', 1, 'dependency'),
      ('blocks', 'A blocks B', 'blocked_by', 1, 'dependency');
    CREATE TABLE IF NOT EXISTS graph_cycles (
      id TEXT PRIMARY KEY,
      entity_chain TEXT NOT NULL,
      cycle_length INTEGER NOT NULL,
      detected_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_graph_cycles_detected ON graph_cycles(detected_at);
  `);
  return db;
}

export const KNOWN_RELATIONS = new Set([
  "depends_on", "required_by", "supersedes", "superseded_by",
  "caused_by", "causes", "part_of", "contains", "related_to",
  "implements", "implemented_by", "blocks", "blocked_by",
]);

export function getAncestors(db: Database, entity: string, maxDepth = 10): Array<{ entity: string; relation: string; depth: number; path: string[] }> {
  const result: Array<{ entity: string; relation: string; depth: number; path: string[] }> = [];
  const visited = new Set<string>();
  const queue: Array<{ entity: string; depth: number; path: string[] }> = [{ entity, depth: 0, path: [entity] }];
  visited.add(entity);

  while (queue.length > 0) {
    const { entity: current, depth, path } = queue.shift()!;
    if (depth >= maxDepth) continue;

    // Get all incoming links (things this entity depends on / is caused by / etc.)
    const rows = db.prepare(`
      SELECT f.entity, fl.relation, f.id FROM fact_links fl
      JOIN facts f ON fl.source_id = f.id
      WHERE fl.target_id = (SELECT MIN(id) FROM facts WHERE entity = ? AND expires_at IS NULL LIMIT 1)
    `).all(current) as Array<Record<string, unknown>>;

    // Also check via entity name directly
    const inbound = db.prepare(`
      SELECT f.entity, fl.relation FROM fact_links fl
      JOIN facts f ON fl.source_id = f.id
      JOIN facts tf ON fl.target_id = tf.id
      WHERE tf.entity = ?
    `).all(current) as Array<Record<string, unknown>>;

    const combined = [...rows, ...inbound];
    for (const row of combined) {
      const nextEntity = row.entity as string;
      if (visited.has(nextEntity)) continue;
      visited.add(nextEntity);
      result.push({ entity: nextEntity, relation: row.relation as string, depth: depth + 1, path: [...path, nextEntity] });
      queue.push({ entity: nextEntity, depth: depth + 1, path: [...path, nextEntity] });
    }
  }
  return result;
}

export function getDescendants(db: Database, entity: string, maxDepth = 10): Array<{ entity: string; relation: string; depth: number; path: string[] }> {
  const result: Array<{ entity: string; relation: string; depth: number; path: string[] }> = [];
  const visited = new Set<string>();
  const queue: Array<{ entity: string; depth: number; path: string[] }> = [{ entity, depth: 0, path: [entity] }];
  visited.add(entity);

  while (queue.length > 0) {
    const { entity: current, depth, path } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const outbound = db.prepare(`
      SELECT f.entity, fl.relation FROM fact_links fl
      JOIN facts f ON fl.target_id = f.id
      JOIN facts sf ON fl.source_id = sf.id
      WHERE sf.entity = ?
    `).all(current) as Array<Record<string, unknown>>;

    for (const row of outbound) {
      const nextEntity = row.entity as string;
      if (visited.has(nextEntity)) continue;
      visited.add(nextEntity);
      result.push({ entity: nextEntity, relation: row.relation as string, depth: depth + 1, path: [...path, nextEntity] });
      queue.push({ entity: nextEntity, depth: depth + 1, path: [...path, nextEntity] });
    }
  }
  return result;
}

export function detectCycles(db: Database): Array<{ cycle: string[]; length: number }> {
  const allLinks = db.prepare("SELECT source_id, target_id FROM fact_links").all() as Array<{ source_id: string; target_id: string }>;
  if (allLinks.length === 0) return [];

  const adj = new Map<string, Set<string>>();
  for (const { source_id, target_id } of allLinks) {
    if (!adj.has(source_id)) adj.set(source_id, new Set());
    adj.get(source_id)!.add(target_id);
  }

  const cycles: Array<{ cycle: string[]; length: number }> = [];
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, path);
      } else if (recStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cycle = path.slice(cycleStart);
          cycles.push({ cycle, length: cycle.length });
        }
      }
    }
    path.pop();
    recStack.delete(node);
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node, []);
  }

  // Deduplicate symmetric cycles
  const seen = new Set<string>();
  return cycles.filter(c => {
    const key = c.cycle.join("->");
    const rev = [...c.cycle].reverse().join("->");
    if (seen.has(key) || seen.has(rev)) return false;
    seen.add(key);
    return true;
  });
}

export function inferRelations(db: Database, entity: string): Array<{ from: string; to: string; inferred_relation: string; confidence: number; reason: string }> {
  // Find facts with the same entity appearing in episodes together
  const episodeRows = db.prepare(`
    SELECT DISTINCT e.id FROM episodes e
    JOIN episode_entities ee ON e.id = ee.episode_id
    WHERE ee.entity = ?
  `).all(entity) as Array<{ id: string }>;

  if (episodeRows.length === 0) return [];

  const episodeIds = episodeRows.map(r => r.id);
  const placeholders = episodeIds.map(() => "?").join(",");
  const coEntities = db.prepare(`
    SELECT DISTINCT ee2.entity, COUNT(DISTINCT ee2.episode_id) as co_occurrences
    FROM episode_entities ee1
    JOIN episode_entities ee2 ON ee1.episode_id = ee2.episode_id
    WHERE ee1.entity = ? AND ee2.entity != ? AND ee2.episode_id IN (${placeholders})
    GROUP BY ee2.entity
    ORDER BY co_occurrences DESC
    LIMIT 10
  `).all(entity, entity, ...episodeIds) as Array<{ entity: string; co_occurrences: number }>;

  const totalEpisodes = episodeRows.length;
  return coEntities.map(r => ({
    from: entity,
    to: r.entity,
    inferred_relation: "related_to",
    confidence: r.co_occurrences / totalEpisodes,
    reason: `Co-occurs in ${r.co_occurrences} episode(s) with "${entity}"`,
  }));
}

export function exportDot(db: Database, entity?: string, outputPath?: string): string {
  let links;
  if (entity) {
    const rows = db.prepare(`
      SELECT fl.*, sf.entity as src_entity, tf.entity as tgt_entity
      FROM fact_links fl
      JOIN facts sf ON fl.source_id = sf.id
      JOIN facts tf ON fl.target_id = tf.id
      WHERE sf.entity = ? OR tf.entity = ?
    `).all(entity, entity) as Array<Record<string, unknown>>;
    links = rows;
  } else {
    const rows = db.prepare(`
      SELECT fl.*, sf.entity as src_entity, tf.entity as tgt_entity
      FROM fact_links fl
      JOIN facts sf ON fl.source_id = sf.id
      JOIN facts tf ON fl.target_id = tf.id
    `).all() as Array<Record<string, unknown>>;
    links = rows;
  }

  const nodes = new Set<string>();
  for (const l of links as Array<Record<string, unknown>>) {
    nodes.add(l.src_entity as string);
    nodes.add(l.tgt_entity as string);
  }

  const lines = ["digraph memory_graph {", "  rankdir=LR;", "  node [shape=box];"];
  for (const node of nodes) lines.push(`  "${node}" [label="${node}"];`);
  for (const l of links as Array<Record<string, unknown>>) {
    lines.push(`  "${l.src_entity}" -> "${l.tgt_entity}" [label="${l.relation}"];`);
  }
  lines.push("}");

  const dot = lines.join("\n");
  if (outputPath) { writeFileSync(outputPath, dot); }
  return dot;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Graph Traversal CLI\n\nCommands:\n  ancestors --entity <name>   Find all upstream dependencies\n  descendants --entity <name> Find all downstream dependents\n  cycles                    Detect dependency cycles\n  infer --entity <name>      Infer new relations from co-occurrence\n  export-dot --entity <name> --output <path>  Export to DOT format");
    process.exit(0);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i + 1] || "";
  const command = args[0];
  const db = getDb();

  if (command === "ancestors") {
    if (!flags.entity) { console.error("--entity required"); process.exit(1); }
    const ancestors = getAncestors(db, flags.entity);
    if (ancestors.length === 0) { console.log(`No ancestors for "${flags.entity}".`); }
    else { ancestors.forEach(a => console.log(`  ${"  ".repeat(a.depth - 1)}--${a.relation}--> ${a.entity}`)); }
  }
  else if (command === "descendants") {
    if (!flags.entity) { console.error("--entity required"); process.exit(1); }
    const descendants = getDescendants(db, flags.entity);
    if (descendants.length === 0) { console.log(`No descendants for "${flags.entity}".`); }
    else { descendants.forEach(d => console.log(`  ${"  ".repeat(d.depth - 1)}${d.entity} --${d.relation}-->`)); }
  }
  else if (command === "cycles") {
    const cycles = detectCycles(db);
    if (cycles.length === 0) { console.log("No cycles detected."); }
    else { console.log(`${cycles.length} cycle(s) found:\n`); cycles.forEach((c, i) => console.log(`  ${i + 1}. ${c.cycle.join(" → ")} (${c.length} hops)`)); }
  }
  else if (command === "infer") {
    if (!flags.entity) { console.error("--entity required"); process.exit(1); }
    const inferred = inferRelations(db, flags.entity);
    if (inferred.length === 0) { console.log("No inferred relations."); }
    else { inferred.forEach(r => console.log(`  ${r.from} --${r.inferred_relation}--> ${r.to} (${(r.confidence * 100).toFixed(0)}% conf)\n    ${r.reason}`)); }
  }
  else if (command === "export-dot") {
    const dot = exportDot(db, flags.entity || undefined, flags.output);
    if (flags.output) console.log(`Exported to ${flags.output}`);
    else console.log(dot);
  }
  db.close();
}

if (import.meta.main) main();