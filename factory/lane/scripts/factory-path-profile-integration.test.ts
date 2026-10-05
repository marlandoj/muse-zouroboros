import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindFactoryPathProfile, configHash, loadRuntimeConfig, validateConfig, rollbackConfig } from './runtime-config';
import { factoryStateRoot } from './factory-state-root';
import { reconcileCodebaseIndexes } from './codebase-index-reconcile';
import { factoryProfileEnv, loadFactoryPathProfile } from '../../../packages/swarm/src/transport/factory-path-profile';

const roots: string[] = [];
const prior = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
  Object.assign(process.env, prior);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync('/tmp/factory-profile-integration-');
  roots.push(root);
  const state = join(root, 'state');
  mkdirSync(state);
  const marker = { namespace: 'zouroboros-software-factory', schema_version: 1, canonical_path: state, root_id: randomUUID(), generation: 0, device: statSync(state).dev };
  writeFileSync(join(state, '.factory-state-root.json'), JSON.stringify(marker));
  const profilePath = join(root, 'profile.json');
  const bytes = JSON.stringify({ version: 1, source_root: '/home/workspace', worktrees_root: '/home/.z/factory/.factory-worktrees', releases_root: '/home/.z/factory/releases', state_root: state, state_root_id: marker.root_id, state_generation: 0, state_device: marker.device });
  writeFileSync(profilePath, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const source = JSON.parse(readFileSync(join(import.meta.dir, '../config/runtime-flags.json'), 'utf8'));
  const configPath = join(root, 'runtime-flags.json');
  writeFileSync(configPath, JSON.stringify(source));
  return { root, state, profilePath, digest, source, paths: { configPath, previousPath: join(root, 'previous.json') }, env: { FACTORY_PATH_PROFILE: profilePath, FACTORY_PATH_PROFILE_SHA256: digest, FACTORY_STATE_DIR: state } };
}

test('environment alone cannot introduce profile authority into unchanged runtime config', () => {
  const f = fixture();
  Object.assign(process.env, f.env);
  const loaded = loadRuntimeConfig(f.paths.configPath);
  expect(loaded.ok).toBe(false);
  if (!loaded.ok) expect(loaded.errors.join()).toContain('config divergence');
  expect(JSON.parse(readFileSync(f.paths.configPath, 'utf8'))).toEqual(f.source);
});

test('paired config binding is preimage-checked, idempotent and rollback preserves every flag', () => {
  const f = fixture();
  expect(bindFactoryPathProfile(f.profilePath, f.digest, '0'.repeat(64), 'test', f.paths).ok).toBe(false);
  expect(existsSync(f.paths.previousPath)).toBe(false);
  const bound = bindFactoryPathProfile(f.profilePath, f.digest, configHash(f.source.flags), 'test', f.paths);
  expect(bound.ok).toBe(true);
  if (!bound.ok) throw new Error(bound.errors.join());
  expect(bound.changed).toBe(true);
  expect(JSON.parse(readFileSync(f.paths.previousPath, 'utf8'))).toEqual(f.source);
  const again = bindFactoryPathProfile(f.profilePath, f.digest, configHash(f.source.flags), 'test', f.paths);
  expect(again.ok).toBe(true);
  expect(again.ok && again.changed).toBe(false);
  expect(JSON.parse(readFileSync(f.paths.previousPath, 'utf8'))).toEqual(f.source);
  const rolled = rollbackConfig('test', f.paths);
  expect(rolled.ok).toBe(true);
  expect(JSON.parse(readFileSync(f.paths.configPath, 'utf8')).flags).toEqual(f.source.flags);
});

test('config rejects partial profile bindings and changed profile bytes', () => {
  const f = fixture();
  expect(validateConfig({ ...f.source, flags: { ...f.source.flags, FACTORY_PATH_PROFILE: f.profilePath } }).errors.length).toBeGreaterThan(0);
  const bound = bindFactoryPathProfile(f.profilePath, f.digest, configHash(f.source.flags), 'test', f.paths);
  expect(bound.ok).toBe(true);
  writeFileSync(f.profilePath, '{}');
  expect(loadRuntimeConfig(f.paths.configPath).ok).toBe(false);
});

test('profile state cannot fall back to compatibility or silently omit state binding', () => {
  const f = fixture();
  expect(factoryStateRoot({ env: f.env, mode: 'test' })).toBe(f.state);
  expect(() => factoryStateRoot({ env: f.env, mode: 'compatibility' })).toThrow('exact independent state');
  expect(() => factoryStateRoot({ env: { ...f.env, FACTORY_STATE_DIR: undefined }, mode: 'test' })).toThrow('exact independent state');
});

test('invalid index profile is rejected before acquiring a durable lock', () => {
  const f = fixture();
  Object.assign(process.env, f.env);
  expect(() => reconcileCodebaseIndexes({ stateDir: f.state, mirrorRoot: '/tmp/wrong', enabled: true })).toThrow('diverge');
  expect(existsSync(join(f.state, 'codebase-index-reconcile.lock'))).toBe(false);
  expect(factoryProfileEnv().FACTORY_PATH_PROFILE_SHA256).toBe(f.digest);
  expect(factoryProfileEnv().FACTORY_STATE_DIR).toBe(f.state);
});

test('symlinked state marker cannot supply profile identity', () => {
  const f = fixture();
  const marker = join(f.state, '.factory-state-root.json');
  const alternate = join(f.root, 'marker.json');
  writeFileSync(alternate, readFileSync(marker));
  rmSync(marker);
  symlinkSync(alternate, marker);
  expect(() => loadFactoryPathProfile(f.env)).toThrow('symlink');
});
