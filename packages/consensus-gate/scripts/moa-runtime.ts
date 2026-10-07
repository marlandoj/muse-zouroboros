#!/usr/bin/env bun
import * as fs from "fs";

const SYNTHETIC_URL = "https://api.synthetic.new/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENCODE_URL = "https://opencode.ai/zen/v1/chat/completions";
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const KIMI_URL = "https://api.moonshot.ai/v1/chat/completions";
const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const OPENCODE_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 529]);

export interface MoaLineup {
  proposers: string[];
  aggregator: string;
}

export const DEFAULT_PRODUCTION_MOA_LINEUP: MoaLineup = {
  proposers: [
    "hf:zai-org/GLM-5.2",
    "hf:moonshotai/Kimi-K2.7-Code",
    "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
  ],
  aggregator: "hf:MiniMaxAI/MiniMax-M3",
};

export interface ResolvedMoaLineup extends MoaLineup {
  source: "env" | "dynamic" | "fallback";
  generatedAt?: string;
  lineupPath: string;
}

export interface MoaCallOptions {
  maxTokens: number;
  temperature: number;
  system?: string;
  signal?: AbortSignal;
}

export interface MoaCallResult {
  model: string;
  provider: string;
  ok: boolean;
  text: string;
  source: "content" | "reasoning" | "none";
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

type Env = Record<string, string | undefined>;

function isLineup(value: unknown): value is MoaLineup {
  if (!value || typeof value !== "object") return false;
  const lineup = value as Partial<MoaLineup>;
  return Array.isArray(lineup.proposers)
    && lineup.proposers.length > 0
    && lineup.proposers.every((model) => typeof model === "string" && model.length > 0)
    && typeof lineup.aggregator === "string"
    && lineup.aggregator.length > 0
    && !lineup.proposers.includes(lineup.aggregator);
}

export function resolveProductionMoaLineup(
  fallback: MoaLineup,
  options: { env?: Env; lineupPath?: string } = {},
): ResolvedMoaLineup {
  const env = options.env ?? process.env;
  const lineupPath = options.lineupPath
    ?? env.ZO_MOA_LINEUP_PATH
    ?? `${env.HOME ?? process.env.HOME}/.zouroboros/lineup.json`;
  let dynamic: MoaLineup | null = null;
  let generatedAt: string | undefined;
  try {
    const record = JSON.parse(fs.readFileSync(lineupPath, "utf-8")) as {
      valid?: boolean;
      lineup?: MoaLineup & { generatedAt?: string };
    };
    if (record.valid === true && isLineup(record.lineup)) {
      dynamic = record.lineup;
      generatedAt = record.lineup.generatedAt;
    }
  } catch {}

  const base = dynamic ?? fallback;
  const proposerOverride = (env.ZO_MOA_PROPOSERS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const aggregatorOverride = (env.ZO_MOA_AGGREGATOR ?? "").trim();
  const resolved: MoaLineup = {
    proposers: proposerOverride.length ? proposerOverride : base.proposers,
    aggregator: aggregatorOverride || base.aggregator,
  };
  if (!isLineup(resolved)) {
    return { ...fallback, source: "fallback", lineupPath };
  }
  return {
    ...resolved,
    source: proposerOverride.length || aggregatorOverride ? "env" : dynamic ? "dynamic" : "fallback",
    generatedAt,
    lineupPath,
  };
}

export function providerForMoaModel(model: string): "zo-byok" | "synthetic" | "opencode" | "xai" | "kimi" | "openrouter" {
  if (model.startsWith("byok:")) return "zo-byok";
  if (model.startsWith("hf:") || model.startsWith("syn:")) return "synthetic";
  if (model.startsWith("oc:")) return "opencode";
  if (model.startsWith("xai:")) return "xai";
  if (model.startsWith("kimi:")) return "kimi";
  return "openrouter";
}

function mapToOpenRouter(model: string): string | null {
  const normalized = model.replace(/^syn:/, "hf:");
  if (!normalized.startsWith("hf:")) return null;
  const slug = normalized.slice(3);
  const slash = slug.indexOf("/");
  if (slash < 0) return null;
  const org = slug.slice(0, slash).toLowerCase();
  const name = slug.slice(slash + 1).toLowerCase();
  const orgMap: Record<string, string> = { "zai-org": "z-ai", minimaxai: "minimax" };
  return `${orgMap[org] ?? org}/${name}`;
}

function mapToOpencode(model: string): string | null {
  const normalized = model.replace(/^syn:/, "hf:");
  if (!normalized.startsWith("hf:")) return null;
  const slug = normalized.slice(3);
  return (slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug).toLowerCase();
}

async function callZoByok(model: string, prompt: string, options: MoaCallOptions, token: string): Promise<MoaCallResult> {
  const started = Date.now();
  let lastError = "Zo BYOK call failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(ZO_ASK_URL, {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json" },
        body: JSON.stringify({ input: options.system ? `${options.system}\n\n${prompt}` : prompt, model_name: model }),
        signal: options.signal ?? AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`;
        if (TRANSIENT_STATUSES.has(response.status) && attempt === 0) {
          await Bun.sleep(2_500);
          continue;
        }
        break;
      }
      const data = await response.json() as { output?: unknown };
      const text = typeof data.output === "string" ? data.output.trim() : "";
      if (text) {
        return {
          model, provider: "zo-byok", ok: true, text, source: "content",
          latencyMs: Date.now() - started, inputTokens: 0, outputTokens: 0, costUsd: 0,
        };
      }
      lastError = "empty output";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    model, provider: "zo-byok", ok: false, text: "", source: "none",
    latencyMs: Date.now() - started, inputTokens: 0, outputTokens: 0, costUsd: 0, error: lastError,
  };
}

async function callOpenAiCompatible(
  model: string,
  prompt: string,
  options: MoaCallOptions,
  provider: string,
  endpoint: string,
  key: string,
  headers: Record<string, string> = {},
): Promise<MoaCallResult> {
  const started = Date.now();
  let lastError = `${provider} call failed`;
  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  messages.push({ role: "user", content: prompt });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature,
          max_tokens: Math.max(options.maxTokens, 4096),
          usage: { include: true },
        }),
        signal: options.signal ?? AbortSignal.timeout(90_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`;
        if (TRANSIENT_STATUSES.has(response.status) && attempt === 0) {
          await Bun.sleep(2_500);
          continue;
        }
        break;
      }
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: string | number };
        cost?: string | number;
      };
      const message = data.choices?.[0]?.message ?? {};
      const content = typeof message.content === "string" ? message.content.trim() : "";
      const reasoningValue = message.reasoning ?? message.reasoning_content;
      const reasoning = typeof reasoningValue === "string" ? reasoningValue.trim() : "";
      const text = content || reasoning;
      if (text) {
        return {
          model, provider, ok: true, text, source: content ? "content" : "reasoning",
          latencyMs: Date.now() - started,
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
          costUsd: Number(data.cost ?? data.usage?.cost ?? 0) || 0,
        };
      }
      lastError = "empty content and reasoning";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    model, provider, ok: false, text: "", source: "none",
    latencyMs: Date.now() - started, inputTokens: 0, outputTokens: 0, costUsd: 0, error: lastError,
  };
}

export async function callMoaModel(model: string, prompt: string, options: MoaCallOptions): Promise<MoaCallResult> {
  const env = process.env;
  const zoToken = env.ZO_CLIENT_IDENTITY_TOKEN || env.ZO_TOKEN || "";
  const syntheticKey = env.SYNTHETIC_API_KEY || "";
  const openrouterKey = env.OPENROUTER_API_KEY || "";
  const opencodeKey = env.OPENCODE_API_KEY || "";
  const xaiKey = env.XAI_API_KEY || "";
  const kimiKey = env.KIMI_API_KEY || "";
  const provider = providerForMoaModel(model);

  if (provider === "zo-byok") {
    if (!zoToken) return failure(model, provider, "ZO_CLIENT_IDENTITY_TOKEN or ZO_TOKEN not set");
    return callZoByok(model, prompt, options, zoToken);
  }
  if (provider === "opencode") {
    if (!opencodeKey) return failure(model, provider, "OPENCODE_API_KEY not set");
    return callOpenAiCompatible(model.slice(3), prompt, options, provider, OPENCODE_URL, opencodeKey, { "User-Agent": OPENCODE_UA });
  }
  if (provider === "xai") {
    if (!xaiKey) return failure(model, provider, "XAI_API_KEY not set");
    return callOpenAiCompatible(model.slice(4), prompt, options, provider, XAI_URL, xaiKey);
  }
  if (provider === "kimi") {
    if (!kimiKey) return failure(model, provider, "KIMI_API_KEY not set");
    const vendorModel = model.slice(5);
    const kimiOptions = { ...options, temperature: 1 };
    return callOpenAiCompatible(vendorModel, prompt, kimiOptions, provider, KIMI_URL, kimiKey);
  }
  if (provider === "openrouter") {
    if (!openrouterKey) return failure(model, provider, "OPENROUTER_API_KEY not set");
    const vendorModel = model.replace(/^or:/, "");
    return callOpenAiCompatible(vendorModel, prompt, options, provider, OPENROUTER_URL, openrouterKey, {
      "HTTP-Referer": "https://github.com/marlandoj/muse-zouroboros",
      "X-Title": "Zouroboros MoA",
    });
  }

  const syntheticModel = model.replace(/^syn:/, "hf:");
  if (syntheticKey) {
    const primary = await callOpenAiCompatible(syntheticModel, prompt, options, "synthetic", SYNTHETIC_URL, syntheticKey);
    if (primary.ok) return primary;
  }
  const openrouterModel = mapToOpenRouter(syntheticModel);
  if (openrouterKey && openrouterModel) {
    const failover = await callOpenAiCompatible(openrouterModel, prompt, options, "openrouter", OPENROUTER_URL, openrouterKey, {
      "HTTP-Referer": "https://github.com/marlandoj/muse-zouroboros",
      "X-Title": "Zouroboros MoA",
    });
    if (failover.ok) return { ...failover, model };
  }
  const opencodeModel = mapToOpencode(syntheticModel);
  if (opencodeKey && opencodeModel) {
    const failover = await callOpenAiCompatible(opencodeModel, prompt, options, "opencode", OPENCODE_URL, opencodeKey, { "User-Agent": OPENCODE_UA });
    if (failover.ok) return { ...failover, model };
    return { ...failover, model };
  }
  return failure(model, provider, "No reachable Synthetic, OpenRouter, or Opencode route");
}

function failure(model: string, provider: string, error: string): MoaCallResult {
  return {
    model, provider, ok: false, text: "", source: "none", latencyMs: 0,
    inputTokens: 0, outputTokens: 0, costUsd: 0, error,
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(resolveProductionMoaLineup(DEFAULT_PRODUCTION_MOA_LINEUP), null, 2));
}
