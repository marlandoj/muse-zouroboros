#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalize } from "./run-receipt-contract.ts";
import {
  COMPARISON_ARMS,
  FAILURE_CLASSES,
  SILENT_SUCCESS_SUMMARY,
  comparisonSha256,
  computeSummaryHash,
  hasPermittedEvidence,
  observationCell,
  parseObservation,
  parseProtocol,
  type ArmMetrics,
  type ComparisonArm,
  type ConfidenceInterval,
  type ReceiptComparison,
  type SilentSuccessObservation,
  type SilentSuccessProtocol,
  type SilentSuccessSummary,
} from "./silent-success-comparison-contract.ts";

function round(value: number): number {
  return Number(value.toFixed(9));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function wilson(successes: number, total: number): ConfidenceInterval {
  if (total === 0) return { confidence_level: 0.95, method: "wilson-95", lower: 0, upper: 0 };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    confidence_level: 0.95,
    method: "wilson-95",
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
  };
}

function pairedInterval(deltas: readonly number[]): ConfidenceInterval {
  const average = mean(deltas);
  if (deltas.length < 2) return { confidence_level: 0.95, method: "paired-normal-95", lower: round(average), upper: round(average) };
  const variance = deltas.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (deltas.length - 1);
  const margin = 1.959963984540054 * Math.sqrt(variance / deltas.length);
  return {
    confidence_level: 0.95,
    method: "paired-normal-95",
    lower: round(average - margin),
    upper: round(average + margin),
  };
}

function bootstrapMedianInterval(strata: readonly (readonly number[])[], seed: string): ConfidenceInterval {
  const values = strata.flatMap((entry) => [...entry]);
  if (values.length === 0) {
    return {
      confidence_level: 0.95,
      method: "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash",
      lower: 0,
      upper: 0,
    };
  }
  let state = Number.parseInt(comparisonSha256(seed).slice(0, 8), 16) || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const medians: number[] = [];
  for (let iteration = 0; iteration < 600; iteration++) {
    const sample = strata.flatMap((stratum) =>
      Array.from({ length: stratum.length }, () => stratum[next() % stratum.length]!)
    );
    medians.push(median(sample));
  }
  medians.sort((a, b) => a - b);
  const lowerIndex = Math.floor((medians.length - 1) * 0.025);
  const upperIndex = Math.ceil((medians.length - 1) * 0.975);
  return {
    confidence_level: 0.95,
    method: "deterministic-stratified-bootstrap-95-seeded-from-protocol-hash",
    lower: round(medians[lowerIndex]!),
    upper: round(medians[upperIndex]!),
  };
}

function observationsForArm(observations: readonly SilentSuccessObservation[], arm: ComparisonArm): SilentSuccessObservation[] {
  return observations.filter((entry) => entry.arm === arm);
}

function armMetrics(protocol: SilentSuccessProtocol, observations: readonly SilentSuccessObservation[], arm: ComparisonArm): ArmMetrics {
  const selected = observationsForArm(observations, arm);
  const byBlindId = new Map(selected.map((entry) => [entry.blind_id, entry]));
  const strata = (select: (observation: SilentSuccessObservation) => number): number[][] =>
    FAILURE_CLASSES.map((failureClass) => protocol.pairs
      .filter((pair) => pair.failure_class === failureClass)
      .map((pair) => byBlindId.get(pair.blind_ids[arm]))
      .filter((entry): entry is SilentSuccessObservation => entry !== undefined)
      .map(select));
  const diagnosis = selected.map((entry) => entry.diagnosis_time_ms);
  const actions = selected.map((entry) => entry.operator_actions);
  const latency = selected.map((entry) => entry.latency_ms);
  const cost = selected.map((entry) => entry.cost_usd);
  const replay = selected.filter((entry) => entry.canonical_replay_verified !== null);
  return {
    arm,
    incident_detection_sensitivity: round(mean(selected.map((entry) => Number(entry.incident_detected)))),
    incident_detection_interval: wilson(selected.filter((entry) => entry.incident_detected).length, selected.length),
    matched_control_false_alarm_rate: round(mean(selected.map((entry) => Number(entry.control_false_alarm)))),
    matched_control_false_alarm_interval: wilson(selected.filter((entry) => entry.control_false_alarm).length, selected.length),
    diagnosis_time_ms_median: round(median(diagnosis)),
    diagnosis_time_ms_interval: bootstrapMedianInterval(strata((entry) => entry.diagnosis_time_ms), `${protocol.protocol_sha256}:${arm}:diagnosis_time_ms`),
    operator_actions_median: round(median(actions)),
    operator_actions_interval: bootstrapMedianInterval(strata((entry) => entry.operator_actions), `${protocol.protocol_sha256}:${arm}:operator_actions`),
    latency_ms_median: round(median(latency)),
    latency_ms_interval: bootstrapMedianInterval(strata((entry) => entry.latency_ms), `${protocol.protocol_sha256}:${arm}:latency_ms`),
    cost_usd_median: round(median(cost)),
    cost_usd_interval: bootstrapMedianInterval(strata((entry) => entry.cost_usd), `${protocol.protocol_sha256}:${arm}:cost_usd`),
    canonical_replay_rate: replay.length === 0 ? null : round(mean(replay.map((entry) => Number(entry.canonical_replay_verified)))),
  };
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 1 : Number.MAX_SAFE_INTEGER;
  return round(numerator / denominator);
}

function receiptComparison(
  protocol: SilentSuccessProtocol,
  byCell: ReadonlyMap<string, SilentSuccessObservation>,
  comparator: "transcript_only" | "tool_result",
  armSummaries: ReadonlyMap<ComparisonArm, ArmMetrics>,
): ReceiptComparison {
  const receipt = armSummaries.get("canonical_receipt")!;
  const other = armSummaries.get(comparator)!;
  const detectionDeltas: number[] = [];
  const falseAlarmDeltas: number[] = [];
  const diagnosisDeltas: number[] = [];
  const actionDeltas: number[] = [];
  for (const pair of protocol.pairs) {
    const receiptObservation = byCell.get(`canonical_receipt:${pair.blind_ids.canonical_receipt}`)!;
    const comparatorObservation = byCell.get(`${comparator}:${pair.blind_ids[comparator]}`)!;
    detectionDeltas.push(Number(receiptObservation.incident_detected) - Number(comparatorObservation.incident_detected));
    falseAlarmDeltas.push(Number(comparatorObservation.control_false_alarm) - Number(receiptObservation.control_false_alarm));
    diagnosisDeltas.push(comparatorObservation.diagnosis_time_ms - receiptObservation.diagnosis_time_ms);
    actionDeltas.push(comparatorObservation.operator_actions - receiptObservation.operator_actions);
  }
  return {
    comparator,
    incident_detection_delta: round(mean(detectionDeltas)),
    incident_detection_delta_interval: pairedInterval(detectionDeltas),
    false_alarm_delta: round(mean(falseAlarmDeltas)),
    false_alarm_delta_interval: pairedInterval(falseAlarmDeltas),
    diagnosis_time_delta_ms: round(mean(diagnosisDeltas)),
    diagnosis_time_delta_interval: pairedInterval(diagnosisDeltas),
    operator_actions_delta: round(mean(actionDeltas)),
    operator_actions_delta_interval: pairedInterval(actionDeltas),
    latency_ratio: safeRatio(receipt.latency_ms_median, other.latency_ms_median),
    cost_ratio: safeRatio(receipt.cost_usd_median, other.cost_usd_median),
  };
}

export function evaluateSilentSuccessComparison(protocolInput: unknown, observationInputs: readonly unknown[]): SilentSuccessSummary {
  const protocol = parseProtocol(protocolInput);
  const observations = observationInputs.map((entry) => parseObservation(entry, protocol));
  const reasons: string[] = [];
  const byCell = new Map<string, SilentSuccessObservation>();
  for (const observation of observations) {
    const cell = observationCell(observation);
    if (byCell.has(cell)) reasons.push(`duplicate observation cell: ${cell}`);
    else byCell.set(cell, observation);
    if (!hasPermittedEvidence(observation)) reasons.push(`${cell} lacks permitted complete evidence`);
    if (!observation.boundary_valid) reasons.push(`${cell} boundary validation failed`);
    if (observation.contamination_detected) reasons.push(`${cell} contamination detected`);
    if (!observation.redaction_valid) reasons.push(`${cell} redaction validation failed`);
    if (observation.arm === "canonical_receipt" && observation.canonical_replay_verified !== true) reasons.push(`${cell} canonical replay is incomplete or unavailable`);
    if (observation.compute_seconds > protocol.budget.per_run_timeout_minutes * 60) reasons.push(`${cell} per-run timeout exceeded`);
  }
  const completePairs = protocol.pairs.filter((pair) => COMPARISON_ARMS.every((arm) => byCell.has(`${arm}:${pair.blind_ids[arm]}`))).length;
  if (completePairs !== protocol.minimum_complete_pairs || observations.length !== protocol.planned_runs || byCell.size !== protocol.planned_runs) reasons.push("comparison requires exactly 30 complete pairs and 90 unique observations");

  const totalCost = observations.reduce((sum, entry) => sum + entry.cost_usd, 0);
  const totalTokens = observations.reduce((sum, entry) => sum + entry.token_count, 0);
  const totalComputeHours = observations.reduce((sum, entry) => sum + entry.compute_seconds, 0) / 3600;
  const totalStorageGib = observations.reduce((sum, entry) => sum + entry.storage_bytes, 0) / (1024 ** 3);
  if (totalCost > protocol.budget.maximum_cost_usd) reasons.push("cost budget exceeded");
  if (totalTokens > protocol.budget.maximum_tokens) reasons.push("token budget exceeded");
  if (totalComputeHours > protocol.budget.maximum_compute_hours) reasons.push("compute budget exceeded");
  if (totalStorageGib > protocol.budget.maximum_storage_gib) reasons.push("storage budget exceeded");

  const armMetricList = COMPARISON_ARMS.map((arm) => armMetrics(protocol, observations, arm));
  const armMetricMap = new Map(armMetricList.map((entry) => [entry.arm, entry]));
  const receiptComparisons = completePairs === 30
    ? (["transcript_only", "tool_result"] as const).map((arm) => receiptComparison(protocol, byCell, arm, armMetricMap))
    : [];

  let disposition: SilentSuccessSummary["disposition"] = "HOLD";
  const uniqueReasons = [...new Set(reasons)].sort();
  if (uniqueReasons.length === 0) {
    const receipt = armMetricMap.get("canonical_receipt")!;
    const tool = armMetricMap.get("tool_result")!;
    const nonOverheadGatesPass = receiptComparisons.every((entry) =>
      entry.incident_detection_delta_interval.lower > 0 &&
      entry.false_alarm_delta_interval.lower >= 0
    ) && receipt.diagnosis_time_ms_median <= tool.diagnosis_time_ms_median &&
      receipt.operator_actions_median <= tool.operator_actions_median &&
      (receipt.canonical_replay_rate ?? 0) >= protocol.replay_threshold;
    const toolComparison = receiptComparisons.find((entry) => entry.comparator === "tool_result")!;
    const overheadPasses = toolComparison.latency_ratio <= protocol.overhead_ratio_ceiling &&
      toolComparison.cost_ratio <= protocol.overhead_ratio_ceiling;
    if (protocol.evidence_class === "synthetic_qualification") {
      disposition = "NULL_OR_NEGATIVE";
      uniqueReasons.push("synthetic qualification evidence is ineligible for a Phase D receipt-benefit claim");
    } else if (nonOverheadGatesPass && !overheadPasses) {
      disposition = "OPERATOR_REVIEW_REQUIRED";
      uniqueReasons.push("receipt overhead exceeds the preregistered 1.10 ceiling; no exception is inferred");
    } else if (nonOverheadGatesPass && overheadPasses) {
      disposition = "RECEIPT_BENEFIT_SUPPORTED";
      uniqueReasons.push("all preregistered Phase D receipt-benefit gates passed");
    } else {
      disposition = "NULL_OR_NEGATIVE";
      uniqueReasons.push("one or more preregistered Phase D receipt-benefit gates did not pass");
    }
  }

  const base: Omit<SilentSuccessSummary, "summary_sha256"> = {
    schema: SILENT_SUCCESS_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    complete_pairs: completePairs,
    observations: observations.length,
    arm_metrics: armMetricList,
    receipt_comparisons: receiptComparisons,
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

export function runSilentSuccessComparisonCli(): number {
  if (process.env.SF009_SILENT_SUCCESS_COMPARISON !== "1") return 0;
  const protocolPath = argument("--protocol");
  const observationsPath = argument("--observations");
  const outputPath = argument("--output");
  if (!protocolPath || !observationsPath || !outputPath) throw new Error("--protocol, --observations, and --output are required");
  const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as unknown;
  const observations = JSON.parse(readFileSync(observationsPath, "utf8")) as unknown;
  if (!Array.isArray(observations)) throw new Error("observations input must be an array");
  const summary = evaluateSilentSuccessComparison(protocol, observations);
  writeFileSync(outputPath, `${canonicalize(summary)}\n`, { flag: "wx" });
  return summary.disposition === "HOLD" ? 2 : 0;
}

if (import.meta.main) process.exit(runSilentSuccessComparisonCli());
