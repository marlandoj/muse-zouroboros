import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actorSha256, parseActorSystemManifest } from "./actor-system-twin.ts";
import {
  SCENARIO_SOURCE_OBSERVATION,
  SCENARIO_SOURCE_PROTOCOL,
  SOURCE_METRICS,
  finalizeScenarioSourceObservation,
  finalizeScenarioSourceProtocol,
  sourceSha256,
  type ScenarioSourceObservation,
  type ScenarioSourcePair,
  type ScenarioSourceProtocol,
  type SourceArm,
  type SourceMetricValues,
} from "./scenario-source-comparison-contract.ts";

export interface SyntheticScenarioSourceQualification {
  protocol: ScenarioSourceProtocol;
  observations: ScenarioSourceObservation[];
}

function metrics(pair: ScenarioSourcePair, arm: SourceArm): SourceMetricValues {
  const unit = Number.parseInt(sourceSha256({ pair: pair.pair_id, arm }).slice(0, 6), 16) / 0xffffff;
  const manual = arm === "manual";
  return {
    defect_discovery_rate: Number((0.58 + unit * 0.04 + (manual ? 0.01 : 0)).toFixed(6)),
    severity_weighted_defect_score: Number((4.8 + unit * 0.4 + (manual ? 0.08 : 0)).toFixed(6)),
    unique_defect_rate: Number((0.42 + unit * 0.03 + (manual ? 0.01 : 0)).toFixed(6)),
    reproducibility_rate: Number((0.94 + unit * 0.02).toFixed(6)),
    maintenance_minutes: Number((12 + unit * 2 + (manual ? 0 : 0.5)).toFixed(6)),
    contamination_rate: 0,
  };
}

export function buildSyntheticScenarioSourceQualification(manifestPath: string): SyntheticScenarioSourceQualification {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseActorSystemManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.contracts.length !== 20) throw new Error("synthetic qualification requires the incumbent 20-contract actor-system manifest");
  if (manifest.replicateSeeds.length !== 3) throw new Error("synthetic qualification requires exactly three registered seeds");
  const contracts = [...manifest.contracts].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 10);
  const seeds = [...manifest.replicateSeeds].sort((left, right) => left - right);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const cohortDescriptor = {
    manifest_id: manifest.manifestId,
    manifest_sha256: manifestSha256,
    contract_ids: contracts.map((entry) => entry.id),
    seeds,
  };
  const cohortSha256 = sourceSha256(cohortDescriptor);
  const pairs: ScenarioSourcePair[] = contracts.flatMap((contract) => seeds.map((seed) => {
    const pairId = `${contract.id}:${seed}`;
    const taskContractSha256 = actorSha256(contract);
    const authorityEnvelopeSha256 = sourceSha256({
      classification: manifest.classification,
      manifest_sha256: manifestSha256,
      review_binding: manifest.reviewBinding,
      task_contract_sha256: taskContractSha256,
    });
    const verifierContractSha256 = sourceSha256({
      task_class: contract.actorKind,
      expected_terminal: contract.expectedTerminal,
      fault: contract.fault,
      recovery: contract.recovery,
      structural_only: true,
    });
    const lineage = {
      source_receipt_id: `receipt-${sourceSha256({ pairId, seed }).slice(0, 24)}`,
      source_receipt_sha256: sourceSha256({ pairId, seed, stage: "receipt" }),
      candidate_id: `candidate-${sourceSha256({ pairId, seed }).slice(0, 24)}`,
      candidate_sha256: sourceSha256({ pairId, seed, stage: "candidate" }),
      review_id: `review-${sourceSha256({ pairId, seed }).slice(0, 24)}`,
      review_sha256: sourceSha256({ pairId, seed, stage: "simulated-review" }),
      scenario_version: 1,
      reviewer_kind: "synthetic" as const,
      review_evidence_kind: "simulated_fixture" as const,
    };
    return {
      pair_id: pairId,
      task_class: contract.actorKind,
      seed,
      task_contract_sha256: taskContractSha256,
      authority_envelope_sha256: authorityEnvelopeSha256,
      verifier_contract_sha256: verifierContractSha256,
      manual_scenario_sha256: sourceSha256({ pairId, source: "manual", contract }),
      receipt_derived_scenario_sha256: sourceSha256({ pairId, source: "receipt_derived", contract, lineage }),
      receipt_derived_lineage: lineage,
    };
  }));
  const protocol = finalizeScenarioSourceProtocol({
    schema: SCENARIO_SOURCE_PROTOCOL,
    protocol_id: "zou-1062-synthetic-qualification-v1",
    evidence_class: "synthetic_qualification",
    cohort_id: manifest.manifestId,
    cohort_sha256: cohortSha256,
    planned_pairs: 30,
    planned_runs: 60,
    minimum_complete_pairs: 30,
    futility_minimum_pairs: 20,
    confidence_level: 0.95,
    primary_metric: "severity_weighted_defect_score",
    metrics: [...SOURCE_METRICS],
    contamination_detections_allowed: 0,
    advisory_only: true,
    live_model_calls: 0,
    budget: {
      maximum_runs: 60,
      maximum_cost_usd: 0,
      maximum_tokens: 0,
      maximum_compute_hours: 1,
      maximum_storage_gib: 0.1,
      per_run_timeout_minutes: 1,
    },
    pairs,
  });
  const observations = pairs.flatMap((pair) => (["manual", "receipt_derived"] as const).map((arm) => {
    const lineage = arm === "receipt_derived" ? pair.receipt_derived_lineage : null;
    return finalizeScenarioSourceObservation({
      schema: SCENARIO_SOURCE_OBSERVATION,
      observation_id: `obs-${sourceSha256({ pair: pair.pair_id, arm }).slice(0, 24)}`,
      protocol_sha256: protocol.protocol_sha256,
      pair_id: pair.pair_id,
      task_class: pair.task_class,
      seed: pair.seed,
      source_arm: arm,
      task_contract_sha256: pair.task_contract_sha256,
      authority_envelope_sha256: pair.authority_envelope_sha256,
      verifier_contract_sha256: pair.verifier_contract_sha256,
      scenario_sha256: arm === "manual" ? pair.manual_scenario_sha256 : pair.receipt_derived_scenario_sha256,
      run_receipt_sha256: sourceSha256({ pair: pair.pair_id, arm, evidence: "run-receipt" }),
      trajectory_report_sha256: sourceSha256({ pair: pair.pair_id, arm, evidence: "trajectory-report" }),
      receipt_derived_lineage: lineage,
      authority_valid: true,
      task_mix_matches: true,
      verifier_contract_matches: true,
      receipt_valid: true,
      verifier_valid: true,
      environment_secret_free: true,
      answer_exposure_detected: false,
      contamination_detected: false,
      cost_usd: 0,
      token_count: 0,
      compute_seconds: 1,
      storage_bytes: 1024,
      metrics: metrics(pair, arm),
    });
  }));
  return { protocol, observations };
}
