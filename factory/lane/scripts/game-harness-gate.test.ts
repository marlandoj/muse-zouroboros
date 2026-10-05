import { describe, expect, test } from "bun:test";
import { dispatchTickets, type DispatchResult, type IntakeTicket } from "./dispatcher";
import {
  AXIOM_VEIL_CERTIFIED_HARNESS,
  AXIOM_VEIL_FROZEN_TITLE_FIXTURE,
  AXIOM_VEIL_STALE_CONTROLS_FIXTURE,
  certifyHarness,
} from "../game-gauntlet/scripts/game-harness-certification";
import type { GameHarnessPreflightResult } from "../game-gauntlet/scripts/game-harness-preflight";
import type { GameManifestPreflightResult } from "../game-gauntlet/scripts/game-manifest-preflight";
import type { GameSeedPreflightResult } from "../game-gauntlet/scripts/game-seed-preflight";
import type { ProductPreflightResult } from "./product-lifecycle-gate";

const ticket: IntakeTicket = {
  linear_id: "linear-game",
  identifier: "ZOU-GAME",
  title: "Score a game candidate with the browser harness",
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

const gameManifestPreflight = async (): Promise<GameManifestPreflightResult> => ({
  mode: "off",
  allowed: true,
  roundPath: null,
  decision: null,
  reason: "disabled",
});

function preflight(result: GameHarnessPreflightResult) {
  return async () => result;
}

const DISABLED: GameHarnessPreflightResult = {
  mode: "off",
  allowed: true,
  certificationPath: null,
  decision: null,
  reason: "disabled",
};

function blockedBy(input: typeof AXIOM_VEIL_CERTIFIED_HARNESS): GameHarnessPreflightResult {
  return {
    mode: "enforce",
    allowed: false,
    certificationPath: "/game/harness-certification.json",
    decision: certifyHarness(input),
    reason: "harness-not-certified",
  };
}

describe("dispatcher game harness gate", () => {
  test("preserves routing when the gate is disabled", async () => {
    let gateCalls = 0;
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight,
      gameManifestPreflight,
      gameHarnessPreflight: preflight(DISABLED),
      swarmGate: () => {
        gateCalls++;
        return { ...gateResult };
      },
    });
    expect(gateCalls).toBe(1);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_harness_gate).toBeUndefined();
  });

  test("suppresses critic dispatch when the harness is not certified", async () => {
    for (const fixture of [AXIOM_VEIL_FROZEN_TITLE_FIXTURE, AXIOM_VEIL_STALE_CONTROLS_FIXTURE]) {
      const result = blockedBy(fixture);
      expect(result.decision?.verdict).toBe("HARNESS_NOT_CERTIFIED");
      expect(result.decision?.terminalState).toBe("BLOCKED");

      let gateCalls = 0;
      const batch = await dispatchTickets([ticket], {
        productPreflight,
        gameSeedPreflight,
        gameManifestPreflight,
        gameHarnessPreflight: preflight(result),
        swarmGate: () => {
          gateCalls++;
          return { ...gateResult };
        },
      });
      expect(gateCalls).toBe(0);
      expect(batch.results).toEqual([]);
      expect(batch.counts).toEqual({ DIRECT: 0, SWARM: 0, FORCE_SWARM: 0, SUGGEST: 0, ERROR: 0 });
    }
  });

  test("routes and records the certification when every preflight passes", async () => {
    const passing: GameHarnessPreflightResult = {
      mode: "enforce",
      allowed: true,
      certificationPath: "/game/harness-certification.json",
      decision: certifyHarness(AXIOM_VEIL_CERTIFIED_HARNESS),
      reason: "certified",
    };
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight,
      gameManifestPreflight,
      gameHarnessPreflight: preflight(passing),
      swarmGate: () => ({ ...gateResult }),
    });
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_harness_gate).toEqual(passing);
    expect(batch.results[0]?.game_harness_gate?.decision?.scoresSuppressed).toBe(false);
    expect(batch.results[0]?.game_harness_gate?.decision?.runtimeIdentity.renderer.length).toBeGreaterThan(0);
  });
});
