import { describe, expect, test } from "bun:test";
import {
  executeLineupRole,
  isRetryableVerdictLike,
  normalizeLineupRole,
  parseLineupRoleConfig,
  roleConfigFromEnv,
  validateLineupRole,
} from "./lineup-roles";

const role = {
  primary: "hf:zai-org/GLM-5.2",
  fallbacks: ["oc:glm-5.2", "or:z-ai/glm-5.2"],
};

describe("lineup roles", () => {
  test("keeps bare ids backward compatible", () => {
    expect(normalizeLineupRole("hf:zai-org/GLM-5.2")).toEqual({
      primary: "hf:zai-org/GLM-5.2",
      fallbacks: [],
    });
  });

  test("accepts a provider-diverse same-model chain", () => {
    expect(validateLineupRole(role)).toEqual([]);
  });

  test("rejects duplicate routes and identity changes", () => {
    expect(validateLineupRole({
      primary: "hf:zai-org/GLM-5.2",
      fallbacks: ["hf:zai-org/GLM-5.2", "or:anthropic/claude-fable-5"],
    })).toEqual(expect.arrayContaining([
      "role chain contains duplicate resolved ids",
      "first fallback must use a different provider route from the primary",
      "role chain contains duplicate provider routes",
      "fallback or:anthropic/claude-fable-5 does not preserve canonical model identity",
    ]));
  });

  test("parses the structured env contract", () => {
    const parsed = parseLineupRoleConfig(JSON.stringify({ proposers: [role], aggregator: role }));
    expect(parsed.proposers[0]).toEqual(role);
  });

  test("accepts the approved Routine four-source policy", () => {
    const config = {
      proposers: [
        { primary: "byok:claude-fable-5", fallbacks: ["oc:claude-fable-5", "or:anthropic/claude-fable-5"] },
        { primary: "byok:gpt-5.6-sol", fallbacks: ["oc:gpt-5.6-sol", "or:openai/gpt-5.6-sol"] },
        { primary: "hf:MiniMaxAI/MiniMax-M3", fallbacks: ["oc:minimax-m3", "or:minimax/minimax-m3"] },
      ],
      aggregator: { primary: "hf:zai-org/GLM-5.2", fallbacks: ["oc:glm-5.2", "or:z-ai/glm-5.2"] },
    };
    expect(parseLineupRoleConfig(JSON.stringify(config))).toEqual(config);
  });

  test("primary pins remain the fallback-free compatibility path", () => {
    const parsed = roleConfigFromEnv({
      LINEUP_PIN_PROPOSERS: "oc:a,oc:b",
      LINEUP_PIN_AGGREGATOR: "oc:c",
    }, ["legacy:a"], "legacy:judge");
    expect(parsed).toEqual({
      proposers: [{ primary: "oc:a", fallbacks: [] }, { primary: "oc:b", fallbacks: [] }],
      aggregator: { primary: "oc:c", fallbacks: [] },
    });
  });
});

describe("role chain execution", () => {
  test("classifies every documented failover trigger", () => {
    for (const issue of [
      "API error: 408",
      "API error: 429",
      "API error: 500",
      "API error: 502",
      "API error: 503",
      "API error: 504",
      "API error: 529",
      "Call failed: timeout",
      "Call failed: connection reset",
      "Empty response from vendor",
      'Unparseable verdict (no JSON object with "pass" key)',
    ]) {
      expect(isRetryableVerdictLike({ confidence: 0, issues: [issue] })).toBe(true);
    }
    expect(isRetryableVerdictLike({ confidence: 0.9, issues: ["API error: 503"] })).toBe(false);
  });

  test("fault injection advances every primary route to the same seat on another provider", async () => {
    const roles = [
      { primary: "byok:claude-fable-5", fallbacks: ["oc:claude-fable-5", "or:anthropic/claude-fable-5"] },
      { primary: "hf:zai-org/GLM-5.2", fallbacks: ["oc:glm-5.2", "or:z-ai/glm-5.2"] },
      { primary: "oc:glm-5.2", fallbacks: ["or:z-ai/glm-5.2", "hf:zai-org/GLM-5.2"] },
      { primary: "or:z-ai/glm-5.2", fallbacks: ["oc:glm-5.2", "hf:zai-org/GLM-5.2"] },
    ];
    for (const failure of ["API error: 429", "API error: 503", "Call failed: timeout", "Empty response from vendor", "Unparseable verdict"]) {
      for (const injected of roles) {
        let calls = 0;
        const outcome = await executeLineupRole(
          injected,
          async (id) => ({ confidence: calls++ === 0 ? 0 : 0.9, issues: calls === 1 ? [failure] : [], id }),
          isRetryableVerdictLike,
          (value) => value.issues.join("; "),
        );
        expect(outcome.attempts).toHaveLength(2);
        expect(outcome.attempts[0].provider).not.toBe(outcome.attempts[1].provider);
      }
    }
  });

  test("uses the second hop after a primary failure", async () => {
    const result = await executeLineupRole(role, async (id) => ({ ok: id.startsWith("oc:"), id }), (value) => !value.ok, (value) => value.id);
    expect(result.servingModel).toBe("oc:glm-5.2");
    expect(result.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
  });

  test("uses the third hop after two failures", async () => {
    const result = await executeLineupRole(role, async (id) => ({ ok: id.startsWith("or:"), id }), (value) => !value.ok, (value) => value.id);
    expect(result.servingModel).toBe("or:z-ai/glm-5.2");
    expect(result.attempts).toHaveLength(3);
  });

  test("returns the full trail when every hop fails", async () => {
    const result = await executeLineupRole(role, async (id) => ({ ok: false, id }), (value) => !value.ok, (value) => value.id);
    expect(result.attempts.map((attempt) => attempt.resolvedId)).toEqual([
      "hf:zai-org/GLM-5.2",
      "oc:glm-5.2",
      "or:z-ai/glm-5.2",
    ]);
    expect(result.attempts.every((attempt) => !attempt.ok)).toBe(true);
  });
});
