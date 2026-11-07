#!/usr/bin/env bun
/**
 * Child-process probe for graph-visibility.test.ts (not a test file itself).
 *
 * Exercises, on a scratch database only:
 *  - MCP memory_search (toolMemorySearch): printed output with and without a
 *    link from a visible fact to another persona's fact / dangling ids;
 *  - computeGraphBoost over vault_links: hidden fact endpoints vs. a visible
 *    vault-file endpoint.
 * Runs in its own process because mcp-server binds ZO_MEMORY_DB at import and
 * graph-boost caches vault_links existence per process.
 *
 * usage: bun graph-visibility-probe.ts <mcp|vault> <scratch-dir>   (prints one JSON line)
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const mode = process.argv[2];
const dir = process.argv[3];
if ((mode !== "mcp" && mode !== "vault") || !dir) throw new Error("usage: graph-visibility-probe.ts <mcp|vault> <scratch-dir>");
mkdirSync(dir, { recursive: true });
process.env.ZO_MODEL_EMBEDDING = process.env.ZO_MODEL_EMBEDDING || "deterministic:hash-v1";
const mcpDbPath = join(dir, "mcp.db");
process.env.ZO_MEMORY_DB = mcpDbPath;

const { initDb, closeDb } = await import("./memory");
const { resolveScope } = await import("./scope");

function link(db: Database, table: string, s: string, t: string, w = 1.0) {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(`INSERT OR IGNORE INTO ${table} (source_id, target_id, relation, weight) VALUES (?, ?, 'related', ?)`).run(s, t, w);
}

// ---- MCP memory_search -----------------------------------------------------
if (mode === "mcp") {
await initDb(mcpDbPath); // full schema, as install.sh / memory.ts init does
closeDb();
const mcp = await import("./mcp-server");
await mcp.toolMemoryStore({ actor: "shared", entity: "market-report", value: "weekly market report covers tech sector" });
await mcp.toolMemoryStore({ actor: "shared", entity: "market-calendar", value: "weekly market calendar lists earnings dates" });
await mcp.toolMemoryStore({ actor: "financial-advisor", entity: "acme-portfolio", value: "holds 40% NVDA confidential allocation" });
const mdb = mcp.getDb();
const sharedId = (mdb.prepare("SELECT id FROM facts WHERE entity = 'market-report'").get() as { id: string }).id;
const victimId = (mdb.prepare("SELECT id FROM facts WHERE entity = 'acme-portfolio'").get() as { id: string }).id;

const q = "weekly market report";
const attackerBefore = await mcp.toolMemorySearch({ actor: "alaric", query: q });
const ownerBefore = await mcp.toolMemorySearch({ actor: "financial-advisor", query: q });
link(mdb, "fact_links", sharedId, victimId, 1.0);
for (let i = 0; i < 10; i++) link(mdb, "fact_links", sharedId, `ghost-${i}`, 1.0);
const attackerAfter = await mcp.toolMemorySearch({ actor: "alaric", query: q });
const ownerAfter = await mcp.toolMemorySearch({ actor: "financial-advisor", query: q });
console.log(JSON.stringify({ attackerBefore, attackerAfter, ownerBefore, ownerAfter }));
process.exit(0);
}

// ---- vault_links -------------------------------------------------------------
const vdb = await initDb(join(dir, "vault.db"));
vdb.exec(`
  CREATE TABLE IF NOT EXISTS vault_files (id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, title TEXT,
    tags TEXT DEFAULT '[]', personas TEXT DEFAULT '[]', last_indexed INTEGER, mtime INTEGER,
    link_count INTEGER DEFAULT 0, backlink_count INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS vault_links (source_id TEXT NOT NULL, target_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'related', weight REAL DEFAULT 1.0,
    created_at INTEGER DEFAULT (strftime('%s', 'now')), PRIMARY KEY (source_id, target_id, relation));
`);
const { computeGraphBoost } = await import("./graph-boost");
const nowMs = Date.now();
const ins = vdb.prepare(`INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance,
  source, created_at, expires_at, last_accessed, confidence) VALUES (?, ?, ?, NULL, ?, ?, 'fact', 'stable', 1, 'test', ?, NULL, ?, 1)`);
for (const [id, p] of [["A", "shared"], ["B", "shared"], ["X", "financial-advisor"]]) ins.run(id, p, `e.${id}`, `v ${id}`, `e.${id} v ${id}`, nowMs, Math.floor(nowMs / 1000));
vdb.prepare("INSERT INTO vault_files (id, file_path, title) VALUES ('vf-0001', 'notes/a.md', 'A note')").run();
const scope = resolveScope("alaric");
const rs = [
  { id: "A", rrfScore: 0.03, freshness: 1, confidence: 1, sources: ["fts"] },
  { id: "B", rrfScore: 0.029, freshness: 1, confidence: 1, sources: ["fts"] },
];
const snap = () => computeGraphBoost(vdb, rs, scope).map(r => ({ id: r.id, composite: r.composite, graphBoost: r.graphBoost }));
const baseline = snap();
link(vdb, "vault_links", "A", "X", 1.0);          // other persona
link(vdb, "vault_links", "vf-ghost", "B", 1.0);   // dangling vault id
const hiddenOnly = snap();
link(vdb, "vault_links", "A", "vf-0001", 1.0);    // visible vault file
const withVaultFileAndHidden = snap();
vdb.exec("DELETE FROM vault_links WHERE target_id = 'X' OR source_id = 'vf-ghost'");
const withVaultFile = snap();

console.log(JSON.stringify({
  baseline, hiddenOnly, withVaultFile, withVaultFileAndHidden,
  withVaultFileGraphBoost: withVaultFile.find(r => r.id === "A")!.graphBoost,
}));
