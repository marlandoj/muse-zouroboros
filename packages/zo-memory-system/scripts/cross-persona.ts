#!/usr/bin/env bun
/**
 * cross-persona.ts — Cross-Persona Memory Sharing & Inheritance
 * MEM-104: Cross-Persona Memory Sharing
 *
 * Usage:
 *   bun cross-persona.ts list-shared
 *   bun cross-persona.ts share --entity <name> --pools pool1,pool2
 *   bun cross-persona.ts inherit --persona <name> --from parent1,parent2
 *   bun cross-persona.ts search --persona <name> --query "<text>"
 */

import { Database } from "bun:sqlite";
import { DEFAULT_POOLS } from "./domain-map.ts";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS persona_pool_members (
      pool_id TEXT NOT NULL REFERENCES persona_pools(id) ON DELETE CASCADE,
      persona TEXT NOT NULL,
      added_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (pool_id, persona)
    );

    CREATE TABLE IF NOT EXISTS persona_inheritance (
      child_persona TEXT PRIMARY KEY,
      parent_persona TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pool_members_persona ON persona_pool_members(persona);
    CREATE INDEX IF NOT EXISTS idx_inheritance_child ON persona_inheritance(child_persona);
  `);
  return db;
}

export interface SharedPool { id: string; name: string; description?: string; personas: string[]; factCount: number; }
export interface PersonaNode { name: string; depth: number; children: PersonaNode[]; }

export function listPools(db: Database): SharedPool[] {
  const pools = db.prepare("SELECT * FROM persona_pools ORDER BY name").all() as Array<Record<string, unknown>>;
  return pools.map(p => {
    const members = (db.prepare("SELECT persona FROM persona_pool_members WHERE pool_id = ?").all(p.id as string) as Array<Record<string, unknown>>).map(m => m.persona as string);
    const factCount = members.length > 0
      ? (db.prepare(`SELECT COUNT(*) as c FROM facts WHERE persona IN (${members.map(() => "?").join(",")})`).get(...members) as { c: number }).c
      : 0;
    return { id: p.id as string, name: p.name as string, description: p.description as string | undefined, personas: members, factCount };
  });
}

export function createPool(db: Database, name: string, description?: string): string {
  const { randomUUID } = require("crypto");
  const id = randomUUID();
  db.prepare("INSERT OR IGNORE INTO persona_pools (id, name, description) VALUES (?, ?, ?)").run(id, name, description || null);
  return id;
}

export function addToPool(db: Database, poolId: string, persona: string): void {
  db.prepare("INSERT OR IGNORE INTO persona_pool_members (pool_id, persona) VALUES (?, ?)").run(poolId, persona);
}

export function removeFromPool(db: Database, poolId: string, persona: string): void {
  db.prepare("DELETE FROM persona_pool_members WHERE pool_id = ? AND persona = ?").run(poolId, persona);
}

export function setInheritance(db: Database, childPersona: string, parentPersonas: string[]): void {
  db.prepare("DELETE FROM persona_inheritance WHERE child_persona = ?").run(childPersona);
  for (let i = 0; i < parentPersonas.length; i++) {
    db.prepare("INSERT OR IGNORE INTO persona_inheritance (child_persona, parent_persona, depth) VALUES (?, ?, ?)").run(childPersona, parentPersonas[i], i + 1);
  }
}

export function getAccessiblePersonas(db: Database, persona: string): string[] {
  const direct = [persona];
  // Direct pool membership
  const pools = db.prepare("SELECT pool_id FROM persona_pool_members WHERE persona = ?").all(persona) as Array<Record<string, unknown>>;
  for (const pool of pools) {
    const members = db.prepare("SELECT persona FROM persona_pool_members WHERE pool_id = ? AND persona != ?").all(pool.pool_id as string, persona) as Array<Record<string, unknown>>;
    for (const m of members) direct.push(m.persona as string);
  }
  // Inheritance chain
  const parents = db.prepare("SELECT parent_persona FROM persona_inheritance WHERE child_persona = ? ORDER BY depth ASC").all(persona) as Array<Record<string, unknown>>;
  for (const parent of parents) direct.push(parent.parent_persona as string);
  return [...new Set(direct)];
}

export function searchCrossPersona(db: Database, persona: string, query: string, limit = 10): Array<Record<string, unknown>> {
  const accessible = getAccessiblePersonas(db, persona);
  if (accessible.length === 0) return [];
  const placeholders = accessible.map(() => "?").join(",");
  const safeQuery = query.replace(/['"*]/g, "").trim();
  try {
    return db.prepare(`
      SELECT f.*, rank,
        CASE WHEN f.persona = ? THEN 1.0 ELSE 0.8 END as access_bonus
      FROM facts f
      JOIN facts_fts fts ON f.rowid = fts.rowid
      WHERE facts_fts MATCH ? AND f.persona IN (${placeholders})
        AND (f.expires_at IS NULL OR f.expires_at > ?)
      ORDER BY rank * (CASE WHEN f.persona = ? THEN 1.0 ELSE 0.8 END) ASC
      LIMIT ?
    `).all(persona, safeQuery, ...accessible, Math.floor(Date.now() / 1000), persona, limit) as Array<Record<string, unknown>>;
  } catch { return []; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Cross-Persona Memory CLI\n\nCommands:\n  list-pools                   List all shared pools\n  create-pool --name <n> --desc <d>  Create a shared pool\n  add-to-pool --pool <id> --persona <p>  Add persona to pool\n  remove-from-pool --pool <id> --persona <p>  Remove persona from pool\n  list-inheritance             Show inheritance hierarchy\n  set-inheritance --child <p> --parents p1,p2  Set parent chain\n  accessible --persona <name>  Show accessible personas for a persona\n  search --persona <name> --query <text>  Cross-persona search");
    process.exit(0);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i + 1] || "";
  const command = args[0];
  const db = getDb();

  if (command === "list-pools") {
    const pools = listPools(db);
    if (pools.length === 0) { console.log("No shared pools."); }
    else { pools.forEach(p => { console.log(`[${p.id.slice(0,8)}] ${p.name} | ${p.description || "no description"} | ${p.personas.length} personas | ${p.factCount} facts`); if (p.personas.length) console.log(`  Members: ${p.personas.join(", ")}`); }); }
  }
  else if (command === "create-pool") {
    if (!flags.name) { console.error("--name required"); process.exit(1); }
    const id = createPool(db, flags.name, flags.desc);
    console.log(`Pool "${flags.name}" created: ${id.slice(0, 8)}`);
  }
  else if (command === "add-to-pool") {
    if (!flags.pool || !flags.persona) { console.error("--pool and --persona required"); process.exit(1); }
    addToPool(db, flags.pool, flags.persona);
    console.log(`Added "${flags.persona}" to pool ${flags.pool.slice(0, 8)}.`);
  }
  else if (command === "remove-from-pool") {
    if (!flags.pool || !flags.persona) { console.error("--pool and --persona required"); process.exit(1); }
    removeFromPool(db, flags.pool, flags.persona);
    console.log(`Removed "${flags.persona}" from pool ${flags.pool.slice(0, 8)}.`);
  }
  else if (command === "set-inheritance") {
    if (!flags.child || !flags.parents) { console.error("--child and --parents required"); process.exit(1); }
    const parents = flags.parents.split(",").map(p => p.trim()).filter(Boolean);
    setInheritance(db, flags.child, parents);
    console.log(`"${flags.child}" now inherits from: ${parents.join(" > ")}`);
  }
  else if (command === "accessible") {
    if (!flags.persona) { console.error("--persona required"); process.exit(1); }
    const accessible = getAccessiblePersonas(db, flags.persona);
    console.log(`Accessible for "${flags.persona}": ${accessible.join(", ")}`);
  }
  else if (command === "search") {
    if (!flags.persona || !flags.query) { console.error("--persona and --query required"); process.exit(1); }
    const results = await searchCrossPersona(db, flags.persona, flags.query);
    if (results.length === 0) { console.log("No results."); }
    else { results.forEach(r => console.log(`  [${(r.persona as string).padEnd(20)}] ${(r.entity as string)}.${(r.key || "_") as string} = ${(r.value as string).slice(0, 80)}`)); }
  }
  else if (command === "setup-pools") {
    const existingPools = listPools(db);
    const existingNames = new Set(existingPools.map(p => p.name));
    let created = 0;
    let membersAdded = 0;
    for (const pool of DEFAULT_POOLS) {
      let poolId: string;
      if (existingNames.has(pool.name)) {
        const existing = existingPools.find(p => p.name === pool.name)!;
        poolId = existing.id;
        console.log(`Pool "${pool.name}" already exists (${existing.personas.length} members)`);
      } else {
        poolId = createPool(db, pool.name, pool.description);
        created++;
        console.log(`Created pool "${pool.name}": ${poolId.slice(0, 8)}`);
      }
      // Add members not already in pool
      const existingPool = existingPools.find(p => p.name === pool.name);
      const existingMembers = new Set(existingPool?.personas || []);
      for (const member of pool.members) {
        if (!existingMembers.has(member)) {
          addToPool(db, poolId, member);
          membersAdded++;
        }
      }
    }
    console.log(`\nSetup complete: ${created} pools created, ${membersAdded} members added`);
    // Show final state
    const finalPools = listPools(db);
    for (const p of finalPools) {
      console.log(`  [${p.name}] ${p.personas.length} members, ${p.factCount} facts`);
    }
  }
  db.close();
}

if (import.meta.main) main();
