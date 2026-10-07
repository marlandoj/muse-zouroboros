import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPortableHarnessInventory } from "../../../packages/zo-swarm-orchestrator/src/executor/portability.ts";
import { buildSyntheticHarnessPortabilityQualification } from "./harness-portability-comparison-cohort.ts";
import { evaluateHarnessPortabilityComparison } from "./harness-portability-comparison-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("harness portability synthetic qualification cohort", () => {
  test("selects the first ten sorted contracts across three seeds and three comparison-scoped pairs", () => {
    const manifest = JSON.parse(readFileSync(fixture, "utf8")) as { contracts: Array<{ id: string }> };
    const expectedTasks = manifest.contracts.map((contract) => contract.id).sort().slice(0, 10);
    const qualification = buildSyntheticHarnessPortabilityQualification(fixture);
    expect(qualification.protocol.task_contracts.map((task) => task.task_id)).toEqual(expectedTasks);
    expect(qualification.protocol.replicate_seeds).toEqual([1057001, 1057002, 1057003]);
    expect(qualification.pairs).toHaveLength(90);
    expect(qualification.observations).toHaveLength(180);
    expect(qualification.capability_cells).toHaveLength(180);
    expect(new Set(qualification.pairs.map((pair) => pair.pair_id)).size).toBe(90);
    expect(qualification.protocol.comparisons.every((comparison) => qualification.pairs.filter((pair) => pair.comparison_id === comparison.comparison_id).length === 30)).toBe(true);
  });

  test("binds all seven production adapters while keeping the frozen out-of-cohort label for Cursor", () => {
    const inventory = buildPortableHarnessInventory();
    const qualification = buildSyntheticHarnessPortabilityQualification(fixture);
    expect(inventory.entries.map((entry) => entry.id)).toEqual(["claude-code", "codex", "gemini", "hermes", "kimi", "opencode", "pi"]);
    expect(qualification.observations.some((observation) => observation.harness_id === ("cursor" as never))).toBe(false);
    expect(qualification.observations.every((observation) => inventory.entries.some((entry) => entry.id === observation.harness_id && entry.adapterSha256 === observation.adapter_sha256))).toBe(true);
  });

  test("is deterministic, redacted, comparison-scoped, advisory, and structurally nonconformant", () => {
    const first = buildSyntheticHarnessPortabilityQualification(fixture);
    const second = buildSyntheticHarnessPortabilityQualification(fixture);
    expect(first).toEqual(second);
    const references = first.observations.filter((observation) => observation.arm === "reference");
    expect(new Set(references.map((observation) => observation.observation_sha256)).size).toBe(90);
    expect(new Set(references.map((observation) => observation.receipt_sha256)).size).toBe(90);
    const serialized = JSON.stringify(first);
    for (const forbidden of ["raw_task_input", "raw_output", "raw_receipt", "raw_verifier_report", "holdout_plaintext", "hidden_answer", "golden_patch", "fixture_path", "credential", "secret"]) {
      expect(serialized.includes(`\"${forbidden}\"`)).toBe(false);
    }
    const summary = evaluateHarnessPortabilityComparison(first.protocol, first.pairs, first.observations, first.capability_cells);
    expect(first.claim_eligible).toBe(false);
    expect(first.uses_live_models_or_harnesses).toBe(false);
    expect(summary.disposition).toBe("NONCONFORMANT");
    expect(summary.claim_eligible).toBe(false);
    expect(summary.production_routing_mutations).toBe(0);
  });
});
