#!/usr/bin/env bun
/**
 * eval-three-signal.ts — Per-signal ablation harness for three-signal
 * retrieval (keyword + vector + graph), following the three-stage-eval
 * discipline: mechanical → semantic → consensus.
 *
 * Measures the LIVE default path (memory.ts hybridSearch: FTS + vector RRF
 * fusion + graph boost + neighbor injection) against each signal in
 * isolation, so a regression in any one signal is attributable.
 *
 * Method
 *  - Hermetic: mkdtemp scratch DB (ZO_MEMORY_DB redirected via initDb);
 *    OPENAI_API_KEY / ZO_OPENAI_API_KEY / ANTHROPIC_API_KEY stripped and
 *    restored, so no network path can fire.
 *  - Vector arm runs on the `deterministic` embedding provider
 *    (ZO_MODEL_EMBEDDING="deterministic:hash-v1", model-client.ts): zero
 *    cost, zero network, byte-identical across machines. It exercises the
 *    vector plumbing and RRF fusion; real semantic quality belongs to a
 *    nightly real-embedding lane (documented, not default).
 *  - Golden manifest: entity-direct facts (keyword territory), paraphrase +
 *    near-miss pairs (vector territory), graph-linked hub→spoke groups
 *    (explicit fact_links edges — this package's native graph substrate; the
 *    gold fact lives on the spoke, reachable only through the link),
 *    temporal-update groups (stale fact seeded first with HIGHER
 *    importance), contested pairs with pending fact_conflicts rows
 *    (correct = abstain), decay-expiry fixtures (the expired fact gets
 *    HIGHER importance — if the expires_at filter ever breaks, the gate goes
 *    red), and correction-recall groups.
 *  - Arms: keyword (ftsSearch), vector (vectorSearch), graph (entity-seeded
 *    fact_links walk, neighbors only), keyword-vector (direct RRF fusion of
 *    the two legs), all-three (hybridSearch, graph on — the production
 *    default), no-graph-boost (hybridSearch, graph off — the A/B mirror).
 *  - Abstention policy (uniform across arms): if the top-1 fact is half of a
 *    pending fact_conflicts pair and its counterpart also surfaced in top-K,
 *    the arm abstains. Near-miss queries are correct only on an EMPTY result
 *    set (strict rejection).
 *  - Stage 1 (mechanical): deterministic top-1/top-K accuracy per arm and
 *    per category; exact assertions in the CI gate test.
 *  - Stage 2 (semantic): paraphrase recall, near-miss rejection, correction
 *    recall, decay-expiry exclusion (must be zero surfaced), graph
 *    contribution on entity-linked questions (top-K: can the production
 *    path surface the spoke at all without the graph?), contested abstention.
 *  - Stage 3 (consensus): pairwise top-1 arm agreement + the A/B verdict
 *    (graph boost helps / hurts / neutral, with numbers).
 *  - Efficiency on every query: latency p50/p95/mean per arm, embedding-call
 *    counts, estimated query+context tokens (chars/4), context size, and the
 *    cost the same run would incur on the real embedding provider.
 *
 * All fixtures and arms run under a single eval actor (fail-closed scope).
 *
 * Usage: bun scripts/eval-three-signal.ts [--json]
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  initDb,
  closeDb,
  storeWithEmbedding,
  ftsSearch,
  vectorSearch,
  hybridSearch,
  type MemoryEntry,
} from "./memory";
import { findGraphNeighbors } from "./graph-boost";
import { notForgottenSql, resolveScope, scopeSql } from "./scope";

// ---------------------------------------------------------------------------
// Golden manifest
// ---------------------------------------------------------------------------

export const TOP_K = 5;

/** Entity-direct: single-word entities, query = entity name (keyword territory). */
const ENTITY_DIRECT: Array<{ entity: string; value: string; gold: string }> = [
  { entity: "quartz", value: "Quartz schedules the nightly maintenance sweep at 03:15 UTC", gold: "03:15" },
  { entity: "forge", value: "Forge builds release artifacts with reproducible checksums", gold: "reproducible" },
  { entity: "lumen", value: "Lumen renders the status dashboard from streamed metrics", gold: "dashboard" },
  { entity: "pylon", value: "Pylon terminates TLS and forwards traffic to the internal mesh", gold: "TLS" },
  { entity: "vertex", value: "Vertex stores workflow definitions as signed documents", gold: "signed" },
  { entity: "crucible", value: "Crucible replays failed jobs against candidate fixes", gold: "replays" },
];

/** Paraphrase + near-miss pairs on dotted entities. Paraphrases share most
 *  content tokens with the fact; near-misses share almost none and have NO
 *  stored answer — correct behavior is an empty result set. */
const PARAPHRASE_GROUPS: Array<{ entity: string; value: string; paraphrase: string; nearMiss: string; gold: string }> = [
  {
    entity: "workspace.editor",
    value: "Primary editor is Neovim with tokyonight theme and relative line numbers",
    paraphrase: "neovim editor tokyonight theme relative line numbers",
    nearMiss: "emacs solarized palette absolute gutter numbering",
    gold: "Neovim",
  },
  {
    entity: "deploy.host",
    value: "Production API served from a Hetzner CX32 box in Falkenstein",
    paraphrase: "hetzner cx32 falkenstein production api box",
    nearMiss: "graviton instance virginia staging frontend droplet",
    gold: "Hetzner",
  },
  {
    entity: "db.backup",
    value: "Postgres backups stream nightly to Backblaze B2 with restic",
    paraphrase: "restic streams postgres backups nightly backblaze b2",
    nearMiss: "mysql dumps weekly glacier archive borg",
    gold: "restic",
  },
  {
    entity: "queue.broker",
    value: "Task queue runs on NATS JetStream with three replicas",
    paraphrase: "nats jetstream task queue three replicas",
    nearMiss: "rabbitmq cluster five mirrors message fanout",
    gold: "NATS",
  },
  {
    entity: "docs.site",
    value: "Documentation site is built with Astro Starlight and deployed on push",
    paraphrase: "astro starlight documentation site deployed push",
    nearMiss: "docusaurus wiki published manually each friday",
    gold: "Starlight",
  },
  {
    entity: "alerts.channel",
    value: "Pager alerts route to the oncall channel with severity tags",
    paraphrase: "pager alerts oncall channel severity tags route",
    nearMiss: "email digest weekly summary inbox folder",
    gold: "oncall",
  },
];

/** Graph-linked hub→spoke groups. The query names the hub entity plus filler
 *  words that appear in NO stored fact; the gold fact lives on the spoke,
 *  reachable only through an explicit fact_links edge (this package's native
 *  graph substrate). Keyword and vector miss the spoke by construction —
 *  this isolates the graph signal. */
const GRAPH_GROUPS: Array<{
  hub: string; hubValue: string;
  spoke: string; spokeValue: string;
  query: string; gold: string;
}> = [
  {
    hub: "herald", hubValue: "Herald service health is green",
    spoke: "signalbus", spokeValue: "Signalbus fans messages across sharded consumers",
    query: "herald downstream delivery dependency", gold: "sharded",
  },
  {
    hub: "atlas", hubValue: "Atlas ingestion pipeline is enabled",
    spoke: "ledgerd", spokeValue: "Ledgerd persists events in append-only segments",
    query: "atlas storage persistence layer", gold: "append-only",
  },
  {
    hub: "sentinel", hubValue: "Sentinel probe cadence is five minutes",
    spoke: "warden", spokeValue: "Warden quarantines suspicious payloads before handoff",
    query: "sentinel escalation handler target", gold: "quarantines",
  },
  {
    hub: "beacon", hubValue: "Beacon emits heartbeat pulses on the mesh",
    spoke: "relayd", spokeValue: "Relayd forwards pulses to regional collectors",
    query: "beacon forwarding chain endpoint", gold: "collectors",
  },
];

/** Temporal updates: stale fact seeded FIRST with HIGHER importance. */
const UPDATE_GROUPS: Array<{ entity: string; oldValue: string; newValue: string; gold: string }> = [
  { entity: "deploy.region", oldValue: "Deployment region is us-east-1 (legacy)", newValue: "Deployment region migrated to eu-central-1", gold: "eu-central-1" },
  { entity: "api.version", oldValue: "API version v1.4.2 in production", newValue: "API version v2.0.0 in production", gold: "v2.0.0" },
  { entity: "cache.backend", oldValue: "Cache backend is Redis 6", newValue: "Cache backend is Valkey 8", gold: "Valkey 8" },
  { entity: "ci.runner", oldValue: "CI runs on hosted runners", newValue: "CI runs on self-hosted BuildJet runners", gold: "BuildJet" },
];

/** Contested pairs: unresolved contradiction — correct behavior is abstention. */
const CONTESTED_GROUPS: Array<{ entity: string; valueA: string; valueB: string }> = [
  { entity: "deploy.strategy", valueA: "Blue-green deploys are the standard", valueB: "Rolling deploys are the standard" },
  { entity: "api.protocol", valueA: "Public API is GraphQL only", valueB: "Public API is REST only" },
  { entity: "db.sharding", valueA: "Sharding is enabled for all tenants", valueB: "Sharding is disabled for all tenants" },
];

/** Decay-expiry: the expired fact gets HIGHER importance than its live
 *  replacement — if the expires_at filter ever breaks on any arm, the
 *  expired fact outranks the gold and the gate goes red. */
const DECAY_GROUPS: Array<{ entity: string; expiredValue: string; liveValue: string; gold: string }> = [
  { entity: "token.rotation", expiredValue: "Stale guidance: rotate tokens quarterly by hand", liveValue: "Tokens rotate automatically every 30 days", gold: "30 days" },
  { entity: "cert.renewal", expiredValue: "Certificates renewed manually via support ticket", liveValue: "Certificates auto-renew through ACME with a 21 day window", gold: "ACME" },
  { entity: "log.purge", expiredValue: "Logs purged ad hoc when disk fills", liveValue: "Logs purge on a 45 day retention schedule", gold: "45 day" },
];

/** Correction recall: the wrong fact outranks the correction on importance;
 *  the query shares tokens with the CORRECTION, so token-overlap retrieval
 *  must recover it. */
const CORRECTION_GROUPS: Array<{ entity: string; wrongValue: string; correctionValue: string; query: string; gold: string }> = [
  {
    entity: "backup.cadence",
    wrongValue: "Backups run weekly on Fridays",
    correctionValue: "Correction: backups actually run nightly at 02:00 UTC",
    query: "backups actually run at utc",
    gold: "02:00",
  },
  {
    entity: "mesh.port",
    wrongValue: "Mesh gateway listens on port 8080",
    correctionValue: "Correction: mesh gateway now listens on port 9443",
    query: "which port does the mesh gateway now listen on",
    gold: "9443",
  },
  {
    entity: "retry.budget",
    wrongValue: "Retry budget is three attempts per request",
    correctionValue: "Correction: retry budget raised to five attempts with jitter",
    query: "retry budget attempts raised with jitter",
    gold: "five",
  },
];

// ---------------------------------------------------------------------------
// Question set
// ---------------------------------------------------------------------------

export type Category =
  | "entity-direct"
  | "semantic-paraphrase"
  | "semantic-near-miss"
  | "graph-linked"
  | "temporal-update"
  | "contested"
  | "decay-expiry"
  | "correction";

interface EvalQuestion {
  category: Category;
  query: string;
  /** Gold substring, or 'ABSTAIN' (contested) / 'NONE' (near-miss rejection). */
  gold: string;
}

const QUESTIONS: EvalQuestion[] = [
  ...ENTITY_DIRECT.map((f) => ({ category: "entity-direct" as const, query: f.entity, gold: f.gold })),
  ...PARAPHRASE_GROUPS.map((g) => ({ category: "semantic-paraphrase" as const, query: g.paraphrase, gold: g.gold })),
  ...PARAPHRASE_GROUPS.map((g) => ({ category: "semantic-near-miss" as const, query: g.nearMiss, gold: "NONE" })),
  ...GRAPH_GROUPS.map((g) => ({ category: "graph-linked" as const, query: g.query, gold: g.gold })),
  ...UPDATE_GROUPS.map((g) => ({ category: "temporal-update" as const, query: g.entity, gold: g.gold })),
  ...CONTESTED_GROUPS.map((g) => ({ category: "contested" as const, query: g.entity, gold: "ABSTAIN" })),
  ...DECAY_GROUPS.map((g) => ({ category: "decay-expiry" as const, query: g.entity, gold: g.gold })),
  ...CORRECTION_GROUPS.map((g) => ({ category: "correction" as const, query: g.query, gold: g.gold })),
];

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

export type ArmName = "keyword" | "vector" | "graph" | "keyword-vector" | "all-three" | "no-graph-boost";

/** Single eval identity: all fixtures and arms share one fail-closed scope. */
const EVAL_ACTOR = "eval-three-signal";
const EVAL_SCOPE = resolveScope(EVAL_ACTOR);

export const ARM_NAMES: ArmName[] = ["keyword", "vector", "graph", "keyword-vector", "all-three", "no-graph-boost"];

/** Arms that generate one query embedding per question (hybridSearch always
 *  embeds the query; the direct fusion arm embeds once for its vector leg). */
const EMBEDDING_ARMS: ReadonlySet<ArmName> = new Set(["vector", "keyword-vector", "all-three", "no-graph-boost"]);

interface ArmResult {
  entry: Pick<MemoryEntry, "id" | "value">;
  score: number;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface SeededBank {
  /** fact id → counterpart fact id for every pending conflict pair. */
  conflictPairs: Map<string, string>;
  /** fact ids that are expired and must NEVER surface on any arm. */
  expiredIds: Set<string>;
}

async function seed(entity: string, value: string, importance: number, decay: "stable" | "checkpoint" = "stable", key = "fact") {
  const entry = await storeWithEmbedding({
    entity,
    key,
    value,
    text: `${entity} ${key}: ${value}`,
    category: "fact",
    decayClass: decay,
    importance,
    source: "eval-fixture",
    confidence: 1.0,
  }, { actor: EVAL_ACTOR, skipWikilinkEnforcement: true });
  if (!entry) throw new Error(`seed failed for ${entity}`);
  return entry;
}

async function seedBank(): Promise<SeededBank> {
  const db = await initDb();

  for (const f of ENTITY_DIRECT) await seed(f.entity, f.value, 0.9);
  for (const g of PARAPHRASE_GROUPS) await seed(g.entity, g.value, 0.9);

  // Graph groups: hub + spoke facts connected by an explicit fact_links edge.
  for (const g of GRAPH_GROUPS) {
    const hub = await seed(g.hub, g.hubValue, 0.6);
    const spoke = await seed(g.spoke, g.spokeValue, 0.9);
    db.prepare(
      "INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'related', 1.0)"
    ).run(hub.id, spoke.id);
  }

  // Temporal: stale fact first with HIGHER importance.
  for (const g of UPDATE_GROUPS) {
    await seed(g.entity, g.oldValue, 0.85, "stable", "state");
    await seed(g.entity, g.newValue, 0.8, "stable", "state");
  }

  // Contested pairs + pending conflict rows (same DDL as conflict-resolver.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_conflicts (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      conflicting_fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      conflict_type TEXT NOT NULL,
      resolution TEXT CHECK(resolution IN ('superseded','merged','flagged','pending')),
      resolved_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  const conflictPairs = new Map<string, string>();
  for (const g of CONTESTED_GROUPS) {
    const a = await seed(g.entity, g.valueA, 0.7, "stable", "claim");
    const b = await seed(g.entity, g.valueB, 0.7, "stable", "claim");
    db.prepare(
      `INSERT INTO fact_conflicts (id, fact_id, conflicting_fact_id, conflict_type, resolution) VALUES (?, ?, ?, 'semantic', 'pending')`
    ).run(randomUUID(), a.id, b.id);
    conflictPairs.set(a.id, b.id);
    conflictPairs.set(b.id, a.id);
  }

  // Decay-expiry: expired fact has HIGHER importance; expiry forced into the past.
  const expiredIds = new Set<string>();
  for (const g of DECAY_GROUPS) {
    const expired = await seed(g.entity, g.expiredValue, 0.95, "checkpoint", "policy");
    db.prepare("UPDATE facts SET expires_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000) - 1000, expired.id);
    expiredIds.add(expired.id);
    await seed(g.entity, g.liveValue, 0.6, "stable", "policy");
  }

  // Correction recall: wrong fact first with HIGHER importance.
  for (const g of CORRECTION_GROUPS) {
    await seed(g.entity, g.wrongValue, 0.9, "stable", "note");
    await seed(g.entity, g.correctionValue, 0.7, "stable", "note");
  }

  return { conflictPairs, expiredIds };
}

// ---------------------------------------------------------------------------
// Graph-only arm: entity-seeded fact_links walk, neighbors only.
//
// Mirrors how the production graph leg contributes: facts whose entity name
// appears in the query are seeds; the arm returns ONLY what the graph adds
// (the linked neighbors), so its signal is fully isolated from keyword.
// ---------------------------------------------------------------------------

async function graphArm(query: string): Promise<ArmResult[]> {
  const db = await initDb();
  const nowSec = Math.floor(Date.now() / 1000);
  const tokens = Array.from(new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []));
  if (tokens.length === 0) return [];

  const scoped = scopeSql(EVAL_SCOPE);
  const seeds = db.prepare(
    `SELECT id FROM facts
     WHERE lower(entity) IN (${tokens.map(() => "?").join(",")})
       AND (expires_at IS NULL OR expires_at > ?)
       AND ${notForgottenSql()}
       AND ${scoped.sql}
     ORDER BY created_at ASC`
  ).all(...tokens, nowSec, ...scoped.params) as Array<{ id: string }>;
  const seedIds = seeds.map((s) => s.id);
  if (seedIds.length === 0) return [];

  const neighbors = findGraphNeighbors(db, seedIds, new Set(seedIds), TOP_K, EVAL_SCOPE);
  const results: ArmResult[] = [];
  const scoped2 = scopeSql(EVAL_SCOPE);
  for (const n of neighbors) {
    const row = db.prepare(
      `SELECT id, value FROM facts
       WHERE id = ? AND (expires_at IS NULL OR expires_at > ?) AND ${notForgottenSql()} AND ${scoped2.sql}`
    ).get(n.factId, nowSec, ...scoped2.params) as { id: string; value: string } | null;
    if (row) results.push({ entry: row, score: n.weight });
  }
  return results.slice(0, TOP_K);
}

/** Direct two-signal RRF fusion (keyword + vector), mirroring the hybrid
 *  core without graph participation — the explicit keyword-vector arm. */
async function keywordVectorArm(query: string): Promise<ArmResult[]> {
  const [kw, vec] = [
    await ftsSearch(query, { actor: EVAL_ACTOR, limit: TOP_K * 2 }),
    await vectorSearch(query, { actor: EVAL_ACTOR, limit: TOP_K * 2 }),
  ];
  const k = 60;
  const rrf = new Map<string, { entry: ArmResult["entry"]; score: number }>();
  kw.forEach((r, i) => {
    const prev = rrf.get(r.entry.id);
    rrf.set(r.entry.id, { entry: r.entry, score: (prev?.score ?? 0) + 1 / (k + i + 1) });
  });
  vec.forEach((r, i) => {
    const prev = rrf.get(r.entry.id);
    rrf.set(r.entry.id, { entry: r.entry, score: (prev?.score ?? 0) + 1 / (k + i + 1) });
  });
  return Array.from(rrf.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);
}

// ---------------------------------------------------------------------------
// Answer policy + scoring
// ---------------------------------------------------------------------------

interface ArmAnswer {
  results: ArmResult[];
  answer: string;
  abstained: boolean;
}

function answerFromResults(results: ArmResult[], bank: SeededBank): ArmAnswer {
  if (results.length === 0) return { results, answer: "(no result)", abstained: false };
  const top = results[0];
  const counterpart = bank.conflictPairs.get(top.entry.id);
  if (counterpart && results.some((r) => r.entry.id === counterpart)) {
    return { results, answer: "ABSTAIN (contested evidence)", abstained: true };
  }
  return { results, answer: top.entry.value, abstained: false };
}

function scoreTop1(q: EvalQuestion, a: ArmAnswer): boolean {
  if (q.gold === "NONE") return a.results.length === 0;
  if (q.gold === "ABSTAIN") return a.abstained;
  return !a.abstained && a.results.length > 0 && a.results[0].entry.value.toLowerCase().includes(q.gold.toLowerCase());
}

function scoreTopK(q: EvalQuestion, a: ArmAnswer): boolean {
  if (q.gold === "NONE") return a.results.length === 0;
  if (q.gold === "ABSTAIN") return a.abstained;
  return a.results.some((r) => r.entry.value.toLowerCase().includes(q.gold.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** text-embedding-3-small list price, USD per token (the cost this run would
 *  incur per embedded query on the real provider; the hermetic run spends $0). */
const REAL_EMBEDDING_USD_PER_TOKEN = 0.02 / 1_000_000;

const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export interface ArmEfficiency {
  embeddingCalls: number;
  estimatedQueryTokens: number;
  estimatedContextTokens: number;
  meanContextChars: number;
  actualCostUsd: number;
  realProviderCostUsd: number;
}

export interface ArmMetrics {
  top1Correct: number;
  topKCorrect: number;
  correctAbstentions: number;
  correctRejections: number;
  latency: { p50Ms: number; p95Ms: number; meanMs: number };
  efficiency: ArmEfficiency;
}

export interface ThreeSignalReport {
  questions: number;
  topK: number;
  arms: Record<ArmName, ArmMetrics>;
  byCategory: Record<Category, { total: number } & Record<ArmName, number>>;
  stage2: {
    paraphraseRecall: Record<ArmName, { hit: number; total: number }>;
    nearMissRejection: Record<ArmName, { rejected: number; total: number }>;
    correctionRecall: Record<ArmName, { hit: number; total: number }>;
    contestedAbstention: Record<ArmName, { abstained: number; total: number }>;
    decayExclusion: { expiredSurfaced: number; queriesChecked: number };
    /** Graph contribution measured on top-K: without the graph the spoke
     *  cannot surface at all through the production path. */
    graphBoostContribution: { entityLinkedQuestions: number; allThreeTopK: number; noBoostTopK: number; contribution: number };
  };
  stage3: {
    agreement: Array<{ a: ArmName; b: ArmName; top1AgreementRate: number }>;
    abVerdict: { verdict: "helps" | "hurts" | "neutral"; allThreeTopK: number; noBoostTopK: number; delta: number };
  };
  rows: Array<{
    category: Category;
    query: string;
    gold: string;
    perArm: Record<ArmName, { top1Ok: boolean; topKOk: boolean; hits: number }>;
  }>;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1) + 0.5))];
}

function perArm<T>(make: () => T): Record<ArmName, T> {
  return Object.fromEntries(ARM_NAMES.map((a) => [a, make()])) as Record<ArmName, T>;
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

export async function runThreeSignalEval(dbPath: string): Promise<ThreeSignalReport> {
  // Hermetic: strip API keys (every model/embedding network path must fail or
  // fall back deterministically), force the deterministic embedding provider,
  // and redirect the memory DB to the scratch path. All restored on return.
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ["OPENAI_API_KEY", "ZO_OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ZO_MODEL_EMBEDDING", "ZO_MEMORY_DB"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";
  process.env.ZO_MEMORY_DB = dbPath;

  try {
    await initDb(dbPath);

    // ── Construction phase — no question text participates. ──
    const bank = await seedBank();

    const armRunners: Record<ArmName, (q: EvalQuestion) => Promise<ArmResult[]>> = {
      keyword: (q) => ftsSearch(q.query, { actor: EVAL_ACTOR, limit: TOP_K }),
      vector: (q) => vectorSearch(q.query, { actor: EVAL_ACTOR, limit: TOP_K }),
      graph: (q) => graphArm(q.query),
      "keyword-vector": (q) => keywordVectorArm(q.query),
      "all-three": (q) => hybridSearch(q.query, { actor: EVAL_ACTOR, limit: TOP_K, useHyde: false, useGraph: true }),
      "no-graph-boost": (q) => hybridSearch(q.query, { actor: EVAL_ACTOR, limit: TOP_K, useHyde: false, useGraph: false }),
    };

    // ── Evaluation phase — held-out questions against the frozen bank. ──
    const latencies = perArm<number[]>(() => []);
    const metrics = perArm<ArmMetrics>(() => ({
      top1Correct: 0, topKCorrect: 0, correctAbstentions: 0, correctRejections: 0,
      latency: { p50Ms: 0, p95Ms: 0, meanMs: 0 },
      efficiency: { embeddingCalls: 0, estimatedQueryTokens: 0, estimatedContextTokens: 0, meanContextChars: 0, actualCostUsd: 0, realProviderCostUsd: 0 },
    }));
    const byCategory = {} as ThreeSignalReport["byCategory"];
    const rows: ThreeSignalReport["rows"] = [];
    const paraphraseRecall = perArm(() => ({ hit: 0, total: 0 }));
    const correctionRecall = perArm(() => ({ hit: 0, total: 0 }));
    const nearMissRejection = perArm(() => ({ rejected: 0, total: 0 }));
    const contestedAbstention = perArm(() => ({ abstained: 0, total: 0 }));
    let expiredSurfaced = 0;
    const contextChars = perArm(() => 0);
    const top1Ids = perArm<Array<string | null>>(() => []);
    const graphContribution = { entityLinkedQuestions: 0, allThreeTopK: 0, noBoostTopK: 0, contribution: 0 };

    for (const q of QUESTIONS) {
      const cat = (byCategory[q.category] ??= Object.assign({ total: 0 }, perArm(() => 0)));
      cat.total++;

      const rowPerArm = {} as Record<ArmName, { top1Ok: boolean; topKOk: boolean; hits: number }>;
      const perArmTopKOk = {} as Record<ArmName, boolean>;

      for (const arm of ARM_NAMES) {
        const t0 = performance.now();
        const results = await armRunners[arm](q);
        const latencyMs = performance.now() - t0;
        latencies[arm].push(latencyMs);

        // Fail-closed invariant: an expired fact surfacing ANYWHERE is a defect.
        expiredSurfaced += results.filter((r) => bank.expiredIds.has(r.entry.id)).length;

        const a = answerFromResults(results, bank);
        const top1Ok = scoreTop1(q, a);
        const topKOk = scoreTopK(q, a);
        const m = metrics[arm];
        if (top1Ok) { m.top1Correct++; cat[arm]++; }
        if (topKOk) m.topKCorrect++;
        if (q.gold === "ABSTAIN") {
          contestedAbstention[arm].total++;
          if (a.abstained) { m.correctAbstentions++; contestedAbstention[arm].abstained++; }
        }
        if (q.gold === "NONE") {
          nearMissRejection[arm].total++;
          if (results.length === 0) { m.correctRejections++; nearMissRejection[arm].rejected++; }
        }
        if (q.category === "semantic-paraphrase") {
          paraphraseRecall[arm].total++;
          if (topKOk) paraphraseRecall[arm].hit++;
        }
        if (q.category === "correction") {
          correctionRecall[arm].total++;
          if (top1Ok) correctionRecall[arm].hit++;
        }

        const ctxChars = results.reduce((sum, r) => sum + r.entry.value.length, 0);
        contextChars[arm] += ctxChars;
        const queryTokens = estimateTokens(q.query.length);
        m.efficiency.estimatedQueryTokens += queryTokens;
        m.efficiency.estimatedContextTokens += estimateTokens(ctxChars);
        if (EMBEDDING_ARMS.has(arm)) {
          m.efficiency.embeddingCalls += 1;
          m.efficiency.realProviderCostUsd += queryTokens * REAL_EMBEDDING_USD_PER_TOKEN;
        }

        top1Ids[arm].push(results.length > 0 ? results[0].entry.id : null);
        perArmTopKOk[arm] = topKOk;
        rowPerArm[arm] = { top1Ok, topKOk, hits: results.length };
      }

      if (q.category === "graph-linked") {
        graphContribution.entityLinkedQuestions++;
        if (perArmTopKOk["all-three"]) graphContribution.allThreeTopK++;
        if (perArmTopKOk["no-graph-boost"]) graphContribution.noBoostTopK++;
      }

      rows.push({ category: q.category, query: q.query, gold: q.gold, perArm: rowPerArm });
    }
    graphContribution.contribution = graphContribution.allThreeTopK - graphContribution.noBoostTopK;

    const n = QUESTIONS.length;
    for (const arm of ARM_NAMES) {
      const sorted = [...latencies[arm]].sort((a, b) => a - b);
      metrics[arm].latency = {
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        meanMs: sorted.reduce((s, v) => s + v, 0) / n,
      };
      metrics[arm].efficiency.meanContextChars = contextChars[arm] / n;
      metrics[arm].efficiency.realProviderCostUsd = Number(metrics[arm].efficiency.realProviderCostUsd.toFixed(8));
    }

    const agreement: ThreeSignalReport["stage3"]["agreement"] = [];
    for (let i = 0; i < ARM_NAMES.length; i++) {
      for (let j = i + 1; j < ARM_NAMES.length; j++) {
        const a = ARM_NAMES[i];
        const b = ARM_NAMES[j];
        let agree = 0;
        for (let k = 0; k < n; k++) {
          if (top1Ids[a][k] === top1Ids[b][k]) agree++;
        }
        agreement.push({ a, b, top1AgreementRate: Number((agree / n).toFixed(4)) });
      }
    }

    // A/B verdict on top-K: in this package the graph's contribution is
    // neighbor INJECTION (adds otherwise-unreachable facts to the context),
    // so recall-at-K is the honest measure of what the boost buys.
    const allThreeTopK = metrics["all-three"].topKCorrect;
    const noBoostTopK = metrics["no-graph-boost"].topKCorrect;
    const delta = allThreeTopK - noBoostTopK;

    return {
      questions: n,
      topK: TOP_K,
      arms: metrics,
      byCategory,
      stage2: {
        paraphraseRecall,
        nearMissRejection,
        correctionRecall,
        contestedAbstention,
        decayExclusion: { expiredSurfaced, queriesChecked: n * ARM_NAMES.length },
        graphBoostContribution: graphContribution,
      },
      stage3: {
        agreement,
        abVerdict: {
          verdict: delta > 0 ? "helps" : delta < 0 ? "hurts" : "neutral",
          allThreeTopK,
          noBoostTopK,
          delta,
        },
      },
      rows,
    };
  } finally {
    // Leave no state behind: close the scratch singleton (the next initDb()
    // reopens the process default) and restore every saved env var.
    closeDb();
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatReport(report: ThreeSignalReport): string {
  const pct = (x: number, total: number) => (total === 0 ? "n/a" : `${((x / total) * 100).toFixed(1)}%`);
  const n = report.questions;
  const lines: string[] = [
    "## Three-signal retrieval eval — per-signal ablation (mechanical → semantic → consensus)",
    "",
    `${n} held-out questions, top-K=${report.topK}, deterministic pseudo-embeddings (zero network, zero cost). Arms: ${ARM_NAMES.join(", ")}.`,
    "",
    "### Stage 1 — mechanical (top-1 / top-K accuracy)",
    "",
    "| Arm | Top-1 | Top-K | Abstentions | Rejections | p50 | p95 | Embedding calls | Mean context chars |",
    "|---|---|---|---|---|---|---|---|---|",
    ...ARM_NAMES.map((a) => {
      const m = report.arms[a];
      return `| ${a} | ${m.top1Correct}/${n} (${pct(m.top1Correct, n)}) | ${m.topKCorrect}/${n} | ${m.correctAbstentions} | ${m.correctRejections} | ${m.latency.p50Ms.toFixed(2)} ms | ${m.latency.p95Ms.toFixed(2)} ms | ${m.efficiency.embeddingCalls} | ${m.efficiency.meanContextChars.toFixed(0)} |`;
    }),
    "",
    "| Category | Total | " + ARM_NAMES.join(" | ") + " |",
    "|---|---|" + ARM_NAMES.map(() => "---").join("|") + "|",
    ...(Object.entries(report.byCategory) as Array<[string, { total: number } & Record<ArmName, number>]>).map(
      ([cat, s]) => `| ${cat} | ${s.total} | ` + ARM_NAMES.map((a) => s[a]).join(" | ") + " |"
    ),
    "",
    "### Stage 2 — semantic behaviors",
    "",
    "| Behavior | " + ARM_NAMES.join(" | ") + " |",
    "|---|" + ARM_NAMES.map(() => "---").join("|") + "|",
    "| Paraphrase recall | " + ARM_NAMES.map((a) => `${report.stage2.paraphraseRecall[a].hit}/${report.stage2.paraphraseRecall[a].total}`).join(" | ") + " |",
    "| Near-miss rejection | " + ARM_NAMES.map((a) => `${report.stage2.nearMissRejection[a].rejected}/${report.stage2.nearMissRejection[a].total}`).join(" | ") + " |",
    "| Correction recall | " + ARM_NAMES.map((a) => `${report.stage2.correctionRecall[a].hit}/${report.stage2.correctionRecall[a].total}`).join(" | ") + " |",
    "| Contested abstention | " + ARM_NAMES.map((a) => `${report.stage2.contestedAbstention[a].abstained}/${report.stage2.contestedAbstention[a].total}`).join(" | ") + " |",
    "",
    `Decay-expiry exclusion: ${report.stage2.decayExclusion.expiredSurfaced} expired facts surfaced across ${report.stage2.decayExclusion.queriesChecked} arm-queries (must be 0).`,
    `Graph contribution on entity-linked questions (top-K): all-three ${report.stage2.graphBoostContribution.allThreeTopK}/${report.stage2.graphBoostContribution.entityLinkedQuestions} vs no-boost ${report.stage2.graphBoostContribution.noBoostTopK}/${report.stage2.graphBoostContribution.entityLinkedQuestions} → contribution ${report.stage2.graphBoostContribution.contribution}.`,
    "",
    "### Stage 3 — consensus",
    "",
    "| Arm pair | Top-1 agreement |",
    "|---|---|",
    ...report.stage3.agreement.map((p) => `| ${p.a} vs ${p.b} | ${(p.top1AgreementRate * 100).toFixed(1)}% |`),
    "",
    `A/B verdict: graph boost **${report.stage3.abVerdict.verdict}** — all-three top-K ${report.stage3.abVerdict.allThreeTopK}/${n} vs no-graph-boost ${report.stage3.abVerdict.noBoostTopK}/${n} (delta ${report.stage3.abVerdict.delta >= 0 ? "+" : ""}${report.stage3.abVerdict.delta}).`,
    "",
    "Limitations: the vector arm runs on deterministic hashed-token pseudo-embeddings, which measure plumbing and token-overlap retrieval, not real semantic quality — a nightly lane on the real embedding provider owns that (run this file with ZO_MODEL_EMBEDDING unset and OPENAI_API_KEY present; keep it OUT of the merge gate: network + billing must never gate merges). Latency is DB-path wall time only.",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "three-signal-"));
  try {
    const report = await runThreeSignalEval(join(root, "eval.db"));
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatReport(report));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`three-signal eval failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
