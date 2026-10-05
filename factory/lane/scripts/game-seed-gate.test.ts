import { describe, expect, test } from "bun:test";
import { dispatchTickets, type DispatchResult, type IntakeTicket } from "./dispatcher";
import type { GameSeedPreflightResult } from "../game-gauntlet/scripts/game-seed-preflight";
import type { ProductPreflightResult } from "./product-lifecycle-gate";

const ticket: IntakeTicket = {
  linear_id: "linear-game",
  identifier: "ZOU-GAME",
  title: "Build game slice",
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

function preflight(result: GameSeedPreflightResult) {
  return async () => result;
}

describe("dispatcher game seed gate", () => {
  test("preserves routing when the gate is disabled", async () => {
    let gateCalls = 0;
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight: preflight({ mode: "off", allowed: true, contractPath: null, decisions: [], reason: "disabled" }),
      swarmGate: () => {
        gateCalls++;
        return { ...gateResult };
      },
    });
    expect(gateCalls).toBe(1);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_seed_gate).toBeUndefined();
  });

  test("prevents decision-gate routing when the game seed contract is invalid", async () => {
    let gateCalls = 0;
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight: preflight({
        mode: "enforce",
        allowed: false,
        contractPath: "/game/seed.json",
        decisions: [],
        reason: "contract-invalid",
      }),
      swarmGate: () => {
        gateCalls++;
        return { ...gateResult };
      },
    });
    expect(gateCalls).toBe(0);
    expect(batch.results).toEqual([]);
    expect(batch.counts).toEqual({ DIRECT: 0, SWARM: 0, FORCE_SWARM: 0, SUGGEST: 0, ERROR: 0 });
  });

  test("routes and records evidence when the game seed contract passes", async () => {
    const passing: GameSeedPreflightResult = {
      mode: "enforce",
      allowed: true,
      contractPath: "/game/seed.json",
      decisions: [],
      reason: "valid",
    };
    const batch = await dispatchTickets([ticket], {
      productPreflight,
      gameSeedPreflight: preflight(passing),
      swarmGate: () => ({ ...gateResult }),
    });
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_seed_gate).toEqual(passing);
  });
});
