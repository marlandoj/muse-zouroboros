import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionLifecycle, transitionExecutionLifecycle } from "./execution-lifecycle";
import { loadCampaigns, loadQueue, saveCampaigns, saveQueue, writeJsonAtomic } from "./pool-queue";
import { saveAssignment, type Assignment } from "./pool-worker";
import {
  recoverExistingPullRequest,
  type ExistingPullRequestEvidence,
  type RecoveryCommandRunner,
  type VerificationRecoveryInput,
} from "./pool-verification-recovery";

const BASE = "a".repeat(40);
const IMPLEMENTATION = "b".repeat(40);
const HEAD = "c".repeat(40);
const NOW = "2026-08-21T03:30:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SF003_POOL_STATE_DIR;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pool-verification-recovery-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const poolDir = join(stateDir, "pool");
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  process.env.SF003_POOL_STATE_DIR = poolDir;

  let lifecycle = createExecutionLifecycle("accepted", NOW);
  lifecycle = transitionExecutionLifecycle(lifecycle, "pool_enqueued", {
    kind: "pool",
    reference: "campaign:ZOU-1462",
    recorded_at: NOW,
  }, { now: NOW });
  writeJsonAtomic(join(stateDir, "exec-exec-test1462.json"), {
    ...lifecycle,
    execution_id: "exec-test1462",
    identifier: "ZOU-1462",
    ticket_id: "linear-test",
    ticket_title: "Speeder",
    branch_name: null,
    base_commit: null,
    repo_path: worktree,
    started_at: NOW,
    completed_at: NOW,
    stage: "pool-enqueued",
    status: "pool-enqueued",
    error: null,
  });
  saveCampaigns({
    "ZOU-1462": {
      campaign_id: "ZOU-1462",
      ticket_id: "linear-test",
      identifier: "ZOU-1462",
      seed_path: null,
      tasks: ["DIRECT"],
      cost_ceiling_usd: 5,
      cost_spent_usd: 0,
      state: "parked",
      created_at: NOW,
      execution_id: "exec-test1462",
      target_repository: join(root, "stale-campaign-worktree"),
      base_commit: BASE,
      validation_commands: [{ label: "wrong", command: "bun", args: ["missing.ts"] }],
    },
  });
  saveQueue([{
    campaign_id: "ZOU-1462",
    task_id: "DIRECT",
    name: "Speeder",
    description: "existing work",
    deps: [],
    state: "parked",
    attempts: 2,
    park_reason: "dispatch: transport failure; explicit retry required",
    created_at: NOW,
    updated_at: NOW,
  }]);
  const assignment: Assignment = {
    assignment_id: "asg-ZOU-1462-DIRECT-a0-test",
    campaign_id: "ZOU-1462",
    task_id: "DIRECT",
    model: "test-model",
    attempt: 0,
    started_at: NOW,
    heartbeat_path: join(poolDir, "heartbeats", "test"),
    result_path: join(poolDir, "results", "test.json"),
    timeout_min: 30,
    completed_at: NOW,
    outcome: "failure",
    mock: false,
    base_commit: BASE,
    worktree_path: worktree,
    failure: { kind: "mechanical_validation", retryable: true, detail: "wrong repository validator" },
  };
  saveAssignment(assignment);

  const pr: ExistingPullRequestEvidence = {
    number: 18,
    url: "https://github.com/marlandoj/arcade-games/pull/18",
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/zou-1462-speeder",
    headRefOid: HEAD,
    baseRefName: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
  };
  const run: RecoveryCommandRunner = (command, args) => {
    if (command === "gh" && args[0] === "repo") return { status: 0, stdout: "marlandoj/arcade-games\n", stderr: "" };
    if (command === "gh" && args[0] === "pr") return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
    if (command === "git" && args[0] === "status") return { status: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (command === "git" && args[0] === "merge-base") return { status: 0, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "diff" && args[1] === "--quiet") return { status: 1, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "diff") return { status: 0, stdout: "", stderr: "" };
    if (command === "bun") return { status: 0, stdout: "valid\n", stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected ${command} ${args.join(" ")}` };
  };
  const input: VerificationRecoveryInput = {
    recovery_id: "zou-1462-verification-only-20260821",
    execution_id: "exec-test1462",
    campaign_id: "ZOU-1462",
    task_id: "DIRECT",
    assignment_id: assignment.assignment_id,
    implementation_commit: IMPLEMENTATION,
    pr_number: 18,
    branch: "feat/zou-1462-speeder",
    operator: "marlandoj",
    note: "existing PR and browser acceptance verified",
    validation_commands: [{ label: "registry", command: "bun", args: ["scripts/validate-registry.ts"] }],
  };
  return { root, stateDir, poolDir, worktree, pr, run, input };
}

describe("pool verification-only recovery", () => {
  test("reconciles an existing verified PR without creating an assignment", () => {
    const f = fixture();
    const beforeAssignments = readFileSync(join(f.poolDir, "assignments", `${f.input.assignment_id}.json`), "utf8");
    const result = recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    expect(result.idempotent).toBeFalse();
    expect(loadQueue()[0].state).toBe("done");
    expect(loadCampaigns()["ZOU-1462"].state).toBe("complete");
    expect(loadCampaigns()["ZOU-1462"].target_repository).toBe(f.worktree);
    expect(loadCampaigns()["ZOU-1462"].validation_commands).toEqual(f.input.validation_commands);
    const execution = JSON.parse(readFileSync(join(f.stateDir, "exec-exec-test1462.json"), "utf8"));
    expect(execution.state).toBe("pr_ready");
    expect(execution.pr_number).toBe(18);
    expect(execution.branch_name).toBe("feat/zou-1462-speeder");
    expect(execution.repo_path).toBe(f.worktree);
    expect(JSON.parse(readFileSync(join(f.stateDir, "shipping-request-exec-test1462.json"), "utf8")).status).toBe("queued");
    expect(readFileSync(join(f.poolDir, "assignments", `${f.input.assignment_id}.json`), "utf8")).toBe(beforeAssignments);
  });

  test("repeating the same recovery is idempotent", () => {
    const f = fixture();
    recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    const repeated = recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    expect(repeated.idempotent).toBeTrue();
    expect(readFileSync(join(f.poolDir, "verification-recoveries.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("rebinds a completed campaign after its verified PR merges", () => {
    const f = fixture();
    recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    const receiptPath = join(f.stateDir, "shipping-request-exec-test1462.json");
    const originalReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeJsonAtomic(receiptPath, {
      ...originalReceipt,
      status: "succeeded",
      step: "complete",
      outcome: "existing_open_pr",
      pr_number: f.pr.number,
      pr_url: f.pr.url,
      completed_at: NOW,
      updated_at: NOW,
    });
    const campaigns = loadCampaigns();
    campaigns["ZOU-1462"].target_repository = join(f.root, "stale-campaign-worktree");
    saveCampaigns(campaigns);
    f.pr.state = "MERGED";
    const result = recoverExistingPullRequest({
      ...f.input,
      recovery_id: "zou-1462-merged-pr-rebind-20260821",
      note: "merged PR target rebind",
    }, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    expect(result.idempotent).toBeFalse();
    expect(loadCampaigns()["ZOU-1462"].target_repository).toBe(f.worktree);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
      ...originalReceipt,
      status: "succeeded",
      step: "complete",
      outcome: "existing_open_pr",
      pr_number: f.pr.number,
      pr_url: f.pr.url,
      completed_at: NOW,
      updated_at: NOW,
    });
    expect(readFileSync(join(f.poolDir, "verification-recoveries.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("fails closed when a pr_ready rebind lacks a terminal shipping receipt", () => {
    const f = fixture();
    recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    const campaigns = loadCampaigns();
    const staleTarget = join(f.root, "stale-campaign-worktree");
    campaigns["ZOU-1462"].target_repository = staleTarget;
    saveCampaigns(campaigns);
    f.pr.state = "MERGED";
    expect(() => recoverExistingPullRequest({
      ...f.input,
      recovery_id: "zou-1462-merged-pr-rebind-20260821",
      note: "merged PR target rebind",
    }, { stateDir: f.stateDir, run: f.run, now: () => NOW }))
      .toThrow("pr_ready rebind requires an existing terminal shipping receipt");
    expect(loadCampaigns()["ZOU-1462"].target_repository).toBe(staleTarget);
  });

  test("fails closed when a terminal shipping receipt is bound to different PR evidence", () => {
    const f = fixture();
    recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    const receiptPath = join(f.stateDir, "shipping-request-exec-test1462.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeJsonAtomic(receiptPath, {
      ...receipt,
      status: "succeeded",
      step: "complete",
      outcome: "existing_open_pr",
      pr_number: 99,
      completed_at: NOW,
      updated_at: NOW,
    });
    const campaigns = loadCampaigns();
    const staleTarget = join(f.root, "stale-campaign-worktree");
    campaigns["ZOU-1462"].target_repository = staleTarget;
    saveCampaigns(campaigns);
    f.pr.state = "MERGED";
    expect(() => recoverExistingPullRequest({
      ...f.input,
      recovery_id: "zou-1462-merged-pr-rebind-20260821",
      note: "merged PR target rebind",
    }, { stateDir: f.stateDir, run: f.run, now: () => NOW }))
      .toThrow("pr_ready rebind shipping receipt does not match the verified execution and pull request");
    expect(loadCampaigns()["ZOU-1462"].target_repository).toBe(staleTarget);
  });

  test("fails closed when a pr_ready terminal-receipt rebind still has an open PR", () => {
    const f = fixture();
    recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: f.run, now: () => NOW });
    const executionPath = join(f.stateDir, "exec-exec-test1462.json");
    const receiptPath = join(f.stateDir, "shipping-request-exec-test1462.json");
    const eventPath = join(f.poolDir, "verification-recoveries.jsonl");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeJsonAtomic(receiptPath, {
      ...receipt,
      status: "succeeded",
      step: "complete",
      outcome: "existing_open_pr",
      pr_number: f.pr.number,
      pr_url: f.pr.url,
      completed_at: NOW,
      updated_at: NOW,
    });
    const campaigns = loadCampaigns();
    const staleTarget = join(f.root, "stale-campaign-worktree");
    campaigns["ZOU-1462"].target_repository = staleTarget;
    saveCampaigns(campaigns);
    const executionBefore = readFileSync(executionPath, "utf8");
    const receiptBefore = readFileSync(receiptPath, "utf8");
    const queueBefore = JSON.stringify(loadQueue());
    const eventsBefore = readFileSync(eventPath, "utf8");
    expect(() => recoverExistingPullRequest({
      ...f.input,
      recovery_id: "zou-1462-open-pr-rebind-20260821",
      note: "open PR rebind must fail closed",
    }, { stateDir: f.stateDir, run: f.run, now: () => NOW }))
      .toThrow("pr_ready rebind requires a merged pull request");
    expect(loadCampaigns()["ZOU-1462"].target_repository).toBe(staleTarget);
    expect(JSON.stringify(loadQueue())).toBe(queueBefore);
    expect(readFileSync(executionPath, "utf8")).toBe(executionBefore);
    expect(readFileSync(receiptPath, "utf8")).toBe(receiptBefore);
    expect(readFileSync(eventPath, "utf8")).toBe(eventsBefore);
  });

  test("fails closed when the retained worktree does not match the PR head", () => {
    const f = fixture();
    const mismatch: RecoveryCommandRunner = (command, args, options) => {
      if (command === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" };
      return f.run(command, args, options);
    };
    expect(() => recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: mismatch, now: () => NOW }))
      .toThrow("does not match PR head");
    expect(loadQueue()[0].state).toBe("parked");
    expect(loadCampaigns()["ZOU-1462"].state).toBe("parked");
  });

  test("fails closed when a repository validator fails", () => {
    const f = fixture();
    const failing: RecoveryCommandRunner = (command, args, options) => {
      if (command === "bun") return { status: 1, stdout: "", stderr: "validator failed" };
      return f.run(command, args, options);
    };
    expect(() => recoverExistingPullRequest(f.input, { stateDir: f.stateDir, run: failing, now: () => NOW }))
      .toThrow("repository validation failed");
    expect(loadQueue()[0].state).toBe("parked");
  });
});
