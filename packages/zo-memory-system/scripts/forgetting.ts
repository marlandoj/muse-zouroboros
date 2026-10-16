#!/usr/bin/env bun
/**
 * forgetting.ts — Reversible forgetting on the canonical decay vocabulary
 * (permanent / stable / active / session / checkpoint).
 *
 * Forgetting hides a fact from every retrieval path (scope.ts
 * notForgottenSql) but keeps the row; restore removes the hide. Hard
 * deletion only happens via purgeForgottenFacts after a retention window.
 * The decay sweep scores non-permanent facts on recency / importance /
 * relevance and forgets — never deletes — the ones below threshold.
 *
 * Every entry point requires an actor (fail closed, scope.ts) and writes a
 * memory_audit row. Shared by memory.ts (CLI) and the MCP servers.
 */

import { Database } from "bun:sqlite";
import {
  ensureIntelligencePlaneSchema,
  notForgottenSql,
  recordAudit,
  resolveScope,
  scopeSql,
} from "./scope";

export type DecayClass = "permanent" | "stable" | "active" | "session" | "checkpoint";

/** Recency half-life per decay class, in seconds. Permanent facts never decay. */
const DECAY_HALF_LIFE_S: Record<Exclude<DecayClass, "permanent">, number> = {
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

/** Facts scoring below this retention score are reversibly forgotten. */
export const DEFAULT_RETENTION_THRESHOLD = 0.05;

/** Default retention window before a forgotten fact may be hard-purged. */
export const DEFAULT_PURGE_RETENTION_DAYS = 30;

export interface RetentionSignals {
  recency: number;
  importance: number;
  relevance: number;
  score: number;
}

/**
 * Score one fact's retention on recency (exponential decay of last access,
 * half-life set by decay class), importance (normalized stored importance),
 * and relevance (whether the fact has been accessed since creation).
 *
 * Note: facts store created_at in ms and last_accessed in seconds (schema
 * quirk); callers normalize both to seconds before scoring.
 */
export function scoreRetention(
  fact: { decay: DecayClass; importance: number; createdAt: number; lastAccessed: number | null },
  nowSec: number
): RetentionSignals {
  if (fact.decay === "permanent") {
    return { recency: 1, importance: 1, relevance: 1, score: 1 };
  }
  const halfLife = DECAY_HALF_LIFE_S[fact.decay] ?? DECAY_HALF_LIFE_S.stable;
  const lastTouch = fact.lastAccessed ?? fact.createdAt;
  const age = Math.max(0, nowSec - lastTouch);
  const recency = Math.pow(2, -age / halfLife);
  const importance = Math.min(Math.max(fact.importance, 0) / 2, 1);
  // Relevance: a fact accessed after creation has demonstrated retrieval
  // value; one never touched since creation has not.
  const relevance = fact.lastAccessed !== null && fact.lastAccessed > fact.createdAt ? 1 : 0.3;
  const score = 0.5 * recency + 0.35 * importance + 0.15 * relevance;
  return { recency, importance, relevance, score };
}

/** created_at is stored in milliseconds by memory.ts; normalize to seconds. */
function toSec(ts: number): number {
  return ts > 10_000_000_000 ? Math.floor(ts / 1000) : ts;
}

/**
 * Reversibly forget a fact: hide it from every retrieval path. Scope-checked.
 * Returns false if the fact is outside scope, already forgotten, or missing.
 */
export function forgetFact(
  db: Database,
  id: string,
  options: { actor: string; reason?: string; retentionScore?: number }
): boolean {
  const scope = resolveScope(options.actor, "forgetFact");
  ensureIntelligencePlaneSchema(db);
  const predicate = scopeSql(scope);
  const visible = db.prepare(
    `SELECT id FROM facts WHERE id = ? AND ${notForgottenSql()} AND ${predicate.sql}`
  ).get(id, ...predicate.params);
  if (!visible) return false;
  db.prepare(
    `INSERT INTO fact_forgotten (fact_id, forgotten_by, reason, retention_score) VALUES (?, ?, ?, ?)`
  ).run(id, scope.actor, options.reason ?? null, options.retentionScore ?? null);
  recordAudit(db, { actor: scope.actor, scope: scope.personas.join(","), action: "forget", factId: id });
  return true;
}

/**
 * Restore a reversibly-forgotten fact. Scope-checked against the underlying
 * fact's persona. Returns false when nothing was restored.
 */
export function restoreFact(db: Database, id: string, options: { actor: string }): boolean {
  const scope = resolveScope(options.actor, "restoreFact");
  ensureIntelligencePlaneSchema(db);
  const predicate = scopeSql(scope);
  const result = db.prepare(
    `DELETE FROM fact_forgotten
     WHERE fact_id = ?
       AND fact_id IN (SELECT id FROM facts WHERE ${predicate.sql})`
  ).run(id, ...predicate.params);
  if (result.changes > 0) {
    recordAudit(db, { actor: scope.actor, scope: scope.personas.join(","), action: "restore", factId: id });
    return true;
  }
  return false;
}

export interface ForgottenFact {
  factId: string;
  entity: string;
  value: string;
  forgottenAt: number;
  forgottenBy: string;
  reason: string | null;
  retentionScore: number | null;
}

/** List forgotten facts within the actor's scope (for review / restore). */
export function listForgottenFacts(
  db: Database,
  options: { actor: string; limit?: number }
): ForgottenFact[] {
  const scope = resolveScope(options.actor, "listForgottenFacts");
  ensureIntelligencePlaneSchema(db);
  const predicate = scopeSql(scope, "f.persona");
  return db.prepare(`
    SELECT ff.fact_id as factId, f.entity, f.value,
           ff.forgotten_at as forgottenAt, ff.forgotten_by as forgottenBy,
           ff.reason, ff.retention_score as retentionScore
    FROM fact_forgotten ff
    JOIN facts f ON f.id = ff.fact_id
    WHERE ${predicate.sql}
    ORDER BY ff.forgotten_at DESC
    LIMIT ?
  `).all(...predicate.params, options.limit ?? 50) as ForgottenFact[];
}

/**
 * Hard-delete facts that have been forgotten longer than the retention
 * window. This is the ONLY path from forgotten to gone.
 */
export function purgeForgottenFacts(
  db: Database,
  options: { actor: string; retentionDays?: number }
): number {
  const scope = resolveScope(options.actor, "purgeForgottenFacts");
  ensureIntelligencePlaneSchema(db);
  const predicate = scopeSql(scope);
  const cutoff =
    Math.floor(Date.now() / 1000) -
    (options.retentionDays ?? DEFAULT_PURGE_RETENTION_DAYS) * 24 * 3600;
  db.exec("PRAGMA foreign_keys = ON");
  const result = db.prepare(
    `DELETE FROM facts
     WHERE id IN (SELECT fact_id FROM fact_forgotten WHERE forgotten_at < ?)
       AND ${predicate.sql}`
  ).run(cutoff, ...predicate.params);
  if (result.changes > 0) {
    recordAudit(db, { actor: scope.actor, scope: scope.personas.join(","), action: "purge" });
  }
  return result.changes;
}

export interface DecaySweepResult {
  examined: number;
  forgotten: Array<{ factId: string; score: number }>;
  dryRun: boolean;
}

/**
 * Decay sweep: reversibly forget in-scope, non-permanent facts whose
 * retention score (recency / importance / relevance) falls below threshold.
 * Expired facts are forgotten outright (reversible, unlike `prune`'s hard
 * delete). Idempotent; dry-run supported.
 */
export function sweepDecay(
  db: Database,
  options: { actor: string; threshold?: number; now?: number; dryRun?: boolean }
): DecaySweepResult {
  const scope = resolveScope(options.actor, "sweepDecay");
  ensureIntelligencePlaneSchema(db);
  const predicate = scopeSql(scope);
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);
  const threshold = options.threshold ?? DEFAULT_RETENTION_THRESHOLD;

  const rows = db.prepare(`
    SELECT id, decay_class as decay, importance, created_at as createdAt,
           last_accessed as lastAccessed, expires_at as expiresAt
    FROM facts
    WHERE decay_class != 'permanent'
      AND ${notForgottenSql()}
      AND ${predicate.sql}
  `).all(...predicate.params) as Array<{
    id: string;
    decay: DecayClass;
    importance: number;
    createdAt: number;
    lastAccessed: number | null;
    expiresAt: number | null;
  }>;

  const forgotten: Array<{ factId: string; score: number }> = [];
  for (const row of rows) {
    const expired = row.expiresAt !== null && row.expiresAt < nowSec;
    const { score } = scoreRetention(
      { ...row, createdAt: toSec(row.createdAt) },
      nowSec
    );
    if (!expired && score >= threshold) continue;
    forgotten.push({ factId: row.id, score });
    if (!options.dryRun) {
      forgetFact(db, row.id, {
        actor: scope.actor,
        reason: expired ? "decay-sweep: expired" : "decay-sweep: retention below threshold",
        retentionScore: score,
      });
    }
  }

  return { examined: rows.length, forgotten, dryRun: options.dryRun ?? false };
}
