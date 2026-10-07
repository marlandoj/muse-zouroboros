#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { PORTABLE_HARNESS_IDS, buildPortableHarnessInventory, type PortableHarnessInventory } from "../../../packages/zo-swarm-orchestrator/src/executor/portability.ts";
import {
  COMPARISON_HARNESSES,
  COMPARISON_IDS,
  HARNESS_PORTABILITY_SUMMARY,
  PRIMARY_METRICS,
  REFERENCE_HARNESS,
  buildCompatibilityMatrix,
  computeSummaryHash,
  parseCapabilityConformanceCell,
  parseCompatibilityMatrix,
  parseHarnessPortabilityObservation,
  parseHarnessPortabilityPair,
  parseHarnessPortabilityProtocol,
  parseHarnessPortabilitySummary,
  validateProductionInventory,
  type CapabilityConformanceCell,
  type ComparisonHarness,
  type ComparisonId,
  type ConfidenceInterval,
  type HarnessPortabilityComparisonResult,
  type HarnessPortabilityObservation,
  type HarnessPortabilityPair,
  type HarnessPortabilityProtocol,
  type HarnessPortabilitySummary,
  type PortabilityMetricComparison,
  type PrimaryMetric,
} from "./harness-portability-comparison-contract.ts";
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

function metricComparison(
  metric: PrimaryMetric,
  pairs: Array<[HarnessPortabilityObservation, HarnessPortabilityObservation]>,
): PortabilityMetricComparison {
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

function pairCells(
  comparisonId: ComparisonId,
  pairs: readonly HarnessPortabilityPair[],
  observations: readonly HarnessPortabilityObservation[],
): Array<[HarnessPortabilityObservation, HarnessPortabilityObservation]> {
  const result: Array<[HarnessPortabilityObservation, HarnessPortabilityObservation]> = [];
  for (const pair of pairs.filter((entry) => entry.comparison_id === comparisonId)) {
    const reference = observations.find((entry) => entry.pair_id === pair.pair_id && entry.arm === "reference");
    const candidate = observations.find((entry) => entry.pair_id === pair.pair_id && entry.arm === "candidate");
    if (reference && candidate) result.push([reference, candidate]);
  }
  return result.sort(([left], [right]) => left.pair_id.localeCompare(right.pair_id));
}

function comparisonResult(
  comparisonId: ComparisonId,
  candidateHarness: ComparisonHarness,
  pairs: readonly HarnessPortabilityPair[],
  observations: readonly HarnessPortabilityObservation[],
  capabilityCells: readonly CapabilityConformanceCell[],
  evidenceClass: HarnessPortabilityProtocol["evidence_class"],
): HarnessPortabilityComparisonResult {
  const matched = pairCells(comparisonId, pairs, observations);
  const reasons: string[] = [];
  if (matched.length !== 30) reasons.push(`${comparisonId}: complete pairs must equal 30, found ${matched.length}`);
  const comparisonCells = capabilityCells.filter((cell) => cell.comparison_id === comparisonId);
  const unsupported = comparisonCells.filter((cell) => !cell.supported).length;
  if (unsupported > 0) reasons.push(`${comparisonId}: ${unsupported} unsupported capability cells failed conformance`);
  const confounded = matched.filter(([reference, candidate]) => reference.model_equivalence_class === "unknown"
    || candidate.model_equivalence_class === "unknown"
    || reference.model_equivalence_class !== candidate.model_equivalence_class).length;
  if (confounded > 0) reasons.push(`${comparisonId}: ${confounded} model-confounded pairs forbid a harness-only claim`);
  const nonconformant = matched.filter(([reference, candidate]) => reference.metrics.contract_conformance !== 1
    || candidate.metrics.contract_conformance !== 1).length;
  if (nonconformant > 0) reasons.push(`${comparisonId}: ${nonconformant} pairs failed contract conformance`);
  const claimEligible = evidenceClass === "phase_d_observation" && matched.length === 30 && unsupported === 0
    && confounded === 0 && nonconformant === 0;
  return {
    comparison_id: comparisonId,
    reference_harness: REFERENCE_HARNESS,
    candidate_harness: candidateHarness,
    complete_pairs: matched.length,
    observations: matched.length * 2,
    unsupported_capability_cells: unsupported,
    model_confounded_pairs: confounded,
    harness_effect_claim_eligible: claimEligible,
    metrics: PRIMARY_METRICS.map((metric) => metricComparison(metric, matched)),
    disposition: reasons.length === 0 && claimEligible ? "CONFORMANT" : "NONCONFORMANT",
    reasons,
  };
}

function observationHoldReasons(observation: HarnessPortabilityObservation, protocol: HarnessPortabilityProtocol): string[] {
  const reasons: string[] = [];
  if (!observation.receipt_valid) reasons.push(`${observation.pair_id}/${observation.arm}: receipt proof is invalid`);
  if (!observation.verifier_valid) reasons.push(`${observation.pair_id}/${observation.arm}: verifier proof is invalid`);
  if (!observation.environment_secret_free) reasons.push(`${observation.pair_id}/${observation.arm}: verifier environment is not secret-free`);
  if (!observation.loopback_only_replay) reasons.push(`${observation.pair_id}/${observation.arm}: replay crossed the loopback boundary`);
  if (observation.boundary_failure) reasons.push(`${observation.pair_id}/${observation.arm}: generator-verifier boundary failure`);
  if (observation.contamination_detected || observation.metrics.contamination_rate !== 0) {
    reasons.push(`${observation.pair_id}/${observation.arm}: contamination detected`);
  }
  if (observation.compute_seconds > protocol.budget.per_run_timeout_minutes * 60) {
    reasons.push(`${observation.pair_id}/${observation.arm}: per-run timeout budget exceeded`);
  }
  return reasons;
}

export function evaluateHarnessPortabilityComparison(
  protocolInput: unknown,
  pairInputs: readonly unknown[],
  observationInputs: readonly unknown[],
  capabilityCellInputs: readonly unknown[],
  inventory: PortableHarnessInventory = buildPortableHarnessInventory(),
): HarnessPortabilitySummary {
  validateProductionInventory(inventory);
  const protocol = parseHarnessPortabilityProtocol(protocolInput);
  const holdReasons: string[] = [];
  const nonconformanceReasons: string[] = [];
  if (protocol.adapter_inventory_sha256 !== inventory.inventorySha256) holdReasons.push("production adapter inventory hash drift");

  const pairs: HarnessPortabilityPair[] = [];
  for (const [index, input] of pairInputs.entries()) {
    try {
      pairs.push(parseHarnessPortabilityPair(input, protocol));
    } catch (error) {
      holdReasons.push(`pair[${index}] rejected: ${String(error)}`);
    }
  }
  const pairIds = pairs.map((pair) => pair.pair_id);
  if (new Set(pairIds).size !== pairIds.length) holdReasons.push("duplicate pair ids");
  if (pairs.length !== protocol.total_pair_records) holdReasons.push(`pair record count must equal ${protocol.total_pair_records}, found ${pairs.length}`);
  for (const comparisonId of COMPARISON_IDS) {
    const comparisonPairs = pairs.filter((pair) => pair.comparison_id === comparisonId);
    if (comparisonPairs.length !== 30) holdReasons.push(`${comparisonId}: pair records must equal 30, found ${comparisonPairs.length}`);
  }

  const pairById = new Map(pairs.map((pair) => [pair.pair_id, pair]));
  const observations: HarnessPortabilityObservation[] = [];
  for (const [index, input] of observationInputs.entries()) {
    const raw = input as Partial<HarnessPortabilityObservation>;
    const pair = typeof raw?.pair_id === "string" ? pairById.get(raw.pair_id) : undefined;
    if (!pair) {
      holdReasons.push(`observation[${index}] rejected: pair is absent`);
      continue;
    }
    try {
      observations.push(parseHarnessPortabilityObservation(input, pair, protocol, inventory));
    } catch (error) {
      holdReasons.push(`observation[${index}] rejected: ${String(error)}`);
    }
  }
  const observationCells = observations.map((entry) => `${entry.pair_id}:${entry.arm}`);
  if (new Set(observationCells).size !== observationCells.length) holdReasons.push("duplicate pair-arm observation cells");
  if (observations.length !== protocol.total_observation_slots) {
    holdReasons.push(`observation slot count must equal ${protocol.total_observation_slots}, found ${observations.length}`);
  }
  for (const pair of pairs) {
    const arms = observations.filter((entry) => entry.pair_id === pair.pair_id).map((entry) => entry.arm).sort();
    if (arms.length !== 2 || arms[0] !== "candidate" || arms[1] !== "reference") {
      holdReasons.push(`${pair.pair_id}: requires exactly one reference and one candidate arm`);
    }
  }
  const referenceObservations = observations.filter((entry) => entry.arm === "reference");
  for (const key of ["observation_sha256", "receipt_sha256"] as const) {
    const values = referenceObservations.map((entry) => entry[key]);
    if (new Set(values).size !== values.length) holdReasons.push(`comparison-scoped reference reuse detected by ${key}`);
  }
  holdReasons.push(...observations.flatMap((observation) => observationHoldReasons(observation, protocol)));

  const capabilityCells: CapabilityConformanceCell[] = [];
  for (const [index, input] of capabilityCellInputs.entries()) {
    const raw = input as Partial<CapabilityConformanceCell>;
    const pair = typeof raw?.pair_id === "string" ? pairById.get(raw.pair_id) : undefined;
    if (!pair) {
      holdReasons.push(`capability_cell[${index}] rejected: pair is absent`);
      continue;
    }
    try {
      capabilityCells.push(parseCapabilityConformanceCell(input, pair));
    } catch (error) {
      holdReasons.push(`capability_cell[${index}] rejected: ${String(error)}`);
    }
  }
  const cellKeys = capabilityCells.map((cell) => `${cell.pair_id}:${cell.arm}:${cell.capability_id}`);
  if (new Set(cellKeys).size !== cellKeys.length) holdReasons.push("duplicate capability conformance cells");
  if (capabilityCells.length !== protocol.total_observation_slots) {
    holdReasons.push(`capability cell count must equal ${protocol.total_observation_slots}, found ${capabilityCells.length}`);
  }
  for (const observation of observations) {
    const cell = capabilityCells.find((entry) => entry.pair_id === observation.pair_id && entry.arm === observation.arm);
    if (!cell) holdReasons.push(`${observation.pair_id}/${observation.arm}: missing capability conformance cell`);
    else if (cell.supported !== observation.capability_supported || cell.contract_conformance !== observation.metrics.contract_conformance) {
      holdReasons.push(`${observation.pair_id}/${observation.arm}: capability cell and observation disagree`);
    }
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

  const compatibilityMatrix = parseCompatibilityMatrix(buildCompatibilityMatrix(inventory), inventory);
  const productionAdapterParity = compatibilityMatrix.entries.length / PORTABLE_ADAPTER_COUNT;
  if (productionAdapterParity !== protocol.production_adapter_parity_required) holdReasons.push("production adapter parity is incomplete");
  const comparisons = COMPARISON_IDS.map((comparisonId, index) => comparisonResult(
    comparisonId,
    COMPARISON_HARNESSES[index],
    pairs,
    observations,
    capabilityCells,
    protocol.evidence_class,
  ));
  nonconformanceReasons.push(...comparisons.flatMap((comparison) => comparison.reasons));
  if (protocol.evidence_class === "synthetic_qualification") {
    nonconformanceReasons.push("synthetic qualification evidence is structurally claim-ineligible");
  }
  const uniqueHolds = [...new Set(holdReasons)].sort();
  const uniqueNonconformance = [...new Set(nonconformanceReasons)].sort();
  const disposition = uniqueHolds.length > 0
    ? "HOLD"
    : uniqueNonconformance.length > 0 || comparisons.some((comparison) => comparison.disposition !== "CONFORMANT")
      ? "NONCONFORMANT"
      : "CONFORMANT";
  const base: HarnessPortabilitySummary = {
    schema: HARNESS_PORTABILITY_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    pair_records: pairs.length,
    observation_slots: observations.length,
    capability_cells: capabilityCells.length,
    production_adapter_parity: productionAdapterParity,
    total_cost_usd: round(totalCost),
    total_tokens: totalTokens,
    total_compute_hours: round(totalComputeHours),
    total_storage_gib: round(totalStorageGib),
    compatibility_matrix: compatibilityMatrix,
    comparisons,
    claim_eligible: disposition === "CONFORMANT" && comparisons.every((comparison) => comparison.harness_effect_claim_eligible),
    disposition,
    hold_reasons: uniqueHolds,
    nonconformance_reasons: uniqueNonconformance,
    advisory_only: true,
    production_routing_mutations: 0,
    summary_sha256: "0".repeat(64),
  };
  const summary = { ...base, summary_sha256: computeSummaryHash(base) };
  return parseHarnessPortabilitySummary(summary, protocol, inventory);
}

const PORTABLE_ADAPTER_COUNT = PORTABLE_HARNESS_IDS.length;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function runHarnessPortabilityComparisonCli(args = process.argv.slice(2)): number {
  if (process.env.SF010_HARNESS_PORTABILITY_COMPARISON !== "1") return 0;
  const protocolPath = option(args, "--protocol");
  const pairsPath = option(args, "--pairs");
  const observationsPath = option(args, "--observations");
  const capabilityCellsPath = option(args, "--capability-cells");
  const outputPath = option(args, "--output");
  if (!protocolPath || !pairsPath || !observationsPath || !capabilityCellsPath || !outputPath) {
    throw new Error("--protocol, --pairs, --observations, --capability-cells, and --output are required when enabled");
  }
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as unknown;
  const pairs = JSON.parse(readFileSync(pairsPath, "utf8")) as unknown;
  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as unknown;
  const capabilityCells = JSON.parse(readFileSync(capabilityCellsPath, "utf8")) as unknown;
  if (!Array.isArray(pairs) || !Array.isArray(observations) || !Array.isArray(capabilityCells)) {
    throw new Error("pairs, observations, and capability cells files must contain JSON arrays");
  }
  const summary = evaluateHarnessPortabilityComparison(protocol, pairs, observations, capabilityCells);
  writeFileSync(outputPath, `${canonicalize(summary)}\n`, { flag: "wx" });
  return summary.disposition === "CONFORMANT" ? 0 : 2;
}

if (import.meta.main) process.exit(runHarnessPortabilityComparisonCli());
