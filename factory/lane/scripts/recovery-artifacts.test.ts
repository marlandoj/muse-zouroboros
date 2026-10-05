import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSeedFile } from "./dedup-gate";
import { reapDir } from "./reap-stale-execs";
import { atomicPublishSeed, recoverExecutionArtifacts } from "./recovery-artifacts";
import { activeWorktreeRecords, appendWorktreeLedger } from "./execution-repository";
import { acquireTicketClaim } from "./ticket-claim";

const roots: string[] = [];

function sandbox(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Recovery Test",
      GIT_AUTHOR_EMAIL: "recovery@example.invalid",
      GIT_COMMITTER_NAME: "Recovery Test",
      GIT_COMMITTER_EMAIL: "recovery@example.invalid",
    },
  });
}

describe("atomic seed publication", () => {
  test("publishes a parseable seed and leaves no temporary file", () => {
    const root = sandbox("factory-seed-atomic-");
    const seed = join(root, "seed.yaml");
    atomicPublishSeed(seed, "version: 1\ntasks:\n  - id: T1\n");
    expect(Bun.YAML.parse(readFileSync(seed, "utf8"))).toEqual({ version: 1, tasks: [{ id: "T1" }] });
    expect(readdirSync(root)).toEqual(["seed.yaml"]);
  });

  test("invalid replacement never clobbers the live seed", () => {
    const root = sandbox("factory-seed-rollback-");
    const seed = join(root, "seed.yaml");
    writeFileSync(seed, "version: 1\ntasks: []\n");
    expect(() => atomicPublishSeed(seed, "version: 1\ntasks: [\n")).toThrow();
    expect(readFileSync(seed, "utf8")).toBe("version: 1\ntasks: []\n");
    expect(readdirSync(root)).toEqual(["seed.yaml"]);
  });
});

describe("artifact-complete recovery", () => {
  test("quarantines a corrupt seed only after a durable hashed manifest", () => {
    const root = sandbox("factory-recovery-seed-");
    const seed = join(root, "seed-zou-1.yaml");
    const temporaryRoot = join(root, "tmp");
    mkdirSync(temporaryRoot);
    writeFileSync(seed, "tasks: [\n");
    const originalHash = sha256(seed);
    const runTmp = join(temporaryRoot, "executor-exec-abc12-output.tmp");
    writeFileSync(runTmp, "partial executor output");

    const result = recoverExecutionArtifacts(
      { execution_id: "exec-abc12", identifier: "ZOU-1", seed_path: seed },
      {
        recoveryRoot: join(root, "recovery"),
        repositoryRoots: [],
        temporaryRoots: [temporaryRoot],
        now: () => new Date("2026-07-13T04:00:00.000Z"),
      },
    );

    expect(existsSync(result.manifestPath)).toBe(true);
    expect(existsSync(seed)).toBe(false);
    const quarantined = result.manifest.artifacts.find((artifact) => artifact.kind === "seed_quarantine");
    expect(quarantined?.sha256).toBe(originalHash);
    expect(quarantined?.recovery_path && existsSync(quarantined.recovery_path)).toBe(true);
    expect(quarantined?.recovery_path && sha256(quarantined.recovery_path)).toBe(originalHash);
    expect(result.manifest.artifacts.find((artifact) => artifact.kind === "run_tmp")?.sha256).toBe(sha256(runTmp));
    expect(result.manifest.retry_decision).toBe("retry");

    writeFileSync(seed, "version: 1\ntasks: []\n");
    const replay = recoverExecutionArtifacts(
      { execution_id: "exec-abc12", identifier: "ZOU-1", seed_path: seed },
      { recoveryRoot: join(root, "recovery"), repositoryRoots: [], temporaryRoots: [temporaryRoot] },
    );
    expect(replay.reused).toBe(true);
    expect(replay.manifest).toEqual(result.manifest);
    expect(readFileSync(seed, "utf8")).toBe("version: 1\ntasks: []\n");
  });

  test("preserves dirty tracked and untracked work without cleaning the repository", () => {
    const root = sandbox("factory-recovery-worktree-");
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "factory/zou-2");
    writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
    git(repo, "add", "tracked.ts");
    git(repo, "commit", "-q", "-m", "fixture");
    writeFileSync(join(repo, "tracked.ts"), "export const value = 2;\n");
    writeFileSync(join(repo, "untracked.md"), "operator work\n");

    const result = recoverExecutionArtifacts(
      {
        execution_id: "exec-dirty2",
        identifier: "ZOU-2",
        branch_name: "factory/zou-2",
        repo_path: repo,
      },
      { recoveryRoot: join(root, "recovery"), repositoryRoots: [repo], temporaryRoots: [] },
    );

    expect(result.manifest.retry_decision).toBe("manual_review");
    expect(result.manifest.worktree?.dirty).toBe(true);
    expect(result.manifest.worktree?.patch_path && existsSync(result.manifest.worktree.patch_path)).toBe(true);
    const untracked = result.manifest.artifacts.find((artifact) => artifact.kind === "worktree_untracked");
    expect(untracked?.recovery_path && existsSync(untracked.recovery_path)).toBe(true);
    expect(readFileSync(join(repo, "tracked.ts"), "utf8")).toContain("value = 2");
    expect(readFileSync(join(repo, "untracked.md"), "utf8")).toBe("operator work\n");
    expect(git(repo, "status", "--porcelain")).toContain("tracked.ts");
  });

  test("does not attribute dirty primary checkout files to a missing execution worktree", () => {
    const root = sandbox("factory-recovery-missing-worktree-");
    const repo = join(root, "repo");
    const worktree = join(root, "ticket-worktree");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "tracked.ts"), "export const value = 1;\n");
    git(repo, "add", "tracked.ts");
    git(repo, "commit", "-q", "-m", "fixture");
    git(repo, "worktree", "add", "-q", "-b", "factory/zou-4", worktree, "HEAD");
    rmSync(worktree, { recursive: true, force: true });
    writeFileSync(join(repo, "tracked.ts"), "export const operatorValue = 2;\n");
    writeFileSync(join(repo, "operator-notes.md"), "unrelated local work\n");

    const result = recoverExecutionArtifacts(
      {
        execution_id: "exec-missing4",
        identifier: "ZOU-4",
        branch_name: "factory/zou-4",
        repo_path: repo,
      },
      { recoveryRoot: join(root, "recovery"), repositoryRoots: [repo], temporaryRoots: [] },
    );

    expect(result.manifest.retry_decision).toBe("retry");
    expect(result.manifest.worktree).toBeNull();
    expect(result.manifest.artifacts.filter((artifact) => artifact.kind.startsWith("worktree_"))).toEqual([]);
    expect(readFileSync(join(repo, "tracked.ts"), "utf8")).toContain("operatorValue");
    expect(readFileSync(join(repo, "operator-notes.md"), "utf8")).toBe("unrelated local work\n");
  });
});

describe("reaper integration", () => {
  test("does not pre-empt a run before its declared executor timeout plus grace", () => {
    const root = sandbox("factory-reaper-budget-");
    const state = join(root, "state");
    mkdirSync(state);
    const startedAt = "2026-07-17T19:50:00.000Z";
    const recordPath = join(state, "exec-live731.json");
    writeFileSync(recordPath, JSON.stringify({
      execution_id: "live731",
      identifier: "ZOU-731",
      status: "executing",
      stage: "executing",
      started_at: startedAt,
      completed_at: null,
      executor_timeout_ms: 45 * 60_000,
    }));

    const early = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-17T20:21:00.000Z"),
      processAlive: () => false,
    });
    expect(early.reaped).toHaveLength(0);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).status).toBe("executing");

    const expired = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-17T20:41:00.000Z"),
      processAlive: () => false,
    });
    expect(expired.reaped).toHaveLength(1);
  });

  test("reaps a corrupt-seed run with advisory null hash and one retry", () => {
    const root = sandbox("factory-reaper-corrupt-");
    const state = join(root, "state");
    mkdirSync(state);
    const seed = join(root, "seed-zou-3.yaml");
    writeFileSync(seed, "tasks: [\n");
    const recordPath = join(state, "exec-dead333.json");
    writeFileSync(
      recordPath,
      JSON.stringify({
        execution_id: "dead333",
        identifier: "ZOU-3",
        status: "executing",
        stage: "executing",
        started_at: "2026-07-13T02:00:00.000Z",
        completed_at: null,
        seed_path: seed,
      }),
    );
    expect(hashSeedFile(seed)).toBeNull();

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-13T04:00:00.000Z"),
      processAlive: () => false,
    });

    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(result.reaped).toHaveLength(1);
    expect(record.status).toBe("failed");
    expect(record.retry_eligible).toBe(true);
    expect(existsSync(record.recovery_manifest)).toBe(true);
    expect(existsSync(seed)).toBe(false);
    expect(reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-13T04:20:00.000Z"),
      processAlive: () => false,
    }).reaped).toHaveLength(0);
  });

  test("fails closed when the recovery manifest cannot become durable", () => {
    const root = sandbox("factory-reaper-failclosed-");
    const state = join(root, "state");
    mkdirSync(state);
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "block");
    const recordPath = join(state, "exec-dead444.json");
    const original = {
      execution_id: "dead444",
      identifier: "ZOU-4",
      status: "executing",
      started_at: "2026-07-13T02:00:00.000Z",
      completed_at: null,
    };
    writeFileSync(recordPath, JSON.stringify(original));

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(blocker, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-13T04:00:00.000Z"),
      processAlive: () => false,
    });

    expect(result.reaped).toHaveLength(0);
    expect(result.recovery_failed).toBe(1);
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(original);
  });

  test("production reaper reclaims a terminal execution's isolated worktree", () => {
    const root = sandbox("factory-reaper-terminal-worktree-");
    const state = join(root, "state");
    const repo = join(root, "repo");
    const worktreesRoot = join(root, ".factory-worktrees");
    const worktree = join(worktreesRoot, "repo-linear-done");
    mkdirSync(state);
    mkdirSync(repo);
    mkdirSync(worktree, { recursive: true });
    appendWorktreeLedger({
      ts: "2026-07-13T02:00:00.000Z",
      repoPath: repo,
      ticketId: "linear-done",
      worktreePath: worktree,
      baseRef: "origin/main",
      baseCommit: "a".repeat(40),
      status: "active",
    }, { workspaceRoot: root, worktreesRoot });
    writeFileSync(join(state, "exec-done.json"), JSON.stringify({
      execution_id: "done",
      ticket_id: "linear-done",
      identifier: "ZOU-DONE",
      repo_path: worktree,
      status: "failed",
      started_at: "2026-07-13T02:00:00.000Z",
      completed_at: "2026-07-13T02:10:00.000Z",
    }));

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-13T04:00:00.000Z"),
      processAlive: () => false,
      worktreeOptions: {
        workspaceRoot: root,
        worktreesRoot,
        run: (_command, args) => args.includes("status")
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
      },
    });

    expect(result.reaped).toHaveLength(0);
    expect(result.cleanup_failed).toBe(0);
    expect(result.worktrees_reclaimed).toEqual([worktree]);
    expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toEqual([]);
  });

  test("production reaper preserves a held execution's resumable worktree", () => {
    const root = sandbox("factory-reaper-held-worktree-");
    const state = join(root, "state");
    const repo = join(root, "repo");
    const worktreesRoot = join(root, ".factory-worktrees");
    const worktree = join(worktreesRoot, "repo-linear-held");
    mkdirSync(state);
    mkdirSync(repo);
    mkdirSync(worktree, { recursive: true });
    appendWorktreeLedger({
      ts: "2026-07-13T02:00:00.000Z",
      repoPath: repo,
      ticketId: "linear-held",
      worktreePath: worktree,
      baseRef: "origin/main",
      baseCommit: "a".repeat(40),
      status: "active",
    }, { workspaceRoot: root, worktreesRoot });
    writeFileSync(join(state, "exec-held.json"), JSON.stringify({
      execution_id: "held",
      ticket_id: "linear-held",
      identifier: "ZOU-HELD",
      repo_path: worktree,
      status: "held",
      started_at: "2026-07-13T02:00:00.000Z",
      completed_at: null,
    }));

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      nowMs: Date.parse("2026-07-13T04:00:00.000Z"),
      processAlive: () => false,
      worktreeOptions: { workspaceRoot: root, worktreesRoot },
    });
    expect(result.worktrees_reclaimed).toEqual([]);
    expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toHaveLength(1);
  });

  test("stale execution remains in flight when isolated worktree cleanup fails", () => {
    const root = sandbox("factory-reaper-cleanup-fail-");
    const state = join(root, "state");
    const repo = join(root, "repo");
    const worktreesRoot = join(root, ".factory-worktrees");
    const worktree = join(worktreesRoot, "repo-linear-stale");
    mkdirSync(state);
    mkdirSync(repo);
    mkdirSync(worktree, { recursive: true });
    appendWorktreeLedger({
      ts: "2026-07-13T02:00:00.000Z",
      repoPath: repo,
      ticketId: "linear-stale",
      worktreePath: worktree,
      baseRef: "origin/main",
      baseCommit: "a".repeat(40),
      status: "active",
    }, { workspaceRoot: root, worktreesRoot });
    const recordPath = join(state, "exec-stale.json");
    const original = {
      execution_id: "stale",
      ticket_id: "linear-stale",
      identifier: "ZOU-STALE",
      repo_path: worktree,
      status: "executing",
      started_at: "2026-07-13T02:00:00.000Z",
      completed_at: null,
    };
    writeFileSync(recordPath, JSON.stringify(original));

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-13T04:00:00.000Z"),
      processAlive: () => false,
      worktreeOptions: {
        workspaceRoot: root,
        worktreesRoot,
        run: (_command, args) => args.includes("status")
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 1, stdout: "", stderr: "worktree locked" },
      },
    });

    expect(result.reaped).toHaveLength(0);
    expect(result.cleanup_failed).toBe(1);
    expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(original);
    expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toHaveLength(1);
  });

  test("stale execution is reaped only after its isolated worktree is reclaimed", () => {
    const root = sandbox("factory-reaper-cleanup-success-");
    const state = join(root, "state");
    const repo = join(root, "repo");
    const worktreesRoot = join(root, ".factory-worktrees");
    const worktree = join(worktreesRoot, "repo-linear-stale-ok");
    mkdirSync(state);
    mkdirSync(repo);
    mkdirSync(worktree, { recursive: true });
    appendWorktreeLedger({
      ts: "2026-07-13T02:00:00.000Z",
      repoPath: repo,
      ticketId: "linear-stale-ok",
      worktreePath: worktree,
      baseRef: "origin/main",
      baseCommit: "a".repeat(40),
      status: "active",
    }, { workspaceRoot: root, worktreesRoot });
    const recordPath = join(state, "exec-stale-ok.json");
    writeFileSync(recordPath, JSON.stringify({
      execution_id: "stale-ok",
      ticket_id: "linear-stale-ok",
      identifier: "ZOU-STALE-OK",
      repo_path: worktree,
      status: "executing",
      started_at: "2026-07-13T02:00:00.000Z",
      completed_at: null,
    }));

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: Date.parse("2026-07-13T04:00:00.000Z"),
      processAlive: () => false,
      worktreeOptions: {
        workspaceRoot: root,
        worktreesRoot,
        run: () => ({ status: 0, stdout: "", stderr: "" }),
      },
    });

    expect(result.reaped).toHaveLength(1);
    expect(result.cleanup_failed).toBe(0);
    expect(result.worktrees_reclaimed).toEqual([worktree]);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).status).toBe("failed");
    expect(activeWorktreeRecords({ workspaceRoot: root, worktreesRoot })).toEqual([]);
  });

  test("production reaper reconciles an expired ticket claim", () => {
    const root = sandbox("factory-reaper-ticket-claim-");
    const state = join(root, "state");
    mkdirSync(state);
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    expect(acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-killed" },
      { stateDir: state, nowMs: start, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      nowMs: start + 6 * 60_000,
      processAlive: () => false,
    });

    expect(result.claims_reclaimed).toEqual(["linear-uuid"]);
    expect(result.claim_reconcile_failed).toBe(0);
    expect(acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-next" },
      { stateDir: state, nowMs: start + 6 * 60_000, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");
  });

  test("production reaper binds terminalization to an enforce-mode claim release", () => {
    const root = sandbox("factory-reaper-proven-ticket-claim-");
    const state = join(root, "state");
    mkdirSync(state);
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    expect(acquireTicketClaim(
      { ticket_id: "linear-proven-reaper", execution_id: "dead-claim" },
      { stateDir: state, nowMs: start, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");
    writeFileSync(join(state, "exec-dead-claim.json"), JSON.stringify({
      execution_id: "dead-claim",
      ticket_id: "linear-proven-reaper",
      identifier: "ZOU-PROVEN",
      status: "executing",
      stage: "executing",
      started_at: "2026-08-01T00:00:00.000Z",
      completed_at: null,
    }));
    writeFileSync(join(state, "lane-utilization.jsonl.current-cycle"), "cycle-reaper\n");
    writeFileSync(join(state, "lane-utilization.jsonl"), `${JSON.stringify({
      cycle_id: "cycle-reaper",
      phase: "open",
      ts: "2026-08-01T00:00:00.000Z",
    })}\n`);

    const result = reapDir(state, {
      staleMinutes: 5,
      dryRun: false,
      recoveryRoot: join(root, "recovery"),
      repositoryRoots: [],
      temporaryRoots: [],
      nowMs: start + 10 * 60_000,
      processAlive: () => false,
      claimMutationEvidenceMode: "enforce",
    });

    expect(result.reaped).toHaveLength(1);
    expect(result.claims_reclaimed).toEqual(["linear-proven-reaper"]);
    expect(result.claim_reconcile_failed).toBe(0);
    expect(result.claim_evidence_receipts).toHaveLength(2);
    expect(result.claim_would_reject).toEqual([]);
    expect(result.claim_evidence_receipts.every((path) => existsSync(path))).toBe(true);
  });

  test("production reaper enforce mode preserves an expired claim without terminal proof", () => {
    const root = sandbox("factory-reaper-unproven-ticket-claim-");
    const state = join(root, "state");
    mkdirSync(state);
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const acquired = acquireTicketClaim(
      { ticket_id: "linear-unproven-reaper", execution_id: "missing-terminal" },
      { stateDir: state, nowMs: start, leaseMs: 5 * 60_000 },
    );
    if (acquired.status !== "acquired") throw new Error("expected claim");

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      nowMs: start + 6 * 60_000,
      processAlive: () => false,
      claimMutationEvidenceMode: "enforce",
    });

    expect(result.claims_reclaimed).toEqual([]);
    expect(result.claim_reconcile_failed).toBe(1);
    expect(result.claim_would_reject[0]?.ticket_id).toBe("linear-unproven-reaper");
    expect(existsSync(acquired.claim_path)).toBe(true);
  });

  test("production reaper preserves an expired claim owned by a live PID", () => {
    const root = sandbox("factory-reaper-live-ticket-claim-");
    const state = join(root, "state");
    mkdirSync(state);
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    expect(acquireTicketClaim(
      { ticket_id: "linear-live-uuid", execution_id: "exec-live-owner" },
      { stateDir: state, nowMs: start, leaseMs: 5 * 60_000, pid: process.pid },
    ).status).toBe("acquired");

    const result = reapDir(state, {
      staleMinutes: 20,
      dryRun: false,
      nowMs: start + 6 * 60_000,
    });

    expect(result.claims_reclaimed).toEqual([]);
    expect(result.claim_reconcile_failed).toBe(0);
  });
});
