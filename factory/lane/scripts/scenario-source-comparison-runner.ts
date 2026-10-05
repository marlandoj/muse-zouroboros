#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import {
  PRIMARY_SOURCE_METRIC,
  SCENARIO_SOURCE_SUMMARY,
  SOURCE_METRICS,
  computeScenarioSourceSummaryHash,
  observationCell,
  parseScenarioSourceObservation,
  parseScenarioSourceProtocol,
  type ScenarioSourceObservation,
  type ScenarioSourceProtocol,
  type ScenarioSourceSummary,
  type SourceConfidenceInterval,
  type SourceMetric,
  type SourceMetricComparison,
} from "./scenario-source-comparison-contract.ts";
import { canonicalize } from "./run-receipt-contract.ts";

function round(value: number): number {
  return Number(value.toFixed(12));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function interval(deltas: readonly number[]): SourceConfidenceInterval {
  const center = mean(deltas);
  if (deltas.length < 2) return { confidence_level: 0.95, method: "paired-normal-95", lower: round(center), upper: round(center) };
  const variance = deltas.reduce((sum, value) => sum + ((value - center) ** 2), 0) / (deltas.length - 1);
  const margin = 1.96 * Math.sqrt(variance / deltas.length);
  return {
    confidence_level: 0.95,
    method: "paired-normal-95",
    lower: round(center - margin),
    upper: round(center + margin),
  };
}

function metricComparison(metric: SourceMetric, pairs: Array<[ScenarioSourceObservation, ScenarioSourceObservation]>): SourceMetricComparison {
  const manual = pairs.map(([entry]) => entry.metrics[metric]);
  const derived = pairs.map(([, entry]) => entry.metrics[metric]);
  const reversed = metric === "maintenance_minutes" || metric === "contamination_rate";
  const deltas = pairs.map(([left, right]) => reversed ? left.metrics[metric] - right.metrics[metric] : right.metrics[metric] - left.metrics[metric]);
  return {
    metric,
    manual_mean: round(mean(manual)),
    receipt_derived_mean: round(mean(derived)),
    mean_delta: round(mean(deltas)),
    delta_direction: reversed ? "manual_minus_receipt_derived" : "receipt_derived_minus_manual",
    interval: interval(deltas),
  };
}

function safetyReasons(observation: ScenarioSourceObservation, protocol: ScenarioSourceProtocol): string[] {
  const reasons: string[] = [];
  if (!observation.authority_valid) reasons.push(`${observation.observation_id}: authority envelope invalid`);
  if (!observation.task_mix_matches) reasons.push(`${observation.observation_id}: task mix drift`);
  if (!observation.verifier_contract_matches) reasons.push(`${observation.observation_id}: verifier contract drift`);
  if (!observation.receipt_valid) reasons.push(`${observation.observation_id}: receipt invalid`);
  if (!observation.verifier_valid) reasons.push(`${observation.observation_id}: verifier evidence invalid`);
  if (!observation.environment_secret_free) reasons.push(`${observation.observation_id}: secret boundary failed`);
  if (observation.answer_exposure_detected) reasons.push(`${observation.observation_id}: answer exposure detected`);
  if (observation.contamination_detected || observation.metrics.contamination_rate !== 0) reasons.push(`${observation.observation_id}: contamination detected`);
  if (observation.compute_seconds > protocol.budget.per_run_timeout_minutes * 60) reasons.push(`${observation.observation_id}: per-run timeout exceeded`);
  return reasons;
}

export function evaluateScenarioSourceComparison(protocolInput: unknown, observationInputs: readonly unknown[]): ScenarioSourceSummary {
  const protocol = parseScenarioSourceProtocol(protocolInput);
  const reasons: string[] = [];
  const observations: ScenarioSourceObservation[] = [];
  for (const [index, input] of observationInputs.entries()) {
    try {
      observations.push(parseScenarioSourceObservation(input, protocol));
    } catch (error) {
      reasons.push(`observation[${index}] rejected: ${String(error)}`);
    }
  }
  const ids = observations.map((entry) => entry.observation_id);
  if (new Set(ids).size !== ids.length) reasons.push("duplicate observation ids");
  const cells = observations.map(observationCell);
  if (new Set(cells).size !== cells.length) reasons.push("duplicate pair/source-arm cells");
  reasons.push(...observations.flatMap((entry) => safetyReasons(entry, protocol)));

  const byCell = new Map(observations.map((entry) => [observationCell(entry), entry]));
  const pairs: Array<[ScenarioSourceObservation, ScenarioSourceObservation]> = [];
  for (const planned of protocol.pairs) {
    const manual = byCell.get(`${planned.pair_id}:manual`);
    const derived = byCell.get(`${planned.pair_id}:receipt_derived`);
    if (manual && derived) pairs.push([manual, derived]);
  }
  pairs.sort(([left], [right]) => left.pair_id.localeCompare(right.pair_id));

  const totalCost = observations.reduce((sum, entry) => sum + entry.cost_usd, 0);
  const totalTokens = observations.reduce((sum, entry) => sum + entry.token_count, 0);
  const totalComputeHours = observations.reduce((sum, entry) => sum + entry.compute_seconds, 0) / 3600;
  const totalStorageGib = observations.reduce((sum, entry) => sum + entry.storage_bytes, 0) / (1024 ** 3);
  if (observations.length > protocol.budget.maximum_runs) reasons.push("run budget exceeded");
  if (totalCost > protocol.budget.maximum_cost_usd) reasons.push("cost budget exceeded");
  if (totalTokens > protocol.budget.maximum_tokens) reasons.push("token budget exceeded");
  if (totalComputeHours > protocol.budget.maximum_compute_hours) reasons.push("compute budget exceeded");
  if (totalStorageGib > protocol.budget.maximum_storage_gib) reasons.push("storage budget exceeded");

  const metrics = SOURCE_METRICS.map((metric) => metricComparison(metric, pairs));
  const primary = metrics.find((entry) => entry.metric === PRIMARY_SOURCE_METRIC)!;
  let disposition: ScenarioSourceSummary["disposition"] = "HOLD";
  if (reasons.length === 0) {
    if (pairs.length < protocol.futility_minimum_pairs) {
      reasons.push(`complete pairs ${pairs.length} below futility minimum ${protocol.futility_minimum_pairs}`);
    } else if (pairs.length < protocol.minimum_complete_pairs) {
      if (primary.interval.upper <= 0) {
        disposition = "NULL_OR_NEGATIVE";
        reasons.push(`futility boundary reached at ${pairs.length} complete pairs`);
      } else {
        reasons.push(`complete pairs ${pairs.length} below required ${protocol.minimum_complete_pairs}`);
      }
    } else if (protocol.evidence_class === "synthetic_qualification") {
      disposition = "NULL_OR_NEGATIVE";
      reasons.push("synthetic qualification evidence is not eligible for a Phase D benefit claim");
    } else if (primary.interval.lower > 0) {
      disposition = "BENEFIT_SUPPORTED";
      reasons.push("primary paired 95% interval is strictly positive with zero contamination");
    } else {
      disposition = "NULL_OR_NEGATIVE";
      reasons.push("primary paired 95% interval does not establish positive benefit");
    }
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  const base: ScenarioSourceSummary = {
    schema: SCENARIO_SOURCE_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    complete_pairs: pairs.length,
    observations: observations.length,
    metrics,
    total_cost_usd: round(totalCost),
    total_tokens: totalTokens,
    total_compute_hours: round(totalComputeHours),
    total_storage_gib: round(totalStorageGib),
    disposition,
    reasons: uniqueReasons,
    advisory_only: true,
    policy_mutations: [],
    summary_sha256: "0".repeat(64),
  };
  return { ...base, summary_sha256: computeScenarioSourceSummaryHash(base) };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function runScenarioSourceComparisonCli(args = process.argv.slice(2)): number {
  if (process.env.ZOUROBOROS_SCENARIO_SOURCE_COMPARISON !== "1") return 0;
  const protocolPath = option(args, "--protocol");
  const observationsPath = option(args, "--observations");
  const outputPath = option(args, "--output");
  if (!protocolPath || !observationsPath) throw new Error("--protocol and --observations are required when scenario-source comparison is enabled");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as unknown;
  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as unknown;
  if (!Array.isArray(observations)) throw new Error("observations file must contain a JSON array");
  const summary = evaluateScenarioSourceComparison(protocol, observations);
  const output = `${canonicalize(summary)}\n`;
  if (outputPath) writeFileSync(outputPath, output, { flag: "wx" });
  else process.stdout.write(output);
  return summary.disposition === "HOLD" ? 2 : 0;
}

if (import.meta.main) process.exit(runScenarioSourceComparisonCli());
