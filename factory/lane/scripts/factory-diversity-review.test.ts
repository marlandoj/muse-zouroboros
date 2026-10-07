import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareFactoryDiversityReview } from "./factory-diversity-review";
import type { PersonaCallRequest, PersonaOrchestratorDeps } from "./persona-orchestrator";
import type { SpecialistReviewerPolicy } from "../../../packages/zo-swarm-orchestrator/src/persona/specialist-consult";

const KIMI_MODEL = "byok:463350ac-4a49-4ceb-8653-042ecffa513f";
// Reviewer identity is a policy input, never a constant. Pinning a specific
// default left this suite red on main twice: #635 retired Claude Code Opus 4.8
// after its BYOK config was deleted, and the successor pin would rot the same
// way on the next rotation. Cases that assert *which* model reviewed inject the
// policy below; the compiled default pool is covered by an invariant test that
// asserts independence rather than identity.
const REVIEWER_POLICY: SpecialistReviewerPolicy = {
  candidates: [
    { modelName: KIMI_MODEL, vendor: "moonshot" },
    { modelName: "byok:test-independent-reviewer", vendor: "openai" },
  ],
};
const EXPECTED_REVIEWER_MODEL = "byok:test-independent-reviewer";
const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function artifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-diversity-review-"));
  directories.push(dir);
  return dir;
}

function persona(id: string, name: string): string {
  return `id='${id}' name='${name}' prompt='not persisted' model='persona-default' scopes=['all'] updated_at=None`;
}

function directory(): string[] {
  return [
    persona("zouro-id", "Zouroboros Engineer"),
    persona("reality-id", "Testing Reality Checker"),
    persona("ai-id", "AI Engineer"),
    persona("security-id", "Security Engineer"),
  ];
}

function deps(
  mode: "shadow" | "enforce",
  calls: PersonaCallRequest[],
  verdictFor: (request: PersonaCallRequest) => "pass" | "fail" = () => "pass",
  // `null` opts out of injection so the case exercises the compiled default pool;
  // `undefined` would silently fall back to this default parameter instead.
  reviewer_policy: SpecialistReviewerPolicy | null = REVIEWER_POLICY,
): PersonaOrchestratorDeps {
  return {
    mode,
    reviewer_policy: reviewer_policy ?? undefined,
    artifact_dir: artifactDir(),
    now: () => "2026-08-21T12:00:00.000Z",
    list_personas: async () => directory(),
    invoke_persona: async (request) => {
      calls.push(request);
      const verdict = verdictFor(request);
      return {
        output: JSON.stringify({ verdict, summary: `${request.persona_id} ${verdict}` }),
        model_name: request.model_name,
        cost_usd: 0.01,
      };
    },
  };
}

function input(overrides: Partial<Parameters<typeof prepareFactoryDiversityReview>[0]> = {}) {
  return {
    execution_id: "exec-diversity-1",
    ticket_id: "linear-1",
    identifier: "ZOU-1479",
    title: "Replace Factory consensus",
    description: "Use deterministic persona review for the Factory",
    seed_path: null,
    risk_tier: "medium",
    target_repository: "/home/workspace/zouroboros",
    implementer_model_name: KIMI_MODEL,
    implementer_vendor: "moonshot",
    ...overrides,
  };
}

describe("factory diversity review", () => {
  test("off returns a clean no-review without resolving personas", async () => {
    let directoryCalls = 0;
    const prepared = await prepareFactoryDiversityReview(input({
      deps: { mode: "off", list_personas: async () => { directoryCalls++; return directory(); } },
    }));
    expect(prepared).toBeNull();
    expect(directoryCalls).toBe(0);
  });

  test("shadow selects bounded default reviewers without invoking them", async () => {
    const calls: PersonaCallRequest[] = [];
    const prepared = await prepareFactoryDiversityReview(input({ deps: deps("shadow", calls) }));
    expect(prepared?.source).toBe("factory-default");
    expect(prepared?.record.invocations.map((entry) => entry.persona_name)).toEqual([
      "Zouroboros Engineer",
      "Testing Reality Checker",
    ]);
    const result = await prepared!.run({
      implementation_summary: "implemented",
      deterministic_pass: true,
      deterministic_summary: "clean",
    });
    expect(calls).toHaveLength(0);
    expect(result.terminal_state).toBe("shadow");
    expect(result.required_count).toBe(2);
    expect(result.new_cost_usd).toBe(0);
  });

  test("AI and security context adds only the applicable specialist personas", async () => {
    const calls: PersonaCallRequest[] = [];
    const prepared = await prepareFactoryDiversityReview(input({
      title: "Secure RAG model tokens",
      description: "Audit retrieval prompt injection, authentication, privacy, and secret handling",
      risk_tier: "high",
      deps: deps("shadow", calls),
    }));
    expect(prepared?.record.invocations.map((entry) => entry.persona_name)).toEqual([
      "Zouroboros Engineer",
      "Testing Reality Checker",
      "AI Engineer",
      "Security Engineer",
    ]);
  });

  test("enforce passes only after every required independent persona approves", async () => {
    const calls: PersonaCallRequest[] = [];
    const prepared = await prepareFactoryDiversityReview(input({ deps: deps("enforce", calls) }));
    const result = await prepared!.run({
      implementation_summary: "implemented",
      deterministic_pass: true,
      deterministic_summary: "clean",
    });
    expect(result.pass).toBe(true);
    expect(result.terminal_state).toBe("pass");
    expect(result.invoked_count).toBe(2);
    expect(result.reviews.every((review) => review.model_name === EXPECTED_REVIEWER_MODEL)).toBe(true);
    expect(result.reviews.every((review) => review.vendor_diverse === true)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  test("the compiled default reviewer pool still yields an independent reviewer", async () => {
    const calls: PersonaCallRequest[] = [];
    const prepared = await prepareFactoryDiversityReview(input({
      deps: deps("enforce", calls, () => "pass", null),
    }));
    const result = await prepared!.run({
      implementation_summary: "implemented",
      deterministic_pass: true,
      deterministic_summary: "clean",
    });
    expect(result.pass).toBe(true);
    expect(result.reviews).not.toHaveLength(0);
    for (const review of result.reviews) {
      expect(review.model_name).not.toBe(KIMI_MODEL);
      expect(review.distinct_model).toBe(true);
      expect(review.vendor_diverse).toBe(true);
      expect(review.model_vendor).not.toBe("moonshot");
    }
  });

  test("one required dissent deterministically holds the execution", async () => {
    const calls: PersonaCallRequest[] = [];
    const prepared = await prepareFactoryDiversityReview(input({
      deps: deps("enforce", calls, (request) => request.persona_id === "reality-id" ? "fail" : "pass"),
    }));
    const result = await prepared!.run({
      implementation_summary: "implemented",
      deterministic_pass: true,
      deterministic_summary: "clean",
    });
    expect(result.pass).toBe(false);
    expect(result.terminal_state).toBe("hold");
    expect(result.dissent_count).toBe(1);
    expect(result.summary).toContain("reality-check did not pass");
  });
});
