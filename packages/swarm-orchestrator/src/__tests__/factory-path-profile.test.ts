import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalFactoryPath, factoryWorktreesRoot, loadFactoryPathProfile, validateFactoryPathProfile } from '../transport/factory-path-profile';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync('/tmp/factory-profile-');
  roots.push(root);
  const state = join(root, 'state');
  mkdirSync(state);
  const profile = { version: 1, source_root: '/home/workspace', worktrees_root: '/home/.z/factory/.factory-worktrees', releases_root: '/home/.z/factory/releases', state_root: state, state_root_id: randomUUID(), state_generation: 0, state_device: statSync(state).dev };
  writeFileSync(join(state, '.factory-state-root.json'), JSON.stringify({ namespace: 'zouroboros-software-factory', schema_version: 1, canonical_path: state, root_id: profile.state_root_id, generation: 0, device: profile.state_device }));
  const path = join(root, 'profile.json');
  const bytes = JSON.stringify(profile);
  writeFileSync(path, bytes);
  const env = { FACTORY_PATH_PROFILE: path, FACTORY_PATH_PROFILE_SHA256: createHash('sha256').update(bytes).digest('hex') };
  return { root, profile, env };
}

test('legacy defaults stay unchanged and external roots need a profile', () => {
  expect(factoryWorktreesRoot(undefined, '/home/workspace/.factory-worktrees', {})).toBe('/home/workspace/.factory-worktrees');
  expect(() => factoryWorktreesRoot('/home/.z/factory/.factory-worktrees', undefined, {})).toThrow('pinned profile');
});
test('valid profile survives a new process with the same identity', () => {
  const f = fixture();
  expect(loadFactoryPathProfile(f.env)).toEqual(f.profile);
  const module = join(import.meta.dir, '../transport/factory-path-profile.ts');
  const child = spawnSync(process.execPath, ['-e', `import {loadFactoryPathProfile} from ${JSON.stringify(module)}; console.log(JSON.stringify(loadFactoryPathProfile()));`], { env: { PATH: process.env.PATH, ...f.env }, encoding: 'utf8' });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(f.profile);
});
test('partial, missing, changed and divergent profile bindings hold', () => {
  const f = fixture();
  expect(() => loadFactoryPathProfile({ FACTORY_PATH_PROFILE: f.env.FACTORY_PATH_PROFILE })).toThrow();
  expect(() => loadFactoryPathProfile({ ...f.env, FACTORY_PATH_PROFILE: join(f.root, 'absent') })).toThrow();
  expect(() => loadFactoryPathProfile({ ...f.env, FACTORY_PATH_PROFILE_SHA256: '0'.repeat(64) })).toThrow('digest');
  expect(() => loadFactoryPathProfile({ ...f.env, SWARM_EXEC_CONTAINMENT_ROOT: '/home/workspace/.factory-worktrees' })).toThrow('divergence');
  expect(() => factoryWorktreesRoot('/tmp/other', undefined, f.env)).toThrow('diverges');
});
test('unknown fields, broadened source authority and state identity drift hold', () => {
  const f = fixture();
  expect(() => validateFactoryPathProfile({ ...f.profile, extra: true })).toThrow('schema');
  expect(() => validateFactoryPathProfile({ ...f.profile, source_root: '/home' })).toThrow('namespace');
  expect(() => validateFactoryPathProfile({ ...f.profile, state_generation: 1 })).toThrow('identity mismatch');
  expect(() => validateFactoryPathProfile({ ...f.profile, state_root: f.profile.releases_root })).toThrow('independent');
});
test('relative, escaped, symlink and dangling symlink paths hold', () => {
  const f = fixture();
  for (const path of ['relative', '/tmp/../etc', '/', '/tmp/x\n']) expect(() => canonicalFactoryPath(path)).toThrow();
  symlinkSync(f.root, join(f.root, 'alias'));
  symlinkSync(join(f.root, 'missing'), join(f.root, 'dangling'));
  expect(() => canonicalFactoryPath(join(f.root, 'alias', 'new'))).toThrow('symlink');
  expect(() => canonicalFactoryPath(join(f.root, 'dangling', 'new'))).toThrow('symlink');
});
