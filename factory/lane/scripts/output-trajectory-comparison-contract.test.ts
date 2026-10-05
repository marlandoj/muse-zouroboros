import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSyntheticOutputTrajectoryQualification } from "./output-trajectory-comparison-cohort.ts";
import { checkExpectations } from "./scenario-run.ts";
import { parseTrajectoryVerifierReport } from "./trajectory-verifier-contract.ts";
import {
  INCUMBENT_OUTPUT_JUDGE,
  INCUMBENT_TRAJECTORY_REPORT_PARSER,
  computeObservationHash,
  computeProtocolHash,
  computeSummaryHash,
  finalizeObservation,
  finalizeProtocol,
  hasPermittedEvidence,
  parseObservation,
  parseProtocol,
  parseSummary,
} from "./output-trajectory-comparison-contract.ts";
import { evaluateOutputTrajectoryComparison } from "./output-trajectory-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("output trajectory comparison contract", () => {
  test("binds the incumbent output grader and trajectory report parser", () => {
    expect(INCUMBENT_OUTPUT_JUDGE).toBe(checkExpectations);
    expect(INCUMBENT_TRAJECTORY_REPORT_PARSER).toBe(parseTrajectoryVerifierReport);
  });

  test("accepts the canonical 30-pair protocol and 60 blinded observations", () => {
    const cohort = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    expect(parseProtocol(cohort.protocol)).toEqual(cohort.protocol);
    expect(cohort.observations.map((entry) => parseObservation(entry, cohort.protocol))).toEqual(cohort.observations);
    expect(computeProtocolHash(cohort.protocol)).toBe(cohort.protocol.protocol_sha256);
    expect(cohort.observations.every((entry) => computeObservationHash(entry) === entry.observation_sha256)).toBe(true);
  });

  test("rejects unknown fields and canonical hash drift", () => {
    const { protocol } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    expect(() => parseProtocol({ ...protocol, extra: true })).toThrow("unknown fields");
    expect(() => parseProtocol({ ...protocol, cohort_id: "drift" })).toThrow("protocol hash mismatch");
  });

  test("requires unique opaque blind ids and six pairs per case class", () => {
    const { protocol } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    const duplicatePairs = structuredClone(protocol.pairs);
    duplicatePairs[1]!.blind_ids.output_judge = duplicatePairs[0]!.blind_ids.output_judge;
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, pairs: duplicatePairs }))).toThrow("duplicate blind ids");
    const imbalancedPairs = structuredClone(protocol.pairs);
    imbalancedPairs.find((pair) => pair.case_class === "acceptable_alternative")!.case_class = "benchmark_gaming";
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, pairs: imbalancedPairs }))).toThrow("at least six acceptable_alternative");
  });

  test("freezes identical task, authority, and rubric hashes across both arms", () => {
    const { protocol, observations } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    const drifted = finalizeObservation({ ...observations[0]!, rubric_sha256: "f".repeat(64) });
    expect(() => parseObservation(drifted, protocol)).toThrow("task, authority, or rubric identity drift");
    const wrongBlind = finalizeObservation({ ...observations[0]!, blind_id: protocol.pairs[1]!.blind_ids.output_judge });
    expect(() => parseObservation(wrongBlind, protocol)).toThrow("identity drift");
  });

  test("enforces arm-specific evidence allowlists", () => {
    const { protocol, observations } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    const output = observations.find((entry) => entry.arm === "output_judge")!;
    const trajectory = observations.find((entry) => entry.arm === "trajectory_verifier")!;
    expect(hasPermittedEvidence(output)).toBe(true);
    expect(hasPermittedEvidence(trajectory)).toBe(true);
    const outputWithTrajectoryEvidence = finalizeObservation({ ...output, citations: trajectory.citations });
    expect(hasPermittedEvidence(parseObservation(outputWithTrajectoryEvidence, protocol))).toBe(false);
    const incompleteTrajectory = finalizeObservation({ ...trajectory, citations: trajectory.citations.slice(0, 3) });
    expect(hasPermittedEvidence(parseObservation(incompleteTrajectory, protocol))).toBe(false);
  });

  test("rejects secrets, forbidden fields, duplicate citations, and invalid ratios", () => {
    const { protocol, observations } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    expect(() => parseProtocol({ ...protocol, ground_truth_label: "defective" })).toThrow("forbidden field");
    expect(() => parseProtocol({ ...protocol, cohort_id: "sk-secretvalue123456" })).toThrow("secret-shaped");
    const observation = observations[0]!;
    expect(() => parseObservation({ ...observation, raw_prompt: "hidden" }, protocol)).toThrow("forbidden field");
    expect(() => parseObservation(finalizeObservation({ ...observation, citations: [observation.citations[0]!, observation.citations[0]!] }), protocol)).toThrow("duplicate citation kinds");
    expect(() => parseObservation(finalizeObservation({ ...observation, reproduction_rate: 1.1 }), protocol)).toThrow("must be <= 1");
  });

  test("rejects budgets above issue and Phase D ceilings", () => {
    const { protocol } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, budget: { ...protocol.budget, maximum_cost_usd: 426 } }))).toThrow("Phase D ceiling");
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, budget: { ...protocol.budget, per_run_timeout_minutes: 31 } }))).toThrow("Phase D ceiling");
  });

  test("strictly validates summaries and disagreement hashes", () => {
    const cohort = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    const summary = evaluateOutputTrajectoryComparison(cohort.protocol, cohort.observations);
    expect(parseSummary(summary)).toEqual(summary);
    expect(() => parseSummary({ ...summary, extra: true })).toThrow("unknown fields");
    expect(() => parseSummary({ ...summary, complete_pairs: 29 })).toThrow("summary hash mismatch");
    const disagreements = structuredClone(summary.disagreements);
    disagreements[0]!.queue_id = "f".repeat(64);
    const driftedQueue = { ...summary, disagreements };
    driftedQueue.summary_sha256 = computeSummaryHash(driftedQueue);
    expect(() => parseSummary(driftedQueue)).toThrow("queue_id hash mismatch");
    const metrics = [...summary.metrics];
    metrics[1] = metrics[0]!;
    expect(() => parseSummary({ ...summary, metrics })).toThrow("order or identity drift");
  });
});
