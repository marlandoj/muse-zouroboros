#!/usr/bin/env bun
/**
 * zo-memory-system MCP Server v1.0
 *
 * Exposes memory system as MCP tools for Claude Desktop, Cursor, etc.
 * Binds to localhost only (privacy first).
 *
 * Tools:
 *   memory_search  — Hybrid search (FTS + vector + HyDE)
 *   memory_store   — Store a new fact with embedding
 *   memory_episodes — Query episodic memory
 *   memory_procedures — List/show procedures
 *   cognitive_profile — Show executor cognitive profile
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { embeddings as mcEmbeddings } from "./model-client";

// --- Config ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";
const HISTORY_PATH = join(process.env.HOME || "/tmp", ".swarm", "executor-history.json");

// --- DB ---
let db: Database;

function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

// --- Embedding helper ---
async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await mcEmbeddings(text, EMBEDDING_MODEL);
    return result.embedding || null;
  } catch {
    return null;
  }
}

// --- Cosine similarity ---
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// --- Time parser (shared with memory.ts) ---
function parseRelativeTime(input: string): number {
  const now = Math.floor(Date.now() / 1000);
  const lower = input.toLowerCase().trim();

  // Relative: "7 days ago", "30 minutes ago"
  const relMatch = lower.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2];
    const multipliers: Record<string, number> = {
      second: 1, minute: 60, hour: 3600, day: 86400,
      week: 604800, month: 2592000, year: 31536000,
    };
    return now - n * (multipliers[unit] || 86400);
  }

  // Named
  if (lower === "today") return now - 86400;
  if (lower === "yesterday") return now - 2 * 86400;
  if (lower === "last week") return now - 7 * 86400;
  if (lower === "last month") return now - 30 * 86400;
  if (lower === "last year") return now - 365 * 86400;

  // ISO date
  const isoMatch = lower.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoMatch) return Math.floor(new Date(isoMatch[0]).getTime() / 1000);

  // Unix timestamp
  const ts = parseInt(lower);
  if (!isNaN(ts) && ts > 1000000000) return ts;

  return now - 7 * 86400; // default: 7 days ago
}

// ==========================================================================
// TOOL IMPLEMENTATIONS
// ==========================================================================

async function toolMemorySearch(args: {
  query: string;
  category?: string;
  persona?: string;
  limit?: number;
}): Promise<string> {
  const db = getDb();
  const { query, category, persona, limit = 6 } = args;
  const nowSec = Math.floor(Date.now() / 1000);

  // FTS search
  const ftsWhere = [];
  const ftsParams: SQLQueryBindings[] = [];

  if (persona) { ftsWhere.push("f.persona = ?"); ftsParams.push(persona); }
  if (category) { ftsWhere.push("f.category = ?"); ftsParams.push(category); }
  ftsWhere.push("(f.expires_at IS NULL OR f.expires_at > ?)");
  ftsParams.push(nowSec);

  // FTS5 reads a bare multi-word string as an adjacency phrase query, so
  // "agent harnesses" only ever matches when the words sit next to each other.
  // Tokenize to quoted OR-terms, the same way hybridSearch() in memory.ts does.
  // facts_fts is an external-content table on content_rowid='rowid', so the
  // join must be f.rowid = fts.rowid -- f.id is a TEXT uuid and never matches.
  const ftsQuery = query
    .replace(/['"]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`)
    .join(" OR ");

  const ftsResults = ftsQuery
    ? (db.prepare(`
    SELECT f.*, fts.rank
    FROM facts_fts fts
    JOIN facts f ON f.rowid = fts.rowid
    WHERE fts.facts_fts MATCH ?
      ${ftsWhere.length ? "AND " + ftsWhere.join(" AND ") : ""}
    ORDER BY fts.rank
    LIMIT ?
  `).all(ftsQuery, ...ftsParams, limit * 2) as Array<Record<string, unknown>>)
    : [];

  // Vector search
  const queryEmbedding = await getEmbedding(query);
  let vectorResults: Array<{ id: string; score: number }> = [];

  if (queryEmbedding) {
    const rows = db.prepare(`
      SELECT fe.fact_id, fe.embedding FROM fact_embeddings fe
      JOIN facts f ON f.id = fe.fact_id
      WHERE (f.expires_at IS NULL OR f.expires_at > ?)
      ${persona ? "AND f.persona = ?" : ""}
      ${category ? "AND f.category = ?" : ""}
    `).all(
      ...[nowSec, ...(persona ? [persona] : []), ...(category ? [category] : [])]
    ) as Array<{ fact_id: string; embedding: Buffer }>;

    vectorResults = rows.map(r => {
      const emb = Array.from(new Float32Array(r.embedding.buffer));
      return { id: r.fact_id, score: cosineSim(queryEmbedding, emb) };
    }).sort((a, b) => b.score - a.score).slice(0, limit * 2);
  }

  // RRF fusion
  const rrf: Record<string, number> = {};
  const k = 60;

  ftsResults.forEach((r, i) => {
    const id = r.id as string;
    rrf[id] = (rrf[id] || 0) + 1 / (k + i + 1);
  });
  vectorResults.forEach((r, i) => {
    rrf[r.id] = (rrf[r.id] || 0) + 1 / (k + i + 1);
  });

  const ranked = Object.entries(rrf).sort((a, b) => b[1] - a[1]).slice(0, limit);

  // Fetch full facts
  const results: string[] = [];
  for (const [id, score] of ranked) {
    const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (row) {
      results.push(
        `[${row.decay_class}] ${row.entity}.${row.key || "_"} = ${(row.value as string).slice(0, 200)}` +
        `\n  score: ${score.toFixed(4)} | category: ${row.category} | source: ${row.source}`
      );
    }
  }

  return results.length > 0
    ? `Found ${results.length} results for "${query}":\n\n${results.join("\n\n")}`
    : `No results found for "${query}".`;
}

async function toolMemoryStore(args: {
  entity: string;
  key?: string;
  value: string;
  category?: string;
  decay_class?: string;
  persona?: string;
  text?: string;
}): Promise<string> {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const category = args.category || "fact";
  const decayClass = args.decay_class || "stable";

  const TTL: Record<string, number | null> = {
    permanent: null, stable: 90 * 86400, active: 14 * 86400,
    session: 86400, checkpoint: 4 * 3600,
  };
  const expiresAt = TTL[decayClass] ? nowSec + TTL[decayClass]! : null;

  const text = args.text || `${args.entity} ${args.key || ""}: ${args.value}`;

  db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                       importance, source, created_at, expires_at, last_accessed, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0, 'mcp', ?, ?, ?, 1.0)
  `).run(id, args.persona || "shared", args.entity, args.key || null,
    args.value, text, category, decayClass, now, expiresAt, nowSec);

  // Generate embedding
  const embedding = await getEmbedding(text);
  if (embedding) {
    db.prepare("INSERT INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
      .run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
  }

  return `Stored fact ${id}\n  entity: ${args.entity}\n  key: ${args.key || "(none)"}\n  value: ${args.value.slice(0, 100)}\n  embedding: ${embedding ? "generated" : "failed"}`;
}

function toolMemoryEpisodes(args: {
  entity?: string;
  outcome?: string;
  since?: string;
  until?: string;
  limit?: number;
}): string {
  const db = getDb();
  const limit = args.limit || 20;

  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'"
  ).get();
  if (!hasTable) return "Episodes table not found. Run `bun memory.ts migrate` first.";

  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (args.entity) {
    where.push("e.id IN (SELECT episode_id FROM episode_entities WHERE entity = ?)");
    params.push(args.entity);
  }
  if (args.outcome) {
    where.push("e.outcome = ?");
    params.push(args.outcome);
  }
  if (args.since) {
    where.push("e.happened_at >= ?");
    params.push(parseRelativeTime(args.since));
  }
  if (args.until) {
    where.push("e.happened_at <= ?");
    params.push(parseRelativeTime(args.until));
  }

  const rows = db.prepare(`
    SELECT e.* FROM episodes e
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY e.happened_at DESC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;

  if (rows.length === 0) return "No episodes found.";

  const results = rows.map(ep => {
    const entities = db.prepare(
      "SELECT entity FROM episode_entities WHERE episode_id = ?"
    ).all(ep.id as string) as Array<{ entity: string }>;

    const date = new Date((ep.happened_at as number) * 1000).toISOString().slice(0, 16).replace("T", " ");
    const duration = ep.duration_ms ? ` (${((ep.duration_ms as number) / 1000).toFixed(1)}s)` : "";
    const icon = { success: "\u2713", failure: "\u2717", resolved: "~", ongoing: "\u2026" }[ep.outcome as string] || "?";

    return `${icon} [${ep.outcome}] ${date}${duration}\n  ${ep.summary}` +
      (entities.length > 0 ? `\n  entities: ${entities.map(e => e.entity).join(", ")}` : "");
  });

  return `Found ${rows.length} episodes:\n\n${results.join("\n\n")}`;
}

function toolMemoryProcedures(args: { name?: string }): string {
  const db = getDb();

  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='procedures'"
  ).get();
  if (!hasTable) return "Procedures table not found. Run `bun memory.ts migrate` first.";

  if (args.name) {
    const row = db.prepare(
      "SELECT * FROM procedures WHERE name = ? ORDER BY version DESC LIMIT 1"
    ).get(args.name) as Record<string, unknown> | null;

    if (!row) return `Procedure not found: ${args.name}`;

    const steps = JSON.parse(row.steps as string) as Array<{
      executor: string; taskPattern: string; timeoutSeconds: number;
      fallbackExecutor?: string; notes?: string;
    }>;

    const stepsStr = steps.map((s, i) =>
      `  ${i + 1}. [${s.executor}] ${s.taskPattern} (${s.timeoutSeconds}s)` +
      (s.fallbackExecutor ? `\n     fallback: ${s.fallbackExecutor}` : "") +
      (s.notes ? `\n     note: ${s.notes}` : "")
    ).join("\n");

    return `Procedure: ${row.name} v${row.version}\n` +
      `Success rate: ${row.success_count}/${(row.success_count as number) + (row.failure_count as number)}\n` +
      (row.evolved_from ? `Evolved from: ${row.evolved_from}\n` : "") +
      `\nSteps:\n${stepsStr}`;
  }

  // List all procedures (latest version per name)
  const rows = db.prepare(
    "SELECT * FROM procedures ORDER BY name, version DESC"
  ).all() as Array<Record<string, unknown>>;

  if (rows.length === 0) return "No procedures found.";

  const seen = new Set<string>();
  const results: string[] = [];
  for (const p of rows) {
    const name = p.name as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const total = (p.success_count as number) + (p.failure_count as number);
    const rate = total > 0 ? (((p.success_count as number) / total) * 100).toFixed(0) : "\u2013";
    const steps = JSON.parse(p.steps as string) as unknown[];
    results.push(`  ${name} v${p.version}  (${p.success_count}/${total} = ${rate}% success)  ${steps.length} steps` +
      (p.evolved_from ? `\n    evolved from: ${p.evolved_from}` : ""));
  }

  return `Found ${results.length} procedures:\n\n${results.join("\n")}`;
}

function toolCognitiveProfile(args: { executor_id: string }): string {
  if (!existsSync(HISTORY_PATH)) return "No executor history found.";

  const history = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
  const prefix = `${args.executor_id}:`;
  const entries = Object.entries(history).filter(([k]) => k.startsWith(prefix));

  if (entries.length === 0) return `No history found for executor: ${args.executor_id}`;

  const results = entries.map(([key, entry]: [string, any]) => {
    const category = key.split(":")[1] || "unknown";
    const rate = entry.attempts > 0
      ? ((entry.successes / entry.attempts) * 100).toFixed(0)
      : "\u2013";

    let profile = `  ${category}: ${entry.successes}/${entry.attempts} = ${rate}% success, avg ${(entry.avgDurationMs / 1000).toFixed(1)}s`;

    if (entry.recent_episode_ids?.length) {
      profile += `\n    recent episodes: ${entry.recent_episode_ids.slice(0, 5).join(", ")}`;
    }
    if (entry.failure_patterns?.length) {
      profile += `\n    failure patterns: ${entry.failure_patterns.join(", ")}`;
    }
    if (entry.entity_affinities && Object.keys(entry.entity_affinities).length > 0) {
      const affinities = Object.entries(entry.entity_affinities)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 5)
        .map(([e, s]: [string, any]) => `${e}=${s.toFixed(2)}`)
        .join(", ");
      profile += `\n    entity affinities: ${affinities}`;
    }

    return profile;
  });

  return `Cognitive profile for ${args.executor_id}:\n\n${results.join("\n\n")}`;
}

// ==========================================================================
// MCP SERVER SETUP
// ==========================================================================

const server = new Server(
  { name: "zo-memory-system", version: "3.2.0" },
  { capabilities: { tools: {} } }
);

// --- List tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_search",
      description: "Search the memory system using hybrid FTS + vector search with RRF fusion. Returns facts matching the query.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          category: { type: "string", description: "Filter by category (preference, fact, decision, convention, other, reference, project)", enum: ["preference", "fact", "decision", "convention", "other", "reference", "project"] },
          persona: { type: "string", description: "Filter by persona name" },
          limit: { type: "number", description: "Max results (default: 6)" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_store",
      description: "Store a new fact in the memory system with automatic embedding generation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          entity: { type: "string", description: "Entity name (e.g., 'user', 'project.ffb')" },
          key: { type: "string", description: "Key/attribute (optional)" },
          value: { type: "string", description: "Value to store" },
          category: { type: "string", description: "Category (default: fact)", enum: ["preference", "fact", "decision", "convention", "other", "reference", "project"] },
          decay_class: { type: "string", description: "Decay class (default: stable)", enum: ["permanent", "stable", "active", "session", "checkpoint"] },
          persona: { type: "string", description: "Persona name (default: shared)" },
          text: { type: "string", description: "Full text for embedding (auto-generated if not provided)" },
        },
        required: ["entity", "value"],
      },
    },
    {
      name: "memory_episodes",
      description: "Query episodic memory — event-based records of what happened, with outcomes and entity tagging.",
      inputSchema: {
        type: "object" as const,
        properties: {
          entity: { type: "string", description: "Filter by entity" },
          outcome: { type: "string", description: "Filter by outcome", enum: ["success", "failure", "resolved", "ongoing"] },
          since: { type: "string", description: "Since when (e.g., '7 days ago', '2026-03-01', 'last week')" },
          until: { type: "string", description: "Until when (same formats as since)" },
          limit: { type: "number", description: "Max results (default: 20)" },
        },
      },
    },
    {
      name: "memory_procedures",
      description: "List or show workflow procedures — versioned step sequences with success/failure tracking.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Show specific procedure by name (omit to list all)" },
        },
      },
    },
    {
      name: "cognitive_profile",
      description: "Show the cognitive profile for a swarm executor — success rates, failure patterns, entity affinities, and recent episodes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          executor_id: { type: "string", description: "Executor ID (e.g., 'claude-code', 'gemini', 'codex', 'hermes')" },
        },
        required: ["executor_id"],
      },
    },
  ],
}));

// --- Call tool ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "memory_search":
        result = await toolMemorySearch(args as any);
        break;
      case "memory_store":
        result = await toolMemoryStore(args as any);
        break;
      case "memory_episodes":
        result = toolMemoryEpisodes(args as any);
        break;
      case "memory_procedures":
        result = toolMemoryProcedures(args as any);
        break;
      case "cognitive_profile":
        result = toolCognitiveProfile(args as any);
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    return { content: [{ type: "text", text: result }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error}` }],
      isError: true,
    };
  }
});

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("zo-memory-system MCP server running on stdio");
}

main().catch(console.error);
