import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { receiptShadowExternalConfigHash, type ReceiptShadowExternalConfig } from "./runtime-config";
import { buildReceiptShadowReport } from "./run-receipt-shadow-report";
import { createExecutionLifecycle, transitionExecutionLifecycle } from "./execution-lifecycle";
import {
  PROJECT_DELEGATION_ACTION_SCHEMA,
  PROJECT_DELEGATION_EVIDENCE_SCHEMA,
  PROJECT_DELEGATION_PERSONAS,
  PROJECT_DELEGATION_RECEIPT_SCHEMA,
  signProjectDelegationReceipt,
  type ProjectDelegationActionPayload,
  type ProjectDelegationEvidence,
  type ProjectDelegationReceipt,
} from "../../../Skills/zouroboros-governance/scripts/project-delegation-receipt";
import {
  buildPullRequestTitle,
  loadShippingAttempt,
  MAX_PULL_REQUEST_TITLE_LENGTH,
  queueShippingRequest,
  runPrePrChangeQuiz,
  runReadyQueue,
  runShippingRequest,
  shipExecution,
  type CommandResult,
  type CommandRunner,
  type Shipper,
  type ShippingExecution,
} from "./ship-ready-runner";

const directories: string[] = [];
const firstTimestamp = "2026-07-26T10:10:15.667Z";
const secondTimestamp = "2026-07-26T10:11:15.667Z";

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function delegatedRemoteArtifacts(input: {
  root: string;
  seedPath: string;
  repository: string;
  baseCommit: string;
  commitShas: string[];
  issuedAtUtc: string;
  expiresAtUtc: string;
}): {
  paths: ShippingExecution["project_delegation_remote_action"];
  keyPath: string;
  auditPath: string;
  operationalStatePaths: { revocations_path: string; project_status_path: string };
  seedSha256: string;
  mandateSha256: string;
} {
  const projectName = "Zouroboros Platform Independence";
  const paths = {
    manifesto: join(input.root, "ZOUROBOROS.md"),
    constitution: join(input.root, "CONSTITUTION.md"),
    mandate: join(input.root, "mandate.json"),
    activation: join(input.root, "activation.json"),
    action: join(input.root, "l2-action.json"),
    evidence: join(input.root, "l2-evidence.json"),
    receipt: join(input.root, "l2-receipt.json"),
    revocations: join(input.root, "revocations.json"),
    projectStatus: join(input.root, "project-status.json"),
  };
  const keyPath = join(input.root, "delegation.hmac");
  const auditPath = join(input.root, "audit", "verification.jsonl");
  writeFileSync(paths.manifesto, "manifesto\n");
  writeFileSync(paths.constitution, "constitution\n");
  writeFileSync(keyPath, Buffer.alloc(48, 9), { mode: 0o600 });
  const mandate = {
    schema: "zouroboros.project-delegation-mandate/v1",
    mandate_id: "zpi-delegation-e2e",
    project: { name: projectName, repository_allowlist: [input.repository] },
    governing_authority: {
      manifesto_path: paths.manifesto,
      manifesto_sha256: fileDigest(paths.manifesto),
      constitution_path: paths.constitution,
      constitution_sha256: fileDigest(paths.constitution),
      fail_closed: true,
    },
    delegates: PROJECT_DELEGATION_PERSONAS.map((persona) => ({ persona_id: persona.id, persona_name: persona.name })),
    decision_rule: {
      mutation_approval_quorum: 2,
      distinct_authenticated_sessions_required: true,
      configured_persona_model_required: true,
      rejection_blocks: true,
      model_consensus_is_authority: false,
      vendor_diversity_is_authority: false,
    },
    budget_and_retry: {
      new_cloud_or_infrastructure_spend_usd: 0,
      mutation_retries_after_ambiguous_effect: 0,
      model_based_moa_authorized: false,
      model_consensus_gate_authorized: false,
    },
    lifecycle: { expires_at_utc: "2026-11-30T23:59:59Z" },
  };
  writeJson(paths.mandate, mandate);
  const mandateSha256 = fileDigest(paths.mandate);
  writeJson(paths.activation, {
    schema: "zouroboros.project-delegation-mandate-activation/v1",
    mandate_id: mandate.mandate_id,
    mandate_sha256: mandateSha256,
    governing_authority: {
      manifesto_sha256: mandate.governing_authority.manifesto_sha256,
      constitution_sha256: mandate.governing_authority.constitution_sha256,
      verify_docs_ok: true,
    },
    decision: "activate",
    effective_at_utc: "2026-08-27T00:00:00Z",
    expires_at_utc: "2026-11-30T23:59:59Z",
    initial_transition: { delegated_receipts_operational: true },
    fail_closed: true,
  });
  writeJson(paths.revocations, { schema: "zouroboros.project-delegation-revocations/v1", revoked_mandate_ids: [] });
  writeJson(paths.projectStatus, { schema: "zouroboros.project-delegation-project-status/v1", projects: { [projectName]: { closed: false } } });
  chmodSync(paths.revocations, 0o600);
  chmodSync(paths.projectStatus, 0o600);
  const seedSha256 = fileDigest(input.seedPath);
  const action: ProjectDelegationActionPayload = {
    schema: PROJECT_DELEGATION_ACTION_SCHEMA,
    operation: "feature_branch_push_draft_pr",
    risk_lane: "L2_remote_reversible",
    ticket: "ZOU-REVIEW",
    project_name: projectName,
    repository: input.repository,
    seed_sha256: seedSha256,
    target_branch: "feat/zou-307-delegation-enforcement-r1",
    base_branch: "main",
    base_commit: input.baseCommit,
    commit_shas: input.commitShas,
    expected_remote_head: null,
    draft: true,
    ready_for_review: false,
    merge: false,
    protected_main_write: false,
    branch_policy_change: false,
    production_mutation: false,
    spend_usd: 0,
    secret_authority_change: false,
    destructive_deletion: false,
    scope_expansion: false,
    force_push: false,
  };
  writeJson(paths.action, action);
  const evidence: ProjectDelegationEvidence = {
    schema: PROJECT_DELEGATION_EVIDENCE_SCHEMA,
    seed_sha256: seedSha256,
    action_payload_sha256: fileDigest(paths.action),
    reviews: [
      { persona_id: PROJECT_DELEGATION_PERSONAS[0].id, session_id: "session-ai-e2e", configured_model: "ai-model", decision: "approve" },
      { persona_id: PROJECT_DELEGATION_PERSONAS[1].id, session_id: "session-zbr-e2e", configured_model: "zbr-model", decision: "approve" },
    ],
  };
  writeJson(paths.evidence, evidence);
  const unsigned: Omit<ProjectDelegationReceipt, "signature"> = {
    schema: PROJECT_DELEGATION_RECEIPT_SCHEMA,
    mandate_id: mandate.mandate_id,
    mandate_sha256: mandateSha256,
    mandate_activation_receipt_sha256: fileDigest(paths.activation),
    project_name: projectName,
    repository: input.repository,
    risk_lane: "L2_remote_reversible",
    seed_path: input.seedPath,
    seed_sha256: seedSha256,
    action_payload_sha256: fileDigest(paths.action),
    evidence_sha256: fileDigest(paths.evidence),
    reviewer_persona_ids: evidence.reviews.map((review) => review.persona_id),
    reviewer_session_ids: evidence.reviews.map((review) => review.session_id),
    reviewer_configured_models: evidence.reviews.map((review) => review.configured_model),
    issued_at_utc: input.issuedAtUtc,
    expires_at_utc: input.expiresAtUtc,
    nonce: "nonce-l2-e2e",
    decision: "approve",
  };
  writeJson(paths.receipt, { ...unsigned, signature: signProjectDelegationReceipt(unsigned, keyPath) });
  return {
    paths: {
      mandate_path: paths.mandate,
      activation_receipt_path: paths.activation,
      receipt_path: paths.receipt,
      action_payload_path: paths.action,
      evidence_path: paths.evidence,
    },
    keyPath,
    auditPath,
    operationalStatePaths: { revocations_path: paths.revocations, project_status_path: paths.projectStatus },
    seedSha256,
    mandateSha256,
  };
}

function delegatedShippingFixture(actionCommitShas?: (commits: string[]) => string[], nowMs = Date.now()) {
  const issuedAtUtc = new Date(nowMs - 5 * 60_000).toISOString();
  const expiresAtUtc = new Date(nowMs + 60 * 60_000).toISOString();
  const root = temporaryDirectory("shipping-delegated-e2e-");
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const stateDir = join(root, "state");
  const runGit = (args: string[], cwd = root) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  runGit(["init", "--bare", origin]);
  runGit(["clone", origin, repo]);
  runGit(["config", "user.email", "test@example.com"], repo);
  runGit(["config", "user.name", "Test"], repo);
  writeFileSync(join(repo, "proof.txt"), "base\n");
  runGit(["add", "proof.txt"], repo);
  runGit(["commit", "-m", "base"], repo);
  runGit(["branch", "-M", "main"], repo);
  runGit(["push", "-u", "origin", "main"], repo);
  const baseCommit = runGit(["rev-parse", "HEAD"], repo);
  runGit(["switch", "-c", "factory/zou-review"], repo);
  writeFileSync(join(repo, "proof.txt"), "base\npredecessor\n");
  runGit(["add", "proof.txt"], repo);
  runGit(["commit", "-m", "predecessor"], repo);
  const predecessorCommit = runGit(["rev-parse", "HEAD"], repo);
  writeFileSync(join(repo, "proof.txt"), "base\npredecessor\nreviewed\n");
  runGit(["add", "proof.txt"], repo);
  runGit(["commit", "-m", "reviewed"], repo);
  const finalCommit = runGit(["rev-parse", "HEAD"], repo);
  const seedPath = join(root, "seed.yaml");
  writeFileSync(seedPath, "tasks:\n  - id: T1\n    name: task\n    deps: []\n");
  const commitShas = actionCommitShas?.([predecessorCommit, finalCommit]) ?? [predecessorCommit, finalCommit];
  const artifacts = delegatedRemoteArtifacts({
    root,
    seedPath,
    repository: "marlandoj/zouroboros-workspace",
    baseCommit,
    commitShas,
    issuedAtUtc,
    expiresAtUtc,
  });
  const execution = verifiedExecution(repo);
  execution.started_at = runGit(["show", "-s", "--format=%cI", baseCommit], repo);
  execution.completed_at = runGit(["show", "-s", "--format=%cI", finalCommit], repo);
  execution.base_commit = baseCommit;
  execution.seed_path = seedPath;
  execution.project_delegation = {
    paths: artifacts.paths!,
    l1_admission: { seed_sha256: artifacts.seedSha256, mandate_sha256: artifacts.mandateSha256 },
  };
  execution.project_delegation_remote_action = artifacts.paths;
  const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
  return {
    root,
    origin,
    repo,
    stateDir,
    runGit,
    baseCommit,
    predecessorCommit,
    finalCommit,
    artifacts,
    execution,
    receipt,
    receiptValidity: { issuedAtUtc, expiresAtUtc, nowMs },
  };
}

function delegatedCommand(
  fixture: ReturnType<typeof delegatedShippingFixture>,
  options: {
    existingPrRows?: unknown[];
    preimageResult?: { status: number; stdout: string; stderr: string };
    absentRefPushResult?: { status: number; stdout: string; stderr: string };
    prView?: Record<string, unknown>;
  } = {},
) {
  const calls: string[] = [];
  const state = { prCreates: 0, refCreates: 0 };
  const command: CommandRunner = (program, args, cwd = fixture.repo) => {
    calls.push(`${program} ${args.join(" ")}`);
    if (program === "gh") {
      if (args[0] === "repo") return { status: 0, stdout: "marlandoj/zouroboros-workspace\n", stderr: "" };
      if (args[0] === "pr" && args[1] === "list") {
        return { status: 0, stdout: `${JSON.stringify(options.existingPrRows ?? [])}\n`, stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        state.prCreates++;
        return { status: 0, stdout: "https://github.com/marlandoj/zouroboros-workspace/pull/700\n", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        return {
          status: 0,
          stdout: `${JSON.stringify(options.prView ?? {
            number: 700,
            url: "https://github.com/marlandoj/zouroboros-workspace/pull/700",
            state: "OPEN",
            isDraft: true,
            headRefName: "feat/zou-307-delegation-enforcement-r1",
            headRefOid: fixture.finalCommit,
            baseRefName: "main",
          })}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    if (program === "git" && args[0] === "config" && args[2] === "remote.origin.url") {
      return { status: 0, stdout: "marlandoj/zouroboros-workspace\n", stderr: "" };
    }
    if (program === "git" && args[0] === "ls-remote" && state.refCreates === 0 && options.preimageResult) {
      return options.preimageResult;
    }
    if (program === "git" && args[0] === "push" && args[1]?.startsWith("--force-with-lease=refs/heads/")) {
      state.refCreates++;
      if (options.absentRefPushResult) return options.absentRefPushResult;
    }
    const result = Bun.spawnSync([program, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  return { calls, state, command };
}

function shipDelegatedFixture(
  fixture: ReturnType<typeof delegatedShippingFixture>,
  command: CommandRunner,
) {
  return shipExecution(fixture.execution, fixture.receipt, {
    stateDir: fixture.stateDir,
    authorizedRoot: fixture.root,
    command,
    tempRoot: fixture.root,
    changeQuizMode: "off",
    projectDelegationKeyPath: fixture.artifacts.keyPath,
    projectDelegationAuditLogPath: fixture.artifacts.auditPath,
    projectDelegationOperationalStatePathsForTest: fixture.artifacts.operationalStatePaths,
  });
}

const commitChainCases: Array<[string, (commits: string[]) => string[]]> = [
  ["missing", (commits) => [commits.at(-1)!]],
  ["extra", (commits) => [...commits, "a".repeat(40)]],
  ["reordered", (commits) => [...commits].reverse()],
  ["drifted", (commits) => ["b".repeat(40), commits.at(-1)!]],
];

const preimageProbeCases: Array<[string, CommandResult]> = [
  ["transport status", { status: 1, stdout: "", stderr: "transport unavailable" }],
  ["authentication status", { status: 128, stdout: "", stderr: "authentication failed" }],
  ["empty success output", { status: 0, stdout: "", stderr: "" }],
];

const existingPrMismatchCases: Array<[string, Record<string, unknown>]> = [
  ["merged state", { state: "MERGED" }],
  ["ready state", { isDraft: false }],
  ["wrong branch", { headRefName: "feat/wrong" }],
  ["wrong head", { headRefOid: "c".repeat(40) }],
  ["wrong base", { baseRefName: "release" }],
];

const absentRefPushFailureCases: Array<[string, CommandResult, RegExp]> = [
  ["lease conflict", { status: 1, stdout: "", stderr: "rejected: stale info" }, /rejected: stale info/],
  ["timeout", { status: 124, stdout: "", stderr: "request timed out" }, /request timed out/],
  ["false success", { status: 0, stdout: "", stderr: "" }, /remote readback failed/],
];

function shadowEnvironment(stateDir: string, dbPath: string, registryPath: string): Record<string, string> {
  const policyPath = join(stateDir, "shadow-policy.json");
  const configPath = join(stateDir, "shadow-config.json");
  writeFileSync(policyPath, readFileSync(join(import.meta.dir, "../../../Skills/zouroboros-governance/config/autonomy-policy.json")));
  const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const config: ReceiptShadowExternalConfig = {
    contract_id: "zouroboros-run-receipt-shadow-config/v1",
    version: 1,
    updated_at: firstTimestamp,
    updated_by: "test",
    mode: "shadow",
    activation_manifest_sha256: "a".repeat(64),
    effective_config_sha256: "0".repeat(64),
    automation_id: "7760679f-6ac8-461c-a567-43fae21c3eee",
    runtime: "zo-native",
    policy_path: policyPath,
    policy_sha256: fileHash(policyPath),
    database_path: dbPath,
    registry_path: registryPath,
    registry_sha256: fileHash(registryPath),
    cohort_amendment_sha256: "b".repeat(64),
    qualification_window_days: 225,
    required_operations_per_class: 30,
    max_plans_per_harvest: 12,
    max_database_bytes: 64 * 1024 * 1024,
    write_high_water_bytes: 56 * 1024 * 1024,
    github_readback_enabled: true,
  };
  config.effective_config_sha256 = receiptShadowExternalConfigHash(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    NODE_ENV: "test",
    FACTORY_RECEIPT_SHADOW_TEST_ROOT: stateDir,
    FACTORY_RECEIPT_SHADOW_MODE: "shadow",
    FACTORY_RECEIPT_SHADOW_AUTOMATION_ID: "7760679f-6ac8-461c-a567-43fae21c3eee",
    FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: config.activation_manifest_sha256,
    FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: config.effective_config_sha256,
    FACTORY_RECEIPT_SHADOW_CONFIG_PATH: configPath,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function verifiedExecution(stateDir: string): ShippingExecution {
  let lifecycle = createExecutionLifecycle("verified", "2026-07-26T09:00:00.000Z");
  lifecycle = transitionExecutionLifecycle(lifecycle, "implementation_complete", {
    kind: "implementation",
    reference: "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    recorded_at: "2026-07-26T09:30:00.000Z",
  }, { now: "2026-07-26T09:30:00.000Z" });
  lifecycle = transitionExecutionLifecycle(lifecycle, "verified", {
    kind: "manual-approval",
    reference: "marlandoj",
    recorded_at: firstTimestamp,
  }, { now: firstTimestamp });
  const execution: ShippingExecution = {
    ...lifecycle,
    execution_id: "exec-review",
    identifier: "ZOU-REVIEW",
    ticket_id: "ticket-review",
    branch_name: "factory/zou-review",
    repo_path: stateDir,
    base_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    started_at: "2026-07-26T09:00:00.000Z",
    completed_at: firstTimestamp,
    stage: "verified",
    status: "verified",
    pr_number: null,
    pr_url: null,
  };
  writeFileSync(join(stateDir, "exec-exec-review.json"), `${JSON.stringify(execution, null, 2)}\n`);
  return execution;
}

function clock(...timestamps: string[]): () => string {
  let index = 0;
  return () => timestamps[Math.min(index++, timestamps.length - 1)]!;
}

const promotionPending: Shipper = async () => ({
  outcome: "promotion_pending",
  pr_number: 431,
  pr_url: "https://github.com/marlandoj/zouroboros/pull/431",
});

describe("ship-ready deterministic runner", () => {
  test("change-quiz off returns before reading the diff or writing artifacts", async () => {
    const stateDir = temporaryDirectory("shipping-quiz-off-");
    const execution = verifiedExecution(stateDir);
    let diffReads = 0;
    const result = await runPrePrChangeQuiz(execution, () => {
      diffReads++;
      return "diff";
    }, {
      stateDir,
      changeQuizMode: "off",
      changeQuizEvaluationsDir: join(stateDir, "evaluations"),
    });
    expect(result).toBeNull();
    expect(diffReads).toBe(0);
    expect(existsSync(join(stateDir, "evaluations"))).toBe(false);
  });

  test("advisory change-quiz persists evidence and never blocks PR creation", async () => {
    const stateDir = temporaryDirectory("shipping-quiz-advisory-");
    const evaluationsDir = join(stateDir, "evaluations");
    const execution = verifiedExecution(stateDir);
    execution.ticket_title = "Change one file";
    execution.change_quiz_answers = {
      files_modified: ["scripts/example.ts"],
      primary_change: "Changes the example behavior.",
      scope_not_changed: "Leaves unrelated behavior unchanged.",
      side_effects: "The example caller could regress.",
      control_flags: [],
    };
    const result = await runPrePrChangeQuiz(execution, () => [
      "diff --git a/scripts/example.ts b/scripts/example.ts",
      "--- a/scripts/example.ts",
      "+++ b/scripts/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n"), {
      stateDir,
      changeQuizMode: "advisory",
      changeQuizEvaluationsDir: evaluationsDir,
      now: () => secondTimestamp,
      changeQuizGrader: async ({ questions }) => ({
        scores: Object.fromEntries(questions.map((question) => [question.id, 1])),
        model_id: "test",
        cost_usd: 0.001,
      }),
    });
    expect(result?.artifact).toMatchObject({ passed: true, blocking: false, score: 1 });
    expect(existsSync(result!.artifact_path)).toBe(true);
    expect(JSON.parse(readFileSync(join(evaluationsDir, "change-quiz-rollout.json"), "utf8"))).toMatchObject({
      advisory_started_at: secondTimestamp,
      real_samples: 1,
      eligible_for_enforcement: false,
    });
  });

  test("enforcement fails closed until the five-day advisory gate matures", async () => {
    const stateDir = temporaryDirectory("shipping-quiz-enforce-");
    const execution = verifiedExecution(stateDir);
    execution.change_quiz_answers = {
      files_modified: ["scripts/example.ts"],
      primary_change: "Changes the example behavior.",
      scope_not_changed: "Leaves unrelated behavior unchanged.",
      side_effects: "The example caller could regress.",
      control_flags: [],
    };
    await expect(runPrePrChangeQuiz(execution, () => [
      "--- a/scripts/example.ts",
      "+++ b/scripts/example.ts",
      "+export const value = 2;",
    ].join("\n"), {
      stateDir,
      changeQuizMode: "enforce",
      changeQuizEvaluationsDir: join(stateDir, "evaluations"),
      now: () => secondTimestamp,
      changeQuizGrader: async ({ questions }) => ({
        scores: Object.fromEntries(questions.map((question) => [question.id, 1])),
        model_id: "test",
        cost_usd: null,
      }),
    })).rejects.toThrow("enforcement is not mature");
  });

  test("bounds generated pull request titles to GitHub's maximum", () => {
    const title = buildPullRequestTitle({
      identifier: "ZOU-933",
      execution_id: "exec-d50452ec",
      result_summary: "x".repeat(400),
    });

    expect(Array.from(title)).toHaveLength(MAX_PULL_REQUEST_TITLE_LENGTH);
    expect(title.startsWith("ZOU-933: ")).toBe(true);
  });

  test("uses the execution id when no result summary exists", () => {
    expect(buildPullRequestTitle({
      identifier: "ZOU-REVIEW",
      execution_id: "exec-review",
      result_summary: null,
    })).toBe("ZOU-REVIEW: factory execution exec-review");
  });

  test("manual approval creates one durable, idempotent shipping request", () => {
    const stateDir = temporaryDirectory("shipping-request-");
    const execution = verifiedExecution(stateDir);
    const first = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const second = queueShippingRequest(execution, { stateDir, now: () => secondTimestamp });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "queued",
      step: "queued",
      attempt_count: 0,
      execution_id: "exec-review",
      identifier: "ZOU-REVIEW",
      source_branch: "factory/zou-review",
    });
    expect(JSON.parse(readFileSync(join(stateDir, "shipping-request-exec-review.json"), "utf8"))).toEqual(first);
  });

  test("a successful request persists its PR and is not executed twice", async () => {
    const stateDir = temporaryDirectory("shipping-success-");
    const execution = verifiedExecution(stateDir);
    queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    let calls = 0;
    const shipper: Shipper = async (...args) => {
      calls++;
      return promotionPending(...args);
    };

    const first = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp, secondTimestamp),
      shipper,
    });
    const second = await runShippingRequest("exec-review", { stateDir, shipper });

    expect(calls).toBe(1);
    expect(first).toMatchObject({
      status: "succeeded",
      outcome: "promotion_pending",
      pr_number: 431,
      attempt_count: 1,
    });
    expect(second).toEqual(first);
  });

  test("a failed request remains visible and can be explicitly requeued", async () => {
    const stateDir = temporaryDirectory("shipping-retry-");
    const execution = verifiedExecution(stateDir);
    queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });

    await expect(runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp),
      shipper: async () => {
        throw new Error("push rejected");
      },
    })).rejects.toThrow("push rejected");
    expect(loadShippingAttempt("exec-review", stateDir)).toMatchObject({
      status: "failed",
      attempt_count: 1,
      error: "push rejected",
    });

    expect(queueShippingRequest(execution, { stateDir, now: () => secondTimestamp }).status).toBe("queued");
    const recovered = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(secondTimestamp, secondTimestamp),
      shipper: promotionPending,
    });
    expect(recovered).toMatchObject({ status: "succeeded", attempt_count: 2, error: null });
  });

  test("shadow shipping keeps retries under one operation and terminalizes only success", async () => {
    const stateDir = temporaryDirectory("shipping-shadow-retry-");
    const registryPath = join(stateDir, "shadow-registry.json");
    const dbPath = join(stateDir, "shadow.sqlite");
    writeFileSync(
      registryPath,
      readFileSync(join(import.meta.dir, "..", "config", "run-receipt-shadow-adapters.json")),
    );
    const prior = { ...process.env };
    const shadowEnv = shadowEnvironment(stateDir, dbPath, registryPath);
    Object.assign(process.env, shadowEnv);
    try {
      const execution = verifiedExecution(stateDir);
      queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
      await expect(runShippingRequest("exec-review", {
        stateDir,
        now: clock(firstTimestamp, secondTimestamp),
        shipper: async () => { throw new Error("transient push rejection"); },
      })).rejects.toThrow("transient push rejection");
      queueShippingRequest(execution, { stateDir, now: () => secondTimestamp });
      const recovered = await runShippingRequest("exec-review", {
        stateDir,
        now: clock(secondTimestamp, secondTimestamp),
        shipper: promotionPending,
      });
      expect(recovered).toMatchObject({ status: "succeeded", attempt_count: 2 });
      const db = new Database(dbPath, { readonly: true });
      try {
        expect((db.query("SELECT COUNT(*) AS count FROM operations").get() as { count: number }).count).toBe(1);
        expect((db.query("SELECT COUNT(*) AS count FROM receipts").get() as { count: number }).count).toBe(1);
        expect((db.query("SELECT COUNT(*) AS count FROM journal_events WHERE kind = 'attempt.started'").get() as { count: number }).count).toBe(2);
        const payloads = (db.query("SELECT canonical_payload FROM journal_events").all() as Array<{ canonical_payload: string }>)
          .map((row) => row.canonical_payload).join("\n");
        expect(payloads).not.toContain("transient push rejection");
        expect(payloads).toContain("shipping_attempt_failed");
      } finally {
        db.close();
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
    }
  });

  test("shadow cohort excludes no-patch runs and retains already-merged outcomes", async () => {
    const stateDir = temporaryDirectory("shipping-shadow-cohort-");
    const registryPath = join(stateDir, "shadow-registry.json");
    const dbPath = join(stateDir, "shadow.sqlite");
    writeFileSync(registryPath, readFileSync(join(import.meta.dir, "..", "config", "run-receipt-shadow-adapters.json")));
    const prior = { ...process.env };
    const shadowEnv = shadowEnvironment(stateDir, dbPath, registryPath);
    Object.assign(process.env, shadowEnv);
    try {
      const noPatch = verifiedExecution(stateDir);
      queueShippingRequest(noPatch, { stateDir, now: () => firstTimestamp });
      await runShippingRequest("exec-review", {
        stateDir,
        now: clock(firstTimestamp, secondTimestamp),
        shipper: async () => ({ outcome: "no_patch_novel", pr_number: null, pr_url: null }),
      });
      expect(buildReceiptShadowReport(dbPath).classes.external_side_effect).toMatchObject({ operations: 0, excluded: 1 });

      const merged = { ...verifiedExecution(stateDir), execution_id: "exec-merged" };
      writeFileSync(join(stateDir, "exec-exec-merged.json"), `${JSON.stringify(merged, null, 2)}\n`);
      queueShippingRequest(merged, { stateDir, now: () => firstTimestamp });
      await runShippingRequest("exec-merged", {
        stateDir,
        now: clock(firstTimestamp, secondTimestamp),
        shipper: async () => ({ outcome: "already_merged", pr_number: 430, pr_url: "https://github.com/marlandoj/zouroboros/pull/430" }),
      });
      expect(buildReceiptShadowReport(dbPath).classes.external_side_effect).toMatchObject({ operations: 1, excluded: 1, receipts: 1 });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
      Object.assign(process.env, prior);
    }
  });

  test("an already merged PR is a successful idempotent outcome", async () => {
    const stateDir = temporaryDirectory("shipping-merged-");
    queueShippingRequest(verifiedExecution(stateDir), { stateDir, now: () => firstTimestamp });
    const result = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp),
      shipper: async () => ({
        outcome: "already_merged",
        pr_number: 430,
        pr_url: "https://github.com/marlandoj/zouroboros/pull/430",
      }),
    });
    expect(result).toMatchObject({ status: "succeeded", outcome: "already_merged", pr_number: 430 });
  });

  test("delegated shipping blocks before any command when exact L2 admission is absent", async () => {
    const stateDir = temporaryDirectory("shipping-delegated-block-");
    const execution = verifiedExecution(stateDir);
    execution.seed_path = join(stateDir, "seed.yaml");
    writeFileSync(execution.seed_path, "tasks:\n  - id: T1\n    name: task\n    deps: []\n");
    execution.project_delegation = {
      paths: {
        mandate_path: join(stateDir, "mandate.json"),
        activation_receipt_path: join(stateDir, "activation.json"),
        receipt_path: join(stateDir, "l1-receipt.json"),
        action_payload_path: join(stateDir, "l1-action.json"),
        evidence_path: join(stateDir, "l1-evidence.json"),
      },
      l1_admission: { seed_sha256: "a".repeat(64), mandate_sha256: "b".repeat(64) },
    };
    const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const calls: string[] = [];
    await expect(shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: stateDir,
      command: (program, args) => {
        calls.push(`${program} ${args.join(" ")}`);
        return { status: 0, stdout: "", stderr: "" };
      },
    })).rejects.toThrow("delegated L2 shipping admission is required");
    expect(calls).toEqual([]);
  });

  test("delegated otherwise-valid receipt window survives a UTC calendar rollover", () => {
    const nowMs = Date.parse("2026-08-29T23:59:30.000Z");
    const fixture = delegatedShippingFixture(undefined, nowMs);
    expect(fixture.receiptValidity).toEqual({
      issuedAtUtc: "2026-08-29T23:54:30.000Z",
      expiresAtUtc: "2026-08-30T00:59:30.000Z",
      nowMs,
    });
    expect(Date.parse(fixture.receiptValidity.issuedAtUtc)).toBeLessThan(nowMs);
    expect(Date.parse(fixture.receiptValidity.expiresAtUtc)).toBeGreaterThan(nowMs);
  });

  test("delegated L2 shipping uploads the reviewed objects with an absent-ref lease, creates one draft PR, and rejects replay", async () => {
    const fixture = delegatedShippingFixture();
    const { root, origin, repo, stateDir, runGit, finalCommit, artifacts, execution, receipt } = fixture;
    expect(Bun.spawnSync(["git", "cat-file", "-e", `${finalCommit}^{commit}`], {
      cwd: origin,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode).not.toBe(0);
    const { calls, state, command } = delegatedCommand(fixture);
    const result = await shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: root,
      command,
      tempRoot: root,
      changeQuizMode: "off",
      projectDelegationKeyPath: artifacts.keyPath,
      projectDelegationAuditLogPath: artifacts.auditPath,
      projectDelegationOperationalStatePathsForTest: artifacts.operationalStatePaths,
    });
    expect(result).toMatchObject({ outcome: "promotion_pending", pr_number: 700 });
    expect(state.prCreates).toBe(1);
    expect(state.refCreates).toBe(1);
    expect(calls.some((call) => call.includes("cherry-pick"))).toBe(false);
    expect(calls.filter((call) => call.startsWith("git push --force-with-lease=refs/heads/feat/zou-307-delegation-enforcement-r1:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("gh api "))).toBe(false);
    expect(runGit(["cat-file", "-t", finalCommit], origin)).toBe("commit");
    expect(runGit(["rev-parse", "refs/heads/feat/zou-307-delegation-enforcement-r1"], origin)).toBe(finalCommit);
    const remoteEffectsBeforeReplay = calls.filter((call) => call.startsWith("git fetch ") || call.startsWith("git push ") || call.startsWith("gh api ") || call.startsWith("gh pr create ")).length;
    await expect(shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: root,
      command,
      tempRoot: root,
      changeQuizMode: "off",
      projectDelegationKeyPath: artifacts.keyPath,
      projectDelegationAuditLogPath: artifacts.auditPath,
      projectDelegationOperationalStatePathsForTest: artifacts.operationalStatePaths,
    })).rejects.toThrow("replay");
    expect(calls.filter((call) => call.startsWith("git fetch ") || call.startsWith("git push ") || call.startsWith("gh api ") || call.startsWith("gh pr create ")).length).toBe(remoteEffectsBeforeReplay);
  });

  test.each(commitChainCases)("delegated L2 shipping blocks a %s commit chain before remote mutation", async (_name, transform) => {
    const fixture = delegatedShippingFixture(transform);
    const { calls, state, command } = delegatedCommand(fixture);
    await expect(shipDelegatedFixture(fixture, command)).rejects.toThrow(/commit list|commit chain/);
    expect(state.refCreates).toBe(0);
    expect(state.prCreates).toBe(0);
    expect(calls.some((call) => call.startsWith("gh api ") || call.startsWith("gh pr create "))).toBe(false);
  });

  test.each(preimageProbeCases)("delegated L2 shipping fails closed on a %s preimage probe", async (_name, preimageResult) => {
    const fixture = delegatedShippingFixture();
    const { calls, state, command } = delegatedCommand(fixture, { preimageResult });
    await expect(shipDelegatedFixture(fixture, command)).rejects.toThrow(/preimage probe|readback is malformed/);
    expect(state.refCreates).toBe(0);
    expect(state.prCreates).toBe(0);
    expect(calls.some((call) => call.startsWith("gh api ") || call.startsWith("gh pr create "))).toBe(false);
  });

  test("delegated L2 shipping rejects a malformed successful preimage ref", async () => {
    const fixture = delegatedShippingFixture();
    const preimageResult = {
      status: 0,
      stdout: `${fixture.finalCommit}\trefs/heads/wrong\n`,
      stderr: "",
    };
    const { state, command } = delegatedCommand(fixture, { preimageResult });
    await expect(shipDelegatedFixture(fixture, command)).rejects.toThrow("remote readback is malformed");
    expect(state.refCreates).toBe(0);
    expect(state.prCreates).toBe(0);
  });

  test("delegated L2 shipping accepts only the exact existing open draft PR", async () => {
    const fixture = delegatedShippingFixture();
    const exactPr = {
      number: 701,
      url: "https://github.com/marlandoj/zouroboros-workspace/pull/701",
      state: "OPEN",
      isDraft: true,
      headRefName: "feat/zou-307-delegation-enforcement-r1",
      headRefOid: fixture.finalCommit,
      baseRefName: "main",
    };
    const { calls, state, command } = delegatedCommand(fixture, { existingPrRows: [exactPr] });
    const result = await shipDelegatedFixture(fixture, command);
    expect(result).toMatchObject({ outcome: "existing_open_pr", pr_number: 701 });
    expect(state.refCreates).toBe(0);
    expect(state.prCreates).toBe(0);
    expect(calls.some((call) => call.startsWith("git ls-remote ") || call.startsWith("gh api ") || call.startsWith("gh pr create "))).toBe(false);
  });

  test.each(existingPrMismatchCases)("delegated L2 shipping rejects an existing PR with %s before persistence", async (_name, patch) => {
    const fixture = delegatedShippingFixture();
    const existingPr = {
      number: 701,
      url: "https://github.com/marlandoj/zouroboros-workspace/pull/701",
      state: "OPEN",
      isDraft: true,
      headRefName: "feat/zou-307-delegation-enforcement-r1",
      headRefOid: fixture.finalCommit,
      baseRefName: "main",
      ...patch,
    };
    const { calls, state, command } = delegatedCommand(fixture, { existingPrRows: [existingPr] });
    await expect(shipDelegatedFixture(fixture, command)).rejects.toThrow("does not match the exact reviewed open draft state");
    expect(state.refCreates).toBe(0);
    expect(state.prCreates).toBe(0);
    expect(calls.some((call) => call.startsWith("gh api ") || call.startsWith("gh pr create "))).toBe(false);
  });

  test("delegated L2 shipping rejects duplicate active PR readback", async () => {
    const fixture = delegatedShippingFixture();
    const existingPr = {
      url: "https://github.com/marlandoj/zouroboros-workspace/pull/701",
      state: "OPEN",
      isDraft: true,
      headRefName: "feat/zou-307-delegation-enforcement-r1",
      headRefOid: fixture.finalCommit,
      baseRefName: "main",
    };
    const { state, command } = delegatedCommand(fixture, {
      existingPrRows: [{ ...existingPr, number: 701 }, { ...existingPr, number: 702 }],
    });
    await expect(shipDelegatedFixture(fixture, command)).rejects.toThrow("pull-request lookup is ambiguous");
    expect(state.refCreates).toBe(0);
    expect(state.prCreates).toBe(0);
  });

  test.each(absentRefPushFailureCases)("delegated L2 shipping terminalizes one absent-ref push %s without PR creation", async (_name, absentRefPushResult, expectedError) => {
    const fixture = delegatedShippingFixture();
    const { calls, state, command } = delegatedCommand(fixture, { absentRefPushResult });
    await expect(shipDelegatedFixture(fixture, command)).rejects.toThrow(expectedError);
    expect(state.refCreates).toBe(1);
    expect(state.prCreates).toBe(0);
    expect(calls.filter((call) => call.startsWith("git push --force-with-lease=refs/heads/feat/zou-307-delegation-enforcement-r1:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("gh api ") || call.startsWith("gh pr create "))).toBe(false);
  });

  test("the real shipper recognizes a merged PR and records contiguous lifecycle evidence", async () => {
    const stateDir = temporaryDirectory("shipping-real-merged-");
    const execution = verifiedExecution(stateDir);
    const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const calls: string[] = [];
    const command: CommandRunner = (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${stateDir}\n`, stderr: "" };
      if (program === "gh" && args[0] === "repo") return { status: 0, stdout: "marlandoj/zouroboros\n", stderr: "" };
      if (program === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          status: 0,
          stdout: `${JSON.stringify([{ number: 430, state: "MERGED", url: "https://github.com/marlandoj/zouroboros/pull/430", isDraft: false, headRefName: "factory/zou-review" }])}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: stateDir,
      command,
      now: () => secondTimestamp,
    });
    expect(result).toMatchObject({ outcome: "already_merged", pr_number: 430 });
    expect(calls.some((call) => call.includes("gh pr merge"))).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "exec-exec-review.json"), "utf8"))).toMatchObject({
      state: "merged",
      stage: "merged",
      status: "merged",
      pr_number: 430,
    });
  });

  test("the real shipper reuses an open PR without invoking merge", async () => {
    const stateDir = temporaryDirectory("shipping-real-open-");
    const execution = verifiedExecution(stateDir);
    const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const calls: string[] = [];
    const command: CommandRunner = (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${stateDir}\n`, stderr: "" };
      if (program === "gh" && args[0] === "repo") return { status: 0, stdout: "marlandoj/zouroboros\n", stderr: "" };
      if (program === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          status: 0,
          stdout: `${JSON.stringify([{ number: 431, state: "OPEN", url: "https://github.com/marlandoj/zouroboros/pull/431", isDraft: false, headRefName: "factory/zou-review" }])}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: stateDir,
      command,
      now: () => secondTimestamp,
    });
    expect(result).toMatchObject({ outcome: "existing_open_pr", pr_number: 431 });
    expect(calls.some((call) => call.includes("gh pr merge"))).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "exec-exec-review.json"), "utf8"))).toMatchObject({
      state: "pr_ready",
      stage: "pr_ready",
      status: "pr_ready",
      pr_number: 431,
    });
  });

  test("the real shipper accepts a verified existing-PR branch already reconciled to pr_ready", async () => {
    const stateDir = temporaryDirectory("shipping-recovered-open-");
    const execution = verifiedExecution(stateDir);
    execution.branch_name = "feat/zou-1462-speeder";
    execution.pr_number = 18;
    execution.pr_url = "https://github.com/marlandoj/arcade-games/pull/18";
    const receipt = queueShippingRequest(execution, { stateDir, now: () => firstTimestamp });
    const prReady = transitionExecutionLifecycle(execution, "pr_ready", {
      kind: "verified-existing-pr",
      reference: execution.pr_url,
      recorded_at: secondTimestamp,
    }, { now: secondTimestamp });
    Object.assign(execution, prReady, { stage: "pr_ready", status: "pr_ready" });
    writeFileSync(join(stateDir, "exec-exec-review.json"), `${JSON.stringify(execution, null, 2)}\n`);
    const calls: string[] = [];
    const command: CommandRunner = (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      if (program === "git" && args[0] === "rev-parse") return { status: 0, stdout: `${stateDir}\n`, stderr: "" };
      if (program === "gh" && args[0] === "repo") return { status: 0, stdout: "marlandoj/arcade-games\n", stderr: "" };
      if (program === "gh" && args[0] === "pr" && args[1] === "list") {
        return {
          status: 0,
          stdout: `${JSON.stringify([{ number: 18, state: "OPEN", url: execution.pr_url, isDraft: false, headRefName: execution.branch_name }])}\n`,
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const result = await shipExecution(execution, receipt, {
      stateDir,
      authorizedRoot: stateDir,
      command,
      now: () => secondTimestamp,
    });
    expect(result).toMatchObject({ outcome: "existing_open_pr", pr_number: 18 });
    expect(calls.some((call) => call.startsWith("gh pr merge "))).toBe(false);
  });

  test("a duplicate execution with no patch-novel commits is durably skipped", async () => {
    const stateDir = temporaryDirectory("shipping-nodiff-");
    queueShippingRequest(verifiedExecution(stateDir), { stateDir, now: () => firstTimestamp });
    const result = await runShippingRequest("exec-review", {
      stateDir,
      now: clock(firstTimestamp, secondTimestamp),
      shipper: async () => ({ outcome: "no_patch_novel", pr_number: null, pr_url: null }),
    });
    expect(result).toMatchObject({ status: "skipped", outcome: "no_patch_novel", error: null });
    expect((await runShippingRequest("exec-review", { stateDir, shipper: promotionPending })).status).toBe("skipped");
  });

  test("run-ready consumes scanner output and executes each eligible request once", async () => {
    const stateDir = temporaryDirectory("shipping-scan-");
    verifiedExecution(stateDir);
    const command: CommandRunner = (program, args) => {
      expect(program).toBe("bun");
      expect(args).toContain("--min-age-minutes");
      return {
        status: 0,
        stdout: `${JSON.stringify({
          ok: true,
          linear_ok: true,
          items: [{ execution_id: "exec-review" }],
        })}\n`,
        stderr: "",
      };
    };
    const result = await runReadyQueue({
      stateDir,
      minAgeMinutes: 0,
      command,
      now: clock(firstTimestamp, firstTimestamp, secondTimestamp),
      shipper: promotionPending,
      codebaseIndexer: () => ({
        ok: true,
        enabled: true,
        locked: false,
        evaluated: 1,
        indexed: 0,
        skipped: 0,
        pending: 1,
        failures: [],
        results: [],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.codebase_index).toMatchObject({ ok: true, pending: 1 });
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]).toMatchObject({ status: "succeeded", outcome: "promotion_pending" });
  });

  test("run-ready fails closed when the Linear join is unavailable", async () => {
    const stateDir = temporaryDirectory("shipping-linear-");
    const command: CommandRunner = () => ({
      status: 0,
      stdout: `${JSON.stringify({ ok: true, linear_ok: false, items: [] })}\n`,
      stderr: "",
    });
    await expect(runReadyQueue({ stateDir, command })).rejects.toThrow("Linear evidence");
  });

  test("run-ready surfaces Codebase MCP reconciliation failures without rewriting shipping receipts", async () => {
    const stateDir = temporaryDirectory("shipping-index-failure-");
    const command: CommandRunner = () => ({
      status: 0,
      stdout: `${JSON.stringify({ ok: true, linear_ok: true, items: [] })}\n`,
      stderr: "",
    });
    const result = await runReadyQueue({
      stateDir,
      command,
      codebaseIndexer: () => ({
        ok: false,
        enabled: true,
        locked: false,
        evaluated: 1,
        indexed: 0,
        skipped: 0,
        pending: 0,
        failures: [{
          execution_id: "exec-review",
          identifier: "ZOU-REVIEW",
          repo_path: stateDir,
          pr_number: 431,
          merge_sha: "b".repeat(40),
          status: "failed",
          graph_project: null,
          receipt_path: join(stateDir, "codebase-index-test.json"),
          error: "index failed",
        }],
        results: [],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.codebase_index.failures[0]).toMatchObject({ identifier: "ZOU-REVIEW", error: "index failed" });
  });
});
