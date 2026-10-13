/**
 * Host locations resolved at call time from env/XDG instead of hard-coded
 * host paths (ported from hermes-zouroboros `packages/swarm/src/host-roots.ts`).
 *
 *   workspace  ZOUROBOROS_WORKSPACE / ZO_WORKSPACE, else the current directory
 *   state      ZOUROBOROS_STATE_DIR / ZO_STATE_DIR, else $XDG_STATE_HOME/zouroboros
 *              (else ~/.local/state/zouroboros)
 *   logs       ZOUROBOROS_LOG_DIR / ZO_LOG_DIR, else <state>/logs
 *   runtime    ZOUROBOROS_RUNTIME_DIR / ZO_RUNTIME_DIR, else $XDG_RUNTIME_DIR/zouroboros,
 *              else <state>/runtime
 *
 * A host that keeps the old layout sets ZOUROBOROS_WORKSPACE (and
 * ZOUROBOROS_STATE_DIR=/var/lib/zouroboros) and gets the previous paths back.
 *
 * NOTE: this file is intentionally self-contained. The upstream version
 * imports `resolveRuntimeDirectories` from `zouroboros-core`, which is not
 * vendored in this distribution, so the (small) resolution logic needed here
 * is inlined below with identical precedence semantics.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

type Env = Record<string, string | undefined>;

function expandHome(path: string, homeDir: string): string {
  if (path === '~') return homeDir;
  if (path.startsWith('~/')) return join(homeDir, path.slice(2));
  return path;
}

function absolutePath(raw: string | undefined, homeDir: string): string | undefined {
  if (!raw) return undefined;
  const expanded = expandHome(raw.trim(), homeDir);
  if (!expanded || !isAbsolute(expanded)) return undefined;
  return resolve(expanded);
}

interface HostRoots {
  workspace: string;
  state: string;
  logs: string;
  runtime: string;
}

/** Minimal, self-contained equivalent of zouroboros-core's resolveRuntimeDirectories. */
function resolveRoots(env: Env = process.env): HostRoots {
  const homeDir = env.HOME ?? homedir();
  const state =
    absolutePath(env.ZOUROBOROS_STATE_DIR, homeDir) ??
    absolutePath(env.ZO_STATE_DIR, homeDir) ??
    absolutePath(
      join(env.XDG_STATE_HOME ?? join(homeDir, '.local', 'state'), 'zouroboros'),
      homeDir,
    )!;
  const logs =
    absolutePath(env.ZOUROBOROS_LOG_DIR, homeDir) ??
    absolutePath(env.ZO_LOG_DIR, homeDir) ??
    join(state, 'logs');
  const runtime =
    absolutePath(env.ZOUROBOROS_RUNTIME_DIR, homeDir) ??
    absolutePath(env.ZO_RUNTIME_DIR, homeDir) ??
    (env.XDG_RUNTIME_DIR
      ? absolutePath(join(env.XDG_RUNTIME_DIR, 'zouroboros'), homeDir)!
      : join(state, 'runtime'));
  const workspace =
    absolutePath(env.ZOUROBOROS_WORKSPACE, homeDir) ??
    absolutePath(env.ZO_WORKSPACE, homeDir) ??
    resolve(process.cwd());
  return { workspace, state, logs, runtime };
}

export const workspaceRoot = (env: Env = process.env): string => resolveRoots(env).workspace;
export const stateRoot = (env: Env = process.env): string => resolveRoots(env).state;
export const logRoot = (env: Env = process.env): string => resolveRoots(env).logs;
export const runtimeRoot = (env: Env = process.env): string => resolveRoots(env).runtime;

/**
 * Software Factory namespaces. The source tree is FACTORY_SOURCE_ROOT, else the workspace; the
 * external namespace (worktrees and pinned releases) is FACTORY_EXTERNAL_ROOT, else <state>/factory.
 */
export function factoryRoots(env: Env = process.env) {
  const source = env.FACTORY_SOURCE_ROOT || workspaceRoot(env);
  const external = env.FACTORY_EXTERNAL_ROOT || join(stateRoot(env), 'factory');
  return {
    source,
    legacyWorktrees: join(source, '.factory-worktrees'),
    external,
    externalWorktrees: join(external, '.factory-worktrees'),
    externalReleases: join(external, 'releases'),
  };
}

/** Model-routing catalogs published by the model router. */
export function modelRoutingDir(env: Env = process.env): string {
  return join(stateRoot(env), 'model-routing');
}
