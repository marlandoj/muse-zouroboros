/**
 * Reversible forgetting (Track 1): forgotten facts vanish from every
 * retrieval path but stay in the database; restore brings them back; the
 * decay sweep honors the canonical vocabulary (permanent never decays);
 * hard deletion only happens via purge after the retention window.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, storeWithEmbedding, ftsSearch, hybridSearch, vectorSearch } from "./memory";
import {
  forgetFact,
  restoreFact,
  listForgottenFacts,
  purgeForgottenFacts,
  sweepDecay,
  scoreRetention,
} from "./forgetting";
import { MissingActorError } from "./scope";

process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";

const root = mkdtempSync(join(tmpdir(), "forgetting-test-"));
let dbCounter = 0;

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await initDb(join(root, `t${dbCounter++}.db`));
});

const ACTOR = "claude-code";

async function seedFact(value: string, decay: "permanent" | "stable" | "active" | "session" | "checkpoint" = "stable") {
  const entry = await storeWithEmbedding({
    entity: "probe",
    key: null,
    value,
    text: `probe : ${value}`,
    category: "fact",
    decayClass: decay,
    importance: 1.0,
    source: "test",
    confidence: 1.0,
  }, { actor: ACTOR, skipWikilinkEnforcement: true });
  if (!entry) throw new Error("seed failed");
  return entry;
}

describe("forget / restore", () => {
  test("a forgotten fact disappears from keyword, vector, and hybrid retrieval — and restore recovers it", async () => {
    const db = await initDb();
    const entry = await seedFact("the reactor manual lives in cabinet seven");

    expect((await ftsSearch("reactor manual cabinet", { actor: ACTOR })).length).toBe(1);

    expect(forgetFact(db, entry.id, { actor: ACTOR, reason: "stale" })).toBe(true);
    expect((await ftsSearch("reactor manual cabinet", { actor: ACTOR })).length).toBe(0);
    expect((await vectorSearch("reactor manual cabinet seven lives", { actor: ACTOR })).length).toBe(0);
    expect((await hybridSearch("reactor manual cabinet", { actor: ACTOR, useHyde: false })).length).toBe(0);

    // The row is still there (reversible, not deleted).
    const raw = db.prepare("SELECT COUNT(*) c FROM facts WHERE id = ?").get(entry.id) as { c: number };
    expect(raw.c).toBe(1);

    const forgotten = listForgottenFacts(db, { actor: ACTOR });
    expect(forgotten.map((f) => f.factId)).toContain(entry.id);
    expect(forgotten[0].reason).toBe("stale");

    expect(restoreFact(db, entry.id, { actor: ACTOR })).toBe(true);
    expect((await ftsSearch("reactor manual cabinet", { actor: ACTOR })).length).toBe(1);
  });

  test("forgetting is scope-checked: another actor cannot forget or restore the fact", async () => {
    const db = await initDb();
    const entry = await seedFact("scoped forgetting probe");

    expect(forgetFact(db, entry.id, { actor: "codex" })).toBe(false);
    expect(forgetFact(db, entry.id, { actor: ACTOR })).toBe(true);
    expect(restoreFact(db, entry.id, { actor: "codex" })).toBe(false);
    expect(restoreFact(db, entry.id, { actor: ACTOR })).toBe(true);
  });

  test("fail-closed: forgetting APIs require an actor", async () => {
    const db = await initDb();
    const entry = await seedFact("actor requirement probe");
    expect(() => forgetFact(db, entry.id, { actor: undefined as never })).toThrow(MissingActorError);
    expect(() => sweepDecay(db, { actor: "" as never })).toThrow(MissingActorError);
    expect(() => purgeForgottenFacts(db, { actor: null as never })).toThrow(MissingActorError);
  });
});

describe("decay sweep on the canonical vocabulary", () => {
  test("permanent facts never decay; stale non-permanent facts are reversibly forgotten", async () => {
    const db = await initDb();
    const keeper = await seedFact("permanent decision: use Bun", "permanent");
    const scratch = await seedFact("checkpoint scratch note", "checkpoint");
    const fresh = await seedFact("active fact touched just now", "active");

    // Age the checkpoint fact far past its half-life (and its expiry).
    const past = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    db.prepare("UPDATE facts SET created_at = ?, last_accessed = ?, expires_at = ? WHERE id = ?")
      .run(past * 1000, past, past + 4 * 3600, scratch.id);

    const dry = sweepDecay(db, { actor: ACTOR, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.forgotten.map((f) => f.factId)).toContain(scratch.id);
    // Dry run changed nothing: no fact_forgotten rows yet.
    const dryCount = db.prepare("SELECT COUNT(*) c FROM fact_forgotten").get() as { c: number };
    expect(dryCount.c).toBe(0);

    const run = sweepDecay(db, { actor: ACTOR });
    expect(run.forgotten.map((f) => f.factId)).toContain(scratch.id);
    expect(run.forgotten.map((f) => f.factId)).not.toContain(keeper.id);
    expect(run.forgotten.map((f) => f.factId)).not.toContain(fresh.id);

    // Permanent is exempt by construction (never even examined for scoring).
    expect(scoreRetention({ decay: "permanent", importance: 0, createdAt: 0, lastAccessed: null }, Math.floor(Date.now() / 1000)).score).toBe(1);

    // Forgotten reversibly — the row is still there, and restore works.
    const raw = db.prepare("SELECT COUNT(*) c FROM facts WHERE id = ?").get(scratch.id) as { c: number };
    expect(raw.c).toBe(1);
    expect(restoreFact(db, scratch.id, { actor: ACTOR })).toBe(true);

    // Idempotent: a second sweep re-forgets the same stale fact, no more.
    const again = sweepDecay(db, { actor: ACTOR });
    expect(again.forgotten.map((f) => f.factId)).toEqual([scratch.id]);
  });

  test("purge hard-deletes only after the retention window", async () => {
    const db = await initDb();
    const entry = await seedFact("purge window probe");
    forgetFact(db, entry.id, { actor: ACTOR });

    // Inside the window: nothing purged.
    expect(purgeForgottenFacts(db, { actor: ACTOR, retentionDays: 30 })).toBe(0);

    // Age the forgotten marker past the window.
    db.prepare("UPDATE fact_forgotten SET forgotten_at = ? WHERE fact_id = ?")
      .run(Math.floor(Date.now() / 1000) - 31 * 24 * 3600, entry.id);
    // (changes may include FK-cascade rows depending on the sqlite build —
    // assert "something was purged" plus the row actually being gone.)
    expect(purgeForgottenFacts(db, { actor: ACTOR, retentionDays: 30 })).toBeGreaterThan(0);

    const raw = db.prepare("SELECT COUNT(*) c FROM facts WHERE id = ?").get(entry.id) as { c: number };
    expect(raw.c).toBe(0);
  });
});
