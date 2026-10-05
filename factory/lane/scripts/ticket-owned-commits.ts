#!/usr/bin/env bun
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { parseArgs } from "node:util";

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_COMMITS = 20;
const COMPLETION_GRACE_MS = 120_000;

export interface ShippingExecutionRecord {
  execution_id: string;
  identifier: string;
  branch_name: string | null;
  repo_path?: string | null;
  base_commit?: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface SelectedCommit {
  sha: string;
  committed_at: string;
}

export interface GitRunner {
  (args: string[]): string;
}

function canonicalPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  return realpathSync(path);
}

export function resolveShippingRepository(record: ShippingExecutionRecord, authorizedRoot?: string): string {
  const recorded = record.repo_path?.trim();
  if (!recorded) {
    if (!authorizedRoot) throw new Error("execution record is missing repo_path");
    return canonicalPath(authorizedRoot, "shipping repository");
  }

  const repository = canonicalPath(recorded, "execution repo_path");
  if (authorizedRoot) {
    const root = canonicalPath(authorizedRoot, "authorized repository root");
    const child = relative(root, repository);
    if (child.startsWith("..") || isAbsolute(child)) {
      throw new Error(`execution repo_path is outside the authorized repository root: ${repository}`);
    }
  }
  return repository;
}

function gitRunner(repo: string): GitRunner {
  return (args) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
    }
    return result.stdout.trim();
  };
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseTimestamp(value: string | null, label: string): number {
  if (!value) throw new Error(`${label} is required`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}

/**
 * Pick the commit the ticket-owned range is measured from.
 *
 * `base_commit` is captured from `origin/main` at dispatch
 * (`swarm-exec.ts:836`), but the branch itself is created by the executor from
 * whatever the target repository currently has checked out — the prompt just
 * says "create a git branch named X". In a serial lane that is the previous
 * ticket's branch, so the recorded base is routinely NOT an ancestor of the
 * branch and the old assertion threw. OpenFlight Sim T3, T4 and T5 each needed
 * a hand rebase for this and nothing else.
 *
 * Falling back to the merge-base loses no safety. What actually bounds the
 * selection is the pair of filters below: `git cherry` keeps only commits whose
 * patch is not already on main, and the execution window rejects anything not
 * committed during this run. Both still apply to every commit in the wider
 * range. A branch with no common ancestor at all is still a hard failure.
 */
export function resolveRangeBase(
  record: ShippingExecutionRecord,
  git: GitRunner,
  mainRef: string,
): string {
  try {
    git(["merge-base", "--is-ancestor", record.base_commit!, record.branch_name!]);
    return record.base_commit!;
  } catch {
    // Not an ancestor — measure from where the branch actually diverged.
  }
  const mergeBase = git(["merge-base", mainRef, record.branch_name!]).trim();
  if (!FULL_SHA.test(mergeBase)) {
    throw new Error(`branch ${record.branch_name} shares no history with ${mainRef}`);
  }
  return mergeBase;
}

export function selectTicketOwnedCommits(
  record: ShippingExecutionRecord,
  git: GitRunner,
  mainRef = "origin/main",
): { base_commit: string; range_base: string; branch_name: string; commits: SelectedCommit[] } {
  if (!record.branch_name?.startsWith("factory/")) {
    throw new Error("branch_name must start with factory/");
  }
  if (!record.base_commit || !FULL_SHA.test(record.base_commit)) {
    throw new Error("execution record is missing a valid base_commit");
  }

  const startedAt = parseTimestamp(record.started_at, "started_at");
  const completedAt = parseTimestamp(record.completed_at, "completed_at");
  git(["rev-parse", "--verify", `${record.base_commit}^{commit}`]);
  git(["rev-parse", "--verify", `${record.branch_name}^{commit}`]);

  const rangeBase = resolveRangeBase(record, git, mainRef);
  const range = `${rangeBase}..${record.branch_name}`;
  const merges = lines(git(["rev-list", "--merges", range]));
  if (merges.length > 0) throw new Error(`ticket-owned range contains merge commits: ${merges.join(", ")}`);

  const candidates = lines(git(["rev-list", "--reverse", "--no-merges", range]));
  if (candidates.length > MAX_COMMITS) {
    throw new Error(`ticket-owned range contains ${candidates.length} commits; maximum is ${MAX_COMMITS}`);
  }

  const patchNovel = new Set(
    lines(git(["cherry", mainRef, record.branch_name]))
      .filter((line) => line.startsWith("+ "))
      .map((line) => line.slice(2).trim()),
  );
  const selected = candidates.filter((sha) => patchNovel.has(sha));
  if (selected.length === 0) {
    throw new Error("ticket-owned range has no patch-novel commits");
  }

  const commits = selected.map((sha) => {
    if (!FULL_SHA.test(sha)) throw new Error(`git returned an invalid commit SHA: ${sha}`);
    const committedAt = git(["show", "-s", "--format=%cI", sha]);
    const committedMs = parseTimestamp(committedAt, `commit ${sha} timestamp`);
    if (committedMs < startedAt || committedMs > completedAt + COMPLETION_GRACE_MS) {
      throw new Error(`commit ${sha} falls outside the execution window`);
    }
    return { sha, committed_at: committedAt };
  });

  return { base_commit: record.base_commit, range_base: rangeBase, branch_name: record.branch_name, commits };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      execution: { type: "string", short: "e" },
      repo: { type: "string", short: "r" },
      main: { type: "string", default: "origin/main" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log("Usage: bun ticket-owned-commits.ts --execution <exec.json> [--repo <path>] [--main origin/main]");
    return;
  }
  if (!values.execution) throw new Error("--execution is required");

  const record = JSON.parse(readFileSync(values.execution, "utf8")) as ShippingExecutionRecord;
  const repo = resolveShippingRepository(record, values.repo);
  const result = selectTicketOwnedCommits(record, gitRunner(repo), values.main);
  console.log(JSON.stringify({ repo_path: repo, ...result }));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
