#!/usr/bin/env bun

export const RISK_TIERS = ["low", "medium", "high", "critical"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export interface JoinIdentity {
  execution_id: string;
  assignment_id: string;
  ticket_id: string;
}

export interface DispatchObservation extends JoinIdentity {
  route_key: string;
  risk_tier: RiskTier;
  model_id: string;
  provider: string;
  selected_at: string;
}

export interface OutcomeObservation extends JoinIdentity {
  first_pass: boolean;
  cost_usd: number;
  latency_ms: number;
  survived: boolean;
  observed_at: string;
}

export interface JoinedOutcome {
  dispatch: DispatchObservation;
  outcome: OutcomeObservation;
}

export interface JoinReport {
  joined: JoinedOutcome[];
  new_run_total: number;
  new_run_joined: number;
  new_run_coverage: number | null;
  coverage_required: number;
  coverage_met: boolean;
  unmatched_dispatch_ids: string[];
  unmatched_outcome_ids: string[];
  invalid: string[];
}

export interface OutcomeRoutingConfig {
  min_new_run_coverage: number;
  min_samples: number;
  confidence_z: number;
  cost_target_usd: number;
  latency_target_ms: number;
  min_combined_score: number;
  min_first_pass_lower: number;
  min_survival_lower: number;
  min_shadow_samples: number;
  min_shadow_agreement_lower: number;
}

export const DEFAULT_OUTCOME_ROUTING_CONFIG: OutcomeRoutingConfig = {
  min_new_run_coverage: 0.95,
  min_samples: 20,
  confidence_z: 1.96,
  cost_target_usd: 1,
  latency_target_ms: 600_000,
  min_combined_score: 0.08,
  min_first_pass_lower: 0.65,
  min_survival_lower: 0.75,
  min_shadow_samples: 20,
  min_shadow_agreement_lower: 0.5,
};

export interface ConfidenceBound {
  estimate: number;
  lower: number;
  upper: number;
}

export interface CandidateScore {
  route_key: string;
  risk_tier: RiskTier;
  model_id: string;
  provider: string;
  n: number;
  cost_usd: { mean: number; upper: number; efficiency: number };
  first_pass: ConfidenceBound;
  latency_ms: { mean: number; upper: number; efficiency: number };
  survivability: ConfidenceBound;
  combined_score: number;
  eligible: boolean;
  reasons: string[];
}

export interface ModelProfile {
  model_id: string;
  provider: string;
  risk_cap: RiskTier;
}

export interface ShadowRecommendation extends JoinIdentity {
  route_key: string;
  risk_tier: RiskTier;
  recommended_model_id: string;
  recommended_at: string;
}

export interface OperatorChoice extends JoinIdentity {
  model_id: string;
  chosen_at: string;
}

export interface ShadowComparison {
  compared: number;
  matched: number;
  agreement: ConfidenceBound | null;
  sufficient: boolean;
  unmatched_recommendation_ids: string[];
  unmatched_operator_ids: string[];
  invalid: string[];
}

export interface PromotedRoute {
  route_key: string;
  risk_tier: RiskTier;
  primary_model_id: string;
  fallback_model_ids: string[];
  evidence: {
    primary_score: number;
    primary_n: number;
    shadow_compared: number;
    shadow_agreement_lower: number;
  };
}

export interface PromotedOutcomePolicy {
  schema: "zouroboros.outcome-routing-policy.v1";
  promoted_at: string;
  new_run_coverage: number;
  routes: Record<string, PromotedRoute>;
}

export interface PromotionResult {
  promoted: boolean;
  policy: PromotedOutcomePolicy | null;
  reasons: string[];
}

export interface OutcomePolicyResolution {
  source: "promoted-outcome-policy";
  route_key: string;
  risk_tier: RiskTier;
  model_id: string;
  fallback_model_ids: string[];
  evidence: PromotedRoute["evidence"];
}

function round(value: number, places = 6): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function validId(value: string): boolean {
  return typeof value === "string" && value.trim() !== "" && !/[\x00-\x1f]/.test(value);
}

export function exactJoinId(identity: JoinIdentity): string {
  const fields: Array<[keyof JoinIdentity, string]> = [
    ["execution_id", identity.execution_id],
    ["assignment_id", identity.assignment_id],
    ["ticket_id", identity.ticket_id],
  ];
  for (const [field, value] of fields) {
    if (!validId(value)) throw new Error(`${field} must be a non-empty printable string`);
  }
  return JSON.stringify([identity.execution_id, identity.assignment_id, identity.ticket_id]);
}

function isCompleteOutcome(row: OutcomeObservation): boolean {
  return Number.isFinite(row.cost_usd)
    && row.cost_usd >= 0
    && Number.isFinite(row.latency_ms)
    && row.latency_ms >= 0
    && !Number.isNaN(Date.parse(row.observed_at));
}

export function joinOutcomeEvidence(
  dispatches: DispatchObservation[],
  outcomes: OutcomeObservation[],
  options: { new_run_since: string; min_coverage?: number },
): JoinReport {
  const coverageRequired = options.min_coverage ?? DEFAULT_OUTCOME_ROUTING_CONFIG.min_new_run_coverage;
  if (coverageRequired < 0.95 || coverageRequired > 1) {
    throw new Error("min_coverage must be within [0.95, 1]");
  }
  const since = Date.parse(options.new_run_since);
  if (Number.isNaN(since)) throw new Error("new_run_since must be ISO-8601");

  const invalid: string[] = [];
  const dispatchById = new Map<string, DispatchObservation>();
  const outcomeById = new Map<string, OutcomeObservation>();
  for (const row of dispatches) {
    try {
      const id = exactJoinId(row);
      if (dispatchById.has(id)) invalid.push(`duplicate dispatch ${id}`);
      else if (Number.isNaN(Date.parse(row.selected_at))) invalid.push(`invalid selected_at ${id}`);
      else dispatchById.set(id, row);
    } catch (error) {
      invalid.push(`invalid dispatch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const row of outcomes) {
    try {
      const id = exactJoinId(row);
      if (outcomeById.has(id)) invalid.push(`duplicate outcome ${id}`);
      else if (!isCompleteOutcome(row)) invalid.push(`incomplete outcome ${id}`);
      else outcomeById.set(id, row);
    } catch (error) {
      invalid.push(`invalid outcome: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const joined: JoinedOutcome[] = [];
  const unmatchedDispatchIds: string[] = [];
  for (const [id, dispatch] of dispatchById) {
    const outcome = outcomeById.get(id);
    if (outcome) joined.push({ dispatch, outcome });
    else unmatchedDispatchIds.push(id);
  }
  const unmatchedOutcomeIds = [...outcomeById.keys()].filter(id => !dispatchById.has(id));
  const newIds = [...dispatchById.entries()].filter(([, row]) => Date.parse(row.selected_at) >= since).map(([id]) => id);
  const newJoined = newIds.filter(id => outcomeById.has(id)).length;
  const coverage = newIds.length === 0 ? null : newJoined / newIds.length;
  return {
    joined: joined.sort((a, b) => exactJoinId(a.dispatch).localeCompare(exactJoinId(b.dispatch))),
    new_run_total: newIds.length,
    new_run_joined: newJoined,
    new_run_coverage: coverage === null ? null : round(coverage),
    coverage_required: coverageRequired,
    coverage_met: coverage !== null && coverage >= coverageRequired,
    unmatched_dispatch_ids: unmatchedDispatchIds.sort(),
    unmatched_outcome_ids: unmatchedOutcomeIds.sort(),
    invalid: invalid.sort(),
  };
}

export function wilson(successes: number, n: number, z = 1.96): ConfidenceBound {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n < 1 || successes < 0 || successes > n) {
    throw new Error("Wilson inputs require 0 <= integer successes <= integer n, n >= 1");
  }
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    estimate: round(p),
    lower: round(Math.max(0, (center - margin) / denominator)),
    upper: round(Math.min(1, (center + margin) / denominator)),
  };
}

function meanUpper(values: number[], z: number): { mean: number; upper: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return { mean: round(mean), upper: round(mean) };
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  const upper = mean + z * Math.sqrt(variance / values.length);
  return { mean: round(mean), upper: round(Math.max(mean, upper)) };
}

function efficiency(upper: number, target: number): number {
  return round(target / (target + Math.max(0, upper)));
}

function riskRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

export function riskAllowed(taskRisk: RiskTier, profile: ModelProfile): boolean {
  return riskRank(taskRisk) <= riskRank(profile.risk_cap);
}

export function scoreOutcomeCandidates(
  joined: JoinedOutcome[],
  catalog: ModelProfile[],
  config: OutcomeRoutingConfig = DEFAULT_OUTCOME_ROUTING_CONFIG,
): CandidateScore[] {
  const profiles = new Map(catalog.map(profile => [profile.model_id, profile]));
  const groups = new Map<string, JoinedOutcome[]>();
  for (const row of joined) {
    const key = JSON.stringify([row.dispatch.route_key, row.dispatch.risk_tier, row.dispatch.model_id]);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  const scores: CandidateScore[] = [];
  for (const rows of groups.values()) {
    const first = rows[0].dispatch;
    const profile = profiles.get(first.model_id);
    const costs = meanUpper(rows.map(row => row.outcome.cost_usd), config.confidence_z);
    const latencies = meanUpper(rows.map(row => row.outcome.latency_ms), config.confidence_z);
    const firstPass = wilson(rows.filter(row => row.outcome.first_pass).length, rows.length, config.confidence_z);
    const survival = wilson(rows.filter(row => row.outcome.survived).length, rows.length, config.confidence_z);
    const costEfficiency = efficiency(costs.upper, config.cost_target_usd);
    const latencyEfficiency = efficiency(latencies.upper, config.latency_target_ms);
    const combined = round(costEfficiency * firstPass.lower * latencyEfficiency * survival.lower);
    const reasons: string[] = [];
    if (!profile) reasons.push("model missing from catalog");
    else {
      if (profile.provider !== first.provider) reasons.push(`provider mismatch: dispatch=${first.provider} catalog=${profile.provider}`);
      if (!riskAllowed(first.risk_tier, profile)) reasons.push(`risk ${first.risk_tier} exceeds model cap ${profile.risk_cap}`);
    }
    if (rows.length < config.min_samples) reasons.push(`samples ${rows.length}/${config.min_samples}`);
    if (firstPass.lower < config.min_first_pass_lower) reasons.push(`first-pass lower ${firstPass.lower} < ${config.min_first_pass_lower}`);
    if (survival.lower < config.min_survival_lower) reasons.push(`survival lower ${survival.lower} < ${config.min_survival_lower}`);
    if (combined < config.min_combined_score) reasons.push(`combined ${combined} < ${config.min_combined_score}`);
    scores.push({
      route_key: first.route_key,
      risk_tier: first.risk_tier,
      model_id: first.model_id,
      provider: first.provider,
      n: rows.length,
      cost_usd: { ...costs, efficiency: costEfficiency },
      first_pass: firstPass,
      latency_ms: { ...latencies, efficiency: latencyEfficiency },
      survivability: survival,
      combined_score: combined,
      eligible: reasons.length === 0,
      reasons,
    });
  }
  return scores.sort((a, b) => a.route_key.localeCompare(b.route_key)
    || riskRank(a.risk_tier) - riskRank(b.risk_tier)
    || b.combined_score - a.combined_score
    || a.model_id.localeCompare(b.model_id));
}

export function compareShadowRecommendations(
  recommendations: ShadowRecommendation[],
  choices: OperatorChoice[],
  config: OutcomeRoutingConfig = DEFAULT_OUTCOME_ROUTING_CONFIG,
): ShadowComparison {
  const invalid: string[] = [];
  const choiceById = new Map<string, OperatorChoice>();
  for (const choice of choices) {
    const id = exactJoinId(choice);
    if (choiceById.has(id)) invalid.push(`duplicate operator choice ${id}`);
    else choiceById.set(id, choice);
  }
  const recommendationById = new Map<string, ShadowRecommendation>();
  for (const recommendation of recommendations) {
    const id = exactJoinId(recommendation);
    if (recommendationById.has(id)) invalid.push(`duplicate shadow recommendation ${id}`);
    else recommendationById.set(id, recommendation);
  }
  let matched = 0;
  const unmatchedRecommendations: string[] = [];
  for (const [id, recommendation] of recommendationById) {
    const choice = choiceById.get(id);
    if (!choice) unmatchedRecommendations.push(id);
    else if (choice.model_id === recommendation.recommended_model_id) matched++;
  }
  const recommendationIds = new Set(recommendationById.keys());
  const unmatchedChoices = [...choiceById.keys()].filter(id => !recommendationIds.has(id));
  const compared = recommendationById.size - unmatchedRecommendations.length;
  const agreement = compared === 0 ? null : wilson(matched, compared, config.confidence_z);
  return {
    compared,
    matched,
    agreement,
    sufficient: invalid.length === 0
      && compared >= config.min_shadow_samples
      && agreement !== null
      && agreement.lower >= config.min_shadow_agreement_lower,
    unmatched_recommendation_ids: unmatchedRecommendations.sort(),
    unmatched_operator_ids: unmatchedChoices.sort(),
    invalid: invalid.sort(),
  };
}

function routeId(routeKey: string, riskTier: RiskTier): string {
  return JSON.stringify([routeKey, riskTier]);
}

export function validateFallbackChain(
  route: Pick<PromotedRoute, "risk_tier" | "primary_model_id" | "fallback_model_ids">,
  catalog: ModelProfile[],
): string[] {
  const profiles = new Map(catalog.map(profile => [profile.model_id, profile]));
  const ids = [route.primary_model_id, ...route.fallback_model_ids];
  const errors: string[] = [];
  if (route.fallback_model_ids.length === 0) errors.push("at least one fallback is required");
  if (new Set(ids).size !== ids.length) errors.push("model IDs must be unique across the chain");
  const providers = new Set<string>();
  for (const id of ids) {
    const profile = profiles.get(id);
    if (!profile) {
      errors.push(`unknown model ${id}`);
      continue;
    }
    if (!riskAllowed(route.risk_tier, profile)) errors.push(`model ${id} cap ${profile.risk_cap} cannot serve ${route.risk_tier}`);
    if (providers.has(profile.provider)) errors.push(`provider ${profile.provider} repeats in fallback chain`);
    providers.add(profile.provider);
  }
  if (providers.size < 2) errors.push("fallback chain must span at least two providers");
  return [...new Set(errors)].sort();
}

export function buildPromotedOutcomePolicy(input: {
  join_report: JoinReport;
  candidates: CandidateScore[];
  shadow: ShadowComparison;
  catalog: ModelProfile[];
  config?: OutcomeRoutingConfig;
  now?: string;
}): PromotionResult {
  const config = input.config ?? DEFAULT_OUTCOME_ROUTING_CONFIG;
  const reasons: string[] = [];
  if (input.join_report.new_run_coverage === null || input.join_report.new_run_coverage < config.min_new_run_coverage) {
    reasons.push(`new-run coverage ${input.join_report.new_run_coverage ?? "n/a"} < ${config.min_new_run_coverage}`);
  }
  if (input.join_report.invalid.length > 0) reasons.push(`${input.join_report.invalid.length} invalid evidence row(s)`);
  if (!input.shadow.sufficient) reasons.push("shadow/operator comparison below sample or confidence gate");
  const eligible = input.candidates.filter(candidate => candidate.eligible);
  const groups = new Map<string, CandidateScore[]>();
  for (const candidate of eligible) {
    const key = routeId(candidate.route_key, candidate.risk_tier);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  if (groups.size === 0) reasons.push("no evidence-eligible routes");

  const routes: Record<string, PromotedRoute> = {};
  for (const [key, group] of groups) {
    group.sort((a, b) => b.combined_score - a.combined_score || b.n - a.n || a.model_id.localeCompare(b.model_id));
    const primary = group[0];
    const fallbackIds: string[] = [];
    const providers = new Set([primary.provider]);
    for (const candidate of group.slice(1)) {
      if (providers.has(candidate.provider)) continue;
      providers.add(candidate.provider);
      fallbackIds.push(candidate.model_id);
    }
    const route: PromotedRoute = {
      route_key: primary.route_key,
      risk_tier: primary.risk_tier,
      primary_model_id: primary.model_id,
      fallback_model_ids: fallbackIds,
      evidence: {
        primary_score: primary.combined_score,
        primary_n: primary.n,
        shadow_compared: input.shadow.compared,
        shadow_agreement_lower: input.shadow.agreement?.lower ?? 0,
      },
    };
    const chainErrors = validateFallbackChain(route, input.catalog);
    if (chainErrors.length > 0) reasons.push(`${key}: ${chainErrors.join("; ")}`);
    else routes[key] = route;
  }
  if (reasons.length > 0) return { promoted: false, policy: null, reasons: reasons.sort() };
  const now = input.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error("now must be ISO-8601");
  return {
    promoted: true,
    policy: {
      schema: "zouroboros.outcome-routing-policy.v1",
      promoted_at: now,
      new_run_coverage: input.join_report.new_run_coverage!,
      routes,
    },
    reasons: [],
  };
}

export function resolvePromotedOutcomePolicy(
  input: { route_key: string; risk_tier: RiskTier },
  policy: PromotedOutcomePolicy,
  catalog: ModelProfile[],
): OutcomePolicyResolution | null {
  if (policy.schema !== "zouroboros.outcome-routing-policy.v1") throw new Error("unsupported outcome policy schema");
  if (policy.new_run_coverage < 0.95 || policy.new_run_coverage > 1) throw new Error("promoted policy has invalid new-run coverage");
  if (Number.isNaN(Date.parse(policy.promoted_at))) throw new Error("promoted policy has invalid promoted_at");
  const route = policy.routes[routeId(input.route_key, input.risk_tier)];
  if (!route) return null;
  const errors = validateFallbackChain(route, catalog);
  if (errors.length > 0) throw new Error(`invalid promoted route: ${errors.join("; ")}`);
  return {
    source: "promoted-outcome-policy",
    route_key: route.route_key,
    risk_tier: route.risk_tier,
    model_id: route.primary_model_id,
    fallback_model_ids: [...route.fallback_model_ids],
    evidence: { ...route.evidence },
  };
}
