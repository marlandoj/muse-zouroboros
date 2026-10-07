import { providerForModelId, type ModelProvider } from "./model-identity";

export interface ProviderCredentials {
  synthetic: string;
  openrouter: string;
  opencode: string;
  xai: string;
  kimi: string;
  zo: string;
}

export interface DirectProviderRoute {
  provider: Exclude<ModelProvider, "synthetic" | "unknown">;
  endpoint: string;
  vendorModel: string;
}

export function directProviderRoute(
  model: string,
  credentials: ProviderCredentials,
): DirectProviderRoute | null {
  const provider = providerForModelId(model);
  if (provider === "zo-byok" && credentials.zo) {
    return { provider, endpoint: "https://api.zo.computer/zo/ask", vendorModel: model };
  }
  if (provider === "opencode" && credentials.opencode) {
    return { provider, endpoint: "https://opencode.ai/zen/v1/chat/completions", vendorModel: model.slice(3) };
  }
  if (provider === "openrouter" && model.startsWith("or:") && credentials.openrouter) {
    return { provider, endpoint: "https://openrouter.ai/api/v1/chat/completions", vendorModel: model.slice(3) };
  }
  if (provider === "xai" && credentials.xai) {
    return { provider, endpoint: "https://api.x.ai/v1/chat/completions", vendorModel: model.slice(4) };
  }
  if (provider === "kimi" && credentials.kimi) {
    return { provider, endpoint: "https://api.moonshot.ai/v1/chat/completions", vendorModel: model.slice(5) };
  }
  return null;
}
