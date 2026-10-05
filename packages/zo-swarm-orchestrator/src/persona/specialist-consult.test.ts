import { describe, expect, test } from "bun:test";
import {
  consultSpecialists,
  parseSpecialistReviewVerdict,
  renderSpecialistOutputs,
  selectIndependentReviewerModel,
  resolveSpecialistConsultMode,
  resolveZoAskAuthorization,
  resolveSpecialistReviewerCandidates,
  DEFAULT_SPECIALIST_REVIEWER_MODELS,
  SPECIALIST_REVIEWER_MODELS_ENV,
  type SpecialistAssignment,
} from "./specialist-consult";

const assignment: SpecialistAssignment = {
  roleId: "mobile-experience-reviewer",
  personaName: "Mobile App Builder",
  required: true,
  phases: ["advise", "review"],
  requiredScopes: ["files:read"],
};

function directory(name = "Mobile App Builder"): () => Promise<unknown> {
  return async () => JSON.stringify([
    `Persona(id='b8c64600-9c6e-43ad-88cf-2d7d5f6b650c', name='${name}', model='byok:test-model', scopes=['all'], updated_at=None)`,
  ]);
}

describe("specialist consultation", () => {
  test("off mode performs no directory or persona calls", async () => {
    let calls = 0;
    const result = await consultSpecialists({
      mode: "off",
      phase: "advise",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      assignments: [assignment],
      listPersonas: async () => { calls++; return []; },
      invokePersona: async () => { calls++; throw new Error("must not run"); },
    });
    expect(result.ok).toBe(true);
    expect(result.evidence).toEqual([]);
    expect(calls).toBe(0);
  });

  test("shadow mode resolves exact identity and spends nothing", async () => {
    let invokes = 0;
    const result = await consultSpecialists({
      mode: "shadow",
      phase: "advise",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      assignments: [assignment],
      listPersonas: directory(),
      invokePersona: async () => { invokes++; throw new Error("must not run"); },
    });
    expect(result.ok).toBe(true);
    expect(result.totalCostUsd).toBe(0);
    expect(result.evidence[0]).toMatchObject({
      personaName: "Mobile App Builder",
      status: "would_invoke",
    });
    expect(invokes).toBe(0);
  });

  test("enforce mode invokes a distinct persona with an explicit model", async () => {
    const requests: Array<{ personaId: string; modelName: string; input: string }> = [];
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "advise",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      assignments: [assignment],
      modelName: "byok:frontier-coder",
      listPersonas: directory(),
      invokePersona: async (request) => {
        requests.push(request);
        return { output: "Use safe-area insets and verify touch targets.", modelName: request.modelName, costUsd: 0.01 };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.totalCostUsd).toBe(0.01);
    expect(requests).toHaveLength(1);
    expect(requests[0].modelName).toBe("byok:frontier-coder");
    expect(requests[0].input).toContain("primary executor retains implementation authority");
    expect(renderSpecialistOutputs(result)).toContain("safe-area insets");
  });

  test("required missing specialists fail closed only in enforce mode", async () => {
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [assignment],
      listPersonas: directory("Different Persona"),
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toContain("not found");
    expect(result.evidence[0].status).toBe("blocked");
  });

  test("required review failures block with strict parsed verdict evidence", async () => {
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [assignment],
      implementerModelName: "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51",
      listPersonas: directory(),
      invokePersona: async (request) => ({
        output: '{"verdict":"fail","summary":"Touch targets remain below 44px."}',
        modelName: request.modelName,
        costUsd: 0.02,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toContain("Touch targets");
    expect(result.evidence[0]).toMatchObject({
      status: "invoked",
      verdict: "fail",
      modelVendor: "moonshot",
      implementerVendor: "openai",
      distinctModel: true,
      vendorDiverse: true,
    });
  });

  test("strict passing review uses a vendor-diverse model and permits completion", async () => {
    const requests: string[] = [];
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [assignment],
      implementerModelName: "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51",
      listPersonas: directory(),
      invokePersona: async (request) => {
        requests.push(request.modelName);
        return {
          output: '{"verdict":"pass","summary":"No material mobile defects remain."}',
          modelName: request.modelName,
          costUsd: 0.01,
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(requests).toEqual(["byok:463350ac-4a49-4ceb-8653-042ecffa513f"]);
    expect(result.evidence[0].verdict).toBe("pass");
  });

  test("malformed required review verdict blocks even after a successful call", async () => {
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [assignment],
      implementerModelName: "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51",
      listPersonas: directory(),
      invokePersona: async (request) => ({ output: "PASS", modelName: request.modelName, costUsd: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toContain("JSON");
    expect(result.evidence[0].status).toBe("invoked");
    expect(result.evidence[0].verdict).toBeNull();
  });

  test("optional specialist review failures are recorded without blocking completion", async () => {
    const optionalAssignment = { ...assignment, required: false };
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [optionalAssignment],
      implementerModelName: "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51",
      listPersonas: directory(),
      invokePersona: async (request) => ({
        output: '{"verdict":"fail","summary":"A non-blocking polish issue remains."}',
        modelName: request.modelName,
        costUsd: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.blockedReason).toBeNull();
    expect(result.evidence[0]).toMatchObject({
      required: false,
      verdict: "fail",
      reason: "A non-blocking polish issue remains.",
    });
  });

  test("fails closed when the served reviewer model collapses onto the implementer", async () => {
    const implementerModelName = "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51";
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [assignment],
      implementerModelName,
      listPersonas: directory(),
      invokePersona: async () => ({
        output: '{"verdict":"pass","summary":"No material defects remain."}',
        modelName: implementerModelName,
        costUsd: 0,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toContain("matches implementer model");
    expect(result.evidence[0]).toMatchObject({
      verdict: "pass",
      distinctModel: false,
      vendorDiverse: false,
    });
  });

  test("fails closed when no reviewer model can be independent", async () => {
    const result = await consultSpecialists({
      mode: "enforce",
      phase: "review",
      taskId: "task-1",
      task: "Build a mobile-first web app",
      implementationOutput: "done",
      assignments: [assignment],
      implementerModelName: "byok:only",
      implementerVendor: "openai",
      reviewerPolicy: { candidates: [{ modelName: "byok:only", vendor: "openai" }] },
      listPersonas: directory(),
    });
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toContain("no specialist reviewer model satisfies");
  });

  test("reviewer selection and strict verdict parsing are deterministic", () => {
    expect(selectIndependentReviewerModel({
      implementerModelName: "byok:0a635de6-5e45-4a8a-8e73-f1d25f31fd96",
    })).toMatchObject({ vendor: "openai", distinctModel: true, vendorDiverse: true });
    expect(parseSpecialistReviewVerdict('```json\n{"verdict":"pass","summary":"clean"}\n```'))
      .toEqual({ verdict: "pass", summary: "clean" });
  });

  test("rejects invalid environment modes", () => {
    expect(() => resolveSpecialistConsultMode("active")).toThrow("off|shadow|enforce");
  });

  test("uses raw identity-token auth and bearer API-key fallback", () => {
    expect(resolveZoAskAuthorization({
      ZO_CLIENT_IDENTITY_TOKEN: "identity-token",
      ZO_API_KEY: "api-key",
    })).toBe("identity-token");
    expect(resolveZoAskAuthorization({ ZO_API_KEY: "api-key" })).toBe("Bearer api-key");
    expect(() => resolveZoAskAuthorization({})).toThrow("not set");
  });
});

describe("specialist reviewer candidate resolution (ZOU-1571)", () => {
  test("defaults exclude retired BYOK configs and span three vendors", () => {
    const retired = [
      "byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0",
      "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
      "byok:ef1faca8-a70d-46d3-88d3-b78f96635885",
      "byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e",
    ];
    const names = DEFAULT_SPECIALIST_REVIEWER_MODELS.map((m) => m.modelName);
    for (const dead of retired) expect(names).not.toContain(dead);
    expect(new Set(DEFAULT_SPECIALIST_REVIEWER_MODELS.map((m) => m.vendor)).size).toBe(3);
  });

  test("every vendor in the default pool can review every other vendor's implementer", () => {
    for (const implementer of DEFAULT_SPECIALIST_REVIEWER_MODELS) {
      const selection = selectIndependentReviewerModel({ implementerModelName: implementer.modelName });
      expect(selection.vendor).not.toBe(implementer.vendor);
      expect(selection.modelName).not.toBe(implementer.modelName);
    }
  });

  test("operator override replaces the pool and infers vendors", () => {
    const candidates = resolveSpecialistReviewerCandidates({
      [SPECIALIST_REVIEWER_MODELS_ENV]: "byok:463350ac-4a49-4ceb-8653-042ecffa513f, zo:claude-opus-4-8:anthropic",
    });
    expect(candidates).toEqual([
      { modelName: "byok:463350ac-4a49-4ceb-8653-042ecffa513f", vendor: "moonshot" },
      { modelName: "zo:claude-opus-4-8", vendor: "anthropic" },
    ]);
  });

  test("blank, malformed, and unresolvable overrides fall back to the defaults", () => {
    expect(resolveSpecialistReviewerCandidates({})).toEqual(DEFAULT_SPECIALIST_REVIEWER_MODELS);
    expect(resolveSpecialistReviewerCandidates({ [SPECIALIST_REVIEWER_MODELS_ENV]: "  " }))
      .toEqual(DEFAULT_SPECIALIST_REVIEWER_MODELS);
    expect(resolveSpecialistReviewerCandidates({ [SPECIALIST_REVIEWER_MODELS_ENV]: " , ," }))
      .toEqual(DEFAULT_SPECIALIST_REVIEWER_MODELS);
    expect(resolveSpecialistReviewerCandidates({ [SPECIALIST_REVIEWER_MODELS_ENV]: "mystery-model" }))
      .toEqual(DEFAULT_SPECIALIST_REVIEWER_MODELS);
  });
});
