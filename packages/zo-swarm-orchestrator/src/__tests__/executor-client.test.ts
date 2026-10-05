import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { ExecutorClient } from '../client/executor-client.js';
import type { ExecutorTransport } from '../transport/types.js';
import type { ExecutorRegistryEntry, TaskResult } from '../types.js';

const MOCK_RESULT: TaskResult = {
  task: {} as any,
  success: true,
  output: 'executor output',
  durationMs: 50,
  retries: 0,
};

const STUB_ENTRY: ExecutorRegistryEntry = {
  id: 'claude-code',
  name: 'Claude Code',
  executor: 'local',
  bridge: '/bin/echo',
  description: 'Test executor',
  expertise: ['code'],
  bestFor: ['code'],
  transport: 'bridge',
  config: { defaultTimeout: 120 },
};

const CODEX_ENTRY: ExecutorRegistryEntry = {
  ...STUB_ENTRY,
  id: 'codex',
  name: 'Codex CLI',
};

function makeTransport(overrides: Partial<ExecutorTransport> = {}): ExecutorTransport {
  return {
    execute: async () => MOCK_RESULT,
    executeWithUpdates: () => ({
      updates: (async function* () {})(),
      result: Promise.resolve(MOCK_RESULT),
    }),
    healthCheck: async () => ({ healthy: true }),
    shutdown: async () => {},
    ...overrides,
  };
}

describe('ExecutorClient', () => {
  test('resolves Pi and Kimi scripts against an explicit immutable runtime root', async () => {
    const workspaceRoot = resolve(import.meta.dir, '../../../..');
    const registryPath = resolve(import.meta.dir, '../executor/registry/executor-registry.json');

    for (const executorId of ['pi', 'kimi']) {
      const client = await ExecutorClient.for(executorId, { registryPath, workspaceRoot });
      try {
        const status = await client.health();
        expect(status.healthy).toBe(true);
      } finally {
        await client.dispose();
      }
    }
  });

  test('does not resolve registry scripts against the caller cwd', async () => {
    const registryPath = resolve(import.meta.dir, '../executor/registry/executor-registry.json');
    const client = await ExecutorClient.for('pi', { registryPath, workspaceRoot: '/definitely/missing/runtime-root' });
    try {
      const status = await client.health();
      expect(status.healthy).toBe(false);
      expect(status.message).toContain('/definitely/missing/runtime-root/packages/swarm');
    } finally {
      await client.dispose();
    }
  });

  test('constructs for known executor', () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, makeTransport());
    expect(client.executorId).toBe('claude-code');
  });

  test('convenience factory claudeCode()', () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, makeTransport());
    expect(client.executorId).toBe('claude-code');
  });

  test('convenience factory codex()', () => {
    const client = ExecutorClient._withTransport(CODEX_ENTRY, makeTransport());
    expect(client.executorId).toBe('codex');
  });

  test('run() returns output from transport', async () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, makeTransport());
    const result = await client.run('some task');
    expect(result.output).toBe('executor output');
    expect(result.success).toBe(true);
    expect(result.executorId).toBe('claude-code');
    expect(result.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('run() skips RAG when no keyword match', async () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, makeTransport());
    const result = await client.run('Hello world');
    expect(result.ragContext).toBe('');
    expect(result.ragPatterns).toBe(0);
  });

  test('health() delegates to transport', async () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, makeTransport());
    const status = await client.health();
    expect(status.healthy).toBe(true);
  });

  test('dispose() calls shutdown', async () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, makeTransport());
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  test('run() passes enriched prompt to transport when forceRAG', async () => {
    let capturedTask: any;
    const transport = makeTransport({
      execute: async (task) => { capturedTask = task; return MOCK_RESULT; },
    });
    const client = ExecutorClient._withTransport(STUB_ENTRY, transport);
    await client.run('Hello world', { forceRAG: true });
    expect(capturedTask).toBeDefined();
  });
});
