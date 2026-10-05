import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { loadRegistry, resolveExecutorRegistryPath } from '../registry/loader';
import { canonicalRegistry, generatedRegistry, orchestratorCopies, runtimeCopies, syncRuntimeCopies } from '../../scripts/sync-runtime-copies';

const root = resolve(import.meta.dir, '../../../..');
const roots: string[] = [];
const campaigns: string[] = [];
function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'rb2-runtime-'));
  roots.push(path);
  return path;
}
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
  for (const id of campaigns.splice(0)) {
    for (const suffix of ['.lock', '-complete.json']) rmSync(`/dev/shm/${id}${suffix}`, { force: true });
  }
});

describe('registry authority', () => {
  test('resolves explicit overrides, workspace data, and the installed registry consistently', () => {
    const workspace = tempRoot();
    expect(resolveExecutorRegistryPath(undefined, undefined, {})).toBe(join(root, canonicalRegistry));
    expect(resolveExecutorRegistryPath(undefined, undefined, { SWARM_WORKSPACE: workspace }))
      .toBe(join(workspace, canonicalRegistry));
    expect(resolveExecutorRegistryPath(undefined, undefined, { ZOUROBOROS_WORKSPACE_ROOT: workspace }))
      .toBe(join(workspace, canonicalRegistry));
    expect(resolveExecutorRegistryPath(undefined, workspace, { SWARM_EXECUTOR_REGISTRY: 'custom.json' }))
      .toBe(join(workspace, 'custom.json'));
    expect(resolveExecutorRegistryPath('/explicit.json', workspace, { SWARM_EXECUTOR_REGISTRY: '/env.json' }))
      .toBe('/explicit.json');
    // A missing explicit registry must not silently select another tree.
    expect(loadRegistry(join(workspace, 'missing.json')).executors).toEqual([]);
  });

  test('keeps active CLI executors separate from Mimir service metadata and deferred Cursor', () => {
    const registry = JSON.parse(readFileSync(join(root, canonicalRegistry), 'utf8'));
    expect(registry.executors.map((entry: any) => entry.id).sort())
      .toEqual(['claude-code', 'codex', 'gemini', 'hermes', 'kimi', 'opencode', 'pi']);
    expect(registry.services.map((entry: any) => entry.id)).toEqual(['mimir']);
    expect(registry.executors.find((entry: any) => entry.id === 'opencode').bridge).toBeUndefined();
    const loaded = loadRegistry(join(root, canonicalRegistry));
    expect(loaded.executors.find(entry => entry.id === 'pi')?.bestFor.length).toBeGreaterThan(0);
  });

  test('detects regenerated registry and runtime drift, including missing private submodules', () => {
    expect(syncRuntimeCopies(root)).toEqual([]);
    const fixture = tempRoot();
    for (const copy of runtimeCopies) write(join(fixture, copy.path), 'stale');
    write(join(fixture, canonicalRegistry), '{"executors":[]}\n');
    expect(syncRuntimeCopies(fixture, false, true)).toContain('Uninitialized submodule: Skills/zo-swarm-executors');
    write(join(fixture, 'Skills/zo-swarm-executors/.git'), 'fixture');
    write(join(fixture, 'Skills/zo-swarm-orchestrator/.git'), 'fixture');
    write(join(fixture, generatedRegistry), 'stale');
    syncRuntimeCopies(fixture, true, true);
    expect(syncRuntimeCopies(fixture, false, true)).toEqual([]);
    write(join(fixture, generatedRegistry), '{"executors":[{"id":"drift"}]}');
    expect(syncRuntimeCopies(fixture, false, true)).toEqual([`Runtime copy drift: ${generatedRegistry}`]);
  });
});

const entrypoints = ['packages/swarm/scripts/orchestrate-v5.ts',
  ...[...runtimeCopies, ...orchestratorCopies.filter(copy => existsSync(join(root, copy.path)))].filter(copy => copy.target === 'orchestrate-v5.ts').map(copy => copy.path)];
const cases = [
  { name: 'valid', output: 'Fixture completed.', stderr: '', success: true },
  { name: 'empty', output: ' \n ', stderr: '', success: false },
  { name: '4xx', output: 'HTTP 429 Too Many Requests', stderr: '', success: false },
  { name: '5xx', output: 'HTTP/1.1 503 Service Unavailable', stderr: '', success: false },
  { name: 'bridge-error', output: 'CLI banner', stderr: 'BRIDGE_ERROR: fixture failed', success: false },
];

for (const entrypoint of entrypoints) {
  test(`${entrypoint}: structured and plain failures never increase success history`, async () => {
    const workspace = tempRoot();
    const home = join(workspace, 'home');
    const swarmDir = join(workspace, 'campaign-state');
    const memory = join(workspace, 'memory.db');
    new Database(memory).close();
    const id = `rb37-${process.pid}-${entrypoints.indexOf(entrypoint)}-${Date.now()}`;
    campaigns.push(id);
    const executors: any[] = [];
    const tasks: any[] = [];
    for (const structured of [false, true]) {
      for (const fixture of cases) {
        const executor = `${structured ? 'json' : 'plain'}-${fixture.name}`;
        const bridge = join(workspace, `${executor}.sh`);
        const out = join(workspace, `${executor}.output`);
        const err = join(workspace, `${executor}.stderr`);
        write(out, structured ? JSON.stringify({ output: fixture.output, metrics: { tokensIn: 13, tokensOut: 7 } }) : fixture.output);
        write(err, fixture.stderr);
        write(bridge, `#!/bin/bash\ncat '${err}' >&2\n${structured ? `cp '${out}' "$RESULT_PATH"` : `cat '${out}'`}\n`);
        executors.push({ id: executor, name: executor, executor: 'local', bridge, expertise: [], best_for: [] });
        tasks.push({ id: executor, executor, persona: executor, task: 'Return a short fixture answer.', priority: 'medium', model: 'fixture-model', timeoutSeconds: 5 });
      }
    }
    write(join(workspace, canonicalRegistry), JSON.stringify({ executors }));
    // A conflicting Skills copy makes precedence regressions visible.
    write(join(workspace, generatedRegistry), JSON.stringify({ executors: [] }));
    write(join(workspace, 'packages/swarm/assets/persona-registry.json'), '{"personas":[]}');
    const campaign = join(workspace, 'tasks.json');
    write(campaign, JSON.stringify(tasks));
    const proc = Bun.spawn([process.execPath, join(root, entrypoint), campaign,
      '--swarm-id', id, '--max-retries', '0', '--concurrency', '1', '--plan-gate-mode', 'disabled'], {
      cwd: workspace,
      env: { ...process.env, HOME: home, SWARM_DIR: swarmDir, SWARM_WORKSPACE: workspace, SWARM_EXECUTOR_REGISTRY: undefined,
        ZO_MEMORY_DB: memory, ZOUROBOROS_MEMORY_DB: memory, ZO_TRACE_ID: id,
        SWARM_SPECIALIST_MODE: 'off' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect({ exitCode, diagnostics: exitCode ? stdout + stderr : '' }).toEqual({ exitCode: 0, diagnostics: '' });
    const results = JSON.parse(readFileSync(join(swarmDir, 'results', `${id}.json`), 'utf8'));
    expect(existsSync(join(home, '.swarm/results', `${id}.json`))).toBe(false);
    expect(results.completed).toBe(2);
    expect(results.failed).toBe(8);
    const history = new Database(join(swarmDir, 'executor-history.db'), { readonly: true });
    try {
      for (const result of results.results) {
        const expected = result.task.id.endsWith('-valid');
        expect(result.success).toBe(expected);
        if (!expected) expect(result.task.memoryMetadata.previousAttemptContext.error).toContain('Bridge failure:');
        const row = history.query('SELECT attempts, successes FROM executor_history WHERE executor = ?')
          .get(result.task.executor) as { attempts: number; successes: number };
        expect(row).toEqual({ attempts: 1, successes: expected ? 1 : 0 });
      }
    } finally { history.close(); }
    const trace = JSON.parse(readFileSync(join(home, '.zouroboros/trace-outcomes.jsonl'), 'utf8').trim());
    expect(trace.trace_id).toBe(id);
    expect(trace.outcome).toBe('failure');
  }, 90_000);
}
