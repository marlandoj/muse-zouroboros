/**
 * ACPTransport integration test
 *
 * Stage 1: Unit tests for transport factory, BridgeTransport, ACPTransport construction.
 * Stage 2: Integration smoke test — ACPTransport health check (verifies adapter binary exists).
 *
 * We do NOT run live ACP sessions in CI (requires Claude auth). The integration
 * test validates the full transport wiring up to the spawn boundary.
 */

import { describe, test, expect, mock } from 'bun:test';
import { BridgeTransport } from '../transport/bridge-transport.js';
import {
  ACPTransport,
  AcpAgentMessageClassifier,
  buildAcpPrompt,
  buildCgroupGuardedAdapterSpawn,
  buildResourceGuardedAdapterSpawn,
  createExecutorResourceCgroup,
  findAcpModelConfig,
  dispatchWayfinderShadow,
  evaluateWayfinderShadow,
  formatWayfinderPromptSuffix,
  isAcpSuccessfulOutput,
  loadAcpMcpServers,
  parseProcSmapsRollupPssBytes,
  parseProcStatmRssBytes,
  readWayfinderShadowRow,
  resolveWayfinderLivePick,
  wayfinderInjectionArmed,
  wayfinderRowPath,
  wayfinderRankScript,
  wayfinderPython,
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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


describe('Wayfinder shadow integration', () => {
  const engineDir = '/opt/wayfinder';
  const entrypoint = `${engineDir}/engine/run.py`;
  const base = {
    enabled: true,
    mode: 'shadow' as const,
    engineDir,
    harness: 'factory',
    home: '/home/workspace/.wayfinder',
    skillsRoots: ['/home/workspace/Skills'],
  };
  const task = {
    id: 'task-1',
    persona: 'kimi',
    task: 'Render a promotional video for the quarterly earnings deck',
    priority: 'low' as const,
  };

  describe('the program it runs', () => {
    const script = wayfinderRankScript({
      entrypoint,
      harness: 'factory',
      stateHome: '/home/workspace/.wayfinder',
      roots: '/home/workspace/Skills',
      cwd: '/home/workspace/.factory-worktrees/wt-1',
      timeoutMs: 15_000,
      invocationId: 'inv-1',
      event: { prompt: task.task, session_id: 'task-1', cwd: '/home/workspace/.factory-worktrees/wt-1' },
    });

    test('passes the event in argv so the child needs no stdin pipe', () => {
      expect(script).toContain('--event-json');
      expect(script).toContain('--invocation-id');
      expect(script).toContain('inv-1');
      // A pipe would have to stay owned by this process until the child exits.
      expect(script).not.toContain('printf');
      expect(script).not.toContain('<<');
    });

    test('carries state, roots, cwd and a hard timeout', () => {
      expect(script).toContain(`export WAYFINDER_HOME='/home/workspace/.wayfinder'`);
      expect(script).toContain(`export WAYFINDER_SKILLS_ROOTS='/home/workspace/Skills'`);
      expect(script).toContain(`cd '/home/workspace/.factory-worktrees/wt-1' || exit 0`);
      expect(script).toContain('timeout 15 python3');
    });

    test('runs the engine with WAYFINDER_PYTHON when a host sets one', () => {
      expect(wayfinderPython({})).toBe('python3');
      expect(wayfinderPython({ WAYFINDER_PYTHON: '  ' })).toBe('python3');
      expect(wayfinderPython({ WAYFINDER_PYTHON: '/opt/wf venv/bin/python' })).toBe('/opt/wf venv/bin/python');
      const custom = wayfinderRankScript({
        entrypoint,
        harness: 'factory',
        stateHome: '/tmp/wf',
        roots: '',
        cwd: '/tmp',
        timeoutMs: 15_000,
        invocationId: 'inv-3',
        event: { prompt: 'p', session_id: 's', cwd: '/tmp' },
        python: '/opt/wf venv/bin/python',
      });
      expect(custom).toContain(`timeout 15 '/opt/wf venv/bin/python' `);
      expect(custom).not.toContain('python3');
    });

    test('shell-quotes values rather than trusting them', () => {
      const quoted = wayfinderRankScript({
        entrypoint,
        harness: 'factory',
        stateHome: "/tmp/it's here",
        roots: '',
        cwd: '/tmp',
        timeoutMs: 15_000,
        invocationId: 'inv-2',
        event: { prompt: 'a $(rm -rf /) prompt', session_id: 's', cwd: '/tmp' },
      });
      expect(quoted).toContain("'\\''");
      expect(quoted).toContain(`rm -rf /`);
      // An empty root list must not export an empty override.
      expect(quoted).not.toContain('WAYFINDER_SKILLS_ROOTS');
    });
  });

  describe('row lookup', () => {
    test('reads the per-invocation file the engine writes', () => {
      const home = mkdtempSync(join(tmpdir(), 'wayfinder-row-'));
      try {
        const rowPath = join(home, 'invocations', 'inv-9', 'shadow.jsonl');
        mkdirSync(join(home, 'invocations', 'inv-9'), { recursive: true, mode: 0o700 });
        writeFileSync(rowPath, JSON.stringify({
          pick: 'fal-ai-media',
          pick_path: '/home/workspace/Skills/fal-ai-media/SKILL.md',
          candidates: [{ id: 'fal-ai-media', source: '/home/workspace/Skills/fal-ai-media/SKILL.md' }],
        }) + '\n');
        const row = readWayfinderShadowRow(rowPath);
        expect(row?.pick).toBe('fal-ai-media');
        expect(row?.pickPath).toBe('/home/workspace/Skills/fal-ai-media/SKILL.md');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test('returns nothing when the ranking never landed', () => {
      expect(readWayfinderShadowRow('/nonexistent/inv-1/shadow.jsonl')).toBeUndefined();
    });

    test('derives the row path from state home and invocation id', () => {
      expect(wayfinderRowPath('/home/workspace/.wayfinder', 'inv-1'))
        .toBe('/home/workspace/.wayfinder/invocations/inv-1/shadow.jsonl');
    });
  });

  describe('adoption labelling', () => {
    const row = {
      pick: 'fal-ai-media',
      pickPath: '/home/workspace/Skills/fal-ai-media/SKILL.md',
      candidates: [{ id: 'fal-ai-media', source: '/home/workspace/Skills/fal-ai-media/SKILL.md' }],
    };

    test('counts a suggestion as adopted when the agent read the skill', () => {
      const result = evaluateWayfinderShadow(row, new Set(['/home/workspace/Skills/fal-ai-media/SKILL.md']));
      expect(result).toEqual({
        pick: 'fal-ai-media',
        used: true,
        readSkills: ['/home/workspace/Skills/fal-ai-media/SKILL.md'],
      });
    });

    test('prefers the candidate path over pick_path', () => {
      const stale = { ...row, pickPath: '/old/path/SKILL.md' };
      const result = evaluateWayfinderShadow(stale, new Set(['/old/path/SKILL.md']));
      expect(result?.used).toBe(false);
    });

    test('labels a read-but-ignored suggestion as not adopted', () => {
      const result = evaluateWayfinderShadow(row, new Set(['/home/workspace/AGENTS.md']));
      expect(result?.used).toBe(false);
      expect(result?.readSkills).toEqual([]);
    });

    test('produces no label when nothing was picked', () => {
      expect(evaluateWayfinderShadow({ pick: undefined, candidates: [] }, new Set())).toBeUndefined();
    });
  });

  describe('dispatch guards', () => {
    test('does nothing when the integration is not enabled', () => {
      expect(dispatchWayfinderShadow(task, { ...base, enabled: false }, {}, '/tmp')).toBeUndefined();
    });

    test('the shadow path refuses canary/live configs', () => {
      expect(dispatchWayfinderShadow(
        task,
        { ...base, mode: 'live' },
        {},
        '/tmp',
      )).toBeUndefined();
      expect(dispatchWayfinderShadow(
        task,
        { ...base, mode: 'canary' },
        {},
        '/tmp',
      )).toBeUndefined();
    });

    test('does nothing when the engine is not on disk', () => {
      expect(dispatchWayfinderShadow(
        task,
        { ...base, engineDir: '/nonexistent/wayfinder' },
        {},
        '/tmp',
      )).toBeUndefined();
    });

    test('prompts are never altered in shadow mode', async () => {
      const prompt = await buildAcpPrompt(task, undefined, {}, undefined);
      expect(prompt).toBe(task.task);
    });
  });

  describe('live injection seam', () => {
    const liveBase = { ...base, mode: 'live' as const };
    const canaryBase = { ...base, mode: 'canary' as const, harness: 'opencode', canaryHarness: 'opencode' };

    describe('wayfinderInjectionArmed', () => {
      test('live is armed only with the flag', () => {
        expect(wayfinderInjectionArmed(liveBase, { WAYFINDER_LIVE_INJECT: '1' })).toBe(true);
        expect(wayfinderInjectionArmed(liveBase, {})).toBe(false);
      });

      test('canary requires the harness to match the canary harness', () => {
        expect(wayfinderInjectionArmed(canaryBase, { WAYFINDER_LIVE_INJECT: '1' })).toBe(true);
        expect(wayfinderInjectionArmed(
          { ...canaryBase, harness: 'claude' },
          { WAYFINDER_LIVE_INJECT: '1' },
        )).toBe(false);
      });

      test('shadow never arms, even with the flag', () => {
        expect(wayfinderInjectionArmed(base, { WAYFINDER_LIVE_INJECT: '1' })).toBe(false);
        expect(wayfinderInjectionArmed(undefined, { WAYFINDER_LIVE_INJECT: '1' })).toBe(false);
      });
    });

    describe('formatWayfinderPromptSuffix', () => {
      test('names the skill and its path', () => {
        const suffix = formatWayfinderPromptSuffix({ pick: 'fal-ai-media', pickPath: '/s/fal-ai-media' });
        expect(suffix).toContain('[WAYFINDER SUGGESTION]');
        expect(suffix).toContain('fal-ai-media');
        expect(suffix).toContain('/s/fal-ai-media');
      });

      test('omits the path when absent', () => {
        expect(formatWayfinderPromptSuffix({ pick: 'x' })).not.toContain('(');
      });
    });

    describe('resolveWayfinderLivePick', () => {
      test('degrades to nothing without the flag', async () => {
        await expect(resolveWayfinderLivePick(task, liveBase, {}, '/tmp')).resolves.toBeUndefined();
      });

      test('degrades to nothing when the engine is missing', async () => {
        await expect(resolveWayfinderLivePick(
          task,
          { ...liveBase, engineDir: '/nonexistent/wayfinder' },
          { WAYFINDER_LIVE_INJECT: '1' },
          '/tmp',
        )).resolves.toBeUndefined();
      });

      test('resolves the pick through a fake engine', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'wayfinder-live-'));
        try {
          // engineDir is the checkout root: the entrypoint is <engineDir>/engine/run.py.
          const engineSubdir = join(dir, 'engine');
          mkdirSync(engineSubdir, { recursive: true });
          // Fake engine: parses --invocation-id, writes the row the real engine would.
          writeFileSync(join(engineSubdir, 'run.py'), [
            'import json, os, sys',
            'inv = sys.argv[sys.argv.index("--invocation-id") + 1]',
            'home = os.environ["WAYFINDER_HOME"]',
            'd = os.path.join(home, "invocations", inv)',
            'os.makedirs(d, exist_ok=True)',
            'row = {"pick": "test-skill", "pick_path": "/tmp/test-skill",',
            '       "candidates": [{"id": "test-skill", "source": "/tmp/test-skill"}]}',
            'open(os.path.join(d, "shadow.jsonl"), "w").write(json.dumps(row) + "\\n")',
          ].join('\n'));
          const pick = await resolveWayfinderLivePick(
            task,
            { ...liveBase, engineDir: dir, home: join(dir, 'state'), timeoutMs: 10_000 },
            { WAYFINDER_LIVE_INJECT: '1' },
            dir,
          );
          expect(pick?.pick).toBe('test-skill');
          expect(pick?.pickPath).toBe('/tmp/test-skill');
          expect(pick?.rowPath).toContain('shadow.jsonl');
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });
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

  test('creates unified cgroup v2 limits when controllers are delegated', () => {
    const root = mkdtempSync(join(tmpdir(), 'zou-cgroup-v2-'));
    try {
      writeFileSync(join(root, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
      writeFileSync(join(root, 'cgroup.subtree_control'), '');
      const group = createExecutorResourceCgroup({
        SWARM_EXEC_RESOURCE_GUARD_REQUIRED: '1',
        SWARM_EXEC_MEMORY_LIMIT_MIB: '2048',
        SWARM_EXEC_PROCESS_LIMIT: '256',
      }, { cgroupRoot: root, logger: { warn: () => {} } });
      expect(group?.mode).toBe('cgroup-v2');
      expect(group?.memoryDir).toBe(group?.pidsDir);
      expect(readFileSync(join(group!.memoryDir!, 'memory.max'), 'utf8')).toBe(String(2048 * 1024 * 1024));
      expect(readFileSync(join(group!.pidsDir!, 'pids.max'), 'utf8')).toBe('256');

      const spec = buildCgroupGuardedAdapterSpawn(
        { command: 'codex-acp', args: ['serve'] },
        group!,
      );
      expect(spec.args.filter(arg => arg.endsWith('cgroup.procs'))).toHaveLength(1);
      // A real cgroupfs owns these virtual files; remove the regular-file
      // stand-ins before exercising directory cleanup in the temp hierarchy.
      rmSync(join(group!.memoryDir!, 'memory.max'));
      rmSync(join(group!.memoryDir!, 'pids.max'));
      expect(group!.cleanup()).toBe(true);
      expect(existsSync(group!.memoryDir!)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('degrades explicitly to process-tree monitoring when v2 controllers are not delegated', () => {
    const root = mkdtempSync(join(tmpdir(), 'zou-cgroup-degraded-'));
    const warnings: string[] = [];
    try {
      writeFileSync(join(root, 'cgroup.controllers'), '');
      const group = createExecutorResourceCgroup({
        SWARM_EXEC_RESOURCE_GUARD_REQUIRED: '1',
        SWARM_EXEC_MEMORY_LIMIT_MIB: '2048',
        SWARM_EXEC_PROCESS_LIMIT: '256',
      }, { cgroupRoot: root, logger: { warn: message => warnings.push(String(message)) } });
      expect(group?.mode).toBe('process-tree');
      expect(group?.memoryDir).toBeNull();
      expect(group?.pidsDir).toBeNull();
      expect(group?.degradedReason).toContain('memory, pids');
      expect(warnings.join('\n')).toContain('falling back to process-tree monitoring');
      expect(buildCgroupGuardedAdapterSpawn({ command: 'codex-acp', args: ['serve'] }, group!)).toEqual({
        command: 'codex-acp',
        args: ['serve'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test('reads unified cgroup v2 usage files', () => {
    const files = new Map<string, string>([
      ['/sys/fs/cgroup/zou-test/memory.current', String(512 * 1024 * 1024)],
      ['/sys/fs/cgroup/zou-test/pids.current', '42'],
    ]);
    expect(readExecutorResourceUsage(
      100,
      {
        mode: 'cgroup-v2',
        memoryDir: '/sys/fs/cgroup/zou-test',
        pidsDir: '/sys/fs/cgroup/zou-test',
      },
      path => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`unexpected read: ${path}`);
        return content;
      },
    )).toEqual({
      memory_bytes: 512 * 1024 * 1024,
      process_count: 42,
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

  test('loads shared memory servers and never injects Zo tools', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-'));
    const configPath = join(directory, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'] },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
      },
    }));
    try {
      // The Zo MCP server injection was removed outright (governance review
      // 2026-10-14): even with Zo tokens present, no `zo` server is added.
      const servers = loadAcpMcpServers(
        { configPath, includeShared: true },
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
      ]);
      expect(JSON.stringify(servers)).not.toContain('api.zo.computer');
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
        mcpConfig: { configPath, includeShared: true },
      });
      const outcome = await t.execute(
        { id: 'mcp-wire-test', persona: 'kimi', task: 'report mcp', priority: 'low' },
        {
          timeoutMs: 5_000,
          workdir: directory,
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

  test('keeps shared MCP servers regardless of Zo credentials in env', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-no-zo-'));
    const configPath = join(directory, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        'zo-memory': { command: 'bun', args: ['memory.ts'], env: { MEMORY_MODE: 'local' } },
        'qdrant-rag': { command: 'bun', args: ['rag.ts'] },
        custom: { url: 'https://custom.test/mcp' },
      },
    }));
    try {
      // The Zo MCP server injection was removed outright (governance review
      // 2026-10-14): no warning, no `zo` server, for any credential state.
      const shared = loadAcpMcpServers({ configPath }, { env: {} });
      for (const env of [{}, { ZO_CLIENT_IDENTITY_TOKEN: 'tok', ZO_API_KEY: 'tok2', ZO_MCP_API_KEY: 'tok3' }]) {
        expect(loadAcpMcpServers({ configPath }, { env })).toEqual(shared);
      }
      expect(loadAcpMcpServers({ includeShared: false }, { env: {} })).toEqual([]);
      expect(JSON.stringify(shared)).not.toContain('api.zo.computer');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('still rejects missing or malformed shared configuration without Zo credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarm-mcp-invalid-'));
    const configPath = join(directory, '.mcp.json');
    try {
      const config = { configPath };
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
        mcpConfig: { configPath, includeShared: true },
      });
      const outcome = await t.execute(
        { id: 'mcp-no-zo-wire-test', persona: 'kimi', task: 'report mcp', priority: 'low' },
        {
          timeoutMs: 5_000,
          workdir: directory,
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
