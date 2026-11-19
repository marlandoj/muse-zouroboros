#!/usr/bin/env bun
/**
 * observations.ts — Observation substrate for the plane-native observation layer.
 *
 * Ported from the monorepo's packages/memory/src/observations.ts (2026-10-15,
 * plane-observation-layer branch). Only the pieces the session observer needs
 * are vendored here: the kind/decay vocabulary and the idempotent schema
 * ensure. The full consolidation machinery (consolidateObservations et al.)
 * was not ported — this package's observation story is the per-session
 * observer in session-observer.ts.
 *
 * Target-layout adaptations:
 *  - Explicit `db` parameter (this package's convention: forgetting.ts,
 *    scope.ts, continuation.ts all take Database first — no module singleton).
 *  - Called from memory.ts initDb() and mcp-server.ts getDb(), so every
 *    entry point upgrades pre-existing DBs in place. There is no _migrations
 *    framework in this package, so the idempotent ensure IS the migration
 *    (the monorepo's 103_observation_layer_indexes is not needed here).
 *  - The legacy hook-capture reconciliation (event-observations.ts) does not
 *    exist in this package and was not ported.
 */

import { Database } from "bun:sqlite";

export type ObservationKind = "entity" | "session";

export type ObservationDecayClass =
  | "permanent"
  | "stable"
  | "active"
  | "session"
  | "checkpoint";

export interface Observation {
  id: string;
  persona: string;
  entity: string;
  key: string | null;
  text: string;
  proofCount: number;
  status: "active" | "contested" | "faded";
  createdAt: number;
  updatedAt: number;
  /** Newest supporting fact's created_at (milliseconds in this package). */
  lastEvidenceAt: number | null;
  /** 'entity' = key-structured consolidation; 'session' = per-session narrative (plane-native observation layer). */
  kind: ObservationKind;
  /** Plane decay vocabulary, derived from supporting facts (max liveness). */
  decayClass: ObservationDecayClass;
  /** Session date the observation describes (session-kind only), unix seconds. */
  observedAt: number | null;
}

/**
 * Idempotent DDL for the observation tables. Safe on pre-existing databases:
 * CREATE TABLE IF NOT EXISTS for fresh DBs, plus pragma-guarded ALTERs
 * (SQLite has no ADD COLUMN IF NOT EXISTS) for tables created before the
 * plane-native observation layer added kind/decay_class/observed_at.
 *
 * Ordering matters: the kind index is created AFTER the column upgrade.
 * On a pre-existing observations table the CREATE TABLE is a no-op, and
 * creating the index first would throw "no such column".
 */
export function ensureObservationSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      persona TEXT NOT NULL DEFAULT 'shared',
      entity TEXT NOT NULL,
      key TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      proof_count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','contested','faded')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      last_evidence_at INTEGER,
      kind TEXT NOT NULL DEFAULT 'entity' CHECK(kind IN ('entity','session')),
      decay_class TEXT NOT NULL DEFAULT 'stable' CHECK(decay_class IN ('permanent','stable','active','session','checkpoint')),
      observed_at INTEGER,
      UNIQUE(persona, entity, key)
    );
    CREATE TABLE IF NOT EXISTS observation_evidence (
      observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      quote TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (observation_id, fact_id)
    );
  `);

  // Upgrade path for tables created before the observation layer: the
  // CREATE TABLE above is a no-op there, so add the columns explicitly.
  const cols = db
    .query(`PRAGMA table_info(observations)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("kind")) {
    db.exec(
      `ALTER TABLE observations ADD COLUMN kind TEXT NOT NULL DEFAULT 'entity' CHECK(kind IN ('entity','session'))`
    );
  }
  if (!names.has("decay_class")) {
    db.exec(
      `ALTER TABLE observations ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable' CHECK(decay_class IN ('permanent','stable','active','session','checkpoint'))`
    );
  }
  if (!names.has("observed_at")) {
    db.exec(`ALTER TABLE observations ADD COLUMN observed_at INTEGER`);
  }

  // Indexes last: every indexed column is guaranteed to exist by now.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity, key);
    CREATE INDEX IF NOT EXISTS idx_observations_persona ON observations(persona, status);
    CREATE INDEX IF NOT EXISTS idx_observations_kind ON observations(kind, status, observed_at DESC);
  `);
}
