/**
 * Mixed-transport swarm test (Phase 3 → AC11 complete)
 *
 * Verifies that native ACP executors and the Hermes rollback bridge coexist
 * correctly in the same orchestrator instance.
 *
 * These are unit-level tests — no live agent processes are spawned.
 */

import { describe, test, expect } from 'bun:test';

// Skip binary-dependent health checks in CI (binaries not installed in GitHub Actions)
const itZoOnly = process.env.CI ? test.skip : test;
import { createTransport } from '../transport/factory.js';
import { BridgeTransport } from '../transport/bridge-transport.js';
import { ACPTransport } from '../transport/acp-transport.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import type { ExecutorRegistryEntry } from '../types.js';

function entry(id: string, bridge: string, transport: 'bridge' | 'acp'): ExecutorRegistryEntry {
  const adapters: Record<string, { adapterBin: string; adapterArgs?: string[] }> = {
    'claude-code': { adapterBin: 'claude-agent-acp' },
    hermes: { adapterBin: 'hermes', adapterArgs: ['acp', '--accept-hooks'] },
    gemini: { adapterBin: 'gemini', adapterArgs: ['--acp'] },
    codex: { adapterBin: 'codex-acp' },
    opencode: { adapterBin: 'opencode', adapterArgs: ['acp', '--pure'] },
  };
  return {
    id, name: id, executor: 'local',
    bridge, description: id, expertise: [], bestFor: [],
    config: { defaultTimeout: 300, model: null, envVars: {} },
    healthCheck: { command: 'true', expectedPattern: '', description: '' },
    transport,
    acp: adapters[id],
    ...(id === 'hermes' ? {
      transportFallback: {
        envVar: 'HERMES_ACP_ENABLED',
        equals: '0',
        transport: 'bridge' as const,
      },
    } : {}),
  } as ExecutorRegistryEntry & { transport: 'bridge' | 'acp' };
}

function cb() {
  return new CircuitBreaker({ id: 'test', cooldownMs: 0, failureThreshold: 5 });
}

const EXECUTORS = [
  { id: 'claude-code', bridge: 'Skills/zo-swarm-executors/bridges/claude-code-bridge.sh', transport: 'acp' as const },
  { id: 'hermes',      bridge: 'Skills/zo-swarm-executors/bridges/hermes-bridge.sh',      transport: 'acp' as const },
  { id: 'gemini',      bridge: 'Skills/zo-swarm-executors/bridges/gemini-bridge.sh',      transport: 'acp' as const },
  { id: 'codex',       bridge: 'Skills/zo-swarm-executors/bridges/codex-bridge.sh',       transport: 'acp' as const },
  { id: 'opencode',    bridge: '',                                                              transport: 'acp' as const },
];

describe('Mixed-transport executor set', () => {
  test('claude-code uses ACPTransport', () => {
    const e = EXECUTORS.find(x => x.id === 'claude-code')!;
    const t = createTransport(entry(e.id, e.bridge, e.transport), cb());
    expect(t).toBeInstanceOf(ACPTransport);
  });

  test('hermes uses native ACPTransport', () => {
    const e = EXECUTORS.find(x => x.id === 'hermes')!;
    const t = createTransport(entry(e.id, e.bridge, e.transport), cb());
    expect(t).toBeInstanceOf(ACPTransport);
  });

  test('hermes rollback flag uses BridgeTransport', () => {
    const original = process.env.HERMES_ACP_ENABLED;
    try {
      process.env.HERMES_ACP_ENABLED = '0';
      const t = createTransport(
        entry('hermes', 'Skills/zo-swarm-executors/bridges/hermes-bridge.sh', 'acp'),
        cb(),
      );
      expect(t).toBeInstanceOf(BridgeTransport);
    } finally {
      if (original === undefined) delete process.env.HERMES_ACP_ENABLED;
      else process.env.HERMES_ACP_ENABLED = original;
    }
  });

  test('gemini uses ACPTransport (native --acp flag)', () => {
    const e = EXECUTORS.find(x => x.id === 'gemini')!;
    const t = createTransport(entry(e.id, e.bridge, e.transport), cb());
    expect(t).toBeInstanceOf(ACPTransport);
  });

  test('codex uses ACPTransport (codex-acp binary)', () => {
    const e = EXECUTORS.find(x => x.id === 'codex')!;
    const t = createTransport(entry(e.id, e.bridge, e.transport), cb());
    expect(t).toBeInstanceOf(ACPTransport);
  });

  test('opencode uses native ACPTransport', () => {
    const e = EXECUTORS.find(x => x.id === 'opencode')!;
    const t = createTransport(entry(e.id, e.bridge, e.transport), cb());
    expect(t).toBeInstanceOf(ACPTransport);
  });

  test('all transports implement the ExecutorTransport interface', () => {
    for (const e of EXECUTORS) {
      const t = createTransport(entry(e.id, e.bridge, e.transport), cb());
      expect(typeof t.execute).toBe('function');
      expect(typeof t.executeWithUpdates).toBe('function');
      expect(typeof t.healthCheck).toBe('function');
      expect(typeof t.shutdown).toBe('function');
    }
  });

  itZoOnly('claude-code ACP health check finds binary', async () => {
    const ccTransport = createTransport(
      entry('claude-code', 'Skills/zo-swarm-executors/bridges/claude-code-bridge.sh', 'acp'),
      cb(),
    ) as ACPTransport;
    const health = await ccTransport.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('claude-agent-acp');
  });

  itZoOnly('codex-acp health check finds binary', async () => {
    const codexAcp = createTransport(
      entry('codex', 'Skills/zo-swarm-executors/bridges/codex-bridge.sh', 'acp'),
      cb(),
    ) as ACPTransport;
    const health = await codexAcp.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('codex-acp');
  });

  itZoOnly('gemini ACP health check finds binary (gemini --acp)', async () => {
    const geminiAcp = createTransport(
      entry('gemini', 'Skills/zo-swarm-executors/bridges/gemini-bridge.sh', 'acp'),
      cb(),
    ) as ACPTransport;
    const health = await geminiAcp.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('gemini');
  });

  itZoOnly('hermes ACP health check finds native binary', async () => {
    const hermesAcp = createTransport(
      entry('hermes', 'Skills/zo-swarm-executors/bridges/hermes-bridge.sh', 'acp'),
      cb(),
    ) as ACPTransport;
    const health = await hermesAcp.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('hermes acp --accept-hooks');
  });

  test('all transports shutdown cleanly in parallel', async () => {
    const transports = EXECUTORS.map(e =>
      createTransport(entry(e.id, e.bridge, e.transport), cb())
    );
    await expect(Promise.all(transports.map(t => t.shutdown()))).resolves.toBeDefined();
  });
});
