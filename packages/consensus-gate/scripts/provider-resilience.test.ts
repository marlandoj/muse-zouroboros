import { describe, expect, test } from "bun:test";
import {
  buildProviderFallbackChain,
  providerForConsensusModel,
  selectProviderBalancedFallback,
  type ProviderCatalogSet,
  type ResilientModel,
} from "./provider-resilience";

const model = (id: string, provider: ResilientModel["provider"], family: string, tier: ResilientModel["tier"], label?: string): ResilientModel => ({
  id, provider, family, tier, label,
});

const catalogs: ProviderCatalogSet = {
  synthetic: [
    model("hf:zai-org/GLM-5.2", "synthetic", "glm", "flagship"),
    model("hf:moonshotai/Kimi-K2.7-Code", "synthetic", "kimi", "flagship"),
    model("hf:openai/gpt-oss-120b", "synthetic", "gpt", "fast"),
  ],
  openrouter: [
    model("z-ai/glm-5.2", "openrouter", "glm", "flagship"),
    model("moonshotai/kimi-k2.7-code", "openrouter", "kimi", "coder"),
    model("x-ai/grok-4.5", "openrouter", "grok", "flagship"),
    model("cohere/north-mini-code:free", "openrouter", "north", "coder"),
  ],
  opencode: [
    model("oc:glm-5.2", "opencode", "glm", "flagship"),
    model("oc:kimi-k2.7-code", "opencode", "kimi", "coder"),
    model("oc:grok-4.5", "opencode", "grok", "flagship"),
    model("oc:north-mini-code-free", "opencode", "north", "coder"),
  ],
  byok: [
    model("byok:glm", "zo-byok", "glm", "flagship", "Synthetic GLM-5.2"),
    model("byok:kimi", "zo-byok", "kimi", "coder", "Kimi K2.7-Code"),
    model("byok:claude", "zo-byok", "claude", "flagship", "Claude Code Sonnet 4.6"),
  ],
  kimi: [
    model("kimi:kimi-k3", "kimi", "kimi", "flagship", "Kimi K3"),
    model("kimi:kimi-k2.7-code", "kimi", "kimi", "coder", "Kimi K2.7 Code"),
  ],
};

describe("provider resilience", () => {
  const firstByProvider = (chain: ResilientModel[]) => new Map(chain.map((candidate) => [candidate.provider, candidate]));

  test("recognizes every consensus provider namespace", () => {
    expect(providerForConsensusModel("byok:id")).toBe("zo-byok");
    expect(providerForConsensusModel("z-ai/glm-5.2")).toBe("openrouter");
    expect(providerForConsensusModel("oc:glm-5.2")).toBe("opencode");
    expect(providerForConsensusModel("hf:zai-org/GLM-5.2")).toBe("synthetic");
    expect(providerForConsensusModel("xai:grok-3-mini")).toBe("xai");
    expect(providerForConsensusModel("kimi:kimi-k3")).toBe("kimi");
  });

  test("GLM keeps identity across BYOK, OpenRouter, and OpenCode", () => {
    const chain = buildProviderFallbackChain("hf:zai-org/GLM-5.2", catalogs, {});
    const first = firstByProvider([...chain].reverse());
    expect(first.get("zo-byok")?.id).toBe("byok:glm");
    expect(first.get("openrouter")?.id).toBe("z-ai/glm-5.2");
    expect(first.get("opencode")?.id).toBe("oc:glm-5.2");
    expect(chain.filter((candidate) => candidate.provider === "opencode")).toHaveLength(2);
  });

  test("BYOK seats receive OpenRouter, OpenCode, and Synthetic fallbacks", () => {
    const chain = buildProviderFallbackChain("byok:kimi", catalogs, {});
    const first = firstByProvider([...chain].reverse());
    expect(first.get("openrouter")?.id).toBe("moonshotai/kimi-k2.7-code");
    expect(first.get("opencode")?.id).toBe("oc:kimi-k2.7-code");
    expect(first.get("synthetic")?.id).toBe("hf:moonshotai/Kimi-K2.7-Code");
    expect(first.get("kimi")?.id).toBe("kimi:kimi-k2.7-code");
  });

  test("xAI seats fall back through all four independent provider pools", () => {
    const chain = buildProviderFallbackChain("xai:grok-3-mini", catalogs, {});
    const first = firstByProvider([...chain].reverse());
    expect([...first.keys()].sort()).toEqual(["kimi", "opencode", "openrouter", "synthetic", "zo-byok"]);
    expect(first.get("openrouter")?.family).toBe("grok");
    expect(first.get("opencode")?.family).toBe("grok");
  });

  test("adaptive selection visits each provider before repeating a pool", () => {
    const chain = [
      "byok:glm",
      "z-ai/glm-5.2",
      "oc:glm-5.2",
      "byok:claude",
      "x-ai/grok-4.5",
      "oc:grok-4.5",
    ];
    const attempted = new Set<string>();
    const providerAttempts = new Map<ResilientModel["provider"], number>([["synthetic", 1]]);
    const selected: string[] = [];
    for (let index = 0; index < 3; index++) {
      const next = selectProviderBalancedFallback(chain, attempted, providerAttempts);
      expect(next).toBeDefined();
      attempted.add(next!);
      selected.push(next!);
      const provider = providerForConsensusModel(next!);
      providerAttempts.set(provider, (providerAttempts.get(provider) ?? 0) + 1);
    }
    expect(selected.map(providerForConsensusModel)).toEqual(["zo-byok", "openrouter", "opencode"]);
  });
});
