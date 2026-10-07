import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";

// Restores the consensus-gate cost_ledger writer that was removed in mid-June
// 2026 (last live write 2026-06-16). Prices each quorum call and appends a row
// to cost_ledger so the /dashboard Costs tab tracks current gate routing spend.
const LEDGER_DB = process.env.COST_LEDGER_DB || "/home/workspace/.swarm/swarm.db";
const CATALOG_CACHE = `${process.env.HOME}/.zouroboros/synthetic-catalog.json`;

// Static rates for non-synthetic providers, USD per 1M tokens.
const XAI_RATES: Record<string, { input: number; output: number }> = {
  "grok-3-mini": { input: 0.3, output: 0.5 },
};
// Conservative rate for genuinely unknown models. Tagged 'static-fallback' (NOT
// 'unknown-fallback') so the dashboard's seed-row exclusion never hides a real
// call — only the May smoke-test seeds carry 'unknown-fallback'.
const UNKNOWN_RATE = { input: 1, output: 5 };

export interface LedgerUsage {
  model: string; // canonical model id, e.g. hf:zai-org/GLM-5.1 or xai:grok-3-mini
  provider: string; // serving provider: synthetic.new | x.ai | openrouter | opencode | zo-proxy
  inputTokens: number;
  outputTokens: number;
  // Real provider-billed cost in USD for this call, when the vendor returns one
  // (OpenRouter usage.cost, Opencode Zen top-level cost). Authoritative when > 0:
  // it supersedes the token-estimate so the ledger tracks actual spend.
  billedUsd?: number;
}

function parsePrice(s: string): number {
  const n = parseFloat((s || "").replace(/[^0-9eE.+-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

let catalogRates: Record<string, { input: number; output: number }> | null = null;
// Read synthetic.new catalog rates straight from the cache file. Unlike
// catalog.loadCachedCatalog() this ignores the 14-day staleness gate — a
// slightly old rate card is a fine estimate and beats falling back to $1/$5.
function loadCatalogRates(): Record<string, { input: number; output: number }> {
  if (catalogRates) return catalogRates;
  catalogRates = {};
  try {
    if (existsSync(CATALOG_CACHE)) {
      const cache = JSON.parse(readFileSync(CATALOG_CACHE, "utf8"));
      for (const m of cache.models || []) {
        catalogRates[m.id] = {
          input: parsePrice(m.pricing?.prompt) * 1e6, // per-token → per-1M
          output: parsePrice(m.pricing?.completion) * 1e6,
        };
      }
    }
  } catch {}
  return catalogRates;
}

function priceFor(model: string): {
  input: number;
  output: number;
  rateSource: string;
  estimated: boolean;
} {
  // synthetic.new and OpenRouter both serve the hf: catalog models, so the
  // synthetic rate card is the best available price for either path.
  if (model.startsWith("hf:")) {
    const r = loadCatalogRates()[model];
    if (r && (r.input > 0 || r.output > 0)) {
      return { input: r.input, output: r.output, rateSource: "synthetic-catalog", estimated: false };
    }
  }
  if (model.startsWith("xai:")) {
    const r = XAI_RATES[model.slice(4)];
    if (r) return { input: r.input, output: r.output, rateSource: "static-xai", estimated: false };
  }
  return { input: UNKNOWN_RATE.input, output: UNKNOWN_RATE.output, rateSource: "static-fallback", estimated: true };
}

function vendorCode(provider: string): string {
  const p = (provider || "").toLowerCase();
  if (p.includes("synthetic")) return "synthetic";
  if (p === "xai" || p.includes("x.ai")) return "xai";
  if (p.includes("openrouter")) return "openrouter";
  if (p.includes("opencode")) return "opencode";
  if (p.includes("zo")) return "zo-proxy";
  return "unknown";
}

// Append one cost_ledger row per usage record. Returns rows written. Callers
// must wrap this in try/catch so a ledger failure never blocks a gate verdict.
export function recordUsage(
  rows: LedgerUsage[],
  meta: { source?: string; runId?: string | null; label?: string | null }
): number {
  const valid = rows.filter(
    (r) => r && r.model && (r.inputTokens > 0 || r.outputTokens > 0 || (r.billedUsd ?? 0) > 0)
  );
  if (!valid.length) return 0;
  const db = new Database(LEDGER_DB);
  try {
    db.run("PRAGMA busy_timeout = 3000");
    const stmt = db.prepare(
      `INSERT INTO cost_ledger (ts, source, run_id, label, model, vendor, input_tokens, output_tokens, cost_usd, rate_source, estimated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const ts = Date.now();
    const source = meta.source || "consensus-gate";
    let n = 0;
    for (const r of valid) {
      const inTok = Math.max(0, Math.round(r.inputTokens));
      const outTok = Math.max(0, Math.round(r.outputTokens));
      const vendor = vendorCode(r.provider);

      // Prefer the vendor's own billed cost when present — it reflects actual
      // spend (provider-specific tiering, cache discounts, surcharges) that a
      // static rate card can't. Fall back to the token estimate otherwise.
      let cost: number;
      let rateSource: string;
      let estimated: number;
      if (typeof r.billedUsd === "number" && r.billedUsd > 0) {
        cost = r.billedUsd;
        rateSource = `${vendor}-billed`;
        estimated = 0;
      } else {
        const p = priceFor(r.model);
        cost = (inTok * p.input + outTok * p.output) / 1e6;
        rateSource = p.rateSource;
        estimated = p.estimated ? 1 : 0;
      }

      stmt.run(
        ts,
        source,
        meta.runId ?? null,
        meta.label ?? null,
        r.model,
        vendor,
        inTok,
        outTok,
        cost,
        rateSource,
        estimated
      );
      n++;
    }
    return n;
  } finally {
    db.close();
  }
}
