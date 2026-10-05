import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCascadeWorktree } from "./coding-cascade";
import { executionWorkspaceRoot } from "./execution-repository";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function seedRepository(hostRoot: string): { repository: string; baseCommit: string } {
  const repository = join(hostRoot, ".factory-worktrees", "app-ZOU-1570");
  mkdirSync(repository, { recursive: true });
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "factory@test.local");
  git(repository, "config", "user.name", "Factory Test");
  writeFileSync(join(repository, "README.md"), "seed\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-qm", "seed");
  return { repository, baseCommit: git(repository, "rev-parse", "HEAD").toLowerCase() };
}

describe("cascade workspace root anchoring (ZOU-1570)", () => {
  test("guard rejects execution-repository clones when anchored to a divergent release root", () => {
    const hostRoot = scratch("zou1570-host-");
    const releaseRoot = scratch("zou1570-release-");
    const { repository, baseCommit } = seedRepository(hostRoot);

    expect(() =>
      prepareCascadeWorktree({
        repository,
        base_commit: baseCommit,
        assignment_id: "asg-ZOU-1570-divergent",
        options: { workspaceRoot: releaseRoot },
      }),
    ).toThrow(/outside workspace root/);
  });

  test("guard admits the same clone when anchored to the root that placed it", () => {
    const hostRoot = scratch("zou1570-host-");
    const { repository, baseCommit } = seedRepository(hostRoot);

    const worktree = prepareCascadeWorktree({
      repository,
      base_commit: baseCommit,
      assignment_id: "asg-ZOU-1570-anchored",
      options: { workspaceRoot: hostRoot },
    });

    expect(worktree.startsWith(join(hostRoot, ".factory-worktrees"))).toBe(true);
    expect(git(worktree, "rev-parse", "HEAD").toLowerCase()).toBe(baseCommit);
  });

  test("executionWorkspaceRoot defaults to the host workspace and honors ZOUROBOROS_WORKSPACE", () => {
    const saved = process.env.ZOUROBOROS_WORKSPACE;
    try {
      delete process.env.ZOUROBOROS_WORKSPACE;
      expect(executionWorkspaceRoot()).toBe("/home/workspace");
      process.env.ZOUROBOROS_WORKSPACE = "/tmp/zou1570-override";
      expect(executionWorkspaceRoot()).toBe("/tmp/zou1570-override");
    } finally {
      if (saved === undefined) delete process.env.ZOUROBOROS_WORKSPACE;
      else process.env.ZOUROBOROS_WORKSPACE = saved;
    }
  });
});
