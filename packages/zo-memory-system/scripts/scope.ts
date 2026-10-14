#!/usr/bin/env bun
/**
 * scope.ts — Scope resolution: the single choke point for persona/actor scoping.
 *
 * Track 1 (intelligence plane): every fact retrieval and mutation path in
 * this package resolves its SQL visibility predicate HERE. No module
 * hand-rolls `persona = ?` / `persona IN (...)` anymore; they call
 * resolveScope() (or build a persona list through cross-persona pools) and
 * splice `scopeSql()` into their queries. This is the fix for the
 * definer-rights leak class: a path that forgets to scope now fails at the
 * call site (actor is a required parameter) instead of silently widening to
 * every persona's facts.
 *
 * Fail-closed contract (operator decision Q2, 2026-10-14):
 *  - `actor` is caller-declared identity (MCP tool arg / CLI --actor /
 *    function param).
 *  - requireActor() throws MissingActorError (code MISSING_ACTOR) on
 *    missing/empty/non-string — there is no silent default to 'shared'.
 *    Callers that want shared visibility declare actor 'shared' explicitly,
 *    which is itself a legitimate first-party actor for cross-harness facts.
 *  - Misattribution is detectable, not preventable, at this trust boundary
 *    (every MCP client is a first-party local harness): the memory_audit
 *    trail records actor + scope for every access.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

/** Error surfaced when a call arrives without a usable actor. */
export class MissingActorError extends Error {
  readonly code = "MISSING_ACTOR";
  constructor(context?: string) {
    super(
      `MISSING_ACTOR: actor is required${context ? ` for ${context}` : ""}: ` +
      `pass a non-empty actor identity (fail-closed; no default scope)`
    );
    this.name = "MissingActorError";
  }
}

/**
 * The resolved visibility scope for one actor.
 * `personas` is the exact set of persona values the actor may read.
 * `key` is a stable cache key.
 */
export interface ScopePredicate {
  actor: string;
  personas: string[];
  key: string;
}

/**
 * Fail-closed actor validation. Throws MissingActorError unless `actor`
 * is a non-empty string after trimming. Returns the trimmed actor.
 */
export function requireActor(actor: unknown, context?: string): string {
  if (typeof actor !== "string") throw new MissingActorError(context);
  const trimmed = actor.trim();
  if (trimmed.length === 0) throw new MissingActorError(context);
  return trimmed;
}

/**
 * Build the scope for an actor: the actor's own persona plus the shared
 * pool. The ONLY place the baseline visibility rule lives. (The opt-in
 * cross-persona pool/inheritance expansion in cross-persona.ts renders its
 * wider persona list through scopeSql() too, so predicate construction has
 * exactly one implementation.)
 */
export function resolveScope(actor: unknown, context?: string): ScopePredicate {
  const a = requireActor(actor, context);
  const personas = a === "shared" ? ["shared"] : [a, "shared"];
  return { actor: a, personas, key: personas.join("||") };
}

/**
 * Render a persona list as a SQL predicate for `column` (default `persona`).
 * Returns the parenthesized SQL fragment and its bind params, in order.
 */
export function scopeSql(
  scope: ScopePredicate | { personas: string[] },
  column = "persona"
): { sql: string; params: string[] } {
  const placeholders = scope.personas.map(() => `${column} = ?`).join(" OR ");
  return { sql: `(${placeholders})`, params: [...scope.personas] };
}

/**
 * Reversible-forgetting visibility filter: facts with a fact_forgotten row
 * are hidden from every retrieval path until restored or purged.
 */
export function notForgottenSql(column = "id"): string {
  return `${column} NOT IN (SELECT fact_id FROM fact_forgotten)`;
}

// ---------------------------------------------------------------------------
// Intelligence-plane schema (audit + promotion ledger + reversible forgetting)
// ---------------------------------------------------------------------------

/**
 * Idempotent DDL for the Track 1 tables. Called by every entry point that
 * audits or forgets, so a pre-v4 database upgrades in place (the same DDL
 * ships in schema.sql and migrate-v4.sql).
 */
export function ensureIntelligencePlaneSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      fact_id TEXT,
      call_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_audit_actor ON memory_audit(actor, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_fact ON memory_audit(fact_id);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_action ON memory_audit(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_audit_call ON memory_audit(call_id);

    CREATE TABLE IF NOT EXISTS fact_promotions (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('capture', 'extraction', 'review', 'promotion')),
      decided_by TEXT NOT NULL,
      decided_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      contradiction_of TEXT REFERENCES facts(id),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fact_promotions_fact ON fact_promotions(fact_id, decided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fact_promotions_stage ON fact_promotions(stage, decided_at DESC);

    CREATE TABLE IF NOT EXISTS fact_forgotten (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      forgotten_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      forgotten_by TEXT NOT NULL,
      reason TEXT,
      retention_score REAL
    );
    CREATE INDEX IF NOT EXISTS idx_fact_forgotten_at ON fact_forgotten(forgotten_at);
  `);
}

// ---------------------------------------------------------------------------
// Audit — every scoped access leaves a row in memory_audit.
// ---------------------------------------------------------------------------

export type AuditAction =
  | "store"
  | "search"
  | "search_vector"
  | "get"
  | "delete"
  | "forget"
  | "restore"
  | "purge"
  | "promotion_stage"
  | "review_decision";

export interface AuditEvent {
  actor: string;
  /** Human-readable scope the action ran under (persona list or target persona). */
  scope: string;
  action: AuditAction;
  factId?: string | null;
  /** Correlates the rows of one logical call (e.g. hybrid = keyword + vector legs). */
  callId?: string | null;
}

/** Mint a correlation id for one logical memory call. */
export function newCallId(): string {
  return randomUUID();
}

/**
 * Record an audit row. Deliberately NOT best-effort: if the audit substrate
 * is broken the operation fails (fail closed), because an unauditable
 * memory plane is the exact failure mode Track 1 exists to prevent.
 */
export function recordAudit(db: Database, event: AuditEvent): void {
  ensureIntelligencePlaneSchema(db);
  db.prepare(
    `INSERT INTO memory_audit (actor, scope, action, fact_id, call_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(event.actor, event.scope, event.action, event.factId ?? null, event.callId ?? null);
}
