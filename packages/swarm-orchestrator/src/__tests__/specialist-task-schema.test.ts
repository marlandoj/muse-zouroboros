import { describe, expect, test } from "bun:test";
import { validateTask, validateTaskResult } from "../schemas/swarm-schemas";

describe("specialist task schema", () => {
  test("accepts bounded explicit specialist assignments", () => {
    const task = validateTask({
      id: "mobile-web",
      persona: "claude-code",
      task: "Implement the mobile-first experience",
      priority: "high",
      specialistMode: "shadow",
      specialists: [{
        roleId: "mobile-experience-reviewer",
        personaName: "Mobile App Builder",
        required: false,
        phases: ["advise", "review"],
        requiredScopes: ["files:read"],
      }],
    });
    expect(task.specialistMode).toBe("shadow");
    expect(task.specialists?.[0].personaName).toBe("Mobile App Builder");
  });

  test("rejects unknown modes, phases, fields, and oversized fleets", () => {
    const base = {
      id: "mobile-web",
      persona: "claude-code",
      task: "Implement",
      priority: "high",
    };
    expect(() => validateTask({ ...base, specialistMode: "active" })).toThrow("invalid value");
    expect(() => validateTask({
      ...base,
      specialists: [{ roleId: "r", personaName: "P", required: true, phases: ["deploy"] }],
    })).toThrow("invalid value");
    expect(() => validateTask({
      ...base,
      specialists: [{ roleId: "r", personaName: "P", required: true, phases: ["advise"], uuid: "forbidden" }],
    })).toThrow("unknown field");
    expect(() => validateTask({
      ...base,
      specialists: Array.from({ length: 9 }, (_, index) => ({
        roleId: `r-${index}`,
        personaName: `P ${index}`,
        required: false,
        phases: ["advise"],
      })),
    })).toThrow("exceeds maximum");
  });

  test("preserves consultation evidence across task-result validation", () => {
    const task = {
      id: "mobile-web",
      persona: "claude-code",
      task: "Implement",
      priority: "high",
    };
    const result = validateTaskResult({
      task,
      success: true,
      durationMs: 1,
      retries: 0,
      specialistCostUsd: 0,
      specialistEvidence: [{ status: "would_invoke", personaName: "Mobile App Builder" }],
    });
    expect(result.specialistEvidence?.[0].status).toBe("would_invoke");
    expect(result.specialistCostUsd).toBe(0);
  });
});
