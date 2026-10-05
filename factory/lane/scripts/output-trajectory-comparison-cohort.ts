import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { actorSha256, parseActorSystemManifest } from "./actor-system-twin.ts";
import {
  CASE_CLASSES,
  OUTPUT_EVIDENCE_KINDS,
  OUTPUT_TRAJECTORY_OBSERVATION,
  OUTPUT_TRAJECTORY_PROTOCOL,
  TRAJECTORY_EVIDENCE_KINDS,
  comparisonSha256,
  finalizeObservation,
  finalizeProtocol,
  type AdjudicatedOutcome,
  type CaseClass,
  type ComparisonArm,
  type ComparisonPair,
  type ComparisonVerdict,
  type EvidenceCitation,
  type OutputTrajectoryObservation,
  type OutputTrajectoryProtocol,
} from "./output-trajectory-comparison-contract.ts";

export interface SyntheticOutputTrajectoryQualification {
  protocol: OutputTrajectoryProtocol;
  observations: OutputTrajectoryObservation[];
}

function citations(pair: ComparisonPair, arm: ComparisonArm): EvidenceCitation[] {
  const kinds = arm === "output_judge" ? OUTPUT_EVIDENCE_KINDS : TRAJECTORY_EVIDENCE_KINDS;
  return kinds.map((kind) => ({ kind, sha256: comparisonSha256({ pair_id: pair.pair_id, arm, kind }) }));
}

function verdict(pair: ComparisonPair, arm: ComparisonArm): ComparisonVerdict {
  if (arm === "trajectory_verifier") return pair.adjudicated_outcome === "acceptable" ? "ACCEPT" : "REJECT";
  return pair.adjudicated_outcome === "acceptable" ? "REJECT" : "ACCEPT";
}

function adjudicatedOutcome(caseClass: CaseClass): AdjudicatedOutcome {
  return caseClass === "acceptable_alternative" ? "acceptable" : "defective";
}

export function buildSyntheticOutputTrajectoryQualification(manifestPath: string): SyntheticOutputTrajectoryQualification {
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
  };
  const cohortSha256 = comparisonSha256(descriptor);
  const rawPairs = contracts.flatMap((contract) => seeds.map((seed) => ({ contract, seed })));
  const pairs: ComparisonPair[] = rawPairs.map(({ contract, seed }, index) => {
    const pairId = `${contract.id}:${seed}`;
    const caseClass = CASE_CLASSES[index % CASE_CLASSES.length];
    const outcome = adjudicatedOutcome(caseClass);
    const taskContractSha256 = actorSha256(contract);
    const authorityEnvelopeSha256 = comparisonSha256({
      classification: manifest.classification,
      manifest_sha256: manifestSha256,
      review_binding: manifest.reviewBinding,
      task_contract_sha256: taskContractSha256,
    });
    const rubricSha256 = comparisonSha256({
      rubric: "output-trajectory-comparison-v1",
      expected_terminal: contract.expectedTerminal,
      structural_only: true,
    });
    return {
      pair_id: pairId,
      case_class: caseClass,
      seed,
      task_contract_sha256: taskContractSha256,
      authority_envelope_sha256: authorityEnvelopeSha256,
      rubric_sha256: rubricSha256,
      task_input_sha256: comparisonSha256({ contract, seed, task_contract_sha256: taskContractSha256 }),
      blind_ids: {
        output_judge: `blind-${comparisonSha256({ pairId, arm: "output_judge" }).slice(0, 24)}`,
        trajectory_verifier: `blind-${comparisonSha256({ pairId, arm: "trajectory_verifier" }).slice(0, 24)}`,
      },
      adjudicated_outcome: outcome,
      adjudication_sha256: comparisonSha256({ pair_id: pairId, outcome, reviewer: "synthetic" }),
    };
  });
  const protocol = finalizeProtocol({
    schema: OUTPUT_TRAJECTORY_PROTOCOL,
    protocol_id: "zou-1063-synthetic-qualification-v1",
    evidence_class: "synthetic_qualification",
    cohort_id: manifest.manifestId,
    cohort_sha256: cohortSha256,
    arms: ["output_judge", "trajectory_verifier"],
    planned_pairs: 30,
    planned_runs: 60,
    minimum_complete_pairs: 30,
    confidence_level: 0.95,
    interval_method: "paired-normal-95",
    primary_metric: "false_acceptance_rate",
    metrics: ["false_acceptance_rate", "false_rejection_rate", "reproduction_rate", "latency_ms", "cost_usd"],
    trajectory_reproduction_threshold: 0.9,
    boundary_failures_allowed: 0,
    contamination_detections_allowed: 0,
    advisory_only: true,
    live_model_calls: 0,
    policy_mutations: [],
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
  const observations = pairs.flatMap((pair) => (["output_judge", "trajectory_verifier"] as const).map((arm) => {
    const unit = Number.parseInt(comparisonSha256({ pair_id: pair.pair_id, arm }).slice(0, 6), 16) / 0xffffff;
    return finalizeObservation({
      schema: OUTPUT_TRAJECTORY_OBSERVATION,
      observation_id: `obs-${comparisonSha256({ pair_id: pair.pair_id, arm }).slice(0, 24)}`,
      protocol_sha256: protocol.protocol_sha256,
      blind_id: pair.blind_ids[arm],
      arm,
      task_input_sha256: pair.task_input_sha256,
      task_contract_sha256: pair.task_contract_sha256,
      authority_envelope_sha256: pair.authority_envelope_sha256,
      rubric_sha256: pair.rubric_sha256,
      verdict: verdict(pair, arm),
      citations: citations(pair, arm),
      reproduction_rate: arm === "trajectory_verifier" ? Number((0.95 + unit * 0.03).toFixed(6)) : Number((0.15 + unit * 0.1).toFixed(6)),
      boundary_valid: true,
      contamination_detected: false,
      latency_ms: Number(((arm === "trajectory_verifier" ? 220 : 90) + unit * 10).toFixed(6)),
      cost_usd: 0,
      token_count: 0,
      compute_seconds: 1,
      storage_bytes: 1024,
    });
  }));
  return { protocol, observations };
}
