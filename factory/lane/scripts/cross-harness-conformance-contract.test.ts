import { describe, expect, test } from "bun:test";
import { buildPortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import {
  COMPARISON_HARNESSES,
  CROSS_HARNESS_OBSERVATION,
  CROSS_HARNESS_PROTOCOL,
  EMPTY_HISTORY_SHA256,
  PRIMARY_METRICS,
  REFERENCE_HARNESS,
  computeObservationHash,
  finalizeObservation,
  finalizeProtocol,
  parseConformanceProtocol,
  parseRunObservation,
  type ConformanceProtocol,
  type RunObservation,
  type TaskContract,
  conformanceSha256,
} from "./cross-harness-conformance-contract.ts";

const inventory = buildPortableHarnessInventory();
const digest = (value: unknown) => conformanceSha256(value);

function task(index: number): TaskContract {
  const taskId = `task-${String(index).padStart(2, "0")}`;
  return {
    schema_version: 1,
    task_id: taskId,
    task_class: "synthetic-contract",
    input_sha256: digest({ taskId, kind: "input" }),
    input_contract_sha256: digest({ taskId, kind: "input-contract" }),
    output_contract_sha256: digest({ taskId, kind: "output-contract" }),
    rubric_sha256: digest({ taskId, kind: "rubric" }),
    authority_envelope_sha256: digest({ taskId, kind: "authority" }),
    receipt_contract_sha256: digest("zouroboros-run-receipt/v1"),
    verifier_contract_sha256: digest("trajectory-verifier/v1"),
  };
}

function protocol(): ConformanceProtocol {
  return finalizeProtocol({
    schema: CROSS_HARNESS_PROTOCOL,
    protocol_id: "zou-1061-synthetic-v1",
    adapter_inventory_sha256: inventory.inventorySha256,
    canonical_empty_history_sha256: EMPTY_HISTORY_SHA256,
    reference_harness: REFERENCE_HARNESS,
    comparison_harnesses: [...COMPARISON_HARNESSES],
    out_of_cohort_harnesses: ["cursor"],
    minimum_untouched_holdout_items: 20,
    minimum_seeded_replicates_per_scenario: 3,
    minimum_paired_outcomes_per_comparison: 30,
    confidence_level: 0.95,
    primary_metrics: [...PRIMARY_METRICS],
    contamination_detections_allowed: 0,
    production_adapter_parity_required: 1,
    advisory_only: true,
    live_model_runs: 0,
    budget: {
      maximum_runs: 500,
      maximum_cost_usd: 425,
      maximum_tokens: 55_000_000,
      maximum_compute_hours: 110,
      maximum_storage_gib: 7,
      per_run_timeout_minutes: 30,
    },
    task_contracts: Array.from({ length: 20 }, (_, index) => task(index + 1)),
  });
}

function observation(source = protocol()): RunObservation {
  const harnessId = REFERENCE_HARNESS;
  const adapter = inventory.entries.find((entry) => entry.id === harnessId)!;
  const taskContract = source.task_contracts[0];
  return finalizeObservation({
    schema: CROSS_HARNESS_OBSERVATION,
    observation_id: "obs-task-01-claude-code-1",
    task_id: taskContract.task_id,
    seed: 1061001,
    replicate: 1,
    harness_id: harnessId,
    model_id: "deterministic-stub-v1",
    adapter_sha256: adapter.adapterSha256,
    input_sha256: taskContract.input_sha256,
    output_sha256: digest({ task: taskContract.task_id, harnessId }),
    receipt_id: "receipt-task-01-claude-code-1",
    receipt_sha256: digest({ task: taskContract.task_id, kind: "receipt" }),
    verifier_report_id: "report-task-01-claude-code-1",
    verifier_report_sha256: digest({ task: taskContract.task_id, kind: "report" }),
    generator_identity: "generator-stub-v1",
    verifier_identity: "verifier-stub-v1",
    generator_prompt_sha256: digest("generator-prompt"),
    verifier_prompt_sha256: digest("verifier-prompt"),
    generator_history_sha256: EMPTY_HISTORY_SHA256,
    verifier_history_sha256: EMPTY_HISTORY_SHA256,
    generator_root_sha256: digest("generator-root"),
    verifier_root_sha256: digest("verifier-root"),
    environment_secret_free: true,
    loopback_only_replay: true,
    capability_supported: true,
    receipt_valid: true,
    verifier_valid: true,
    contamination_detected: false,
    token_count: 100,
    compute_seconds: 1,
    storage_bytes: 1024,
    metrics: {
      contract_conformance: 1,
      verified_quality: 0.95,
      latency_ms: 100,
      cost_usd: 0.01,
      failure_rate: 0,
      recovery_rate: 1,
      edge_proof_completeness: 1,
      contamination_rate: 0,
    },
  });
}

describe("cross-harness conformance contract", () => {
  test("accepts the frozen hash-only protocol and production-bound observation", () => {
    const parsedProtocol = parseConformanceProtocol(protocol(), inventory);
    const parsedObservation = parseRunObservation(observation(parsedProtocol), parsedProtocol, inventory);
    expect(parsedProtocol.task_contracts).toHaveLength(20);
    expect(parsedObservation.harness_id).toBe("claude-code");
    expect(parsedObservation.observation_sha256).toBe(computeObservationHash(parsedObservation));
  });

  test("rejects unknown fields and protocol hash drift", () => {
    expect(() => parseConformanceProtocol({ ...protocol(), extra: true }, inventory)).toThrow("unknown fields");
    expect(() => parseConformanceProtocol({ ...protocol(), protocol_sha256: "f".repeat(64) }, inventory)).toThrow("protocol hash drift");
  });

  test("rejects held-out plaintext, secrets, and widened budgets", () => {
    expect(() => parseConformanceProtocol({ ...protocol(), holdout_plaintext: "answer" }, inventory)).toThrow("forbidden field");
    const widened = protocol();
    widened.budget.maximum_runs = 501;
    widened.protocol_sha256 = "0".repeat(64);
    expect(() => parseConformanceProtocol(widened, inventory)).toThrow("approved Phase D ceiling");
    const secret = observation();
    secret.model_id = "sk-secretvalue123456";
    secret.observation_sha256 = computeObservationHash(secret);
    expect(() => parseRunObservation(secret, protocol(), inventory)).toThrow("secret-shaped");
  });

  test("rejects adapter, input, proof-boundary, and observation hash drift", () => {
    const source = protocol();
    const adapterDrift = observation(source);
    adapterDrift.adapter_sha256 = "a".repeat(64);
    adapterDrift.observation_sha256 = computeObservationHash(adapterDrift);
    expect(() => parseRunObservation(adapterDrift, source, inventory)).toThrow("adapter hash drift");

    const inputDrift = observation(source);
    inputDrift.input_sha256 = "b".repeat(64);
    inputDrift.observation_sha256 = computeObservationHash(inputDrift);
    expect(() => parseRunObservation(inputDrift, source, inventory)).toThrow("input hash drift");

    const sameIdentity = observation(source);
    sameIdentity.verifier_identity = sameIdentity.generator_identity;
    sameIdentity.observation_sha256 = computeObservationHash(sameIdentity);
    expect(() => parseRunObservation(sameIdentity, source, inventory)).toThrow("identities must be distinct");

    expect(() => parseRunObservation({ ...observation(source), observation_sha256: "c".repeat(64) }, source, inventory)).toThrow("observation hash drift");
  });
});
