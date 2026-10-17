import { describe, expect, test } from "bun:test";
import { createHarnessSeatCallModel, type SeatClient } from "./panel-seat-executor";
import type { PersonaPanelArtifact } from "./persona-panel";

function seat(name: string, harness: string | null, personaName: string, domain: string) {
  return {
    seat: name,
    role: name === "adjudicator" ? "adjudicator" : "reviewer",
    personaId: `uuid-${name}`,
    personaName,
    domain,
    binding: { harness: harness ?? "gemini", chain: [harness ?? "gemini", "claude-code"] },
    executionModel: "byok:ignored",
    resolvedHarness: harness,
    degraded: false,
  };
}

function fakePanel(reviewer3Harness: string | null = "claude-code"): PersonaPanelArtifact {
  return {
    schemaVersion: 2,
    profile: "consensus-persona-panel",
    topology: "three-persona-reviewers-plus-independent-adjudicator",
    diversityAxis: "persona",
    status: "shadow",
    valid: true,
    generatedAt: new Date().toISOString(),
    reviewers: [
      seat("reviewer-1", "claude-code", "AI Engineer", "ai-systems"),
      seat("reviewer-2", "codex", "Zouroboros Engineer", "governance-and-orchestration"),
      seat("reviewer-3", reviewer3Harness, "Security Engineer", "security-and-adversarial-review"),
    ],
    adjudicator: seat("adjudicator", "hermes", "Reality Checker", "evidence-certification"),
    policy: {},
    harnessAvailability: {},
  } as unknown as PersonaPanelArtifact;
}

function recordingFactory(calls: Array<{ harness: string; prompt: string; opts: Record<string, unknown> }>, output = '{"verdict":"PASS","findings":[],"confidence":1,"unresolvedAssumptions":[]}') {
  return async (harness: string): Promise<SeatClient> => ({
    async run(prompt: string, opts: Record<string, unknown>) {
      calls.push({ harness, prompt, opts });
      return { output, success: true, durationMs: 12 };
    },
  });
}

describe("harness seat executor", () => {
  test("routes a reviewer seat to its resolved harness with persona identity", async () => {
    const calls: Array<{ harness: string; prompt: string; opts: Record<string, unknown> }> = [];
    const callModel = createHarnessSeatCallModel({ panel: fakePanel(), clientFactory: recordingFactory(calls) });
    const result = await callModel("byok:ignored", "review this", {
      maxTokens: 512,
      temperature: 0,
      seat: { seat: "reviewer-1", role: "reviewer" },
    });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("harness:claude-code");
    expect(result.text).toContain('"verdict":"PASS"');
    expect(calls).toHaveLength(1);
    expect(calls[0].harness).toBe("claude-code");
    expect(calls[0].opts.persona).toBe("AI Engineer");
    expect(calls[0].opts.seat).toBe("reviewer-1");
    expect(calls[0].opts.skipRAG).toBe(true);
    expect(calls[0].prompt).toContain("AI Engineer");
  });

  test("routes the adjudicator to its own harness", async () => {
    const calls: Array<{ harness: string; prompt: string; opts: Record<string, unknown> }> = [];
    const callModel = createHarnessSeatCallModel({ panel: fakePanel(), clientFactory: recordingFactory(calls, '{"classification":"INSUFFICIENT","rationale":"probe","evidence":[],"confidence":1}') });
    const result = await callModel("byok:ignored", "adjudicate", {
      maxTokens: 512,
      temperature: 0,
      seat: { seat: "adjudicator", role: "adjudicator" },
    });
    expect(result.ok).toBe(true);
    expect(calls[0].harness).toBe("hermes");
  });

  test("held seat returns ok:false without invoking any harness", async () => {
    const calls: Array<{ harness: string; prompt: string; opts: Record<string, unknown> }> = [];
    const callModel = createHarnessSeatCallModel({ panel: fakePanel(null), clientFactory: recordingFactory(calls) });
    const result = await callModel("byok:ignored", "review", {
      maxTokens: 512,
      temperature: 0,
      seat: { seat: "reviewer-3", role: "reviewer" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("held");
    expect(calls).toHaveLength(0);
  });

  test("unknown seat and missing seat context fail closed", async () => {
    const callModel = createHarnessSeatCallModel({ panel: fakePanel(), clientFactory: recordingFactory([]) });
    const unknown = await callModel("m", "p", { maxTokens: 1, temperature: 0, seat: { seat: "reviewer-9", role: "reviewer" } });
    expect(unknown.ok).toBe(false);
    const missing = await callModel("m", "p", { maxTokens: 1, temperature: 0 });
    expect(missing.ok).toBe(false);
  });

  test("harness exceptions and empty output become ok:false, never throw", async () => {
    const throwing = createHarnessSeatCallModel({
      panel: fakePanel(),
      clientFactory: async () => {
        throw new Error("registry exploded");
      },
    });
    const thrown = await throwing("m", "p", { maxTokens: 1, temperature: 0, seat: { seat: "reviewer-2", role: "reviewer" } });
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toContain("registry exploded");

    const empty = createHarnessSeatCallModel({
      panel: fakePanel(),
      clientFactory: async (): Promise<SeatClient> => ({
        async run() {
          return { output: "  ", success: true, durationMs: 1 };
        },
      }),
    });
    const blank = await empty("m", "p", { maxTokens: 1, temperature: 0, seat: { seat: "reviewer-2", role: "reviewer" } });
    expect(blank.ok).toBe(false);
    expect(blank.error).toContain("empty output");
  });
});
