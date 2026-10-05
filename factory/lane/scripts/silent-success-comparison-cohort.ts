import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actorSha256, parseActorSystemManifest } from "./actor-system-twin.ts";
import {
  COMPARISON_ARMS,
  COMPARISON_METRICS,
  FAILURE_CLASSES,
  SILENT_SUCCESS_OBSERVATION,
  SILENT_SUCCESS_PROTOCOL,
  comparisonSha256,
  finalizeObservation,
  finalizeProtocol,
  requiredEvidenceKinds,
  type ComparisonArm,
  type EvidenceCitation,
  type FailureClass,
  type IncidentControlPair,
  type SilentSuccessObservation,
  type SilentSuccessProtocol,
} from "./silent-success-comparison-contract.ts";

export interface SyntheticSilentSuccessQualification {
  protocol: SilentSuccessProtocol;
  observations: SilentSuccessObservation[];
}

const FAILURE_CLASS_SEQUENCE: FailureClass[] = FAILURE_CLASSES.flatMap((failureClass, index) =>
  Array.from({ length: index < 3 ? 4 : 3 }, () => failureClass)
);

function citations(pair: IncidentControlPair, arm: ComparisonArm): EvidenceCitation[] {
  return requiredEvidenceKinds(arm).map((kind) => ({
    kind,
    sha256: comparisonSha256({ pair_id: pair.pair_id, arm, kind, evidence: "synthetic_hash_only" }),
  }));
}

export function buildSyntheticSilentSuccessQualification(manifestPath: string): SyntheticSilentSuccessQualification {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseActorSystemManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.contracts.length !== 20) throw new Error("synthetic qualification requires the incumbent 20-contract actor-system manifest");
  if (manifest.replicateSeeds.length !== 3) throw new Error("synthetic qualification requires exactly three registered seeds");
  const contracts = [...manifest.contracts].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 10);
  const seeds = [...manifest.replicateSeeds].sort((left, right) => left - right);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const descriptor = {
    manifest_id: manifest.manifestId,
    manifest_sha256: manifestSha256,
    contract_ids: contracts.map((entry) => entry.id),
    seeds,
    failure_class_sequence: FAILURE_CLASS_SEQUENCE,
  };
  const cohortSha256 = comparisonSha256(descriptor);
  const rawPairs = contracts.flatMap((contract) => seeds.map((seed) => ({ contract, seed })));
  const pairs: IncidentControlPair[] = rawPairs.map(({ contract, seed }, index) => {
    const pairId = `${contract.id}:${seed}`;
    const failureClass = FAILURE_CLASS_SEQUENCE[index]!;
    const taskContractSha256 = actorSha256(contract);
    const authorityEnvelopeSha256 = comparisonSha256({
      classification: manifest.classification,
      manifest_sha256: manifestSha256,
      review_binding: manifest.reviewBinding,
      task_contract_sha256: taskContractSha256,
    });
    return {
      pair_id: pairId,
      failure_class: failureClass,
      seed,
      task_contract_sha256: taskContractSha256,
      authority_envelope_sha256: authorityEnvelopeSha256,
      incident_input_sha256: comparisonSha256({ contract, seed, failure_class: failureClass, variant: "incident" }),
      matched_control_sha256: comparisonSha256({ contract, seed, failure_class: failureClass, variant: "clean_control" }),
      adjudication_sha256: comparisonSha256({ pair_id: pairId, failure_class: failureClass, reviewer: "synthetic" }),
      blind_ids: {
        transcript_only: `blind-${comparisonSha256({ pairId, arm: "transcript_only" }).slice(0, 24)}`,
        tool_result: `blind-${comparisonSha256({ pairId, arm: "tool_result" }).slice(0, 24)}`,
        canonical_receipt: `blind-${comparisonSha256({ pairId, arm: "canonical_receipt" }).slice(0, 24)}`,
      },
    };
  });
  const protocol = finalizeProtocol({
    schema: SILENT_SUCCESS_PROTOCOL,
    protocol_id: "zou-1064-synthetic-qualification-v1",
    evidence_class: "synthetic_qualification",
    cohort_id: manifest.manifestId,
    cohort_sha256: cohortSha256,
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
    budget: {
      maximum_runs: 90,
      maximum_cost_usd: 1,
      maximum_tokens: 0,
      maximum_compute_hours: 1,
      maximum_storage_gib: 0.1,
      per_run_timeout_minutes: 1,
    },
    pairs,
  });
  const observations = pairs.flatMap((pair, index) => COMPARISON_ARMS.map((arm) => {
    const unit = Number.parseInt(comparisonSha256({ pair_id: pair.pair_id, arm }).slice(0, 6), 16) / 0xffffff;
    const incidentDetected = arm === "canonical_receipt" || (arm === "tool_result" ? index < 15 : index < 10);
    const controlFalseAlarm = arm === "canonical_receipt" ? false : arm === "tool_result" ? index < 5 : index < 8;
    const diagnosisBase = arm === "canonical_receipt" ? 80 : arm === "tool_result" ? 110 : 150;
    const operatorActions = arm === "canonical_receipt" ? 1 : arm === "tool_result" ? 2 : 3;
    const latencyBase = arm === "canonical_receipt" ? 105 : arm === "tool_result" ? 100 : 70;
    const costBase = arm === "canonical_receipt" ? 0.0105 : arm === "tool_result" ? 0.01 : 0.007;
    return finalizeObservation({
      schema: SILENT_SUCCESS_OBSERVATION,
      observation_id: `obs-${comparisonSha256({ pair_id: pair.pair_id, arm }).slice(0, 24)}`,
      protocol_sha256: protocol.protocol_sha256,
      blind_id: pair.blind_ids[arm],
      arm,
      task_contract_sha256: pair.task_contract_sha256,
      authority_envelope_sha256: pair.authority_envelope_sha256,
      incident_input_sha256: pair.incident_input_sha256,
      matched_control_sha256: pair.matched_control_sha256,
      citations: citations(pair, arm),
      redaction_manifest_sha256: comparisonSha256({ pair_id: pair.pair_id, arm, redaction: "hashes_only" }),
      incident_detected: incidentDetected,
      control_false_alarm: controlFalseAlarm,
      diagnosis_time_ms: Number((diagnosisBase + unit * 5).toFixed(6)),
      operator_actions: operatorActions,
      latency_ms: Number((latencyBase + unit * 2).toFixed(6)),
      cost_usd: Number((costBase + unit * 0.0001).toFixed(8)),
      token_count: 0,
      compute_seconds: 1,
      storage_bytes: 1024,
      canonical_replay_verified: arm === "canonical_receipt" ? true : null,
      boundary_valid: true,
      contamination_detected: false,
      redaction_valid: true,
    });
  }));
  return { protocol, observations };
}
