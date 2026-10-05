import { describe, expect, test } from "bun:test";
import { executeLineupRole, parseLineupRoleConfig } from "../../../Skills/consensus-gate/scripts/lineup-roles";
import { applyModelPolicy, parseModelPolicy } from "./model-policy";

const routine = {
  proposers: [
    { primary: "byok:claude-fable-5", fallbacks: ["oc:claude-fable-5", "or:anthropic/claude-fable-5"] },
    { primary: "byok:gpt-5.6-sol", fallbacks: ["oc:gpt-5.6-sol", "or:openai/gpt-5.6-sol"] },
    { primary: "hf:MiniMaxAI/MiniMax-M3", fallbacks: ["oc:minimax-m3", "or:minimax/minimax-m3"] },
  ],
  aggregator: { primary: "hf:zai-org/GLM-5.2", fallbacks: ["oc:glm-5.2", "or:z-ai/glm-5.2"] },
};

const reasoning = {
  proposers: [
    { primary: "byok:claude-fable-5", fallbacks: ["oc:claude-fable-5", "or:anthropic/claude-fable-5"] },
    { primary: "byok:gpt-5.6-sol", fallbacks: ["oc:gpt-5.6-sol", "or:openai/gpt-5.6-sol"] },
    { primary: "hf:moonshotai/Kimi-K2.7-Code", fallbacks: ["oc:kimi-k2.7-code", "or:moonshotai/kimi-k2.7-code"] },
  ],
  aggregator: { primary: "hf:zai-org/GLM-5.2", fallbacks: ["oc:glm-5.2", "or:z-ai/glm-5.2"] },
};

function ticket(tier: string, config: typeof routine) {
  return `## Model Policy (Ori-scoped)

Tier: **${tier}**

\`\`\`bash
LINEUP_PIN_PROPOSERS="${config.proposers.map((role) => role.primary).join(",")}"
LINEUP_PIN_AGGREGATOR="${config.aggregator.primary}"
LINEUP_ROLE_CHAINS='${JSON.stringify(config)}'
\`\`\``;
}

async function dryRun(description: string) {
  const priorAuthorization = process.env.FACTORY_MODEL_REVIEW;
  process.env.FACTORY_MODEL_REVIEW = "operator";
  const policy = parseModelPolicy(description)!;
  const applied = applyModelPolicy(policy);
  try {
    const config = parseLineupRoleConfig(process.env.LINEUP_ROLE_CHAINS!);
    const roles = [...config.proposers, config.aggregator];
    return Promise.all(roles.map(async (role) => {
      let calls = 0;
      return executeLineupRole(
        role,
        async (id) => ({ id, failed: calls++ === 0 }),
        (value) => value.failed,
        (value) => value.failed ? "injected primary-provider failure" : undefined,
      );
    }));
  } finally {
    applied.restore();
    if (priorAuthorization === undefined) delete process.env.FACTORY_MODEL_REVIEW;
    else process.env.FACTORY_MODEL_REVIEW = priorAuthorization;
  }
}

describe("Ori policy dry-run", () => {
  test("Routine and Reasoning tickets fail over every seat and restore scope", async () => {
    const before = process.env.LINEUP_ROLE_CHAINS;
    for (const [tier, config] of [["Routine", routine], ["Reasoning-heavy", reasoning]] as const) {
      const results = await dryRun(ticket(tier, config));
      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result.attempts).toHaveLength(2);
        expect(result.attempts[0].ok).toBe(false);
        expect(result.attempts[1].ok).toBe(true);
        expect(result.servingModel).toBe(result.role.fallbacks[0].startsWith("byok:")
          ? result.attempts[1].resolvedId
          : result.role.fallbacks[0]);
      }
      expect(process.env.LINEUP_ROLE_CHAINS).toBe(before);
    }
  });
});
