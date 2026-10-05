import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import { buildSyntheticHarnessPortabilityQualification } from "./harness-portability-comparison-cohort.ts";
import {
  finalizeCapabilityCell,
  finalizeObservation,
  finalizeProtocol,
  type CapabilityConformanceCell,
  type HarnessPortabilityObservation,
} from "./harness-portability-comparison-contract.ts";
import { evaluateHarnessPortabilityComparison, runHarnessPortabilityComparisonCli } from "./harness-portability-comparison-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const inventory = buildPortableHarnessInventory();
const temporaryRoots: string[] = [];
const originalFlag = process.env.SF010_HARNESS_PORTABILITY_COMPARISON;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.SF010_HARNESS_PORTABILITY_COMPARISON;
  else process.env.SF010_HARNESS_PORTABILITY_COMPARISON = originalFlag;
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function phaseD() {
  const qualification = buildSyntheticHarnessPortabilityQualification(fixture);
  const { protocol_sha256: _ignored, ...protocolBody } = qualification.protocol;
  return {
    ...qualification,
    protocol: finalizeProtocol({ ...protocolBody, evidence_class: "phase_d_observation" }),
  };
}

function refinalizeObservation(observation: HarnessPortabilityObservation): HarnessPortabilityObservation {
  const { observation_sha256: _ignored, ...body } = observation;
  return finalizeObservation(body);
}

function refinalizeCell(cell: CapabilityConformanceCell): CapabilityConformanceCell {
  const { cell_sha256: _ignored, ...body } = cell;
  return finalizeCapabilityCell(body);
}

describe("harness portability comparison runner", () => {
  test("produces deterministic comparison-specific 95 percent intervals and a conformant Phase D result", () => {
    const qualification = phaseD();
    const first = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, qualification.observations, qualification.capability_cells, inventory);
    const second = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, qualification.observations, qualification.capability_cells, inventory);
    expect(first).toEqual(second);
    expect(first.disposition).toBe("CONFORMANT");
    expect(first.claim_eligible).toBe(true);
    expect(first.pair_records).toBe(90);
    expect(first.observation_slots).toBe(180);
    expect(first.comparisons.every((comparison) => comparison.complete_pairs === 30)).toBe(true);
    expect(first.comparisons.flatMap((comparison) => comparison.metrics).every((metric) => metric.interval.method === "paired-normal-95")).toBe(true);
    expect(first.production_routing_mutations).toBe(0);
  });

  test("retains unsupported capabilities in the denominator as nonconformant without rewriting", () => {
    const qualification = phaseD();
    const observations = [...qualification.observations];
    observations[1] = refinalizeObservation({
      ...observations[1],
      capability_supported: false,
      metrics: { ...observations[1].metrics, contract_conformance: 0 },
    });
    const cells = [...qualification.capability_cells];
    cells[1] = refinalizeCell({ ...cells[1], supported: false, contract_conformance: 0 });
    const summary = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, observations, cells, inventory);
    expect(summary.disposition).toBe("NONCONFORMANT");
    expect(summary.hold_reasons).toEqual([]);
    expect(summary.nonconformance_reasons.join("\n")).toContain("unsupported capability cells");
    expect(cells[1].denominator_included).toBe(true);
    expect(cells[1].adapter_or_task_rewritten).toBe(false);
  });

  test("records model confounding and forbids a harness-only claim", () => {
    const qualification = phaseD();
    const observations = [...qualification.observations];
    const candidateIndex = observations.findIndex((observation) => observation.arm === "candidate");
    observations[candidateIndex] = refinalizeObservation({ ...observations[candidateIndex], model_equivalence_class: "different-model-v1" });
    const summary = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, observations, qualification.capability_cells, inventory);
    expect(summary.disposition).toBe("NONCONFORMANT");
    expect(summary.comparisons.some((comparison) => comparison.model_confounded_pairs === 1)).toBe(true);
    expect(summary.claim_eligible).toBe(false);
  });

  test("fails closed on comparison-scoped reference reuse, proof gaps, contamination, and budget breach", () => {
    const qualification = phaseD();
    const observations = [...qualification.observations];
    const references = observations.map((observation, index) => ({ observation, index })).filter(({ observation }) => observation.arm === "reference");
    const first = references[0];
    const second = references.find(({ observation }) => observation.comparison_id !== first.observation.comparison_id)!;
    observations[second.index] = refinalizeObservation({ ...observations[second.index], receipt_sha256: first.observation.receipt_sha256 });
    observations[first.index] = refinalizeObservation({
      ...observations[first.index], receipt_valid: false, verifier_valid: false,
      contamination_detected: true, metrics: { ...observations[first.index].metrics, contamination_rate: 1, cost_usd: 153.01 },
    });
    const summary = evaluateHarnessPortabilityComparison(qualification.protocol, qualification.pairs, observations, qualification.capability_cells, inventory);
    expect(summary.disposition).toBe("HOLD");
    expect(summary.hold_reasons.join("\n")).toContain("comparison-scoped reference reuse");
    expect(summary.hold_reasons.join("\n")).toContain("receipt proof is invalid");
    expect(summary.hold_reasons.join("\n")).toContain("contamination detected");
    expect(summary.hold_reasons.join("\n")).toContain("cost budget exceeded");
  });

  test("CLI is read-free when disabled and writes one exclusive caller-selected output when enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1066-runner-"));
    temporaryRoots.push(root);
    delete process.env.SF010_HARNESS_PORTABILITY_COMPARISON;
    expect(runHarnessPortabilityComparisonCli(["--protocol", join(root, "absent.json")])).toBe(0);
    expect(existsSync(join(root, "summary.json"))).toBe(false);
    const qualification = phaseD();
    const paths = {
      protocol: join(root, "protocol.json"), pairs: join(root, "pairs.json"), observations: join(root, "observations.json"),
      cells: join(root, "cells.json"), output: join(root, "summary.json"),
    };
    writeFileSync(paths.protocol, JSON.stringify(qualification.protocol));
    writeFileSync(paths.pairs, JSON.stringify(qualification.pairs));
    writeFileSync(paths.observations, JSON.stringify(qualification.observations));
    writeFileSync(paths.cells, JSON.stringify(qualification.capability_cells));
    process.env.SF010_HARNESS_PORTABILITY_COMPARISON = "1";
    const args = ["--protocol", paths.protocol, "--pairs", paths.pairs, "--observations", paths.observations, "--capability-cells", paths.cells, "--output", paths.output];
    expect(runHarnessPortabilityComparisonCli(args)).toBe(0);
    expect(JSON.parse(readFileSync(paths.output, "utf8")).disposition).toBe("CONFORMANT");
    expect(() => runHarnessPortabilityComparisonCli(args)).toThrow();
  });
});
