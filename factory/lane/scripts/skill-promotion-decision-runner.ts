import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DECISION_LIFECYCLE_BRIDGE_REQUEST,
  resolveDecisionLifecycleBridgeMode,
  type DecisionLifecycleShadowRequest,
} from "./decision-lifecycle-bridge-contract.ts";
import { runDecisionLifecycleShadowRunner } from "./decision-lifecycle-bridge-runner.ts";
import {
  PREDECESSOR_SCHEMAS,
  PRIMARY_METRICS,
  SKILL_PROMOTION_SUMMARY,
  buildSkillCompatibilityMatrix,
  computeSummaryHash,
  parsePredecessorBundle,
  parsePromotionSignature,
  parseSkillCompatibilityMatrix,
  parseSkillPromotionObservation,
  parseSkillPromotionProtocol,
  promotionSha256,
  validateLifecyclePair,
  type PredecessorBundle,
  type PromotionMetricComparison,
  type PromotionMetricValues,
  type SkillPromotionObservation,
  type SkillPromotionSummary,
} from "./skill-promotion-decision-contract.ts";

const LOWER_IS_BETTER = new Set(["failure_rate", "latency_ms", "cost_usd", "contamination_rate"]);
const POSITIVE_INTERVAL_METRICS = new Set(["verified_quality", "contract_conformance", "failure_rate", "recovery_rate", "edge_proof_completeness"]);

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function interval(values: readonly number[]): { lower: number; upper: number } {
  const average = mean(values);
  if (values.length < 2) return { lower: average, upper: average };
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { lower: average - margin, upper: average + margin };
}

function metricComparisons(
  observationsByPair: Map<string, { approved: SkillPromotionObservation; candidate: SkillPromotionObservation }>,
): PromotionMetricComparison[] {
  return PRIMARY_METRICS.map((metric) => {
    const approvedValues: number[] = [];
    const candidateValues: number[] = [];
    const benefitDeltas: number[] = [];
    for (const { approved, candidate } of observationsByPair.values()) {
      const approvedValue = approved.metrics[metric];
      const candidateValue = candidate.metrics[metric];
      approvedValues.push(approvedValue);
      candidateValues.push(candidateValue);
      benefitDeltas.push(LOWER_IS_BETTER.has(metric) ? approvedValue - candidateValue : candidateValue - approvedValue);
    }
    const confidence = interval(benefitDeltas);
    return {
      metric,
      approved_mean: mean(approvedValues),
      candidate_mean: mean(candidateValues),
      benefit_delta: mean(benefitDeltas),
      benefit_direction: LOWER_IS_BETTER.has(metric) ? "approved-minus-candidate" : "candidate-minus-approved",
      interval: { confidence_level: 0.95, method: "paired-normal-95", lower: confidence.lower, upper: confidence.upper },
    };
  });
}

function predecessorDecisions(predecessors: PredecessorBundle): SkillPromotionSummary["predecessor_decisions"] {
  return [
    {
      schema: PREDECESSOR_SCHEMAS[0],
      disposition: predecessors.scenario_source_summary.disposition,
      claim_eligible: predecessors.scenario_source_summary.evidence_class === "phase_d_observation" && predecessors.scenario_source_summary.disposition === "BENEFIT_SUPPORTED",
    },
    {
      schema: PREDECESSOR_SCHEMAS[1],
      disposition: predecessors.output_trajectory_summary.disposition,
      claim_eligible: predecessors.output_trajectory_summary.evidence_class === "phase_d_observation" && predecessors.output_trajectory_summary.disposition === "TRAJECTORY_BENEFIT_SUPPORTED",
    },
    {
      schema: PREDECESSOR_SCHEMAS[2],
      disposition: predecessors.silent_success_summary.disposition,
      claim_eligible: predecessors.silent_success_summary.evidence_class === "phase_d_observation" && predecessors.silent_success_summary.disposition === "RECEIPT_BENEFIT_SUPPORTED",
    },
    {
      schema: PREDECESSOR_SCHEMAS[3],
      disposition: predecessors.harness_portability_summary.disposition,
      claim_eligible: predecessors.harness_portability_summary.evidence_class === "phase_d_observation" && predecessors.harness_portability_summary.disposition === "CONFORMANT" && predecessors.harness_portability_summary.claim_eligible && predecessors.harness_portability_summary.production_adapter_parity === 1,
    },
  ];
}

function pairedObservations(observations: readonly SkillPromotionObservation[]): Map<string, { approved: SkillPromotionObservation; candidate: SkillPromotionObservation }> {
  const pairs = new Map<string, { approved?: SkillPromotionObservation; candidate?: SkillPromotionObservation }>();
  for (const observation of observations) {
    const entry = pairs.get(observation.pair_id) ?? {};
    if (observation.arm === "last-approved") {
      if (entry.approved) throw new Error(`duplicate last-approved observation for ${observation.pair_id}`);
      entry.approved = observation;
    } else {
      if (entry.candidate) throw new Error(`duplicate candidate observation for ${observation.pair_id}`);
      entry.candidate = observation;
    }
    pairs.set(observation.pair_id, entry);
  }
  const complete = new Map<string, { approved: SkillPromotionObservation; candidate: SkillPromotionObservation }>();
  for (const [pairId, entry] of pairs) if (entry.approved && entry.candidate) complete.set(pairId, { approved: entry.approved, candidate: entry.candidate });
  return complete;
}

export function evaluateSkillPromotionDecision(
  protocolInput: unknown,
  observationInputs: readonly unknown[],
  approvedLifecycleInput: unknown,
  candidateLifecycleInput: unknown,
  predecessorInput: unknown,
  signatureInput: unknown,
): SkillPromotionSummary {
  const protocol = parseSkillPromotionProtocol(protocolInput);
  const observations = observationInputs.map((input) => parseSkillPromotionObservation(input, protocol));
  if (observations.length !== protocol.required_observations || new Set(observations.map((entry) => entry.observation_id)).size !== observations.length) throw new Error("exactly 60 unique observations are required");
  const paired = pairedObservations(observations);
  const lifecycle = validateLifecyclePair(approvedLifecycleInput, candidateLifecycleInput, protocol);
  const predecessors = parsePredecessorBundle(predecessorInput);
  const compatibility = lifecycle.candidate.record
    ? parseSkillCompatibilityMatrix(buildSkillCompatibilityMatrix(lifecycle.candidate.record, protocol), protocol)
    : null;
  const metrics = metricComparisons(paired);
  const predecessorResults = predecessorDecisions(predecessors);
  const approvedLatency = metrics.find((entry) => entry.metric === "latency_ms")!.approved_mean;
  const candidateLatency = metrics.find((entry) => entry.metric === "latency_ms")!.candidate_mean;
  const approvedCost = metrics.find((entry) => entry.metric === "cost_usd")!.approved_mean;
  const candidateCost = metrics.find((entry) => entry.metric === "cost_usd")!.candidate_mean;
  const latencyRatio = approvedLatency === 0 ? (candidateLatency === 0 ? 1 : Number.POSITIVE_INFINITY) : candidateLatency / approvedLatency;
  const costRatio = approvedCost === 0 ? (candidateCost === 0 ? 1 : Number.POSITIVE_INFINITY) : candidateCost / approvedCost;
  const constitutionalFailures = observations.filter((entry) => entry.constitutional_failure).length;
  const authorityFailures = observations.filter((entry) => !entry.authority_valid || !entry.receipt_valid || !entry.verifier_valid || !entry.production_parity_valid).length;
  const contaminationDetections = observations.filter((entry) => entry.contamination_detected).length;
  const rollbackFailures = observations.filter((entry) => !entry.rollback_valid).length;
  const unresolvedCriticalObjections = observations.filter((entry) => entry.unresolved_critical_objection).length;
  const evidenceBody = {
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    complete_pairs: paired.size,
    observations: observations.length,
    compatibility_matrix_sha256: compatibility?.matrix_sha256 ?? null,
    lifecycle_gate_decisions: { approved: lifecycle.approved.decision, candidate: lifecycle.candidate.decision },
    predecessor_decisions: predecessorResults,
    metrics,
    latency_ratio: latencyRatio,
    cost_ratio: costRatio,
    constitutional_failures: constitutionalFailures,
    authority_failures: authorityFailures,
    contamination_detections: contaminationDetections,
    rollback_failures: rollbackFailures,
    unresolved_critical_objections: unresolvedCriticalObjections,
  };
  const evidencePreimageSha256 = promotionSha256(evidenceBody);
  const signature = parsePromotionSignature(signatureInput);
  const signatureValid = signature !== null && signature.evidence_preimage_sha256 === evidencePreimageSha256;
  const denyReasons: string[] = [];
  const holdReasons: string[] = [];
  if (lifecycle.approved.decision === "DENY" || lifecycle.candidate.decision === "DENY") denyReasons.push("lifecycle gate denied one or more exact skill subjects");
  if (constitutionalFailures > 0) denyReasons.push("constitutional failure detected");
  if (contaminationDetections > 0) denyReasons.push("holdout contamination detected");
  if (authorityFailures > 0) denyReasons.push("authority, receipt, verifier, or production parity failure detected");
  if (lifecycle.approved.decision === "HOLD" || lifecycle.candidate.decision === "HOLD") holdReasons.push("lifecycle evidence is not promotion ready");
  if (protocol.evidence_class !== "phase-d-production") holdReasons.push("synthetic evidence cannot support promotion");
  if (paired.size !== 30) holdReasons.push("paired observation coverage is incomplete");
  if (!compatibility || compatibility.coverage !== 1 || compatibility.cells.some((cell) => !cell.passed || !cell.contamination_checked || cell.contamination_detected || !cell.production_adapter_hash_matches)) holdReasons.push("skill/model/harness compatibility matrix is incomplete or failed");
  if (predecessorResults.some((entry) => !entry.claim_eligible)) holdReasons.push("one or more predecessor summaries are not positive claim-eligible Phase D evidence");
  if (metrics.some((entry) => POSITIVE_INTERVAL_METRICS.has(entry.metric) && entry.interval.lower <= 0)) holdReasons.push("one or more primary benefit intervals include zero");
  if (!Number.isFinite(latencyRatio) || latencyRatio > protocol.maximum_latency_ratio) holdReasons.push("latency ratio exceeds 1.10");
  if (!Number.isFinite(costRatio) || costRatio > protocol.maximum_cost_ratio) holdReasons.push("cost ratio exceeds 1.10");
  if (observations.reduce((total, entry) => total + entry.metrics.cost_usd, 0) > protocol.budget.maximum_cost_usd) holdReasons.push("cost budget exceeded");
  if (rollbackFailures > 0) holdReasons.push("rollback proof is incomplete or failed");
  if (unresolvedCriticalObjections > 0) holdReasons.push("critical objections remain unresolved");
  if (!signatureValid) holdReasons.push(signature === null ? "explicit human signature absent" : "human signature does not bind the exact evidence preimage");
  const decision = denyReasons.length > 0 ? "DENY" : holdReasons.length > 0 ? "HOLD" : "PROMOTION_RECOMMENDED";
  const body: Omit<SkillPromotionSummary, "summary_sha256"> = {
    schema: SKILL_PROMOTION_SUMMARY,
    protocol_id: protocol.protocol_id,
    protocol_sha256: protocol.protocol_sha256,
    evidence_class: protocol.evidence_class,
    complete_pairs: paired.size,
    observations: observations.length,
    compatibility_rows: compatibility?.cells.length ?? 0,
    compatibility_coverage: compatibility?.coverage ?? 0,
    lifecycle_gate_decisions: { approved: lifecycle.approved.decision, candidate: lifecycle.candidate.decision },
    predecessor_decisions: predecessorResults,
    metrics,
    latency_ratio: latencyRatio,
    cost_ratio: costRatio,
    constitutional_failures: constitutionalFailures,
    authority_failures: authorityFailures,
    contamination_detections: contaminationDetections,
    rollback_failures: rollbackFailures,
    unresolved_critical_objections: unresolvedCriticalObjections,
    human_signature_valid: signatureValid,
    decision,
    reasons: decision === "DENY" ? denyReasons : holdReasons,
    advisory_only: true,
    production_promotion_mutations: 0,
    production_routing_mutations: 0,
    evidence_preimage_sha256: evidencePreimageSha256,
  };
  return { ...body, summary_sha256: computeSummaryHash(body) };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function runSkillPromotionDecisionCli(args = process.argv.slice(2)): number {
  if (process.env.SF010_SKILL_PROMOTION_DECISION !== "1") return 0;
  const bridgeMode = resolveDecisionLifecycleBridgeMode();
  const { values } = parseArgs({
    args,
    options: {
      protocol: { type: "string" },
      observations: { type: "string" },
      "approved-lifecycle": { type: "string" },
      "candidate-lifecycle": { type: "string" },
      predecessors: { type: "string" },
      signature: { type: "string" },
      output: { type: "string" },
      "bridge-ledger": { type: "string" },
      "bridge-trace-id": { type: "string" },
      "bridge-actor-id": { type: "string" },
      "bridge-observed-at": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const key of ["protocol", "observations", "approved-lifecycle", "candidate-lifecycle", "predecessors", "signature", "output"] as const) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  if (bridgeMode === "shadow") {
    for (const key of ["bridge-ledger", "bridge-trace-id", "bridge-actor-id"] as const) {
      if (!values[key]) throw new Error(`--${key} is required in shadow mode`);
    }
  }
  const protocolInput = readJson(values.protocol!);
  const observationsInput = readJson(values.observations!) as unknown[];
  const approvedLifecycleInput = readJson(values["approved-lifecycle"]!);
  const candidateLifecycleInput = readJson(values["candidate-lifecycle"]!);
  const predecessorInput = readJson(values.predecessors!);
  const signatureInput = readJson(values.signature!);
  const summary = evaluateSkillPromotionDecision(
    protocolInput,
    observationsInput,
    approvedLifecycleInput,
    candidateLifecycleInput,
    predecessorInput,
    signatureInput,
  );
  const descriptor = openSync(values.output!, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (bridgeMode === "shadow") {
    const request: DecisionLifecycleShadowRequest = {
      schema: DECISION_LIFECYCLE_BRIDGE_REQUEST,
      trace_id: values["bridge-trace-id"]!,
      observed_at: values["bridge-observed-at"] ?? new Date().toISOString(),
      actor: { id: values["bridge-actor-id"]!, authority: "observe-only" },
      protocol: protocolInput,
      summary,
      signature: signatureInput,
      lifecycle_record: candidateLifecycleInput,
    };
    try {
      runDecisionLifecycleShadowRunner("shadow", () => request, values["bridge-ledger"]!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[decision-lifecycle-shadow] HOLD: ${message}\n`);
    }
  }
  return 0;
}

if (import.meta.main) process.exitCode = runSkillPromotionDecisionCli();
