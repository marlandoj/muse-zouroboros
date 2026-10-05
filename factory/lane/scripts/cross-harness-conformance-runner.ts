#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { PORTABLE_HARNESS_IDS, buildPortableHarnessInventory, type PortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import {
  COMPARISON_HARNESSES,
  CROSS_HARNESS_SUMMARY,
  PRIMARY_METRICS,
  REFERENCE_HARNESS,
  computeSummaryHash,
  observationPairKey,
  parseConformanceProtocol,
  parseRunObservation,
  validateProductionInventory,
  type ConfidenceInterval,
  type ConformanceProtocol,
  type ConformanceSummary,
  type HarnessComparison,
  type MetricComparison,
  type PrimaryMetric,
  type RunObservation,
} from "./cross-harness-conformance-contract.ts";
import { canonicalize } from "./run-receipt-contract.ts";

function round(value: number): number {
  return Number(value.toFixed(12));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function interval(deltas: readonly number[]): ConfidenceInterval {
  const center = mean(deltas);
  if (deltas.length < 2) {
    return { confidence_level: 0.95, method: "paired-normal-95", lower: round(center), upper: round(center) };
  }
  const variance = deltas.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (deltas.length - 1);
  const margin = 1.96 * Math.sqrt(variance / deltas.length);
  return {
    confidence_level: 0.95,
    method: "paired-normal-95",
    lower: round(center - margin),
    upper: round(center + margin),
  };
}

function metricComparison(metric: PrimaryMetric, pairs: Array<[RunObservation, RunObservation]>): MetricComparison {
  const reference = pairs.map(([entry]) => entry.metrics[metric]);
  const candidate = pairs.map(([, entry]) => entry.metrics[metric]);
  const deltas = pairs.map(([left, right]) => right.metrics[metric] - left.metrics[metric]);
  return {
    metric,
    reference_mean: round(mean(reference)),
    candidate_mean: round(mean(candidate)),
    mean_delta: round(mean(deltas)),
    interval: interval(deltas),
  };
}

function comparison(
  candidate: typeof COMPARISON_HARNESSES[number],
  observations: readonly RunObservation[],
  protocol: ConformanceProtocol,
): HarnessComparison {
  const reference = new Map(
    observations.filter((entry) => entry.harness_id === REFERENCE_HARNESS).map((entry) => [observationPairKey(entry), entry]),
  );
  const candidateEntries = new Map(
    observations.filter((entry) => entry.harness_id === candidate).map((entry) => [observationPairKey(entry), entry]),
  );
  const pairs: Array<[RunObservation, RunObservation]> = [];
  for (const [key, left] of reference) {
    const right = candidateEntries.get(key);
    if (right) pairs.push([left, right]);
  }
  pairs.sort(([left], [right]) => observationPairKey(left).localeCompare(observationPairKey(right)));
  const holdReasons: string[] = [];
  if (pairs.length < protocol.minimum_paired_outcomes_per_comparison) {
    holdReasons.push(`${candidate}: paired outcomes ${pairs.length} below ${protocol.minimum_paired_outcomes_per_comparison}`);
  }
  if (pairs.length < 2) holdReasons.push(`${candidate}: insufficient outcomes for a confidence interval`);
  return {
    reference_harness: REFERENCE_HARNESS,
    candidate_harness: candidate,
    paired_outcomes: pairs.length,
    metrics: PRIMARY_METRICS.map((metric) => metricComparison(metric, pairs)),
    disposition: holdReasons.length === 0 ? "PASS" : "HOLD",
    hold_reasons: holdReasons,
  };
}

function observationHoldReasons(observation: RunObservation, protocol: ConformanceProtocol): string[] {
  const reasons: string[] = [];
  if (!observation.capability_supported) reasons.push(`${observation.observation_id}: unsupported capability`);
  if (!observation.receipt_valid) reasons.push(`${observation.observation_id}: missing or invalid receipt proof`);
  if (!observation.verifier_valid) reasons.push(`${observation.observation_id}: missing or invalid verifier proof`);
  if (!observation.environment_secret_free) reasons.push(`${observation.observation_id}: verifier environment is not secret-free`);
  if (!observation.loopback_only_replay) reasons.push(`${observation.observation_id}: replay crossed the loopback boundary`);
  if (observation.contamination_detected || observation.metrics.contamination_rate !== 0) {
    reasons.push(`${observation.observation_id}: contamination detected`);
  }
  if (observation.compute_seconds > protocol.budget.per_run_timeout_minutes * 60) {
    reasons.push(`${observation.observation_id}: per-run timeout budget exceeded`);
  }
  return reasons;
}

function minimumReplicates(protocol: ConformanceProtocol, observations: readonly RunObservation[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const task of protocol.task_contracts) {
    for (const harness of [REFERENCE_HARNESS, ...COMPARISON_HARNESSES] as const) {
      const count = new Set(
        observations.filter((entry) => entry.task_id === task.task_id && entry.harness_id === harness).map((entry) => entry.replicate),
      ).size;
      minimum = Math.min(minimum, count);
    }
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

export function evaluateCrossHarnessConformance(
  protocolInput: unknown,
  observationInputs: readonly unknown[],
  inventory: PortableHarnessInventory = buildPortableHarnessInventory(),
): ConformanceSummary {
  validateProductionInventory(inventory);
  const protocol = parseConformanceProtocol(protocolInput);
  const holdReasons: string[] = [];
  if (protocol.adapter_inventory_sha256 !== inventory.inventorySha256) holdReasons.push("production adapter inventory hash drift");
  const observations: RunObservation[] = [];
  for (const [index, input] of observationInputs.entries()) {
    try {
      observations.push(parseRunObservation(input, protocol, inventory));
    } catch (error) {
      holdReasons.push(`observation[${index}] rejected: ${String(error)}`);
    }
  }
  const observationIds = observations.map((entry) => entry.observation_id);
  if (new Set(observationIds).size !== observationIds.length) holdReasons.push("duplicate observation ids");
  const cells = observations.map((entry) => `${entry.harness_id}:${observationPairKey(entry)}`);
  if (new Set(cells).size !== cells.length) holdReasons.push("duplicate harness/task/seed/replicate cells");
  holdReasons.push(...observations.flatMap((observation) => observationHoldReasons(observation, protocol)));
  const replicates = minimumReplicates(protocol, observations);
  if (replicates < protocol.minimum_seeded_replicates_per_scenario) {
    holdReasons.push(`seeded replicates ${replicates} below ${protocol.minimum_seeded_replicates_per_scenario}`);
  }
  if (protocol.task_contracts.length < protocol.minimum_untouched_holdout_items) {
    holdReasons.push("untouched holdout item count is below the protocol minimum");
  }
  const totalCost = observations.reduce((sum, entry) => sum + entry.metrics.cost_usd, 0);
  const totalTokens = observations.reduce((sum, entry) => sum + entry.token_count, 0);
  const totalComputeHours = observations.reduce((sum, entry) => sum + entry.compute_seconds, 0) / 3600;
  const totalStorageGib = observations.reduce((sum, entry) => sum + entry.storage_bytes, 0) / (1024 ** 3);
  if (observations.length > protocol.budget.maximum_runs) holdReasons.push("run budget exceeded");
  if (totalCost > protocol.budget.maximum_cost_usd) holdReasons.push("cost budget exceeded");
  if (totalTokens > protocol.budget.maximum_tokens) holdReasons.push("token budget exceeded");
  if (totalComputeHours > protocol.budget.maximum_compute_hours) holdReasons.push("compute budget exceeded");
  if (totalStorageGib > protocol.budget.maximum_storage_gib) holdReasons.push("storage budget exceeded");
  const comparisons = COMPARISON_HARNESSES.map((candidate) => comparison(candidate, observations, protocol));
  holdReasons.push(...comparisons.flatMap((entry) => entry.hold_reasons));
  const productionAdapterParity = inventory.entries.length / PORTABLE_HARNESS_IDS.length;
  if (productionAdapterParity !== protocol.production_adapter_parity_required) holdReasons.push("production adapter parity is incomplete");
  const uniqueReasons = [...new Set(holdReasons)].sort();
  const base: ConformanceSummary = {
    schema: CROSS_HARNESS_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    adapter_inventory_sha256: inventory.inventorySha256,
    production_adapter_parity: productionAdapterParity,
    observations: observations.length,
    untouched_holdout_items: protocol.task_contracts.length,
    seeded_replicates_per_scenario: replicates,
    total_cost_usd: round(totalCost),
    total_tokens: totalTokens,
    total_compute_hours: round(totalComputeHours),
    total_storage_gib: round(totalStorageGib),
    comparisons,
    disposition: uniqueReasons.length === 0 ? "PASS" : "HOLD",
    hold_reasons: uniqueReasons,
    advisory_only: true,
    policy_mutations: [],
    summary_sha256: "0".repeat(64),
  };
  return { ...base, summary_sha256: computeSummaryHash(base) };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function runCrossHarnessConformanceCli(args = process.argv.slice(2)): number {
  if (process.env.ZOUROBOROS_CROSS_HARNESS_CONFORMANCE !== "1") return 0;
  const protocolPath = option(args, "--protocol");
  const observationsPath = option(args, "--observations");
  const outputPath = option(args, "--output");
  if (!protocolPath || !observationsPath) throw new Error("--protocol and --observations are required when cross-harness conformance is enabled");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as unknown;
  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as unknown;
  if (!Array.isArray(observations)) throw new Error("observations file must contain a JSON array");
  const summary = evaluateCrossHarnessConformance(protocol, observations);
  const output = `${canonicalize(summary)}\n`;
  if (outputPath) writeFileSync(outputPath, output, { flag: "wx" });
  else process.stdout.write(output);
  return summary.disposition === "PASS" ? 0 : 2;
}

if (import.meta.main) process.exit(runCrossHarnessConformanceCli());
