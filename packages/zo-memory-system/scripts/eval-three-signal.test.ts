/**
 * CI gate for the three-signal retrieval eval (Track 3).
 *
 * Pins exact deterministic counts (hermetic scratch DB + deterministic
 * pseudo-embeddings, so every number below is reproducible byte-for-byte)
 * and verifies structural identity across two fresh DBs. Green/red
 * discipline mirrors the heldout-recall gate: any drift in a signal's
 * accuracy is a gate failure, not a flake.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runThreeSignalEval, ARM_NAMES, type ThreeSignalReport } from "./eval-three-signal";
import {
  deterministicEmbedding,
  embeddings as mcEmbeddings,
  DETERMINISTIC_EMBEDDING_DIMENSION,
  DETERMINISTIC_EMBEDDING_MODEL,
} from "./model-client";

/** Strip wall-clock noise so two runs can be compared structurally. */
function stripLatency(report: ThreeSignalReport): unknown {
  return JSON.parse(JSON.stringify(report, (key, value) => (key === "latency" ? undefined : value)));
}

test("deterministic embedding provider is stable, unit-norm, and key-free", async () => {
  const a = deterministicEmbedding("postgres backups stream nightly");
  const b = deterministicEmbedding("postgres backups stream nightly");
  expect(a.length).toBe(DETERMINISTIC_EMBEDDING_DIMENSION);
  expect(a).toEqual(b);
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  expect(Math.abs(norm - 1)).toBeLessThan(1e-9);

  // The provider slots into the model-client embeddings seam with no API key.
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ["OPENAI_API_KEY", "ZO_OPENAI_API_KEY", "ZO_MODEL_EMBEDDING"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ZO_MODEL_EMBEDDING = "deterministic:hash-v1";
  try {
    const viaSeam = await mcEmbeddings("postgres backups stream nightly");
    expect(viaSeam.embedding).toEqual(a);
    expect(viaSeam.model).toBe(DETERMINISTIC_EMBEDDING_MODEL);
    expect(viaSeam.cost_usd).toBe(0);
  } finally {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
});

test("three-signal eval: per-signal ablation is deterministic and each signal owns its category", async () => {
  const root = mkdtempSync(join(tmpdir(), "three-signal-test-"));
  try {
    const report = await runThreeSignalEval(join(root, "eval.db"));

    expect(report.questions).toBe(35);
    expect(report.topK).toBe(5);

    // ── Fail-closed invariants ──
    // Expired facts must NEVER surface, on any arm, on any query.
    expect(report.stage2.decayExclusion.expiredSurfaced).toBe(0);
    expect(report.stage2.decayExclusion.queriesChecked).toBe(35 * ARM_NAMES.length);
    // The hermetic run costs exactly zero.
    for (const arm of ARM_NAMES) {
      expect(report.arms[arm].efficiency.actualCostUsd).toBe(0);
    }

    // ── Stage 1: mechanical top-1 accuracy per arm (exact) ──
    expect(report.arms["keyword"].top1Correct).toBe(24);
    expect(report.arms["vector"].top1Correct).toBe(27);
    expect(report.arms["graph"].top1Correct).toBe(10);
    expect(report.arms["keyword-vector"].top1Correct).toBe(24);
    expect(report.arms["all-three"].top1Correct).toBe(23);
    expect(report.arms["no-graph-boost"].top1Correct).toBe(24);
    // Top-K recall: the production default reaches every graph-linked gold.
    expect(report.arms["all-three"].topKCorrect).toBe(32);
    expect(report.arms["no-graph-boost"].topKCorrect).toBe(28);

    // ── Stage 1: each signal owns its category ──
    expect(report.byCategory["entity-direct"]["keyword"]).toBe(6);
    expect(report.byCategory["entity-direct"]["graph"]).toBe(0);
    expect(report.byCategory["semantic-paraphrase"]["vector"]).toBe(6);
    expect(report.byCategory["graph-linked"]["graph"]).toBe(4);
    expect(report.byCategory["graph-linked"]["keyword"]).toBe(0);
    expect(report.byCategory["graph-linked"]["vector"]).toBe(0);
    // Temporal updates: the stale fact wins on EVERY arm — the known
    // staleness failure mode, measured, not hidden.
    for (const arm of ARM_NAMES) {
      expect(report.byCategory["temporal-update"][arm]).toBe(0);
    }

    // ── Stage 2: semantic behaviors ──
    expect(report.stage2.paraphraseRecall["vector"]).toEqual({ hit: 6, total: 6 });
    expect(report.stage2.paraphraseRecall["graph"]).toEqual({ hit: 0, total: 6 });
    // Vector (token-overlap) rejects every near-miss; keyword OR-matching
    // over-recalls on shared stopword-ish tokens — a real, measured weakness.
    expect(report.stage2.nearMissRejection["vector"]).toEqual({ rejected: 6, total: 6 });
    expect(report.stage2.nearMissRejection["graph"]).toEqual({ rejected: 6, total: 6 });
    expect(report.stage2.nearMissRejection["keyword"]).toEqual({ rejected: 3, total: 6 });
    expect(report.stage2.correctionRecall["vector"]).toEqual({ hit: 3, total: 3 });
    expect(report.stage2.correctionRecall["keyword"]).toEqual({ hit: 3, total: 3 });
    expect(report.stage2.contestedAbstention["all-three"]).toEqual({ abstained: 3, total: 3 });
    expect(report.stage2.contestedAbstention["keyword"]).toEqual({ abstained: 3, total: 3 });
    // Graph contribution > 0 on entity-linked questions (exact: +4 — without
    // the graph the spoke facts are unreachable through the production path).
    expect(report.stage2.graphBoostContribution.contribution).toBe(4);
    expect(report.stage2.graphBoostContribution.allThreeTopK).toBe(4);
    expect(report.stage2.graphBoostContribution.noBoostTopK).toBe(0);

    // ── Stage 3: consensus ──
    expect(report.stage3.abVerdict.verdict).toBe("helps");
    expect(report.stage3.abVerdict.delta).toBe(4);
    // Internal consistency: the direct keyword+vector fusion and the
    // production path with graph off rank top-1 identically.
    const hybridVsNoBoost = report.stage3.agreement.find(
      (p) => p.a === "keyword-vector" && p.b === "no-graph-boost"
    );
    expect(hybridVsNoBoost?.top1AgreementRate).toBe(1);

    // ── Efficiency accounting ──
    expect(report.arms["vector"].efficiency.embeddingCalls).toBe(35);
    expect(report.arms["all-three"].efficiency.embeddingCalls).toBe(35);
    expect(report.arms["keyword"].efficiency.embeddingCalls).toBe(0);
    expect(report.arms["graph"].efficiency.embeddingCalls).toBe(0);
    expect(report.arms["all-three"].efficiency.realProviderCostUsd).toBeGreaterThan(0);

    // ── Determinism: a second run on a fresh DB is structurally identical ──
    const again = await runThreeSignalEval(join(root, "eval2.db"));
    expect(stripLatency(again)).toEqual(stripLatency(report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
