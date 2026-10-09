import { describe, expect, test } from 'bun:test';
import { adaptModelCatalog, selectShared, sharedPath, validCatalog } from '../routing/shared-catalog.js';

const now = new Date().toISOString();
function modelCatalog() {
  return {
    schema_version: '1.0.0',
    generated_at: now,
    source_generation: 'test', source_manifest_sha256: 'x', stale_after_hours: 24, content_sha256: 'y',
    routes: {
      'codex': {
        winner: { light: 'gpt-5-codex-light', mid: 'gpt-5-codex-mid', heavy: 'gpt-5-codex-heavy' },
        fallback: { light: 'a', mid: 'b', heavy: 'c' },
        candidates: { light: [], mid: [], heavy: [] },
        qualification: {
          light: { model: 'gpt-5-codex-light', qualified: true, evidence: 'probe', qualifiedAt: now },
          mid: { model: 'gpt-5-codex-mid', qualified: true, evidence: 'probe', qualifiedAt: now },
          heavy: { model: 'gpt-5-codex-heavy', qualified: true, evidence: 'probe', qualifiedAt: now },
        },
      },
    },
  };
}

describe('shared-catalog path unification', () => {
  test('sharedPath defaults to the swarm catalog path', () => {
    delete process.env.SWARM_MODEL_CATALOG_PATH;
    delete process.env.ZOUROBOROS_MODEL_CATALOG_PATH;
    expect(sharedPath()).toBe('/var/lib/zouroboros/model-routing/swarm/current.json');
  });
  test('SWARM_MODEL_CATALOG_PATH wins over the deprecated var', () => {
    process.env.SWARM_MODEL_CATALOG_PATH = '/tmp/a.json';
    process.env.ZOUROBOROS_MODEL_CATALOG_PATH = '/tmp/b.json';
    expect(sharedPath()).toBe('/tmp/a.json');
    delete process.env.SWARM_MODEL_CATALOG_PATH;
    expect(sharedPath()).toBe('/tmp/b.json');
    delete process.env.ZOUROBOROS_MODEL_CATALOG_PATH;
  });
});

describe('adaptModelCatalog', () => {
  test('translates ModelCatalog winners into selectable routes', () => {
    const adapted = adaptModelCatalog(modelCatalog());
    expect(adapted).not.toBeNull();
    expect(validCatalog(adapted)).toBe(true);
    expect(adapted!.routes.length).toBe(3);
    const picked = selectShared('swarm', { harness: 'codex', tier: 'light', catalog: adapted });
    expect(picked.length).toBe(1);
    expect(picked[0].model).toBe('gpt-5-codex-light');
  });
  test('rejects non-ModelCatalog input', () => {
    expect(adaptModelCatalog(null)).toBeNull();
    expect(adaptModelCatalog({ version: 1, routes: [] })).toBeNull();
    expect(adaptModelCatalog({ schema_version: '1.0.0', routes: [] })).toBeNull();
  });
});
