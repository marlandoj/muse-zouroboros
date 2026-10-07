#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { canonicalModelFamily, sameCanonicalModel } from "./model-identity";

const CACHE_PATH = `${process.env.HOME}/.zouroboros/synthetic-catalog.json`;
// Sibling provider cache, written by catalog-openrouter.ts. Same CatalogCache
// shape, disjoint id namespace — getChain consults it without importing that
// module (one-directional imports: openrouter → catalog).
const OPENROUTER_CACHE_PATH = `${process.env.HOME}/.zouroboros/openrouter-catalog.json`;
// Opencode Zen cache, written by catalog-opencode.ts. Same one-directional
// import rule (opencode → catalog); ids are oc:-prefixed so they never collide
// with hf:/openrouter slugs in getChain's lookup.
const OPENCODE_CACHE_PATH = `${process.env.HOME}/.zouroboros/opencode-catalog.json`;
const KIMI_CACHE_PATH = `${process.env.HOME}/.zouroboros/kimi-catalog.json`;
const CATALOG_URL = "https://api.synthetic.new/v1/models";
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CHAIN_LENGTH = 5;

export type Tier = "flagship" | "fast" | "coder";

export type OpenWeightsEvidence = "explicit" | "hugging-face-id" | "hf-route" | "verified-family" | "unknown";
export type LifecycleStatus = "promoted" | "cold-start-passed" | "provisional" | "shadow" | "rejected" | "unknown";
export type RouteHealth = "healthy" | "failing" | "unknown";

export interface RawModel {
  id: string;
  hugging_face_id?: string;
  open_weights?: boolean | null;
  openWeights?: boolean | null;
  context_length: number;
  pricing: { prompt: string; completion: string };
  supported_features?: string[];
}

export interface ClassifiedModel extends RawModel {
  family: string;
  tier: Tier;
  promptCost: number;
  completionCost: number;
  openWeights: boolean | null;
  openWeightsEvidence: OpenWeightsEvidence;
  lifecycleStatus?: LifecycleStatus;
  routeHealth?: RouteHealth;
}

export interface CatalogCache {
  fetched_at: string;
  source: string;
  models: ClassifiedModel[];
  chains: Record<string, string[]>;
}

export const AGGREGATOR_FLAGSHIP_FAMILIES: ReadonlySet<string> = new Set(["claude", "gpt"]);

export function isAggregatorRestrictedFlagship(model: { family: string; tier: Tier }): boolean {
  return AGGREGATOR_FLAGSHIP_FAMILIES.has(model.family) && model.tier === "flagship";
}

export const DEFAULT_CHAINS: Record<string, string[]> = {
  "hf:zai-org/GLM-5.2": [
    "hf:deepseek-ai/DeepSeek-R1-0528",
    "hf:moonshotai/Kimi-K2.7-Code",
    "hf:Qwen/Qwen3.5-397B-A17B",
    "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
    "hf:MiniMaxAI/MiniMax-M3",
  ],
  "hf:moonshotai/Kimi-K2.7-Code": [
    "hf:deepseek-ai/DeepSeek-R1-0528",
    "hf:Qwen/Qwen3.5-397B-A17B",
    "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
    "hf:zai-org/GLM-5.2",
    "hf:MiniMaxAI/MiniMax-M3",
  ],
  "hf:MiniMaxAI/MiniMax-M3": [
    "hf:deepseek-ai/DeepSeek-R1-0528",
    "hf:moonshotai/Kimi-K2.7-Code",
    "hf:Qwen/Qwen3.5-397B-A17B",
    "hf:zai-org/GLM-5.2",
    "hf:deepseek-ai/DeepSeek-V3.2",
  ],
};

export function parsePrice(s: string): number {
  const cleaned = (s || "").replace(/[^0-9eE.+-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function classifyOpenWeights(raw: Pick<RawModel, "id" | "hugging_face_id" | "open_weights" | "openWeights">): Pick<ClassifiedModel, "openWeights" | "openWeightsEvidence"> {
  const explicit = raw.open_weights ?? raw.openWeights;
  if (typeof explicit === "boolean") return { openWeights: explicit, openWeightsEvidence: "explicit" };
  if (raw.hugging_face_id) return { openWeights: true, openWeightsEvidence: "hugging-face-id" };
  if (raw.id.startsWith("hf:")) return { openWeights: true, openWeightsEvidence: "hf-route" };
  return { openWeights: null, openWeightsEvidence: "unknown" };
}

function classify(raw: RawModel): ClassifiedModel {
  const hfId = raw.hugging_face_id || raw.id.replace(/^hf:/, "");
  const family = canonicalModelFamily({ id: raw.id, family: hfId.split("/")[0] || "unknown" });
  const promptCost = parsePrice(raw.pricing.prompt);
  const completionCost = parsePrice(raw.pricing.completion);

  // Tier heuristic: "coder" by name match; "fast" by "flash" name or sub-microcent
  // output pricing (Synthetic's cheap tier is well under $1e-6/tok); else flagship.
  // If Synthetic adjusts pricing such that flagship models drop below $1e-6, this
  // misclassifies — revisit the threshold.
  let tier: Tier;
  if (/coder/i.test(raw.id)) tier = "coder";
  else if (/flash/i.test(raw.id) || completionCost < 1e-6) tier = "fast";
  else tier = "flagship";

  return { ...raw, family, tier, promptCost, completionCost, ...classifyOpenWeights(raw) };
}

function underlyingId(m: { id: string; hugging_face_id?: string }): string {
  return m.hugging_face_id || m.id.replace(/^hf:/, "");
}

// Lower rank = preferred representative when several aliases share one underlying
// model. synthetic.new exposes the same hugging_face_id under both a canonical
// `hf:<org>/<model>` id and opaque `syn:<size>:<text|vision>` routing aliases.
// Prefer the hf id (the vendor parse + fallback paths expect it) and prefer a
// text route over vision (vision adds nothing for code review and the alias
// often fails JSON parse on a plain code prompt).
function aliasRank(m: { id: string }): number {
  const isVision = m.id.includes(":vision");
  const isHf = m.id.startsWith("hf:");
  if (isHf) return isVision ? 1 : 0;
  return isVision ? 3 : 2;
}

export function buildChain(primary: ClassifiedModel, all: ClassifiedModel[]): string[] {
  const primaryKey = underlyingId(primary);
  const primaryFamily = canonicalModelFamily(primary);
  // Collapse alias duplicates to one entry per underlying model, dropping the
  // primary's own twin and keeping the best-ranked alias for each survivor.
  const byUnderlying = new Map<string, ClassifiedModel>();
  for (const m of all) {
    if (m.tier !== primary.tier) continue;
    const key = underlyingId(m);
    if (key === primaryKey || sameCanonicalModel(primary, m)) continue;
    const existing = byUnderlying.get(key);
    if (!existing || aliasRank(m) < aliasRank(existing)) {
      byUnderlying.set(key, m);
    }
  }
  const candidates = [...byUnderlying.values()];
  candidates.sort((a, b) => {
    const aDiff = canonicalModelFamily(a) !== primaryFamily ? 1 : 0;
    const bDiff = canonicalModelFamily(b) !== primaryFamily ? 1 : 0;
    if (aDiff !== bDiff) return bDiff - aDiff;
    return b.completionCost - a.completionCost;
  });
  return candidates.slice(0, MAX_CHAIN_LENGTH).map((m) => m.id);
}

export async function fetchLiveCatalog(): Promise<ClassifiedModel[]> {
  const key = process.env.SYNTHETIC_API_KEY;
  if (!key) throw new Error("SYNTHETIC_API_KEY not set");
  const resp = await fetch(CATALOG_URL, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) throw new Error(`Catalog fetch failed: ${resp.status} ${resp.statusText}`);
  const data = (await resp.json()) as { data: RawModel[] };
  return data.data.map(classify);
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

/**
 * Per-token USD pricing for a model id, consulted across all three provider
 * caches (synthetic, openrouter, opencode, kimi). The consensus gate uses this to
 * estimate spend for vendors that don't return a billed cost (synthetic.new).
 * Matches on the raw id or its provider-prefix-stripped form. Returns null when
 * the id isn't in any fresh cache or the cache prices it at zero.
 */
export function lookupPricing(modelId: string): { promptCost: number; completionCost: number } | null {
  const stripped = modelId.replace(/^(hf:|syn:|oc:|or:|xai:|kimi:)/, "");
  const caches = [
    loadCacheFile(CACHE_PATH),
    loadCacheFile(OPENROUTER_CACHE_PATH),
    loadCacheFile(OPENCODE_CACHE_PATH),
    loadCacheFile(KIMI_CACHE_PATH),
  ];
  for (const cache of caches) {
    if (!cache) continue;
    const hit = cache.models.find(
      (m) =>
        m.id === modelId ||
        m.id.replace(/^(hf:|syn:|oc:|or:|kimi:)/, "") === stripped ||
        m.hugging_face_id === stripped ||
        sameCanonicalModel(modelId, m)
    );
    if (hit && (hit.promptCost > 0 || hit.completionCost > 0)) {
      return { promptCost: hit.promptCost, completionCost: hit.completionCost };
    }
  }
  return null;
}

export function getChain(modelId: string): string[] {
  const synthetic = loadCachedCatalog();
  if (synthetic?.chains[modelId]) return synthetic.chains[modelId];
  const openrouter = loadCacheFile(OPENROUTER_CACHE_PATH);
  if (openrouter?.chains[modelId]) return openrouter.chains[modelId];
  const opencode = loadCacheFile(OPENCODE_CACHE_PATH);
  if (opencode?.chains[modelId]) return opencode.chains[modelId];
  const kimi = loadCacheFile(KIMI_CACHE_PATH);
  if (kimi?.chains[modelId]) return kimi.chains[modelId];
  return DEFAULT_CHAINS[modelId] || [];
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

export interface DiffSummary {
  added: string[];
  removed: string[];
  priceChanges: { id: string; old: string; new: string }[];
  chainChanges: { id: string; old: string[]; new: string[] }[];
}

export function diffCatalog(prev: CatalogCache | null, next: CatalogCache): DiffSummary {
  const summary: DiffSummary = { added: [], removed: [], priceChanges: [], chainChanges: [] };
  if (!prev) {
    summary.added = next.models.map((m) => m.id);
    return summary;
  }
  const prevIds = new Set(prev.models.map((m) => m.id));
  const nextIds = new Set(next.models.map((m) => m.id));
  summary.added = [...nextIds].filter((id) => !prevIds.has(id));
  summary.removed = [...prevIds].filter((id) => !nextIds.has(id));

  const prevModels = new Map(prev.models.map((m) => [m.id, m]));
  for (const m of next.models) {
    const old = prevModels.get(m.id);
    if (!old) continue;
    const oldTotal = old.promptCost + old.completionCost;
    const newTotal = m.promptCost + m.completionCost;
    if (oldTotal > 0 && Math.abs(newTotal - oldTotal) / oldTotal > 0.1) {
      summary.priceChanges.push({
        id: m.id,
        old: `${old.pricing.prompt}/${old.pricing.completion}`,
        new: `${m.pricing.prompt}/${m.pricing.completion}`,
      });
    }
  }
  for (const [id, newChain] of Object.entries(next.chains)) {
    const oldChain = prev.chains[id];
    if (!oldChain) continue;
    if (oldChain.join("|") !== newChain.join("|")) {
      summary.chainChanges.push({ id, old: oldChain, new: newChain });
    }
  }
  return summary;
}

async function cmdRefresh(showDiff: boolean): Promise<void> {
  const prev = loadCachedCatalog();
  const models = await fetchLiveCatalog();
  const next = writeCache(models);
  console.log(`✅ Cached ${models.length} models at ${CACHE_PATH}`);

  if (showDiff) {
    const diff = diffCatalog(prev, next);
    const totalChanges =
      diff.added.length + diff.removed.length + diff.priceChanges.length + diff.chainChanges.length;
    if (totalChanges === 0) {
      console.log("📋 No changes vs previous catalog");
    } else {
      console.log(`\n📋 Catalog diff:`);
      if (diff.added.length) console.log(`  + Added (${diff.added.length}): ${diff.added.join(", ")}`);
      if (diff.removed.length) console.log(`  − Removed (${diff.removed.length}): ${diff.removed.join(", ")}`);
      if (diff.priceChanges.length) {
        console.log(`  Δ Price changes (${diff.priceChanges.length}):`);
        for (const p of diff.priceChanges) console.log(`     ${p.id}: ${p.old} → ${p.new}`);
      }
      if (diff.chainChanges.length) {
        console.log(`  Δ Chain changes (${diff.chainChanges.length}):`);
        for (const c of diff.chainChanges) {
          console.log(`     ${c.id}:`);
          console.log(`       was: [${c.old.join(", ")}]`);
          console.log(`       now: [${c.new.join(", ")}]`);
        }
      }
    }
    console.log(JSON.stringify({ diff_summary: diff, total_changes: totalChanges }));
  }
}

function cmdShow(): void {
  const cache = loadCachedCatalog();
  if (!cache) {
    console.error("No fresh cache — run 'catalog.ts refresh' first");
    process.exit(1);
  }
  console.log(`Catalog (${cache.models.length} models, fetched ${cache.fetched_at}):\n`);
  const byTier: Record<Tier, ClassifiedModel[]> = { flagship: [], fast: [], coder: [] };
  for (const m of cache.models) byTier[m.tier].push(m);
  for (const tier of ["flagship", "fast", "coder"] as Tier[]) {
    if (!byTier[tier].length) continue;
    console.log(`\n[${tier}]`);
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
  console.log(`Validating ${quorum.length} quorum models against catalog (${liveIds.size} known):\n`);
  let bad = 0;
  for (const id of quorum) {
    const inCatalog = liveIds.has(id);
    const chainLen = getChain(id).length;
    const ok = inCatalog && chainLen > 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "✅" : "❌"} ${id} | in_catalog=${inCatalog} chain=${chainLen}`);
  }
  if (bad > 0) {
    console.error(`\n${bad} quorum model(s) missing from catalog`);
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
      console.error("Usage: catalog.ts chain <model-id>");
      process.exit(1);
    }
    cmdChain(id);
  } else if (cmd === "validate") {
    const ids = (values.quorum || "hf:zai-org/GLM-5.2,hf:moonshotai/Kimi-K2.7-Code,hf:MiniMaxAI/MiniMax-M3")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    cmdValidate(ids);
  } else {
    console.log(`
Usage:
  catalog.ts refresh [--diff]      Fetch live catalog from synthetic.new and cache
  catalog.ts show                  Show cached catalog grouped by tier
  catalog.ts chain <model-id>      Show fallback chain for a model
  catalog.ts validate [--quorum a,b,c]   Verify quorum models exist in catalog with non-empty chains
`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
