import { readFileSync } from 'node:fs';
import type { ComplexityTier, ExecutorRegistryEntry, Task } from '../types.js';
import { selectShared, readSharedCatalog } from './shared-catalog.js';
import {
  readBestModelCatalogSync,
  resolveCatalogModel,
  type CatalogTier,
} from './model-catalog.js';

export interface ModelRoute {
  executorId: string;
  model: string;
  tier: ComplexityTier;
  source: 'task' | 'role' | 'registry' | 'default';
  catalogSource?: 'pin' | 'catalog' | 'floor';
  fallbackReason?: string;
}

interface RouterSpec {
  defaultModel: string;
  tierMap: Record<ComplexityTier | string, string>;
  acceptedPrefixes?: string[];
  rejectPrefixes?: string[];
  stripPrefixes?: string[];
  fallbackModel?: string;
  passthrough?: boolean;
}

const STATIC_FLOOR_ROUTERS: Record<string, RouterSpec> = (() => {
  try {
    const registry = JSON.parse(readFileSync(new URL('../executor/registry/executor-registry.json', import.meta.url), 'utf8'));
    return Object.fromEntries(registry.executors.filter((e: ExecutorRegistryEntry) => e.modelRouter).map((e: ExecutorRegistryEntry) => [e.id, { ...e.modelRouter, tierMap: e.modelRouter?.tierMap ?? {} }]));
  } catch { return {}; }
})();

const TIER_ALIASES: Record<string, CatalogTier> = {
  opus: 'heavy', frontier: 'heavy', pro: 'heavy', heavy: 'heavy', complex: 'heavy', 'swarm-heavy': 'heavy',
  sonnet: 'mid', balanced: 'mid', mid: 'mid', moderate: 'mid', 'swarm-mid': 'mid',
  haiku: 'light', flash: 'light', mini: 'light', light: 'light', simple: 'light', trivial: 'light', 'swarm-light': 'light', 'swarm-failover': 'light',
};

function normalizeSpec(entry?: ExecutorRegistryEntry): RouterSpec | undefined {
  const fromRegistry = entry?.modelRouter;
  const fallback = STATIC_FLOOR_ROUTERS[entry?.id ?? ''];
  if (!fromRegistry) return fallback;
  return {
    defaultModel: fromRegistry.defaultModel ?? fallback?.defaultModel ?? entry?.config.model ?? '',
    fallbackModel: fromRegistry.fallbackModel ?? fallback?.fallbackModel,
    acceptedPrefixes: fromRegistry.acceptedPrefixes ?? fallback?.acceptedPrefixes,
    rejectPrefixes: fromRegistry.rejectPrefixes ?? fallback?.rejectPrefixes,
    stripPrefixes: fromRegistry.stripPrefixes ?? fallback?.stripPrefixes,
    passthrough: fromRegistry.passthrough ?? fallback?.passthrough,
    tierMap: { ...(fallback?.tierMap ?? {}), ...(fromRegistry.tierMap ?? {}) },
  };
}

function stripKnownPrefix(model: string, spec: RouterSpec): string {
  for (const prefix of spec.stripPrefixes ?? []) if (model.startsWith(prefix)) return model.slice(prefix.length);
  return model;
}

function acceptsModel(model: string, spec: RouterSpec): boolean {
  if (spec.passthrough) return true;
  return (spec.acceptedPrefixes ?? []).some(prefix => model.startsWith(prefix));
}

function aliasTier(requestedModel: string): CatalogTier | null {
  const normalized = requestedModel.trim().toLowerCase();
  if (normalized === 'gpt-5.x' || /^gpt-\d+\.x$/.test(normalized)) return 'heavy';
  return TIER_ALIASES[normalized] ?? null;
}

export function resolveModelForExecutor(
  task: Task,
  executorId: string,
  tier: ComplexityTier,
  entry?: ExecutorRegistryEntry,
  roleModel?: string,
): ModelRoute | null {
  const spec = normalizeSpec(entry ?? ({ id: executorId } as ExecutorRegistryEntry));
  if (!spec) return null;

  const requestedModel = task.model || roleModel;
  const requestedTier = requestedModel ? aliasTier(requestedModel) : null;
  const effectiveTier: ComplexityTier = requestedTier === 'light' ? 'simple' : requestedTier === 'mid' ? 'moderate' : requestedTier === 'heavy' ? 'complex' : tier;
  const source = task.model ? 'task' : roleModel ? 'role' : entry?.modelRouter ? 'registry' : 'default';
  const catalog = entry ? readBestModelCatalogSync(process.env.SWARM_MODEL_CATALOG_PATH) : null;
  const resolveTierModel = () => {
    const native = readSharedCatalog();
    const nativeTier = effectiveTier === 'trivial' || effectiveTier === 'simple' ? 'light' : effectiveTier === 'moderate' ? 'mid' : 'heavy';
    const pin = entry?.modelPins?.[nativeTier];
    if (pin) return { model: pin, source: 'pin' as const, reason: 'explicit operator pin' };
    const route = selectShared('swarm', { harness: executorId, tier: nativeTier, catalog: native })[0] ?? selectShared('swarm', { harness: executorId, catalog: native })[0];
    if (route) return { model: route.model, source: 'catalog' as const, reason: 'VPS exact harness/provider qualification' };
    return entry?.modelRouter || catalog
    ? resolveCatalogModel({ ...entry, id: executorId, config: entry?.config ?? { defaultTimeout: 300 }, modelRouter: spec } as ExecutorRegistryEntry, executorId, effectiveTier, catalog)
    : {
      model: spec.tierMap[effectiveTier] ?? spec.defaultModel,
      source: 'floor' as const,
      reason: 'static router floor',
    };
  };
  let model: string;
  let catalogSource: ModelRoute['catalogSource'];
  let fallbackReason: string | undefined;

  if (requestedModel && aliasTier(requestedModel)) {
    const resolved = resolveTierModel();
    model = resolved.model;
    catalogSource = resolved.source;
    if (resolved.source === 'floor') fallbackReason = resolved.reason;
  } else if (requestedModel) {
    model = spec.tierMap[requestedModel] ?? requestedModel;
  } else {
    const resolved = resolveTierModel();
    model = resolved.model;
    catalogSource = resolved.source;
    if (resolved.source === 'floor') fallbackReason = resolved.reason;
  }

  model = stripKnownPrefix(model, spec);
  if ((spec.rejectPrefixes ?? []).some(prefix => model.startsWith(prefix))) return null;

  if (!acceptsModel(model, spec)) {
    model = stripKnownPrefix(spec.fallbackModel || spec.defaultModel, spec);
    catalogSource = 'floor';
    fallbackReason = `requested model '${requestedModel}' is incompatible with ${executorId}; static fallback model selected`;
  }

  if (!model) return null;
  return { executorId, model, tier, source, catalogSource, fallbackReason };
}
