import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticScenarioSourceQualification } from "./scenario-source-comparison-cohort.ts";
import {
  finalizeScenarioSourceObservation,
  finalizeScenarioSourceProtocol,
  type ScenarioSourceObservation,
  type ScenarioSourceProtocol,
} from "./scenario-source-comparison-contract.ts";
import { evaluateScenarioSourceComparison } from "./scenario-source-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const RUNNER = join(import.meta.dir, "scenario-source-comparison-runner.ts");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function phaseD(delta: number): { protocol: ScenarioSourceProtocol; observations: ScenarioSourceObservation[] } {
  const synthetic = buildSyntheticScenarioSourceQualification(FIXTURE);
  const pairs = synthetic.protocol.pairs.map((pair) => ({
    ...pair,
    receipt_derived_lineage: {
      ...pair.receipt_derived_lineage,
      reviewer_kind: "human" as const,
      review_evidence_kind: "human_admission" as const,
    },
  }));
  const protocol = finalizeScenarioSourceProtocol({ ...synthetic.protocol, evidence_class: "phase_d_observation", pairs });
  const observations = synthetic.observations.map((entry) => {
    const pair = pairs.find((candidate) => candidate.pair_id === entry.pair_id)!;
    const severity = entry.source_arm === "receipt_derived"
      ? synthetic.observations.find((candidate) => candidate.pair_id === entry.pair_id && candidate.source_arm === "manual")!.metrics.severity_weighted_defect_score + delta
      : entry.metrics.severity_weighted_defect_score;
    return finalizeScenarioSourceObservation({
      ...entry,
      protocol_sha256: protocol.protocol_sha256,
      receipt_derived_lineage: entry.source_arm === "receipt_derived" ? pair.receipt_derived_lineage : null,
      metrics: { ...entry.metrics, severity_weighted_defect_score: severity },
    });
  });
  return { protocol, observations };
}

describe("scenario source comparison runner", () => {
  test("supports benefit only for complete Phase D evidence with a positive primary interval", () => {
    const cohort = phaseD(1);
    const summary = evaluateScenarioSourceComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("BENEFIT_SUPPORTED");
    expect(summary.complete_pairs).toBe(30);
    expect(summary.metrics.find((entry) => entry.metric === "severity_weighted_defect_score")!.interval.lower).toBeGreaterThan(0);
  });

  test("publishes complete null or negative outcomes", () => {
    const cohort = phaseD(0);
    const summary = evaluateScenarioSourceComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.reasons).toContain("primary paired 95% interval does not establish positive benefit");
  });

  test("publishes futility after 20 complete pairs when the primary upper bound is nonpositive", () => {
    const cohort = phaseD(-1);
    const summary = evaluateScenarioSourceComparison(cohort.protocol, cohort.observations.slice(0, 40));
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.complete_pairs).toBe(20);
    expect(summary.reasons).toContain("futility boundary reached at 20 complete pairs");
  });

  test("holds incomplete promising evidence and safety failures", () => {
    const promising = phaseD(1);
    expect(evaluateScenarioSourceComparison(promising.protocol, promising.observations.slice(0, 40)).disposition).toBe("HOLD");
    const unsafe = phaseD(1);
    unsafe.observations[0] = finalizeScenarioSourceObservation({
      ...unsafe.observations[0]!,
      contamination_detected: true,
      metrics: { ...unsafe.observations[0]!.metrics, contamination_rate: 0.1 },
    });
    const summary = evaluateScenarioSourceComparison(unsafe.protocol, unsafe.observations);
    expect(summary.disposition).toBe("HOLD");
    expect(summary.reasons.some((reason) => reason.includes("contamination detected"))).toBe(true);
  });

  test("holds every preregistered authority, proof, drift, exposure, and timeout failure", () => {
    const failures: Array<[keyof ScenarioSourceObservation, boolean | number, string]> = [
      ["authority_valid", false, "authority envelope invalid"],
      ["task_mix_matches", false, "task mix drift"],
      ["verifier_contract_matches", false, "verifier contract drift"],
      ["receipt_valid", false, "receipt invalid"],
      ["verifier_valid", false, "verifier evidence invalid"],
      ["environment_secret_free", false, "secret boundary failed"],
      ["answer_exposure_detected", true, "answer exposure detected"],
      ["compute_seconds", 61, "per-run timeout exceeded"],
    ];
    for (const [field, value, reason] of failures) {
      const cohort = phaseD(1);
      cohort.observations[0] = finalizeScenarioSourceObservation({ ...cohort.observations[0]!, [field]: value });
      const summary = evaluateScenarioSourceComparison(cohort.protocol, cohort.observations);
      expect(summary.disposition).toBe("HOLD");
      expect(summary.reasons.some((entry) => entry.includes(reason))).toBe(true);
    }
    const lineage = phaseD(1);
    const derivedIndex = lineage.observations.findIndex((entry) => entry.source_arm === "receipt_derived");
    lineage.observations[derivedIndex] = finalizeScenarioSourceObservation({
      ...lineage.observations[derivedIndex]!,
      receipt_derived_lineage: {
        ...lineage.observations[derivedIndex]!.receipt_derived_lineage!,
        candidate_sha256: "f".repeat(64),
      },
    });
    expect(evaluateScenarioSourceComparison(lineage.protocol, lineage.observations).disposition).toBe("HOLD");
  });

  test("holds duplicates, contract drift, and resource budget violations", () => {
    const duplicate = phaseD(1);
    expect(evaluateScenarioSourceComparison(duplicate.protocol, [...duplicate.observations, duplicate.observations[0]!]).disposition).toBe("HOLD");
    const overBudget = phaseD(1);
    overBudget.observations[0] = finalizeScenarioSourceObservation({ ...overBudget.observations[0]!, token_count: 1 });
    expect(evaluateScenarioSourceComparison(overBudget.protocol, overBudget.observations).reasons).toContain("token budget exceeded");
    const drift = phaseD(1);
    drift.observations[0] = { ...drift.observations[0]!, task_class: "drift" };
    expect(evaluateScenarioSourceComparison(drift.protocol, drift.observations).disposition).toBe("HOLD");
  });

  test("CLI is silent and read-free unless exactly enabled, then writes one exclusive summary", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1062-cli-"));
    roots.push(root);
    const off = Bun.spawnSync(["bun", RUNNER, "--protocol", join(root, "missing.json"), "--observations", join(root, "also-missing.json")], {
      env: { ...process.env, ZOUROBOROS_SCENARIO_SOURCE_COMPARISON: "0" },
    });
    expect(off.exitCode).toBe(0);
    expect(off.stdout.toString()).toBe("");
    expect(off.stderr.toString()).toBe("");
    const cohort = phaseD(0);
    const protocolPath = join(root, "protocol.json");
    const observationsPath = join(root, "observations.json");
    const outputPath = join(root, "summary.json");
    writeFileSync(protocolPath, JSON.stringify(cohort.protocol));
    writeFileSync(observationsPath, JSON.stringify(cohort.observations));
    const on = Bun.spawnSync(["bun", RUNNER, "--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath], {
      env: { ...process.env, ZOUROBOROS_SCENARIO_SOURCE_COMPARISON: "1" },
    });
    expect(on.exitCode).toBe(0);
    expect(on.stdout.toString()).toBe("");
    expect(JSON.parse(readFileSync(outputPath, "utf8")).disposition).toBe("NULL_OR_NEGATIVE");
    const repeated = Bun.spawnSync(["bun", RUNNER, "--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath], {
      env: { ...process.env, ZOUROBOROS_SCENARIO_SOURCE_COMPARISON: "1" },
    });
    expect(repeated.exitCode).not.toBe(0);
  });
});
