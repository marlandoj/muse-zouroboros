import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import {
  COMPARISON_HARNESSES,
  CROSS_HARNESS_OBSERVATION,
  CROSS_HARNESS_PROTOCOL,
  EMPTY_HISTORY_SHA256,
  PRIMARY_METRICS,
  REFERENCE_HARNESS,
  conformanceSha256,
  finalizeObservation,
  finalizeProtocol,
  type RunObservation,
  type TaskContract,
} from "./cross-harness-conformance-contract.ts";
import { evaluateCrossHarnessConformance } from "./cross-harness-conformance-runner.ts";

interface SyntheticManifest {
  schemaVersion: 1;
  manifestId: string;
  classification: "synthetic_only";
  replicateSeeds: number[];
  contracts: Array<{ id: string; actorKind: string; interaction: string }>;
}

const inventory = buildPortableHarnessInventory();
const fixturePath = join(import.meta.dir, "..", "scenarios", "fixtures", "actor-system-cohort.json");
const manifest = JSON.parse(readFileSync(fixturePath, "utf8")) as SyntheticManifest;
const digest = (value: unknown) => conformanceSha256(value);

function taskContract(contract: SyntheticManifest["contracts"][number]): TaskContract {
  return {
    schema_version: 1,
    task_id: contract.id,
    task_class: `${contract.actorKind}-${contract.interaction}`,
    input_sha256: digest(contract),
    input_contract_sha256: digest({ schema: "actor-system-contract/v1", role: "input" }),
    output_contract_sha256: digest({ schema: "actor-system-contract/v1", role: "output" }),
    rubric_sha256: digest({ schema: "actor-system-rubric/v1", contract: contract.id }),
    authority_envelope_sha256: digest({ schema: "operator-authority/v1", manifest: manifest.manifestId }),
    receipt_contract_sha256: digest("zouroboros-run-receipt/v1"),
    verifier_contract_sha256: digest("trajectory-verifier/v1"),
  };
}

describe("cross-harness synthetic cohort", () => {
  test("binds the 20-contract, three-replicate cohort to four claimable and seven inventoried adapters", () => {
    expect(manifest.classification).toBe("synthetic_only");
    expect(manifest.contracts).toHaveLength(20);
    expect(manifest.replicateSeeds).toHaveLength(3);
    expect(inventory.entries.map((entry) => entry.id)).toEqual(["claude-code", "codex", "gemini", "hermes", "kimi", "opencode", "pi"]);
    const protocol = finalizeProtocol({
      schema: CROSS_HARNESS_PROTOCOL,
      protocol_id: "zou-1061-actor-system-synthetic-v1",
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
      task_contracts: manifest.contracts.map(taskContract),
    });
    const harnesses = [REFERENCE_HARNESS, ...COMPARISON_HARNESSES] as const;
    const observations: RunObservation[] = protocol.task_contracts.flatMap((task, taskIndex) => harnesses.flatMap((harnessId, harnessIndex) => {
      const adapter = inventory.entries.find((entry) => entry.id === harnessId)!;
      return manifest.replicateSeeds.map((seed, replicateIndex) => finalizeObservation({
        schema: CROSS_HARNESS_OBSERVATION,
        observation_id: `obs-${task.task_id}-${harnessId}-${replicateIndex + 1}`,
        task_id: task.task_id,
        seed,
        replicate: replicateIndex + 1,
        harness_id: harnessId,
        model_id: `synthetic-${harnessId}-v1`,
        adapter_sha256: adapter.adapterSha256,
        input_sha256: task.input_sha256,
        output_sha256: digest({ task: task.task_id, harnessId, seed, output: "structural" }),
        receipt_id: `receipt-${task.task_id}-${harnessId}-${replicateIndex + 1}`,
        receipt_sha256: digest({ task: task.task_id, harnessId, seed, receipt: true }),
        verifier_report_id: `report-${task.task_id}-${harnessId}-${replicateIndex + 1}`,
        verifier_report_sha256: digest({ task: task.task_id, harnessId, seed, report: true }),
        generator_identity: `generator-${harnessId}-v1`,
        verifier_identity: `verifier-${harnessId}-v1`,
        generator_prompt_sha256: digest({ harnessId, role: "generator" }),
        verifier_prompt_sha256: digest({ harnessId, role: "verifier" }),
        generator_history_sha256: EMPTY_HISTORY_SHA256,
        verifier_history_sha256: EMPTY_HISTORY_SHA256,
        generator_root_sha256: digest({ task: task.task_id, harnessId, seed, root: "generator" }),
        verifier_root_sha256: digest({ task: task.task_id, harnessId, seed, root: "verifier" }),
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
          verified_quality: 0.95 - harnessIndex * 0.01,
          latency_ms: 100 + taskIndex + harnessIndex,
          cost_usd: 0.01,
          failure_rate: 0,
          recovery_rate: 1,
          edge_proof_completeness: 1,
          contamination_rate: 0,
        },
      }));
    }));
    const summary = evaluateCrossHarnessConformance(protocol, observations, inventory);
    expect(summary.disposition).toBe("PASS");
    expect(summary.production_adapter_parity).toBe(1);
    expect(summary.comparisons.map((entry) => entry.candidate_harness)).toEqual([...COMPARISON_HARNESSES]);
    expect(summary.comparisons.some((entry) => entry.candidate_harness === ("cursor" as never))).toBe(false);
    expect(summary.comparisons.every((entry) => entry.paired_outcomes === 60)).toBe(true);
    expect(summary.comparisons.flatMap((entry) => entry.metrics).every((metric) => metric.interval.method === "paired-normal-95")).toBe(true);
  });
});
