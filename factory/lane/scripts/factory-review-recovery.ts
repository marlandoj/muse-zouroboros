#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  gateCompletedExecution,
  type FactoryConsensusOptions,
  type FactoryConsensusRecord,
  type ConsensusMutableExecution,
} from "./factory-consensus";
import { runFactoryReviewGate } from "./factory-review-gate";
import { applyModelPolicy, modelReviewAuthorized, parseModelPolicy, type ExecutionPolicy } from "./model-policy";
import {
  normalizeExecutionLifecycle,
  transitionExecutionLifecycle,
  type ExecutionLifecycle,
} from "./execution-lifecycle";
import { queueShippingRequest, type ShippingExecution } from "./ship-ready-runner";
import {
  recordConsensusOutcome,
  recordManualResolution,
  recordRecoveryTransition,
} from "./recovery-journal";
import { buildEscalation, planRepair, type EscalationPacket } from "./consensus-repair";
import { recordRawFailure } from "./lane-halt";

const DEFAULT_STATE_DIR = factoryStateRoot();
const DEFAULT_REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const LINEAR_API = "https://api.linear.app/graphql";
const MANUAL_REVIEW_STATE = process.env.FACTORY_MANUAL_REVIEW_STATE ?? "In Review";
const UNCHUNKED_MAX_REVIEW_BYTES = 512 * 1024;

export function recoveryConsensusOptions(unchunked: boolean): FactoryConsensusOptions | undefined {
  if (!unchunked) return undefined;
  return {
    maxVendorAttempts: 2,
    maxChunkBytes: UNCHUNKED_MAX_REVIEW_BYTES,
    maxChunks: 1,
    maxGateCalls: 1,
    maxTotalGateCalls: 2,
  };
}

export interface ReviewRecoveryExecution extends ExecutionLifecycle, ConsensusMutableExecution {
  ticket_id: string;
  repo_path?: string;
  base_commit?: string | null;
  started_at: string;
  result_summary?: string | null;
  completed_at?: string | null;
  [key: string]: unknown;
}

export interface ReviewRecoveryTicket {
  linear_id: string;
  identifier: string;
  description: string;
}

export interface LinearManualReviewResult {
  comment: "created" | "existing";
  state: "updated" | "already";
}

export interface ManualReviewRecord {
  version: 1;
  execution_id: string;
  ticket_id: string;
  identifier: string;
  branch_name: string | null;
  status: "pending" | "requested" | "resolved";
  review_strategy?: "legacy-model-consensus" | "diversity-of-thought";
  consensus_status: FactoryConsensusRecord["status"] | "not_applicable";
  reason_code: FactoryConsensusRecord["reason_code"] | "persona_dissent" | "persona_unavailable";
  reason: string;
  attempts: FactoryConsensusRecord["attempts"];
  requested_at: string;
  requested_by: "factory";
  linear_comment: "pending" | "created" | "existing";
  linear_state: "pending" | "updated" | "already";
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: "consensus-retry" | "manual-approval" | null;
  note: string | null;
  last_error: string | null;
  /**
   * FH-04 — structured escalation packet. The audit's acceptance criteria
   * require every human escalation to carry the failure class, attempts, route
   * telemetry, remediation already attempted, and one explicit decision. Before
   * this, an operator received a reason string and had to reconstruct the rest.
   */
  escalation?: EscalationPacket | null;
}

export interface ManualReviewRequestOptions {
  state_dir?: string;
  now?: () => string;
  linear_sync?: (input: {
    ticket: ReviewRecoveryTicket;
    execution: ReviewRecoveryExecution;
    consensus: FactoryConsensusRecord;
  }) => Promise<LinearManualReviewResult>;
}

export interface DiversityReviewEvidence {
  terminal_state: string | null;
  dissent_count: number;
  summary: string;
}

export interface DiversityReviewRequestOptions {
  state_dir?: string;
  now?: () => string;
  linear_sync?: (input: {
    ticket: ReviewRecoveryTicket;
    execution: ReviewRecoveryExecution;
    review: DiversityReviewEvidence;
  }) => Promise<LinearManualReviewResult>;
}

interface LinearIssueContext {
  description: string;
  state: { id: string; name: string };
  team: { states: { nodes: Array<{ id: string; name: string }> } };
  comments: { nodes: Array<{ body: string }> };
}

function recordPath(executionId: string, stateDir = DEFAULT_STATE_DIR): string {
  return join(stateDir, `manual-review-${executionId}.json`);
}

function executionPath(executionId: string, stateDir = DEFAULT_STATE_DIR): string {
  return join(stateDir, `exec-${executionId}.json`);
}

function holdPath(executionId: string, stateDir = DEFAULT_STATE_DIR): string {
  return join(stateDir, `hold-${executionId}.json`);
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function manualReviewMarker(executionId: string): string {
  return `<!-- factory-manual-review:${executionId} -->`;
}

function resolutionMarker(executionId: string): string {
  return `<!-- factory-manual-review-resolved:${executionId} -->`;
}

export function manualReviewComment(
  execution: ReviewRecoveryExecution,
  consensus: FactoryConsensusRecord,
): string {
  const attemptCount = Math.max(1, consensus.attempts.length);
  return [
    manualReviewMarker(execution.execution_id),
    "## Factory manual review required",
    "",
    `Execution \`${execution.execution_id}\` completed implementation on branch \`${execution.branch_name ?? "unknown"}\`, but promotion could not be verified.`,
    "",
    `- Consensus outcome: \`${consensus.status}\``,
    `- Gate outcome: \`${consensus.gate_status}\``,
    `- Review attempts: ${attemptCount}`,
    `- Reason: ${consensus.reason ?? "review did not pass"}`,
    "",
    "The factory placed this execution in a durable hold instead of leaving it in silent limbo.",
    "",
    "Operator actions:",
    `- Retry consensus: \`FACTORY_MODEL_REVIEW=operator bun Projects/zouroboros-software-factory/scripts/factory-review-recovery.ts retry ${execution.execution_id} --by <operator>\``,
    `- Approve after manual review: \`bun Projects/zouroboros-software-factory/scripts/factory-review-recovery.ts approve ${execution.execution_id} --by <operator> --note \"review evidence\"\``,
  ].join("\n");
}

export function diversityReviewComment(
  execution: ReviewRecoveryExecution,
  review: DiversityReviewEvidence,
): string {
  return [
    manualReviewMarker(execution.execution_id),
    "## Factory Diversity of Thought review required",
    "",
    `Execution \`${execution.execution_id}\` completed implementation on branch \`${execution.branch_name ?? "unknown"}\`, but one or more required persona reviews did not pass.`,
    "",
    "- Review strategy: `diversity-of-thought`",
    `- Terminal state: \`${review.terminal_state ?? "hold"}\``,
    `- Dissent count: ${review.dissent_count}`,
    `- Reason: ${review.summary}`,
    "",
    "The factory placed this execution in a durable hold. It cannot be released back to an absent worker.",
    "",
    "Operator action:",
    `- Approve after reviewing the dissent, tests, and diff: \`bun Projects/zouroboros-software-factory/scripts/factory-review-recovery.ts approve ${execution.execution_id} --by <operator> --note "review evidence"\``,
  ].join("\n");
}

async function linearGql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set for manual-review escalation");
  const response = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || payload.errors?.length || !payload.data) {
    const detail = payload.errors?.map((item) => item.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Linear manual-review sync failed: ${detail}`);
  }
  return payload.data;
}

async function loadLinearIssue(ticketId: string): Promise<LinearIssueContext> {
  const data = await linearGql<{ issue: LinearIssueContext | null }>(`
    query FactoryManualReviewIssue($id: String!) {
      issue(id: $id) {
        description
        state { id name }
        team { states { nodes { id name } } }
        comments(first: 100) { nodes { body } }
      }
    }
  `, { id: ticketId });
  if (!data.issue) throw new Error(`Linear issue not found: ${ticketId}`);
  return data.issue;
}

export async function syncLinearManualReview(input: {
  ticket: ReviewRecoveryTicket;
  execution: ReviewRecoveryExecution;
  consensus: FactoryConsensusRecord;
}): Promise<LinearManualReviewResult> {
  const issue = await loadLinearIssue(input.ticket.linear_id);
  const marker = manualReviewMarker(input.execution.execution_id);
  let comment: LinearManualReviewResult["comment"] = "existing";
  if (!issue.comments.nodes.some((node) => node.body.includes(marker))) {
    const data = await linearGql<{ commentCreate: { success: boolean } }>(`
      mutation FactoryManualReviewComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }
    `, { input: { issueId: input.ticket.linear_id, body: manualReviewComment(input.execution, input.consensus) } });
    if (!data.commentCreate.success) throw new Error("Linear manual-review comment returned success=false");
    comment = "created";
  }

  let state: LinearManualReviewResult["state"] = "already";
  if (issue.state.name !== MANUAL_REVIEW_STATE) {
    const reviewState = issue.team.states.nodes.find((candidate) => candidate.name === MANUAL_REVIEW_STATE);
    if (!reviewState) throw new Error(`Linear workflow state not found: ${MANUAL_REVIEW_STATE}`);
    const data = await linearGql<{ issueUpdate: { success: boolean } }>(`
      mutation FactoryManualReviewState($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }
    `, { id: input.ticket.linear_id, input: { stateId: reviewState.id } });
    if (!data.issueUpdate.success) throw new Error("Linear manual-review state update returned success=false");
    state = "updated";
  }
  return { comment, state };
}

export async function syncLinearDiversityReview(input: {
  ticket: ReviewRecoveryTicket;
  execution: ReviewRecoveryExecution;
  review: DiversityReviewEvidence;
}): Promise<LinearManualReviewResult> {
  const issue = await loadLinearIssue(input.ticket.linear_id);
  const marker = manualReviewMarker(input.execution.execution_id);
  let comment: LinearManualReviewResult["comment"] = "existing";
  if (!issue.comments.nodes.some((node) => node.body.includes(marker))) {
    const data = await linearGql<{ commentCreate: { success: boolean } }>(`
      mutation FactoryDiversityReviewComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }
    `, { input: { issueId: input.ticket.linear_id, body: diversityReviewComment(input.execution, input.review) } });
    if (!data.commentCreate.success) throw new Error("Linear diversity-review comment returned success=false");
    comment = "created";
  }

  let state: LinearManualReviewResult["state"] = "already";
  if (issue.state.name !== MANUAL_REVIEW_STATE) {
    const reviewState = issue.team.states.nodes.find((candidate) => candidate.name === MANUAL_REVIEW_STATE);
    if (!reviewState) throw new Error(`Linear workflow state not found: ${MANUAL_REVIEW_STATE}`);
    const data = await linearGql<{ issueUpdate: { success: boolean } }>(`
      mutation FactoryDiversityReviewState($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }
    `, { id: input.ticket.linear_id, input: { stateId: reviewState.id } });
    if (!data.issueUpdate.success) throw new Error("Linear diversity-review state update returned success=false");
    state = "updated";
  }
  return { comment, state };
}

export function loadManualReviewRecord(executionId: string, stateDir = DEFAULT_STATE_DIR): ManualReviewRecord | null {
  const path = recordPath(executionId, stateDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ManualReviewRecord : null;
}

export async function requestManualReview(
  execution: ReviewRecoveryExecution,
  ticket: ReviewRecoveryTicket,
  consensus: FactoryConsensusRecord,
  options: ManualReviewRequestOptions = {},
): Promise<ManualReviewRecord> {
  if (consensus.status === "passed") throw new Error("cannot request manual review for a passed consensus result");
  const stateDir = options.state_dir ?? DEFAULT_STATE_DIR;
  const existing = loadManualReviewRecord(execution.execution_id, stateDir);
  if (existing?.status === "requested" || existing?.status === "resolved") return existing;
  const requestedAt = (options.now ?? (() => new Date().toISOString()))();
  // FH-04 — classify before notifying, so the operator is told what kind of
  // failure this is and what single decision is being asked of them.
  const plan = planRepair(consensus);
  const escalation = buildEscalation({
    identifier: ticket.identifier,
    plan,
    attempts: [],
    consensus,
    unresolved: plan.adjudicate,
    decision: plan.reason,
  });
  // FH-07 — a deterministic defect that reaches a second ticket halts the lane
  // before it can propagate to a third. Provider flakiness never counts.
  recordRawFailure({
    project: ticket.identifier.split("-")[0] ?? "unscoped",
    ticket: ticket.identifier,
    execution_id: execution.execution_id,
    message: consensus.reason ?? consensus.status,
    reason_code: consensus.reason_code,
    stage: "consensus",
  }, { base: join(stateDir, "..") });
  const record: ManualReviewRecord = existing ?? {
    version: 1,
    execution_id: execution.execution_id,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    branch_name: execution.branch_name,
    status: "pending",
    review_strategy: "legacy-model-consensus",
    consensus_status: consensus.status,
    reason_code: consensus.reason_code,
    reason: consensus.reason ?? "consensus review did not pass",
    attempts: consensus.attempts,
    requested_at: requestedAt,
    requested_by: "factory",
    linear_comment: "pending",
    linear_state: "pending",
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    note: null,
    last_error: null,
    escalation,
  };
  record.escalation = escalation;
  atomicWrite(recordPath(execution.execution_id, stateDir), record);
  try {
    const linear = await (options.linear_sync ?? syncLinearManualReview)({ ticket, execution, consensus });
    record.status = "requested";
    record.linear_comment = linear.comment;
    record.linear_state = linear.state;
    record.last_error = null;
    atomicWrite(recordPath(execution.execution_id, stateDir), record);
    return record;
  } catch (error) {
    record.last_error = errorMessage(error);
    atomicWrite(recordPath(execution.execution_id, stateDir), record);
    throw error;
  }
}

export async function requestDiversityReview(
  execution: ReviewRecoveryExecution,
  ticket: ReviewRecoveryTicket,
  review: DiversityReviewEvidence,
  options: DiversityReviewRequestOptions = {},
): Promise<ManualReviewRecord> {
  const stateDir = options.state_dir ?? DEFAULT_STATE_DIR;
  const existing = loadManualReviewRecord(execution.execution_id, stateDir);
  if (existing?.status === "requested" || existing?.status === "resolved") return existing;
  const requestedAt = (options.now ?? (() => new Date().toISOString()))();
  const record: ManualReviewRecord = existing ?? {
    version: 1,
    execution_id: execution.execution_id,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    branch_name: execution.branch_name,
    status: "pending",
    review_strategy: "diversity-of-thought",
    consensus_status: "not_applicable",
    reason_code: review.dissent_count > 0 ? "persona_dissent" : "persona_unavailable",
    reason: review.summary,
    attempts: [],
    requested_at: requestedAt,
    requested_by: "factory",
    linear_comment: "pending",
    linear_state: "pending",
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    note: null,
    last_error: null,
    escalation: null,
  };
  record.review_strategy = "diversity-of-thought";
  atomicWrite(recordPath(execution.execution_id, stateDir), record);
  try {
    const linear = await (options.linear_sync ?? syncLinearDiversityReview)({ ticket, execution, review });
    record.status = "requested";
    record.linear_comment = linear.comment;
    record.linear_state = linear.state;
    record.last_error = null;
    atomicWrite(recordPath(execution.execution_id, stateDir), record);
    return record;
  } catch (error) {
    record.last_error = errorMessage(error);
    atomicWrite(recordPath(execution.execution_id, stateDir), record);
    throw error;
  }
}

function applyLifecycle(execution: ReviewRecoveryExecution, lifecycle: ExecutionLifecycle): void {
  execution.state = lifecycle.state;
  execution.delivery_target = lifecycle.delivery_target;
  execution.target_reached = lifecycle.target_reached;
  execution.state_updated_at = lifecycle.state_updated_at;
  execution.evidence = lifecycle.evidence;
  execution.post_merge_survivability = lifecycle.post_merge_survivability;
  execution.post_merge_survivability_reason = lifecycle.post_merge_survivability_reason;
  execution.post_merge_survivability_checks = lifecycle.post_merge_survivability_checks;
}

export function advanceReviewToVerified(
  execution: ReviewRecoveryExecution,
  by: string,
  note: string,
  resolution: "consensus-retry" | "manual-approval",
  timestamp = new Date().toISOString(),
): ReviewRecoveryExecution {
  let lifecycle = normalizeExecutionLifecycle(execution);
  if (lifecycle.state === "held") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "executing", {
      kind: "operator-review-release",
      reference: by,
      recorded_at: timestamp,
      details: { resolution, note },
    }, { now: timestamp });
  }
  if (lifecycle.state === "executing") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "implementation_complete", {
      kind: "review-recovery",
      reference: execution.branch_name ?? execution.execution_id,
      recorded_at: timestamp,
      details: { resolution },
    }, { now: timestamp });
  }
  if (lifecycle.state === "implementation_complete") {
    lifecycle = transitionExecutionLifecycle(lifecycle, "verified", {
      kind: resolution,
      reference: by,
      recorded_at: timestamp,
      details: { note, consensus_id: execution.consensus?.gate_id ?? null },
    }, { now: timestamp });
  }
  if (lifecycle.state !== "verified") throw new Error(`review recovery cannot verify execution from state ${lifecycle.state}`);
  applyLifecycle(execution, lifecycle);
  execution.stage = "verified";
  execution.status = "verified";
  execution.error = null;
  execution.completed_at = timestamp;
  return execution;
}

function loadExecution(executionId: string, stateDir = DEFAULT_STATE_DIR): ReviewRecoveryExecution {
  const path = executionPath(executionId, stateDir);
  if (!existsSync(path)) throw new Error(`execution not found: ${executionId}`);
  return JSON.parse(readFileSync(path, "utf8")) as ReviewRecoveryExecution;
}

function releaseHold(executionId: string, by: string, timestamp: string, stateDir = DEFAULT_STATE_DIR): void {
  const path = holdPath(executionId, stateDir);
  if (!existsSync(path)) return;
  const hold = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  hold.released_by = by;
  hold.released_at = timestamp;
  atomicWrite(path, hold);
}

async function loadRecoveryTicket(ticketId: string, identifier: string): Promise<ReviewRecoveryTicket> {
  const issue = await loadLinearIssue(ticketId);
  return { linear_id: ticketId, identifier, description: issue.description ?? "" };
}

async function syncLinearResolution(
  ticket: ReviewRecoveryTicket,
  execution: ReviewRecoveryExecution,
  by: string,
  resolution: "consensus-retry" | "manual-approval",
): Promise<void> {
  const issue = await loadLinearIssue(ticket.linear_id);
  const marker = resolutionMarker(execution.execution_id);
  if (!issue.comments.nodes.some((node) => node.body.includes(marker))) {
    const body = [
      marker,
      `Factory manual-review hold resolved by **${by}** via \`${resolution}\`.`,
      `Execution \`${execution.execution_id}\` is now \`verified\`; downstream ship-ready processing may resume.`,
    ].join("\n\n");
    const data = await linearGql<{ commentCreate: { success: boolean } }>(`
      mutation FactoryManualReviewResolved($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }
    `, { input: { issueId: ticket.linear_id, body } });
    if (!data.commentCreate.success) throw new Error("Linear manual-review resolution comment returned success=false");
  }
  if (issue.state.name === MANUAL_REVIEW_STATE) {
    const inProgress = issue.team.states.nodes.find((candidate) => candidate.name === "In Progress");
    if (!inProgress) throw new Error("Linear workflow state not found: In Progress");
    const data = await linearGql<{ issueUpdate: { success: boolean } }>(`
      mutation FactoryManualReviewResolvedState($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }
    `, { id: ticket.linear_id, input: { stateId: inProgress.id } });
    if (!data.issueUpdate.success) throw new Error("Linear manual-review resolution state update returned success=false");
  }
}

function markResolved(
  executionId: string,
  by: string,
  note: string,
  resolution: "consensus-retry" | "manual-approval",
  timestamp: string,
  stateDir = DEFAULT_STATE_DIR,
): void {
  const record = loadManualReviewRecord(executionId, stateDir);
  if (!record) throw new Error(`manual-review record not found: ${executionId}`);
  record.status = "resolved";
  record.resolved_at = timestamp;
  record.resolved_by = by;
  record.resolution = resolution;
  record.note = note;
  record.last_error = null;
  atomicWrite(recordPath(executionId, stateDir), record);
}

export async function recoverExecution(input: {
  command: "retry" | "approve";
  executionId: string;
  by: string;
  note: string;
  stateDir?: string;
  consensusOptions?: FactoryConsensusOptions;
}): Promise<ReviewRecoveryExecution> {
  if (input.command === "retry" && !modelReviewAuthorized()) {
    throw new Error("consensus retry requires FACTORY_MODEL_REVIEW=operator for this process");
  }
  const stateDir = input.stateDir ?? DEFAULT_STATE_DIR;
  const execution = loadExecution(input.executionId, stateDir);
  const ticket = await loadRecoveryTicket(execution.ticket_id, execution.identifier);
  let policy: ExecutionPolicy | null = parseModelPolicy(ticket.description);
  let consensus = execution.consensus;

  if (input.command === "retry") {
    const applied = policy ? applyModelPolicy(policy) : null;
    try {
      consensus = await gateCompletedExecution(
        { ...execution, stage: "complete", status: "complete", error: null },
        undefined,
        input.consensusOptions,
      );
    } finally {
      applied?.restore();
    }
    execution.consensus = consensus;
    // FH-06 — append the retry outcome whether it passed or failed. The ZBRE
    // run recorded only the original failure, so a later success was invisible
    // to every journal consumer.
    recordConsensusOutcome(
      { execution_id: execution.execution_id, identifier: execution.identifier },
      consensus,
      { recovery: true, by: input.by },
    );
    if (consensus.status !== "passed") {
      atomicWrite(executionPath(execution.execution_id, stateDir), execution);
      await requestManualReview(execution, ticket, consensus, { state_dir: stateDir });
      throw new Error(`consensus retry did not pass: ${consensus.reason ?? consensus.status}`);
    }
  }

  if (input.command === "approve" && !input.note.trim()) {
    throw new Error("manual approval requires --note with review evidence");
  }

  const review = await runFactoryReviewGate({
    execution_id: execution.execution_id,
    identifier: execution.identifier,
    implementation_summary: execution.result_summary ?? "",
    ticket_context: ticket.description,
    workdir: execution.repo_path ?? DEFAULT_REPO_ROOT,
    policy,
    risk_tier: null,
    state_dir: stateDir,
    // A recovery is substantiated by whichever route got here: an operator who
    // reviewed the work, or a consensus retry that passed. Without this the
    // deterministic-level recovery path would stop advancing under the
    // substantiation guard.
    prior_verification: input.command === "approve"
      ? { kind: "operator", status: "passed", reference: input.by }
      : { kind: "consensus", status: consensus?.status ?? "absent", reference: consensus?.gate_id ?? null },
  }, {
    mode: "enforce",
    consensus: async () => ({
      pass: input.command === "approve" || consensus?.status === "passed",
      summary: input.command === "approve" ? `manual review by ${input.by}` : "consensus retry passed",
      consensus_id: consensus?.gate_id ?? null,
      confidence: null,
    }),
  });
  if (!review.pass) throw new Error(`deterministic recovery review failed: ${review.deterministic.summary}`);

  const timestamp = new Date().toISOString();
  const resolution = input.command === "retry" ? "consensus-retry" : "manual-approval";
  advanceReviewToVerified(execution, input.by, input.note, resolution, timestamp);
  atomicWrite(executionPath(execution.execution_id, stateDir), execution);
  // FH-06 — the lifecycle advance and the hold release are both recovery
  // transitions; the projection must see them, not just the mutable record.
  const subject = { execution_id: execution.execution_id, identifier: execution.identifier };
  recordRecoveryTransition(subject, { state: execution.state, by: input.by, resolution });
  recordManualResolution(subject, {
    by: input.by,
    note: input.note,
    resolution,
    state: execution.state,
  });
  queueShippingRequest(execution as ShippingExecution, { stateDir, now: () => timestamp });
  await syncLinearResolution(ticket, execution, input.by, resolution);
  releaseHold(execution.execution_id, input.by, timestamp, stateDir);
  markResolved(execution.execution_id, input.by, input.note, resolution, timestamp, stateDir);
  return execution;
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  const executionId = Bun.argv[3];
  const { values } = parseArgs({
    args: Bun.argv.slice(4),
    options: {
      by: { type: "string" },
      note: { type: "string", default: "" },
      unchunked: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || !["retry", "approve"].includes(command ?? "")) {
    console.log("Usage: factory-review-recovery.ts <retry|approve> <execution_id> --by <operator> [--note <evidence>] [--unchunked]");
    return;
  }
  if (!executionId || !values.by) throw new Error("execution_id and --by are required");
  const execution = await recoverExecution({
    command: command as "retry" | "approve",
    executionId,
    by: values.by,
    note: values.note,
    consensusOptions: recoveryConsensusOptions(values.unchunked),
  });
  console.log(JSON.stringify({ execution_id: execution.execution_id, identifier: execution.identifier, state: execution.state }, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`FATAL: ${errorMessage(error)}`);
    process.exit(1);
  });
}
