import { describe, expect, test } from "bun:test";
import { commitDigest, resolveExactCommitDigest, type GitRunner } from "./outcome-evidence-emission";

const SHA = "a".repeat(40);

function runner(overrides: Partial<Record<string, { exitCode: number; stdout: string; stderr: string }>> = {}): GitRunner {
  return (_cwd, args) => {
    const key = args.join(" ");
    return overrides[key] ?? {
      exitCode: 0,
      stdout: key === "branch --show-current" ? "factory/zou-1528\n"
        : key === "status --porcelain --untracked-files=normal" ? ""
          : `${SHA}\n`,
      stderr: "",
    };
  };
}

describe("exact commit evidence emission", () => {
  test("binds a clean execution branch to its full commit SHA", () => {
    const result = resolveExactCommitDigest({ repoPath: "/repo", branchName: "factory/zou-1528" }, runner());
    expect(result).toEqual({ ok: true, commit_sha: SHA, commit_digest: commitDigest(SHA) });
  });

  test("rejects a wrong branch", () => {
    const result = resolveExactCommitDigest({ repoPath: "/repo", branchName: "factory/other" }, runner());
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("branch mismatch");
  });

  test("rejects a dirty worktree", () => {
    const result = resolveExactCommitDigest(
      { repoPath: "/repo", branchName: "factory/zou-1528" },
      runner({ "status --porcelain --untracked-files=normal": { exitCode: 0, stdout: " M src/app.ts\n", stderr: "" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("dirty");
  });

  test("rejects a branch head different from checked-out HEAD", () => {
    const result = resolveExactCommitDigest(
      { repoPath: "/repo", branchName: "factory/zou-1528" },
      runner({ "rev-parse --verify factory/zou-1528^{commit}": { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error).toContain("does not equal");
  });

  test("rejects missing repository identity", () => {
    expect(resolveExactCommitDigest({ branchName: "factory/zou-1528" }, runner()).ok).toBe(false);
    expect(resolveExactCommitDigest({ repoPath: "/repo", branchName: null }, runner()).ok).toBe(false);
  });
});
