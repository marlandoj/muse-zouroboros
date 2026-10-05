import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  parseRunReceipt,
  reconstructRunReceipt,
  reduceRunEvents,
} from "./run-receipt-contract.ts";
import { validateEdgeProofRecord } from "./run-edge-proof.ts";
import { buildSyntheticSilentSuccessQualification } from "./silent-success-comparison-cohort.ts";
import {
  CANONICAL_EDGE_PROOF_VALIDATOR,
  CANONICAL_EVENT_REDUCER,
  CANONICAL_RECEIPT_PARSER,
  CANONICAL_RECEIPT_RECONSTRUCTOR,
  FAILURE_CLASSES,
  computeObservationHash,
  computeProtocolHash,
  computeSummaryHash,
  finalizeObservation,
  finalizeProtocol,
  hasPermittedEvidence,
  parseObservation,
  parseProtocol,
  parseSummary,
} from "./silent-success-comparison-contract.ts";
import { evaluateSilentSuccessComparison } from "./silent-success-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("silent-success receipt comparison contract", () => {
  test("binds the exact production receipt and edge-proof validators", () => {
    expect(CANONICAL_RECEIPT_PARSER).toBe(parseRunReceipt);
    expect(CANONICAL_EVENT_REDUCER).toBe(reduceRunEvents);
    expect(CANONICAL_RECEIPT_RECONSTRUCTOR).toBe(reconstructRunReceipt);
    expect(CANONICAL_EDGE_PROOF_VALIDATOR).toBe(validateEdgeProofRecord);
  });

  test("accepts the canonical 30-pair protocol and 90 blinded observations", () => {
    const cohort = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(parseProtocol(cohort.protocol)).toEqual(cohort.protocol);
    expect(cohort.observations.map((entry) => parseObservation(entry, cohort.protocol))).toEqual(cohort.observations);
    expect(computeProtocolHash(cohort.protocol)).toBe(cohort.protocol.protocol_sha256);
    expect(cohort.observations.every((entry) => computeObservationHash(entry) === entry.observation_sha256)).toBe(true);
  });

  test("rejects unknown fields and canonical hash drift", () => {
    const { protocol } = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(() => parseProtocol({ ...protocol, extra: true })).toThrow("unknown fields");
    expect(() => parseProtocol({ ...protocol, cohort_id: "drift" })).toThrow("protocol hash mismatch");
  });

  test("enforces exact failure-class counts and globally unique blind ids", () => {
    const { protocol } = buildSyntheticSilentSuccessQualification(FIXTURE);
    const duplicatePairs = structuredClone(protocol.pairs);
    duplicatePairs[1]!.blind_ids.transcript_only = duplicatePairs[0]!.blind_ids.transcript_only;
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, pairs: duplicatePairs }))).toThrow("duplicate blind ids");
    const imbalancedPairs = structuredClone(protocol.pairs);
    imbalancedPairs.find((pair) => pair.failure_class === "missing_edge_proof")!.failure_class = "timeout";
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, pairs: imbalancedPairs }))).toThrow("failure-class count mismatch");
    expect(new Set(protocol.pairs.map((pair) => pair.failure_class))).toEqual(new Set(FAILURE_CLASSES));
  });

  test("freezes incident, control, task, and authority identities across all arms", () => {
    const { protocol, observations } = buildSyntheticSilentSuccessQualification(FIXTURE);
    const drifted = finalizeObservation({ ...observations[0]!, matched_control_sha256: "f".repeat(64) });
    expect(() => parseObservation(drifted, protocol)).toThrow("incident-control identity drift");
    const wrongBlind = finalizeObservation({ ...observations[0]!, blind_id: protocol.pairs[1]!.blind_ids.transcript_only });
    expect(() => parseObservation(wrongBlind, protocol)).toThrow("identity drift");
  });

  test("enforces exact arm-specific evidence and canonical replay semantics", () => {
    const { protocol, observations } = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(observations.every(hasPermittedEvidence)).toBe(true);
    const transcript = observations.find((entry) => entry.arm === "transcript_only")!;
    const receipt = observations.find((entry) => entry.arm === "canonical_receipt")!;
    const crossed = finalizeObservation({ ...transcript, citations: receipt.citations });
    expect(hasPermittedEvidence(parseObservation(crossed, protocol))).toBe(false);
    const incompleteReceipt = finalizeObservation({ ...receipt, citations: receipt.citations.slice(0, 6) });
    expect(hasPermittedEvidence(parseObservation(incompleteReceipt, protocol))).toBe(false);
    expect(() => parseObservation(finalizeObservation({ ...receipt, canonical_replay_verified: null }), protocol)).toThrow("replay field");
    expect(() => parseObservation(finalizeObservation({ ...transcript, canonical_replay_verified: true }), protocol)).toThrow("replay field");
  });

  test("rejects raw payloads, secrets, duplicate citations, and malformed measurements", () => {
    const { protocol, observations } = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(() => parseProtocol({ ...protocol, ground_truth_label: "incident" })).toThrow("forbidden field");
    expect(() => parseProtocol({ ...protocol, cohort_id: "sk-secretvalue123456" })).toThrow("secret-shaped");
    const observation = observations[0]!;
    expect(() => parseObservation({ ...observation, raw_receipt: "hidden" }, protocol)).toThrow("forbidden field");
    expect(() => parseObservation(finalizeObservation({ ...observation, citations: [observation.citations[0]!, observation.citations[0]!] }), protocol)).toThrow("duplicate citation kinds");
    expect(() => parseObservation(finalizeObservation({ ...observation, diagnosis_time_ms: -1 }), protocol)).toThrow("nonnegative");
  });

  test("rejects issue or Phase D budget drift", () => {
    const { protocol } = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, budget: { ...protocol.budget, maximum_runs: 91 as 90 } }))).toThrow("must be 90");
    expect(() => parseProtocol(finalizeProtocol({ ...protocol, budget: { ...protocol.budget, maximum_cost_usd: 426 } }))).toThrow("Phase D ceiling");
  });

  test("strictly validates canonical summaries", () => {
    const cohort = buildSyntheticSilentSuccessQualification(FIXTURE);
    const summary = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    expect(parseSummary(summary)).toEqual(summary);
    expect(() => parseSummary({ ...summary, extra: true })).toThrow("unknown fields");
    expect(() => parseSummary({ ...summary, complete_pairs: 29 })).toThrow("summary hash mismatch");
    const armMetrics = [...summary.arm_metrics];
    armMetrics[1] = armMetrics[0]!;
    const drifted = { ...summary, arm_metrics: armMetrics };
    drifted.summary_sha256 = computeSummaryHash(drifted);
    expect(() => parseSummary(drifted)).toThrow("arm order or identity drift");
  });
});
