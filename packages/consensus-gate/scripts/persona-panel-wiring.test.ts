/**
 * Reachability proof for the persona panel.
 *
 * `persona-panel.ts` is a tested module, but a tested module with no caller is
 * dead code. These tests assert the gate actually reads it: the panel state
 * reaches the result, a held seat forces HOLD before any model is called, and
 * the Art. II model-family axis is dropped only when a persona panel is present.
 */
import { describe, expect, test } from "bun:test";
import { buildConsensusProfile, type ConsensusProfileArtifact } from "./consensus-profile";
import { gatePanelState, runQualityGate } from "./consensus-quality-gate";
import { buildPersonaPanel, type AvailabilityMap, type PersonaPanelArtifact } from "./persona-panel";
import type { Candidate } from "./lineup-picker";
import type { MoaCallResult } from "./moa-runtime";

const candidates: Candidate[] = [
  { id: "byok:claude", label: "Claude", family: "claude", canonicalModel: "claude-test", tier: "flagship", provider: "zo-byok", promptCost: 0, completionCost: 0, totalCost: 0, subscription: true },
  { id: "hf:zai-org/GLM-Test", label: "GLM", family: "glm", canonicalModel: "glm-test", tier: "flagship", provider: "synthetic", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
  { id: "oc:kimi-test", label: "Kimi", family: "kimi", canonicalModel: "kimi-test", tier: "flagship", provider: "opencode", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
  { id: "or:deepseek/test", label: "DeepSeek", family: "deepseek", canonicalModel: "deepseek-test", tier: "flagship", provider: "openrouter", promptCost: 0, completionCost: 0, totalCost: 0, subscription: false },
];

function profile(): ConsensusProfileArtifact {
  return buildConsensusProfile(candidates, {
    reviewerIds: ["byok:claude", "hf:zai-org/GLM-Test", "oc:kimi-test"],
    adjudicatorId: "or:deepseek/test",
    generatedAt: "2026-07-30T00:00:00.000Z",
  });
}

const allLive: AvailabilityMap = {
  "claude-code": { registered: true, executable: true },
  codex: { registered: true, executable: true },
  gemini: { registered: true, executable: true },
  hermes: { registered: true, executable: true },
};

const nothingLive: AvailabilityMap = {};

const passJson = JSON.stringify({ verdict: "PASS", findings: [], confidence: 0.9, unresolvedAssumptions: [] });
const adjudicatorProbeJson = JSON.stringify({ classification: "INSUFFICIENT", rationale: "capability probe", evidence: [], confidence: 1 });

function stubCallModel(): { callModel: (model: string, prompt: string, options: { maxTokens: number; temperature: number; system?: string }) => Promise<MoaCallResult>; calls: () => number } {
  let calls = 0;
  const callModel = async (model: string, _prompt: string, _options: { maxTokens: number; temperature: number; system?: string }): Promise<MoaCallResult> => {
    calls += 1;
    const text = _prompt.includes("adjudicator capability") || _prompt.includes("classification") ? adjudicatorProbeJson : passJson;
    return { model, provider: "stub", ok: true, text, source: "content", latencyMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 };
  };
  return { callModel, calls: () => calls };
}

describe("persona panel reaches the gate", () => {
  test("the gate reads the panel rather than redefining seat identity", () => {
    const panel: PersonaPanelArtifact = buildPersonaPanel({ availability: allLive });
    const state = gatePanelState(panel);
    expect(state.diversityAxis).toBe("persona");
    expect(state.panelHash).toBe(panel.panelHash);
    expect(state.seats).toHaveLength(4);
    expect(state.personasDistinct).toBe(true);
    expect(state.domainsDistinct).toBe(true);
  });

  test("gatePanelState refuses to call a held panel ready", () => {
    const state = gatePanelState(buildPersonaPanel({ availability: nothingLive }));
    expect(state.readiness.ready).toBe(false);
    expect(state.readiness.decision).toBe("HOLD");
    // Held is a ruling, not a structural defect: the panel is still the panel we
    // chartered, it simply cannot convene. It must stay recordable and reviewable.
    expect(state.structurallyValid).toBe(true);
    expect(state.readiness.heldSeats).toEqual(["reviewer-1", "reviewer-2", "reviewer-3", "adjudicator"]);
    expect(state.readiness.degradations.length).toBe(4);
  });

  test("panel state is attached to the gate result on the review path", async () => {
    const panel = buildPersonaPanel({ availability: allLive });
    const { callModel } = stubCallModel();
    const result = await runQualityGate({
      input: "const ok = true",
      criteria: "correctness",
      label: "panel-wired",
      profile: profile(),
      personaPanel: panel,
      callModel,
    });
    expect(result.personaPanelState).not.toBeNull();
    expect(result.personaPanelState?.diversityAxis).toBe("persona");
    expect(result.personaPanelState?.panelHash).toBe(panel.panelHash);
    expect(result.personaPanelState?.readiness.ready).toBe(true);
  });

  test("a held seat forces HOLD before any model is called", async () => {
    const panel = buildPersonaPanel({ availability: nothingLive });
    const { callModel, calls } = stubCallModel();
    const result = await runQualityGate({
      input: "const secret = true",
      criteria: "correctness",
      label: "held-panel",
      profile: profile(),
      personaPanel: panel,
      callModel,
    });
    expect(result.decision).toBe("HOLD");
    expect(result.reviewers).toEqual([]);
    expect(result.adjudication).toBeNull();
    // No review happened, so no code may have left the gate.
    expect(calls()).toBe(0);
    expect(result.personaPanelState?.readiness.heldSeats).toEqual([
      "reviewer-1",
      "reviewer-2",
      "reviewer-3",
      "adjudicator",
    ]);
  });

  test("a single dead harness degrades a seat instead of holding the panel", async () => {
    const oneLive: AvailabilityMap = { "claude-code": { registered: true, executable: true } };
    const panel = buildPersonaPanel({ availability: oneLive });
    const state = gatePanelState(panel);
    expect(state.readiness.ready).toBe(true);
    expect(state.readiness.decision).toBe("REVIEW");
    expect(state.readiness.degradedSeats.length).toBeGreaterThan(0);
  });

  test("persona axis replaces the model-family axis when a panel is supplied", async () => {
    const panel = buildPersonaPanel({ availability: allLive });
    const { callModel } = stubCallModel();
    const result = await runQualityGate({
      input: "const ok = true",
      criteria: "correctness",
      label: "persona-axis",
      profile: profile(),
      personaPanel: panel,
      callModel,
    });
    // The model-keyed profile has three distinct families here, but the gate must
    // not be leaning on that as its independence claim once a panel exists.
    expect(result.independence.axis).toBe("persona");
    expect(result.independence.personasDistinct).toBe(true);
    expect(result.automaticApprovalEligible).toBe(true);
  });

  test("without a panel the legacy model-keyed axis is preserved", async () => {
    const { callModel } = stubCallModel();
    const result = await runQualityGate({
      input: "const ok = true",
      criteria: "correctness",
      label: "legacy-axis",
      profile: profile(),
      callModel,
    });
    expect(result.independence.axis).toBe("model-family");
    expect(result.personaPanelState).toBeNull();
    expect(result.independence.configuredFamiliesDistinct).toBe(true);
  });

  test("a tampered panel cannot pass structural validation", () => {
    const panel = buildPersonaPanel({ availability: allLive });
    panel.reviewers[1].personaId = panel.reviewers[0].personaId;
    const state = gatePanelState(panel);
    expect(state.structurallyValid).toBe(false);
    expect(state.readiness.ready).toBe(false);
    expect(state.readiness.decision).toBe("HOLD");
  });

  test("the panel never leaves shadow mode on its own", async () => {
    const panel = buildPersonaPanel({ availability: allLive });
    const { callModel } = stubCallModel();
    const result = await runQualityGate({
      input: "const ok = true",
      criteria: "correctness",
      label: "shadow",
      profile: profile(),
      personaPanel: panel,
      callModel,
    });
    expect(result.profileStatus).toBe("shadow");
    expect(result.enforcement).toBe("disabled");
    expect(result.personaPanelState?.panelStatus).toBe("shadow");
  });
});
