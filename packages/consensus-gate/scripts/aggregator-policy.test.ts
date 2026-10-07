import { describe, expect, test } from "bun:test";
import { isAggregatorRestrictedFlagship, type ClassifiedModel } from "./catalog";
import { classifyOpenRouterModels } from "./catalog-openrouter";
import { classifyOpencodeModels } from "./catalog-opencode";

// Operator policy: Anthropic and OpenAI frontier models reach the gate through
// BYOK only; Opencode and OpenRouter must not surface them. The filter is the
// sole enforcement point — a blocked model never enters the cache, so it can
// never be picked. These tests exist so a refactor cannot silently drop it.

const ids = (models: ClassifiedModel[]) => models.map((m) => m.id);

describe("isAggregatorRestrictedFlagship", () => {
  test("blocks claude and gpt flagships", () => {
    expect(isAggregatorRestrictedFlagship({ family: "claude", tier: "flagship" })).toBe(true);
    expect(isAggregatorRestrictedFlagship({ family: "gpt", tier: "flagship" })).toBe(true);
  });

  test("admits non-frontier tiers of the same families", () => {
    expect(isAggregatorRestrictedFlagship({ family: "claude", tier: "fast" })).toBe(false);
    expect(isAggregatorRestrictedFlagship({ family: "gpt", tier: "coder" })).toBe(false);
  });

  test("never blocks other vendors", () => {
    for (const family of ["glm", "kimi", "minimax", "qwen", "nvidia", "mistralai", "ling"]) {
      expect(isAggregatorRestrictedFlagship({ family, tier: "flagship" })).toBe(false);
    }
  });
});

describe("OpenRouter catalog policy", () => {
  // Prices are per-token USD strings, matching the live /models shape. Anything
  // at or above $2/M output classifies flagship unless the id says otherwise.
  const raw = [
    { id: "anthropic/claude-fable-5", pricing: { prompt: "0.00001", completion: "0.00005" } },
    { id: "anthropic/claude-opus-5", pricing: { prompt: "0.000005", completion: "0.000025" } },
    { id: "anthropic/claude-sonnet-5", pricing: { prompt: "0.000003", completion: "0.00001" } },
    { id: "openai/gpt-5", pricing: { prompt: "0.00000125", completion: "0.00001" } },
    { id: "anthropic/claude-haiku-4.5", pricing: { prompt: "0.000001", completion: "0.000005" } },
    { id: "openai/gpt-5.3-codex", pricing: { prompt: "0.00000125", completion: "0.00001" } },
    { id: "openai/gpt-oss-120b", pricing: { prompt: "0.00000005", completion: "0.00000017" } },
    { id: "z-ai/glm-5.2", pricing: { prompt: "0.0000006", completion: "0.0000022" } },
  ];

  test("withholds every Anthropic/OpenAI flagship", () => {
    const out = ids(classifyOpenRouterModels(raw));
    expect(out).not.toContain("anthropic/claude-fable-5");
    expect(out).not.toContain("anthropic/claude-opus-5");
    expect(out).not.toContain("anthropic/claude-sonnet-5");
    expect(out).not.toContain("openai/gpt-5");
  });

  test("keeps non-frontier tiers and other vendors", () => {
    const out = ids(classifyOpenRouterModels(raw));
    expect(out).toContain("anthropic/claude-haiku-4.5");
    expect(out).toContain("openai/gpt-5.3-codex");
    expect(out).toContain("openai/gpt-oss-120b");
    expect(out).toContain("z-ai/glm-5.2");
  });

  test("no admitted model is a restricted flagship", () => {
    for (const m of classifyOpenRouterModels(raw)) {
      expect(isAggregatorRestrictedFlagship(m)).toBe(false);
    }
  });

  test("drops non-text-output models and de-duplicates ids", () => {
    const out = ids(classifyOpenRouterModels([
      { id: "z-ai/glm-5.2", pricing: { prompt: "0.0000006", completion: "0.0000022" } },
      { id: "z-ai/glm-5.2", pricing: { prompt: "0.0000006", completion: "0.0000022" } },
      { id: "some/image-only", architecture: { output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0" } },
    ]));
    expect(out).toEqual(["z-ai/glm-5.2"]);
  });
});

describe("Opencode catalog policy", () => {
  const raw = [
    { id: "claude-fable-5" },
    { id: "claude-opus-5" },
    { id: "claude-sonnet-5" },
    { id: "gpt-5.6-sol" },
    { id: "gpt-5.6-terra" },
    { id: "claude-haiku-4-5" },
    { id: "gpt-5.4-mini" },
    { id: "gpt-5.3-codex" },
    { id: "glm-5.2" },
    { id: "north-mini-code-free" },
  ];

  test("withholds every Anthropic/OpenAI flagship", () => {
    const out = ids(classifyOpencodeModels(raw));
    for (const blocked of ["oc:claude-fable-5", "oc:claude-opus-5", "oc:claude-sonnet-5", "oc:gpt-5.6-sol", "oc:gpt-5.6-terra"]) {
      expect(out).not.toContain(blocked);
    }
  });

  test("keeps non-frontier tiers and other vendors", () => {
    const out = ids(classifyOpencodeModels(raw));
    expect(out).toContain("oc:claude-haiku-4-5");
    expect(out).toContain("oc:gpt-5.4-mini");
    expect(out).toContain("oc:gpt-5.3-codex");
    expect(out).toContain("oc:glm-5.2");
    expect(out).toContain("oc:north-mini-code-free");
  });

  test("no admitted model is a restricted flagship", () => {
    for (const m of classifyOpencodeModels(raw)) {
      expect(isAggregatorRestrictedFlagship(m)).toBe(false);
    }
  });

  test("both aggregators apply the same predicate", () => {
    // Same model, two routes — neither may admit it.
    const or = ids(classifyOpenRouterModels([
      { id: "anthropic/claude-fable-5", pricing: { prompt: "0.00001", completion: "0.00005" } },
    ]));
    const oc = ids(classifyOpencodeModels([{ id: "claude-fable-5" }]));
    expect(or).toEqual([]);
    expect(oc).toEqual([]);
  });
});
