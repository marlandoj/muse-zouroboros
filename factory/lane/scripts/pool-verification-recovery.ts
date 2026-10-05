#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { factoryStateRoot } from "./factory-state-root";
import {
  loadCampaigns,
  loadQueue,
  parseCascadeValidationCommands,
  poolStateDir,
  rollupCampaignState,
  saveCampaigns,
  saveQueue,
  withPoolMutationLock,
  writeJsonAtomic,
} from "./pool-queue";
import { loadAssignments, type Assignment } from "./pool-worker";
import {
  runCascadeValidation,
  type CascadeCommandRunner,
  type CascadeValidationCommand,
  type CascadeValidationResult,
} from "./coding-cascade";
import {
  normalizeExecutionLifecycle,
  transitionExecutionLifecycle,
  type ExecutionLifecycle,
} from "./execution-lifecycle";
import { loadShippingAttempt, queueShippingRequest, type ShippingExecution } from "./ship-ready-runner";
import { recordFlight } from "./flight-recorder";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{3,160}$/;

export interface ExistingPullRequestEvidence {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  mergeable: string;
  mergeStateStatus: string;
}

export interface VerificationRecoveryIntent {
  version: 1;
  recovery_id: string;
  execution_id: string;
  campaign_id: string;
  task_id: string;
  assignment_id: string;
  implementation_commit: string;
  operator: string;
  note: string;
  created_at: string;
  repository: string;
  repository_identity: string;
  base_commit: string;
  pull_request: ExistingPullRequestEvidence;
  validation_commands: CascadeValidationCommand[];
  validation: CascadeValidationResult;
  evidence_digest: string;
  prior: {
    execution_state: string;
    campaign_state: string;
    task_state: string;
    attempts: number;
  };
}

export interface VerificationRecoveryEvent extends VerificationRecoveryIntent {
  applied_at: string;
  execution_state: "pr_ready";
  campaign_state: "complete";
  task_state: "done";
  shipping_receipt: string;
}

export interface RecoveryCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RecoveryCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
) => RecoveryCommandResult;

export interface VerificationRecoveryInput {
  recovery_id: string;
  execution_id: string;
  campaign_id: string;
  task_id: string;
  assignment_id: string;
  implementation_commit: string;
  pr_number: number;
  branch: string;
  operator: string;
  note: string;
  validation_commands: CascadeValidationCommand[];
}

export interface VerificationRecoveryOptions {
  stateDir?: string;
  run?: RecoveryCommandRunner;
  now?: () => string;
}

function defaultRun(command: string, args: string[], options: { cwd: string; timeoutMs?: number }): RecoveryCommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function errorMessage(result: RecoveryCommandResult): string {
  return result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`;
}

function requireCommand(run: RecoveryCommandRunner, command: string, args: string[], cwd: string): string {
  const result = run(command, args, { cwd, timeoutMs: 120_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${errorMessage(result)}`);
  return result.stdout.trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function executionPath(executionId: string, stateDir: string): string {
  return join(stateDir, `exec-${executionId}.json`);
}

function intentPath(recoveryId: string): string {
  return join(poolStateDir(), "verification-recovery-intents", `${recoveryId}.json`);
}

function evidencePath(recoveryId: string, stateDir: string): string {
  return join(stateDir, "evidence", `${recoveryId}.verification.json`);
}

function eventsPath(): string {
  return join(poolStateDir(), "verification-recoveries.jsonl");
}

function loadEvents(): VerificationRecoveryEvent[] {
  if (!existsSync(eventsPath())) return [];
  return readFileSync(eventsPath(), "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as VerificationRecoveryEvent];
    } catch {
      return [];
    }
  });
}

function sameRecoveryContract(
  existing: VerificationRecoveryIntent,
  input: VerificationRecoveryInput,
  verified: { repository: string; repositoryIdentity: string; pullRequest: ExistingPullRequestEvidence },
  baseCommit: string,
): boolean {
  return existing.recovery_id === input.recovery_id
    && existing.execution_id === input.execution_id
    && existing.campaign_id === input.campaign_id
    && existing.task_id === input.task_id
    && existing.assignment_id === input.assignment_id
    && existing.implementation_commit === input.implementation_commit
    && existing.operator === input.operator.trim()
    && existing.note === input.note.trim()
    && existing.repository === verified.repository
    && existing.repository_identity === verified.repositoryIdentity
    && existing.base_commit === baseCommit
    && existing.pull_request.number === verified.pullRequest.number
    && existing.pull_request.url === verified.pullRequest.url
    && existing.pull_request.headRefName === verified.pullRequest.headRefName
    && existing.pull_request.headRefOid === verified.pullRequest.headRefOid
    && canonical(existing.validation_commands) === canonical(input.validation_commands);
}

function loadExecution(executionId: string, stateDir: string): ShippingExecution {
  const path = executionPath(executionId, stateDir);
  if (!existsSync(path)) throw new Error(`execution not found: ${executionId}`);
  return JSON.parse(readFileSync(path, "utf8")) as ShippingExecution;
}

function applyLifecycle(execution: ShippingExecution, lifecycle: ExecutionLifecycle): void {
  execution.state = lifecycle.state;
  execution.delivery_target = lifecycle.delivery_target;
  execution.target_reached = lifecycle.target_reached;
  execution.state_updated_at = lifecycle.state_updated_at;
  execution.evidence = lifecycle.evidence;
  execution.post_merge_survivability = lifecycle.post_merge_survivability;
  execution.post_merge_survivability_reason = lifecycle.post_merge_survivability_reason;
  execution.post_merge_survivability_checks = lifecycle.post_merge_survivability_checks;
  execution.stage = lifecycle.state;
  execution.status = lifecycle.state;
}

function advanceToVerified(
  execution: ShippingExecution,
  input: VerificationRecoveryInput,
  evidenceReference: string,
  timestamp: string,
): void {
  let lifecycle = normalizeExecutionLifecycle(execution);
  if (lifecycle.state === "pool_enqueued") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "executing", {
      kind: "verification-recovery-release",
      reference: input.recovery_id,
      recorded_at: timestamp,
    }, { now: timestamp });
  }
  if (lifecycle.state === "executing") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "implementation_complete", {
      kind: "existing-implementation",
      reference: input.implementation_commit,
      recorded_at: timestamp,
    }, { now: timestamp });
  }
  if (lifecycle.state === "implementation_complete") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "verified", {
      kind: "repository-validation",
      reference: evidenceReference,
      recorded_at: timestamp,
    }, { now: timestamp });
  }
  if (lifecycle.state !== "verified" && lifecycle.state !== "pr_ready") {
    throw new Error(`verification recovery cannot advance execution from ${lifecycle.state}`);
  }
  applyLifecycle(execution, lifecycle);
}

function advanceToPrReady(
  execution: ShippingExecution,
  input: VerificationRecoveryInput,
  pullRequest: ExistingPullRequestEvidence,
  timestamp: string,
): void {
  let lifecycle = normalizeExecutionLifecycle(execution);
  if (lifecycle.state === "verified") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "pr_ready", {
      kind: "verified-existing-pr",
      reference: pullRequest.url,
      recorded_at: timestamp,
      details: {
        recovery_id: input.recovery_id,
        branch: pullRequest.headRefName,
        head_sha: pullRequest.headRefOid,
      },
    }, { now: timestamp });
  }
  if (lifecycle.state !== "pr_ready") throw new Error(`verification recovery expected pr_ready, found ${lifecycle.state}`);
  applyLifecycle(execution, lifecycle);
}

function validateInput(input: VerificationRecoveryInput): void {
  for (const [label, value] of Object.entries({
    recovery_id: input.recovery_id,
    execution_id: input.execution_id,
    campaign_id: input.campaign_id,
    task_id: input.task_id,
    assignment_id: input.assignment_id,
  })) {
    if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier`);
  }
  if (!FULL_SHA.test(input.implementation_commit)) throw new Error("implementation_commit must be a full lowercase SHA");
  if (!Number.isSafeInteger(input.pr_number) || input.pr_number <= 0) throw new Error("pr_number must be a positive integer");
  if (!/^[A-Za-z0-9._/-]+$/.test(input.branch)) throw new Error("branch contains unsafe characters");
  if (!input.operator.trim() || !input.note.trim()) throw new Error("operator and note are required");
  parseCascadeValidationCommands(input.validation_commands, "verification recovery input");
}

function verifyExistingPullRequest(
  input: VerificationRecoveryInput,
  assignment: Assignment,
  campaignBase: string,
  run: RecoveryCommandRunner,
  now: () => string,
): {
  repository: string;
  repositoryIdentity: string;
  pullRequest: ExistingPullRequestEvidence;
  validation: CascadeValidationResult;
} {
  if (!assignment.worktree_path || !existsSync(assignment.worktree_path)) {
    throw new Error(`assignment worktree is missing: ${assignment.worktree_path ?? "unset"}`);
  }
  const repository = realpathSync(assignment.worktree_path);
  if (requireCommand(run, "git", ["status", "--porcelain=v1", "--untracked-files=all"], repository)) {
    throw new Error("assignment worktree is not clean");
  }
  const repositoryIdentity = requireCommand(run, "gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], repository);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repositoryIdentity)) throw new Error(`invalid repository identity: ${repositoryIdentity}`);
  const pullRequest = parseJson<ExistingPullRequestEvidence>(requireCommand(run, "gh", [
    "pr", "view", String(input.pr_number), "--repo", repositoryIdentity,
    "--json", "number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus",
  ], repository), "gh pr view");
  if (pullRequest.number !== input.pr_number || !["OPEN", "MERGED"].includes(pullRequest.state) || pullRequest.isDraft) {
    throw new Error(`PR #${input.pr_number} is not an open or merged, non-draft pull request`);
  }
  if (pullRequest.headRefName !== input.branch || pullRequest.baseRefName !== "main") {
    throw new Error(`PR #${input.pr_number} branch boundary mismatch`);
  }
  if (!FULL_SHA.test(pullRequest.headRefOid)) throw new Error("PR head is not a full commit SHA");
  if (pullRequest.mergeable === "CONFLICTING" || pullRequest.mergeStateStatus === "DIRTY") {
    throw new Error(`PR #${input.pr_number} is not mergeable`);
  }
  const head = requireCommand(run, "git", ["rev-parse", "HEAD"], repository);
  if (head !== pullRequest.headRefOid) throw new Error(`retained worktree HEAD ${head} does not match PR head ${pullRequest.headRefOid}`);
  if (assignment.base_commit !== campaignBase) throw new Error("assignment and campaign base commits differ");
  requireCommand(run, "git", ["merge-base", "--is-ancestor", campaignBase, head], repository);
  requireCommand(run, "git", ["merge-base", "--is-ancestor", input.implementation_commit, head], repository);
  const novel = run("git", ["diff", "--quiet", `${campaignBase}..${head}`], { cwd: repository, timeoutMs: 30_000 });
  if (novel.status === 0) throw new Error("PR has no patch-novel changes from the recorded base");
  if (novel.status !== 1) throw new Error(`cannot prove patch novelty: ${errorMessage(novel)}`);
  requireCommand(run, "git", ["diff", "--check", `${campaignBase}..${head}`], repository);
  const validation = runCascadeValidation({
    worktree: repository,
    commands: input.validation_commands,
    run: run as CascadeCommandRunner,
    now,
  });
  if (!validation.pass) {
    const failed = validation.checks.find((check) => !check.pass);
    throw new Error(`repository validation failed: ${failed?.label ?? "unknown"}: ${failed?.summary ?? "no detail"}`);
  }
  return { repository, repositoryIdentity, pullRequest, validation };
}

export function recoverExistingPullRequest(
  input: VerificationRecoveryInput,
  options: VerificationRecoveryOptions = {},
): { event: VerificationRecoveryEvent; idempotent: boolean } {
  validateInput(input);
  const stateDir = options.stateDir ?? factoryStateRoot();
  const now = options.now ?? (() => new Date().toISOString());
  const run = options.run ?? defaultRun;
  const campaignsBefore = loadCampaigns();
  const campaignBefore = campaignsBefore[input.campaign_id];
  if (!campaignBefore) throw new Error(`no campaign ${input.campaign_id}`);
  if (campaignBefore.execution_id && campaignBefore.execution_id !== input.execution_id) {
    throw new Error("campaign execution identity mismatch");
  }
  const itemBefore = loadQueue().find((item) => item.campaign_id === input.campaign_id && item.task_id === input.task_id);
  if (!itemBefore) throw new Error(`no work item (${input.campaign_id}, ${input.task_id})`);
  const assignment = loadAssignments().find((candidate) => candidate.assignment_id === input.assignment_id);
  if (!assignment || assignment.campaign_id !== input.campaign_id || assignment.task_id !== input.task_id) {
    throw new Error("assignment identity mismatch");
  }
  if (assignment.outcome !== "failure" || assignment.failure?.kind !== "mechanical_validation") {
    throw new Error("verification-only recovery requires a mechanically failed implementation assignment");
  }
  const open = loadAssignments().find((candidate) => candidate.campaign_id === input.campaign_id
    && candidate.task_id === input.task_id && candidate.outcome === null);
  if (open) throw new Error(`open assignment prevents recovery: ${open.assignment_id}`);
  const baseCommit = campaignBefore.base_commit ?? "";
  if (!FULL_SHA.test(baseCommit)) throw new Error("campaign base_commit is missing or invalid");

  const verified = verifyExistingPullRequest(input, assignment, baseCommit, run, now);
  const applied = loadEvents().find((event) => event.recovery_id === input.recovery_id);
  if (applied) {
    if (!sameRecoveryContract(applied, input, verified, baseCommit)) {
      throw new Error(`verification recovery ${input.recovery_id} was applied with different inputs`);
    }
    return { event: applied, idempotent: true };
  }
  const timestamp = now();
  const unsigned = {
    version: 1 as const,
    recovery_id: input.recovery_id,
    execution_id: input.execution_id,
    campaign_id: input.campaign_id,
    task_id: input.task_id,
    assignment_id: input.assignment_id,
    implementation_commit: input.implementation_commit,
    operator: input.operator.trim(),
    note: input.note.trim(),
    created_at: timestamp,
    repository: verified.repository,
    repository_identity: verified.repositoryIdentity,
    base_commit: baseCommit,
    pull_request: verified.pullRequest,
    validation_commands: input.validation_commands.map((command) => ({ ...command, args: [...command.args] })),
    validation: verified.validation,
    prior: {
      execution_state: normalizeExecutionLifecycle(loadExecution(input.execution_id, stateDir)).state,
      campaign_state: campaignBefore.state,
      task_state: itemBefore.state,
      attempts: itemBefore.attempts,
    },
  };
  const existingIntentPath = intentPath(input.recovery_id);
  let intent: VerificationRecoveryIntent;
  if (existsSync(existingIntentPath)) {
    intent = JSON.parse(readFileSync(existingIntentPath, "utf8")) as VerificationRecoveryIntent;
    if (!sameRecoveryContract(intent, input, verified, baseCommit)) {
      throw new Error(`verification recovery intent ${input.recovery_id} has different inputs`);
    }
  } else {
    intent = { ...unsigned, evidence_digest: digest(unsigned) };
    writeJsonAtomic(existingIntentPath, intent);
  }
  const proofPath = evidencePath(input.recovery_id, stateDir);
  writeJsonAtomic(proofPath, intent);

  const result = withPoolMutationLock(() => {
    const existingEvent = loadEvents().find((event) => event.recovery_id === input.recovery_id);
    if (existingEvent) {
      if (existingEvent.evidence_digest !== intent.evidence_digest) {
        throw new Error(`verification recovery ${input.recovery_id} was applied with different evidence`);
      }
      return { event: existingEvent, idempotent: true };
    }
    const campaigns = loadCampaigns();
    const campaign = campaigns[input.campaign_id];
    const queue = loadQueue();
    const item = queue.find((candidate) => candidate.campaign_id === input.campaign_id && candidate.task_id === input.task_id);
    if (!campaign || !item) throw new Error("campaign or work item disappeared during recovery");
    const recoverablePark = item.state === "parked"
      && item.park_reason?.startsWith("dispatch:") === true
      && item.park_reason.includes("explicit retry required");
    if (!recoverablePark && item.state !== "done") {
      throw new Error(`work item changed during recovery: ${item.state}`);
    }

    const execution = loadExecution(input.execution_id, stateDir);
    if (execution.identifier !== campaign.identifier) throw new Error("execution and campaign identifier mismatch");
    execution.branch_name = verified.pullRequest.headRefName;
    execution.base_commit = baseCommit;
    execution.repo_path = verified.repository;
    execution.pr_number = verified.pullRequest.number;
    execution.pr_url = verified.pullRequest.url;
    execution.completed_at = timestamp;
    execution.error = null;
    execution.result_summary = `Verification-only recovery passed for existing PR #${verified.pullRequest.number}`;
    advanceToVerified(execution, input, proofPath, timestamp);
    const recoveryState = normalizeExecutionLifecycle(execution).state;
    const existingReceipt = recoveryState === "pr_ready"
      ? loadShippingAttempt(execution.execution_id, stateDir)
      : null;
    if (recoveryState === "pr_ready" && verified.pullRequest.state !== "MERGED") {
      throw new Error("pr_ready rebind requires a merged pull request");
    }
    if (recoveryState === "pr_ready"
      && (!existingReceipt || !["succeeded", "skipped"].includes(existingReceipt.status))) {
      throw new Error("pr_ready rebind requires an existing terminal shipping receipt");
    }
    if (recoveryState === "pr_ready" && existingReceipt
      && (existingReceipt.execution_id !== execution.execution_id
        || existingReceipt.identifier !== execution.identifier
        || existingReceipt.pr_number !== verified.pullRequest.number
        || existingReceipt.pr_url !== verified.pullRequest.url
        || existingReceipt.repo_path !== verified.repository
        || existingReceipt.base_commit !== baseCommit)) {
      throw new Error("pr_ready rebind shipping receipt does not match the verified execution and pull request");
    }
    if (recoveryState !== "pr_ready") {
      writeJsonAtomic(executionPath(input.execution_id, stateDir), execution);
    }
    const receipt = existingReceipt ?? queueShippingRequest(execution, { stateDir, now: () => timestamp });
    advanceToPrReady(execution, input, verified.pullRequest, timestamp);
    execution.shipping_branch = verified.pullRequest.headRefName;
    writeJsonAtomic(executionPath(input.execution_id, stateDir), execution);

    campaign.target_repository = verified.repository;
    campaign.validation_commands = input.validation_commands.map((command) => ({ ...command, args: [...command.args] }));
    item.state = "done";
    item.park_reason = null;
    item.updated_at = timestamp;
    campaign.state = rollupCampaignState(queue.filter((candidate) => candidate.campaign_id === input.campaign_id));
    if (campaign.state !== "complete") throw new Error(`campaign did not roll up to complete: ${campaign.state}`);
    saveQueue(queue);
    saveCampaigns(campaigns);

    const event: VerificationRecoveryEvent = {
      ...intent,
      applied_at: timestamp,
      execution_state: "pr_ready",
      campaign_state: "complete",
      task_state: "done",
      shipping_receipt: join(stateDir, `shipping-request-${receipt.execution_id}.json`),
    };
    mkdirSync(dirname(eventsPath()), { recursive: true });
    appendFileSync(eventsPath(), `${JSON.stringify(event)}\n`);
    return { event, idempotent: false };
  });

  recordFlight({
    execution_id: input.execution_id,
    identifier: input.campaign_id,
    kind: "exec.verification-recovery.pr-ready",
    detail: `Existing PR #${input.pr_number} verified without a model rerun`,
    data: { recovery_id: input.recovery_id, evidence_digest: intent.evidence_digest },
  }, join(stateDir, "flight"));
  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      recovery: { type: "string" },
      execution: { type: "string" },
      campaign: { type: "string" },
      task: { type: "string" },
      assignment: { type: "string" },
      implementation: { type: "string" },
      pr: { type: "string" },
      branch: { type: "string" },
      by: { type: "string" },
      note: { type: "string" },
      validations: { type: "string" },
      "state-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: pool-verification-recovery.ts --recovery <id> --execution <exec-id> --campaign <id> --task <id> --assignment <id> --implementation <sha> --pr <number> --branch <name> --by <operator> --note <evidence> --validations <json-file> [--state-dir <path>]");
    return;
  }
  const required = ["recovery", "execution", "campaign", "task", "assignment", "implementation", "pr", "branch", "by", "note", "validations"] as const;
  for (const key of required) if (!values[key]) throw new Error(`--${key} is required`);
  if (!existsSync(values.validations!)) throw new Error(`validation commands file not found: ${values.validations}`);
  const commands = parseCascadeValidationCommands(
    JSON.parse(readFileSync(values.validations!, "utf8")),
    values.validations!,
  );
  const result = recoverExistingPullRequest({
    recovery_id: values.recovery!,
    execution_id: values.execution!,
    campaign_id: values.campaign!,
    task_id: values.task!,
    assignment_id: values.assignment!,
    implementation_commit: values.implementation!,
    pr_number: Number(values.pr),
    branch: values.branch!,
    operator: values.by!,
    note: values.note!,
    validation_commands: commands,
  }, { ...(values["state-dir"] ? { stateDir: values["state-dir"] } : {}) });
  console.log(JSON.stringify({
    recovery_id: result.event.recovery_id,
    execution_state: result.event.execution_state,
    campaign_state: result.event.campaign_state,
    task_state: result.event.task_state,
    idempotent: result.idempotent,
  }, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
