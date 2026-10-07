import { describe, expect, test } from "bun:test";
import {
  buildConsensusProfile,
  validateConsensusProfile,
  type ConsensusProfileArtifact,
} from "./consensus-profile";
import {
  computePreliminaryDecision,
  parseReviewerResponse,
  preflightConsensusProfile,
  probeConsensusProfile,
  runQualityGate,
  type ReviewRecord,
} from "./consensus-quality-gate";
import type { Candidate } from "./lineup-picker";
import type { MoaCallResult } from "./moa-runtime";

const candidates: Candidate[] = [
  { id: "byok:claude", label: "Claude", family: "claude", canonicalModel: "claude-test", tier: "flagship", provider: "zo-byok", promptCost: 0, completionCost: 0, totalCost: 0, subscription: true },
  { id: "hf:zai-org/GLM-Test", label: "GLM", family: "glm", canonicalModel: "glm-test", tier: "flagship", provider: "synthetic", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
  { id: "oc:kimi-test", label: "Kimi", family: "kimi", canonicalModel: "kimi-test", tier: "flagship", provider: "opencode", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
  { id: "or:deepseek/test", label: "DeepSeek", family: "deepseek", canonicalModel: "deepseek-test", tier: "flagship", provider: "openrouter", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
  { id: "or:google/gemini-test", label: "Gemini", family: "gemini", canonicalModel: "gemini-test", tier: "flagship", provider: "openrouter", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
];

function profile(): ConsensusProfileArtifact {
  return buildConsensusProfile(candidates, {
    reviewerIds: ["byok:claude", "hf:zai-org/GLM-Test", "oc:kimi-test"],
    adjudicatorId: "or:deepseek/test",
    generatedAt: "2026-07-30T00:00:00.000Z",
  });
}

function sharedProviderProfile(): ConsensusProfileArtifact {
  return buildConsensusProfile(candidates, {
    reviewerIds: ["or:deepseek/test", "or:google/gemini-test", "byok:claude"],
    adjudicatorId: "hf:zai-org/GLM-Test",
    generatedAt: "2026-08-02T00:00:00.000Z",
  });
}

function record(verdict: "PASS" | "FAIL" | "ABSTAIN", provider: string, severity: "critical" | "major" | "minor" | "none" = "none"): ReviewRecord {
  return {
    seat: "reviewer",
    role: "reviewer",
    requestedModel: provider,
    configuredProvider: provider,
    servingProvider: provider,
    family: provider,
    substituted: false,
    observedAt: "2026-07-30T00:00:00.000Z",
    latencyMs: 1,
    status: "valid",
    response: {
      verdict,
      findings: verdict === "FAIL" ? [{ criterion: "correctness", severity, finding: "defect", evidence: "line 1" }] : [],
      confidence: 0.9,
      unresolvedAssumptions: verdict === "ABSTAIN" ? ["missing test evidence"] : [],
    },
  };
}

function response(model: string, provider: string, text: string): MoaCallResult {
  return { model, provider, ok: true, text, source: "content", latencyMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 };
}

const passJson = JSON.stringify({ verdict: "PASS", findings: [], confidence: 0.9, unresolvedAssumptions: [] });
const failJson = JSON.stringify({ verdict: "FAIL", findings: [{ criterion: "correctness", severity: "major", finding: "wrong result", evidence: "line 4" }], confidence: 0.9, unresolvedAssumptions: [] });
const adjudicatorProbeJson = JSON.stringify({ classification: "INSUFFICIENT", rationale: "capability probe", evidence: [], confidence: 1 });

describe("consensus profile schema", () => {
  test("builds exactly three reviewers and one independent adjudicator", () => {
    const artifact = profile();
    expect(artifact.reviewers).toHaveLength(3);
    expect(artifact).toMatchObject({
      schemaVersion: 2,
      roleProfile: "judge",
      capabilityTier: "frontier",
      weightPolicy: "any",
    });
    expect(new Set([...artifact.reviewers, artifact.adjudicator].map((seat) => seat.family)).size).toBe(4);
    expect(validateConsensusProfile(artifact)).toEqual({ valid: true, errors: [] });
  });

  test("accepts an explicitly pinned direct xAI adjudicator outside the cached catalogs", () => {
    const artifact = buildConsensusProfile(candidates.slice(0, 3), {
      reviewerIds: ["byok:claude", "hf:zai-org/GLM-Test", "oc:kimi-test"],
      adjudicatorId: "xai:grok-3-mini",
    });
    expect(artifact.adjudicator).toMatchObject({ id: "xai:grok-3-mini", provider: "xai", family: "grok" });
    expect(validateConsensusProfile(artifact).valid).toBe(true);
  });

  test("accepts distinct model families routed through a shared provider", () => {
    const artifact = sharedProviderProfile();
    expect(artifact.reviewers[0].provider).toBe("openrouter");
    expect(artifact.reviewers[1].provider).toBe("openrouter");
    expect(new Set([...artifact.reviewers, artifact.adjudicator].map((seat) => seat.family)).size).toBe(4);
    expect(validateConsensusProfile(artifact)).toEqual({ valid: true, errors: [] });
  });

  test("automatically selects distinct families from one multi-vendor provider", () => {
    const syntheticCandidates: Candidate[] = ["claude", "deepseek", "gemini", "glm"].map((family) => ({
      id: `hf:${family}/test`,
      label: family,
      family,
      canonicalModel: `${family}-test`,
      tier: "flagship",
      provider: "synthetic",
      promptCost: 0,
      completionCost: 0,
      totalCost: 0,
      subscription: false,
    }));
    const artifact = buildConsensusProfile(syntheticCandidates);
    expect(new Set([...artifact.reviewers, artifact.adjudicator].map((seat) => seat.provider))).toEqual(new Set(["synthetic"]));
    expect(new Set([...artifact.reviewers, artifact.adjudicator].map((seat) => seat.family)).size).toBe(4);
    expect(validateConsensusProfile(artifact)).toEqual({ valid: true, errors: [] });
  });

  test("applies an open-weight constraint independently within the judge role", () => {
    const openJudges: Candidate[] = ["glm", "qwen", "kimi", "deepseek"].map((family) => ({
      id: `hf:${family}/judge`,
      label: family,
      family,
      canonicalModel: `${family}-judge`,
      tier: "flagship",
      provider: "synthetic",
      promptCost: 0,
      completionCost: 0,
      totalCost: 0,
      subscription: false,
      openWeights: true,
      openWeightsEvidence: "explicit",
    }));
    const closedJudge: Candidate = {
      ...openJudges[0],
      id: "byok:closed-judge",
      family: "closed",
      canonicalModel: "closed-judge",
      provider: "zo-byok",
      openWeights: false,
    };
    const artifact = buildConsensusProfile([closedJudge, ...openJudges], { weightPolicy: "open-only" });
    expect(artifact.weightPolicy).toBe("open-only");
    expect([...artifact.reviewers, artifact.adjudicator].map((seat) => seat.id)).not.toContain("byok:closed-judge");
  });

  test("rejects a model-family collision even when model ids differ", () => {
    const artifact = profile();
    artifact.adjudicator.family = artifact.reviewers[0].family;
    expect(validateConsensusProfile(artifact).errors).toContain("all four model families must be distinct");
  });

  test("rejects a partially pinned reviewer set", () => {
    expect(() => buildConsensusProfile(candidates, {
      reviewerIds: ["byok:claude", "hf:zai-org/GLM-Test"],
      adjudicatorId: "or:deepseek/test",
    })).toThrow("exactly three pinned reviewers");
  });
});

describe("consensus reviewer policy", () => {
  test("parses a strict PASS record", () => {
    expect(parseReviewerResponse(`prefix ${passJson} suffix`).verdict).toBe("PASS");
  });

  test("rejects FAIL without evidence-backed major or critical finding", () => {
    expect(() => parseReviewerResponse(JSON.stringify({ verdict: "FAIL", findings: [], confidence: 0.8, unresolvedAssumptions: [] }))).toThrow();
  });

  test("requires unanimous reviewers for preliminary PASS", () => {
    expect(computePreliminaryDecision([record("PASS", "a"), record("PASS", "b"), record("PASS", "c")]).decision).toBe("PASS");
    expect(computePreliminaryDecision([record("PASS", "a"), record("PASS", "b"), record("FAIL", "c", "major")]).decision).toBe("ESCALATE");
    expect(computePreliminaryDecision([record("PASS", "a"), record("PASS", "b"), record("ABSTAIN", "c")]).decision).toBe("HOLD");
  });

  test("allows unanimous reviewers to share a serving provider", () => {
    expect(computePreliminaryDecision([record("PASS", "openrouter"), record("PASS", "openrouter"), record("PASS", "synthetic")]).decision).toBe("PASS");
  });
});

describe("consensus quality gate", () => {
  test("passes only unanimous blind reviewers and does not call the adjudicator", async () => {
    const artifact = sharedProviderProfile();
    let calls = 0;
    const callModel = async (model: string, prompt: string): Promise<MoaCallResult> => {
      calls++;
      const seat = [...artifact.reviewers, artifact.adjudicator].find((item) => item.id === model)!;
      return response(model, seat.provider, prompt.includes('"classification"') ? adjudicatorProbeJson : passJson);
    };
    const result = await runQualityGate({ input: "const ok = true", criteria: "correctness", label: "pass", profile: artifact, callModel });
    expect(result.decision).toBe("PASS");
    expect(result.automaticApprovalEligible).toBe(true);
    expect(result.adjudication).toBeNull();
    expect(calls).toBe(7);
    expect(result.independence.configuredProvidersDistinct).toBe(false);
    expect(result.independence.servingProvidersDistinct).toBe(false);
    expect(result.independence.configuredFamiliesDistinct).toBe(true);
    expect(result.independence.providerReuseAllowed).toBe(true);
  });

  test("uses the adjudicator on dissent but keeps split-pass authority disabled", async () => {
    const artifact = profile();
    const callModel = async (model: string): Promise<MoaCallResult> => {
      const seat = [...artifact.reviewers, artifact.adjudicator].find((item) => item.id === model)!;
      if (seat.role === "adjudicator") {
        return response(model, seat.provider, JSON.stringify({ classification: "OVERRULED_WITH_EVIDENCE", rationale: "the cited line contradicts the dissent", evidence: ["line 4 returns the expected value"], confidence: 0.9 }));
      }
      return response(model, seat.provider, seat.seat === "reviewer-3" ? failJson : passJson);
    };
    const result = await runQualityGate({ input: "const ok = true", criteria: "correctness", label: "split", profile: artifact, callModel });
    expect(result.preliminaryDecision).toBe("ESCALATE");
    expect(result.adjudication?.classification).toBe("OVERRULED_WITH_EVIDENCE");
    expect(result.decision).toBe("HOLD");
    expect(result.recommendedDecision).toBe("PASS");
    expect(result.automaticApprovalEligible).toBe(false);
  });

  test("role-specific health requires parseable reviewer and adjudicator contracts", async () => {
    const artifact = sharedProviderProfile();
    const callModel = async (model: string): Promise<MoaCallResult> => {
      const seat = [...artifact.reviewers, artifact.adjudicator].find((item) => item.id === model)!;
      const text = seat.role === "adjudicator"
        ? JSON.stringify({ classification: "INSUFFICIENT", rationale: "capability probe", evidence: [], confidence: 1 })
        : passJson;
      return response(model, seat.provider, text);
    };
    const health = await probeConsensusProfile(artifact, callModel);
    expect(health.status).toBe("healthy");
    expect(health.providerReuseAllowed).toBe(true);
    expect(health.collisions).toEqual(["openrouter"]);
    expect(health.results.every((item) => item.transportOk && item.capabilityOk)).toBe(true);
  });

  test("resolves an HTTP 429 primary to a schema-healthy same-family fallback before review", async () => {
    const artifact = profile();
    artifact.reviewers[0].fallbacks = ["or:anthropic/claude-sonnet-4.6"];
    const prompts = new Map<string, string[]>();
    const callModel = async (model: string, prompt: string): Promise<MoaCallResult> => {
      prompts.set(model, [...(prompts.get(model) ?? []), prompt]);
      if (model === "byok:claude") {
        return { ...response(model, "zo-byok", ""), ok: false, error: "HTTP 429 rate limited" };
      }
      return response(model, model.startsWith("or:") ? "openrouter" : "test", prompt.includes('"classification"') ? adjudicatorProbeJson : passJson);
    };
    const readiness = await preflightConsensusProfile(artifact, callModel);
    expect(readiness.healthy).toBe(true);
    expect(readiness.evidence.seats[0].selectedModel).toBe("or:anthropic/claude-sonnet-4.6");
    expect(readiness.evidence.seats[0].attempts.map((attempt) => attempt.error)).toContain("HTTP 429 rate limited");
    expect((prompts.get("byok:claude") ?? []).every((prompt) => !prompt.includes("<<ARTIFACT-"))).toBe(true);
  });

  test("resolves malformed JSON before review and binds only the parseable route", async () => {
    const artifact = profile();
    artifact.reviewers[1].fallbacks = ["or:z-ai/glm-5.2"];
    const callModel = async (model: string, prompt: string): Promise<MoaCallResult> => {
      if (model === "hf:zai-org/GLM-Test") return response(model, "synthetic", "not-json");
      return response(model, model.startsWith("or:") ? "openrouter" : "test", prompt.includes('"classification"') ? adjudicatorProbeJson : passJson);
    };
    const readiness = await preflightConsensusProfile(artifact, callModel);
    expect(readiness.healthy).toBe(true);
    expect(readiness.evidence.seats[1].selectedModel).toBe("or:z-ai/glm-5.2");
    expect(readiness.evidence.seats[1].attempts[0]).toMatchObject({ transportOk: true, schemaOk: false, ok: false });
  });

  test("holds without sending code when no healthy route can be established", async () => {
    const artifact = profile();
    const prompts: string[] = [];
    const callModel = async (model: string, prompt: string): Promise<MoaCallResult> => {
      prompts.push(prompt);
      return { ...response(model, "unavailable", ""), ok: false, error: "provider unavailable" };
    };
    const result = await runQualityGate({ input: "const secret = true", criteria: "correctness", label: "hold", profile: artifact, callModel });
    expect(result.decision).toBe("HOLD");
    expect(result.reviewers).toEqual([]);
    expect(result.readiness.codePayloadSent).toBe(false);
    expect(prompts.every((prompt) => !prompt.includes("const secret = true"))).toBe(true);
  });
});
