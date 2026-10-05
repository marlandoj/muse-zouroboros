import { readFileSync } from "node:fs";
import { buildPortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import {
  CANONICAL_RECEIPT_CONTRACT_SHA256,
  CANONICAL_VERIFIER_CONTRACT_SHA256,
  COMPARISON_HARNESSES,
  COMPARISON_IDS,
  EMPTY_HISTORY_SHA256,
  HARNESS_PORTABILITY_CAPABILITY_CELL,
  HARNESS_PORTABILITY_COMPARISON,
  HARNESS_PORTABILITY_OBSERVATION,
  HARNESS_PORTABILITY_PAIR,
  HARNESS_PORTABILITY_PROTOCOL,
  PRIMARY_METRICS,
  REFERENCE_HARNESS,
  finalizeCapabilityCell,
  finalizeObservation,
  finalizePair,
  finalizeProtocol,
  portabilitySha256,
  type CapabilityConformanceCell,
  type HarnessPortabilityObservation,
  type HarnessPortabilityPair,
  type HarnessPortabilityProtocol,
  type PortabilityTaskContract,
} from "./harness-portability-comparison-contract.ts";

interface SyntheticActorContract {
  id: string;
  actorKind: string;
  interaction: string;
  initialState: string;
  fault: string;
  recovery: string;
  approval: string;
  expectedTerminal: string;
}

interface SyntheticActorManifest {
  schemaVersion: 1;
  manifestId: string;
  classification: "synthetic_only";
  reviewBinding: string;
  replicateSeeds: number[];
  contracts: SyntheticActorContract[];
}

export interface SyntheticHarnessPortabilityQualification {
  protocol: HarnessPortabilityProtocol;
  pairs: HarnessPortabilityPair[];
  observations: HarnessPortabilityObservation[];
  capability_cells: CapabilityConformanceCell[];
  claim_eligible: false;
  required_disposition: "NONCONFORMANT";
  uses_live_models_or_harnesses: false;
}

function taskContract(contract: SyntheticActorContract, manifest: SyntheticActorManifest): PortabilityTaskContract {
  return {
    schema_version: 1,
    task_id: contract.id,
    task_class: `${contract.actorKind}-${contract.interaction}`,
    input_sha256: portabilitySha256(contract),
    input_contract_sha256: portabilitySha256({ schema: "actor-system-contract/v1", role: "input" }),
    output_contract_sha256: portabilitySha256({ schema: "actor-system-contract/v1", role: "output" }),
    rubric_sha256: portabilitySha256({ schema: "actor-system-rubric/v1", contract: contract.id }),
    authority_envelope_sha256: portabilitySha256({ schema: "operator-authority/v1", manifest: manifest.manifestId }),
    receipt_contract_sha256: CANONICAL_RECEIPT_CONTRACT_SHA256,
    verifier_contract_sha256: CANONICAL_VERIFIER_CONTRACT_SHA256,
  };
}

export function buildSyntheticHarnessPortabilityQualification(manifestPath: string): SyntheticHarnessPortabilityQualification {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SyntheticActorManifest;
  if (manifest.schemaVersion !== 1 || manifest.classification !== "synthetic_only") throw new Error("manifest must be reviewed synthetic-only v1");
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length < 10) throw new Error("manifest requires at least ten actor contracts");
  if (!Array.isArray(manifest.replicateSeeds) || manifest.replicateSeeds.length !== 3) throw new Error("manifest requires exactly three replicate seeds");
  const seeds = [...manifest.replicateSeeds].sort((a, b) => a - b) as [number, number, number];
  if (!seeds.every(Number.isSafeInteger) || new Set(seeds).size !== 3) throw new Error("manifest seeds must be unique integers");
  const selectedContracts = [...manifest.contracts].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 10);
  if (new Set(selectedContracts.map((contract) => contract.id)).size !== 10) throw new Error("selected actor contract ids must be unique");
  const inventory = buildPortableHarnessInventory();
  const tasks = selectedContracts.map((contract) => taskContract(contract, manifest));
  const protocol = finalizeProtocol({
    schema: HARNESS_PORTABILITY_PROTOCOL,
    protocol_id: "zou-1066-synthetic-harness-portability-v1",
    evidence_class: "synthetic_qualification",
    adapter_inventory_sha256: inventory.inventorySha256,
    canonical_empty_history_sha256: EMPTY_HISTORY_SHA256,
    reference_harness: REFERENCE_HARNESS,
    comparison_harnesses: [...COMPARISON_HARNESSES],
    out_of_cohort_harnesses: ["cursor"],
    comparisons: COMPARISON_IDS.map((comparisonId, index) => ({
      schema: HARNESS_PORTABILITY_COMPARISON,
      comparison_id: comparisonId,
      reference_harness: REFERENCE_HARNESS,
      candidate_harness: COMPARISON_HARNESSES[index],
      required_pairs: 30,
      required_runs: 60,
    })),
    replicate_seeds: seeds,
    pairs_per_comparison: 30,
    total_pair_records: 90,
    total_observation_slots: 180,
    confidence_level: 0.95,
    interval_method: "paired-normal-95",
    primary_metrics: [...PRIMARY_METRICS],
    unsupported_capabilities_in_denominator: true,
    production_adapter_parity_required: 1,
    advisory_only: true,
    production_routing_mutations: 0,
    implementation_live_calls: 0,
    budget: {
      maximum_runs: 180,
      maximum_cost_usd: 153,
      maximum_tokens: 19_800_000,
      maximum_compute_hours: 39.6,
      maximum_storage_gib: 2.52,
      per_run_timeout_minutes: 30,
    },
    task_contracts: tasks,
  });

  const pairs = protocol.comparisons.flatMap((comparison) => protocol.task_contracts.flatMap((task) => seeds.map((seed) => finalizePair({
    schema: HARNESS_PORTABILITY_PAIR,
    comparison_id: comparison.comparison_id,
    pair_id: `pair-${comparison.comparison_id}-${task.task_id}-${seed}`,
    task_id: task.task_id,
    task_class: task.task_class,
    seed,
    input_sha256: task.input_sha256,
    input_contract_sha256: task.input_contract_sha256,
    output_contract_sha256: task.output_contract_sha256,
    rubric_sha256: task.rubric_sha256,
    authority_envelope_sha256: task.authority_envelope_sha256,
    receipt_contract_sha256: task.receipt_contract_sha256,
    verifier_contract_sha256: task.verifier_contract_sha256,
  }))));

  const observations = pairs.flatMap((pair, pairIndex) => (["reference", "candidate"] as const).map((arm, armIndex) => {
    const candidateIndex = COMPARISON_IDS.indexOf(pair.comparison_id);
    const harnessId = arm === "reference" ? REFERENCE_HARNESS : COMPARISON_HARNESSES[candidateIndex];
    const adapter = inventory.entries.find((entry) => entry.id === harnessId);
    if (!adapter) throw new Error(`production adapter missing for ${harnessId}`);
    return finalizeObservation({
      schema: HARNESS_PORTABILITY_OBSERVATION,
      comparison_id: pair.comparison_id,
      pair_id: pair.pair_id,
      arm,
      harness_id: harnessId,
      task_id: pair.task_id,
      seed: pair.seed,
      pair_sha256: pair.pair_sha256,
      model_id: "synthetic-only-v1",
      model_equivalence_class: "synthetic-only-v1",
      adapter_sha256: adapter.adapterSha256,
      input_sha256: pair.input_sha256,
      input_contract_sha256: pair.input_contract_sha256,
      output_contract_sha256: pair.output_contract_sha256,
      rubric_sha256: pair.rubric_sha256,
      authority_envelope_sha256: pair.authority_envelope_sha256,
      receipt_contract_sha256: pair.receipt_contract_sha256,
      verifier_contract_sha256: pair.verifier_contract_sha256,
      output_sha256: portabilitySha256({ pair: pair.pair_id, arm, harnessId, kind: "synthetic-output" }),
      receipt_sha256: portabilitySha256({ pair: pair.pair_id, arm, harnessId, kind: "synthetic-receipt" }),
      verifier_report_sha256: portabilitySha256({ pair: pair.pair_id, arm, harnessId, kind: "synthetic-verifier" }),
      generator_identity: `generator-${harnessId}-synthetic-v1`,
      verifier_identity: `verifier-${harnessId}-synthetic-v1`,
      generator_prompt_sha256: portabilitySha256({ pair: pair.pair_id, arm, role: "generator" }),
      verifier_prompt_sha256: portabilitySha256({ pair: pair.pair_id, arm, role: "verifier" }),
      generator_history_sha256: EMPTY_HISTORY_SHA256,
      verifier_history_sha256: EMPTY_HISTORY_SHA256,
      generator_root_sha256: portabilitySha256({ pair: pair.pair_id, arm, root: "generator" }),
      verifier_root_sha256: portabilitySha256({ pair: pair.pair_id, arm, root: "verifier" }),
      environment_secret_free: true,
      loopback_only_replay: true,
      capability_supported: true,
      receipt_valid: true,
      verifier_valid: true,
      contamination_detected: false,
      boundary_failure: false,
      token_count: 0,
      compute_seconds: 0,
      storage_bytes: 0,
      metrics: {
        contract_conformance: 1,
        verified_quality: 0.9,
        latency_ms: pairIndex + armIndex + 1,
        cost_usd: 0,
        failure_rate: 0,
        recovery_rate: 1,
        edge_proof_completeness: 1,
        contamination_rate: 0,
      },
    });
  }));

  const capabilityCells = observations.map((observation) => finalizeCapabilityCell({
    schema: HARNESS_PORTABILITY_CAPABILITY_CELL,
    comparison_id: observation.comparison_id,
    pair_id: observation.pair_id,
    arm: observation.arm,
    harness_id: observation.harness_id,
    capability_id: "frozen-task-contract",
    supported: true,
    contract_conformance: 1,
    denominator_included: true,
    adapter_or_task_rewritten: false,
  }));

  return {
    protocol,
    pairs,
    observations,
    capability_cells: capabilityCells,
    claim_eligible: false,
    required_disposition: "NONCONFORMANT",
    uses_live_models_or_harnesses: false,
  };
}
