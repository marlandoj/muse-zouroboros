import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  type ConformanceProtocol,
  type RunObservation,
  type TaskContract,
} from "./cross-harness-conformance-contract.ts";
import { evaluateCrossHarnessConformance, runCrossHarnessConformanceCli } from "./cross-harness-conformance-runner.ts";

const inventory = buildPortableHarnessInventory();
const temporaryRoots: string[] = [];
const originalFlag = process.env.ZOUROBOROS_CROSS_HARNESS_CONFORMANCE;
const digest = (value: unknown) => conformanceSha256(value);

afterEach(() => {
  if (originalFlag === undefined) delete process.env.ZOUROBOROS_CROSS_HARNESS_CONFORMANCE;
  else process.env.ZOUROBOROS_CROSS_HARNESS_CONFORMANCE = originalFlag;
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

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

function observations(source = protocol()): RunObservation[] {
  const harnesses = [REFERENCE_HARNESS, ...COMPARISON_HARNESSES] as const;
  return source.task_contracts.flatMap((taskContract, taskIndex) => harnesses.flatMap((harnessId, harnessIndex) => {
    const adapter = inventory.entries.find((entry) => entry.id === harnessId)!;
    return [1, 2, 3].map((replicate) => finalizeObservation({
      schema: CROSS_HARNESS_OBSERVATION,
      observation_id: `obs-${taskContract.task_id}-${harnessId}-${replicate}`,
      task_id: taskContract.task_id,
      seed: 1_061_000 + taskIndex * 10 + replicate,
      replicate,
      harness_id: harnessId,
      model_id: `deterministic-${harnessId}-v1`,
      adapter_sha256: adapter.adapterSha256,
      input_sha256: taskContract.input_sha256,
      output_sha256: digest({ task: taskContract.task_id, harnessId, replicate }),
      receipt_id: `receipt-${taskContract.task_id}-${harnessId}-${replicate}`,
      receipt_sha256: digest({ task: taskContract.task_id, harnessId, replicate, kind: "receipt" }),
      verifier_report_id: `report-${taskContract.task_id}-${harnessId}-${replicate}`,
      verifier_report_sha256: digest({ task: taskContract.task_id, harnessId, replicate, kind: "report" }),
      generator_identity: `generator-${harnessId}-v1`,
      verifier_identity: `verifier-${harnessId}-v1`,
      generator_prompt_sha256: digest({ harnessId, role: "generator" }),
      verifier_prompt_sha256: digest({ harnessId, role: "verifier" }),
      generator_history_sha256: EMPTY_HISTORY_SHA256,
      verifier_history_sha256: EMPTY_HISTORY_SHA256,
      generator_root_sha256: digest({ task: taskContract.task_id, harnessId, replicate, root: "generator" }),
      verifier_root_sha256: digest({ task: taskContract.task_id, harnessId, replicate, root: "verifier" }),
      environment_secret_free: true,
      loopback_only_replay: true,
      capability_supported: true,
      receipt_valid: true,
      verifier_valid: true,
      contamination_detected: false,
      token_count: 100 + harnessIndex,
      compute_seconds: 1,
      storage_bytes: 1024,
      metrics: {
        contract_conformance: 1,
        verified_quality: 0.95 - harnessIndex * 0.01,
        latency_ms: 100 + harnessIndex * 10 + replicate,
        cost_usd: 0.01 + harnessIndex * 0.001,
        failure_rate: 0,
        recovery_rate: 1,
        edge_proof_completeness: 1,
        contamination_rate: 0,
      },
    }));
  }));
}

function refinalize(observation: RunObservation): RunObservation {
  const { observation_sha256: _ignored, ...body } = observation;
  return finalizeObservation(body);
}

describe("cross-harness conformance runner", () => {
  test("produces deterministic PASS evidence with intervals for every primary metric", () => {
    const source = protocol();
    const first = evaluateCrossHarnessConformance(source, observations(source), inventory);
    const second = evaluateCrossHarnessConformance(source, observations(source), inventory);
    expect(first).toEqual(second);
    expect(first.disposition).toBe("PASS");
    expect(first.production_adapter_parity).toBe(1);
    expect(first.observations).toBe(240);
    expect(first.seeded_replicates_per_scenario).toBe(3);
    expect(first.comparisons).toHaveLength(3);
    expect(first.comparisons.every((entry) => entry.paired_outcomes === 60)).toBe(true);
    expect(first.comparisons.every((entry) => entry.metrics.length === PRIMARY_METRICS.length)).toBe(true);
    expect(first.comparisons.flatMap((entry) => entry.metrics).every((entry) => entry.interval.confidence_level === 0.95)).toBe(true);
    expect(first.policy_mutations).toEqual([]);
  });

  test("returns HOLD for contamination, unsupported cells, invalid proofs, or boundary failure", () => {
    const source = protocol();
    const entries = observations(source);
    entries[0].contamination_detected = true;
    entries[0].metrics.contamination_rate = 1;
    entries[0] = refinalize(entries[0]);
    entries[1].capability_supported = false;
    entries[1] = refinalize(entries[1]);
    entries[2].receipt_valid = false;
    entries[2].verifier_valid = false;
    entries[2].environment_secret_free = false;
    entries[2].loopback_only_replay = false;
    entries[2] = refinalize(entries[2]);
    entries[3].compute_seconds = 1_801;
    entries[3] = refinalize(entries[3]);
    const summary = evaluateCrossHarnessConformance(source, entries, inventory);
    expect(summary.disposition).toBe("HOLD");
    expect(summary.hold_reasons.join("\n")).toContain("contamination detected");
    expect(summary.hold_reasons.join("\n")).toContain("unsupported capability");
    expect(summary.hold_reasons.join("\n")).toContain("invalid receipt proof");
    expect(summary.hold_reasons.join("\n")).toContain("loopback boundary");
    expect(summary.hold_reasons.join("\n")).toContain("per-run timeout budget exceeded");
  });

  test("returns HOLD for adapter drift, insufficient samples, and budget breach", () => {
    const source = protocol();
    const entries = observations(source);
    entries[0].adapter_sha256 = "f".repeat(64);
    entries[0] = refinalize(entries[0]);
    entries[1].metrics.cost_usd = 425;
    entries[1] = refinalize(entries[1]);
    const sparse = entries.filter((entry) => source.task_contracts.slice(0, 5).some((taskContract) => taskContract.task_id === entry.task_id));
    const summary = evaluateCrossHarnessConformance(source, sparse, inventory);
    expect(summary.disposition).toBe("HOLD");
    expect(summary.hold_reasons.join("\n")).toContain("adapter hash drift");
    expect(summary.hold_reasons.join("\n")).toContain("paired outcomes");
    expect(summary.hold_reasons.join("\n")).toContain("cost budget exceeded");
  });

  test("CLI is silent and side-effect free by default, then writes only caller-selected evidence when enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1061-runner-"));
    temporaryRoots.push(root);
    const source = protocol();
    const protocolPath = join(root, "protocol.json");
    const observationsPath = join(root, "observations.json");
    const outputPath = join(root, "summary.json");
    writeFileSync(protocolPath, JSON.stringify(source));
    writeFileSync(observationsPath, JSON.stringify(observations(source)));
    delete process.env.ZOUROBOROS_CROSS_HARNESS_CONFORMANCE;
    expect(runCrossHarnessConformanceCli(["--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath])).toBe(0);
    expect(existsSync(outputPath)).toBe(false);
    process.env.ZOUROBOROS_CROSS_HARNESS_CONFORMANCE = "1";
    expect(runCrossHarnessConformanceCli(["--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath])).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).disposition).toBe("PASS");
  });
});
