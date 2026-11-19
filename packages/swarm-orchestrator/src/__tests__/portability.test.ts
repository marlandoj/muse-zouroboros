import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadRegistry } from '../registry/loader.js';
import {
  PORTABLE_HARNESS_IDS,
  buildPortableHarnessInventory,
  detectHarness,
  loadHarnessContract,
  resolvePortableHarness,
  validateHarnessContract,
} from '../executor/portability.js';

describe('portable harness contract', () => {
  const contract = loadHarnessContract();

  test('keeps the packaged active registry aligned with the supported CLI contract', () => {
    const registry = loadRegistry(join(import.meta.dir, '../executor/registry/executor-registry.json'));
    expect(registry.executors.map((entry) => entry.id).sort()).toEqual([...PORTABLE_HARNESS_IDS].sort());
    expect(registry.executors.map((entry) => entry.id).sort()).toEqual(Object.keys(contract.harnesses).sort());
    for (const entry of registry.executors) {
      expect(entry.executor).toBe('local');
      expect(['acp', 'bridge']).toContain(entry.transport);
    }
  });

  test('detects all seven supported harnesses with deterministic precedence', () => {
    expect(detectHarness(contract, { explicitHarness: 'claude' })).toBe('claude-code');
    expect(detectHarness(contract, { env: { CODEX_HOME: '/tmp/codex' }, argv: ['gemini'] })).toBe('codex');
    expect(detectHarness(contract, { argv: ['gemini-cli'], env: {} })).toBe('gemini');
    expect(detectHarness(contract, { argv: ['hermes-agent'], env: {} })).toBe('hermes');
    expect(detectHarness(contract, { argv: ['/home/zouroboros/.kimi-code/bin/kimi'], env: {} })).toBe('kimi');
    expect(detectHarness(contract, { env: { KIMI_DISABLE_TELEMETRY: '1' }, argv: [] })).toBe('kimi');
    expect(detectHarness(contract, { env: { OPENCODE_CONFIG_CONTENT: '{}' }, argv: [] })).toBe('opencode');
    expect(detectHarness(contract, { argv: ['/usr/local/bin/opencode'], env: {} })).toBe('opencode');
    expect(detectHarness(contract, { env: { PI_CODING_AGENT: 'true' }, argv: [] })).toBe('pi');
    expect(detectHarness(contract, { argv: ['pi-bridge.sh'], env: {} })).toBe('pi');
  });

  test('fails closed for unknown, ambiguous, and malformed inputs', () => {
    expect(() => detectHarness(contract, { explicitHarness: 'unknown' })).toThrow('Unsupported harness');
    expect(() => detectHarness(contract, { explicitHarness: 'cursor' })).toThrow('Unsupported harness');
    expect(() => detectHarness(contract, { env: { CODEX_HOME: '1', HERMES_HOME: '1' }, argv: [] })).toThrow('Ambiguous');
    expect(() => detectHarness(contract, { env: {}, argv: ['node'] })).toThrow('Unable to detect');
    expect(() => validateHarnessContract({ ...contract, extra: true })).toThrow('unknown fields');
    const malformed = structuredClone(contract) as unknown as Record<string, unknown>;
    delete ((malformed.harnesses as Record<string, Record<string, unknown>>).codex.tools as Record<string, unknown>).web;
    expect(() => validateHarnessContract(malformed)).toThrow('Tool map for codex is incomplete');
    expect(() => resolvePortableHarness({ explicitHarness: 'codex', contractPath: 'missing.json' })).toThrow('not found');
  });

  test('resolves registry-backed overlays and explicit unsupported tools', () => {
    for (const id of ['claude-code', 'codex', 'gemini', 'hermes', 'kimi', 'opencode', 'pi']) {
      const resolved = resolvePortableHarness({ explicitHarness: id });
      expect(resolved.executor.id).toBe(id);
      expect(resolved.overlay.transport).toBe(resolved.executor.transport);
      expect(Object.keys(resolved.tools).sort()).toEqual(['mcp', 'read', 'shell', 'web', 'write']);
    }
    expect(resolvePortableHarness({ explicitHarness: 'codex' }).tools.web).toBeNull();
    expect(resolvePortableHarness({ explicitHarness: 'kimi' }).tools.web).toBeNull();
    expect(resolvePortableHarness({ explicitHarness: 'pi' }).tools.web).toBeNull();
    expect(resolvePortableHarness({ explicitHarness: 'pi' }).overlay.transport).toBe('bridge');
  });

  test('projects one exhaustive canonical inventory from the production resolver', () => {
    const inventory = buildPortableHarnessInventory();
    expect(inventory.schema).toBe('harness-adapter-inventory/v1');
    expect(inventory.entries.map((entry) => entry.id)).toEqual(PORTABLE_HARNESS_IDS);
    expect(inventory.entries).toHaveLength(7);
    expect(inventory.inventorySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildPortableHarnessInventory()).toEqual(inventory);

    for (const entry of inventory.entries) {
      const resolved = resolvePortableHarness({ explicitHarness: entry.id });
      expect(entry.executorId).toBe(resolved.executor.id);
      expect(entry.transport).toBe(resolved.overlay.transport);
      expect(entry.instructionFile).toBe(resolved.overlay.instructionFile);
      expect(entry.tools).toEqual(resolved.tools);
      expect(entry.adapterSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
