import { createHash } from "node:crypto";

export interface ExactCommitInput {
  repoPath?: string;
  branchName?: string | null;
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: string[]) => GitCommandResult;

export type ExactCommitResolution =
  | { ok: true; commit_sha: string; commit_digest: string }
  | { ok: false; error: string };

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function defaultGit(cwd: string, args: string[]): GitCommandResult {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function failure(action: string, result: GitCommandResult): ExactCommitResolution {
  return { ok: false, error: `${action}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}` };
}

export function commitDigest(commitSha: string): string {
  return `sha256:${createHash("sha256").update(commitSha.toLowerCase()).digest("hex")}`;
}

export function resolveExactCommitDigest(
  input: ExactCommitInput,
  git: GitRunner = defaultGit,
): ExactCommitResolution {
  if (!input.repoPath) return { ok: false, error: "execution repo_path is absent" };
  if (!input.branchName) return { ok: false, error: "execution branch_name is absent" };

  const branch = git(input.repoPath, ["branch", "--show-current"]);
  if (branch.exitCode !== 0) return failure("current branch resolution failed", branch);
  if (branch.stdout.trim() !== input.branchName) {
    return { ok: false, error: `worktree branch mismatch: expected ${input.branchName}, got ${branch.stdout.trim() || "detached"}` };
  }

  const status = git(input.repoPath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.exitCode !== 0) return failure("worktree status failed", status);
  if (status.stdout.trim() !== "") return { ok: false, error: "worktree is dirty; no exact commit binding is available" };

  const head = git(input.repoPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.exitCode !== 0) return failure("HEAD commit resolution failed", head);
  const branchHead = git(input.repoPath, ["rev-parse", "--verify", `${input.branchName}^{commit}`]);
  if (branchHead.exitCode !== 0) return failure("branch commit resolution failed", branchHead);
  const commitSha = head.stdout.trim().toLowerCase();
  if (!FULL_SHA.test(commitSha)) return { ok: false, error: "resolved HEAD is not a full commit SHA" };
  if (branchHead.stdout.trim().toLowerCase() !== commitSha) {
    return { ok: false, error: "checked-out HEAD does not equal the execution branch head" };
  }
  return { ok: true, commit_sha: commitSha, commit_digest: commitDigest(commitSha) };
}
