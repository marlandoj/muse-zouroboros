#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { consumeReleaseGrant, type ReleaseGrant } from "./release-grant";
/**
 * T4 — Swarm Execution Wrapper
 *
 * For SWARM/FORCE_SWARM tickets: dispatches a self-contained prompt (ticket
 * context + repo + AC + archetype) through the coder-executor chain
 * (claude-code → opencode → codex → gemini → pi → kimi; packages/zo-swarm-orchestrator ExecutorClient over the
 * Skills/zo-swarm-executors bridges). The child agent does interview → seed →
 * eval → execute → post-flight → gap audit. Collects result + branch name.
 * Zouroboros System (de-Zo phase 2): the executor chain is the only execution
 * path. The legacy Zo fallback has been removed; chain exhaustion is terminal.
 *
 * For DIRECT tickets: executes inline (no executor dispatch).
 *
 * For SUGGEST tickets: defaults to direct execution with a note.
 *
 * Writes a PipelineExecution record to state/ for every ticket processed.
 *
 * Usage:
 *   bun swarm-exec.ts --dispatch <json-file>     # Execute from dispatcher output
 *   bun swarm-exec.ts --dispatch -                # Execute from stdin
 *   bun swarm-exec.ts --dispatch <json> --dry-run  # Report without executing
 *   bun swarm-exec.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { assertLegacyLinearTicket } from "./factory-work-contract";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const ZCR_SHADOW_HOOK = "zcr-008/v1";

// ZCR-008 shadow observation: fire-and-forget, fail-open by design — the
// host flow must never block or fail because observation is unavailable.
function zcrShadowObserve(adapter: "autoloop" | "swarm" | "factory", input: Record<string, unknown>): void {
  try {
    if (process.env.ZCR_SHADOW === "0" || process.env.FACTORY_STATE_MODE === "test") return;
    const stateDir = process.env.ZCR_SHADOW_STATE_DIR ?? "/home/workspace/.zouroboros/zcr-shadow";
    if (process.env.ZCR_SHADOW !== "1" && !existsSync(join(stateDir, "ENABLED"))) return;
    const cli = [
      process.env.ZCR_SHADOW_CLI,
      new URL("../../../packages/capability-runtime/bin/shadow-observe.ts", import.meta.url).pathname,
      join(stateDir, "runtime/packages/capability-runtime/bin/shadow-observe.ts"),
      "/home/workspace/zouroboros/packages/capability-runtime/bin/shadow-observe.ts",
    ].find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && existsSync(candidate));
    if (cli === undefined) return;
    const child = Bun.spawn(["bun", cli], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook: ZCR_SHADOW_HOOK, adapter, input })),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    });
    child.unref();
  } catch {
    return;
  }
}
import { autoPromoteEligible, buildInputs, classifyRisk, currentMode, parseContractFields, type GateDecision, type RiskVerdict } from "./risk-classifier";
import { agreementStats, appendVerdict, readLedger } from "./approval-ledger";
import { ticketTitleForExecution } from "./pr-provenance";
import { computeReputation, reputationBaselineForVerdict, type ReputationBaseline } from "./reputation-core";
import {
  enqueueCampaign,
  enqueueDirect,
  parseSeedContract,
  parseSeedValidationCommands,
  personaAssociationLineage,
  projectDelegationExecutionFields,
  readSeedPersonaLineage,
  readSeedSourceHash,
  type PersonaAssociationLineage,
  type SeedContract,
  type ProjectDelegationAdmissionReference,
  verifyDelegatedSeedAdmission,
} from "./pool-queue";
import {
  DEFAULT_PROJECT_DELEGATION_KEY_PATH,
  type ProjectDelegationPaths,
} from "../../../Skills/zouroboros-governance/scripts/project-delegation-receipt";
import type { CascadeValidationCommand } from "./coding-cascade";
import { resolveRepositoryValidationCommands } from "./repository-validation-routing";
import { retryableExecutionContractError } from "./execution-contract-error";
import { currentReconcileMode, reconcilePoolHandoff, type PoolHandoffResult } from "./pool-manager";
import { defaultSloSources, laneBlockDecision, readSloStateFile } from "./factory-slo";
import { automergeEnabled, certificationEnabled, runAutoMergeLane } from "./auto-merge-lane";
import { persistPreDispatchHold } from "./pre-dispatch-hold";
import {
  loadPromotionExecutionBinding,
  preservePersistedPromotionExecutionBinding,
  type PromotionExecutionContext,
  type PromotionExecutionContextClaim,
} from "./promotion-execution-context";
import { type DedupDecision, hashSeedFile, resumeTarget } from "./dedup-gate";
import { type LedgerStage, appendRow, sourceHash } from "./intake-ledger";
import { classifyArchetype, hasDisagreement, laneArchetypeName, type ArchetypeClassification } from "./archetype-classifier";
import { effectiveRung, loadLineConfig, rulesForLine, type LoadedLineConfig } from "./line-config";
import { RUNGS, type Rung } from "./permission-ladder";
import {
  activeFailurePark,
  loadFailureStreak,
  recordFailureCycle,
  recordFailureSuccess,
} from "./failure-fingerprint";
import {
  type AppliedPolicy,
  type ExecutionPolicy,
  applyModelPolicy,
  formatPolicy,
  parseModelPolicy,
  policyEnvironment,
} from "./model-policy";
import { runFactoryReviewGate, type FactoryReviewResult } from "./factory-review-gate";
import { failedFactoryDiversityReview, prepareFactoryDiversityReview } from "./factory-diversity-review";
import { requestDiversityReview } from "./factory-review-recovery";
import { type HetznerExecutionRoute } from "./hetzner-executor-policy";
import { runHetznerExecutor, type HetznerExecutorResult } from "./hetzner-executor-adapter";
import { executionLaneForTicket } from "./execution-lane";
import type { FactoryComputeRoutingRecord } from "./factory-compute-routing";
import { CODER_HARNESS_CHAIN, classifyHarnessFailureDetail, defaultHealthProbe, runHarness } from "./harness-router";
import { runExecutorChain, type ExecutorLifecycleEvent } from "./executor-runner";
import { builderCheckpointContract } from "./builder-contract";
import { appendExecLog, recordFlight } from "./flight-recorder";
import type { FactoryConsensusRecord } from "./factory-consensus";
import {
  createEvidenceManifest,
  independentReviewers,
  parseReviewerCandidates,
  promotionBlockers,
  rolloutMode,
  writeEvidenceManifest,
  type AgentIdentity,
  type EvidenceCheck,
} from "./factory-evidence";
import type { PersonaOrchestrationRecord } from "./persona-orchestrator";
import { runSupplyChainPreflight, type SupplyChainPreflight } from "./factory-supply-chain";
import { runFactoryPlanGate, type FactoryPlanGateDecision } from "./factory-plan-gate";
import { exactJoinId, type OutcomePolicyResolution } from "./outcome-routing-core";
import { writeVerdict } from "./factory-verdict";
import { commitDigest, resolveExactCommitDigest } from "./outcome-evidence-emission";
import { captureExecutionBaseCommit } from "./execution-provenance";
import {
  createExecutionLifecycle,
  hasProvenDeliveryState,
  hasReachedDeliveryTarget,
  normalizeExecutionLifecycle,
  transitionExecutionLifecycle,
  wouldDowngradeDelivery,
  type DeliveryTarget,
  type ExecutionLifecycle,
} from "./execution-lifecycle";
import { resolveExecutionRepository, createIsolatedWorktree, reclaimIsolatedWorktrees } from "./execution-repository";
import { resolveCodingCascadeMode } from "./coding-cascade";
import {
  productGateArtifact,
  productGateSummary,
  productLaunchFailureResult,
  runProductLaunchGate,
  type ProductLaunchResult,
  type ProductPreflightResult,
} from "./product-lifecycle-gate";
import { acquireTicketClaim } from "./ticket-claim";
import {
  activeTransientHoldForTicket,
  attemptTransientRecovery,
  type TransientRecoveryResult,
} from "./transient-recovery";
import { currentShadowPhase } from "./shadow-state";
import {
  changeQuizAnswerInstructions,
  extractChangeQuizAnswers,
  resolveChangeQuizMode,
  type ChangeQuizAnswers,
} from "./change-quiz";
import {
  compileValidationContract,
  criteriaFromAcceptanceText,
  persistValidationContract,
  type ValidationContract,
} from "./validation-contract";
import {
  resolveFirstPassValidationMode,
  runFirstPassValidatorRuntime,
  type FirstPassValidationMode,
} from "./first-pass-shadow";
import { appendFirstPassLedger } from "./first-pass-ledger";
import { finalizeHoldoutManifest, readHoldoutState, writeHoldoutState, type HoldoutState } from "./heldout-cohort";
import type { ValidatorVerdict } from "./validator-authority";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntakeTicket {
  linear_id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface DispatchResult {
  ticket: IntakeTicket;
  decision: "DIRECT" | "SWARM" | "FORCE_SWARM" | "SUGGEST" | "ERROR";
  score: number;
  override: boolean;
  exit_code: number;
  raw_output: string;
  dedup?: DedupDecision; // SF-006: attached by dispatcher when SF006_DEDUP is on
  author_identity?: AgentIdentity;
  outcome_policy?: OutcomePolicyResolution;
  product_gate?: ProductPreflightResult;
}

export interface PipelineExecution extends ExecutionLifecycle, Record<string, unknown> {
  execution_id: string;
  ticket_id: string;
  identifier: string;
  /** Linear title, routing prefixes stripped — the PR title source. */
  ticket_title: string | null;
  gate_decision: GateDecision;
  seed_path: string | null;
  stage: string;
  branch_name: string | null;
  repo_path?: string;
  base_commit?: string | null;
  commit_digest?: string;
  pr_number: number | null;
  promotion_context?: PromotionExecutionContext;
  promotion_context_claim?: PromotionExecutionContextClaim;
  shadow_phase: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  result_summary: string | null;
  change_quiz_answers?: ChangeQuizAnswers;
  error: string | null;
  /** SF-013: the provider model_name that actually served the result (after any 429 failover). */
  model_used?: string;
  token_usage?: {
    total?: number;
    input?: number;
    output?: number;
  };
  model_cost_usd?: number;
  executor_harness?: string;
  model_provenance?: {
    harness: string;
    requestedProvider?: string;
    requestedModel?: string;
    resolvedModel?: string;
    modelFamily?: string;
    servingProvider?: string;
    endpointClass?: string;
    credentialEnvironment?: string;
  };
  /** SF-013: compact attempt-by-attempt failover trail. */
  failover_trail?: string;
  /** Declared executor budgets used by the reaper to avoid pre-empting a live run. */
  executor_timeout_ms?: number;
  executor_idle_timeout_ms?: number;
  risk?: { verdict_id: string; tier: string; score: number; mode: string; acted: boolean };
  /** SF-011: assembly-line classification; absent on pre-SF-011 records and when SF011_LINES is off. */
  archetype?: { line: string; source: string; fine: string | null; disagreement: boolean };
  /** True when this exec failed due to a stream-drop/crash (reaper-stamped or detected inline).
   *  Consumers can treat this ticket as retry-eligible rather than permanently failed. */
  retry_eligible?: boolean;
  transient_recovery?: {
    recovery_id: string | null;
    status: "recovered" | "failed" | "blocked";
    failure_class: "transient";
    prevalidated_routes: string[];
    trail: string[];
    detail: string;
  };
  consensus?: FactoryConsensusRecord;
  product_gate?: { preflight: ProductPreflightResult; launch?: ProductLaunchResult };
  plan_gate?: FactoryPlanGateDecision;
  pool_handoff?: PoolHandoffResult;
  compute_routing?: FactoryComputeRoutingRecord;
  hetzner_executor?: HetznerExecutorResult;
  /**
   * ZOU-1282: versioned persona-association lineage declared by the seed.
   * Identity-free by construction — role ids and hashes only, never a resolved
   * UUID, model, or harness. Absent unless the seed declares an association, so
   * legacy/DIRECT execution records stay byte-identical.
   */
  persona_association?: PersonaAssociationLineage;
  project_delegation?: {
    paths: ProjectDelegationPaths;
    l1_admission: ProjectDelegationAdmissionReference;
  };
  project_delegation_remote_action?: ProjectDelegationPaths;
  /** Task-qualified persona records harvested asynchronously from the pool. */
  persona_participation?: PersonaOrchestrationRecord[];
  first_pass_validation?: {
    mode: FirstPassValidationMode;
    contract_path: string | null;
    contract_digest: string | null;
    ledger_record_id: string | null;
    verdict: ValidatorVerdict["verdict"] | null;
    validator_version: string;
    errors: string[];
  };
}

export interface HoldRecord {
  execution_id: string;
  tier: string;
  held_at: string;
  notified: "sms" | "summary" | "none";
  released_by: string | null;
  released_at: string | null;
  reason?: "approval_gate" | "slo_gate" | "failure_streak" | "consensus_manual_review" | "diversity_of_thought_review" | "transient_recovery" | "promotion_context";
  failure_fingerprint?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();
const MAX_CONCURRENCY = 20;

// Option C (2026-07-09): SWARM execution is executor-first. Workdir for harness
// runs defaults to the workspace root (the prompt itself directs the agent into
// the ticket's target repo); override via SF_MULTI_HARNESS_WORKDIR (same knob
// pool-worker.ts uses).
const EXEC_WORKDIR = process.env.SF_MULTI_HARNESS_WORKDIR || join(import.meta.dir, "..", "..", "..");

/** Ticket-level harness timeout — full pipeline runs take ~20 min; default 45. */
function harnessTimeoutMs(): number {
  const min = Number(process.env.SF_EXEC_HARNESS_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 45) * 60_000;
}

/** No-output watchdog for ACP executors. Active sessions retain the full task
 * timeout; a wedged harness fails over before the hosting Zo turn expires. */
function harnessIdleTimeoutMs(): number {
  const min = Number(process.env.SF_EXEC_HARNESS_IDLE_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 8) * 60_000;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

interface PreparedFirstPassValidation {
  mode: "shadow";
  contract: ValidationContract;
  contract_path: string;
  commands: CascadeValidationCommand[];
  holdout_state: HoldoutState;
  holdout_path: string;
}

function prepareFirstPassValidation(input: {
  execution_id: string;
  ticket: IntakeTicket;
  workdir: string;
  seed_path: string;
}): PreparedFirstPassValidation | null {
  const mode = resolveFirstPassValidationMode();
  if (mode === "off") return null;
  const commands = existsSync(input.seed_path)
    ? parseSeedValidationCommands(input.seed_path)
    : resolveRepositoryValidationCommands({
        repository: input.workdir,
        scopedJson: process.env.FACTORY_CODING_CASCADE_VALIDATION_COMMANDS_BY_REPOSITORY,
        legacyJson: process.env.FACTORY_CODING_CASCADE_VALIDATION_COMMANDS,
        legacyRepository: process.env.FACTORY_CODING_CASCADE_VALIDATION_REPOSITORY,
      });
  const fields = parseContractFields(input.ticket.description || "");
  const baseCommit = captureExecutionBaseCommit({
    executionId: input.execution_id,
    stateDir: STATE_DIR,
    workdir: input.workdir,
  });
  const holdoutPath = factoryStatePath("first-pass-holdouts.json");
  const holdoutState = existsSync(holdoutPath)
    ? readHoldoutState(holdoutPath)
    : { manifest: finalizeHoldoutManifest([]), accessLedger: [] };
  const seedHash = existsSync(input.seed_path) ? hashSeedFile(input.seed_path) : null;
  const sourceDigest = seedHash ?? sourceHash(input.ticket.title, input.ticket.description || "");
  const contract = compileValidationContract({
    execution_id: input.execution_id,
    ticket: input.ticket.identifier,
    candidate_cycle_id: `${input.execution_id}:0`,
    compiled_at: now(),
    seed_digest: `sha256:${sourceDigest}`,
    criteria: criteriaFromAcceptanceText(fields.acceptance_criteria ?? "", commands),
    environment: {
      repository: input.workdir,
      base_commit_digest: commitDigest(baseCommit),
      harness: "first-pass-validator",
      validator_version: "first-pass-validator-v1",
      required_env_names: (process.env.FIRST_PASS_VALIDATOR_ENV_ALLOWLIST ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    },
    heldout_refs: holdoutState.manifest.items.map((item) => ({
      id: item.itemId,
      digest: `sha256:${item.contentSha256}`,
    })),
  });
  if (!contract.ok) throw new Error(`first-pass contract compilation failed: ${contract.errors.join("; ")}`);
  const contractPath = factoryStatePath("first-pass-contracts", `${input.execution_id}-cycle-0.json`);
  persistValidationContract(contractPath, contract.contract);
  return {
    mode: "shadow",
    contract: contract.contract,
    contract_path: contractPath,
    commands,
    holdout_state: holdoutState,
    holdout_path: holdoutPath,
  };
}

function deliveryTargetForTicket(ticket: Pick<IntakeTicket, "description">): DeliveryTarget {
  const match = ticket.description.match(/(?:delivery[_ -]?target)\s*[:=]\s*`?([a-z_]+)`?/i);
  const candidate = match?.[1]?.toLowerCase();
  const allowed: DeliveryTarget[] = [
    "implementation_complete",
    "verified",
    "pr_ready",
    "ci_green",
    "merged",
    "deployed",
    "accepted",
  ];
  return allowed.includes(candidate as DeliveryTarget) ? candidate as DeliveryTarget : "accepted";
}

export function executionWorkdirForTicket(ticket: Pick<IntakeTicket, "description" | "identifier">): string {
  const target = parseContractFields(ticket.description || "").target_repo?.trim();
  const repo = resolveExecutionRepository(target, { fallback: EXEC_WORKDIR });
  // ZOU-890 — with SF_EXEC_ISOLATED_WORKTREE=1, build in a clean per-ticket
  // worktree off origin/main instead of the (possibly dirty) resolved checkout.
  // createIsolatedWorktree is idempotent, so the 7+ call sites share one worktree
  // per ticket. Default-off => the resolved checkout is returned unchanged.
  if (process.env.SF_EXEC_ISOLATED_WORKTREE === "1") {
    return createIsolatedWorktree(repo, ticket.identifier);
  }
  return repo;
}

function applyLifecycle(exec: PipelineExecution, lifecycle: ExecutionLifecycle): void {
  exec.state = lifecycle.state;
  exec.delivery_target = lifecycle.delivery_target;
  exec.target_reached = lifecycle.target_reached;
  exec.state_updated_at = lifecycle.state_updated_at;
  exec.evidence = lifecycle.evidence;
  exec.post_merge_survivability = lifecycle.post_merge_survivability;
  exec.post_merge_survivability_reason = lifecycle.post_merge_survivability_reason;
  exec.post_merge_survivability_checks = lifecycle.post_merge_survivability_checks;
}

function transitionExecution(
  exec: PipelineExecution,
  state: Parameters<typeof transitionExecutionLifecycle>[1],
  kind: string,
  reference: string,
  details?: Record<string, unknown>,
): void {
  const timestamp = now();
  applyLifecycle(exec, transitionExecutionLifecycle(normalizeExecutionLifecycle(exec), state, {
    kind,
    reference,
    recorded_at: timestamp,
    ...(details ? { details } : {}),
  }, { now: timestamp }));
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function saveExecution(exec: PipelineExecution): void {
  ensureStateDir();
  const path = join(STATE_DIR, `exec-${exec.execution_id}.json`);
  if (!existsSync(path)) {
    zcrShadowObserve("swarm", {
      executionId: exec.execution_id,
      ticketIdentifier: exec.identifier,
      gateDecision: exec.gate_decision,
      stage: exec.stage,
    });
  }
  // A run holds `exec` from dispatch to completion and writes the whole record,
  // so a pass still in flight when the ticket ships would revert the shipped
  // state. Re-read before writing and refuse to move a delivery state backwards.
  if (existsSync(path)) {
    let persistedRecord: Record<string, unknown> | null = null;
    try {
      persistedRecord = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      persistedRecord = null;
    }
    if (persistedRecord) preservePersistedPromotionExecutionBinding(exec, persistedRecord);
    const persistedState = persistedRecord?.state ?? null;
    const incomingState = normalizeExecutionLifecycle(exec).state;
    if (wouldDowngradeDelivery(persistedState, incomingState)) {
      recordFlight({
        execution_id: exec.execution_id,
        identifier: exec.identifier,
        kind: "exec.save_skipped_downgrade",
        detail: `refused to overwrite ${String(persistedState)} with ${incomingState}`,
        data: { persisted_state: persistedState, incoming_state: incomingState },
      });
      return;
    }
  }
  writeFileSync(path, JSON.stringify(exec, null, 2));
}

function saveHold(hold: HoldRecord): void {
  ensureStateDir();
  writeFileSync(join(STATE_DIR, `hold-${hold.execution_id}.json`), JSON.stringify(hold, null, 2));
}

function transientRecoveryEvidence(
  recovery: Exclude<TransientRecoveryResult, { status: "not_applicable" }>,
): NonNullable<PipelineExecution["transient_recovery"]> {
  const detail = recovery.status === "blocked"
    ? recovery.reason
    : recovery.result.error ?? recovery.result.output.slice(0, 500);
  return {
    recovery_id: recovery.recovery_id,
    status: recovery.status,
    failure_class: "transient",
    prevalidated_routes: recovery.preflight.filter((route) => route.healthy).map((route) => route.route),
    trail: recovery.result?.trail ?? [],
    detail,
  };
}

function holdAfterTransientRecovery(
  exec: PipelineExecution,
  ticket: IntakeTicket,
  recovery: Exclude<TransientRecoveryResult, { status: "not_applicable" } | { status: "recovered" }>,
): PipelineExecution {
  const evidence = transientRecoveryEvidence(recovery);
  exec.transient_recovery = evidence;
  exec.completed_at = now();
  exec.status = "held";
  exec.stage = "transient-recovery-held";
  exec.retry_eligible = false;
  exec.error = evidence.detail;
  exec.result_summary = `transient recovery ${recovery.status}; operator release required`;
  transitionExecution(exec, "held", "transient-recovery", `recovery:${recovery.recovery_id ?? exec.execution_id}`, {
    recovery_status: recovery.status,
    prevalidated_routes: evidence.prevalidated_routes,
    trail: evidence.trail,
  });
  saveHold({
    execution_id: exec.execution_id,
    tier: "high",
    held_at: exec.completed_at,
    notified: "none",
    released_by: null,
    released_at: null,
    reason: "transient_recovery",
  });
  saveExecution(exec);
  recordFlight({
    execution_id: exec.execution_id,
    identifier: ticket.identifier,
    kind: "exec.transient-recovery-held",
    detail: evidence.detail,
    data: evidence,
  });
  return exec;
}

function evidenceFiles(envName: string): string[] {
  return (process.env[envName] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

function artifactCheck(envName: string, executionId: string, blocking: boolean): EvidenceCheck {
  const paths = evidenceFiles(envName);
  const hashes: Record<string, string> = {};
  let valid = paths.length > 0;
  for (const path of paths) {
    if (!existsSync(path)) { valid = false; continue; }
    const bytes = readFileSync(path);
    if (bytes.length === 0) { valid = false; continue; }
    hashes[path] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (blocking) {
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as { execution_id?: string; status?: string; verdict?: string };
        if (parsed.execution_id !== executionId || (parsed.status !== "pass" && parsed.verdict !== "pass")) valid = false;
      } catch { valid = false; }
    }
  }
  return {
    status: valid ? "pass" : paths.length > 0 ? "fail" : "not_run",
    evidence: paths,
    hashes,
  };
}

function executorIdentity(exec: PipelineExecution): AgentIdentity {
  if (exec.model_provenance?.servingProvider) {
    return {
      provider: exec.model_provenance.servingProvider,
      model: exec.model_provenance.resolvedModel ?? exec.model_used ?? "unknown",
    };
  }
  const raw = exec.model_used ?? "factory:inline";
  const [provider, ...model] = raw.split(":");
  return { provider: provider || "factory", model: model.join(":") || "inline" };
}

// ─── SF-011 per-archetype assembly lines ─────────────────────────────────────

/**
 * SF-011 T3: classify the ticket onto an assembly line. Returns null when
 * SF011_LINES is not "1" (flags-off path byte-identical). Pure classifier;
 * failure never blocks execution.
 */
function sf011Classify(d: DispatchResult): ArchetypeClassification | null {
  if (process.env.SF011_LINES !== "1") return null;
  try {
    const fields = parseContractFields(d.ticket.description || "");
    return classifyArchetype({ archetype: fields.archetype }, `${d.ticket.title}\n${d.ticket.description || ""}`);
  } catch (err: any) {
    console.error(`[sf011] ${d.ticket.identifier}: classification failed (non-blocking) — ${err.message}`);
    return null;
  }
}

/**
 * Line config loaded once per process. Invalid file is captured (not thrown):
 * advisory mode logs it; enforce mode fails closed at the sf010 lane.
 */
let sf011ConfigCache: { loaded: LoadedLineConfig | null; error: string | null } | null = null;
function sf011Config(): { loaded: LoadedLineConfig | null; error: string | null } {
  if (sf011ConfigCache) return sf011ConfigCache;
  try {
    sf011ConfigCache = { loaded: loadLineConfig(), error: null };
  } catch (err: any) {
    sf011ConfigCache = { loaded: null, error: err?.message ?? String(err) };
  }
  return sf011ConfigCache;
}

/**
 * Global ladder rung, READ-ONLY. Deliberately not loadLadder(): that
 * initializes (writes) state when absent — SF-011 must never write ladder state.
 */
function sf011GlobalRung(): Rung | null {
  try {
    const p = join(STATE_DIR, "permission-ladder.json");
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, "utf-8")) as { current_rung?: string };
    return (RUNGS as readonly string[]).includes(s.current_rung ?? "") ? (s.current_rung as Rung) : null;
  } catch {
    return null;
  }
}

/** Advisory posture log: line, source, would-cap rung. Never throws, never writes. */
function sf011AdvisoryLog(identifier: string, c: ArchetypeClassification): void {
  console.log(`[sf011] ${identifier}: line=${c.line} source=${c.source}${c.fine ? ` fine=${c.fine}` : ""} conf=${c.confidence}`);
  const cfg = sf011Config();
  if (!cfg.loaded) {
    console.error(`[sf011] ${identifier}: line-config INVALID (${cfg.error}) — posture unavailable (enforce would fail closed)`);
    return;
  }
  const rules = rulesForLine(c.line, cfg.loaded.config);
  const global = sf011GlobalRung();
  if (global !== null) {
    const eff = effectiveRung(global, rules.max_rung);
    if (eff !== global) {
      console.log(
        `[sf011] ${identifier}: would-cap rung ${global} → ${eff} (line=${c.line}, posture=${rules.risk_posture}) — advisory, ladder untouched`,
      );
    }
  }
}

/**
 * SF-002 T4: classify a dispatch at execution time. Returns null when
 * SF002_CLASSIFY=0 (flags-off path byte-identical to SF-001 baseline).
 * Classification failure never blocks execution. When SF-011 resolved a
 * coarse line, it feeds the risk classifier's archetype input (the exact
 * ARCHETYPE_BASE vocabulary); unknown falls back to the declared field.
 */
function classifyDispatch(d: DispatchResult, executionId: string, sf011: ArchetypeClassification | null = null): RiskVerdict | null {
  if (process.env.SF002_CLASSIFY === "0") return null;
  try {
    const fields = parseContractFields(d.ticket.description || "");
    const inputs = buildInputs(
      {
        archetype: sf011 !== null && sf011.line !== "unknown" ? sf011.line : fields.archetype,
        target_repo: fields.target_repo,
        repro: fields.repro ?? fields.area,
        acceptance_criteria: fields.acceptance_criteria,
      },
      `${d.ticket.title}\n${d.ticket.description || ""}`,
      d.decision,
      null
    );
    return classifyRisk(d.ticket, inputs, executionId, currentMode());
  } catch (err: any) {
    console.error(`[sf002] ${d.ticket.identifier}: classification failed (non-blocking) — ${err.message}`);
    return null;
  }
}

function ledgerAppend(verdict: RiskVerdict): void {
  try {
    appendVerdict(verdict);
  } catch (err: any) {
    console.error(`[sf002] ledger append failed (non-blocking) — ${err.message}`);
  }
}

/**
 * SF-006 T3: intake-ledger stage checkpoint. No-op when SF006_DEDUP=0
 * (flags-off path byte-identical — no rows, no logs). A checkpoint row means
 * "this stage completed for this execution"; append failure never blocks.
 */
function sf006Checkpoint(
  ref: { ticket_id: string; identifier: string; execution_id: string; pr_number?: number | null; branch_name?: string | null },
  stage: LedgerStage,
  seedHash: string | null = null
): void {
  if (process.env.SF006_DEDUP === "0") return;
  try {
    appendRow({
      ticket_id: ref.ticket_id,
      identifier: ref.identifier,
      execution_id: ref.execution_id,
      stage,
      seed_hash: seedHash,
      pr_number: ref.pr_number ?? null,
      branch_name: ref.branch_name ?? null,
    });
  } catch (err: any) {
    console.error(`[sf006] checkpoint ${stage} append failed (non-blocking) — ${err.message}`);
  }
}

/** Prompt preamble for an enforce-mode resume — the child must not redo completed stages. */
function sf006ResumeNote(resume: DedupDecision | null): string | undefined {
  if (!resume || !resume.checkpoint_stage) return undefined;
  return (
    `[SF-006 RESUME] This execution resumes from checkpoint stage=${resume.checkpoint_stage} ` +
    `(execution ${resume.matched_execution_id}). Stages up to and including "${resume.checkpoint_stage}" ` +
    `are already complete — resume at "${resumeTarget(resume.checkpoint_stage)}" and do NOT redo earlier stages.`
  );
}

/** Seed hash for a ticket's pre-generated seed file, or null (never throws). */
function sf006SeedHash(seedPath: string): string | null {
  try {
    return existsSync(seedPath) ? hashSeedFile(seedPath) : null;
  } catch (err: any) {
    console.error(`[sf006] seed hash failed (non-blocking) — ${err.message}`);
    return null;
  }
}

/**
 * Observation Deck P2 tee — streams live executor chunks to
 * state/flight/exec-<id>.log and emits a throttled heartbeat event so the
 * dashboard can show liveness without reading the raw log. Fail-open.
 */
function makeExecTee(executionId: string, identifier: string, executorId: string): (text: string) => void {
  let bytes = 0;
  let lastBeat = 0;
  return (text: string) => {
    try {
      bytes += text.length;
      appendExecLog(executionId, text);
      const t = Date.now();
      if (t - lastBeat > 30_000) {
        lastBeat = t;
        recordFlight({ execution_id: executionId, identifier, kind: "executor.heartbeat", data: { executor: executorId, bytes } });
      }
    } catch {
      // observation must never fail a run
    }
  };
}

function generateBranchName(ticket: IntakeTicket): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `factory/${ticket.identifier.toLowerCase()}-${slug}`;
}

function modelReviewInstruction(): string {
  return "[REVIEW POLICY] Do not invoke MoA or a model-based Consensus Gate. The Factory control plane owns independent persona review after implementation; preserve deterministic verification and any operator approval boundary.";
}

/**
 * Build a self-contained prompt for the executor child agent.
 * The child has NO context from this conversation — include everything.
 */
function buildSwarmPrompt(ticket: IntakeTicket, resumeNote?: string): string {
  const fields = parseTicketFields(ticket.description);
  const executionWorkdir = executionWorkdirForTicket(ticket);
  return [
    ...(resumeNote ? [resumeNote, ``] : []),
    `You are executing a ticket from the Zouroboros Software Factory intake pipeline.`,
    ``,
    `## Ticket`,
    `- **ID:** ${ticket.identifier} (${ticket.linear_id})`,
    `- **Title:** ${ticket.title}`,
    `- **Target Repo:** ${fields.target_repo || "unknown"}`,
    `- **Archetype:** ${fields.archetype || "unknown"}`,
    ``,
    `## Description`,
    ticket.description,
    ``,
    `## Your Task`,
    `1. Run the spec-first interview on this ticket (if not already done)`,
    `2. Generate a seed YAML specification`,
    `3. Evaluate the seed (Seed Eval Gate)`,
    `4. Implement the ticket in the target repo`,
    `5. Run post-flight evaluation (three-stage-eval)`,
    `6. Run the gap audit (reachability, data prerequisites, cross-boundary state)`,
    `7. Create a git branch named: ${generateBranchName(ticket)}`,
    `8. Commit the verified implementation to that branch`,
    `9. ${modelReviewInstruction()}`,
    ``,
    `## Constraints`,
    `- Do NOT merge, deploy, or push to main/master/protected branches`,
    `- Do NOT create PRs during dry-run shadow phase`,
    `- All code must pass tsc --noEmit with zero errors`,
    `- Work in ${executionWorkdir}`,
    ...builderCheckpointContract(),
    ``,
    `## Response Format`,
    `Respond with:`,
    ...(resolveChangeQuizMode() === "off" ? [] : changeQuizAnswerInstructions()),
    `1. A summary of what you did (2-3 sentences)`,
    `2. The branch name you created`,
    `3. List of files changed`,
    `4. Post-flight eval result (PASS/FAIL + score)`,
    `5. Gap audit result (PASS/FAIL for each of the 3 checks)`,
  ].join("\n");
}

function buildDirectPrompt(ticket: IntakeTicket, resumeNote?: string): string {
  const fields = parseTicketFields(ticket.description);
  const executionWorkdir = executionWorkdirForTicket(ticket);
  return [
    ...(resumeNote ? [resumeNote, ``] : []),
    `You are implementing a DIRECT ticket from the Zouroboros Software Factory.`,
    ``,
    `## Ticket`,
    `- **ID:** ${ticket.identifier} (${ticket.linear_id})`,
    `- **Title:** ${ticket.title}`,
    `- **Target Repo:** ${fields.target_repo || "unknown"}`,
    `- **Archetype:** ${fields.archetype || "unknown"}`,
    ``,
    `## Description`,
    ticket.description,
    ``,
    `## Your Task`,
    `1. Inspect the target repository and preserve its current behavior outside this ticket`,
    `2. Implement every acceptance criterion`,
    `3. Run the repository's focused tests and tsc --noEmit with zero errors`,
    `4. Run a focused post-flight and reachability check`,
    `5. Create or reuse the git branch named: ${generateBranchName(ticket)}`,
    `6. Commit the verified implementation to that branch`,
    ``,
    `## Constraints`,
    `- Do NOT merge, deploy, push, or create a pull request`,
    `- Do NOT modify protected branches`,
    `- Work in ${executionWorkdir}`,
    ...builderCheckpointContract(),
    ``,
    `## Response Format`,
    `Respond with:`,
    ...(resolveChangeQuizMode() === "off" ? [] : changeQuizAnswerInstructions()),
    `1. A summary of what you did (2-3 sentences)`,
    `2. The branch name and commit SHA`,
    `3. List of files changed`,
    `4. Tests and TypeScript result`,
    `5. Reachability result`,
  ].join("\n");
}

function parseTicketFields(description: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Inline bold: **field:** value
  for (const line of description.split("\n")) {
    const m = line.match(/^\*\*(\w[\w\s/]*?):\*\*\s*(.*)$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/[\s/]/g, "_");
      const val = m[2].trim();
      if (val) fields[key] = val;
    }
  }
  // Acceptance criteria section
  const acMatch = description.match(/##\s*Acceptance\s*Criteria\s*\n([\s\S]*?)(?=\n##|\n\*\*|$)/i);
  if (acMatch) fields["acceptance_criteria"] = acMatch[1].trim();
  return fields;
}

// ─── SF-003 pool routing ──────────────────────────────────────────────────────

/**
 * SF-003 T4: route a dispatch into the logical pool instead of monolithic
 * execution. Only reached when SF003_POOL=1 (flags-off path byte-identical —
 * this function and the pool modules create no state unless invoked).
 *
 * SWARM/FORCE_SWARM tickets with a seed at seed-<identifier>.yaml decompose
 * into DAG-task work items; everything else enters as a single-item campaign.
 * The pool manager (conveyor tick) dispatches from the ready set — enqueue
 * itself never calls /zo/ask, so the SF-002 classify hook (which already ran
 * on this execution) covers the pool path at the same point as monolithic.
 */
/**
 * ZOU-437 T3 — speculative-seed consume-guard (always on, independent of SF_PRESPEC).
 *
 * A speculative pre-spec (SF-P3) stamps each cached seed with
 * source_hash = sha256(title + "\n" + description). If the ticket was re-scoped
 * after the seed was pre-generated, the stamp no longer matches the CURRENT ticket
 * → the cache is stale and must not execute the wrong spec; return false so the
 * caller falls through to the inline pipeline (safe default). A seed with NO stamp
 * is hand-authored and trusted unchanged — byte-identical to legacy behavior.
 */
function seedStampMatches(seedPath: string, ticket: IntakeTicket): boolean {
  const stamped = readSeedSourceHash(seedPath);
  if (stamped === null) return true; // unstamped → hand-authored → trust
  const matches = stamped === sourceHash(ticket.title, ticket.description);
  if (!matches) {
    console.error(
      `[prespec-guard] ${ticket.identifier}: cached seed source_hash mismatch — ticket re-scoped since pre-spec; ignoring stale cache, running inline pipeline`,
    );
  }
  return matches;
}

function localRepositoryIdentity(repositoryPath: string): string {
  const result = Bun.spawnSync(["git", "-C", repositoryPath, "config", "--get", "remote.origin.url"]);
  const value = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
  if (!value) throw new Error(`delegated seed admission cannot resolve remote.origin.url for ${repositoryPath}`);
  return value;
}

async function executePoolEnqueue(
  d: DispatchResult,
  executionId: string,
  policy: ExecutionPolicy | null,
  riskTier: string | null,
  dryRun: boolean,
): Promise<PipelineExecution> {
  const ticket = d.ticket;
  const campaignId = ticket.identifier;
  const seedPath = join(import.meta.dir, "..", `seed-${ticket.identifier.toLowerCase()}.yaml`);
  const isSwarm = d.decision === "SWARM" || d.decision === "FORCE_SWARM";
  // Consume-guard: only trust a present seed whose source_hash still matches the
  // ticket (or is unstamped/hand-authored). A stale speculative seed falls through.
  const seedCacheUsable = isSwarm && existsSync(seedPath) && seedStampMatches(seedPath, ticket);
  // ZOU-1282: one parse yields the task DAG and the persona-association contract.
  // Validation is fail-closed here, before any work item exists — a seed whose
  // assignments escalate authority or escape their owned files never enqueues.
  // Nothing is resolved: no directory call, no UUID, no model/harness change.
  const seedContract: SeedContract | null = seedCacheUsable ? parseSeedContract(seedPath) : null;
  const executionWorkdir = executionWorkdirForTicket(ticket);
  const delegationAdmission = seedContract
    ? verifyDelegatedSeedAdmission({
        delegation: seedContract.delegation,
        seedPath,
        ticket: ticket.identifier,
        expectedRepository: localRepositoryIdentity(executionWorkdir),
        keyPath: process.env.ZOUROBOROS_PROJECT_DELEGATION_KEY_PATH ?? DEFAULT_PROJECT_DELEGATION_KEY_PATH,
        auditLogPath: factoryStatePath("governance", "project-delegation-verification.jsonl"),
      })
    : null;
  const cascadeMode = resolveCodingCascadeMode();
  let poolTargetRepository: string | undefined;
  let poolBaseCommit: string | undefined;
  let poolValidationCommands: CascadeValidationCommand[] | undefined;
  if (cascadeMode === "enforce") {
    const declaredTarget = parseContractFields(ticket.description || "").target_repo?.trim();
    if (!declaredTarget) throw new Error("coding cascade enforce requires an explicit target repository");
    poolTargetRepository = executionWorkdir;
    poolBaseCommit = captureExecutionBaseCommit({
      executionId,
      stateDir: STATE_DIR,
      workdir: executionWorkdir,
    });
    if (seedCacheUsable) {
      poolValidationCommands = parseSeedValidationCommands(seedPath);
    } else {
      poolValidationCommands = resolveRepositoryValidationCommands({
        repository: executionWorkdir,
        scopedJson: process.env.FACTORY_CODING_CASCADE_VALIDATION_COMMANDS_BY_REPOSITORY,
        legacyJson: process.env.FACTORY_CODING_CASCADE_VALIDATION_COMMANDS,
        legacyRepository: process.env.FACTORY_CODING_CASCADE_VALIDATION_REPOSITORY,
      });
    }
  }

  let itemCount: number;
  let alreadyExisted: boolean;
  let seedUsed: string | null = null;

  if (seedContract) {
    const r = enqueueCampaign({
      campaign_id: campaignId,
      ticket_id: ticket.linear_id,
      identifier: ticket.identifier,
      seed_path: seedPath,
      tasks: seedContract.tasks,
      execution_id: executionId,
      persona_association: seedContract.persona_association,
      execution_policy: policy,
      risk_tier: riskTier,
      target_repository: poolTargetRepository,
      base_commit: poolBaseCommit,
      validation_commands: poolValidationCommands,
      delegation_admission: delegationAdmission,
      delegation_remote_action: seedContract.delegation_remote_action,
    });
    itemCount = r.items.length;
    alreadyExisted = r.already_existed;
    seedUsed = seedPath;
  } else {
    const reviewInstruction = modelReviewInstruction();
    const description = isSwarm
      ? `${ticket.description}\n\n[SWARM: no pre-generated seed — run the full pipeline: spec interview → seed YAML → Seed Eval Gate → implement → post-flight eval → gap audit]\n\n${reviewInstruction}`
      : `${ticket.description}\n\n${reviewInstruction}`;
    const r = enqueueDirect({
      campaign_id: campaignId,
      ticket_id: ticket.linear_id,
      identifier: ticket.identifier,
      name: ticket.title,
      description,
      execution_policy: policy,
      risk_tier: riskTier,
      target_repository: poolTargetRepository,
      base_commit: poolBaseCommit,
      validation_commands: poolValidationCommands,
    });
    itemCount = r.items.length;
    alreadyExisted = r.already_existed;
  }

  const startedAt = now();
  const exec: PipelineExecution = {
    ...createExecutionLifecycle(deliveryTargetForTicket(ticket), startedAt),
    execution_id: executionId,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    ticket_title: ticketTitleForExecution(ticket.title),
    gate_decision: d.decision,
    seed_path: seedUsed,
    stage: "pool-enqueued",
    branch_name: null,
    repo_path: executionWorkdir,
    pr_number: null,
    shadow_phase: currentShadowPhase(),
    started_at: startedAt,
    completed_at: now(), // enqueue is complete; work is tracked in pool state by campaign_id
    status: "pool-enqueued",
    result_summary: alreadyExisted
      ? `SF-003 pool: campaign ${campaignId} already enqueued (idempotent no-op)`
      : `SF-003 pool: campaign ${campaignId} enqueued (${itemCount} item${itemCount === 1 ? "" : "s"}) — pool-manager reconcile dispatches from the ready set`,
    error: null,
    ...(seedContract?.persona_association
      ? { persona_association: personaAssociationLineage(seedContract.persona_association) }
      : {}),
    ...(seedContract ? projectDelegationExecutionFields(seedContract, delegationAdmission) : {}),
  };
  transitionExecution(exec, "pool_enqueued", "pool", `campaign:${campaignId}`, { item_count: itemCount });
  console.log(`[exec] ${ticket.identifier}: ${d.decision} → pool ${alreadyExisted ? "(already enqueued)" : `(${itemCount} items)`}`);
  saveExecution(exec);
  recordFlight({ execution_id: executionId, identifier: ticket.identifier, kind: "exec.pool-enqueued", data: { gate: d.decision, items: itemCount, already_existed: alreadyExisted } });
  const handoff = await reconcilePoolHandoff(campaignId, {
    mode: dryRun ? "plan" : currentReconcileMode(),
    shadow_phase: exec.shadow_phase,
  });
  exec.pool_handoff = handoff;
  if (handoff.reachability === "parked_with_retry" || handoff.reachability === "reconcile_attempted") {
    transitionExecution(exec, "held", "pool-handoff", handoff.reconcile_event_id ?? `campaign:${campaignId}`, {
      reachability: handoff.reachability,
      reason: handoff.reason,
    });
    exec.stage = "pool-handoff-held";
    exec.status = "held";
    exec.result_summary = `SF-003 pool handoff held: ${handoff.reason}`;
    exec.error = handoff.reason;
  } else if (handoff.reachability === "terminal") {
    transitionExecution(exec, "failed", "pool-handoff", handoff.reconcile_event_id ?? `campaign:${campaignId}`, {
      reachability: handoff.reachability,
      reason: handoff.reason,
    });
    exec.stage = "pool-terminal";
    exec.status = "failed";
    exec.result_summary = `SF-003 pool handoff terminal: ${handoff.reason}`;
    exec.error = handoff.reason;
  } else {
    exec.result_summary = `SF-003 pool handoff reachable: ${handoff.reason}`;
  }
  saveExecution(exec);
  recordFlight({
    execution_id: executionId,
    identifier: ticket.identifier,
    kind: `exec.pool-handoff.${handoff.reachability}`,
    detail: handoff.reason,
    data: {
      campaign_id: campaignId,
      assignment_id: handoff.assignment_id,
      reconcile_event_id: handoff.reconcile_event_id,
    },
  });
  return exec;
}

// ─── Execution strategies ─────────────────────────────────────────────────────

function retryableExecutorError(error: string): boolean {
  const normalized = error.toLowerCase();
  return ["response interrupted", "stream dropped", "connection dropped", "timed out", "wedged child"].some((term) => normalized.includes(term));
}

async function executeHetzner(
  ticket: IntakeTicket,
  gateDecision: "DIRECT" | "SUGGEST" | "SWARM" | "FORCE_SWARM",
  route: HetznerExecutionRoute,
  dryRun: boolean,
  executionPolicy: ExecutionPolicy | null,
  executionId?: string,
): Promise<PipelineExecution> {
  const execution_id = executionId ?? `exec-${randomUUID().slice(0, 8)}`;
  const branch = generateBranchName(ticket);
  const startedAt = now();
  const executionWorkdir = executionWorkdirForTicket(ticket);
  const baseCommit = dryRun
    ? null
    : captureExecutionBaseCommit({
        executionId: execution_id,
        stateDir: STATE_DIR,
        workdir: executionWorkdir,
        ref: "origin/main",
      });
  const exec: PipelineExecution = {
    ...createExecutionLifecycle(deliveryTargetForTicket(ticket), startedAt),
    execution_id,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    ticket_title: ticketTitleForExecution(ticket.title),
    gate_decision: gateDecision,
    seed_path: null,
    stage: dryRun ? "dry-run-staged" : "executing",
    branch_name: dryRun ? null : branch,
    repo_path: executionWorkdir,
    base_commit: baseCommit,
    pr_number: null,
    shadow_phase: currentShadowPhase(),
    started_at: startedAt,
    completed_at: dryRun ? now() : null,
    status: dryRun ? "dry-run" : "executing",
    result_summary: dryRun ? `Hetzner ${route.profile_name ?? "unsupported"} execution staged` : null,
    error: null,
    executor_timeout_ms: route.profile ? route.profile.ttl_minutes * 60_000 : undefined,
  };

  saveExecution(exec);
  recordFlight({
    execution_id,
    identifier: ticket.identifier,
    kind: "hetzner.route",
    detail: route.reason,
    data: {
      binding: route.binding,
      supported: route.supported,
      matched_text: route.matched_text,
      profile: route.profile_name,
      server_type: route.profile?.server_type,
      location: route.location,
      max_in_flight: 1,
    },
  });

  if (dryRun) {
    transitionExecution(exec, "dry_run", "operator", `dry-run:${ticket.identifier}`, {
      execution_target: "hetzner-ephemeral",
      profile: route.profile_name,
    });
    saveExecution(exec);
    return exec;
  }

  if (!route.supported) {
    exec.completed_at = now();
    exec.status = "failed";
    exec.stage = "failed";
    exec.error = `binding Hetzner execution cannot start: ${route.reason}`;
    exec.result_summary = exec.error;
    transitionExecution(exec, "failed", "hetzner-routing", `ticket:${ticket.identifier}`, {
      binding: true,
      fallback_allowed: false,
    });
    saveExecution(exec);
    recordFlight({
      execution_id,
      identifier: ticket.identifier,
      kind: "exec.failed",
      detail: exec.error,
      data: { executor: "zo-byok-cascade+hetzner-verify", fallback_allowed: false },
    });
    return exec;
  }

  recordFlight({
    execution_id,
    identifier: ticket.identifier,
    kind: "executor.start",
    data: {
      executor: "zo-byok-cascade+hetzner-verify",
      profile: route.profile_name,
      server_type: route.profile?.server_type,
      timeout_ms: exec.executor_timeout_ms,
    },
  });
  const result = await runHetznerExecutor({
    executionId: execution_id,
    ticket,
    decision: gateDecision,
    workdir: executionWorkdir,
    route,
    executionPolicy,
  });
  exec.hetzner_executor = result;
  if (result.change_quiz_answers) exec.change_quiz_answers = result.change_quiz_answers;
  exec.completed_at = now();
  exec.result_summary = result.summary;
  exec.executor_harness = "zo-byok-cascade+hetzner-verify";
  exec.model_used = result.implementation_model ?? "executor:zo-byok-cascade+hetzner-verify";
  exec.failover_trail = result.implementation_trail
    || (result.pass ? "executor:zo-byok-cascade+hetzner-verify=ok" : "executor:zo-byok-cascade+hetzner-verify=failed-closed");

  if (result.pass) {
    exec.status = "complete";
    exec.stage = "complete";
    transitionExecution(exec, "implementation_complete", "executor", "executor:zo-byok-cascade+hetzner-verify", {
      branch,
      profile: route.profile_name,
      server_type: route.profile?.server_type,
      evidence_path: result.evidence_path,
      patch_path: result.patch_path,
      patch_applied: result.patch_applied,
      implementation_provider: result.implementation_provider,
      implementation_model: result.implementation_model,
      implementation_trail: result.implementation_trail,
      cascade_attempts: result.cascade_attempts,
      estimated_compute_cost_usd: result.evidence?.estimated_cost_usd,
      teardown: result.evidence?.teardown,
    });
    recordFlight({
      execution_id,
      identifier: ticket.identifier,
      kind: "executor.ok",
      detail: result.summary,
      data: {
        executor: "zo-byok-cascade+hetzner-verify",
        profile: route.profile_name,
        evidence_path: result.evidence_path,
        patch_applied: result.patch_applied,
      },
    });
  } else {
    exec.status = "failed";
    exec.stage = "failed";
    exec.error = result.summary;
    transitionExecution(exec, "failed", "hetzner-executor", `execution:${execution_id}`, {
      binding: true,
      fallback_allowed: false,
      evidence_path: result.evidence_path,
      teardown: result.evidence?.teardown,
    });
    recordFlight({
      execution_id,
      identifier: ticket.identifier,
      kind: "exec.failed",
      detail: result.summary,
      data: { executor: "zo-byok-cascade+hetzner-verify", fallback_allowed: false },
    });
  }
  saveExecution(exec);
  return exec;
}

/**
 * Execute a DIRECT ticket inline (no /zo/ask call).
 * In shadow mode, this stages commits but does not push.
 */
async function executeDirect(
  ticket: IntakeTicket,
  dryRun: boolean,
  executionId?: string,
  resumeNote?: string,
  gateDecision: "DIRECT" | "SUGGEST" = "DIRECT",
): Promise<PipelineExecution> {
  const execution_id = executionId ?? `exec-${randomUUID().slice(0, 8)}`;
  const branch = generateBranchName(ticket);
  const startedAt = now();
  const executionWorkdir = executionWorkdirForTicket(ticket);
  const timeoutMs = harnessTimeoutMs();
  const idleTimeoutMs = harnessIdleTimeoutMs();
  const baseCommit = dryRun
    ? null
    : captureExecutionBaseCommit({
        executionId: execution_id,
        stateDir: STATE_DIR,
        workdir: executionWorkdir,
        ref: "origin/main",
      });

  const exec: PipelineExecution = {
    ...createExecutionLifecycle(deliveryTargetForTicket(ticket), startedAt),
    execution_id,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    ticket_title: ticketTitleForExecution(ticket.title),
    gate_decision: gateDecision,
    seed_path: null,
    stage: dryRun ? "dry-run-staged" : "executing",
    branch_name: dryRun ? null : branch,
    repo_path: executionWorkdir,
    base_commit: baseCommit,
    pr_number: null,
    shadow_phase: currentShadowPhase(),
    started_at: startedAt,
    completed_at: dryRun ? now() : null,
    status: dryRun ? "dry-run" : "executing",
    result_summary: dryRun
      ? "DIRECT ticket staged for dry-run (no execution in shadow)"
      : null,
    error: null,
    executor_timeout_ms: dryRun ? undefined : timeoutMs,
    executor_idle_timeout_ms: dryRun ? undefined : idleTimeoutMs,
  };

  if (dryRun) transitionExecution(exec, "dry_run", "operator", `dry-run:${ticket.identifier}`);

  saveExecution(exec);
  if (dryRun) {
    console.log(`[exec] ${ticket.identifier}: DIRECT — staged (dry-run, no execution)`);
    recordFlight({
      execution_id,
      identifier: ticket.identifier,
      kind: "exec.dry-run",
      detail: ticket.title,
      data: { gate: gateDecision, branch: null, repo_path: executionWorkdir, base_commit: exec.base_commit },
    });
    return exec;
  }

  console.log(`[exec] ${ticket.identifier}: DIRECT — dispatching through executor chain [${CODER_HARNESS_CHAIN.join(" → ")}] (branch: ${branch})...`);
  const outputTees = new Map<string, (text: string) => void>();
  const healthProbe = defaultHealthProbe();
  const onEvent = (event: ExecutorLifecycleEvent) => recordFlight({
    execution_id,
    identifier: ticket.identifier,
    kind: event.kind,
    detail: event.detail,
    data: event.data,
  });
  const onOutput = (executorId: string, text: string) => {
    let tee = outputTees.get(executorId);
    if (!tee) {
      tee = makeExecTee(execution_id, ticket.identifier, executorId);
      outputTees.set(executorId, tee);
    }
    tee(text);
  };
  let result = await runExecutorChain({
    prompt: buildDirectPrompt(ticket, resumeNote),
    workdir: executionWorkdir,
    timeoutMs,
    idleTimeoutMs,
    healthProbe,
    onEvent,
    onOutput,
  });

  if (!result.success) {
    const recovery = await attemptTransientRecovery({
      subject: { execution_id, ticket_id: ticket.linear_id, identifier: ticket.identifier },
      stateDir: STATE_DIR,
      failure: result.error ?? "executor chain failed without an error",
      prompt: buildDirectPrompt(ticket, resumeNote),
      workdir: executionWorkdir,
      timeoutMs,
      idleTimeoutMs,
      chain: CODER_HARNESS_CHAIN,
      healthProbe,
      harnessRun: runHarness,
      onEvent,
      onOutput,
    });
    if (recovery.status === "recovered") {
      result = recovery.result;
      exec.transient_recovery = transientRecoveryEvidence(recovery);
      recordFlight({
        execution_id,
        identifier: ticket.identifier,
        kind: "exec.transient-recovered",
        data: { ...exec.transient_recovery },
      });
    } else if (recovery.status === "failed" || recovery.status === "blocked") {
      return holdAfterTransientRecovery(exec, ticket, recovery);
    }
  }

  exec.completed_at = now();
  exec.failover_trail = result.trail.join(" → ");
  if (result.success) {
    exec.status = "complete";
    exec.stage = "complete";
    exec.result_summary = result.output.slice(0, 5000);
    exec.executor_harness = result.executorId ?? undefined;
    exec.model_used = result.modelUsed ?? `executor:${result.executorId}`;
    exec.token_usage = result.tokensUsed !== undefined
      || result.inputTokens !== undefined
      || result.outputTokens !== undefined
      ? {
          total: result.tokensUsed,
          input: result.inputTokens,
          output: result.outputTokens,
        }
      : undefined;
    exec.model_cost_usd = result.costUsd;
    exec.model_provenance = result.modelProvenance;
    transitionExecution(exec, "implementation_complete", "executor", `executor:${result.executorId}`, {
      branch,
      output_bytes: result.output.length,
      model_used: exec.model_used,
      token_usage: exec.token_usage,
      model_cost_usd: exec.model_cost_usd,
      model_provenance: exec.model_provenance,
    });
    console.log(`[exec] ${ticket.identifier}: DIRECT complete via executor ${result.executorId} — ${result.output.slice(0, 200)}...`);
  } else {
    exec.status = "failed";
    exec.stage = "failed";
    exec.error = result.error;
    exec.retry_eligible = retryableExecutorError(result.error ?? "");
    transitionExecution(exec, "failed", "executor-chain", `execution:${execution_id}`, {
      retry_eligible: exec.retry_eligible,
    });
    console.error(`[exec] ${ticket.identifier}: DIRECT FAILED — ${result.error}`);
  }
  saveExecution(exec);
  return exec;
}

/**
 * Execute a SUGGEST ticket — defaults to direct execution with a note.
 */
async function executeSuggest(
  ticket: IntakeTicket,
  dryRun: boolean,
  executionId?: string,
  resumeNote?: string,
): Promise<PipelineExecution> {
  console.log(`[exec] ${ticket.identifier}: SUGGEST — defaulting to direct execution (operator judgment)`);
  return executeDirect(ticket, dryRun, executionId, resumeNote, "SUGGEST");
}

/** Returns true when the error string matches known stream-drop/ACP-pool-wedge patterns. */
function isStreamDrop(msg: string): boolean {
  const s = msg.toLowerCase();
  return (
    s.includes("response interrupted") ||
    s.includes("no agent output") ||
    s.includes("dropped upstream stream") ||
    s.includes("wedged child") ||
    s.includes("stream dropped") ||
    s.includes("connection dropped")
  );
}

/**
 * Execute a SWARM/FORCE_SWARM ticket via the coder-executor chain.
 * The child agent runs the full pipeline: interview → seed → eval → execute → post-flight → gap audit.
 * Chain walk: for each executor (claude-code → opencode → codex → gemini → pi → kimi), cheap health
 * probe → real dispatch; any failure advances to the next rung. Exhausting
 * the whole chain is a terminal failure (de-Zo phase 2: no Zo fallback).
 */
async function executeSwarm(
  ticket: IntakeTicket,
  force: boolean,
  dryRun: boolean,
  executionId?: string,
  resumeNote?: string,
): Promise<PipelineExecution> {
  const execution_id = executionId ?? `exec-${randomUUID().slice(0, 8)}`;
  const branch = generateBranchName(ticket);
  const executionWorkdir = executionWorkdirForTicket(ticket);

  if (dryRun) {
    const dryRunAt = now();
    const lifecycle = transitionExecutionLifecycle(
      createExecutionLifecycle(deliveryTargetForTicket(ticket), dryRunAt),
      "dry_run",
      { kind: "operator", reference: `dry-run:${ticket.identifier}`, recorded_at: dryRunAt },
      { now: dryRunAt },
    );
    const exec: PipelineExecution = {
      ...lifecycle,
      execution_id,
      ticket_id: ticket.linear_id,
      identifier: ticket.identifier,
      ticket_title: ticketTitleForExecution(ticket.title),
      gate_decision: force ? "FORCE_SWARM" : "SWARM",
      seed_path: null,
      stage: "dry-run-staged",
      branch_name: null,
      repo_path: executionWorkdir,
      pr_number: null,
      shadow_phase: currentShadowPhase(),
      started_at: dryRunAt,
      completed_at: dryRunAt,
      status: "dry-run",
      result_summary: `${force ? "FORCE_SWARM" : "SWARM"} ticket staged for dry-run (no executor dispatch)`,
      error: null,
    };
    console.log(`[exec] ${ticket.identifier}: ${force ? "FORCE_SWARM" : "SWARM"} — staged (dry-run, no executor dispatch)`);
    saveExecution(exec);
    recordFlight({ execution_id, identifier: ticket.identifier, kind: "exec.dry-run", data: { gate: exec.gate_decision } });
    return exec;
  }

  const prompt = buildSwarmPrompt(ticket, resumeNote);
  const startedAt = now();
  const timeoutMs = harnessTimeoutMs();
  const idleTimeoutMs = harnessIdleTimeoutMs();
  const baseCommit = captureExecutionBaseCommit({
    executionId: execution_id,
    stateDir: STATE_DIR,
    workdir: executionWorkdir,
    ref: "origin/main",
  });

  console.log(`[exec] ${ticket.identifier}: ${force ? "FORCE_SWARM" : "SWARM"} — dispatching through executor chain [${CODER_HARNESS_CHAIN.join(" → ")}] (branch: ${branch})...`);

  const exec: PipelineExecution = {
    ...createExecutionLifecycle(deliveryTargetForTicket(ticket), startedAt),
    execution_id,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    ticket_title: ticketTitleForExecution(ticket.title),
    gate_decision: force ? "FORCE_SWARM" : "SWARM",
    seed_path: null,
    stage: "executing",
    branch_name: branch,
    repo_path: executionWorkdir,
    base_commit: baseCommit,
    pr_number: null,
    shadow_phase: currentShadowPhase(),
    started_at: startedAt,
    completed_at: null,
    status: "executing",
    result_summary: null,
    error: null,
    executor_timeout_ms: timeoutMs,
    executor_idle_timeout_ms: idleTimeoutMs,
  };
  saveExecution(exec);
  recordFlight({
    execution_id,
    identifier: ticket.identifier,
    kind: "exec.start",
    detail: ticket.title,
    data: {
      gate: exec.gate_decision,
      branch,
      repo_path: executionWorkdir,
      base_commit: baseCommit,
      chain: [...CODER_HARNESS_CHAIN],
      timeout_min: Math.round(timeoutMs / 60_000),
      idle_timeout_min: Math.round(idleTimeoutMs / 60_000),
    },
  });

  const trail: string[] = [];
  const probe = defaultHealthProbe();

  for (const executorId of CODER_HARNESS_CHAIN) {
    let health: { healthy: boolean; message: string };
    try {
      health = await probe(executorId);
    } catch (e: any) {
      health = { healthy: false, message: e?.message ?? String(e) };
    }
    if (!health.healthy) {
      trail.push(`executor:${executorId}=unhealthy`);
      console.error(`[exec] ${ticket.identifier}: executor ${executorId} unhealthy — ${health.message}; trying next in chain`);
      recordFlight({ execution_id, identifier: ticket.identifier, kind: "probe.unhealthy", detail: health.message, data: { executor: executorId } });
      continue;
    }
    recordFlight({ execution_id, identifier: ticket.identifier, kind: "probe.ok", data: { executor: executorId } });

    try {
      recordFlight({
        execution_id,
        identifier: ticket.identifier,
        kind: "executor.start",
        data: { executor: executorId, timeout_ms: timeoutMs, idle_timeout_ms: idleTimeoutMs },
      });
      const r = await runHarness(executorId, prompt, {
        workdir: executionWorkdir,
        timeoutMs,
        idleTimeoutMs,
        onOutput: makeExecTee(execution_id, ticket.identifier, executorId),
      });
      const secs = Math.round(r.durationMs / 1000);
      if (r.success) {
        trail.push(`executor:${executorId}=ok(${secs}s)`);
        const output = r.output || "";
        exec.completed_at = now();
        exec.status = "complete";
        exec.stage = "complete";
        exec.result_summary = output.slice(0, 5000);
        exec.executor_harness = executorId;
        exec.model_used = r.modelUsed ?? `executor:${executorId}`;
        exec.token_usage = r.tokensUsed !== undefined
          || r.inputTokens !== undefined
          || r.outputTokens !== undefined
          ? {
              total: r.tokensUsed,
              input: r.inputTokens,
              output: r.outputTokens,
            }
          : undefined;
        exec.model_cost_usd = r.costUsd;
        exec.model_provenance = r.modelProvenance;
        exec.failover_trail = trail.join(" → ");
        transitionExecution(exec, "implementation_complete", "executor", `executor:${executorId}`, {
          branch,
          output_bytes: output.length,
          model_used: exec.model_used,
          token_usage: exec.token_usage,
          model_cost_usd: exec.model_cost_usd,
          model_provenance: exec.model_provenance,
        });
        saveExecution(exec);
        console.log(`[exec] ${ticket.identifier}: SWARM complete via executor ${executorId} — ${output.slice(0, 200)}...`);
        recordFlight({ execution_id, identifier: ticket.identifier, kind: "executor.ok", data: { executor: executorId, secs } });
        recordFlight({ execution_id, identifier: ticket.identifier, kind: "exec.implementation_complete", detail: output.slice(0, 200), data: { model_used: exec.model_used } });
        return exec;
      }
      const detail = (r.failureDetail ?? r.output).trim().replace(/\s+/g, " ").slice(0, 200) || "unsuccessful result";
      const failureKind = r.failureKind ?? "execution";
      trail.push(`executor:${executorId}=fail(${secs}s):${failureKind}:${detail}`);
      console.error(`[exec] ${ticket.identifier}: executor ${executorId} reported failure after ${secs}s; trying next in chain`);
      recordFlight({ execution_id, identifier: ticket.identifier, kind: "executor.fail", detail, data: { executor: executorId, secs, failure_kind: failureKind } });
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).slice(0, 120);
      const failureKind = classifyHarnessFailureDetail(msg);
      trail.push(`executor:${executorId}=throw:${failureKind}:${msg}`);
      console.error(`[exec] ${ticket.identifier}: executor ${executorId} threw — ${msg}; trying next in chain`);
      recordFlight({ execution_id, identifier: ticket.identifier, kind: "executor.throw", detail: msg, data: { executor: executorId, failure_kind: failureKind } });
    }
  }

  const ticketArchetype = parseTicketFields(ticket.description).archetype;
  const executorFailure = `executor chain exhausted (${trail.join(" → ")})`;
  const recoveryOutputTees = new Map<string, (text: string) => void>();
  const recovery = await attemptTransientRecovery({
    subject: { execution_id, ticket_id: ticket.linear_id, identifier: ticket.identifier },
    stateDir: STATE_DIR,
    failure: executorFailure,
    prompt,
    workdir: executionWorkdir,
    timeoutMs,
    idleTimeoutMs,
    chain: CODER_HARNESS_CHAIN,
    healthProbe: probe,
    harnessRun: runHarness,
    onEvent: (event) => recordFlight({
      execution_id,
      identifier: ticket.identifier,
      kind: event.kind,
      detail: event.detail,
      data: event.data,
    }),
    onOutput: (executorId, text) => {
      let tee = recoveryOutputTees.get(executorId);
      if (!tee) {
        tee = makeExecTee(execution_id, ticket.identifier, executorId);
        recoveryOutputTees.set(executorId, tee);
      }
      tee(text);
    },
  });
  if (recovery.status === "recovered") {
    const r = recovery.result;
    const output = r.output || "";
    exec.completed_at = now();
    exec.status = "complete";
    exec.stage = "complete";
    exec.result_summary = output.slice(0, 5000);
    exec.executor_harness = r.executorId ?? undefined;
    exec.model_used = r.modelUsed ?? `executor:${r.executorId}`;
    exec.token_usage = r.tokensUsed !== undefined || r.inputTokens !== undefined || r.outputTokens !== undefined
      ? { total: r.tokensUsed, input: r.inputTokens, output: r.outputTokens }
      : undefined;
    exec.model_cost_usd = r.costUsd;
    exec.model_provenance = r.modelProvenance;
    exec.failover_trail = [...trail, `recovery:${recovery.recovery_id}`, ...r.trail].join(" → ");
    exec.transient_recovery = transientRecoveryEvidence(recovery);
    transitionExecution(exec, "implementation_complete", "transient-recovery", `recovery:${recovery.recovery_id}`, {
      branch,
      output_bytes: output.length,
      executor: r.executorId,
      prevalidated_routes: exec.transient_recovery.prevalidated_routes,
    });
    saveExecution(exec);
    console.log(`[exec] ${ticket.identifier}: SWARM recovered via executor ${r.executorId} — ${output.slice(0, 200)}...`);
    recordFlight({
      execution_id,
      identifier: ticket.identifier,
      kind: "exec.transient-recovered",
      detail: output.slice(0, 200),
      data: { ...exec.transient_recovery },
    });
    return exec;
  }
  if (recovery.status === "failed" || recovery.status === "blocked") {
    return holdAfterTransientRecovery(exec, ticket, recovery);
  }

  // Zouroboros System (de-Zo phase 2): the legacy Zo fallback has been
  // removed. Executor-chain exhaustion falls through to the terminal
  // failure below — there is no Zo transport to fall back to.

  exec.completed_at = now();
  exec.status = "failed";
  exec.stage = "failed";
  exec.failover_trail = trail.join(" → ");
  exec.error = `executor chain exhausted (${trail.join(" → ")}); no local harness executor succeeded (archetype '${ticketArchetype}')`;
  transitionExecution(exec, "failed", "executor-chain", `execution:${execution_id}`, { retry_eligible: false });
  saveExecution(exec);
  console.error(`[exec] ${ticket.identifier}: SWARM FAILED — ${exec.error}`);
  recordFlight({ execution_id, identifier: ticket.identifier, kind: "exec.failed", detail: exec.error, data: { trail: exec.failover_trail } });
  return exec;
}

// ─── SF-010 post-execution promotion gate ─────────────────────────────────────

/**
 * SF-010 T0: After post-flight passes and a PR exists, evaluate the auto-merge
 * lane. Persona attestation is evaluated even when SF010_AUTOMERGE is unset; the flag
 * controls merge authority, not whether the mandatory gate runs. Advisory
 * mode logs would-be decisions without permitting a merge.
 *
 * In production, prRef would be the real PR number extracted from exec output.
 * Archetype: SF-011 classifier when SF011_LINES=1 (fine-grained alias name
 * preserved — the exact vocabulary the lane's allowlist was baselined on),
 * else the ticket's contract fields (existing parseContractFields). Injected
 * dependencies are the defaults (no real merger, no real scenario runner) —
 * the lane uses noop stubs unless the operator wires in the real gh integration.
 */
async function runSf010PromotionGate(
  exec: PipelineExecution,
  ticket: IntakeTicket,
  verdict: RiskVerdict | null,
  sf011: ArchetypeClassification | null = null,
): Promise<void> {
  const lifecycle = normalizeExecutionLifecycle(exec);
  if (lifecycle.state !== "verified" || !hasProvenDeliveryState(lifecycle, "verified")) return;

  const fields = parseContractFields(ticket.description || "");
  const archetype = sf011 !== null
    ? laneArchetypeName(sf011)
    : (fields.archetype || "unknown").trim().toLowerCase();

  // SF-011: line eligibility check — TIGHTENING only (the SF-010 allowlist
  // stays the merge truth). Unknown lines get migration (most conservative)
  // rules; invalid config fails closed in enforce mode.
  if (sf011 !== null) {
    const cfg = sf011Config();
    const enforce = process.env.SF011_ENFORCE === "1";
    if (cfg.loaded === null) {
      if (enforce) {
        console.error(`[sf011] ${ticket.identifier}: line-config INVALID (${cfg.error}) — sf010 lane SKIPPED (fail-closed)`);
        return;
      }
      console.error(`[sf011] ${ticket.identifier}: line-config INVALID (${cfg.error}) — would-skip sf010 lane (advisory)`);
    } else {
      const rules = rulesForLine(sf011.line, cfg.loaded.config);
      if (!rules.auto_merge_eligible) {
        if (enforce) {
          console.log(`[sf011] ${ticket.identifier}: line=${sf011.line} auto_merge_eligible=false — sf010 lane SKIPPED (enforce)`);
          return;
        }
        console.log(`[sf011] ${ticket.identifier}: line=${sf011.line} auto_merge_eligible=false — would-skip sf010 lane (advisory)`);
      }
    }
  }

  const certification = certificationEnabled();
  let context = exec.promotion_context;
  const holdBeforeDispatch = (reason: string): void => {
    console.error(`[sf010] ${ticket.identifier}: ${reason} — HOLD before reviewer dispatch`);
    const persistence = persistPreDispatchHold(exec, reason, { now, saveExecution, saveHold });
    recordFlight({
      execution_id: exec.execution_id,
      identifier: ticket.identifier,
      kind: "sf010.hold",
      detail: reason,
      data: { reviewer_dispatches: 0, retry: false, persistence },
    });
  };
  if (certification && !context) {
    try {
      const binding = loadPromotionExecutionBinding({
        configuredPath: process.env.SF010_PROMOTION_CONTEXT_PATH,
        executionId: exec.execution_id,
        ticketIdentifier: ticket.identifier,
        expectedRepoDir: exec.repo_path,
        expectedPullRequest: exec.pr_number,
        expectedHeadRef: exec.branch_name,
      });
      context = binding.context;
      exec.promotion_context = binding.context;
      if (binding.claim) exec.promotion_context_claim = binding.claim;
      if (exec.pr_number === null || exec.pr_number === undefined) exec.pr_number = context.pullRequest;
      saveExecution(exec);
    } catch (error) {
      holdBeforeDispatch(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (certification && exec.pr_number !== context?.pullRequest) {
    holdBeforeDispatch("execution PR does not match promotion_context");
    return;
  }
  if (certification && (exec.repo_path !== context?.repoDir || context?.headSha.length !== 40)) {
    holdBeforeDispatch("execution checkout or exact head binding does not match promotion_context");
    return;
  }
  if (certification && context) {
    const head = Bun.spawnSync(["git", "-C", context.repoDir, "rev-parse", "HEAD"]);
    const actualHead = head.exitCode === 0 ? new TextDecoder().decode(head.stdout).trim() : "";
    if (actualHead !== context.headSha || (exec.branch_name !== null && exec.branch_name !== context.headRef)) {
      holdBeforeDispatch("live checkout head or branch drifted from promotion_context");
      return;
    }
  }

  const prRef = context ? String(context.pullRequest) : (exec.pr_number !== null ? String(exec.pr_number) : exec.execution_id);
  const targetRepo = context?.repoDir ?? exec.repo_path ?? executionWorkdirForTicket(ticket);
  const personaAttestationPath = context?.personaAttestationPath
    ?? join(targetRepo, "evaluations", `${ticket.identifier.toLowerCase()}-persona-attestation.json`);

  console.log(`[sf010] ${ticket.identifier}: evaluating auto-merge lane (archetype=${archetype}, pr=${prRef}, advisory=${!automergeEnabled()})`);

  try {
    const result = await runAutoMergeLane(
      prRef,
      archetype,
      verdict ?? {
        verdict_id: `sf010-fallback-${exec.execution_id}`,
        execution_id: exec.execution_id,
        ticket_id: ticket.linear_id,
        identifier: ticket.identifier,
        tier: "low",
        score: 0.1,
        reasons: ["fallback — no SF-002 verdict available"],
        inputs: {
          archetype,
          target_repo: fields.target_repo || ticket.identifier,
          repro: "",
          acceptance_criteria: "",
          gate_decision: exec.gate_decision,
          seed_eval_score: null,
          files_touched_estimate: 1,
          schema_contact: false,
          secret_contact: false,
          infra_contact: false,
          reversibility: "easy",
        },
        classified_at: new Date().toISOString(),
        mode: "shadow",
        acted: false,
      },
      [],
      context?.diff ?? "",
      {
        personaAttestationPath,
        personaRepoDir: targetRepo,
        ...(context ? {
          mergeRepo: context.repository,
          operatorApprovalPath: context.operatorApprovalPath,
          operatorApprovalKeyPath: context.operatorApprovalKeyPath,
          rollbackEvidencePath: context.rollbackEvidencePath,
          certificationValidationEvidencePath: context.certificationValidationEvidencePath,
          personaKeyPath: context.personaKeyPath,
        } : {}),
      },
    );

    console.log(`[sf010] ${ticket.identifier}: lane decision=${result.decision} — ${result.reason}`);
    if (result.audit_path) {
      console.log(`[sf010] ${ticket.identifier}: audit record → ${result.audit_path}`);
    }
    if (result.decision === "certified") {
      exec.result_summary = `${exec.result_summary ?? "verified execution"}; SF010 certified at Gate 10 with merge disabled`;
      saveExecution(exec);
      recordFlight({
        execution_id: exec.execution_id,
        identifier: ticket.identifier,
        kind: "sf010.certified",
        detail: result.reason,
        data: { evidence_path: result.evidence_path ?? null, merge: false, retry: false },
      });
    }
    if (result.decision === "merged") {
      if (exec.pr_number === null) throw new Error("auto-merge reported success without a concrete PR number");
      const evidenceRef = result.audit_path ?? `pr:${exec.pr_number}`;
      transitionExecution(exec, "pr_ready", "auto-merge", evidenceRef, { pr_number: exec.pr_number });
      transitionExecution(exec, "ci_green", "auto-merge", evidenceRef, { pr_number: exec.pr_number });
      transitionExecution(exec, "merged", "auto-merge", evidenceRef, { pr_number: exec.pr_number });
      saveExecution(exec);
      recordFlight({
        execution_id: exec.execution_id,
        identifier: ticket.identifier,
        kind: "exec.merged",
        data: { pr_number: exec.pr_number, audit_path: result.audit_path ?? null },
      });
    }
  } catch (err: any) {
    // SF-010 hook failure is always non-blocking (never blocks the existing pipeline)
    console.error(`[sf010] ${ticket.identifier}: post-exec hook failed (non-blocking) — ${err.message}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      dispatch: { type: "string", short: "d" },
      "dry-run": { type: "boolean", default: false },
      "cleanup-worktrees": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  // ZOU-890 — operator/agent bulk reclaim remains available for maintenance.
  // The conveyor preflight reaper performs targeted terminal/stale cleanup.
  if (values["cleanup-worktrees"]) {
    const result = reclaimIsolatedWorktrees();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (values.help) {
    console.log(`
swarm-exec — Execute dispatched tickets through the pipeline

USAGE:
  bun swarm-exec.ts --dispatch <json-file>      # Execute from dispatcher output
  bun swarm-exec.ts --dispatch -                 # Execute from stdin
  bun swarm-exec.ts --dispatch <json> --dry-run  # Report without executing

OUTPUT:
  JSON array of PipelineExecution records to stdout.
  Each record also saved to state/exec-<id>.json.
`);
    process.exit(0);
  }

  const dispatchPath = values.dispatch as string;
  if (!dispatchPath) {
    console.error("Error: --dispatch <file|-> required");
    process.exit(1);
  }

  const raw =
    dispatchPath === "-"
      ? readFileSync("/dev/stdin", "utf-8")
      : readFileSync(dispatchPath, "utf-8");

  const dispatches: unknown = JSON.parse(raw);
  if (!Array.isArray(dispatches)) throw new Error("LINEAR_DISPATCHES_REQUIRED");
  for (const dispatch of dispatches) {
    if (typeof dispatch !== "object" || dispatch === null || !("ticket" in dispatch)) throw new Error("LINEAR_DISPATCH_REQUIRED");
    assertLegacyLinearTicket(dispatch.ticket);
  }
  const linearDispatches = dispatches as DispatchResult[];
  const dryRun = Boolean(values["dry-run"]);

  console.log(`[exec] Processing ${linearDispatches.length} ticket(s) — dryRun=${dryRun}`);

  const executions: PipelineExecution[] = [];
  let inFlight = 0;

  // SF-005: an unreviewed yield-floor SLO breach parks the auto-approval lane.
  // Absent state = never blocked; corrupt state / read failure = fail-closed.
  // Gated on SF005_SLO so a stale state file can't block after the feature is off.
  let sloBlock: { blocked: boolean; reason: string } = { blocked: false, reason: "SF005_SLO off" };
  if (process.env.SF005_SLO === "1") {
    try {
      sloBlock = laneBlockDecision(readSloStateFile(defaultSloSources().statePath));
    } catch (err: any) {
      sloBlock = { blocked: true, reason: `slo lane check failed (fail-closed) — ${err.message}` };
    }
  }

  for (const d of linearDispatches) {
    const activePark = activeFailurePark(d.ticket.identifier, STATE_DIR);
    if (activePark) {
      const executionId = `exec-${randomUUID().slice(0, 8)}`;
      const parkedAt = now();
      const parkedLifecycle = transitionExecutionLifecycle(
        createExecutionLifecycle(deliveryTargetForTicket(d.ticket), parkedAt),
        "held",
        {
          kind: "failure-streak",
          reference: `fingerprint:${activePark.current_fingerprint!.digest}`,
          recorded_at: parkedAt,
        },
        { now: parkedAt },
      );
      const parked: PipelineExecution = {
        ...parkedLifecycle,
        execution_id: executionId,
        ticket_id: d.ticket.linear_id,
        identifier: d.ticket.identifier,
        ticket_title: ticketTitleForExecution(d.ticket.title),
        gate_decision: d.decision,
        seed_path: null,
        stage: "held",
        branch_name: null,
        pr_number: null,
        shadow_phase: currentShadowPhase(),
        started_at: parkedAt,
        completed_at: null,
        status: "held",
        result_summary: `parked after ${activePark.consecutive_failures} equivalent failures; operator release required`,
        error: null,
        retry_eligible: false,
        ...(d.product_gate ? { product_gate: { preflight: d.product_gate } } : {}),
      };
      saveExecution(parked);
      recordFlight({
        execution_id: executionId,
        identifier: d.ticket.identifier,
        kind: "exec.failure-parked-noop",
        data: { fingerprint: activePark.current_fingerprint!.digest },
      });
      executions.push(parked);
      console.log(`[failure-streak] ${d.ticket.identifier}: PARKED — executor dispatch skipped`);
      continue;
    }

    // Enforce concurrency cap
    while (inFlight >= MAX_CONCURRENCY) {
      await new Promise((r) => setTimeout(r, 100));
    }
    inFlight++;

    // SF-006 T3: enforce-mode resume reuses the checkpointed execution instead
    // of starting a fresh one; shadow already logged would-resume at dispatch.
    const resume =
      d.dedup?.decision === "resume_from_checkpoint" && d.dedup.acted && d.dedup.matched_execution_id
        ? d.dedup
        : null;

    // SF-011 T3: assembly-line classification (null when SF011_LINES off)
    const sf011 = sf011Classify(d);

    // SF-002 T4: classify every PipelineExecution before execute (shadow: log-only)
    const execution_id = resume?.matched_execution_id ?? `exec-${randomUUID().slice(0, 8)}`;
    if (!dryRun) {
      const activeTransientHold = activeTransientHoldForTicket(STATE_DIR, d.ticket.linear_id);
      if (activeTransientHold) {
        const held = activeTransientHold.execution as unknown as PipelineExecution;
        console.error(
          `[transient-recovery] ${d.ticket.identifier}: HELD — operator must release ${activeTransientHold.hold.execution_id} before dispatch`,
        );
        recordFlight({
          execution_id: activeTransientHold.hold.execution_id,
          identifier: d.ticket.identifier,
          kind: "exec.transient-recovery-held-noop",
          detail: "active transient recovery hold blocks dispatch until operator release",
          data: { ticket_id: d.ticket.linear_id },
        });
        executions.push(held);
        inFlight--;
        continue;
      }
      const claim = acquireTicketClaim(
        { ticket_id: d.ticket.linear_id, execution_id },
        { stateDir: STATE_DIR },
      );
      if (claim.status !== "acquired") {
        console.error(`[ticket-claim] ${d.ticket.identifier}: SKIPPED — ${claim.reason}`);
        recordFlight({
          execution_id,
          identifier: d.ticket.identifier,
          kind: claim.status === "contended" ? "ticket-claim.contended" : "ticket-claim.unavailable",
          detail: claim.reason,
          data: { ticket_id: d.ticket.linear_id, claim_path: claim.claim_path },
        });
        inFlight--;
        continue;
      }
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: "ticket-claim.acquired",
        data: {
          ticket_id: d.ticket.linear_id,
          claim_path: claim.claim_path,
          lease_expires_at: claim.record.lease_expires_at,
        },
      });
    }
    const verdict = classifyDispatch(d, execution_id, sf011);

    recordFlight({
      execution_id,
      identifier: d.ticket.identifier,
      kind: "gate.decision",
      detail: d.ticket.title,
      data: { decision: d.decision, score: d.score, override: d.override, resumed: resume !== null },
    });

    const sf006Ref = { ticket_id: d.ticket.linear_id, identifier: d.ticket.identifier, execution_id };
    const sf006SeedPath = join(import.meta.dir, "..", `seed-${d.ticket.identifier.toLowerCase()}.yaml`);
    if (resume) {
      console.log(
        `[sf006] ${d.ticket.identifier}: RESUME exec ${execution_id} at stage=${resumeTarget(resume.checkpoint_stage ?? "decision")} — earlier checkpoints not re-appended`
      );
    } else {
      // decision checkpoint: the gate decision for this execution is final here
      sf006Checkpoint(sf006Ref, "decision");
      const hash = sf006SeedHash(sf006SeedPath);
      if (hash) sf006Checkpoint(sf006Ref, "seed", hash);
    }
    if (verdict) {
      console.log(
        `[sf002] ${d.ticket.identifier}: risk=${verdict.tier} score=${verdict.score} mode=${verdict.mode} (${verdict.verdict_id})`
      );
    }
    if (sf011 !== null) sf011AdvisoryLog(d.ticket.identifier, sf011);

    // Auto-promote lane (SF002_AUTO_PROMOTE): medium-tier may proceed within the
    // hard blast-radius ceiling once ≥20 decisions are baselined. Never high.
    let autoPromoted = false;
    if (
      verdict &&
      verdict.mode === "enforce" &&
      verdict.tier === "medium" &&
      process.env.SF002_AUTO_PROMOTE === "1"
    ) {
      try {
        // ZOU-435 learned auto-approval: per-archetype outcome-credit reputation.
        // SF002_REPUTATION (default on) computes + logs the earned-credit baseline
        // (advisory — never changes the decision). SF002_REPUTATION_ENFORCE (default
        // off) makes that per-archetype baseline REPLACE the flat global ≥20 baseline
        // in the eligibility check. The blast-radius ceiling is unaffected either way.
        const repAdvisory = process.env.SF002_REPUTATION !== "0";
        const repEnforce = process.env.SF002_REPUTATION_ENFORCE === "1";
        let repBaseline: ReputationBaseline | undefined;
        if (repAdvisory || repEnforce) {
          repBaseline = reputationBaselineForVerdict(verdict, computeReputation(readLedger()));
          if (repAdvisory) {
            const status = repBaseline.eligible ? "EARNED" : repBaseline.cold_start ? "cold-start" : "below-rate";
            console.log(
              `[sf002-rep] ${d.ticket.identifier}: archetype '${repBaseline.archetype}' — ${repBaseline.distinct_tickets} distinct ticket(s) @ ${repBaseline.distinct_rate ?? "n/a"} → ${status} ${repEnforce ? "[enforced]" : "[advisory]"}`
            );
          }
        }
        const ap = autoPromoteEligible(verdict, agreementStats().resolved, repEnforce ? repBaseline : undefined);
        autoPromoted = ap.eligible;
        console.log(
          `[sf002] ${d.ticket.identifier}: auto-promote ${ap.eligible ? "GRANTED" : "denied"} — ${ap.reasons.join("; ")}`
        );
      } catch (err: any) {
        console.error(`[sf002] auto-promote check failed (fail-closed, holding) — ${err.message}`);
      }
    }

    // SF-005: units that would ride the auto-approval lane (low tier or granted
    // auto-promote) are blocked while an unreviewed yield-floor breach is active.
    // Enforce mode holds; shadow mode logs would-block and proceeds unchanged.
    const wouldAutoApprove = verdict !== null && (verdict.tier === "low" || autoPromoted);
    const heldBySlo = sloBlock.blocked && wouldAutoApprove && verdict !== null && verdict.mode === "enforce";
    if (sloBlock.blocked && wouldAutoApprove && verdict !== null) {
      if (verdict.mode === "enforce") {
        console.log(`[sf005] ${d.ticket.identifier}: auto-approval lane BLOCKED — ${sloBlock.reason}`);
      } else {
        console.log(`[sf005] ${d.ticket.identifier}: would-block auto-approval lane (shadow) — ${sloBlock.reason}`);
      }
    }

    // ZOU-1568: an operator release of a prior SF-002 approval hold persists as
    // a single-use, expiring, tier-bound grant. Consuming it lets this dispatch
    // execute instead of re-parking, closing the release→reap→retry→re-hold
    // loop. SLO-gate holds are never bypassed, and any grant failure holds
    // exactly as before (fail-closed).
    let releaseGrant: ReleaseGrant | null = null;
    if (verdict && verdict.mode === "enforce" && verdict.tier !== "low" && !autoPromoted && !heldBySlo) {
      try {
        const consumed = consumeReleaseGrant(d.ticket.identifier, verdict.tier, execution_id, STATE_DIR);
        releaseGrant = consumed.grant;
        if (releaseGrant) {
          console.log(
            `[sf002] ${d.ticket.identifier}: operator release grant consumed (granted by ${releaseGrant.granted_by} at ${releaseGrant.granted_at}, tier=${releaseGrant.tier}) — executing`,
          );
          recordFlight({
            execution_id,
            identifier: d.ticket.identifier,
            kind: "sf002.release-grant-consumed",
            detail: `granted by ${releaseGrant.granted_by} for ${releaseGrant.source_execution_id}`,
            data: { granted_at: releaseGrant.granted_at, tier: releaseGrant.tier, source_execution_id: releaseGrant.source_execution_id },
          });
        } else if (consumed.reason !== "no grant on file") {
          console.log(`[sf002] ${d.ticket.identifier}: release grant not applied — ${consumed.reason}`);
        }
      } catch (err: any) {
        console.error(`[sf002] ${d.ticket.identifier}: release-grant check failed (fail-closed, holding) — ${err.message}`);
      }
    }

    // Enforce mode only: medium/high park as 'held' instead of executing;
    // SF-005 extends the hold to the auto lane while the SLO block is active.
    if (verdict && verdict.mode === "enforce" && ((verdict.tier !== "low" && !autoPromoted && releaseGrant === null) || heldBySlo)) {
      verdict.acted = true;
      const heldAt = now();
      const heldLifecycle = transitionExecutionLifecycle(
        createExecutionLifecycle(deliveryTargetForTicket(d.ticket), heldAt),
        "held",
        { kind: heldBySlo ? "slo-gate" : "approval-gate", reference: verdict.verdict_id, recorded_at: heldAt },
        { now: heldAt },
      );
      const held: PipelineExecution = {
        ...heldLifecycle,
        execution_id,
        ticket_id: d.ticket.linear_id,
        identifier: d.ticket.identifier,
        ticket_title: ticketTitleForExecution(d.ticket.title),
        gate_decision: d.decision,
        seed_path: null,
        stage: "held",
        branch_name: null,
        pr_number: null,
        shadow_phase: currentShadowPhase(),
        started_at: heldAt,
        completed_at: null,
        status: "held",
        result_summary: heldBySlo
          ? `held by SF-005 SLO gate (${sloBlock.reason}) — auto-approval lane blocked until reviewed`
          : `held by SF-002 approval gate (tier=${verdict.tier}, score=${verdict.score}) — awaiting operator sign-off`,
        error: null,
        risk: { verdict_id: verdict.verdict_id, tier: verdict.tier, score: verdict.score, mode: verdict.mode, acted: true },
        ...(sf011 !== null ? { archetype: { line: sf011.line, source: sf011.source, fine: sf011.fine, disagreement: hasDisagreement(sf011) } } : {}),
        ...(d.product_gate ? { product_gate: { preflight: d.product_gate } } : {}),
      };
      saveExecution(held);
      saveHold({ execution_id, tier: verdict.tier, held_at: now(), notified: "none", released_by: null, released_at: null });
      ledgerAppend(verdict);
      console.log(`[${heldBySlo ? "sf005" : "sf002"}] ${d.ticket.identifier}: HELD (${heldBySlo ? "slo yield-floor breach" : `tier=${verdict.tier}`}) — not executing`);
      recordFlight({ execution_id, identifier: d.ticket.identifier, kind: "exec.held", detail: held.result_summary ?? undefined, data: { tier: verdict.tier, slo: heldBySlo } });
      executions.push(held);
      inFlight--;
      continue;
    }

    if (verdict) ledgerAppend(verdict);

    const executionWorkdir = executionWorkdirForTicket(d.ticket);
    const planGate = await runFactoryPlanGate({
      decision: d.decision,
      seedPath: sf006SeedPath,
      workspaceRoot: executionWorkdir,
      dryRun,
      ticketId: d.ticket.linear_id,
      identifier: d.ticket.identifier,
      executionId: execution_id,
    });
    if (planGate) {
      console.log(
        `[plan-gate] ${d.ticket.identifier}: ${planGate.mode} ${planGate.action} — ${planGate.reason}`,
      );
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: planGate.action === "hold" ? "plan-gate.held" : planGate.wouldHold ? "plan-gate.would-hold" : "plan-gate.passed",
        detail: planGate.reason,
        data: {
          mode: planGate.mode,
          plan_path: planGate.plan_path,
          audit_event: planGate.auditEvent,
          audit_error: planGate.auditError,
          repository_drift: planGate.repository_drift,
        },
      });
      if (planGate.action === "hold") {
        const heldAt = now();
        const heldLifecycle = transitionExecutionLifecycle(
          createExecutionLifecycle(deliveryTargetForTicket(d.ticket), heldAt),
          "held",
          { kind: "plan-consensus-gate", reference: `execution:${execution_id}`, recorded_at: heldAt },
          { now: heldAt },
        );
        const held: PipelineExecution = {
          ...heldLifecycle,
          execution_id,
          ticket_id: d.ticket.linear_id,
          identifier: d.ticket.identifier,
          ticket_title: ticketTitleForExecution(d.ticket.title),
          gate_decision: d.decision,
          seed_path: planGate.plan_path,
          stage: "plan-gate-held",
          branch_name: null,
          repo_path: executionWorkdir,
          pr_number: null,
          shadow_phase: currentShadowPhase(),
          started_at: heldAt,
          completed_at: heldAt,
          status: "held",
          result_summary: `held by Plan Consensus Gate: ${planGate.reason}`,
          error: planGate.auditError ?? null,
          plan_gate: planGate,
          ...(d.product_gate ? { product_gate: { preflight: d.product_gate } } : {}),
        };
        saveExecution(held);
        executions.push(held);
        inFlight--;
        continue;
      }
    }

    const manifestMode = rolloutMode(d.ticket);
    const supplyChain: SupplyChainPreflight = dryRun
      ? { status: "not_run", blocked: false, evidence: [], hashes: {}, diagnostics: [], attestation_hash: null }
      : runSupplyChainPreflight(
          executionWorkdir,
          join(STATE_DIR, "evidence", "supply-chain", execution_id),
          manifestMode,
        );
    recordFlight({
      execution_id,
      identifier: d.ticket.identifier,
      kind: supplyChain.blocked ? "supply-chain.blocked" : "supply-chain.checked",
      data: { status: supplyChain.status, mode: manifestMode, attestation_hash: supplyChain.attestation_hash },
    });

    if (supplyChain.blocked) {
      const blockedAt = now();
      const blockedLifecycle = transitionExecutionLifecycle(
        createExecutionLifecycle(deliveryTargetForTicket(d.ticket), blockedAt),
        "held",
        { kind: "supply-chain", reference: `execution:${execution_id}`, recorded_at: blockedAt },
        { now: blockedAt },
      );
      const blocked: PipelineExecution = {
        ...blockedLifecycle,
        execution_id,
        ticket_id: d.ticket.linear_id,
        identifier: d.ticket.identifier,
        ticket_title: ticketTitleForExecution(d.ticket.title),
        gate_decision: d.decision,
        seed_path: null,
        stage: "supply-chain-blocked",
        branch_name: null,
        pr_number: null,
        shadow_phase: currentShadowPhase(),
        started_at: blockedAt,
        completed_at: blockedAt,
        status: "held",
        result_summary: "blocked by strict supply-chain preflight",
        error: supplyChain.diagnostics.join("; ").slice(0, 2000),
        ...(d.product_gate ? { product_gate: { preflight: d.product_gate } } : {}),
      };
      const author = d.author_identity ?? { provider: "unknown", model: "unknown" };
      const manifest = createEvidenceManifest({
        schema_version: 1,
        ticket: d.ticket.identifier,
        execution_id,
        seed_hash: null,
        author,
        executor: { provider: "factory", model: "preflight" },
        reviewers: [],
        review_evidence: { status: "not_run", evidence: [], hashes: {} },
        tests: [],
        test_evidence: { status: "not_run", evidence: [], hashes: {} },
        artifacts: supplyChain.evidence,
        trace_verification: { status: "not_run", evidence: [], hashes: {} },
        feature_contract: { status: "not_run", evidence: [], hashes: {} },
        supply_chain: supplyChain,
        verdict: "fail",
        rollout_mode: manifestMode,
        override: null,
        generated_at: now(),
      });
      const path = writeEvidenceManifest(manifest);
      blocked.evidence_manifest = { path, hash: manifest.content_hash, mode: manifestMode, blockers: promotionBlockers(manifest) };
      const blockedJoin = { execution_id, assignment_id: execution_id, ticket_id: d.ticket.linear_id };
      blocked.routing_join = { ...blockedJoin, exact_id: exactJoinId(blockedJoin) };
      saveExecution(blocked);
      executions.push(blocked);
      inFlight--;
      continue;
    }

    let preparedFirstPass: PreparedFirstPassValidation | null = null;
    const firstPassPreparationErrors: string[] = [];
    try {
      preparedFirstPass = prepareFirstPassValidation({
        execution_id,
        ticket: d.ticket,
        workdir: executionWorkdir,
        seed_path: sf006SeedPath,
      });
      if (preparedFirstPass) {
        recordFlight({
          execution_id,
          identifier: d.ticket.identifier,
          kind: "first-pass.contract-frozen",
          data: {
            mode: preparedFirstPass.mode,
            contract_digest: preparedFirstPass.contract.contract_digest,
            contract_path: preparedFirstPass.contract_path,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      firstPassPreparationErrors.push(message);
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: "first-pass.contract-held",
        detail: message,
      });
    }

    // ZOU-528/ZOU-1177: per-ticket Model Policy hook. Solver chains remain
    // effective, but legacy model-review pins are inert unless the operator
    // authorizes this exact process with FACTORY_MODEL_REVIEW=operator.
    const ticketPolicy =
      process.env.SF_MODEL_POLICY_HOOK !== "0" ? parseModelPolicy(d.ticket.description || "") : null;
    const outcomeChain = d.outcome_policy
      ? [d.outcome_policy.model_id, ...d.outcome_policy.fallback_model_ids]
      : null;
    const riskTier: string | null = verdict?.tier ?? d.outcome_policy?.risk_tier ?? null;
    const laneDecision = executionLaneForTicket(d.ticket, d.decision);
    const hetznerRoute = laneDecision.hetzner_route;
    const poolRoute = laneDecision.pool_route;
    let executionPolicy: ExecutionPolicy | null = null;
    if (ticketPolicy || outcomeChain) {
      const base: ExecutionPolicy = ticketPolicy ?? {
        tier: "Routine",
        pin_proposers: [],
        pin_aggregator: null,
        model_chain: [],
        review_level: "deterministic",
      };
      executionPolicy = outcomeChain ? { ...base, model_chain: outcomeChain } : base;
    }
    let policyApplied: AppliedPolicy | null = null;
    if (executionPolicy && !poolRoute) {
      policyApplied = applyModelPolicy(executionPolicy);
    }
    if (ticketPolicy && executionPolicy) {
      console.log(`[sf528] ${d.ticket.identifier}: Model Policy ${poolRoute ? "persisted for pool workers" : "applied"} — ${formatPolicy(executionPolicy)}`);
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: poolRoute ? "model-policy.persisted" : "model-policy.applied",
        data: policyEnvironment(ticketPolicy),
      });
    }
    if (d.outcome_policy && executionPolicy) {
      console.log(`[zou500] ${d.ticket.identifier}: promoted outcome policy ${poolRoute ? "persisted for pool workers" : "applied"} — ${formatPolicy(executionPolicy)}`);
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: poolRoute ? "outcome-policy.persisted" : "outcome-policy.applied",
        data: { ...d.outcome_policy, model_chain: outcomeChain!.join(",") },
      });
    }

    let exec!: PipelineExecution;
    try {
      if (hetznerRoute.requested && d.decision !== "ERROR") {
        exec = await executeHetzner(d.ticket, d.decision, hetznerRoute, dryRun, executionPolicy, execution_id);
      } else if (poolRoute) {
        exec = await executePoolEnqueue(d, execution_id, executionPolicy, riskTier, dryRun);
      } else {
        switch (d.decision) {
          case "DIRECT":
            exec = await executeDirect(d.ticket, dryRun, execution_id, sf006ResumeNote(resume));
            break;
          case "SUGGEST":
            exec = await executeSuggest(d.ticket, dryRun, execution_id, sf006ResumeNote(resume));
            break;
          case "SWARM":
            exec = await executeSwarm(d.ticket, false, dryRun, execution_id, sf006ResumeNote(resume));
            break;
          case "FORCE_SWARM":
            exec = await executeSwarm(d.ticket, true, dryRun, execution_id, sf006ResumeNote(resume));
            break;
          default:
            console.error(`[exec] ${d.ticket.identifier}: Unknown decision "${d.decision}" — skipping`);
            inFlight--;
            continue;
        }
      }
      // ZOU-1282: carry the seed's persona-association lineage onto the execution
      // record for the monolithic path too (the pool path stamps it at enqueue).
      // Read-only and non-resolving: no directory call, no identity, no routing
      // change. A seed without an association adds no field and no extra write.
      if (exec.persona_association === undefined && existsSync(sf006SeedPath)) {
        const seedLineage = readSeedPersonaLineage(sf006SeedPath);
        if (seedLineage) {
          exec.persona_association = seedLineage;
          saveExecution(exec);
        }
      }
    } catch (error) {
      const failedAt = now();
      const message = error instanceof Error ? error.message : String(error);
      const retryEligible = retryableExecutionContractError(error);
      const failedLifecycle = transitionExecutionLifecycle(
        createExecutionLifecycle(deliveryTargetForTicket(d.ticket), failedAt),
        "failed",
        {
          kind: "execution-exception",
          reference: `execution:${execution_id}`,
          recorded_at: failedAt,
          details: { retry_eligible: retryEligible },
        },
        { now: failedAt },
      );
      const failedSeedPath = join(import.meta.dir, "..", `seed-${d.ticket.identifier.toLowerCase()}.yaml`);
      exec = {
        ...failedLifecycle,
        execution_id,
        ticket_id: d.ticket.linear_id,
        identifier: d.ticket.identifier,
        ticket_title: ticketTitleForExecution(d.ticket.title),
        gate_decision: d.decision,
        seed_path: existsSync(failedSeedPath) ? failedSeedPath : null,
        stage: "failed",
        branch_name: null,
        repo_path: executionWorkdirForTicket(d.ticket),
        pr_number: null,
        shadow_phase: currentShadowPhase(),
        started_at: failedAt,
        completed_at: failedAt,
        status: "failed",
        result_summary: "factory execution failed before a durable executor result",
        error: message,
        retry_eligible: retryEligible,
      };
      saveExecution(exec);
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: "exec.failed",
        detail: message,
        data: { retry_eligible: retryEligible, unexpected_exception: true },
      });
      console.error(`[exec] ${d.ticket.identifier}: failed before durable executor result — ${message}`);
    } finally {
      if (policyApplied) policyApplied.restore();
    }
    if (resolveChangeQuizMode() !== "off" && exec.result_summary) {
      const changeQuizAnswers = extractChangeQuizAnswers(exec.result_summary);
      if (changeQuizAnswers) exec.change_quiz_answers = changeQuizAnswers;
    }
    if (verdict) {
      exec.risk = { verdict_id: verdict.verdict_id, tier: verdict.tier, score: verdict.score, mode: verdict.mode, acted: verdict.acted };
    }
    if (sf011 !== null) {
      // SF-011: archetype recorded on every run (SF-004 drill-down data path)
      exec.archetype = { line: sf011.line, source: sf011.source, fine: sf011.fine, disagreement: hasDisagreement(sf011) };
    }
    if (d.product_gate) {
      exec.product_gate = { preflight: d.product_gate };
    }
    if (planGate) {
      exec.plan_gate = planGate;
    }
    if (laneDecision.compute_shadow) {
      exec.compute_routing = laneDecision.compute_shadow;
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: "compute-routing.shadow",
        detail: `${laneDecision.lane} -> ${laneDecision.compute_shadow.proposed.provider}/${laneDecision.compute_shadow.proposed.action}`,
        data: { ...laneDecision.compute_shadow },
      });
    }
    const joinIdentity = { execution_id, assignment_id: execution_id, ticket_id: d.ticket.linear_id };
    exec.routing_join = { ...joinIdentity, exact_id: exactJoinId(joinIdentity) };
    if (verdict || sf011 !== null || d.product_gate || planGate || laneDecision.compute_shadow) saveExecution(exec);

    if (dryRun) {
      saveExecution(exec);
      executions.push(exec);
      inFlight--;
      continue;
    }

    // Inline and pool executions share the same deterministic + persona review
    // resolver. Persona routing remains independently shadow/enforce controlled;
    // the Factory never invokes MoA or the model-consensus panel here.
    let outcomeReview: FactoryReviewResult | null = null;
    if (normalizeExecutionLifecycle(exec).state === "implementation_complete") {
      let firstPassVerdict: ValidatorVerdict | null = null;
      const firstPassErrors = [...firstPassPreparationErrors];
      let firstPassRecordId: string | null = null;
      if (preparedFirstPass) {
        const binding = resolveExactCommitDigest({ repoPath: exec.repo_path, branchName: exec.branch_name });
        if (!binding.ok) {
          firstPassErrors.push(binding.error);
        } else {
          const executor = executorIdentity(exec);
          const runtime = runFirstPassValidatorRuntime({
            mode: preparedFirstPass.mode,
            contract: preparedFirstPass.contract,
            expected_contract_digest: preparedFirstPass.contract.contract_digest,
            candidate_repository: exec.repo_path ?? executionWorkdir,
            candidate_commit_sha: binding.commit_sha,
            commands: preparedFirstPass.commands,
            executor: {
              id: `executor:${execution_id}`,
              harness: exec.executor_harness ?? exec.model_provenance?.harness ?? executor.provider,
              model: executor.model,
            },
            validator: {
              id: `first-pass-validator:${execution_id}`,
              harness: "first-pass-validator",
              model: preparedFirstPass.contract.environment.validator_version,
            },
            holdout_state: preparedFirstPass.holdout_state,
            decided_at: now(),
            runtime_root: process.env.FIRST_PASS_VALIDATOR_RUNTIME_ROOT
              ?? "/home/workspace/.runtime/first-pass-validators",
          });
          firstPassErrors.push(...runtime.shadow.errors);
          if (!runtime.cleanup_ok) firstPassErrors.push("validator worktree cleanup failed");
          if (runtime.shadow.verdict && runtime.cleanup_ok) {
            try {
              writeHoldoutState(preparedFirstPass.holdout_path, runtime.shadow.holdout_state);
              const row = appendFirstPassLedger(factoryStatePath("first-pass-ledger.jsonl"), {
                ticket: d.ticket.identifier,
                verdict: runtime.shadow.verdict,
                cycle_number: 0,
                prior_cycle: null,
                stratum: {
                  archetype: exec.archetype?.line ?? parseContractFields(d.ticket.description || "").archetype ?? "unrecorded",
                  repository: exec.repo_path ?? executionWorkdir,
                  harness: exec.executor_harness ?? exec.model_provenance?.harness ?? executor.provider,
                  validator_version: preparedFirstPass.contract.environment.validator_version,
                },
                recorded_at: runtime.shadow.verdict.decided_at,
              });
              firstPassVerdict = runtime.shadow.verdict;
              firstPassRecordId = row.row.record_id;
            } catch (error) {
              firstPassErrors.push(error instanceof Error ? error.message : String(error));
            }
          }
        }
      }
      if (preparedFirstPass || firstPassErrors.length > 0) {
        exec.first_pass_validation = {
          mode: "shadow",
          contract_path: preparedFirstPass?.contract_path ?? null,
          contract_digest: preparedFirstPass?.contract.contract_digest ?? null,
          ledger_record_id: firstPassRecordId,
          verdict: firstPassVerdict?.verdict ?? null,
          validator_version: preparedFirstPass?.contract.environment.validator_version ?? "first-pass-validator-v1",
          errors: [...new Set(firstPassErrors)],
        };
        saveExecution(exec);
        recordFlight({
          execution_id,
          identifier: d.ticket.identifier,
          kind: firstPassVerdict ? `first-pass.${firstPassVerdict.verdict}` : "first-pass.held",
          detail: firstPassErrors.join("; ") || firstPassVerdict?.verdict,
          data: {
            contract_digest: preparedFirstPass?.contract.contract_digest ?? null,
            ledger_record_id: firstPassRecordId,
            enforcement_active: false,
          },
        });
      }
      let diversityPreparation: Awaited<ReturnType<typeof prepareFactoryDiversityReview>> = null;
      let diversityPreflightError: string | null = null;
      try {
        diversityPreparation = await prepareFactoryDiversityReview({
          execution_id,
          ticket_id: d.ticket.linear_id,
          identifier: d.ticket.identifier,
          title: d.ticket.title,
          description: d.ticket.description ?? "",
          seed_path: exec.seed_path,
          risk_tier: riskTier,
          target_repository: executionWorkdirForTicket(d.ticket),
          implementer_model_name: exec.model_provenance?.resolvedModel
            ?? exec.model_used
            ?? d.author_identity?.model
            ?? "factory:inline",
          implementer_vendor: exec.model_provenance?.servingProvider ?? d.author_identity?.provider,
        });
      } catch (error) {
        diversityPreflightError = error instanceof Error ? error.message : String(error);
      }
      const diversityDeps = diversityPreparation || diversityPreflightError
        ? {
            persona_review: async (deterministic: { pass: boolean; summary: string }) => diversityPreparation
              ? diversityPreparation.run({
                  implementation_summary: exec.result_summary ?? "",
                  deterministic_pass: deterministic.pass,
                  deterministic_summary: deterministic.summary,
                })
              : failedFactoryDiversityReview(diversityPreflightError ?? "unknown preflight failure"),
          }
        : {};
      const review = await runFactoryReviewGate({
        execution_id,
        identifier: d.ticket.identifier,
        implementation_summary: exec.result_summary ?? "",
        ticket_context: d.ticket.description ?? "",
        workdir: executionWorkdirForTicket(d.ticket),
        policy: executionPolicy,
        risk_tier: riskTier,
        // Historical passed records remain acceptable migration evidence, but
        // this path never creates a new model-consensus record.
        prior_verification: {
          kind: "consensus",
          status: exec.consensus?.status ?? "absent",
          reference: exec.consensus?.gate_id ?? null,
        },
        first_pass_validation: firstPassVerdict,
        first_pass_required: false,
      }, diversityDeps);
      outcomeReview = review;
      if (diversityPreparation) {
        exec.persona_participation = [
          ...(exec.persona_participation ?? []).filter(
            (record) => record.task_id !== diversityPreparation!.record.task_id,
          ),
          diversityPreparation.record,
        ];
      }
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: review.advance_to_verified
          ? "factory-review.verified"
          : review.blocking
            ? "factory-review.blocked"
            : "factory-review.recorded",
        detail: review.persona_reviews?.summary ?? review.deterministic.summary,
        data: {
          mode: review.mode,
          review_level: review.review_level,
          review_strategy: review.review_strategy,
          terminal_state: review.diversity_terminal_state,
          dissent_count: review.dissent_count,
          source: diversityPreparation?.source ?? "none",
          pass: review.pass,
        },
      });
      if (review.blocking) {
        transitionExecution(exec, "held", "diversity-review", `review:${execution_id}`, {
          review_strategy: review.review_strategy,
          terminal_state: review.diversity_terminal_state,
          dissent_count: review.dissent_count,
        });
        exec.stage = "diversity-review-held";
        exec.status = "held";
        exec.error = review.persona_reviews?.summary ?? review.substantiation;
        saveHold({
          execution_id,
          tier: "high",
          held_at: now(),
          notified: "none",
          released_by: null,
          released_at: null,
          reason: "diversity_of_thought_review",
        });
        saveExecution(exec);
        await requestDiversityReview(
          exec,
          {
            linear_id: d.ticket.linear_id,
            identifier: d.ticket.identifier,
            description: d.ticket.description ?? "",
          },
          {
            terminal_state: review.diversity_terminal_state,
            dissent_count: review.dissent_count,
            summary: exec.error,
          },
        );
        recordFlight({
          execution_id,
          identifier: d.ticket.identifier,
          kind: "manual-review.requested",
          detail: "diversity-of-thought hold routed to operator review",
          data: { review_strategy: review.review_strategy, dissent_count: review.dissent_count },
        });
      } else if (review.advance_to_verified) {
        transitionExecution(exec, "verified", "factory-review", `review:${execution_id}`, {
          review_level: review.review_level,
          review_strategy: review.review_strategy,
          dissent_count: review.dissent_count,
        });
        saveExecution(exec);
      } else if (diversityPreparation) {
        saveExecution(exec);
      }
    }

    if (normalizeExecutionLifecycle(exec).state === "verified" && d.product_gate) {
      let launch: ProductLaunchResult;
      try {
        launch = runProductLaunchGate(d.ticket, d.product_gate, execution_id);
      } catch (error) {
        launch = productLaunchFailureResult(d.product_gate, error, now());
      }
      exec.product_gate = { preflight: d.product_gate, launch };
      console.log(`[product-gate] ${d.ticket.identifier}: ${productGateSummary(launch)}`);
      recordFlight({
        execution_id,
        identifier: d.ticket.identifier,
        kind: launch.acted ? "product-gate.held" : launch.decision === "hold" ? "product-gate.would-hold" : "product-gate.passed",
        detail: productGateSummary(launch),
        data: {
          verdict: launch.verdict,
          report_path: launch.report_path,
          report_sha256: launch.report_sha256,
          context_sha256: launch.context_sha256,
        },
      });
      if (launch.acted) {
        transitionExecution(exec, "held", "product-lifecycle-gate", `product-gate:${execution_id}`, {
          reason_code: launch.reason_code,
          verdict: launch.verdict,
        });
        exec.stage = "product-gate-held";
        exec.status = "held";
        exec.error = `production readiness blocked: ${launch.audit_error ?? launch.verdict ?? launch.reason_code}`;
      }
      saveExecution(exec);
    }

    const blockingEvidence = manifestMode === "blocking";
    const traceVerification = artifactCheck("FACTORY_TRACE_EVIDENCE", execution_id, blockingEvidence);
    const featureContract = artifactCheck("FACTORY_FEATURE_EVIDENCE", execution_id, blockingEvidence);
    const reviewEvidence = artifactCheck("FACTORY_REVIEW_EVIDENCE", execution_id, blockingEvidence);
    const testEvidence = artifactCheck("FACTORY_TEST_EVIDENCE", execution_id, blockingEvidence);
    const author = d.author_identity ?? { provider: "unknown", model: "unknown" };
    const reviewers = independentReviewers(author, parseReviewerCandidates(process.env.FACTORY_REVIEWERS));
    const commitBinding = resolveExactCommitDigest({ repoPath: exec.repo_path, branchName: exec.branch_name });
    if (commitBinding.ok === true) exec.commit_digest = commitBinding.commit_digest;
    else recordFlight({
      execution_id,
      identifier: d.ticket.identifier,
      kind: "outcome-evidence.commit-unavailable",
      detail: commitBinding.error,
    });
    const manifest = createEvidenceManifest({
      schema_version: 1,
      ticket: d.ticket.identifier,
      execution_id,
      ...(commitBinding.ok ? { commit_digest: commitBinding.commit_digest } : {}),
      seed_hash: exec.seed_path && existsSync(exec.seed_path) ? hashSeedFile(exec.seed_path) : null,
      author,
      executor: executorIdentity(exec),
      reviewers,
      review_evidence: reviewEvidence,
      tests: testEvidence.evidence,
      test_evidence: testEvidence,
      artifacts: [
        ...supplyChain.evidence,
        ...traceVerification.evidence,
        ...featureContract.evidence,
        ...reviewEvidence.evidence,
        ...productGateArtifact(exec.product_gate?.launch),
      ],
      trace_verification: traceVerification,
      feature_contract: featureContract,
      supply_chain: supplyChain,
      verdict: hasProvenDeliveryState(normalizeExecutionLifecycle(exec), "verified") ? "pass" : exec.status === "failed" ? "fail" : "pending",
      rollout_mode: manifestMode,
      override: null,
      generated_at: now(),
      ...(exec.persona_participation ? { persona_participation: exec.persona_participation } : {}),
    });
    const evidenceManifestPath = writeEvidenceManifest(manifest);
    const blockers = promotionBlockers(manifest);
    exec.evidence_manifest = { path: evidenceManifestPath, hash: manifest.content_hash, mode: manifestMode, blockers };
    if (blockers.length > 0 && normalizeExecutionLifecycle(exec).state === "implementation_complete") {
      transitionExecution(exec, "held", "evidence-manifest", `manifest:${manifest.content_hash}`, { blockers });
      exec.stage = "evidence-blocked";
      exec.status = "held";
      exec.error = `post-flight evidence blocked promotion: ${blockers.join("; ")}`;
      recordFlight({ execution_id, identifier: d.ticket.identifier, kind: "evidence.blocked", detail: exec.error, data: { hash: manifest.content_hash } });
      sf006Checkpoint(exec, "evidence-blocked");
    } else {
      recordFlight({ execution_id, identifier: d.ticket.identifier, kind: "evidence.persisted", data: { hash: manifest.content_hash, path: evidenceManifestPath } });
      if (hasProvenDeliveryState(normalizeExecutionLifecycle(exec), "verified")) {
        const outcomeBinding = outcomeReview?.outcome_verifier && commitBinding.ok
          ? {
              outcome_verifier: outcomeReview.outcome_verifier,
              commit_digest: commitBinding.commit_digest,
              evidence_digest: manifest.content_hash,
            }
          : {};
        writeVerdict(execution_id, {
          ticket: d.ticket.identifier,
          execution_id,
          verdict: "pass",
          rework: false,
          evidence: `factory evidence manifest ${manifest.content_hash}`,
          decided_at: outcomeReview?.reviewed_at ?? now(),
          evidence_mode: manifestMode,
          evidence_manifest_path: evidenceManifestPath,
          evidence_manifest_hash: manifest.content_hash,
          ...outcomeBinding,
        }, { force: true });
      }
    }
    saveExecution(exec);

    // SF-006: executor completion proves implementation only. Verification,
    // PR, CI, merge, deployment, and acceptance are written by their concrete
    // callers and never inferred from a successful executor response.
    const execLifecycle = normalizeExecutionLifecycle(exec);
    if (execLifecycle.state === "failed") {
      const failureDecision = recordFailureCycle({
        ticket_identifier: d.ticket.identifier,
        failing_stage: "dispatch",
        error_class: retryableExecutorError(exec.error ?? "") ? "transport" : "executor",
        error_signature: exec.error ?? "unknown executor failure",
        cycle_id: exec.execution_id,
      }, { state_dir: STATE_DIR });
      exec.retry_eligible = Boolean(exec.retry_eligible) && failureDecision.should_dispatch;
      if (failureDecision.should_park) {
        exec.result_summary = `parked after ${failureDecision.record.consecutive_failures} equivalent failures; fingerprint ${failureDecision.fingerprint.digest.slice(0, 12)}`;
        saveHold({
          execution_id: exec.execution_id,
          tier: "high",
          held_at: failureDecision.record.parked_at ?? now(),
          notified: "none",
          released_by: null,
          released_at: null,
          reason: "failure_streak",
          failure_fingerprint: failureDecision.fingerprint.digest,
        });
      }
      saveExecution(exec);
      recordFlight({
        execution_id: exec.execution_id,
        identifier: d.ticket.identifier,
        kind: failureDecision.should_park ? "exec.failure-parked" : "exec.failure-retryable",
        data: { fingerprint: failureDecision.fingerprint.digest, strike: failureDecision.record.consecutive_failures },
      });
    } else if (["implementation_complete", "verified"].includes(execLifecycle.state) && loadFailureStreak(d.ticket.identifier, STATE_DIR)) {
      recordFailureSuccess(d.ticket.identifier, exec.execution_id, { state_dir: STATE_DIR });
    }
    if (execLifecycle.state === "implementation_complete" || execLifecycle.state === "verified") {
      sf006Checkpoint(exec, "execute");
      // Preserve the independently governed SF-010 promotion gate.
      if (execLifecycle.state === "verified") await runSf010PromotionGate(exec, d.ticket, verdict ?? null, sf011);
      if (exec.pr_number !== null) sf006Checkpoint(exec, "pr");
    }

    executions.push(exec);
    inFlight--;
  }

  // Summary
  const implementationComplete = executions.filter((e) =>
    hasReachedDeliveryTarget(normalizeExecutionLifecycle(e).state, "implementation_complete")
  ).length;
  const pending = executions.filter((e) => normalizeExecutionLifecycle(e).state === "executing").length;
  const summary = {
    total: executions.length,
    complete: implementationComplete,
    pending,
    implementation_complete: implementationComplete,
    target_reached: executions.filter((e) => normalizeExecutionLifecycle(e).target_reached).length,
    failed: executions.filter((e) => normalizeExecutionLifecycle(e).state === "failed").length,
    dry_run: executions.filter((e) => normalizeExecutionLifecycle(e).state === "dry_run").length,
    in_flight: executions.filter((e) => ["executing", "pool_enqueued"].includes(normalizeExecutionLifecycle(e).state)).length,
  };
  console.log(`[exec] Summary: ${JSON.stringify(summary)}`);

  process.stdout.write(JSON.stringify(executions, null, 2) + "\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
