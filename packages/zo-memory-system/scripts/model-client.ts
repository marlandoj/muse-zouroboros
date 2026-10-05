// =============================================================================
// model-client.ts — Unified model provider abstraction
//
// Replaces direct provider calls with a clean interface that routes to OpenAI
// or Anthropic based on env vars.
//
// Usage:
//   import { generate, embeddings, modelHealthCheck } from "./model-client";
//
//   const { content, latency_ms } = await generate({
//     prompt: "Hello world",
//     workload: "gate",
//   });
//
// Env vars by workload (all optional — defaults to OpenAI unless overridden):
//   ZO_MODEL_GATE         → memory gate classifier
//   ZO_MODEL_HYDE         → HyDE query expansion
//   ZO_MODEL_EXTRACTION   → fact extraction
//   ZO_MODEL_SUMMARIZATION → episode summarization
//   ZO_MODEL_BRIEFING     → session briefing
//   ZO_MODEL_CAPTURE      → inline capture
//   ZO_MODEL_CONVERSATION  → conversation capture
//   ZO_MODEL_EMBEDDING    → embedding model
//
// Model spec format: "provider:model-id"
//   openai:gpt-4o-mini    → OpenAI (OPENAI_API_KEY)
//   anthropic:haiku       → Anthropic direct API (ANTHROPIC_API_KEY)
//
//   Bare names default to a provider inferred from the model id.
//
// Cost tracking: every call returns { content, latency_ms, provider, model, cost_usd }
// =============================================================================

export type Provider = "openai" | "anthropic";
export type Workload =
  | "gate" | "hyde" | "extraction"
  | "summarization" | "briefing"
  | "capture" | "conversation" | "embedding";

export interface GenerateOptions {
  prompt: string;
  system?: string;
  workload: Workload;
  model?: string;         // overrides ZO_MODEL_<WORKLOAD>
  temperature?: number;
  maxTokens?: number;
  json?: boolean;          // if true, request structured JSON response
  max_age?: number;        // Anthropic max_age parameter
}

export interface GenerateResult {
  content: string;
  latency_ms: number;
  provider: Provider;
  model: string;
  cost_usd: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface EmbedResult {
  embedding: number[];
  latency_ms: number;
  provider: Provider;
  model: string;
  cost_usd: number;
  error?: string;
}

export interface HealthResult {
  available: boolean;
  latency_ms: number;
  error?: string; cost_usd?: number;
}

// ─── Workload defaults ────────────────────────────────────────────────────────

const WORKLOAD_TEMP: Record<Workload, number> = {
  gate: 0.1, hyde: 0.3, extraction: 0.2,
  summarization: 0.4, briefing: 0.5,
  capture: 0.4, conversation: 0.4, embedding: 0.0,
};

const WORKLOAD_MAX_TOKENS: Record<Workload, number> = {
  gate: 150, hyde: 200, extraction: 600,
  summarization: 800, briefing: 400,
  capture: 600, conversation: 600, embedding: 2048,
};

// ─── Model spec parser ────────────────────────────────────────────────────────

const ALL_PROVIDERS: Provider[] = ["openai", "anthropic"];

const KNOWN_OPENAI_MODELS = new Set([
  "gpt-4o", "gpt-4o-mini", "gpt-4o-large", "gpt-4-turbo", "gpt-4",
  "gpt-3.5-turbo", "gpt-3.5-turbo-16k",
  "text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002",
  "o1", "o1-mini", "o1-preview", "o3-mini",
]);

function parseModelSpec(spec: string): { provider: Provider; model: string } {
  if (!spec || typeof spec !== "string") return { provider: "openai", model: "gpt-4o-mini" };
  const colon = spec.indexOf(":");
  if (colon < 0) {
    // Bare name — check if it's a known OpenAI model
    const base = spec.split("/").pop() || spec;
    if (KNOWN_OPENAI_MODELS.has(base)) return { provider: "openai", model: base };
    if (KNOWN_OPENAI_MODELS.has(base.replace("-", "_").replace("_", "-"))) return { provider: "openai", model: base };
    return { provider: "openai", model: base };
  }
  const prefix = spec.slice(0, colon).toLowerCase();
  if (ALL_PROVIDERS.includes(prefix as Provider)) {
    return { provider: prefix as Provider, model: spec.slice(colon + 1) };
  }
  return { provider: "openai", model: spec.slice(colon + 1) || spec };
}

// ─── Workload resolver ────────────────────────────────────────────────────────

const WORKLOAD_ENV: Record<Workload, string> = {
  gate: "ZO_MODEL_GATE",
  hyde: "ZO_MODEL_HYDE",
  extraction: "ZO_MODEL_EXTRACTION",
  summarization: "ZO_MODEL_SUMMARIZATION",
  briefing: "ZO_MODEL_BRIEFING",
  capture: "ZO_MODEL_CAPTURE",
  conversation: "ZO_MODEL_CONVERSATION",
  embedding: "ZO_MODEL_EMBEDDING",
};

function loadModelEnv(): void {
  try {
    const { readFileSync } = require("fs");
    const { homedir } = require("os");
    const { join } = require("path");
    // Per-workload model overrides live here (optional; env vars take precedence).
    const envPath = join(homedir(), ".config", "zouroboros", "model.env");
    const envContent = readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      let line2 = trimmed;
      // Strip leading "export " prefix (shell-style)
      if (line2.startsWith("export ")) line2 = line2.slice(7);
      const eqIdx = line2.indexOf("=");
      if (eqIdx < 0) continue;
      const key = line2.slice(0, eqIdx).trim();
      const val = line2.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch { /* no model.env */ }
}

const DEFAULT_MODELS: Record<Workload, string> = {
  gate: "openai:gpt-4o-mini",
  hyde: "openai:gpt-4o-mini",
  extraction: "openai:gpt-4o-mini",
  summarization: "openai:gpt-4o-mini",
  briefing: "openai:gpt-4o-mini",
  capture: "openai:gpt-4o-mini",
  conversation: "openai:gpt-4o-mini",
  embedding: "openai:text-embedding-3-small",
};

function resolveModel(workload: Workload, explicitModel?: string): { provider: Provider; model: string } {
  loadModelEnv();
  const envKey = WORKLOAD_ENV[workload];
  const spec = explicitModel || process.env[envKey] || "";
  if (spec) return parseModelSpec(spec);
  return parseModelSpec(DEFAULT_MODELS[workload]);
}

export function resolveConfiguredModel(workload: Workload, explicitModel?: string): { provider: Provider; model: string } {
  return resolveModel(workload, explicitModel);
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_TOKEN = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY || "";

async function openaiGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!OPENAI_TOKEN) throw new Error("OPENAI_API_KEY not set");
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);
  const temperature = opts.temperature ?? WORKLOAD_TEMP[opts.workload];
  const maxTokens = opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload];

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.prompt });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
    if (!opts.system) messages.unshift({ role: "system", content: "You are a JSON generator. Respond ONLY with valid JSON, no markdown or explanation." });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[openai/${model}] OpenAI error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };
  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.usage;
  const latency_ms = Date.now() - start;

  // Cost: gpt-4o-mini = $0.07/1K input + $0.28/1K output
  const inputTokens = usage?.prompt_tokens || 0;
  const outputTokens = usage?.completion_tokens || 0;
  const cost_usd = (inputTokens * 0.07 + outputTokens * 0.28) / 1000;

  return {
    content,
    latency_ms,
    provider: "openai",
    model,
    cost_usd: Math.max(cost_usd, 0.00001),
    usage: usage ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined,
  };
}

async function openaiEmbeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  if (!OPENAI_TOKEN) throw new Error("OPENAI_API_KEY not set");
  const { model } = resolveModel("embedding", explicitModel);
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_TOKEN}`,
    },
    body: JSON.stringify({ input: text, model: model || "text-embedding-3-small" }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[openai] Embeddings error ${resp.status}`);
  const data = await resp.json() as { data?: Array<{ embedding?: number[] }>; usage?: unknown };
  const embedding = data.data?.[0]?.embedding || [];
  return { embedding, latency_ms: 0, provider: "openai", model, cost_usd: 0.00001 };
}

// ─── Anthropic (direct API) ───────────────────────────────────────────────────

// De-Zo port: this provider used to route through the Zo Computer platform
// proxy (https://api.zo.computer/zo/ask) using ZO_CLIENT_IDENTITY_TOKEN.
// Zo Computer no longer exists, so generation now calls the Anthropic
// Messages API directly with ANTHROPIC_API_KEY.
const ANTHROPIC_TOKEN = process.env.ANTHROPIC_API_KEY || "";

async function anthropicGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  if (!ANTHROPIC_TOKEN) throw new Error("ANTHROPIC_API_KEY not set");
  const start = Date.now();
  const { model } = resolveModel(opts.workload, opts.model);
  const temperature = opts.temperature ?? WORKLOAD_TEMP[opts.workload];
  const maxTokens = opts.maxTokens ?? WORKLOAD_MAX_TOKENS[opts.workload];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_TOKEN,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: opts.system || "Respond ONLY with valid JSON.",
      messages: [{ role: "user", content: opts.prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`[anthropic/${model}] API error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json() as { content?: Array<{ type?: string; text?: string }> };
  const content = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("");
  const latency_ms = Date.now() - start;

  return { content, latency_ms, provider: "anthropic", model, cost_usd: 0.001 };
}

async function anthropicEmbeddings(_text: string): Promise<EmbedResult> {
  return { embedding: [], latency_ms: 0, provider: "anthropic", model: "unknown", cost_usd: 0, error: "Anthropic has no embeddings API — use OpenAI embeddings" };
}

// ─── Health checks ────────────────────────────────────────────────────────────

export async function modelHealthCheck(provider: Provider): Promise<HealthResult> {
  const start = Date.now();
  try {
    if (provider === "openai" && OPENAI_TOKEN) {
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${OPENAI_TOKEN}` },
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    if (provider === "anthropic") {
      if (!ANTHROPIC_TOKEN) {
        return { available: false, latency_ms: Date.now() - start, error: "No credentials" };
      }
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": ANTHROPIC_TOKEN,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000),
      });
      return { available: resp.ok, latency_ms: Date.now() - start, error: resp.ok ? undefined : `HTTP ${resp.status}` };
    }
    return { available: false, latency_ms: Date.now() - start, error: "No credentials" };
  } catch (e) {
    return { available: false, latency_ms: Date.now() - start, error: String(e) };
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_WORKLOADS: Workload[] = ["gate", "extraction", "summarization", "briefing"];

// Simple JSON file logger — zero dependencies, non-blocking
function logCall(result: GenerateResult, workload: Workload): void {
  if (!LOG_WORKLOADS.includes(workload)) return;
  try {
    const { appendFileSync } = require("fs");
    const { homedir } = require("os");
    const { join } = require("path");
    const LOG_FILE = join(homedir(), ".zo", "memory", "model-call-log.jsonl");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      workload,
      provider: result.provider,
      model: result.model,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
    }) + "\n";
    // Bun: append to file without reading whole file
    appendFileSync(LOG_FILE, entry);
  } catch { /* non-fatal */ }
}

function logEmbedCall(result: EmbedResult): void {
  // skip embedding logs for now
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const { provider } = resolveModel(opts.workload, opts.model);
  let result: GenerateResult;
  try {
    switch (provider) {
      case "openai":    result = await openaiGenerate(opts); break;
      case "anthropic": result = await anthropicGenerate(opts); break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[model-client] ${provider} workload=${opts.workload} failed: ${msg}`);
    throw err;
  }
  logCall(result, opts.workload);
  return result;
}

export async function embeddings(text: string, explicitModel?: string): Promise<EmbedResult> {
  const { provider, model } = resolveModel("embedding", explicitModel);
  switch (provider) {
    case "openai":    { const r = await openaiEmbeddings(text, model); logEmbedCall(r); return r; }
    case "anthropic": return anthropicEmbeddings(text);
  }
}
