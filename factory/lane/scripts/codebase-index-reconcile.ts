#!/usr/bin/env bun
import { canonicalFactoryPath, factoryWorktreesRoot, loadFactoryPathProfile } from "../../../packages/zo-swarm-orchestrator/src/transport/factory-path-profile";
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const PROJECT_DIR = join(import.meta.dir, "..");
const DEFAULT_STATE_DIR = factoryStateRoot();
const DEFAULT_AUTHORIZED_ROOT = "/home/workspace";
const DEFAULT_MIRROR_ROOT = "/home/workspace/.factory-worktrees/codebase-indexes";
const DEFAULT_CBM_BIN = "/home/workspace/Integrations/codebase-memory-mcp/bin/codebase-memory-mcp";
const FULL_SHA = /^[0-9a-f]{40}$/;
const LOCK_STALE_MS = 2 * 60 * 60_000;

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (program: string, args: string[], cwd?: string) => CommandResult;

interface ShippingReceipt {
  execution_id?: unknown;
  identifier?: unknown;
  status?: unknown;
  outcome?: unknown;
  pr_number?: unknown;
  pr_url?: unknown;
  repo_path?: unknown;
}

export interface CodebaseIndexCandidate {
  execution_id: string;
  identifier: string;
  repo_path: string;
  pr_number: number;
  pr_url: string | null;
}

export type CodebaseIndexStatus = "succeeded" | "failed";

export interface CodebaseIndexReceipt {
  version: 1;
  repository_key: string;
  execution_id: string;
  identifier: string;
  source_repo_path: string;
  github_repository: string;
  pr_number: number;
  pr_url: string | null;
  merge_sha: string | null;
  mirror_path: string;
  graph_project: string | null;
  status: CodebaseIndexStatus;
  attempt_count: number;
  started_at: string;
  completed_at: string;
  indexed_at: string | null;
  error: string | null;
}

export interface CodebaseIndexResult {
  execution_id: string;
  identifier: string;
  repo_path: string;
  pr_number: number;
  merge_sha: string | null;
  status: "indexed" | "skipped" | "pending" | "failed";
  graph_project: string | null;
  receipt_path: string | null;
  error: string | null;
}

export interface CodebaseIndexReport {
  ok: boolean;
  enabled: boolean;
  locked: boolean;
  evaluated: number;
  indexed: number;
  skipped: number;
  pending: number;
  failures: CodebaseIndexResult[];
  results: CodebaseIndexResult[];
}

export interface CodebaseIndexOptions {
  stateDir?: string;
  authorizedRoot?: string;
  mirrorRoot?: string;
  cbmBin?: string;
  indexMode?: "full" | "moderate" | "fast";
  command?: CommandRunner;
  now?: () => string;
  enabled?: boolean;
  lock?: boolean;
}

interface PullRequestView {
  state?: unknown;
  mergeCommit?: { oid?: unknown } | null;
}

interface IndexResponse {
  project?: unknown;
  status?: unknown;
  error?: unknown;
  hint?: unknown;
}

function realCommand(program: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    timeout: 30 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function requireCommand(command: CommandRunner, program: string, args: string[], cwd?: string): string {
  const result = command(program, args, cwd);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${program} ${args.join(" ")} failed`).trim());
  }
  return result.stdout.trim();
}

function parseLastJson<T>(value: string, label: string): T {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]!) as T;
    } catch {
      continue;
    }
  }
  throw new Error(`${label} returned invalid JSON`);
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function safeSegment(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`cannot derive a safe path segment from ${value}`);
  return safe;
}

function validateGitHubRepository(value: string, label: string): string {
  const match = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error(`invalid GitHub repository identity from ${label}: ${value}`);
  return `${match[1]}/${match[2]}`;
}

function repositoryFromPullRequestUrl(candidate: CodebaseIndexCandidate): string | null {
  if (!candidate.pr_url) return null;
  let url: URL;
  try {
    url = new URL(candidate.pr_url);
  } catch {
    throw new Error(`invalid GitHub pull request URL: ${candidate.pr_url}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:"
    || url.hostname.toLowerCase() !== "github.com"
    || url.search
    || url.hash
    || parts.length !== 4
    || parts[2] !== "pull"
    || Number(parts[3]) !== candidate.pr_number
  ) {
    throw new Error(`pull request URL does not match PR #${candidate.pr_number}: ${candidate.pr_url}`);
  }
  return validateGitHubRepository(`${parts[0]}/${parts[1]}`, "pull request URL");
}

function repositoryKey(repoPath: string): string {
  return createHash("sha256").update(repoPath).digest("hex").slice(0, 16);
}

export function codebaseIndexReceiptPath(repoPath: string, stateDir = DEFAULT_STATE_DIR): string {
  return join(stateDir, `codebase-index-${repositoryKey(repoPath)}.json`);
}

function loadIndexReceipt(repoPath: string, stateDir: string): CodebaseIndexReceipt | null {
  const path = codebaseIndexReceiptPath(repoPath, stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CodebaseIndexReceipt;
  } catch {
    return null;
  }
}

export function readCodebaseIndexCandidates(stateDir = DEFAULT_STATE_DIR): CodebaseIndexCandidate[] {
  if (!existsSync(stateDir)) return [];
  const candidates = new Map<string, CodebaseIndexCandidate>();
  for (const name of readdirSync(stateDir)) {
    if (!name.startsWith("shipping-request-") || !name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(readFileSync(join(stateDir, name), "utf8")) as ShippingReceipt;
      if (row.status !== "succeeded" || row.outcome === "no_patch_novel") continue;
      if (typeof row.execution_id !== "string" || typeof row.identifier !== "string") continue;
      if (typeof row.repo_path !== "string" || typeof row.pr_number !== "number") continue;
      const candidate: CodebaseIndexCandidate = {
        execution_id: row.execution_id,
        identifier: row.identifier,
        repo_path: row.repo_path,
        pr_number: row.pr_number,
        pr_url: typeof row.pr_url === "string" ? row.pr_url : null,
      };
      const previous = candidates.get(candidate.repo_path);
      if (!previous || candidate.pr_number > previous.pr_number) candidates.set(candidate.repo_path, candidate);
    } catch {
      continue;
    }
  }
  return [...candidates.values()].sort((a, b) => a.repo_path.localeCompare(b.repo_path) || a.pr_number - b.pr_number);
}

function canonicalRepository(candidate: CodebaseIndexCandidate, authorizedRoot: string): string {
  if (!isAbsolute(candidate.repo_path)) throw new Error(`repo_path must be absolute: ${candidate.repo_path}`);
  const root = realpathSync(authorizedRoot);
  const repo = realpathSync(candidate.repo_path);
  if (!isWithin(repo, root)) throw new Error(`repo_path is outside the authorized root: ${repo}`);
  return repo;
}

function mirrorPathFor(githubRepository: string, mirrorRoot: string): string {
  const [owner, name, extra] = githubRepository.split("/");
  if (!owner || !name || extra) throw new Error(`invalid GitHub repository identity: ${githubRepository}`);
  const root = resolve(mirrorRoot);
  const mirror = join(root, safeSegment(owner), safeSegment(name));
  if (!isWithin(mirror, root)) throw new Error(`derived mirror path escaped its root: ${mirror}`);
  return mirror;
}

function ownedMirrorPathFor(githubRepository: string, mirrorRoot: string, gitCommonDirectory: string): string {
  const legacyPath = mirrorPathFor(githubRepository, mirrorRoot);
  const mirror = `${legacyPath}--${repositoryKey(gitCommonDirectory)}`;
  const root = resolve(mirrorRoot);
  if (!isWithin(mirror, root)) throw new Error(`derived ownership-safe mirror path escaped its root: ${mirror}`);
  return mirror;
}

function gitCommonDir(command: CommandRunner, repoPath: string): string {
  const value = requireCommand(command, "git", ["rev-parse", "--git-common-dir"], repoPath);
  return resolve(repoPath, value);
}

function selectMirrorPath(
  command: CommandRunner,
  sourceRepo: string,
  githubRepository: string,
  requestedMirrorPath: string,
): { mirrorPath: string; sourceCommonDirectory: string } {
  const sourceCommonDirectory = gitCommonDir(command, sourceRepo);
  const mirrorRoot = dirname(dirname(requestedMirrorPath));
  const legacyMirrorPath = mirrorPathFor(githubRepository, mirrorRoot);
  let mirrorPath = requestedMirrorPath;

  if (!existsSync(legacyMirrorPath)) {
    mirrorPath = ownedMirrorPathFor(githubRepository, mirrorRoot, sourceCommonDirectory);
  } else {
    const legacyTopLevel = realpathSync(requireCommand(command, "git", ["rev-parse", "--show-toplevel"], legacyMirrorPath));
    if (legacyTopLevel !== realpathSync(legacyMirrorPath)) {
      throw new Error(`managed mirror is not a git toplevel: ${legacyMirrorPath}`);
    }
    if (gitCommonDir(command, legacyMirrorPath) !== sourceCommonDirectory) {
      mirrorPath = ownedMirrorPathFor(githubRepository, mirrorRoot, sourceCommonDirectory);
    }
  }

  return { mirrorPath, sourceCommonDirectory };
}

function prepareMirror(
  command: CommandRunner,
  sourceRepo: string,
  githubRepository: string,
  mirrorPath: string,
  mergeSha: string,
  sourceCommonDirectory: string,
): void {
  requireCommand(command, "git", ["fetch", `https://github.com/${githubRepository}.git`, mergeSha], sourceRepo);
  if (!existsSync(mirrorPath)) {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    requireCommand(command, "git", ["worktree", "add", "--detach", mirrorPath, mergeSha], sourceRepo);
  } else {
    const topLevel = realpathSync(requireCommand(command, "git", ["rev-parse", "--show-toplevel"], mirrorPath));
    if (topLevel !== realpathSync(mirrorPath)) throw new Error(`managed mirror is not a git toplevel: ${mirrorPath}`);
    if (gitCommonDir(command, mirrorPath) !== sourceCommonDirectory) {
      throw new Error(`managed mirror does not belong to the source repository: ${mirrorPath}`);
    }
    const dirty = requireCommand(command, "git", ["status", "--porcelain"], mirrorPath);
    if (dirty) throw new Error(`managed mirror is dirty and will not be overwritten: ${mirrorPath}`);
    requireCommand(command, "git", ["checkout", "--detach", mergeSha], mirrorPath);
  }
  if (gitCommonDir(command, mirrorPath) !== sourceCommonDirectory) {
    throw new Error(`managed mirror does not belong to the source repository: ${mirrorPath}`);
  }
  const head = requireCommand(command, "git", ["rev-parse", "HEAD"], mirrorPath);
  if (head !== mergeSha) throw new Error(`mirror HEAD ${head || "unknown"} does not match merge SHA ${mergeSha}`);
  const dirty = requireCommand(command, "git", ["status", "--porcelain"], mirrorPath);
  if (dirty) throw new Error(`managed mirror became dirty before indexing: ${mirrorPath}`);
}

function acquireLock(stateDir: string): (() => void) | null {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "codebase-index-reconcile.lock");
  try {
    closeSync(openSync(path, "wx"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = Date.now() - statSync(path).mtimeMs;
    if (age <= LOCK_STALE_MS) return null;
    unlinkSync(path);
    closeSync(openSync(path, "wx"));
  }
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // A missing lock after completion is harmless.
    }
  };
}

function disabledReport(enabled: boolean, locked: boolean): CodebaseIndexReport {
  return {
    ok: true,
    enabled,
    locked,
    evaluated: 0,
    indexed: 0,
    skipped: 0,
    pending: 0,
    failures: [],
    results: [],
  };
}

export function reconcileCodebaseIndexes(options: CodebaseIndexOptions = {}): CodebaseIndexReport {
  const enabled = options.enabled ?? process.env.FACTORY_CODEBASE_INDEX !== "0";
  if (!enabled) return disabledReport(false, false);

  const configuredMode = options.indexMode ?? process.env.FACTORY_CODEBASE_INDEX_MODE ?? "full";
  if (!["full", "moderate", "fast"].includes(configuredMode)) throw new Error(`invalid Codebase MCP index mode: ${configuredMode}`);
  const indexMode = configuredMode as NonNullable<CodebaseIndexOptions["indexMode"]>;
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const command = options.command ?? realCommand;
  const authorizedRoot = options.authorizedRoot ?? DEFAULT_AUTHORIZED_ROOT;
  const profile = loadFactoryPathProfile();
  const mirrorRoot = options.mirrorRoot ?? join(factoryWorktreesRoot(), "codebase-indexes");
  if (profile && (authorizedRoot !== profile.source_root || mirrorRoot !== join(profile.worktrees_root, "codebase-indexes"))) throw new Error("index roots diverge from Factory profile");
  const cbmBin = options.cbmBin ?? process.env.CODEBASE_MEMORY_MCP_BIN ?? DEFAULT_CBM_BIN;
  const now = options.now ?? (() => new Date().toISOString());
  const results: CodebaseIndexResult[] = [];
  const release = options.lock === false ? () => undefined : acquireLock(stateDir);
  if (!release) return disabledReport(true, true);

  try {
    for (const candidate of readCodebaseIndexCandidates(stateDir)) {
      let mergeSha: string | null = null;
      let receiptPath: string | null = null;
      let sourceRepo = candidate.repo_path;
      let githubRepository = "unknown";
      let mirrorPath = "unknown";
      let startedAt = now();
      try {
        sourceRepo = canonicalRepository(candidate, authorizedRoot);
        receiptPath = codebaseIndexReceiptPath(sourceRepo, stateDir);
        const topLevel = realpathSync(requireCommand(command, "git", ["rev-parse", "--show-toplevel"], sourceRepo));
        if (topLevel !== sourceRepo) throw new Error(`repo_path is not the git toplevel: ${sourceRepo}`);
        githubRepository = repositoryFromPullRequestUrl(candidate) ?? validateGitHubRepository(requireCommand(command, "gh", [
          "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner",
        ], sourceRepo), "local checkout");
        const pr = parseLastJson<PullRequestView>(requireCommand(command, "gh", [
          "pr", "view", String(candidate.pr_number), "--repo", githubRepository,
          "--json", "state,mergeCommit",
        ], sourceRepo), "gh pr view");
        if (pr.state !== "MERGED") {
          results.push({
            execution_id: candidate.execution_id,
            identifier: candidate.identifier,
            repo_path: sourceRepo,
            pr_number: candidate.pr_number,
            merge_sha: null,
            status: "pending",
            graph_project: null,
            receipt_path: null,
            error: null,
          });
          continue;
        }
        mergeSha = typeof pr.mergeCommit?.oid === "string" ? pr.mergeCommit.oid : null;
        if (!mergeSha || !FULL_SHA.test(mergeSha)) throw new Error("merged PR is missing a valid merge commit SHA");

        const previous = loadIndexReceipt(sourceRepo, stateDir);
        if (previous?.status === "succeeded" && previous.merge_sha === mergeSha) {
          results.push({
            execution_id: candidate.execution_id,
            identifier: candidate.identifier,
            repo_path: sourceRepo,
            pr_number: candidate.pr_number,
            merge_sha: mergeSha,
            status: "skipped",
            graph_project: previous.graph_project,
            receipt_path: receiptPath,
            error: null,
          });
          continue;
        }

        mirrorPath = mirrorPathFor(githubRepository, mirrorRoot);
        if (profile) canonicalFactoryPath(mirrorPath);
        startedAt = now();
        const attemptCount = (previous?.attempt_count ?? 0) + 1;
        const selection = selectMirrorPath(command, sourceRepo, githubRepository, mirrorPath);
        mirrorPath = selection.mirrorPath;
        if (profile) canonicalFactoryPath(mirrorPath);
        prepareMirror(command, sourceRepo, githubRepository, mirrorPath, mergeSha, selection.sourceCommonDirectory);
        const indexPayload = parseLastJson<IndexResponse>(requireCommand(command, cbmBin, [
          "cli", "index_repository", JSON.stringify({ repo_path: mirrorPath, mode: indexMode }),
        ], mirrorPath), "Codebase MCP index_repository");
        if (indexPayload.status !== "indexed" || typeof indexPayload.project !== "string") {
          const detail = typeof indexPayload.error === "string" ? indexPayload.error
            : typeof indexPayload.hint === "string" ? indexPayload.hint
            : `unexpected index status ${String(indexPayload.status)}`;
          throw new Error(`Codebase MCP indexing did not pass: ${detail}`);
        }
        const graphProject = indexPayload.project;
        const architecture = parseLastJson<Record<string, unknown>>(requireCommand(command, cbmBin, [
          "cli", "get_architecture", JSON.stringify({ project: graphProject }),
        ], mirrorPath), "Codebase MCP get_architecture");
        if (typeof architecture.error === "string") throw new Error(`Codebase MCP verification failed: ${architecture.error}`);
        if (architecture.project !== graphProject) {
          throw new Error(`Codebase MCP verification returned the wrong project: ${String(architecture.project)}`);
        }
        if (typeof architecture.total_nodes !== "number" || architecture.total_nodes <= 0) {
          throw new Error(`Codebase MCP verification found no indexed nodes for ${graphProject}`);
        }

        const completedAt = now();
        const receipt: CodebaseIndexReceipt = {
          version: 1,
          repository_key: repositoryKey(sourceRepo),
          execution_id: candidate.execution_id,
          identifier: candidate.identifier,
          source_repo_path: sourceRepo,
          github_repository: githubRepository,
          pr_number: candidate.pr_number,
          pr_url: candidate.pr_url,
          merge_sha: mergeSha,
          mirror_path: mirrorPath,
          graph_project: graphProject,
          status: "succeeded",
          attempt_count: attemptCount,
          started_at: startedAt,
          completed_at: completedAt,
          indexed_at: completedAt,
          error: null,
        };
        atomicWrite(receiptPath, receipt);
        results.push({
          execution_id: candidate.execution_id,
          identifier: candidate.identifier,
          repo_path: sourceRepo,
          pr_number: candidate.pr_number,
          merge_sha: mergeSha,
          status: "indexed",
          graph_project: graphProject,
          receipt_path: receiptPath,
          error: null,
        });
      } catch (error) {
        const message = errorMessage(error);
        sourceRepo = isAbsolute(sourceRepo) && existsSync(sourceRepo) ? realpathSync(sourceRepo) : sourceRepo;
        receiptPath = receiptPath ?? (isAbsolute(sourceRepo) ? codebaseIndexReceiptPath(sourceRepo, stateDir) : null);
        if (receiptPath) {
          const previous = loadIndexReceipt(sourceRepo, stateDir);
          const completedAt = now();
          atomicWrite(receiptPath, {
            version: 1,
            repository_key: repositoryKey(sourceRepo),
            execution_id: candidate.execution_id,
            identifier: candidate.identifier,
            source_repo_path: sourceRepo,
            github_repository: githubRepository !== "unknown" ? githubRepository : previous?.github_repository ?? "unknown",
            pr_number: candidate.pr_number,
            pr_url: candidate.pr_url,
            merge_sha: mergeSha,
            mirror_path: mirrorPath !== "unknown" ? mirrorPath : previous?.mirror_path ?? "unknown",
            graph_project: previous?.graph_project ?? null,
            status: "failed",
            attempt_count: (previous?.attempt_count ?? 0) + 1,
            started_at: startedAt,
            completed_at: completedAt,
            indexed_at: previous?.indexed_at ?? null,
            error: message,
          } satisfies CodebaseIndexReceipt);
        }
        results.push({
          execution_id: candidate.execution_id,
          identifier: candidate.identifier,
          repo_path: sourceRepo,
          pr_number: candidate.pr_number,
          merge_sha: mergeSha,
          status: "failed",
          graph_project: null,
          receipt_path: receiptPath,
          error: message,
        });
      }
    }
  } finally {
    release();
  }

  const failures = results.filter((item) => item.status === "failed");
  return {
    ok: failures.length === 0,
    enabled: true,
    locked: false,
    evaluated: results.length,
    indexed: results.filter((item) => item.status === "indexed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    pending: results.filter((item) => item.status === "pending").length,
    failures,
    results,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean" },
      "state-dir": { type: "string" },
      "authorized-root": { type: "string" },
      "mirror-root": { type: "string" },
      mode: { type: "string" },
      "no-lock": { type: "boolean" },
    },
    strict: true,
  });
  const mode = values.mode;
  if (mode && !["full", "moderate", "fast"].includes(mode)) throw new Error(`invalid index mode: ${mode}`);
  const report = reconcileCodebaseIndexes({
    stateDir: values["state-dir"],
    authorizedRoot: values["authorized-root"],
    mirrorRoot: values["mirror-root"],
    indexMode: mode as CodebaseIndexOptions["indexMode"],
    lock: !values["no-lock"],
  });
  if (values.json) console.log(JSON.stringify(report));
  else console.log(`Codebase MCP: ${report.indexed} indexed, ${report.skipped} current, ${report.pending} pending, ${report.failures.length} failed`);
  process.exit(report.ok ? 0 : 1);
}
