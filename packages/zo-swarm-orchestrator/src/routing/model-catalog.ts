import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ComplexityTier, ExecutorRegistryEntry } from '../types.js';

export const MODEL_CATALOG_SCHEMA_VERSION = '1.0.0';
export const DEFAULT_MODEL_CATALOG_PATH = process.env.SWARM_MODEL_CATALOG_PATH || '/var/lib/zouroboros/model-routing/swarm/current.json';
const LAST_KNOWN_GOOD_NAME = 'last-known-good.json';

export type CatalogTier = 'light' | 'mid' | 'heavy';

export const MODEL_OUTPUT_PRICE_CAPS: Record<CatalogTier, number> = {
  light: 2,
  mid: 15,
  heavy: Number.POSITIVE_INFINITY,
};

export interface CatalogCandidate {
  model: string;
  sourceModel: string;
  family: string;
  quality: number;
  coding: number | null;
  agentic: number | null;
  intelligence: number | null;
  tokensPerSecond: number;
  outputPricePerMillion: number;
}

export interface QualificationEvidence {
  model: string;
  qualified: boolean;
  evidence: string;
  qualifiedAt: string | null;
}

export interface CatalogRoute {
  winner: Record<CatalogTier, string>;
  fallback: Record<CatalogTier, string>;
  candidates: Record<CatalogTier, CatalogCandidate[]>;
  qualification: Record<CatalogTier, QualificationEvidence>;
}

export interface ModelCatalog {
  schema_version: string;
  generated_at: string;
  source_generation: string;
  source_manifest_sha256: string;
  stale_after_hours: number;
  routes: Record<string, CatalogRoute>;
  content_sha256: string;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: Record<string, string | null>;
}

interface ArtificialAnalysisModel {
  id: string;
  name?: string;
  slug?: string;
  evaluations?: Record<string, number | null>;
  pricing?: Record<string, number | null>;
  performance?: Record<string, number | null>;
}

interface SourceArtifact<T> {
  generation?: string;
  generated_at?: string;
  records: T[];
}

interface JoinedArtifact {
  generation?: string;
  generated_at?: string;
  content_sha256?: string;
  manifest?: { content_sha256?: string };
  source_hashes?: { openrouter?: string; artificial_analysis?: string };
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function outputPrice(model: OpenRouterModel, artificial?: ArtificialAnalysisModel): number {
  const artificialPrice = finite(artificial?.pricing?.price_1m_output_tokens);
  if (artificialPrice !== null) return artificialPrice;
  const openRouterPrice = Number(model.pricing?.completion ?? NaN) * 1_000_000;
  return Number.isFinite(openRouterPrice) ? openRouterPrice : Number.POSITIVE_INFINITY;
}

function qualityMetrics(artificial?: ArtificialAnalysisModel): Pick<CatalogCandidate, 'quality' | 'coding' | 'agentic' | 'intelligence' | 'tokensPerSecond'> {
  const coding = finite(artificial?.evaluations?.artificial_analysis_coding_index);
  const agentic = finite(artificial?.evaluations?.artificial_analysis_agentic_index);
  const intelligence = finite(artificial?.evaluations?.artificial_analysis_intelligence_index);
  const quality = Math.max(coding ?? 0, agentic ?? 0, intelligence ?? 0);
  return {
    quality,
    coding,
    agentic,
    intelligence,
    tokensPerSecond: finite(artificial?.performance?.median_output_tokens_per_second) ?? 0,
  };
}

function matchArtificialAnalysis(model: OpenRouterModel, records: ArtificialAnalysisModel[]): ArtificialAnalysisModel | undefined {
  const sourceId = model.id.replace(/^.*\//, '').replace(/:batch$/, '');
  const keys = new Set([normalize(sourceId), normalize(model.name ?? '')].filter(Boolean));
  const matches = records.filter((record) => {
    const recordKeys = [normalize(record.id), normalize(record.slug ?? ''), normalize(record.name ?? '')].filter(Boolean);
    return recordKeys.some((key) => keys.has(key) || (key.length > 0 && key.startsWith(normalize(sourceId))));
  });
  return matches.sort((left, right) =>
    Math.max(finite(right.evaluations?.artificial_analysis_intelligence_index) ?? 0, finite(right.evaluations?.artificial_analysis_coding_index) ?? 0, finite(right.evaluations?.artificial_analysis_agentic_index) ?? 0) -
    Math.max(finite(left.evaluations?.artificial_analysis_intelligence_index) ?? 0, finite(left.evaluations?.artificial_analysis_coding_index) ?? 0, finite(left.evaluations?.artificial_analysis_agentic_index) ?? 0),
  )[0];
}

function candidateFor(model: OpenRouterModel, family: string, stripPrefix: string | undefined, artificial?: ArtificialAnalysisModel): CatalogCandidate {
  const metrics = qualityMetrics(artificial);
  return {
    model: stripPrefix && model.id.startsWith(stripPrefix) ? model.id.slice(stripPrefix.length) : model.id,
    sourceModel: model.id,
    family,
    ...metrics,
    outputPricePerMillion: outputPrice(model, artificial),
  };
}

function sortCandidates(candidates: CatalogCandidate[]): CatalogCandidate[] {
  return [...candidates].sort((left, right) =>
    right.quality - left.quality ||
    (right.coding ?? 0) - (left.coding ?? 0) ||
    (right.agentic ?? 0) - (left.agentic ?? 0) ||
    right.tokensPerSecond - left.tokensPerSecond ||
    left.outputPricePerMillion - right.outputPricePerMillion ||
    left.model.localeCompare(right.model),
  );
}

function rankCandidates(candidates: CatalogCandidate[]): Record<CatalogTier, CatalogCandidate[]> {
  const ordered = sortCandidates(candidates);
  const qualityValues = ordered.map((candidate) => candidate.quality).sort((a, b) => a - b);
  const median = qualityValues.length === 0 ? 0 : qualityValues[Math.floor(qualityValues.length / 2)]!;
  const qualityFloor = median * 0.5;
  const light = [...ordered]
    .filter((candidate) => candidate.outputPricePerMillion <= 2 && candidate.quality >= qualityFloor)
    .sort((left, right) => (right.tokensPerSecond / Math.max(right.outputPricePerMillion, 0.01)) - (left.tokensPerSecond / Math.max(left.outputPricePerMillion, 0.01)) || left.model.localeCompare(right.model));
  const mid = [...ordered]
    .filter((candidate) => candidate.outputPricePerMillion <= 15 && candidate.quality >= median)
    .sort((left, right) => (right.quality / Math.max(right.outputPricePerMillion, 0.01)) - (left.quality / Math.max(left.outputPricePerMillion, 0.01)) || left.model.localeCompare(right.model));
  return {
    light: light.length > 0 ? light : ordered.filter((candidate) => candidate.outputPricePerMillion <= MODEL_OUTPUT_PRICE_CAPS.light),
    mid: mid.length > 0 ? mid : ordered.filter((candidate) => candidate.outputPricePerMillion <= MODEL_OUTPUT_PRICE_CAPS.mid),
    heavy: ordered,
  };
}

function staticFloor(entry: ExecutorRegistryEntry, tier: CatalogTier): string {
  const pins = entry.modelPins ?? {};
  const router = entry.modelRouter?.tierMap ?? {};
  const complexity = tier === 'light' ? 'trivial' : tier === 'mid' ? 'moderate' : 'complex';
  return pins[tier] ?? router[`swarm-${tier}`] ?? router[tier] ?? router[complexity] ?? entry.modelRouter?.defaultModel ?? entry.config.model ?? `${entry.id}-${tier}`;
}

function familyCandidates(entry: ExecutorRegistryEntry, records: OpenRouterModel[], artificial: ArtificialAnalysisModel[]): CatalogCandidate[] {
  const families = entry.modelFamilies ?? [];
  const candidates: CatalogCandidate[] = [];
  for (const family of families) {
    for (const model of records) {
      if (!family.sourcePrefixes.some((prefix) => prefix === '*' || model.id.startsWith(prefix))) continue;
      if (model.id.startsWith('~') || model.id.endsWith(':batch') || /(?:image|audio|embedding|moderation|tts)/i.test(model.id)) continue;
      const candidate = candidateFor(model, family.name, family.stripPrefix, matchArtificialAnalysis(model, artificial));
      if (!candidates.some((existing) => existing.model === candidate.model)) candidates.push(candidate);
    }
  }
  return candidates;
}

export interface BuildCatalogOptions {
  registryPath: string;
  openRouterPath: string;
  artificialAnalysisPath: string;
  joinedPath?: string;
  existingCatalog?: ModelCatalog | null;
  now?: Date;
  staleAfterHours?: number;
}

export async function buildModelCatalog(options: BuildCatalogOptions): Promise<ModelCatalog> {
  const [registryRoot, openRouter, artificial, joined] = await Promise.all([
    readJson<{ executors: ExecutorRegistryEntry[] }>(options.registryPath),
    readJson<SourceArtifact<OpenRouterModel>>(options.openRouterPath),
    readJson<SourceArtifact<ArtificialAnalysisModel>>(options.artificialAnalysisPath),
    options.joinedPath ? readJson<JoinedArtifact>(options.joinedPath) : Promise.resolve({} as JoinedArtifact),
  ]);
  const now = options.now ?? new Date();
  const sourceGeneration = joined.generation ?? joined.generated_at ?? openRouter.generation ?? openRouter.generated_at ?? artificial.generation ?? artificial.generated_at ?? now.toISOString();
  const routes: Record<string, CatalogRoute> = {};
  for (const entry of registryRoot.executors) {
    const candidates = familyCandidates(entry, openRouter.records, artificial.records);
    if (candidates.length === 0) continue;
    const ranked = rankCandidates(candidates);
    const fallback = Object.fromEntries((['light', 'mid', 'heavy'] as CatalogTier[]).map((tier) => [tier, staticFloor(entry, tier)])) as Record<CatalogTier, string>;
    const winner = Object.fromEntries((['light', 'mid', 'heavy'] as CatalogTier[]).map((tier) => [tier, ranked[tier]![0]?.model ?? fallback[tier]])) as Record<CatalogTier, string>;
    const qualification = Object.fromEntries((['light', 'mid', 'heavy'] as CatalogTier[]).map((tier) => {
      const prior = options.existingCatalog?.routes[entry.id]?.qualification[tier];
      const priorStillAvailable = prior && ranked[tier]!.some((candidate) => candidate.model === prior.model);
      return [tier, priorStillAvailable ? prior : {
        model: fallback[tier],
        qualified: false,
        evidence: 'static-floor-bootstrap',
        qualifiedAt: now.toISOString(),
      }];
    })) as Record<CatalogTier, QualificationEvidence>;
    routes[entry.id] = {
      winner,
      fallback,
      candidates: ranked,
      qualification,
    };
  }
  const withoutHash = {
    schema_version: MODEL_CATALOG_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    source_generation: sourceGeneration,
    source_manifest_sha256: joined.manifest?.content_sha256 ?? joined.content_sha256 ?? '',
    stale_after_hours: options.staleAfterHours ?? 24,
    routes,
  };
  return { ...withoutHash, content_sha256: sha256Json(withoutHash) };
}

export async function publishModelCatalog(catalog: ModelCatalog, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  if (existsSync(outputPath)) await copyFile(outputPath, `${dirname(outputPath)}/${LAST_KNOWN_GOOD_NAME}`);
  await writeFile(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  await rename(tempPath, outputPath);
}

export async function readModelCatalog(path = DEFAULT_MODEL_CATALOG_PATH): Promise<ModelCatalog | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ModelCatalog;
  } catch {
    return null;
  }
}

export function readModelCatalogSync(path = DEFAULT_MODEL_CATALOG_PATH): ModelCatalog | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ModelCatalog;
  } catch {
    return null;
  }
}

export function readBestModelCatalogSync(path = DEFAULT_MODEL_CATALOG_PATH, now = new Date()): ModelCatalog | null {
  const current = readModelCatalogSync(path);
  if (current && catalogIsFresh(current, now)) return current;
  const lastKnownGood = readModelCatalogSync(`${dirname(path)}/${LAST_KNOWN_GOOD_NAME}`);
  return lastKnownGood ?? current;
}

export function catalogIsFresh(catalog: ModelCatalog, now = new Date(), maxAgeHours = catalog.stale_after_hours): boolean {
  const age = now.getTime() - Date.parse(catalog.generated_at);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeHours * 60 * 60 * 1000;
}

export function resolveCatalogModel(
  entry: ExecutorRegistryEntry,
  executorId: string,
  tier: ComplexityTier,
  catalog: ModelCatalog | null,
  now = new Date(),
): { model: string; source: 'pin' | 'catalog' | 'floor'; reason: string } {
  const catalogTier: CatalogTier = tier === 'trivial' || tier === 'simple' ? 'light' : tier === 'moderate' ? 'mid' : 'heavy';
  const pin = entry.modelPins?.[catalogTier];
  if (pin) return { model: pin, source: 'pin', reason: `model pin for ${executorId}/${catalogTier}` };
  const route = catalog?.routes[executorId];
  const qualification = route?.qualification[catalogTier];
  if (catalog && catalogIsFresh(catalog, now) && qualification?.qualified && qualification.model) {
    return { model: qualification.model, source: 'catalog', reason: `qualified catalog model for ${executorId}/${catalogTier}` };
  }
  return { model: staticFloor(entry, catalogTier), source: 'floor', reason: catalog ? 'catalog missing, stale, or unqualified' : 'catalog unavailable' };
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
