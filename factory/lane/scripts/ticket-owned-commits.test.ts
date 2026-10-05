import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureExecutionBaseCommit } from "./execution-provenance";
import { resolveRangeBase, resolveShippingRepository, selectTicketOwnedCommits, type GitRunner, type ShippingExecutionRecord } from "./ticket-owned-commits";

const BASE = "a".repeat(40);
const TICKET = "b".repeat(40);
const PRIOR = "c".repeat(40);

function record(overrides: Partial<ShippingExecutionRecord> = {}): ShippingExecutionRecord {
  return {
    execution_id: "exec-test",
    identifier: "ZOU-656",
    branch_name: "factory/zou-656",
    base_commit: BASE,
    started_at: "2026-07-14T16:00:00.000Z",
    completed_at: "2026-07-14T16:10:00.000Z",
    ...overrides,
  };
}

function fakeGit(): GitRunner {
  return (args) => {
    const command = args.join(" ");
    if (command === `rev-list --merges ${BASE}..factory/zou-656`) return "";
    if (command === `rev-list --reverse --no-merges ${BASE}..factory/zou-656`) return TICKET;
    if (command === "cherry origin/main factory/zou-656") return `+ ${PRIOR}\n+ ${TICKET}`;
    if (command === `show -s --format=%cI ${TICKET}`) return "2026-07-14T16:05:00+00:00";
    if (command.startsWith("rev-parse --verify ")) return args.at(-1)!.replace("^{commit}", "");
    if (command === `merge-base --is-ancestor ${BASE} factory/zou-656`) return "";
    throw new Error(`unexpected git command: ${command}`);
  };
}

describe("execution provenance", () => {
  test("captures HEAD for a new execution", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "factory-provenance-"));
    expect(captureExecutionBaseCommit({ executionId: "new", stateDir, workdir: "/repo", git: () => BASE })).toBe(BASE);
  });

  test("captures an explicit canonical ref for a new execution", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "factory-provenance-"));
    const calls: string[][] = [];
    const git = (args: string[]) => {
      calls.push(args);
      return BASE;
    };
    expect(captureExecutionBaseCommit({
      executionId: "new",
      stateDir,
      workdir: "/repo",
      ref: "origin/main",
      git,
    })).toBe(BASE);
    expect(calls).toEqual([["rev-parse", "origin/main"]]);
  });

  test("preserves the original base across retries", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "factory-provenance-"));
    writeFileSync(join(stateDir, "exec-retry.json"), JSON.stringify({ base_commit: PRIOR, repo_path: "/repo" }));
    expect(captureExecutionBaseCommit({ executionId: "retry", stateDir, workdir: "/repo", git: () => BASE })).toBe(PRIOR);
  });

  test("fails closed when retry provenance belongs to another repository", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "factory-provenance-"));
    writeFileSync(join(stateDir, "exec-retry.json"), JSON.stringify({ base_commit: PRIOR, repo_path: "/repo/a" }));
    expect(() => captureExecutionBaseCommit({ executionId: "retry", stateDir, workdir: "/repo/b", git: () => BASE })).toThrow(
      "repository mismatch",
    );
  });
});

describe("ticket-owned commit selection", () => {
  test("uses the persisted execution repository beneath an authorized root", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shipping-root-"));
    const repo = join(root, "Sites", "zouroboros-ai");
    mkdirSync(repo, { recursive: true });
    expect(resolveShippingRepository(record({ repo_path: repo }), root)).toBe(repo);
  });

  test("rejects an execution repository outside the authorized root", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-shipping-root-"));
    const other = mkdtempSync(join(tmpdir(), "factory-shipping-other-"));
    expect(() => resolveShippingRepository(record({ repo_path: other }), root)).toThrow("outside the authorized repository root");
  });

  test("fails closed without persisted repository identity or an explicit legacy repository", () => {
    expect(() => resolveShippingRepository(record())).toThrow("missing repo_path");
    expect(resolveShippingRepository(record(), "/home/workspace")).toBe("/home/workspace");
    expect(() => resolveShippingRepository(record({ repo_path: "Sites/zouroboros-ai" }))).toThrow("must be absolute");
  });

  test("intersects the base range with patch-novel commits", () => {
    const result = selectTicketOwnedCommits(record(), fakeGit());
    expect(result.commits).toEqual([{ sha: TICKET, committed_at: "2026-07-14T16:05:00+00:00" }]);
    expect(result.commits.some((commit) => commit.sha === PRIOR)).toBe(false);
  });

  test("fails closed without execution-boundary provenance", () => {
    expect(() => selectTicketOwnedCommits(record({ base_commit: null }), fakeGit())).toThrow("missing a valid base_commit");
  });

  test("fails closed when a selected commit is outside the execution window", () => {
    const git = fakeGit();
    expect(() => selectTicketOwnedCommits(record({ completed_at: "2026-07-14T16:01:00.000Z" }), git)).toThrow("outside the execution window");
  });
});

describe("range base when the branch did not start from the recorded base", () => {
  const DIVERGED = "d".repeat(40);

  // The executor creates the branch from whatever the target repo has checked
  // out, while base_commit is captured from origin/main at dispatch. In a
  // serial lane those differ on every ticket after the first.
  function strandedGit(extra: Record<string, string> = {}): GitRunner {
    return (args) => {
      const command = args.join(" ");
      if (command in extra) return extra[command]!;
      if (command === `merge-base --is-ancestor ${BASE} factory/zou-656`) throw new Error("not an ancestor");
      if (command === "merge-base origin/main factory/zou-656") return DIVERGED;
      if (command === `rev-list --merges ${DIVERGED}..factory/zou-656`) return "";
      if (command === `rev-list --reverse --no-merges ${DIVERGED}..factory/zou-656`) return `${PRIOR}\n${TICKET}`;
      if (command === "cherry origin/main factory/zou-656") return `- ${PRIOR}\n+ ${TICKET}`;
      if (command === `show -s --format=%cI ${TICKET}`) return "2026-07-14T16:05:00+00:00";
      if (command.startsWith("rev-parse --verify ")) return args.at(-1)!.replace("^{commit}", "");
      throw new Error(`unexpected git command: ${command}`);
    };
  }

  test("prefers the recorded base when it really is an ancestor", () => {
    expect(resolveRangeBase(record(), fakeGit(), "origin/main")).toBe(BASE);
  });

  test("falls back to the merge-base instead of throwing", () => {
    expect(resolveRangeBase(record(), strandedGit(), "origin/main")).toBe(DIVERGED);
  });

  test("still selects only the patch-novel commit from the wider range", () => {
    const result = selectTicketOwnedCommits(record(), strandedGit());
    // PRIOR is the previous ticket, already squashed onto main — `git cherry`
    // marks it "-" and it must not be shipped again.
    expect(result.commits.map((c) => c.sha)).toEqual([TICKET]);
    expect(result.range_base).toBe(DIVERGED);
    expect(result.base_commit).toBe(BASE);
  });

  test("a branch sharing no history with main is still a hard failure", () => {
    const orphan = strandedGit({ "merge-base origin/main factory/zou-656": "" });
    expect(() => resolveRangeBase(record(), orphan, "origin/main")).toThrow("shares no history");
  });

  test("the execution window still rejects a commit from outside the run", () => {
    const stale = strandedGit({ [`show -s --format=%cI ${TICKET}`]: "2026-07-14T15:00:00+00:00" });
    expect(() => selectTicketOwnedCommits(record(), stale)).toThrow("outside the execution window");
  });
});
