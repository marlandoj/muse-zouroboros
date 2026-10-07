#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import {
  buildChain,
  diffCatalog,
  type CatalogCache,
  type ClassifiedModel,
  type RawModel,
  type Tier,
  classifyOpenWeights,
} from "./catalog";

const CACHE_PATH = `${process.env.HOME}/.zouroboros/kimi-catalog.json`;
const CATALOG_URL = "https://api.moonshot.ai/v1/models";
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export const KIMI_MODEL_IDS = [
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.7-code-highspeed",
  "kimi-k2.6",
  "kimi-k2.5",
] as const;

interface KimiRawModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

const MODEL_METADATA: Record<(typeof KIMI_MODEL_IDS)[number], {
  contextLength: number;
  tier: Tier;
  label: string;
  promptCost: number;
  completionCost: number;
}> = {
  "kimi-k3": { contextLength: 1_048_576, tier: "flagship", label: "Kimi K3", promptCost: 3e-6, completionCost: 15e-6 },
  "kimi-k2.7-code": { contextLength: 262_144, tier: "coder", label: "Kimi K2.7 Code", promptCost: 0.95e-6, completionCost: 4e-6 },
  "kimi-k2.7-code-highspeed": { contextLength: 262_144, tier: "coder", label: "Kimi K2.7 Code HighSpeed", promptCost: 1.9e-6, completionCost: 8e-6 },
  "kimi-k2.6": { contextLength: 262_144, tier: "flagship", label: "Kimi K2.6", promptCost: 0.95e-6, completionCost: 4e-6 },
  "kimi-k2.5": { contextLength: 262_144, tier: "flagship", label: "Kimi K2.5", promptCost: 0.6e-6, completionCost: 3e-6 },
};

export function classifyKimiModels(rawModels: KimiRawModel[]): ClassifiedModel[] {
  const available = new Set(rawModels.map((model) => model.id));
  return KIMI_MODEL_IDS
    .filter((id) => available.has(id))
    .map((id) => {
      const metadata = MODEL_METADATA[id];
      const model: RawModel & { label: string } = {
        id: `kimi:${id}`,
        label: metadata.label,
        context_length: metadata.contextLength,
        pricing: { prompt: String(metadata.promptCost), completion: String(metadata.completionCost) },
        supported_features: ["text", "image", "video", "reasoning", "tools"],
      };
      return {
        ...model,
        family: "kimi",
        tier: metadata.tier,
        promptCost: metadata.promptCost,
        completionCost: metadata.completionCost,
        ...classifyOpenWeights(model),
      };
    });
}

export async function fetchLiveCatalog(): Promise<ClassifiedModel[]> {
  const key = process.env.KIMI_API_KEY;
  if (!key) throw new Error("KIMI_API_KEY not set");
  const response = await fetch(CATALOG_URL, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status} ${response.statusText}`);
  const data = await response.json() as { data?: KimiRawModel[] };
  if (!Array.isArray(data.data)) throw new Error("Catalog response did not contain a model list");
  return classifyKimiModels(data.data);
}

export function loadCachedCatalog(): CatalogCache | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")) as CatalogCache;
    const age = Date.now() - Date.parse(cache.fetched_at);
    return Number.isFinite(age) && age <= STALE_AFTER_MS ? cache : null;
  } catch {
    return null;
  }
}

export function writeCache(models: ClassifiedModel[]): CatalogCache {
  const chains: Record<string, string[]> = {};
  for (const model of models) chains[model.id] = buildChain(model, models);
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

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { diff: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "show";

  if (command === "refresh") {
    const previous = loadCachedCatalog();
    const models = await fetchLiveCatalog();
    const next = writeCache(models);
    console.log(`Cached ${models.length} Kimi models at ${CACHE_PATH}`);
    if (values.diff) {
      const diff = diffCatalog(previous, next);
      const totalChanges = diff.added.length + diff.removed.length + diff.priceChanges.length + diff.chainChanges.length;
      console.log(JSON.stringify({ diff_summary: diff, total_changes: totalChanges }));
    }
    return;
  }

  if (command === "show") {
    const cache = loadCachedCatalog();
    if (!cache) throw new Error("No fresh cache; run catalog-kimi.ts refresh first");
    console.log(JSON.stringify(cache, null, 2));
    return;
  }

  throw new Error("Usage: catalog-kimi.ts refresh [--diff] | show");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
