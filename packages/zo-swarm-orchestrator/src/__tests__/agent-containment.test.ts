import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareFilesystemContainedSpawn } from '../transport/agent-containment.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; containmentRoot: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), 'zouroboros-containment-'));
  roots.push(root);
  chmodSync(root, 0o755);
  const containmentRoot = join(root, '.factory-worktrees');
  const workdir = join(containmentRoot, 'job');
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, 'input.txt'), 'safe\n');
  return { root, containmentRoot, workdir };
}

function env(containmentRoot: string): Record<string, string> {
  return {
    SWARM_EXEC_CONTAINMENT_REQUIRED: '1',
    SWARM_EXEC_CONTAINMENT_ROOT: containmentRoot,
    SWARM_EXEC_CONTAINMENT_UID: '65534',
    SWARM_EXEC_CONTAINMENT_GID: '65534',
    SWARM_EXECUTOR_ID: 'containment-test',
  };
}

describe('agent filesystem containment', () => {
  test('external containment cannot bypass profile selection', () => {
    expect(() => prepareFilesystemContainedSpawn({ command: '/bin/true', args: [] }, '/home/.z/factory/.factory-worktrees/job', env('/home/.z/factory/.factory-worktrees'))).toThrow('pinned Factory profile');
  });
  const containmentAvailable = existsSync('/usr/bin/bwrap') && existsSync('/usr/bin/setpriv');
  test.skipIf(!containmentAvailable)('binds only assigned linked Git metadata read-only', () => {
    const item = fixture();
    const repo = join(item.root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    writeFileSync(join(repo, 'source'), 'before\n');
    git('add', 'source');
    git('commit', '-qm', 'fixture');
    const linked = join(item.containmentRoot, 'linked');
    const sibling = join(item.containmentRoot, 'sibling');
    git('worktree', 'add', '--detach', linked, 'HEAD');
    git('worktree', 'add', '--detach', sibling, 'HEAD');
    const spec = prepareFilesystemContainedSpawn({ command: '/bin/sh', args: ['-c', `git status --porcelain && git rev-parse HEAD && printf after > source && git diff -- source && test ! -e ${JSON.stringify(sibling)} && ! git update-ref refs/heads/forbidden HEAD`] }, linked, env(item.containmentRoot));
    try {
      const result = spawnSync(spec.command, spec.args, { env: process.env, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('+after');
    } finally { spec.closeAfterSpawn?.(); spec.cleanupAfterExit?.(); }
    const pointer = readFileSync(join(linked, '.git'), 'utf8');
    writeFileSync(join(linked, '.git'), readFileSync(join(sibling, '.git'), 'utf8'));
    expect(() => prepareFilesystemContainedSpawn({ command: '/bin/true', args: [] }, linked, env(item.containmentRoot))).toThrow('registration');
    writeFileSync(join(linked, '.git'), pointer);
    const gitdir = pointer.trim().slice(8);
    writeFileSync(join(gitdir, 'commondir'), '../../..');
    expect(() => prepareFilesystemContainedSpawn({ command: '/bin/true', args: [] }, linked, env(item.containmentRoot))).toThrow('common directory');
  });
  test('leaves non-factory spawns unchanged when containment is not required', () => {
    expect(prepareFilesystemContainedSpawn({ command: 'codex-acp', args: ['serve'] }, '/tmp', {})).toEqual({
      command: 'codex-acp',
      args: ['serve'],
    });
  });

  test('rejects a workdir outside the assigned factory worktree root', () => {
    const item = fixture();
    expect(() => prepareFilesystemContainedSpawn(
      { command: '/usr/bin/true', args: [] },
      item.root,
      env(item.containmentRoot),
    )).toThrow('must be inside');
  });

  test.skipIf(!containmentAvailable)('runs as a rootless host user with only the assigned worktree writable', () => {
    const item = fixture();
    const spec = prepareFilesystemContainedSpawn(
      {
        command: '/usr/bin/sh',
        args: ['-c', 'test "$(id -u)" = 0 && test ! -e /home/workspace/AGENTS.md && printf contained > output.txt'],
      },
      item.workdir,
      env(item.containmentRoot),
    );
    const result = spawnSync(spec.command, spec.args, {
      cwd: item.workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', ...(spec.passFds ?? [])],
    });
    spec.closeAfterSpawn?.();
    spec.cleanupAfterExit?.();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(item.workdir, 'output.txt'), 'utf8')).toBe('contained');
    expect(statSync(join(item.workdir, 'output.txt')).uid).toBe(65_534);
  });

  test.skipIf(!containmentAvailable)('permits pnpm-style hard links only beneath node_modules', () => {
    const item = fixture();
    const store = join(item.root, 'store-file');
    const dependency = join(item.workdir, 'node_modules', 'pkg', 'index.js');
    writeFileSync(store, 'module.exports = 1\n');
    mkdirSync(join(item.workdir, 'node_modules', 'pkg'), { recursive: true });
    linkSync(store, dependency);
    expect(() => prepareFilesystemContainedSpawn(
      { command: '/usr/bin/true', args: [] },
      item.workdir,
      env(item.containmentRoot),
    )).not.toThrow();
  });

  test.skipIf(!containmentAvailable)('rejects hard links outside dependency trees', () => {
    const item = fixture();
    const outside = join(item.root, 'outside');
    writeFileSync(outside, 'sensitive\n');
    linkSync(outside, join(item.workdir, 'linked'));
    expect(() => prepareFilesystemContainedSpawn(
      { command: '/usr/bin/true', args: [] },
      item.workdir,
      env(item.containmentRoot),
    )).toThrow('hard-linked file');
  });
});
