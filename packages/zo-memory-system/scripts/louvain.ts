#!/usr/bin/env bun
/**
 * louvain.ts — Louvain Community Detection for Knowledge Graphs
 *
 * The Louvain algorithm detects communities (clusters) in large networks
 * by optimizing modularity. It's fast (O(n log n)) and works well for
 * knowledge graphs where communities represent related knowledge domains.
 *
 * Algorithm phases:
 * 1. Each node starts in its own community
 * 2. For each node, try moving to neighbor communities; keep if modularity improves
 * 3. Build new graph where communities become nodes
 * 4. Repeat until no improvement
 *
 * Reference: Blondel, V. D., et al. (2008). Fast unfolding of communities
 *            in large networks. Journal of Statistical Mechanics: Theory
 *            and Experiment, 2008(10), P10008.
 */

import { Database } from "bun:sqlite";

export interface Community {
  id: number;
  members: string[]; // Fact IDs
  size: number;
  internalEdges: number;
  externalEdges: number;
  modularityContribution: number;
  entities: Map<string, number>; // Entity -> count
  topEntities: Array<{ entity: string; count: number }>;
  keywords: string[];
}

export interface CommunityAssignment {
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  communityId: number;
}

export interface LouvainResult {
  communities: Map<number, Community>;
  assignments: Map<string, number>; // Fact ID -> Community ID
  modularity: number;
  iterations: number;
  levels: number; // Number of hierarchical levels
}

// Algorithm parameters
export const DEFAULT_PARAMS = {
  resolution: 1.0,      // Resolution parameter (higher = more/smaller communities)
  minCommunitySize: 3,  // Minimum community size to report
  maxIterations: 100,   // Max iterations per level
  minModularityGain: 0.000001, // Convergence threshold
};

export interface LouvainParams {
  resolution: number;
  minCommunitySize: number;
  maxIterations: number;
  minModularityGain: number;
}

/**
 * Build weighted graph from fact_links
 */
function buildGraph(db: Database): {
  nodes: Set<string>;
  edges: Map<string, Map<string, number>>;
  nodeWeights: Map<string, number>;
  totalWeight: number;
} {
  const nodes = new Set<string>();
  const edges = new Map<string, Map<string, number>>();
  const nodeWeights = new Map<string, number>();
  let totalWeight = 0;
  
  // Get all facts
  const facts = db.prepare("SELECT id FROM facts").all() as Array<{ id: string }>;
  for (const f of facts) {
    nodes.add(f.id);
    edges.set(f.id, new Map());
    nodeWeights.set(f.id, 0);
  }
  
  // Get all links (treat as undirected, sum weights)
  const links = db.prepare(`
    SELECT source_id, target_id, weight 
    FROM fact_links
  `).all() as Array<{ source_id: string; target_id: string; weight: number }>;
  
  for (const link of links) {
    const weight = link.weight || 1.0;
    
    // Skip orphaned links (target or source not in facts table)
    const sourceEdges = edges.get(link.source_id);
    const targetEdges = edges.get(link.target_id);
    if (!sourceEdges || !targetEdges) continue;
    
    // Add edge source -> target
    const existingWeight = sourceEdges.get(link.target_id) || 0;
    sourceEdges.set(link.target_id, existingWeight + weight);
    
    // Add edge target -> source
    const reverseWeight = targetEdges.get(link.source_id) || 0;
    targetEdges.set(link.source_id, reverseWeight + weight);
    
    // Update node weights (each edge contributes to both nodes)
    nodeWeights.set(link.source_id, (nodeWeights.get(link.source_id) || 0) + weight);
    nodeWeights.set(link.target_id, (nodeWeights.get(link.target_id) || 0) + weight);
    
    totalWeight += weight * 2; // Count both directions
  }
  
  return { nodes, edges, nodeWeights, totalWeight };
}

/**
 * Calculate modularity gain from moving node to target community
 */
function calculateModularityGain(
  node: string,
  targetCommunity: number,
  communities: Map<number, Set<string>>,
  edges: Map<string, Map<string, number>>,
  nodeWeights: Map<string, number>,
  totalWeight: number,
  resolution: number
): number {
  const nodeWeight = nodeWeights.get(node) || 0;
  const community = communities.get(targetCommunity);
  if (!community) return 0;
  
  // Calculate sum of weights from node to nodes in target community
  let ki_in = 0;
  const nodeEdges = edges.get(node);
  if (nodeEdges) {
    for (const member of community) {
      if (member !== node) {
        ki_in += nodeEdges.get(member) || 0;
      }
    }
  }
  
  // Calculate sum of weights of all nodes in target community
  let sumTot = 0;
  for (const member of community) {
    if (member !== node) {
      sumTot += nodeWeights.get(member) || 0;
    }
  }
  
  // Modularity gain formula
  const gain = ki_in - (resolution * nodeWeight * sumTot / totalWeight);
  
  return gain;
}

/**
 * Run one phase of Louvain algorithm
 */
function runPhase(
  nodes: Set<string>,
  edges: Map<string, Map<string, number>>,
  nodeWeights: Map<string, number>,
  totalWeight: number,
  params: LouvainParams
): { communities: Map<number, Set<string>>; modularity: number; improved: boolean } {
  // Initialize: each node in its own community
  const communities = new Map<number, Set<string>>();
  const nodeToCommunity = new Map<string, number>();
  let nextCommunityId = 0;
  
  for (const node of nodes) {
    communities.set(nextCommunityId, new Set([node]));
    nodeToCommunity.set(node, nextCommunityId);
    nextCommunityId++;
  }
  
  let improved = true;
  let iteration = 0;
  
  while (improved && iteration < params.maxIterations) {
    improved = false;
    iteration++;
    
    for (const node of nodes) {
      const currentCommunity = nodeToCommunity.get(node)!;
      const currentCommunitySet = communities.get(currentCommunity)!;
      
      // Remove node from current community
      currentCommunitySet.delete(node);
      if (currentCommunitySet.size === 0) {
        communities.delete(currentCommunity);
      }
      
      // Find best community among neighbors
      let bestCommunity = -1;
      let bestGain = 0;
      
      const nodeEdges = edges.get(node);
      if (nodeEdges) {
        // Check communities of neighbors
        const neighborCommunities = new Set<number>();
        for (const neighbor of nodeEdges.keys()) {
          neighborCommunities.add(nodeToCommunity.get(neighbor)!);
        }
        
        for (const commId of neighborCommunities) {
          // Skip empty communities
          if (!communities.has(commId)) continue;
          
          const gain = calculateModularityGain(
            node,
            commId,
            communities,
            edges,
            nodeWeights,
            totalWeight,
            params.resolution
          );
          
          if (gain > bestGain) {
            bestGain = gain;
            bestCommunity = commId;
          }
        }
      }
      
      // If no improvement, put back in original community
      if (bestCommunity === -1) {
        bestCommunity = currentCommunity;
        if (!communities.has(bestCommunity)) {
          communities.set(bestCommunity, new Set());
        }
      }
      
      // Add node to best community
      communities.get(bestCommunity)!.add(node);
      nodeToCommunity.set(node, bestCommunity);
      
      if (bestCommunity !== currentCommunity) {
        improved = true;
      }
    }
  }
  
  // Calculate final modularity
  let modularity = 0;
  for (const [commId, members] of communities) {
    let internalWeight = 0;
    let communityWeight = 0;
    
    for (const member of members) {
      communityWeight += nodeWeights.get(member) || 0;
      const memberEdges = edges.get(member);
      if (memberEdges) {
        for (const [neighbor, weight] of memberEdges) {
          if (members.has(neighbor)) {
            internalWeight += weight;
          }
        }
      }
    }
    
    modularity += (internalWeight / totalWeight) - 
      Math.pow(communityWeight / totalWeight, 2) * params.resolution;
  }
  
  return { communities, modularity, improved };
}

/**
 * Aggregate graph: communities become nodes
 */
function aggregateGraph(
  communities: Map<number, Set<string>>,
  edges: Map<string, Map<string, number>>,
  nodeWeights: Map<string, number>
): {
  nodes: Set<string>;
  edges: Map<string, Map<string, number>>;
  nodeWeights: Map<string, number>;
  totalWeight: number;
  communityMapping: Map<string, number>; // Original node -> new community
} {
  const newNodes = new Set<string>();
  const newEdges = new Map<string, Map<string, number>>();
  const newNodeWeights = new Map<string, number>();
  const communityMapping = new Map<string, number>();
  
  // Create community nodes
  for (const [commId, members] of communities) {
    const commNode = `comm_${commId}`;
    newNodes.add(commNode);
    newEdges.set(commNode, new Map());
    
    // Sum weights of all members
    let totalNodeWeight = 0;
    for (const member of members) {
      totalNodeWeight += nodeWeights.get(member) || 0;
      communityMapping.set(member, commId);
    }
    newNodeWeights.set(commNode, totalNodeWeight);
  }
  
  // Create edges between communities
  let totalWeight = 0;
  for (const [commId1, members1] of communities) {
    const commNode1 = `comm_${commId1}`;
    
    for (const [commId2, members2] of communities) {
      if (commId1 >= commId2) continue; // Avoid double counting
      
      const commNode2 = `comm_${commId2}`;
      let interCommunityWeight = 0;
      
      // Sum weights between communities
      for (const member1 of members1) {
        const memberEdges = edges.get(member1);
        if (memberEdges) {
          for (const [neighbor, weight] of memberEdges) {
            if (members2.has(neighbor)) {
              interCommunityWeight += weight;
            }
          }
        }
      }
      
      if (interCommunityWeight > 0) {
        newEdges.get(commNode1)!.set(commNode2, interCommunityWeight);
        newEdges.get(commNode2)!.set(commNode1, interCommunityWeight);
        totalWeight += interCommunityWeight * 2;
      }
    }
  }
  
  // Add self-loops for internal edges
  for (const [commId, members] of communities) {
    const commNode = `comm_${commId}`;
    let internalWeight = 0;
    
    for (const member of members) {
      const memberEdges = edges.get(member);
      if (memberEdges) {
        for (const [neighbor, weight] of memberEdges) {
          if (members.has(neighbor)) {
            internalWeight += weight;
          }
        }
      }
    }
    
    if (internalWeight > 0) {
      newEdges.get(commNode)!.set(commNode, internalWeight);
      totalWeight += internalWeight;
    }
  }
  
  return {
    nodes: newNodes,
    edges: newEdges,
    nodeWeights: newNodeWeights,
    totalWeight,
    communityMapping,
  };
}

/**
 * Run full Louvain algorithm
 */
export function detectCommunities(
  db: Database,
  params: LouvainParams = DEFAULT_PARAMS
): LouvainResult {
  let { nodes, edges, nodeWeights, totalWeight } = buildGraph(db);
  
  const allLevels: Array<Map<string, number>> = [];
  let level = 0;
  let improved = true;
  let finalModularity = 0;
  
  // Hierarchical clustering
  while (improved && nodes.size > 1) {
    const phase = runPhase(nodes, edges, nodeWeights, totalWeight, params);
    
    if (!phase.improved || phase.communities.size === nodes.size) {
      break;
    }
    
    finalModularity = phase.modularity;
    
    // Store community assignments at this level
    const levelAssignments = new Map<string, number>();
    for (const [commId, members] of phase.communities) {
      for (const member of members) {
        levelAssignments.set(member, commId);
      }
    }
    allLevels.push(levelAssignments);
    
    // Aggregate for next level
    const aggregated = aggregateGraph(phase.communities, edges, nodeWeights);
    nodes = aggregated.nodes;
    edges = aggregated.edges;
    nodeWeights = aggregated.nodeWeights;
    totalWeight = aggregated.totalWeight;
    
    level++;
  }
  
  // Build final result with original fact IDs
  const assignments = new Map<string, number>();
  const communities = new Map<number, Community>();
  
  // Map back to original nodes
  const finalLevel = allLevels[allLevels.length - 1];
  if (finalLevel) {
    // Get fact details
    const factDetails = new Map<string, { entity: string; key: string | null; value: string }>();
    const rows = db.prepare("SELECT id, entity, key, value FROM facts").all() as Array<{
      id: string;
      entity: string;
      key: string | null;
      value: string;
    }>;
    for (const row of rows) {
      factDetails.set(row.id, row);
    }
    
    // Build communities
    for (const [nodeId, commId] of finalLevel) {
      if (nodeId.startsWith("comm_")) continue; // Skip intermediate community nodes
      
      assignments.set(nodeId, commId);
      
      if (!communities.has(commId)) {
        communities.set(commId, {
          id: commId,
          members: [],
          size: 0,
          internalEdges: 0,
          externalEdges: 0,
          modularityContribution: 0,
          entities: new Map(),
          topEntities: [],
          keywords: [],
        });
      }
      
      const comm = communities.get(commId)!;
      comm.members.push(nodeId);
      comm.size++;
      
      const details = factDetails.get(nodeId);
      if (details) {
        const count = comm.entities.get(details.entity) || 0;
        comm.entities.set(details.entity, count + 1);
      }
    }
    
    // Calculate internal/external edges and find top entities
    for (const [commId, comm] of communities) {
      // Get top entities
      comm.topEntities = Array.from(comm.entities.entries())
        .map(([entity, count]) => ({ entity, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      
      // Generate keywords from member values
      const wordFreq = new Map<string, number>();
      for (const memberId of comm.members) {
        const details = factDetails.get(memberId);
        if (details) {
          const words = details.value
            .toLowerCase()
            .replace(/[^a-z\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length > 4 && !["about", "would", "should", "could", "there", "their", "where", "while"].includes(w));
          
          for (const word of words) {
            wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
          }
        }
      }
      
      comm.keywords = Array.from(wordFreq.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word]) => word);
    }
  }
  
  return {
    communities,
    assignments,
    modularity: finalModularity,
    iterations: 0, // Could track if needed
    levels: level,
  };
}

/**
 * Get facts in a specific community
 */
export function getCommunityFacts(
  db: Database,
  communityId: number,
  params: LouvainParams = DEFAULT_PARAMS
): Array<{ id: string; entity: string; key: string | null; value: string }> {
  const result = detectCommunities(db, params);
  const members = result.communities.get(communityId)?.members || [];
  
  if (members.length === 0) return [];
  
  const placeholders = members.map(() => "?").join(",");
  return db.prepare(`
    SELECT id, entity, key, value 
    FROM facts 
    WHERE id IN (${placeholders})
  `).all(...members) as Array<{ id: string; entity: string; key: string | null; value: string }>;
}

/**
 * Find which community a fact belongs to
 */
export function getFactCommunity(
  db: Database,
  factId: string,
  params: LouvainParams = DEFAULT_PARAMS
): { communityId: number; community: Community | null } {
  const result = detectCommunities(db, params);
  const communityId = result.assignments.get(factId);
  
  if (communityId === undefined) {
    return { communityId: -1, community: null };
  }
  
  return { communityId, community: result.communities.get(communityId) || null };
}

/**
 * CLI for Louvain community detection
 */
function printUsage() {
  console.log(`
zo-memory-system louvain — Community Detection

Usage:
  bun louvain.ts <command> [options]

Commands:
  detect             Detect communities in the knowledge graph
  show               Show facts in a specific community
  fact               Find which community a fact belongs to
  entity             Find communities containing an entity

Options:
  --id <fact-id>     Fact ID (for fact command)
  --community <n>    Community ID (for show command)
  --entity <name>    Entity name (for entity command)
  --resolution <n>   Resolution parameter (default: 1.0)
  --min-size <n>     Minimum community size (default: 3)

Examples:
  bun louvain.ts detect
  bun louvain.ts show --community 0
  bun louvain.ts fact --id abc123
  bun louvain.ts entity --name "project.ffb"
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

  const params: LouvainParams = {
    ...DEFAULT_PARAMS,
    resolution: parseFloat(flags.resolution) || DEFAULT_PARAMS.resolution,
    minCommunitySize: parseInt(flags["min-size"]) || DEFAULT_PARAMS.minCommunitySize,
  };

  switch (command) {
    case "detect": {
      console.log("Detecting communities...\n");
      const result = detectCommunities(db, params);
      
      console.log(`Found ${result.communities.size} communities`);
      console.log(`Modularity: ${result.modularity.toFixed(4)}`);
      console.log(`Hierarchical levels: ${result.levels}\n`);
      
      // Sort communities by size
      const sortedCommunities = Array.from(result.communities.values())
        .sort((a, b) => b.size - a.size);
      
      for (const comm of sortedCommunities) {
        if (comm.size < params.minCommunitySize) continue;
        
        console.log(`Community ${comm.id} (${comm.size} facts)`);
        console.log(`  Top entities: ${comm.topEntities.slice(0, 3).map(e => e.entity).join(", ")}`);
        console.log(`  Keywords: ${comm.keywords.slice(0, 5).join(", ")}`);
        console.log();
      }
      break;
    }

    case "show": {
      if (flags.community === undefined) {
        console.error("Error: --community is required");
        process.exit(1);
      }
      
      const communityId = parseInt(flags.community);
      const facts = getCommunityFacts(db, communityId, params);
      const comm = detectCommunities(db, params).communities.get(communityId);
      
      if (!comm) {
        console.error(`Community ${communityId} not found`);
        process.exit(1);
      }
      
      console.log(`\nCommunity ${communityId} (${facts.length} facts)\n`);
      console.log(`Top entities: ${comm.topEntities.map(e => `${e.entity}(${e.count})`).join(", ")}`);
      console.log(`Keywords: ${comm.keywords.join(", ")}\n`);
      
      for (let i = 0; i < Math.min(facts.length, 20); i++) {
        const f = facts[i];
        console.log(`${i + 1}. [${f.entity}.${f.key || "_"}] ${f.value.slice(0, 60)}`);
      }
      
      if (facts.length > 20) {
        console.log(`\n... and ${facts.length - 20} more`);
      }
      break;
    }

    case "fact": {
      if (!flags.id) {
        console.error("Error: --id is required");
        process.exit(1);
      }
      
      const { communityId, community } = getFactCommunity(db, flags.id, params);
      
      if (communityId === -1) {
        console.log("Fact not found in any community (may be isolated)");
        break;
      }
      
      console.log(`\nFact belongs to Community ${communityId}`);
      if (community) {
        console.log(`Community size: ${community.size} facts`);
        console.log(`Top entities: ${community.topEntities.map(e => e.entity).join(", ")}`);
        console.log(`Keywords: ${community.keywords.slice(0, 5).join(", ")}`);
      }
      break;
    }

    case "entity": {
      if (!flags.entity) {
        console.error("Error: --entity is required");
        process.exit(1);
      }
      
      const result = detectCommunities(db, params);
      const entityCommunities: Array<{ id: number; size: number; factCount: number }> = [];
      
      for (const [commId, comm] of result.communities) {
        const count = comm.entities.get(flags.entity);
        if (count) {
          entityCommunities.push({ id: commId, size: comm.size, factCount: count });
        }
      }
      
      if (entityCommunities.length === 0) {
        console.log(`No communities found for entity: ${flags.entity}`);
        break;
      }
      
      console.log(`\nEntity "${flags.entity}" appears in ${entityCommunities.length} community(s):\n`);
      for (const ec of entityCommunities.sort((a, b) => b.factCount - a.factCount)) {
        console.log(`  Community ${ec.id}: ${ec.factCount} facts (of ${ec.size} total)`);
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
