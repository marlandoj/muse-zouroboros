import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

const WORKSPACE_ROOT = "/home/workspace";

// The root that owns execution-repository clone/worktree placement. Cascade
// containment guards must anchor to this same root (ZOU-1570): coding-cascade's
// script-derived default resolves to the conveyor release root under
// /home/workspace/.runtime, which never contains these clones.
export function executionWorkspaceRoot(): string {
  return process.env.ZOUROBOROS_WORKSPACE ?? WORKSPACE_ROOT;
}

export interface ExecutionRepositoryOptions {
  fallback?: string;
  workspaceRoot?: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  run?: (command: string, args: string[]) => ProcessResult;
}

interface ProcessResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

interface GitHubRepository {
  owner: string;
  repo: string;
}

function requireInsideWorkspace(path: string, workspaceRoot: string): string {
  const child = relative(workspaceRoot, path);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`target repository is outside the workspace root: ${path}`);
  }
  return path;
}

function defaultRun(command: string, args: string[]): ProcessResult {
  const result = spawnSync(command, args, {
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function parseGitHubRepository(value: string): GitHubRepository | null {
  const rawUrl = value.match(/https:\/\/github\.com\/[^\s<>()\[\]`]+/i)?.[0];
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  const validPart = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repo || !validPart.test(owner) || !validPart.test(repo)) return null;
  return { owner, repo };
}

function parseGitHubRemote(value: string): GitHubRepository | null {
  const https = parseGitHubRepository(value);
  if (https) return https;
  const ssh = value.trim().match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return ssh ? { owner: ssh[1], repo: ssh[2] } : null;
}

function sameGitHubRepository(left: GitHubRepository, right: GitHubRepository): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}

function commandError(result: ProcessResult): string {
  return result.error?.message || result.stderr?.trim() || `exit ${result.status ?? "unknown"}`;
}

function matchingLocalCheckout(
  repository: GitHubRepository,
  candidates: string[],
  workspaceRoot: string,
  exists: (path: string) => boolean,
  canonicalize: (path: string) => string,
  run: (command: string, args: string[]) => ProcessResult,
): string | null {
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const canonical = requireInsideWorkspace(canonicalize(candidate), workspaceRoot);
    const remote = run("git", ["-C", canonical, "remote", "get-url", "origin"]);
    const identity = remote.status === 0 ? parseGitHubRemote(remote.stdout ?? "") : null;
    if (identity && sameGitHubRepository(identity, repository)) return canonical;
  }
  return null;
}

function resolveGitHubRepository(
  repository: GitHubRepository,
  workspaceRoot: string,
  exists: (path: string) => boolean,
  canonicalize: (path: string) => string,
  run: (command: string, args: string[]) => ProcessResult,
): string {
  const candidates = [
    join(workspaceRoot, "Projects", repository.repo),
    join(workspaceRoot, "Sites", repository.repo),
    join(workspaceRoot, repository.repo),
  ];
  const local = matchingLocalCheckout(repository, candidates, workspaceRoot, exists, canonicalize, run);
  if (local) return local;

  const cloneParentPath = join(workspaceRoot, "Projects");
  if (!exists(cloneParentPath)) {
    throw new Error(`repository clone parent does not exist: ${cloneParentPath}`);
  }
  const cloneParent = requireInsideWorkspace(canonicalize(cloneParentPath), workspaceRoot);
  const cloneTarget = join(cloneParent, repository.repo);
  if (exists(cloneTarget)) {
    throw new Error(`refusing to overwrite non-matching repository checkout: ${cloneTarget}`);
  }

  const qualified = `${repository.owner}/${repository.repo}`;
  const access = run("gh", ["api", `repos/${qualified}`, "--silent"]);
  if (access.status !== 0) {
    throw new Error(`GitHub repository is missing or inaccessible (${qualified}): ${commandError(access)}`);
  }

  const clone = run("gh", ["repo", "clone", qualified, cloneTarget]);
  if (clone.status !== 0) {
    throw new Error(`failed to clone GitHub repository ${qualified}: ${commandError(clone)}`);
  }
  if (!exists(cloneTarget)) {
    throw new Error(`GitHub clone reported success but checkout is missing: ${cloneTarget}`);
  }
  return requireInsideWorkspace(canonicalize(cloneTarget), workspaceRoot);
}

export function resolveExecutionRepository(
  targetRepo: string | undefined,
  options: ExecutionRepositoryOptions = {},
): string {
  const exists = options.exists ?? existsSync;
  const canonicalize = options.realpath ?? realpathSync;
  const run = options.run ?? defaultRun;
  const workspaceRoot = canonicalize(options.workspaceRoot ?? WORKSPACE_ROOT);
  const fallback = canonicalize(options.fallback ?? WORKSPACE_ROOT);
  requireInsideWorkspace(fallback, workspaceRoot);

  const target = targetRepo?.trim();
  if (!target) return fallback;

  const githubRepository = parseGitHubRepository(target);
  if (githubRepository) {
    return resolveGitHubRepository(githubRepository, workspaceRoot, exists, canonicalize, run);
  }
  if (/github\.com/i.test(target)) {
    throw new Error(`unable to parse GitHub repository URL: ${target}`);
  }

  const explicitPath = target.match(/`(\/[^`\r\n]+)`/)?.[1];
  const leadingPath = target.match(/^`?([A-Za-z0-9._/-]+)`?/)?.[1];
  const repoRef = explicitPath ?? leadingPath;
  if (!repoRef) throw new Error(`unable to parse target repository: ${target}`);

  const candidates = isAbsolute(repoRef)
    ? [repoRef]
    : [
        join(workspaceRoot, "Projects", repoRef),
        join(workspaceRoot, "Sites", repoRef),
        join(workspaceRoot, repoRef),
      ];
  const matched = candidates.find(exists);
  if (!matched) throw new Error(`target repository does not exist: ${repoRef}`);

  return requireInsideWorkspace(canonicalize(matched), workspaceRoot);
}

// ---------------------------------------------------------------------------
// ZOU-890 — isolated per-ticket worktree for clean-room conveyor builds.
//
// resolveExecutionRepository returns an EXISTING checkout (e.g. the primary
// /home/workspace/zouroboros, which drifts and can be dirty). Building there
// risks contaminating the build against uncommitted primary state. These
// helpers create a fresh git worktree off a clean base (origin/main) per
// ticket, tracked in an append-only JSONL ledger so the production reaper or
// an explicit bulk reclaim can tear them down. Gated at the call site by SF_EXEC_ISOLATED_WORKTREE
// (default-off => resolveExecutionRepository is used unchanged).
// ---------------------------------------------------------------------------

const WORKTREES_DIRNAME = ".factory-worktrees";
import { canonicalFactoryPath, factoryWorktreesRoot, factoryWorktreeReadRoots, insideFactoryPath, loadFactoryPathProfile } from "../../../packages/swarm/src/transport/factory-path-profile";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

export interface WorktreeLedgerRecord {
  ts: string;
  repoPath: string;
  ticketId: string;
  worktreePath: string;
  baseRef: string;
  baseCommit?: string;
  status: "active" | "reclaimed";
}

export interface IsolatedWorktreeOptions {
  workspaceRoot?: string;
  /** Parent dir for worktrees + ledger; defaults to <workspaceRoot>/.factory-worktrees. */
  worktreesRoot?: string;
  /** Clean base ref to build off; defaults to origin/main. */
  baseRef?: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  run?: (command: string, args: string[]) => ProcessResult;
  now?: () => string;
}

function sanitizeTicketId(ticketId: string): string {
  return ticketId.trim().replace(/[^A-Za-z0-9_-]/g, "_") || "ticket";
}

function worktreesRootFor(options: IsolatedWorktreeOptions): string {
  const canonicalize = options.realpath ?? realpathSync;
  return factoryWorktreesRoot(options.worktreesRoot, join(canonicalize(options.workspaceRoot ?? WORKSPACE_ROOT), WORKTREES_DIRNAME));
}

/** PURE: deterministic worktree path + base ref for a repo+ticket (no I/O). */
export function planIsolatedWorktree(
  repoPath: string,
  ticketId: string,
  options: IsolatedWorktreeOptions = {},
): { worktreePath: string; baseRef: string } {
  const baseRef = options.baseRef ?? "origin/main";
  const worktreePath = join(worktreesRootFor(options), `${basename(repoPath)}-${sanitizeTicketId(ticketId)}`);
  return { worktreePath, baseRef };
}

function worktreeLedgerPath(options: IsolatedWorktreeOptions): string {
  return join(worktreesRootFor(options), "ledger.jsonl");
}

/** Append one ledger record (JSONL); creates the parent dir if needed. */
export function appendWorktreeLedger(record: WorktreeLedgerRecord, options: IsolatedWorktreeOptions = {}): void {
  const path = worktreeLedgerPath(options);
  if (loadFactoryPathProfile()) canonicalFactoryPath(path);
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

/** Read all ledger records, skipping malformed lines. */
export function readWorktreeLedger(options: IsolatedWorktreeOptions = {}): WorktreeLedgerRecord[] {
  const exists = options.exists ?? existsSync;
  const records: WorktreeLedgerRecord[] = [];
  const paths = loadFactoryPathProfile() && !options.worktreesRoot
    ? factoryWorktreeReadRoots().reverse().map(root => join(root, "ledger.jsonl"))
    : [worktreeLedgerPath(options)];
  for (const path of paths) {
    if (!exists(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as WorktreeLedgerRecord);
      } catch {
        continue;
      }
    }
  }
  return records;
}

/** Fold the ledger to the latest status per worktree path, keeping only active ones. */
export function activeWorktreeRecords(options: IsolatedWorktreeOptions = {}): WorktreeLedgerRecord[] {
  const latest = new Map<string, WorktreeLedgerRecord>();
  for (const rec of readWorktreeLedger(options)) {
    if (!rec || !rec.worktreePath) continue;
    latest.set(rec.worktreePath, rec);
  }
  return [...latest.values()].filter((rec) => rec.status === "active");
}

export interface WorktreeExecutionIdentity {
  ticketIds: string[];
  worktreePath?: string;
}

export interface ReclaimIsolatedWorktreeOptions extends IsolatedWorktreeOptions {
  allowDirtyWithRecoveryManifest?: string;
}

function matchingActiveWorktreeRecords(
  identity: WorktreeExecutionIdentity,
  options: IsolatedWorktreeOptions,
): WorktreeLedgerRecord[] {
  const ticketIds = new Set(identity.ticketIds.map((value) => value.trim()).filter(Boolean));
  if (ticketIds.size === 0) throw new Error("isolated worktree lookup requires a ticket identity");
  return activeWorktreeRecords(options).filter((record) => {
    if (!ticketIds.has(record.ticketId)) return false;
    return !identity.worktreePath || record.worktreePath === identity.worktreePath;
  });
}

export function activeWorktreeForExecution(
  identity: WorktreeExecutionIdentity,
  options: IsolatedWorktreeOptions = {},
): WorktreeLedgerRecord | null {
  const matches = matchingActiveWorktreeRecords(identity, options);
  if (matches.length > 1) {
    throw new Error(`ambiguous isolated worktree ownership for ${identity.ticketIds.join(",")}`);
  }
  return matches[0] ?? null;
}

/**
 * Create (or reuse) an isolated worktree off a clean base for a ticket.
 * IDEMPOTENT: if the worktree path already exists it is reused, so repeated
 * calls for the same ticket create exactly one worktree. FAIL-CLOSED: any git
 * failure throws — isolation NEVER silently falls back to the dirty primary.
 */
export function createIsolatedWorktree(
  repoPath: string,
  ticketId: string,
  options: IsolatedWorktreeOptions = {},
): string {
  const exists = options.exists ?? existsSync;
  const run = options.run ?? defaultRun;
  const now = options.now ?? (() => new Date().toISOString());
  const canonicalize = options.realpath ?? realpathSync;
  const workspaceRoot = canonicalize(options.workspaceRoot ?? WORKSPACE_ROOT);

  const { worktreePath, baseRef } = planIsolatedWorktree(repoPath, ticketId, options);
  const profile = loadFactoryPathProfile();
  if (profile) {
    requireInsideWorkspace(canonicalize(repoPath), profile.source_root);
    canonicalFactoryPath(worktreePath);
  }
  requireInsideWorkspace(worktreePath, profile?.worktrees_root ?? workspaceRoot);

  if (exists(worktreePath)) {
    const owned = activeWorktreeForExecution({ ticketIds: [ticketId], worktreePath }, options);
    if (!owned || owned.repoPath !== repoPath) {
      throw new Error(`existing isolated worktree has ambiguous repository ownership: ${worktreePath}`);
    }
    if (!owned.baseCommit || !FULL_COMMIT_SHA.test(owned.baseCommit)) {
      throw new Error(`existing isolated worktree is missing a verified base commit: ${worktreePath}`);
    }
    const basePresent = run("git", ["-C", repoPath, "cat-file", "-e", `${owned.baseCommit}^{commit}`]);
    if (basePresent.status !== 0) {
      throw new Error(`existing isolated worktree base commit is unavailable: ${owned.baseCommit}`);
    }
    return worktreePath;
  }

  const fetch = run("git", ["-C", repoPath, "fetch", "origin", baseRef.replace(/^origin\//, "")]);
  if (fetch.status !== 0) {
    throw new Error(`failed to fetch base ${baseRef} for isolated worktree: ${commandError(fetch)}`);
  }
  const resolveBase = run("git", ["-C", repoPath, "rev-parse", `${baseRef}^{commit}`]);
  const baseCommit = resolveBase.status === 0 ? resolveBase.stdout?.trim() ?? "" : "";
  if (!FULL_COMMIT_SHA.test(baseCommit)) {
    throw new Error(`failed to resolve a full base commit for isolated worktree: ${baseRef}`);
  }
  const add = run("git", ["-C", repoPath, "worktree", "add", "--detach", worktreePath, baseCommit]);
  if (add.status !== 0) {
    throw new Error(`failed to create isolated worktree at ${worktreePath}: ${commandError(add)}`);
  }
  appendWorktreeLedger({ ts: now(), repoPath, ticketId, worktreePath, baseRef, baseCommit, status: "active" }, options);
  return worktreePath;
}

export function reclaimIsolatedWorktree(
  identity: WorktreeExecutionIdentity,
  options: ReclaimIsolatedWorktreeOptions = {},
): { status: "absent" | "reclaimed"; worktreePath: string | null } {
  const record = activeWorktreeForExecution(identity, options);
  if (!record) return { status: "absent", worktreePath: null };
  const profile = loadFactoryPathProfile();
  if (profile && !insideFactoryPath(profile.worktrees_root, record.worktreePath)) throw new Error('legacy worktree requires its original owner and retirement review');

  const run = options.run ?? defaultRun;
  const exists = options.exists ?? existsSync;
  const now = options.now ?? (() => new Date().toISOString());
  const status = run("git", ["-C", record.worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]);
  const gone = /not a git repository|not a working tree|is not a working tree|no such|cannot find|does not exist/i.test(commandError(status));
  if (status.status !== 0 && !gone) {
    throw new Error(`isolated worktree status failed: ${commandError(status)}`);
  }
  const dirty = status.status === 0 && Boolean(status.stdout?.trim());
  if (dirty && !options.allowDirtyWithRecoveryManifest) {
    throw new Error(`refusing to reclaim dirty isolated worktree without recovery evidence: ${record.worktreePath}`);
  }
  if (dirty && !exists(options.allowDirtyWithRecoveryManifest!)) {
    throw new Error(`isolated worktree recovery manifest is unavailable: ${options.allowDirtyWithRecoveryManifest}`);
  }

  const remove = gone
    ? status
    : run("git", ["-C", record.repoPath, "worktree", "remove", ...(dirty ? ["--force"] : []), record.worktreePath]);
  const removedOrGone = remove.status === 0
    || /not a working tree|is not a working tree|no such|cannot find|does not exist/i.test(commandError(remove));
  if (!removedOrGone) {
    throw new Error(`failed to reclaim isolated worktree: ${commandError(remove)}`);
  }
  appendWorktreeLedger({ ...record, ts: now(), status: "reclaimed" }, options);
  if (activeWorktreeForExecution(identity, options)) {
    throw new Error(`isolated worktree reclaim did not clear ownership: ${record.worktreePath}`);
  }
  return { status: "reclaimed", worktreePath: record.worktreePath };
}

/**
 * Reclaim (tear down) every active worktree in the ledger. Tolerates a
 * worktree that is already gone. Appends a 'reclaimed' record per removal
 * (append-only; the ledger is folded by latest-status-per-path on read).
 */
export function reclaimIsolatedWorktrees(
  options: IsolatedWorktreeOptions = {},
): { removed: string[]; kept: string[] } {
  const run = options.run ?? defaultRun;
  const now = options.now ?? (() => new Date().toISOString());
  const removed: string[] = [];
  const kept: string[] = [];
  for (const rec of activeWorktreeRecords(options)) {
    try {
      const result = reclaimIsolatedWorktree(
        { ticketIds: [rec.ticketId], worktreePath: rec.worktreePath },
        { ...options, run, now },
      );
      if (result.status === "reclaimed" && result.worktreePath) removed.push(result.worktreePath);
    } catch {
      kept.push(rec.worktreePath);
    }
  }
  return { removed, kept };
}
