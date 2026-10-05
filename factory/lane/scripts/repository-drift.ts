import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

export type RepositoryDriftStatus =
  | "not_declared"
  | "exact"
  | "fast_forward_safe"
  | "fast_forward_reconciled"
  | "held";

export interface RepositoryDriftDecision {
  action: "proceed" | "hold";
  status: RepositoryDriftStatus;
  reason: string;
  repository: string | null;
  expected_ref: string | null;
  pinned_commit: string | null;
  remote_commit: string | null;
  head_before: string | null;
  head_after: string | null;
  branch: string | null;
  changed_paths: string[];
  journaled: boolean;
  journal_path: string | null;
  detail?: string;
  journal_error?: string;
  prior_reason?: string;
}

export interface RepositoryDriftInput {
  seedPath: string;
  workspaceRoot: string;
  dryRun?: boolean;
  ticketId?: string;
  identifier?: string;
  executionId?: string;
}

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface RepositoryPin {
  repository: string;
  ref: string;
  commit_sha: string;
}

interface JournalRecord extends RepositoryDriftDecision {
  schema_version: 1;
  event_id: string;
  checked_at: string;
  seed_path: string;
  workspace_root: string;
  ticket_id: string | null;
  identifier: string | null;
  execution_id: string | null;
}

export interface RepositoryDriftOptions {
  ledgerPath?: string;
  now?: () => string;
  run?: (workspaceRoot: string, args: string[]) => GitResult;
  append?: (path: string, record: JournalRecord) => void;
}

const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const DEFAULT_LEDGER = factoryStatePath("repository-drift.jsonl");

function defaultRun(workspaceRoot: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", workspaceRoot, ...args], {
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

function durableAppend(path: string, record: JournalRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function errorText(result: GitResult): string {
  return result.error?.message || result.stderr.trim() || `exit ${result.status ?? "unknown"}`;
}

function gitOutput(
  run: NonNullable<RepositoryDriftOptions["run"]>,
  workspaceRoot: string,
  args: string[],
): string | null {
  const result = run(workspaceRoot, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseSeed(seedPath: string): Record<string, unknown> {
  const parsed = Bun.YAML.parse(readFileSync(seedPath, "utf8"));
  const seed = record(parsed);
  if (!seed) throw new Error("seed YAML must contain one top-level mapping");
  return seed;
}

function parsePin(seed: Record<string, unknown>): { pin: RepositoryPin | null; error?: string } {
  if (seed.repositories === undefined) return { pin: null };
  if (!Array.isArray(seed.repositories) || seed.repositories.length !== 1) {
    return { pin: null, error: "execution_requires_exactly_one_repository_pin" };
  }
  const raw = record(seed.repositories[0]);
  const repository = raw?.repository;
  const ref = raw?.ref;
  const commit = raw?.commit_sha;
  if (
    typeof repository !== "string" || repository.trim() === ""
    || typeof ref !== "string" || ref.trim() === ""
    || typeof commit !== "string" || !FULL_COMMIT_SHA.test(commit)
  ) {
    return { pin: null, error: "repository_pin_invalid" };
  }
  return {
    pin: {
      repository: repository.trim(),
      ref: ref.trim(),
      commit_sha: commit.toLowerCase(),
    },
  };
}

function githubIdentity(value: string): string | null {
  const normalized = value.trim();
  const qualified = normalized.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (qualified) return `github:${qualified[1].toLowerCase()}/${qualified[2].toLowerCase()}`;
  const https = normalized.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (https) return `github:${https[1].toLowerCase()}/${https[2].toLowerCase()}`;
  const ssh = normalized.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return ssh ? `github:${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}` : null;
}

function repositoryIdentity(value: string): string {
  const github = githubIdentity(value);
  if (github) return github;
  return value.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "").toLowerCase();
}

function remoteBranch(ref: string): string | null {
  let branch = ref.trim();
  if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
  else if (branch.startsWith("refs/remotes/origin/")) branch = branch.slice("refs/remotes/origin/".length);
  else if (branch.startsWith("origin/")) branch = branch.slice("origin/".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) return null;
  return branch;
}

function normalizeScopePattern(value: string): string | null {
  const trimmed = value.trim().replace(/^\.\//, "").replace(/[\\]+/g, "/");
  if (!trimmed || isAbsolute(trimmed) || trimmed === ".." || trimmed.startsWith("../") || trimmed.includes("/../")) {
    return null;
  }
  return trimmed.replace(/\/$/, "");
}

function seedScopePatterns(seed: Record<string, unknown>): { patterns: string[]; invalid: string | null } {
  const values: unknown[] = [];
  if (Array.isArray(seed.tasks)) {
    for (const rawTask of seed.tasks) {
      const task = record(rawTask);
      if (!task) continue;
      if (Array.isArray(task.paths)) values.push(...task.paths);
      if (Array.isArray(task.files)) values.push(...task.files);
      if (typeof task.file === "string") values.push(task.file);
    }
  }
  const allowance = record(seed.build_plumbing_allowance);
  if (Array.isArray(allowance?.path_patterns)) values.push(...allowance.path_patterns);

  const patterns: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") return { patterns: [], invalid: JSON.stringify(value) };
    const normalized = normalizeScopePattern(value);
    if (!normalized) return { patterns: [], invalid: value };
    patterns.push(normalized);
  }
  return { patterns: [...new Set(patterns)], invalid: null };
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  if (/[*?\[]/.test(pattern)) {
    try {
      return new Bun.Glob(pattern).match(path);
    } catch {
      return true;
    }
  }
  return path === pattern || path.startsWith(`${pattern}/`) || pattern.startsWith(`${path}/`);
}

function intersectingPaths(changedPaths: string[], scopePatterns: string[]): string[] {
  return changedPaths.filter((path) => scopePatterns.some((pattern) => pathMatchesPattern(path, pattern)));
}

function baseDecision(
  overrides: Partial<RepositoryDriftDecision> & Pick<RepositoryDriftDecision, "action" | "status" | "reason">,
): RepositoryDriftDecision {
  return {
    repository: null,
    expected_ref: null,
    pinned_commit: null,
    remote_commit: null,
    head_before: null,
    head_after: null,
    branch: null,
    changed_paths: [],
    journaled: false,
    journal_path: null,
    ...overrides,
  };
}

function journalDecision(
  input: RepositoryDriftInput,
  decision: RepositoryDriftDecision,
  options: RepositoryDriftOptions,
): RepositoryDriftDecision {
  const ledgerPath = options.ledgerPath ?? process.env.FACTORY_REPOSITORY_DRIFT_LEDGER ?? DEFAULT_LEDGER;
  const append = options.append ?? durableAppend;
  const now = options.now ?? (() => new Date().toISOString());
  const record: JournalRecord = {
    ...decision,
    journaled: true,
    schema_version: 1,
    event_id: `repo-drift-${randomUUID()}`,
    checked_at: now(),
    seed_path: input.seedPath,
    workspace_root: input.workspaceRoot,
    ticket_id: input.ticketId ?? null,
    identifier: input.identifier ?? null,
    execution_id: input.executionId ?? null,
    journal_path: ledgerPath,
  };
  try {
    append(ledgerPath, record);
    return { ...decision, journaled: true, journal_path: ledgerPath };
  } catch (error) {
    return {
      ...decision,
      action: "hold",
      status: "held",
      reason: "repository_drift_journal_failed",
      prior_reason: decision.reason,
      journaled: false,
      journal_path: ledgerPath,
      journal_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function checkSeedRepositoryDrift(
  input: RepositoryDriftInput,
  options: RepositoryDriftOptions = {},
): RepositoryDriftDecision {
  if (!existsSync(input.seedPath)) {
    return baseDecision({ action: "proceed", status: "not_declared", reason: "seed_missing" });
  }

  let seed: Record<string, unknown>;
  try {
    seed = parseSeed(input.seedPath);
  } catch (error) {
    return journalDecision(input, baseDecision({
      action: "hold",
      status: "held",
      reason: "seed_parse_failed",
      journal_error: error instanceof Error ? error.message : String(error),
    }), options);
  }

  const parsed = parsePin(seed);
  if (!parsed.pin && !parsed.error) {
    return baseDecision({ action: "proceed", status: "not_declared", reason: "repository_pins_not_declared" });
  }
  if (!parsed.pin) {
    return journalDecision(input, baseDecision({ action: "hold", status: "held", reason: parsed.error! }), options);
  }
  const pin = parsed.pin;
  const run = options.run ?? defaultRun;
  const shared = {
    repository: pin.repository,
    expected_ref: pin.ref,
    pinned_commit: pin.commit_sha,
  };
  const hold = (reason: string, overrides: Partial<RepositoryDriftDecision> = {}) => journalDecision(
    input,
    baseDecision({ action: "hold", status: "held", reason, ...shared, ...overrides }),
    options,
  );

  const worktree = gitOutput(run, input.workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (worktree !== "true") return hold("workspace_is_not_git_worktree");

  const remoteUrl = gitOutput(run, input.workspaceRoot, ["remote", "get-url", "origin"]);
  if (!remoteUrl) return hold("origin_remote_unavailable");
  if (repositoryIdentity(remoteUrl) !== repositoryIdentity(pin.repository)) {
    return hold("repository_identity_mismatch");
  }

  const branchName = remoteBranch(pin.ref);
  if (!branchName) return hold("expected_ref_invalid");
  const branch = gitOutput(run, input.workspaceRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const headBefore = gitOutput(run, input.workspaceRoot, ["rev-parse", "HEAD"]);
  if (!headBefore || !FULL_COMMIT_SHA.test(headBefore)) return hold("head_unavailable", { branch });
  const state = { branch, head_before: headBefore, head_after: headBefore };

  const dirty = gitOutput(run, input.workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty === null) return hold("worktree_status_unavailable", state);
  if (dirty !== "") return hold("worktree_dirty", state);

  let pinPresent = run(input.workspaceRoot, ["cat-file", "-e", `${pin.commit_sha}^{commit}`]);
  if (pinPresent.status !== 0) {
    pinPresent = run(input.workspaceRoot, ["fetch", "--no-tags", "origin", pin.commit_sha]);
    if (pinPresent.status !== 0) return hold("pinned_commit_unavailable", state);
  }

  const remoteTrackingRef = `refs/remotes/origin/${branchName}`;
  const fetched = run(input.workspaceRoot, [
    "fetch",
    "--no-tags",
    "origin",
    `+refs/heads/${branchName}:${remoteTrackingRef}`,
  ]);
  if (fetched.status !== 0) return hold("expected_ref_fetch_failed", { ...state, detail: errorText(fetched) });
  const remoteCommit = gitOutput(run, input.workspaceRoot, ["rev-parse", remoteTrackingRef]);
  if (!remoteCommit || !FULL_COMMIT_SHA.test(remoteCommit)) return hold("remote_commit_unavailable", state);
  const remoteState = { ...state, remote_commit: remoteCommit };

  if (remoteCommit === pin.commit_sha && headBefore === pin.commit_sha) {
    return journalDecision(input, baseDecision({
      action: "proceed",
      status: "exact",
      reason: "repository_state_matches_pin",
      ...shared,
      ...remoteState,
    }), options);
  }

  const pinAncestor = run(input.workspaceRoot, ["merge-base", "--is-ancestor", pin.commit_sha, remoteCommit]);
  if (pinAncestor.status !== 0) return hold("remote_ref_not_descendant_of_pin", remoteState);

  const changedOutput = gitOutput(run, input.workspaceRoot, ["diff", "--name-only", `${pin.commit_sha}..${remoteCommit}`, "--"]);
  if (changedOutput === null) return hold("drift_diff_unavailable", remoteState);
  const changedPaths = changedOutput.split("\n").map((path) => path.trim()).filter(Boolean);
  const scope = seedScopePatterns(seed);
  if (scope.invalid) return hold("declared_scope_invalid", { ...remoteState, changed_paths: changedPaths });
  if (changedPaths.length > 0 && scope.patterns.length === 0) {
    return hold("scope_preservation_unprovable", { ...remoteState, changed_paths: changedPaths });
  }
  const overlap = intersectingPaths(changedPaths, scope.patterns);
  if (overlap.length > 0) {
    return hold("repository_drift_overlaps_declared_scope", { ...remoteState, changed_paths: changedPaths });
  }

  if (headBefore === remoteCommit) {
    return journalDecision(input, baseDecision({
      action: "proceed",
      status: "fast_forward_safe",
      reason: "remote_fast_forward_is_scope_preserving",
      ...shared,
      ...remoteState,
      changed_paths: changedPaths,
    }), options);
  }

  const headAncestor = run(input.workspaceRoot, ["merge-base", "--is-ancestor", headBefore, remoteCommit]);
  if (headAncestor.status !== 0) {
    return hold("worktree_cannot_fast_forward_to_remote", { ...remoteState, changed_paths: changedPaths });
  }
  if (input.dryRun) {
    return journalDecision(input, baseDecision({
      action: "proceed",
      status: "fast_forward_safe",
      reason: remoteCommit === pin.commit_sha
        ? "worktree_would_fast_forward_to_approved_pin"
        : "scope_preserving_remote_drift_would_fast_forward",
      ...shared,
      ...remoteState,
      changed_paths: changedPaths,
    }), options);
  }
  const reconcile = run(input.workspaceRoot, ["merge", "--ff-only", remoteTrackingRef]);
  if (reconcile.status !== 0) {
    return hold("fast_forward_reconcile_failed", {
      ...remoteState,
      changed_paths: changedPaths,
      detail: errorText(reconcile),
    });
  }
  const headAfter = gitOutput(run, input.workspaceRoot, ["rev-parse", "HEAD"]);
  if (headAfter !== remoteCommit) {
    return hold("fast_forward_reconcile_unverified", {
      ...remoteState,
      head_after: headAfter,
      changed_paths: changedPaths,
    });
  }
  return journalDecision(input, baseDecision({
    action: "proceed",
    status: "fast_forward_reconciled",
    reason: remoteCommit === pin.commit_sha
      ? "worktree_fast_forwarded_to_approved_pin"
      : "scope_preserving_remote_drift_fast_forwarded",
    ...shared,
    ...remoteState,
    head_after: headAfter,
    changed_paths: changedPaths,
  }), options);
}
