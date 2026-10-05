import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkSeedRepositoryDrift } from "./repository-drift";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repository-drift-"));
  tempDirs.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  const seedPath = join(root, "seed.yaml");
  const ledgerPath = join(root, "repository-drift.jsonl");

  git(root, "init", "--bare", remote);
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "factory@example.test");
  git(source, "config", "user.name", "Factory Test");
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "src", "index.ts"), "export const value = 1;\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "-u", "origin", "main");
  git(root, "clone", "--branch", "main", remote, worktree);
  git(worktree, "config", "user.email", "factory@example.test");
  git(worktree, "config", "user.name", "Factory Test");
  const pin = git(worktree, "rev-parse", "HEAD");

  const writeSeed = (taskPath = "src/index.ts", repository = remote) => writeFileSync(seedPath, [
    "id: ZOU-TEST",
    "title: Repository drift fixture",
    `target_repo: ${JSON.stringify(repository)}`,
    "repositories:",
    `  - repository: ${JSON.stringify(repository)}`,
    "    ref: refs/heads/main",
    `    commit_sha: ${pin}`,
    "tasks:",
    "  - id: T1",
    "    title: Implement fixture",
    "    files:",
    `      - ${taskPath}`,
    "",
  ].join("\n"));
  writeSeed();

  return { root, remote, source, worktree, seedPath, ledgerPath, pin, writeSeed };
}

function check(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return checkSeedRepositoryDrift({
    seedPath: f.seedPath,
    workspaceRoot: f.worktree,
    ticketId: "linear-1",
    identifier: "ZOU-TEST",
    executionId: "exec-1",
  }, { ledgerPath: f.ledgerPath, ...overrides });
}

function upstreamCommit(f: ReturnType<typeof fixture>, path: string, contents: string): string {
  const target = join(f.source, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  git(f.source, "add", path);
  git(f.source, "commit", "-m", `change ${path}`);
  git(f.source, "push", "origin", "main");
  return git(f.source, "rev-parse", "HEAD");
}

describe("repository drift contract", () => {
  test("accepts and journals an exact pinned checkout", () => {
    const f = fixture();
    const result = check(f);
    expect(result.action).toBe("proceed");
    expect(result.status).toBe("exact");
    expect(result.journaled).toBe(true);
    const records = readFileSync(f.ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0].execution_id).toBe("exec-1");
    expect(records[0].journaled).toBe(true);
  });

  test("fast-forwards scope-preserving remote drift", () => {
    const f = fixture();
    const remoteHead = upstreamCommit(f, "docs/notes.md", "unrelated\n");
    git(f.worktree, "checkout", "--detach");
    const result = check(f);
    expect(result.action).toBe("proceed");
    expect(result.status).toBe("fast_forward_reconciled");
    expect(result.changed_paths).toEqual(["docs/notes.md"]);
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(git(f.worktree, "rev-parse", "refs/remotes/origin/main")).toBe(remoteHead);
  });

  test("reports a safe reconciliation without mutating a dry-run worktree", () => {
    const f = fixture();
    const remoteHead = upstreamCommit(f, "docs/notes.md", "unrelated\n");
    const result = checkSeedRepositoryDrift({
      seedPath: f.seedPath,
      workspaceRoot: f.worktree,
      dryRun: true,
      identifier: "ZOU-TEST",
    }, { ledgerPath: f.ledgerPath });
    expect(result.action).toBe("proceed");
    expect(result.status).toBe("fast_forward_safe");
    expect(result.reason).toBe("scope_preserving_remote_drift_would_fast_forward");
    expect(result.remote_commit).toBe(remoteHead);
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.pin);
    expect(git(f.worktree, "rev-parse", "refs/remotes/origin/main")).toBe(remoteHead);
  });

  test("fails closed when remote drift overlaps declared scope", () => {
    const f = fixture();
    upstreamCommit(f, "src/index.ts", "export const value = 2;\n");
    const result = check(f);
    expect(result.action).toBe("hold");
    expect(result.reason).toBe("repository_drift_overlaps_declared_scope");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.pin);
  });

  test("fails closed on a dirty or divergent checkout", () => {
    const dirty = fixture();
    writeFileSync(join(dirty.worktree, "untracked.ts"), "dirty\n");
    expect(check(dirty).reason).toBe("worktree_dirty");

    const divergent = fixture();
    writeFileSync(join(divergent.worktree, "local.md"), "local\n");
    git(divergent.worktree, "add", "local.md");
    git(divergent.worktree, "commit", "-m", "local divergence");
    upstreamCommit(divergent, "docs/remote.md", "remote\n");
    expect(check(divergent).reason).toBe("worktree_cannot_fast_forward_to_remote");
  });

  test("fails closed when the declared repository does not match origin", () => {
    const f = fixture();
    f.writeSeed("src/index.ts", "marlandoj/not-this-repository");
    expect(check(f).reason).toBe("repository_identity_mismatch");
  });

  test("preserves legacy seeds without silently fabricating pins", () => {
    const f = fixture();
    writeFileSync(f.seedPath, "id: legacy\ntasks: []\n");
    const result = check(f);
    expect(result.action).toBe("proceed");
    expect(result.status).toBe("not_declared");
    expect(result.journaled).toBe(false);
  });

  test("journal failure blocks execution even when repository state is exact", () => {
    const f = fixture();
    const result = check(f, { append: () => { throw new Error("disk unavailable"); } });
    expect(result.action).toBe("hold");
    expect(result.reason).toBe("repository_drift_journal_failed");
    expect(result.prior_reason).toBe("repository_state_matches_pin");
    expect(result.journal_error).toBe("disk unavailable");
  });
});
