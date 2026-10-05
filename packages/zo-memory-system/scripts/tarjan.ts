#!/usr/bin/env bun
/**
 * tarjan.ts — Articulation Point Detection for Knowledge Graph
 *
 * Tarjan's algorithm finds nodes whose removal would disconnect the graph.
 * Applied to open loops: critical blockers that bridge workstreams are protected from decay.
 *
 * Algorithm: O(V + E) time, O(V) space
 * Reference: Tarjan, R. E. (1972). Depth-first search and linear graph algorithms.
 */

import { Database } from "bun:sqlite";

export interface ArticulationPoint {
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  bridges: number; // Number of disconnected components if removed
}

export interface GraphNode {
  id: string;
  entity: string;
  key: string | null;
  value: string;
}

/**
 * Build adjacency list from fact_links table
 * Treats graph as undirected for articulation point detection
 */
export function buildAdjacencyList(db: Database): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();

  // Get all facts that have links
  const linkedFacts = db.prepare(`
    SELECT DISTINCT f.id, f.entity, f.key, f.value
    FROM facts f
    WHERE f.id IN (SELECT source_id FROM fact_links)
       OR f.id IN (SELECT target_id FROM fact_links)
  `).all() as Array<{ id: string; entity: string; key: string | null; value: string }>;

  for (const fact of linkedFacts) {
    adj.set(fact.id, new Set());
  }

  // Add undirected edges
  const links = db.prepare("SELECT source_id, target_id FROM fact_links").all() as Array<{ source_id: string; target_id: string }>;

  for (const link of links) {
    if (adj.has(link.source_id) && adj.has(link.target_id)) {
      adj.get(link.source_id)!.add(link.target_id);
      adj.get(link.target_id)!.add(link.source_id);
    }
  }

  return adj;
}

/**
 * Tarjan's articulation point algorithm
 * Returns set of fact IDs that are articulation points
 */
export function findArticulationPoints(adj: Map<string, Set<string>>): Set<string> {
  const articulationPoints = new Set<string>();
  const visited = new Set<string>();
  const discovery = new Map<string, number>(); // Discovery times
  const low = new Map<string, number>(); // Lowest reachable discovery time
  const parent = new Map<string, string | null>();

  let time = 0;

  function dfs(node: string) {
    visited.add(node);
    discovery.set(node, time);
    low.set(node, time);
    time++;

    let children = 0;

    for (const neighbor of adj.get(node) || []) {
      if (!visited.has(neighbor)) {
        children++;
        parent.set(neighbor, node);
        dfs(neighbor);

        // Check if subtree rooted at neighbor has back edge to ancestor of node
        low.set(node, Math.min(low.get(node)!, low.get(neighbor)!));

        // Node is articulation point if:
        // 1. It's root and has 2+ children
        // 2. It's not root and low[neighbor] >= discovery[node]
        const nodeParent = parent.get(node);
        if ((nodeParent === null && children > 1) ||
            (nodeParent !== null && low.get(neighbor)! >= discovery.get(node)!)) {
          articulationPoints.add(node);
        }
      } else if (neighbor !== parent.get(node)) {
        // Back edge found, update low value
        low.set(node, Math.min(low.get(node)!, discovery.get(neighbor)!));
      }
    }
  }

  // Handle disconnected components
  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      parent.set(node, null);
      dfs(node);
    }
  }

  return articulationPoints;
}

/**
 * Get detailed information about articulation points
 */
export function getArticulationPointDetails(
  db: Database,
  adj: Map<string, Set<string>>
): ArticulationPoint[] {
  const articulationIds = findArticulationPoints(adj);

  if (articulationIds.size === 0) return [];

  const placeholders = Array.from(articulationIds).map(() => "?").join(",");
  const facts = db.prepare(`
    SELECT id, entity, key, value FROM facts WHERE id IN (${placeholders})
  `).all(...Array.from(articulationIds)) as Array<{ id: string; entity: string; key: string | null; value: string }>;

  // Calculate bridges count for each articulation point
  return facts.map(fact => {
    const neighbors = adj.get(fact.id) || new Set();
    const bridges = countDisconnectedComponents(adj, fact.id);

    return {
      factId: fact.id,
      entity: fact.entity,
      key: fact.key,
      value: fact.value,
      bridges,
    };
  }).sort((a, b) => b.bridges - a.bridges); // Most critical first
}

/**
 * Count how many components would be disconnected if node is removed
 * For a star graph center: returns leaf count (each leaf becomes its own component)
 */
function countDisconnectedComponents(adj: Map<string, Set<string>>, removeNode: string): number {
  const neighbors = adj.get(removeNode);
  if (!neighbors || neighbors.size === 0) return 0;

  // Build a subgraph without the removed node
  const visited = new Set<string>();
  let components = 0;

  // For each neighbor, check if it's in a new component
  for (const startNode of neighbors) {
    if (visited.has(startNode)) continue;

    // Found a new component
    components++;
    const queue = [startNode];
    visited.add(startNode);

    // BFS to mark all reachable nodes in this component
    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const neighbor of adj.get(current) || []) {
        if (neighbor !== removeNode && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  return components;
}

/**
 * Check if a specific fact is an articulation point
 */
export function isArticulationPoint(factId: string, adj: Map<string, Set<string>>): boolean {
  if (!adj.has(factId)) return false;

  const articulationPoints = findArticulationPoints(adj);
  return articulationPoints.has(factId);
}

/**
 * Get articulation points related to an entity
 * Useful for checking if an open loop (which may reference an entity) is critical
 */
export function getEntityArticulationPoints(
  db: Database,
  entity: string
): ArticulationPoint[] {
  const adj = buildAdjacencyList(db);
  const allArticulationPoints = getArticulationPointDetails(db, adj);

  // Get all facts for this entity
  const entityFacts = db.prepare("SELECT id FROM facts WHERE entity = ?").all(entity) as Array<{ id: string }>;
  const entityFactIds = new Set(entityFacts.map(f => f.id));

  return allArticulationPoints.filter(ap => entityFactIds.has(ap.factId));
}

/**
 * CLI for testing and debugging
 */
function printUsage() {
  console.log(`
zo-memory-system tarjan — Articulation Point Detection

Usage:
  bun tarjan.ts <command> [options]

Commands:
  analyze              Find all articulation points in the knowledge graph
  check --id <id>      Check if a specific fact is an articulation point
  entity --name <n>    Find articulation points for an entity

Options:
  --id <fact-id>       Fact ID to check
  --name <entity>      Entity name to analyze

Examples:
  bun tarjan.ts analyze
  bun tarjan.ts check --id abc123
  bun tarjan.ts entity --name "project.ffb-site"
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

  switch (command) {
    case "analyze": {
      const adj = buildAdjacencyList(db);
      const articulationPoints = getArticulationPointDetails(db, adj);

      if (articulationPoints.length === 0) {
        console.log("No articulation points found. Graph would remain connected if any single node is removed.");
        break;
      }

      console.log(`Found ${articulationPoints.length} articulation point(s):\n`);
      console.log("Ranked by criticality (bridges created if removed):\n");

      for (const ap of articulationPoints) {
        console.log(`  [${ap.entity}.${ap.key || "_"}]`);
        console.log(`    ID: ${ap.factId}`);
        console.log(`    Value: "${ap.value.slice(0, 60)}${ap.value.length > 60 ? "..." : ""}"`);
        console.log(`    Bridges if removed: ${ap.bridges}`);
        console.log();
      }
      break;
    }

    case "check": {
      if (!flags.id) {
        console.error("Error: --id is required");
        process.exit(1);
      }

      const adj = buildAdjacencyList(db);
      const isAP = isArticulationPoint(flags.id, adj);

      const fact = db.prepare("SELECT entity, key, value FROM facts WHERE id = ?").get(flags.id) as
        | { entity: string; key: string | null; value: string }
        | null;

      if (!fact) {
        console.error(`Fact not found: ${flags.id}`);
        process.exit(1);
      }

      console.log(`\n[${fact.entity}.${fact.key || "_"}] "${fact.value.slice(0, 60)}"`);
      console.log(`\nIs articulation point: ${isAP ? "YES ⚠️" : "NO"}`);

      if (isAP) {
        const bridges = countDisconnectedComponents(adj, flags.id);
        console.log(`Would disconnect ${bridges} component(s) if removed.`);
      }
      break;
    }

    case "entity": {
      if (!flags.name) {
        console.error("Error: --name is required");
        process.exit(1);
      }

      const aps = getEntityArticulationPoints(db, flags.name);

      if (aps.length === 0) {
        console.log(`\nNo articulation points found for entity: ${flags.name}`);
        console.log("Facts for this entity can be safely removed without disconnecting the graph.");
        break;
      }

      console.log(`\nFound ${aps.length} articulation point(s) for entity "${flags.name}":\n`);
      for (const ap of aps) {
        console.log(`  [${ap.entity}.${ap.key || "_"}]`);
        console.log(`    ID: ${ap.factId}`);
        console.log(`    Value: "${ap.value.slice(0, 60)}${ap.value.length > 60 ? "..." : ""}"`);
        console.log(`    Bridges if removed: ${ap.bridges}`);
        console.log();
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
