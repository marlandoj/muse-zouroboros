/**
 * ACPTransport integration test
 *
 * Stage 1: Unit tests for transport factory, BridgeTransport, ACPTransport construction.
 * Stage 2: Integration smoke test — ACPTransport health check (verifies adapter binary exists).
 *
 * We do NOT run live ACP sessions in CI (requires Claude auth). The integration
 * test validates the full transport wiring up to the spawn boundary.
 */

import { describe, test, expect, mock, spyOn } from 'bun:test';
import { BridgeTransport } from '../transport/bridge-transport.js';
import {
  ACPTransport,
  AcpAgentMessageClassifier,
  buildAcpPrompt,
  buildCgroupGuardedAdapterSpawn,
  buildResourceGuardedAdapterSpawn,
  findAcpModelConfig,
  isAcpSuccessfulOutput,
  loadAcpMcpServers,
  parseProcSmapsRollupPssBytes,
  parseProcStatmRssBytes,
  processTreeUsage,
  readExecutorResourceUsage,
  replayPathSegment,
  resolveACPModel,
  resolveHermesSessionModel,
  selectAcpPermissionOption,
} from '../transport/acp-transport.js';
import {
  createTransport,
  resolveTransportType,
} from '../transport/factory.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import type { ExecutorRegistryEntry } from '../types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockBridgeEntry: ExecutorRegistryEntry = {
  id: 'claude-code',
  name: 'Claude Code',
  executor: 'local',
  bridge: 'Skills/zo-swarm-executors/bridges/claude-code-bridge.sh',
  description: 'test',
  expertise: ['code-generation'],
  bestFor: ['test'],
  config: { defaultTimeout: 600, model: null, envVars: {} },
  healthCheck: { command: 'true', expectedPattern: '', description: 'test' },
};

const mockACPEntry = {
  ...mockBridgeEntry,
  transport: 'acp' as const,
  acp: { adapterBin: 'claude-agent-acp' },
};

const mockBridgeEntryWithTransport = {
  ...mockBridgeEntry,
  transport: 'bridge' as const,
};

function makeCB() {
  return new CircuitBreaker({ id: 'test', cooldownMs: 0, failureThreshold: 5 });
}

test('replayPathSegment prevents traversal and preserves identifier uniqueness', () => {
  const traversal = replayPathSegment('../../outside');
  expect(traversal).not.toContain('/');
  expect(traversal).not.toBe('..');
  expect(replayPathSegment('task/a')).not.toBe(replayPathSegment('task_a'));
});

describe('ACP executor resource guard', () => {
  test('leaves ordinary ACP adapter spawns unchanged', () => {
    expect(buildResourceGuardedAdapterSpawn('codex-acp', ['serve'], {})).toEqual({
      command: 'codex-acp',
      args: ['serve'],
    });
  });

  test('wraps guarded adapters with CPU affinity and lower scheduling priority', () => {
    const spec = buildResourceGuardedAdapterSpawn('codex-acp', ['serve'], {
      SWARM_EXEC_RESOURCE_GUARD_REQUIRED: '1',
      SWARM_EXEC_MEMORY_LIMIT_MIB: '12288',
      SWARM_EXEC_NICE: '10',
      SWARM_EXEC_CPU_SET: '0-7',
      SWARM_EXEC_PROCESS_LIMIT: '256',
    });
    expect(spec).toEqual({
      command: '/usr/bin/taskset',
      args: ['-c', '0-7', '/usr/bin/nice', '-n', '10', 'codex-acp', 'serve'],
    });
  });

  test('enters hard memory and process cgroups before executing the adapter', () => {
    const spec = buildCgroupGuardedAdapterSpawn(
      { command: '/usr/bin/taskset', args: ['-c', '0-7', 'codex-acp', 'serve'] },
      { memoryDir: '/sys/fs/cgroup/memory/zou-test', pidsDir: '/sys/fs/cgroup/pids/zou-test' },
    );
    expect(spec.command).toBe('/bin/sh');
    expect(spec.args.slice(-7)).toEqual([
      '/sys/fs/cgroup/memory/zou-test/cgroup.procs',
      '/sys/fs/cgroup/pids/zou-test/cgroup.procs',
      '/usr/bin/taskset',
      '-c',
      '0-7',
      'codex-acp',
      'serve',
    ]);
    expect(spec.args[1]).toContain('exec "$@"');
  });

  test('uses kernel cgroup usage instead of inflated process-tree RSS', () => {
    const files = new Map<string, string>([
      ['/sys/fs/cgroup/memory/zou-test/memory.usage_in_bytes', String(1_399 * 1024 * 1024)],
      ['/sys/fs/cgroup/pids/zou-test/pids.current', '136'],
    ]);
    const usage = readExecutorResourceUsage(
      100,
      { memoryDir: '/sys/fs/cgroup/memory/zou-test', pidsDir: '/sys/fs/cgroup/pids/zou-test' },
      path => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`unexpected read: ${path}`);
        return content;
      },
    );
    expect(usage).toEqual({
      memory_bytes: 1_399 * 1024 * 1024,
      process_count: 136,
      source: 'cgroup',
    });
  });

  test('falls back to proportional-set memory without double-counting shared pages', () => {
    const files = new Map<string, string>([
      ['/proc/100/smaps_rollup', 'Rss: 8000 kB\nPss: 1200 kB\n'],
      ['/proc/100/task/100/children', '101'],
      ['/proc/101/statm', '1000 500'],
      ['/proc/101/task/101/children', ''],
    ]);
    expect(parseProcSmapsRollupPssBytes('Rss: 8000 kB\nPss: 1200 kB\n')).toBe(1_200 * 1024);
    expect(parseProcStatmRssBytes('1000 500')).toBe(500 * 4096);
    expect(processTreeUsage(100, path => {
      const content = files.get(path);
      if (content === undefined) throw new Error('missing');
      return content;
    })).toEqual({
      memory_bytes: (1_200 * 1024) + (500 * 4096),
      process_count: 2,
      source: 'process-tree-mixed',
    });
  });

  test('fails closed when a required resource limit is missing or invalid', () => {
    expect(() => buildResourceGuardedAdapterSpawn('codex-acp', [], {
      SWARM_EXEC_RESOURCE_GUARD_REQUIRED: '1',
      SWARM_EXEC_NICE: '10',
    })).toThrow('SWARM_EXEC_MEMORY_LIMIT_MIB');
    expect(() => buildResourceGuardedAdapterSpawn('codex-acp', [], {
      SWARM_EXEC_RESOURCE_GUARD_REQUIRED: '1',
      SWARM_EXEC_MEMORY_LIMIT_MIB: '12288',
      SWARM_EXEC_NICE: '20',
      SWARM_EXEC_CPU_SET: '0-7',
      SWARM_EXEC_PROCESS_LIMIT: '256',
    })).toThrow('SWARM_EXEC_NICE');
  });
});

// ─── Transport Construction ───────────────────────────────────────────────────

describe('createTransport factory', () => {
  test('defaults to BridgeTransport when transport field absent', () => {
    const t = createTransport(mockBridgeEntry, makeCB());
    expect(t).toBeInstanceOf(BridgeTransport);
  });

  test('returns BridgeTransport for transport: bridge', () => {
    const t = createTransport(mockBridgeEntryWithTransport, makeCB());
    expect(t).toBeInstanceOf(BridgeTransport);
  });

  test('returns ACPTransport for transport: acp', () => {
    const t = createTransport(mockACPEntry as ExecutorRegistryEntry, makeCB());
    expect(t).toBeInstanceOf(ACPTransport);
  });

  test('uses the registry-declared ACP adapter', () => {
    const opencode = {
      ...mockACPEntry,
      id: 'opencode',
      bridge: undefined,
      acp: { adapterBin: 'opencode', adapterArgs: ['acp', '--pure'] },
    } as ExecutorRegistryEntry;
    expect(createTransport(opencode, makeCB())).toBeInstanceOf(ACPTransport);
  });

  test('uses ACP for Hermes by default and bridge only with explicit rollback', () => {
    const hermes = {
      ...mockACPEntry,
      id: 'hermes',
      transportFallback: {
        envVar: 'HERMES_ACP_ENABLED',
        equals: '0',
        transport: 'bridge' as const,
      },
    } as ExecutorRegistryEntry;
    const original = process.env.HERMES_ACP_ENABLED;
    try {
      delete process.env.HERMES_ACP_ENABLED;
      expect(resolveTransportType(hermes)).toBe('acp');
      expect(createTransport(hermes, makeCB())).toBeInstanceOf(ACPTransport);

      process.env.HERMES_ACP_ENABLED = '0';
      expect(resolveTransportType(hermes)).toBe('bridge');
      expect(createTransport(hermes, makeCB())).toBeInstanceOf(BridgeTransport);
    } finally {
      if (original === undefined) delete process.env.HERMES_ACP_ENABLED;
      else process.env.HERMES_ACP_ENABLED = original;
    }
  });

  test('throws on unknown transport type', () => {
    const bad = { ...mockBridgeEntry, transport: 'grpc' };
    expect(() => createTransport(bad as ExecutorRegistryEntry, makeCB())).toThrow("Unknown transport type 'grpc'");
  });
});

// ─── BridgeTransport ─────────────────────────────────────────────────────────

describe('BridgeTransport', () => {
  test('healthCheck returns healthy when bridge script exists', async () => {
    const t = new BridgeTransport(mockBridgeEntry, makeCB());
    const result = await t.healthCheck();
    // Bridge script should exist in the workspace
    expect(typeof result.healthy).toBe('boolean');
    expect(typeof result.message).toBe('string');
  });

  test('healthCheck accepts an absolute bridge path', async () => {
    const t = new BridgeTransport(
      { ...mockBridgeEntry, bridge: '/bin/echo' },
      makeCB(),
    );
    const result = await t.healthCheck();
    expect(result.healthy).toBe(true);
  });

  test('executeWithUpdates returns empty async iterable for updates', async () => {
    const t = new BridgeTransport(mockBridgeEntry, makeCB());
    const { updates } = t.executeWithUpdates(
      { id: 'test', persona: 'claude-code', task: 'test', priority: 'low' },
      { timeoutMs: 1000 },
    );

    const collected: unknown[] = [];
    // Bridge transport yields no streaming updates — the iterable should be immediately done
    // We give it 50ms then move on
    const timeout = new Promise<void>(res => setTimeout(res, 50));
    const drain = (async () => {
      for await (const u of updates) collected.push(u);
    })();
    await Promise.race([drain, timeout]);

    expect(collected.length).toBe(0);
  });

  test('shutdown resolves immediately', async () => {
    const t = new BridgeTransport(mockBridgeEntry, makeCB());
    await expect(t.shutdown()).resolves.toBeUndefined();
  });
});

// ─── ACPTransport ─────────────────────────────────────────────────────────────

describe('ACPTransport', () => {
  test('selects allow_once regardless of permission option ordering', () => {
    const response = selectAcpPermissionOption({
      sessionId: 'test-session',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'Write source file',
        kind: 'edit',
        status: 'pending',
      },
      options: [
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      ],
    });

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
  });

  test('fails closed when an ACP permission request has no allow option', () => {
    const response = selectAcpPermissionOption({
      sessionId: 'test-session',
      toolCall: {
        toolCallId: 'tool-2',
        title: 'Write source file',
        kind: 'edit',
        status: 'pending',
      },
      options: [
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  test('loads shared memory servers and authenticated Zo tools', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-'));
    const configPath = join(directory, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'] },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
      },
    }));
    try {
      const servers = loadAcpMcpServers(
        { configPath, includeShared: true, includeZo: true },
        {
          env: {
            ZO_API_KEY: 'test-token',
            ZO_CONVERSATION_ID: 'test-conversation',
          },
        },
      );
      expect(servers.map(server => server.name)).toEqual([
        'zo-memory',
        'qdrant-rag',
        'zo',
      ]);
      const zo = servers.find(server => server.name === 'zo');
      expect(zo).toMatchObject({ type: 'http', name: 'zo' });
      expect((zo as { url: string }).url).toContain('conversation_id=test-conversation');
      expect((zo as { headers: Array<{ name: string; value: string }> }).headers).toContainEqual({
        name: 'Authorization',
        value: 'Bearer test-token',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('sends configured MCP servers across the ACP session boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-session-'));
    const configPath = join(directory, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'] },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
      },
    }));
    try {
      const t = new ACPTransport(mockACPEntry as ExecutorRegistryEntry, makeCB(), {
        adapterBin: 'bun',
        adapterArgs: [`${import.meta.dir}/fixtures/mock-acp-adapter.ts`],
        mcpConfig: { configPath, includeShared: true, includeZo: true },
      });
      const outcome = await t.execute(
        { id: 'mcp-wire-test', persona: 'kimi', task: 'report mcp', priority: 'low' },
        {
          timeoutMs: 5_000,
          workdir: directory,
          env: { ZO_API_KEY: 'test-token' },
        },
      );
      expect(outcome.success).toBe(true);
      expect(outcome.output).toContain('zo-memory');
      expect(outcome.output).toContain('qdrant-rag');
      expect(outcome.output).toContain('zo');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('warns and keeps shared MCP servers when Zo credentials are absent or blank', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-no-zo-'));
    const configPath = join(directory, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'], env: { MEMORY_MODE: 'local' } },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
        custom: { url: 'https://custom.test/mcp' },
      },
    }));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const shared = loadAcpMcpServers({ configPath, includeZo: false }, { env: {} });
      expect(warn).not.toHaveBeenCalled();
      for (const env of [{}, { ZO_CLIENT_IDENTITY_TOKEN: '', ZO_API_KEY: ' ', ZO_MCP_API_KEY: '' }]) {
        expect(loadAcpMcpServers({ configPath, includeZo: true }, { env })).toEqual(shared);
      }
      expect(loadAcpMcpServers({ includeShared: false, includeZo: true }, { env: {} })).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[0]?.[0]).toContain('Skipping optional Zo server');
    } finally {
      warn.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('selects the first nonblank Zo credential in precedence order', () => {
    const keys = ['ZO_CLIENT_IDENTITY_TOKEN', 'ZO_API_KEY', 'ZO_MCP_API_KEY'];
    for (let index = 0; index < keys.length; index++) {
      const env = Object.fromEntries(keys.map((key, position) => [key, position < index ? ' ' : `token-${position}`]));
      expect(loadAcpMcpServers({ includeShared: false, includeZo: true }, { env })).toMatchObject([{
        name: 'zo', headers: [{ name: 'Authorization', value: `Bearer token-${index}` },
          { name: 'Content-Type', value: 'application/json' }],
      }]);
    }
  });

  test('still rejects missing or malformed shared configuration without Zo credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-invalid-'));
    const configPath = join(directory, '.mcp.json');
    try {
      const config = { configPath, includeZo: true };
      expect(() => loadAcpMcpServers(config, { env: {} })).toThrow('ACP MCP config does not exist');
      writeFileSync(configPath, '{invalid');
      expect(() => loadAcpMcpServers(config, { env: {} })).toThrow(SyntaxError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('sends local memory servers across the ACP session boundary without Zo credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-session-no-zo-'));
    const configPath = join(directory, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'] },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
      },
    }));
    try {
      const t = new ACPTransport(mockACPEntry as ExecutorRegistryEntry, makeCB(), {
        adapterBin: 'bun',
        adapterArgs: [`${import.meta.dir}/fixtures/mock-acp-adapter.ts`],
        mcpConfig: { configPath, includeShared: true, includeZo: true },
      });
      const outcome = await t.execute(
        { id: 'mcp-no-zo-wire-test', persona: 'kimi', task: 'report mcp', priority: 'low' },
        {
          timeoutMs: 5_000,
          workdir: directory,
          env: { ZO_CLIENT_IDENTITY_TOKEN: '', ZO_API_KEY: '', ZO_MCP_API_KEY: '' },
        },
      );
      expect(outcome.success).toBe(true);
      expect(outcome.output).toBe('zo-memory,qdrant-rag');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('injects the memory-gate briefing into ACP prompts', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('Remember the active project.', {
      status: 200,
    })) as typeof fetch;
    try {
      const prompt = await buildAcpPrompt(
        {
          id: 'memory-test',
          persona: 'kimi',
          task: 'Continue the implementation.',
          priority: 'low',
        },
        { includeMemoryBriefing: true },
        { MEMORY_GATE_URL: 'http://memory.test' },
      );
      expect(prompt).toContain('Continue the implementation.');
      expect(prompt).toContain('[SESSION BRIEFING - Zo Shared Memory]');
      expect(prompt).toContain('Remember the active project.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('builds Hermes session-local provider and model selections', () => {
    expect(resolveHermesSessionModel(undefined, undefined, 'deepseek:model-a')).toBeUndefined();
    expect(resolveHermesSessionModel(undefined, 'model-b', 'deepseek:model-a')).toBe('model-b');
    expect(resolveHermesSessionModel('xai', 'grok-3', 'deepseek:model-a')).toBe('xai:grok-3');
    expect(resolveHermesSessionModel('xai', undefined, 'deepseek:model-a')).toBe('xai:model-a');
    expect(() => resolveHermesSessionModel('xai', undefined, undefined)).toThrow(
      'requires an ACP current model',
    );
  });

  test('finds the ACP 0.25 model configuration selector', () => {
    expect(findAcpModelConfig([
      { id: 'approval', type: 'select', currentValue: 'ask' },
      { id: 'model-choice', category: 'model', type: 'select', currentValue: 'xai:grok-4.5' },
    ])).toEqual({ id: 'model-choice', currentValue: 'xai:grok-4.5' });
    expect(findAcpModelConfig(undefined)).toBeUndefined();
  });

  test('builds provider-qualified ACP models and rejects ambiguous identifiers', () => {
    expect(resolveACPModel('xai', 'grok-4.3', undefined, '/')).toBe('xai/grok-4.3');
    expect(resolveACPModel(undefined, 'opencode/gpt-5.4-mini', undefined, '/')).toBe(
      'opencode/gpt-5.4-mini',
    );
    expect(resolveACPModel('xai', undefined, 'opencode/gpt-5.4-mini', '/')).toBe(
      'xai/gpt-5.4-mini',
    );
    expect(() => resolveACPModel('xai', 'opencode/gpt-5.4-mini', undefined, '/')).toThrow(
      'conflicts with model',
    );
    expect(() => resolveACPModel(undefined, 'byok:opaque-id', undefined, '/')).toThrow(
      'not provider-native',
    );
  });

  test('injects task-scoped provider config without replacing existing OpenCode config', () => {
    const entry = {
      ...mockACPEntry,
      id: 'opencode',
      acp: {
        adapterBin: 'opencode',
        modelSelection: { method: 'session-config', providerSeparator: '/' },
        providerTemplates: {
          'synthetic-new': {
            endpointClass: 'synthetic-direct',
            credentialEnv: 'SYNTHETIC_NEW_API_KEY',
            launchConfig: {
              envVar: 'OPENCODE_CONFIG_CONTENT',
              value: {
                provider: {
                  'synthetic-new': { npm: '@ai-sdk/openai-compatible' },
                },
              },
            },
          },
        },
      },
    } as ExecutorRegistryEntry;
    const transport = new ACPTransport(entry, makeCB());
    const env = (transport as unknown as {
      buildEnv(options: { env: Record<string, string> }): Record<string, string>;
    }).buildEnv({
      env: {
        SWARM_PROVIDER: 'synthetic-new',
        SWARM_RESOLVED_MODEL: 'hf:zai-org/GLM-5.2',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugin: ['existing-plugin'],
          provider: { existing: { npm: '@ai-sdk/openai' } },
        }),
      },
    });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
      plugin: string[];
      provider: Record<string, { npm: string }>;
    };

    expect(config.plugin).toEqual(['existing-plugin']);
    expect(config.provider.existing.npm).toBe('@ai-sdk/openai');
    expect(config.provider['synthetic-new'].npm).toBe('@ai-sdk/openai-compatible');
  });

  test('requires non-empty output for ACP success', () => {
    expect(isAcpSuccessfulOutput('end_turn', 'done')).toBe(true);
    expect(isAcpSuccessfulOutput('end_turn', '   ')).toBe(false);
    expect(isAcpSuccessfulOutput('cancelled', 'partial')).toBe(false);
  });

  test('classifies the Codex skill budget warning as progress across chunks', () => {
    const warning =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. ' +
      'Codex can still see every skill, but some descriptions are shorter. ' +
      'Disable unused skills or plugins to leave more room for the rest.';
    const classifier = new AcpAgentMessageClassifier();

    expect(classifier.consume(warning.slice(0, 72))).toBeNull();
    expect(classifier.consume(warning.slice(72))).toEqual({ type: 'progress', content: warning });

    expect(classifier.consume(`\n${warning.replace('2%', '3%')}\n`)?.type).toBe('progress');
  });

  test('keeps ordinary ACP agent messages in final text output', () => {
    const classifier = new AcpAgentMessageClassifier();
    expect(classifier.consume('Implementation complete.')).toEqual({
      type: 'text',
      content: 'Implementation complete.',
    });
    expect(classifier.consume('Warning: the build failed.')?.type).toBe('text');
    expect(classifier.consume(undefined)).toEqual({ type: 'text', content: '' });
  });

  test('normalizes unusual ACP content without throwing', () => {
    const classifier = new AcpAgentMessageClassifier();
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(classifier.consume(1n)).toEqual({ type: 'text', content: '1' });
    expect(classifier.consume(circular)?.type).toBe('text');
  });

  test('flushes an incomplete diagnostic prefix as final text', () => {
    const classifier = new AcpAgentMessageClassifier();
    const partial = 'Warning: Skill descriptions were shortened';
    expect(classifier.consume(partial)).toBeNull();
    expect(classifier.flush()).toEqual({ type: 'text', content: partial });
  });

  test('releases a non-diagnostic message that diverges after the warning prefix', () => {
    const classifier = new AcpAgentMessageClassifier();
    const message =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. ' +
      'This is ordinary agent output.';

    expect(classifier.consume(message)).toEqual({ type: 'text', content: message });
    expect(classifier.flush()).toBeNull();
  });

  test('requires the complete Codex diagnostic wording before classifying progress', () => {
    const classifier = new AcpAgentMessageClassifier();
    const message =
      'Warning: Skill descriptions were shortened to fit the 2% skills context budget. ' +
      'Codex can still see every skill, including the final answer.';

    expect(classifier.consume(message)).toEqual({ type: 'text', content: message });
  });

  test('flush clears buffered content before a following non-agent update', () => {
    const classifier = new AcpAgentMessageClassifier();
    const partial = 'Warning: Skill descriptions were shortened to fit the ';

    expect(classifier.consume(partial)).toBeNull();
    expect(classifier.flush()).toEqual({ type: 'text', content: partial });
    expect(classifier.consume('Final answer.')).toEqual({ type: 'text', content: 'Final answer.' });
  });

  test('healthCheck reports binary presence', async () => {
    const t = new ACPTransport(mockBridgeEntry, makeCB(), { adapterBin: 'claude-agent-acp' });
    const result = await t.healthCheck();
    // Result is deterministic based on whether binary is installed
    expect(typeof result.healthy).toBe('boolean');
    expect(typeof result.message).toBe('string');
    if (result.healthy) {
      expect(result.message).toContain('claude-agent-acp');
    }
  });

  test('healthCheck reports unhealthy for missing binary', async () => {
    const t = new ACPTransport(mockBridgeEntry, makeCB(), { adapterBin: 'nonexistent-acp-binary-xyz' });
    const result = await t.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain('not found');
  });

  test('healthCheck reports unhealthy when a bash ACP adapter script is missing', async () => {
    const t = new ACPTransport(mockBridgeEntry, makeCB(), {
      adapterBin: 'bash',
      adapterArgs: ['/definitely/missing/kimi-bridge.sh', '--acp'],
    });
    const result = await t.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain('ACP adapter script not found');
    expect(result.message).toContain('/definitely/missing/kimi-bridge.sh');
  });

  test('shutdown resolves immediately', async () => {
    const t = new ACPTransport(mockBridgeEntry, makeCB());
    await expect(t.shutdown()).resolves.toBeUndefined();
  });

  test('execute respects circuit breaker OPEN state', async () => {
    const cb = makeCB();
    // Force circuit breaker open
    for (let i = 0; i < 5; i++) cb.recordFailure('runtime_error');

    const t = new ACPTransport(mockBridgeEntry, cb);
    const result = await t.execute(
      { id: 'test', persona: 'claude-code', task: 'test', priority: 'low' },
      { timeoutMs: 1000 },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Circuit breaker OPEN');
  });

  test('executeWithUpdates returns { updates, result } shape', () => {
    // Use an open circuit breaker to prevent spawn — shape test only, no live process
    const cb = makeCB();
    for (let i = 0; i < 5; i++) cb.recordFailure('runtime_error');
    const t = new ACPTransport(mockBridgeEntry, cb);
    const { updates, result } = t.executeWithUpdates(
      { id: 'test', persona: 'claude-code', task: 'test', priority: 'low' },
      { timeoutMs: 100 },
    );
    expect(typeof updates[Symbol.asyncIterator]).toBe('function');
    expect(result).toBeInstanceOf(Promise);
  });

  test('retains final output while the streaming queue is drained', async () => {
    const t = new ACPTransport(mockACPEntry as ExecutorRegistryEntry, makeCB(), {
      adapterBin: 'bun',
      adapterArgs: [`${import.meta.dir}/fixtures/mock-acp-adapter.ts`],
    });
    const { updates, result } = t.executeWithUpdates(
      { id: 'stream-test', persona: 'claude-code', task: 'test', priority: 'low' },
      { timeoutMs: 5_000, idleTimeoutMs: 2_000 },
    );
    const streamed: string[] = [];
    const drain = (async () => {
      for await (const update of updates) {
        if (update.type === 'text') streamed.push(update.content);
      }
    })();

    const outcome = await result;
    await drain;

    expect(streamed.join('')).toBe('STREAMED_OK');
    expect(outcome.success).toBe(true);
    expect(outcome.output).toBe('STREAMED_OK');
  });

  test('applies Hermes routing through the ACP 0.25 model config option', async () => {
    const hermesEntry = {
      ...mockACPEntry,
      id: 'hermes',
      acp: {
        ...mockACPEntry.acp,
        modelSelection: {
          method: 'extension' as const,
          extensionMethod: 'session/set_model',
          category: 'model',
          providerSeparator: ':' as const,
        },
      },
    } as ExecutorRegistryEntry;
    const t = new ACPTransport(hermesEntry, makeCB(), {
      adapterBin: 'bun',
      adapterArgs: [`${import.meta.dir}/fixtures/mock-acp-adapter.ts`],
    });
    const outcome = await t.execute(
      { id: 'model-test', persona: 'hermes', task: 'report model', priority: 'low' },
      {
        timeoutMs: 5_000,
        idleTimeoutMs: 2_000,
        env: { SWARM_PROVIDER: 'xai', SWARM_RESOLVED_MODEL: 'grok-4.5' },
      },
    );

    expect(outcome.success).toBe(true);
    expect(outcome.output).toBe('xai:grok-4.5');
    expect(outcome.modelUsed).toBe('xai:grok-4.5');
  });
  // ZOU-568 regression: an adapter that dies mid-request could hang _runSession
  // forever when the ACP SDK failed to reject the in-flight JSON-RPC promise on
  // stream EOF. The event loop then drained and the host exited 0 with the
  // execution record stuck in a non-terminal 'executing' state. The session must
  // settle to a failure result and, regardless of whether the process-death
  // watchdog or the SDK's own stream-closed rejection wins the race, attribute
  // the failure to adapter death (its exit code/signal), not a generic error.
  test('settles to failure when the adapter dies before responding (ZOU-568)', async () => {
    const t = new ACPTransport(mockBridgeEntry, makeCB(), {
      adapterBin: '/bin/sh',
      adapterArgs: ['-c', 'exit 1'],
    });

    const HUNG = Symbol('hung');
    const outcome = await Promise.race([
      t.execute(
        { id: 'test', persona: 'claude-code', task: 'test', priority: 'low' },
        { timeoutMs: 30_000 },
      ),
      new Promise<typeof HUNG>(res => setTimeout(() => res(HUNG), 8_000)),
    ]);

    expect(outcome).not.toBe(HUNG); // must not hang past the child's death
    const result = outcome as Awaited<ReturnType<typeof t.execute>>;
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('ACP adapter exited');
  });

  test('rejects an adapter that acknowledges but ignores explicit model selection', async () => {
    const entry = {...mockACPEntry, acp:{...mockACPEntry.acp,modelSelection:{method:'session-config',configId:'model',category:'model'}}} as ExecutorRegistryEntry;
    const transport = new ACPTransport(entry, makeCB(), {adapterBin:'bun',adapterArgs:[`${import.meta.dir}/fixtures/mock-acp-adapter.ts`]});
    const result = await transport.execute(
      {id:'ignored-model',persona:'claude-code',task:'report model',priority:'low'},
      {timeoutMs:5000, env:{SWARM_RESOLVED_MODEL:'alternate-model',MOCK_IGNORE_MODEL:'1'}},
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not confirm selected ACP model');
  });

  test('buffered chunks count as activity without disabling idle deadlines', async () => {
    const transport = new ACPTransport(mockACPEntry as ExecutorRegistryEntry, makeCB(), {
      adapterBin: 'bun', adapterArgs: [`${import.meta.dir}/fixtures/mock-acp-adapter.ts`],
    });
    const result = await transport.execute(
      {id:'buffered', persona:'claude-code', task:'buffered activity', priority:'low'},
      {timeoutMs:5000, idleTimeoutMs:200},
    );
    expect(result.success).toBe(true);
    expect(result.output?.trim()).toBe('STREAMED_OK');
  });

  test('cancels an adapter that emits no ACP updates before the total timeout', async () => {
    const t = new ACPTransport(mockBridgeEntry, makeCB(), {
      adapterBin: '/bin/sh',
      adapterArgs: ['-c', 'sleep 30'],
    });

    const started = Date.now();
    const result = await t.execute(
      { id: 'idle-test', persona: 'claude-code', task: 'test', priority: 'low' },
      { timeoutMs: 10_000, idleTimeoutMs: 100 },
    );

    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('idle timed out after 100ms');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

// ─── Interface compliance ─────────────────────────────────────────────────────

describe('ExecutorTransport interface compliance', () => {
  test('both transport types implement required methods', () => {
    const bridge = new BridgeTransport(mockBridgeEntry, makeCB());
    const acp = new ACPTransport(mockBridgeEntry, makeCB());

    for (const t of [bridge, acp]) {
      expect(typeof t.execute).toBe('function');
      expect(typeof t.executeWithUpdates).toBe('function');
      expect(typeof t.healthCheck).toBe('function');
      expect(typeof t.shutdown).toBe('function');
    }
  });
});
