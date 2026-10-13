import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  factoryRoots,
  logRoot,
  modelRoutingDir,
  runtimeRoot,
  stateRoot,
  workspaceRoot,
} from '../host-roots.js';

const HOME = '/home/testuser';

function env(overrides: Record<string, string | undefined> = {}) {
  return { HOME, ...overrides };
}

describe('host-roots env precedence', () => {
  test('ZOUROBOROS_STATE_DIR wins over legacy ZO_* and XDG', () => {
    const e = env({
      ZOUROBOROS_STATE_DIR: '/var/lib/zouroboros',
      ZO_STATE_DIR: '/legacy',
      XDG_STATE_HOME: '/xdg',
    });
    expect(stateRoot(e)).toBe('/var/lib/zouroboros');
  });

  test('legacy ZO_STATE_DIR is honored when ZOUROBOROS_* unset', () => {
    expect(stateRoot(env({ ZO_STATE_DIR: '/legacy' }))).toBe('/legacy');
  });

  test('XDG_STATE_HOME is used when no explicit state dir', () => {
    expect(stateRoot(env({ XDG_STATE_HOME: '/xdg' }))).toBe('/xdg/zouroboros');
  });

  test('falls back to ~/.local/state/zouroboros', () => {
    expect(stateRoot(env())).toBe(join(HOME, '.local', 'state', 'zouroboros'));
  });

  test('logs and runtime derive from state by default', () => {
    const e = env({ ZOUROBOROS_STATE_DIR: '/s' });
    expect(logRoot(e)).toBe('/s/logs');
    expect(runtimeRoot(e)).toBe('/s/runtime');
  });

  test('explicit log/runtime dirs override the state-derived ones', () => {
    const e = env({ ZOUROBOROS_STATE_DIR: '/s', ZOUROBOROS_LOG_DIR: '/l', ZOUROBOROS_RUNTIME_DIR: '/r' });
    expect(logRoot(e)).toBe('/l');
    expect(runtimeRoot(e)).toBe('/r');
  });

  test('workspace prefers ZOUROBOROS_WORKSPACE, then ZO_WORKSPACE, then cwd', () => {
    expect(workspaceRoot(env({ ZOUROBOROS_WORKSPACE: '/w', ZO_WORKSPACE: '/z' }))).toBe('/w');
    expect(workspaceRoot(env({ ZO_WORKSPACE: '/z' }))).toBe('/z');
    expect(workspaceRoot(env())).toBe(process.cwd());
  });

  test('legacy host layout is fully restorable via env', () => {
    const e = env({
      ZOUROBOROS_WORKSPACE: '/home/workspace',
      ZOUROBOROS_STATE_DIR: '/var/lib/zouroboros',
    });
    expect(workspaceRoot(e)).toBe('/home/workspace');
    expect(stateRoot(e)).toBe('/var/lib/zouroboros');
    expect(modelRoutingDir(e)).toBe('/var/lib/zouroboros/model-routing');
  });

  test('factoryRoots derives external namespace from state', () => {
    const e = env({ ZOUROBOROS_STATE_DIR: '/s', ZOUROBOROS_WORKSPACE: '/w' });
    const r = factoryRoots(e);
    expect(r.source).toBe('/w');
    expect(r.external).toBe('/s/factory');
    expect(r.externalReleases).toBe('/s/factory/releases');
  });

  test('relative env values are ignored (must be absolute)', () => {
    // 'relative/path' is not absolute → falls through to the XDG default
    expect(stateRoot(env({ ZOUROBOROS_STATE_DIR: 'relative/path' }))).toBe(
      join(HOME, '.local', 'state', 'zouroboros'),
    );
  });
});
