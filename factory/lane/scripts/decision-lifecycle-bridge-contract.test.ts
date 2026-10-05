import { describe, expect, test } from "bun:test";
import { buildSyntheticSkillPromotionQualification } from "./skill-promotion-decision-cohort.ts";
import {
  computeSummaryHash,
  finalizeSignature,
  type SkillPromotionSummary,
} from "./skill-promotion-decision-contract.ts";
import { evaluateSkillPromotionDecision } from "./skill-promotion-decision-runner.ts";
import {
  DECISION_LIFECYCLE_BRIDGE_REQUEST,
  DECISION_LIFECYCLE_MAX_AGE_MS,
  evaluateDecisionLifecycleShadow,
  parseDecisionLifecycleShadowObservation,
  runDecisionLifecycleBridge,
} from "./decision-lifecycle-bridge-contract.ts";

const fixture = `${import.meta.dir}/../scenarios/fixtures/actor-system-cohort.json`;

function inputs() {
  const qualification = buildSyntheticSkillPromotionQualification(fixture);
  const holdSummary = evaluateSkillPromotionDecision(
    qualification.protocol,
    qualification.observations,
    qualification.approved_lifecycle,
    qualification.candidate_lifecycle,
    qualification.predecessors,
    null,
  );
  return { qualification, holdSummary };
}

function recommended(summary: SkillPromotionSummary, signedAt: string) {
  const { summary_sha256: _hash, ...body } = summary;
  const promoted = {
    ...body,
    human_signature_valid: true,
    decision: "PROMOTION_RECOMMENDED" as const,
    reasons: [],
  };
  return {
    summary: { ...promoted, summary_sha256: computeSummaryHash(promoted) },
    signature: finalizeSignature({
      schema: "skill-promotion-signature/v1",
      actor: "operator",
      signed_at: signedAt,
      evidence_preimage_sha256: summary.evidence_preimage_sha256,
      requested_decision: "PROMOTION_RECOMMENDED",
    }),
  };
}

function request(summary?: SkillPromotionSummary) {
  const { qualification, holdSummary } = inputs();
  return {
    schema: DECISION_LIFECYCLE_BRIDGE_REQUEST,
    trace_id: "dlb-01-test-trace",
    observed_at: qualification.protocol.evaluation_time,
    actor: { id: "decision-runner", authority: "observe-only" as const },
    protocol: qualification.protocol,
    summary: summary ?? holdSummary,
    signature: null,
    lifecycle_record: qualification.candidate_lifecycle,
  };
}

describe("decision-to-lifecycle bridge contract", () => {
  test("off mode returns before reading inputs", () => {
    let reads = 0;
    const result = runDecisionLifecycleBridge("off", () => {
      reads += 1;
      throw new Error("must not read");
    });
    expect(reads).toBe(0);
    expect(result).toEqual({ mode: "off", disposition: "OFF", observation: null, reasons: [] });
  });

  test("maps an exact advisory recommendation to an authority-free dry promotion request", () => {
    const base = request();
    const recommendation = recommended(base.summary as SkillPromotionSummary, base.observed_at);
    const result = evaluateDecisionLifecycleShadow({ ...base, ...recommendation });
    expect(result.disposition).toBe("WOULD_REQUEST_PROMOTION");
    expect(result.observation?.requested_transition).toEqual({ from: "approved", to: "promoted" });
    expect(result.observation?.lifecycle_dry_verdict).toBe("PASS");
    expect(new Set(Object.values(result.observation?.authority ?? {}))).toEqual(new Set([false]));
    expect(result.observation?.subject.subject_sha256).toBe((base.protocol as { candidate_subject_sha256: string }).candidate_subject_sha256);
  });

  test("keeps a valid upstream HOLD advisory-only with no transition", () => {
    const result = evaluateDecisionLifecycleShadow(request());
    expect(result.disposition).toBe("HOLD");
    expect(result.observation?.requested_transition).toBeNull();
    expect(result.observation?.source_decision).toBe("HOLD");
  });

  test("returns HOLD without a proposal for unknown, mismatched, tampered, stale, or unsigned input", () => {
    const base = request();
    const recommendation = recommended(base.summary as SkillPromotionSummary, base.observed_at);
    const exactSummary = recommendation.summary;
    const cases = [
      { ...base, unknown: true },
      { ...base, ...recommendation, lifecycle_record: { ...(base.lifecycle_record as object), subjectHash: `sha256:${"f".repeat(64)}` } },
      { ...base, ...recommendation, summary: { ...exactSummary, summary_sha256: "0".repeat(64) } },
      { ...base, ...recommendation, observed_at: new Date(Date.parse(base.observed_at) + DECISION_LIFECYCLE_MAX_AGE_MS + 1).toISOString() },
      { ...base, summary: { ...exactSummary, human_signature_valid: false } },
      { ...base, summary: exactSummary, signature: null },
    ];
    for (const candidate of cases) {
      const result = evaluateDecisionLifecycleShadow(candidate);
      expect(result.disposition).toBe("HOLD");
      expect(result.observation).toBeNull();
    }
  });

  test("records lifecycle blocking evidence without proposing a transition", () => {
    const base = request();
    const recommendation = recommended(base.summary as SkillPromotionSummary, base.observed_at);
    const lifecycle = structuredClone(base.lifecycle_record) as {
      state: string;
      security: { deterministic: Array<{ issuedAt: string; validUntil: string }> };
    };
    lifecycle.security.deterministic[0]!.validUntil = new Date(
      Date.parse(lifecycle.security.deterministic[0]!.issuedAt) + 1,
    ).toISOString();
    const result = evaluateDecisionLifecycleShadow({ ...base, ...recommendation, lifecycle_record: lifecycle });
    expect(result.disposition).toBe("HOLD");
    expect(result.observation?.requested_transition).toBeNull();
    expect(result.observation?.lifecycle_dry_verdict).toBe("DENY");
    expect(result.observation?.lifecycle_issues.some((issue) => issue.code === "STALE_EVIDENCE")).toBe(true);
  });

  test("derives stable input hashes and dedupe keys for deterministic replay", () => {
    const base = request();
    const recommendation = recommended(base.summary as SkillPromotionSummary, base.observed_at);
    const first = evaluateDecisionLifecycleShadow({ ...base, ...recommendation });
    const second = evaluateDecisionLifecycleShadow(structuredClone({ ...base, ...recommendation }));
    expect(first).toEqual(second);
    expect(first.observation?.dedupe_key).toBe(second.observation?.dedupe_key);
    expect(first.observation?.observation_sha256).toBe(second.observation?.observation_sha256);
  });

  test("strictly parses replayed observations and rejects authority or hash drift", () => {
    const base = request();
    const recommendation = recommended(base.summary as SkillPromotionSummary, base.observed_at);
    const result = evaluateDecisionLifecycleShadow({ ...base, ...recommendation });
    expect(result.observation).not.toBeNull();
    const observation = result.observation;
    if (!observation) throw new Error("expected a shadow observation");
    expect(parseDecisionLifecycleShadowObservation(observation)).toEqual(observation);
    expect(() => parseDecisionLifecycleShadowObservation({ ...observation, unknown: true })).toThrow();
    expect(() => parseDecisionLifecycleShadowObservation({
      ...observation,
      authority: { ...observation.authority, promotion: true },
    })).toThrow();
    expect(() => parseDecisionLifecycleShadowObservation({
      ...observation,
      observation_sha256: `sha256:${"0".repeat(64)}`,
    })).toThrow();
  });
});
