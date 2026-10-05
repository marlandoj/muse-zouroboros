import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveExecutionRepository } from "./execution-repository";

describe("execution repository resolution", () => {
  test("prefers an explicit workspace path from a descriptive target contract", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const repository = join(root, "Sites", "zouroboros-ai");
    mkdirSync(repository, { recursive: true });
    try {
      const target = `Sites/zouroboros-ai — local path \`${repository}\`; Git remote follows.`;
      expect(resolveExecutionRepository(target, { fallback: root, workspaceRoot: root })).toBe(repository);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a relative repository name under Projects before the workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const repository = join(root, "Projects", "zouroboros-software-factory");
    mkdirSync(repository, { recursive: true });
    try {
      expect(resolveExecutionRepository("zouroboros-software-factory", { fallback: root, workspaceRoot: root })).toBe(repository);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves relative repository names under Sites", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const repository = join(root, "Sites", "arcade-games");
    mkdirSync(repository, { recursive: true });
    try {
      expect(resolveExecutionRepository("arcade-games", { fallback: root, workspaceRoot: root })).toBe(repository);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes Markdown, angle-bracket, plain, and .git GitHub references", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const repository = join(root, "Sites", "arcade-games");
    mkdirSync(repository, { recursive: true });
    const run = (command: string, args: string[]) => {
      expect(command).toBe("git");
      expect(args).toEqual(["-C", repository, "remote", "get-url", "origin"]);
      return { status: 0, stdout: "https://github.com/marlandoj/arcade-games.git\n" };
    };
    const targets = [
      "[https://github.com/marlandoj/arcade-games](<https://github.com/marlandoj/arcade-games>)",
      "<https://github.com/marlandoj/arcade-games>",
      "https://github.com/marlandoj/arcade-games",
      "https://github.com/marlandoj/arcade-games.git",
    ];
    try {
      for (const target of targets) {
        expect(resolveExecutionRepository(target, { fallback: root, workspaceRoot: root, run })).toBe(repository);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validates access and clones an absent GitHub repository with argument arrays", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const projects = join(root, "Projects");
    const repository = join(projects, "private-repo");
    mkdirSync(projects, { recursive: true });
    const calls: Array<[string, string[]]> = [];
    const run = (command: string, args: string[]) => {
      calls.push([command, args]);
      if (command === "gh" && args[0] === "api") return { status: 0 };
      if (command === "gh" && args[0] === "repo") {
        mkdirSync(repository);
        return { status: 0 };
      }
      return { status: 1, stderr: "not a checkout" };
    };
    try {
      expect(resolveExecutionRepository("https://github.com/marlandoj/private-repo", {
        fallback: root,
        workspaceRoot: root,
        run,
      })).toBe(repository);
      expect(calls).toEqual([
        ["gh", ["api", "repos/marlandoj/private-repo", "--silent"]],
        ["gh", ["repo", "clone", "marlandoj/private-repo", repository]],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for inaccessible, malformed, and conflicting GitHub targets", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const projects = join(root, "Projects");
    mkdirSync(projects, { recursive: true });
    try {
      expect(() => resolveExecutionRepository("https://github.com/marlandoj", {
        fallback: root,
        workspaceRoot: root,
      })).toThrow("unable to parse GitHub repository URL");
      expect(() => resolveExecutionRepository("https://github.com/marlandoj/missing", {
        fallback: root,
        workspaceRoot: root,
        run: () => ({ status: 1, stderr: "HTTP 404" }),
      })).toThrow("missing or inaccessible");

      const conflict = join(projects, "arcade-games");
      mkdirSync(conflict);
      expect(() => resolveExecutionRepository("https://github.com/marlandoj/arcade-games", {
        fallback: root,
        workspaceRoot: root,
        run: () => ({ status: 0, stdout: "https://github.com/other/arcade-games.git" }),
      })).toThrow("refusing to overwrite non-matching repository checkout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects GitHub clone fallback through a Projects symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "factory-outside-"));
    symlinkSync(outside, join(root, "Projects"));
    try {
      expect(() => resolveExecutionRepository("https://github.com/marlandoj/private-repo", {
        fallback: root,
        workspaceRoot: root,
        run: () => {
          throw new Error("GitHub must not be called for an escaped clone parent");
        },
      })).toThrow("outside the workspace root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("fails closed for missing targets, escaped fallbacks, and symlink escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "factory-outside-"));
    const link = join(root, "linked-repo");
    symlinkSync(outside, link);
    try {
      expect(resolveExecutionRepository(undefined, { fallback: root, workspaceRoot: root })).toBe(root);
      expect(() => resolveExecutionRepository("Sites/missing", { fallback: root, workspaceRoot: root })).toThrow(
        "target repository does not exist",
      );
      expect(() => resolveExecutionRepository(undefined, { fallback: outside, workspaceRoot: root })).toThrow(
        "outside the workspace root",
      );
      expect(() => resolveExecutionRepository("linked-repo", { fallback: root, workspaceRoot: root })).toThrow(
        "outside the workspace root",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// --- ZOU-890: isolated per-ticket worktree ------------------------------

import {
  planIsolatedWorktree,
  createIsolatedWorktree,
  reclaimIsolatedWorktree,
  reclaimIsolatedWorktrees,
  activeWorktreeRecords,
  activeWorktreeForExecution,
  appendWorktreeLedger,
} from "./execution-repository";

describe("isolated worktree", () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "factory-wt-"));
    const worktreesRoot = join(root, ".factory-worktrees");
    const repoPath = join(root, "zouroboros");
    mkdirSync(repoPath, { recursive: true });
    const calls: string[][] = [];
    const baseCommit = "a".repeat(40);
    const okRun = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: args.includes("rev-parse") ? `${baseCommit}\n` : "", stderr: "" };
    };
    const opts = (over: Record<string, unknown> = {}) => ({
      workspaceRoot: root,
      worktreesRoot,
      run: okRun,
      now: () => "2026-07-24T00:00:00Z",
      ...over,
    });
    return { root, worktreesRoot, repoPath, calls, okRun, baseCommit, opts };
  }

  test("planIsolatedWorktree is deterministic and defaults to origin/main", () => {
    const { root, worktreesRoot, repoPath } = fixture();
    try {
      const a = planIsolatedWorktree(repoPath, "ZOU-890", { workspaceRoot: root, worktreesRoot });
      const b = planIsolatedWorktree(repoPath, "ZOU-890", { workspaceRoot: root, worktreesRoot });
      expect(a).toEqual(b);
      expect(a.baseRef).toBe("origin/main");
      expect(a.worktreePath).toBe(join(worktreesRoot, "zouroboros-ZOU-890"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createIsolatedWorktree fetches origin/main, adds the worktree, and ledgers it", () => {
    const { root, worktreesRoot, repoPath, calls, baseCommit, opts } = fixture();
    try {
      const wt = createIsolatedWorktree(repoPath, "ZOU-890", opts());
      expect(wt).toBe(join(worktreesRoot, "zouroboros-ZOU-890"));
      // fetch origin main, resolve the immutable base, then add detached.
      expect(calls[0]).toEqual(["git", "-C", repoPath, "fetch", "origin", "main"]);
      expect(calls[1]).toEqual(["git", "-C", repoPath, "rev-parse", "origin/main^{commit}"]);
      expect(calls[2]).toEqual(["git", "-C", repoPath, "worktree", "add", "--detach", wt, baseCommit]);
      const active = activeWorktreeRecords({ workspaceRoot: root, worktreesRoot });
      expect(active.map((r) => r.worktreePath)).toEqual([wt]);
      expect(active[0].baseCommit).toBe(baseCommit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createIsolatedWorktree reuses only a worktree with verified ownership and base commit", () => {
    const { root, worktreesRoot, repoPath, calls, baseCommit, opts } = fixture();
    try {
      const wt = join(worktreesRoot, "zouroboros-ZOU-890");
      mkdirSync(wt, { recursive: true });
      appendWorktreeLedger(
        { ts: "2026-07-24T00:00:00Z", repoPath, ticketId: "ZOU-890", worktreePath: wt, baseRef: "origin/main", baseCommit, status: "active" },
        { workspaceRoot: root, worktreesRoot },
      );
      const reused = createIsolatedWorktree(repoPath, "ZOU-890", opts());
      expect(reused).toBe(wt);
      expect(calls).toEqual([["git", "-C", repoPath, "cat-file", "-e", `${baseCommit}^{commit}`]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createIsolatedWorktree fails closed when the base commit cannot be resolved", () => {
    const { root, worktreesRoot, repoPath, opts } = fixture();
    try {
      expect(() => createIsolatedWorktree(repoPath, "ZOU-890", opts({
        run: (_command: string, args: string[]) => ({ status: 0, stdout: args.includes("rev-parse") ? "" : "", stderr: "" }),
      }))).toThrow("failed to resolve a full base commit");
      expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createIsolatedWorktree fails closed on a git error and writes no ledger row", () => {
    const { root, worktreesRoot, repoPath, opts } = fixture();
    try {
      const failAdd = (command: string, args: string[]) => {
        if (args.includes("add")) return { status: 1, stdout: "", stderr: "fatal: boom" };
        return { status: 0, stdout: args.includes("rev-parse") ? `${"a".repeat(40)}\n` : "", stderr: "" };
      };
      expect(() => createIsolatedWorktree(repoPath, "ZOU-890", opts({ run: failAdd }))).toThrow(
        "failed to create isolated worktree",
      );
      expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createIsolatedWorktree rejects a worktree path outside the workspace root", () => {
    const { root, worktreesRoot, repoPath, opts } = fixture();
    try {
      expect(() =>
        createIsolatedWorktree(repoPath, "ZOU-890", opts({ worktreesRoot: "/tmp/outside-factory-wt" })),
      ).toThrow("outside the workspace root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reclaimIsolatedWorktrees removes active worktrees and marks them reclaimed", () => {
    const { root, worktreesRoot, repoPath, opts } = fixture();
    try {
      const wt = createIsolatedWorktree(repoPath, "ZOU-890", opts());
      const result = reclaimIsolatedWorktrees({ workspaceRoot: root, worktreesRoot, now: () => "2026-07-24T01:00:00Z", run: (c, a) => ({ status: 0, stdout: "", stderr: "" }) });
      expect(result.removed).toEqual([wt]);
      expect(result.kept).toEqual([]);
      expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reclaim tolerates an already-gone worktree", () => {
    const { root, worktreesRoot, repoPath } = fixture();
    try {
      appendWorktreeLedger(
        { ts: "2026-07-24T00:00:00Z", repoPath, ticketId: "ZOU-890", worktreePath: join(worktreesRoot, "zouroboros-ZOU-890"), baseRef: "origin/main", status: "active" },
        { workspaceRoot: root, worktreesRoot },
      );
      const result = reclaimIsolatedWorktrees({
        workspaceRoot: root,
        worktreesRoot,
        now: () => "2026-07-24T01:00:00Z",
        run: () => ({ status: 128, stdout: "", stderr: "fatal: 'x' is not a working tree" }),
      });
      expect(result.removed.length).toBe(1);
      expect(result.kept).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("targeted reclaim fails closed on ambiguous ownership and cleanup failure", () => {
    const { root, worktreesRoot, repoPath } = fixture();
    try {
      for (const suffix of ["a", "b"]) {
        appendWorktreeLedger(
          { ts: `2026-07-24T00:00:0${suffix === "a" ? 0 : 1}Z`, repoPath, ticketId: "linear-ticket", worktreePath: join(worktreesRoot, `zouroboros-${suffix}`), baseRef: "origin/main", baseCommit: "a".repeat(40), status: "active" },
          { workspaceRoot: root, worktreesRoot },
        );
      }
      expect(() => activeWorktreeForExecution(
        { ticketIds: ["linear-ticket"] },
        { workspaceRoot: root, worktreesRoot },
      )).toThrow("ambiguous isolated worktree ownership");

      const target = join(worktreesRoot, "zouroboros-a");
      expect(() => reclaimIsolatedWorktree(
        { ticketIds: ["linear-ticket"], worktreePath: target },
        {
          workspaceRoot: root,
          worktreesRoot,
          run: (_command, args) => args.includes("status")
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 1, stdout: "", stderr: "locked" },
        },
      )).toThrow("failed to reclaim isolated worktree");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two same-repository executions keep branches, indexes, diffs, and teardown isolated", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-wt-concurrent-"));
    const remote = join(root, "remote.git");
    const source = join(root, "zouroboros");
    const worktreesRoot = join(root, ".factory-worktrees");
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
      return result.stdout.trim();
    };
    try {
      spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" });
      mkdirSync(source);
      git(source, "init", "-b", "main");
      git(source, "config", "user.email", "factory@example.test");
      git(source, "config", "user.name", "Factory Test");
      writeFileSync(join(source, "shared.ts"), "export const owner = 'base';\n");
      git(source, "add", ".");
      git(source, "commit", "-m", "base");
      git(source, "remote", "add", "origin", remote);
      git(source, "push", "-u", "origin", "main");

      const options = { workspaceRoot: root, worktreesRoot };
      const a = createIsolatedWorktree(source, "linear-a", options);
      const b = createIsolatedWorktree(source, "linear-b", options);
      git(a, "switch", "-c", "factory/a");
      git(b, "switch", "-c", "factory/b");
      writeFileSync(join(a, "shared.ts"), "export const owner = 'a';\n");
      writeFileSync(join(b, "shared.ts"), "export const owner = 'b';\n");

      expect(git(a, "branch", "--show-current")).toBe("factory/a");
      expect(git(b, "branch", "--show-current")).toBe("factory/b");
      expect(git(a, "rev-parse", "--git-path", "index")).not.toBe(git(b, "rev-parse", "--git-path", "index"));
      expect(git(a, "diff", "--", "shared.ts")).toContain("owner = 'a'");
      expect(git(b, "diff", "--", "shared.ts")).toContain("owner = 'b'");

      git(a, "add", ".");
      git(a, "commit", "-m", "a change");
      git(b, "add", ".");
      git(b, "commit", "-m", "b change");
      expect(reclaimIsolatedWorktree({ ticketIds: ["linear-a"], worktreePath: a }, options).status).toBe("reclaimed");
      expect(activeWorktreeForExecution({ ticketIds: ["linear-b"], worktreePath: b }, options)?.worktreePath).toBe(b);
      expect(reclaimIsolatedWorktree({ ticketIds: ["linear-b"], worktreePath: b }, options).status).toBe("reclaimed");
      expect(activeWorktreeRecords(options)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
