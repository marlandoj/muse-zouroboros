/**
 * Deploy-root freshness (conveyor code drift).
 *
 * The conveyor runs from a rotating git worktree under
 * `.runtime/factory-conveyor-state-boundary-*`, and the `[SYS] Factory Conveyor`
 * automation binds that root by PATH, not by commit. Nothing advances the root
 * when canonical main moves, so a root silently keeps executing older code.
 *
 * That is not hypothetical: on 2026-09-01/02 the root sat four commits behind
 * main and failed the smoke gate on `factory-diversity-review.test.ts` for a
 * defect main had already fixed in #640. Two cycles aborted before the Linear
 * pull chasing a bug that no longer existed.
 *
 * This reports drift instead of hiding it. Two independent signals:
 *   1. HEAD vs canonical main, read with `git ls-remote` (read-only — it never
 *      mutates refs, unlike `git fetch`, so the smoke stays side-effect-free).
 *   2. HEAD vs the short sha embedded in the root's own directory name, which
 *      goes stale the moment the root is advanced in place.
 *
 * ADVISORY by default: drift is reported and the smoke still passes, because a
 * hard gate here would halt the conveyor on every merge to main. Set
 * FACTORY_ROOT_DRIFT_ENFORCE=1 to make drift abort the cycle, or
 * FACTORY_ROOT_DRIFT_CHECK=0 to skip entirely. Network or git failures are
 * always advisory — an unreachable remote must never turn a healthy cycle red.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const DEPLOY_ROOT_PREFIX = "factory-conveyor-state-boundary-";
export const LS_REMOTE_TIMEOUT_MS = 15_000;

export interface FreshnessResult {
  /** False only when drift was found AND enforcement is enabled. */
  ok: boolean;
  /** False when this is not a conveyor deploy root — the check is skipped. */
  applicable: boolean;
  root: string | null;
  head: string | null;
  /** Short sha embedded in the deploy-root directory name, when present. */
  pinnedSha: string | null;
  /** null when the directory name carries no sha to compare against. */
  nameMatchesHead: boolean | null;
  remote: string | null;
  upstream: string | null;
  /** Commits on canonical main that HEAD does not have; null when unresolved. */
  behind: number | null;
  /** Commits on HEAD that canonical main does not have; null when unresolved. */
  ahead: number | null;
  /**
   * A sibling deploy root already materialized at canonical main. Roots are cut
   * as main advances, but the automation binds ROOT by path — so the usual fix
   * for drift is rebinding to an existing root, not cutting a new one.
   */
  replacementRoot: string | null;
  enforced: boolean;
  detail: string;
}

export interface RemoteEntry {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * A push URL that is a real transport target, not a neutered placeholder.
 * Accepts scheme URLs, scp-style `user@host:path`, and local filesystem paths
 * (git clones from a path, and the tests exercise that shape). The deploy root's
 * `DISABLED-meta-repo-…` push value matches none of them, which is the point.
 */
export function isRealRemoteUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^[^\s/]+@[^\s:]+:/.test(value)) return true;
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

export function parseRemotes(output: string): RemoteEntry[] {
  const byName = new Map<string, RemoteEntry>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const entry = byName.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
    byName.set(name, entry);
  }
  return [...byName.values()];
}

/**
 * Pick the canonical remote. A deploy root's `origin` intentionally points at a
 * meta-repository whose push URL is neutered, so "origin" is the wrong answer
 * here — prefer a remote that can actually be pushed, then the repository named
 * by the environment, and only then fall back to declaration order.
 */
export function selectCanonicalRemote(
  remotes: RemoteEntry[],
  repository?: string,
): RemoteEntry | null {
  const pushable = remotes.filter((entry) => isRealRemoteUrl(entry.pushUrl));
  const pool = pushable.length ? pushable : remotes.filter((entry) => isRealRemoteUrl(entry.fetchUrl));
  if (!pool.length) return null;
  const slug = repository?.trim().toLowerCase();
  if (slug) {
    const named = pool.find((entry) => entry.fetchUrl.toLowerCase().includes(slug));
    if (named) return named;
  }
  return pool[0];
}

/**
 * Extract the short sha a deploy-root directory name pins, tolerating both
 * observed shapes: `<prefix>main-<sha>-<date>` and `<prefix><sha>-<label>`.
 * The trailing `YYYYMMDD` stamp is itself valid hex, so date-shaped segments are
 * excluded rather than relying on a sha containing a letter.
 */
export function parsePinnedSha(root: string): string | null {
  const name = basename(root);
  if (!name.startsWith(DEPLOY_ROOT_PREFIX)) return null;
  for (const segment of name.slice(DEPLOY_ROOT_PREFIX.length).split("-")) {
    if (!/^[0-9a-f]{7,40}$/.test(segment)) continue;
    if (/^(19|20)\d{6}$/.test(segment)) continue;
    return segment;
  }
  return null;
}

export function isDeployRoot(root: string): boolean {
  return basename(root).startsWith(DEPLOY_ROOT_PREFIX);
}

export function describeFreshness(
  input: Pick<
    FreshnessResult,
    | "head"
    | "pinnedSha"
    | "nameMatchesHead"
    | "remote"
    | "upstream"
    | "behind"
    | "ahead"
    | "replacementRoot"
  >,
): string {
  const parts: string[] = [];
  const head = input.head ? input.head.slice(0, 8) : "unknown";
  const remote = `${input.remote ?? "canonical"}/main`;
  if (!input.upstream) {
    parts.push(`HEAD ${head}; canonical main unresolved (remote read failed) — drift unverified`);
  } else if (input.head === input.upstream) {
    parts.push(`HEAD ${head} matches ${remote}`);
  } else {
    const target = `${remote} ${input.upstream.slice(0, 8)}`;
    const behind = input.behind === null ? "an unknown number of" : `${input.behind}`;
    // A root can also carry commits main has not merged — reporting that as
    // "0 commits behind" would read as healthy when it is unreviewed code.
    if (input.behind === 0 && input.ahead !== null && input.ahead > 0) {
      parts.push(`HEAD ${head} is ${input.ahead} unmerged commit(s) ahead of ${target}`);
    } else if (input.ahead !== null && input.ahead > 0) {
      parts.push(`HEAD ${head} has diverged from ${target} (${behind} behind, ${input.ahead} ahead)`);
    } else {
      parts.push(`HEAD ${head} is ${behind} commit(s) behind ${target}`);
    }
  }
  if (input.nameMatchesHead === false) {
    parts.push(`directory name still pins ${input.pinnedSha}`);
  }
  if (input.replacementRoot) {
    parts.push(`a root at canonical main already exists — rebind the conveyor ROOT to ${input.replacementRoot}`);
  }
  return parts.join("; ");
}

/**
 * Find a sibling deploy root already sitting at canonical main. Matching is by
 * the sha in the directory name, so this costs one readdir and no git calls.
 */
export function findReplacementRoot(
  root: string,
  upstream: string | null,
  listDir: (dir: string) => string[] = (dir) => readdirSync(dir),
): string | null {
  if (!upstream) return null;
  const parent = dirname(root);
  const self = basename(root);
  let best: { name: string; pinned: string } | null = null;
  let entries: string[];
  try {
    entries = listDir(parent);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name === self || !name.startsWith(DEPLOY_ROOT_PREFIX)) continue;
    const pinned = parsePinnedSha(name);
    if (!pinned || !upstream.startsWith(pinned)) continue;
    if (!best || pinned.length > best.pinned.length) best = { name, pinned };
  }
  return best ? join(parent, best.name) : null;
}

function git(args: string[], cwd: string, timeout = 10_000): { code: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

export function checkDeployRootFreshness(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): FreshnessResult {
  const skipped: FreshnessResult = {
    ok: true,
    applicable: false,
    root: null,
    head: null,
    pinnedSha: null,
    nameMatchesHead: null,
    remote: null,
    upstream: null,
    behind: null,
    ahead: null,
    replacementRoot: null,
    enforced: false,
    detail: "not a conveyor deploy root — freshness check skipped",
  };
  if (env.FACTORY_ROOT_DRIFT_CHECK === "0") {
    return { ...skipped, detail: "freshness check disabled via FACTORY_ROOT_DRIFT_CHECK=0" };
  }
  if (!isDeployRoot(root)) return skipped;

  const enforced = env.FACTORY_ROOT_DRIFT_ENFORCE === "1";
  const head = git(["rev-parse", "HEAD"], root);
  if (head.code !== 0 || !head.out) {
    return { ...skipped, applicable: true, root, enforced, detail: "unable to resolve deploy-root HEAD — drift unverified" };
  }
  const pinnedSha = parsePinnedSha(root);
  const nameMatchesHead = pinnedSha === null ? null : head.out.startsWith(pinnedSha);

  const remotes = parseRemotes(git(["remote", "-v"], root).out);
  const canonical = selectCanonicalRemote(remotes, env.FACTORY_CANONICAL_REPOSITORY ?? env.GITHUB_REPOSITORY);
  let upstream: string | null = null;
  if (canonical) {
    const ls = git(["ls-remote", canonical.name, "refs/heads/main"], root, LS_REMOTE_TIMEOUT_MS);
    const sha = ls.code === 0 ? ls.out.split(/\s+/)[0] : "";
    if (/^[0-9a-f]{40}$/.test(sha)) upstream = sha;
  }

  let behind: number | null = null;
  let ahead: number | null = null;
  if (upstream && upstream !== head.out) {
    const counts = git(["rev-list", "--left-right", "--count", `${head.out}...${upstream}`], root);
    const [aheadRaw, behindRaw] = counts.out.split(/\s+/);
    if (counts.code === 0 && /^\d+$/.test(aheadRaw ?? "") && /^\d+$/.test(behindRaw ?? "")) {
      ahead = Number(aheadRaw);
      behind = Number(behindRaw);
    }
  } else if (upstream) {
    behind = 0;
    ahead = 0;
  }

  const drifted = upstream !== null && upstream !== head.out;
  const partial = {
    head: head.out,
    pinnedSha,
    nameMatchesHead,
    remote: canonical?.name ?? null,
    upstream,
    behind,
    ahead,
    replacementRoot: upstream === head.out ? null : findReplacementRoot(root, upstream),
  };
  return {
    ...partial,
    ok: !(drifted && enforced),
    applicable: true,
    root,
    enforced,
    detail: describeFreshness(partial),
  };
}
