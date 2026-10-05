import { createHash } from "node:crypto";
import { validateLifecycleRecord } from "../../../Skills/skill-security-gate/scripts/lifecycle/gate.ts";
import type { CompatibilityRow, SkillLifecycleRecord } from "../../../Skills/skill-security-gate/scripts/lifecycle/types.ts";
import {
  parseScenarioSourceSummary,
  type ScenarioSourceSummary,
} from "./scenario-source-comparison-contract.ts";
import {
  parseSummary as parseOutputTrajectorySummary,
  type OutputTrajectorySummary,
} from "./output-trajectory-comparison-contract.ts";
import {
  parseSummary as parseSilentSuccessSummary,
  type SilentSuccessSummary,
} from "./silent-success-comparison-contract.ts";
import {
  parseHarnessPortabilityProtocol,
  parseHarnessPortabilitySummary,
  type HarnessPortabilityProtocol,
  type HarnessPortabilitySummary,
} from "./harness-portability-comparison-contract.ts";
import type { PortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";

export const SKILL_PROMOTION_PROTOCOL = "skill-promotion-decision/v1" as const;
export const SKILL_PROMOTION_PAIR = "skill-version-comparison-pair/v1" as const;
export const SKILL_PROMOTION_OBSERVATION = "skill-version-observation/v1" as const;
export const SKILL_COMPATIBILITY_MATRIX = "skill-compatibility-matrix/v1" as const;
export const SKILL_PROMOTION_SUMMARY = "skill-promotion-summary/v1" as const;
export const SKILL_PROMOTION_SIGNATURE = "skill-promotion-signature/v1" as const;
export const VERSION_ARMS = ["last-approved", "candidate"] as const;
export const COMPATIBILITY_INVENTORY = ["claude-code", "codex", "cursor", "gemini", "hermes"] as const;
export const PRIMARY_METRICS = [
  "verified_quality",
  "contract_conformance",
  "failure_rate",
  "recovery_rate",
  "latency_ms",
  "cost_usd",
  "edge_proof_completeness",
  "contamination_rate",
] as const;
export const PREDECESSOR_SCHEMAS = [
  "scenario-source-summary/v1",
  "output-trajectory-summary/v1",
  "silent-success-summary/v1",
  "harness-portability-summary/v1",
] as const;
const LOWER_IS_BETTER_FOR_CONTRACT = new Set<PrimaryMetric>(["failure_rate", "latency_ms", "cost_usd", "contamination_rate"]);

export type VersionArm = typeof VERSION_ARMS[number];
export type CompatibilityHarness = typeof COMPATIBILITY_INVENTORY[number];
export type PrimaryMetric = typeof PRIMARY_METRICS[number];
export type PromotionEvidenceClass = "synthetic_qualification" | "phase-d-production";
export type PromotionDecision = "PROMOTION_RECOMMENDED" | "HOLD" | "DENY";
export type PromotionMetricValues = Record<PrimaryMetric, number>;

export interface SkillPromotionBudget {
  maximum_runs: 110;
  required_runs: 60;
  maximum_cost_usd: 93.5;
  maximum_tokens: 12_100_000;
  maximum_compute_hours: 24.2;
  maximum_storage_gib: 1.54;
  per_run_timeout_minutes: 30;
}

export interface SkillPromotionPair {
  schema: typeof SKILL_PROMOTION_PAIR;
  protocol_id: string;
  pair_id: string;
  skill_slug: string;
  approved_version: string;
  approved_subject_sha256: string;
  candidate_version: string;
  candidate_subject_sha256: string;
  task_id: string;
  task_class: string;
  seed: number;
  input_contract_sha256: string;
  output_contract_sha256: string;
  verifier_contract_sha256: string;
  authority_envelope_sha256: string;
  pair_sha256: string;
}

export interface SkillPromotionProtocol {
  schema: typeof SKILL_PROMOTION_PROTOCOL;
  protocol_id: string;
  evidence_class: PromotionEvidenceClass;
  evaluation_time: string;
  skill_slug: string;
  approved_version: string;
  approved_subject_sha256: string;
  candidate_version: string;
  candidate_subject_sha256: string;
  planned_pairs: 30;
  required_observations: 60;
  version_arms: ["last-approved", "candidate"];
  compatibility_inventory: ["claude-code", "codex", "cursor", "gemini", "hermes"];
  required_predecessor_schemas: [
    "scenario-source-summary/v1",
    "output-trajectory-summary/v1",
    "silent-success-summary/v1",
    "harness-portability-summary/v1",
  ];
  primary_metrics: typeof PRIMARY_METRICS;
  confidence_level: 0.95;
  interval_method: "paired-normal-95";
  maximum_latency_ratio: 1.10;
  maximum_cost_ratio: 1.10;
  advisory_only: true;
  production_promotion_mutations: 0;
  production_routing_mutations: 0;
  budget: SkillPromotionBudget;
  pairs: SkillPromotionPair[];
  protocol_sha256: string;
}

export interface SkillPromotionObservation {
  schema: typeof SKILL_PROMOTION_OBSERVATION;
  observation_id: string;
  protocol_id: string;
  pair_id: string;
  arm: VersionArm;
  skill_subject_sha256: string;
  model_id: string;
  model_revision: string;
  harness_id: CompatibilityHarness;
  harness_version: string;
  harness_config_sha256: string;
  task_contract_sha256: string;
  output_sha256: string;
  receipt_sha256: string;
  verifier_report_sha256: string;
  authority_valid: boolean;
  receipt_valid: boolean;
  verifier_valid: boolean;
  production_parity_valid: boolean;
  rollback_valid: boolean;
  constitutional_failure: boolean;
  contamination_detected: boolean;
  unresolved_critical_objection: boolean;
  metrics: PromotionMetricValues;
  observation_sha256: string;
}

export interface SkillCompatibilityCell {
  harness_id: CompatibilityHarness;
  subject_sha256: string;
  task_class: string;
  task_class_version: string;
  task_contract_sha256: string;
  model_id: string;
  model_revision: string;
  harness_version: string;
  harness_config_sha256: string;
  receipt_sha256: string;
  passed: boolean;
  score: number;
  threshold: number;
  contamination_checked: boolean;
  contamination_detected: boolean;
  production_adapter_hash_matches: boolean;
  denominator_included: true;
  failure: string | null;
  cell_sha256: string;
}

export interface SkillCompatibilityMatrix {
  schema: typeof SKILL_COMPATIBILITY_MATRIX;
  candidate_subject_sha256: string;
  inventory: ["claude-code", "codex", "cursor", "gemini", "hermes"];
  cells: SkillCompatibilityCell[];
  coverage: number;
  advisory_only: true;
  matrix_sha256: string;
}

export interface PromotionConfidenceInterval {
  confidence_level: 0.95;
  method: "paired-normal-95";
  lower: number;
  upper: number;
}

export interface PromotionMetricComparison {
  metric: PrimaryMetric;
  approved_mean: number;
  candidate_mean: number;
  benefit_delta: number;
  benefit_direction: "candidate-minus-approved" | "approved-minus-candidate";
  interval: PromotionConfidenceInterval;
}

export interface PromotionSignature {
  schema: typeof SKILL_PROMOTION_SIGNATURE;
  actor: string;
  signed_at: string;
  evidence_preimage_sha256: string;
  requested_decision: "PROMOTION_RECOMMENDED";
  signature_sha256: string;
}

export interface PredecessorBundle {
  scenario_source_summary: ScenarioSourceSummary;
  output_trajectory_summary: OutputTrajectorySummary;
  silent_success_summary: SilentSuccessSummary;
  harness_portability_protocol: HarnessPortabilityProtocol;
  harness_portability_summary: HarnessPortabilitySummary;
  production_inventory: PortableHarnessInventory;
}

export interface SkillPromotionSummary {
  schema: typeof SKILL_PROMOTION_SUMMARY;
  protocol_id: string;
  protocol_sha256: string;
  evidence_class: PromotionEvidenceClass;
  complete_pairs: number;
  observations: number;
  compatibility_rows: number;
  compatibility_coverage: number;
  lifecycle_gate_decisions: { approved: "PASS" | "HOLD" | "DENY"; candidate: "PASS" | "HOLD" | "DENY" };
  predecessor_decisions: Array<{ schema: typeof PREDECESSOR_SCHEMAS[number]; disposition: string; claim_eligible: boolean }>;
  metrics: PromotionMetricComparison[];
  latency_ratio: number;
  cost_ratio: number;
  constitutional_failures: number;
  authority_failures: number;
  contamination_detections: number;
  rollback_failures: number;
  unresolved_critical_objections: number;
  human_signature_valid: boolean;
  decision: PromotionDecision;
  reasons: string[];
  advisory_only: true;
  production_promotion_mutations: 0;
  production_routing_mutations: 0;
  evidence_preimage_sha256: string;
  summary_sha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const SUBJECT = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,191}$/i;
const SECRET_VALUE = /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const FORBIDDEN_FIELDS = new Set([
  "raw_task", "raw_task_input", "raw_output", "raw_receipt", "raw_verifier_report", "raw_prompt",
  "raw_history", "prompt", "history", "holdout_plaintext", "hidden_answer", "golden_patch",
  "fixture_path", "tenant_data", "user_data", "credential_value", "secret", "secrets",
  "password", "token", "api_key", "production_state",
]);
const PROTOCOL_KEYS = new Set([
  "schema", "protocol_id", "evidence_class", "evaluation_time", "skill_slug", "approved_version",
  "approved_subject_sha256", "candidate_version", "candidate_subject_sha256", "planned_pairs",
  "required_observations", "version_arms", "compatibility_inventory", "required_predecessor_schemas",
  "primary_metrics", "confidence_level", "interval_method", "maximum_latency_ratio",
  "maximum_cost_ratio", "advisory_only", "production_promotion_mutations",
  "production_routing_mutations", "budget", "pairs", "protocol_sha256",
]);
const BUDGET_KEYS = new Set([
  "maximum_runs", "required_runs", "maximum_cost_usd", "maximum_tokens", "maximum_compute_hours",
  "maximum_storage_gib", "per_run_timeout_minutes",
]);
const PAIR_KEYS = new Set([
  "schema", "protocol_id", "pair_id", "skill_slug", "approved_version", "approved_subject_sha256",
  "candidate_version", "candidate_subject_sha256", "task_id", "task_class", "seed",
  "input_contract_sha256", "output_contract_sha256", "verifier_contract_sha256",
  "authority_envelope_sha256", "pair_sha256",
]);
const OBSERVATION_KEYS = new Set([
  "schema", "observation_id", "protocol_id", "pair_id", "arm", "skill_subject_sha256", "model_id",
  "model_revision", "harness_id", "harness_version", "harness_config_sha256",
  "task_contract_sha256", "output_sha256", "receipt_sha256", "verifier_report_sha256",
  "authority_valid", "receipt_valid", "verifier_valid", "production_parity_valid", "rollback_valid",
  "constitutional_failure", "contamination_detected", "unresolved_critical_objection", "metrics",
  "observation_sha256",
]);
const METRIC_VALUE_KEYS = new Set(PRIMARY_METRICS);
const MATRIX_KEYS = new Set(["schema", "candidate_subject_sha256", "inventory", "cells", "coverage", "advisory_only", "matrix_sha256"]);
const CELL_KEYS = new Set([
  "harness_id", "subject_sha256", "task_class", "task_class_version", "task_contract_sha256",
  "model_id", "model_revision", "harness_version", "harness_config_sha256", "receipt_sha256",
  "passed", "score", "threshold", "contamination_checked", "contamination_detected",
  "production_adapter_hash_matches", "denominator_included", "failure", "cell_sha256",
]);
const SIGNATURE_KEYS = new Set(["schema", "actor", "signed_at", "evidence_preimage_sha256", "requested_decision", "signature_sha256"]);
const LIFECYCLE_DECISION_KEYS = new Set(["approved", "candidate"]);
const PREDECESSOR_DECISION_KEYS = new Set(["schema", "disposition", "claim_eligible"]);
const METRIC_COMPARISON_KEYS = new Set(["metric", "approved_mean", "candidate_mean", "benefit_delta", "benefit_direction", "interval"]);
const INTERVAL_KEYS = new Set(["confidence_level", "method", "lower", "upper"]);
const SUMMARY_KEYS = new Set([
  "schema", "protocol_id", "protocol_sha256", "evidence_class", "complete_pairs", "observations",
  "compatibility_rows", "compatibility_coverage", "lifecycle_gate_decisions", "predecessor_decisions",
  "metrics", "latency_ratio", "cost_ratio", "constitutional_failures", "authority_failures",
  "contamination_detections", "rollback_failures", "unresolved_critical_objections",
  "human_signature_valid", "decision", "reasons", "advisory_only", "production_promotion_mutations",
  "production_routing_mutations", "evidence_preimage_sha256", "summary_sha256",
]);

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalizePromotion(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizePromotion).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("canonical JSON accepts plain objects only");
    return `{${Object.keys(value as Record<string, unknown>).sort(compareUtf8).map((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new Error(`canonical JSON rejects undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalizePromotion(item)}`;
    }).join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function promotionSha256(value: unknown): string {
  return createHash("sha256").update(canonicalizePromotion(value)).digest("hex");
}

export function assertPromotionBoundary(value: unknown, path = "value"): void {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) throw new Error(`${path} contains secret-shaped data`);
    if (value.length > 1024) throw new Error(`${path} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPromotionBoundary(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELDS.has(key.toLowerCase())) throw new Error(`${path}.${key} is a forbidden field`);
      assertPromotionBoundary(entry, `${path}.${key}`);
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: Set<string>, label: string): void {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) throw new Error(`${label} has unknown fields [${unknown}] or missing fields [${missing}]`);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
}

function subject(value: unknown, label: string): string {
  if (typeof value !== "string" || !SUBJECT.test(value)) throw new Error(`${label} must be a canonical lifecycle subject hash`);
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || SECRET_VALUE.test(value)) throw new Error(`${label} must be a bounded identifier`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonnegative(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}

function integer(value: unknown, label: string): number {
  const parsed = nonnegative(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512 || SECRET_VALUE.test(entry))) {
    throw new Error(`${label} must contain bounded non-secret strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return [...value];
}

export function computeProtocolHash(value: Omit<SkillPromotionProtocol, "protocol_sha256"> | SkillPromotionProtocol): string {
  const { protocol_sha256: _ignored, ...body } = value as SkillPromotionProtocol;
  return promotionSha256(body);
}

export function computePairHash(value: Omit<SkillPromotionPair, "pair_sha256"> | SkillPromotionPair): string {
  const { pair_sha256: _ignored, ...body } = value as SkillPromotionPair;
  return promotionSha256(body);
}

export function computeObservationHash(value: Omit<SkillPromotionObservation, "observation_sha256"> | SkillPromotionObservation): string {
  const { observation_sha256: _ignored, ...body } = value as SkillPromotionObservation;
  return promotionSha256(body);
}

export function computeCellHash(value: Omit<SkillCompatibilityCell, "cell_sha256"> | SkillCompatibilityCell): string {
  const { cell_sha256: _ignored, ...body } = value as SkillCompatibilityCell;
  return promotionSha256(body);
}

export function computeMatrixHash(value: Omit<SkillCompatibilityMatrix, "matrix_sha256"> | SkillCompatibilityMatrix): string {
  const { matrix_sha256: _ignored, ...body } = value as SkillCompatibilityMatrix;
  return promotionSha256(body);
}

export function computeSignatureHash(value: Omit<PromotionSignature, "signature_sha256"> | PromotionSignature): string {
  const { signature_sha256: _ignored, ...body } = value as PromotionSignature;
  return promotionSha256(body);
}

export function computeSummaryHash(value: Omit<SkillPromotionSummary, "summary_sha256"> | SkillPromotionSummary): string {
  const { summary_sha256: _ignored, ...body } = value as SkillPromotionSummary;
  return promotionSha256(body);
}

export function finalizeProtocol(value: Omit<SkillPromotionProtocol, "protocol_sha256">): SkillPromotionProtocol {
  return { ...value, protocol_sha256: computeProtocolHash(value) };
}

export function finalizePair(value: Omit<SkillPromotionPair, "pair_sha256">): SkillPromotionPair {
  return { ...value, pair_sha256: computePairHash(value) };
}

export function finalizeObservation(value: Omit<SkillPromotionObservation, "observation_sha256">): SkillPromotionObservation {
  return { ...value, observation_sha256: computeObservationHash(value) };
}

export function finalizeCell(value: Omit<SkillCompatibilityCell, "cell_sha256">): SkillCompatibilityCell {
  return { ...value, cell_sha256: computeCellHash(value) };
}

export function finalizeMatrix(value: Omit<SkillCompatibilityMatrix, "matrix_sha256">): SkillCompatibilityMatrix {
  return { ...value, matrix_sha256: computeMatrixHash(value) };
}

export function finalizeSignature(value: Omit<PromotionSignature, "signature_sha256">): PromotionSignature {
  return { ...value, signature_sha256: computeSignatureHash(value) };
}

export function parseSkillPromotionPair(value: unknown): SkillPromotionPair {
  assertPromotionBoundary(value, "pair");
  const raw = object(value, "pair");
  exactKeys(raw, PAIR_KEYS, "pair");
  const pair: SkillPromotionPair = {
    schema: raw.schema as typeof SKILL_PROMOTION_PAIR,
    protocol_id: id(raw.protocol_id, "pair.protocol_id"),
    pair_id: id(raw.pair_id, "pair.pair_id"),
    skill_slug: id(raw.skill_slug, "pair.skill_slug"),
    approved_version: id(raw.approved_version, "pair.approved_version"),
    approved_subject_sha256: subject(raw.approved_subject_sha256, "pair.approved_subject_sha256"),
    candidate_version: id(raw.candidate_version, "pair.candidate_version"),
    candidate_subject_sha256: subject(raw.candidate_subject_sha256, "pair.candidate_subject_sha256"),
    task_id: id(raw.task_id, "pair.task_id"),
    task_class: id(raw.task_class, "pair.task_class"),
    seed: integer(raw.seed, "pair.seed"),
    input_contract_sha256: hash(raw.input_contract_sha256, "pair.input_contract_sha256"),
    output_contract_sha256: hash(raw.output_contract_sha256, "pair.output_contract_sha256"),
    verifier_contract_sha256: hash(raw.verifier_contract_sha256, "pair.verifier_contract_sha256"),
    authority_envelope_sha256: hash(raw.authority_envelope_sha256, "pair.authority_envelope_sha256"),
    pair_sha256: hash(raw.pair_sha256, "pair.pair_sha256"),
  };
  if (pair.schema !== SKILL_PROMOTION_PAIR) throw new Error("pair schema drift");
  if (computePairHash(pair) !== pair.pair_sha256) throw new Error("pair hash drift");
  return pair;
}

export function parseSkillPromotionProtocol(value: unknown): SkillPromotionProtocol {
  assertPromotionBoundary(value, "protocol");
  const raw = object(value, "protocol");
  exactKeys(raw, PROTOCOL_KEYS, "protocol");
  const budget = object(raw.budget, "protocol.budget");
  exactKeys(budget, BUDGET_KEYS, "protocol.budget");
  if (!Array.isArray(raw.pairs)) throw new Error("protocol.pairs must be an array");
  const pairs = raw.pairs.map(parseSkillPromotionPair);
  const protocol: SkillPromotionProtocol = {
    schema: raw.schema as typeof SKILL_PROMOTION_PROTOCOL,
    protocol_id: id(raw.protocol_id, "protocol.protocol_id"),
    evidence_class: raw.evidence_class as PromotionEvidenceClass,
    evaluation_time: id(raw.evaluation_time, "protocol.evaluation_time"),
    skill_slug: id(raw.skill_slug, "protocol.skill_slug"),
    approved_version: id(raw.approved_version, "protocol.approved_version"),
    approved_subject_sha256: subject(raw.approved_subject_sha256, "protocol.approved_subject_sha256"),
    candidate_version: id(raw.candidate_version, "protocol.candidate_version"),
    candidate_subject_sha256: subject(raw.candidate_subject_sha256, "protocol.candidate_subject_sha256"),
    planned_pairs: raw.planned_pairs as 30,
    required_observations: raw.required_observations as 60,
    version_arms: raw.version_arms as SkillPromotionProtocol["version_arms"],
    compatibility_inventory: raw.compatibility_inventory as SkillPromotionProtocol["compatibility_inventory"],
    required_predecessor_schemas: raw.required_predecessor_schemas as SkillPromotionProtocol["required_predecessor_schemas"],
    primary_metrics: raw.primary_metrics as typeof PRIMARY_METRICS,
    confidence_level: raw.confidence_level as 0.95,
    interval_method: raw.interval_method as "paired-normal-95",
    maximum_latency_ratio: raw.maximum_latency_ratio as 1.10,
    maximum_cost_ratio: raw.maximum_cost_ratio as 1.10,
    advisory_only: raw.advisory_only as true,
    production_promotion_mutations: raw.production_promotion_mutations as 0,
    production_routing_mutations: raw.production_routing_mutations as 0,
    budget: {
      maximum_runs: budget.maximum_runs as 110,
      required_runs: budget.required_runs as 60,
      maximum_cost_usd: budget.maximum_cost_usd as 93.5,
      maximum_tokens: budget.maximum_tokens as 12_100_000,
      maximum_compute_hours: budget.maximum_compute_hours as 24.2,
      maximum_storage_gib: budget.maximum_storage_gib as 1.54,
      per_run_timeout_minutes: budget.per_run_timeout_minutes as 30,
    },
    pairs,
    protocol_sha256: hash(raw.protocol_sha256, "protocol.protocol_sha256"),
  };
  if (protocol.schema !== SKILL_PROMOTION_PROTOCOL || !["synthetic_qualification", "phase-d-production"].includes(protocol.evidence_class)) throw new Error("protocol contract drift");
  if (!Number.isFinite(Date.parse(protocol.evaluation_time))) throw new Error("protocol evaluation time is invalid");
  if (protocol.approved_version === protocol.candidate_version || protocol.approved_subject_sha256 === protocol.candidate_subject_sha256) throw new Error("protocol requires distinct skill versions and subjects");
  if (protocol.planned_pairs !== 30 || protocol.required_observations !== 60 || protocol.confidence_level !== 0.95 || protocol.interval_method !== "paired-normal-95") throw new Error("protocol pair or interval contract drift");
  if (protocol.maximum_latency_ratio !== 1.10 || protocol.maximum_cost_ratio !== 1.10 || protocol.advisory_only !== true || protocol.production_promotion_mutations !== 0 || protocol.production_routing_mutations !== 0) throw new Error("protocol safety contract drift");
  if (JSON.stringify(protocol.version_arms) !== JSON.stringify(VERSION_ARMS) || JSON.stringify(protocol.compatibility_inventory) !== JSON.stringify(COMPATIBILITY_INVENTORY) || JSON.stringify(protocol.required_predecessor_schemas) !== JSON.stringify(PREDECESSOR_SCHEMAS) || JSON.stringify(protocol.primary_metrics) !== JSON.stringify(PRIMARY_METRICS)) throw new Error("protocol inventory or metric drift");
  if (Object.values(protocol.budget).join(",") !== [110, 60, 93.5, 12_100_000, 24.2, 1.54, 30].join(",")) throw new Error("protocol budget drift");
  if (pairs.length !== 30 || new Set(pairs.map((pair) => pair.pair_id)).size !== 30) throw new Error("protocol requires exactly 30 unique pairs");
  for (const pair of pairs) {
    if (pair.protocol_id !== protocol.protocol_id || pair.skill_slug !== protocol.skill_slug || pair.approved_version !== protocol.approved_version || pair.approved_subject_sha256 !== protocol.approved_subject_sha256 || pair.candidate_version !== protocol.candidate_version || pair.candidate_subject_sha256 !== protocol.candidate_subject_sha256) throw new Error("pair identity drifts from protocol");
  }
  if (computeProtocolHash(protocol) !== protocol.protocol_sha256) throw new Error("protocol hash drift");
  return protocol;
}

function parseMetricValues(value: unknown): PromotionMetricValues {
  const raw = object(value, "observation.metrics");
  exactKeys(raw, METRIC_VALUE_KEYS, "observation.metrics");
  const metrics = Object.fromEntries(PRIMARY_METRICS.map((metric) => [metric, nonnegative(raw[metric], `observation.metrics.${metric}`)])) as PromotionMetricValues;
  for (const metric of ["verified_quality", "contract_conformance", "failure_rate", "recovery_rate", "edge_proof_completeness", "contamination_rate"] as const) {
    if (metrics[metric] > 1) throw new Error(`${metric} must be a ratio`);
  }
  return metrics;
}

export function parseSkillPromotionObservation(value: unknown, protocol: SkillPromotionProtocol): SkillPromotionObservation {
  assertPromotionBoundary(value, "observation");
  const raw = object(value, "observation");
  exactKeys(raw, OBSERVATION_KEYS, "observation");
  const observation: SkillPromotionObservation = {
    schema: raw.schema as typeof SKILL_PROMOTION_OBSERVATION,
    observation_id: id(raw.observation_id, "observation.observation_id"),
    protocol_id: id(raw.protocol_id, "observation.protocol_id"),
    pair_id: id(raw.pair_id, "observation.pair_id"),
    arm: raw.arm as VersionArm,
    skill_subject_sha256: subject(raw.skill_subject_sha256, "observation.skill_subject_sha256"),
    model_id: id(raw.model_id, "observation.model_id"),
    model_revision: id(raw.model_revision, "observation.model_revision"),
    harness_id: raw.harness_id as CompatibilityHarness,
    harness_version: id(raw.harness_version, "observation.harness_version"),
    harness_config_sha256: hash(raw.harness_config_sha256, "observation.harness_config_sha256"),
    task_contract_sha256: hash(raw.task_contract_sha256, "observation.task_contract_sha256"),
    output_sha256: hash(raw.output_sha256, "observation.output_sha256"),
    receipt_sha256: hash(raw.receipt_sha256, "observation.receipt_sha256"),
    verifier_report_sha256: hash(raw.verifier_report_sha256, "observation.verifier_report_sha256"),
    authority_valid: bool(raw.authority_valid, "observation.authority_valid"),
    receipt_valid: bool(raw.receipt_valid, "observation.receipt_valid"),
    verifier_valid: bool(raw.verifier_valid, "observation.verifier_valid"),
    production_parity_valid: bool(raw.production_parity_valid, "observation.production_parity_valid"),
    rollback_valid: bool(raw.rollback_valid, "observation.rollback_valid"),
    constitutional_failure: bool(raw.constitutional_failure, "observation.constitutional_failure"),
    contamination_detected: bool(raw.contamination_detected, "observation.contamination_detected"),
    unresolved_critical_objection: bool(raw.unresolved_critical_objection, "observation.unresolved_critical_objection"),
    metrics: parseMetricValues(raw.metrics),
    observation_sha256: hash(raw.observation_sha256, "observation.observation_sha256"),
  };
  const pair = protocol.pairs.find((candidate) => candidate.pair_id === observation.pair_id);
  if (observation.schema !== SKILL_PROMOTION_OBSERVATION || observation.protocol_id !== protocol.protocol_id || !pair || !VERSION_ARMS.includes(observation.arm) || !COMPATIBILITY_INVENTORY.includes(observation.harness_id)) throw new Error("observation identity drift");
  const expectedSubject = observation.arm === "last-approved" ? protocol.approved_subject_sha256 : protocol.candidate_subject_sha256;
  if (observation.skill_subject_sha256 !== expectedSubject || observation.task_contract_sha256 !== pair.input_contract_sha256) throw new Error("observation subject or task contract drift");
  if (observation.contamination_detected !== (observation.metrics.contamination_rate > 0)) throw new Error("observation contamination evidence drift");
  if (computeObservationHash(observation) !== observation.observation_sha256) throw new Error("observation hash drift");
  return observation;
}

export function validateLifecyclePair(approvedInput: unknown, candidateInput: unknown, protocol: SkillPromotionProtocol): {
  approved: { decision: "PASS" | "HOLD" | "DENY"; record: SkillLifecycleRecord | null };
  candidate: { decision: "PASS" | "HOLD" | "DENY"; record: SkillLifecycleRecord | null };
} {
  assertPromotionBoundary(approvedInput, "approved_lifecycle");
  assertPromotionBoundary(candidateInput, "candidate_lifecycle");
  const approvedResult = validateLifecycleRecord(approvedInput, { now: protocol.evaluation_time });
  const candidateResult = validateLifecycleRecord(candidateInput, { now: protocol.evaluation_time });
  const checked = (input: unknown, result: typeof approvedResult, version: string, expectedSubject: string, role: "approved" | "candidate") => {
    const candidate = result.decision === "DENY" ? null : input as Partial<SkillLifecycleRecord>;
    const record = candidate?.identity && candidate.evaluation && candidate.security ? candidate as SkillLifecycleRecord : null;
    if (record && (record.identity.slug !== protocol.skill_slug || record.identity.version !== version || record.subjectHash !== expectedSubject)) return { decision: "DENY" as const, record: null };
    if (record && record.identity.credentials.length > 0) return { decision: "DENY" as const, record: null };
    if (record && role === "approved" && record.state !== "promoted") return { decision: "HOLD" as const, record };
    if (record && role === "candidate" && record.state !== "approved") return { decision: "HOLD" as const, record };
    return { decision: result.decision, record };
  };
  return {
    approved: checked(approvedInput, approvedResult, protocol.approved_version, protocol.approved_subject_sha256, "approved"),
    candidate: checked(candidateInput, candidateResult, protocol.candidate_version, protocol.candidate_subject_sha256, "candidate"),
  };
}

function lifecycleCell(row: CompatibilityRow, candidate: SkillLifecycleRecord, harness: CompatibilityHarness): SkillCompatibilityCell {
  const task = candidate.evaluation.taskClasses.find((entry) => entry.name === row.taskClass && entry.version === row.taskClassVersion);
  if (!task) throw new Error(`compatibility row ${harness} references an undeclared task`);
  const body: Omit<SkillCompatibilityCell, "cell_sha256"> = {
    harness_id: harness,
    subject_sha256: row.subjectHash,
    task_class: row.taskClass,
    task_class_version: row.taskClassVersion,
    task_contract_sha256: row.contractHash.slice("sha256:".length),
    model_id: `${row.model.provider}:${row.model.id}`,
    model_revision: row.model.revision,
    harness_version: row.harness.version,
    harness_config_sha256: row.harness.configHash.slice("sha256:".length),
    receipt_sha256: row.receiptHash.slice("sha256:".length),
    passed: row.passed && row.score >= row.threshold,
    score: row.score,
    threshold: row.threshold,
    contamination_checked: row.contamination.checked,
    contamination_detected: row.contamination.detected,
    production_adapter_hash_matches: candidate.evaluation.parity?.verdict === "pass",
    denominator_included: true,
    failure: row.failure,
  };
  return finalizeCell(body);
}

export function buildSkillCompatibilityMatrix(candidate: SkillLifecycleRecord, protocol: SkillPromotionProtocol): SkillCompatibilityMatrix {
  const cells = COMPATIBILITY_INVENTORY.map((harness) => {
    const matches = candidate.evaluation.compatibility.filter((row) => row.harness.name === harness);
    if (matches.length !== 1) {
      const task = candidate.evaluation.taskClasses[0];
      return finalizeCell({
        harness_id: harness,
        subject_sha256: protocol.candidate_subject_sha256,
        task_class: task?.name ?? "missing-task-contract",
        task_class_version: task?.version ?? "missing-version",
        task_contract_sha256: promotionSha256(task ?? { missing: true }),
        model_id: "missing:compatibility-row",
        model_revision: "missing-revision",
        harness_version: "missing-version",
        harness_config_sha256: promotionSha256({ harness, missing: "config" }),
        receipt_sha256: promotionSha256({ harness, missing: "receipt" }),
        passed: false,
        score: 0,
        threshold: task?.minimumScore ?? 1,
        contamination_checked: false,
        contamination_detected: false,
        production_adapter_hash_matches: false,
        denominator_included: true,
        failure: matches.length === 0 ? "missing-compatibility-row" : "duplicate-compatibility-row",
      });
    }
    return lifecycleCell(matches[0]!, candidate, harness);
  });
  const coverage = cells.filter((cell) => cell.denominator_included).length / COMPATIBILITY_INVENTORY.length;
  return finalizeMatrix({
    schema: SKILL_COMPATIBILITY_MATRIX,
    candidate_subject_sha256: protocol.candidate_subject_sha256,
    inventory: [...COMPATIBILITY_INVENTORY],
    cells,
    coverage,
    advisory_only: true,
  });
}

export function parseSkillCompatibilityMatrix(value: unknown, protocol: SkillPromotionProtocol): SkillCompatibilityMatrix {
  assertPromotionBoundary(value, "compatibility_matrix");
  const raw = object(value, "compatibility_matrix");
  exactKeys(raw, MATRIX_KEYS, "compatibility_matrix");
  if (!Array.isArray(raw.cells) || raw.cells.length !== 5) throw new Error("compatibility matrix requires five cells");
  const cells = raw.cells.map((entry, index): SkillCompatibilityCell => {
    const cell = object(entry, `compatibility_matrix.cells[${index}]`);
    exactKeys(cell, CELL_KEYS, `compatibility_matrix.cells[${index}]`);
    const parsed: SkillCompatibilityCell = {
      harness_id: cell.harness_id as CompatibilityHarness,
      subject_sha256: subject(cell.subject_sha256, `compatibility_matrix.cells[${index}].subject_sha256`),
      task_class: id(cell.task_class, `compatibility_matrix.cells[${index}].task_class`),
      task_class_version: id(cell.task_class_version, `compatibility_matrix.cells[${index}].task_class_version`),
      task_contract_sha256: hash(cell.task_contract_sha256, `compatibility_matrix.cells[${index}].task_contract_sha256`),
      model_id: id(cell.model_id, `compatibility_matrix.cells[${index}].model_id`),
      model_revision: id(cell.model_revision, `compatibility_matrix.cells[${index}].model_revision`),
      harness_version: id(cell.harness_version, `compatibility_matrix.cells[${index}].harness_version`),
      harness_config_sha256: hash(cell.harness_config_sha256, `compatibility_matrix.cells[${index}].harness_config_sha256`),
      receipt_sha256: hash(cell.receipt_sha256, `compatibility_matrix.cells[${index}].receipt_sha256`),
      passed: bool(cell.passed, `compatibility_matrix.cells[${index}].passed`),
      score: nonnegative(cell.score, `compatibility_matrix.cells[${index}].score`),
      threshold: nonnegative(cell.threshold, `compatibility_matrix.cells[${index}].threshold`),
      contamination_checked: bool(cell.contamination_checked, `compatibility_matrix.cells[${index}].contamination_checked`),
      contamination_detected: bool(cell.contamination_detected, `compatibility_matrix.cells[${index}].contamination_detected`),
      production_adapter_hash_matches: bool(cell.production_adapter_hash_matches, `compatibility_matrix.cells[${index}].production_adapter_hash_matches`),
      denominator_included: cell.denominator_included as true,
      failure: cell.failure === null ? null : id(cell.failure, `compatibility_matrix.cells[${index}].failure`),
      cell_sha256: hash(cell.cell_sha256, `compatibility_matrix.cells[${index}].cell_sha256`),
    };
    if (parsed.harness_id !== COMPATIBILITY_INVENTORY[index] || parsed.subject_sha256 !== protocol.candidate_subject_sha256 || parsed.denominator_included !== true || parsed.score > 1 || parsed.threshold > 1 || computeCellHash(parsed) !== parsed.cell_sha256) throw new Error(`compatibility matrix cell ${index} drift`);
    return parsed;
  });
  const matrix: SkillCompatibilityMatrix = {
    schema: raw.schema as typeof SKILL_COMPATIBILITY_MATRIX,
    candidate_subject_sha256: subject(raw.candidate_subject_sha256, "compatibility_matrix.candidate_subject_sha256"),
    inventory: raw.inventory as SkillCompatibilityMatrix["inventory"],
    cells,
    coverage: nonnegative(raw.coverage, "compatibility_matrix.coverage"),
    advisory_only: raw.advisory_only as true,
    matrix_sha256: hash(raw.matrix_sha256, "compatibility_matrix.matrix_sha256"),
  };
  if (matrix.schema !== SKILL_COMPATIBILITY_MATRIX || matrix.candidate_subject_sha256 !== protocol.candidate_subject_sha256 || JSON.stringify(matrix.inventory) !== JSON.stringify(COMPATIBILITY_INVENTORY) || matrix.coverage !== 1 || matrix.advisory_only !== true || computeMatrixHash(matrix) !== matrix.matrix_sha256) throw new Error("compatibility matrix drift");
  return matrix;
}

export function parsePredecessorBundle(value: unknown): PredecessorBundle {
  assertPromotionBoundary(value, "predecessors");
  const raw = object(value, "predecessors");
  exactKeys(raw, new Set(["scenario_source_summary", "output_trajectory_summary", "silent_success_summary", "harness_portability_protocol", "harness_portability_summary", "production_inventory"]), "predecessors");
  const inventory = raw.production_inventory as PortableHarnessInventory;
  const harnessProtocol = parseHarnessPortabilityProtocol(raw.harness_portability_protocol, inventory);
  return {
    scenario_source_summary: parseScenarioSourceSummary(raw.scenario_source_summary),
    output_trajectory_summary: parseOutputTrajectorySummary(raw.output_trajectory_summary),
    silent_success_summary: parseSilentSuccessSummary(raw.silent_success_summary),
    harness_portability_protocol: harnessProtocol,
    harness_portability_summary: parseHarnessPortabilitySummary(raw.harness_portability_summary, harnessProtocol, inventory),
    production_inventory: inventory,
  };
}

export function parsePromotionSignature(value: unknown): PromotionSignature | null {
  if (value === null) return null;
  assertPromotionBoundary(value, "signature");
  const raw = object(value, "signature");
  exactKeys(raw, SIGNATURE_KEYS, "signature");
  const signature: PromotionSignature = {
    schema: raw.schema as typeof SKILL_PROMOTION_SIGNATURE,
    actor: id(raw.actor, "signature.actor"),
    signed_at: id(raw.signed_at, "signature.signed_at"),
    evidence_preimage_sha256: hash(raw.evidence_preimage_sha256, "signature.evidence_preimage_sha256"),
    requested_decision: raw.requested_decision as "PROMOTION_RECOMMENDED",
    signature_sha256: hash(raw.signature_sha256, "signature.signature_sha256"),
  };
  if (signature.schema !== SKILL_PROMOTION_SIGNATURE || signature.requested_decision !== "PROMOTION_RECOMMENDED" || !Number.isFinite(Date.parse(signature.signed_at)) || computeSignatureHash(signature) !== signature.signature_sha256) throw new Error("promotion signature drift");
  return signature;
}

export function parseSkillPromotionSummary(value: unknown): SkillPromotionSummary {
  assertPromotionBoundary(value, "summary");
  const raw = object(value, "summary");
  exactKeys(raw, SUMMARY_KEYS, "summary");
  if (raw.schema !== SKILL_PROMOTION_SUMMARY || !["PROMOTION_RECOMMENDED", "HOLD", "DENY"].includes(String(raw.decision))) throw new Error("summary contract drift");
  const lifecycleDecisions = object(raw.lifecycle_gate_decisions, "summary.lifecycle_gate_decisions");
  exactKeys(lifecycleDecisions, LIFECYCLE_DECISION_KEYS, "summary.lifecycle_gate_decisions");
  for (const key of LIFECYCLE_DECISION_KEYS) if (!["PASS", "HOLD", "DENY"].includes(String(lifecycleDecisions[key]))) throw new Error(`summary.lifecycle_gate_decisions.${key} is invalid`);
  if (!Array.isArray(raw.predecessor_decisions) || raw.predecessor_decisions.length !== PREDECESSOR_SCHEMAS.length) throw new Error("summary predecessor completeness drift");
  const predecessorDecisions = raw.predecessor_decisions.map((entry, index) => {
    const parsed = object(entry, `summary.predecessor_decisions[${index}]`);
    exactKeys(parsed, PREDECESSOR_DECISION_KEYS, `summary.predecessor_decisions[${index}]`);
    if (parsed.schema !== PREDECESSOR_SCHEMAS[index] || typeof parsed.disposition !== "string" || parsed.disposition.length === 0 || typeof parsed.claim_eligible !== "boolean") throw new Error(`summary.predecessor_decisions[${index}] drift`);
    return { schema: PREDECESSOR_SCHEMAS[index], disposition: parsed.disposition, claim_eligible: parsed.claim_eligible };
  });
  if (!Array.isArray(raw.metrics) || raw.metrics.length !== PRIMARY_METRICS.length) throw new Error("summary metric completeness drift");
  const metrics = raw.metrics.map((entry, index): PromotionMetricComparison => {
    const parsed = object(entry, `summary.metrics[${index}]`);
    exactKeys(parsed, METRIC_COMPARISON_KEYS, `summary.metrics[${index}]`);
    const parsedInterval = object(parsed.interval, `summary.metrics[${index}].interval`);
    exactKeys(parsedInterval, INTERVAL_KEYS, `summary.metrics[${index}].interval`);
    const direction = LOWER_IS_BETTER_FOR_CONTRACT.has(PRIMARY_METRICS[index]!) ? "approved-minus-candidate" : "candidate-minus-approved";
    if (parsed.metric !== PRIMARY_METRICS[index] || parsed.benefit_direction !== direction || parsedInterval.confidence_level !== 0.95 || parsedInterval.method !== "paired-normal-95") throw new Error(`summary.metrics[${index}] identity drift`);
    return {
      metric: PRIMARY_METRICS[index]!,
      approved_mean: nonnegative(parsed.approved_mean, `summary.metrics[${index}].approved_mean`),
      candidate_mean: nonnegative(parsed.candidate_mean, `summary.metrics[${index}].candidate_mean`),
      benefit_delta: finite(parsed.benefit_delta, `summary.metrics[${index}].benefit_delta`),
      benefit_direction: direction,
      interval: {
        confidence_level: 0.95,
        method: "paired-normal-95",
        lower: finite(parsedInterval.lower, `summary.metrics[${index}].interval.lower`),
        upper: finite(parsedInterval.upper, `summary.metrics[${index}].interval.upper`),
      },
    };
  });
  const summary: SkillPromotionSummary = {
    schema: SKILL_PROMOTION_SUMMARY,
    protocol_id: id(raw.protocol_id, "summary.protocol_id"),
    protocol_sha256: hash(raw.protocol_sha256, "summary.protocol_sha256"),
    evidence_class: raw.evidence_class as PromotionEvidenceClass,
    complete_pairs: integer(raw.complete_pairs, "summary.complete_pairs"),
    observations: integer(raw.observations, "summary.observations"),
    compatibility_rows: integer(raw.compatibility_rows, "summary.compatibility_rows"),
    compatibility_coverage: nonnegative(raw.compatibility_coverage, "summary.compatibility_coverage"),
    lifecycle_gate_decisions: lifecycleDecisions as SkillPromotionSummary["lifecycle_gate_decisions"],
    predecessor_decisions: predecessorDecisions,
    metrics,
    latency_ratio: nonnegative(raw.latency_ratio, "summary.latency_ratio"),
    cost_ratio: nonnegative(raw.cost_ratio, "summary.cost_ratio"),
    constitutional_failures: integer(raw.constitutional_failures, "summary.constitutional_failures"),
    authority_failures: integer(raw.authority_failures, "summary.authority_failures"),
    contamination_detections: integer(raw.contamination_detections, "summary.contamination_detections"),
    rollback_failures: integer(raw.rollback_failures, "summary.rollback_failures"),
    unresolved_critical_objections: integer(raw.unresolved_critical_objections, "summary.unresolved_critical_objections"),
    human_signature_valid: bool(raw.human_signature_valid, "summary.human_signature_valid"),
    decision: raw.decision as PromotionDecision,
    reasons: stringArray(raw.reasons, "summary.reasons"),
    advisory_only: raw.advisory_only as true,
    production_promotion_mutations: raw.production_promotion_mutations as 0,
    production_routing_mutations: raw.production_routing_mutations as 0,
    evidence_preimage_sha256: hash(raw.evidence_preimage_sha256, "summary.evidence_preimage_sha256"),
    summary_sha256: hash(raw.summary_sha256, "summary.summary_sha256"),
  };
  if (summary.advisory_only !== true || summary.production_promotion_mutations !== 0 || summary.production_routing_mutations !== 0) throw new Error("summary must remain advisory only");
  if (!["synthetic_qualification", "phase-d-production"].includes(summary.evidence_class) || summary.compatibility_coverage > 1) throw new Error("summary evidence or coverage drift");
  if (summary.decision === "PROMOTION_RECOMMENDED" && (!summary.human_signature_valid || summary.reasons.length > 0)) throw new Error("promotion recommendation lacks a clean human signature gate");
  if (computeSummaryHash(summary) !== summary.summary_sha256) throw new Error("summary hash drift");
  return summary;
}
