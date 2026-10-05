import { createHash } from "node:crypto";
import {
  PORTABLE_HARNESS_IDS,
  type HarnessId,
  type PortableHarnessInventory,
} from "../../../packages/swarm/src/executor/portability.ts";
import { canonicalize } from "./run-receipt-contract.ts";

export const CROSS_HARNESS_PROTOCOL = "cross-harness-conformance/v1" as const;
export const CROSS_HARNESS_OBSERVATION = "cross-harness-observation/v1" as const;
export const CROSS_HARNESS_SUMMARY = "cross-harness-summary/v1" as const;
export const REFERENCE_HARNESS = "claude-code" as const;
export const COMPARISON_HARNESSES = ["codex", "gemini", "hermes"] as const;
export const OUT_OF_COHORT_HARNESSES = ["cursor"] as const;
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

export type ComparisonHarness = typeof COMPARISON_HARNESSES[number];
export type PrimaryMetric = typeof PRIMARY_METRICS[number];

export interface TaskContract {
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

export interface ConformanceBudget {
  maximum_runs: number;
  maximum_cost_usd: number;
  maximum_tokens: number;
  maximum_compute_hours: number;
  maximum_storage_gib: number;
  per_run_timeout_minutes: number;
}

export interface ConformanceProtocol {
  schema: typeof CROSS_HARNESS_PROTOCOL;
  protocol_id: string;
  adapter_inventory_sha256: string;
  canonical_empty_history_sha256: string;
  reference_harness: typeof REFERENCE_HARNESS;
  comparison_harnesses: ComparisonHarness[];
  out_of_cohort_harnesses: ["cursor"];
  minimum_untouched_holdout_items: number;
  minimum_seeded_replicates_per_scenario: number;
  minimum_paired_outcomes_per_comparison: number;
  confidence_level: 0.95;
  primary_metrics: PrimaryMetric[];
  contamination_detections_allowed: 0;
  production_adapter_parity_required: 1;
  advisory_only: true;
  live_model_runs: 0;
  budget: ConformanceBudget;
  task_contracts: TaskContract[];
  protocol_sha256: string;
}

export type MetricValues = Record<PrimaryMetric, number>;

export interface RunObservation {
  schema: typeof CROSS_HARNESS_OBSERVATION;
  observation_id: string;
  task_id: string;
  seed: number;
  replicate: number;
  harness_id: typeof REFERENCE_HARNESS | ComparisonHarness;
  model_id: string;
  adapter_sha256: string;
  input_sha256: string;
  output_sha256: string;
  receipt_id: string;
  receipt_sha256: string;
  verifier_report_id: string;
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
  token_count: number;
  compute_seconds: number;
  storage_bytes: number;
  metrics: MetricValues;
  observation_sha256: string;
}

export interface ConfidenceInterval {
  confidence_level: 0.95;
  method: "paired-normal-95";
  lower: number;
  upper: number;
}

export interface MetricComparison {
  metric: PrimaryMetric;
  reference_mean: number;
  candidate_mean: number;
  mean_delta: number;
  interval: ConfidenceInterval;
}

export interface HarnessComparison {
  reference_harness: typeof REFERENCE_HARNESS;
  candidate_harness: ComparisonHarness;
  paired_outcomes: number;
  metrics: MetricComparison[];
  disposition: "PASS" | "HOLD";
  hold_reasons: string[];
}

export interface ConformanceSummary {
  schema: typeof CROSS_HARNESS_SUMMARY;
  protocol_id: string;
  protocol_sha256: string;
  adapter_inventory_sha256: string;
  production_adapter_parity: number;
  observations: number;
  untouched_holdout_items: number;
  seeded_replicates_per_scenario: number;
  total_cost_usd: number;
  total_tokens: number;
  total_compute_hours: number;
  total_storage_gib: number;
  comparisons: HarnessComparison[];
  disposition: "PASS" | "HOLD";
  hold_reasons: string[];
  advisory_only: true;
  policy_mutations: [];
  summary_sha256: string;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,127}$/i;
const SECRET_VALUE = /(?:^|[^A-Za-z0-9])(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const FORBIDDEN_FIELDS = new Set([
  "holdout_plaintext",
  "hidden_answer",
  "golden_patch",
  "fixture_path",
  "prompt",
  "generator_prompt",
  "verifier_prompt",
  "history",
  "credential",
  "tenant_data",
  "production_state",
]);
const PROTOCOL_KEYS = new Set([
  "schema", "protocol_id", "adapter_inventory_sha256", "canonical_empty_history_sha256",
  "reference_harness", "comparison_harnesses", "out_of_cohort_harnesses",
  "minimum_untouched_holdout_items", "minimum_seeded_replicates_per_scenario",
  "minimum_paired_outcomes_per_comparison", "confidence_level", "primary_metrics",
  "contamination_detections_allowed", "production_adapter_parity_required", "advisory_only",
  "live_model_runs", "budget", "task_contracts", "protocol_sha256",
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
const OBSERVATION_KEYS = new Set([
  "schema", "observation_id", "task_id", "seed", "replicate", "harness_id", "model_id",
  "adapter_sha256", "input_sha256", "output_sha256", "receipt_id", "receipt_sha256",
  "verifier_report_id", "verifier_report_sha256", "generator_identity", "verifier_identity",
  "generator_prompt_sha256", "verifier_prompt_sha256", "generator_history_sha256",
  "verifier_history_sha256", "generator_root_sha256", "verifier_root_sha256",
  "environment_secret_free", "loopback_only_replay", "capability_supported", "receipt_valid",
  "verifier_valid", "contamination_detected", "token_count", "compute_seconds", "storage_bytes",
  "metrics", "observation_sha256",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

function assertNoSensitiveFields(value: unknown, path = "value"): void {
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error(`${path} contains a secret-shaped value`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key)) throw new Error(`${path} contains forbidden field: ${key}`);
    assertNoSensitiveFields(entry, `${path}.${key}`);
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

function exactArray<T extends string>(value: unknown, expected: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    throw new Error(`${label} must equal ${expected.join(",")}`);
  }
  return [...expected];
}

export function conformanceSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function computeProtocolHash(protocol: ConformanceProtocol): string {
  return conformanceSha256({ ...protocol, protocol_sha256: "0".repeat(64) });
}

export function computeObservationHash(observation: RunObservation): string {
  return conformanceSha256({ ...observation, observation_sha256: "0".repeat(64) });
}

export function computeSummaryHash(summary: ConformanceSummary): string {
  return conformanceSha256({ ...summary, summary_sha256: "0".repeat(64) });
}

function parseTaskContract(value: unknown, index: number): TaskContract {
  if (!isObject(value)) throw new Error(`task_contracts[${index}] must be an object`);
  exactKeys(value, TASK_KEYS, `task_contracts[${index}]`);
  if (value.schema_version !== 1) throw new Error(`task_contracts[${index}].schema_version must be 1`);
  return {
    schema_version: 1,
    task_id: text(value.task_id, `task_contracts[${index}].task_id`),
    task_class: text(value.task_class, `task_contracts[${index}].task_class`),
    input_sha256: hash(value.input_sha256, `task_contracts[${index}].input_sha256`),
    input_contract_sha256: hash(value.input_contract_sha256, `task_contracts[${index}].input_contract_sha256`),
    output_contract_sha256: hash(value.output_contract_sha256, `task_contracts[${index}].output_contract_sha256`),
    rubric_sha256: hash(value.rubric_sha256, `task_contracts[${index}].rubric_sha256`),
    authority_envelope_sha256: hash(value.authority_envelope_sha256, `task_contracts[${index}].authority_envelope_sha256`),
    receipt_contract_sha256: hash(value.receipt_contract_sha256, `task_contracts[${index}].receipt_contract_sha256`),
    verifier_contract_sha256: hash(value.verifier_contract_sha256, `task_contracts[${index}].verifier_contract_sha256`),
  };
}

function parseBudget(value: unknown): ConformanceBudget {
  if (!isObject(value)) throw new Error("budget must be an object");
  exactKeys(value, BUDGET_KEYS, "budget");
  const budget = {
    maximum_runs: integer(value.maximum_runs, "budget.maximum_runs", 1),
    maximum_cost_usd: nonnegative(value.maximum_cost_usd, "budget.maximum_cost_usd"),
    maximum_tokens: integer(value.maximum_tokens, "budget.maximum_tokens"),
    maximum_compute_hours: nonnegative(value.maximum_compute_hours, "budget.maximum_compute_hours"),
    maximum_storage_gib: nonnegative(value.maximum_storage_gib, "budget.maximum_storage_gib"),
    per_run_timeout_minutes: nonnegative(value.per_run_timeout_minutes, "budget.per_run_timeout_minutes"),
  };
  if (budget.maximum_runs > 500 || budget.maximum_cost_usd > 425 || budget.maximum_tokens > 55_000_000
    || budget.maximum_compute_hours > 110 || budget.maximum_storage_gib > 7 || budget.per_run_timeout_minutes > 30) {
    throw new Error("budget exceeds the approved Phase D ceiling");
  }
  return budget;
}

export function parseConformanceProtocol(value: unknown, inventory?: PortableHarnessInventory): ConformanceProtocol {
  assertNoSensitiveFields(value, "protocol");
  if (!isObject(value)) throw new Error("protocol must be an object");
  exactKeys(value, PROTOCOL_KEYS, "protocol");
  if (value.schema !== CROSS_HARNESS_PROTOCOL) throw new Error(`protocol.schema must be ${CROSS_HARNESS_PROTOCOL}`);
  if (value.reference_harness !== REFERENCE_HARNESS) throw new Error("reference_harness must be claude-code");
  const comparisonHarnesses = exactArray(value.comparison_harnesses, COMPARISON_HARNESSES, "comparison_harnesses") as ComparisonHarness[];
  const outOfCohort = exactArray(value.out_of_cohort_harnesses, OUT_OF_COHORT_HARNESSES, "out_of_cohort_harnesses") as ["cursor"];
  const metrics = exactArray(value.primary_metrics, PRIMARY_METRICS, "primary_metrics") as PrimaryMetric[];
  if (value.confidence_level !== 0.95) throw new Error("confidence_level must be 0.95");
  if (value.contamination_detections_allowed !== 0) throw new Error("contamination_detections_allowed must be 0");
  if (value.production_adapter_parity_required !== 1) throw new Error("production_adapter_parity_required must be 1");
  if (value.advisory_only !== true || value.live_model_runs !== 0) throw new Error("protocol must be advisory-only with zero live model runs");
  if (!Array.isArray(value.task_contracts)) throw new Error("task_contracts must be an array");
  const tasks = value.task_contracts.map(parseTaskContract);
  if (tasks.length < 20) throw new Error("protocol requires at least 20 untouched holdout task contracts");
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length) throw new Error("task_contracts contains duplicate task ids");
  const protocol: ConformanceProtocol = {
    schema: CROSS_HARNESS_PROTOCOL,
    protocol_id: text(value.protocol_id, "protocol_id"),
    adapter_inventory_sha256: hash(value.adapter_inventory_sha256, "adapter_inventory_sha256"),
    canonical_empty_history_sha256: hash(value.canonical_empty_history_sha256, "canonical_empty_history_sha256"),
    reference_harness: REFERENCE_HARNESS,
    comparison_harnesses: comparisonHarnesses,
    out_of_cohort_harnesses: outOfCohort,
    minimum_untouched_holdout_items: integer(value.minimum_untouched_holdout_items, "minimum_untouched_holdout_items", 20),
    minimum_seeded_replicates_per_scenario: integer(value.minimum_seeded_replicates_per_scenario, "minimum_seeded_replicates_per_scenario", 3),
    minimum_paired_outcomes_per_comparison: integer(value.minimum_paired_outcomes_per_comparison, "minimum_paired_outcomes_per_comparison", 30),
    confidence_level: 0.95,
    primary_metrics: metrics,
    contamination_detections_allowed: 0,
    production_adapter_parity_required: 1,
    advisory_only: true,
    live_model_runs: 0,
    budget: parseBudget(value.budget),
    task_contracts: tasks,
    protocol_sha256: hash(value.protocol_sha256, "protocol_sha256"),
  };
  if (protocol.minimum_untouched_holdout_items > tasks.length) throw new Error("task contract count is below the declared holdout minimum");
  if (protocol.canonical_empty_history_sha256 !== EMPTY_HISTORY_SHA256) throw new Error("canonical empty history hash drift");
  if (inventory && protocol.adapter_inventory_sha256 !== inventory.inventorySha256) throw new Error("adapter inventory hash drift");
  if (computeProtocolHash(protocol) !== protocol.protocol_sha256) throw new Error("protocol hash drift");
  return protocol;
}

function parseMetrics(value: unknown): MetricValues {
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

export function parseRunObservation(
  value: unknown,
  protocol: ConformanceProtocol,
  inventory: PortableHarnessInventory,
): RunObservation {
  assertNoSensitiveFields(value, "observation");
  if (!isObject(value)) throw new Error("observation must be an object");
  exactKeys(value, OBSERVATION_KEYS, "observation");
  if (value.schema !== CROSS_HARNESS_OBSERVATION) throw new Error(`observation.schema must be ${CROSS_HARNESS_OBSERVATION}`);
  const harnesses = [REFERENCE_HARNESS, ...COMPARISON_HARNESSES] as const;
  if (!harnesses.includes(value.harness_id as typeof harnesses[number])) throw new Error("observation harness is outside the frozen comparison cohort");
  const task = protocol.task_contracts.find((entry) => entry.task_id === value.task_id);
  if (!task) throw new Error("observation task is not in the frozen protocol");
  const adapter = inventory.entries.find((entry) => entry.id === value.harness_id);
  if (!adapter) throw new Error("observation adapter is absent from the production inventory");
  const observation: RunObservation = {
    schema: CROSS_HARNESS_OBSERVATION,
    observation_id: text(value.observation_id, "observation_id"),
    task_id: task.task_id,
    seed: integer(value.seed, "seed"),
    replicate: integer(value.replicate, "replicate", 1),
    harness_id: value.harness_id as RunObservation["harness_id"],
    model_id: text(value.model_id, "model_id"),
    adapter_sha256: hash(value.adapter_sha256, "adapter_sha256"),
    input_sha256: hash(value.input_sha256, "input_sha256"),
    output_sha256: hash(value.output_sha256, "output_sha256"),
    receipt_id: text(value.receipt_id, "receipt_id"),
    receipt_sha256: hash(value.receipt_sha256, "receipt_sha256"),
    verifier_report_id: text(value.verifier_report_id, "verifier_report_id"),
    verifier_report_sha256: hash(value.verifier_report_sha256, "verifier_report_sha256"),
    generator_identity: text(value.generator_identity, "generator_identity"),
    verifier_identity: text(value.verifier_identity, "verifier_identity"),
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
    token_count: integer(value.token_count, "token_count"),
    compute_seconds: nonnegative(value.compute_seconds, "compute_seconds"),
    storage_bytes: integer(value.storage_bytes, "storage_bytes"),
    metrics: parseMetrics(value.metrics),
    observation_sha256: hash(value.observation_sha256, "observation_sha256"),
  };
  if (observation.adapter_sha256 !== adapter.adapterSha256) throw new Error("observation adapter hash drift");
  if (observation.input_sha256 !== task.input_sha256) throw new Error("observation input hash drift");
  if (observation.generator_identity === observation.verifier_identity) throw new Error("generator and verifier identities must be distinct");
  if (observation.generator_prompt_sha256 === observation.verifier_prompt_sha256) throw new Error("generator and verifier prompt hashes must be distinct");
  if (observation.generator_root_sha256 === observation.verifier_root_sha256) throw new Error("generator and verifier roots must be distinct");
  if (observation.generator_history_sha256 !== protocol.canonical_empty_history_sha256
    || observation.verifier_history_sha256 !== protocol.canonical_empty_history_sha256) {
    throw new Error("prior-run histories must bind to the canonical empty history hash");
  }
  if (observation.contamination_detected !== (observation.metrics.contamination_rate > 0)) {
    throw new Error("contamination indicator and metric disagree");
  }
  if (computeObservationHash(observation) !== observation.observation_sha256) throw new Error("observation hash drift");
  return observation;
}

export function validateProductionInventory(inventory: PortableHarnessInventory): void {
  if (inventory.schema !== "harness-adapter-inventory/v1" || inventory.contractVersion !== 1) throw new Error("production inventory contract drift");
  if (inventory.entries.length !== PORTABLE_HARNESS_IDS.length) throw new Error(`production inventory must contain exactly ${PORTABLE_HARNESS_IDS.length} adapters`);
  if (inventory.entries.some((entry, index) => entry.id !== PORTABLE_HARNESS_IDS[index])) throw new Error("production inventory order or membership drift");
  if (!inventory.entries.every((entry) => HASH.test(entry.adapterSha256))) throw new Error("production adapter hash is invalid");
}

export function observationPairKey(observation: Pick<RunObservation, "task_id" | "seed" | "replicate">): string {
  return `${observation.task_id}:${observation.seed}:${observation.replicate}`;
}

export function finalizeProtocol(protocol: Omit<ConformanceProtocol, "protocol_sha256">): ConformanceProtocol {
  const provisional = { ...protocol, protocol_sha256: "0".repeat(64) };
  return { ...provisional, protocol_sha256: computeProtocolHash(provisional) };
}

export function finalizeObservation(observation: Omit<RunObservation, "observation_sha256">): RunObservation {
  const provisional = { ...observation, observation_sha256: "0".repeat(64) };
  return { ...provisional, observation_sha256: computeObservationHash(provisional) };
}
