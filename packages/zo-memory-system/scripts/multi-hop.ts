#!/usr/bin/env bun
/**
 * multi-hop.ts — Iterative Multi-Hop Retrieval
 * MEM-003: Iterative Multi-Hop Retrieval
 *
 * Performs iterative graph traversal for complex queries that require
 * multi-step reasoning through the knowledge graph.
 *
 * Usage:
 *   bun multi-hop.ts retrieve --query "What decisions led to our database choice?" --maxHops 3
 *   bun multi-hop.ts benchmark --query "FFB hosting decisions"
 *   bun multi-hop.ts explain --factId <id>
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";
import { generate as mcGenerate } from "./model-client";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

export interface HopResult {
  hop: number;
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  relevance: number;
  connection: string;
}

export interface MultiHopResult {
  query: string;
  hopsTaken: number;
  confidence: number;
  allResults: HopResult[];
  summary: string;
  reasoning: string;
}

interface SearchResult {
  id: string;
  entity: string;
  key: string | null;
  value: string;
  rank: number;
}

async function generateReasoning(prompt: string, workload: "hyde" | "summarization" = "hyde"): Promise<string> {
  try {
    const result = await mcGenerate({
      prompt,
      workload,
      temperature: 0.1,
      maxTokens: 300,
    });
    return result.content.trim();
  } catch { return ""; }
}

async function semanticSearch(query: string, limit = 5): Promise<SearchResult[]> {
  const db = getDb();
  const safeQuery = query.replace(/['"*]/g, "").trim();
  if (!safeQuery) return [];

  try {
    const rows = db.prepare(`
      SELECT f.id, f.entity, f.key, f.value, rank
      FROM facts f
      JOIN facts_fts fts ON f.rowid = fts.rowid
      WHERE facts_fts MATCH ? AND (f.expires_at IS NULL OR f.expires_at > ?)
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, Math.floor(Date.now() / 1000), limit) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      id: r.id as string, entity: r.entity as string,
      key: r.key as string | null, value: r.value as string,
      rank: r.rank as number,
    }));
  } catch { return []; }
}

function getNeighbors(db: Database, factId: string): Array<{ id: string; entity: string; key: string | null; value: string; relation: string; weight: number }> {
  const rows = db.prepare(`
    SELECT fl.target_id as id, f.entity, f.key, f.value, fl.relation, fl.weight
    FROM fact_links fl JOIN facts f ON fl.target_id = f.id
    WHERE fl.source_id = ? AND (f.expires_at IS NULL OR f.expires_at > ?)
    UNION ALL
    SELECT fl.source_id as id, f.entity, f.key, f.value, fl.relation, fl.weight
    FROM fact_links fl JOIN facts f ON fl.source_id = f.id
    WHERE fl.target_id = ? AND (f.expires_at IS NULL OR f.expires_at > ?)
  `).all(factId, Math.floor(Date.now() / 1000), factId, Math.floor(Date.now() / 1000)) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    id: r.id as string, entity: r.entity as string,
    key: r.key as string | null, value: r.value as string,
    relation: r.relation as string, weight: r.weight as number,
  }));
}

function assessConfidence(results: HopResult[], query: string): number {
  if (results.length === 0) return 0;
  const avgRelevance = results.reduce((s, r) => s + r.relevance, 0) / results.length;
  const diverseEntities = new Set(results.map(r => r.entity)).size;
  const entityBonus = Math.min(diverseEntities / 3, 1) * 0.2;
  return Math.min(avgRelevance * 0.7 + entityBonus, 1);
}

async function refineQueryForNextHop(originalQuery: string, gathered: HopResult[]): Promise<string> {
  const factsSummary = gathered.map(r => `[${r.entity}.${r.key || "_"}]: ${r.value.slice(0, 80)}`).join("\n");
  const prompt = `Original question: "${originalQuery}"
Facts already found:
${factsSummary}

What additional information would help answer the original question? Reply with 1-2 specific search terms.`;
  const refined = await generateReasoning(prompt, "hyde");
  return refined.replace(/"/g, "").trim().slice(0, 100) || originalQuery;
}

async function multiHopRetrieve(
  query: string,
  maxHops = 3,
  limitPerHop = 5,
): Promise<MultiHopResult> {
  const db = getDb();
  const allResults: HopResult[] = [];
  const seenIds = new Set<string>();
  let currentQuery = query;
  let confidence = 0;

  for (let hop = 0; hop < maxHops; hop++) {
    const results = await semanticSearch(currentQuery, limitPerHop);

    for (const r of results) {
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);

      const neighbors = getNeighbors(db, r.id);
      let connection = "direct match";
      let relevance = 1 - (r.rank / (limitPerHop * 2));

      // Check if connected to existing results
      for (const n of neighbors) {
        if (seenIds.has(n.id)) {
          connection = `linked via "${n.relation}"`;
          relevance = Math.min(relevance + 0.15, 1);
          break;
        }
      }

      allResults.push({
        hop: hop + 1,
        factId: r.id,
        entity: r.entity,
        key: r.key,
        value: r.value,
        relevance,
        connection,
      });
    }

    confidence = assessConfidence(allResults, query);
    if (confidence >= 0.75) break;

    if (hop < maxHops - 1) {
      currentQuery = await refineQueryForNextHop(query, allResults);
    }
  }

  const reasoningPrompt = `Question: "${query}"

Found ${allResults.length} relevant facts across ${allResults.length > 0 ? Math.max(...allResults.map(r => r.hop)) : 0} hops.
Key findings:
${allResults.slice(0, 6).map(r => `• [${r.entity}.${r.key || "_"}] ${r.value.slice(0, 100)} (hop ${r.hop}, ${r.connection})`).join("\n")}

Provide a 2-sentence answer to the question.`;
  const reasoning = await generateReasoning(reasoningPrompt, "summarization");
  const summary = allResults.length > 0
    ? `${allResults.length} facts found across ${Math.max(...allResults.map(r => r.hop))} hops. ${reasoning}`
    : "No results found.";

  return {
    query, hopsTaken: Math.max(0, ...allResults.map(r => r.hop)),
    confidence, allResults, summary, reasoning,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "help") {
    console.log(`Multi-Hop Retrieval CLI — v1.0

Commands:
  retrieve --query "<text>"          Perform iterative multi-hop retrieval
  retrieve --query "<text>" --maxHops 3 --limit 5
  benchmark --query "<text>"          Compare multi-hop vs single-shot
  explain --factId <id>               Show all connections for a fact

Flags:
  --query    Search query string (required for retrieve/benchmark)
  --maxHops  Maximum hops (default: 3)
  --limit    Results per hop (default: 5)
  --factId   Fact ID for explain command`);
    process.exit(0);
  }

  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i + 1] || "";
  }

  const command = args[0];

  if (command === "retrieve" || command === "search") {
    if (!flags.query) { console.error("--query is required"); process.exit(1); }
    const maxHops = parseInt(flags.maxhops || "3");
    const limit = parseInt(flags.limit || "5");
    console.log(`\nMulti-hop retrieval for: "${flags.query}"\n`);
    const result = await multiHopRetrieve(flags.query, maxHops, limit);
    console.log(`Hops taken: ${result.hopsTaken} | Confidence: ${(result.confidence * 100).toFixed(0)}%\n`);
    for (const r of result.allResults) {
      console.log(`  [Hop ${r.hop}] ${r.entity}.${r.key || "_"}`);
      console.log(`    ${r.value.slice(0, 120)}${r.value.length > 120 ? "..." : ""}`);
      console.log(`    ${r.connection} (relevance: ${(r.relevance * 100).toFixed(0)}%)`);
      console.log();
    }
    console.log(`Summary: ${result.reasoning || result.summary}`);
  }

  else if (command === "benchmark") {
    if (!flags.query) { console.error("--query is required"); process.exit(1); }
    const db = getDb();
    const singleStart = Date.now();
    const singleResults = await semanticSearch(flags.query, 10);
    const singleMs = Date.now() - singleStart;

    const multiStart = Date.now();
    const multiResult = await multiHopRetrieve(flags.query, 3, 5);
    const multiMs = Date.now() - multiStart;

    console.log(`\nBenchmark: "${flags.query}"\n`);
    console.log(`Single-shot FTS:  ${singleResults.length} results in ${singleMs}ms`);
    console.log(`Multi-hop:       ${multiResult.allResults.length} results in ${multiMs}ms (${multiResult.hopsTaken} hops, conf ${(multiResult.confidence * 100).toFixed(0)}%)`);
    console.log(`\nNew facts discovered by multi-hop: ${multiResult.allResults.filter(r => r.hop > 1).length}`);
  }

  else if (command === "explain") {
    if (!flags.factid) { console.error("--factId is required"); process.exit(1); }
    const db = getDb();
    const fact = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?").get(flags.factid) as Record<string, unknown> | null;
    if (!fact) { console.log("Fact not found."); process.exit(0); }
    console.log(`\n[${fact.entity}.${fact.key || "_"}] ${fact.value}\n`);
    const neighbors = getNeighbors(db, fact.id as string);
    if (neighbors.length === 0) { console.log("No connections."); }
    else {
      console.log(`${neighbors.length} connections:\n`);
      for (const n of neighbors) {
        console.log(`  --${n.relation}--> [${n.entity}.${n.key || "_"}] ${n.value.slice(0, 80)}`);
      }
    }
  }
}

if (import.meta.main) main();
