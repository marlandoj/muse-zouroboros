#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import {
  COMPARISON_METRICS,
  OUTPUT_TRAJECTORY_SUMMARY,
  comparisonSha256,
  computeSummaryHash,
  hasPermittedEvidence,
  observationCell,
  parseObservation,
  parseProtocol,
  type ComparisonDisagreement,
  type ComparisonMetric,
  type ComparisonPair,
  type MetricComparison,
  type OutputTrajectoryObservation,
  type OutputTrajectoryProtocol,
  type OutputTrajectorySummary,
  type PairedConfidenceInterval,
} from "./output-trajectory-comparison-contract.ts";
import { canonicalize } from "./run-receipt-contract.ts";

function round(value: number): number {
  return Number(value.toFixed(12));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function interval(deltas: readonly number[]): PairedConfidenceInterval {
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

function metricValue(
  metric: ComparisonMetric,
  arm: OutputTrajectoryObservation,
  pair: ComparisonPair,
): number {
  if (metric === "false_acceptance_rate") return pair.adjudicated_outcome === "defective" && arm.verdict === "ACCEPT" ? 1 : 0;
  if (metric === "false_rejection_rate") return pair.adjudicated_outcome === "acceptable" && arm.verdict === "REJECT" ? 1 : 0;
  if (metric === "reproduction_rate") return arm.reproduction_rate;
  if (metric === "latency_ms") return arm.latency_ms;
  return arm.cost_usd;
}

function metricComparison(
  metric: ComparisonMetric,
  pairs: Array<[ComparisonPair, OutputTrajectoryObservation, OutputTrajectoryObservation]>,
): MetricComparison {
  const output = pairs.map(([pair, observation]) => metricValue(metric, observation, pair));
  const trajectory = pairs.map(([pair, , observation]) => metricValue(metric, observation, pair));
  const reproduction = metric === "reproduction_rate";
  const deltas = pairs.map(([pair, left, right]) => reproduction
    ? metricValue(metric, right, pair) - metricValue(metric, left, pair)
    : metricValue(metric, left, pair) - metricValue(metric, right, pair));
  return {
    metric,
    output_judge_mean: round(mean(output)),
    trajectory_verifier_mean: round(mean(trajectory)),
    mean_delta: round(mean(deltas)),
    delta_direction: reproduction ? "trajectory_verifier_minus_output_judge" : "output_judge_minus_trajectory_verifier",
    interval: interval(deltas),
  };
}

function observationReasons(observation: OutputTrajectoryObservation, protocol: OutputTrajectoryProtocol): string[] {
  const reasons: string[] = [];
  if (!hasPermittedEvidence(observation)) reasons.push(`${observation.observation_id}: verdict lacks permitted ${observation.arm} evidence`);
  if (!observation.boundary_valid) reasons.push(`${observation.observation_id}: boundary validation failed`);
  if (observation.contamination_detected) reasons.push(`${observation.observation_id}: contamination detected`);
  if (observation.compute_seconds > protocol.budget.per_run_timeout_minutes * 60) reasons.push(`${observation.observation_id}: per-run timeout exceeded`);
  return reasons;
}

function disagreement(
  pair: ComparisonPair,
  output: OutputTrajectoryObservation,
  trajectory: OutputTrajectoryObservation,
): ComparisonDisagreement {
  const base = {
    pair_id: pair.pair_id,
    case_class: pair.case_class,
    adjudication_sha256: pair.adjudication_sha256,
    output_judge: { blind_id: output.blind_id, verdict: output.verdict, citations: output.citations },
    trajectory_verifier: { blind_id: trajectory.blind_id, verdict: trajectory.verdict, citations: trajectory.citations },
  };
  return { queue_id: comparisonSha256(base), ...base };
}

export function evaluateOutputTrajectoryComparison(
  protocolInput: unknown,
  observationInputs: readonly unknown[],
): OutputTrajectorySummary {
  const protocol = parseProtocol(protocolInput);
  const reasons: string[] = [];
  const observations: OutputTrajectoryObservation[] = [];
  for (const [index, input] of observationInputs.entries()) {
    try {
      observations.push(parseObservation(input, protocol));
    } catch (error) {
      reasons.push(`observation[${index}] rejected: ${String(error)}`);
    }
  }
  const ids = observations.map((entry) => entry.observation_id);
  if (new Set(ids).size !== ids.length) reasons.push("duplicate observation ids");
  const cells = observations.map(observationCell);
  if (new Set(cells).size !== cells.length) reasons.push("duplicate blinded arm cells");
  reasons.push(...observations.flatMap((entry) => observationReasons(entry, protocol)));

  const byBlindId = new Map(observations.map((entry) => [entry.blind_id, entry]));
  const complete: Array<[ComparisonPair, OutputTrajectoryObservation, OutputTrajectoryObservation]> = [];
  for (const pair of protocol.pairs) {
    const output = byBlindId.get(pair.blind_ids.output_judge);
    const trajectory = byBlindId.get(pair.blind_ids.trajectory_verifier);
    if (output && trajectory && hasPermittedEvidence(output) && hasPermittedEvidence(trajectory)) {
      complete.push([pair, output, trajectory]);
    }
  }
  complete.sort(([left], [right]) => left.pair_id.localeCompare(right.pair_id));

  const totalCost = observations.reduce((sum, entry) => sum + entry.cost_usd, 0);
  const totalTokens = observations.reduce((sum, entry) => sum + entry.token_count, 0);
  const totalComputeHours = observations.reduce((sum, entry) => sum + entry.compute_seconds, 0) / 3600;
  const totalStorageGib = observations.reduce((sum, entry) => sum + entry.storage_bytes, 0) / (1024 ** 3);
  if (observations.length > protocol.budget.maximum_runs) reasons.push("run budget exceeded");
  if (totalCost > protocol.budget.maximum_cost_usd) reasons.push("cost budget exceeded");
  if (totalTokens > protocol.budget.maximum_tokens) reasons.push("token budget exceeded");
  if (totalComputeHours > protocol.budget.maximum_compute_hours) reasons.push("compute budget exceeded");
  if (totalStorageGib > protocol.budget.maximum_storage_gib) reasons.push("storage budget exceeded");

  const metrics = COMPARISON_METRICS.map((metric) => metricComparison(metric, complete));
  const disagreements = complete
    .filter(([, output, trajectory]) => output.verdict !== trajectory.verdict || output.verdict === "HOLD" || trajectory.verdict === "HOLD")
    .map(([pair, output, trajectory]) => disagreement(pair, output, trajectory));
  const falseAcceptance = metrics.find((entry) => entry.metric === "false_acceptance_rate")!;
  const falseRejection = metrics.find((entry) => entry.metric === "false_rejection_rate")!;
  const reproduction = metrics.find((entry) => entry.metric === "reproduction_rate")!;
  const boundaryFailures = observations.filter((entry) => !entry.boundary_valid).length;
  const contaminations = observations.filter((entry) => entry.contamination_detected).length;

  let disposition: OutputTrajectorySummary["disposition"] = "HOLD";
  if (reasons.length === 0) {
    if (complete.length < protocol.minimum_complete_pairs) {
      reasons.push(`complete pairs ${complete.length} below required ${protocol.minimum_complete_pairs}`);
    } else if (protocol.evidence_class === "synthetic_qualification") {
      disposition = "NULL_OR_NEGATIVE";
      reasons.push("synthetic qualification evidence is ineligible for a Phase D benefit claim");
    } else if (
      falseAcceptance.interval.lower > 0 &&
      falseRejection.interval.lower >= 0 &&
      reproduction.trajectory_verifier_mean >= protocol.trajectory_reproduction_threshold &&
      boundaryFailures === protocol.boundary_failures_allowed &&
      contaminations === protocol.contamination_detections_allowed
    ) {
      disposition = "TRAJECTORY_BENEFIT_SUPPORTED";
      reasons.push("all preregistered Phase D benefit gates passed");
    } else {
      disposition = "NULL_OR_NEGATIVE";
      reasons.push("one or more preregistered Phase D benefit gates did not pass");
    }
  }
  const uniqueReasons = [...new Set(reasons)].sort();
  const base: Omit<OutputTrajectorySummary, "summary_sha256"> = {
    schema: OUTPUT_TRAJECTORY_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    complete_pairs: complete.length,
    observations: observations.length,
    metrics,
    disagreements,
    total_cost_usd: round(totalCost),
    total_tokens: totalTokens,
    total_compute_hours: round(totalComputeHours),
    total_storage_gib: round(totalStorageGib),
    disposition,
    reasons: uniqueReasons,
    advisory_only: true,
    policy_mutations: [],
  };
  return { ...base, summary_sha256: computeSummaryHash(base) };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function runOutputTrajectoryComparisonCli(): number {
  if (process.env.SF009_OUTPUT_TRAJECTORY_COMPARISON !== "1") return 0;
  const protocolPath = argument("--protocol");
  const observationsPath = argument("--observations");
  const outputPath = argument("--output");
  if (!protocolPath || !observationsPath || !outputPath) throw new Error("--protocol, --observations, and --output are required when output-trajectory comparison is enabled");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as unknown;
  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as unknown;
  if (!Array.isArray(observations)) throw new Error("observations file must contain a JSON array");
  const summary = evaluateOutputTrajectoryComparison(protocol, observations);
  writeFileSync(outputPath, `${canonicalize(summary)}\n`, { flag: "wx" });
  return summary.disposition === "HOLD" ? 2 : 0;
}

if (import.meta.main) process.exit(runOutputTrajectoryComparisonCli());
