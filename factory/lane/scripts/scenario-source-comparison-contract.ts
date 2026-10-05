import { createHash } from "node:crypto";
import { canonicalize } from "./run-receipt-contract.ts";

export const SCENARIO_SOURCE_PROTOCOL = "scenario-source-comparison/v1" as const;
export const SCENARIO_SOURCE_OBSERVATION = "scenario-source-observation/v1" as const;
export const SCENARIO_SOURCE_SUMMARY = "scenario-source-summary/v1" as const;
export const SOURCE_ARMS = ["manual", "receipt_derived"] as const;
export const EVIDENCE_CLASSES = ["synthetic_qualification", "phase_d_observation"] as const;
export const SOURCE_METRICS = [
  "defect_discovery_rate",
  "severity_weighted_defect_score",
  "unique_defect_rate",
  "reproducibility_rate",
  "maintenance_minutes",
  "contamination_rate",
] as const;
export const PRIMARY_SOURCE_METRIC = "severity_weighted_defect_score" as const;

export type SourceArm = typeof SOURCE_ARMS[number];
export type EvidenceClass = typeof EVIDENCE_CLASSES[number];
export type SourceMetric = typeof SOURCE_METRICS[number];
export type SourceMetricValues = Record<SourceMetric, number>;

export interface ScenarioSourceBudget {
  maximum_runs: 60;
  maximum_cost_usd: number;
  maximum_tokens: number;
  maximum_compute_hours: number;
  maximum_storage_gib: number;
  per_run_timeout_minutes: number;
}

export interface ReceiptDerivedLineage {
  source_receipt_id: string;
  source_receipt_sha256: string;
  candidate_id: string;
  candidate_sha256: string;
  review_id: string;
  review_sha256: string;
  scenario_version: number;
  reviewer_kind: "human" | "synthetic";
  review_evidence_kind: "simulated_fixture" | "human_admission";
}

export interface ScenarioSourcePair {
  pair_id: string;
  task_class: string;
  seed: number;
  task_contract_sha256: string;
  authority_envelope_sha256: string;
  verifier_contract_sha256: string;
  manual_scenario_sha256: string;
  receipt_derived_scenario_sha256: string;
  receipt_derived_lineage: ReceiptDerivedLineage;
}

export interface ScenarioSourceProtocol {
  schema: typeof SCENARIO_SOURCE_PROTOCOL;
  protocol_id: string;
  evidence_class: EvidenceClass;
  cohort_id: string;
  cohort_sha256: string;
  planned_pairs: 30;
  planned_runs: 60;
  minimum_complete_pairs: 30;
  futility_minimum_pairs: 20;
  confidence_level: 0.95;
  primary_metric: typeof PRIMARY_SOURCE_METRIC;
  metrics: SourceMetric[];
  contamination_detections_allowed: 0;
  advisory_only: true;
  live_model_calls: 0;
  budget: ScenarioSourceBudget;
  pairs: ScenarioSourcePair[];
  protocol_sha256: string;
}

export interface ScenarioSourceObservation {
  schema: typeof SCENARIO_SOURCE_OBSERVATION;
  observation_id: string;
  protocol_sha256: string;
  pair_id: string;
  task_class: string;
  seed: number;
  source_arm: SourceArm;
  task_contract_sha256: string;
  authority_envelope_sha256: string;
  verifier_contract_sha256: string;
  scenario_sha256: string;
  run_receipt_sha256: string;
  trajectory_report_sha256: string;
  receipt_derived_lineage: ReceiptDerivedLineage | null;
  authority_valid: boolean;
  task_mix_matches: boolean;
  verifier_contract_matches: boolean;
  receipt_valid: boolean;
  verifier_valid: boolean;
  environment_secret_free: boolean;
  answer_exposure_detected: boolean;
  contamination_detected: boolean;
  cost_usd: number;
  token_count: number;
  compute_seconds: number;
  storage_bytes: number;
  metrics: SourceMetricValues;
  observation_sha256: string;
}

export interface SourceConfidenceInterval {
  confidence_level: 0.95;
  method: "paired-normal-95";
  lower: number;
  upper: number;
}

export interface SourceMetricComparison {
  metric: SourceMetric;
  manual_mean: number;
  receipt_derived_mean: number;
  mean_delta: number;
  delta_direction: "receipt_derived_minus_manual" | "manual_minus_receipt_derived";
  interval: SourceConfidenceInterval;
}

export interface ScenarioSourceSummary {
  schema: typeof SCENARIO_SOURCE_SUMMARY;
  protocol_id: string;
  protocol_sha256: string;
  evidence_class: EvidenceClass;
  complete_pairs: number;
  observations: number;
  metrics: SourceMetricComparison[];
  total_cost_usd: number;
  total_tokens: number;
  total_compute_hours: number;
  total_storage_gib: number;
  disposition: "BENEFIT_SUPPORTED" | "NULL_OR_NEGATIVE" | "HOLD";
  reasons: string[];
  advisory_only: true;
  policy_mutations: [];
  summary_sha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,127}$/i;
const SECRET_VALUE = /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const FORBIDDEN_FIELDS = new Set(["answer", "golden_patch", "holdout_plaintext", "prompt", "credential", "secret", "production_state"]);
const PROTOCOL_KEYS = new Set([
  "schema", "protocol_id", "evidence_class", "cohort_id", "cohort_sha256", "planned_pairs",
  "planned_runs", "minimum_complete_pairs", "futility_minimum_pairs", "confidence_level",
  "primary_metric", "metrics", "contamination_detections_allowed", "advisory_only",
  "live_model_calls", "budget", "pairs", "protocol_sha256",
]);
const BUDGET_KEYS = new Set([
  "maximum_runs", "maximum_cost_usd", "maximum_tokens", "maximum_compute_hours",
  "maximum_storage_gib", "per_run_timeout_minutes",
]);
const PAIR_KEYS = new Set([
  "pair_id", "task_class", "seed", "task_contract_sha256", "authority_envelope_sha256",
  "verifier_contract_sha256", "manual_scenario_sha256", "receipt_derived_scenario_sha256",
  "receipt_derived_lineage",
]);
const LINEAGE_KEYS = new Set([
  "source_receipt_id", "source_receipt_sha256", "candidate_id", "candidate_sha256", "review_id",
  "review_sha256", "scenario_version", "reviewer_kind", "review_evidence_kind",
]);
const OBSERVATION_KEYS = new Set([
  "schema", "observation_id", "protocol_sha256", "pair_id", "task_class", "seed", "source_arm",
  "task_contract_sha256", "authority_envelope_sha256", "verifier_contract_sha256", "scenario_sha256",
  "run_receipt_sha256", "trajectory_report_sha256", "receipt_derived_lineage", "authority_valid",
  "task_mix_matches", "verifier_contract_matches", "receipt_valid", "verifier_valid",
  "environment_secret_free", "answer_exposure_detected", "contamination_detected", "cost_usd",
  "token_count", "compute_seconds", "storage_bytes", "metrics", "observation_sha256",
]);
const SUMMARY_KEYS = new Set([
  "schema", "protocol_id", "protocol_sha256", "evidence_class", "complete_pairs", "observations",
  "metrics", "total_cost_usd", "total_tokens", "total_compute_hours", "total_storage_gib",
  "disposition", "reasons", "advisory_only", "policy_mutations", "summary_sha256",
]);
const COMPARISON_KEYS = new Set([
  "metric", "manual_mean", "receipt_derived_mean", "mean_delta", "delta_direction", "interval",
]);
const INTERVAL_KEYS = new Set(["confidence_level", "method", "lower", "upper"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

function noSensitive(value: unknown, path = "value"): void {
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error(`${path} contains a secret-shaped value`);
  if (Array.isArray(value)) return value.forEach((entry, index) => noSensitive(entry, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) throw new Error(`${path} contains forbidden field: ${key}`);
    noSensitive(entry, `${path}.${key}`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || SECRET_VALUE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return value as number;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and nonnegative`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function parseLineage(value: unknown, label: string): ReceiptDerivedLineage {
  const raw = object(value, label);
  exactKeys(raw, LINEAGE_KEYS, label);
  if (raw.review_evidence_kind !== "simulated_fixture" && raw.review_evidence_kind !== "human_admission") {
    throw new Error(`${label}.review_evidence_kind is invalid`);
  }
  if (raw.reviewer_kind !== "human" && raw.reviewer_kind !== "synthetic") throw new Error(`${label}.reviewer_kind is invalid`);
  return {
    source_receipt_id: text(raw.source_receipt_id, `${label}.source_receipt_id`),
    source_receipt_sha256: hash(raw.source_receipt_sha256, `${label}.source_receipt_sha256`),
    candidate_id: text(raw.candidate_id, `${label}.candidate_id`),
    candidate_sha256: hash(raw.candidate_sha256, `${label}.candidate_sha256`),
    review_id: text(raw.review_id, `${label}.review_id`),
    review_sha256: hash(raw.review_sha256, `${label}.review_sha256`),
    scenario_version: integer(raw.scenario_version, `${label}.scenario_version`, 1),
    reviewer_kind: raw.reviewer_kind,
    review_evidence_kind: raw.review_evidence_kind,
  };
}

function parsePair(value: unknown, index: number, evidenceClass: EvidenceClass): ScenarioSourcePair {
  const label = `pairs[${index}]`;
  const raw = object(value, label);
  exactKeys(raw, PAIR_KEYS, label);
  const lineage = parseLineage(raw.receipt_derived_lineage, `${label}.receipt_derived_lineage`);
  const expectedReview = evidenceClass === "synthetic_qualification" ? "simulated_fixture" : "human_admission";
  const expectedReviewer = evidenceClass === "synthetic_qualification" ? "synthetic" : "human";
  if (lineage.review_evidence_kind !== expectedReview) throw new Error(`${label} review evidence does not match evidence_class`);
  if (lineage.reviewer_kind !== expectedReviewer) throw new Error(`${label} reviewer kind does not match evidence_class`);
  return {
    pair_id: text(raw.pair_id, `${label}.pair_id`),
    task_class: text(raw.task_class, `${label}.task_class`),
    seed: integer(raw.seed, `${label}.seed`),
    task_contract_sha256: hash(raw.task_contract_sha256, `${label}.task_contract_sha256`),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, `${label}.authority_envelope_sha256`),
    verifier_contract_sha256: hash(raw.verifier_contract_sha256, `${label}.verifier_contract_sha256`),
    manual_scenario_sha256: hash(raw.manual_scenario_sha256, `${label}.manual_scenario_sha256`),
    receipt_derived_scenario_sha256: hash(raw.receipt_derived_scenario_sha256, `${label}.receipt_derived_scenario_sha256`),
    receipt_derived_lineage: lineage,
  };
}

function parseBudget(value: unknown): ScenarioSourceBudget {
  const raw = object(value, "budget");
  exactKeys(raw, BUDGET_KEYS, "budget");
  if (raw.maximum_runs !== 60) throw new Error("budget.maximum_runs must be 60");
  const budget: ScenarioSourceBudget = {
    maximum_runs: 60,
    maximum_cost_usd: nonnegative(raw.maximum_cost_usd, "budget.maximum_cost_usd"),
    maximum_tokens: integer(raw.maximum_tokens, "budget.maximum_tokens"),
    maximum_compute_hours: nonnegative(raw.maximum_compute_hours, "budget.maximum_compute_hours"),
    maximum_storage_gib: nonnegative(raw.maximum_storage_gib, "budget.maximum_storage_gib"),
    per_run_timeout_minutes: nonnegative(raw.per_run_timeout_minutes, "budget.per_run_timeout_minutes"),
  };
  if (budget.maximum_cost_usd > 425) throw new Error("budget.maximum_cost_usd exceeds the Phase D ceiling");
  if (budget.maximum_tokens > 55_000_000) throw new Error("budget.maximum_tokens exceeds the Phase D ceiling");
  if (budget.maximum_compute_hours > 110) throw new Error("budget.maximum_compute_hours exceeds the Phase D ceiling");
  if (budget.maximum_storage_gib > 7) throw new Error("budget.maximum_storage_gib exceeds the Phase D ceiling");
  if (budget.per_run_timeout_minutes > 30) throw new Error("budget.per_run_timeout_minutes exceeds the Phase D ceiling");
  return budget;
}

export function sourceSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function computeProtocolHash(value: Omit<ScenarioSourceProtocol, "protocol_sha256"> | ScenarioSourceProtocol): string {
  const { protocol_sha256: _ignored, ...base } = value as ScenarioSourceProtocol;
  return sourceSha256(base);
}

export function computeObservationHash(value: Omit<ScenarioSourceObservation, "observation_sha256"> | ScenarioSourceObservation): string {
  const { observation_sha256: _ignored, ...base } = value as ScenarioSourceObservation;
  return sourceSha256(base);
}

export function computeScenarioSourceSummaryHash(value: Omit<ScenarioSourceSummary, "summary_sha256"> | ScenarioSourceSummary): string {
  const { summary_sha256: _ignored, ...base } = value as ScenarioSourceSummary;
  return sourceSha256(base);
}

export function finalizeScenarioSourceProtocol(value: Omit<ScenarioSourceProtocol, "protocol_sha256">): ScenarioSourceProtocol {
  return { ...value, protocol_sha256: computeProtocolHash(value) };
}

export function finalizeScenarioSourceObservation(value: Omit<ScenarioSourceObservation, "observation_sha256">): ScenarioSourceObservation {
  return { ...value, observation_sha256: computeObservationHash(value) };
}

export function parseScenarioSourceProtocol(value: unknown): ScenarioSourceProtocol {
  noSensitive(value, "protocol");
  const raw = object(value, "protocol");
  exactKeys(raw, PROTOCOL_KEYS, "protocol");
  if (raw.schema !== SCENARIO_SOURCE_PROTOCOL) throw new Error(`protocol.schema must be ${SCENARIO_SOURCE_PROTOCOL}`);
  if (!EVIDENCE_CLASSES.includes(raw.evidence_class as EvidenceClass)) throw new Error("protocol.evidence_class is invalid");
  if (raw.planned_pairs !== 30 || raw.planned_runs !== 60 || raw.minimum_complete_pairs !== 30 || raw.futility_minimum_pairs !== 20) {
    throw new Error("protocol sample ceilings must be 30 pairs, 60 runs, minimum 30, futility 20");
  }
  if (raw.confidence_level !== 0.95 || raw.primary_metric !== PRIMARY_SOURCE_METRIC) throw new Error("protocol statistical contract is invalid");
  if (!Array.isArray(raw.metrics) || raw.metrics.length !== SOURCE_METRICS.length || raw.metrics.some((entry, index) => entry !== SOURCE_METRICS[index])) {
    throw new Error("protocol.metrics must match the frozen metric order");
  }
  if (raw.contamination_detections_allowed !== 0 || raw.advisory_only !== true || raw.live_model_calls !== 0) {
    throw new Error("protocol must be advisory, contamination-free, and prerecorded-only");
  }
  if (!Array.isArray(raw.pairs) || raw.pairs.length !== 30) throw new Error("protocol.pairs must contain exactly 30 pairs");
  const evidenceClass = raw.evidence_class as EvidenceClass;
  const pairs = raw.pairs.map((entry, index) => parsePair(entry, index, evidenceClass));
  if (new Set(pairs.map((entry) => entry.pair_id)).size !== pairs.length) throw new Error("protocol has duplicate pair ids");
  const parsed: ScenarioSourceProtocol = {
    schema: SCENARIO_SOURCE_PROTOCOL,
    protocol_id: text(raw.protocol_id, "protocol.protocol_id"),
    evidence_class: evidenceClass,
    cohort_id: text(raw.cohort_id, "protocol.cohort_id"),
    cohort_sha256: hash(raw.cohort_sha256, "protocol.cohort_sha256"),
    planned_pairs: 30,
    planned_runs: 60,
    minimum_complete_pairs: 30,
    futility_minimum_pairs: 20,
    confidence_level: 0.95,
    primary_metric: PRIMARY_SOURCE_METRIC,
    metrics: [...SOURCE_METRICS],
    contamination_detections_allowed: 0,
    advisory_only: true,
    live_model_calls: 0,
    budget: parseBudget(raw.budget),
    pairs,
    protocol_sha256: hash(raw.protocol_sha256, "protocol.protocol_sha256"),
  };
  if (computeProtocolHash(parsed) !== parsed.protocol_sha256) throw new Error("protocol hash mismatch");
  return parsed;
}

function parseMetrics(value: unknown): SourceMetricValues {
  const raw = object(value, "observation.metrics");
  exactKeys(raw, new Set(SOURCE_METRICS), "observation.metrics");
  const result = {} as SourceMetricValues;
  for (const metric of SOURCE_METRICS) {
    const parsed = nonnegative(raw[metric], `observation.metrics.${metric}`);
    if (["defect_discovery_rate", "unique_defect_rate", "reproducibility_rate", "contamination_rate"].includes(metric) && parsed > 1) {
      throw new Error(`observation.metrics.${metric} must be <= 1`);
    }
    result[metric] = parsed;
  }
  return result;
}

export function parseScenarioSourceObservation(value: unknown, protocol: ScenarioSourceProtocol): ScenarioSourceObservation {
  noSensitive(value, "observation");
  const raw = object(value, "observation");
  exactKeys(raw, OBSERVATION_KEYS, "observation");
  if (raw.schema !== SCENARIO_SOURCE_OBSERVATION) throw new Error(`observation.schema must be ${SCENARIO_SOURCE_OBSERVATION}`);
  if (!SOURCE_ARMS.includes(raw.source_arm as SourceArm)) throw new Error("observation.source_arm is invalid");
  const pairId = text(raw.pair_id, "observation.pair_id");
  const pair = protocol.pairs.find((entry) => entry.pair_id === pairId);
  if (!pair) throw new Error("observation pair is not in protocol");
  const arm = raw.source_arm as SourceArm;
  const lineage = raw.receipt_derived_lineage === null ? null : parseLineage(raw.receipt_derived_lineage, "observation.receipt_derived_lineage");
  if (arm === "manual" && lineage !== null) throw new Error("manual observation must not carry receipt-derived lineage");
  if (arm === "receipt_derived" && canonicalize(lineage) !== canonicalize(pair.receipt_derived_lineage)) throw new Error("receipt-derived lineage mismatch");
  const parsed: ScenarioSourceObservation = {
    schema: SCENARIO_SOURCE_OBSERVATION,
    observation_id: text(raw.observation_id, "observation.observation_id"),
    protocol_sha256: hash(raw.protocol_sha256, "observation.protocol_sha256"),
    pair_id: pairId,
    task_class: text(raw.task_class, "observation.task_class"),
    seed: integer(raw.seed, "observation.seed"),
    source_arm: arm,
    task_contract_sha256: hash(raw.task_contract_sha256, "observation.task_contract_sha256"),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, "observation.authority_envelope_sha256"),
    verifier_contract_sha256: hash(raw.verifier_contract_sha256, "observation.verifier_contract_sha256"),
    scenario_sha256: hash(raw.scenario_sha256, "observation.scenario_sha256"),
    run_receipt_sha256: hash(raw.run_receipt_sha256, "observation.run_receipt_sha256"),
    trajectory_report_sha256: hash(raw.trajectory_report_sha256, "observation.trajectory_report_sha256"),
    receipt_derived_lineage: lineage,
    authority_valid: bool(raw.authority_valid, "observation.authority_valid"),
    task_mix_matches: bool(raw.task_mix_matches, "observation.task_mix_matches"),
    verifier_contract_matches: bool(raw.verifier_contract_matches, "observation.verifier_contract_matches"),
    receipt_valid: bool(raw.receipt_valid, "observation.receipt_valid"),
    verifier_valid: bool(raw.verifier_valid, "observation.verifier_valid"),
    environment_secret_free: bool(raw.environment_secret_free, "observation.environment_secret_free"),
    answer_exposure_detected: bool(raw.answer_exposure_detected, "observation.answer_exposure_detected"),
    contamination_detected: bool(raw.contamination_detected, "observation.contamination_detected"),
    cost_usd: nonnegative(raw.cost_usd, "observation.cost_usd"),
    token_count: integer(raw.token_count, "observation.token_count"),
    compute_seconds: nonnegative(raw.compute_seconds, "observation.compute_seconds"),
    storage_bytes: integer(raw.storage_bytes, "observation.storage_bytes"),
    metrics: parseMetrics(raw.metrics),
    observation_sha256: hash(raw.observation_sha256, "observation.observation_sha256"),
  };
  if (parsed.protocol_sha256 !== protocol.protocol_sha256) throw new Error("observation protocol hash mismatch");
  if (parsed.task_class !== pair.task_class || parsed.seed !== pair.seed) throw new Error("observation task identity drift");
  if (parsed.task_contract_sha256 !== pair.task_contract_sha256 || parsed.authority_envelope_sha256 !== pair.authority_envelope_sha256 || parsed.verifier_contract_sha256 !== pair.verifier_contract_sha256) {
    throw new Error("observation contract identity drift");
  }
  const expectedScenario = arm === "manual" ? pair.manual_scenario_sha256 : pair.receipt_derived_scenario_sha256;
  if (parsed.scenario_sha256 !== expectedScenario) throw new Error("observation scenario hash drift");
  if (computeObservationHash(parsed) !== parsed.observation_sha256) throw new Error("observation hash mismatch");
  return parsed;
}

export function observationCell(value: Pick<ScenarioSourceObservation, "pair_id" | "source_arm">): string {
  return `${value.pair_id}:${value.source_arm}`;
}

export function parseScenarioSourceSummary(value: unknown): ScenarioSourceSummary {
  noSensitive(value, "summary");
  const raw = object(value, "summary");
  exactKeys(raw, SUMMARY_KEYS, "summary");
  if (raw.schema !== SCENARIO_SOURCE_SUMMARY) throw new Error(`summary.schema must be ${SCENARIO_SOURCE_SUMMARY}`);
  if (!EVIDENCE_CLASSES.includes(raw.evidence_class as EvidenceClass)) throw new Error("summary.evidence_class is invalid");
  if (!Array.isArray(raw.metrics) || raw.metrics.length !== SOURCE_METRICS.length) throw new Error("summary.metrics must contain all six metrics");
  const metrics = raw.metrics.map((entry, index): SourceMetricComparison => {
    const label = `summary.metrics[${index}]`;
    const metric = object(entry, label);
    exactKeys(metric, COMPARISON_KEYS, label);
    if (metric.metric !== SOURCE_METRICS[index]) throw new Error("summary.metrics must match the frozen metric order without duplicates");
    const reversed = metric.metric === "maintenance_minutes" || metric.metric === "contamination_rate";
    const expectedDirection = reversed ? "manual_minus_receipt_derived" : "receipt_derived_minus_manual";
    if (metric.delta_direction !== expectedDirection) throw new Error(`${label}.delta_direction is invalid`);
    const rawInterval = object(metric.interval, `${label}.interval`);
    exactKeys(rawInterval, INTERVAL_KEYS, `${label}.interval`);
    if (rawInterval.confidence_level !== 0.95 || rawInterval.method !== "paired-normal-95") throw new Error(`${label}.interval contract is invalid`);
    const lower = typeof rawInterval.lower === "number" && Number.isFinite(rawInterval.lower) ? rawInterval.lower : Number.NaN;
    const upper = typeof rawInterval.upper === "number" && Number.isFinite(rawInterval.upper) ? rawInterval.upper : Number.NaN;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw new Error(`${label}.interval bounds are invalid`);
    for (const field of ["manual_mean", "receipt_derived_mean", "mean_delta"] as const) {
      if (typeof metric[field] !== "number" || !Number.isFinite(metric[field])) throw new Error(`${label}.${field} must be finite`);
    }
    return {
      metric: metric.metric as SourceMetric,
      manual_mean: metric.manual_mean as number,
      receipt_derived_mean: metric.receipt_derived_mean as number,
      mean_delta: metric.mean_delta as number,
      delta_direction: expectedDirection,
      interval: { confidence_level: 0.95, method: "paired-normal-95", lower, upper },
    };
  });
  if (raw.disposition !== "BENEFIT_SUPPORTED" && raw.disposition !== "NULL_OR_NEGATIVE" && raw.disposition !== "HOLD") {
    throw new Error("summary.disposition is invalid");
  }
  if (!Array.isArray(raw.reasons) || raw.reasons.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error("summary.reasons is invalid");
  if (raw.advisory_only !== true || !Array.isArray(raw.policy_mutations) || raw.policy_mutations.length !== 0) throw new Error("summary must be advisory-only with no policy mutations");
  const parsed: ScenarioSourceSummary = {
    schema: SCENARIO_SOURCE_SUMMARY,
    protocol_id: text(raw.protocol_id, "summary.protocol_id"),
    protocol_sha256: hash(raw.protocol_sha256, "summary.protocol_sha256"),
    evidence_class: raw.evidence_class as EvidenceClass,
    complete_pairs: integer(raw.complete_pairs, "summary.complete_pairs"),
    observations: integer(raw.observations, "summary.observations"),
    metrics,
    total_cost_usd: nonnegative(raw.total_cost_usd, "summary.total_cost_usd"),
    total_tokens: integer(raw.total_tokens, "summary.total_tokens"),
    total_compute_hours: nonnegative(raw.total_compute_hours, "summary.total_compute_hours"),
    total_storage_gib: nonnegative(raw.total_storage_gib, "summary.total_storage_gib"),
    disposition: raw.disposition,
    reasons: [...raw.reasons] as string[],
    advisory_only: true,
    policy_mutations: [],
    summary_sha256: hash(raw.summary_sha256, "summary.summary_sha256"),
  };
  if (computeScenarioSourceSummaryHash(parsed) !== parsed.summary_sha256) throw new Error("summary hash mismatch");
  return parsed;
}
