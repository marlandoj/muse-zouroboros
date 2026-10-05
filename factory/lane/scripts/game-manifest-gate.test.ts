import { describe, expect, test } from "bun:test";
import { dispatchTickets, type DispatchResult, type IntakeTicket } from "./dispatcher";
import {
  AXIOM_VEIL_SOURCE_MUTATED_BUNDLE,
  AXIOM_VEIL_VALID_ROUND,
  gateCriticRound,
} from "../game-gauntlet/scripts/game-manifest-contract";
import type { GameManifestPreflightResult } from "../game-gauntlet/scripts/game-manifest-preflight";
import type { GameSeedPreflightResult } from "../game-gauntlet/scripts/game-seed-preflight";
import type { ProductPreflightResult } from "./product-lifecycle-gate";

const ticket: IntakeTicket = {
  linear_id: "linear-game",
  identifier: "ZOU-GAME",
  title: "Critique a frozen game candidate",
  description: "## Acceptance Criteria\nPass\n\n## Repro\nGame",
  url: "https://linear.app/example",
  state: "Backlog",
  labels: ["factory-ready"],
  created_at: "2026-08-13T00:00:00Z",
  updated_at: "2026-08-13T00:00:00Z",
};

const gateResult: DispatchResult = {
  ticket,
  decision: "DIRECT",
  score: 0.2,
  override: false,
  raw_exit: 2,
  reason: "direct fixture",
};

const productPreflight = async (): Promise<ProductPreflightResult> => ({
  phase: "pre_dispatch",
  mode: "off",
  applicability: "not_applicable",
  decision: "off",
  acted: false,
  reason_code: "disabled",
  archetype: "feature",
  evidence: {
    repo_path: null,
    path: null,
    source: "none",
    sha256: null,
    valid: false,
    reason: "disabled",
    ticket_source_hash: "fixture",
  },
  comment_posted: false,
  evaluated_at: "2026-08-13T00:00:00Z",
});

const gameSeedPreflight = async (): Promise<GameSeedPreflightResult> => ({
  mode: "off",
  allowed: true,
  contractPath: null,
  decisions: [],
  reason: "disabled",
});

function preflight(result: GameManifestPreflightResult) {
  return async () => result;
}

const DISABLED: GameManifestPreflightResult = {
  mode: "off",
  allowed: true,
  roundPath: null,
  decision: null,
  reason: "disabled",
};

describe("dispatcher game manifest gate", () => {
  test("preserves routing when the gate is disabled", async () => {
    let gateCalls = 0;
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight,
      gameManifestPreflight: preflight(DISABLED),
      swarmGate: () => {
        gateCalls++;
        return { ...gateResult };
      },
    });
    expect(gateCalls).toBe(1);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_manifest_gate).toBeUndefined();
  });

  test("blocks dispatch when a governed hash changed under the critic lease", async () => {
    const mutated: GameManifestPreflightResult = {
      mode: "enforce",
      allowed: false,
      roundPath: "/game/round.json",
      decision: gateCriticRound({ ...AXIOM_VEIL_VALID_ROUND, after: AXIOM_VEIL_SOURCE_MUTATED_BUNDLE }),
      reason: "invalid-evidence",
    };
    expect(mutated.decision?.terminalState).toBe("INVALID_EVIDENCE");

    let gateCalls = 0;
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight,
      gameManifestPreflight: preflight(mutated),
      swarmGate: () => {
        gateCalls++;
        return { ...gateResult };
      },
    });
    expect(gateCalls).toBe(0);
    expect(batch.results).toEqual([]);
    expect(batch.counts).toEqual({ DIRECT: 0, SWARM: 0, FORCE_SWARM: 0, SUGGEST: 0, ERROR: 0 });
  });

  test("routes and records evidence when every governed hash survived capture", async () => {
    const passing: GameManifestPreflightResult = {
      mode: "enforce",
      allowed: true,
      roundPath: "/game/round.json",
      decision: gateCriticRound(AXIOM_VEIL_VALID_ROUND),
      reason: "valid",
    };
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight,
      gameManifestPreflight: preflight(passing),
      swarmGate: () => ({ ...gateResult }),
    });
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_manifest_gate).toEqual(passing);
    expect(batch.results[0]?.game_manifest_gate?.decision?.promotionBlocked).toBe(false);
  });
});
