import { createHash } from "node:crypto";
import {
  canonicalize,
  parseRunReceipt,
  reconstructRunReceipt,
  reduceRunEvents,
} from "./run-receipt-contract.ts";
import { validateEdgeProofRecord } from "./run-edge-proof.ts";

export const CANONICAL_RECEIPT_PARSER = parseRunReceipt;
export const CANONICAL_EVENT_REDUCER = reduceRunEvents;
export const CANONICAL_RECEIPT_RECONSTRUCTOR = reconstructRunReceipt;
export const CANONICAL_EDGE_PROOF_VALIDATOR = validateEdgeProofRecord;

export const SILENT_SUCCESS_PROTOCOL = "silent-success-receipt-comparison/v1" as const;
export const SILENT_SUCCESS_OBSERVATION = "silent-success-observation/v1" as const;
export const SILENT_SUCCESS_SUMMARY = "silent-success-summary/v1" as const;
export const COMPARISON_ARMS = ["transcript_only", "tool_result", "canonical_receipt"] as const;
export const EVIDENCE_CLASSES = ["synthetic_qualification", "phase_d_observation"] as const;
export const FAILURE_CLASSES = [
  "missing_edge_proof",
  "approval_drift",
  "overlapping_writers",
  "dangling_calls",
  "partial_commits",
  "timeout",
  "late_arrival",
  "unavailable_proof",
  "degraded_dependency",
] as const;
export const COMPARISON_METRICS = [
  "incident_detection_sensitivity",
  "matched_control_false_alarm_rate",
  "diagnosis_time_ms",
  "operator_actions",
  "latency_ms",
  "cost_usd",
] as const;
export const TRANSCRIPT_EVIDENCE_KINDS = [
  "transcript_sha256",
  "declared_terminal_status_sha256",
  "declared_artifact_list_sha256",
] as const;
export const TOOL_RESULT_EVIDENCE_KINDS = [
  "tool_call_sequence_sha256",
  "tool_result_sha256",
  "adapter_status_sha256",
  "exit_code_sha256",
] as const;
export const RECEIPT_EVIDENCE_KINDS = [
  "receipt_sha256",
  "ordered_events_sha256",
  "inherited_state_refs_sha256",
  "authority_envelope_sha256",
  "terminal_outcome_sha256",
  "edge_proof_record_sha256",
  "replayed_receipt_sha256",
] as const;

export type ComparisonArm = typeof COMPARISON_ARMS[number];
export type EvidenceClass = typeof EVIDENCE_CLASSES[number];
export type FailureClass = typeof FAILURE_CLASSES[number];
export type ComparisonMetric = typeof COMPARISON_METRICS[number];
export type EvidenceKind =
  | typeof TRANSCRIPT_EVIDENCE_KINDS[number]
  | typeof TOOL_RESULT_EVIDENCE_KINDS[number]
  | typeof RECEIPT_EVIDENCE_KINDS[number];
export type ComparisonDisposition =
  | "RECEIPT_BENEFIT_SUPPORTED"
  | "NULL_OR_NEGATIVE"
  | "OPERATOR_REVIEW_REQUIRED"
  | "HOLD";

export interface ComparisonBudget {
  maximum_runs: 90;
  maximum_cost_usd: number;
  maximum_tokens: number;
  maximum_compute_hours: number;
  maximum_storage_gib: number;
  per_run_timeout_minutes: number;
}

export interface BlindIds {
  transcript_only: string;
  tool_result: string;
  canonical_receipt: string;
}

export interface IncidentControlPair {
  pair_id: string;
  failure_class: FailureClass;
  seed: number;
  task_contract_sha256: string;
  authority_envelope_sha256: string;
  incident_input_sha256: string;
  matched_control_sha256: string;
  adjudication_sha256: string;
  blind_ids: BlindIds;
}

export interface SilentSuccessProtocol {
  schema: typeof SILENT_SUCCESS_PROTOCOL;
  protocol_id: string;
  evidence_class: EvidenceClass;
  cohort_id: string;
  cohort_sha256: string;
  arms: ComparisonArm[];
  planned_pairs: 30;
  planned_runs: 90;
  minimum_complete_pairs: 30;
  confidence_level: 0.95;
  raw_rate_interval_method: "wilson-95";
  paired_delta_interval_method: "paired-normal-95";
  median_interval_method: "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash";
  primary_metric: "incident_detection_sensitivity";
  metrics: ComparisonMetric[];
  replay_threshold: 0.9;
  overhead_ratio_ceiling: 1.1;
  boundary_failures_allowed: 0;
  contamination_detections_allowed: 0;
  redaction_failures_allowed: 0;
  advisory_only: true;
  live_system_calls: 0;
  policy_mutations: [];
  budget: ComparisonBudget;
  pairs: IncidentControlPair[];
  protocol_sha256: string;
}

export interface EvidenceCitation {
  kind: EvidenceKind;
  sha256: string;
}

export interface SilentSuccessObservation {
  schema: typeof SILENT_SUCCESS_OBSERVATION;
  observation_id: string;
  protocol_sha256: string;
  blind_id: string;
  arm: ComparisonArm;
  task_contract_sha256: string;
  authority_envelope_sha256: string;
  incident_input_sha256: string;
  matched_control_sha256: string;
  citations: EvidenceCitation[];
  redaction_manifest_sha256: string;
  incident_detected: boolean;
  control_false_alarm: boolean;
  diagnosis_time_ms: number;
  operator_actions: number;
  latency_ms: number;
  cost_usd: number;
  token_count: number;
  compute_seconds: number;
  storage_bytes: number;
  canonical_replay_verified: boolean | null;
  boundary_valid: boolean;
  contamination_detected: boolean;
  redaction_valid: boolean;
  observation_sha256: string;
}

export interface ConfidenceInterval {
  confidence_level: 0.95;
  method: "wilson-95" | "paired-normal-95" | "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash";
  lower: number;
  upper: number;
}

export interface ArmMetrics {
  arm: ComparisonArm;
  incident_detection_sensitivity: number;
  incident_detection_interval: ConfidenceInterval;
  matched_control_false_alarm_rate: number;
  matched_control_false_alarm_interval: ConfidenceInterval;
  diagnosis_time_ms_median: number;
  diagnosis_time_ms_interval: ConfidenceInterval;
  operator_actions_median: number;
  operator_actions_interval: ConfidenceInterval;
  latency_ms_median: number;
  latency_ms_interval: ConfidenceInterval;
  cost_usd_median: number;
  cost_usd_interval: ConfidenceInterval;
  canonical_replay_rate: number | null;
}

export interface ReceiptComparison {
  comparator: "transcript_only" | "tool_result";
  incident_detection_delta: number;
  incident_detection_delta_interval: ConfidenceInterval;
  false_alarm_delta: number;
  false_alarm_delta_interval: ConfidenceInterval;
  diagnosis_time_delta_ms: number;
  diagnosis_time_delta_interval: ConfidenceInterval;
  operator_actions_delta: number;
  operator_actions_delta_interval: ConfidenceInterval;
  latency_ratio: number;
  cost_ratio: number;
}

export interface SilentSuccessSummary {
  schema: typeof SILENT_SUCCESS_SUMMARY;
  protocol_id: string;
  protocol_sha256: string;
  evidence_class: EvidenceClass;
  complete_pairs: number;
  observations: number;
  arm_metrics: ArmMetrics[];
  receipt_comparisons: ReceiptComparison[];
  total_cost_usd: number;
  total_tokens: number;
  total_compute_hours: number;
  total_storage_gib: number;
  disposition: ComparisonDisposition;
  reasons: string[];
  advisory_only: true;
  policy_mutations: [];
  summary_sha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,127}$/i;
const SECRET_VALUE = /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const FORBIDDEN_FIELDS = new Set([
  "raw_transcript", "raw_tool_result", "raw_receipt", "raw_provider_payload", "raw_prompt",
  "raw_history", "user_message", "tenant_data", "ground_truth_label", "fixture_path",
  "manifest_path", "golden_patch", "hidden_answer", "holdout_plaintext", "credential", "secret",
]);
const PROTOCOL_KEYS = new Set([
  "schema", "protocol_id", "evidence_class", "cohort_id", "cohort_sha256", "arms",
  "planned_pairs", "planned_runs", "minimum_complete_pairs", "confidence_level",
  "raw_rate_interval_method", "paired_delta_interval_method", "median_interval_method",
  "primary_metric", "metrics", "replay_threshold", "overhead_ratio_ceiling",
  "boundary_failures_allowed", "contamination_detections_allowed", "redaction_failures_allowed",
  "advisory_only", "live_system_calls", "policy_mutations", "budget", "pairs", "protocol_sha256",
]);
const BUDGET_KEYS = new Set([
  "maximum_runs", "maximum_cost_usd", "maximum_tokens", "maximum_compute_hours",
  "maximum_storage_gib", "per_run_timeout_minutes",
]);
const PAIR_KEYS = new Set([
  "pair_id", "failure_class", "seed", "task_contract_sha256", "authority_envelope_sha256",
  "incident_input_sha256", "matched_control_sha256", "adjudication_sha256", "blind_ids",
]);
const BLIND_KEYS = new Set(COMPARISON_ARMS);
const OBSERVATION_KEYS = new Set([
  "schema", "observation_id", "protocol_sha256", "blind_id", "arm", "task_contract_sha256",
  "authority_envelope_sha256", "incident_input_sha256", "matched_control_sha256", "citations",
  "redaction_manifest_sha256", "incident_detected", "control_false_alarm", "diagnosis_time_ms",
  "operator_actions", "latency_ms", "cost_usd", "token_count", "compute_seconds", "storage_bytes",
  "canonical_replay_verified", "boundary_valid", "contamination_detected", "redaction_valid",
  "observation_sha256",
]);
const CITATION_KEYS = new Set(["kind", "sha256"]);
const SUMMARY_KEYS = new Set([
  "schema", "protocol_id", "protocol_sha256", "evidence_class", "complete_pairs", "observations",
  "arm_metrics", "receipt_comparisons", "total_cost_usd", "total_tokens", "total_compute_hours",
  "total_storage_gib", "disposition", "reasons", "advisory_only", "policy_mutations", "summary_sha256",
]);
const ARM_METRIC_KEYS = new Set([
  "arm", "incident_detection_sensitivity", "incident_detection_interval",
  "matched_control_false_alarm_rate", "matched_control_false_alarm_interval",
  "diagnosis_time_ms_median", "diagnosis_time_ms_interval", "operator_actions_median",
  "operator_actions_interval", "latency_ms_median", "latency_ms_interval", "cost_usd_median",
  "cost_usd_interval", "canonical_replay_rate",
]);
const RECEIPT_COMPARISON_KEYS = new Set([
  "comparator", "incident_detection_delta", "incident_detection_delta_interval", "false_alarm_delta",
  "false_alarm_delta_interval", "diagnosis_time_delta_ms", "diagnosis_time_delta_interval",
  "operator_actions_delta", "operator_actions_delta_interval", "latency_ratio", "cost_ratio",
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

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
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

function nullableBool(value: unknown, label: string): boolean | null {
  if (value !== null && typeof value !== "boolean") throw new Error(`${label} must be boolean or null`);
  return value as boolean | null;
}

function parseBudget(value: unknown): ComparisonBudget {
  const raw = object(value, "budget");
  exactKeys(raw, BUDGET_KEYS, "budget");
  if (raw.maximum_runs !== 90) throw new Error("budget.maximum_runs must be 90");
  const budget: ComparisonBudget = {
    maximum_runs: 90,
    maximum_cost_usd: nonnegative(raw.maximum_cost_usd, "budget.maximum_cost_usd"),
    maximum_tokens: integer(raw.maximum_tokens, "budget.maximum_tokens"),
    maximum_compute_hours: nonnegative(raw.maximum_compute_hours, "budget.maximum_compute_hours"),
    maximum_storage_gib: nonnegative(raw.maximum_storage_gib, "budget.maximum_storage_gib"),
    per_run_timeout_minutes: nonnegative(raw.per_run_timeout_minutes, "budget.per_run_timeout_minutes"),
  };
  if (budget.maximum_cost_usd > 425 || budget.maximum_tokens > 55_000_000 ||
      budget.maximum_compute_hours > 110 || budget.maximum_storage_gib > 7 ||
      budget.per_run_timeout_minutes > 30) throw new Error("budget exceeds a Phase D ceiling");
  return budget;
}

function parsePair(value: unknown, index: number): IncidentControlPair {
  const label = `pairs[${index}]`;
  const raw = object(value, label);
  exactKeys(raw, PAIR_KEYS, label);
  if (!FAILURE_CLASSES.includes(raw.failure_class as FailureClass)) throw new Error(`${label}.failure_class is invalid`);
  const blind = object(raw.blind_ids, `${label}.blind_ids`);
  exactKeys(blind, BLIND_KEYS, `${label}.blind_ids`);
  const pair: IncidentControlPair = {
    pair_id: text(raw.pair_id, `${label}.pair_id`),
    failure_class: raw.failure_class as FailureClass,
    seed: integer(raw.seed, `${label}.seed`),
    task_contract_sha256: hash(raw.task_contract_sha256, `${label}.task_contract_sha256`),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, `${label}.authority_envelope_sha256`),
    incident_input_sha256: hash(raw.incident_input_sha256, `${label}.incident_input_sha256`),
    matched_control_sha256: hash(raw.matched_control_sha256, `${label}.matched_control_sha256`),
    adjudication_sha256: hash(raw.adjudication_sha256, `${label}.adjudication_sha256`),
    blind_ids: {
      transcript_only: text(blind.transcript_only, `${label}.blind_ids.transcript_only`),
      tool_result: text(blind.tool_result, `${label}.blind_ids.tool_result`),
      canonical_receipt: text(blind.canonical_receipt, `${label}.blind_ids.canonical_receipt`),
    },
  };
  if (new Set(Object.values(pair.blind_ids)).size !== 3) throw new Error(`${label} blind ids must differ`);
  return pair;
}

function parseCitation(value: unknown, label: string): EvidenceCitation {
  const raw = object(value, label);
  exactKeys(raw, CITATION_KEYS, label);
  const kinds = [...TRANSCRIPT_EVIDENCE_KINDS, ...TOOL_RESULT_EVIDENCE_KINDS, ...RECEIPT_EVIDENCE_KINDS] as readonly string[];
  if (!kinds.includes(raw.kind as string)) throw new Error(`${label}.kind is invalid`);
  return { kind: raw.kind as EvidenceKind, sha256: hash(raw.sha256, `${label}.sha256`) };
}

export function comparisonSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function computeProtocolHash(value: Omit<SilentSuccessProtocol, "protocol_sha256"> | SilentSuccessProtocol): string {
  const { protocol_sha256: _ignored, ...base } = value as SilentSuccessProtocol;
  return comparisonSha256(base);
}

export function computeObservationHash(value: Omit<SilentSuccessObservation, "observation_sha256"> | SilentSuccessObservation): string {
  const { observation_sha256: _ignored, ...base } = value as SilentSuccessObservation;
  return comparisonSha256(base);
}

export function computeSummaryHash(value: Omit<SilentSuccessSummary, "summary_sha256"> | SilentSuccessSummary): string {
  const { summary_sha256: _ignored, ...base } = value as SilentSuccessSummary;
  return comparisonSha256(base);
}

export function finalizeProtocol(value: Omit<SilentSuccessProtocol, "protocol_sha256">): SilentSuccessProtocol {
  return { ...value, protocol_sha256: computeProtocolHash(value) };
}

export function finalizeObservation(value: Omit<SilentSuccessObservation, "observation_sha256">): SilentSuccessObservation {
  return { ...value, observation_sha256: computeObservationHash(value) };
}

export function parseProtocol(value: unknown): SilentSuccessProtocol {
  noSensitive(value, "protocol");
  const raw = object(value, "protocol");
  exactKeys(raw, PROTOCOL_KEYS, "protocol");
  if (raw.schema !== SILENT_SUCCESS_PROTOCOL) throw new Error(`protocol.schema must be ${SILENT_SUCCESS_PROTOCOL}`);
  if (!EVIDENCE_CLASSES.includes(raw.evidence_class as EvidenceClass)) throw new Error("protocol.evidence_class is invalid");
  if (!Array.isArray(raw.arms) || canonicalize(raw.arms) !== canonicalize(COMPARISON_ARMS)) throw new Error("protocol.arms must freeze exactly three ordered arms");
  if (raw.planned_pairs !== 30 || raw.planned_runs !== 90 || raw.minimum_complete_pairs !== 30) throw new Error("protocol sample contract must be 30 pairs and 90 runs");
  if (raw.confidence_level !== 0.95 || raw.raw_rate_interval_method !== "wilson-95" ||
      raw.paired_delta_interval_method !== "paired-normal-95" ||
      raw.median_interval_method !== "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash" ||
      raw.primary_metric !== "incident_detection_sensitivity") throw new Error("protocol statistical contract is invalid");
  if (!Array.isArray(raw.metrics) || canonicalize(raw.metrics) !== canonicalize(COMPARISON_METRICS)) throw new Error("protocol.metrics must match the frozen order");
  if (raw.replay_threshold !== 0.9 || raw.overhead_ratio_ceiling !== 1.1 ||
      raw.boundary_failures_allowed !== 0 || raw.contamination_detections_allowed !== 0 ||
      raw.redaction_failures_allowed !== 0) throw new Error("protocol benefit and safety thresholds are invalid");
  if (raw.advisory_only !== true || raw.live_system_calls !== 0 || !Array.isArray(raw.policy_mutations) || raw.policy_mutations.length !== 0) throw new Error("protocol must be advisory, prerecorded-only, and mutation-free");
  if (!Array.isArray(raw.pairs) || raw.pairs.length !== 30) throw new Error("protocol.pairs must contain exactly 30 pairs");
  const pairs = raw.pairs.map(parsePair);
  if (new Set(pairs.map((pair) => pair.pair_id)).size !== pairs.length) throw new Error("protocol has duplicate pair ids");
  const blindIds = pairs.flatMap((pair) => Object.values(pair.blind_ids));
  if (new Set(blindIds).size !== blindIds.length) throw new Error("protocol has duplicate blind ids");
  const expectedCounts: Record<FailureClass, number> = {
    missing_edge_proof: 4,
    approval_drift: 4,
    overlapping_writers: 4,
    dangling_calls: 3,
    partial_commits: 3,
    timeout: 3,
    late_arrival: 3,
    unavailable_proof: 3,
    degraded_dependency: 3,
  };
  for (const failureClass of FAILURE_CLASSES) {
    if (pairs.filter((pair) => pair.failure_class === failureClass).length !== expectedCounts[failureClass]) throw new Error(`protocol failure-class count mismatch: ${failureClass}`);
  }
  const parsed: SilentSuccessProtocol = {
    schema: SILENT_SUCCESS_PROTOCOL,
    protocol_id: text(raw.protocol_id, "protocol.protocol_id"),
    evidence_class: raw.evidence_class as EvidenceClass,
    cohort_id: text(raw.cohort_id, "protocol.cohort_id"),
    cohort_sha256: hash(raw.cohort_sha256, "protocol.cohort_sha256"),
    arms: [...COMPARISON_ARMS],
    planned_pairs: 30,
    planned_runs: 90,
    minimum_complete_pairs: 30,
    confidence_level: 0.95,
    raw_rate_interval_method: "wilson-95",
    paired_delta_interval_method: "paired-normal-95",
    median_interval_method: "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash",
    primary_metric: "incident_detection_sensitivity",
    metrics: [...COMPARISON_METRICS],
    replay_threshold: 0.9,
    overhead_ratio_ceiling: 1.1,
    boundary_failures_allowed: 0,
    contamination_detections_allowed: 0,
    redaction_failures_allowed: 0,
    advisory_only: true,
    live_system_calls: 0,
    policy_mutations: [],
    budget: parseBudget(raw.budget),
    pairs,
    protocol_sha256: hash(raw.protocol_sha256, "protocol.protocol_sha256"),
  };
  if (computeProtocolHash(parsed) !== parsed.protocol_sha256) throw new Error("protocol hash mismatch");
  return parsed;
}

export function pairForObservation(protocol: SilentSuccessProtocol, blindId: string, arm: ComparisonArm): IncidentControlPair {
  const pair = protocol.pairs.find((entry) => entry.blind_ids[arm] === blindId);
  if (!pair) throw new Error("observation blind id is not in protocol for its arm");
  return pair;
}

export function parseObservation(value: unknown, protocol: SilentSuccessProtocol): SilentSuccessObservation {
  noSensitive(value, "observation");
  const raw = object(value, "observation");
  exactKeys(raw, OBSERVATION_KEYS, "observation");
  if (raw.schema !== SILENT_SUCCESS_OBSERVATION) throw new Error(`observation.schema must be ${SILENT_SUCCESS_OBSERVATION}`);
  if (!COMPARISON_ARMS.includes(raw.arm as ComparisonArm)) throw new Error("observation.arm is invalid");
  const arm = raw.arm as ComparisonArm;
  const blindId = text(raw.blind_id, "observation.blind_id");
  const pair = pairForObservation(protocol, blindId, arm);
  const citations = Array.isArray(raw.citations) ? raw.citations.map((entry, index) => parseCitation(entry, `observation.citations[${index}]`)) : (() => { throw new Error("observation.citations must be an array"); })();
  if (new Set(citations.map((entry) => entry.kind)).size !== citations.length) throw new Error("observation has duplicate citation kinds");
  const observation: SilentSuccessObservation = {
    schema: SILENT_SUCCESS_OBSERVATION,
    observation_id: text(raw.observation_id, "observation.observation_id"),
    protocol_sha256: hash(raw.protocol_sha256, "observation.protocol_sha256"),
    blind_id: blindId,
    arm,
    task_contract_sha256: hash(raw.task_contract_sha256, "observation.task_contract_sha256"),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, "observation.authority_envelope_sha256"),
    incident_input_sha256: hash(raw.incident_input_sha256, "observation.incident_input_sha256"),
    matched_control_sha256: hash(raw.matched_control_sha256, "observation.matched_control_sha256"),
    citations,
    redaction_manifest_sha256: hash(raw.redaction_manifest_sha256, "observation.redaction_manifest_sha256"),
    incident_detected: bool(raw.incident_detected, "observation.incident_detected"),
    control_false_alarm: bool(raw.control_false_alarm, "observation.control_false_alarm"),
    diagnosis_time_ms: nonnegative(raw.diagnosis_time_ms, "observation.diagnosis_time_ms"),
    operator_actions: integer(raw.operator_actions, "observation.operator_actions"),
    latency_ms: nonnegative(raw.latency_ms, "observation.latency_ms"),
    cost_usd: nonnegative(raw.cost_usd, "observation.cost_usd"),
    token_count: integer(raw.token_count, "observation.token_count"),
    compute_seconds: nonnegative(raw.compute_seconds, "observation.compute_seconds"),
    storage_bytes: integer(raw.storage_bytes, "observation.storage_bytes"),
    canonical_replay_verified: nullableBool(raw.canonical_replay_verified, "observation.canonical_replay_verified"),
    boundary_valid: bool(raw.boundary_valid, "observation.boundary_valid"),
    contamination_detected: bool(raw.contamination_detected, "observation.contamination_detected"),
    redaction_valid: bool(raw.redaction_valid, "observation.redaction_valid"),
    observation_sha256: hash(raw.observation_sha256, "observation.observation_sha256"),
  };
  if (observation.protocol_sha256 !== protocol.protocol_sha256) throw new Error("observation protocol identity drift");
  if (observation.task_contract_sha256 !== pair.task_contract_sha256 ||
      observation.authority_envelope_sha256 !== pair.authority_envelope_sha256 ||
      observation.incident_input_sha256 !== pair.incident_input_sha256 ||
      observation.matched_control_sha256 !== pair.matched_control_sha256) throw new Error("observation incident-control identity drift");
  if (arm === "canonical_receipt" ? observation.canonical_replay_verified === null : observation.canonical_replay_verified !== null) throw new Error("observation replay field does not match its arm");
  if (computeObservationHash(observation) !== observation.observation_sha256) throw new Error("observation hash mismatch");
  return observation;
}

export function requiredEvidenceKinds(arm: ComparisonArm): readonly EvidenceKind[] {
  if (arm === "transcript_only") return TRANSCRIPT_EVIDENCE_KINDS;
  if (arm === "tool_result") return TOOL_RESULT_EVIDENCE_KINDS;
  return RECEIPT_EVIDENCE_KINDS;
}

export function hasPermittedEvidence(observation: SilentSuccessObservation): boolean {
  const expected = requiredEvidenceKinds(observation.arm);
  return observation.citations.length === expected.length &&
    observation.citations.every((entry, index) => entry.kind === expected[index]);
}

export function observationCell(value: Pick<SilentSuccessObservation, "blind_id" | "arm">): string {
  return `${value.arm}:${value.blind_id}`;
}

function parseInterval(value: unknown, label: string): ConfidenceInterval {
  const raw = object(value, label);
  exactKeys(raw, INTERVAL_KEYS, label);
  const methods = ["wilson-95", "paired-normal-95", "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash"];
  if (raw.confidence_level !== 0.95 || !methods.includes(raw.method as string)) throw new Error(`${label} contract is invalid`);
  const lower = typeof raw.lower === "number" && Number.isFinite(raw.lower) ? raw.lower : Number.NaN;
  const upper = typeof raw.upper === "number" && Number.isFinite(raw.upper) ? raw.upper : Number.NaN;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) throw new Error(`${label} bounds are invalid`);
  return { confidence_level: 0.95, method: raw.method as ConfidenceInterval["method"], lower, upper };
}

export function parseSummary(value: unknown): SilentSuccessSummary {
  noSensitive(value, "summary");
  const raw = object(value, "summary");
  exactKeys(raw, SUMMARY_KEYS, "summary");
  if (raw.schema !== SILENT_SUCCESS_SUMMARY) throw new Error(`summary.schema must be ${SILENT_SUCCESS_SUMMARY}`);
  if (!EVIDENCE_CLASSES.includes(raw.evidence_class as EvidenceClass)) throw new Error("summary.evidence_class is invalid");
  if (!Array.isArray(raw.arm_metrics) || raw.arm_metrics.length !== 3) throw new Error("summary.arm_metrics must contain three arms");
  raw.arm_metrics.forEach((entry, index) => {
    const item = object(entry, `summary.arm_metrics[${index}]`);
    exactKeys(item, ARM_METRIC_KEYS, `summary.arm_metrics[${index}]`);
    if (item.arm !== COMPARISON_ARMS[index]) throw new Error("summary arm order or identity drift");
    ratio(item.incident_detection_sensitivity, `summary.arm_metrics[${index}].incident_detection_sensitivity`);
    ratio(item.matched_control_false_alarm_rate, `summary.arm_metrics[${index}].matched_control_false_alarm_rate`);
    nonnegative(item.diagnosis_time_ms_median, `summary.arm_metrics[${index}].diagnosis_time_ms_median`);
    nonnegative(item.operator_actions_median, `summary.arm_metrics[${index}].operator_actions_median`);
    nonnegative(item.latency_ms_median, `summary.arm_metrics[${index}].latency_ms_median`);
    nonnegative(item.cost_usd_median, `summary.arm_metrics[${index}].cost_usd_median`);
    if (item.canonical_replay_rate !== null) ratio(item.canonical_replay_rate, `summary.arm_metrics[${index}].canonical_replay_rate`);
    parseInterval(item.incident_detection_interval, `summary.arm_metrics[${index}].incident_detection_interval`);
    parseInterval(item.matched_control_false_alarm_interval, `summary.arm_metrics[${index}].matched_control_false_alarm_interval`);
    parseInterval(item.diagnosis_time_ms_interval, `summary.arm_metrics[${index}].diagnosis_time_ms_interval`);
    parseInterval(item.operator_actions_interval, `summary.arm_metrics[${index}].operator_actions_interval`);
    parseInterval(item.latency_ms_interval, `summary.arm_metrics[${index}].latency_ms_interval`);
    parseInterval(item.cost_usd_interval, `summary.arm_metrics[${index}].cost_usd_interval`);
  });
  const dispositions: ComparisonDisposition[] = ["RECEIPT_BENEFIT_SUPPORTED", "NULL_OR_NEGATIVE", "OPERATOR_REVIEW_REQUIRED", "HOLD"];
  if (!dispositions.includes(raw.disposition as ComparisonDisposition)) throw new Error("summary.disposition is invalid");
  if (!Array.isArray(raw.receipt_comparisons) ||
      (raw.receipt_comparisons.length !== 2 && !(raw.disposition === "HOLD" && raw.receipt_comparisons.length === 0))) {
    throw new Error("summary.receipt_comparisons must contain two comparators unless incomplete evidence is held");
  }
  raw.receipt_comparisons.forEach((entry, index) => {
    const item = object(entry, `summary.receipt_comparisons[${index}]`);
    exactKeys(item, RECEIPT_COMPARISON_KEYS, `summary.receipt_comparisons[${index}]`);
    if (item.comparator !== COMPARISON_ARMS[index]) throw new Error("summary comparator order or identity drift");
    finite(item.incident_detection_delta, `summary.receipt_comparisons[${index}].incident_detection_delta`);
    finite(item.false_alarm_delta, `summary.receipt_comparisons[${index}].false_alarm_delta`);
    finite(item.diagnosis_time_delta_ms, `summary.receipt_comparisons[${index}].diagnosis_time_delta_ms`);
    finite(item.operator_actions_delta, `summary.receipt_comparisons[${index}].operator_actions_delta`);
    nonnegative(item.latency_ratio, `summary.receipt_comparisons[${index}].latency_ratio`);
    nonnegative(item.cost_ratio, `summary.receipt_comparisons[${index}].cost_ratio`);
    parseInterval(item.incident_detection_delta_interval, `summary.receipt_comparisons[${index}].incident_detection_delta_interval`);
    parseInterval(item.false_alarm_delta_interval, `summary.receipt_comparisons[${index}].false_alarm_delta_interval`);
    parseInterval(item.diagnosis_time_delta_interval, `summary.receipt_comparisons[${index}].diagnosis_time_delta_interval`);
    parseInterval(item.operator_actions_delta_interval, `summary.receipt_comparisons[${index}].operator_actions_delta_interval`);
  });
  if (raw.advisory_only !== true || !Array.isArray(raw.policy_mutations) || raw.policy_mutations.length !== 0) throw new Error("summary must remain advisory and mutation-free");
  const summary = structuredClone(raw) as unknown as SilentSuccessSummary;
  hash(summary.protocol_sha256, "summary.protocol_sha256");
  hash(summary.summary_sha256, "summary.summary_sha256");
  text(summary.protocol_id, "summary.protocol_id");
  integer(summary.complete_pairs, "summary.complete_pairs");
  integer(summary.observations, "summary.observations");
  nonnegative(summary.total_cost_usd, "summary.total_cost_usd");
  integer(summary.total_tokens, "summary.total_tokens");
  nonnegative(summary.total_compute_hours, "summary.total_compute_hours");
  nonnegative(summary.total_storage_gib, "summary.total_storage_gib");
  if (!Array.isArray(summary.reasons) || summary.reasons.some((entry) => typeof entry !== "string")) throw new Error("summary.reasons must be strings");
  if (computeSummaryHash(summary) !== summary.summary_sha256) throw new Error("summary hash mismatch");
  return summary;
}
