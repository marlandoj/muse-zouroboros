import { test, expect, describe } from 'bun:test';
import {
  buildFeatureList,
  createFeatureList,
  computeFeatureListHash,
  parseFeatureList,
  loadFeatureList,
  verifyFeatureListIntegrity,
  reconcileProgress,
  type FeatureList,
  type FeatureListFileProbe,
} from './feature-list.js';
import type { TaskResult, Task } from '../types.js';

const FIXED = '2026-06-30T00:00:00.000Z';

function mkList(): FeatureList {
  return buildFeatureList(
    'demo-campaign',
    [
      { id: 'f1', title: 'Landing page' },
      { id: 'f2', title: 'Checkout flow', artifact: '/out/checkout.ts' },
    ],
    { createdAt: FIXED },
  );
}

function memProbe(initial: Record<string, string> = {}): FeatureListFileProbe & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    exists: (p) => store.has(p),
    read: (p) => (store.has(p) ? store.get(p)! : null),
    write: (p, c) => void store.set(p, c),
  };
}

function result(id: string, success: boolean, artifacts?: string[]): TaskResult {
  const task = { id, prompt: 'x' } as unknown as Task;
  return { task, success, durationMs: 1, retries: 0, artifacts } as TaskResult;
}

describe('feature-list hashing', () => {
  test('hash round-trips and is stable across rebuilds', () => {
    const a = mkList();
    const b = mkList();
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyFeatureListIntegrity(a).ok).toBe(true);
  });

  test('hash excludes the hash field itself', () => {
    const a = mkList();
    const recomputed = computeFeatureListHash({
      campaign: a.campaign,
      createdAt: a.createdAt,
      features: a.features,
    });
    expect(recomputed).toBe(a.hash);
  });

  test('changing a feature changes the hash (drift is detectable)', () => {
    const a = mkList();
    const tampered: FeatureList = {
      ...a,
      features: [{ ...a.features[0], title: 'Landing page (HACKED)' }, a.features[1]],
    };
    // hash field still the OLD value → integrity fails
    const integ = verifyFeatureListIntegrity(tampered);
    expect(integ.ok).toBe(false);
    expect(integ.expected).not.toBe(integ.actual);
  });

  test('done flag participates in the hash', () => {
    const a = buildFeatureList('c', [{ id: 'f1', title: 't' }], { createdAt: FIXED });
    const b = buildFeatureList('c', [{ id: 'f1', title: 't', done: true }], { createdAt: FIXED });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('write-once create + load', () => {
  test('createFeatureList writes through the probe', () => {
    const probe = memProbe();
    const list = createFeatureList('c', [{ id: 'f1', title: 't' }], '/spec.json', probe, {
      createdAt: FIXED,
    });
    expect(probe.exists('/spec.json')).toBe(true);
    expect(verifyFeatureListIntegrity(list).ok).toBe(true);
  });

  test('createFeatureList refuses to overwrite (write-once)', () => {
    const probe = memProbe({ '/spec.json': '{}' });
    expect(() =>
      createFeatureList('c', [{ id: 'f1', title: 't' }], '/spec.json', probe),
    ).toThrow(/write-once/);
  });

  test('loadFeatureList round-trips a written file with intact integrity', () => {
    const probe = memProbe();
    createFeatureList('c', [{ id: 'f1', title: 't' }], '/spec.json', probe, { createdAt: FIXED });
    const loaded = loadFeatureList('/spec.json', probe);
    expect(loaded.campaign).toBe('c');
    expect(verifyFeatureListIntegrity(loaded).ok).toBe(true);
  });

  test('loadFeatureList throws on a missing file', () => {
    const probe = memProbe();
    expect(() => loadFeatureList('/nope.json', probe)).toThrow(/not found/);
  });

  test('parseFeatureList throws on malformed JSON', () => {
    expect(() => parseFeatureList('{not json')).toThrow(/not valid JSON/);
  });

  test('parseFeatureList throws on a wrong-shape object', () => {
    expect(() => parseFeatureList('{"campaign":"c"}')).toThrow(/createdAt/);
  });

  test('loadFeatureList surfaces an integrity mismatch after on-disk tamper', () => {
    const probe = memProbe();
    const list = createFeatureList('c', [{ id: 'f1', title: 't' }], '/spec.json', probe, {
      createdAt: FIXED,
    });
    // simulate an agent overwriting the file body but not the hash
    const tampered = JSON.parse(probe.read('/spec.json')!);
    tampered.features[0].title = 'rewritten';
    probe.write('/spec.json', JSON.stringify(tampered));
    const loaded = loadFeatureList('/spec.json', probe);
    expect(loaded.hash).toBe(list.hash); // stale hash preserved
    expect(verifyFeatureListIntegrity(loaded).ok).toBe(false);
  });
});

describe('reconcileProgress', () => {
  test('maps landed by task-id match and missing otherwise', () => {
    const list = mkList(); // f1, f2(artifact /out/checkout.ts)
    const rep = reconcileProgress(list, [result('f1', true)]);
    expect(rep.landed).toEqual(['f1']);
    expect(rep.missing).toEqual(['f2']);
    expect(rep.total).toBe(2);
    expect(rep.passed).toBe(false);
  });

  test('maps landed by artifact match', () => {
    const list = mkList();
    const rep = reconcileProgress(list, [result('other', true, ['/out/checkout.ts'])]);
    expect(rep.landed).toContain('f2');
    expect(rep.missing).toContain('f1');
  });

  test('a failed result does not count as landed', () => {
    const list = mkList();
    const rep = reconcileProgress(list, [result('f1', false)]);
    expect(rep.missing).toContain('f1');
  });

  test('all features landed ⇒ passed', () => {
    const list = mkList();
    const rep = reconcileProgress(list, [result('f1', true), result('f2', true)]);
    expect(rep.passed).toBe(true);
    expect(rep.missing).toEqual([]);
  });

  test('empty feature list ⇒ empty passing reconcile', () => {
    const list = buildFeatureList('empty', [], { createdAt: FIXED });
    const rep = reconcileProgress(list, []);
    expect(rep.total).toBe(0);
    expect(rep.passed).toBe(true);
  });
});
