import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyntheticSkillPromotionQualification } from "./skill-promotion-decision-cohort.ts";
import { validateLifecyclePair, parseSkillPromotionProtocol } from "./skill-promotion-decision-contract.ts";
import { evaluateSkillPromotionDecision } from "./skill-promotion-decision-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("skill promotion decision synthetic cohort", () => {
  test("selects ten sorted contracts across three seeds into 30 pairs and 60 slots", () => {
    const manifest = JSON.parse(readFileSync(fixture, "utf8")) as { contracts: Array<{ id: string }>; replicateSeeds: number[] };
    const expectedTasks = manifest.contracts.map((contract) => contract.id).sort().slice(0, 10);
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    expect([...new Set(qualification.protocol.pairs.map((pair) => pair.task_id))]).toEqual(expectedTasks);
    expect([...new Set(qualification.protocol.pairs.map((pair) => pair.seed))]).toEqual([...manifest.replicateSeeds].sort());
    expect(qualification.protocol.pairs).toHaveLength(30);
    expect(qualification.observations).toHaveLength(60);
    expect(new Set(qualification.observations.map((entry) => entry.observation_sha256)).size).toBe(60);
  });

  test("binds distinct exact skill versions and all five production harnesses", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const protocol = parseSkillPromotionProtocol(qualification.protocol);
    const lifecycle = validateLifecyclePair(qualification.approved_lifecycle, qualification.candidate_lifecycle, protocol);
    expect(protocol.approved_version).toBe("1.0.0");
    expect(protocol.candidate_version).toBe("1.1.0");
    expect(protocol.approved_subject_sha256).not.toBe(protocol.candidate_subject_sha256);
    expect(lifecycle.approved.decision).toBe("PASS");
    expect(lifecycle.candidate.decision).toBe("PASS");
    expect(qualification.candidate_lifecycle.evaluation.compatibility.map((row) => row.harness.name)).toEqual(["claude-code", "codex", "cursor", "gemini", "hermes"]);
  });

  test("is deterministic, redacted, advisory, zero-live-call, and necessarily HOLD", () => {
    const first = buildSyntheticSkillPromotionQualification(fixture);
    const second = buildSyntheticSkillPromotionQualification(fixture);
    expect(first).toEqual(second);
    expect(first.uses_live_models_harnesses_or_receipts).toBe(false);
    expect(first.claim_eligible).toBe(false);
    const serialized = JSON.stringify(first);
    for (const field of ["raw_task_input", "raw_output", "raw_receipt", "raw_verifier_report", "holdout_plaintext", "hidden_answer", "golden_patch", "fixture_path", "credential_value", "secret"]) {
      expect(serialized.includes(`\"${field}\"`)).toBe(false);
    }
    const summary = evaluateSkillPromotionDecision(first.protocol, first.observations, first.approved_lifecycle, first.candidate_lifecycle, first.predecessors, first.signature);
    expect(summary.decision).toBe("HOLD");
    expect(summary.human_signature_valid).toBe(false);
    expect(summary.advisory_only).toBe(true);
  });
});
