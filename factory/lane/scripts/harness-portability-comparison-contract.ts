import { createHash } from "node:crypto";
import {
  PORTABLE_HARNESS_IDS,
  type HarnessId,
  type PortableHarnessInventory,
} from "../../../packages/swarm/src/executor/portability.ts";
import { canonicalize, CONTRACT_ID } from "./run-receipt-contract.ts";
import {
  TRAJECTORY_CLAIM_FIELDS,
  TRAJECTORY_FORBIDDEN_FIELDS,
  TRAJECTORY_REQUEST_KEYS,
} from "./trajectory-verifier-contract.ts";

export const HARNESS_PORTABILITY_PROTOCOL = "harness-portability-comparison/v1" as const;
export const HARNESS_PORTABILITY_COMPARISON = "harness-portability-comparison-cell/v1" as const;
export const HARNESS_PORTABILITY_PAIR = "harness-portability-pair/v1" as const;
export const HARNESS_PORTABILITY_OBSERVATION = "harness-portability-observation/v1" as const;
export const HARNESS_PORTABILITY_CAPABILITY_CELL = "harness-portability-capability-cell/v1" as const;
export const HARNESS_PORTABILITY_MATRIX = "harness-portability-matrix/v1" as const;
export const HARNESS_PORTABILITY_SUMMARY = "harness-portability-summary/v1" as const;
export const REFERENCE_HARNESS = "claude-code" as const;
export const COMPARISON_HARNESSES = ["codex", "gemini", "hermes"] as const;
export const OUT_OF_COHORT_HARNESSES = ["cursor"] as const;
export const COMPARISON_IDS = [
  "claude-code-vs-codex",
  "claude-code-vs-gemini",
  "claude-code-vs-hermes",
] as const;
export const PRIMARY_METRICS = [
  "contract_conformance",
  "verified_quality",
  "latency_ms",
  "cost_usd",
  "failure_rate",
  "recovery_rate",
  "edge_proof_completeness",
  "contamination_rate",
] as const;
export const EMPTY_HISTORY_SHA256 = createHash("sha256").update(canonicalize([])).digest("hex");
export const CANONICAL_RECEIPT_CONTRACT_SHA256 = createHash("sha256").update(CONTRACT_ID).digest("hex");
export const CANONICAL_VERIFIER_CONTRACT_SHA256 = createHash("sha256").update(canonicalize({
  request_keys: TRAJECTORY_REQUEST_KEYS,
  forbidden_fields: TRAJECTORY_FORBIDDEN_FIELDS,
  claim_fields: TRAJECTORY_CLAIM_FIELDS,
})).digest("hex");

export type ComparisonHarness = typeof COMPARISON_HARNESSES[number];
export type ComparisonId = typeof COMPARISON_IDS[number];
export type ComparisonArm = "reference" | "candidate";
export type PrimaryMetric = typeof PRIMARY_METRICS[number];
export type EvidenceClass = "synthetic_qualification" | "phase_d_observation";
export type PortabilityDisposition = "CONFORMANT" | "NONCONFORMANT" | "HOLD";

export function inComparisonCohort(id: string): boolean {
  return id === REFERENCE_HARNESS || (COMPARISON_HARNESSES as readonly string[]).includes(id);
}

export interface HarnessComparisonContract {
  schema: typeof HARNESS_PORTABILITY_COMPARISON;
  comparison_id: ComparisonId;
  reference_harness: typeof REFERENCE_HARNESS;
  candidate_harness: ComparisonHarness;
  required_pairs: 30;
  required_runs: 60;
}

export interface PortabilityTaskContract {
  schema_version: 1;
  task_id: string;
  task_class: string;
  input_sha256: string;
  input_contract_sha256: string;
  output_contract_sha256: string;
  rubric_sha256: string;
  authority_envelope_sha256: string;
  receipt_contract_sha256: string;
  verifier_contract_sha256: string;
}

export interface PortabilityBudget {
  maximum_runs: 180;
  maximum_cost_usd: 153;
  maximum_tokens: 19_800_000;
  maximum_compute_hours: 39.6;
  maximum_storage_gib: 2.52;
  per_run_timeout_minutes: 30;
}

export interface HarnessPortabilityProtocol {
  schema: typeof HARNESS_PORTABILITY_PROTOCOL;
  protocol_id: string;
  evidence_class: EvidenceClass;
  adapter_inventory_sha256: string;
  canonical_empty_history_sha256: string;
  reference_harness: typeof REFERENCE_HARNESS;
  comparison_harnesses: ComparisonHarness[];
  out_of_cohort_harnesses: ["cursor"];
  comparisons: HarnessComparisonContract[];
  replicate_seeds: [number, number, number];
  pairs_per_comparison: 30;
  total_pair_records: 90;
  total_observation_slots: 180;
  confidence_level: 0.95;
  interval_method: "paired-normal-95";
  primary_metrics: PrimaryMetric[];
  unsupported_capabilities_in_denominator: true;
  production_adapter_parity_required: 1;
  advisory_only: true;
  production_routing_mutations: 0;
  implementation_live_calls: 0;
  budget: PortabilityBudget;
  task_contracts: PortabilityTaskContract[];
  protocol_sha256: string;
}

export interface HarnessPortabilityPair {
  schema: typeof HARNESS_PORTABILITY_PAIR;
  comparison_id: ComparisonId;
  pair_id: string;
  task_id: string;
  task_class: string;
  seed: number;
  input_sha256: string;
  input_contract_sha256: string;
  output_contract_sha256: string;
  rubric_sha256: string;
  authority_envelope_sha256: string;
  receipt_contract_sha256: string;
  verifier_contract_sha256: string;
  pair_sha256: string;
}

export type PortabilityMetricValues = Record<PrimaryMetric, number>;

export interface HarnessPortabilityObservation {
  schema: typeof HARNESS_PORTABILITY_OBSERVATION;
  comparison_id: ComparisonId;
  pair_id: string;
  arm: ComparisonArm;
  harness_id: typeof REFERENCE_HARNESS | ComparisonHarness;
  task_id: string;
  seed: number;
  pair_sha256: string;
  model_id: string;
  model_equivalence_class: string;
  adapter_sha256: string;
  input_sha256: string;
  input_contract_sha256: string;
  output_contract_sha256: string;
  rubric_sha256: string;
  authority_envelope_sha256: string;
  receipt_contract_sha256: string;
  verifier_contract_sha256: string;
  output_sha256: string;
  receipt_sha256: string;
  verifier_report_sha256: string;
  generator_identity: string;
  verifier_identity: string;
  generator_prompt_sha256: string;
  verifier_prompt_sha256: string;
  generator_history_sha256: string;
  verifier_history_sha256: string;
  generator_root_sha256: string;
  verifier_root_sha256: string;
  environment_secret_free: boolean;
  loopback_only_replay: boolean;
  capability_supported: boolean;
  receipt_valid: boolean;
  verifier_valid: boolean;
  contamination_detected: boolean;
  boundary_failure: boolean;
  token_count: number;
  compute_seconds: number;
  storage_bytes: number;
  metrics: PortabilityMetricValues;
  observation_sha256: string;
}

export interface CapabilityConformanceCell {
  schema: typeof HARNESS_PORTABILITY_CAPABILITY_CELL;
  comparison_id: ComparisonId;
  pair_id: string;
  arm: ComparisonArm;
  harness_id: typeof REFERENCE_HARNESS | ComparisonHarness;
  capability_id: string;
  supported: boolean;
  contract_conformance: number;
  denominator_included: true;
  adapter_or_task_rewritten: false;
  cell_sha256: string;
}

export interface ConfidenceInterval {
  confidence_level: 0.95;
  method: "paired-normal-95";
  lower: number;
  upper: number;
}

export interface PortabilityMetricComparison {
  metric: PrimaryMetric;
  reference_mean: number;
  candidate_mean: number;
  mean_delta: number;
  interval: ConfidenceInterval;
}

export interface HarnessPortabilityComparisonResult {
  comparison_id: ComparisonId;
  reference_harness: typeof REFERENCE_HARNESS;
  candidate_harness: ComparisonHarness;
  complete_pairs: number;
  observations: number;
  unsupported_capability_cells: number;
  model_confounded_pairs: number;
  harness_effect_claim_eligible: boolean;
  metrics: PortabilityMetricComparison[];
  disposition: PortabilityDisposition;
  reasons: string[];
}

export interface CompatibilityMatrixEntry {
  harness_id: HarnessId;
  adapter_sha256: string;
  production_inventory_member: true;
  in_comparison_cohort: boolean;
}

export interface HarnessCompatibilityMatrix {
  schema: typeof HARNESS_PORTABILITY_MATRIX;
  adapter_inventory_sha256: string;
  entries: CompatibilityMatrixEntry[];
  advisory_only: true;
  matrix_sha256: string;
}

export interface HarnessPortabilitySummary {
  schema: typeof HARNESS_PORTABILITY_SUMMARY;
  protocol_id: string;
  protocol_sha256: string;
  evidence_class: EvidenceClass;
  pair_records: number;
  observation_slots: number;
  capability_cells: number;
  production_adapter_parity: number;
  total_cost_usd: number;
  total_tokens: number;
  total_compute_hours: number;
  total_storage_gib: number;
  compatibility_matrix: HarnessCompatibilityMatrix;
  comparisons: HarnessPortabilityComparisonResult[];
  claim_eligible: boolean;
  disposition: PortabilityDisposition;
  hold_reasons: string[];
  nonconformance_reasons: string[];
  advisory_only: true;
  production_routing_mutations: 0;
  summary_sha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,191}$/i;
const SECRET_VALUE = /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const FORBIDDEN_FIELDS = new Set([
  "raw_task_input", "raw_output", "raw_receipt", "raw_verifier_report", "raw_prompt",
  "raw_history", "user_or_tenant_data", "tenant_data", "user_data", "holdout_plaintext",
  "hidden_answer", "golden_patch", "fixture_path", "credential", "credentials", "secret",
  "secrets", "production_state",
]);
const COMPARISON_KEYS = new Set([
  "schema", "comparison_id", "reference_harness", "candidate_harness", "required_pairs", "required_runs",
]);
const TASK_KEYS = new Set([
  "schema_version", "task_id", "task_class", "input_sha256", "input_contract_sha256",
  "output_contract_sha256", "rubric_sha256", "authority_envelope_sha256",
  "receipt_contract_sha256", "verifier_contract_sha256",
]);
const BUDGET_KEYS = new Set([
  "maximum_runs", "maximum_cost_usd", "maximum_tokens", "maximum_compute_hours",
  "maximum_storage_gib", "per_run_timeout_minutes",
]);
const PROTOCOL_KEYS = new Set([
  "schema", "protocol_id", "evidence_class", "adapter_inventory_sha256",
  "canonical_empty_history_sha256", "reference_harness", "comparison_harnesses",
  "out_of_cohort_harnesses", "comparisons", "replicate_seeds", "pairs_per_comparison",
  "total_pair_records", "total_observation_slots", "confidence_level", "interval_method",
  "primary_metrics", "unsupported_capabilities_in_denominator", "production_adapter_parity_required",
  "advisory_only", "production_routing_mutations", "implementation_live_calls", "budget",
  "task_contracts", "protocol_sha256",
]);
const PAIR_KEYS = new Set([
  "schema", "comparison_id", "pair_id", "task_id", "task_class", "seed", "input_sha256",
  "input_contract_sha256", "output_contract_sha256", "rubric_sha256", "authority_envelope_sha256",
  "receipt_contract_sha256", "verifier_contract_sha256", "pair_sha256",
]);
const OBSERVATION_KEYS = new Set([
  "schema", "comparison_id", "pair_id", "arm", "harness_id", "task_id", "seed", "pair_sha256",
  "model_id", "model_equivalence_class", "adapter_sha256", "input_sha256", "input_contract_sha256",
  "output_contract_sha256", "rubric_sha256", "authority_envelope_sha256", "receipt_contract_sha256",
  "verifier_contract_sha256", "output_sha256", "receipt_sha256", "verifier_report_sha256",
  "generator_identity", "verifier_identity", "generator_prompt_sha256", "verifier_prompt_sha256",
  "generator_history_sha256", "verifier_history_sha256", "generator_root_sha256", "verifier_root_sha256",
  "environment_secret_free", "loopback_only_replay", "capability_supported", "receipt_valid",
  "verifier_valid", "contamination_detected", "boundary_failure", "token_count", "compute_seconds",
  "storage_bytes", "metrics", "observation_sha256",
]);
const CAPABILITY_KEYS = new Set([
  "schema", "comparison_id", "pair_id", "arm", "harness_id", "capability_id", "supported",
  "contract_conformance", "denominator_included", "adapter_or_task_rewritten", "cell_sha256",
]);
const MATRIX_KEYS = new Set(["schema", "adapter_inventory_sha256", "entries", "advisory_only", "matrix_sha256"]);
const MATRIX_ENTRY_KEYS = new Set([
  "harness_id", "adapter_sha256", "production_inventory_member", "in_comparison_cohort",
]);
const SUMMARY_KEYS = new Set([
  "schema", "protocol_id", "protocol_sha256", "evidence_class", "pair_records", "observation_slots",
  "capability_cells", "production_adapter_parity", "total_cost_usd", "total_tokens",
  "total_compute_hours", "total_storage_gib", "compatibility_matrix", "comparisons", "claim_eligible",
  "disposition", "hold_reasons", "nonconformance_reasons", "advisory_only",
  "production_routing_mutations", "summary_sha256",
]);
const RESULT_KEYS = new Set([
  "comparison_id", "reference_harness", "candidate_harness", "complete_pairs", "observations",
  "unsupported_capability_cells", "model_confounded_pairs", "harness_effect_claim_eligible", "metrics",
  "disposition", "reasons",
]);
const METRIC_COMPARISON_KEYS = new Set([
  "metric", "reference_mean", "candidate_mean", "mean_delta", "interval",
]);
const INTERVAL_KEYS = new Set(["confidence_level", "method", "lower", "upper"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

export function assertPortabilityBoundary(value: unknown, path = "value"): void {
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error(`${path} contains a secret-shaped value`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPortabilityBoundary(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) throw new Error(`${path} contains forbidden field: ${key}`);
    assertPortabilityBoundary(entry, `${path}.${key}`);
  }
}

function identifier(value: unknown, label: string): string {
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

function exactArray<T extends string>(value: unknown, expected: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} must equal ${expected.join(",")}`);
  }
  return [...expected];
}

export function portabilitySha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function computeProtocolHash(protocol: HarnessPortabilityProtocol): string {
  return portabilitySha256({ ...protocol, protocol_sha256: "0".repeat(64) });
}

export function computePairHash(pair: HarnessPortabilityPair): string {
  return portabilitySha256({ ...pair, pair_sha256: "0".repeat(64) });
}

export function computeObservationHash(observation: HarnessPortabilityObservation): string {
  return portabilitySha256({ ...observation, observation_sha256: "0".repeat(64) });
}

export function computeCapabilityCellHash(cell: CapabilityConformanceCell): string {
  return portabilitySha256({ ...cell, cell_sha256: "0".repeat(64) });
}

export function computeMatrixHash(matrix: HarnessCompatibilityMatrix): string {
  return portabilitySha256({ ...matrix, matrix_sha256: "0".repeat(64) });
}

export function computeSummaryHash(summary: HarnessPortabilitySummary): string {
  return portabilitySha256({ ...summary, summary_sha256: "0".repeat(64) });
}

function parseTask(value: unknown, index: number): PortabilityTaskContract {
  if (!isObject(value)) throw new Error(`task_contracts[${index}] must be an object`);
  exactKeys(value, TASK_KEYS, `task_contracts[${index}]`);
  if (value.schema_version !== 1) throw new Error(`task_contracts[${index}].schema_version must be 1`);
  const task: PortabilityTaskContract = {
    schema_version: 1,
    task_id: identifier(value.task_id, `task_contracts[${index}].task_id`),
    task_class: identifier(value.task_class, `task_contracts[${index}].task_class`),
    input_sha256: hash(value.input_sha256, `task_contracts[${index}].input_sha256`),
    input_contract_sha256: hash(value.input_contract_sha256, `task_contracts[${index}].input_contract_sha256`),
    output_contract_sha256: hash(value.output_contract_sha256, `task_contracts[${index}].output_contract_sha256`),
    rubric_sha256: hash(value.rubric_sha256, `task_contracts[${index}].rubric_sha256`),
    authority_envelope_sha256: hash(value.authority_envelope_sha256, `task_contracts[${index}].authority_envelope_sha256`),
    receipt_contract_sha256: hash(value.receipt_contract_sha256, `task_contracts[${index}].receipt_contract_sha256`),
    verifier_contract_sha256: hash(value.verifier_contract_sha256, `task_contracts[${index}].verifier_contract_sha256`),
  };
  if (task.receipt_contract_sha256 !== CANONICAL_RECEIPT_CONTRACT_SHA256) {
    throw new Error(`task_contracts[${index}] receipt contract drifts from the incumbent`);
  }
  if (task.verifier_contract_sha256 !== CANONICAL_VERIFIER_CONTRACT_SHA256) {
    throw new Error(`task_contracts[${index}] verifier contract drifts from the incumbent`);
  }
  return task;
}

function parseBudget(value: unknown): PortabilityBudget {
  if (!isObject(value)) throw new Error("budget must be an object");
  exactKeys(value, BUDGET_KEYS, "budget");
  const expected = {
    maximum_runs: 180,
    maximum_cost_usd: 153,
    maximum_tokens: 19_800_000,
    maximum_compute_hours: 39.6,
    maximum_storage_gib: 2.52,
    per_run_timeout_minutes: 30,
  } as const;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`budget.${key} must be ${expectedValue}`);
  }
  return expected;
}

function parseComparison(value: unknown, index: number): HarnessComparisonContract {
  if (!isObject(value)) throw new Error(`comparisons[${index}] must be an object`);
  exactKeys(value, COMPARISON_KEYS, `comparisons[${index}]`);
  const candidate = COMPARISON_HARNESSES[index];
  const comparisonId = COMPARISON_IDS[index];
  if (value.schema !== HARNESS_PORTABILITY_COMPARISON || value.comparison_id !== comparisonId
    || value.reference_harness !== REFERENCE_HARNESS || value.candidate_harness !== candidate
    || value.required_pairs !== 30 || value.required_runs !== 60) {
    throw new Error(`comparisons[${index}] drifts from the frozen ${comparisonId} contract`);
  }
  return {
    schema: HARNESS_PORTABILITY_COMPARISON,
    comparison_id: comparisonId,
    reference_harness: REFERENCE_HARNESS,
    candidate_harness: candidate,
    required_pairs: 30,
    required_runs: 60,
  };
}

export function parseHarnessPortabilityProtocol(value: unknown, inventory?: PortableHarnessInventory): HarnessPortabilityProtocol {
  assertPortabilityBoundary(value, "protocol");
  if (!isObject(value)) throw new Error("protocol must be an object");
  exactKeys(value, PROTOCOL_KEYS, "protocol");
  if (value.schema !== HARNESS_PORTABILITY_PROTOCOL) throw new Error(`protocol.schema must be ${HARNESS_PORTABILITY_PROTOCOL}`);
  if (value.evidence_class !== "synthetic_qualification" && value.evidence_class !== "phase_d_observation") {
    throw new Error("evidence_class is invalid");
  }
  if (value.reference_harness !== REFERENCE_HARNESS) throw new Error("reference_harness must be claude-code");
  const comparisonHarnesses = exactArray(value.comparison_harnesses, COMPARISON_HARNESSES, "comparison_harnesses") as ComparisonHarness[];
  const outOfCohort = exactArray(value.out_of_cohort_harnesses, OUT_OF_COHORT_HARNESSES, "out_of_cohort_harnesses") as ["cursor"];
  const metrics = exactArray(value.primary_metrics, PRIMARY_METRICS, "primary_metrics") as PrimaryMetric[];
  if (!Array.isArray(value.comparisons) || value.comparisons.length !== 3) throw new Error("comparisons must contain exactly three contracts");
  const comparisons = value.comparisons.map(parseComparison);
  if (!Array.isArray(value.replicate_seeds) || value.replicate_seeds.length !== 3) throw new Error("replicate_seeds must contain exactly three seeds");
  const seeds = value.replicate_seeds.map((entry, index) => integer(entry, `replicate_seeds[${index}]`));
  if (new Set(seeds).size !== 3 || [...seeds].sort((a, b) => a - b).some((seed, index) => seed !== seeds[index])) {
    throw new Error("replicate_seeds must be unique and ascending");
  }
  if (value.pairs_per_comparison !== 30 || value.total_pair_records !== 90 || value.total_observation_slots !== 180) {
    throw new Error("pair or observation accounting drifts from 30/90/180");
  }
  if (value.confidence_level !== 0.95 || value.interval_method !== "paired-normal-95") throw new Error("confidence interval contract drift");
  if (value.unsupported_capabilities_in_denominator !== true || value.production_adapter_parity_required !== 1) {
    throw new Error("conformance denominator or parity contract drift");
  }
  if (value.advisory_only !== true || value.production_routing_mutations !== 0 || value.implementation_live_calls !== 0) {
    throw new Error("protocol must remain advisory-only with zero routing mutations and implementation live calls");
  }
  if (!Array.isArray(value.task_contracts) || value.task_contracts.length !== 10) throw new Error("task_contracts must contain exactly ten contracts");
  const tasks = value.task_contracts.map(parseTask);
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length) throw new Error("task_contracts contains duplicate task ids");
  if ([...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id)).some((task, index) => task.task_id !== tasks[index].task_id)) {
    throw new Error("task_contracts must be lexicographically ordered");
  }
  const protocol: HarnessPortabilityProtocol = {
    schema: HARNESS_PORTABILITY_PROTOCOL,
    protocol_id: identifier(value.protocol_id, "protocol_id"),
    evidence_class: value.evidence_class,
    adapter_inventory_sha256: hash(value.adapter_inventory_sha256, "adapter_inventory_sha256"),
    canonical_empty_history_sha256: hash(value.canonical_empty_history_sha256, "canonical_empty_history_sha256"),
    reference_harness: REFERENCE_HARNESS,
    comparison_harnesses: comparisonHarnesses,
    out_of_cohort_harnesses: outOfCohort,
    comparisons,
    replicate_seeds: seeds as [number, number, number],
    pairs_per_comparison: 30,
    total_pair_records: 90,
    total_observation_slots: 180,
    confidence_level: 0.95,
    interval_method: "paired-normal-95",
    primary_metrics: metrics,
    unsupported_capabilities_in_denominator: true,
    production_adapter_parity_required: 1,
    advisory_only: true,
    production_routing_mutations: 0,
    implementation_live_calls: 0,
    budget: parseBudget(value.budget),
    task_contracts: tasks,
    protocol_sha256: hash(value.protocol_sha256, "protocol_sha256"),
  };
  if (protocol.canonical_empty_history_sha256 !== EMPTY_HISTORY_SHA256) throw new Error("canonical empty history hash drift");
  if (inventory && protocol.adapter_inventory_sha256 !== inventory.inventorySha256) throw new Error("adapter inventory hash drift");
  if (computeProtocolHash(protocol) !== protocol.protocol_sha256) throw new Error("protocol hash drift");
  return protocol;
}

export function parseHarnessPortabilityPair(value: unknown, protocol: HarnessPortabilityProtocol): HarnessPortabilityPair {
  assertPortabilityBoundary(value, "pair");
  if (!isObject(value)) throw new Error("pair must be an object");
  exactKeys(value, PAIR_KEYS, "pair");
  if (value.schema !== HARNESS_PORTABILITY_PAIR) throw new Error(`pair.schema must be ${HARNESS_PORTABILITY_PAIR}`);
  if (!COMPARISON_IDS.includes(value.comparison_id as ComparisonId)) throw new Error("pair comparison_id is outside the frozen cohort");
  const comparisonId = value.comparison_id as ComparisonId;
  const task = protocol.task_contracts.find((entry) => entry.task_id === value.task_id);
  if (!task) throw new Error("pair task is outside the frozen protocol");
  const seed = integer(value.seed, "pair.seed");
  if (!protocol.replicate_seeds.includes(seed)) throw new Error("pair seed is outside the frozen protocol");
  const pair: HarnessPortabilityPair = {
    schema: HARNESS_PORTABILITY_PAIR,
    comparison_id: comparisonId,
    pair_id: identifier(value.pair_id, "pair_id"),
    task_id: task.task_id,
    task_class: identifier(value.task_class, "task_class"),
    seed,
    input_sha256: hash(value.input_sha256, "input_sha256"),
    input_contract_sha256: hash(value.input_contract_sha256, "input_contract_sha256"),
    output_contract_sha256: hash(value.output_contract_sha256, "output_contract_sha256"),
    rubric_sha256: hash(value.rubric_sha256, "rubric_sha256"),
    authority_envelope_sha256: hash(value.authority_envelope_sha256, "authority_envelope_sha256"),
    receipt_contract_sha256: hash(value.receipt_contract_sha256, "receipt_contract_sha256"),
    verifier_contract_sha256: hash(value.verifier_contract_sha256, "verifier_contract_sha256"),
    pair_sha256: hash(value.pair_sha256, "pair_sha256"),
  };
  const expectedId = `pair-${comparisonId}-${task.task_id}-${seed}`;
  if (pair.pair_id !== expectedId) throw new Error("pair_id must be comparison-scoped and deterministic");
  for (const key of [
    "task_class", "input_sha256", "input_contract_sha256", "output_contract_sha256", "rubric_sha256",
    "authority_envelope_sha256", "receipt_contract_sha256", "verifier_contract_sha256",
  ] as const) {
    if (pair[key] !== task[key]) throw new Error(`pair ${key} drifts from its frozen task contract`);
  }
  if (computePairHash(pair) !== pair.pair_sha256) throw new Error("pair hash drift");
  return pair;
}

function parseMetrics(value: unknown): PortabilityMetricValues {
  if (!isObject(value)) throw new Error("metrics must be an object");
  exactKeys(value, new Set<string>(PRIMARY_METRICS), "metrics");
  return {
    contract_conformance: ratio(value.contract_conformance, "metrics.contract_conformance"),
    verified_quality: ratio(value.verified_quality, "metrics.verified_quality"),
    latency_ms: nonnegative(value.latency_ms, "metrics.latency_ms"),
    cost_usd: nonnegative(value.cost_usd, "metrics.cost_usd"),
    failure_rate: ratio(value.failure_rate, "metrics.failure_rate"),
    recovery_rate: ratio(value.recovery_rate, "metrics.recovery_rate"),
    edge_proof_completeness: ratio(value.edge_proof_completeness, "metrics.edge_proof_completeness"),
    contamination_rate: ratio(value.contamination_rate, "metrics.contamination_rate"),
  };
}

export function expectedHarnessForArm(pair: HarnessPortabilityPair, arm: ComparisonArm): typeof REFERENCE_HARNESS | ComparisonHarness {
  if (arm === "reference") return REFERENCE_HARNESS;
  const index = COMPARISON_IDS.indexOf(pair.comparison_id);
  return COMPARISON_HARNESSES[index];
}

export function parseHarnessPortabilityObservation(
  value: unknown,
  pair: HarnessPortabilityPair,
  protocol: HarnessPortabilityProtocol,
  inventory: PortableHarnessInventory,
): HarnessPortabilityObservation {
  assertPortabilityBoundary(value, "observation");
  if (!isObject(value)) throw new Error("observation must be an object");
  exactKeys(value, OBSERVATION_KEYS, "observation");
  if (value.schema !== HARNESS_PORTABILITY_OBSERVATION) throw new Error(`observation.schema must be ${HARNESS_PORTABILITY_OBSERVATION}`);
  if (value.arm !== "reference" && value.arm !== "candidate") throw new Error("observation arm is invalid");
  const arm = value.arm;
  const expectedHarness = expectedHarnessForArm(pair, arm);
  if (value.harness_id !== expectedHarness) throw new Error("observation harness does not match its comparison arm");
  const adapter = inventory.entries.find((entry) => entry.id === expectedHarness);
  if (!adapter) throw new Error("observation adapter is absent from the production inventory");
  const observation: HarnessPortabilityObservation = {
    schema: HARNESS_PORTABILITY_OBSERVATION,
    comparison_id: value.comparison_id as ComparisonId,
    pair_id: identifier(value.pair_id, "pair_id"),
    arm,
    harness_id: expectedHarness,
    task_id: identifier(value.task_id, "task_id"),
    seed: integer(value.seed, "seed"),
    pair_sha256: hash(value.pair_sha256, "pair_sha256"),
    model_id: identifier(value.model_id, "model_id"),
    model_equivalence_class: identifier(value.model_equivalence_class, "model_equivalence_class"),
    adapter_sha256: hash(value.adapter_sha256, "adapter_sha256"),
    input_sha256: hash(value.input_sha256, "input_sha256"),
    input_contract_sha256: hash(value.input_contract_sha256, "input_contract_sha256"),
    output_contract_sha256: hash(value.output_contract_sha256, "output_contract_sha256"),
    rubric_sha256: hash(value.rubric_sha256, "rubric_sha256"),
    authority_envelope_sha256: hash(value.authority_envelope_sha256, "authority_envelope_sha256"),
    receipt_contract_sha256: hash(value.receipt_contract_sha256, "receipt_contract_sha256"),
    verifier_contract_sha256: hash(value.verifier_contract_sha256, "verifier_contract_sha256"),
    output_sha256: hash(value.output_sha256, "output_sha256"),
    receipt_sha256: hash(value.receipt_sha256, "receipt_sha256"),
    verifier_report_sha256: hash(value.verifier_report_sha256, "verifier_report_sha256"),
    generator_identity: identifier(value.generator_identity, "generator_identity"),
    verifier_identity: identifier(value.verifier_identity, "verifier_identity"),
    generator_prompt_sha256: hash(value.generator_prompt_sha256, "generator_prompt_sha256"),
    verifier_prompt_sha256: hash(value.verifier_prompt_sha256, "verifier_prompt_sha256"),
    generator_history_sha256: hash(value.generator_history_sha256, "generator_history_sha256"),
    verifier_history_sha256: hash(value.verifier_history_sha256, "verifier_history_sha256"),
    generator_root_sha256: hash(value.generator_root_sha256, "generator_root_sha256"),
    verifier_root_sha256: hash(value.verifier_root_sha256, "verifier_root_sha256"),
    environment_secret_free: bool(value.environment_secret_free, "environment_secret_free"),
    loopback_only_replay: bool(value.loopback_only_replay, "loopback_only_replay"),
    capability_supported: bool(value.capability_supported, "capability_supported"),
    receipt_valid: bool(value.receipt_valid, "receipt_valid"),
    verifier_valid: bool(value.verifier_valid, "verifier_valid"),
    contamination_detected: bool(value.contamination_detected, "contamination_detected"),
    boundary_failure: bool(value.boundary_failure, "boundary_failure"),
    token_count: integer(value.token_count, "token_count"),
    compute_seconds: nonnegative(value.compute_seconds, "compute_seconds"),
    storage_bytes: integer(value.storage_bytes, "storage_bytes"),
    metrics: parseMetrics(value.metrics),
    observation_sha256: hash(value.observation_sha256, "observation_sha256"),
  };
  if (observation.comparison_id !== pair.comparison_id || observation.pair_id !== pair.pair_id
    || observation.task_id !== pair.task_id || observation.seed !== pair.seed || observation.pair_sha256 !== pair.pair_sha256) {
    throw new Error("observation identity drifts from its comparison-scoped pair");
  }
  for (const key of [
    "input_sha256", "input_contract_sha256", "output_contract_sha256", "rubric_sha256",
    "authority_envelope_sha256", "receipt_contract_sha256", "verifier_contract_sha256",
  ] as const) {
    if (observation[key] !== pair[key]) throw new Error(`observation ${key} drifts from its pair`);
  }
  if (observation.adapter_sha256 !== adapter.adapterSha256) throw new Error("observation adapter hash drift");
  if (observation.generator_identity === observation.verifier_identity) throw new Error("generator and verifier identities must differ");
  if (observation.generator_prompt_sha256 === observation.verifier_prompt_sha256) throw new Error("generator and verifier prompt hashes must differ");
  if (observation.generator_root_sha256 === observation.verifier_root_sha256) throw new Error("generator and verifier roots must differ");
  if (observation.generator_history_sha256 !== protocol.canonical_empty_history_sha256
    || observation.verifier_history_sha256 !== protocol.canonical_empty_history_sha256) {
    throw new Error("histories must equal the canonical empty history hash");
  }
  if (observation.contamination_detected !== (observation.metrics.contamination_rate > 0)) {
    throw new Error("contamination indicator and metric disagree");
  }
  if (!observation.capability_supported && observation.metrics.contract_conformance !== 0) {
    throw new Error("unsupported capability must be a failed conformance observation");
  }
  if (computeObservationHash(observation) !== observation.observation_sha256) throw new Error("observation hash drift");
  return observation;
}

export function parseCapabilityConformanceCell(
  value: unknown,
  pair: HarnessPortabilityPair,
): CapabilityConformanceCell {
  assertPortabilityBoundary(value, "capability_cell");
  if (!isObject(value)) throw new Error("capability cell must be an object");
  exactKeys(value, CAPABILITY_KEYS, "capability_cell");
  if (value.schema !== HARNESS_PORTABILITY_CAPABILITY_CELL) throw new Error(`capability cell schema must be ${HARNESS_PORTABILITY_CAPABILITY_CELL}`);
  if (value.arm !== "reference" && value.arm !== "candidate") throw new Error("capability cell arm is invalid");
  const arm = value.arm;
  const expectedHarness = expectedHarnessForArm(pair, arm);
  const cell: CapabilityConformanceCell = {
    schema: HARNESS_PORTABILITY_CAPABILITY_CELL,
    comparison_id: value.comparison_id as ComparisonId,
    pair_id: identifier(value.pair_id, "pair_id"),
    arm,
    harness_id: value.harness_id as CapabilityConformanceCell["harness_id"],
    capability_id: identifier(value.capability_id, "capability_id"),
    supported: bool(value.supported, "supported"),
    contract_conformance: ratio(value.contract_conformance, "contract_conformance"),
    denominator_included: value.denominator_included as true,
    adapter_or_task_rewritten: value.adapter_or_task_rewritten as false,
    cell_sha256: hash(value.cell_sha256, "cell_sha256"),
  };
  if (cell.comparison_id !== pair.comparison_id || cell.pair_id !== pair.pair_id || cell.harness_id !== expectedHarness) {
    throw new Error("capability cell identity drifts from its pair arm");
  }
  if (cell.denominator_included !== true) throw new Error("capability cell must remain in the denominator");
  if (cell.adapter_or_task_rewritten !== false) throw new Error("capability cell forbids adapter or task rewriting");
  if (!cell.supported && cell.contract_conformance !== 0) throw new Error("unsupported capability cell must fail conformance");
  if (computeCapabilityCellHash(cell) !== cell.cell_sha256) throw new Error("capability cell hash drift");
  return cell;
}

export function validateProductionInventory(inventory: PortableHarnessInventory): void {
  if (inventory.schema !== "harness-adapter-inventory/v1" || inventory.contractVersion !== 1) throw new Error("production inventory contract drift");
  if (inventory.entries.length !== PORTABLE_HARNESS_IDS.length) throw new Error(`production inventory must contain exactly ${PORTABLE_HARNESS_IDS.length} adapters`);
  if (inventory.entries.some((entry, index) => entry.id !== PORTABLE_HARNESS_IDS[index])) throw new Error("production inventory order or membership drift");
  if (!inventory.entries.every((entry) => HASH.test(entry.adapterSha256))) throw new Error("production adapter hash is invalid");
}

export function buildCompatibilityMatrix(inventory: PortableHarnessInventory): HarnessCompatibilityMatrix {
  validateProductionInventory(inventory);
  const base: HarnessCompatibilityMatrix = {
    schema: HARNESS_PORTABILITY_MATRIX,
    adapter_inventory_sha256: inventory.inventorySha256,
    entries: inventory.entries.map((entry) => ({
      harness_id: entry.id,
      adapter_sha256: entry.adapterSha256,
      production_inventory_member: true,
      in_comparison_cohort: inComparisonCohort(entry.id),
    })),
    advisory_only: true,
    matrix_sha256: "0".repeat(64),
  };
  return { ...base, matrix_sha256: computeMatrixHash(base) };
}

export function parseCompatibilityMatrix(value: unknown, inventory: PortableHarnessInventory): HarnessCompatibilityMatrix {
  assertPortabilityBoundary(value, "compatibility_matrix");
  if (!isObject(value)) throw new Error("compatibility matrix must be an object");
  exactKeys(value, MATRIX_KEYS, "compatibility_matrix");
  if (value.schema !== HARNESS_PORTABILITY_MATRIX || value.adapter_inventory_sha256 !== inventory.inventorySha256
    || value.advisory_only !== true || !Array.isArray(value.entries) || value.entries.length !== PORTABLE_HARNESS_IDS.length) {
    throw new Error("compatibility matrix contract drift");
  }
  const entries = value.entries.map((entry, index): CompatibilityMatrixEntry => {
    if (!isObject(entry)) throw new Error(`compatibility_matrix.entries[${index}] must be an object`);
    exactKeys(entry, MATRIX_ENTRY_KEYS, `compatibility_matrix.entries[${index}]`);
    const production = inventory.entries[index];
    if (entry.harness_id !== production.id || entry.adapter_sha256 !== production.adapterSha256
      || entry.production_inventory_member !== true || entry.in_comparison_cohort !== inComparisonCohort(production.id)) {
      throw new Error(`compatibility matrix entry ${index} drifts from production inventory`);
    }
    return {
      harness_id: production.id,
      adapter_sha256: production.adapterSha256,
      production_inventory_member: true,
      in_comparison_cohort: inComparisonCohort(production.id),
    };
  });
  const matrix: HarnessCompatibilityMatrix = {
    schema: HARNESS_PORTABILITY_MATRIX,
    adapter_inventory_sha256: inventory.inventorySha256,
    entries,
    advisory_only: true,
    matrix_sha256: hash(value.matrix_sha256, "matrix_sha256"),
  };
  if (computeMatrixHash(matrix) !== matrix.matrix_sha256) throw new Error("compatibility matrix hash drift");
  return matrix;
}

function reasonArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512 || SECRET_VALUE.test(entry))) {
    throw new Error(`${label} must contain bounded non-secret strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return [...value];
}

function parseMetricComparison(value: unknown, index: number): PortabilityMetricComparison {
  if (!isObject(value)) throw new Error(`metrics[${index}] must be an object`);
  exactKeys(value, METRIC_COMPARISON_KEYS, `metrics[${index}]`);
  if (value.metric !== PRIMARY_METRICS[index]) throw new Error(`metrics[${index}] order or identity drift`);
  if (!isObject(value.interval)) throw new Error(`metrics[${index}].interval must be an object`);
  exactKeys(value.interval, INTERVAL_KEYS, `metrics[${index}].interval`);
  if (value.interval.confidence_level !== 0.95 || value.interval.method !== "paired-normal-95") {
    throw new Error(`metrics[${index}].interval contract drift`);
  }
  return {
    metric: PRIMARY_METRICS[index],
    reference_mean: finite(value.reference_mean, `metrics[${index}].reference_mean`),
    candidate_mean: finite(value.candidate_mean, `metrics[${index}].candidate_mean`),
    mean_delta: finite(value.mean_delta, `metrics[${index}].mean_delta`),
    interval: {
      confidence_level: 0.95,
      method: "paired-normal-95",
      lower: finite(value.interval.lower, `metrics[${index}].interval.lower`),
      upper: finite(value.interval.upper, `metrics[${index}].interval.upper`),
    },
  };
}

function parseComparisonResult(value: unknown, index: number): HarnessPortabilityComparisonResult {
  if (!isObject(value)) throw new Error(`comparisons[${index}] must be an object`);
  exactKeys(value, RESULT_KEYS, `comparisons[${index}]`);
  if (value.comparison_id !== COMPARISON_IDS[index] || value.reference_harness !== REFERENCE_HARNESS
    || value.candidate_harness !== COMPARISON_HARNESSES[index]) {
    throw new Error(`comparisons[${index}] identity drift`);
  }
  if (!Array.isArray(value.metrics) || value.metrics.length !== PRIMARY_METRICS.length) {
    throw new Error(`comparisons[${index}].metrics must contain all eight metrics`);
  }
  if (value.disposition !== "CONFORMANT" && value.disposition !== "NONCONFORMANT" && value.disposition !== "HOLD") {
    throw new Error(`comparisons[${index}].disposition is invalid`);
  }
  return {
    comparison_id: COMPARISON_IDS[index],
    reference_harness: REFERENCE_HARNESS,
    candidate_harness: COMPARISON_HARNESSES[index],
    complete_pairs: integer(value.complete_pairs, `comparisons[${index}].complete_pairs`),
    observations: integer(value.observations, `comparisons[${index}].observations`),
    unsupported_capability_cells: integer(value.unsupported_capability_cells, `comparisons[${index}].unsupported_capability_cells`),
    model_confounded_pairs: integer(value.model_confounded_pairs, `comparisons[${index}].model_confounded_pairs`),
    harness_effect_claim_eligible: bool(value.harness_effect_claim_eligible, `comparisons[${index}].harness_effect_claim_eligible`),
    metrics: value.metrics.map(parseMetricComparison),
    disposition: value.disposition,
    reasons: reasonArray(value.reasons, `comparisons[${index}].reasons`),
  };
}

export function parseHarnessPortabilitySummary(
  value: unknown,
  protocol: HarnessPortabilityProtocol,
  inventory: PortableHarnessInventory,
): HarnessPortabilitySummary {
  assertPortabilityBoundary(value, "summary");
  if (!isObject(value)) throw new Error("summary must be an object");
  exactKeys(value, SUMMARY_KEYS, "summary");
  if (value.schema !== HARNESS_PORTABILITY_SUMMARY || value.protocol_id !== protocol.protocol_id
    || value.protocol_sha256 !== protocol.protocol_sha256 || value.evidence_class !== protocol.evidence_class) {
    throw new Error("summary protocol identity drift");
  }
  if (!Array.isArray(value.comparisons) || value.comparisons.length !== 3) throw new Error("summary comparisons must contain exactly three results");
  if (value.disposition !== "CONFORMANT" && value.disposition !== "NONCONFORMANT" && value.disposition !== "HOLD") {
    throw new Error("summary disposition is invalid");
  }
  const summary: HarnessPortabilitySummary = {
    schema: HARNESS_PORTABILITY_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    pair_records: integer(value.pair_records, "pair_records"),
    observation_slots: integer(value.observation_slots, "observation_slots"),
    capability_cells: integer(value.capability_cells, "capability_cells"),
    production_adapter_parity: ratio(value.production_adapter_parity, "production_adapter_parity"),
    total_cost_usd: nonnegative(value.total_cost_usd, "total_cost_usd"),
    total_tokens: integer(value.total_tokens, "total_tokens"),
    total_compute_hours: nonnegative(value.total_compute_hours, "total_compute_hours"),
    total_storage_gib: nonnegative(value.total_storage_gib, "total_storage_gib"),
    compatibility_matrix: parseCompatibilityMatrix(value.compatibility_matrix, inventory),
    comparisons: value.comparisons.map(parseComparisonResult),
    claim_eligible: bool(value.claim_eligible, "claim_eligible"),
    disposition: value.disposition,
    hold_reasons: reasonArray(value.hold_reasons, "hold_reasons"),
    nonconformance_reasons: reasonArray(value.nonconformance_reasons, "nonconformance_reasons"),
    advisory_only: value.advisory_only as true,
    production_routing_mutations: value.production_routing_mutations as 0,
    summary_sha256: hash(value.summary_sha256, "summary_sha256"),
  };
  if (summary.advisory_only !== true || summary.production_routing_mutations !== 0) throw new Error("summary must remain advisory-only");
  if (summary.claim_eligible && summary.disposition !== "CONFORMANT") throw new Error("only a CONFORMANT summary can be claim eligible");
  if (computeSummaryHash(summary) !== summary.summary_sha256) throw new Error("summary hash drift");
  return summary;
}

export function finalizeProtocol(protocol: Omit<HarnessPortabilityProtocol, "protocol_sha256">): HarnessPortabilityProtocol {
  const base = { ...protocol, protocol_sha256: "0".repeat(64) };
  return { ...base, protocol_sha256: computeProtocolHash(base) };
}

export function finalizePair(pair: Omit<HarnessPortabilityPair, "pair_sha256">): HarnessPortabilityPair {
  const base = { ...pair, pair_sha256: "0".repeat(64) };
  return { ...base, pair_sha256: computePairHash(base) };
}

export function finalizeObservation(observation: Omit<HarnessPortabilityObservation, "observation_sha256">): HarnessPortabilityObservation {
  const base = { ...observation, observation_sha256: "0".repeat(64) };
  return { ...base, observation_sha256: computeObservationHash(base) };
}

export function finalizeCapabilityCell(cell: Omit<CapabilityConformanceCell, "cell_sha256">): CapabilityConformanceCell {
  const base = { ...cell, cell_sha256: "0".repeat(64) };
  return { ...base, cell_sha256: computeCapabilityCellHash(base) };
}
