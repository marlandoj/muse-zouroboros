import { describe, expect, test } from "bun:test";
import type { Candidate } from "./lineup-picker";
import {
  buildZourobenchLineupRoster,
  type RosterAssignment,
} from "./zourobench-lineup-roster";

function candidate(overrides: Partial<Candidate> & Pick<Candidate, "id" | "canonicalModel" | "family">): Candidate {
  return {
    label: overrides.id,
    tier: "flagship",
    provider: "openrouter",
    promptCost: 1,
    completionCost: 1,
    totalCost: 2,
    subscription: false,
    lifecycleStatus: "promoted",
    routeHealth: "healthy",
    ...overrides,
  };
}

describe("ZouroBench lineup roster", () => {
  test("deduplicates provider routes by canonical model and prefers active healthy routes", () => {
    const candidates = [
      candidate({ id: "or:z-ai/glm-5.2", canonicalModel: "glm-5.2", family: "glm" }),
      candidate({
        id: "hf:zai-org/GLM-5.2",
        canonicalModel: "glm-5.2",
        family: "glm",
        provider: "synthetic",
        routeHealth: "failing",
      }),
    ];
    const assignments: RosterAssignment[] = [
      { id: "or:z-ai/glm-5.2", profile: "flagship", role: "aggregator", source: "active-lineup" },
      { id: "hf:zai-org/GLM-5.2", profile: "open-weights", role: "proposer", source: "promotion-target" },
    ];

    const roster = buildZourobenchLineupRoster({ candidates, assignments, generatedAt: "2026-08-04T00:00:00.000Z" });
    expect(roster.models).toHaveLength(1);
    expect(roster.models[0]).toMatchObject({
      canonicalModel: "glm-5.2",
      benchmarkRoute: "or:z-ai/glm-5.2",
      profiles: ["flagship", "open-weights"],
      roles: ["aggregator", "proposer"],
      benchmarkStatus: "missing",
    });
  });

  test("queues supported roles, preserves qualified evidence, and holds coder-only models", () => {
    const qualified = candidate({
      id: "or:moonshotai/kimi-k3",
      canonicalModel: "kimi-k3",
      family: "kimi",
      benchmarkEvidence: {
        benchmark: "ZouroBench",
        canonicalModel: "kimi-k3",
        family: "kimi",
        cohortId: "kimi",
        replicates: 5,
        requiredReplicates: 5,
        observedAt: "2026-08-04T00:00:00.000Z",
        contextFingerprint: "ctx",
        sourceModelIds: ["or:moonshotai/kimi-k3"],
        overall: { mean: 95, selectionFloor: 93, standardDeviation: 1 },
        roles: { proposer: { mean: 95, selectionFloor: 93, standardDeviation: 1 } },
      },
    });
    const coder = candidate({
      id: "oc:gpt-5.3-codex",
      canonicalModel: "gpt-5.3-codex",
      family: "gpt",
      tier: "coder",
      provider: "opencode",
    });
    const assignments: RosterAssignment[] = [
      { id: qualified.id, profile: "flagship", role: "proposer", source: "active-lineup" },
      { id: coder.id, profile: "coder", role: "coder", source: "promotion-target" },
    ];

    const roster = buildZourobenchLineupRoster({
      candidates: [qualified, coder],
      assignments,
      unresolvedTargets: ["or:missing/model"],
    });
    expect(roster.summary).toEqual({
      models: 2,
      qualified: 1,
      queued: 0,
      unsupportedRoleOnly: 1,
      heldRoute: 0,
      unresolvedTargets: 1,
    });
    expect(roster.models.find((model) => model.canonicalModel === "gpt-5.3-codex"))
      .toMatchObject({ benchmarkEligible: false, benchmarkRunnable: false, benchmarkStatus: "unsupported-role" });
  });

  test("holds supported roles until the selected route is healthy", () => {
    const held = candidate({
      id: "or:deepseek/deepseek-r1-0528",
      canonicalModel: "deepseek-r1-0528",
      family: "deepseek",
      routeHealth: "unknown",
    });
    const roster = buildZourobenchLineupRoster({
      candidates: [held],
      assignments: [{
        id: held.id,
        profile: "flagship",
        role: "proposer",
        source: "promotion-target",
      }],
    });
    expect(roster.models[0]).toMatchObject({
      benchmarkEligible: true,
      benchmarkRunnable: false,
      benchmarkStatus: "held-route",
    });
  });
});
