import { describe, expect, test } from "bun:test";
import type { FactoryControlOutcome } from "../../../packages/capability-runtime/src/index";
import type { GameHarnessPreflightResult } from "../game-gauntlet/scripts/game-harness-preflight";
import type { GameManifestPreflightResult } from "../game-gauntlet/scripts/game-manifest-preflight";
import type { GameScorePreflightResult } from "../game-gauntlet/scripts/game-score-preflight";
import type { GameSeedPreflightResult } from "../game-gauntlet/scripts/game-seed-preflight";
import type { ProductPreflightResult } from "./product-lifecycle-gate";
import {
  coerceTicketArray,
  dispatchTickets,
  type DispatchResult,
  type DispatcherDeps,
  type IntakeTicket,
} from "./dispatcher";

const ticket: IntakeTicket = {
  linear_id: "linear-zou-1514",
  identifier: "ZOU-1514",
  title: "Factory control canary fixture",
  description: "## Acceptance Criteria\nRoute one exact canary ticket",
  url: "https://linear.app/example/ZOU-1514",
  state: "In Progress",
  labels: ["factory-ready"],
  created_at: "2026-08-24T00:00:00Z",
  updated_at: "2026-08-24T00:00:00Z",
};

test("Hermes-shaped input is rejected before dispatcher preflights or state effects", async () => {
  const hermes = { ...ticket, source: "hermes", factory_work_id: `fw_${"a".repeat(64)}`, dispatch_eligible: false };
  expect(() => coerceTicketArray([hermes])).toThrow("LINEAR_TICKET_REQUIRED");
  let preflightCalls = 0;
  await expect(dispatchTickets([hermes as IntakeTicket], {
    productPreflight: async () => { preflightCalls++; return productPreflight(); },
  })).rejects.toThrow("LINEAR_TICKET_REQUIRED");
  expect(preflightCalls).toBe(0);
  expect(coerceTicketArray({ valid: [ticket], rejected: [] })).toEqual([ticket]);
});

const routeResult: DispatchResult = {
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
  evaluated_at: "2026-08-24T00:00:00Z",
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

const gameScorePreflight = async (): Promise<GameScorePreflightResult> => ({
  mode: "off",
  allowed: true,
  reportPath: null,
  report: null,
  reason: "disabled",
});

function deps(factoryControl: DispatcherDeps["factoryControl"]): Partial<DispatcherDeps> {
  return {
    productPreflight,
    gameSeedPreflight,
    gameManifestPreflight,
    gameHarnessPreflight,
    gameScorePreflight,
    swarmGate: () => ({ ...routeResult }),
    factoryControl,
  };
}

function controlOutcome(
  mode: FactoryControlOutcome<DispatchResult>["mode"],
  hostEffect: FactoryControlOutcome<DispatchResult>["host_effect"],
  decision: FactoryControlOutcome<DispatchResult>["decision"],
): FactoryControlOutcome<DispatchResult> {
  return {
    mode,
    decision,
    enforced: mode === "canary",
    reason_codes: decision === "permit" ? [] : ["fixture_hold"],
    action_id: "action-fixture",
    action_state: decision === "permit" ? "applied" : "awaiting_approval",
    dispatch_boundary: decision === "permit" ? "provider_confirmed" : "not_dispatched",
    host_effect: hostEffect,
  };
}

describe("dispatcher Factory control path", () => {
  test("a canary hold occurs before the route result is exposed downstream", async () => {
    let continuationCalls = 0;
    const batch = await dispatchTickets([ticket], deps(async (_input, continuation) => {
      expect(continuationCalls).toBe(0);
      void continuation;
      return controlOutcome("canary", "not_performed", "hold");
    }));
    expect(continuationCalls).toBe(0);
    expect(batch.results).toEqual([]);
    expect(batch.counts.DIRECT).toBe(0);
  });

  test("shadow records a would-decision while preserving the current host result", async () => {
    let continuationCalls = 0;
    const batch = await dispatchTickets([ticket], deps(async (_input, continuation) => {
      const value = continuation();
      continuationCalls++;
      return { ...controlOutcome("shadow", "performed", "hold"), value: await value };
    }));
    expect(continuationCalls).toBe(1);
    expect(batch.results).toHaveLength(1);
    expect(batch.results[0]?.decision).toBe("DIRECT");
    expect(batch.counts.DIRECT).toBe(1);
  });

  test("an already-applied canary cycle does not expose or execute a duplicate result", async () => {
    let hostCalls = 0;
    const batch = await dispatchTickets([ticket], deps(async (_input, continuation) => {
      void continuation;
      return controlOutcome("canary", "already_applied", "permit");
    }));
    expect(hostCalls).toBe(0);
    expect(batch.results).toEqual([]);
    expect(batch.counts.DIRECT).toBe(0);
  });
});
