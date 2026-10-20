/**
 * Track 1 regression tests: the definer-rights scope-leak class.
 *
 * Before Track 1, the graph arm (findGraphNeighbors neighbor injection in
 * hybridSearch and the MCP servers) fetched facts with NO persona filter:
 * any actor could pull another persona's facts through a fact_links edge.
 * These tests pin the fix — cross-actor facts must not leak through any
 * graph-arm surface — and the actor-resolution contract (a missing actor
 * resolves to the 'shared' scope) at the function and MCP boundaries.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDb,
  closeDb,
  storeWithEmbedding,
  hybridSearch,
  ftsSearch,
  vectorSearch,
  deleteFact,
} from "./memory";
import { findGraphNeighbors } from "./graph-boost";
import { resolveScope, resolveActor } from "./scope";

// Deterministic embeddings: no network, no keys, stable across machines.
process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";

const root = mkdtempSync(join(tmpdir(), "scope-leak-test-"));
// The MCP server module reads ZO_MEMORY_DB at load; point it at a scratch DB
// BEFORE its first (dynamic) import so no test ever touches a real database.
process.env.ZO_MEMORY_DB = join(root, "mcp-scratch.db");
// Pre-create the full schema in the MCP scratch DB (production DBs are
// initialized by install.sh / memory.ts init before the server starts).
await initDb(process.env.ZO_MEMORY_DB);
let dbCounter = 0;

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await initDb(join(root, `t${dbCounter++}.db`));
});

async function seedFact(actor: string, entity: string, value: string) {
  const entry = await storeWithEmbedding({
    entity,
    key: null,
    value,
    text: `${entity} : ${value}`,
    category: "fact",
    decayClass: "stable",
    importance: 1.0,
    source: "test",
    confidence: 1.0,
  }, { actor, skipWikilinkEnforcement: true });
  if (!entry) throw new Error("seed failed");
  return entry;
}

/**
 * The pre-Track-1 leak shape: a private fact owned by another persona whose
 * fact is graph-linked (fact_links edge) to a shared fact the attacker
 * legitimately retrieves.
 */
async function seedCrossActorBank() {
  const db = await initDb();
  const victim = await seedFact("financial-advisor", "acme-portfolio", "holds 40% NVDA — confidential allocation");
  const shared = await seedFact("shared", "market-report", "weekly market report covers tech sector");
  // The bridge the old code walked straight across.
  db.prepare(
    "INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'related', 1.0)"
  ).run(shared.id, victim.id);
  return { victim, shared };
}

describe("graph-arm scope leak (regression)", () => {
  test("hybridSearch graph injection does not surface cross-actor facts", async () => {
    await seedCrossActorBank();

    const attacker = await hybridSearch("weekly market report", { actor: "alaric", useHyde: false, limit: 10 });
    const attackerValues = attacker.map((r) => r.entry.value).join(" | ");
    expect(attackerValues).toContain("weekly market report");
    expect(attackerValues).not.toContain("confidential allocation");

    // The owner still gets their own fact through the same arm.
    const owner = await hybridSearch("weekly market report", { actor: "financial-advisor", useHyde: false, limit: 10 });
    const ownerValues = owner.map((r) => r.entry.value).join(" | ");
    expect(ownerValues).toContain("confidential allocation");
    expect(ownerValues.includes("graph") || owner.some((r) => r.sources.some((s) => s.startsWith("graph")))).toBe(true);
  });

  test("findGraphNeighbors filters neighbors by scope", async () => {
    const { shared } = await seedCrossActorBank();
    const db = await initDb();

    const attackerNeighbors = findGraphNeighbors(db, [shared.id], new Set([shared.id]), 5, resolveScope("alaric"));
    expect(attackerNeighbors.length).toBe(0);

    const ownerNeighbors = findGraphNeighbors(db, [shared.id], new Set([shared.id]), 5, resolveScope("financial-advisor"));
    expect(ownerNeighbors.length).toBe(1);
  });

  test("keyword and vector arms stay scoped too", async () => {
    await seedCrossActorBank();

    const kw = await ftsSearch("confidential allocation NVDA", { actor: "alaric", limit: 10 });
    expect(kw.length).toBe(0);
    const vec = await vectorSearch("confidential allocation NVDA acme portfolio holds", { actor: "alaric", limit: 10 });
    expect(vec.map((r) => r.entry.value).join(" ")).not.toContain("confidential");

    const kwOwner = await ftsSearch("confidential allocation NVDA", { actor: "financial-advisor", limit: 10 });
    expect(kwOwner.length).toBeGreaterThan(0);
  });

  test("scoped delete: an actor cannot delete another persona's fact", async () => {
    const { victim } = await seedCrossActorBank();
    expect(await deleteFact(victim.id, { actor: "alaric" })).toBe(false);
    expect(await deleteFact(victim.id, { actor: "financial-advisor" })).toBe(true);
  });
});

describe("actor resolution at the function boundary", () => {
  test("search and store without actor resolve to the shared scope", async () => {
    const entry = await storeWithEmbedding({
      entity: "probe", key: null, value: "shared-scope probe fact",
      text: "probe : shared-scope probe fact", category: "fact",
      decayClass: "stable", importance: 1, source: "test", confidence: 1,
    }, { actor: undefined as never });
    expect(entry?.persona).toBe("shared");

    const kw = await ftsSearch("shared-scope probe", { actor: "" as never, limit: 5 });
    expect(kw.some((r) => r.entry.id === entry!.id)).toBe(true);
    await expect(hybridSearch("anything", { actor: undefined as never, useHyde: false })).resolves.toBeDefined();
    await expect(vectorSearch("anything", { actor: "   " as never })).resolves.toBeDefined();
  });

  test("resolveActor falls back to 'shared' for missing/non-string actors", () => {
    expect(resolveActor(42 as never)).toBe("shared");
    expect(resolveActor(null as never)).toBe("shared");
    expect(resolveActor("")).toBe("shared");
    expect(resolveScope(42 as never).personas).toEqual(["shared"]);
    expect(resolveActor("  claude-code ")).toBe("claude-code");
  });

  test("store persona defaults to the actor when one is given", async () => {
    const entry = await seedFact("claude-code", "pref.editor", "editor is Neovim");
    expect(entry.persona).toBe("claude-code");

    // Invisible to an unrelated actor; visible to the owner and via audit.
    const other = await ftsSearch("editor Neovim", { actor: "codex", limit: 5 });
    expect(other.length).toBe(0);
    const own = await ftsSearch("editor Neovim", { actor: "claude-code", limit: 5 });
    expect(own.length).toBe(1);
  });

  test("every scoped access writes a memory_audit row", async () => {
    const db = await initDb();
    await seedFact("claude-code", "audit.probe", "audit probe fact");
    await ftsSearch("audit probe", { actor: "claude-code", limit: 5 });
    const rows = db.prepare(
      "SELECT action, COUNT(*) c FROM memory_audit WHERE actor = ? GROUP BY action ORDER BY action"
    ).all("claude-code") as Array<{ action: string; c: number }>;
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r.c]));
    expect(byAction["store"]).toBe(1);
    expect(byAction["search"]).toBe(1);
  });
});

describe("actor resolution at the MCP boundary", () => {
  test("memory_store / memory_search without actor operate on the shared scope", async () => {
    const { toolMemorySearch, toolMemoryStore } = await import("./mcp-server");

    await toolMemoryStore({ entity: "x", value: "y" } as never);
    const res = await toolMemorySearch({ query: "y" } as never);
    expect(res).toContain("scope: actor=shared personas=[shared]");

    // The store landed under the 'shared' persona (check the MCP server's own DB).
    const { Database } = await import("bun:sqlite");
    const mcpDb = new Database(process.env.ZO_MEMORY_DB!);
    const rows = mcpDb.prepare("SELECT persona FROM facts").all() as Array<{ persona: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].persona).toBe("shared");
    mcpDb.close();
  });

  test("memory_search with actor returns scoped results and scope metadata", async () => {
    // The MCP server opens its own DB handle from ZO_MEMORY_DB at first use;
    // its singleton is already bound (previous test), so seed through it.
    const { toolMemorySearch, toolMemoryStore } = await import("./mcp-server");
    await toolMemoryStore({ actor: "alaric", entity: "note.a", value: "alaric note about zouroboros" });
    await toolMemoryStore({ actor: "financial-advisor", entity: "note.b", value: "advisor note about zouroboros" });

    const res = await toolMemorySearch({ actor: "alaric", query: "note about zouroboros" });
    expect(res).toContain("scope: actor=alaric personas=[alaric, shared]");
    expect(res).toContain("alaric note");
    expect(res).not.toContain("advisor note");
  });
});
