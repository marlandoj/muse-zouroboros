import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticOutputTrajectoryQualification } from "./output-trajectory-comparison-cohort.ts";
import {
  finalizeObservation,
  finalizeProtocol,
  type OutputTrajectoryObservation,
  type OutputTrajectoryProtocol,
} from "./output-trajectory-comparison-contract.ts";
import { evaluateOutputTrajectoryComparison } from "./output-trajectory-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const RUNNER = join(import.meta.dir, "output-trajectory-comparison-runner.ts");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function phaseD(): { protocol: OutputTrajectoryProtocol; observations: OutputTrajectoryObservation[] } {
  const synthetic = buildSyntheticOutputTrajectoryQualification(FIXTURE);
  const protocol = finalizeProtocol({ ...synthetic.protocol, evidence_class: "phase_d_observation" });
  const observations = synthetic.observations.map((entry) => finalizeObservation({
    ...entry,
    protocol_sha256: protocol.protocol_sha256,
  }));
  return { protocol, observations };
}

describe("output trajectory comparison runner", () => {
  test("supports benefit only for complete eligible Phase D evidence", () => {
    const cohort = phaseD();
    const summary = evaluateOutputTrajectoryComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("TRAJECTORY_BENEFIT_SUPPORTED");
    expect(summary.complete_pairs).toBe(30);
    expect(summary.metrics.find((entry) => entry.metric === "false_acceptance_rate")!.interval.lower).toBeGreaterThan(0);
    expect(summary.metrics.find((entry) => entry.metric === "false_rejection_rate")!.interval.lower).toBeGreaterThanOrEqual(0);
    expect(summary.metrics.find((entry) => entry.metric === "reproduction_rate")!.trajectory_verifier_mean).toBeGreaterThanOrEqual(0.9);
  });

  test("publishes complete null or negative Phase D outcomes", () => {
    const cohort = phaseD();
    cohort.observations = cohort.observations.map((entry) => {
      const pair = cohort.protocol.pairs.find((candidate) => candidate.blind_ids[entry.arm] === entry.blind_id)!;
      return finalizeObservation({
        ...entry,
        verdict: pair.adjudicated_outcome === "acceptable" ? "ACCEPT" : "REJECT",
      });
    });
    const summary = evaluateOutputTrajectoryComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.reasons).toContain("one or more preregistered Phase D benefit gates did not pass");
  });

  test("synthetic qualification is structurally benefit-ineligible", () => {
    const cohort = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    const summary = evaluateOutputTrajectoryComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.reasons).toContain("synthetic qualification evidence is ineligible for a Phase D benefit claim");
  });

  test("holds incomplete pairs and verdicts without permitted evidence", () => {
    const incomplete = phaseD();
    expect(evaluateOutputTrajectoryComparison(incomplete.protocol, incomplete.observations.slice(0, 58)).disposition).toBe("HOLD");
    const missingEvidence = phaseD();
    missingEvidence.observations[0] = finalizeObservation({ ...missingEvidence.observations[0]!, citations: [] });
    const summary = evaluateOutputTrajectoryComparison(missingEvidence.protocol, missingEvidence.observations);
    expect(summary.disposition).toBe("HOLD");
    expect(summary.reasons.some((reason) => reason.includes("lacks permitted"))).toBe(true);
  });

  test("holds boundary, contamination, timeout, duplicates, and resource violations", () => {
    const mutations: Array<[keyof OutputTrajectoryObservation, boolean | number, string]> = [
      ["boundary_valid", false, "boundary validation failed"],
      ["contamination_detected", true, "contamination detected"],
      ["compute_seconds", 61, "per-run timeout exceeded"],
    ];
    for (const [field, value, reason] of mutations) {
      const cohort = phaseD();
      cohort.observations[0] = finalizeObservation({ ...cohort.observations[0]!, [field]: value });
      const summary = evaluateOutputTrajectoryComparison(cohort.protocol, cohort.observations);
      expect(summary.disposition).toBe("HOLD");
      expect(summary.reasons.some((entry) => entry.includes(reason))).toBe(true);
    }
    const duplicate = phaseD();
    expect(evaluateOutputTrajectoryComparison(duplicate.protocol, [...duplicate.observations, duplicate.observations[0]!]).disposition).toBe("HOLD");
    const overBudget = phaseD();
    overBudget.observations[0] = finalizeObservation({ ...overBudget.observations[0]!, token_count: 1 });
    expect(evaluateOutputTrajectoryComparison(overBudget.protocol, overBudget.observations).reasons).toContain("token budget exceeded");
  });

  test("disagreements retain blinded verdicts and evidence hashes for humans", () => {
    const cohort = phaseD();
    const summary = evaluateOutputTrajectoryComparison(cohort.protocol, cohort.observations);
    expect(summary.disagreements.length).toBeGreaterThan(0);
    expect(new Set(summary.disagreements.map((entry) => entry.case_class))).toEqual(new Set([
      "acceptable_alternative",
      "benchmark_gaming",
      "state_or_process_failure",
      "maintainability_failure",
      "recovery_failure",
    ]));
    expect(summary.disagreements.every((entry) => entry.queue_id.length === 64)).toBe(true);
    expect(summary.disagreements.every((entry) => entry.output_judge.blind_id.startsWith("blind-"))).toBe(true);
    expect(JSON.stringify(summary.disagreements)).not.toContain("adjudicated_outcome");
  });

  test("CLI is silent and read-free unless enabled, then writes one exclusive summary", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1063-cli-"));
    roots.push(root);
    const off = Bun.spawnSync(["bun", RUNNER, "--protocol", join(root, "missing.json"), "--observations", join(root, "also-missing.json")], {
      env: { ...process.env, SF009_OUTPUT_TRAJECTORY_COMPARISON: "0" },
    });
    expect(off.exitCode).toBe(0);
    expect(off.stdout.toString()).toBe("");
    expect(off.stderr.toString()).toBe("");
    const cohort = phaseD();
    const protocolPath = join(root, "protocol.json");
    const observationsPath = join(root, "observations.json");
    const outputPath = join(root, "summary.json");
    writeFileSync(protocolPath, JSON.stringify(cohort.protocol));
    writeFileSync(observationsPath, JSON.stringify(cohort.observations));
    const on = Bun.spawnSync(["bun", RUNNER, "--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath], {
      env: { ...process.env, SF009_OUTPUT_TRAJECTORY_COMPARISON: "1" },
    });
    expect(on.exitCode).toBe(0);
    expect(on.stdout.toString()).toBe("");
    expect(JSON.parse(readFileSync(outputPath, "utf8")).disposition).toBe("TRAJECTORY_BENEFIT_SUPPORTED");
    const repeated = Bun.spawnSync(["bun", RUNNER, "--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath], {
      env: { ...process.env, SF009_OUTPUT_TRAJECTORY_COMPARISON: "1" },
    });
    expect(repeated.exitCode).not.toBe(0);
  });
});
