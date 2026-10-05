import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticSkillPromotionQualification } from "./skill-promotion-decision-cohort.ts";
import {
  finalizeObservation,
  finalizeProtocol,
  finalizeSignature,
  type SkillPromotionObservation,
} from "./skill-promotion-decision-contract.ts";
import { computeScenarioSourceSummaryHash } from "./scenario-source-comparison-contract.ts";
import { computeSummaryHash as computeOutputSummaryHash } from "./output-trajectory-comparison-contract.ts";
import { computeSummaryHash as computeSilentSummaryHash } from "./silent-success-comparison-contract.ts";
import {
  computeSummaryHash as computeHarnessSummaryHash,
  finalizeProtocol as finalizeHarnessProtocol,
} from "./harness-portability-comparison-contract.ts";
import { evaluateSkillPromotionDecision, runSkillPromotionDecisionCli } from "./skill-promotion-decision-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const roots: string[] = [];
const originalFlag = process.env.SF010_SKILL_PROMOTION_DECISION;
const originalBridgeMode = process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE;

afterEach(() => {
  if (originalFlag === undefined) delete process.env.SF010_SKILL_PROMOTION_DECISION;
  else process.env.SF010_SKILL_PROMOTION_DECISION = originalFlag;
  if (originalBridgeMode === undefined) delete process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE;
  else process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE = originalBridgeMode;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function refinalize(observation: SkillPromotionObservation): SkillPromotionObservation {
  const { observation_sha256: _ignored, ...body } = observation;
  return finalizeObservation(body);
}

describe("skill promotion decision runner", () => {
  test("deterministically yields mandatory HOLD for complete synthetic evidence", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const first = evaluateSkillPromotionDecision(qualification.protocol, qualification.observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, qualification.predecessors, null);
    const second = evaluateSkillPromotionDecision(qualification.protocol, qualification.observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, qualification.predecessors, null);
    expect(first).toEqual(second);
    expect(first.decision).toBe("HOLD");
    expect(first.complete_pairs).toBe(30);
    expect(first.observations).toBe(60);
    expect(first.compatibility_rows).toBe(5);
    expect(first.metrics.every((metric) => metric.interval.method === "paired-normal-95")).toBe(true);
    expect(first.reasons).toContain("synthetic evidence cannot support promotion");
    expect(first.reasons).toContain("explicit human signature absent");
    expect(first.production_promotion_mutations).toBe(0);
    expect(first.production_routing_mutations).toBe(0);
  });

  test("denies constitutional, authority, or contamination failures and holds rollback gaps", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const observations = [...qualification.observations];
    observations[0] = refinalize({
      ...observations[0]!,
      authority_valid: false,
      constitutional_failure: true,
      contamination_detected: true,
      rollback_valid: false,
      metrics: { ...observations[0]!.metrics, contamination_rate: 1 },
    });
    const summary = evaluateSkillPromotionDecision(qualification.protocol, observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, qualification.predecessors, null);
    expect(summary.decision).toBe("DENY");
    expect(summary.constitutional_failures).toBe(1);
    expect(summary.authority_failures).toBe(1);
    expect(summary.contamination_detections).toBe(1);
    expect(summary.rollback_failures).toBe(1);
  });

  test("keeps missing harness rows as explicit denominator failures", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const candidate = structuredClone(qualification.candidate_lifecycle);
    candidate.evaluation.compatibility = candidate.evaluation.compatibility.filter((row) => row.harness.name !== "cursor");
    const summary = evaluateSkillPromotionDecision(qualification.protocol, qualification.observations, qualification.approved_lifecycle, candidate, qualification.predecessors, null);
    expect(summary.decision).toBe("HOLD");
    expect(summary.compatibility_rows).toBe(5);
    expect(summary.compatibility_coverage).toBe(1);
    expect(summary.reasons).toContain("skill/model/harness compatibility matrix is incomplete or failed");
  });

  test("rejects a signature that does not bind the exact evidence preimage", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const signature = finalizeSignature({
      schema: "skill-promotion-signature/v1",
      actor: "operator",
      signed_at: "2026-08-20T14:01:00.000Z",
      evidence_preimage_sha256: "f".repeat(64),
      requested_decision: "PROMOTION_RECOMMENDED",
    });
    const summary = evaluateSkillPromotionDecision(qualification.protocol, qualification.observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, qualification.predecessors, signature);
    expect(summary.decision).toBe("HOLD");
    expect(summary.human_signature_valid).toBe(false);
    expect(summary.reasons).toContain("human signature does not bind the exact evidence preimage");
  });

  test("reaches an advisory recommendation only for positive Phase D evidence with an exact signature", () => {
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const { protocol_sha256: _protocolHash, ...protocolBody } = qualification.protocol;
    const protocol = finalizeProtocol({ ...protocolBody, evidence_class: "phase-d-production" });

    const { summary_sha256: _scenarioHash, ...scenarioBody } = qualification.predecessors.scenario_source_summary;
    const scenarioWithoutHash = {
      ...scenarioBody,
      evidence_class: "phase_d_observation" as const,
      disposition: "BENEFIT_SUPPORTED" as const,
      reasons: [],
    };
    const scenario = {
      ...scenarioWithoutHash,
      summary_sha256: computeScenarioSourceSummaryHash(scenarioWithoutHash),
    };

    const { summary_sha256: _outputHash, ...outputBody } = qualification.predecessors.output_trajectory_summary;
    const outputWithoutHash = {
      ...outputBody,
      evidence_class: "phase_d_observation" as const,
      disposition: "TRAJECTORY_BENEFIT_SUPPORTED" as const,
      reasons: [],
    };
    const output = {
      ...outputWithoutHash,
      summary_sha256: computeOutputSummaryHash(outputWithoutHash),
    };

    const { summary_sha256: _silentHash, ...silentBody } = qualification.predecessors.silent_success_summary;
    const silentWithoutHash = {
      ...silentBody,
      evidence_class: "phase_d_observation" as const,
      disposition: "RECEIPT_BENEFIT_SUPPORTED" as const,
      reasons: [],
    };
    const silent = {
      ...silentWithoutHash,
      summary_sha256: computeSilentSummaryHash(silentWithoutHash),
    };

    const { protocol_sha256: _harnessProtocolHash, ...harnessProtocolBody } = qualification.predecessors.harness_portability_protocol;
    const harnessProtocol = finalizeHarnessProtocol({
      ...harnessProtocolBody,
      evidence_class: "phase_d_observation",
    });
    const { summary_sha256: _harnessSummaryHash, ...harnessSummaryBody } = qualification.predecessors.harness_portability_summary;
    const harnessWithoutHash = {
      ...harnessSummaryBody,
      protocol_sha256: harnessProtocol.protocol_sha256,
      evidence_class: "phase_d_observation" as const,
      production_adapter_parity: 1,
      comparisons: harnessSummaryBody.comparisons.map((comparison) => ({
        ...comparison,
        unsupported_capability_cells: 0,
        model_confounded_pairs: 0,
        harness_effect_claim_eligible: true,
        disposition: "CONFORMANT" as const,
        reasons: [],
      })),
      claim_eligible: true,
      disposition: "CONFORMANT" as const,
      hold_reasons: [],
      nonconformance_reasons: [],
    };
    const harness = {
      ...harnessWithoutHash,
      summary_sha256: computeHarnessSummaryHash({ ...harnessWithoutHash, summary_sha256: "0".repeat(64) }),
    };
    const predecessors = {
      ...qualification.predecessors,
      scenario_source_summary: scenario,
      output_trajectory_summary: output,
      silent_success_summary: silent,
      harness_portability_protocol: harnessProtocol,
      harness_portability_summary: harness,
    };

    const unsigned = evaluateSkillPromotionDecision(
      protocol,
      qualification.observations,
      qualification.approved_lifecycle,
      qualification.candidate_lifecycle,
      predecessors,
      null,
    );
    expect(unsigned.decision).toBe("HOLD");
    expect(unsigned.reasons).toEqual(["explicit human signature absent"]);

    const signature = finalizeSignature({
      schema: "skill-promotion-signature/v1",
      actor: "operator",
      signed_at: "2026-08-20T14:01:00.000Z",
      evidence_preimage_sha256: unsigned.evidence_preimage_sha256,
      requested_decision: "PROMOTION_RECOMMENDED",
    });
    const signed = evaluateSkillPromotionDecision(
      protocol,
      qualification.observations,
      qualification.approved_lifecycle,
      qualification.candidate_lifecycle,
      predecessors,
      signature,
    );
    expect(signed.decision).toBe("PROMOTION_RECOMMENDED");
    expect(signed.human_signature_valid).toBe(true);
    expect(signed.reasons).toEqual([]);
    expect(signed.advisory_only).toBe(true);
    expect(signed.production_promotion_mutations).toBe(0);
    expect(signed.production_routing_mutations).toBe(0);
  });

  test("CLI is read-free while disabled and exclusively creates one caller-selected output", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1067-runner-"));
    roots.push(root);
    delete process.env.SF010_SKILL_PROMOTION_DECISION;
    delete process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE;
    expect(runSkillPromotionDecisionCli(["--protocol", join(root, "absent.json")])).toBe(0);
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const paths = {
      protocol: join(root, "protocol.json"), observations: join(root, "observations.json"),
      approved: join(root, "approved.json"), candidate: join(root, "candidate.json"),
      predecessors: join(root, "predecessors.json"), signature: join(root, "signature.json"),
      output: join(root, "summary.json"),
    };
    writeFileSync(paths.protocol, JSON.stringify(qualification.protocol));
    writeFileSync(paths.observations, JSON.stringify(qualification.observations));
    writeFileSync(paths.approved, JSON.stringify(qualification.approved_lifecycle));
    writeFileSync(paths.candidate, JSON.stringify(qualification.candidate_lifecycle));
    writeFileSync(paths.predecessors, JSON.stringify(qualification.predecessors));
    writeFileSync(paths.signature, "null");
    process.env.SF010_SKILL_PROMOTION_DECISION = "1";
    const args = ["--protocol", paths.protocol, "--observations", paths.observations, "--approved-lifecycle", paths.approved, "--candidate-lifecycle", paths.candidate, "--predecessors", paths.predecessors, "--signature", paths.signature, "--output", paths.output];
    expect(runSkillPromotionDecisionCli(args)).toBe(0);
    expect(existsSync(paths.output)).toBe(true);
    const expected = evaluateSkillPromotionDecision(qualification.protocol, qualification.observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, qualification.predecessors, null);
    expect(readFileSync(paths.output, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(() => runSkillPromotionDecisionCli(args)).toThrow();
  });

  test("canonical decision CLI invokes the merged bridge runner only in explicit shadow mode", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1470-runner-"));
    roots.push(root);
    const qualification = buildSyntheticSkillPromotionQualification(fixture);
    const paths = {
      protocol: join(root, "protocol.json"), observations: join(root, "observations.json"),
      approved: join(root, "approved.json"), candidate: join(root, "candidate.json"),
      predecessors: join(root, "predecessors.json"), signature: join(root, "signature.json"),
      output: join(root, "summary.json"), ledger: join(root, "shadow", "observations.jsonl"),
    };
    writeFileSync(paths.protocol, JSON.stringify(qualification.protocol));
    writeFileSync(paths.observations, JSON.stringify(qualification.observations));
    writeFileSync(paths.approved, JSON.stringify(qualification.approved_lifecycle));
    writeFileSync(paths.candidate, JSON.stringify(qualification.candidate_lifecycle));
    writeFileSync(paths.predecessors, JSON.stringify(qualification.predecessors));
    writeFileSync(paths.signature, "null");
    process.env.SF010_SKILL_PROMOTION_DECISION = "1";
    process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE = "shadow";
    const args = [
      "--protocol", paths.protocol,
      "--observations", paths.observations,
      "--approved-lifecycle", paths.approved,
      "--candidate-lifecycle", paths.candidate,
      "--predecessors", paths.predecessors,
      "--signature", paths.signature,
      "--output", paths.output,
      "--bridge-ledger", paths.ledger,
      "--bridge-trace-id", "zou-1470-canonical-consumer",
      "--bridge-actor-id", "skill-promotion-decision-runner",
      "--bridge-observed-at", qualification.protocol.evaluation_time,
    ];
    expect(runSkillPromotionDecisionCli(args)).toBe(0);
    const expected = evaluateSkillPromotionDecision(qualification.protocol, qualification.observations, qualification.approved_lifecycle, qualification.candidate_lifecycle, qualification.predecessors, null);
    expect(readFileSync(paths.output, "utf8")).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    const rows = readFileSync(paths.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0].source_decision).toBe("HOLD");
    expect(rows[0].actor).toEqual({ id: "skill-promotion-decision-runner", authority: "observe-only" });
    expect(Object.values(rows[0].authority).every((value) => value === false)).toBe(true);
  });
});
