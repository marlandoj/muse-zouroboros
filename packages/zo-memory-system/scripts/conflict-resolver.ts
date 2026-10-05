#!/usr/bin/env bun
/**
 * conflict-resolver.ts — Memory Conflict Detection & Resolution
 * MEM-103: Memory Conflict Resolution
 *
 * Usage:
 *   bun conflict-resolver.ts detect --entity <name>
 *   bun conflict-resolver.ts resolve --id <conflictId> --strategy supersede|flag
 *   bun conflict-resolver.ts history --entity <name> --key <key>
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { generate as mcGenerate } from "./model-client";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
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
    CREATE TABLE IF NOT EXISTS fact_provenance (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      capture_method TEXT,
      superseded_by TEXT REFERENCES facts(id),
      superseded_at INTEGER,
      effective_from INTEGER DEFAULT (strftime('%s','now')),
      effective_until INTEGER,
      metadata TEXT,
      UNIQUE(fact_id, source)
    );
    CREATE INDEX IF NOT EXISTS idx_conflicts_fact ON fact_conflicts(fact_id);
    CREATE INDEX IF NOT EXISTS idx_provenance_fact ON fact_provenance(fact_id);
  `);
  return db;
}

export type ConflictType = "semantic" | "temporal" | "exact";
export type ResolutionStrategy = "supersede" | "merge" | "flag" | "pending";

export interface ConflictRecord {
  id: string; factId: string; conflictingFactId: string;
  conflictType: ConflictType; resolution: ResolutionStrategy | null;
  fact1Value: string; fact2Value: string; createdAt: number;
}

export interface ProvenanceRecord {
  id: string; factId: string; source: string; capturedAt: number;
  captureMethod?: string; supersededBy?: string; supersededAt?: number;
  effectiveFrom: number; effectiveUntil?: number;
}

async function llmCheck(prompt: string): Promise<boolean> {
  try {
    const result = await mcGenerate({
      prompt,
      workload: "gate",
      temperature: 0,
      maxTokens: 50,
    });
    const r = result.content.trim().toLowerCase();
    return r === "yes" || r === "true";
  } catch { return false; }
}

export async function isContradiction(
  fact1: { value: string; entity: string; key: string | null },
  fact2: { value: string; entity: string; key: string | null }
): Promise<boolean> {
  if (fact1.value.trim().toLowerCase() === fact2.value.trim().toLowerCase()) return false;
  const n1 = parseFloat((fact1.value.match(/^[\d.,]+/)?.[0] || "").replace(/,/g, ""));
  const n2 = parseFloat((fact2.value.match(/^[\d.,]+/)?.[0] || "").replace(/,/g, ""));
  if (!isNaN(n1) && !isNaN(n2) && Math.abs(n1 - n2) > 0.001 * Math.max(n1, n2)) return true;
  const prompt = `Do these two statements directly contradict each other? Reply "yes" or "no".
1: "${fact1.value.slice(0, 300)}"
2: "${fact2.value.slice(0, 300)}"`;
  return llmCheck(prompt);
}

export function findEntityConflicts(db: Database, entity: string): ConflictRecord[] {
  const rows = db.prepare(`
    SELECT fc.id, fc.fact_id, fc.conflicting_fact_id, fc.conflict_type, fc.resolution, fc.created_at,
      f1.value as fact1_value, f2.value as fact2_value
    FROM fact_conflicts fc
    JOIN facts f1 ON fc.fact_id = f1.id
    JOIN facts f2 ON fc.conflicting_fact_id = f2.id
    WHERE f1.entity = ? OR f2.entity = ?
    ORDER BY fc.created_at DESC
  `).all(entity, entity) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: r.id as string, factId: r.fact_id as string, conflictingFactId: r.conflicting_fact_id as string,
    conflictType: r.conflict_type as ConflictType, resolution: r.resolution as ResolutionStrategy | null,
    fact1Value: r.fact1_value as string, fact2Value: r.fact2_value as string, createdAt: r.created_at as number,
  }));
}

export async function detectNewConflict(db: Database, entity: string, key: string | null, newValue: string): Promise<ConflictRecord | null> {
  const existing = db.prepare(`
    SELECT id, entity, key, value, created_at FROM facts
    WHERE entity = ? ${key ? "AND key = ?" : "AND key IS NULL"} AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC LIMIT 10
  `).all(entity, ...(key ? [key] : []), Math.floor(Date.now() / 1000)) as Array<Record<string, unknown>>;

  for (const ef of existing) {
    if ((ef.value as string).trim().toLowerCase() === newValue.trim().toLowerCase()) continue;
    const isContradict = await isContradiction(
      { value: newValue, entity, key },
      { value: ef.value as string, entity, key },
    );
    if (isContradict) {
      const nowSec = Math.floor(Date.now() / 1000);
      const cid = randomUUID();
      const factId = ef.id as string;
      const conflictingFactId = randomUUID();
      db.prepare(`INSERT OR IGNORE INTO fact_conflicts (id, fact_id, conflicting_fact_id, conflict_type, resolution, created_at) VALUES (?, ?, ?, 'semantic', 'pending', ?)`).run(cid, factId, conflictingFactId, nowSec);
      return { id: cid, factId, conflictingFactId, conflictType: "semantic", resolution: "pending", fact1Value: ef.value as string, fact2Value: newValue, createdAt: nowSec };
    }
  }
  return null;
}

export function resolveConflict(db: Database, conflictId: string, strategy: ResolutionStrategy): void {
  const nowSec = Math.floor(Date.now() / 1000);
  if (strategy === "supersede") {
    db.prepare("UPDATE fact_conflicts SET resolution = 'superseded', resolved_at = ? WHERE id = ?").run(nowSec, conflictId);
    db.prepare("UPDATE facts SET expires_at = ? WHERE id = (SELECT fact_id FROM fact_conflicts WHERE id = ? AND resolution = 'superseded')").run(nowSec - 1, conflictId);
  } else {
    db.prepare("UPDATE fact_conflicts SET resolution = ?, resolved_at = ? WHERE id = ?").run(strategy, nowSec, conflictId);
  }
}

export function resolveAllPending(db: Database, strategy: ResolutionStrategy = "flag"): number {
  const result = db.prepare("UPDATE fact_conflicts SET resolution = ?, resolved_at = ? WHERE resolution = 'pending'").run(strategy, Math.floor(Date.now() / 1000));
  return result.changes;
}

export function trackProvenance(db: Database, factId: string, source: string, captureMethod?: string): void {
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare(`INSERT OR IGNORE INTO fact_provenance (id, fact_id, source, captured_at, capture_method, effective_from) VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), factId, source, nowSec, captureMethod || null, nowSec);
}

export function getProvenance(db: Database, factId: string): ProvenanceRecord[] {
  return (db.prepare("SELECT * FROM fact_provenance WHERE fact_id = ? ORDER BY effective_from DESC").all(factId) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string, factId: r.fact_id as string, source: r.source as string,
    capturedAt: r.captured_at as number, captureMethod: r.capture_method as string | undefined,
    supersededBy: r.superseded_by as string | undefined, supersededAt: r.superseded_at as number | undefined,
    effectiveFrom: r.effective_from as number, effectiveUntil: r.effective_until as number | undefined,
  }));
}

export function getFactHistory(db: Database, entity: string, key: string | null): Array<{ id: string; value: string; effectiveFrom: number; superseded: boolean }> {
  const rows = db.prepare(`
    SELECT f.id, f.value, COALESCE(fp.effective_from, f.created_at) as eff, fp.superseded_by
    FROM facts f LEFT JOIN fact_provenance fp ON f.id = fp.fact_id
    WHERE f.entity = ? ${key ? "AND f.key = ?" : "AND f.key IS NULL"}
    ORDER BY eff DESC
  `).all(entity, ...(key ? [key] : [])) as Array<Record<string, unknown>>;
  return rows.map(r => ({ id: r.id as string, value: r.value as string, effectiveFrom: r.eff as number, superseded: Boolean(r.superseded_by) }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Conflict Resolver CLI\n\nCommands:\n  detect --entity <name>            Detect conflicts for an entity\n  resolve --id <conflictId> --strategy supersede|flag\n  resolve-all --strategy <s>          Resolve all pending\n  provenance --id <factId>            Show provenance chain\n  history --entity <name> --key <key> Show value history\n  stats                             Conflict stats");
    process.exit(0);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i + 1] || "";
  const command = args[0];
  const db = getDb();

  if (command === "detect") {
    if (!flags.entity) { console.error("--entity required"); process.exit(1); }
    const conflicts = findEntityConflicts(db, flags.entity);
    if (conflicts.length === 0) { console.log(`No conflicts for "${flags.entity}".`); }
    else { console.log(`${conflicts.length} conflict(s):\n`); for (const c of conflicts) { console.log(`  [${c.id.slice(0,8)}] ${c.conflictType} | ${c.resolution || "pending"}\n    F1: ${c.fact1Value.slice(0,80)}\n    F2: ${c.fact2Value.slice(0,80)}\n`); } }
  }
  else if (command === "resolve") {
    if (!flags.id || !flags.strategy) { console.error("--id and --strategy required"); process.exit(1); }
    resolveConflict(db, flags.id, flags.strategy as ResolutionStrategy);
    console.log(`Conflict ${flags.id.slice(0,8)} resolved as ${flags.strategy}.`);
  }
  else if (command === "resolve-all") {
    const n = resolveAllPending(db, (flags.strategy as ResolutionStrategy) || "flag");
    console.log(`${n} pending conflict(s) resolved.`);
  }
  else if (command === "provenance") {
    if (!flags.id) { console.error("--id required"); process.exit(1); }
    const prov = getProvenance(db, flags.id);
    if (prov.length === 0) { console.log("No provenance records."); }
    else { prov.forEach(p => console.log(`  ${new Date(p.capturedAt * 1000).toISOString()} | ${p.source} | superseded=${p.supersededBy ? "yes (" + p.supersededBy.slice(0,8) + ")" : "no"}`)); }
  }
  else if (command === "history") {
    if (!flags.entity) { console.error("--entity required"); process.exit(1); }
    const history = getFactHistory(db, flags.entity, flags.key || null);
    if (history.length === 0) { console.log("No history found."); }
    else { history.forEach(h => console.log(`  [${h.superseded ? "SUPERSEDED" : "active"}] ${h.value.slice(0,80)}\n    since ${new Date(h.effectiveFrom * 1000).toDateString()}`)); }
  }
  else if (command === "stats") {
    const total = db.prepare("SELECT COUNT(*) as c FROM fact_conflicts").get() as { c: number };
    const pending = db.prepare("SELECT COUNT(*) as c FROM fact_conflicts WHERE resolution = 'pending'").get() as { c: number };
    const resolved = db.prepare("SELECT COUNT(*) as c FROM fact_conflicts WHERE resolution != 'pending'").get() as { c: number };
    console.log(`Conflicts: ${total.c} total | ${pending.c} pending | ${resolved.c} resolved`);
  }
  db.close();
}

if (import.meta.main) main();
