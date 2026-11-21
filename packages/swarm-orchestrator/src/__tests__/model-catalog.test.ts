import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildModelCatalog,
  catalogIsFresh,
  publishModelCatalog,
  readBestModelCatalogSync,
  resolveCatalogModel,
} from '../routing/model-catalog.js';
import type { ExecutorRegistryEntry } from '../types.js';

const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'swarm-model-catalog-'));
  scratch.push(root);
  const registryPath = join(root, 'registry.json');
  const openRouterPath = join(root, 'openrouter.json');
  const artificialPath = join(root, 'artificial-analysis.json');
  const joinedPath = join(root, 'joined.json');
  const outputPath = join(root, 'current.json');
  const entry: ExecutorRegistryEntry = {
    id: 'claude-code', name: 'Claude', executor: 'local', description: 'test', expertise: [], bestFor: [],
    config: { defaultTimeout: 300, model: 'claude-sonnet-5' },
    modelRouter: { tierMap: { light: 'claude-light', mid: 'claude-mid', heavy: 'claude-heavy' } },
    modelFamilies: [{ name: 'anthropic-claude', sourcePrefixes: ['anthropic/'], stripPrefix: 'anthropic/' }],
  };
  writeFileSync(registryPath, JSON.stringify({ executors: [entry] }));
  writeFileSync(openRouterPath, JSON.stringify({ generated_at: '2026-09-23T00:00:00.000Z', records: [
    { id: 'anthropic/claude-light', pricing: { completion: '0.000001' } },
    { id: 'anthropic/claude-mid', pricing: { completion: '0.00001' } },
    { id: 'anthropic/claude-heavy', pricing: { completion: '0.00002' } },
    { id: 'anthropic/claude-heavy:batch', pricing: { completion: '0.00001' } },
  ] }));
  writeFileSync(artificialPath, JSON.stringify({ generated_at: '2026-09-23T00:00:00.000Z', records: [
    { id: 'light', slug: 'claude-light', evaluations: { artificial_analysis_coding_index: 40, artificial_analysis_agentic_index: 40, artificial_analysis_intelligence_index: 40 }, performance: { median_output_tokens_per_second: 150 }, pricing: { price_1m_output_tokens: 1 } },
    { id: 'mid', slug: 'claude-mid', evaluations: { artificial_analysis_coding_index: 70, artificial_analysis_agentic_index: 70, artificial_analysis_intelligence_index: 70 }, performance: { median_output_tokens_per_second: 80 }, pricing: { price_1m_output_tokens: 10 } },
    { id: 'heavy', slug: 'claude-heavy', evaluations: { artificial_analysis_coding_index: 90, artificial_analysis_agentic_index: 90, artificial_analysis_intelligence_index: 90 }, performance: { median_output_tokens_per_second: 40 }, pricing: { price_1m_output_tokens: 20 } },
  ] }));
  writeFileSync(joinedPath, JSON.stringify({ generated_at: '2026-09-23T00:00:00.000Z', content_sha256: 'source-digest' }));
  return { root, registryPath, openRouterPath, artificialAnalysisPath: artificialPath, joinedPath, outputPath, entry };
}

describe('dynamic model catalog', () => {
  test('ranks candidates, applies price ceilings, and filters batch routes', async () => {
    const paths = fixture();
    const catalog = await buildModelCatalog({ ...paths, now: new Date('2026-09-23T01:00:00.000Z') });
    const route = catalog.routes['claude-code']!;
    expect(route.candidates.heavy.some((candidate) => candidate.sourceModel.endsWith(':batch'))).toBe(false);
    expect(route.winner.heavy).toBe('claude-heavy');
    expect(route.winner.mid).toBe('claude-mid');
    expect(route.winner.light).toBe('claude-light');
    expect(route.candidates.light.every((candidate) => candidate.outputPricePerMillion <= 2)).toBe(true);
    expect(catalog.source_generation).toBe('2026-09-23T00:00:00.000Z');
  });

  test('preserves qualification evidence and publishes an atomic last-known-good catalog', async () => {
    const paths = fixture();
    const first = await buildModelCatalog({ ...paths, now: new Date('2026-09-23T01:00:00.000Z') });
    first.routes['claude-code']!.qualification.heavy = {
      model: 'claude-heavy', qualified: true, evidence: 'bridge-probe-and-three-task-canary', qualifiedAt: '2026-09-23T01:05:00.000Z',
    };
    await publishModelCatalog(first, paths.outputPath);
    const second = await buildModelCatalog({ ...paths, existingCatalog: readBestModelCatalogSync(paths.outputPath), now: new Date('2026-09-23T02:00:00.000Z') });
    expect(second.routes['claude-code']!.qualification.heavy.evidence).toBe('bridge-probe-and-three-task-canary');
    await publishModelCatalog(second, paths.outputPath);
    expect(readFileSync(join(paths.root, 'last-known-good.json'), 'utf8')).toContain('bridge-probe-and-three-task-canary');
    const current = readBestModelCatalogSync(paths.outputPath, new Date('2026-09-23T02:01:00.000Z'))!;
    expect(catalogIsFresh(current, new Date('2026-09-23T02:01:00.000Z'))).toBe(true);
    expect(resolveCatalogModel(paths.entry, 'claude-code', 'complex', current).model).toBe('claude-heavy');
  });
});
