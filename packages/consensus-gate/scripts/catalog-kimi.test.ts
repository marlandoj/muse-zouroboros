import { describe, expect, test } from "bun:test";
import { classifyKimiModels, KIMI_MODEL_IDS } from "./catalog-kimi";

describe("Kimi catalog", () => {
  test("exposes only the five approved direct-provider models", () => {
    const models = classifyKimiModels([
      ...KIMI_MODEL_IDS.map((id) => ({ id })),
      { id: "moonshot-v1-8k" },
    ]);

    expect(models.map((model) => model.id)).toEqual(KIMI_MODEL_IDS.map((id) => `kimi:${id}`));
    expect(models.every((model) => model.family === "kimi")).toBe(true);
  });

  test("classifies coding and flagship tiers with documented context lengths", () => {
    const models = classifyKimiModels(KIMI_MODEL_IDS.map((id) => ({ id })));
    const byId = new Map(models.map((model) => [model.id, model]));

    expect(byId.get("kimi:kimi-k3")).toMatchObject({ tier: "flagship", context_length: 1_048_576, promptCost: 3e-6, completionCost: 15e-6 });
    expect(byId.get("kimi:kimi-k2.7-code")).toMatchObject({ tier: "coder", context_length: 262_144, promptCost: 0.95e-6, completionCost: 4e-6 });
    expect(byId.get("kimi:kimi-k2.7-code-highspeed")).toMatchObject({ tier: "coder", context_length: 262_144, promptCost: 1.9e-6, completionCost: 8e-6 });
    expect(byId.get("kimi:kimi-k2.6")).toMatchObject({ tier: "flagship", context_length: 262_144, promptCost: 0.95e-6, completionCost: 4e-6 });
    expect(byId.get("kimi:kimi-k2.5")).toMatchObject({ tier: "flagship", context_length: 262_144, promptCost: 0.6e-6, completionCost: 3e-6 });
  });
});
