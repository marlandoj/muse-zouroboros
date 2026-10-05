import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalFactoryPath, insideFactoryPath, loadFactoryPathProfile } from './factory-path-profile.js';
import {
  chownSync,
  closeSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface AdapterSpawnSpec {
  command: string;
  args: string[];
  passFds?: number[];
  closeAfterSpawn?: () => void;
  cleanupAfterExit?: () => void;
  ipcHostRoot?: string;
  ipcGuestRoot?: string;
}

const BWRAP = '/usr/bin/bwrap';
const SETPRIV = '/usr/bin/setpriv';
const FACTORY_ROOT_NAME = '.factory-worktrees';
const IPC_HOST_PREFIX = '/dev/shm/zouroboros-sandbox-ipc-';

function isStrictDescendant(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function removeTree(target: string): void {
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (entry.isDirectory()) removeTree(child);
    else unlinkSync(child);
  }
  rmdirSync(target);
}

function validateAndChownTree(target: string, uid: number, gid: number, dependencyTree = false): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    lchownSync(target, uid, gid);
    return;
  }
  if (stat.isFile() && stat.nlink > 1 && !dependencyTree) {
    throw new Error(`executor containment rejects hard-linked file: ${target}`);
  }
  if (stat.isDirectory()) {
    const dependencies = dependencyTree || basename(target) === 'node_modules';
    if (dependencies) return;
    for (const entry of readdirSync(target)) validateAndChownTree(join(target, entry), uid, gid, dependencies);
  }
  chownSync(target, uid, gid);
}

function directoryArgs(target: string): string[] {
  const dirs: string[] = [];
  let current = dirname(target);
  while (current !== '/') {
    dirs.unshift(current);
    current = dirname(current);
  }
  return dirs.flatMap((dir) => ['--dir', dir]);
}

function positiveId(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${field} must be an integer between 1 and 65535`);
  }
  return parsed;
}

function assignedWorktree(containmentRoot: string, workdir: string): string {
  const root = realpathSync(containmentRoot);
  if (basename(root) !== FACTORY_ROOT_NAME) {
    throw new Error(`executor containment root must end with ${FACTORY_ROOT_NAME}`);
  }
  const cwd = realpathSync(workdir);
  if (!isStrictDescendant(root, cwd)) {
    throw new Error(`executor workdir must be inside ${root}`);
  }
  const first = relative(root, cwd).split(sep)[0];
  const assigned = realpathSync(join(root, first));
  if (!isStrictDescendant(root, assigned)) {
    throw new Error('executor assigned worktree escaped the containment root');
  }
  return assigned;
}

function assignedGitBinds(assigned: string, env: Record<string, string>): string[] {
  const profile = loadFactoryPathProfile(env);
  const pointer = join(assigned, '.git');
  if (!existsSync(pointer)) {
    if (profile) throw new Error('profiled executor requires a registered Git worktree');
    return [];
  }
  if (!lstatSync(pointer).isFile() || lstatSync(pointer).isSymbolicLink()) throw new Error('executor requires a linked Git worktree');
  const match = /^gitdir: (.+)\n?$/.exec(readFileSync(pointer, 'utf8'));
  if (!match) throw new Error('invalid worktree gitdir');
  const gitdir = canonicalFactoryPath(match[1]);
  const common = canonicalFactoryPath(resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()));
  if (dirname(dirname(gitdir)) !== common || basename(dirname(gitdir)) !== 'worktrees' || basename(common) !== '.git') throw new Error('forged Git common directory');
  if (readFileSync(join(gitdir, 'gitdir'), 'utf8').trim() !== pointer) throw new Error('Git registration does not identify assigned worktree');
  if (profile) {
    const records = readFileSync(join(profile.worktrees_root, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const record = records.filter(item => item.worktreePath === assigned).at(-1);
    if (!record || record.status !== 'active' || !insideFactoryPath(profile.source_root, canonicalFactoryPath(record.repoPath))) throw new Error('assigned repository has no active ledger authority');
    const result = spawnSync('git', ['-C', record.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0 || realpathSync(result.stdout.trim()) !== common) throw new Error('assigned repository Git metadata mismatch');
  } else if (!insideFactoryPath('/home/workspace', common) && !insideFactoryPath(dirname(realpathSync(env.SWARM_EXEC_CONTAINMENT_ROOT)), common)) {
    throw new Error('Git metadata outside authorized source root');
  }
  if (existsSync(join(common, 'objects', 'info', 'alternates'))) throw new Error('external Git object alternates are unsupported');
  const args = [...directoryArgs(common), '--dir', common, '--dir', join(common, 'worktrees')];
  for (const name of ['HEAD', 'config', 'objects', 'refs', 'packed-refs', 'shallow']) {
    const source = join(common, name);
    if (existsSync(source)) {
      canonicalFactoryPath(source);
      args.push('--ro-bind', source, source);
    }
  }
  args.push('--ro-bind', gitdir, gitdir, '--ro-bind', pointer, pointer);
  return args;
}

export function prepareFilesystemContainedSpawn(
  spawnSpec: AdapterSpawnSpec,
  workdir: string,
  env: Record<string, string>,
): AdapterSpawnSpec {
  if (env.SWARM_EXEC_CONTAINMENT_REQUIRED !== '1') {
    return { command: spawnSpec.command, args: [...spawnSpec.args] };
  }
  const uid = positiveId(env.SWARM_EXEC_CONTAINMENT_UID, 'SWARM_EXEC_CONTAINMENT_UID');
  const gid = positiveId(env.SWARM_EXEC_CONTAINMENT_GID, 'SWARM_EXEC_CONTAINMENT_GID');
  const configuredRoot = env.SWARM_EXEC_CONTAINMENT_ROOT;
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error('SWARM_EXEC_CONTAINMENT_ROOT must be an absolute path');
  }
  const profile = loadFactoryPathProfile(env);
  if (!profile && insideFactoryPath('/home/.z/factory', resolve(configuredRoot))) throw new Error('external containment requires a pinned Factory profile');
  const assigned = assignedWorktree(configuredRoot, workdir);
  if (profile && realpathSync(configuredRoot) !== profile.worktrees_root) throw new Error('containment root diverges from profile');
  const gitArgs = assignedGitBinds(assigned, env);
  if (!existsSync(BWRAP) || !existsSync(SETPRIV)) {
    throw new Error('required executor containment binaries are unavailable');
  }
  validateAndChownTree(assigned, uid, gid);

  const ipcHostRoot = `${IPC_HOST_PREFIX}${randomUUID()}`;
  mkdirSync(ipcHostRoot, { mode: 0o700 });
  chownSync(ipcHostRoot, uid, gid);
  const ipcGuestRoot = '/sandbox-ipc';
  const passFds: number[] = [];
  const credentialArgs: string[] = [];
  const executorId = env.SWARM_EXECUTOR_ID;
  const credential = executorId === 'claude-code'
    ? {
        source: '/root/.claude/.credentials.json',
        destination: '/sandbox-home/.claude/.credentials.json',
        parent: '/sandbox-home/.claude',
      }
    : executorId === 'codex'
      ? {
          source: '/root/.codex/auth.json',
          destination: '/sandbox-home/.codex/auth.json',
          parent: '/sandbox-home/.codex',
        }
      : undefined;
  if (credential) {
    const credentialPath = credential.source;
    if (!existsSync(credentialPath)) {
      removeTree(ipcHostRoot);
      throw new Error(`${executorId} containment credential source is unavailable`);
    }
    const credentialFd = openSync(credentialPath, 'r');
    passFds.push(credentialFd);
    credentialArgs.push(
      '--dir', credential.parent,
      '--perms', '0400',
      '--ro-bind-data', String(3 + passFds.length - 1), credential.destination,
    );
  }

  const optionalToolBinds: string[] = [];
  const toolFiles = [
    ['/root/.bun/bin/bun', '/sandbox-bin/bun'],
    ['/root/.local/share/claude/versions/2.1.240', '/sandbox-bin/claude'],
  ] as const;
  for (const [source, destination] of toolFiles) {
    if (existsSync(source)) optionalToolBinds.push('--ro-bind', source, destination);
  }
  const bridgeRuntimeRoot = '/home/workspace/Skills/zo-swarm-executors';
  const bridgeRuntimeArgs = spawnSpec.command === 'bash' && existsSync(bridgeRuntimeRoot)
    ? [...directoryArgs(bridgeRuntimeRoot), '--ro-bind', bridgeRuntimeRoot, bridgeRuntimeRoot]
    : [];
  const tierResolver = '/home/workspace/Skills/zo-swarm-orchestrator/scripts/tier-resolve.ts';
  const tierResolverArgs = spawnSpec.command === 'bash' && existsSync(tierResolver)
    ? [...directoryArgs(tierResolver), '--ro-bind', tierResolver, tierResolver]
    : [];
  const factoryCodexRequirements = '/etc/codex/factory-requirements.toml';
  const factoryCodexRequirementsArgs = executorId === 'codex' && existsSync(factoryCodexRequirements)
    ? ['--ro-bind', factoryCodexRequirements, '/etc/codex/requirements.toml']
    : [];

  const args = [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--clear-groups',
    BWRAP,
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--uid', '0',
    '--gid', '0',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--ro-bind', '/usr', '/usr',
    '--dir', '/etc',
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--ro-bind', '/etc/passwd', '/etc/passwd',
    '--ro-bind', '/etc/group', '/etc/group',
    '--ro-bind', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    ...factoryCodexRequirementsArgs,
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--dir', '/sandbox-home',
    '--dir', '/sandbox-home/.codex',
    '--dir', '/sandbox-home/.config',
    '--dir', '/sandbox-bin',
    ...directoryArgs(assigned),
    '--bind', assigned, assigned,
    ...gitArgs,
    ...bridgeRuntimeArgs,
    ...tierResolverArgs,
    '--bind', ipcHostRoot, ipcGuestRoot,
    ...optionalToolBinds,
    ...credentialArgs,
    '--chdir', realpathSync(workdir),
    '--setenv', 'HOME', '/sandbox-home',
    '--setenv', 'CODEX_HOME', '/sandbox-home/.codex',
    '--setenv', 'CLAUDE_CONFIG_DIR', '/sandbox-home/.claude',
    '--setenv', 'XDG_CONFIG_HOME', '/sandbox-home/.config',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'USER', 'zouroboros-agent',
    '--setenv', 'LOGNAME', 'zouroboros-agent',
    '--setenv', 'GIT_CONFIG_COUNT', '1',
    '--setenv', 'GIT_CONFIG_KEY_0', 'safe.directory',
    '--setenv', 'GIT_CONFIG_VALUE_0', assigned,
    '--setenv', 'GIT_OPTIONAL_LOCKS', '0',
    '--setenv', 'PATH', '/sandbox-bin:/usr/local/bin:/usr/bin:/bin',
    '--',
    spawnSpec.command,
    ...spawnSpec.args,
  ];

  return {
    command: SETPRIV,
    args,
    passFds,
    ipcHostRoot,
    ipcGuestRoot,
    closeAfterSpawn: () => {
      for (const fd of passFds) closeSync(fd);
    },
    cleanupAfterExit: () => removeTree(ipcHostRoot),
  };
}
