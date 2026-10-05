import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSyntheticScenarioSourceQualification } from "./scenario-source-comparison-cohort.ts";
import {
  computeObservationHash,
  computeProtocolHash,
  finalizeScenarioSourceObservation,
  finalizeScenarioSourceProtocol,
  parseScenarioSourceObservation,
  parseScenarioSourceProtocol,
  parseScenarioSourceSummary,
} from "./scenario-source-comparison-contract.ts";
import { evaluateScenarioSourceComparison } from "./scenario-source-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("scenario source comparison contract", () => {
  test("accepts the canonical 30-pair protocol and 60 observations", () => {
    const cohort = buildSyntheticScenarioSourceQualification(FIXTURE);
    expect(parseScenarioSourceProtocol(cohort.protocol)).toEqual(cohort.protocol);
    expect(cohort.observations.map((entry) => parseScenarioSourceObservation(entry, cohort.protocol))).toEqual(cohort.observations);
    expect(computeProtocolHash(cohort.protocol)).toBe(cohort.protocol.protocol_sha256);
    expect(cohort.observations.every((entry) => computeObservationHash(entry) === entry.observation_sha256)).toBe(true);
  });

  test("rejects unknown fields and protocol hash drift", () => {
    const { protocol } = buildSyntheticScenarioSourceQualification(FIXTURE);
    expect(() => parseScenarioSourceProtocol({ ...protocol, extra: true })).toThrow("unknown fields");
    expect(() => parseScenarioSourceProtocol({ ...protocol, cohort_id: "drift" })).toThrow("protocol hash mismatch");
  });

  test("requires review evidence to match the declared evidence class", () => {
    const { protocol } = buildSyntheticScenarioSourceQualification(FIXTURE);
    const pairs = protocol.pairs.map((pair) => ({
      ...pair,
      receipt_derived_lineage: { ...pair.receipt_derived_lineage, review_evidence_kind: "human_admission" as const },
    }));
    expect(() => parseScenarioSourceProtocol(finalizeScenarioSourceProtocol({ ...protocol, pairs }))).toThrow("review evidence");
  });

  test("strictly validates canonical summaries, metric uniqueness, and summary hashes", () => {
    const cohort = buildSyntheticScenarioSourceQualification(FIXTURE);
    const summary = evaluateScenarioSourceComparison(cohort.protocol, cohort.observations);
    expect(parseScenarioSourceSummary(summary)).toEqual(summary);
    expect(() => parseScenarioSourceSummary({ ...summary, extra: true })).toThrow("unknown fields");
    expect(() => parseScenarioSourceSummary({ ...summary, complete_pairs: 29 })).toThrow("summary hash mismatch");
    const metrics = [...summary.metrics];
    metrics[1] = metrics[0]!;
    expect(() => parseScenarioSourceSummary({ ...summary, metrics })).toThrow("frozen metric order");
  });

  test("rejects budgets above the frozen issue and Phase D ceilings", () => {
    const { protocol } = buildSyntheticScenarioSourceQualification(FIXTURE);
    expect(() => parseScenarioSourceProtocol(finalizeScenarioSourceProtocol({
      ...protocol,
      budget: { ...protocol.budget, maximum_cost_usd: 426 },
    }))).toThrow("Phase D ceiling");
    expect(() => parseScenarioSourceProtocol(finalizeScenarioSourceProtocol({
      ...protocol,
      budget: { ...protocol.budget, per_run_timeout_minutes: 31 },
    }))).toThrow("Phase D ceiling");
  });

  test("forbids lineage on manual observations and requires it on derived observations", () => {
    const { protocol, observations } = buildSyntheticScenarioSourceQualification(FIXTURE);
    const manual = observations.find((entry) => entry.source_arm === "manual")!;
    const derived = observations.find((entry) => entry.source_arm === "receipt_derived")!;
    expect(() => parseScenarioSourceObservation(finalizeScenarioSourceObservation({
      ...manual,
      receipt_derived_lineage: protocol.pairs[0]!.receipt_derived_lineage,
    }), protocol)).toThrow("must not carry");
    expect(() => parseScenarioSourceObservation(finalizeScenarioSourceObservation({
      ...derived,
      receipt_derived_lineage: null,
    }), protocol)).toThrow("lineage mismatch");
  });

  test("rejects secret-shaped values, forbidden answers, and invalid metric bounds", () => {
    const { protocol, observations } = buildSyntheticScenarioSourceQualification(FIXTURE);
    expect(() => parseScenarioSourceProtocol({ ...protocol, cohort_id: "sk-secretvalue123456" })).toThrow("secret-shaped");
    expect(() => parseScenarioSourceProtocol({ ...protocol, answer: "hidden" })).toThrow("forbidden field");
    const observation = observations[0]!;
    expect(() => parseScenarioSourceObservation(finalizeScenarioSourceObservation({
      ...observation,
      metrics: { ...observation.metrics, reproducibility_rate: 1.1 },
    }), protocol)).toThrow("must be <= 1");
  });
});
