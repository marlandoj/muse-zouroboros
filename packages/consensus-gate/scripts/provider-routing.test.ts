import { describe, expect, test } from "bun:test";
import { directProviderRoute } from "./provider-routing";

const allCredentials = {
  synthetic: "synthetic-key",
  openrouter: "openrouter-key",
  opencode: "opencode-key",
  xai: "xai-key",
  kimi: "kimi-key",
  zo: "zo-token",
};

describe("direct provider routing", () => {
  test("routes an or: pin directly to OpenRouter even when every provider is available", () => {
    expect(directProviderRoute("or:anthropic/claude-fable-5", allCredentials)).toEqual({
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      vendorModel: "anthropic/claude-fable-5",
    });
  });

  test("preserves existing explicit prefixes", () => {
    expect(directProviderRoute("oc:glm-5.2", allCredentials)?.provider).toBe("opencode");
    expect(directProviderRoute("byok:uuid", allCredentials)?.provider).toBe("zo-byok");
    expect(directProviderRoute("xai:grok-3-mini", allCredentials)?.provider).toBe("xai");
    expect(directProviderRoute("kimi:kimi-k3", allCredentials)).toEqual({
      provider: "kimi",
      endpoint: "https://api.moonshot.ai/v1/chat/completions",
      vendorModel: "kimi-k3",
    });
  });

  test("does not treat hf: as direct OpenRouter traffic", () => {
    expect(directProviderRoute("hf:zai-org/GLM-5.2", allCredentials)).toBeNull();
  });
});
