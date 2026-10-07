import { describe, expect, test } from "bun:test";
import {
  canonicalModelFamily,
  resolveByokAlias,
  resolveModelIdentity,
  providerForModelId,
  sameCanonicalModel,
  stableByokAlias,
} from "./model-identity";

const registry = [
  { id: "byok:uuid-1", label: "Claude Code Fable 5", family: "claude" },
  { id: "byok:uuid-2", label: "Codex GPT 5.6 Sol", family: "gpt" },
];

describe("canonical model identity", () => {
  test("normalizes provider organizations to model families", () => {
    expect(canonicalModelFamily("or:anthropic/claude-fable-5")).toBe("claude");
    expect(canonicalModelFamily("or:openai/gpt-5.6-sol")).toBe("gpt");
    expect(canonicalModelFamily("hf:zai-org/GLM-5.2")).toBe("glm");
    expect(canonicalModelFamily("or:moonshotai/kimi-k2.7-code")).toBe("kimi");
    expect(canonicalModelFamily("kimi:kimi-k3")).toBe("kimi");
    expect(canonicalModelFamily("or:x-ai/grok-4.5")).toBe("grok");
    expect(canonicalModelFamily("hf:MiniMaxAI/MiniMax-M3")).toBe("minimax");
  });

  test("recognizes the direct Kimi provider namespace", () => {
    expect(providerForModelId("kimi:kimi-k3")).toBe("kimi");
    expect(sameCanonicalModel("kimi:kimi-k2.7-code", "oc:kimi-k2.7-code")).toBe(true);
  });

  test("recognizes cross-provider twins as one canonical model", () => {
    expect(sameCanonicalModel("hf:zai-org/GLM-5.2", "or:z-ai/glm-5.2")).toBe(true);
    expect(sameCanonicalModel("hf:moonshotai/Kimi-K2.7-Code", "oc:kimi-k2.7-code")).toBe(true);
    expect(sameCanonicalModel("hf:MiniMaxAI/MiniMax-M3", "or:minimax/minimax-m3")).toBe(true);
  });

  test("resolves stable BYOK aliases through rotating registry ids", () => {
    expect(stableByokAlias("Claude Code Fable 5")).toBe("byok:claude-fable-5");
    expect(resolveByokAlias("byok:claude-fable-5", registry)).toBe("byok:uuid-1");
    expect(resolveByokAlias("byok:gpt-5.6-sol", registry)).toBe("byok:uuid-2");
    expect(resolveModelIdentity("byok:claude-fable-5", registry)).toMatchObject({
      resolvedId: "byok:uuid-1",
      family: "claude",
      model: "claude-fable-5",
    });
  });

  test("unknown BYOK aliases do not resolve", () => {
    expect(resolveByokAlias("byok:not-registered", registry)).toBeNull();
  });

  test("alias rotation changes runtime ids without changing policy text", () => {
    const alias = "byok:claude-fable-5";
    expect(resolveByokAlias(alias, registry)).toBe("byok:uuid-1");
    expect(resolveByokAlias(alias, [{ ...registry[0], id: "byok:uuid-rotated" }])).toBe("byok:uuid-rotated");
  });
});
