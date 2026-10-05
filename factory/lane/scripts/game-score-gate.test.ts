import { describe, expect, test } from "bun:test";
import { dispatchTickets, type DispatchResult, type IntakeTicket } from "./dispatcher";
import {
  AXIOM_VEIL_COMPARABLE_ROUND,
  AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE,
  AXIOM_VEIL_UNRELATED_HISTORY_FIXTURE,
  AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE,
  evaluateScoreReport,
  type ScoreReportInput,
} from "../game-gauntlet/scripts/game-score-lineage";
import type { GameScorePreflightResult } from "../game-gauntlet/scripts/game-score-preflight";
import type { GameHarnessPreflightResult } from "../game-gauntlet/scripts/game-harness-preflight";
import type { GameManifestPreflightResult } from "../game-gauntlet/scripts/game-manifest-preflight";
import type { GameSeedPreflightResult } from "../game-gauntlet/scripts/game-seed-preflight";
import type { ProductPreflightResult } from "./product-lifecycle-gate";

const ticket: IntakeTicket = {
  linear_id: "linear-score",
  identifier: "ZOU-SCORE",
  title: "Report a visual delta for the game candidate",
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

const gameHarnessPreflight = async (): Promise<GameHarnessPreflightResult> => ({
  mode: "off",
  allowed: true,
  certificationPath: null,
  decision: null,
  reason: "disabled",
});

const DISABLED: GameScorePreflightResult = {
  mode: "off",
  allowed: true,
  reportPath: null,
  report: null,
  reason: "disabled",
};

function preflight(result: GameScorePreflightResult) {
  return async () => result;
}

function enforced(input: ScoreReportInput): GameScorePreflightResult {
  const report = evaluateScoreReport(input);
  return {
    mode: "enforce",
    allowed: report.valid,
    reportPath: "/game/score-report.json",
    report,
    reason: report.valid ? "comparable" : "invalid-score-lineage",
  };
}

function dispatch(gameScorePreflight: () => Promise<GameScorePreflightResult>, onGate: () => void) {
  return dispatchTickets([ticket], {
    productPreflight,
    gameSeedPreflight,
    gameManifestPreflight,
    gameHarnessPreflight,
    gameScorePreflight,
    swarmGate: () => {
      onGate();
      return { ...gateResult };
    },
  });
}

describe("dispatcher game score gate", () => {
  test("preserves routing when the gate is disabled", async () => {
    let gateCalls = 0;
    const batch = await dispatch(preflight(DISABLED), () => gateCalls++);
    expect(gateCalls).toBe(1);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_score_gate).toBeUndefined();
  });

  test("stops dispatch on every invalid-lineage fixture", async () => {
    const fixtures: ScoreReportInput[] = [
      AXIOM_VEIL_COMPOSITE_SUBSTITUTION_FIXTURE,
      AXIOM_VEIL_UNRESCORED_LINEAGE_FIXTURE,
      AXIOM_VEIL_UNRELATED_HISTORY_FIXTURE,
    ];
    for (const fixture of fixtures) {
      const result = enforced(fixture);
      expect(result.allowed).toBe(false);
      expect(result.report?.terminalState).toBe("INVALID_EVIDENCE");
      expect(result.report?.reportableDeltas).toEqual([]);

      let gateCalls = 0;
      const batch = await dispatch(preflight(result), () => gateCalls++);
      expect(gateCalls).toBe(0);
      expect(batch.results).toEqual([]);
      expect(batch.counts).toEqual({ DIRECT: 0, SWARM: 0, FORCE_SWARM: 0, SUGGEST: 0, ERROR: 0 });
    }
  });

  test("routes and records the report when the lineage is comparable", async () => {
    const passing = enforced(AXIOM_VEIL_COMPARABLE_ROUND);
    expect(passing.allowed).toBe(true);
    const batch = await dispatch(preflight(passing), () => {});
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.game_score_gate).toEqual(passing);
    expect(batch.results[0]?.game_score_gate?.report?.closure.derivedFrom).toBe("hard-lane-status");
    expect(batch.results[0]?.game_score_gate?.report?.promotionBlocked).toBe(true);
  });
});
