#!/usr/bin/env bun
/**
 * graph-boost.ts — Associative Graph Boost for Hybrid Search
 *
 * Queries fact_links AND vault_links for 1-hop neighbors of search results and adjusts
 * composite scores. Imported by memory.ts to enhance hybrid search.
 *
 * Scoring redistribution when graph links exist:
 *   RRF(0.60) + GraphBoost(0.15) + Freshness(0.15) + Confidence(0.10)
 *
 * When no links exist for any result, returns original scores unchanged.
 */

import { Database } from "bun:sqlite";

/** Cache whether vault_links table exists to avoid repeated schema queries. */
let _vaultLinksExists: boolean | null = null;

function hasVaultLinks(db: Database): boolean {
  if (_vaultLinksExists !== null) return _vaultLinksExists;
  try {
    const row = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vault_links' LIMIT 1"
    ).get();
    _vaultLinksExists = !!row;
  } catch {
    _vaultLinksExists = false;
  }
  return _vaultLinksExists;
}

interface ScoredResult {
  id: string;
  rrfScore: number;
  freshness: number;
  confidence: number;
  sources: string[];
}

type BoostedResult<T extends ScoredResult> = T & {
  graphBoost: number;
  composite: number;
};

interface FactLink {
  source_id: string;
  target_id: string;
  relation: string;
  weight: number;
}

/** Unified neighbor type returned by multi-hop graph expansion. */
export interface GraphNeighbor {
  id: string;
  type: "fact" | "vault_file";
  weight: number;
  hop: number;
  // For facts:
  entity?: string;
  value?: string;
  // For vault_files:
  file_path?: string;
  title?: string;
}

/**
 * Compute graph-boosted composite scores for hybrid search results.
 *
 * For each result, queries fact_links for 1-hop neighbors.
 * If a neighbor is also in the result set, both get a graph boost.
 *
 * @param db - SQLite database handle
 * @param results - Scored results from RRF fusion (pre-composite)
 * @returns Results with graphBoost and reweighted composite scores
 */
export function computeGraphBoost<T extends ScoredResult>(db: Database, results: T[]): BoostedResult<T>[] {
  if (results.length === 0) return [];

  const resultIds = new Set(results.map(r => r.id));

  // Batch-query all links where source OR target is in our result set
  const placeholders = results.map(() => "?").join(",");
  const ids = results.map(r => r.id);
  const baseSQL = `SELECT source_id, target_id, relation, weight FROM fact_links WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`;
  const sql = hasVaultLinks(db)
    ? `${baseSQL} UNION ALL SELECT source_id, target_id, relation, weight FROM vault_links WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`
    : baseSQL;
  const params = hasVaultLinks(db) ? [...ids, ...ids, ...ids, ...ids] : [...ids, ...ids];
  const links = db.prepare(sql).all(...params) as FactLink[];

  // If no links exist for any result, return with original scoring weights
  if (links.length === 0) {
    return results.map(r => ({
      ...r,
      graphBoost: 0,
      composite: r.rrfScore * 0.7 + r.freshness * 0.2 + r.confidence * 0.1,
    }));
  }

  // Build adjacency: for each result id, accumulate boost from linked results
  const boostMap = new Map<string, number>();

  for (const link of links) {
    const { source_id, target_id, weight } = link;

    // Boost target if source is in results (and target is too)
    if (resultIds.has(source_id) && resultIds.has(target_id)) {
      boostMap.set(target_id, (boostMap.get(target_id) || 0) + weight);
      boostMap.set(source_id, (boostMap.get(source_id) || 0) + weight * 0.5); // Smaller reverse boost
    }
    // If only one side is in results, give a small boost to the one that is
    else if (resultIds.has(source_id)) {
      boostMap.set(source_id, (boostMap.get(source_id) || 0) + weight * 0.3);
    } else if (resultIds.has(target_id)) {
      boostMap.set(target_id, (boostMap.get(target_id) || 0) + weight * 0.3);
    }
  }

  // Normalize boost values to [0, 1]
  const maxBoost = Math.max(...Array.from(boostMap.values()), 1);

  return results.map(r => {
    const rawBoost = boostMap.get(r.id) || 0;
    const graphBoost = Math.min(rawBoost / maxBoost, 1.0);

    // Reweighted composite: RRF(0.70) + Graph(0.05) + Freshness(0.15) + Confidence(0.10)
    const composite = r.rrfScore * 0.7 + graphBoost * 0.05 + r.freshness * 0.15 + r.confidence * 0.1;

    return {
      ...r,
      graphBoost,
      composite,
    };
  });
}

/**
 * Inject graph-discovered neighbors into the result set.
 *
 * For top-N results, finds 1-hop neighbors that are NOT already in results
 * but are valid (non-expired) facts. Injects them with a graph-only score.
 *
 * @param db - SQLite database handle
 * @param topIds - IDs of top results to find neighbors for
 * @param existingIds - IDs already in the result set
 * @param maxInject - Maximum number of neighbors to inject
 * @returns Array of neighbor fact IDs with their link metadata
 */
export function findGraphNeighbors(
  db: Database,
  topIds: string[],
  existingIds: Set<string>,
  maxInject: number = 3
): Array<{ factId: string; linkedFrom: string; relation: string; weight: number }> {
  if (topIds.length === 0) return [];

  const nowSec = Math.floor(Date.now() / 1000);
  const placeholders = topIds.map(() => "?").join(",");

  const baseNeighborSQL = `
    SELECT fl.source_id, fl.target_id, fl.relation, fl.weight
    FROM fact_links fl
    JOIN facts f ON (
      CASE WHEN fl.source_id IN (${placeholders}) THEN fl.target_id ELSE fl.source_id END
    ) = f.id
    WHERE (fl.source_id IN (${placeholders}) OR fl.target_id IN (${placeholders}))
      AND (f.expires_at IS NULL OR f.expires_at > ?)`;
  const neighborSQL = hasVaultLinks(db)
    ? `${baseNeighborSQL} UNION ALL SELECT vl.source_id, vl.target_id, vl.relation, vl.weight FROM vault_links vl JOIN facts f2 ON (CASE WHEN vl.source_id IN (${placeholders}) THEN vl.target_id ELSE vl.source_id END) = f2.id WHERE (vl.source_id IN (${placeholders}) OR vl.target_id IN (${placeholders})) AND (f2.expires_at IS NULL OR f2.expires_at > ?) ORDER BY weight DESC LIMIT ?`
    : `${baseNeighborSQL} ORDER BY fl.weight DESC LIMIT ?`;
  const neighborParams = hasVaultLinks(db)
    ? [...topIds, ...topIds, ...topIds, nowSec, ...topIds, ...topIds, ...topIds, nowSec, maxInject * 3]
    : [...topIds, ...topIds, ...topIds, nowSec, maxInject * 3];
  const neighbors = db.prepare(neighborSQL).all(...neighborParams) as FactLink[];

  const injected: Array<{ factId: string; linkedFrom: string; relation: string; weight: number }> = [];

  for (const link of neighbors) {
    if (injected.length >= maxInject) break;

    // Determine which side is the neighbor (not in topIds)
    const isSourceTop = topIds.includes(link.source_id);
    const neighborId = isSourceTop ? link.target_id : link.source_id;
    const linkedFrom = isSourceTop ? link.source_id : link.target_id;

    // Skip if already in results or already injected
    if (existingIds.has(neighborId) || injected.some(i => i.factId === neighborId)) continue;

    injected.push({
      factId: neighborId,
      linkedFrom,
      relation: link.relation,
      weight: link.weight,
    });
  }

  return injected;
}

// ---------------------------------------------------------------------------
// Enhanced multi-hop neighbor expansion with vault_files support (T4)
// ---------------------------------------------------------------------------

const MAX_EXPANDED_NODES = 20;
const BFS_TIMEOUT_MS = 150;
const MAX_DEPTH_LIMIT = 2;

/**
 * Resolve metadata for a single node ID.
 * IDs prefixed with 'vf-' are looked up in vault_files; all others in facts.
 */
function resolveNode(
  db: Database,
  id: string,
  weight: number,
  hop: number,
): GraphNeighbor | null {
  if (id.startsWith("vf-")) {
    const row = db.prepare(
      "SELECT id, file_path, title FROM vault_files WHERE id = ?"
    ).get(id) as { id: string; file_path: string; title: string | null } | null;
    if (!row) return null;
    return { id: row.id, type: "vault_file", weight, hop, file_path: row.file_path, title: row.title ?? undefined };
  }

  const row = db.prepare(
    "SELECT id, entity, value FROM facts WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).get(id, Math.floor(Date.now() / 1000)) as { id: string; entity: string; value: string } | null;
  if (!row) return null;
  return { id: row.id, type: "fact", weight, hop, entity: row.entity, value: row.value };
}

/**
 * Multi-hop BFS neighbor expansion with vault_files support.
 *
 * Traverses fact_links up to `maxDepth` hops (default 1, max 2) from the
 * supplied seed IDs, discovering both facts and vault_files neighbours.
 *
 * Performance guards:
 *  - Stops after 150 ms wall-clock time
 *  - Caps total expanded nodes at 20
 *
 * @param db        - SQLite database handle
 * @param seedIds   - Starting node IDs (facts or vault_files)
 * @param excludeIds - IDs to skip (e.g. already in result set)
 * @param maxDepth  - Maximum BFS depth (default 1, clamped to 2)
 * @returns Array of GraphNeighbor objects annotated with hop distance
 */
export function findGraphNeighborsDeep(
  db: Database,
  seedIds: string[],
  excludeIds: Set<string> = new Set(),
  maxDepth: number = 1,
): GraphNeighbor[] {
  if (seedIds.length === 0) return [];

  const depth = Math.max(1, Math.min(maxDepth, MAX_DEPTH_LIMIT));
  const startTime = performance.now();

  // Visited set includes seeds so we never revisit them
  const visited = new Set<string>(seedIds);
  for (const id of excludeIds) visited.add(id);

  const results: GraphNeighbor[] = [];

  // BFS frontier: [nodeId, currentHop]
  let frontier: Array<[string, number]> = seedIds.map(id => [id, 0]);

  while (frontier.length > 0) {
    // Performance guard: timeout
    if (performance.now() - startTime > BFS_TIMEOUT_MS) break;
    // Performance guard: node cap
    if (results.length >= MAX_EXPANDED_NODES) break;

    const nextFrontier: Array<[string, number]> = [];

    for (const [nodeId, hop] of frontier) {
      if (performance.now() - startTime > BFS_TIMEOUT_MS) break;
      if (results.length >= MAX_EXPANDED_NODES) break;

      // Query links where this node is source or target (fact_links + vault_links)
      const bfsBase = `SELECT source_id, target_id, weight FROM fact_links WHERE source_id = ? OR target_id = ?`;
      const bfsSQL = hasVaultLinks(db)
        ? `${bfsBase} UNION ALL SELECT source_id, target_id, weight FROM vault_links WHERE source_id = ? OR target_id = ? ORDER BY weight DESC`
        : `${bfsBase} ORDER BY weight DESC`;
      const bfsParams = hasVaultLinks(db) ? [nodeId, nodeId, nodeId, nodeId] : [nodeId, nodeId];
      const links = db.prepare(bfsSQL).all(...bfsParams) as Array<{ source_id: string; target_id: string; weight: number }>;

      for (const link of links) {
        if (results.length >= MAX_EXPANDED_NODES) break;

        const neighborId = link.source_id === nodeId ? link.target_id : link.source_id;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborHop = hop + 1;
        const resolved = resolveNode(db, neighborId, link.weight, neighborHop);
        if (resolved) {
          results.push(resolved);
        }

        // Continue BFS only if we haven't hit max depth
        if (neighborHop < depth) {
          nextFrontier.push([neighborId, neighborHop]);
        }
      }
    }

    frontier = nextFrontier;
  }

  return results;
}
