#!/usr/bin/env bun
/**
 * promotion.ts — Fact promotion pipeline (Track 1, operator decision Q3).
 *
 * Explicit state machine over the append-only `fact_promotions` ledger:
 *
 *   capture → extraction → promotion          (the normal path)
 *                        ↘ review → promotion (contradictions only)
 *
 * A fact's current stage is its LATEST ledger row; stages are never updated
 * in place. Rules-based throughout — no LLM extraction (deferred per Q3; the
 * Track 3 three-signal harness is what would later measure whether LLM
 * extraction earns its keep). The human review queue receives ONLY
 * contradictions/contested facts; everything machine-resolvable resolves
 * mechanically.
 *
 * Contradiction handling reuses the `fact_conflicts` DDL shared with
 * conflict-resolver.ts:
 *   - supersede: the contradicted (older) fact is reversibly forgotten; the
 *     new fact promotes.
 *   - merge: both facts stand; the new fact promotes.
 *   - flag: contested; the fact STAYS in review (visible but unpromoted).
 *
 * Fail-closed contract: every entry point requires an actor; illegal stage
 * transitions throw PromotionStateError; unknown facts throw.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  ensureIntelligencePlaneSchema,
  notForgottenSql,
  recordAudit,
  resolveActor,
  resolveScope,
  scopeSql,
  type ScopePredicate,
} from "./scope";
import { forgetFact } from "./forgetting";

export type PromotionStage = "capture" | "extraction" | "review" | "promotion";

export type ReviewDecision = "supersede" | "merge" | "flag";

/** Thrown on any transition the state machine does not permit. */
export class PromotionStateError extends Error {
  readonly code = "PROMOTION_STATE";
  constructor(message: string) {
    super(message);
    this.name = "PromotionStateError";
  }
}

/** Same DDL as conflict-resolver.ts — single shared shape. */
function ensureConflictTable(db: Database): void {
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
    CREATE INDEX IF NOT EXISTS idx_conflicts_fact ON fact_conflicts(fact_id);
  `);
}

/** Current stage of a fact = its latest ledger row (null for unknown facts). */
export function getPromotionStage(db: Database, factId: string): PromotionStage | null {
  ensureIntelligencePlaneSchema(db);
  const row = db.prepare(
    `SELECT stage FROM fact_promotions WHERE fact_id = ? ORDER BY decided_at DESC, created_at DESC, rowid DESC LIMIT 1`
  ).get(factId) as { stage: PromotionStage } | null;
  return row?.stage ?? null;
}

/**
 * Enter a fact into the pipeline at `capture`. Idempotent per-fact entry
 * point for capture-time callers (auto-capture, CLI store).
 */
export function enterCapture(db: Database, factId: string, options: { actor: string }): void {
  const scope = resolveScope(options.actor, "enterCapture");
  ensureIntelligencePlaneSchema(db);
  if (getPromotionStage(db, factId) !== null) return;
  recordStage(db, factId, "capture", scope.actor);
}

function recordStage(
  db: Database,
  factId: string,
  stage: PromotionStage,
  actor: string,
  contradictionOf?: string | null
): void {
  db.prepare(
    `INSERT INTO fact_promotions (id, fact_id, stage, decided_by, contradiction_of) VALUES (?, ?, ?, ?, ?)`
  ).run(randomUUID(), factId, stage, actor, contradictionOf ?? null);
  recordAudit(db, { actor, scope: stage, action: "promotion_stage", factId });
}

// ---------------------------------------------------------------------------
// Extraction rules (capture → extraction). Deterministic, zero marginal cost.
// ---------------------------------------------------------------------------

/** Minimum fact-value length considered extractable signal rather than noise. */
const MIN_VALUE_LENGTH = 3;

export interface ExtractionVerdict {
  pass: boolean;
  reason: string;
}

/**
 * Rules-based extraction gate: does this captured row carry a usable fact?
 * No LLM (operator decision Q3) — structural checks only.
 */
export function extractionRules(fact: { entity: string; value: string }): ExtractionVerdict {
  const entity = (fact.entity ?? "").trim();
  const value = (fact.value ?? "").trim();
  if (entity.length === 0) return { pass: false, reason: "empty entity" };
  if (value.length < MIN_VALUE_LENGTH) return { pass: false, reason: "value too short to be a fact" };
  if (/^\W+$/.test(value)) return { pass: false, reason: "value is punctuation/noise" };
  return { pass: true, reason: "structural checks passed" };
}

// ---------------------------------------------------------------------------
// Contradiction detection (extraction → review | promotion).
// ---------------------------------------------------------------------------

interface VisibleFact {
  id: string;
  persona: string | null;
  entity: string;
  key: string | null;
  value: string;
  createdAt: number;
}

function loadVisibleFact(db: Database, factId: string, scope: ScopePredicate): VisibleFact {
  const predicate = scopeSql(scope);
  const row = db.prepare(
    `SELECT id, persona, entity, key, value, created_at as createdAt
     FROM facts
     WHERE id = ? AND ${notForgottenSql()} AND ${predicate.sql}`
  ).get(factId, ...predicate.params) as VisibleFact | null;
  if (!row) {
    throw new PromotionStateError(
      `fact ${factId} is not visible to actor ${scope.actor} (missing, forgotten, or out of scope)`
    );
  }
  return row;
}

/**
 * Rules-based contradiction scan: an in-scope, live, non-forgotten fact with
 * the same entity+key but a different value contradicts the candidate.
 * Returns the ids of contradicting facts, oldest first.
 */
export function findContradictions(
  db: Database,
  fact: VisibleFact,
  scope: ScopePredicate
): string[] {
  const predicate = scopeSql(scope);
  const rows = db.prepare(
    `SELECT id FROM facts
     WHERE id != ?
       AND entity = ?
       AND COALESCE(key, '') = COALESCE(?, '')
       AND value != ?
       AND (expires_at IS NULL OR expires_at > strftime('%s', 'now'))
       AND ${notForgottenSql()}
       AND ${predicate.sql}
     ORDER BY created_at ASC`
  ).all(fact.id, fact.entity, fact.key, fact.value, ...predicate.params) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// The state machine.
// ---------------------------------------------------------------------------

export interface AdvanceResult {
  factId: string;
  from: PromotionStage;
  to: PromotionStage;
  /** Set when the fact entered review: the fact it contradicts. */
  contradictionOf?: string;
  /** Set when extraction rejected the fact (it stays at capture). */
  rejectedReason?: string;
}

/**
 * Advance one fact a single step through the pipeline.
 *  - capture    → extraction (if extraction rules pass; else stays, with reason)
 *  - extraction → review     (if a contradiction exists; conflict row recorded)
 *  - extraction → promotion  (no contradiction)
 *  - review     → throws (only resolveReview may leave review)
 *  - promotion  → throws (terminal)
 */
export function advancePromotion(
  db: Database,
  factId: string,
  options: { actor: string }
): AdvanceResult {
  const scope = resolveScope(options.actor, "advancePromotion");
  ensureIntelligencePlaneSchema(db);
  ensureConflictTable(db);
  const fact = loadVisibleFact(db, factId, scope);
  const stage = getPromotionStage(db, factId);
  if (stage === null) {
    throw new PromotionStateError(`fact ${factId} has no promotion ledger entry`);
  }

  switch (stage) {
    case "capture": {
      const verdict = extractionRules(fact);
      if (!verdict.pass) {
        return { factId, from: "capture", to: "capture", rejectedReason: verdict.reason };
      }
      recordStage(db, factId, "extraction", scope.actor);
      return { factId, from: "capture", to: "extraction" };
    }
    case "extraction": {
      const contradictions = findContradictions(db, fact, scope);
      if (contradictions.length > 0) {
        db.prepare(
          `INSERT INTO fact_conflicts (id, fact_id, conflicting_fact_id, conflict_type, resolution) VALUES (?, ?, ?, 'semantic', 'pending')`
        ).run(randomUUID(), factId, contradictions[0]);
        recordStage(db, factId, "review", scope.actor, contradictions[0]);
        return { factId, from: "extraction", to: "review", contradictionOf: contradictions[0] };
      }
      recordStage(db, factId, "promotion", scope.actor);
      return { factId, from: "extraction", to: "promotion" };
    }
    case "review":
      throw new PromotionStateError(
        `fact ${factId} is in review; only resolveReview (supersede/merge/flag) may move it`
      );
    case "promotion":
      throw new PromotionStateError(`fact ${factId} is already promoted (terminal stage)`);
  }
}

export interface SweepResult {
  examined: number;
  advancedToExtraction: number;
  promoted: number;
  sentToReview: number;
  rejected: Array<{ factId: string; reason: string }>;
  dryRun: boolean;
}

/**
 * Batch sweep (idempotent, dry-run, mirrors the knowledge-promoter job
 * shape). Facts with NO ledger entry are entered at capture first. Runs
 * every in-scope fact currently at capture or extraction one step, then
 * runs freshly-extracted facts their second step, so a clean fact goes
 * capture → promotion in one sweep. Review-stage facts are untouched.
 */
export function sweepPromotions(
  db: Database,
  options: { actor: string; dryRun?: boolean }
): SweepResult {
  const scope = resolveScope(options.actor, "sweepPromotions");
  ensureIntelligencePlaneSchema(db);
  ensureConflictTable(db);
  const predicate = scopeSql(scope, "f.persona");

  const rows = db.prepare(`
    SELECT f.id as factId,
           (SELECT stage FROM fact_promotions fp
             WHERE fp.fact_id = f.id
             ORDER BY fp.decided_at DESC, fp.created_at DESC, fp.rowid DESC LIMIT 1) as stage
    FROM facts f
    WHERE ${notForgottenSql("f.id")}
      AND (f.expires_at IS NULL OR f.expires_at > strftime('%s', 'now'))
      AND ${predicate.sql}
  `).all(...predicate.params) as Array<{ factId: string; stage: PromotionStage | null }>;

  const result: SweepResult = {
    examined: 0,
    advancedToExtraction: 0,
    promoted: 0,
    sentToReview: 0,
    rejected: [],
    dryRun: options.dryRun ?? false,
  };

  for (const row of rows) {
    if (row.stage !== null && row.stage !== "capture" && row.stage !== "extraction") continue;
    result.examined++;
    if (options.dryRun) continue;

    if (row.stage === null) enterCapture(db, row.factId, { actor: scope.actor });

    let step = advancePromotion(db, row.factId, { actor: scope.actor });
    if (step.rejectedReason) {
      result.rejected.push({ factId: row.factId, reason: step.rejectedReason });
      continue;
    }
    if (step.to === "extraction") {
      result.advancedToExtraction++;
      step = advancePromotion(db, row.factId, { actor: scope.actor });
    }
    if (step.to === "promotion") result.promoted++;
    else if (step.to === "review") result.sentToReview++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Human review queue — contradictions/contested facts ONLY (decision Q3).
// ---------------------------------------------------------------------------

export interface ReviewQueueItem {
  factId: string;
  entity: string;
  key: string | null;
  value: string;
  contradictionOf: string | null;
  contradictingValue: string | null;
  conflictId: string | null;
  enteredReviewAt: number;
  /** True once a flag decision marked the pair contested. */
  contested: boolean;
}

/**
 * The review queue: in-scope facts whose current stage is `review`.
 * By construction this contains only contradiction cases — nothing else is
 * ever routed to review.
 */
export function listReviewQueue(
  db: Database,
  options: { actor: string; limit?: number }
): ReviewQueueItem[] {
  const scope = resolveScope(options.actor, "listReviewQueue");
  ensureIntelligencePlaneSchema(db);
  ensureConflictTable(db);
  const predicate = scopeSql(scope, "f.persona");

  return (db.prepare(`
    SELECT f.id as factId, f.entity, f.key, f.value,
           fp.contradiction_of as contradictionOf,
           cf.value as contradictingValue,
           (SELECT id FROM fact_conflicts
             WHERE fact_id = f.id AND resolution IN ('pending','flagged')
             ORDER BY created_at DESC LIMIT 1) as conflictId,
           fp.decided_at as enteredReviewAt,
           EXISTS(SELECT 1 FROM fact_conflicts
                   WHERE fact_id = f.id AND resolution = 'flagged') as contested
    FROM facts f
    JOIN fact_promotions fp ON fp.fact_id = f.id
    LEFT JOIN facts cf ON cf.id = fp.contradiction_of
    WHERE fp.stage = 'review'
      AND fp.id = (SELECT id FROM fact_promotions
                    WHERE fact_id = f.id
                    ORDER BY decided_at DESC, created_at DESC, rowid DESC LIMIT 1)
      AND ${notForgottenSql("f.id")}
      AND ${predicate.sql}
    ORDER BY fp.decided_at ASC
    LIMIT ?
  `).all(...predicate.params, options.limit ?? 50) as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    contested: Boolean(r.contested),
  })) as ReviewQueueItem[];
}

export interface ReviewResolution {
  factId: string;
  decision: ReviewDecision;
  stage: PromotionStage;
  /** Fact reversibly forgotten by a supersede decision, if any. */
  forgottenFactId?: string;
}

/**
 * Resolve a review-stage fact. The ONLY exit from review.
 *  - supersede: the contradicted fact is reversibly forgotten; this fact promotes.
 *  - merge: both facts stand; this fact promotes.
 *  - flag: contested — conflict marked flagged, fact STAYS in review.
 */
export function resolveReview(
  db: Database,
  factId: string,
  decision: ReviewDecision,
  options: { actor: string }
): ReviewResolution {
  const actor = resolveActor(options.actor, "resolveReview");
  const scope = resolveScope(actor, "resolveReview");
  ensureIntelligencePlaneSchema(db);
  ensureConflictTable(db);

  loadVisibleFact(db, factId, scope);
  const stage = getPromotionStage(db, factId);
  if (stage !== "review") {
    throw new PromotionStateError(
      `resolveReview requires stage 'review'; fact ${factId} is at '${stage ?? "none"}'`
    );
  }

  const latestReview = db.prepare(
    `SELECT contradiction_of as contradictionOf FROM fact_promotions
     WHERE fact_id = ? AND stage = 'review'
     ORDER BY decided_at DESC, created_at DESC, rowid DESC LIMIT 1`
  ).get(factId) as { contradictionOf: string | null } | null;
  const contradictionOf = latestReview?.contradictionOf ?? null;

  const nowSec = Math.floor(Date.now() / 1000);
  const resolutionFor: Record<ReviewDecision, string> = {
    supersede: "superseded",
    merge: "merged",
    flag: "flagged",
  };
  db.prepare(
    `UPDATE fact_conflicts SET resolution = ?, resolved_at = ?
     WHERE fact_id = ? AND resolution = 'pending'`
  ).run(resolutionFor[decision], nowSec, factId);
  recordAudit(db, { actor, scope: decision, action: "review_decision", factId });

  if (decision === "flag") {
    // Contested: stays in review, visible to the operator queue.
    return { factId, decision, stage: "review" };
  }

  let forgottenFactId: string | undefined;
  if (decision === "supersede" && contradictionOf) {
    if (forgetFact(db, contradictionOf, { actor, reason: `superseded by ${factId} (review decision)` })) {
      forgottenFactId = contradictionOf;
    }
  }

  recordStage(db, factId, "promotion", actor);
  return { factId, decision, stage: "promotion", forgottenFactId };
}
