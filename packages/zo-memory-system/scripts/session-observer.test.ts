/**
 * session-observer.test.ts — tests for the plane-native observation layer.
 *
 * Ported from the monorepo's packages/memory/src/__tests__/session-observer.test.ts
 * (plane-observation-layer branch), adapted to the vendored zo-memory-system
 * layout and conventions:
 *  - explicit `db` first parameter (no module singleton)
 *  - initDb() per-test scratch DBs in a temp dir (scope-leak.test.ts pattern)
 *  - storeWithEmbedding / createEpisodeRecord / forgetFact target signatures
 *  - no _migrations framework here: the "migration 103" coverage becomes
 *    idempotent-schema-upgrade tests instead
 *  - the MCP JSON-RPC harness (handleMessage/callTool) does not exist in this
 *    package; the memory_session_observations tool is tested via its exported
 *    implementation + the exported TOOLS surface, with the MCP server module
 *    dynamically imported after ZO_MEMORY_DB is pointed at scratch
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initDb, closeDb, storeWithEmbedding } from "./memory";
import { createEpisodeRecord } from "./continuation";
import { forgetFact } from "./forgetting";
import { MissingActorError } from "./scope";
import { ensureObservationSchema } from "./observations";
import {
  observeSessions,
  fadeOrphanedSessionObservations,
  deriveDecayClass,
  searchSessionObservations,
  retrieveSessionObservations,
  OBSERVE_MIN_CHARS,
} from "./session-observer";

// Deterministic embeddings: no network, no keys, stable across machines.
process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";

const root = mkdtempSync(join(tmpdir(), "session-observer-test-"));
// The MCP server module reads ZO_MEMORY_DB at load; point it at a scratch DB
// BEFORE its first (dynamic) import so no test ever touches a real database.
process.env.ZO_MEMORY_DB = join(root, "mcp-scratch.db");

let db: Database;
let dbCounter = 0;

beforeEach(async () => {
  db = await initDb(join(root, `t${dbCounter++}.db`));
});

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const LONG_VALUE = (s: string) =>
  `${s} — additional context to push the session over the minimum character threshold for observation. `.repeat(4);

async function seedEpisodeWithFacts(
  actor: string,
  summary: string,
  entities: string[],
  nFacts = 3,
  decay: "permanent" | "stable" | "active" | "session" | "checkpoint" = "stable"
) {
  const epId = createEpisodeRecord(db, {
    summary,
    outcome: "success",
    happenedAt: Math.floor(Date.now() / 1000),
    entities,
  });
  const factIds: string[] = [];
  for (let i = 0; i < nFacts; i++) {
    const f = await storeWithEmbedding(
      {
        entity: entities[i % entities.length],
        key: `k${i}`,
        value: LONG_VALUE(`${actor} fact ${i} about ${entities[i % entities.length]}`),
        text: `${entities[i % entities.length]} : ${actor} fact ${i}`,
        category: "fact",
        decayClass: decay,
        importance: 1.0,
        source: "test",
        confidence: 1.0,
      },
      { actor, skipWikilinkEnforcement: true }
    );
    factIds.push(f!.id);
  }
  return { epId, factIds };
}

describe("observeSessions — fail-closed scoping", () => {
  test("throws MissingActorError on missing actor", async () => {
    await expect(observeSessions(db, { actor: "" })).rejects.toThrow(MissingActorError);
    // @ts-expect-error testing runtime guard
    await expect(observeSessions(db, {})).rejects.toThrow(MissingActorError);
  });

  test("observer sees only the invoking actor facts (strictly per-actor v1)", async () => {
    const { epId } = await seedEpisodeWithFacts("alice", "alice work session", ["proj.alpha"]);
    // bob's facts on the SAME entities must not leak into alice's observation
    await storeWithEmbedding(
      {
        entity: "proj.alpha",
        key: "secret",
        value: LONG_VALUE("bob secret plan"),
        text: "proj.alpha : bob secret plan",
        category: "fact",
        decayClass: "stable",
        importance: 1.0,
        source: "test",
        confidence: 1.0,
      },
      { actor: "bob", skipWikilinkEnforcement: true }
    );

    const r = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r.observed).toBe(1);

    const obs = db
      .query(`SELECT * FROM observations WHERE entity = ?`)
      .get(`session:${epId}`) as any;
    expect(obs.persona).toBe("alice");
    expect(obs.kind).toBe("session");
    expect(obs.text).not.toContain("bob secret plan");

    const evidence = db
      .query(`SELECT fact_id FROM observation_evidence WHERE observation_id = ?`)
      .all(obs.id) as Array<{ fact_id: string }>;
    expect(evidence.length).toBeGreaterThan(0);
    const factPersonas = db.query(
      `SELECT DISTINCT persona as p FROM facts WHERE id IN (${evidence.map(() => "?").join(",")})`
    ).all(...evidence.map((e) => e.fact_id)) as Array<{ p: string }>;
    expect(factPersonas.map((f) => f.p)).toEqual(["alice"]);
  });
});

describe("observeSessions — provenance and lifecycle", () => {
  test("evidence rows link observation to fact ids with exact quotes", async () => {
    const { epId, factIds } = await seedEpisodeWithFacts("alice", "provenance session", [
      "proj.beta",
    ]);
    const r = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r.observed).toBe(1);

    const obs = db
      .query(`SELECT id FROM observations WHERE entity = ?`)
      .get(`session:${epId}`) as { id: string };
    const evidence = db
      .query(`SELECT fact_id, quote FROM observation_evidence WHERE observation_id = ?`)
      .all(obs.id) as Array<{ fact_id: string; quote: string }>;
    expect(new Set(evidence.map((e) => e.fact_id))).toEqual(new Set(factIds));
    for (const e of evidence) {
      const fact = db.query(`SELECT value FROM facts WHERE id = ?`).get(e.fact_id) as {
        value: string;
      };
      expect(e.quote).toBe(fact.value);
    }
  });

  test("re-running with no new facts skips (idempotent)", async () => {
    await seedEpisodeWithFacts("alice", "idempotent session", ["proj.gamma"]);
    const r1 = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r1.observed).toBe(1);
    const r2 = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r2.observed).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);
  });

  test("sessions below the char floor are skipped", async () => {
    createEpisodeRecord(db, {
      summary: "tiny session",
      outcome: "success",
      happenedAt: Math.floor(Date.now() / 1000),
      entities: ["proj.tiny"],
    });
    await storeWithEmbedding(
      {
        entity: "proj.tiny",
        key: null,
        value: "short",
        text: "proj.tiny : short",
        category: "fact",
        decayClass: "stable",
        importance: 1.0,
        source: "test",
        confidence: 1.0,
      },
      { actor: "alice", skipWikilinkEnforcement: true }
    );
    const r = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r.observed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(OBSERVE_MIN_CHARS).toBe(500);
  });

  test("audit rows carry observation_id on create", async () => {
    const { epId } = await seedEpisodeWithFacts("alice", "audited session", ["proj.delta"]);
    await observeSessions(db, { actor: "alice", deterministicOnly: true });
    const obs = db
      .query(`SELECT id FROM observations WHERE entity = ?`)
      .get(`session:${epId}`) as { id: string };
    // Single-predicate forensic query (SME Q2 rationale)
    const rows = db
      .query(`SELECT action, observation_id FROM memory_audit WHERE observation_id = ?`)
      .all(obs.id) as Array<{ action: string; observation_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].action).toBe("observe");
  });

  test("fadeOrphanedSessionObservations fades when all evidence is forgotten", async () => {
    const { epId, factIds } = await seedEpisodeWithFacts("alice", "fading session", [
      "proj.epsilon",
    ]);
    await observeSessions(db, { actor: "alice", deterministicOnly: true });
    for (const fid of factIds) forgetFact(db, fid, { actor: "alice", reason: "test" });
    const { faded } = fadeOrphanedSessionObservations(db, "alice");
    expect(faded).toBe(1);
    const obs = db
      .query(`SELECT status FROM observations WHERE entity = ?`)
      .get(`session:${epId}`) as { status: string };
    expect(obs.status).toBe("faded");
  });
});

describe("deriveDecayClass", () => {
  const mk = (decay_class: "permanent" | "stable" | "active" | "session" | "checkpoint") =>
    ({ id: "x", entity: "e", key: null, value: "v", decay_class, created_at: 1 }) as const;
  test("takes max liveness: any permanent fact → permanent", () => {
    expect(deriveDecayClass([mk("session"), mk("permanent"), mk("stable")])).toBe("permanent");
  });
  test("session-scoped evidence → session", () => {
    expect(deriveDecayClass([mk("session"), mk("checkpoint")])).toBe("session");
  });
  test("all checkpoint → checkpoint", () => {
    expect(deriveDecayClass([mk("checkpoint")])).toBe("checkpoint");
  });
  test("stable default when mixed stable/active", () => {
    expect(deriveDecayClass([mk("active"), mk("stable")])).toBe("stable");
  });
});

describe("observeSessions — deterministic fallback", () => {
  test("deterministicOnly produces the extractive digest floor", async () => {
    const { epId } = await seedEpisodeWithFacts("alice", "floor session", ["proj.zeta"]);
    const r = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r.observed).toBe(1);
    expect(r.llmCalls).toBe(0);
    const obs = db
      .query(`SELECT text FROM observations WHERE entity = ?`)
      .get(`session:${epId}`) as { text: string };
    expect(obs.text.startsWith("Session ")).toBe(true);
    expect(obs.text).toContain("floor session");
  });

  test("LLM failure falls back to the digest (Art. IX)", async () => {
    // No API key in env for this test → mcGenerate throws → fallback
    const savedKey = process.env.OPENAI_API_KEY;
    const savedZoKey = process.env.ZO_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ZO_OPENAI_API_KEY;
    try {
      await seedEpisodeWithFacts("alice", "fallback session", ["proj.eta"]);
      const r = await observeSessions(db, { actor: "alice" });
      expect(r.observed).toBe(1);
      expect(r.llmCalls).toBe(0); // polish failed → digest kept, not counted
      expect(r.errors).toHaveLength(0);
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
      if (savedZoKey !== undefined) process.env.ZO_OPENAI_API_KEY = savedZoKey;
    }
  });
});

describe("observation schema — idempotent upgrade (migration-103 equivalent)", () => {
  test("ensureObservationSchema is idempotent and columns are present", () => {
    ensureObservationSchema(db);
    ensureObservationSchema(db);
    const cols = db.query(`PRAGMA table_info(observations)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("kind")).toBe(true);
    expect(names.has("decay_class")).toBe(true);
    expect(names.has("observed_at")).toBe(true);
    const idx = db
      .query(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_kind'`)
      .get();
    expect(idx).toBeTruthy();
    const auditCols = db.query(`PRAGMA table_info(memory_audit)`).all() as Array<{
      name: string;
    }>;
    expect(new Set(auditCols.map((c) => c.name)).has("observation_id")).toBe(true);
  });

  test("pre-existing observations table without new columns gets upgraded", async () => {
    const legacyPath = join(root, `legacy-${dbCounter++}.db`);
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE observations (
        id TEXT PRIMARY KEY, persona TEXT NOT NULL DEFAULT 'shared',
        entity TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
        proof_count INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER, updated_at INTEGER, last_evidence_at INTEGER,
        UNIQUE(persona, entity, key)
      );
      CREATE TABLE memory_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL,
        scope TEXT NOT NULL, action TEXT NOT NULL, fact_id TEXT, call_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    legacy.exec(
      `INSERT INTO observations (id, persona, entity, text) VALUES ('leg-1','alice','proj','legacy text')`
    );
    ensureObservationSchema(legacy);
    // memory_audit upgrade rides on ensureIntelligencePlaneSchema (recordAudit path);
    // exercise it directly here.
    const { ensureIntelligencePlaneSchema } = await import("./scope");
    ensureIntelligencePlaneSchema(legacy);

    const cols = legacy.query(`PRAGMA table_info(observations)`).all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("kind")).toBe(true);
    expect(names.has("decay_class")).toBe(true);
    expect(names.has("observed_at")).toBe(true);
    const row = legacy
      .query(`SELECT kind, decay_class, observed_at FROM observations WHERE id = 'leg-1'`)
      .get() as any;
    expect(row.kind).toBe("entity"); // default, existing rows untouched
    expect(row.decay_class).toBe("stable");
    const auditCols = legacy.query(`PRAGMA table_info(memory_audit)`).all() as Array<{
      name: string;
    }>;
    expect(new Set(auditCols.map((c) => c.name)).has("observation_id")).toBe(true);
    legacy.close();
  });

  test("new session observations carry kind/decay/observed_at", async () => {
    await seedEpisodeWithFacts("alice", "default session", ["proj.theta"]);
    const r = await observeSessions(db, { actor: "alice", deterministicOnly: true });
    expect(r.observed).toBe(1);
    const obs = db
      .query(`SELECT kind, decay_class, observed_at FROM observations WHERE persona = 'alice'`)
      .get() as any;
    expect(obs.kind).toBe("session");
    expect(obs.decay_class).toBe("stable"); // all supporting facts seeded stable
    expect(typeof obs.observed_at).toBe("number");
  });
});

describe("searchSessionObservations / retrieveSessionObservations", () => {
  test("returns bounded session-kind hits for the actor only", async () => {
    await seedEpisodeWithFacts("alice", "searchable session about databases", ["proj.iota"]);
    await observeSessions(db, { actor: "alice", deterministicOnly: true });
    const hits = searchSessionObservations(db, "databases", { actor: "alice", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0].decayClass).toBe("stable");
    const bobHits = searchSessionObservations(db, "databases", { actor: "bob", limit: 5 });
    expect(bobHits).toHaveLength(0);
  });

  test("retrieve fuses bounded hits with positive scores", async () => {
    await seedEpisodeWithFacts("alice", "retrievable session about caching", ["proj.kappa"]);
    await observeSessions(db, { actor: "alice", deterministicOnly: true });
    const hits = retrieveSessionObservations(db, "caching", { actor: "alice", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0].score).toBeGreaterThan(0);
  });
});

describe("memory_session_observations MCP tool (plane-native observation layer)", () => {
  async function seedSessionObs() {
    // Seed through the MCP server's own DB handle: its singleton is bound at
    // first import in this process (whichever test file imports the server
    // first wins), so seeding anywhere else would miss the tool's reads.
    const { getDb } = await import("./mcp-server");
    const mcpDb = getDb();
    mcpDb.exec(`DELETE FROM observations`);
    const ins = mcpDb.prepare(
      `INSERT INTO observations (id, persona, entity, key, text, kind, observed_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    ins.run("t-alice-1", "alice", "proj", "k1", "Alice chose Postgres", "session", 1000);
    ins.run("t-alice-2", "alice", "proj", "k2", "Alice likes morning standups", "session", 1001);
    ins.run("t-bob-1", "bob", "proj", "k1", "Bob chose Redis", "session", 1002);
    ins.run("t-alice-ent", "alice", "proj", "k3", "entity-kind, excluded", "entity", 1003);
  }

  test("TOOLS surface exposes memory_session_observations", async () => {
    const { TOOLS } = await import("./mcp-server");
    const names = (TOOLS as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("memory_session_observations");
  });

  test("search is strictly per-actor and session-kind only", async () => {
    await seedSessionObs();
    const { toolMemorySessionObservations } = await import("./mcp-server");
    const out = await toolMemorySessionObservations({
      action: "search",
      actor: "alice",
      query: "Alice",
    });
    expect(out).toContain("t-alice-1");
    expect(out).toContain("t-alice-2");
    expect(out).not.toContain("t-bob-1");
    expect(out).not.toContain("t-alice-ent");
  });

  test("retrieve returns RRF-fused bounded hits for the actor", async () => {
    await seedSessionObs();
    const { toolMemorySessionObservations } = await import("./mcp-server");
    const out = await toolMemorySessionObservations({
      action: "retrieve",
      actor: "bob",
      query: "Redis",
      limit: 5,
    });
    expect(out).toContain("t-bob-1");
    expect(out).not.toContain("t-alice-1");
  });

  test("cross-actor content is invisible", async () => {
    await seedSessionObs();
    const { toolMemorySessionObservations } = await import("./mcp-server");
    const out = await toolMemorySessionObservations({
      action: "search",
      actor: "alice",
      query: "Redis",
    });
    expect(out).toBe("No session observations found.");
  });

  test("missing actor fails closed (MISSING_ACTOR)", async () => {
    const { toolMemorySessionObservations } = await import("./mcp-server");
    await expect(
      toolMemorySessionObservations({ action: "search", actor: "", query: "x" })
    ).rejects.toThrow(/actor is required/);
  });

  test("blank actor fails closed", async () => {
    const { toolMemorySessionObservations } = await import("./mcp-server");
    await expect(
      toolMemorySessionObservations({ action: "search", actor: "  ", query: "x" })
    ).rejects.toThrow(MissingActorError);
  });

  test("observer triggering is not exposed (no observe/fade action)", async () => {
    const { toolMemorySessionObservations } = await import("./mcp-server");
    await expect(
      toolMemorySessionObservations({ action: "observe", actor: "alice", query: "x" })
    ).rejects.toThrow("Unknown memory_session_observations action");
  });
});
