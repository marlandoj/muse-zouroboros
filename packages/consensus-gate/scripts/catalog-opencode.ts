#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import {
  type Tier,
  type RawModel,
  type ClassifiedModel,
  type CatalogCache,
  buildChain,
  diffCatalog,
  classifyOpenWeights,
  isAggregatorRestrictedFlagship,
} from "./catalog";
import { canonicalModelFamily } from "./model-identity";

const CACHE_PATH = `${process.env.HOME}/.zouroboros/opencode-catalog.json`;
const CATALOG_URL = "https://opencode.ai/zen/v1/models";
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
// opencode.ai/zen is behind Cloudflare bot-protection (error 1010) that rejects
// requests lacking a browser-like User-Agent — present one or the fetch 403s.
const OPENCODE_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Anthropic/OpenAI flagships must come from BYOK only (free subscription keys).
// Opencode-sourced claude/gpt flagships are dropped so lineups never route a
// flagship seat through the aggregator; fall back to open-weights equivalents.
// Fast/coder tiers (oc:gpt-5.3-codex, oc:north-mini-code-free, …) stay.
// Opencode Zen (opencode.ai) is OpenAI-compatible at /zen/v1/chat/completions,
// but its /models list is the bare OpenAI shape ({id, object, created, owned_by})
// with NO pricing or context_length — unlike synthetic.new and OpenRouter. So
// tier classification here is name-only, and pricing is recorded as 0. Ids are
// namespaced with an "oc:" prefix (disjoint from hf:/xai:/openrouter slugs) so
// fallback chains route unambiguously back to the Opencode endpoint in
// consensus-gate.ts. Auth uses OPENCODE_API_KEY as a Bearer token.

interface OCRawModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

function classify(raw: OCRawModel): ClassifiedModel {
  const rawId = raw.id;
  // Brand/family is the leading token before the first separator:
  // "claude-opus-4-8" → claude, "glm-5.2" → glm, "kimi-k2.6" → kimi.
  const family = canonicalModelFamily(`oc:${rawId}`);

  let tier: Tier;
  if (/codex|coder|(^|[-_])code([-_]|$)/i.test(rawId)) tier = "coder";
  else if (/mini|nano|flash|haiku|lite|small|spark|free/i.test(rawId)) tier = "fast";
  else tier = "flagship";

  const model: RawModel = {
    id: `oc:${rawId}`,
    context_length: 0,
    pricing: { prompt: "0", completion: "0" },
  };
  return { ...model, family, tier, promptCost: 0, completionCost: 0, ...classifyOpenWeights(model) };
}

export function classifyOpencodeModels(raw: OCRawModel[]): ClassifiedModel[] {
  const seen = new Set<string>();
  return raw
    .filter((m) => {
      if (!m.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .map(classify)
    // Policy guard: exclude aggregator-sourced Anthropic/OpenAI flagships.
    .filter((m) => !isAggregatorRestrictedFlagship(m));
}

export async function fetchLiveCatalog(): Promise<ClassifiedModel[]> {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) throw new Error("OPENCODE_API_KEY not set");
  const resp = await fetch(CATALOG_URL, { headers: { Authorization: `Bearer ${key}`, "User-Agent": OPENCODE_UA } });
  if (!resp.ok) throw new Error(`Catalog fetch failed: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as { data: OCRawModel[] };
  return classifyOpencodeModels(data.data);
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
  console.log(`✅ Cached ${models.length} Opencode Zen models at ${CACHE_PATH}`);

  if (showDiff) {
    const diff = diffCatalog(prev, next);
    const totalChanges =
      diff.added.length + diff.removed.length + diff.priceChanges.length + diff.chainChanges.length;
    if (totalChanges === 0) {
      console.log("📋 No changes vs previous catalog");
    } else {
      console.log(`\n📋 Opencode catalog diff:`);
      if (diff.added.length) console.log(`  + Added (${diff.added.length}): ${diff.added.slice(0, 20).join(", ")}${diff.added.length > 20 ? " …" : ""}`);
      if (diff.removed.length) console.log(`  − Removed (${diff.removed.length}): ${diff.removed.slice(0, 20).join(", ")}${diff.removed.length > 20 ? " …" : ""}`);
      if (diff.chainChanges.length) console.log(`  Δ Chain changes (${diff.chainChanges.length})`);
    }
    console.log(JSON.stringify({ diff_summary: diff, total_changes: totalChanges }));
  }
}

function cmdShow(): void {
  const cache = loadCachedCatalog();
  if (!cache) {
    console.error("No fresh cache — run 'catalog-opencode.ts refresh' first");
    process.exit(1);
  }
  console.log(`Opencode Zen catalog (${cache.models.length} models, fetched ${cache.fetched_at}):\n`);
  const byTier: Record<Tier, ClassifiedModel[]> = { flagship: [], fast: [], coder: [] };
  for (const m of cache.models) byTier[m.tier].push(m);
  for (const tier of ["flagship", "fast", "coder"] as Tier[]) {
    if (!byTier[tier].length) continue;
    console.log(`\n[${tier}] (${byTier[tier].length})`);
    for (const m of byTier[tier]) {
      console.log(`  ${m.id} (${m.family})`);
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
  console.log(`Validating ${quorum.length} model(s) against Opencode catalog (${liveIds.size} known):\n`);
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
      console.error("Usage: catalog-opencode.ts chain <model-id>");
      process.exit(1);
    }
    cmdChain(id);
  } else if (cmd === "validate") {
    if (!values.quorum) {
      console.error("Usage: catalog-opencode.ts validate --quorum oc:a,oc:b,oc:c");
      process.exit(1);
    }
    const ids = values.quorum.split(",").map((s) => s.trim()).filter(Boolean);
    cmdValidate(ids);
  } else {
    console.log(`
Usage:
  catalog-opencode.ts refresh [--diff]   Fetch live catalog from opencode.ai/zen and cache
  catalog-opencode.ts show               Show cached catalog grouped by tier
  catalog-opencode.ts chain <model-id>   Show fallback chain for a model (oc:-prefixed)
  catalog-opencode.ts validate --quorum oc:a,oc:b,oc:c   Verify models exist in catalog with non-empty chains
`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
