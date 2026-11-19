#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { buildAdjacencyList, findArticulationPoints, isArticulationPoint, getArticulationPointDetails } from "./tarjan";

type OpenLoopStatus = "open" | "resolved" | "stale" | "superseded";
type OpenLoopKind = "task" | "bug" | "incident" | "approval" | "commitment" | "other";

type EpisodeOutcome = "success" | "failure" | "resolved" | "ongoing";

export interface EpisodeRecordInput {
  summary: string;
  outcome: EpisodeOutcome;
  happenedAt: number;
  durationMs?: number;
  procedureId?: string;
  entities: string[];
  metadata?: Record<string, unknown>;
}

export interface OpenLoopInput {
  persona?: string;
  title: string;
  summary?: string;
  kind?: OpenLoopKind;
  status?: OpenLoopStatus;
  priority?: number;
  entity?: string | null;
  source?: string;
  relatedEpisodeId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OpenLoopRecord extends OpenLoopInput {
  id: string;
  persona: string;
  summary: string;
  kind: OpenLoopKind;
  status: OpenLoopStatus;
  priority: number;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number | null;
  isArticulationPoint?: boolean; // NEW: Protected from decay if true
}

export interface ArticulationPointCheck {
  loopId: string;
  isProtected: boolean;
  reason: string;
  articulationFactIds: string[];
  bridges: number;
}

export interface ContinuationDetection {
  needsMemory: boolean;
  score: number;
  keywords: string[];
  reason: string;
}

export interface RankedContinuationItem {
  kind: "fact" | "episode" | "open_loop";
  id: string;
  title: string;
  summary: string;
  entity?: string | null;
  score: number;
  source: string;
  metadata?: Record<string, unknown>;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do", "for", "from", "get", "got",
  "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "my", "of", "on",
  "or", "our", "so", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "up",
  "use", "was", "we", "were", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your"
]);

const CONTINUATION_PHRASES = [
  "continue", "left off", "leave off", "pick up", "resume", "earlier", "before", "still", "again", "status", "progress", "result",
  "we were", "last time", "few days", "yesterday", "last week", "follow up", "next step", "open loop"
];

const ACTION_HINTS = [
  "update", "fix", "finish", "review", "check", "resume", "continue", "revisit", "investigate", "follow", "compare"
];

const GREETING_ONLY = /^(hi|hello|hey|yo|good morning|good afternoon|good evening|thanks|thank you|ok|okay|yes|no)[!. ]*$/i;

function safeJson(value: unknown): string | null {
  return value ? JSON.stringify(value) : null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && !STOPWORDS.has(s));
}

function makeFtsQuery(text: string): string {
  const terms = Array.from(new Set(tokenize(text))).slice(0, 8);
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function buildFingerprint(kind: OpenLoopKind, entity: string | null | undefined, title: string): string {
  return `${kind}::${(entity || "").toLowerCase()}::${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

function normalizePriority(priority?: number): number {
  return Math.max(0, Math.min(1, priority ?? 0.6));
}

function loopKindFromText(text: string): OpenLoopKind {
  const lower = text.toLowerCase();
  if (/\b(bug|error|broken|fail|failing|issue|fix)\b/.test(lower)) return "bug";
  if (/\b(incident|outage|downtime|502|521|alert)\b/.test(lower)) return "incident";
  if (/\b(approve|approval|confirm|decision needed|pending decision)\b/.test(lower)) return "approval";
  if (/\b(next step|follow up|commitment|need to|should|must|todo|to-do)\b/.test(lower)) return "commitment";
  return "task";
}

function looksResolved(text: string): boolean {
  return /\b(resolved|fixed|done|completed|closed|approved|shipped|finished)\b/i.test(text);
}

function inferEntity(text: string): string | null {
  const match = text.match(/\b([a-z]+(?:[._-][a-z0-9]+)+)\b/i);
  return match ? match[1] : null;
}

function recencyBoost(unixSeconds: number, windowDays: number): number {
  const ageDays = Math.max(0, (Date.now() / 1000 - unixSeconds) / 86400);
  return Math.max(0, 1 - ageDays / windowDays);
}

/**
 * Check if an open loop is connected to articulation points in the knowledge graph
 * Returns details about why the loop should be protected from decay
 */
export function checkArticulationPointsForOpenLoop(
  db: Database,
  loop: OpenLoopRecord | { entity?: string | null; title: string; summary: string }
): ArticulationPointCheck {
  try {
    const adj = buildAdjacencyList(db);

    if (adj.size === 0) {
      return {
        loopId: "unknown",
        isProtected: false,
        reason: "No graph connections found",
        articulationFactIds: [],
        bridges: 0,
      };
    }

    // Find facts related to this open loop
    const relatedFactIds: string[] = [];

    // If loop has an entity, find facts for that entity
    if (loop.entity) {
      const entityFacts = db.prepare("SELECT id FROM facts WHERE entity = ?").all(loop.entity) as Array<{ id: string }>;
      relatedFactIds.push(...entityFacts.map(f => f.id));
    }

    // Also search for facts that might be semantically related
    const keywords = tokenize(`${loop.title} ${loop.summary}`).slice(0, 5);
    if (keywords.length > 0) {
      const ftsQuery = keywords.map(k => `"${k}"`).join(" OR ");
      const ftsFacts = db.prepare(`
        SELECT f.id FROM facts f
        JOIN facts_fts fts ON fts.rowid = f.rowid
        WHERE facts_fts MATCH ?
        LIMIT 10
      `).all(ftsQuery) as Array<{ id: string }>;
      relatedFactIds.push(...ftsFacts.map(f => f.id));
    }

    // Deduplicate
    const uniqueFactIds = Array.from(new Set(relatedFactIds));

    // Check which of these are articulation points
    const articulationPoints = findArticulationPoints(adj);
    const matchingArticulationPoints = uniqueFactIds.filter(id => articulationPoints.has(id));

    if (matchingArticulationPoints.length === 0) {
      return {
        loopId: (loop as OpenLoopRecord).id || "unknown",
        isProtected: false,
        reason: "No articulation points connected to this open loop",
        articulationFactIds: [],
        bridges: 0,
      };
    }

    // Calculate total bridges
    let totalBridges = 0;
    for (const factId of matchingArticulationPoints) {
      // Count would-be disconnected components
      const neighbors = adj.get(factId) || new Set();
      if (neighbors.size > 1) {
        totalBridges += neighbors.size - 1; // Approximation
      }
    }

    return {
      loopId: (loop as OpenLoopRecord).id || "unknown",
      isProtected: true,
      reason: `Connected to ${matchingArticulationPoints.length} articulation point(s) — removing would disconnect knowledge graph`,
      articulationFactIds: matchingArticulationPoints,
      bridges: totalBridges,
    };
  } catch (error) {
    // If anything fails, don't block the operation
    return {
      loopId: (loop as OpenLoopRecord).id || "unknown",
      isProtected: false,
      reason: `Error checking articulation points: ${error}`,
      articulationFactIds: [],
      bridges: 0,
    };
  }
}

/**
 * Get all open loops that should be protected from decay due to being articulation points
 */
export function getCriticalOpenLoops(db: Database): Array<OpenLoopRecord & { protectionReason: string }> {
  ensureContinuationSchema(db);

  const openLoops = db.prepare(`
    SELECT * FROM open_loops WHERE status IN ('open', 'stale')
  `).all() as Array<Record<string, unknown>>;

  const criticalLoops: Array<OpenLoopRecord & { protectionReason: string }> = [];

  for (const row of openLoops) {
    const loop: OpenLoopRecord = {
      id: row.id as string,
      persona: row.persona as string,
      title: row.title as string,
      summary: row.summary as string,
      kind: row.kind as OpenLoopKind,
      status: row.status as OpenLoopStatus,
      priority: row.priority as number,
      entity: row.entity as string | null,
      source: row.source as string | undefined,
      relatedEpisodeId: row.related_episode_id as string | null | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      fingerprint: row.fingerprint as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      resolvedAt: row.resolved_at as number | null | undefined,
    };

    const check = checkArticulationPointsForOpenLoop(db, loop);

    if (check.isProtected) {
      criticalLoops.push({
        ...loop,
        protectionReason: check.reason,
      });
    }
  }

  return criticalLoops;
}

/**
 * Protect articulation point loops from being marked as stale
 * Should be called during decay operations
 */
export function protectArticulationPointLoops(db: Database): {
  protected: number;
  unprotected: number;
  details: Array<{ loopId: string; title: string; reason: string }>;
} {
  ensureContinuationSchema(db);

  const staleLoops = db.prepare(`
    SELECT * FROM open_loops WHERE status = 'stale'
  `).all() as Array<Record<string, unknown>>;

  let protected_ = 0;
  let unprotected = 0;
  const details: Array<{ loopId: string; title: string; reason: string }> = [];

  for (const row of staleLoops) {
    const loop: OpenLoopRecord = {
      id: row.id as string,
      persona: row.persona as string,
      title: row.title as string,
      summary: row.summary as string,
      kind: row.kind as OpenLoopKind,
      status: row.status as OpenLoopStatus,
      priority: row.priority as number,
      entity: row.entity as string | null,
      source: row.source as string | undefined,
      relatedEpisodeId: row.related_episode_id as string | null | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      fingerprint: row.fingerprint as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      resolvedAt: row.resolved_at as number | null | undefined,
    };

    const check = checkArticulationPointsForOpenLoop(db, loop);

    if (check.isProtected) {
      // Revert to 'open' status — this loop is critical
      db.prepare(`
        UPDATE open_loops
        SET status = 'open', updated_at = ?
        WHERE id = ?
      `).run(Math.floor(Date.now() / 1000), loop.id);

      protected_++;
      details.push({ loopId: loop.id, title: loop.title, reason: check.reason });
    } else {
      unprotected++;
    }
  }

  return { protected: protected_, unprotected, details };
}

/**
 * Auto-resolve open loops that have been stale for 30+ days AND are not
 * connected to articulation points (not critical to the knowledge graph).
 *
 * Living projects are detected by checking if the loop's entity matches
 * any entity that has facts created in the last 30 days.
 *
 * Resolved loops get a metadata note explaining why.
 */
export function autoResolveStaleLoops(
  db: Database,
  staleDays: number = 30,
  livingDays: number = 30
): {
  resolved: number;
  skipped: number;
  details: Array<{ loopId: string; title: string; reason: string }>;
} {
  ensureContinuationSchema(db);

  const nowSec = Math.floor(Date.now() / 1000);
  const staleThreshold = nowSec - staleDays * 86400;

  // Find entities that have had fact activity in the last `livingDays` days
  // These are "living" projects — loops pointing to them should NOT be auto-resolved
  const livingEntities = new Set<string | null>();
  const livingThreshold = nowSec - livingDays * 86400;
  const livingEntityRows = db.prepare(`
    SELECT DISTINCT entity FROM facts
    WHERE entity IS NOT NULL AND created_at > ?
  `).all(livingThreshold) as Array<{ entity: string }>;
  for (const row of livingEntityRows) {
    livingEntities.add(row.entity);
  }

  // Also protect entities that have open loops with recent activity
  const recentLoopEntities = db.prepare(`
    SELECT DISTINCT entity FROM open_loops
    WHERE entity IS NOT NULL AND status = 'open' AND updated_at > ?
  `).all(staleThreshold) as Array<{ entity: string }>;
  for (const row of recentLoopEntities) {
    livingEntities.add(row.entity);
  }

  // Fetch stale loops
  const staleLoops = db.prepare(`
    SELECT id, title, summary, entity FROM open_loops
    WHERE status = 'stale' AND updated_at < ?
  `).all(staleThreshold) as Array<{ id: string; title: string; summary: string; entity: string | null }>;

  let resolved = 0;
  let skipped = 0;
  const details: Array<{ loopId: string; title: string; reason: string }> = [];

  for (const loop of staleLoops) {
    // Skip if entity is a living project
    if (loop.entity && livingEntities.has(loop.entity)) {
      skipped++;
      continue;
    }

    // Check articulation point protection
    const check = checkArticulationPointsForOpenLoop(db, loop);
    if (check.isProtected) {
      skipped++;
      continue;
    }

    // Auto-resolve
    const note = `Auto-resolved by decay agent: no activity for ${staleDays}+ days and no living project connection.`;
    db.prepare(`
      UPDATE open_loops
      SET status = 'resolved',
          resolved_at = ?,
          updated_at = ?,
          metadata = json_set(COALESCE(metadata, '{}'), '$.auto_resolve_note', ?)
      WHERE id = ?
    `).run(nowSec, nowSec, note, loop.id);

    resolved++;
    details.push({ loopId: loop.id, title: loop.title, reason: note });
  }

  return { resolved, skipped, details };
}

export function ensureContinuationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episode_documents (
      episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
      episode_id UNINDEXED,
      text
    );

    CREATE TABLE IF NOT EXISTS open_loops (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','bug','incident','approval','commitment','other')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','stale','superseded')),
      priority REAL DEFAULT 0.6,
      entity TEXT,
      source TEXT,
      related_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
      fingerprint TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      resolved_at INTEGER
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_open_loops_active_fingerprint
      ON open_loops(fingerprint, status);
    CREATE INDEX IF NOT EXISTS idx_open_loops_status_updated
      ON open_loops(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_open_loops_entity
      ON open_loops(entity);
    CREATE INDEX IF NOT EXISTS idx_open_loops_persona
      ON open_loops(persona);

    CREATE VIRTUAL TABLE IF NOT EXISTS open_loops_fts USING fts5(
      loop_id UNINDEXED,
      text
    );
  `);
}

export function syncEpisodeDocument(
  db: Database,
  episodeId: string,
  summary: string,
  metadata: Record<string, unknown> | undefined,
  entities: string[]
): void {
  ensureContinuationSchema(db);
  const metadataText = metadata ? JSON.stringify(metadata) : "";
  const searchText = [summary, entities.join(" "), metadataText].filter(Boolean).join("\n");

  db.prepare(`
    INSERT INTO episode_documents (episode_id, text, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(episode_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
  `).run(episodeId, searchText);

  db.prepare("DELETE FROM episode_documents_fts WHERE episode_id = ?").run(episodeId);
  db.prepare("INSERT INTO episode_documents_fts (episode_id, text) VALUES (?, ?)").run(episodeId, searchText);
}

export function createEpisodeRecord(db: Database, episode: EpisodeRecordInput): string {
  ensureContinuationSchema(db);
  const id = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO episodes (id, summary, outcome, happened_at, duration_ms, procedure_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    episode.summary,
    episode.outcome,
    episode.happenedAt,
    episode.durationMs || null,
    episode.procedureId || null,
    safeJson(episode.metadata),
    nowSec
  );

  const insertEntity = db.prepare("INSERT OR IGNORE INTO episode_entities (episode_id, entity) VALUES (?, ?)");
  for (const entity of episode.entities) {
    insertEntity.run(id, entity);
  }

  syncEpisodeDocument(db, id, episode.summary, episode.metadata, episode.entities);
  return id;
}

/**
 * Quality gate: reject conversation fragments that aren't actionable open loops.
 * Returns true if the title looks like noise (philosophical quotes, extracted fragments).
 */
function isOpenLoopNoise(title: string): boolean {
  const t = title.trim();
  // Too long to be a real task title (>120 chars = likely a quote/fragment)
  if (t.length > 120) return true;
  // Starts with lowercase (real tasks start with a verb or noun)
  if (/^[a-z]/.test(t) && !/^(npm|git|bun|apt|curl|cd |ls )/.test(t)) return true;
  // Contains em-dash or ellipsis (literary fragments)
  if (/[—…]/.test(t)) return true;
  // Metaphor/philosophy patterns
  if (/\b(like composing|like an? |as if |metaphor|orchestra|harmonize|soar|mantra)\b/i.test(t)) return true;
  // Extracted motivational quotes
  if (/\b(must (outpace|work|fulfill)|it's not enough|peace of mind|not just)\b/i.test(t)) return true;
  // Questions aren't tasks (unless they start with action verbs)
  if (t.endsWith("?") && !/^(fix|resolve|update|check|review|debug|add|remove|create|implement|deploy|migrate)/i.test(t)) return true;
  return false;
}

export function upsertOpenLoop(db: Database, input: OpenLoopInput): OpenLoopRecord {
  ensureContinuationSchema(db);
  const persona = input.persona || "shared";
  const title = input.title.trim();

  // Quality gate: skip noise before doing any DB work
  if (isOpenLoopNoise(title)) {
    return {
      id: "skipped-noise",
      persona,
      title,
      summary: title,
      kind: input.kind || "commitment",
      status: "resolved",
      priority: 0,
      entity: "",
      fingerprint: "",
    } as OpenLoopRecord;
  }

  const summary = (input.summary || input.title).trim();
  const kind = input.kind || loopKindFromText(`${title} ${summary}`);
  const status = input.status || "open";
  const entity = input.entity || inferEntity(summary);
  const fingerprint = buildFingerprint(kind, entity, title);
  const priority = normalizePriority(input.priority);
  const nowSec = Math.floor(Date.now() / 1000);

  const existing = db.prepare(`
    SELECT * FROM open_loops
    WHERE fingerprint = ? AND status IN ('open','stale')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(fingerprint) as Record<string, unknown> | null;

  if (existing) {
    const existingSource = typeof existing.source === "string" ? existing.source : null;
    const existingEpisodeId = typeof existing.related_episode_id === "string" ? existing.related_episode_id : null;
    const existingId = existing.id as string;
    db.prepare(`
      UPDATE open_loops
      SET summary = ?, priority = ?, entity = ?, source = ?, related_episode_id = ?, metadata = ?, updated_at = ?, status = ?
      WHERE id = ?
    `).run(
      summary,
      priority,
      entity,
      input.source || existingSource,
      input.relatedEpisodeId || existingEpisodeId,
      safeJson(input.metadata) || (existing.metadata as string) || null,
      nowSec,
      status,
      existingId
    );

    syncOpenLoopFts(db, existingId, title, summary, kind, status, entity);

    return {
      id: existingId,
      persona,
      title,
      summary,
      kind,
      status,
      priority,
      entity,
      source: input.source || existingSource || undefined,
      relatedEpisodeId: input.relatedEpisodeId || existingEpisodeId,
      metadata: input.metadata,
      fingerprint,
      createdAt: existing.created_at as number,
      updatedAt: nowSec,
      resolvedAt: existing.resolved_at as number | null | undefined,
    };
  }

  const id = randomUUID();
  const resolvedAt = status === "resolved" ? nowSec : null;

  db.prepare(`
    INSERT INTO open_loops (
      id, persona, title, summary, kind, status, priority, entity, source,
      related_episode_id, fingerprint, metadata, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    persona,
    title,
    summary,
    kind,
    status,
    priority,
    entity,
    input.source || null,
    input.relatedEpisodeId || null,
    fingerprint,
    safeJson(input.metadata),
    nowSec,
    nowSec,
    resolvedAt
  );

  syncOpenLoopFts(db, id, title, summary, kind, status, entity);

  return {
    id,
    persona,
    title,
    summary,
    kind,
    status,
    priority,
    entity,
    source: input.source,
    relatedEpisodeId: input.relatedEpisodeId,
    metadata: input.metadata,
    fingerprint,
    createdAt: nowSec,
    updatedAt: nowSec,
    resolvedAt,
  };
}

export function resolveMatchingOpenLoops(db: Database, text: string): number {
  ensureContinuationSchema(db);
  if (!looksResolved(text)) return 0;

  const keywords = tokenize(text).slice(0, 6);
  if (keywords.length === 0) return 0;

  const candidates = db.prepare(`
    SELECT * FROM open_loops
    WHERE status IN ('open','stale')
    ORDER BY updated_at DESC
    LIMIT 25
  `).all() as Array<Record<string, unknown>>;

  let resolved = 0;
  for (const row of candidates) {
    const haystack = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
    const matches = keywords.filter((k) => haystack.includes(k)).length;
    if (matches >= 2) {
      db.prepare(`
        UPDATE open_loops
        SET status = 'resolved', resolved_at = ?, updated_at = ?
        WHERE id = ?
      `).run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), row.id as string);
      syncOpenLoopFts(db, row.id as string, row.title as string, row.summary as string, row.kind as OpenLoopKind, "resolved", row.entity as string | null);
      resolved++;
    }
  }

  return resolved;
}

function syncOpenLoopFts(
  db: Database,
  id: string,
  title: string,
  summary: string,
  kind: OpenLoopKind,
  status: OpenLoopStatus,
  entity: string | null | undefined
): void {
  const text = [title, summary, kind, status, entity || ""].join("\n");
  db.prepare("DELETE FROM open_loops_fts WHERE loop_id = ?").run(id);
  db.prepare("INSERT INTO open_loops_fts (loop_id, text) VALUES (?, ?)").run(id, text);
}

export function shouldSkipExtractionSource(source: string): boolean {
  if (!source) return false;
  const basename = source.split("/").pop() ?? source;
  const lowerBase = basename.toLowerCase();
  const lowerSrc = source.toLowerCase();
  const docNames = new Set([
    "skill.md", "readme.md", "claude.md", "usage.md", "agents.md",
    "identity.md", "soul.md", "spec.md", "changelog.md",
    "integration.md", "notes.md",
  ]);
  if (docNames.has(lowerBase)) return true;
  if (/(^|[-_/])(audit|review|report|findings|research|plan|analysis)([-_./]|$)/.test(lowerSrc)) return true;
  if (/\/(sample-|fixture-)/.test(source) || source.includes("__tests__")) return true;
  return false;
}

export function extractOpenLoopsFromText(text: string, source: string): OpenLoopInput[] {
  if (shouldSkipExtractionSource(source)) return [];
  const chunks = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 12)
    .slice(0, 200);

  const results: OpenLoopInput[] = [];
  const seen = new Set<string>();

  for (const line of chunks) {
    const lower = line.toLowerCase();
    const isCandidate = /\b(todo|to-do|next step|follow up|need to|needs to|should|must|pending|waiting on|unresolved|bug|issue|fix|investigate|approval|approve|confirm)\b/.test(lower);
    if (!isCandidate) continue;

    const title = line.length > 110 ? `${line.slice(0, 107).trim()}...` : line;
    const kind = loopKindFromText(line);
    const status: OpenLoopStatus = looksResolved(line) ? "resolved" : "open";
    const entity = inferEntity(line);
    const fingerprint = buildFingerprint(kind, entity, title);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    results.push({
      title,
      summary: line,
      kind,
      status,
      entity,
      priority: /\bmust|urgent|blocker|critical|outage\b/i.test(line) ? 0.9 : 0.6,
      source,
      metadata: { extractedFrom: source },
    });

    if (results.length >= 8) break;
  }

  return results;
}

export function detectContinuation(message: string): ContinuationDetection {
  const trimmed = message.trim();
  if (!trimmed) {
    return { needsMemory: false, score: 0, keywords: [], reason: "Empty message" };
  }
  if (GREETING_ONLY.test(trimmed)) {
    return { needsMemory: false, score: 0, keywords: [], reason: "Greeting or acknowledgement" };
  }

  const lower = trimmed.toLowerCase();
  let score = 0;

  for (const phrase of CONTINUATION_PHRASES) {
    if (lower.includes(phrase)) score += 2;
  }

  const tokens = tokenize(trimmed);
  const firstWord = lower.split(/\s+/)[0];
  if (ACTION_HINTS.includes(firstWord)) score += 1;
  if (/\b(this|that|it|them|those|again|still)\b/.test(lower)) score += 1;
  if (/\b(yesterday|earlier|before|ago|last)\b/.test(lower)) score += 2;
  if (trimmed.split(/\s+/).length <= 8) score += 1;
  if (/[A-Z]{2,}|[./_-]/.test(trimmed)) score += 1;
  if (/\b(what did we decide|where did we leave off|where did we stop|what was the result|what happened)\b/.test(lower)) score += 3;
  if (/\b(next step|tracking|track|focus|status|progress|review|dashboard|supplier|scorecard|risk dashboard)\b/.test(lower)) score += 2;
  if (/\b(what were we|what are we|is there still|are we still)\b/.test(lower)) score += 2;

  if (/^(write|explain|define|what is|how do i|create a new|build a new)\b/.test(lower)) score -= 2;

  const keywords = Array.from(new Set(tokens)).slice(0, 6);
  const needsMemory = score >= 2 && keywords.length > 0;

  return {
    needsMemory,
    score,
    keywords,
    reason: needsMemory ? "Likely continuation or follow-on work" : "Message appears self-contained",
  };
}

export function searchEpisodesForContinuation(
  db: Database,
  query: string,
  options: { limit?: number; windowDays?: number } = {}
): RankedContinuationItem[] {
  ensureContinuationSchema(db);
  const limit = options.limit || 5;
  const windowDays = options.windowDays || 14;
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;
  const ftsQuery = makeFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = db.prepare(`
    SELECT e.id, e.summary, e.happened_at, e.outcome, ed.text
    FROM episode_documents_fts fts
    JOIN episode_documents ed ON ed.episode_id = fts.episode_id
    JOIN episodes e ON e.id = ed.episode_id
    WHERE episode_documents_fts MATCH ?
      AND e.happened_at >= ?
    LIMIT ${limit * 2}
  `).all(ftsQuery, since) as Array<Record<string, unknown>>;

  return rows.map((row, idx) => ({
    kind: "episode",
    id: row.id as string,
    title: `Episode: ${String(row.summary).slice(0, 60)}`,
    summary: row.summary as string,
    score: (1 / (1 + idx)) * 0.7 + recencyBoost(row.happened_at as number, windowDays) * 0.3,
    source: "episode-fts",
    metadata: { outcome: row.outcome },
  }));
}

export function searchOpenLoopsForContinuation(
  db: Database,
  query: string,
  options: { limit?: number; persona?: string; includeResolved?: boolean } = {}
): RankedContinuationItem[] {
  ensureContinuationSchema(db);
  const limit = options.limit || 5;
  const ftsQuery = makeFtsQuery(query);
  if (!ftsQuery) return [];

  const personaClause = options.persona ? "AND ol.persona = ?" : "";
  const statusClause = options.includeResolved ? "" : "AND ol.status IN ('open','stale')";
  const params = [ftsQuery, ...(options.persona ? [options.persona] : [])];

  const rows = db.prepare(`
    SELECT ol.*
    FROM open_loops_fts fts
    JOIN open_loops ol ON ol.id = fts.loop_id
    WHERE open_loops_fts MATCH ?
      ${personaClause}
      ${statusClause}
    ORDER BY ol.updated_at DESC
    LIMIT ${limit * 2}
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map((row, idx) => ({
    kind: "open_loop",
    id: row.id as string,
    title: row.title as string,
    summary: row.summary as string,
    entity: row.entity as string | null,
    score: (1 / (1 + idx)) * 0.6 + ((row.priority as number) || 0.6) * 0.25 + recencyBoost(row.updated_at as number, 14) * 0.15,
    source: "open-loop-fts",
    metadata: {
      status: row.status,
      kind: row.kind,
      priority: row.priority,
    },
  }));
}

export function renderContinuationContext(results: RankedContinuationItem[], maxItems: number = 6): string {
  const top = results.slice(0, maxItems);
  if (top.length === 0) return "";

  const lines = ["[Continuation Context]"];
  for (const item of top) {
    if (item.kind === "fact") {
      lines.push(`- fact: ${item.summary}`);
    } else if (item.kind === "episode") {
      lines.push(`- episode: ${item.summary}`);
    } else {
      lines.push(`- open loop: ${item.title} — ${item.summary}`);
    }
  }
  return lines.join("\n");
}
