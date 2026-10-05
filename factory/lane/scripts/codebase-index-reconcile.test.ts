import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codebaseIndexReceiptPath,
  readCodebaseIndexCandidates,
  reconcileCodebaseIndexes,
  type CommandRunner,
} from "./codebase-index-reconcile";

const directories: string[] = [];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codebase-index-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeShippingReceipt(stateDir: string, repoPath: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "shipping-request-exec-index.json"), `${JSON.stringify({
    execution_id: "exec-index",
    identifier: "ZOU-1046",
    status: "succeeded",
    outcome: "merge_queued",
    pr_number: 77,
    pr_url: "https://github.com/marlandoj/example/pull/77",
    repo_path: repoPath,
    ...overrides,
  }, null, 2)}\n`);
}

function harness(input: {
  mergeSha: () => string;
  prState?: () => string;
  indexStatus?: () => string;
  head?: () => string;
  commonDirectory?: (cwd: string | undefined) => string;
  architectureProject?: () => string;
  architectureNodes?: () => number;
}) {
  const calls: Array<{ program: string; args: string[]; cwd?: string }> = [];
  let mirrorHead = input.mergeSha();
  const command: CommandRunner = (program, args, cwd) => {
    calls.push({ program, args: [...args], cwd });
    if (program === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { status: 0, stdout: `${cwd}\n`, stderr: "" };
    }
    if (program === "git" && args[0] === "rev-parse" && args[1] === "--git-common-dir") {
      return {
        status: 0,
        stdout: `${input.commonDirectory?.(cwd) ?? "/fake/shared-git-dir"}\n`,
        stderr: "",
      };
    }
    if (program === "gh" && args[0] === "repo") {
      return { status: 0, stdout: "marlandoj/example\n", stderr: "" };
    }
    if (program === "gh" && args[0] === "pr") {
      const state = input.prState?.() ?? "MERGED";
      return {
        status: 0,
        stdout: `${JSON.stringify({
          state,
          mergeCommit: state === "MERGED" ? { oid: input.mergeSha() } : null,
        })}\n`,
        stderr: "",
      };
    }
    if (program === "git" && args[0] === "worktree" && args[1] === "add") {
      mkdirSync(args[3]!, { recursive: true });
      mirrorHead = args[4]!;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (program === "git" && args[0] === "checkout") {
      mirrorHead = args[2]!;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (program === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
      return { status: 0, stdout: `${input.head?.() ?? mirrorHead}\n`, stderr: "" };
    }
    if (program === "git" && args[0] === "status") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (program === "/fake/codebase-memory-mcp" && args[1] === "index_repository") {
      return {
        status: 0,
        stdout: `${JSON.stringify({ project: "factory-mirror-example", status: input.indexStatus?.() ?? "indexed" })}\n`,
        stderr: "",
      };
    }
    if (program === "/fake/codebase-memory-mcp" && args[1] === "get_architecture") {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          project: input.architectureProject?.() ?? "factory-mirror-example",
          total_nodes: input.architectureNodes?.() ?? 12,
        })}\n`,
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, command };
}

function run(root: string, command: CommandRunner) {
  return reconcileCodebaseIndexes({
    stateDir: join(root, "state"),
    authorizedRoot: root,
    mirrorRoot: join(root, "mirrors"),
    cbmBin: "/fake/codebase-memory-mcp",
    command,
    enabled: true,
    lock: false,
    now: () => "2026-07-31T18:00:00.000Z",
  });
}

describe("post-merge Codebase MCP reconciliation", () => {
  test("discovers only successfully shipped PRs with repository identity", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    const state = join(root, "state");
    mkdirSync(repo);
    writeShippingReceipt(state, repo);
    writeFileSync(join(state, "shipping-request-older.json"), JSON.stringify({
      execution_id: "exec-older",
      identifier: "ZOU-OLD",
      status: "succeeded",
      outcome: "already_merged",
      pr_number: 70,
      pr_url: "https://github.com/marlandoj/example/pull/70",
      repo_path: repo,
    }));
    writeFileSync(join(state, "shipping-request-skipped.json"), JSON.stringify({
      execution_id: "exec-skipped",
      identifier: "ZOU-X",
      status: "skipped",
      outcome: "no_patch_novel",
      pr_number: null,
      repo_path: repo,
    }));

    expect(readCodebaseIndexCandidates(state)).toEqual([{
      execution_id: "exec-index",
      identifier: "ZOU-1046",
      repo_path: repo,
      pr_number: 77,
      pr_url: "https://github.com/marlandoj/example/pull/77",
    }]);
  });

  test("registers the exact merge SHA, verifies the graph, and deduplicates replays", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({ mergeSha: () => SHA_A });

    const first = run(root, fake.command);
    const second = run(root, fake.command);

    expect(first).toMatchObject({ ok: true, indexed: 1, skipped: 0 });
    expect(second).toMatchObject({ ok: true, indexed: 0, skipped: 1 });
    expect(fake.calls.filter((call) => call.args[1] === "index_repository")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.args[1] === "get_architecture")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.args[0] === "worktree" && call.args[1] === "add")).toHaveLength(1);
    expect(fake.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add")?.args[3]).toMatch(
      new RegExp(`/mirrors/marlandoj/example--[0-9a-f]{16}$`),
    );
    expect(fake.calls).toContainEqual(expect.objectContaining({
      program: "git",
      args: ["fetch", "https://github.com/marlandoj/example.git", SHA_A],
    }));
    expect(fake.calls.some((call) => call.program === "gh" && call.args[0] === "repo")).toBe(false);
    expect(JSON.parse(readFileSync(codebaseIndexReceiptPath(repo, join(root, "state")), "utf8"))).toMatchObject({
      status: "succeeded",
      merge_sha: SHA_A,
      graph_project: "factory-mirror-example",
      attempt_count: 1,
    });
  });

  test("refreshes the same clean mirror when a later merge lands", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo);
    let mergeSha = SHA_A;
    const fake = harness({ mergeSha: () => mergeSha });

    expect(run(root, fake.command).indexed).toBe(1);
    mergeSha = SHA_B;
    expect(run(root, fake.command).indexed).toBe(1);

    expect(fake.calls).toContainEqual(expect.objectContaining({
      program: "git",
      args: ["checkout", "--detach", SHA_B],
    }));
    expect(fake.calls.filter((call) => call.args[1] === "index_repository")).toHaveLength(2);
    expect(JSON.parse(readFileSync(codebaseIndexReceiptPath(repo, join(root, "state")), "utf8"))).toMatchObject({
      status: "succeeded",
      merge_sha: SHA_B,
      attempt_count: 2,
    });
  });

  test("leaves an auto-merge PR pending until GitHub proves it merged", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({ mergeSha: () => SHA_A, prState: () => "OPEN" });

    const report = run(root, fake.command);

    expect(report).toMatchObject({ ok: true, pending: 1, indexed: 0 });
    expect(report.results[0]).toMatchObject({ status: "pending", merge_sha: null });
    expect(fake.calls.some((call) => call.args[1] === "index_repository")).toBe(false);
  });

  test("fails closed when the durable PR URL disagrees with its PR number", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo, {
      pr_url: "https://github.com/marlandoj/example/pull/76",
    });
    const fake = harness({ mergeSha: () => SHA_A });

    const report = run(root, fake.command);

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.error).toContain("does not match PR #77");
    expect(fake.calls.some((call) => call.program === "gh" && call.args[0] === "pr")).toBe(false);
  });

  test("falls back to the checkout identity when legacy receipts have no PR URL", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo, { pr_url: null });
    const fake = harness({ mergeSha: () => SHA_A });

    const report = run(root, fake.command);

    expect(report.ok).toBe(true);
    expect(fake.calls.some((call) => call.program === "gh" && call.args[0] === "repo")).toBe(true);
  });

  test("records degraded indexing as a retryable failure and succeeds on the next pass", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo);
    let status = "degraded";
    const fake = harness({ mergeSha: () => SHA_A, indexStatus: () => status });

    const failed = run(root, fake.command);
    status = "indexed";
    const recovered = run(root, fake.command);

    expect(failed).toMatchObject({ ok: false, indexed: 0 });
    expect(failed.failures[0]?.error).toContain("did not pass");
    expect(recovered).toMatchObject({ ok: true, indexed: 1 });
    expect(JSON.parse(readFileSync(codebaseIndexReceiptPath(repo, join(root, "state")), "utf8"))).toMatchObject({
      status: "succeeded",
      merge_sha: SHA_A,
      attempt_count: 2,
      error: null,
    });
  });

  test("fails closed when the clean mirror HEAD differs from GitHub's merge SHA", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({ mergeSha: () => SHA_A, head: () => SHA_B });

    const report = run(root, fake.command);

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.error).toContain("does not match merge SHA");
    expect(fake.calls.some((call) => call.args[1] === "index_repository")).toBe(false);
  });

  test("selects an ownership-safe sibling when the legacy mirror belongs to another Git repository", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    const legacyMirror = join(root, "mirrors", "marlandoj", "example");
    mkdirSync(repo);
    mkdirSync(legacyMirror, { recursive: true });
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({
      mergeSha: () => SHA_A,
      commonDirectory: (cwd) => {
        if (cwd === repo) return "/fake/source-git-dir";
        if (cwd === legacyMirror) return "/fake/workspace-root-git-dir";
        return "/fake/source-git-dir";
      },
    });

    const report = run(root, fake.command);
    const worktreeAdd = fake.calls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
    const indexCall = fake.calls.find((call) => call.args[1] === "index_repository");
    const ownedMirror = worktreeAdd?.args[3];

    expect(report).toMatchObject({ ok: true, indexed: 1 });
    expect(ownedMirror).toMatch(new RegExp(`/mirrors/marlandoj/example--[0-9a-f]{16}$`));
    expect(ownedMirror).not.toBe(legacyMirror);
    expect(indexCall?.args[2]).toContain(ownedMirror);
    expect(fake.calls.some((call) =>
      call.cwd === legacyMirror && ["checkout", "status", "worktree"].includes(call.args[0] ?? ""),
    )).toBe(false);
    expect(fake.calls.some((call) => call.cwd === repo && call.args[0] === "status")).toBe(false);
  });

  test("reuses a legacy mirror when it belongs to the same Git repository", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    const legacyMirror = join(root, "mirrors", "marlandoj", "example");
    mkdirSync(repo);
    mkdirSync(legacyMirror, { recursive: true });
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({ mergeSha: () => SHA_A });

    const report = run(root, fake.command);
    const indexCall = fake.calls.find((call) => call.args[1] === "index_repository");

    expect(report).toMatchObject({ ok: true, indexed: 1 });
    expect(fake.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "add")).toBe(false);
    expect(fake.calls.some((call) => call.cwd === legacyMirror && call.args[0] === "checkout")).toBe(true);
    expect(indexCall?.args[2]).toContain(legacyMirror);
  });

  test("fails before mutating a colliding ownership-safe sibling", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    const legacyMirror = join(root, "mirrors", "marlandoj", "example");
    const sourceCommonDirectory = "/fake/source-git-dir";
    const repositoryKey = createHash("sha256").update(sourceCommonDirectory).digest("hex").slice(0, 16);
    const ownedMirror = `${legacyMirror}--${repositoryKey}`;
    mkdirSync(repo);
    mkdirSync(legacyMirror, { recursive: true });
    mkdirSync(ownedMirror, { recursive: true });
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({
      mergeSha: () => SHA_A,
      commonDirectory: (cwd) => {
        if (cwd === repo) return sourceCommonDirectory;
        if (cwd === legacyMirror) return "/fake/workspace-root-git-dir";
        if (cwd === ownedMirror) return "/fake/foreign-git-dir";
        return sourceCommonDirectory;
      },
    });

    const report = run(root, fake.command);

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.error).toContain("does not belong to the source repository");
    expect(fake.calls.some((call) => call.cwd === ownedMirror && call.args[0] === "status")).toBe(false);
    expect(fake.calls.some((call) => call.cwd === ownedMirror && call.args[0] === "checkout")).toBe(false);
    expect(fake.calls.some((call) => call.args[1] === "index_repository")).toBe(false);
    expect(JSON.parse(readFileSync(codebaseIndexReceiptPath(repo, join(root, "state")), "utf8"))).toMatchObject({
      status: "failed",
      mirror_path: ownedMirror,
    });
  });

  test("fails closed when scoped graph verification returns no indexed nodes", () => {
    const root = temporaryRoot();
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeShippingReceipt(join(root, "state"), repo);
    const fake = harness({ mergeSha: () => SHA_A, architectureNodes: () => 0 });

    const report = run(root, fake.command);

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.error).toContain("found no indexed nodes");
  });

  test("rejects invalid index modes without leaving a reconciliation lock", () => {
    const root = temporaryRoot();
    const stateDir = join(root, "state");

    expect(() => reconcileCodebaseIndexes({
      stateDir,
      indexMode: "invalid" as "full",
    })).toThrow("invalid Codebase MCP index mode");
    expect(() => readFileSync(join(stateDir, "codebase-index-reconcile.lock"))).toThrow();
  });
});
