import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const LEGACY_FACTORY_WORKTREES = '/home/workspace/.factory-worktrees';
export const EXTERNAL_FACTORY_WORKTREES = '/home/.z/factory/.factory-worktrees';
export const EXTERNAL_FACTORY_RELEASES = '/home/.z/factory/releases';

export interface FactoryPathProfile {
  version: 1;
  source_root: string;
  worktrees_root: string;
  releases_root: string;
  state_root: string;
  state_root_id: string;
  state_generation: number;
  state_device: number;
}

export function insideFactoryPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function canonicalFactoryPath(path: string): string {
  if (!path || !isAbsolute(path) || resolve(path) !== path || path === '/' || /[\0\r\n]/.test(path)) {
    throw new Error('Factory profile requires canonical absolute paths');
  }
  let part = path;
  while (part !== '/') {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error('Factory profile rejects symlinked paths');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    part = dirname(part);
  }
  return path;
}

export function validateFactoryPathProfile(raw: unknown): FactoryPathProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Factory profile must be an object');
  const value = raw as FactoryPathProfile;
  const keys = ['version', 'source_root', 'worktrees_root', 'releases_root', 'state_root', 'state_root_id', 'state_generation', 'state_device'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.version !== 1) {
    throw new Error('Factory profile schema mismatch');
  }
  for (const key of ['source_root', 'worktrees_root', 'releases_root', 'state_root'] as const) {
    if (typeof value[key] !== 'string') throw new Error('Factory profile path must be a string');
    canonicalFactoryPath(value[key]);
  }
  if (value.source_root !== '/home/workspace' || value.worktrees_root !== EXTERNAL_FACTORY_WORKTREES || value.releases_root !== EXTERNAL_FACTORY_RELEASES) {
    throw new Error('Factory profile namespace is not authorized');
  }
  if ([value.worktrees_root, value.releases_root, LEGACY_FACTORY_WORKTREES].some(root => insideFactoryPath(root, value.state_root) || insideFactoryPath(value.state_root, root)) || /\/\.runtime\/factory-conveyor(?:-|\/)/.test(value.state_root)) {
    throw new Error('Factory profile state must be independent');
  }
  if (typeof value.state_root_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.state_root_id) || !Number.isSafeInteger(value.state_generation) || value.state_generation < 0 || !Number.isSafeInteger(value.state_device) || value.state_device < 0) {
    throw new Error('Factory profile state identity is invalid');
  }
  const markerPath = canonicalFactoryPath(join(value.state_root, '.factory-state-root.json'));
  if (!lstatSync(value.state_root).isDirectory() || !lstatSync(markerPath).isFile()) throw new Error('Factory profile state marker must be a regular file in a directory');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.namespace !== 'zouroboros-software-factory' || marker.schema_version !== 1 || marker.canonical_path !== value.state_root || marker.root_id !== value.state_root_id || marker.generation !== value.state_generation || marker.device !== value.state_device || lstatSync(value.state_root).dev !== value.state_device) {
    throw new Error('Factory profile state identity mismatch');
  }
  return value;
}

export function loadFactoryPathProfile(env: Record<string, string | undefined> = process.env): FactoryPathProfile | null {
  const path = env.FACTORY_PATH_PROFILE;
  const digest = env.FACTORY_PATH_PROFILE_SHA256;
  if (path === undefined && digest === undefined) return null;
  if (!path || !digest || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('Factory profile requires path and SHA-256');
  canonicalFactoryPath(path);
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Factory profile digest mismatch');
  const profile = validateFactoryPathProfile(JSON.parse(bytes.toString('utf8')));
  for (const [key, expected] of Object.entries({ FACTORY_CODING_CASCADE_WORKTREES_ROOT: profile.worktrees_root, SWARM_EXEC_CONTAINMENT_ROOT: profile.worktrees_root, FACTORY_STATE_DIR: profile.state_root })) {
    if (env[key] !== undefined && env[key] !== expected) throw new Error(`Factory profile divergence: ${key}`);
  }
  return profile;
}

export function factoryWorktreesRoot(explicit?: string, legacy = LEGACY_FACTORY_WORKTREES, env: Record<string, string | undefined> = process.env): string {
  const profile = loadFactoryPathProfile(env);
  if (profile) {
    if (explicit !== undefined && explicit !== profile.worktrees_root) throw new Error('Factory worktree override diverges from profile');
    return canonicalFactoryPath(profile.worktrees_root);
  }
  const selected = explicit ?? env.FACTORY_CODING_CASCADE_WORKTREES_ROOT ?? legacy;
  if (insideFactoryPath('/home/.z/factory', resolve(selected))) throw new Error('External Factory root requires a pinned profile');
  return selected;
}

export function factoryWorktreeReadRoots(explicit?: string): string[] {
  const selected = factoryWorktreesRoot(explicit);
  return [...new Set(loadFactoryPathProfile() ? [selected, LEGACY_FACTORY_WORKTREES] : [selected])];
}

export function factoryProfileEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const profile = loadFactoryPathProfile(env);
  return profile ? { FACTORY_PATH_PROFILE: env.FACTORY_PATH_PROFILE!, FACTORY_PATH_PROFILE_SHA256: env.FACTORY_PATH_PROFILE_SHA256!, FACTORY_CODING_CASCADE_WORKTREES_ROOT: profile.worktrees_root, FACTORY_STATE_DIR: profile.state_root } : {};
}
