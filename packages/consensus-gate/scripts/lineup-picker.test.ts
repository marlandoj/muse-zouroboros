import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  blockedCandidateIds,
  buildLineupRole,
  openWeightsBlockers,
  openWeightProvenanceBlockers,
  operationalReadinessBlockers,
  compareFamilyLabels,
  isLineupProfile,
  lineupPathFor,
  lineupPathForSelection,
  migrateLegacyFlagshipArtifact,
  pickLineup,
  PROFILES,
  shouldPersistLineup,
  sortCandidates,
  sortCandidatesForSelection,
  toCandidate,
  validateLineup,
  validatePersistedLineup,
  type Candidate,
  type PersistedLineup,
} from "./lineup-picker";
import { classifyOpenWeights } from "./catalog";
import {
  capabilityTierFor,
  modelRoleFitFor,
  resolveLineupSelection,
  weightPolicyBlockers,
} from "./lineup-taxonomy";
import type { ModelBenchmarkEvidence } from "./zourobench-lineup-evidence";

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    id: "byok:test",
    label: "Test Model",
    family: "test",
    canonicalModel: "test-model",
    tier: "flagship",
    provider: "zo-byok",
    promptCost: 0,
    completionCost: 0,
    totalCost: 0,
    subscription: true,
    openWeights: true,
    openWeightsEvidence: "explicit",
    lifecycleStatus: "promoted",
    routeHealth: "healthy",
    ...overrides,
  };
}

function benchmarkEvidence(
  canonicalModel: string,
  family: string,
  proposer: number,
  aggregator: number,
): ModelBenchmarkEvidence {
  const score = (selectionFloor: number) => ({ mean: selectionFloor, selectionFloor, standardDeviation: 0 });
  return {
    benchmark: "ZouroBench",
    canonicalModel,
    family,
    cohortId: `cohort-${canonicalModel}`,
    replicates: 5,
    requiredReplicates: 5,
    observedAt: "2026-08-04T00:00:00.000Z",
    contextFingerprint: "same-context",
    sourceModelIds: [canonicalModel],
    overall: score(proposer),
    roles: { proposer: score(proposer), aggregator: score(aggregator) },
  };
}

describe("compareFamilyLabels", () => {
  test("orders Claude variants by approved capability preference", () => {
    const labels = [
      "Claude Code Haiku 4.5",
      "Claude Code Opus 4.8",
      "Claude Code Fable 5",
      "Claude Code Sonnet 5",
    ];

    expect(labels.sort((a, b) => compareFamilyLabels("claude", a, b))).toEqual([
      "Claude Code Fable 5",
      "Claude Code Sonnet 5",
      "Claude Code Opus 4.8",
      "Claude Code Haiku 4.5",
    ]);
  });

  test("orders GPT versions descending and prefers Sol on an equal version", () => {
    const labels = ["Codex GPT 5.5", "Codex GPT 5.6", "Codex GPT 5.6 Sol", "Codex GPT 5.10"];

    expect(labels.sort((a, b) => compareFamilyLabels("gpt", a, b))).toEqual([
      "Codex GPT 5.10",
      "Codex GPT 5.6 Sol",
      "Codex GPT 5.6",
      "Codex GPT 5.5",
    ]);
  });

  test("orders Kimi versions newest first", () => {
    const labels = ["Kimi K2.5", "Kimi K3", "Kimi K2.7 Code", "Kimi K2.6"];

    expect(labels.sort((a, b) => compareFamilyLabels("kimi", a, b))).toEqual([
      "Kimi K3",
      "Kimi K2.7 Code",
      "Kimi K2.6",
      "Kimi K2.5",
    ]);
  });

  test("uses a stable natural label fallback for unknown families", () => {
    expect(compareFamilyLabels("other", "Model 10", "Model 9")).toBeGreaterThan(0);
  });
});

describe("identity and eligibility", () => {
  test("uses explicit openness metadata before conservative route evidence", () => {
    expect(classifyOpenWeights({ id: "oc:closed", open_weights: false })).toEqual({
      openWeights: false,
      openWeightsEvidence: "explicit",
    });
    expect(classifyOpenWeights({ id: "or:org/model", hugging_face_id: "org/model" })).toEqual({
      openWeights: true,
      openWeightsEvidence: "hugging-face-id",
    });
    expect(classifyOpenWeights({ id: "hf:org/model" })).toEqual({
      openWeights: true,
      openWeightsEvidence: "hf-route",
    });
    expect(classifyOpenWeights({ id: "oc:unknown" })).toEqual({
      openWeights: null,
      openWeightsEvidence: "unknown",
    });
  });

  test("fails closed on unknown openness, lifecycle, and route health", () => {
    const blockers = openWeightsBlockers(candidate({
      id: "hf:unproven",
      openWeights: null,
      openWeightsEvidence: "unknown",
      lifecycleStatus: "shadow",
      routeHealth: "unknown",
    }));

    expect(blockers).toEqual([
      "hf:unproven: open-weight provenance is unknown",
      "hf:unproven: lifecycle=shadow, allowed=promoted",
      "hf:unproven: route health=unknown",
    ]);
  });

  test("keeps openness classification independent from operational readiness", () => {
    const unreadyOpen = candidate({ lifecycleStatus: "shadow", routeHealth: "failing" });
    expect(openWeightProvenanceBlockers(unreadyOpen)).toEqual([]);
    expect(operationalReadinessBlockers(unreadyOpen)).toEqual([
      "byok:test: lifecycle=shadow, allowed=promoted",
      "byok:test: route health=failing",
    ]);
    expect(openWeightProvenanceBlockers(candidate({
      openWeights: null,
      openWeightsEvidence: "unknown",
    }))).toEqual(["byok:test: open-weight provenance is unknown"]);
  });

  test("classifies explicit and route-level openness while leaving unknown unproven", () => {
    expect(classifyOpenWeights({ id: "or:vendor/model", open_weights: true })).toEqual({
      openWeights: true,
      openWeightsEvidence: "explicit",
    });
    expect(classifyOpenWeights({ id: "or:vendor/model", hugging_face_id: "org/model" })).toEqual({
      openWeights: true,
      openWeightsEvidence: "hugging-face-id",
    });
    expect(classifyOpenWeights({ id: "hf:org/model" })).toEqual({
      openWeights: true,
      openWeightsEvidence: "hf-route",
    });
    expect(classifyOpenWeights({ id: "oc:vendor/model" })).toEqual({
      openWeights: null,
      openWeightsEvidence: "unknown",
    });
  });

  test("rejects unknown, closed, stale, and unhealthy production candidates", () => {
    expect(openWeightsBlockers(candidate({ openWeights: null, openWeightsEvidence: "unknown" }))).toEqual([
      "byok:test: open-weight provenance is unknown",
    ]);
    expect(openWeightsBlockers(candidate({ openWeights: false, openWeightsEvidence: "explicit" }))).toEqual([
      "byok:test: catalog metadata marks weights closed",
    ]);
    expect(openWeightsBlockers(candidate({ openWeights: true, openWeightsEvidence: "unknown" }))).toContain(
      "byok:test: open-weight provenance is missing",
    );
    expect(openWeightsBlockers(candidate({ lifecycleStatus: "shadow" }))).toContain(
      "byok:test: lifecycle=shadow, allowed=promoted",
    );
    expect(openWeightsBlockers(candidate({ routeHealth: "failing" }))).toContain(
      "byok:test: route health=failing",
    );
  });

  test("blocks every non-promoted status from a top-level candidate array", () => {
    const blocked = blockedCandidateIds([
      { id: "oc:provisional", status: "provisional" },
      { id: "oc:cold", status: "cold-start-passed" },
      { id: "oc:shadow", status: "shadow" },
      { id: "oc:rejected", status: "rejected" },
      { id: "oc:promoted", status: "promoted" },
    ]);
    expect([...blocked].sort()).toEqual(["oc:cold", "oc:provisional", "oc:rejected", "oc:shadow"]);
  });

  test("maps legacy raw OpenRouter records to the or: eligibility namespace", () => {
    const blocked = blockedCandidateIds([
      { id: "anthropic/claude-fable-5", provider: "openrouter", status: "shadow" },
    ]);
    expect(blocked.has("or:anthropic/claude-fable-5")).toBe(true);
  });

  test("normalizes raw OpenRouter cache ids only at the lineup boundary", () => {
    const openrouter = toCandidate({
      id: "anthropic/claude-fable-5",
      context_length: 200_000,
      pricing: { prompt: "0.000001", completion: "0.000005" },
      family: "anthropic",
      tier: "flagship",
      promptCost: 0.000001,
      completionCost: 0.000005,
      openWeights: null,
      openWeightsEvidence: "unknown",
    }, "openrouter");
    expect(openrouter).toMatchObject({
      id: "or:anthropic/claude-fable-5",
      provider: "openrouter",
      family: "claude",
      canonicalModel: "claude-fable-5",
    });
  });

  test("prefers schema-valid review health over stale transport health", () => {
    const model = {
      id: "oc:minimax-m3",
      context_length: 200_000,
      pricing: { prompt: "0", completion: "0" },
      family: "minimax",
      tier: "fast" as const,
      promptCost: 0,
      completionCost: 0,
      openWeights: null,
      openWeightsEvidence: "unknown" as const,
      routeHealth: "healthy" as const,
    };
    const health = {
      "oc:minimax-m3": {
        ok: true,
        provider: "opencode",
        latencyMs: 50,
        observedAt: new Date().toISOString(),
      },
      "oc:minimax-m3::review": {
        ok: false,
        provider: "opencode",
        latencyMs: 100,
        error: "API error: 401",
        observedAt: new Date().toISOString(),
        healthClass: "review" as const,
      },
    };

    expect(toCandidate(model, "opencode", [], health).routeHealth).toBe("failing");
  });

  test("excludes unhealthy routes from every production profile", () => {
    const pool = [
      candidate({ id: "oc:unhealthy-fast", family: "minimax", canonicalModel: "minimax-m3", tier: "fast", routeHealth: "failing" }),
      candidate({ id: "byok:healthy-fast", family: "gpt", canonicalModel: "gpt-mini", tier: "fast" }),
      candidate({ id: "or:healthy-fast", family: "gemini", canonicalModel: "gemini-flash", tier: "fast", provider: "openrouter" }),
    ];

    const lineup = pickLineup(pool, { proposerCount: 1, pinProposers: [], pinAggregator: null, profile: "fast" });
    expect([...lineup.proposers, lineup.aggregator]).not.toContain("oc:unhealthy-fast");
    expect(validateLineup({ ...lineup, proposers: ["oc:unhealthy-fast"], pinned: true }, pool, 1).errors).toContain(
      "unhealthy lineup id: oc:unhealthy-fast (failing)",
    );
  });

  test("builds a same-model provider-diverse fallback role", () => {
    const pool = [
      candidate({ id: "hf:zai-org/GLM-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "synthetic" }),
      candidate({ id: "oc:glm-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "opencode" }),
      candidate({ id: "or:z-ai/glm-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "openrouter", totalCost: 1 }),
      candidate({ id: "or:other/glm-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "openrouter", totalCost: 2 }),
    ];
    expect(buildLineupRole("hf:zai-org/GLM-5.2", pool, new Set())).toEqual({
      primary: "hf:zai-org/GLM-5.2",
      fallbacks: ["oc:glm-5.2", "or:z-ai/glm-5.2"],
    });
  });

  test("never persists per-run pinned lineups to the shared cache", () => {
    const pinned = pickLineup([
      candidate({ id: "oc:a", family: "a", canonicalModel: "a" }),
      candidate({ id: "oc:b", family: "b", canonicalModel: "b" }),
    ], { proposerCount: 1, pinProposers: ["oc:a"], pinAggregator: "oc:b" });
    expect(shouldPersistLineup(true, pinned)).toBe(false);
    expect(shouldPersistLineup(true, { ...pinned, pinned: false })).toBe(true);
  });

  test("keeps promoted and untracked established candidates eligible", () => {
    const blocked = blockedCandidateIds([
      { id: "oc:tracked-promoted", status: "promoted" },
    ]);
    expect(blocked.has("oc:tracked-promoted")).toBe(false);
    expect(blocked.has("hf:established-untracked")).toBe(false);
  });

  test("rejects unknown pinned ids instead of guessing their family", () => {
    const pool = [
      candidate({ id: "oc:claude-fable-5", family: "claude", canonicalModel: "claude-fable-5" }),
      candidate({ id: "hf:zai-org/GLM-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "synthetic" }),
    ];
    const lineup = pickLineup(pool, {
      proposerCount: 1,
      pinProposers: ["oc:not-in-catalog"],
      pinAggregator: "hf:zai-org/GLM-5.2",
    });
    expect(validateLineup(lineup, pool, 1)).toMatchObject({ valid: false });
    expect(validateLineup(lineup, pool, 1).errors).toContain("unknown lineup id: oc:not-in-catalog");
  });

  test("rejects a live but non-promoted pinned candidate", () => {
    const pool = [
      candidate({ id: "oc:shadow-model", family: "claude", canonicalModel: "claude-shadow" }),
      candidate({ id: "hf:zai-org/GLM-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "synthetic" }),
    ];
    const lineup = pickLineup(pool, {
      proposerCount: 1,
      pinProposers: ["oc:shadow-model"],
      pinAggregator: "hf:zai-org/GLM-5.2",
    });
    const result = validateLineup(lineup, pool, 1, new Set(["oc:shadow-model"]));
    expect(result.errors).toContain("ineligible lineup id: oc:shadow-model");
  });

  test("rejects duplicate canonical families across provider routes", () => {
    const pool = [
      candidate({ id: "oc:claude-fable-5", family: "claude", canonicalModel: "claude-fable-5", provider: "opencode" }),
      candidate({ id: "or:anthropic/claude-fable-5", family: "claude", canonicalModel: "claude-fable-5", provider: "openrouter" }),
      candidate({ id: "hf:zai-org/GLM-5.2", family: "glm", canonicalModel: "glm-5.2", provider: "synthetic" }),
    ];
    const lineup = pickLineup(pool, {
      proposerCount: 2,
      pinProposers: ["oc:claude-fable-5", "or:anthropic/claude-fable-5"],
      pinAggregator: "hf:zai-org/GLM-5.2",
    });
    expect(validateLineup(lineup, pool, 2).errors).toContain("proposer families must be canonical and distinct");
  });
});

describe("sortCandidates", () => {
  test("prefers publishable role evidence and conservative score before cost", () => {
    const measuredHigh = candidate({
      id: "or:vendor/measured-high",
      family: "high",
      canonicalModel: "measured-high",
      totalCost: 10,
      benchmarkEvidence: benchmarkEvidence("measured-high", "high", 95, 70),
    });
    const measuredLow = candidate({
      id: "or:vendor/measured-low",
      family: "low",
      canonicalModel: "measured-low",
      totalCost: 0,
      benchmarkEvidence: benchmarkEvidence("measured-low", "low", 80, 90),
    });
    const unknown = candidate({ id: "byok:unknown", family: "unknown", canonicalModel: "unknown", totalCost: 0 });

    expect(sortCandidates([unknown, measuredLow, measuredHigh], "proposer").map((item) => item.id)).toEqual([
      "or:vendor/measured-high",
      "or:vendor/measured-low",
      "byok:unknown",
    ]);
    expect(sortCandidates([unknown, measuredLow, measuredHigh], "aggregator").map((item) => item.id)).toEqual([
      "or:vendor/measured-low",
      "or:vendor/measured-high",
      "byok:unknown",
    ]);
  });

  test("does not apply general ZouroBench scores to the unsupported coder role", () => {
    const costlyMeasured = candidate({
      id: "or:vendor/costly",
      family: "costly",
      canonicalModel: "costly",
      provider: "openrouter",
      totalCost: 10,
      benchmarkEvidence: benchmarkEvidence("costly", "costly", 99, 99),
    });
    const cheapUnknown = candidate({
      id: "hf:vendor/cheap",
      family: "cheap",
      canonicalModel: "cheap",
      provider: "synthetic",
      totalCost: 0,
    });

    expect(sortCandidates([costlyMeasured, cheapUnknown], "coder").map((item) => item.id)).toEqual([
      "hf:vendor/cheap",
      "or:vendor/costly",
    ]);
  });

  test("uses proposer evidence for panel seats and aggregator evidence for synthesis", () => {
    const pool = [
      candidate({ id: "hf:a", family: "a", canonicalModel: "a", benchmarkEvidence: benchmarkEvidence("a", "a", 99, 10) }),
      candidate({ id: "hf:b", family: "b", canonicalModel: "b", benchmarkEvidence: benchmarkEvidence("b", "b", 98, 20) }),
      candidate({ id: "hf:c", family: "c", canonicalModel: "c", benchmarkEvidence: benchmarkEvidence("c", "c", 97, 30) }),
      candidate({ id: "hf:d", family: "d", canonicalModel: "d", benchmarkEvidence: benchmarkEvidence("d", "d", 1, 99) }),
    ];

    const lineup = pickLineup(pool, { proposerCount: 3, pinProposers: [], pinAggregator: null });
    expect(lineup.proposers).toEqual(["hf:a", "hf:b", "hf:c"]);
    expect(lineup.aggregator).toBe("hf:d");
  });

  test("selects GPT 5.6 Sol before GPT 5.5 when policy inputs tie", () => {
    const sorted = sortCandidates([
      candidate({ id: "byok:gpt-55", label: "Codex GPT 5.5", family: "gpt" }),
      candidate({ id: "byok:gpt-56", label: "Codex GPT 5.6 Sol", family: "gpt" }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["byok:gpt-56", "byok:gpt-55"]);
  });

  test("keeps cost precedence ahead of family preference", () => {
    const sorted = sortCandidates([
      candidate({ id: "byok:gpt-56", label: "Codex GPT 5.6 Sol", family: "gpt", totalCost: 1 }),
      candidate({ id: "byok:gpt-55", label: "Codex GPT 5.5", family: "gpt", totalCost: 0 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["byok:gpt-55", "byok:gpt-56"]);
  });

  test("keeps subscription provider precedence ahead of family preference", () => {
    const sorted = sortCandidates([
      candidate({ id: "byok:gpt-56", label: "Codex GPT 5.6 Sol", family: "gpt", subscription: false }),
      candidate({ id: "hf:gpt-55", label: "Codex GPT 5.5", family: "gpt", provider: "synthetic", subscription: false }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["hf:gpt-55", "byok:gpt-56"]);
  });
});

describe("lineup profiles (ZOU-576)", () => {
  test("isLineupProfile accepts registry keys and rejects unknowns", () => {
    for (const p of ["flagship", "open-weights", "fast", "coder", "judge"]) expect(isLineupProfile(p)).toBe(true);
    expect(isLineupProfile("budget")).toBe(false);
    expect(isLineupProfile("")).toBe(false);
  });

  test("profile eligibility uses catalog openness metadata without a family allowlist", () => {
    const glmFlagship = candidate({ id: "hf:zai-org/GLM-9", family: "glm", tier: "flagship" });
    const claudeFlagship = candidate({ id: "byok:claude", family: "claude", tier: "flagship", openWeights: false, openWeightsEvidence: "explicit" });
    const qwenFast = candidate({ id: "hf:qwen-mini", family: "qwen", tier: "fast" });
    const kimiCoder = candidate({ id: "hf:kimi-dev", family: "kimi", tier: "coder" });

    expect(PROFILES.flagship.eligible(glmFlagship)).toBe(true);
    expect(PROFILES.flagship.eligible(qwenFast)).toBe(false);

    expect(PROFILES["open-weights"].eligible(glmFlagship)).toBe(true);
    expect(PROFILES["open-weights"].eligible(claudeFlagship)).toBe(false);
    expect(PROFILES["open-weights"].eligible(qwenFast)).toBe(true);

    expect(PROFILES.fast.eligible(qwenFast)).toBe(true);
    expect(PROFILES.fast.eligible(glmFlagship)).toBe(false);

    expect(PROFILES.coder.eligible(kimiCoder)).toBe(true);
    expect(PROFILES.coder.eligible(glmFlagship)).toBe(false);
  });

  test("translates legacy presets into orthogonal role, capability, and weight dimensions", () => {
    expect(resolveLineupSelection("flagship")).toMatchObject({
      roleProfile: "deep-reasoning",
      capabilityTier: "frontier",
      weightPolicy: "any",
    });
    expect(resolveLineupSelection("coder")).toMatchObject({
      roleProfile: "coding",
      capabilityTier: "strong",
      weightPolicy: "any",
    });
    expect(resolveLineupSelection("open-weights")).toMatchObject({
      roleProfile: "deep-reasoning",
      capabilityTier: "frontier",
      weightPolicy: "open-only",
      sourceTiers: ["flagship", "coder", "fast"],
    });
    expect(resolveLineupSelection("open-weights", "deep-reasoning", "open-only").sourceTiers).toEqual(["flagship"]);
    expect(modelRoleFitFor("flagship")).toEqual(["deep-reasoning", "judge"]);
    expect(capabilityTierFor("fast", "promoted")).toBe("efficient");
    expect(capabilityTierFor("coder", "shadow")).toBe("experimental");
  });

  test("applies open-weight policy inside the coding role", () => {
    const pool = [
      candidate({ id: "byok:closed-code", family: "gpt", tier: "coder", openWeights: false }),
      candidate({ id: "hf:open-code-a", family: "qwen", tier: "coder" }),
      candidate({ id: "hf:open-code-b", family: "kimi", tier: "coder" }),
      candidate({ id: "hf:open-code-c", family: "deepseek", tier: "coder" }),
      candidate({ id: "hf:open-code-d", family: "glm", tier: "coder" }),
    ];
    const lineup = pickLineup(pool, {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      roleProfile: "coding",
      weightPolicy: "open-only",
    });
    expect(lineup).toMatchObject({ roleProfile: "coding", capabilityTier: "strong", weightPolicy: "open-only" });
    expect([...lineup.proposers, lineup.aggregator]).not.toContain("byok:closed-code");
  });

  test("applies closed-weight policy inside the fast role", () => {
    const closed = ["gpt", "claude", "gemini", "grok"].map((family) => candidate({
      id: `byok:${family}-fast`,
      family,
      tier: "fast",
      openWeights: false,
      openWeightsEvidence: "explicit",
    }));
    const open = candidate({ id: "hf:qwen-fast", family: "qwen", tier: "fast" });
    const lineup = pickLineup([...closed, open], {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      roleProfile: "fast",
      weightPolicy: "closed-only",
    });
    expect(lineup).toMatchObject({ roleProfile: "fast", capabilityTier: "efficient", weightPolicy: "closed-only" });
    expect([...lineup.proposers, lineup.aggregator]).not.toContain("hf:qwen-fast");
    expect(weightPolicyBlockers(open, "closed-only")).toHaveLength(1);
  });

  test("uses judge evidence when selecting the judge role", () => {
    const pool = [
      candidate({ id: "hf:reasoner", family: "reasoner", benchmarkEvidence: benchmarkEvidence("reasoner", "reasoner", 99, 10) }),
      candidate({ id: "hf:judge-a", family: "judge-a", benchmarkEvidence: benchmarkEvidence("judge-a", "judge-a", 10, 99) }),
      candidate({ id: "hf:judge-b", family: "judge-b", benchmarkEvidence: benchmarkEvidence("judge-b", "judge-b", 20, 98) }),
      candidate({ id: "hf:judge-c", family: "judge-c", benchmarkEvidence: benchmarkEvidence("judge-c", "judge-c", 30, 97) }),
      candidate({ id: "hf:judge-d", family: "judge-d", benchmarkEvidence: benchmarkEvidence("judge-d", "judge-d", 40, 96) }),
    ];
    const lineup = pickLineup(pool, {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      roleProfile: "judge",
    });
    expect(lineup.proposers).toEqual(["hf:judge-a", "hf:judge-b", "hf:judge-c"]);
    expect(lineup).toMatchObject({ roleProfile: "judge", capabilityTier: "frontier", weightPolicy: "any" });
  });

  test("pickLineup with fast profile selects only fast-tier, vendor-diverse proposers", () => {
    const pool = [
      candidate({ id: "hf:glm-big", family: "glm", tier: "flagship", totalCost: 1 }),
      candidate({ id: "hf:glm-mini", family: "glm", tier: "fast", totalCost: 0.1, provider: "synthetic" }),
      candidate({ id: "hf:qwen-mini", family: "qwen", tier: "fast", totalCost: 0.2, provider: "synthetic" }),
      candidate({ id: "hf:kimi-mini", family: "kimi", tier: "fast", totalCost: 0.3, provider: "synthetic" }),
      candidate({ id: "hf:minimax-mini", family: "minimax", tier: "fast", totalCost: 0.4, provider: "synthetic" }),
    ];

    const lineup = pickLineup(pool, { proposerCount: 3, pinProposers: [], pinAggregator: null, profile: "fast" });

    expect(lineup.proposers).toEqual(["hf:glm-mini", "hf:qwen-mini", "hf:kimi-mini"]);
    expect(lineup.aggregator).toBe("hf:minimax-mini");
    expect(lineup.proposers).not.toContain("hf:glm-big");
  });

  test("pickLineup defaults to flagship when profile omitted (legacy callers)", () => {
    const pool = [
      candidate({ id: "hf:glm-big", family: "glm", tier: "flagship", totalCost: 1, provider: "synthetic" }),
      candidate({ id: "hf:kimi-big", family: "kimi", tier: "flagship", totalCost: 2, provider: "synthetic" }),
      candidate({ id: "hf:qwen-mini", family: "qwen", tier: "fast", totalCost: 0, provider: "synthetic" }),
      candidate({ id: "hf:deepseek-big", family: "deepseek", tier: "flagship", totalCost: 3, provider: "synthetic" }),
      candidate({ id: "hf:minimax-big", family: "minimax", tier: "flagship", totalCost: 4, provider: "synthetic" }),
    ];

    const lineup = pickLineup(pool, { proposerCount: 3, pinProposers: [], pinAggregator: null });

    expect(lineup.proposers).toEqual(["hf:glm-big", "hf:kimi-big", "hf:deepseek-big"]);
    expect(lineup.proposers).not.toContain("hf:qwen-mini");
  });

  test("open-weights profile excludes closed-vendor flagships from the panel", () => {
    const pool = [
      candidate({ id: "byok:claude-fable", family: "claude", tier: "flagship", totalCost: 0, openWeights: false, openWeightsEvidence: "explicit" }),
      candidate({ id: "hf:glm-big", family: "glm", tier: "flagship", totalCost: 1, provider: "synthetic" }),
      candidate({ id: "hf:kimi-big", family: "kimi", tier: "flagship", totalCost: 2, provider: "synthetic" }),
      candidate({ id: "hf:deepseek-big", family: "deepseek", tier: "flagship", totalCost: 3, provider: "synthetic" }),
      candidate({ id: "hf:qwen-big", family: "qwen", tier: "flagship", totalCost: 4, provider: "synthetic" }),
    ];

    const lineup = pickLineup(pool, { proposerCount: 3, pinProposers: [], pinAggregator: null, profile: "open-weights" });

    expect(lineup.proposers).toEqual(["hf:glm-big", "hf:kimi-big", "hf:deepseek-big"]);
    expect(lineup.aggregator).toBe("hf:qwen-big");
    expect([...lineup.proposers, lineup.aggregator]).not.toContain("byok:claude-fable");
  });

  test("open-weights profile fills a live panel from lower catalog tiers only after flagship capacity", () => {
    const pool = [
      candidate({ id: "hf:flagship-a", family: "flagship-a", tier: "flagship", totalCost: 9 }),
      candidate({ id: "hf:coder-a", family: "coder-a", tier: "coder", totalCost: 1 }),
      candidate({ id: "hf:coder-b", family: "coder-b", tier: "coder", totalCost: 2 }),
      candidate({ id: "hf:fast-a", family: "fast-a", tier: "fast", totalCost: 0 }),
      candidate({ id: "byok:closed-fast", family: "closed", tier: "fast", openWeights: false }),
    ];

    const lineup = pickLineup(pool, {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      profile: "open-weights",
    });

    expect(lineup.proposers).toEqual(["hf:flagship-a", "hf:coder-a", "hf:coder-b"]);
    expect(lineup.aggregator).toBe("hf:fast-a");
    expect(lineup.productionValid).toBe(true);
    expect(lineup.sourceTiers).toEqual(["flagship", "coder", "fast"]);
  });

  test("selection ordering preserves catalog tier priority before cost", () => {
    const sorted = sortCandidatesForSelection([
      candidate({ id: "hf:fast", family: "fast", tier: "fast", totalCost: 0 }),
      candidate({ id: "hf:coder", family: "coder", tier: "coder", totalCost: 0 }),
      candidate({ id: "hf:flagship", family: "flagship", tier: "flagship", totalCost: 99 }),
    ], ["flagship", "coder", "fast"]);
    expect(sorted.map((item) => item.id)).toEqual(["hf:flagship", "hf:coder", "hf:fast"]);
  });

  test("rehearsal admits cold-start-passed candidates but remains non-production", () => {
    const lineup = pickLineup([
      candidate({ id: "hf:aaa-cold", family: "aaa", lifecycleStatus: "cold-start-passed", totalCost: 0, provider: "synthetic" }),
      candidate({ id: "hf:bbb-promoted", family: "bbb", totalCost: 1, provider: "synthetic" }),
    ], { proposerCount: 1, pinProposers: [], pinAggregator: null, profile: "open-weights", mode: "rehearsal" });

    expect(lineup.proposers).toEqual(["hf:aaa-cold"]);
    expect(lineup.aggregator).toBe("hf:bbb-promoted");
    expect(lineup.readiness).toBe("rehearsal");
    expect(lineup.productionValid).toBe(false);
    expect(shouldPersistLineup(true, lineup)).toBe(false);
    expect(openWeightsBlockers(candidate({ lifecycleStatus: "cold-start-passed" }), "rehearsal")).toEqual([]);
  });

  test("reports actionable thin-pool capacity blockers", () => {
    const lineup = pickLineup([
      candidate({ id: "hf:a", family: "a", provider: "synthetic" }),
      candidate({ id: "hf:b", family: "b", provider: "synthetic" }),
      candidate({ id: "hf:c", family: "c", provider: "synthetic" }),
    ], { proposerCount: 3, pinProposers: [], pinAggregator: null, profile: "open-weights" });

    expect(lineup.productionValid).toBe(false);
    expect(lineup.blockers).toContain("deep-reasoning/open-only pool needs one additional family for a distinct aggregator; available families=3");
  });

  test("thin profile reports fewer proposers than requested (no silent cross-tier fallback)", () => {
    const pool = [
      candidate({ id: "hf:kimi-dev", family: "kimi", tier: "coder", totalCost: 1, provider: "synthetic" }),
      candidate({ id: "hf:qwen-coder", family: "qwen", tier: "coder", totalCost: 2, provider: "synthetic" }),
      candidate({ id: "hf:glm-big", family: "glm", tier: "flagship", totalCost: 0, provider: "synthetic" }),
    ];

    const lineup = pickLineup(pool, { proposerCount: 3, pinProposers: [], pinAggregator: null, profile: "coder" });

    // only 2 coder families exist — picker must NOT borrow the flagship model to fill the slot
    expect(lineup.proposers.length).toBeLessThan(3);
    expect([...lineup.proposers, lineup.aggregator]).not.toContain("hf:glm-big");
    expect(lineup.blockers).toEqual([
      "coding/any pool has 2 distinct proposer families; need 3",
      "coding/any pool needs one additional family for a distinct aggregator; available families=2",
    ]);
  });

  test("allows cold-start-passed open-weight candidates only in non-production rehearsal", () => {
    const pool = [
      candidate({ id: "hf:rehearsal-glm", family: "glm", lifecycleStatus: "cold-start-passed" }),
      candidate({ id: "hf:rehearsal-kimi", family: "kimi", lifecycleStatus: "cold-start-passed" }),
      candidate({ id: "hf:rehearsal-qwen", family: "qwen", lifecycleStatus: "cold-start-passed" }),
      candidate({ id: "hf:rehearsal-minimax", family: "minimax", lifecycleStatus: "cold-start-passed" }),
    ];

    const rehearsal = pickLineup(pool, {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      profile: "open-weights",
      mode: "rehearsal",
    });
    expect(rehearsal.proposers).toHaveLength(3);
    expect(rehearsal.aggregator).toBe("hf:rehearsal-qwen");
    expect(rehearsal.readiness).toBe("rehearsal");
    expect(rehearsal.productionValid).toBe(false);
    expect(rehearsal.blockers).toEqual([]);

    const production = pickLineup(pool, {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      profile: "open-weights",
      mode: "production",
    });
    expect(production.productionValid).toBe(false);
    expect(production.proposers).toHaveLength(0);
  });

  test("lineupPathFor keeps the flagship singleton and namespaces other profiles", () => {
    expect(lineupPathFor()).toBe(lineupPathFor("flagship"));
    expect(lineupPathFor("flagship").endsWith("/.zouroboros/lineup.json")).toBe(true);
    expect(lineupPathFor("fast").endsWith("/.zouroboros/lineup.fast.json")).toBe(true);
    expect(lineupPathFor("open-weights").endsWith("/.zouroboros/lineup.open-weights.json")).toBe(true);
    expect(lineupPathForSelection("coding", "open-only").endsWith("/.zouroboros/lineup.coding.open.json")).toBe(true);
    expect(lineupPathForSelection("judge", "closed-only").endsWith("/.zouroboros/lineup.judge.closed.json")).toBe(true);
  });

  test("atomically adds the explicit profile to a legacy flagship artifact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineup-flagship-"));
    const artifactPath = path.join(dir, "lineup.json");
    fs.writeFileSync(artifactPath, JSON.stringify({
      valid: true,
      lineup: { proposers: ["one"], aggregator: "two", generatedAt: "now" },
      members: [],
      persistedAt: "now",
    }));

    try {
      expect(migrateLegacyFlagshipArtifact(() => artifactPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(artifactPath, "utf-8")).profile).toBe("flagship");
      expect(migrateLegacyFlagshipArtifact(() => artifactPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revalidates persisted members against current profile eligibility", () => {
    const pool = [
      candidate({ id: "hf:glm-fast", family: "glm", tier: "fast" }),
      candidate({ id: "hf:qwen-fast", family: "qwen", tier: "fast" }),
      candidate({ id: "hf:kimi-fast", family: "kimi", tier: "fast" }),
      candidate({ id: "hf:minimax-fast", family: "minimax", tier: "fast" }),
    ];
    const persisted: PersistedLineup = {
      valid: true,
      profile: "fast",
      lineup: {
        proposers: ["hf:glm-fast", "hf:qwen-fast", "hf:kimi-fast"],
        aggregator: "hf:minimax-fast",
        generatedAt: "now",
        catalogSnapshot: [],
        pinned: false,
      },
      members: [],
      persistedAt: "now",
    };

    expect(validatePersistedLineup("fast", persisted, pool, new Set())).toEqual({
      valid: true,
      errors: [],
    });
    expect(validatePersistedLineup("fast", persisted, pool, new Set(["hf:qwen-fast"]))).toMatchObject({
      valid: false,
      errors: ["ineligible lineup id: hf:qwen-fast"],
    });
    expect(validatePersistedLineup("flagship", persisted, pool, new Set()).errors).toContain(
      "artifact profile mismatch: expected flagship, got fast",
    );
    expect(validatePersistedLineup(
      "fast",
      { ...persisted, lineup: null } as unknown as PersistedLineup,
      pool,
      new Set(),
    )).toMatchObject({ valid: false, errors: ["artifact lineup is malformed"] });
  });

  test("rejects rehearsal and unhealthy members during open-weight artifact readback", () => {
    const pool = [
      candidate({ id: "hf:artifact-glm", family: "glm" }),
      candidate({ id: "hf:artifact-kimi", family: "kimi", routeHealth: "failing" }),
      candidate({ id: "hf:artifact-qwen", family: "qwen" }),
      candidate({ id: "hf:artifact-minimax", family: "minimax" }),
    ];
    const persisted: PersistedLineup = {
      valid: true,
      profile: "open-weights",
      lineup: {
        proposers: ["hf:artifact-glm", "hf:artifact-kimi", "hf:artifact-qwen"],
        aggregator: "hf:artifact-minimax",
        generatedAt: "now",
        catalogSnapshot: [],
        pinned: false,
        readiness: "rehearsal",
        productionValid: false,
      },
      members: [],
      persistedAt: "now",
    };

    const result = validatePersistedLineup("open-weights", persisted, pool, new Set());
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("rehearsal artifact cannot be production-valid");
    expect(result.errors).toContain("artifact productionValid=false");
    expect(result.errors).toContain("persisted lineup member blocked: hf:artifact-kimi: route health=failing");
  });
});
