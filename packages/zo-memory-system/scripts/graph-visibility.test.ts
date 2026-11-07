/**
 * SEC-graph-visibility: property tests for the computeGraphBoost scope invariant.
 *
 * Contract (v2 "both endpoints visible"): a fact_links / vault_links edge may
 * only influence ranking when BOTH endpoints are visible to the caller — a
 * fact that exists, is unexpired, is in the caller's scope and is not
 * forgotten (or, for vault_links, an indexed vault file). Before this fix a
 * link whose other end was out of scope, forgotten or missing (dangling)
 * still added weight x 0.3 to the visible end, and memory_search prints a
 * score per item: a membership oracle for facts the caller cannot see.
 *
 * Invariant pinned here: such a link NEVER changes the score or the rank of
 * the visible end. A visible link (control) must still boost exactly as the
 * pre-fix formula did. These tests always run; the invariant has no config
 * key and must not get one.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDb, closeDb, hybridSearch, storeWithEmbedding } from "./memory";
import { computeGraphBoost, type GraphScope } from "./graph-boost";
import { resolveScope } from "./scope";

// Deterministic embeddings: no network, no keys, stable across machines.
process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";

const root = mkdtempSync(join(tmpdir(), "graph-visibility-test-"));
let dbCounter = 0;
let db: Database;

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  db = await initDb(join(root, `g${dbCounter++}.db`));
});

const NOW = Math.floor(Date.now() / 1000);
const ATTACKER: GraphScope = resolveScope("alaric"); // personas: alaric, shared

function insertFact(
  id: string,
  persona: string,
  opts: { expiresAt?: number | null; forgotten?: boolean } = {},
): void {
  db.prepare(
    `INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                        importance, source, created_at, expires_at, last_accessed, confidence)
     VALUES (?, ?, ?, NULL, ?, ?, 'fact', 'stable', 1.0, 'test', ?, ?, ?, 1.0)`
  ).run(id, persona, `e.${id}`, `value ${id}`, `e.${id} value ${id}`, NOW * 1000, opts.expiresAt ?? null, NOW);
  if (opts.forgotten) {
    db.prepare("INSERT INTO fact_forgotten (fact_id, forgotten_by, reason) VALUES (?, 'test', 'test')").run(id);
  }
}

/** Insert a link; FKs are switched off so dangling (pre-wipe style) rows can exist, as in the live store. */
function insertLink(source: string, target: string, weight = 1.0, relation = "related"): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)")
    .run(source, target, relation, weight);
  db.exec("PRAGMA foreign_keys = ON");
}

function results(ids: string[]) {
  // Distinct RRF scores so rank is meaningful; identical freshness/confidence.
  return ids.map((id, i) => ({ id, rrfScore: 0.03 - i * 0.001, freshness: 1, confidence: 1, sources: ["fts"] }));
}

type Scored = { id: string; composite: number; graphBoost: number };
function snapshot(rs: Scored[]) {
  const ranked = [...rs].sort((a, b) => b.composite - a.composite || a.id.localeCompare(b.id));
  return ranked.map((r, rank) => ({ id: r.id, rank, composite: r.composite, graphBoost: r.graphBoost }));
}

function expectSameRanking(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
  a.forEach((r, i) => {
    expect(r.composite).toBeCloseTo(b[i].composite, 12);
    expect(r.graphBoost).toBeCloseTo(b[i].graphBoost, 12);
  });
}

/** The pre-fix scoring math, applied to an explicit link list (reference for the control case). */
function legacyBoost(rs: ReturnType<typeof results>, links: Array<{ s: string; t: string; w: number }>) {
  const ids = new Set(rs.map(r => r.id));
  const touching = links.filter(l => ids.has(l.s) || ids.has(l.t));
  if (touching.length === 0) {
    return rs.map(r => ({ id: r.id, graphBoost: 0, composite: r.rrfScore * 0.7 + r.freshness * 0.2 + r.confidence * 0.1 }));
  }
  const m = new Map<string, number>();
  for (const { s, t, w } of touching) {
    if (ids.has(s) && ids.has(t)) { m.set(t, (m.get(t) || 0) + w); m.set(s, (m.get(s) || 0) + w * 0.5); }
    else if (ids.has(s)) m.set(s, (m.get(s) || 0) + w * 0.3);
    else m.set(t, (m.get(t) || 0) + w * 0.3);
  }
  const max = Math.max(...m.values(), 1);
  return rs.map(r => {
    const g = Math.min((m.get(r.id) || 0) / max, 1);
    return { id: r.id, graphBoost: g, composite: r.rrfScore * 0.7 + g * 0.05 + r.freshness * 0.15 + r.confidence * 0.1 };
  });
}

/** Seed: three visible shared facts in the result set, one visible shared fact outside it, and hidden facts. */
function seedBank() {
  insertFact("A", "shared");
  insertFact("B", "shared");
  insertFact("C", "alaric");
  insertFact("D", "shared");                                  // visible, not in results
  insertFact("X", "financial-advisor");                       // out of scope for alaric
  insertFact("F", "shared", { forgotten: true });             // forgotten
  insertFact("E", "shared", { expiresAt: NOW - 3600 });       // expired
  // "GHOST" is never inserted: links to it are dangling.
}

const HIDDEN_CASES: Array<[string, () => void]> = [
  ["out-of-scope (visible -> other persona)", () => insertLink("A", "X", 1.0)],
  ["out-of-scope (other persona -> visible)", () => insertLink("X", "B", 0.9)],
  ["forgotten", () => insertLink("A", "F", 1.0)],
  ["dangling target", () => insertLink("A", "GHOST", 1.0)],
  ["dangling source", () => insertLink("GHOST", "C", 0.7)],
  ["expired", () => insertLink("B", "E", 1.0)],
  ["many hidden links (count oracle)", () => {
    for (let i = 0; i < 25; i++) insertLink("A", `GHOST-${i}`, 1.0);
    insertLink("A", "X", 1.0); insertLink("A", "F", 1.0);
  }],
];

describe("computeGraphBoost scope invariant (SEC-graph-visibility)", () => {
  for (const [name, addHidden] of HIDDEN_CASES) {
    test(`${name}: link never changes score or rank — no visible links present`, () => {
      seedBank();
      const rs = results(["A", "B", "C"]);
      const before = snapshot(computeGraphBoost(db, rs, ATTACKER));
      addHidden();
      const after = snapshot(computeGraphBoost(db, rs, ATTACKER));
      expect(after).toEqual(before);
      expect(after.every(r => r.graphBoost === 0)).toBe(true);
    });

    test(`${name}: link never changes score or rank — alongside visible links`, () => {
      seedBank();
      insertLink("B", "C", 0.6); // visible, both in results
      insertLink("C", "D", 0.4); // visible, one end outside results
      const rs = results(["A", "B", "C"]);
      const before = snapshot(computeGraphBoost(db, rs, ATTACKER));
      addHidden();
      const after = snapshot(computeGraphBoost(db, rs, ATTACKER));
      expect(after).toEqual(before);
    });
  }

  test("control: visible links still boost exactly as before the fix", () => {
    seedBank();
    insertLink("A", "B", 1.0); // both in results
    insertLink("C", "D", 0.8); // one end visible outside results (0.3 x weight, unchanged)
    const rs = results(["A", "B", "C"]);
    const got = computeGraphBoost(db, rs, ATTACKER);
    const ref = legacyBoost(rs, [{ s: "A", t: "B", w: 1.0 }, { s: "C", t: "D", w: 0.8 }]);
    expectSameRanking(snapshot(got), snapshot(ref));
    expect(got.find(r => r.id === "A")!.graphBoost).toBeGreaterThan(0);
    expect(got.find(r => r.id === "B")!.graphBoost).toBeGreaterThan(0);
    expect(got.find(r => r.id === "C")!.graphBoost).toBeGreaterThan(0);
  });

  test("sensitivity: the pre-fix math would have leaked on the same data", () => {
    // Guards against a vacuous test: the hidden link DOES move the legacy score.
    seedBank();
    const rs = results(["A", "B", "C"]);
    const clean = legacyBoost(rs, []);
    const leaky = legacyBoost(rs, [{ s: "A", t: "X", w: 1.0 }]);
    expect(snapshot(leaky)).not.toEqual(snapshot(clean));
  });

  test("the same link is visible to its owner (scope, not deletion, decides)", () => {
    seedBank();
    insertLink("A", "X", 1.0);
    const rs = results(["A", "B", "C"]);
    const owner = computeGraphBoost(db, rs, resolveScope("financial-advisor"));
    expect(owner.find(r => r.id === "A")!.graphBoost).toBeGreaterThan(0);
    const attacker = computeGraphBoost(db, rs, ATTACKER);
    expect(attacker.find(r => r.id === "A")!.graphBoost).toBe(0);
  });

  test("a scope is required (no silent unscoped fallback)", () => {
    seedBank();
    expect(() => computeGraphBoost(db, results(["A"]), undefined as never)).toThrow();
    expect(() => computeGraphBoost(db, results(["A"]), { personas: [] })).toThrow();
  });

  test("randomized property: removing every hidden-endpoint link changes nothing", () => {
    // Seeded PRNG (mulberry32) so failures reproduce.
    let seed = 0x5ec9a7;
    const rnd = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const personas = ["shared", "alaric", "financial-advisor", "codex"];
    db.exec("PRAGMA synchronous = OFF"); // scratch DB only: speed
    for (let trial = 0; trial < 60; trial++) {
      db.exec("DELETE FROM fact_links; DELETE FROM fact_forgotten; DELETE FROM facts;");
      const visible = new Set<string>();
      const all: string[] = [];
      for (let i = 0; i < 14; i++) {
        const id = `t${trial}-f${i}`;
        const persona = personas[Math.floor(rnd() * personas.length)];
        const forgotten = rnd() < 0.15;
        const expired = rnd() < 0.1;
        insertFact(id, persona, { forgotten, expiresAt: expired ? NOW - 60 : (rnd() < 0.5 ? null : NOW + 86400 * 90) });
        all.push(id);
        if (ATTACKER.personas.includes(persona) && !forgotten && !expired) visible.add(id);
      }
      for (let i = 0; i < 3; i++) all.push(`t${trial}-ghost${i}`); // dangling ids
      const links: Array<{ s: string; t: string; w: number }> = [];
      for (let i = 0; i < 30; i++) {
        const s = all[Math.floor(rnd() * all.length)];
        const t = all[Math.floor(rnd() * all.length)];
        if (s === t) continue;
        const w = Math.round((0.1 + rnd()) * 100) / 100;
        insertLink(s, t, w);
        if (!links.some(l => l.s === s && l.t === t)) links.push({ s, t, w });
      }
      const vis = [...visible];
      if (vis.length === 0) continue;
      const rs = results(vis.filter(() => rnd() < 0.6).slice(0, 6));
      if (rs.length === 0) continue;

      const withHidden = snapshot(computeGraphBoost(db, rs, ATTACKER));
      const visibleLinks = links.filter(l => visible.has(l.s) && visible.has(l.t));
      // Drop every link with a hidden endpoint, then recompute.
      db.exec("DELETE FROM fact_links");
      for (const l of visibleLinks) insertLink(l.s, l.t, l.w);
      const withoutHidden = snapshot(computeGraphBoost(db, rs, ATTACKER));

      expect(withHidden).toEqual(withoutHidden);
      // And the visible-only behaviour equals the pre-fix math on visible links
      // (same ranks; scores equal up to float summation order).
      expectSameRanking(withoutHidden, snapshot(legacyBoost(rs, visibleLinks)));
    }
  }, 120_000);
});

describe("end-to-end: printed scores carry no hidden-link signal", () => {
  async function seed(actor: string, entity: string, value: string) {
    const e = await storeWithEmbedding({
      entity, key: null, value, text: `${entity} : ${value}`, category: "fact",
      decayClass: "stable", importance: 1.0, source: "test", confidence: 1.0,
    }, { actor, skipWikilinkEnforcement: true });
    if (!e) throw new Error("seed failed");
    return e;
  }

  test("hybridSearch (CLI path): a link to another persona's fact does not move the visible fact's score", async () => {
    const shared = await seed("shared", "market-report", "weekly market report covers tech sector");
    await seed("shared", "market-calendar", "weekly market calendar lists earnings dates");
    const victim = await seed("financial-advisor", "acme-portfolio", "holds 40% NVDA confidential allocation");

    const run = async (actor: string) =>
      (await hybridSearch("weekly market report", { actor, useHyde: false, limit: 10 }))
        .map(r => ({ id: r.entry.id, score: r.score }));

    const attackerBefore = await run("alaric");
    const ownerBefore = await run("financial-advisor");
    insertLink(shared.id, victim.id, 1.0);
    for (let i = 0; i < 10; i++) insertLink(shared.id, `ghost-${i}`, 1.0); // dangling, pre-wipe style
    const attackerAfter = await run("alaric");
    const ownerAfter = await run("financial-advisor");

    expect(attackerAfter).toEqual(attackerBefore);
    expect(attackerAfter.some(r => r.id === victim.id)).toBe(false);
    // Control: the owner can see both ends, so the link legitimately changes their ranking.
    expect(ownerAfter).not.toEqual(ownerBefore);
  });

  // Child processes: mcp-server binds its DB path at import, and graph-boost
  // caches vault_links existence per process, so these checks must share
  // neither with the other test files nor with each other.
  function runProbe(mode: "mcp" | "vault") {
    const probe = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "graph-visibility-probe.ts"), mode, join(root, `probe-${mode}`)],
      env: { ...process.env, ZO_MODEL_EMBEDDING: "deterministic:hash-v1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = probe.stdout.toString();
    if (probe.exitCode !== 0) throw new Error(`probe failed: ${probe.stderr.toString()}\n${out}`);
    return JSON.parse(out.trim().split("\n").pop()!);
  }

  test("memory_search (MCP path): printed output for the attacker is byte-identical", () => {
    const r = { mcp: runProbe("mcp") };
    expect(r.mcp.attackerBefore).toContain("weekly market report");
    expect(r.mcp.attackerAfter).toBe(r.mcp.attackerBefore);
    expect(r.mcp.attackerAfter).not.toContain("confidential");
    expect(r.mcp.ownerAfter).not.toBe(r.mcp.ownerBefore); // control: owner sees both ends
  });

  test("vault_links: hidden fact endpoints never boost; a visible vault-file endpoint still does", () => {
    const r = { vault: runProbe("vault") };
    // vault_links: a hidden fact endpoint never boosts; a vault-file endpoint (visible) still does.
    expect(r.vault.hiddenOnly).toEqual(r.vault.baseline);
    expect(r.vault.withVaultFileGraphBoost).toBeGreaterThan(0);
    expect(r.vault.withVaultFileAndHidden).toEqual(r.vault.withVaultFile);
  });
});
