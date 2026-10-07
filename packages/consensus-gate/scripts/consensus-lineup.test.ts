import { describe, expect, test } from "bun:test";
import { resolveConsensusLineup } from "./consensus-lineup";

const persisted = {
  valid: true,
  lineup: {
    proposers: ["oc:a", "hf:b/C", "byok:d"],
    aggregator: "oc:judge",
    generatedAt: "2026-07-13T00:00:00.000Z",
    catalogSnapshot: [],
    pinned: false,
  },
  members: [],
  persistedAt: "2026-07-13T00:00:00.000Z",
  profile: "coder" as const,
  roleProfile: "coding" as const,
  capabilityTier: "strong" as const,
  weightPolicy: "any" as const,
};

const dependencies = {
  loadPersistedLineup: () => persisted,
  loadPersistedRoleLineup: () => persisted,
  getActiveModels: () => ["legacy"],
  warn: () => {},
};

describe("resolveConsensusLineup", () => {
  test("explicit models take precedence", () => {
    const result = resolveConsensusLineup(
      { CONSENSUS_MODELS: "oc:one, hf:two/Model" },
      dependencies,
    );
    expect(result).toEqual({ models: ["oc:one", "hf:two/Model"], source: "explicit" });
  });

  test("uses a valid persisted profile", () => {
    const result = resolveConsensusLineup(
      { GATE_LINEUP_PROFILE: "coder" },
      dependencies,
    );
    expect(result).toEqual({
      models: persisted.lineup.proposers,
      source: "persisted-profile",
      profile: "coder",
      roleProfile: "coding",
      weightPolicy: "any",
    });
  });

  test("loads an orthogonal role and weight-policy selection", () => {
    const result = resolveConsensusLineup(
      { GATE_LINEUP_ROLE: "coding", GATE_LINEUP_WEIGHT_POLICY: "open-only" },
      { ...dependencies, loadPersistedRoleLineup: () => ({ ...persisted, weightPolicy: "open-only" as const }) },
    );
    expect(result).toEqual({
      models: persisted.lineup.proposers,
      source: "persisted-profile",
      profile: undefined,
      roleProfile: "coding",
      weightPolicy: "open-only",
    });
  });

  test("falls back to the active default panel and warns on an unknown profile", () => {
    const warnings: string[] = [];
    const result = resolveConsensusLineup(
      { GATE_LINEUP_PROFILE: "unknown" },
      {
        loadPersistedLineup: () => null,
        loadPersistedRoleLineup: () => null,
        getActiveModels: () => ["legacy:a", "legacy:b"],
        warn: (message) => warnings.push(message),
      },
    );
    expect(result).toEqual({ models: ["legacy:a", "legacy:b"], source: "legacy" });
    expect(warnings).toHaveLength(1);
  });
});
