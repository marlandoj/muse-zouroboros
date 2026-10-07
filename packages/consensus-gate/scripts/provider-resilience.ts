import * as fs from "fs";
import * as path from "path";
import { getChain as getLegacyChain, loadCachedCatalog as loadSyntheticCatalog, type CatalogCache, type Tier } from "./catalog";
import { loadCachedCatalog as loadOpenRouterCatalog } from "./catalog-openrouter";
import { loadCachedCatalog as loadOpencodeCatalog } from "./catalog-opencode";
import { loadCachedCatalog as loadByokCatalog, type ByokClassifiedModel } from "./catalog-byok";
import { loadCachedCatalog as loadKimiCatalog } from "./catalog-kimi";

export type ResilientProvider = "zo-byok" | "openrouter" | "opencode" | "synthetic" | "xai" | "kimi";

export interface ResilientModel {
  id: string;
  provider: ResilientProvider;
  family: string;
  tier: Tier;
  label?: string;
}

export interface ProviderCatalogSet {
  synthetic: ResilientModel[];
  openrouter: ResilientModel[];
  opencode: ResilientModel[];
  byok: ResilientModel[];
  kimi: ResilientModel[];
}

const FALLBACK_PROVIDER_ORDER: ResilientProvider[] = ["zo-byok", "kimi", "openrouter", "opencode", "synthetic"];
const HEALTH_PATH = `${process.env.HOME}/.zouroboros/provider-resilience-health.json`;
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;

export interface RouteHealthRecord {
  ok: boolean;
  provider: string;
  latencyMs: number;
  error?: string;
  observedAt: string;
  healthClass?: "transport" | "review";
}

export function loadRouteHealth(now = Date.now()): Record<string, RouteHealthRecord> {
  if (!fs.existsSync(HEALTH_PATH)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(HEALTH_PATH, "utf8")) as { routes?: Record<string, RouteHealthRecord> };
    return Object.fromEntries(Object.entries(parsed.routes ?? {}).filter(([, record]) => {
      const observed = Date.parse(record.observedAt);
      return Number.isFinite(observed) && now - observed <= HEALTH_TTL_MS;
    }));
  } catch {
    return {};
  }
}

export function writeRouteHealth(records: Array<Omit<RouteHealthRecord, "observedAt"> & { id: string }>, now = new Date()): void {
  const routes = loadRouteHealth(now.getTime());
  for (const { id, ...record } of records) {
    const key = record.healthClass === "review" ? `${id}::review` : id;
    routes[key] = { ...record, observedAt: now.toISOString() };
  }
  fs.mkdirSync(path.dirname(HEALTH_PATH), { recursive: true });
  const temporary = `${HEALTH_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ observedAt: now.toISOString(), routes }, null, 2));
  fs.renameSync(temporary, HEALTH_PATH);
}

export function providerForConsensusModel(model: string): ResilientProvider {
  if (model.startsWith("byok:")) return "zo-byok";
  if (model.startsWith("oc:")) return "opencode";
  if (model.startsWith("hf:") || model.startsWith("syn:")) return "synthetic";
  if (model.startsWith("xai:")) return "xai";
  if (model.startsWith("kimi:")) return "kimi";
  return "openrouter";
}

function identity(value: string): string {
  const leaf = value.replace(/^(byok:|oc:|hf:|syn:|xai:|kimi:)/i, "").split("/").pop() ?? value;
  return leaf
    .toLowerCase()
    .replace(/\b(synthetic|codex|code)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function inferFamily(model: string): string {
  const leaf = model.replace(/^(byok:|oc:|hf:|syn:|xai:|kimi:)/i, "").split("/").pop() ?? model;
  return leaf.toLowerCase().split(/[-_.]/)[0] || "unknown";
}

function inferTier(model: string): Tier {
  if (/codex|coder|(^|[-_])code([-_]|$)/i.test(model)) return "coder";
  if (/mini|nano|flash|haiku|lite|small|spark|free/i.test(model)) return "fast";
  return "flagship";
}

function fromCache(cache: CatalogCache | null, provider: ResilientProvider): ResilientModel[] {
  return (cache?.models ?? []).map((model) => ({
    id: model.id,
    provider,
    family: model.family,
    tier: model.tier,
    label: (model as ByokClassifiedModel).label,
  }));
}

export function loadProviderCatalogs(): ProviderCatalogSet {
  return {
    synthetic: fromCache(loadSyntheticCatalog(), "synthetic"),
    openrouter: fromCache(loadOpenRouterCatalog(), "openrouter"),
    opencode: fromCache(loadOpencodeCatalog(), "opencode"),
    byok: fromCache(loadByokCatalog(), "zo-byok"),
    kimi: fromCache(loadKimiCatalog(), "kimi"),
  };
}

function resolvePrimary(model: string, catalogs: ProviderCatalogSet): ResilientModel {
  const all = [...catalogs.synthetic, ...catalogs.openrouter, ...catalogs.opencode, ...catalogs.byok, ...catalogs.kimi];
  const known = all.find((candidate) => candidate.id === model);
  if (known) return known;
  return {
    id: model,
    provider: providerForConsensusModel(model),
    family: model.startsWith("xai:") ? "grok" : inferFamily(model),
    tier: inferTier(model),
  };
}

function candidateScore(primary: ResilientModel, candidate: ResilientModel, health: Record<string, RouteHealthRecord>): number {
  const primaryIdentity = identity(primary.label ?? primary.id);
  const candidateIdentity = identity(candidate.label ?? candidate.id);
  let score = 0;
  if (primaryIdentity && primaryIdentity === candidateIdentity) score += 10_000;
  if (primary.family === candidate.family && primary.tier === candidate.tier) score += 2_000;
  else if (primary.family === candidate.family) score += 1_200;
  else if (primary.tier === candidate.tier) score += 900;
  if (candidate.id.startsWith("hf:")) score += 20;
  if (!candidate.id.includes(":free")) score += 10;
  const transportHealth = health[candidate.id];
  const reviewHealth = health[`${candidate.id}::review`];
  if (transportHealth?.ok === true) score += 1_000;
  if (transportHealth?.ok === false) score -= 20_000;
  if (reviewHealth?.ok === true) score += 100_000;
  if (reviewHealth?.ok === false) score -= 100_000;
  return score;
}

function catalogFor(provider: ResilientProvider, catalogs: ProviderCatalogSet): ResilientModel[] {
  if (provider === "zo-byok") return catalogs.byok;
  if (provider === "openrouter") return catalogs.openrouter;
  if (provider === "opencode") return catalogs.opencode;
  if (provider === "synthetic") return catalogs.synthetic;
  if (provider === "kimi") return catalogs.kimi;
  return [];
}

export function buildProviderFallbackChain(
  model: string,
  catalogs: ProviderCatalogSet,
  health: Record<string, RouteHealthRecord> = loadRouteHealth(),
): ResilientModel[] {
  const primary = resolvePrimary(model, catalogs);
  const rankedByProvider = new Map<ResilientProvider, ResilientModel[]>();
  for (const provider of FALLBACK_PROVIDER_ORDER) {
    if (provider === primary.provider) continue;
    const candidates = catalogFor(provider, catalogs)
      .filter((candidate) => candidate.id !== model)
      .map((candidate, index) => ({ candidate, index, score: candidateScore(primary, candidate, health) }))
      .sort((a, b) => b.score - a.score || a.index - b.index || a.candidate.id.localeCompare(b.candidate.id));
    const first = candidates[0]?.candidate;
    const second = candidates.find(({ candidate }) => candidate.family !== first?.family)?.candidate
      ?? candidates[1]?.candidate;
    rankedByProvider.set(provider, [first, second].filter((candidate): candidate is ResilientModel => Boolean(candidate)));
  }
  const chain: ResilientModel[] = [];
  for (let round = 0; round < 2; round++) {
    for (const provider of FALLBACK_PROVIDER_ORDER) {
      const candidate = rankedByProvider.get(provider)?.[round];
      if (candidate) chain.push(candidate);
    }
  }
  return chain;
}

export function getResilientChain(model: string, catalogs = loadProviderCatalogs()): string[] {
  const providerDiverse = buildProviderFallbackChain(model, catalogs).map((candidate) => candidate.id);
  const legacy = getLegacyChain(model);
  return [...new Set([...providerDiverse, ...legacy])].filter((candidate) => candidate !== model);
}

export function selectProviderBalancedFallback(
  chain: string[],
  attempted: ReadonlySet<string>,
  providerAttempts: ReadonlyMap<ResilientProvider, number>,
): string | undefined {
  const candidates = chain.filter((candidate) => !attempted.has(candidate));
  if (candidates.length === 0) return undefined;
  const minimumAttempts = Math.min(...candidates.map((candidate) =>
    providerAttempts.get(providerForConsensusModel(candidate)) ?? 0
  ));
  return candidates.find((candidate) =>
    (providerAttempts.get(providerForConsensusModel(candidate)) ?? 0) === minimumAttempts
  );
}
