import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bridgeInjectionArmed,
  bridgeReadPaths,
  claudeProjectDir,
  claudeTranscriptReadPaths,
  rankBridgeTask,
  readWayfinderConfig,
} from '../wayfinder-bridge';
import type { WayfinderShadowConfig } from '../types';

const task = { id: 't_wayfinder_bridge', task: 'write a release note for the bridge seam' };

/** Fake engine: parses --invocation-id, writes the row the real engine would. */
function fakeEngine(dir: string): string {
  const engineSubdir = join(dir, 'engine');
  mkdirSync(engineSubdir, { recursive: true });
  writeFileSync(join(engineSubdir, 'run.py'), [
    'import json, os, sys',
    'inv = sys.argv[sys.argv.index("--invocation-id") + 1]',
    'd = os.path.join(os.environ["WAYFINDER_HOME"], "invocations", inv)',
    'os.makedirs(d, exist_ok=True)',
    'row = {"pick": "test-skill", "pick_path": "/tmp/test-skill/SKILL.md", "candidates": []}',
    'open(os.path.join(d, "shadow.jsonl"), "w").write(json.dumps(row) + "\\n")',
  ].join('\n'));
  return dir;
}

describe('bridgeInjectionArmed', () => {
  const canary: WayfinderShadowConfig = { enabled: true, mode: 'canary', harness: 'factory', canaryHarness: 'claude-code' };

  test('shadow never arms, flag or not', () => {
    expect(bridgeInjectionArmed({ enabled: true, mode: 'shadow' }, 'claude-code', { WAYFINDER_LIVE_INJECT: '1' })).toBe(false);
  });

  test('canary arms only the named executor, and only with the flag', () => {
    expect(bridgeInjectionArmed(canary, 'claude-code', { WAYFINDER_LIVE_INJECT: '1' })).toBe(true);
    expect(bridgeInjectionArmed(canary, 'hermes', { WAYFINDER_LIVE_INJECT: '1' })).toBe(false);
    expect(bridgeInjectionArmed(canary, 'claude-code', {})).toBe(false);
    expect(bridgeInjectionArmed(canary, 'claude-code', { WAYFINDER_LIVE_INJECT: '0' })).toBe(false);
  });

  test('disabled config never arms', () => {
    expect(bridgeInjectionArmed({ ...canary, enabled: false }, 'claude-code', { WAYFINDER_LIVE_INJECT: '1' })).toBe(false);
    expect(bridgeInjectionArmed(undefined, 'claude-code', { WAYFINDER_LIVE_INJECT: '1' })).toBe(false);
  });

  test('live keeps the transport gate', () => {
    expect(bridgeInjectionArmed({ enabled: true, mode: 'live' }, 'codex', { WAYFINDER_LIVE_INJECT: '1' })).toBe(true);
    expect(bridgeInjectionArmed({ enabled: true, mode: 'live' }, 'codex', {})).toBe(false);
  });
});

describe('readWayfinderConfig', () => {
  test('reads one executor block and tolerates a bad file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wayfinder-reg-'));
    try {
      const reg = join(dir, 'registry.json');
      writeFileSync(reg, JSON.stringify({ executors: [{ id: 'a', acp: { wayfinder: { enabled: true, mode: 'shadow' } } }, { id: 'b' }] }));
      expect(readWayfinderConfig(reg, 'a')).toEqual({ enabled: true, mode: 'shadow' });
      expect(readWayfinderConfig(reg, 'b')).toBeUndefined();
      writeFileSync(reg, '{bad');
      expect(readWayfinderConfig(reg, 'a')).toBeUndefined();
      expect(readWayfinderConfig(join(dir, 'missing.json'), 'a')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rankBridgeTask', () => {
  test('returns nothing without an engine', async () => {
    await expect(rankBridgeTask(task, 'claude-code', { enabled: true, mode: 'shadow', engineDir: '/nonexistent/wayfinder' }, {}, '/tmp')).resolves.toBeUndefined();
    await expect(rankBridgeTask(task, 'claude-code', undefined, {}, '/tmp')).resolves.toBeUndefined();
  });

  test('shadow dispatches a detached ranking and never injects', async () => {
    const dir = fakeEngine(mkdtempSync(join(tmpdir(), 'wayfinder-bridge-')));
    try {
      const config: WayfinderShadowConfig = { enabled: true, mode: 'canary', canaryHarness: 'claude-code', engineDir: dir, home: join(dir, 'state') };
      // Canary without the flag degrades to shadow.
      const ranking = await rankBridgeTask(task, 'claude-code', config, {}, dir);
      expect(ranking?.injected).toBe(false);
      expect(ranking?.promptSuffix).toBe('');
      expect(ranking?.suggestion.rowPath).toContain('shadow.jsonl');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('armed canary injects the suggestion marker', async () => {
    const dir = fakeEngine(mkdtempSync(join(tmpdir(), 'wayfinder-bridge-')));
    try {
      const config: WayfinderShadowConfig = { enabled: true, mode: 'canary', canaryHarness: 'claude-code', engineDir: dir, home: join(dir, 'state'), timeoutMs: 10_000 };
      const ranking = await rankBridgeTask(task, 'claude-code', config, { WAYFINDER_LIVE_INJECT: '1' }, dir);
      expect(ranking?.injected).toBe(true);
      expect(ranking?.pick).toBe('test-skill');
      expect(ranking?.promptSuffix).toContain('[WAYFINDER SUGGESTION]');
      expect(ranking?.promptSuffix).toContain('/tmp/test-skill/SKILL.md');

      const dry = await rankBridgeTask(task, 'claude-code', config, { WAYFINDER_LIVE_INJECT: '1', WAYFINDER_DRY_RUN: '1' }, dir);
      expect(dry?.injected).toBe(false);
      expect(dry?.promptSuffix).toBe('');

      // Another executor under the same canary block stays shadow.
      const other = await rankBridgeTask(task, 'hermes', config, { WAYFINDER_LIVE_INJECT: '1' }, dir);
      expect(other?.injected).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude transcript read paths', () => {
  test('project dir follows the Claude Code slug rule', () => {
    expect(claudeProjectDir('/opt/work/t_5d5bb73a', { HOME: '/home/u' })).toBe('/home/u/.claude/projects/-opt-work-t-5d5bb73a');
    expect(claudeProjectDir('/w', { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg/projects/-w');
  });

  test('collects read-like tool calls written since the attempt start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wayfinder-trace-'));
    try {
      const line = (name: string, input: Record<string, string>) =>
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
      writeFileSync(join(dir, 'new.jsonl'), [
        line('Read', { file_path: '/skills/a/SKILL.md' }),
        line('Bash', { command: 'cat /skills/b/SKILL.md' }),
        line('Grep', { path: '/skills/c' }),
        'not json tool_use',
      ].join('\n'));
      const old = join(dir, 'old.jsonl');
      writeFileSync(old, line('Read', { file_path: '/skills/old/SKILL.md' }));
      utimesSync(old, new Date(1_000), new Date(1_000));
      const paths = claudeTranscriptReadPaths(dir, Date.now() - 60_000);
      expect([...paths]).toEqual(['/skills/a/SKILL.md']);
      expect(readFileSync(join(dir, 'new.jsonl'), 'utf-8')).toContain('Bash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('only executors with a readable trace are labelled', () => {
    expect(bridgeReadPaths('hermes', '/tmp', 0, { HOME: '/tmp' })).toBeUndefined();
    expect(bridgeReadPaths('claude-code', '/nonexistent/cwd', 0, { HOME: '/nonexistent/home' })).toBeUndefined();
  });
});
