#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import {
  type Tier,
  type RawModel,
  type ClassifiedModel,
  type CatalogCache,
  parsePrice,
  buildChain,
  diffCatalog,
  classifyOpenWeights,
  isAggregatorRestrictedFlagship,
} from "./catalog";
import { canonicalModelFamily } from "./model-identity";

const CACHE_PATH = `${process.env.HOME}/.zouroboros/openrouter-catalog.json`;
const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

// OpenRouter pricing is per-token USD as plain decimal strings ("0.000005"),
// no "$" prefix (unlike Synthetic). parsePrice strips non-numeric chars either way.
// Fast = cheap output. $2/M tokens output is the cut between fast and flagship here;
// free models ("0") fall into fast. If OpenRouter compresses flagship pricing under
// this, revisit the threshold.
const FAST_OUTPUT_CEIL = 2e-6;

// Anthropic/OpenAI flagships must come from BYOK only (free subscription keys).
// OpenRouter-sourced claude/gpt flagships are paid per-token — drop them so
// lineups never route a flagship seat through the aggregator; the picker falls
// back to open-weights (synthetic hf:) equivalents. Fast/coder tiers and
// non-Anthropic/OpenAI families (glm, kimi, minimax, qwen, nemotron …) stay.
interface ORRawModel {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string | null;
  open_weights?: boolean | null;
  openWeights?: boolean | null;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { output_modalities?: string[] };
  supported_parameters?: string[];
}

function classify(raw: ORRawModel): ClassifiedModel {
  // OpenRouter ids are "<provider-or-org>/<model>", e.g. "anthropic/claude-opus-4.7".
  const family = canonicalModelFamily(raw.id);
  const promptCost = parsePrice(raw.pricing?.prompt || "0");
  const completionCost = parsePrice(raw.pricing?.completion || "0");

  let tier: Tier;
  if (/cod(e|er)/i.test(raw.id)) tier = "coder";
  else if (/flash|mini|nano|lite|haiku|small|8b|7b/i.test(raw.id) || completionCost < FAST_OUTPUT_CEIL)
    tier = "fast";
  else tier = "flagship";

  const model: RawModel = {
    id: raw.id,
    hugging_face_id: raw.hugging_face_id || undefined,
    open_weights: raw.open_weights,
    openWeights: raw.openWeights,
    context_length: raw.context_length ?? 0,
    pricing: { prompt: raw.pricing?.prompt || "0", completion: raw.pricing?.completion || "0" },
    supported_features: raw.supported_parameters,
  };
  return { ...model, family, tier, promptCost, completionCost, ...classifyOpenWeights(model) };
}

export function classifyOpenRouterModels(raw: ORRawModel[]): ClassifiedModel[] {
  const seen = new Set<string>();
  return raw
    .filter((m) => {
      if (!m.id || seen.has(m.id)) return false;
      seen.add(m.id);
      // text-output models only (skip image/audio-only); keep if modality unknown.
      const out = m.architecture?.output_modalities;
      if (out && !out.includes("text")) return false;
      return true;
    })
    .map(classify)
    // Policy guard: exclude aggregator-sourced Anthropic/OpenAI flagships. Keeps
    // the catalog free of paid per-token
    // claude/gpt flagships; byok flagships (free) remain the only such source.
    .filter((m) => !isAggregatorRestrictedFlagship(m));
}

export async function fetchLiveCatalog(): Promise<ClassifiedModel[]> {
  // Endpoint is public; auth header is sent if present but not required.
  const headers: Record<string, string> = {};
  const key = process.env.OPENROUTER_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  const resp = await fetch(CATALOG_URL, { headers });
  if (!resp.ok) throw new Error(`Catalog fetch failed: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as { data: ORRawModel[] };
  return classifyOpenRouterModels(data.data);
}

function loadCacheFile(p: string): CatalogCache | null {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as CatalogCache;
    const age = Date.now() - Date.parse(raw.fetched_at);
    if (!Number.isFinite(age) || age > STALE_AFTER_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

export function loadCachedCatalog(): CatalogCache | null {
  return loadCacheFile(CACHE_PATH);
}

export function getChain(modelId: string): string[] {
  const cached = loadCachedCatalog();
  return cached?.chains[modelId] || [];
}

export function writeCache(models: ClassifiedModel[]): CatalogCache {
  const chains: Record<string, string[]> = {};
  for (const m of models) chains[m.id] = buildChain(m, models);
  const cache: CatalogCache = {
    fetched_at: new Date().toISOString(),
    source: CATALOG_URL,
    models,
    chains,
  };
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  return cache;
}

async function cmdRefresh(showDiff: boolean): Promise<void> {
  const prev = loadCachedCatalog();
  const models = await fetchLiveCatalog();
  const next = writeCache(models);
  console.log(`✅ Cached ${models.length} OpenRouter models at ${CACHE_PATH}`);

  if (showDiff) {
    const diff = diffCatalog(prev, next);
    const totalChanges =
      diff.added.length + diff.removed.length + diff.priceChanges.length + diff.chainChanges.length;
    if (totalChanges === 0) {
      console.log("📋 No changes vs previous catalog");
    } else {
      console.log(`\n📋 OpenRouter catalog diff:`);
      if (diff.added.length) console.log(`  + Added (${diff.added.length}): ${diff.added.slice(0, 20).join(", ")}${diff.added.length > 20 ? " …" : ""}`);
      if (diff.removed.length) console.log(`  − Removed (${diff.removed.length}): ${diff.removed.slice(0, 20).join(", ")}${diff.removed.length > 20 ? " …" : ""}`);
      if (diff.priceChanges.length) {
        console.log(`  Δ Price changes (${diff.priceChanges.length}):`);
        for (const p of diff.priceChanges.slice(0, 20)) console.log(`     ${p.id}: ${p.old} → ${p.new}`);
      }
      if (diff.chainChanges.length) console.log(`  Δ Chain changes (${diff.chainChanges.length})`);
    }
    console.log(JSON.stringify({ diff_summary: diff, total_changes: totalChanges }));
  }
}

function cmdShow(): void {
  const cache = loadCachedCatalog();
  if (!cache) {
    console.error("No fresh cache — run 'catalog-openrouter.ts refresh' first");
    process.exit(1);
  }
  console.log(`OpenRouter catalog (${cache.models.length} models, fetched ${cache.fetched_at}):\n`);
  const byTier: Record<Tier, ClassifiedModel[]> = { flagship: [], fast: [], coder: [] };
  for (const m of cache.models) byTier[m.tier].push(m);
  for (const tier of ["flagship", "fast", "coder"] as Tier[]) {
    if (!byTier[tier].length) continue;
    console.log(`\n[${tier}] (${byTier[tier].length})`);
    for (const m of byTier[tier]) {
      console.log(`  ${m.id} (${m.family}) ctx=${m.context_length} in=${m.pricing.prompt} out=${m.pricing.completion}`);
    }
  }
}

function cmdChain(modelId: string): void {
  const chain = getChain(modelId);
  if (!chain.length) {
    console.log(`No chain for ${modelId} (model not in catalog or no same-tier substitutes)`);
    return;
  }
  console.log(`Chain for ${modelId}:`);
  for (let i = 0; i < chain.length; i++) console.log(`  ${i + 1}. ${chain[i]}`);
}

function cmdValidate(quorum: string[]): void {
  const cache = loadCachedCatalog();
  const liveIds = new Set(cache?.models.map((m) => m.id) || []);
  console.log(`Validating ${quorum.length} model(s) against OpenRouter catalog (${liveIds.size} known):\n`);
  let bad = 0;
  for (const id of quorum) {
    const inCatalog = liveIds.has(id);
    const chainLen = getChain(id).length;
    const ok = inCatalog && chainLen > 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "✅" : "❌"} ${id} | in_catalog=${inCatalog} chain=${chainLen}`);
  }
  if (bad > 0) {
    console.error(`\n${bad} model(s) missing from catalog`);
    process.exit(1);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      diff: { type: "boolean", default: false },
      quorum: { type: "string" },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0];

  if (cmd === "refresh") {
    await cmdRefresh(Boolean(values.diff));
  } else if (cmd === "show") {
    cmdShow();
  } else if (cmd === "chain") {
    const id = positionals[1];
    if (!id) {
      console.error("Usage: catalog-openrouter.ts chain <model-id>");
      process.exit(1);
    }
    cmdChain(id);
  } else if (cmd === "validate") {
    if (!values.quorum) {
      console.error("Usage: catalog-openrouter.ts validate --quorum a,b,c");
      process.exit(1);
    }
    const ids = values.quorum.split(",").map((s) => s.trim()).filter(Boolean);
    cmdValidate(ids);
  } else {
    console.log(`
Usage:
  catalog-openrouter.ts refresh [--diff]   Fetch live catalog from openrouter.ai and cache
  catalog-openrouter.ts show               Show cached catalog grouped by tier
  catalog-openrouter.ts chain <model-id>   Show fallback chain for a model
  catalog-openrouter.ts validate --quorum a,b,c   Verify models exist in catalog with non-empty chains
`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
