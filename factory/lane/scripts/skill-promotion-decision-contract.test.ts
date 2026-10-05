import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildSyntheticSkillPromotionQualification } from "./skill-promotion-decision-cohort.ts";
import {
  buildSkillCompatibilityMatrix,
  finalizeObservation,
  parsePredecessorBundle,
  parseSkillCompatibilityMatrix,
  parseSkillPromotionObservation,
  parseSkillPromotionProtocol,
  parseSkillPromotionSummary,
  validateLifecyclePair,
} from "./skill-promotion-decision-contract.ts";
import { evaluateSkillPromotionDecision } from "./skill-promotion-decision-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("skill promotion decision contract", () => {
  test("accepts exact protocol, pair, observation, lifecycle, predecessor, compatibility, and summary contracts", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const protocol = parseSkillPromotionProtocol(qualification.protocol);
    const observation = parseSkillPromotionObservation(qualification.observations[0], protocol);
    const lifecycle = validateLifecyclePair(qualification.approved_lifecycle, qualification.candidate_lifecycle, protocol);
    expect(lifecycle.approved.decision).toBe("PASS");
    expect(lifecycle.candidate.decision).toBe("PASS");
    const matrix = parseSkillCompatibilityMatrix(buildSkillCompatibilityMatrix(lifecycle.candidate.record!, protocol), protocol);
    const predecessors = parsePredecessorBundle(qualification.predecessors);
    const summary = evaluateSkillPromotionDecision(protocol, qualification.observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, predecessors, null);
    expect(parseSkillPromotionSummary(summary)).toEqual(summary);
    expect(protocol.pairs).toHaveLength(30);
    expect(observation.skill_subject_sha256).toBe(protocol.approved_subject_sha256);
    expect(matrix.cells.map((cell) => cell.harness_id)).toEqual(["claude-code", "codex", "cursor", "gemini", "hermes"]);
    expect(predecessors.harness_portability_summary.schema).toBe("harness-portability-summary/v1");
  });

  test("rejects unknown fields, hash drift, subject drift, and duplicate pair identities", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    expect(() => parseSkillPromotionProtocol({ ...qualification.protocol, surprise: true })).toThrow("unknown fields");
    expect(() => parseSkillPromotionProtocol({ ...qualification.protocol, protocol_sha256: "f".repeat(64) })).toThrow("protocol hash drift");
    expect(() => parseSkillPromotionProtocol({ ...qualification.protocol, pairs: [...qualification.protocol.pairs.slice(0, 29), qualification.protocol.pairs[0]] })).toThrow("unique pairs");
    const protocol = parseSkillPromotionProtocol(qualification.protocol);
    const { observation_sha256: _ignored, ...body } = qualification.observations[0];
    const drifted = finalizeObservation({ ...body, skill_subject_sha256: protocol.candidate_subject_sha256 });
    expect(() => parseSkillPromotionObservation(drifted, protocol)).toThrow("subject or task contract drift");
  });

  test("rejects plaintext evidence and secret-shaped values recursively", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    expect(() => parseSkillPromotionProtocol({ ...qualification.protocol, raw_prompt: "plaintext" })).toThrow("forbidden field");
    expect(() => parseSkillPromotionProtocol({ ...qualification.protocol, protocol_id: "sk_live_1234567890" })).toThrow("secret-shaped");
    expect(() => parsePredecessorBundle({ ...qualification.predecessors, raw_output: "plaintext" })).toThrow("forbidden field");
  });
});
