#!/usr/bin/env bun
/**
 * ZOU-438 T3 — Self-evolving pipeline self-test (SF-P3).
 *
 * Fully hermetic (prespec/dedup-selftest pattern): synthetic seed-*.yaml (BOTH schema
 * variants) + verdict.json fixtures live in a mkdtemp dir; the runner's I/O is INJECTED
 * (loadWinningSeeds / write sink / ledger sink / clock) — no network, no spend, real
 * evaluations/ and state/ never touched. Sandbox removed in finally.
 *
 * Cases:
 *   A. schema-tolerant detection — tsc_clean/flag_gating/selftest_green fire in BOTH
 *      the legacy (goal/constraints/exit_conditions/string-ACs) and template
 *      (context/object-ACs) schemas.
 *   B. per_task_deps true/false; frequency math.
 *   C. proposePromotions — promotes above-threshold-unmandated, withholds mandated,
 *      withholds below-threshold; cold_start below min-seeds proposes nothing.
 *   D. loadWinningSeeds — keeps verdict=pass, drops fail, drops no-verdict.
 *   E. runner — --dry-run writes nothing; enabled run writes proposal + ledger;
 *      ledger idempotent on unchanged corpus; SF_PATTERN_PROMOTION unset → no-op.
 *
 * Exit 0 = all green.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeFrequencies,
  extractFeatures,
  proposePromotions,
  type WinningSeed,
} from "./pattern-promotion-core";
import { loadWinningSeeds, run, type RunDeps } from "./pattern-promotion-runner";

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── Synthetic seeds ────────────────────────────────────────────────────────────

/** Legacy schema-A: goal/constraints/exit_conditions/string-ACs/task.file. */
const SCHEMA_A = `
id: "seed-alpha"
status: approved
goal: "Do the thing idempotently, shadow first."
constraints:
  - "FEATURE_FLAG default OFF shadow log-only; ENFORCE default OFF operator-only; both off byte-identical"
  - "Pure core with INJECTED probe + clock (no live calls in core), sandboxed selftest"
acceptance_criteria:
  - "alpha-selftest.ts green across all scenarios; tsc --noEmit clean"
  - "Both flags off -> behavior byte-identical (diff-verified)"
exit_conditions:
  - name: tsc_clean
    criteria: "tsc --noEmit exit 0"
tasks:
  - id: T1
    name: core
    file: "scripts/alpha.ts"
    deps: []
    wave: 1
dag:
  wave_1: ["T1"]
`;

/** Template schema-B: context/archetype/object-ACs/task.files. */
const SCHEMA_B = `
id: BETA-1
title: "Template-shaped seed"
archetype: feature
context:
  problem: "the loop is open"
  load_bearing_facts: ["fact one"]
  decisions: ["D1 rationale"]
  flags:
    BETA_FLAG: "default OFF opt-in"
    BETA_FLAG_ENFORCE: "default OFF"
tasks:
  - id: T1
    package: beta
    files: ["scripts/beta.ts"]
    change: "hermetic, injectable"
    deps: []
acceptance_criteria:
  - name: selftest_green
    cmd: "bun scripts/beta-selftest.ts"
    expect: "exit 0"
  - name: tsc_clean
    cmd: "bunx tsc --noEmit"
    expect: "exit 0"
  - name: default_off_noop
    expect: "byte-identical when off"
dag:
  wave_1: [T1]
out_of_scope:
  - a learned model
`;

/** Minimal seed lacking the quality-bar features (for below-threshold cases). */
const SCHEMA_BARE = `
id: bare
goal: "just do it"
tasks:
  - id: T1
    name: x
    deps: []
dag:
  wave_1: ["T1"]
`;

function parseSeed(id: string, yaml: string): WinningSeed {
  const doc = Bun.YAML.parse(yaml);
  const top = Array.isArray(doc) ? doc[0] : doc;
  return { id, rework: false, raw: top as Record<string, unknown> };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "zou438-"));
  const evalDir = join(sandbox, "evaluations");
  rmSync(evalDir, { recursive: true, force: true });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(evalDir, { recursive: true });

  try {
    // ── A. schema-tolerant detection ──
    section("A. schema-tolerant detection");
    const a = extractFeatures(parseSeed("alpha", SCHEMA_A).raw);
    const b = extractFeatures(parseSeed("beta", SCHEMA_B).raw);
    checkT("schema-A detects tsc_clean", a.has("tsc_clean"));
    checkT("schema-A detects flag_gating", a.has("flag_gating"));
    checkT("schema-A detects selftest_green", a.has("selftest_green"));
    checkT("schema-A detects byte_identical_off", a.has("byte_identical_off"));
    checkT("schema-A detects injected_test_deps", a.has("injected_test_deps"));
    checkT("schema-B detects tsc_clean", b.has("tsc_clean"));
    checkT("schema-B detects flag_gating (context.flags)", b.has("flag_gating"));
    checkT("schema-B detects selftest_green", b.has("selftest_green"));
    checkT("schema-B detects byte_identical_off", b.has("byte_identical_off"));
    checkT("schema-B detects out_of_scope", b.has("out_of_scope"));
    checkT("both schemas detect per_task_deps", a.has("per_task_deps") && b.has("per_task_deps"));

    // ── B. per_task_deps true/false + frequency ──
    section("B. per_task_deps + frequency math");
    const noDeps = parseSeed("nodeps", `id: nd\ntasks:\n  - id: T1\n    name: x\ndag: {}\n`);
    checkT("per_task_deps false when a task omits deps", !extractFeatures(noDeps.raw).has("per_task_deps"));
    const freq = computeFrequencies([parseSeed("a", SCHEMA_A), parseSeed("b", SCHEMA_B)]);
    checkT("tsc_clean frequency = 1.0 across 2 winners", freq.get("tsc_clean")!.frequency === 1);
    checkT("out_of_scope frequency = 0.5 (only schema-B)", freq.get("out_of_scope")!.frequency === 0.5);
    checkT("frequency supporting_seeds sorted+correct", freq.get("out_of_scope")!.seeds.join(",") === "b");

    // ── C. proposePromotions ──
    section("C. proposePromotions gap logic");
    // 6 winners w/ the quality bar so freq≥0.6 and ≥ min-seeds=5.
    const corpus = [
      parseSeed("a1", SCHEMA_A),
      parseSeed("a2", SCHEMA_A),
      parseSeed("a3", SCHEMA_A),
      parseSeed("b1", SCHEMA_B),
      parseSeed("b2", SCHEMA_B),
      parseSeed("b3", SCHEMA_B),
    ];
    const res = proposePromotions(corpus, { minSeeds: 5, minFrequency: 0.6 });
    const proposedKeys = new Set(res.proposals.map((p) => p.feature));
    checkT("proposes tsc_clean (100%, unmandated)", proposedKeys.has("tsc_clean"));
    checkT("proposes flag_gating (unmandated)", proposedKeys.has("flag_gating"));
    checkT("proposes selftest_green (unmandated)", proposedKeys.has("selftest_green"));
    checkT("does NOT propose per_task_deps (already mandated)", !proposedKeys.has("per_task_deps"));
    checkT("does NOT propose wave_dag (already mandated)", !proposedKeys.has("wave_dag"));
    checkT("already_mandated lists context_rationale", res.already_mandated.includes("context_rationale"));
    checkT("not cold_start at 6 ≥ min-seeds 5", res.cold_start === false);
    checkT("proposals sorted by descending frequency", res.proposals.every((p, i, arr) => i === 0 || arr[i - 1].frequency >= p.frequency));

    // below-threshold: bare seeds lack the quality bar → not proposed
    const bareCorpus = Array.from({ length: 6 }, (_, i) => parseSeed(`bare${i}`, SCHEMA_BARE));
    const bareRes = proposePromotions(bareCorpus, { minSeeds: 5, minFrequency: 0.6 });
    checkT("withholds tsc_clean when 0% of winners have it", !bareRes.proposals.some((p) => p.feature === "tsc_clean"));

    // cold start: below min-seeds proposes nothing
    const cold = proposePromotions(corpus.slice(0, 3), { minSeeds: 5, minFrequency: 0.6 });
    checkT("cold_start true below min-seeds", cold.cold_start === true);
    checkT("cold_start proposes nothing", cold.proposals.length === 0);

    // underused mandate: out_of_scope mandated but only 50% adhere → informational
    const mixed = [parseSeed("a", SCHEMA_A), parseSeed("b", SCHEMA_B)];
    const mixedRes = proposePromotions(mixed, { minSeeds: 1, minFrequency: 0.6 });
    checkT("out_of_scope surfaces as underused_mandate (50% < 60%)", mixedRes.underused_mandates.some((u) => u.feature === "out_of_scope"));

    // ── D. loadWinningSeeds ──
    section("D. loadWinningSeeds verdict join");
    writeFileSync(join(sandbox, "seed-pass1.yaml"), SCHEMA_A);
    writeFileSync(join(sandbox, "seed-fail1.yaml"), SCHEMA_B);
    writeFileSync(join(sandbox, "seed-noverdict.yaml"), SCHEMA_BARE);
    writeFileSync(join(evalDir, "pass1.verdict.json"), JSON.stringify({
      ticket: "pass1",
      verdict: "pass",
      rework: true,
      evidence: "synthetic passing evidence",
      decided_at: "2026-07-01T00:00:00.000Z",
    }));
    writeFileSync(join(evalDir, "fail1.verdict.json"), JSON.stringify({
      ticket: "fail1",
      verdict: "fail",
      rework: false,
      evidence: "synthetic failing evidence",
      decided_at: "2026-07-01T00:00:00.000Z",
    }));
    const loaded = loadWinningSeeds(sandbox, evalDir);
    const loadedIds = loaded.map((s) => s.id).sort();
    checkT("keeps verdict=pass seed", loadedIds.includes("pass1"));
    checkT("drops verdict=fail seed", !loadedIds.includes("fail1"));
    checkT("drops seed with no verdict file", !loadedIds.includes("noverdict"));
    checkT("carries rework metadata", loaded.find((s) => s.id === "pass1")?.rework === true);
    // stripped-variant resolution: seed-sf006-dedup.yaml resolves sf006.verdict.json
    writeFileSync(join(sandbox, "seed-sf006-dedup.yaml"), SCHEMA_A);
    writeFileSync(join(evalDir, "sf006.verdict.json"), JSON.stringify({
      ticket: "SF-006",
      verdict: "pass",
      rework: false,
      evidence: "synthetic stripped-variant evidence",
      decided_at: "2026-07-01T00:00:00.000Z",
    }));
    checkT("resolves stripped verdict variant (sf006-dedup→sf006)", loadWinningSeeds(sandbox, evalDir).some((s) => s.id === "sf006-dedup"));

    // ── E. runner I/O (injected) ──
    section("E. runner (injected I/O)");
    const injectedCorpus = corpus;
    let writes = 0;
    let ledgerRows: unknown[] = [];
    let ledgerHash: string | null = null;
    const makeDeps = (): Partial<RunDeps> => ({
      loadWinningSeeds: () => injectedCorpus,
      writeProposed: () => { writes++; },
      appendLedger: (row) => { ledgerRows.push(row); ledgerHash = (row as { proposal_hash: string }).proposal_hash; },
      latestProposalHash: () => ledgerHash,
      nowMs: Date.parse("2026-07-06T12:00:00.000Z"),
    });

    // dry-run writes nothing even with everything available
    writes = 0; ledgerRows = [];
    const dry = await run({ dryRun: true, minSeeds: 5, minFrequency: 0.6, deps: makeDeps() });
    checkT("dry-run computes proposals", dry.result.proposals.length > 0);
    checkT("dry-run writes no proposal artifact", writes === 0);
    checkT("dry-run appends no ledger row", ledgerRows.length === 0);
    checkT("dry-run reports wrote_proposed=false", dry.wrote_proposed === false);

    // default OFF (flag unset) → no-op, no reads/writes
    const savedFlag = process.env.SF_PATTERN_PROMOTION;
    delete process.env.SF_PATTERN_PROMOTION;
    let loadCalls = 0;
    const off = await run({ dryRun: false, deps: { ...makeDeps(), loadWinningSeeds: () => { loadCalls++; return injectedCorpus; } } });
    checkT("flag off → no-op (enabled=false)", off.enabled === false);
    checkT("flag off → corpus never loaded", loadCalls === 0);
    checkT("flag off → nothing written", writes === 0 && ledgerRows.length === 0);

    // enabled + live → writes proposal + appends ledger
    process.env.SF_PATTERN_PROMOTION = "1";
    writes = 0; ledgerRows = []; ledgerHash = null;
    const live1 = await run({ dryRun: false, minSeeds: 5, minFrequency: 0.6, deps: makeDeps() });
    checkT("live writes proposal artifact", writes === 1 && live1.wrote_proposed === true);
    checkT("live appends one ledger row", ledgerRows.length === 1 && live1.appended_ledger === true);
    checkT("ledger row carries proposal_hash + proposed keys", typeof (ledgerRows[0] as any).proposal_hash === "string" && Array.isArray((ledgerRows[0] as any).proposed));

    // idempotency: 2nd run, unchanged corpus → rewrites proposal but appends NO new row
    const live2 = await run({ dryRun: false, minSeeds: 5, minFrequency: 0.6, deps: makeDeps() });
    checkT("2nd run rewrites proposal", writes === 2);
    checkT("2nd run appends no new ledger row (idempotent)", ledgerRows.length === 1 && live2.appended_ledger === false);
    checkT("proposal_hash stable across identical runs", live1.proposal_hash === live2.proposal_hash);

    if (savedFlag === undefined) delete process.env.SF_PATTERN_PROMOTION;
    else process.env.SF_PATTERN_PROMOTION = savedFlag;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  console.log(`\npattern-promotion-selftest: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`pattern-promotion-selftest: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
