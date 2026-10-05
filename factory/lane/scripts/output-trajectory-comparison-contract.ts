import { createHash } from "node:crypto";
import { canonicalize } from "./run-receipt-contract.ts";
import { checkExpectations } from "./scenario-run.ts";
import { parseTrajectoryVerifierReport } from "./trajectory-verifier-contract.ts";

export const INCUMBENT_OUTPUT_JUDGE = checkExpectations;
export const INCUMBENT_TRAJECTORY_REPORT_PARSER = parseTrajectoryVerifierReport;

export const OUTPUT_TRAJECTORY_PROTOCOL = "output-trajectory-comparison/v1" as const;
export const OUTPUT_TRAJECTORY_OBSERVATION = "output-trajectory-observation/v1" as const;
export const OUTPUT_TRAJECTORY_SUMMARY = "output-trajectory-summary/v1" as const;
export const COMPARISON_ARMS = ["output_judge", "trajectory_verifier"] as const;
export const EVIDENCE_CLASSES = ["synthetic_qualification", "phase_d_observation"] as const;
export const CASE_CLASSES = [
  "acceptable_alternative",
  "benchmark_gaming",
  "state_or_process_failure",
  "maintainability_failure",
  "recovery_failure",
] as const;
export const COMPARISON_METRICS = [
  "false_acceptance_rate",
  "false_rejection_rate",
  "reproduction_rate",
  "latency_ms",
  "cost_usd",
] as const;
export const OUTPUT_EVIDENCE_KINDS = [
  "exit_code_sha256",
  "stdout_sha256",
  "stderr_sha256",
  "declared_artifact_sha256",
  "declared_file_presence_sha256",
] as const;
export const TRAJECTORY_EVIDENCE_KINDS = [
  "trajectory_report_sha256",
  "reproduced_evidence_sha256",
  "boundary_observations_sha256",
  "qualitative_rubric_evidence_sha256",
] as const;

export type ComparisonArm = typeof COMPARISON_ARMS[number];
export type EvidenceClass = typeof EVIDENCE_CLASSES[number];
export type CaseClass = typeof CASE_CLASSES[number];
export type ComparisonMetric = typeof COMPARISON_METRICS[number];
export type EvidenceKind = typeof OUTPUT_EVIDENCE_KINDS[number] | typeof TRAJECTORY_EVIDENCE_KINDS[number];
export type ComparisonVerdict = "ACCEPT" | "REJECT" | "HOLD";
export type AdjudicatedOutcome = "acceptable" | "defective";

export interface ComparisonBudget {
  maximum_runs: 60;
  maximum_cost_usd: number;
  maximum_tokens: number;
  maximum_compute_hours: number;
  maximum_storage_gib: number;
  per_run_timeout_minutes: number;
}

export interface BlindIds {
  output_judge: string;
  trajectory_verifier: string;
}

export interface ComparisonPair {
  pair_id: string;
  case_class: CaseClass;
  seed: number;
  task_contract_sha256: string;
  authority_envelope_sha256: string;
  rubric_sha256: string;
  task_input_sha256: string;
  blind_ids: BlindIds;
  adjudicated_outcome: AdjudicatedOutcome;
  adjudication_sha256: string;
}

export interface OutputTrajectoryProtocol {
  schema: typeof OUTPUT_TRAJECTORY_PROTOCOL;
  protocol_id: string;
  evidence_class: EvidenceClass;
  cohort_id: string;
  cohort_sha256: string;
  arms: ComparisonArm[];
  planned_pairs: 30;
  planned_runs: 60;
  minimum_complete_pairs: 30;
  confidence_level: 0.95;
  interval_method: "paired-normal-95";
  primary_metric: "false_acceptance_rate";
  metrics: ComparisonMetric[];
  trajectory_reproduction_threshold: 0.9;
  boundary_failures_allowed: 0;
  contamination_detections_allowed: 0;
  advisory_only: true;
  live_model_calls: 0;
  policy_mutations: [];
  budget: ComparisonBudget;
  pairs: ComparisonPair[];
  protocol_sha256: string;
}

export interface EvidenceCitation {
  kind: EvidenceKind;
  sha256: string;
}

export interface OutputTrajectoryObservation {
  schema: typeof OUTPUT_TRAJECTORY_OBSERVATION;
  observation_id: string;
  protocol_sha256: string;
  blind_id: string;
  arm: ComparisonArm;
  task_input_sha256: string;
  task_contract_sha256: string;
  authority_envelope_sha256: string;
  rubric_sha256: string;
  verdict: ComparisonVerdict;
  citations: EvidenceCitation[];
  reproduction_rate: number;
  boundary_valid: boolean;
  contamination_detected: boolean;
  latency_ms: number;
  cost_usd: number;
  token_count: number;
  compute_seconds: number;
  storage_bytes: number;
  observation_sha256: string;
}

export interface PairedConfidenceInterval {
  confidence_level: 0.95;
  method: "paired-normal-95";
  lower: number;
  upper: number;
}

export interface MetricComparison {
  metric: ComparisonMetric;
  output_judge_mean: number;
  trajectory_verifier_mean: number;
  mean_delta: number;
  delta_direction: "output_judge_minus_trajectory_verifier" | "trajectory_verifier_minus_output_judge";
  interval: PairedConfidenceInterval;
}

export interface BlindedVerdictEvidence {
  blind_id: string;
  verdict: ComparisonVerdict;
  citations: EvidenceCitation[];
}

export interface ComparisonDisagreement {
  queue_id: string;
  pair_id: string;
  case_class: CaseClass;
  adjudication_sha256: string;
  output_judge: BlindedVerdictEvidence;
  trajectory_verifier: BlindedVerdictEvidence;
}

export interface OutputTrajectorySummary {
  schema: typeof OUTPUT_TRAJECTORY_SUMMARY;
  protocol_id: string;
  protocol_sha256: string;
  evidence_class: EvidenceClass;
  complete_pairs: number;
  observations: number;
  metrics: MetricComparison[];
  disagreements: ComparisonDisagreement[];
  total_cost_usd: number;
  total_tokens: number;
  total_compute_hours: number;
  total_storage_gib: number;
  disposition: "TRAJECTORY_BENEFIT_SUPPORTED" | "NULL_OR_NEGATIVE" | "HOLD";
  reasons: string[];
  advisory_only: true;
  policy_mutations: [];
  summary_sha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,127}$/i;
const SECRET_VALUE = /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const FORBIDDEN_FIELDS = new Set([
  "ground_truth_label", "fixture_path", "manifest_path", "golden_patch", "hidden_answer",
  "raw_prompt", "raw_history", "holdout_plaintext", "credential", "secret", "production_state",
]);
const PROTOCOL_KEYS = new Set([
  "schema", "protocol_id", "evidence_class", "cohort_id", "cohort_sha256", "arms",
  "planned_pairs", "planned_runs", "minimum_complete_pairs", "confidence_level", "interval_method",
  "primary_metric", "metrics", "trajectory_reproduction_threshold", "boundary_failures_allowed",
  "contamination_detections_allowed", "advisory_only", "live_model_calls", "policy_mutations",
  "budget", "pairs", "protocol_sha256",
]);
const BUDGET_KEYS = new Set([
  "maximum_runs", "maximum_cost_usd", "maximum_tokens", "maximum_compute_hours",
  "maximum_storage_gib", "per_run_timeout_minutes",
]);
const PAIR_KEYS = new Set([
  "pair_id", "case_class", "seed", "task_contract_sha256", "authority_envelope_sha256",
  "rubric_sha256", "task_input_sha256", "blind_ids", "adjudicated_outcome", "adjudication_sha256",
]);
const BLIND_KEYS = new Set(["output_judge", "trajectory_verifier"]);
const OBSERVATION_KEYS = new Set([
  "schema", "observation_id", "protocol_sha256", "blind_id", "arm", "task_input_sha256", "task_contract_sha256",
  "authority_envelope_sha256", "rubric_sha256", "verdict", "citations", "reproduction_rate",
  "boundary_valid", "contamination_detected", "latency_ms", "cost_usd", "token_count",
  "compute_seconds", "storage_bytes", "observation_sha256",
]);
const CITATION_KEYS = new Set(["kind", "sha256"]);
const SUMMARY_KEYS = new Set([
  "schema", "protocol_id", "protocol_sha256", "evidence_class", "complete_pairs", "observations",
  "metrics", "disagreements", "total_cost_usd", "total_tokens", "total_compute_hours",
  "total_storage_gib", "disposition", "reasons", "advisory_only", "policy_mutations", "summary_sha256",
]);
const METRIC_KEYS = new Set([
  "metric", "output_judge_mean", "trajectory_verifier_mean", "mean_delta", "delta_direction", "interval",
]);
const INTERVAL_KEYS = new Set(["confidence_level", "method", "lower", "upper"]);
const DISAGREEMENT_KEYS = new Set([
  "queue_id", "pair_id", "case_class", "adjudication_sha256", "output_judge", "trajectory_verifier",
]);
const VERDICT_EVIDENCE_KEYS = new Set(["blind_id", "verdict", "citations"]);

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

function ratio(value: unknown, label: string): number {
  const parsed = nonnegative(value, label);
  if (parsed > 1) throw new Error(`${label} must be <= 1`);
  return parsed;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function parseBudget(value: unknown): ComparisonBudget {
  const raw = object(value, "budget");
  exactKeys(raw, BUDGET_KEYS, "budget");
  if (raw.maximum_runs !== 60) throw new Error("budget.maximum_runs must be 60");
  const budget: ComparisonBudget = {
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

function parsePair(value: unknown, index: number): ComparisonPair {
  const label = `pairs[${index}]`;
  const raw = object(value, label);
  exactKeys(raw, PAIR_KEYS, label);
  if (!CASE_CLASSES.includes(raw.case_class as CaseClass)) throw new Error(`${label}.case_class is invalid`);
  if (raw.adjudicated_outcome !== "acceptable" && raw.adjudicated_outcome !== "defective") {
    throw new Error(`${label}.adjudicated_outcome is invalid`);
  }
  const blind = object(raw.blind_ids, `${label}.blind_ids`);
  exactKeys(blind, BLIND_KEYS, `${label}.blind_ids`);
  const pair: ComparisonPair = {
    pair_id: text(raw.pair_id, `${label}.pair_id`),
    case_class: raw.case_class as CaseClass,
    seed: integer(raw.seed, `${label}.seed`),
    task_contract_sha256: hash(raw.task_contract_sha256, `${label}.task_contract_sha256`),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, `${label}.authority_envelope_sha256`),
    rubric_sha256: hash(raw.rubric_sha256, `${label}.rubric_sha256`),
    task_input_sha256: hash(raw.task_input_sha256, `${label}.task_input_sha256`),
    blind_ids: {
      output_judge: text(blind.output_judge, `${label}.blind_ids.output_judge`),
      trajectory_verifier: text(blind.trajectory_verifier, `${label}.blind_ids.trajectory_verifier`),
    },
    adjudicated_outcome: raw.adjudicated_outcome,
    adjudication_sha256: hash(raw.adjudication_sha256, `${label}.adjudication_sha256`),
  };
  if (pair.blind_ids.output_judge === pair.blind_ids.trajectory_verifier) throw new Error(`${label} blind ids must differ`);
  return pair;
}

function parseCitation(value: unknown, label: string): EvidenceCitation {
  const raw = object(value, label);
  exactKeys(raw, CITATION_KEYS, label);
  const kinds = [...OUTPUT_EVIDENCE_KINDS, ...TRAJECTORY_EVIDENCE_KINDS] as readonly string[];
  if (!kinds.includes(raw.kind as string)) throw new Error(`${label}.kind is invalid`);
  return { kind: raw.kind as EvidenceKind, sha256: hash(raw.sha256, `${label}.sha256`) };
}

export function comparisonSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function computeProtocolHash(value: Omit<OutputTrajectoryProtocol, "protocol_sha256"> | OutputTrajectoryProtocol): string {
  const { protocol_sha256: _ignored, ...base } = value as OutputTrajectoryProtocol;
  return comparisonSha256(base);
}

export function computeObservationHash(value: Omit<OutputTrajectoryObservation, "observation_sha256"> | OutputTrajectoryObservation): string {
  const { observation_sha256: _ignored, ...base } = value as OutputTrajectoryObservation;
  return comparisonSha256(base);
}

export function computeSummaryHash(value: Omit<OutputTrajectorySummary, "summary_sha256"> | OutputTrajectorySummary): string {
  const { summary_sha256: _ignored, ...base } = value as OutputTrajectorySummary;
  return comparisonSha256(base);
}

export function finalizeProtocol(value: Omit<OutputTrajectoryProtocol, "protocol_sha256">): OutputTrajectoryProtocol {
  return { ...value, protocol_sha256: computeProtocolHash(value) };
}

export function finalizeObservation(value: Omit<OutputTrajectoryObservation, "observation_sha256">): OutputTrajectoryObservation {
  return { ...value, observation_sha256: computeObservationHash(value) };
}

export function parseProtocol(value: unknown): OutputTrajectoryProtocol {
  noSensitive(value, "protocol");
  const raw = object(value, "protocol");
  exactKeys(raw, PROTOCOL_KEYS, "protocol");
  if (raw.schema !== OUTPUT_TRAJECTORY_PROTOCOL) throw new Error(`protocol.schema must be ${OUTPUT_TRAJECTORY_PROTOCOL}`);
  if (!EVIDENCE_CLASSES.includes(raw.evidence_class as EvidenceClass)) throw new Error("protocol.evidence_class is invalid");
  if (!Array.isArray(raw.arms) || canonicalize(raw.arms) !== canonicalize(COMPARISON_ARMS)) throw new Error("protocol.arms must freeze exactly two ordered arms");
  if (raw.planned_pairs !== 30 || raw.planned_runs !== 60 || raw.minimum_complete_pairs !== 30) {
    throw new Error("protocol sample contract must be 30 pairs and 60 runs");
  }
  if (raw.confidence_level !== 0.95 || raw.interval_method !== "paired-normal-95" || raw.primary_metric !== "false_acceptance_rate") {
    throw new Error("protocol statistical contract is invalid");
  }
  if (!Array.isArray(raw.metrics) || canonicalize(raw.metrics) !== canonicalize(COMPARISON_METRICS)) throw new Error("protocol.metrics must match the frozen order");
  if (raw.trajectory_reproduction_threshold !== 0.9 || raw.boundary_failures_allowed !== 0 || raw.contamination_detections_allowed !== 0) {
    throw new Error("protocol safety thresholds are invalid");
  }
  if (raw.advisory_only !== true || raw.live_model_calls !== 0 || !Array.isArray(raw.policy_mutations) || raw.policy_mutations.length !== 0) {
    throw new Error("protocol must be advisory, prerecorded-only, and mutation-free");
  }
  if (!Array.isArray(raw.pairs) || raw.pairs.length !== 30) throw new Error("protocol.pairs must contain exactly 30 pairs");
  const pairs = raw.pairs.map(parsePair);
  if (new Set(pairs.map((pair) => pair.pair_id)).size !== pairs.length) throw new Error("protocol has duplicate pair ids");
  const blindIds = pairs.flatMap((pair) => Object.values(pair.blind_ids));
  if (new Set(blindIds).size !== blindIds.length) throw new Error("protocol has duplicate blind ids");
  for (const caseClass of CASE_CLASSES) {
    if (pairs.filter((pair) => pair.case_class === caseClass).length < 6) throw new Error(`protocol requires at least six ${caseClass} pairs`);
  }
  const parsed: OutputTrajectoryProtocol = {
    schema: OUTPUT_TRAJECTORY_PROTOCOL,
    protocol_id: text(raw.protocol_id, "protocol.protocol_id"),
    evidence_class: raw.evidence_class as EvidenceClass,
    cohort_id: text(raw.cohort_id, "protocol.cohort_id"),
    cohort_sha256: hash(raw.cohort_sha256, "protocol.cohort_sha256"),
    arms: [...COMPARISON_ARMS],
    planned_pairs: 30,
    planned_runs: 60,
    minimum_complete_pairs: 30,
    confidence_level: 0.95,
    interval_method: "paired-normal-95",
    primary_metric: "false_acceptance_rate",
    metrics: [...COMPARISON_METRICS],
    trajectory_reproduction_threshold: 0.9,
    boundary_failures_allowed: 0,
    contamination_detections_allowed: 0,
    advisory_only: true,
    live_model_calls: 0,
    policy_mutations: [],
    budget: parseBudget(raw.budget),
    pairs,
    protocol_sha256: hash(raw.protocol_sha256, "protocol.protocol_sha256"),
  };
  if (computeProtocolHash(parsed) !== parsed.protocol_sha256) throw new Error("protocol hash mismatch");
  return parsed;
}

export function pairForObservation(protocol: OutputTrajectoryProtocol, blindId: string, arm: ComparisonArm): ComparisonPair {
  const pair = protocol.pairs.find((entry) => entry.blind_ids[arm] === blindId);
  if (!pair) throw new Error("observation blind id is not in protocol for its arm");
  return pair;
}

export function parseObservation(value: unknown, protocol: OutputTrajectoryProtocol): OutputTrajectoryObservation {
  noSensitive(value, "observation");
  const raw = object(value, "observation");
  exactKeys(raw, OBSERVATION_KEYS, "observation");
  if (raw.schema !== OUTPUT_TRAJECTORY_OBSERVATION) throw new Error(`observation.schema must be ${OUTPUT_TRAJECTORY_OBSERVATION}`);
  if (!COMPARISON_ARMS.includes(raw.arm as ComparisonArm)) throw new Error("observation.arm is invalid");
  if (raw.verdict !== "ACCEPT" && raw.verdict !== "REJECT" && raw.verdict !== "HOLD") throw new Error("observation.verdict is invalid");
  if (!Array.isArray(raw.citations)) throw new Error("observation.citations must be an array");
  const citations = raw.citations.map((entry, index) => parseCitation(entry, `observation.citations[${index}]`));
  if (new Set(citations.map((entry) => entry.kind)).size !== citations.length) throw new Error("observation has duplicate citation kinds");
  const arm = raw.arm as ComparisonArm;
  const blindId = text(raw.blind_id, "observation.blind_id");
  const pair = pairForObservation(protocol, blindId, arm);
  const parsed: OutputTrajectoryObservation = {
    schema: OUTPUT_TRAJECTORY_OBSERVATION,
    observation_id: text(raw.observation_id, "observation.observation_id"),
    protocol_sha256: hash(raw.protocol_sha256, "observation.protocol_sha256"),
    blind_id: blindId,
    arm,
    task_input_sha256: hash(raw.task_input_sha256, "observation.task_input_sha256"),
    task_contract_sha256: hash(raw.task_contract_sha256, "observation.task_contract_sha256"),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, "observation.authority_envelope_sha256"),
    rubric_sha256: hash(raw.rubric_sha256, "observation.rubric_sha256"),
    verdict: raw.verdict,
    citations,
    reproduction_rate: ratio(raw.reproduction_rate, "observation.reproduction_rate"),
    boundary_valid: bool(raw.boundary_valid, "observation.boundary_valid"),
    contamination_detected: bool(raw.contamination_detected, "observation.contamination_detected"),
    latency_ms: nonnegative(raw.latency_ms, "observation.latency_ms"),
    cost_usd: nonnegative(raw.cost_usd, "observation.cost_usd"),
    token_count: integer(raw.token_count, "observation.token_count"),
    compute_seconds: nonnegative(raw.compute_seconds, "observation.compute_seconds"),
    storage_bytes: integer(raw.storage_bytes, "observation.storage_bytes"),
    observation_sha256: hash(raw.observation_sha256, "observation.observation_sha256"),
  };
  if (parsed.protocol_sha256 !== protocol.protocol_sha256) throw new Error("observation protocol hash mismatch");
  if (parsed.task_input_sha256 !== pair.task_input_sha256 || parsed.task_contract_sha256 !== pair.task_contract_sha256 || parsed.authority_envelope_sha256 !== pair.authority_envelope_sha256 || parsed.rubric_sha256 !== pair.rubric_sha256) {
    throw new Error("observation task, authority, or rubric identity drift");
  }
  if (computeObservationHash(parsed) !== parsed.observation_sha256) throw new Error("observation hash mismatch");
  return parsed;
}

export function observationCell(value: Pick<OutputTrajectoryObservation, "blind_id" | "arm">): string {
  return `${value.blind_id}:${value.arm}`;
}

export function hasPermittedEvidence(observation: OutputTrajectoryObservation): boolean {
  if (observation.verdict === "HOLD") return true;
  const kinds = new Set(observation.citations.map((citation) => citation.kind));
  if (observation.arm === "output_judge") {
    return observation.citations.length > 0 && observation.citations.every((citation) =>
      (OUTPUT_EVIDENCE_KINDS as readonly string[]).includes(citation.kind));
  }
  return observation.citations.every((citation) =>
    (TRAJECTORY_EVIDENCE_KINDS as readonly string[]).includes(citation.kind)) &&
    TRAJECTORY_EVIDENCE_KINDS.every((kind) => kinds.has(kind));
}

function parseVerdictEvidence(value: unknown, label: string): BlindedVerdictEvidence {
  const raw = object(value, label);
  exactKeys(raw, VERDICT_EVIDENCE_KEYS, label);
  if (raw.verdict !== "ACCEPT" && raw.verdict !== "REJECT" && raw.verdict !== "HOLD") throw new Error(`${label}.verdict is invalid`);
  if (!Array.isArray(raw.citations)) throw new Error(`${label}.citations must be an array`);
  return {
    blind_id: text(raw.blind_id, `${label}.blind_id`),
    verdict: raw.verdict,
    citations: raw.citations.map((entry, index) => parseCitation(entry, `${label}.citations[${index}]`)),
  };
}

export function parseSummary(value: unknown): OutputTrajectorySummary {
  noSensitive(value, "summary");
  const raw = object(value, "summary");
  exactKeys(raw, SUMMARY_KEYS, "summary");
  if (raw.schema !== OUTPUT_TRAJECTORY_SUMMARY) throw new Error(`summary.schema must be ${OUTPUT_TRAJECTORY_SUMMARY}`);
  if (!EVIDENCE_CLASSES.includes(raw.evidence_class as EvidenceClass)) throw new Error("summary.evidence_class is invalid");
  if (!Array.isArray(raw.metrics) || raw.metrics.length !== COMPARISON_METRICS.length) throw new Error("summary.metrics must contain all five metrics");
  const metrics = raw.metrics.map((entry, index): MetricComparison => {
    const label = `summary.metrics[${index}]`;
    const metric = object(entry, label);
    exactKeys(metric, METRIC_KEYS, label);
    if (metric.metric !== COMPARISON_METRICS[index]) throw new Error("summary.metrics order or identity drift");
    const expectedDirection = metric.metric === "reproduction_rate" ? "trajectory_verifier_minus_output_judge" : "output_judge_minus_trajectory_verifier";
    if (metric.delta_direction !== expectedDirection) throw new Error(`${label}.delta_direction is invalid`);
    const rawInterval = object(metric.interval, `${label}.interval`);
    exactKeys(rawInterval, INTERVAL_KEYS, `${label}.interval`);
    if (rawInterval.confidence_level !== 0.95 || rawInterval.method !== "paired-normal-95") throw new Error(`${label}.interval contract is invalid`);
    const lower = rawInterval.lower;
    const upper = rawInterval.upper;
    if (typeof lower !== "number" || !Number.isFinite(lower) || typeof upper !== "number" || !Number.isFinite(upper) || lower > upper) throw new Error(`${label}.interval bounds are invalid`);
    for (const field of ["output_judge_mean", "trajectory_verifier_mean", "mean_delta"] as const) {
      if (typeof metric[field] !== "number" || !Number.isFinite(metric[field])) throw new Error(`${label}.${field} must be finite`);
    }
    return {
      metric: metric.metric as ComparisonMetric,
      output_judge_mean: metric.output_judge_mean as number,
      trajectory_verifier_mean: metric.trajectory_verifier_mean as number,
      mean_delta: metric.mean_delta as number,
      delta_direction: expectedDirection,
      interval: { confidence_level: 0.95, method: "paired-normal-95", lower, upper },
    };
  });
  if (!Array.isArray(raw.disagreements)) throw new Error("summary.disagreements must be an array");
  const disagreements = raw.disagreements.map((entry, index): ComparisonDisagreement => {
    const label = `summary.disagreements[${index}]`;
    const disagreement = object(entry, label);
    exactKeys(disagreement, DISAGREEMENT_KEYS, label);
    if (!CASE_CLASSES.includes(disagreement.case_class as CaseClass)) throw new Error(`${label}.case_class is invalid`);
    const parsed = {
      queue_id: hash(disagreement.queue_id, `${label}.queue_id`),
      pair_id: text(disagreement.pair_id, `${label}.pair_id`),
      case_class: disagreement.case_class as CaseClass,
      adjudication_sha256: hash(disagreement.adjudication_sha256, `${label}.adjudication_sha256`),
      output_judge: parseVerdictEvidence(disagreement.output_judge, `${label}.output_judge`),
      trajectory_verifier: parseVerdictEvidence(disagreement.trajectory_verifier, `${label}.trajectory_verifier`),
    };
    const { queue_id: _ignored, ...base } = parsed;
    if (comparisonSha256(base) !== parsed.queue_id) throw new Error(`${label}.queue_id hash mismatch`);
    return parsed;
  });
  if (new Set(disagreements.map((entry) => entry.queue_id)).size !== disagreements.length) throw new Error("summary has duplicate disagreement queue ids");
  if (raw.disposition !== "TRAJECTORY_BENEFIT_SUPPORTED" && raw.disposition !== "NULL_OR_NEGATIVE" && raw.disposition !== "HOLD") throw new Error("summary.disposition is invalid");
  if (!Array.isArray(raw.reasons) || raw.reasons.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error("summary.reasons is invalid");
  if (raw.advisory_only !== true || !Array.isArray(raw.policy_mutations) || raw.policy_mutations.length !== 0) throw new Error("summary must be advisory-only with no policy mutations");
  const parsed: OutputTrajectorySummary = {
    schema: OUTPUT_TRAJECTORY_SUMMARY,
    protocol_id: text(raw.protocol_id, "summary.protocol_id"),
    protocol_sha256: hash(raw.protocol_sha256, "summary.protocol_sha256"),
    evidence_class: raw.evidence_class as EvidenceClass,
    complete_pairs: integer(raw.complete_pairs, "summary.complete_pairs"),
    observations: integer(raw.observations, "summary.observations"),
    metrics,
    disagreements,
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
  if (computeSummaryHash(parsed) !== parsed.summary_sha256) throw new Error("summary hash mismatch");
  return parsed;
}
