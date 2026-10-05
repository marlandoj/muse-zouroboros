import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OUTCOME_ROUTING_CONFIG,
  buildPromotedOutcomePolicy,
  compareShadowRecommendations,
  exactJoinId,
  joinOutcomeEvidence,
  resolvePromotedOutcomePolicy,
  scoreOutcomeCandidates,
  validateFallbackChain,
  wilson,
  type DispatchObservation,
  type ModelProfile,
  type OperatorChoice,
  type OutcomeObservation,
  type OutcomeRoutingConfig,
  type ShadowRecommendation,
} from "./outcome-routing-core";

const NOW = "2026-07-11T00:00:00.000Z";
const SINCE = "2026-07-10T00:00:00.000Z";

const CONFIG: OutcomeRoutingConfig = {
  ...DEFAULT_OUTCOME_ROUTING_CONFIG,
  min_samples: 10,
  min_first_pass_lower: 0.5,
  min_survival_lower: 0.5,
  min_combined_score: 0.02,
  min_shadow_samples: 10,
  min_shadow_agreement_lower: 0.5,
};

const CATALOG: ModelProfile[] = [
  { model_id: "alpha-model", provider: "alpha", risk_cap: "high" },
  { model_id: "beta-model", provider: "beta", risk_cap: "critical" },
  { model_id: "alpha-backup", provider: "alpha", risk_cap: "high" },
  { model_id: "low-only", provider: "gamma", risk_cap: "low" },
];

function identity(index: number) {
  return {
    execution_id: `exec-${index}`,
    assignment_id: `assignment-${index}`,
    ticket_id: `ZOU-${1000 + index}`,
  };
}

function dispatch(index: number, model = "alpha-model", provider = "alpha"): DispatchObservation {
  return {
    ...identity(index),
    route_key: "implementation",
    risk_tier: "medium",
    model_id: model,
    provider,
    selected_at: NOW,
  };
}

function outcome(index: number, overrides: Partial<OutcomeObservation> = {}): OutcomeObservation {
  return {
    ...identity(index),
    first_pass: true,
    cost_usd: 0.25,
    latency_ms: 120_000,
    survived: true,
    observed_at: NOW,
    ...overrides,
  };
}

describe("exact evidence joins and coverage", () => {
  test("requires the exact three-part identity and enforces >=95% new-run coverage", () => {
    const dispatches = Array.from({ length: 20 }, (_, index) => dispatch(index));
    const outcomes = Array.from({ length: 19 }, (_, index) => outcome(index));
    outcomes.push({ ...outcome(19), assignment_id: "wrong-assignment" });
    const report = joinOutcomeEvidence(dispatches, outcomes, { new_run_since: SINCE });

    expect(report.new_run_total).toBe(20);
    expect(report.new_run_joined).toBe(19);
    expect(report.new_run_coverage).toBe(0.95);
    expect(report.coverage_met).toBe(true);
    expect(report.unmatched_dispatch_ids).toEqual([exactJoinId(identity(19))]);
    expect(report.unmatched_outcome_ids).toHaveLength(1);

    const below = joinOutcomeEvidence(dispatches, outcomes.slice(0, 18), { new_run_since: SINCE });
    expect(below.new_run_coverage).toBe(0.9);
    expect(below.coverage_met).toBe(false);
  });

  test("rejects duplicate and incomplete evidence instead of inflating coverage", () => {
    const row = dispatch(1);
    const bad = outcome(1, { cost_usd: Number.NaN });
    const report = joinOutcomeEvidence([row, row], [bad], { new_run_since: SINCE });
    expect(report.joined).toHaveLength(0);
    expect(report.invalid).toContain(`duplicate dispatch ${exactJoinId(row)}`);
    expect(report.invalid).toContain(`incomplete outcome ${exactJoinId(bad)}`);
    expect(report.coverage_met).toBe(false);
  });
});

describe("evidence-bounded candidate scoring", () => {
  test("multiplies cost, first-pass, latency, and survivability with confidence bounds", () => {
    const dispatches: DispatchObservation[] = [];
    const outcomes: OutcomeObservation[] = [];
    for (let index = 0; index < 20; index++) {
      dispatches.push(dispatch(index));
      outcomes.push(outcome(index));
    }
    for (let index = 20; index < 40; index++) {
      dispatches.push(dispatch(index, "beta-model", "beta"));
      outcomes.push(outcome(index, {
        first_pass: index < 38,
        survived: index < 39,
        cost_usd: 0.8,
        latency_ms: 480_000,
      }));
    }
    dispatches.push(dispatch(40, "low-only", "gamma"));
    outcomes.push(outcome(40));
    const joined = joinOutcomeEvidence(dispatches, outcomes, { new_run_since: SINCE }).joined;
    const scores = scoreOutcomeCandidates(joined, CATALOG, CONFIG);
    const alpha = scores.find(score => score.model_id === "alpha-model")!;
    const beta = scores.find(score => score.model_id === "beta-model")!;
    const thin = scores.find(score => score.model_id === "low-only")!;

    expect(alpha.first_pass).toEqual(wilson(20, 20));
    expect(alpha.combined_score).toBeCloseTo(
      alpha.cost_usd.efficiency * alpha.first_pass.lower * alpha.latency_ms.efficiency * alpha.survivability.lower,
      5,
    );
    expect(alpha.combined_score).toBeGreaterThan(beta.combined_score);
    expect(alpha.eligible).toBe(true);
    expect(thin.eligible).toBe(false);
    expect(thin.reasons).toContain("samples 1/10");
    expect(thin.reasons).toContain("risk medium exceeds model cap low");
  });
});

describe("shadow comparison and chain safety", () => {
  test("compares shadow recommendations to exact operator choices with a lower bound", () => {
    const recommendations: ShadowRecommendation[] = Array.from({ length: 20 }, (_, index) => ({
      ...identity(index), route_key: "implementation", risk_tier: "medium",
      recommended_model_id: "alpha-model", recommended_at: NOW,
    }));
    const choices: OperatorChoice[] = Array.from({ length: 20 }, (_, index) => ({
      ...identity(index), model_id: index < 19 ? "alpha-model" : "beta-model", chosen_at: NOW,
    }));
    choices.push({ ...identity(99), model_id: "alpha-model", chosen_at: NOW });
    const comparison = compareShadowRecommendations(recommendations, choices, CONFIG);
    expect(comparison.compared).toBe(20);
    expect(comparison.matched).toBe(19);
    expect(comparison.agreement?.estimate).toBe(0.95);
    expect(comparison.agreement!.lower).toBeGreaterThan(0.5);
    expect(comparison.sufficient).toBe(true);
    expect(comparison.unmatched_operator_ids).toEqual([exactJoinId(identity(99))]);
  });

  test("rejects same-provider fallback chains and risk-cap violations", () => {
    expect(validateFallbackChain({
      risk_tier: "medium", primary_model_id: "alpha-model", fallback_model_ids: ["alpha-backup"],
    }, CATALOG)).toContain("provider alpha repeats in fallback chain");
    const errors = validateFallbackChain({
      risk_tier: "critical", primary_model_id: "alpha-model", fallback_model_ids: ["beta-model"],
    }, CATALOG);
    expect(errors).toContain("model alpha-model cap high cannot serve critical");
  });
});

describe("promoted policy resolver seam", () => {
  test("promotes only bounded evidence and resolves a validated cross-provider chain", () => {
    const dispatches: DispatchObservation[] = [];
    const outcomes: OutcomeObservation[] = [];
    for (let index = 0; index < 20; index++) {
      dispatches.push(dispatch(index));
      outcomes.push(outcome(index));
    }
    for (let index = 20; index < 40; index++) {
      dispatches.push(dispatch(index, "beta-model", "beta"));
      outcomes.push(outcome(index, { cost_usd: 0.5, latency_ms: 240_000 }));
    }
    const join = joinOutcomeEvidence(dispatches, outcomes, { new_run_since: SINCE });
    const candidates = scoreOutcomeCandidates(join.joined, CATALOG, CONFIG);
    const recommendations: ShadowRecommendation[] = Array.from({ length: 20 }, (_, index) => ({
      ...identity(index), route_key: "implementation", risk_tier: "medium",
      recommended_model_id: "alpha-model", recommended_at: NOW,
    }));
    const choices: OperatorChoice[] = recommendations.map(row => ({
      execution_id: row.execution_id, assignment_id: row.assignment_id, ticket_id: row.ticket_id,
      model_id: row.recommended_model_id, chosen_at: NOW,
    }));
    const shadow = compareShadowRecommendations(recommendations, choices, CONFIG);
    const promotion = buildPromotedOutcomePolicy({
      join_report: join,
      candidates,
      shadow,
      catalog: CATALOG,
      config: CONFIG,
      now: NOW,
    });
    expect(promotion.promoted).toBe(true);
    const resolution = resolvePromotedOutcomePolicy(
      { route_key: "implementation", risk_tier: "medium" },
      promotion.policy!,
      CATALOG,
    );
    expect(resolution).toMatchObject({
      source: "promoted-outcome-policy",
      model_id: "alpha-model",
      fallback_model_ids: ["beta-model"],
    });
    expect(resolvePromotedOutcomePolicy(
      { route_key: "research", risk_tier: "medium" }, promotion.policy!, CATALOG,
    )).toBeNull();
  });

  test("blocks promotion when coverage or shadow confidence is insufficient", () => {
    const join = joinOutcomeEvidence([dispatch(1), dispatch(2)], [outcome(1)], { new_run_since: SINCE });
    const result = buildPromotedOutcomePolicy({
      join_report: join,
      candidates: [],
      shadow: compareShadowRecommendations([], [], CONFIG),
      catalog: CATALOG,
      config: CONFIG,
      now: NOW,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons.some(reason => reason.includes("new-run coverage"))).toBe(true);
    expect(result.reasons).toContain("shadow/operator comparison below sample or confidence gate");
  });
});
