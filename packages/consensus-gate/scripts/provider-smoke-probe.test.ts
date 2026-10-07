import { describe, expect, test } from "bun:test";
import {
  selectProbeTargets,
  type ProbeConfig,
} from "./provider-smoke-probe";

const base = (route: string, provider: string, genModel: string): ProbeConfig => ({
  route,
  provider,
  genUrl: `https://${provider}.example/generate`,
  catUrl: `https://${provider}.example/models`,
  genModel,
  catModelContains: genModel,
  auth: "test",
  needsUa: false,
});

const targets = [
  base("byok:", "zo-byok", "byok:default"),
  base("hf:", "synthetic", "hf:zai-org/GLM-5.2"),
  base("or:", "openrouter", "z-ai/glm-5.2"),
  base("oc:", "opencode", "glm-5.2"),
  base("kimi:", "kimi", "kimi-k3"),
];

describe("provider smoke target selection", () => {
  test("routes an exact or: model to OpenRouter without falling back", () => {
    expect(selectProbeTargets(targets, "or:qwen/qwen3.7-flash")).toMatchObject([
      {
        route: "or:",
        provider: "openrouter",
        genModel: "qwen/qwen3.7-flash",
        catModelContains: "qwen/qwen3.7-flash",
      },
    ]);
  });

  test("treats an unprefixed vendor model as an exact OpenRouter route", () => {
    expect(selectProbeTargets(targets, "poolside/laguna-s-2.1")).toMatchObject([
      {
        route: "or:",
        genModel: "poolside/laguna-s-2.1",
      },
    ]);
    expect(selectProbeTargets(targets, "poolside/laguna-s-2.1:free")[0].genModel)
      .toBe("poolside/laguna-s-2.1:free");
  });

  test("preserves exact BYOK and Synthetic ids", () => {
    expect(selectProbeTargets(targets, "byok:uuid")[0].genModel).toBe("byok:uuid");
    expect(selectProbeTargets(targets, "hf:vendor/model")[0].genModel).toBe("hf:vendor/model");
    expect(selectProbeTargets(targets, "syn:vendor/model")[0].genModel).toBe("hf:vendor/model");
  });

  test("returns no targets for an unsupported explicit provider", () => {
    expect(selectProbeTargets(targets, "xai:grok-4.5")).toEqual([]);
  });
});
