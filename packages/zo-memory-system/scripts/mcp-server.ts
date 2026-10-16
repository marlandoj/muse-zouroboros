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
 *   memory_session_observations — Read-only retrieval over session-kind observations
 *     (plane-native observation layer; strictly per-actor, actor fail-closed)
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
import { computeGraphBoost, findGraphNeighbors } from "./graph-boost";
import {
  ensureIntelligencePlaneSchema,
  newCallId,
  notForgottenSql,
  recordAudit,
  resolveScope,
  scopeSql,
} from "./scope";
import { ensureObservationSchema } from "./observations";
import {
  searchSessionObservations,
  retrieveSessionObservations,
} from "./session-observer";

// --- Config ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";
const HISTORY_PATH = join(process.env.HOME || "/tmp", ".swarm", "executor-history.json");

// --- DB ---
let db: Database;

/** Exported for tests: the server's own DB handle (bound at first use). */
export function getDb(): Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    ensureIntelligencePlaneSchema(db);
    ensureObservationSchema(db);
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

export async function toolMemorySearch(args: {
  actor: string;
  query: string;
  category?: string;
  persona?: string;
  limit?: number;
}): Promise<string> {
  // Fail-closed (Track 1): no actor, no read. Results are scoped to the
  // actor's persona + the shared pool; `persona` only narrows within scope.
  const scope = resolveScope(args?.actor, "memory_search");
  const db = getDb();
  const { query, category, persona, limit = 6 } = args;
  const nowSec = Math.floor(Date.now() / 1000);
  recordAudit(db, { actor: scope.actor, scope: scope.personas.join(","), action: "search", callId: newCallId() });

  // FTS search
  const scoped = scopeSql(scope, "f.persona");
  const ftsWhere = [scoped.sql, notForgottenSql("f.id")];
  const ftsParams: SQLQueryBindings[] = [...scoped.params];

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
      AND ${scoped.sql}
      AND ${notForgottenSql("f.id")}
      ${persona ? "AND f.persona = ?" : ""}
      ${category ? "AND f.category = ?" : ""}
    `).all(
      ...[nowSec, ...scoped.params, ...(persona ? [persona] : []), ...(category ? [category] : [])]
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

  // Third signal: graph boost over fact_links/vault_links (reweights via
  // link structure) + 1-hop neighbor injection. Purely additive — any
  // failure falls back to the two-signal RRF ranking.
  let finalOrder: Array<{ id: string; score: number; viaGraph: boolean }>;
  try {
    const nowSec2 = Math.floor(Date.now() / 1000);
    const scored = ranked.map(([id, rrfScore]) => {
      const meta = db.prepare(
        "SELECT expires_at, confidence FROM facts WHERE id = ?"
      ).get(id) as { expires_at: number | null; confidence: number | null } | null;
      let freshness = 1;
      if (meta?.expires_at) {
        freshness = Math.max(0, Math.min(1, (meta.expires_at - nowSec2) / (14 * 24 * 3600)));
      }
      return {
        id,
        rrfScore,
        freshness,
        confidence: meta?.confidence ?? 1,
        sources: ["rrf"],
      };
    });
    const boosted = computeGraphBoost(db, scored);
    const topIds = boosted
      .sort((a, b) => b.composite - a.composite)
      .slice(0, 3)
      .map((r) => r.id);
    const existingIds = new Set(boosted.map((r) => r.id));
    // Scope-leak fix: neighbor injection is scope-filtered.
    const neighbors = findGraphNeighbors(db, topIds, existingIds, 2, scope);

    finalOrder = boosted
      .sort((a, b) => b.composite - a.composite)
      .slice(0, limit)
      .map((r) => ({ id: r.id, score: r.composite, viaGraph: r.graphBoost > 0 }));
    for (const n of neighbors) {
      if (finalOrder.length >= limit) break;
      finalOrder.push({ id: n.factId, score: n.weight * 0.15, viaGraph: true });
    }
  } catch {
    finalOrder = ranked.map(([id, score]) => ({ id, score, viaGraph: false }));
  }

  // Fetch full facts (re-checked against scope)
  const results: string[] = [];
  for (const { id, score, viaGraph } of finalOrder) {
    const row = db.prepare(
      `SELECT f.* FROM facts f WHERE f.id = ? AND ${scoped.sql} AND ${notForgottenSql("f.id")}`
    ).get(id, ...scoped.params) as Record<string, unknown> | null;
    if (row) {
      results.push(
        `[${row.decay_class}] ${row.entity}.${row.key || "_"} = ${(row.value as string).slice(0, 200)}` +
        `\n  score: ${score.toFixed(4)} | category: ${row.category} | source: ${row.source}` +
        (viaGraph ? " | via: graph" : "")
      );
    }
  }

  const scopeLine = `scope: actor=${scope.actor} personas=[${scope.personas.join(", ")}]`;
  return results.length > 0
    ? `Found ${results.length} results for "${query}" (${scopeLine}):\n\n${results.join("\n\n")}`
    : `No results found for "${query}" (${scopeLine}).`;
}

export async function toolMemoryStore(args: {
  actor: string;
  entity: string;
  key?: string;
  value: string;
  category?: string;
  decay_class?: string;
  persona?: string;
  text?: string;
}): Promise<string> {
  // Fail-closed (Track 1): no actor, no write. The fact's persona defaults
  // to the actor — never silently to 'shared'.
  const scope = resolveScope(args?.actor, "memory_store");
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const category = args.category || "fact";
  const decayClass = args.decay_class || "stable";
  const persona = args.persona || scope.actor;

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
  `).run(id, persona, args.entity, args.key || null,
    args.value, text, category, decayClass, now, expiresAt, nowSec);

  recordAudit(db, { actor: scope.actor, scope: persona, action: "store", factId: id });

  // Generate embedding
  const embedding = await getEmbedding(text);
  if (embedding) {
    db.prepare("INSERT INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
      .run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
  }

  return `Stored fact ${id}\n  entity: ${args.entity}\n  key: ${args.key || "(none)"}\n  value: ${args.value.slice(0, 100)}\n  persona: ${persona}\n  scope: actor=${scope.actor} personas=[${scope.personas.join(", ")}]\n  embedding: ${embedding ? "generated" : "failed"}`;
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

/**
 * memory_session_observations — read-only retrieval over the plane-native
 * observation layer (session-observer.ts). Curated, dated per-session
 * digests with evidence links, returned bounded top-K (never whole-history
 * in context). Strictly per-actor (v1 governance): actor is required and
 * fail-closed; only observations with persona = actor are visible.
 * Observer triggering (observeSessions/fade) is deliberately NOT exposed.
 */
export async function toolMemorySessionObservations(args: {
  action: string;
  actor: string;
  query: string;
  limit?: number;
}): Promise<string> {
  const db = getDb();
  const action = args.action as string;
  const query = args.query as string;
  if (!query) throw new Error("query is required for memory_session_observations");
  const hits =
    action === "search"
      ? searchSessionObservations(db, query, { actor: args.actor, limit: args.limit })
      : action === "retrieve"
        ? retrieveSessionObservations(db, query, { actor: args.actor, limit: args.limit })
        : null;
  if (!hits) throw new Error(`Unknown memory_session_observations action: ${action}`);
  if (hits.length === 0) return "No session observations found.";
  const lines = hits.map((h) => {
    const date = h.observedAt
      ? new Date(h.observedAt * 1000).toISOString().slice(0, 10)
      : "undated";
    return `- [${h.id}] ${date} (${h.decayClass}, ${h.proofCount} evidence)\n  ${h.text}`;
  });
  return `Found ${hits.length} session observation${hits.length === 1 ? "" : "s"}:\n\n${lines.join("\n\n")}`;
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
// Extracted (and exported) so tests can pin the tool surface without
// standing up the stdio server.
export const TOOLS = [
    {
      name: "memory_search",
      description: "Search the memory system using hybrid FTS + vector search with RRF fusion. Requires a caller identity (actor); calls without one fail closed with MISSING_ACTOR. Results are scoped to the actor plus the shared pool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          actor: { type: "string", description: "REQUIRED caller identity (persona/seat, e.g. 'claude-code'). Fail-closed: calls without an actor are rejected. Visibility = own persona + shared pool." },
          query: { type: "string", description: "Search query" },
          category: { type: "string", description: "Filter by category (preference, fact, decision, convention, other, reference, project)", enum: ["preference", "fact", "decision", "convention", "other", "reference", "project"] },
          persona: { type: "string", description: "Narrow results to one persona WITHIN the actor scope" },
          limit: { type: "number", description: "Max results (default: 6)" },
        },
        required: ["actor", "query"],
      },
    },
    {
      name: "memory_store",
      description: "Store a new fact in the memory system with automatic embedding generation. Requires a caller identity (actor); calls without one fail closed with MISSING_ACTOR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          actor: { type: "string", description: "REQUIRED caller identity (persona/seat). Fail-closed: calls without an actor are rejected. Use 'shared' only for deliberately cross-persona facts." },
          entity: { type: "string", description: "Entity name (e.g., 'user', 'project.ffb')" },
          key: { type: "string", description: "Key/attribute (optional)" },
          value: { type: "string", description: "Value to store" },
          category: { type: "string", description: "Category (default: fact)", enum: ["preference", "fact", "decision", "convention", "other", "reference", "project"] },
          decay_class: { type: "string", description: "Decay class (default: stable)", enum: ["permanent", "stable", "active", "session", "checkpoint"] },
          persona: { type: "string", description: "Persona the fact is stored under (defaults to the actor, never silently 'shared')" },
          text: { type: "string", description: "Full text for embedding (auto-generated if not provided)" },
        },
        required: ["actor", "entity", "value"],
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
    {
      name: "memory_session_observations",
      description: "Read session-kind observations — the plane-native observation layer retrieval signal. Curated, dated per-session digests with evidence links, retrieved bounded top-K (never whole-history in context). Strictly per-actor (v1 governance): actor is required and fail-closed via requireActor; only observations with persona = actor are visible. Read-only: observer triggering is not exposed here.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["search", "retrieve"], description: "search: keyword over session observations; retrieve: RRF-fused bounded top-K (the eval-probe read path)" },
          actor: { type: "string", description: "Actor identity — required, fail-closed. Missing/empty actor throws MISSING_ACTOR." },
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["action", "actor", "query"],
      },
    },
  ];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

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
      case "memory_session_observations":
        result = await toolMemorySessionObservations(args as any);
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
  console.error("memory_search/memory_store require an 'actor' argument (fail-closed; old clients get MISSING_ACTOR)");
}

if (import.meta.main) {
  main().catch(console.error);
}
