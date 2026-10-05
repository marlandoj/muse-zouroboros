#!/usr/bin/env bun
/**
 * graph.ts — Knowledge Graph CLI for zo-memory-system
 *
 * Commands:
 *   link              Create a link between two facts
 *   unlink            Remove a link between two facts
 *   show              Show all links for an entity or fact
 *   find-connections  BFS path finding between two entities
 *   knowledge-gaps    Orphan & cluster analysis
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { generate, embeddings } from "./model-client";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  // Ensure fact_links table exists
  db.exec(`
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
  return db;
}

// --- Link Management ---

function link(db: Database, sourceId: string, targetId: string, relation: string, weight: number): void {
  // Validate both facts exist
  const source = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?").get(sourceId) as any;
  const target = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?").get(targetId) as any;

  if (!source) { console.error(`Source fact not found: ${sourceId}`); process.exit(1); }
  if (!target) { console.error(`Target fact not found: ${targetId}`); process.exit(1); }

  db.prepare(`
    INSERT OR REPLACE INTO fact_links (source_id, target_id, relation, weight)
    VALUES (?, ?, ?, ?)
  `).run(sourceId, targetId, relation, weight);

  console.log(`Linked: [${source.entity}.${source.key || "_"}] --${relation}--> [${target.entity}.${target.key || "_"}]`);
  console.log(`  weight: ${weight}`);
}

function unlink(db: Database, sourceId: string, targetId: string, relation?: string): void {
  if (relation) {
    db.prepare("DELETE FROM fact_links WHERE source_id = ? AND target_id = ? AND relation = ?")
      .run(sourceId, targetId, relation);
  } else {
    db.prepare("DELETE FROM fact_links WHERE source_id = ? AND target_id = ?")
      .run(sourceId, targetId);
  }
  console.log(`Unlinked: ${sourceId} --> ${targetId}${relation ? ` (${relation})` : " (all relations)"}`);
}

function show(db: Database, entityOrId: string): void {
  // Try as fact ID first
  const fact = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?").get(entityOrId) as any;

  let factIds: string[];
  if (fact) {
    factIds = [fact.id];
    console.log(`Links for fact: [${fact.entity}.${fact.key || "_"}] ${fact.value.slice(0, 60)}\n`);
  } else {
    // Treat as entity name — find all facts for this entity
    const facts = db.prepare("SELECT id, entity, key, value FROM facts WHERE entity = ?").all(entityOrId) as any[];
    if (facts.length === 0) {
      console.log(`No facts found for entity or ID: ${entityOrId}`);
      return;
    }
    factIds = facts.map((f: any) => f.id);
    console.log(`Links for entity: ${entityOrId} (${facts.length} facts)\n`);
  }

  const placeholders = factIds.map(() => "?").join(",");

  // Outbound links
  const outbound = db.prepare(`
    SELECT fl.*, f.entity as target_entity, f.key as target_key, f.value as target_value
    FROM fact_links fl
    JOIN facts f ON fl.target_id = f.id
    WHERE fl.source_id IN (${placeholders})
    ORDER BY fl.weight DESC
  `).all(...factIds) as any[];

  // Inbound links
  const inbound = db.prepare(`
    SELECT fl.*, f.entity as source_entity, f.key as source_key, f.value as source_value
    FROM fact_links fl
    JOIN facts f ON fl.source_id = f.id
    WHERE fl.target_id IN (${placeholders})
    ORDER BY fl.weight DESC
  `).all(...factIds) as any[];

  if (outbound.length === 0 && inbound.length === 0) {
    console.log("  No links found.");
    return;
  }

  if (outbound.length > 0) {
    console.log(`Outbound (${outbound.length}):`);
    for (const link of outbound) {
      console.log(`  --${link.relation}--> [${link.target_entity}.${link.target_key || "_"}] ${(link.target_value as string).slice(0, 60)} (w=${link.weight})`);
    }
  }

  if (inbound.length > 0) {
    console.log(`\nInbound (${inbound.length}):`);
    for (const link of inbound) {
      console.log(`  <--${link.relation}-- [${link.source_entity}.${link.source_key || "_"}] ${(link.source_value as string).slice(0, 60)} (w=${link.weight})`);
    }
  }
}

// --- BFS Path Finding ---

interface PathNode {
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  relation?: string;
  direction?: "forward" | "backward";
}

function findConnections(db: Database, fromEntity: string, toEntity: string, maxDepth: number = 5): void {
  // Get all fact IDs for the source and target entities
  const fromFacts = db.prepare("SELECT id, entity, key, value FROM facts WHERE entity = ?").all(fromEntity) as any[];
  const toFacts = db.prepare("SELECT id, entity, key, value FROM facts WHERE entity = ?").all(toEntity) as any[];

  if (fromFacts.length === 0) {
    console.log(`No facts found for entity: ${fromEntity}`);
    return;
  }
  if (toFacts.length === 0) {
    console.log(`No facts found for entity: ${toEntity}`);
    return;
  }

  const targetIds = new Set(toFacts.map((f: any) => f.id));

  // BFS
  const visited = new Set<string>();
  const parent = new Map<string, { from: string; relation: string; direction: string }>();
  const queue: Array<{ id: string; depth: number }> = [];

  // Seed with all source entity facts
  for (const f of fromFacts) {
    queue.push({ id: f.id, depth: 0 });
    visited.add(f.id);
  }

  // Preload all links into memory for fast traversal
  const allLinks = db.prepare("SELECT source_id, target_id, relation, weight FROM fact_links").all() as any[];
  const adjacency = new Map<string, Array<{ neighbor: string; relation: string; direction: string }>>();

  for (const link of allLinks) {
    // Forward: source -> target
    if (!adjacency.has(link.source_id)) adjacency.set(link.source_id, []);
    adjacency.get(link.source_id)!.push({ neighbor: link.target_id, relation: link.relation, direction: "forward" });

    // Backward: target -> source (bidirectional traversal)
    if (!adjacency.has(link.target_id)) adjacency.set(link.target_id, []);
    adjacency.get(link.target_id)!.push({ neighbor: link.source_id, relation: link.relation, direction: "backward" });
  }

  let found: string | null = null;

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (targetIds.has(current.id)) {
      found = current.id;
      break;
    }

    if (current.depth >= maxDepth) continue;

    const neighbors = adjacency.get(current.id) || [];
    for (const { neighbor, relation, direction } of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, { from: current.id, relation, direction });
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  if (!found) {
    console.log(`No connection found between "${fromEntity}" and "${toEntity}" (max depth: ${maxDepth})`);

    // Show direct neighbors for each
    const fromNeighborCount = fromFacts.reduce((sum: number, f: any) => sum + (adjacency.get(f.id)?.length || 0), 0);
    const toNeighborCount = toFacts.reduce((sum: number, f: any) => sum + (adjacency.get(f.id)?.length || 0), 0);
    console.log(`\nDirect connections for "${fromEntity}": ${fromNeighborCount} links`);
    console.log(`Direct connections for "${toEntity}": ${toNeighborCount} links`);
    return;
  }

  // Reconstruct path
  const path: PathNode[] = [];
  let current = found;

  while (current) {
    const fact = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?").get(current) as any;
    const parentInfo = parent.get(current);

    path.unshift({
      factId: fact.id,
      entity: fact.entity,
      key: fact.key,
      value: fact.value,
      relation: parentInfo?.relation,
      direction: parentInfo?.direction as "forward" | "backward" | undefined,
    });

    current = parentInfo?.from || "";
    if (!parent.has(current) && !fromFacts.some((f: any) => f.id === current)) break;
    if (fromFacts.some((f: any) => f.id === current)) {
      const startFact = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?").get(current) as any;
      path.unshift({
        factId: startFact.id,
        entity: startFact.entity,
        key: startFact.key,
        value: startFact.value,
      });
      break;
    }
  }

  console.log(`Path found (${path.length - 1} hops):\n`);
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    console.log(`  [${node.entity}.${node.key || "_"}] "${node.value.slice(0, 60)}"`);

    if (i < path.length - 1) {
      const next = path[i + 1];
      const arrow = next.direction === "backward" ? "<--" : "-->";
      console.log(`    ${arrow}${next.relation}${arrow === "<--" ? "--" : ""}`);
    }
  }
}

// --- Knowledge Gaps Analysis ---

function knowledgeGaps(db: Database): void {
  const allFacts = db.prepare("SELECT id, entity, key, value FROM facts").all() as any[];
  const allLinks = db.prepare("SELECT source_id, target_id, relation FROM fact_links").all() as any[];

  const totalFacts = allFacts.length;

  // Build adjacency (undirected)
  const adj = new Map<string, Set<string>>();
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();

  for (const fact of allFacts) {
    adj.set(fact.id, new Set());
    inbound.set(fact.id, 0);
    outbound.set(fact.id, 0);
  }

  for (const link of allLinks) {
    adj.get(link.source_id)?.add(link.target_id);
    adj.get(link.target_id)?.add(link.source_id);
    outbound.set(link.source_id, (outbound.get(link.source_id) || 0) + 1);
    inbound.set(link.target_id, (inbound.get(link.target_id) || 0) + 1);
  }

  // Classify facts
  const orphans: any[] = [];
  const deadEnds: any[] = [];
  const weaklyLinked: any[] = [];
  const linkedFacts = new Set<string>();

  for (const fact of allFacts) {
    const neighbors = adj.get(fact.id)!;
    const inCount = inbound.get(fact.id) || 0;
    const outCount = outbound.get(fact.id) || 0;

    if (neighbors.size === 0) {
      orphans.push(fact);
    } else {
      linkedFacts.add(fact.id);
      if (inCount > 0 && outCount === 0) {
        deadEnds.push({ ...fact, inCount, outCount });
      }
      if (neighbors.size === 1) {
        weaklyLinked.push({ ...fact, linkCount: 1 });
      }
    }
  }

  // Connected components via BFS
  const componentOf = new Map<string, number>();
  let componentCount = 0;
  const components: Array<{ id: number; members: string[]; hub: any; hubLinks: number }> = [];

  for (const fact of allFacts) {
    if (componentOf.has(fact.id)) continue;
    if ((adj.get(fact.id)?.size || 0) === 0) continue; // Skip orphans

    const component: string[] = [];
    const queue = [fact.id];
    componentOf.set(fact.id, componentCount);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      for (const neighbor of adj.get(current) || []) {
        if (!componentOf.has(neighbor)) {
          componentOf.set(neighbor, componentCount);
          queue.push(neighbor);
        }
      }
    }

    // Find hub (most connections)
    let hubId = component[0];
    let hubLinks = adj.get(component[0])?.size || 0;
    for (const id of component) {
      const links = adj.get(id)?.size || 0;
      if (links > hubLinks) {
        hubId = id;
        hubLinks = links;
      }
    }

    const hubFact = allFacts.find((f: any) => f.id === hubId);
    components.push({ id: componentCount, members: component, hub: hubFact, hubLinks });
    componentCount++;
  }

  // Output
  console.log("Knowledge Gap Analysis");
  console.log("======================");
  console.log(`Total facts: ${totalFacts}`);
  console.log(`Linked facts: ${linkedFacts.size} (${totalFacts > 0 ? ((linkedFacts.size / totalFacts) * 100).toFixed(1) : 0}%)`);
  console.log(`Orphan facts: ${orphans.length} (${totalFacts > 0 ? ((orphans.length / totalFacts) * 100).toFixed(1) : 0}%)`);

  if (deadEnds.length > 0) {
    console.log(`\nDead ends (targets only, never source):`);
    for (const de of deadEnds.slice(0, 10)) {
      console.log(`  - [${de.entity}.${de.key || "_"}] "${de.value.slice(0, 50)}" (${de.inCount} inbound, ${de.outCount} outbound)`);
    }
    if (deadEnds.length > 10) console.log(`  ... and ${deadEnds.length - 10} more`);
  }

  if (weaklyLinked.length > 0) {
    console.log(`\nWeakly linked (only 1 connection):`);
    for (const wl of weaklyLinked.slice(0, 10)) {
      console.log(`  - [${wl.entity}.${wl.key || "_"}] "${wl.value.slice(0, 50)}" (${wl.linkCount} link)`);
    }
    if (weaklyLinked.length > 10) console.log(`  ... and ${weaklyLinked.length - 10} more`);
  }

  if (components.length > 0) {
    console.log(`\nConnected components: ${components.length}`);
    for (const comp of components.sort((a, b) => b.members.length - a.members.length)) {
      console.log(`  Cluster ${comp.id + 1} (${comp.members.length} facts): hub = [${comp.hub.entity}.${comp.hub.key || "_"}] (${comp.hubLinks} links)`);
    }
  } else {
    console.log("\nConnected components: 0 (no linked facts)");
  }

  // Suggest links for orphans that share entities with linked facts
  const linkedEntities = new Set<string>();
  for (const id of linkedFacts) {
    const fact = allFacts.find((f: any) => f.id === id);
    if (fact) linkedEntities.add(fact.entity);
  }

  const suggestable = orphans.filter((o: any) => linkedEntities.has(o.entity));
  if (suggestable.length > 0) {
    console.log(`\nSuggested: ${suggestable.length} orphan facts share entities with linked facts and could be connected.`);
  }
}

// --- Auto-link Orphans (token-based wikilink backfill) ---

const STOPLIST = new Set([
  "the","and","with","from","into","that","this","then","than","over","under",
  "true","false","null","none","value","fact","test","none","when","what","just",
  "have","been","will","does","done","also","they","them","were","your","yours",
  "object","string","number","array","null","item","items","data","info","note",
  "active","status","working","complete","completed","running","start","stop",
  "default","config","setup","apply","apply","using","each","next","step",
]);

function tokenize(s: string | null | undefined): string[] {
  if (!s) return [];
  const tokens = new Set<string>();
  // Hyphenated/dotted/underscore identifiers preserved whole AND split into parts
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g)) {
    const whole = m[0].toLowerCase();
    tokens.add(whole);
    for (const part of whole.split(/[-_.]/)) tokens.add(part);
  }
  // Plain words
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9]{3,}/g)) {
    tokens.add(m[0].toLowerCase());
  }
  // Filter
  return [...tokens].filter(t => t.length >= 4 && !STOPLIST.has(t));
}

function autoLinkOrphans(db: Database, opts: { dryRun: boolean; maxLinksPerOrphan: number }): void {
  const allFacts = db.prepare("SELECT id, entity, key, value, text FROM facts").all() as any[];
  const allLinks = db.prepare("SELECT source_id, target_id FROM fact_links").all() as any[];

  const adj = new Map<string, number>();
  for (const f of allFacts) adj.set(f.id, 0);
  for (const l of allLinks) {
    adj.set(l.source_id, (adj.get(l.source_id) || 0) + 1);
    adj.set(l.target_id, (adj.get(l.target_id) || 0) + 1);
  }

  const orphans = allFacts.filter(f => (adj.get(f.id) || 0) === 0);
  const linked = allFacts.filter(f => (adj.get(f.id) || 0) > 0);
  console.log(`Orphans: ${orphans.length}, linked candidates: ${linked.length}`);

  // Build inverted index: token -> [{ factId, degree }]
  const tokenIndex = new Map<string, Array<{ id: string; degree: number; entity: string; key: string }>>();
  for (const f of linked) {
    const tokens = new Set([
      ...tokenize(f.entity),
      ...tokenize(f.key),
      ...tokenize(f.value),
    ]);
    for (const t of tokens) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t)!.push({ id: f.id, degree: adj.get(f.id) || 0, entity: f.entity, key: f.key || "_" });
    }
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight)
    VALUES (?, ?, 'auto_linked', 0.5)
  `);

  let totalLinks = 0;
  let orphansLinked = 0;

  const writes: Array<[string, string]> = [];
  for (const orphan of orphans) {
    const tokens = new Set([
      ...tokenize(orphan.entity),
      ...tokenize(orphan.key),
      ...tokenize(orphan.value),
      ...tokenize(orphan.text),
    ]);

    // Score candidate target facts: count token matches, prefer high-degree hubs
    const scored = new Map<string, { score: number; degree: number; entity: string; key: string }>();
    for (const t of tokens) {
      const candidates = tokenIndex.get(t);
      if (!candidates) continue;
      // Skip noisy tokens (appear in >50 linked facts) — they're not discriminating
      if (candidates.length > 50) continue;
      for (const c of candidates) {
        if (c.entity === orphan.entity) continue;
        const cur = scored.get(c.id);
        if (cur) cur.score++;
        else scored.set(c.id, { score: 1, degree: c.degree, entity: c.entity, key: c.key });
      }
    }

    // Require ≥2 token-overlap to avoid spurious single-token noise
    const ranked = [...scored.entries()]
      .filter(([, v]) => v.score >= 2)
      .sort((a, b) => b[1].score - a[1].score || b[1].degree - a[1].degree)
      .slice(0, opts.maxLinksPerOrphan);

    if (ranked.length === 0) continue;
    orphansLinked++;

    for (const [targetId, info] of ranked) {
      writes.push([orphan.id, targetId]);
      totalLinks++;
      console.log(`  [${orphan.entity}.${orphan.key || "_"}] -> [${info.entity}.${info.key}] (score=${info.score}, deg=${info.degree})`);
    }
  }

  if (!opts.dryRun && writes.length > 0) {
    const tx = db.transaction(() => {
      for (const [src, tgt] of writes) insertStmt.run(src, tgt);
    });
    tx();
  }

  console.log(`\n${opts.dryRun ? "[DRY-RUN] Would link" : "Linked"} ${orphansLinked}/${orphans.length} orphans (${totalLinks} new edges)`);
  console.log(`Untouched orphans: ${orphans.length - orphansLinked} (no token overlap with any linked fact)`);
}

// --- Community Summarization (GraphRAG Edge 2024) ---

interface Component {
  members: string[];        // fact ids
  internalDegree: Map<string, number>;
}

function findComponents(db: Database): Component[] {
  const allFacts = db.prepare("SELECT id FROM facts").all() as Array<{ id: string }>;
  const allLinks = db.prepare("SELECT source_id, target_id FROM fact_links").all() as Array<{ source_id: string; target_id: string }>;

  const adj = new Map<string, Set<string>>();
  for (const f of allFacts) adj.set(f.id, new Set());
  for (const l of allLinks) {
    adj.get(l.source_id)?.add(l.target_id);
    adj.get(l.target_id)?.add(l.source_id);
  }

  const seen = new Set<string>();
  const comps: Component[] = [];
  for (const f of allFacts) {
    if (seen.has(f.id)) continue;
    const ns = adj.get(f.id);
    if (!ns || ns.size === 0) { seen.add(f.id); continue; }

    const members: string[] = [];
    const queue = [f.id];
    seen.add(f.id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      members.push(cur);
      for (const n of adj.get(cur) || []) {
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    const internalDegree = new Map<string, number>();
    for (const m of members) internalDegree.set(m, adj.get(m)?.size || 0);
    comps.push({ members, internalDegree });
  }
  return comps;
}

function communityIdFor(memberIds: string[]): string {
  const sorted = [...memberIds].sort().join("|");
  return "cs_" + createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function communitySummarize(db: Database, opts: {
  minSize: number;
  maxClusters: number;
  topMembers: number;
  linkThreshold: number;
  dryRun: boolean;
}): Promise<void> {
  const t0 = Date.now();
  const allComps = findComponents(db);
  const targets = allComps
    .filter(c => c.members.length >= opts.minSize)
    .sort((a, b) => b.members.length - a.members.length)
    .slice(0, opts.maxClusters);

  console.log(`Components total: ${allComps.length}`);
  console.log(`Components ≥${opts.minSize}: ${targets.length}`);
  console.log(`Mode: ${opts.dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log("");

  const summarized: Array<{
    communityId: string;
    members: string[];
    summary: string;
    embedding: number[];
    skipped: boolean;
    reason?: string;
  }> = [];

  let llmCost = 0;
  let llmCalls = 0;

  for (let i = 0; i < targets.length; i++) {
    const comp = targets[i];
    const cid = communityIdFor(comp.members);

    const existing = db.prepare("SELECT id FROM facts WHERE id = ?").get(cid) as { id: string } | undefined;
    if (existing) {
      console.log(`[${i + 1}/${targets.length}] ${cid} — exists, skip`);
      summarized.push({ communityId: cid, members: comp.members, summary: "", embedding: [], skipped: true, reason: "exists" });
      continue;
    }

    // Pick top-N members by internal degree as representatives
    const reps = comp.members
      .map(m => ({ id: m, deg: comp.internalDegree.get(m) || 0 }))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, opts.topMembers)
      .map(r => r.id);

    const repFacts = db.prepare(
      `SELECT id, entity, key, value FROM facts WHERE id IN (${reps.map(() => "?").join(",")})`
    ).all(...reps) as Array<{ id: string; entity: string; key: string | null; value: string }>;

    const factLines = repFacts.map((f, idx) =>
      `${idx + 1}. [${f.entity}.${f.key || "_"}] ${f.value.slice(0, 240)}`
    ).join("\n");

    const prompt = `You are summarizing a connected cluster from a knowledge graph.
Below are ${repFacts.length} representative facts (out of ${comp.members.length} in the cluster).

Write a 2-3 sentence summary capturing the cluster's core theme — what topic, decision, or system these facts collectively describe. Be specific, name entities, no preamble.

Facts:
${factLines}

Theme summary:`;

    if (opts.dryRun) {
      console.log(`[${i + 1}/${targets.length}] ${cid} — would summarize ${comp.members.length} members (${reps.length} reps)`);
      summarized.push({ communityId: cid, members: comp.members, summary: "[dry-run]", embedding: [], skipped: true, reason: "dry-run" });
      continue;
    }

    let summary = "";
    try {
      const r = await generate({ prompt, workload: "summarization", temperature: 0.3, maxTokens: 250 });
      summary = r.content.trim();
      llmCost += r.cost_usd;
      llmCalls++;
    } catch (e) {
      console.log(`[${i + 1}/${targets.length}] ${cid} — LLM failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (!summary) {
      console.log(`[${i + 1}/${targets.length}] ${cid} — empty summary, skip`);
      continue;
    }

    let emb: number[] = [];
    try {
      const er = await embeddings(summary);
      emb = er.embedding;
    } catch (e) {
      console.log(`[${i + 1}/${targets.length}] ${cid} — embedding failed (will store summary anyway): ${e instanceof Error ? e.message : String(e)}`);
    }

    const now = Date.now();
    const metadata = JSON.stringify({
      community_id: cid,
      member_count: comp.members.length,
      rep_count: repFacts.length,
      generated_at: new Date(now).toISOString(),
    });

    db.transaction(() => {
      db.prepare(
        `INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, confidence, metadata)
         VALUES (?, 'shared', 'community.summary', ?, ?, ?, 'community_summary', 'stable', 0.8, 'graph.community-summarize', ?, 0.9, ?)`
      ).run(cid, cid, summary, summary, now, metadata);

      const linkStmt = db.prepare(
        `INSERT OR REPLACE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'summarizes', 1.0)`
      );
      for (const m of comp.members) linkStmt.run(cid, m);
    })();

    console.log(`[${i + 1}/${targets.length}] ${cid} — ${comp.members.length} members linked, summary: ${summary.slice(0, 100)}${summary.length > 100 ? "…" : ""}`);
    summarized.push({ communityId: cid, members: comp.members, summary, embedding: emb, skipped: false });
  }

  // Cross-cluster linking via summary embedding similarity
  const withEmb = summarized.filter(s => !s.skipped && s.embedding.length > 0);
  let crossLinks = 0;
  if (!opts.dryRun && withEmb.length >= 2) {
    console.log(`\nCross-cluster linking (threshold cosine ≥ ${opts.linkThreshold})...`);
    const linkStmt = db.prepare(
      `INSERT OR REPLACE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'community_related', ?)`
    );
    for (let i = 0; i < withEmb.length; i++) {
      for (let j = i + 1; j < withEmb.length; j++) {
        const c = cosine(withEmb[i].embedding, withEmb[j].embedding);
        if (c >= opts.linkThreshold) {
          linkStmt.run(withEmb[i].communityId, withEmb[j].communityId, c);
          linkStmt.run(withEmb[j].communityId, withEmb[i].communityId, c);
          crossLinks++;
        }
      }
    }
    console.log(`Cross-cluster links created: ${crossLinks} pairs`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — clusters processed: ${targets.length}, LLM calls: ${llmCalls}, est. cost: $${llmCost.toFixed(4)}, cross-links: ${crossLinks}`);
}

// --- CLI ---

function printUsage() {
  console.log(`
zo-memory-system graph — Knowledge Graph CLI

Usage:
  bun graph.ts <command> [options]

Commands:
  link                  Create a link between two facts
  unlink                Remove a link between two facts
  show                  Show links for an entity or fact ID
  find-connections      Find shortest path between two entities
  knowledge-gaps        Analyze orphans, dead ends, and clusters
  auto-link-orphans     Backfill links from orphan facts via token overlap
  community-summarize   Generate GraphRAG summaries for clusters ≥ min-size

Auto-link-orphans options:
  --max-links <n>       Max edges per orphan (default: 2)
  --dry-run             Preview matches without writing

Community-summarize options:
  --min-size <n>        Minimum component size to summarize (default: 5)
  --max-clusters <n>    Cap number of clusters processed this run (default: 300)
  --top-members <n>     Top-degree members per cluster used as representatives (default: 8)
  --link-threshold <f>  Cosine threshold for cross-cluster summary links (default: 0.78)
  --dry-run             Print plan without LLM calls or DB writes

Link options:
  --source <id>      Source fact ID (required)
  --target <id>      Target fact ID (required)
  --relation <type>  Relation type (default: "related")
  --weight <n>       Link weight 0.0-1.0 (default: 1.0)

Unlink options:
  --source <id>      Source fact ID (required)
  --target <id>      Target fact ID (required)
  --relation <type>  Only remove specific relation (optional)

Show options:
  --entity <name>    Entity name to show links for
  --id <id>          Fact ID to show links for

Find-connections options:
  --from <entity>    Source entity name (required)
  --to <entity>      Target entity name (required)
  --max-depth <n>    Maximum hops (default: 5)

Examples:
  bun graph.ts link --source abc123 --target def456 --relation "depends_on"
  bun graph.ts show --entity "project.ffb-site"
  bun graph.ts find-connections --from "project.ffb-site" --to "system.zo"
  bun graph.ts knowledge-gaps
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  // Parse flags (boolean-safe: don't consume next arg if it's another flag)
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[args[i].slice(2)] = next;
        i++;
      } else {
        flags[args[i].slice(2)] = "";
      }
    }
  }

  const db = getDb();

  switch (command) {
    case "link": {
      if (!flags.source || !flags.target) {
        console.error("Error: --source and --target are required");
        process.exit(1);
      }
      link(db, flags.source, flags.target, flags.relation || "related", parseFloat(flags.weight) || 1.0);
      break;
    }

    case "unlink": {
      if (!flags.source || !flags.target) {
        console.error("Error: --source and --target are required");
        process.exit(1);
      }
      unlink(db, flags.source, flags.target, flags.relation);
      break;
    }

    case "show": {
      const target = flags.entity || flags.id;
      if (!target) {
        console.error("Error: --entity or --id is required");
        process.exit(1);
      }
      show(db, target);
      break;
    }

    case "find-connections": {
      if (!flags.from || !flags.to) {
        console.error("Error: --from and --to are required");
        process.exit(1);
      }
      findConnections(db, flags.from, flags.to, parseInt(flags["max-depth"]) || 5);
      break;
    }

    case "knowledge-gaps": {
      knowledgeGaps(db);
      break;
    }

    case "auto-link-orphans": {
      autoLinkOrphans(db, {
        dryRun: process.argv.includes("--dry-run"),
        maxLinksPerOrphan: parseInt(flags["max-links"]) || 2,
      });
      break;
    }

    case "community-summarize": {
      await communitySummarize(db, {
        minSize: parseInt(flags["min-size"]) || 5,
        maxClusters: parseInt(flags["max-clusters"]) || 300,
        topMembers: parseInt(flags["top-members"]) || 8,
        linkThreshold: parseFloat(flags["link-threshold"]) || 0.78,
        dryRun: process.argv.includes("--dry-run"),
      });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }

  db.close();
}

main().catch(console.error);
