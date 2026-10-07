#!/usr/bin/env bun
// provider-smoke-probe.ts — ZOU-483 acceptance check.
// Probes all consensus-gate routes (Zo BYOK, Synthetic, OpenRouter, Opencode Zen, Kimi)
// end-to-end: a live catalog fetch AND a real generation call against each, using
// the exact headers the gate itself sends (incl. the browser User-Agent that
// dodges opencode.ai/zen Cloudflare 1010). Exits 0 only if all providers return
// 200 + non-empty generation text. Repeatable: designed to run on every gate
// deploy and from the scheduled catalog-refresh agent.
//
// Usage:
//   bun provider-smoke-probe.ts            # human-readable summary
//   bun provider-smoke-probe.ts --json      # machine-readable JSON
//   bun provider-smoke-probe.ts --model oc:glm-5.2   # probe a single provider by gate-prefixed id
//   bun provider-smoke-probe.ts --model oc:glm-5.2 --prompt "<consensus task>" --json
//
// Env: SYNTHETIC_API_KEY, OPENROUTER_API_KEY, OPENCODE_API_KEY, KIMI_API_KEY (all required).

import { parseArgs } from "util";
import { loadCachedCatalog as loadByok } from "./catalog-byok";
import { resolveByokAlias } from "./model-identity";

const SYNTHETIC_GEN = "https://api.synthetic.new/openai/v1/chat/completions";
const SYNTHETIC_CAT = "https://api.synthetic.new/openai/v1/models";
const OPENROUTER_GEN = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_CAT = "https://openrouter.ai/api/v1/models";
const OPENCODE_GEN = "https://opencode.ai/zen/v1/chat/completions";
const OPENCODE_CAT = "https://opencode.ai/zen/v1/models";
const KIMI_GEN = "https://api.moonshot.ai/v1/chat/completions";
const KIMI_CAT = "https://api.moonshot.ai/v1/models";
const OPENCODE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const DEFAULT_PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";
// FH-03 — the default prompt proves reachability only. `--prompt` lets a caller
// send the real consensus task so the probe can also prove the route returns a
// parseable verdict, which reachability never established.
let PROBE_PROMPT = DEFAULT_PROBE_PROMPT;
export function setProbePrompt(prompt: string): void {
  PROBE_PROMPT = prompt.trim() || DEFAULT_PROBE_PROMPT;
}
const GEN_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 256;
// Consensus-shaped probes give reasoning models enough room to emit their final JSON.
const CONSENSUS_MAX_TOKENS = 1024;

export interface ProbeResult {
  route: string;
  provider: string;
  catalogOk: boolean;
  catalogCount: number | null;
  genOk: boolean;
  genText: string;
  httpStatus: number;
  error: string | null;
  elapsedMs: number;
}

export interface ProbeConfig {
  route: string;
  provider: string;
  genUrl: string;
  catUrl: string | null;
  cachedCatalogCount?: number;
  genModel: string;
  catModelContains: string;
  auth: string;
  needsUa: boolean;
  zoAsk?: boolean;
}

export function selectProbeTargets(
  all: readonly ProbeConfig[],
  requested?: string,
): ProbeConfig[] {
  if (!requested) return [...all];

  const explicitPrefix = requested.match(/^(byok:|hf:|syn:|or:|oc:|kimi:)/)?.[1];
  if (!explicitPrefix && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(requested)) return [];
  const prefix = explicitPrefix ?? "or:";
  const base = all.find((candidate) =>
    candidate.route === (prefix === "syn:" ? "hf:" : prefix)
  );
  if (!base) return [];

  let genModel = requested;
  if (explicitPrefix && (prefix === "or:" || prefix === "oc:" || prefix === "kimi:")) {
    genModel = requested.slice(prefix.length);
  } else if (prefix === "syn:") {
    genModel = `hf:${requested.slice(prefix.length)}`;
  }

  return [{ ...base, genModel, catModelContains: genModel }];
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  const t = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms),
  );
  return Promise.race([p, t]);
}

function extractText(json: any): string {
  // OpenAI-compatible shape across all three providers. GLM-5.2 and other
  // reasoning models populate `reasoning_content`/`reasoning` separately and
  // may leave `content` empty until reasoning completes — treat either as
  // proof of real generation.
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  const content = msg.content ?? choice?.text ?? "";
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? "";
  const text = (typeof content === "string" ? content : "") || reasoning;
  return text || (typeof json?.output === "string" ? json.output : "");
}

async function probeProvider(cfg: ProbeConfig): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    ...(cfg.zoAsk ? { authorization: cfg.auth } : { Authorization: `Bearer ${cfg.auth}` }),
    "content-type": "application/json",
    ...(cfg.needsUa ? { "User-Agent": OPENCODE_UA } : {}),
  };
  const result: ProbeResult = {
    route: cfg.route,
    provider: cfg.provider,
    catalogOk: false,
    catalogCount: null,
    genOk: false,
    genText: "",
    httpStatus: 0,
    error: null,
    elapsedMs: 0,
  };
  const start = Date.now();

  // --- Catalog fetch ---
  if (cfg.catUrl) {
    try {
      const catResp = await withTimeout(fetch(cfg.catUrl, { headers }), 15_000, `${cfg.provider} catalog`);
      if (catResp.ok) {
        const cat = (await catResp.json()) as { data?: any[] };
        result.catalogCount = cat.data?.length ?? 0;
        result.catalogOk = (cat.data ?? []).some((model) =>
          typeof model?.id === "string" && model.id.includes(cfg.catModelContains)
        );
      } else {
        result.error = `catalog HTTP ${catResp.status}`;
      }
    } catch (e: any) {
      result.error = `catalog: ${e.message}`;
    }
  } else {
    result.catalogCount = cfg.cachedCatalogCount ?? 0;
    result.catalogOk = result.catalogCount > 0;
  }

  // --- Generation call ---
  try {
    const genResp = await withTimeout(
      fetch(cfg.genUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(cfg.zoAsk
          ? { input: PROBE_PROMPT, model_name: cfg.genModel }
          : {
              model: cfg.genModel,
              messages: [{ role: "user", content: PROBE_PROMPT }],
              max_tokens: PROBE_PROMPT === DEFAULT_PROBE_PROMPT
                ? DEFAULT_MAX_TOKENS
                : CONSENSUS_MAX_TOKENS,
            }),
      }),
      GEN_TIMEOUT_MS,
      `${cfg.provider} generation`,
    );
    result.httpStatus = genResp.status;
    if (!genResp.ok) {
      const body = await genResp.text().catch(() => "");
      result.error = `gen HTTP ${genResp.status}: ${body.slice(0, 160)}`;
    } else {
      const json = await genResp.json();
      const text = extractText(json).trim();
      result.genText = text;
      result.genOk = text.length > 0;
    }
  } catch (e: any) {
    result.error = `gen: ${e.message}`;
  }

  result.elapsedMs = Date.now() - start;
  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      model: { type: "string" },
      prompt: { type: "string" },
    },
    allowPositionals: true,
  });

  if (values.prompt) setProbePrompt(String(values.prompt));

  const synKey = process.env.SYNTHETIC_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const ocKey = process.env.OPENCODE_API_KEY;
  const kimiKey = process.env.KIMI_API_KEY;
  const zoToken = process.env.ZO_CLIENT_IDENTITY_TOKEN || process.env.ZO_TOKEN;
  const byokModel = resolveByokAlias("byok:claude-fable-5");
  const byokCount = loadByok()?.models.length ?? 0;

  const missing = [
    ["SYNTHETIC_API_KEY", synKey],
    ["OPENROUTER_API_KEY", orKey],
    ["OPENCODE_API_KEY", ocKey],
    ["KIMI_API_KEY", kimiKey],
    ["ZO_CLIENT_IDENTITY_TOKEN or ZO_TOKEN", zoToken],
    ["live BYOK alias byok:claude-fable-5", byokModel],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const all = [
    {
      route: "byok:",
      provider: "zo-byok",
      genUrl: "https://api.zo.computer/zo/ask",
      catUrl: null,
      cachedCatalogCount: byokCount,
      genModel: byokModel!,
      catModelContains: byokModel!,
      auth: zoToken!,
      needsUa: false,
      zoAsk: true,
    },
    {
      route: "hf:",
      provider: "synthetic",
      genUrl: SYNTHETIC_GEN,
      catUrl: SYNTHETIC_CAT,
      genModel: "hf:zai-org/GLM-5.2",
      catModelContains: "hf:zai-org/GLM-5.2",
      auth: synKey!,
      needsUa: false,
      zoAsk: false,
    },
    {
      route: "or:",
      provider: "openrouter",
      genUrl: OPENROUTER_GEN,
      catUrl: OPENROUTER_CAT,
      genModel: "z-ai/glm-5.2",
      catModelContains: "z-ai/glm-5.2",
      auth: orKey!,
      needsUa: false,
      zoAsk: false,
    },
    {
      route: "oc:",
      provider: "opencode",
      genUrl: OPENCODE_GEN,
      catUrl: OPENCODE_CAT,
      genModel: "glm-5.2",
      catModelContains: "glm-5.2",
      auth: ocKey!,
      needsUa: true,
      zoAsk: false,
    },
    {
      route: "kimi:",
      provider: "kimi",
      genUrl: KIMI_GEN,
      catUrl: KIMI_CAT,
      genModel: "kimi-k3",
      catModelContains: "kimi-k3",
      auth: kimiKey!,
      needsUa: false,
      zoAsk: false,
    },
  ];

  const targets = selectProbeTargets(all, values.model ? String(values.model) : undefined);
  if (targets.length === 0) {
    console.error(`Unsupported model route: ${String(values.model)}`);
    process.exit(2);
  }
  const results = await Promise.all(targets.map(probeProvider));

  const allPass = results.every((r) => r.catalogOk && r.genOk);

  if (values.json) {
    console.log(JSON.stringify({ allPass, results }, null, 2));
  } else {
    for (const r of results) {
      const cat = r.catalogOk ? `✅ catalog(${r.catalogCount})` : `❌ catalog`;
      const gen = r.genOk ? `✅ gen "${r.genText.slice(0, 20)}"` : `❌ gen`;
      const http = r.httpStatus ? `HTTP ${r.httpStatus}` : "";
      console.log(`${r.route.padEnd(6)} ${r.provider.padEnd(11)} ${cat}  ${gen}  ${http}  ${r.elapsedMs}ms${r.error ? `  ⚠ ${r.error}` : ""}`);
    }
    console.log(allPass ? "\n✅ ALL PROVIDERS OK — gate failover paths healthy." : "\n❌ PROVIDER FAILURE — see above.");
  }

  process.exit(allPass ? 0 : 1);
}

if (import.meta.main) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
