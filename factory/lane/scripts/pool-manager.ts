#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-003 T3 — Pool manager reconcile.
 *
 * Pure, idempotent, file-backed reconcile invoked by the hourly conveyor tick
 * (never a daemon). One cycle:
 *
 *   1. harvest   — result sentinels → assignment outcome, item done/failed, cost fold
 *   2. stall     — in-flight past timeout_min with no result → outcome stale
 *   3. retry     — stale item with attempts < 3 → ready (next failover rung);
 *                  exhausted → park with reason
 *   4. release   — manager-parked items (capacity:/ceiling:) released when the
 *                  blocking condition cleared, never more than headroom
 *   5. dispatch  — ready set up to (20 − global in-flight), per-campaign cost
 *                  ceiling enforced; overflow parks with reason — zero drops
 *
 * Re-running with no new events changes no queue/campaign/assignment state
 * (only a new ReconcileEvent audit record is appended).
 *
 * Modes (SF003_POOL_MODE): plan (default) — full bookkeeping but dispatch is
 * LOG-ONLY (no /zo/ask, items stay ready) · act — real dispatch; workers
 * inherit shadow-state constraints via the prompt.
 *
 * CLI:
 *   bun pool-manager.ts reconcile [--mode plan|act] [--mock]
 *   bun pool-manager.ts events [--last <n>]
 *
 * Exit codes: 0 ok · 1 error · 2 usage.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Campaign,
  type CampaignState,
  type WorkItem,
  addCost,
  ceilingExceeded,
  loadCampaigns,
  loadQueue,
  markItem,
  poolStateDir,
  readySet,
  rollupCampaignState,
  upstreamBlockedItems,
  saveCampaigns,
  saveQueue,
  withPoolMutationLock,
  writeJsonAtomic,
} from "./pool-queue";
import {
  CascadeDispatchError,
  classifyCascadeFailure,
  decideCascadeRetry,
  integrateCascadeWorktree,
  resolveCodingCascadeMode,
  runCascadeValidation,
  type CascadeIntegrationReceipt,
  type CascadeFailure,
} from "./coding-cascade";
import {
  type Assignment,
  dispatchWorker,
  loadAssignments,
  maxAttemptsForPolicy,
  readResult,
  saveAssignment,
} from "./pool-worker";
import {
  recordResultDurable,
  reconcileSupervisor,
  releaseLeaseForAssignment,
  supervisorSnapshot,
  type SupervisorSnapshot,
} from "./worker-supervisor";
import { activeExecutionCount } from "./inflight-cap";
import { reclaimIsolatedWorktree } from "./execution-repository";
import type { ExecutionPolicy } from "./model-policy";
import {
  createEvidenceManifest,
  personaParticipationRecords,
  promotionBlockers,
  readEvidenceManifest,
  writeEvidenceManifest,
} from "./factory-evidence";
import type { PersonaOrchestrationRecord } from "./persona-orchestrator";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReconcileMode = "plan" | "act";

export interface ReconcileEvent {
  event_id: string;
  ran_at: string;
  mode: ReconcileMode;
  harvested: number;
  stalled: number;
  retried: number;
  dispatched: number;
  parked: number;
  released: number;
  capacity_used: number;
  notes: string[];
  campaign_id?: string;
}

export interface PoolRecoveryIntent {
  recovery_id: string;
  campaign_id: string;
  task_id: string;
  reason: string;
  created_at: string;
  execution_policy: ExecutionPolicy;
  verified_models: string[];
  task_description_override?: string;
  prior: {
    campaign_state: CampaignState;
    task_state: WorkItem["state"];
    attempts: number;
    task_description: string;
    assignment_ids: string[];
  };
}

export interface PoolRecoveryEvent extends PoolRecoveryIntent {
  applied_at: string;
  next_campaign_state: CampaignState;
  next_task_state: WorkItem["state"];
}

export interface RetryFailedTaskResult {
  event: PoolRecoveryEvent;
  idempotent: boolean;
}

interface PoolParentExecution {
  execution_id: string;
  identifier: string;
  persona_association?: { sha256?: string };
  persona_participation?: PersonaOrchestrationRecord | PersonaOrchestrationRecord[];
  evidence_manifest?: {
    path: string;
    hash: string;
    mode: "advisory" | "blocking";
    blockers: string[];
  };
}

function factoryStateDir(): string {
  return factoryStateRoot();
}

export function propagatePersonaParticipation(
  campaign: Campaign,
  record: PersonaOrchestrationRecord,
  stateDir = factoryStateDir(),
): { execution_path: string; evidence_path: string; evidence_hash: string } {
  if (!campaign.execution_id) throw new Error(`campaign ${campaign.campaign_id} has no parent execution id`);
  if (record.campaign_id !== campaign.campaign_id) throw new Error("persona record campaign mismatch");
  const executionPath = join(stateDir, `exec-${campaign.execution_id}.json`);
  if (!existsSync(executionPath)) throw new Error(`parent execution record missing: ${executionPath}`);
  const execution = JSON.parse(readFileSync(executionPath, "utf8")) as PoolParentExecution;
  if (execution.execution_id !== campaign.execution_id || execution.identifier !== campaign.identifier) {
    throw new Error("parent execution identity mismatch");
  }
  if (execution.persona_association?.sha256 !== record.association.sha256) {
    throw new Error("parent execution persona association mismatch");
  }
  if (!execution.evidence_manifest?.path) throw new Error("parent execution evidence manifest is not durable yet");

  const records = personaParticipationRecords(execution.persona_participation)
    .filter((candidate) => !(candidate.campaign_id === record.campaign_id && candidate.task_id === record.task_id));
  records.push(record);
  records.sort((left, right) => `${left.campaign_id}/${left.task_id}`.localeCompare(`${right.campaign_id}/${right.task_id}`));

  const prior = readEvidenceManifest(execution.evidence_manifest.path);
  if (prior.execution_id !== execution.execution_id || prior.ticket !== campaign.identifier) {
    throw new Error("parent evidence identity mismatch");
  }
  const { content_hash: _priorHash, ...unsigned } = prior;
  const next = createEvidenceManifest({
    ...unsigned,
    generated_at: record.updated_at,
    persona_participation: records,
  });
  const evidencePath = writeEvidenceManifest(next, dirname(execution.evidence_manifest.path));
  execution.persona_participation = records;
  execution.evidence_manifest = {
    path: evidencePath,
    hash: next.content_hash,
    mode: next.rollout_mode,
    blockers: promotionBlockers(next),
  };
  writeJsonAtomic(executionPath, execution);
  return { execution_path: executionPath, evidence_path: evidencePath, evidence_hash: next.content_hash };
}

export interface PoolHandoffResult {
  campaign_id: string;
  reachability: "active_assignment" | "reconcile_attempted" | "parked_with_retry" | "terminal";
  reason: string;
  assignment_id: string | null;
  reconcile_event_id: string | null;
}

// ─── Config ───────────────────────────────────────────────────────────────────

// SF-003 POOL lane ceiling only (shared with non-pool dispatches via
// externalInFlight subtraction). NOT the conveyor's serial-lane concurrency
// limit — that is FACTORY_INFLIGHT_CAP (inflight-cap.ts, ZOU-925). Effective
// only while SF003_POOL=1; do not read this constant as the factory cap.
export const POOL_GLOBAL_CAP = 20;
export const MAX_ATTEMPTS = 3; // initial + ≤2 retries; equals failover-chain length

const EXEC_STATE_DIR = factoryStateRoot();

export function currentReconcileMode(): ReconcileMode {
  const raw = process.env.SF003_POOL_MODE ?? "plan";
  if (raw !== "plan" && raw !== "act") {
    throw new Error(`SF003_POOL_MODE invalid: "${raw}" (plan|act)`);
  }
  return raw;
}

function eventsPath(): string {
  return join(poolStateDir(), "events.jsonl");
}

// ─── Shared-capacity accounting ───────────────────────────────────────────────

/** Non-pool in-flight: swarm-exec PipelineExecution records still open (held ≠ in-flight). */
export function externalInFlight(): number {
  return activeExecutionCount(EXEC_STATE_DIR);
}

// ─── Reconcile ────────────────────────────────────────────────────────────────

export interface ReconcileOpts {
  mode?: ReconcileMode;
  mock?: boolean; // forwarded to dispatchWorker — self-test only, no /zo/ask
  shadow_phase?: string; // forwarded into worker prompts in act mode
  now?: Date; // injectable clock for stall tests
  campaign_id?: string; // optional single-campaign scope for recovery/resume
  task_id?: string; // optional single-task scope inside a campaign
  max_dispatch?: number; // bounded handoff dispatch; normal reconciles remain unbounded
  target_repo?: string; // explicit worker/review worktree for recovery handoffs
}

export async function reconcile(opts: ReconcileOpts = {}): Promise<ReconcileEvent> {
  const mode = opts.mode ?? currentReconcileMode();
  const cascadeMode = resolveCodingCascadeMode();
  const logOnly = mode === "plan";
  const nowMs = (opts.now ?? new Date()).getTime();
  const notes: string[] = [];
  let harvested = 0;
  let stalled = 0;
  let retried = 0;
  let dispatched = 0;
  let parked = 0;
  let released = 0;

  if (!logOnly) {
    const supervisor = reconcileSupervisor({ assignments: loadAssignments(), now: opts.now ?? new Date() });
    if (supervisor.renewed > 0) notes.push(`supervisor renewed ${supervisor.renewed} lease(s)`);
    if (supervisor.released > 0) notes.push(`supervisor released ${supervisor.released} terminal lease(s)`);
    if (supervisor.expired > 0) notes.push(`supervisor expired ${supervisor.expired} lease(s) and filed ${supervisor.dead_letters} dead letter(s)`);
  }

  const openAssignments = loadAssignments().filter(
    (a) => a.outcome === null
      && (!opts.campaign_id || a.campaign_id === opts.campaign_id)
      && (!opts.task_id || a.task_id === opts.task_id),
  );

  // 1. Harvest result sentinels.
  for (const a of openAssignments) {
    const result = readResult(a);
    if (!result) continue;
    if (logOnly) {
      notes.push(`would-harvest ${a.assignment_id} → ${result.outcome} (plan mode — log only)`);
      continue;
    }
    recordResultDurable(a.assignment_id, new Date(result.completed_at));
    const assignmentCascadeMode = a.cascade_mode ?? cascadeMode;
    const campaign = loadCampaigns()[a.campaign_id];
    let effectiveOutcome = result.outcome;
    const resultPersona = result.persona_orchestration;
    const assignmentPersona = a.persona_orchestration;
    if (Boolean(resultPersona) !== Boolean(assignmentPersona)) {
      a.failure = classifyCascadeFailure({
        cause: "governance",
        detail: "persona provenance must be present in both assignment and durable result",
      });
      effectiveOutcome = "failure";
    } else if (resultPersona && assignmentPersona && JSON.stringify(resultPersona) !== JSON.stringify(assignmentPersona)) {
      a.failure = classifyCascadeFailure({
        cause: "governance",
        detail: "persona provenance differs between assignment and durable result",
      });
      effectiveOutcome = "failure";
    } else if (resultPersona && assignmentPersona) {
      try {
        if (!campaign) throw new Error(`campaign ${a.campaign_id} is missing`);
        const propagated = propagatePersonaParticipation(campaign, resultPersona);
        notes.push(`persona-evidence ${a.assignment_id} → ${propagated.evidence_hash}`);
      } catch (error) {
        a.failure = classifyCascadeFailure({
          cause: "governance",
          detail: `persona provenance propagation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        effectiveOutcome = "failure";
      }
    }
    if (assignmentCascadeMode === "enforce") {
      const receiptPath = join(poolStateDir(), "integrations", `${a.assignment_id}.json`);
      if (!campaign?.target_repository || !a.worktree_path || !a.base_commit || !campaign.validation_commands?.length) {
        a.failure = classifyCascadeFailure({
          cause: "unsafe_scope",
          detail: "cascade harvest is missing repository, worktree, base, or validation provenance",
        });
        effectiveOutcome = "failure";
      } else {
        try {
          if (existsSync(receiptPath)) {
            a.integration = JSON.parse(readFileSync(receiptPath, "utf8")) as CascadeIntegrationReceipt;
            a.validation = a.integration.validation;
          } else {
            a.validation = runCascadeValidation({
              worktree: a.worktree_path,
              commands: campaign.validation_commands,
            });
          }
          if (!a.validation.pass && !a.failure) {
            const failed = a.validation.checks.find((check) => !check.pass);
            a.failure = classifyCascadeFailure({
              cause: "mechanical_validation",
              detail: failed?.summary ?? "factory-owned validation failed",
            });
          }
          if (result.outcome === "success" && !a.failure) {
            const receipt = withPoolMutationLock(() => integrateCascadeWorktree({
              assignment_id: a.assignment_id,
              campaign_id: a.campaign_id,
              task_id: a.task_id,
              source_worktree: a.worktree_path!,
              target_repository: campaign.target_repository!,
              base_commit: a.base_commit!,
              receipt_path: receiptPath,
              validation: a.validation!,
            }));
            a.integration = receipt;
            a.integration_receipt_path = receiptPath;
            a.implementation_commit = receipt.implementation_commit;
            a.patch_sha256 = receipt.patch_sha256;
            try {
              reclaimIsolatedWorktree(
                { ticketIds: [a.assignment_id], worktreePath: a.worktree_path },
                { allowDirtyWithRecoveryManifest: receiptPath },
              );
            } catch (error) {
              a.cleanup_error = error instanceof Error ? error.message : String(error);
              notes.push(`cleanup-deferred ${a.assignment_id}: ${a.cleanup_error}`);
            }
          }
        } catch (error) {
          a.failure = classifyCascadeFailure({
            cause: "unsafe_scope",
            detail: `cascade validation or integration failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        if (a.failure) effectiveOutcome = "failure";
      }
    }
    a.outcome = effectiveOutcome;
    a.completed_at = result.completed_at;
    if (effectiveOutcome === "success") {
      saveAssignment(a);
      markItem(a.campaign_id, a.task_id, "done");
    } else {
      const failure = a.failure ?? classifyCascadeFailure({
        cause: "worker_failure",
        detail: result.summary,
        review: a.review,
      });
      const decision = decideCascadeRetry({
        mode: assignmentCascadeMode,
        failure,
        attempts_made: a.attempt + 1,
        max_attempts: maxAttemptsForPolicy(campaign?.execution_policy),
      });
      if (assignmentCascadeMode !== "off") {
        a.failure = failure;
        a.cascade_decision = decision;
      }
      saveAssignment(a);
      if (decision.action === "retry") {
        markItem(a.campaign_id, a.task_id, "ready");
        retried++;
        notes.push(`cascade-retry ${a.assignment_id} (${failure.kind}) → next model`);
      } else if (decision.action === "exhausted") {
        markItem(a.campaign_id, a.task_id, "parked", {
          park_reason: `cascade: ${failure.kind} retries exhausted (${decision.attempts_made}/${decision.max_attempts})`,
        });
        parked++;
      } else {
        markItem(a.campaign_id, a.task_id, "failed");
        if (decision.action === "would_retry") {
          notes.push(`cascade-shadow ${a.assignment_id}: would retry ${failure.kind}; incumbent state preserved`);
        }
      }
    }
    if (typeof result.cost_usd === "number" && result.cost_usd > 0) {
      addCost(a.campaign_id, result.cost_usd);
    }
    releaseLeaseForAssignment(a.assignment_id, result.outcome, new Date(result.completed_at));
    harvested++;
    notes.push(`harvest ${a.assignment_id} → ${effectiveOutcome}`);
  }

  // 2 + 3. Stall detection → bounded retry with next failover rung, or park.
  for (const a of openAssignments) {
    if (a.outcome !== null) continue; // harvested above
    const ageMin = (nowMs - new Date(a.started_at).getTime()) / 60000;
    if (ageMin < a.timeout_min) continue;
    if (logOnly) {
      notes.push(`would-stale ${a.assignment_id} (attempt ${a.attempt}, ${ageMin.toFixed(0)}min; plan mode — log only)`);
      continue;
    }
    a.outcome = "stale";
    a.completed_at = new Date(nowMs).toISOString();
    const campaign = loadCampaigns()[a.campaign_id];
    const assignmentCascadeMode = a.cascade_mode ?? cascadeMode;
    const timeoutFailure = classifyCascadeFailure({
      cause: "timeout",
      detail: `assignment exceeded ${a.timeout_min} minute timeout`,
    });
    const cascadeDecision = decideCascadeRetry({
      mode: assignmentCascadeMode,
      failure: timeoutFailure,
      attempts_made: a.attempt + 1,
      max_attempts: maxAttemptsForPolicy(campaign?.execution_policy),
    });
    if (assignmentCascadeMode !== "off") {
      a.failure = timeoutFailure;
      a.cascade_decision = cascadeDecision;
    }
    saveAssignment(a);
    releaseLeaseForAssignment(a.assignment_id, "stale", new Date(nowMs));
    stalled++;
    const item = loadQueue().find((i) => i.campaign_id === a.campaign_id && i.task_id === a.task_id);
    if (!item) {
      notes.push(`stale ${a.assignment_id}: work item missing (parked elsewhere?)`);
      continue;
    }
    if (item.state !== "in-flight") {
      notes.push(`stale ${a.assignment_id}: item already ${item.state}, no action`);
      continue;
    }
    if (assignmentCascadeMode === "enforce" && cascadeDecision.action === "retry") {
      markItem(a.campaign_id, a.task_id, "ready");
      retried++;
      notes.push(`stale ${a.assignment_id} (attempt ${a.attempt}, ${ageMin.toFixed(0)}min) → cascade retry on next model`);
    } else if (assignmentCascadeMode !== "enforce" && item.attempts < MAX_ATTEMPTS) {
      markItem(a.campaign_id, a.task_id, "ready");
      retried++;
      notes.push(`stale ${a.assignment_id} (attempt ${a.attempt}, ${ageMin.toFixed(0)}min) → retry on incumbent next rung${cascadeDecision.action === "would_retry" ? " (cascade shadow: would retry)" : ""}`);
    } else {
      markItem(a.campaign_id, a.task_id, "parked", {
        park_reason: `${assignmentCascadeMode === "enforce" ? "cascade" : "stall"}: retries exhausted (${item.attempts} attempts, failover chain exhausted)`,
      });
      parked++;
      notes.push(`stale ${a.assignment_id} → PARKED (chain exhausted)`);
    }
  }

  // Capacity after harvest/stall.
  const poolInFlight = loadQueue().filter((i) => i.state === "in-flight").length;
  const external = externalInFlight();
  let headroom = Math.max(0, POOL_GLOBAL_CAP - poolInFlight - external);

  // 4 + 5 are ACTIONS the manager takes — in plan mode they are log-only
  // (no queue mutation), which is what makes a plan reconcile a strict no-op.
  // 4. Release manager parks whose blocking condition cleared (≤ headroom → no flip-flop).
  const campaignsNow = loadCampaigns();
  for (const i of loadQueue()) {
    if (opts.campaign_id && i.campaign_id !== opts.campaign_id) continue;
    if (i.state !== "parked" || !i.park_reason) continue;
    const c = campaignsNow[i.campaign_id];
    if (!c) continue;
    if (i.park_reason.startsWith("capacity:") && headroom > 0 && !ceilingExceeded(c)) {
      if (!logOnly) {
        markItem(i.campaign_id, i.task_id, "ready");
        released++;
      }
      headroom--; // reserve the slot the released item will consume at dispatch
      notes.push(`${logOnly ? "would-release" : "release"} ${i.campaign_id}/${i.task_id} (capacity available)`);
    } else if (i.park_reason.startsWith("ceiling:") && !ceilingExceeded(c)) {
      if (!logOnly) {
        markItem(i.campaign_id, i.task_id, "ready");
        released++;
      }
      notes.push(`${logOnly ? "would-release" : "release"} ${i.campaign_id}/${i.task_id} (ceiling cleared)`);
    }
  }
  headroom = Math.max(0, POOL_GLOBAL_CAP - loadQueue().filter((i) => i.state === "in-flight").length - external);

  // 5. Dispatch ready set up to headroom; ceiling breach / overflow park — zero drops.
  const campaigns = loadCampaigns();
  const pendingIntents = loadPendingRecoveryIntents().filter(
    (intent) => (!opts.campaign_id || intent.campaign_id === opts.campaign_id)
      && (!opts.task_id || intent.task_id === opts.task_id),
  );
  const pendingRecoveries = new Set(pendingIntents.map((intent) => intent.campaign_id));
  for (const intent of pendingIntents) {
    notes.push(`recovery-pending ${intent.campaign_id}/${intent.task_id}: dispatch blocked until intent is applied`);
  }
  const ready = readySet().filter(
    (item) => (!opts.campaign_id || item.campaign_id === opts.campaign_id)
      && (!opts.task_id || item.task_id === opts.task_id),
  );
  let dispatchAttempts = 0;
  for (const item of ready) {
    if (opts.max_dispatch !== undefined && dispatchAttempts >= opts.max_dispatch) break;
    const campaign = campaigns[item.campaign_id];
    if (!campaign) continue;
    if (pendingRecoveries.has(item.campaign_id)) {
      notes.push(`recovery-pending ${item.campaign_id}/${item.task_id}: dispatch blocked until intent is applied`);
      continue;
    }
    if (ceilingExceeded(campaign)) {
      if (!logOnly) {
        markItem(item.campaign_id, item.task_id, "parked", {
          park_reason: `ceiling: cost ceiling reached ($${campaign.cost_spent_usd.toFixed(2)}/$${campaign.cost_ceiling_usd.toFixed(2)})`,
        });
        parked++;
      }
      notes.push(`${logOnly ? "would-park" : "park"} ${item.campaign_id}/${item.task_id} (ceiling)`);
      continue;
    }
    if (headroom <= 0) {
      if (!logOnly) {
        markItem(item.campaign_id, item.task_id, "parked", {
          park_reason: `capacity: global cap ${POOL_GLOBAL_CAP} reached (pool+external in-flight)`,
        });
        parked++;
      }
      notes.push(`${logOnly ? "would-park" : "park"} ${item.campaign_id}/${item.task_id} (capacity)`);
      continue;
    }
    if (logOnly) {
      notes.push(`would-dispatch ${item.campaign_id}/${item.task_id} (plan mode — log only)`);
      headroom--; // planned slot still counts against this cycle's budget
      dispatchAttempts++;
      continue;
    }
    dispatchAttempts++;
    try {
      const a = await dispatchWorker(campaign, item, {
        mock: opts.mock === true,
        ctx: {
          shadow_phase: opts.shadow_phase ?? "dry-run",
          ...(opts.target_repo ? { target_repo: opts.target_repo } : {}),
        },
      });
      dispatched++;
      notes.push(`dispatch ${a.assignment_id} (${a.model.slice(0, 13)}…, attempt ${a.attempt})`);
    } catch (err: any) {
      const failedAssignment = loadAssignments()
        .filter((candidate) => candidate.campaign_id === item.campaign_id && candidate.task_id === item.task_id && candidate.outcome === null)
        .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
      if (failedAssignment) {
        const cause = err instanceof CascadeDispatchError ? err.failureKind : "unknown";
        const failure: CascadeFailure = classifyCascadeFailure({ cause, detail: String(err?.message ?? err) });
        const campaign = loadCampaigns()[item.campaign_id];
        const decision = decideCascadeRetry({
          mode: cascadeMode,
          failure,
          attempts_made: failedAssignment.attempt + 1,
          max_attempts: maxAttemptsForPolicy(campaign?.execution_policy),
        });
        failedAssignment.outcome = "failure";
        failedAssignment.completed_at = new Date(
          Math.max(Date.now(), new Date(failedAssignment.started_at).getTime()),
        ).toISOString();
        if (cascadeMode !== "off") {
          failedAssignment.failure = failure;
          failedAssignment.cascade_decision = decision;
        }
        saveAssignment(failedAssignment);
        releaseLeaseForAssignment(failedAssignment.assignment_id, "failure", new Date(failedAssignment.completed_at));
        if (decision.action === "retry") {
          markItem(item.campaign_id, item.task_id, "ready");
          retried++;
          notes.push(`dispatch-retry ${failedAssignment.assignment_id}: ${failure.kind} → next model`);
          headroom--;
          continue;
        }
      }
      markItem(item.campaign_id, item.task_id, "parked", {
        park_reason: `dispatch: ${String(err?.message ?? err).slice(0, 500)}; explicit retry required`,
      });
      parked++;
      notes.push(`dispatch-failed ${item.campaign_id}/${item.task_id}: ${err.message} (parked for explicit retry)`);
    }
    headroom--;
  }

  // FR-05 visibility: ready items held back by an incomplete upstream campaign
  // are invisible to the ready set by design — surface them in the audit trail
  // so a blocked chain is diagnosable from events alone.
  for (const b of upstreamBlockedItems()) {
    if (opts.campaign_id && b.item.campaign_id !== opts.campaign_id) continue;
    notes.push(`blocked-upstream ${b.item.campaign_id}/${b.item.task_id} (waiting on ${b.waiting_on.join(",")})`);
  }

  const event: ReconcileEvent = {
    event_id: `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ran_at: new Date(nowMs).toISOString(),
    mode,
    harvested,
    stalled,
    retried,
    dispatched,
    parked,
    released,
    capacity_used: loadQueue().filter((i) => i.state === "in-flight").length + external,
    notes,
    ...(opts.campaign_id ? { campaign_id: opts.campaign_id } : {}),
  };
  mkdirSync(poolStateDir(), { recursive: true });
  appendFileSync(eventsPath(), JSON.stringify(event) + "\n");
  return event;
}

function recoveryEventsPath(): string {
  return join(poolStateDir(), "recoveries.jsonl");
}

function recoveryIntentPath(recoveryId: string): string {
  return join(poolStateDir(), "recovery-intents", `${recoveryId}.json`);
}

export function loadRecoveryEvents(): PoolRecoveryEvent[] {
  if (!existsSync(recoveryEventsPath())) return [];
  const events: PoolRecoveryEvent[] = [];
  for (const line of readFileSync(recoveryEventsPath(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as PoolRecoveryEvent);
    } catch {
      // A torn append cannot hide earlier recovery evidence.
    }
  }
  return events;
}

export function loadPendingRecoveryIntents(): PoolRecoveryIntent[] {
  const dir = join(poolStateDir(), "recovery-intents");
  if (!existsSync(dir)) return [];
  const applied = new Set(loadRecoveryEvents().map((event) => event.recovery_id));
  const pending: PoolRecoveryIntent[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    try {
      const intent = JSON.parse(readFileSync(join(dir, file), "utf8")) as PoolRecoveryIntent;
      if (!applied.has(intent.recovery_id)) pending.push(intent);
    } catch {
      // A malformed intent blocks no unrelated campaign; retry validation still fails closed.
    }
  }
  return pending;
}

function samePolicy(a: ExecutionPolicy | null | undefined, b: ExecutionPolicy): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

export function retryFailedTask(opts: {
  recovery_id: string;
  campaign_id: string;
  task_id: string;
  reason: string;
  execution_policy: ExecutionPolicy;
  verified_models: string[];
  task_description_override?: string;
  fault_after_policy?: boolean;
  now?: Date;
}): RetryFailedTaskResult {
  if (!/^[A-Za-z0-9._-]{3,120}$/.test(opts.recovery_id)) throw new Error("recovery_id must be a safe 3-120 character identifier");
  if (!opts.reason.trim()) throw new Error("recovery reason must not be empty");
  const chain = opts.execution_policy.model_chain;
  if (chain.length !== MAX_ATTEMPTS || new Set(chain).size !== chain.length) {
    throw new Error(`recovery model_chain must contain exactly ${MAX_ATTEMPTS} distinct models`);
  }
  const verified = new Set(opts.verified_models);
  const unverified = chain.filter((model) => !verified.has(model));
  if (unverified.length > 0) throw new Error(`recovery model_chain contains unverified model(s): ${unverified.join(",")}`);
  const canonicalVerified = [...verified].sort();

  return withPoolMutationLock(() => {
    const priorEvent = loadRecoveryEvents().find((event) => event.recovery_id === opts.recovery_id);
    if (priorEvent) {
      const eventVerified = [...priorEvent.verified_models].sort();
      if (
        priorEvent.campaign_id !== opts.campaign_id
        || priorEvent.task_id !== opts.task_id
        || priorEvent.reason !== opts.reason.trim()
        || !samePolicy(priorEvent.execution_policy, opts.execution_policy)
        || JSON.stringify(eventVerified) !== JSON.stringify(canonicalVerified)
        || priorEvent.task_description_override !== opts.task_description_override
      ) {
        throw new Error(`recovery ${opts.recovery_id} was already applied with different inputs`);
      }
      return { event: priorEvent, idempotent: true };
    }

    const campaigns = loadCampaigns();
    const campaign = campaigns[opts.campaign_id];
    if (!campaign) throw new Error(`no campaign ${opts.campaign_id}`);
    const queue = loadQueue();
    const item = queue.find((candidate) => candidate.campaign_id === opts.campaign_id && candidate.task_id === opts.task_id);
    if (!item) throw new Error(`no work item (${opts.campaign_id}, ${opts.task_id})`);
    const open = loadAssignments().filter(
      (assignment) => assignment.campaign_id === opts.campaign_id && assignment.task_id === opts.task_id && assignment.outcome === null,
    );
    if (open.length > 0) throw new Error(`cannot recover ${opts.campaign_id}/${opts.task_id}: open assignment ${open[0].assignment_id}`);

    const done = new Set(queue.filter((candidate) => candidate.campaign_id === opts.campaign_id && candidate.state === "done").map((candidate) => candidate.task_id));
    const unmet = item.deps.filter((dependency) => !done.has(dependency));
    if (unmet.length > 0) throw new Error(`cannot recover ${opts.campaign_id}/${opts.task_id}: unmet dependencies ${unmet.join(",")}`);

    const recoverableDispatchPark = item.state === "parked"
      && item.park_reason?.startsWith("dispatch:") === true
      && item.park_reason.includes("explicit retry required");
    const recoverableState = item.state === "failed" || recoverableDispatchPark;
    const intentPath = recoveryIntentPath(opts.recovery_id);
    let intent: PoolRecoveryIntent;
    if (existsSync(intentPath)) {
      intent = JSON.parse(readFileSync(intentPath, "utf8")) as PoolRecoveryIntent;
      const intentVerified = [...intent.verified_models].sort();
      if (
        intent.campaign_id !== opts.campaign_id
        || intent.task_id !== opts.task_id
        || intent.reason !== opts.reason.trim()
        || !samePolicy(intent.execution_policy, opts.execution_policy)
        || JSON.stringify(intentVerified) !== JSON.stringify(canonicalVerified)
        || intent.task_description_override !== opts.task_description_override
      ) {
        throw new Error(`recovery intent ${opts.recovery_id} does not match this request`);
      }
    } else {
      if (!recoverableState) {
        throw new Error(
          `cannot recover ${opts.campaign_id}/${opts.task_id}: task is ${item.state}, expected failed or dispatch-parked`,
        );
      }
      intent = {
        recovery_id: opts.recovery_id,
        campaign_id: opts.campaign_id,
        task_id: opts.task_id,
        reason: opts.reason.trim(),
        created_at: (opts.now ?? new Date()).toISOString(),
        execution_policy: opts.execution_policy,
        verified_models: canonicalVerified,
        ...(opts.task_description_override !== undefined ? { task_description_override: opts.task_description_override } : {}),
        prior: {
          campaign_state: campaign.state,
          task_state: item.state,
          attempts: item.attempts,
          task_description: item.description,
          assignment_ids: loadAssignments()
            .filter((assignment) => assignment.campaign_id === opts.campaign_id && assignment.task_id === opts.task_id)
            .map((assignment) => assignment.assignment_id)
            .sort(),
        },
      };
      writeJsonAtomic(intentPath, intent);
    }

    if (recoverableState) {
      campaign.execution_policy = opts.execution_policy;
      saveCampaigns(campaigns);
      if (opts.fault_after_policy) throw new Error("injected recovery fault after policy write");
      item.state = "ready";
      item.attempts = 0;
      item.park_reason = null;
      if (intent.task_description_override !== undefined) item.description = intent.task_description_override;
      item.updated_at = (opts.now ?? new Date()).toISOString();
      campaign.state = rollupCampaignState(queue.filter((candidate) => candidate.campaign_id === opts.campaign_id));
      saveQueue(queue);
      saveCampaigns(campaigns);
    } else if (!(item.state === "ready" && item.attempts === 0 && samePolicy(campaign.execution_policy, opts.execution_policy))) {
      throw new Error(`recovery intent ${opts.recovery_id} is incomplete but live state is ${item.state}/${item.attempts}`);
    }

    const event: PoolRecoveryEvent = {
      ...intent,
      applied_at: (opts.now ?? new Date()).toISOString(),
      next_campaign_state: campaign.state,
      next_task_state: item.state,
    };
    appendFileSync(recoveryEventsPath(), JSON.stringify(event) + "\n");
    return { event, idempotent: false };
  });
}

export async function reconcilePoolHandoff(
  campaignId: string,
  opts: Omit<ReconcileOpts, "campaign_id"> = {},
): Promise<PoolHandoffResult> {
  const campaign = loadCampaigns()[campaignId];
  if (!campaign) throw new Error(`no campaign ${campaignId}`);
  const before = loadAssignments().find(
    (assignment) => assignment.campaign_id === campaignId
      && assignment.outcome === null
      && (!opts.task_id || assignment.task_id === opts.task_id),
  );
  if (before) {
    return {
      campaign_id: campaignId,
      reachability: "active_assignment",
      reason: `assignment ${before.assignment_id} is open`,
      assignment_id: before.assignment_id,
      reconcile_event_id: null,
    };
  }
  if (campaign.state === "complete" || campaign.state === "failed") {
    return {
      campaign_id: campaignId,
      reachability: "terminal",
      reason: `campaign is ${campaign.state}; explicit operator retry is required`,
      assignment_id: null,
      reconcile_event_id: null,
    };
  }

  const mode = opts.mode ?? currentReconcileMode();
  const event = await reconcile({ ...opts, mode, campaign_id: campaignId, max_dispatch: 1 });
  const dispatchFailure = event.notes.find((note) => note.startsWith(`dispatch-failed ${campaignId}/`));
  if (dispatchFailure) {
    const assignment = loadAssignments()
      .filter((candidate) => candidate.campaign_id === campaignId && (!opts.task_id || candidate.task_id === opts.task_id))
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    return {
      campaign_id: campaignId,
      reachability: "parked_with_retry",
      reason: dispatchFailure,
      assignment_id: assignment?.assignment_id ?? null,
      reconcile_event_id: event.event_id,
    };
  }

  const assignment = loadAssignments().find(
    (candidate) => candidate.campaign_id === campaignId
      && candidate.outcome === null
      && (!opts.task_id || candidate.task_id === opts.task_id),
  );
  if (assignment) {
    return {
      campaign_id: campaignId,
      reachability: "active_assignment",
      reason: `assignment ${assignment.assignment_id} is open after reconcile`,
      assignment_id: assignment.assignment_id,
      reconcile_event_id: event.event_id,
    };
  }
  const after = loadCampaigns()[campaignId];
  if (after.state === "complete" || after.state === "failed") {
    return {
      campaign_id: campaignId,
      reachability: "terminal",
      reason: `campaign reached ${after.state} during reconcile`,
      assignment_id: null,
      reconcile_event_id: event.event_id,
    };
  }
  return {
    campaign_id: campaignId,
    reachability: mode === "plan" ? "parked_with_retry" : "reconcile_attempted",
    reason: mode === "plan"
      ? `pool reconcile is plan-only; rerun with SF003_POOL_MODE=act for campaign ${campaignId}`
      : `reconcile ${event.event_id} produced no open assignment; inspect event notes and retry explicitly`,
    assignment_id: null,
    reconcile_event_id: event.event_id,
  };
}

export function loadEvents(): ReconcileEvent[] {
  if (!existsSync(eventsPath())) return [];
  const events: ReconcileEvent[] = [];
  for (const l of readFileSync(eventsPath(), "utf8").split("\n")) {
    if (l.trim().length === 0) continue;
    try {
      events.push(JSON.parse(l) as ReconcileEvent);
    } catch {
      // appendFileSync is not atomic — a torn line must not make the whole audit history unreadable
    }
  }
  return events;
}

// ─── SF-003 snapshot (shadow-validate reporting; read-only, never creates state) ─

export interface SF003CampaignProgress {
  campaign_id: string;
  identifier: string;
  state: CampaignState;
  tasks_total: number;
  tasks_done: number;
  tasks_failed: number;
  tasks_parked: number;
  cost_spent_usd: number;
  cost_ceiling_usd: number;
  depends_on_campaigns: string[];
  waiting_on_upstream: string[];
}

export interface SF003Snapshot {
  pool_enabled: boolean;
  mode: ReconcileMode;
  queue_depth_ready: number;
  in_flight: number;
  external_in_flight: number;
  capacity_used: number;
  global_cap: number;
  supervisor: SupervisorSnapshot;
  parked: { campaign_id: string; task_id: string; reason: string }[];
  retried_items: number; // work items dispatched more than once
  /** FR-05 starvation visibility: minutes the longest-waiting dispatchable item has been ready. */
  oldest_ready_wait_min: number | null;
  /** FR-05: ready items whose campaign waits on incomplete upstream campaigns. */
  upstream_blocked: { campaign_id: string; task_id: string; waiting_on: string[] }[];
  failover_dispatches: number; // assignments on rung > 1 of the model chain
  campaigns: SF003CampaignProgress[];
  reconcile_events: number;
  last_reconcile: string | null;
  fleet_separation_ok: boolean;
  fleet_separation_reason: string;
}

export function sf003Snapshot(): SF003Snapshot {
  let mode: ReconcileMode;
  try {
    mode = currentReconcileMode();
  } catch {
    mode = "plan";
  }

  const items = loadQueue();
  const campaignMap = loadCampaigns();
  const assignments = loadAssignments();
  const events = loadEvents();
  const supervisor = supervisorSnapshot();

  const inFlight = items.filter((i) => i.state === "in-flight").length;
  const external = externalInFlight();

  const campaigns: SF003CampaignProgress[] = Object.values(campaignMap).map((c) => {
    const mine = items.filter((i) => i.campaign_id === c.campaign_id);
    return {
      campaign_id: c.campaign_id,
      identifier: c.identifier,
      state: c.state,
      tasks_total: mine.length,
      tasks_done: mine.filter((i) => i.state === "done").length,
      tasks_failed: mine.filter((i) => i.state === "failed").length,
      tasks_parked: mine.filter((i) => i.state === "parked").length,
      cost_spent_usd: c.cost_spent_usd,
      cost_ceiling_usd: c.cost_ceiling_usd,
      depends_on_campaigns: c.depends_on_campaigns ?? [],
      waiting_on_upstream: (c.depends_on_campaigns ?? []).filter((dep) => campaignMap[dep]?.state !== "complete"),
    };
  });

  const dispatchable = readySet(items, campaignMap);
  const nowMs = Date.now();
  const oldestReadyWaitMin = dispatchable.length > 0
    ? Math.max(...dispatchable.map((i) => (nowMs - new Date(i.updated_at).getTime()) / 60000))
    : null;
  const upstreamBlocked = upstreamBlockedItems(items, campaignMap).map((b) => ({
    campaign_id: b.item.campaign_id,
    task_id: b.item.task_id,
    waiting_on: b.waiting_on,
  }));

  // Fleet separation: pool workers are ephemeral /zo/ask children — pool state
  // must contain zero scheduled-agent references. Scan raw assignment records
  // for agent/automation ids (none exist by construction; this proves it on disk).
  const assignDir = join(poolStateDir(), "assignments");
  let offenders = 0;
  if (existsSync(assignDir)) {
    for (const f of readdirSync(assignDir)) {
      if (!f.endsWith(".json")) continue;
      const raw = readFileSync(join(assignDir, f), "utf8");
      if (/"(agent_id|automation_id|schedule|cron)"/.test(raw)) offenders++;
    }
  }
  const fleetOk = offenders === 0;

  return {
    pool_enabled: process.env.SF003_POOL === "1",
    mode,
    queue_depth_ready: dispatchable.length,
    in_flight: inFlight,
    external_in_flight: external,
    capacity_used: inFlight + external,
    global_cap: POOL_GLOBAL_CAP,
    supervisor,
    parked: items
      .filter((i) => i.state === "parked")
      .map((i) => ({ campaign_id: i.campaign_id, task_id: i.task_id, reason: i.park_reason ?? "(none)" })),
    retried_items: items.filter((i) => i.attempts > 1).length,
    failover_dispatches: assignments.filter((a) => a.attempt > 1).length,
    campaigns,
    reconcile_events: events.length,
    last_reconcile: events.length > 0 ? events[events.length - 1].ran_at : null,
    fleet_separation_ok: fleetOk,
    fleet_separation_reason: fleetOk
      ? `workers are ephemeral /zo/ask children; ${assignments.length} assignment record(s) scanned, 0 scheduled-agent references`
      : `${offenders} assignment record(s) reference scheduled-agent fields — pool must never own scheduled agents`,
    oldest_ready_wait_min: oldestReadyWaitMin === null ? null : Math.round(oldestReadyWaitMin * 10) / 10,
    upstream_blocked: upstreamBlocked,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usage(msg?: string): never {
  if (msg) console.error(`ERROR: ${msg}\n`);
  console.error(`Usage:
  pool-manager.ts reconcile [--mode plan|act] [--campaign <id>] [--task <id>] [--mock]
  pool-manager.ts handoff --campaign <id> [--task <id>] [--target-repo <path>] [--mode plan|act] [--mock]
  pool-manager.ts retry --campaign <id> --task <id> --recovery-id <id> --reason <text> --policy <json> --preflight <json> [--task-description-file <path>]
  pool-manager.ts events [--last <n>]

Env:
  SF003_POOL_MODE   plan (default, log-only dispatch) | act (real dispatch)`);
  process.exit(2);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`${flag} requires a value`);
  return value;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "reconcile": {
        const modeIdx = args.indexOf("--mode");
        let mode: ReconcileMode | undefined;
        if (modeIdx !== -1) {
          const v = args[modeIdx + 1];
          if (v !== "plan" && v !== "act") usage(`--mode must be plan|act, got "${v}"`);
          mode = v;
        }
        const ev = await reconcile({
          mode,
          mock: args.includes("--mock"),
          campaign_id: flagValue(args, "--campaign"),
          task_id: flagValue(args, "--task"),
        });
        console.log(
          `[pool-manager] ${ev.mode} reconcile ${ev.event_id}: harvested=${ev.harvested} stalled=${ev.stalled} retried=${ev.retried} dispatched=${ev.dispatched} parked=${ev.parked} released=${ev.released} capacity=${ev.capacity_used}/${POOL_GLOBAL_CAP}`
        );
        for (const n of ev.notes) console.log(`  · ${n}`);
        break;
      }
      case "handoff": {
        const campaignId = flagValue(args, "--campaign");
        if (!campaignId) usage("handoff requires --campaign");
        const modeValue = flagValue(args, "--mode");
        if (modeValue !== undefined && modeValue !== "plan" && modeValue !== "act") {
          usage(`--mode must be plan|act, got "${modeValue}"`);
        }
        const result = await reconcilePoolHandoff(campaignId, {
          mode: modeValue as ReconcileMode | undefined,
          task_id: flagValue(args, "--task"),
          target_repo: flagValue(args, "--target-repo"),
          mock: args.includes("--mock"),
        });
        console.log(JSON.stringify(result));
        break;
      }
      case "retry": {
        const campaignId = flagValue(args, "--campaign");
        const taskId = flagValue(args, "--task");
        const recoveryId = flagValue(args, "--recovery-id");
        const reason = flagValue(args, "--reason");
        const policyPath = flagValue(args, "--policy");
        const preflightPath = flagValue(args, "--preflight");
        const taskDescriptionPath = flagValue(args, "--task-description-file");
        if (!campaignId || !taskId || !recoveryId || !reason || !policyPath || !preflightPath) {
          usage("retry requires --campaign, --task, --recovery-id, --reason, --policy, and --preflight");
        }
        if (!existsSync(policyPath)) throw new Error(`policy file not found: ${policyPath}`);
        if (!existsSync(preflightPath)) throw new Error(`preflight file not found: ${preflightPath}`);
        if (taskDescriptionPath && !existsSync(taskDescriptionPath)) throw new Error(`task description file not found: ${taskDescriptionPath}`);
        const executionPolicy = JSON.parse(readFileSync(policyPath, "utf8")) as ExecutionPolicy;
        const preflight = JSON.parse(readFileSync(preflightPath, "utf8")) as {
          probes?: { id?: unknown; ok?: unknown }[];
        };
        const verifiedModels = (preflight.probes ?? [])
          .filter((probe) => probe.ok === true && typeof probe.id === "string")
          .map((probe) => probe.id as string);
        const result = retryFailedTask({
          recovery_id: recoveryId,
          campaign_id: campaignId,
          task_id: taskId,
          reason,
          execution_policy: executionPolicy,
          verified_models: verifiedModels,
          ...(taskDescriptionPath ? { task_description_override: readFileSync(taskDescriptionPath, "utf8") } : {}),
        });
        console.log(
          `[pool-manager] recovery ${recoveryId} ${result.idempotent ? "already applied" : "applied"}: ${campaignId}/${taskId} → ${result.event.next_task_state}`,
        );
        break;
      }
      case "events": {
        const lastIdx = args.indexOf("--last");
        let events = loadEvents();
        if (lastIdx !== -1) {
          const n = Number(args[lastIdx + 1]);
          if (!Number.isFinite(n) || n <= 0) usage(`--last must be a positive number`);
          events = events.slice(-n);
        }
        for (const ev of events) {
          console.log(
            `${ev.ran_at} ${ev.mode} h=${ev.harvested} s=${ev.stalled} r=${ev.retried} d=${ev.dispatched} p=${ev.parked} rel=${ev.released} cap=${ev.capacity_used}`
          );
        }
        if (events.length === 0) console.log("[pool-manager] no reconcile events");
        break;
      }
      default:
        usage(cmd ? `unknown command: ${cmd}` : undefined);
    }
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}
