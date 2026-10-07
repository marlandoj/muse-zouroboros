import { describe, expect, test } from "bun:test";
import { candidateProbeRouteId, modelForEndpoint, providerForModel } from "./cold-start-probe";

describe("byok probe routing", () => {
  test("byok:<uuid> routes through /zo/ask with the workspace identity token", () => {
    const cfg = providerForModel("byok:73ae74c2-26d1-561e-91af-2cf47a33f4dd");
    expect(cfg.provider).toBe("zo-byok");
    expect(cfg.endpoint).toBe("https://api.zo.computer/zo/ask");
    expect(cfg.keyEnv).toBe("ZO_CLIENT_IDENTITY_TOKEN");
  });

  test("byok model id is passed through verbatim as model_name", () => {
    expect(modelForEndpoint("byok:73ae74c2-26d1-561e-91af-2cf47a33f4dd")).toBe(
      "byok:73ae74c2-26d1-561e-91af-2cf47a33f4dd",
    );
  });

  test("non-byok routes are unchanged", () => {
    expect(providerForModel("oc:kimi-k3").provider).toBe("opencode");
    expect(providerForModel("kimi:kimi-k3").provider).toBe("kimi");
    expect(modelForEndpoint("kimi:kimi-k3")).toBe("kimi-k3");
    expect(modelForEndpoint("or:openai/gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
  });
});

describe("targeted cold-start routing", () => {
  test("matches legacy OpenRouter records through their direct route id", () => {
    expect(candidateProbeRouteId({ id: "openai/gpt-5.6-sol", provider: "openrouter" })).toBe(
      "or:openai/gpt-5.6-sol",
    );
    expect(candidateProbeRouteId({ id: "oc:gpt-5.6-sol", provider: "opencode" })).toBe("oc:gpt-5.6-sol");
    expect(candidateProbeRouteId({ id: "kimi:kimi-k3", provider: "kimi" })).toBe("kimi:kimi-k3");
  });
});
