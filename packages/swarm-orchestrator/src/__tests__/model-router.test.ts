import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { resolveModelForExecutor } from '../routing/model-router.js';
import type { ExecutorRegistryEntry, Task } from '../types.js';

let catalogDirectory: string;
let originalCatalogPath: string | undefined;
beforeEach(() => {
  originalCatalogPath = process.env.SWARM_MODEL_CATALOG_PATH;
  catalogDirectory = mkdtempSync(join(tmpdir(), 'swarm-router-'));
  process.env.SWARM_MODEL_CATALOG_PATH = join(catalogDirectory, 'current.json');
});
afterEach(() => {
  if (originalCatalogPath === undefined) delete process.env.SWARM_MODEL_CATALOG_PATH;
  else process.env.SWARM_MODEL_CATALOG_PATH = originalCatalogPath;
  rmSync(catalogDirectory, { recursive: true, force: true });
});

function task(model?: string): Task {
  return {
    id: 't1',
    persona: 'auto',
    task: 'Analyze the implementation carefully.',
    priority: 'medium',
    ...(model ? { model } : {}),
  };
}

function entry(id: string, configModel?: string): ExecutorRegistryEntry {
  return {
    id,
    name: id,
    executor: 'local',
    description: id,
    expertise: [],
    bestFor: [],
    config: { defaultTimeout: 300, ...(configModel ? { model: configModel } : {}) },
  };
}

describe('model router', () => {
  test('maps Claude swarm aliases to Claude-native models', () => {
    const route = resolveModelForExecutor(task('swarm-heavy'), 'claude-code', 'complex', entry('claude-code'));
    expect(route?.model).toBe('claude-fable-5-1');
  });

  test('explicit Opus model name passes through on claude-code', () => {
    const route = resolveModelForExecutor(task('claude-opus-4-7'), 'claude-code', 'complex', entry('claude-code'));
    expect(route?.model).toBe('claude-opus-4-7');
  });

  test('strips Claude provider prefix', () => {
    const route = resolveModelForExecutor(task('cc/claude-sonnet-5'), 'claude-code', 'moderate', entry('claude-code'));
    expect(route?.model).toBe('claude-sonnet-5');
  });

  test('maps Gemini tiers to Gemini-native models', () => {
    const route = resolveModelForExecutor(task('swarm-mid'), 'gemini', 'moderate', entry('gemini'));
    expect(route?.model).toBe('gemini-3.8-flash');
  });

  test('keeps Gemini-native model names and strips gc prefix', () => {
    const route = resolveModelForExecutor(task('gc/gemini-3.8-flash'), 'gemini', 'simple', entry('gemini'));
    expect(route?.model).toBe('gemini-3.8-flash');
  });

  test('falls back when executor receives an incompatible model family', () => {
    const route = resolveModelForExecutor(task('claude-opus-4-6'), 'gemini', 'complex', entry('gemini'));
    expect(route?.model).toBe('gemini-3.5-flash-lite');
    expect(route?.fallbackReason).toContain('incompatible');
  });

  test('preserves provider-qualified OpenCode models', () => {
    const route = resolveModelForExecutor(
      task('xai/grok-4.3'),
      'opencode',
      'moderate',
      entry('opencode'),
    );
    expect(route?.model).toBe('xai/grok-4.3');
  });

  test('uses the verified OpenCode cross-provider tier ladder', () => {
    expect(resolveModelForExecutor(task(), 'opencode', 'simple', entry('opencode'))?.model).toBe(
      'synthetic-direct/hf:zai-org/GLM-5.3-Flash',
    );
    expect(resolveModelForExecutor(task(), 'opencode', 'complex', entry('opencode'))?.model).toBe(
      'synthetic-direct/hf:zai-org/GLM-5.3-Flash',
    );
  });

  test('rejects opaque BYOK identifiers for OpenCode', () => {
    const route = resolveModelForExecutor(
      task('byok:opaque-id'),
      'opencode',
      'moderate',
      entry('opencode'),
    );
    expect(route).toBeNull();
  });

  test('normalizes role shorthand and legacy wildcard model names to catalog tiers', () => {
    expect(resolveModelForExecutor(task('opus'), 'claude-code', 'complex', entry('claude-code'))?.model).toBe('claude-fable-5-1');
    expect(resolveModelForExecutor(task('pro'), 'gemini', 'moderate', entry('gemini'))?.model).toBe('gemini-3.8-flash');
    expect(resolveModelForExecutor(task('gpt-5.x'), 'codex', 'complex', entry('codex'))?.model).toBe('gpt-6-astra');
  });

  test('uses complexity tiers when no task or role model is pinned', () => {
    const route = resolveModelForExecutor(
      task(),
      'gemini',
      'complex',
      entry('gemini', 'gemini-2.5-flash'),
    );
    expect(route?.model).toBe('gemini-3.8-flash');
    expect(route?.source).toBe('default');
  });

  test('applies role-scoped model selection before registry defaults', () => {
    const route = resolveModelForExecutor(
      task(),
      'claude-code',
      'simple',
      entry('claude-code'),
      'claude-sonnet-5',
    );
    expect(route?.model).toBe('claude-sonnet-5');
    expect(route?.source).toBe('role');
  });
});

describe('RB-23 single tier-to-model contract (CC campaign path)', () => {
  // A bare tier label must never cross the bridge boundary for executors whose
  // harness expects a concrete model slug.
  const TIER_LABEL = /^(swarm-.+|trivial|simple|moderate|complex|light|mid|heavy|failover)$/;
  const TIERS = ['trivial', 'simple', 'moderate', 'complex'] as const;
  // Live VPS bridge executors minus hermes, whose router spec is deliberately
  // passthrough: provider-relative light/mid/heavy labels are hermes' native
  // vocabulary (the hermes bridge adapts them per provider and enforces the
  // anthropic-subscription cost policy).
  const CONCRETE_EXECUTORS = ['claude-code', 'codex', 'gemini', 'opencode'];

  function routerEntry(id: string, modelRouter: ExecutorRegistryEntry['modelRouter']): ExecutorRegistryEntry {
    return { ...entry(id), modelRouter };
  }

  test('router never emits bare tier labels for concrete-model executors', () => {
    for (const id of CONCRETE_EXECUTORS) {
      for (const tier of TIERS) {
        const route = resolveModelForExecutor(task(), id, tier, entry(id));
        expect(route).not.toBeNull();
        expect(TIER_LABEL.test(route!.model)).toBe(false);
      }
    }
  });

  test('Hermes aliases resolve to native Anthropic identifiers', () => {
    const route = resolveModelForExecutor(task(), 'hermes', 'complex', entry('hermes'));
    expect(route?.model).toBe('claude-fable-5-1');
    const light = resolveModelForExecutor(task(), 'hermes', 'trivial', entry('hermes'));
    expect(light?.model).toBe('claude-haiku-4-5-20251001');
  });

  test('registry modelRouter overrides resolve for kimi and pi (live registry contract)', () => {
    const kimi = resolveModelForExecutor(task(), 'kimi', 'moderate', routerEntry('kimi', {
      defaultModel: 'moonshotai/kimi-k3',
      fallbackModel: 'moonshotai/kimi-k3',
      acceptedPrefixes: ['moonshotai/', 'k3', 'kimi-for-coding'],
      tierMap: { moderate: 'moonshotai/kimi-k3' },
    }));
    expect(kimi?.model).toBe('moonshotai/kimi-k3');
    expect(kimi?.source).toBe('registry');

    const pi = resolveModelForExecutor(task(), 'pi', 'trivial', routerEntry('pi', {
      defaultModel: 'openrouter/moonshotai/kimi-k3',
      passthrough: true,
      rejectPrefixes: ['byok:'],
      tierMap: { trivial: 'openrouter/moonshotai/kimi-k3' },
    }));
    expect(pi?.model).toBe('openrouter/moonshotai/kimi-k3');
    expect(pi?.source).toBe('registry');
  });

  test('CC campaign path (packages/swarm/scripts/orchestrate-v5.ts) consults resolveModelForExecutor', () => {
    const src = readFileSync(new URL('../../scripts/orchestrate-v5.ts', import.meta.url), 'utf-8');
    // The router is imported from the shared routing module...
    expect(src).toContain('import { resolveModelForExecutor } from "../src/routing/model-router"');
    // ...the CC call site routes the selected executor through it...
    expect(src).toContain('resolveModelViaRouter(task, exid, complexity.tier)');
    // ...and the static tier map survives only as the fallback after the router.
    expect(src).toContain('routed ?? resolveModelFromTier(task)');
  });
});

test('qualified catalog aliases select their own tier independently of prompt complexity', () => {
  writeFileSync(process.env.SWARM_MODEL_CATALOG_PATH!, JSON.stringify({
    generated_at: new Date().toISOString(), stale_after_hours: 24,
    routes: { 'claude-code': { qualification: {
      light: { qualified: true, model: 'claude-qualified-light' },
      mid: { qualified: true, model: 'claude-qualified-mid' },
      heavy: { qualified: true, model: 'claude-qualified-heavy' },
    } } },
  }));
  expect(resolveModelForExecutor(task('swarm-heavy'), 'claude-code', 'trivial', entry('claude-code'))?.model).toBe('claude-qualified-heavy');
  expect(resolveModelForExecutor(task('swarm-mid'), 'claude-code', 'complex', entry('claude-code'))?.model).toBe('claude-qualified-mid');
  expect(resolveModelForExecutor(task('swarm-light'), 'claude-code', 'complex', entry('claude-code'))?.model).toBe('claude-qualified-light');
});
