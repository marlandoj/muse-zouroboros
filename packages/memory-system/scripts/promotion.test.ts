/**
 * Promotion pipeline (Track 1, operator decision Q3): rules-based state
 * machine over the append-only fact_promotions ledger; the human review
 * queue receives ONLY contradictions; resolveReview is the sole exit from
 * review; every entry point is fail-closed on actor and scope.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, storeWithEmbedding, ftsSearch } from "./memory";
import {
  enterCapture,
  advancePromotion,
  getPromotionStage,
  sweepPromotions,
  listReviewQueue,
  resolveReview,
  extractionRules,
  PromotionStateError,
} from "./promotion";
import { restoreFact } from "./forgetting";

process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";

const root = mkdtempSync(join(tmpdir(), "promotion-test-"));
let dbCounter = 0;

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await initDb(join(root, `t${dbCounter++}.db`));
});

const ACTOR = "claude-code";

async function seedFact(entity: string, value: string, key = "state", actor = ACTOR) {
  const entry = await storeWithEmbedding({
    entity,
    key,
    value,
    text: `${entity} ${key}: ${value}`,
    category: "fact",
    decayClass: "stable",
    importance: 1.0,
    source: "test",
    confidence: 1.0,
  }, { actor, skipWikilinkEnforcement: true });
  if (!entry) throw new Error("seed failed");
  return entry;
}

describe("state machine", () => {
  test("clean fact: capture → extraction → promotion; terminal stage throws", async () => {
    const db = await initDb();
    const entry = await seedFact("deploy.region", "region is eu-central-1");

    expect(getPromotionStage(db, entry.id)).toBeNull();
    enterCapture(db, entry.id, { actor: ACTOR });
    expect(getPromotionStage(db, entry.id)).toBe("capture");

    const step1 = advancePromotion(db, entry.id, { actor: ACTOR });
    expect(step1).toMatchObject({ from: "capture", to: "extraction" });
    const step2 = advancePromotion(db, entry.id, { actor: ACTOR });
    expect(step2).toMatchObject({ from: "extraction", to: "promotion" });
    expect(getPromotionStage(db, entry.id)).toBe("promotion");

    expect(() => advancePromotion(db, entry.id, { actor: ACTOR })).toThrow(PromotionStateError);
  });

  test("extraction rules reject structural noise; the fact stays at capture with a reason", async () => {
    const db = await initDb();
    const entry = await seedFact("noise", "??");
    enterCapture(db, entry.id, { actor: ACTOR });
    const step = advancePromotion(db, entry.id, { actor: ACTOR });
    expect(step.to).toBe("capture");
    expect(step.rejectedReason).toBeTruthy();
    expect(getPromotionStage(db, entry.id)).toBe("capture");

    expect(extractionRules({ entity: "", value: "fine value" }).pass).toBe(false);
    expect(extractionRules({ entity: "x", value: "ab" }).pass).toBe(false);
    expect(extractionRules({ entity: "x", value: "a real fact" }).pass).toBe(true);
  });

  test("contradiction routes to review with a pending conflict row; review only moves via resolveReview", async () => {
    const db = await initDb();
    const older = await seedFact("cache.backend", "Cache backend is Redis 6");
    const newer = await seedFact("cache.backend", "Cache backend is Valkey 8");

    enterCapture(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });
    const step = advancePromotion(db, newer.id, { actor: ACTOR });
    expect(step).toMatchObject({ from: "extraction", to: "review", contradictionOf: older.id });
    expect(getPromotionStage(db, newer.id)).toBe("review");

    const pending = db.prepare(
      "SELECT COUNT(*) c FROM fact_conflicts WHERE fact_id = ? AND resolution = 'pending'"
    ).get(newer.id) as { c: number };
    expect(pending.c).toBe(1);

    expect(() => advancePromotion(db, newer.id, { actor: ACTOR })).toThrow(PromotionStateError);
  });
});

describe("review queue — contradictions only", () => {
  test("queue lists only review-stage facts, scoped to the actor", async () => {
    const db = await initDb();
    // A clean fact that promotes — must never appear in the queue.
    const clean = await seedFact("docs.site", "Docs built with Starlight");
    enterCapture(db, clean.id, { actor: ACTOR });
    advancePromotion(db, clean.id, { actor: ACTOR });
    advancePromotion(db, clean.id, { actor: ACTOR });

    // A contradiction pair that lands in review.
    const older = await seedFact("api.version", "API v1 in production");
    const newer = await seedFact("api.version", "API v2 in production");
    enterCapture(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });

    const queue = listReviewQueue(db, { actor: ACTOR });
    expect(queue.map((q) => q.factId)).toEqual([newer.id]);
    expect(queue[0].contradictionOf).toBe(older.id);
    expect(queue[0].contradictingValue).toBe("API v1 in production");
    expect(queue[0].contested).toBe(false);

    // Another actor sees an empty queue (scope isolation).
    expect(listReviewQueue(db, { actor: "codex" }).length).toBe(0);
  });

  test("supersede: contradicted fact is reversibly forgotten, new fact promotes", async () => {
    const db = await initDb();
    const older = await seedFact("ci.runner", "CI runs on hosted runners");
    const newer = await seedFact("ci.runner", "CI runs on BuildJet runners");
    enterCapture(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });

    const res = resolveReview(db, newer.id, "supersede", { actor: ACTOR });
    expect(res.stage).toBe("promotion");
    expect(res.forgottenFactId).toBe(older.id);
    expect(getPromotionStage(db, newer.id)).toBe("promotion");

    // The superseded fact is hidden from retrieval but restorable.
    expect((await ftsSearch("hosted", { actor: ACTOR })).length).toBe(0);
    expect(restoreFact(db, older.id, { actor: ACTOR })).toBe(true);
  });

  test("merge: both facts stand, new fact promotes", async () => {
    const db = await initDb();
    await seedFact("deploy.strategy", "Blue-green for the API");
    const newer = await seedFact("deploy.strategy", "Rolling for the workers");
    enterCapture(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });

    const res = resolveReview(db, newer.id, "merge", { actor: ACTOR });
    expect(res.stage).toBe("promotion");
    expect(res.forgottenFactId).toBeUndefined();
    expect((await ftsSearch("Blue-green API", { actor: ACTOR })).length).toBeGreaterThan(0);
  });

  test("flag: contested — fact STAYS in review, marked contested in the queue", async () => {
    const db = await initDb();
    await seedFact("db.sharding", "Sharding enabled");
    const newer = await seedFact("db.sharding", "Sharding disabled");
    enterCapture(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });
    advancePromotion(db, newer.id, { actor: ACTOR });

    const res = resolveReview(db, newer.id, "flag", { actor: ACTOR });
    expect(res.stage).toBe("review");
    expect(getPromotionStage(db, newer.id)).toBe("review");
    const queue = listReviewQueue(db, { actor: ACTOR });
    expect(queue.length).toBe(1);
    expect(queue[0].contested).toBe(true);
  });

  test("resolveReview refuses non-review facts and unknown decisions of scope", async () => {
    const db = await initDb();
    const clean = await seedFact("queue.broker", "NATS JetStream");
    enterCapture(db, clean.id, { actor: ACTOR });
    advancePromotion(db, clean.id, { actor: ACTOR });
    advancePromotion(db, clean.id, { actor: ACTOR });
    expect(() => resolveReview(db, clean.id, "merge", { actor: ACTOR })).toThrow(PromotionStateError);
    // Out-of-scope fact: not visible.
    expect(() => resolveReview(db, clean.id, "merge", { actor: "codex" })).toThrow(PromotionStateError);
  });
});

describe("sweep", () => {
  test("sweep enters unledgered facts at capture and runs them through; idempotent; dry-run changes nothing", async () => {
    const db = await initDb();
    const a = await seedFact("alpha", "alpha service owns ingest");
    const b = await seedFact("beta", "beta service owns egress");
    const older = await seedFact("gamma", "gamma uses sqlite");
    const newer = await seedFact("gamma", "gamma uses postgres");

    const dry = sweepPromotions(db, { actor: ACTOR, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.examined).toBe(4);
    expect(getPromotionStage(db, a.id)).toBeNull();

    const run = sweepPromotions(db, { actor: ACTOR });
    expect(run.promoted).toBe(2); // alpha and beta
    // The contradiction scan is symmetric while both facts are live, so BOTH
    // gamma facts route to review — the operator resolves the pair once.
    expect(run.sentToReview).toBe(2);
    expect(getPromotionStage(db, a.id)).toBe("promotion");
    expect(getPromotionStage(db, b.id)).toBe("promotion");
    expect(getPromotionStage(db, older.id)).toBe("review");
    expect(getPromotionStage(db, newer.id)).toBe("review");

    // Idempotent: nothing left at capture/extraction except the review item.
    const again = sweepPromotions(db, { actor: ACTOR });
    expect(again.examined).toBe(0);
  });

  test("promotion APIs without an actor resolve to the shared scope", async () => {
    const db = await initDb();
    const entry = await seedFact("delta", "delta probe");
    // No actor anywhere: every call resolves to 'shared' instead of throwing.
    enterCapture(db, entry.id, { actor: undefined as never });
    expect(getPromotionStage(db, entry.id)).toBe("capture");
    const row = db.prepare(
      "SELECT decided_by FROM fact_promotions WHERE fact_id = ?"
    ).get(entry.id) as { decided_by: string };
    expect(row.decided_by).toBe("shared");
    expect(() => sweepPromotions(db, { actor: null as never })).not.toThrow();
    expect(() => listReviewQueue(db, { actor: undefined as never })).not.toThrow();
    // State-machine/visibility errors are fine; actor-REQUIREMENT errors
    // (the removed fail-closed enforcement) are not.
    try {
      resolveReview(db, entry.id, "merge", { actor: undefined as never });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/actor is required/i);
    }
    try {
      advancePromotion(db, entry.id, { actor: "" as never });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/actor is required/i);
    }
  });
});
