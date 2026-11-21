import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { formatFusedResult, fuseFtsAndGraph, graphGateMode, retrieveGraphCandidates, type FtsCandidate } from "./graph-gate";

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE facts (id TEXT PRIMARY KEY, entity TEXT, key TEXT, value TEXT, text TEXT,
      decay_class TEXT DEFAULT 'stable', category TEXT DEFAULT 'fact', source TEXT, confidence REAL,
      gate_status TEXT DEFAULT 'allow', expires_at INTEGER);
    CREATE TABLE fact_links (source_id TEXT, target_id TEXT, relation TEXT, weight REAL);
    CREATE VIRTUAL TABLE facts_fts USING fts5(text, entity, key, value, category, content='facts', content_rowid='rowid');
  `);
  const put = db.prepare(
    "INSERT INTO facts (id, entity, key, value, source, confidence, gate_status, expires_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  // Anchor: its entity names the query term, its value does not.
  put.run("anchor", "project.hipporag", "port", "listens on 11235", "manual", 1, "allow", null);
  // Linked facts with no query term in their text.
  put.run("wikilinked", "service.bridge", "backend", "sqlite mcp service", "manual", 1, "allow", null);
  put.run("weak", "misc.note", "x", "unrelated chatter", "manual", 1, "allow", null);
  // Neighbors that must never be injected.
  put.run("held", "project.hipporag", "held", "held hipporag row", "manual", 1, "hold", null);
  put.run("expired", "project.hipporag", "old", "expired hipporag row", "manual", 1, "allow", 1);
  put.run("lowconf", "project.hipporag", "draft", "auto hipporag draft", "auto:test", 0.1, "allow", null);
  put.run("stale", "project.hipporag", "v1", "stale hipporag port", "manual", 1, "allow", null);
  put.run("newer", "project.hipporag", "v2", "hipporag port moved", "manual", 1, "allow", null);
  // Quarantined anchor must not act as a seed either.
  put.run("badseed", "project.poisoned", "k", "poisoned", "auto:test", 0.1, "allow", null);
  put.run("behindbad", "secret.thing", "k", "only reachable via poisoned", "manual", 1, "allow", null);
  // Pure FTS hit (value matches, entity does not).
  put.run("ftshit", "notes.misc", "k", "hipporag benchmark results", "manual", 1, "allow", null);
  db.exec("UPDATE facts SET text = value; INSERT INTO facts_fts(facts_fts) VALUES('rebuild')");
  const edge = db.prepare("INSERT INTO fact_links VALUES (?,?,?,?)");
  edge.run("anchor", "wikilinked", "wikilink", 1);
  edge.run("anchor", "weak", "co-reference", 0.5);
  for (const id of ["held", "expired", "lowconf", "stale"]) edge.run("anchor", id, "related", 1);
  edge.run("newer", "stale", "supersedes", 1);
  edge.run("badseed", "behindbad", "wikilink", 1);
  return db;
}

const base = { seedIds: [] as string[], limit: 10, confidenceFloor: 0.35 };

afterEach(() => {
  delete process.env.ZO_GATE_GRAPH;
});

test("anchors on entity names and surfaces linked facts FTS cannot match", () => {
  const db = fixture();
  const r = retrieveGraphCandidates(db, { ...base, query: "hipporag" });
  const ids = r.candidates.map((c) => c.id);
  expect(ids).toContain("anchor");
  expect(ids).toContain("wikilinked");
  const linked = r.candidates.find((c) => c.id === "wikilinked")!;
  expect(linked.via).toEqual({ relation: "wikilink", weight: 1, from: "project.hipporag.port" });
  db.close();
});

test("excludes held, expired, low-confidence auto-captured and superseded nodes", () => {
  const db = fixture();
  const ids = retrieveGraphCandidates(db, { ...base, query: "hipporag" }).candidates.map((c) => c.id);
  for (const id of ["held", "expired", "lowconf", "stale"]) expect(ids).not.toContain(id);
  db.close();
});

test("does not inject off-topic neighbors over weak links", () => {
  const db = fixture();
  const ids = retrieveGraphCandidates(db, { ...base, query: "hipporag" }).candidates.map((c) => c.id);
  expect(ids).not.toContain("weak");
  db.close();
});

test("a quarantined fact is neither injected nor used as a seed", () => {
  const db = fixture();
  const byAnchor = retrieveGraphCandidates(db, { ...base, query: "poisoned" }).candidates.map((c) => c.id);
  const bySeed = retrieveGraphCandidates(db, { ...base, query: "zzz", seedIds: ["badseed"] }).candidates.map((c) => c.id);
  for (const ids of [byAnchor, bySeed]) {
    expect(ids).not.toContain("badseed");
    expect(ids).not.toContain("behindbad");
  }
  db.close();
});

test("expands from FTS seeds even without an entity anchor", () => {
  const db = fixture();
  const r = retrieveGraphCandidates(db, { ...base, query: "nomatchterm", seedIds: ["anchor"] });
  expect(r.anchors).toBe(0);
  expect(r.candidates.map((c) => c.id)).toContain("wikilinked");
  db.close();
});

test("works on legacy backends without expires_at / gate_status columns", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE facts (id TEXT PRIMARY KEY, entity TEXT, key TEXT, value TEXT, text TEXT,
      decay_class TEXT, category TEXT, source TEXT, confidence REAL);
    CREATE TABLE fact_links (source_id TEXT, target_id TEXT, relation TEXT, weight REAL);
    CREATE VIRTUAL TABLE facts_fts USING fts5(text, entity, key, value, category, content='facts', content_rowid='rowid');
    INSERT INTO facts VALUES ('a','project.hipporag','port','11235','11235','stable','fact','manual',1),
      ('b','service.bridge','backend','sqlite','sqlite','stable','fact','manual',1),
      ('c','project.hipporag','v1','old port','old port','stable','fact','manual',1);
    INSERT INTO facts_fts(facts_fts) VALUES('rebuild');
    INSERT INTO fact_links VALUES ('a','b','wikilink',1), ('a','c','supersedes',1);
  `);
  const ids = retrieveGraphCandidates(db, { ...base, query: "hipporag" }).candidates.map((c) => c.id);
  expect(ids).toContain("a");
  expect(ids).toContain("b");
  expect(ids).not.toContain("c");
  db.close();
});

test("empty query and no seeds yields nothing", () => {
  const db = fixture();
  expect(retrieveGraphCandidates(db, { ...base, query: "the and" }).candidates).toEqual([]);
  db.close();
});

function ftsCandidate(id: string, entity: string, _rank: number, superseded = false): FtsCandidate {
  return {
    id, entity, key: "k", value: `${id} value`, decay_class: "stable", source: "manual",
    confidence: 1, retrieval_score: 1, superseded,
  };
}

test("RRF fusion ranks dual-arm hits first and interleaves both arms", () => {
  const db = fixture();
  const graph = retrieveGraphCandidates(db, { ...base, query: "hipporag" }).candidates;
  const fts = [ftsCandidate("ftshit", "notes.misc", 1), ftsCandidate("anchor", "project.hipporag", 2), ftsCandidate("f3", "x", 3)];
  const fused = fuseFtsAndGraph(fts, graph, 5);
  expect(fused[0].id).toBe("anchor");
  expect(fused[0].fts && fused[0].graph).toBeTruthy();
  expect(fused.map((c) => c.id)).toContain("wikilinked");
  expect(fused.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
  const out = formatFusedResult(fused);
  expect(out).toContain("[stable|curated|fts+graph conf=1.00] project.hipporag.k");
  expect(out).toContain("via wikilink w=1.00 ← project.hipporag.port");
  expect(out).toMatch(/^\[BEGIN RETRIEVED MEMORY/);
  expect(out).toMatch(/\[END RETRIEVED MEMORY\]$/);
  db.close();
});

test("superseded FTS rows keep their tag and sort after live rows", () => {
  const fused = fuseFtsAndGraph([ftsCandidate("old", "a", 1, true), ftsCandidate("live", "b", 2)], [], 5);
  expect(fused.map((c) => c.id)).toEqual(["live", "old"]);
  expect(formatFusedResult(fused)).toContain("⚠superseded");
});

test("ZO_GATE_GRAPH selects the mode, defaulting to primary", () => {
  expect(graphGateMode()).toBe("primary");
  process.env.ZO_GATE_GRAPH = "fallback";
  expect(graphGateMode()).toBe("fallback");
  process.env.ZO_GATE_GRAPH = "OFF";
  expect(graphGateMode()).toBe("off");
  process.env.ZO_GATE_GRAPH = "always";
  expect(graphGateMode()).toBe("primary");
});
