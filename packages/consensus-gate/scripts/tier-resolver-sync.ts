#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Tier = "flagship" | "fast" | "coder";

interface CachedModel {
  id: string;
  family: string;
  tier: Tier;
  context_length: number;
  promptCost: number;
  completionCost: number;
}

interface CatalogCache {
  fetched_at: string;
  models: CachedModel[];
}

const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const LOCAL_TIER_ROOT = resolve(__dirname, "../../tier-resolver");
// tier-resolver is not vendored in the public package. Never fall back to a
// hardcoded monorepo path (that would mkdir junk into someone else's tree);
// require an explicit data dir instead.
const TIER_ROOT = existsSync(resolve(LOCAL_TIER_ROOT, "data")) ? LOCAL_TIER_ROOT : null;
const DATA_DIR = process.env.TIER_RESOLVER_DATA_DIR || (TIER_ROOT ? resolve(TIER_ROOT, "data") : null);
const OUT_FILE = DATA_DIR ? resolve(DATA_DIR, "external-models.json") : null;

function loadCache(name: string) {
  const cachePath = `${process.env.HOME}/.zouroboros/${name}-catalog.json`;
  if (!existsSync(cachePath)) return { cache: null, meta: { fetched_at: null, count: 0, stale: false, present: false } };
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf-8")) as CatalogCache;
    const age = Date.now() - Date.parse(cache.fetched_at);
    const stale = !Number.isFinite(age) || age > STALE_AFTER_MS;
    return {
      cache: stale ? null : cache,
      meta: { fetched_at: cache.fetched_at, count: cache.models?.length ?? 0, stale, present: true },
    };
  } catch {
    return { cache: null, meta: { fetched_at: null, count: 0, stale: false, present: true } };
  }
}

function entry(model: CachedModel, provider: string) {
  return {
    id: model.id,
    provider,
    family: model.family,
    tier: model.tier,
    costTier: model.completionCost < 2e-6 ? "low" : model.completionCost < 1e-5 ? "medium" : "high",
    contextLength: model.context_length,
    promptCost: model.promptCost,
    completionCost: model.completionCost,
  };
}

export function buildTierResolverPool() {
  const synthetic = loadCache("synthetic");
  const openrouter = loadCache("openrouter");
  const kimi = loadCache("kimi");
  const entries = [
    ...(synthetic.cache?.models ?? []).map((model) => entry(model, "synthetic.new")),
    ...(openrouter.cache?.models ?? []).map((model) => entry(model, "openrouter")),
    ...(kimi.cache?.models ?? []).map((model) => entry(model, "kimi")),
  ];
  const byTier = { flagship: [], fast: [], coder: [] } as Record<Tier, ReturnType<typeof entry>[]>;
  for (const model of entries) byTier[model.tier].push(model);
  for (const tier of Object.keys(byTier) as Tier[]) byTier[tier].sort((a, b) => a.completionCost - b.completionCost);
  const cheapestByTier: Partial<Record<Tier, ReturnType<typeof entry>>> = {};
  for (const tier of Object.keys(byTier) as Tier[]) if (byTier[tier][0]) cheapestByTier[tier] = byTier[tier][0];
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    advisory: true,
    sources: { synthetic: synthetic.meta, openrouter: openrouter.meta, kimi: kimi.meta },
    counts: { total: entries.length, flagship: byTier.flagship.length, fast: byTier.fast.length, coder: byTier.coder.length },
    cheapestByTier,
    byTier,
  };
}

export function syncTierResolverPool() {
  if (!DATA_DIR || !OUT_FILE) {
    throw new Error(
      "tier-resolver is not vendored in this repo; set TIER_RESOLVER_DATA_DIR to a writable data directory"
    );
  }
  const pool = buildTierResolverPool();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(pool, null, 2));
  if (pool.counts.total === 0) throw new Error("tier-resolver external pool is empty");
  return { output: OUT_FILE, ...pool };
}

function main() {
  const { positionals } = parseArgs({ allowPositionals: true });
  const command = positionals[0] || "sync";
  if (command !== "sync") throw new Error(`unknown command: ${command}`);
  const result = syncTierResolverPool();
  console.log(`Synced tier-resolver advisory pool to ${result.output}`);
  console.log(JSON.stringify({ sync_summary: { counts: result.counts, sources: result.sources } }));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
