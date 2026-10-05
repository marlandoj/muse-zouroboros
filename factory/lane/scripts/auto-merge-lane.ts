#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-010 T0 — Evidence-Gated Auto-Merge Lane (L4 → L5 crossing)
 *
 * The core engine. After post-flight eval passes, the operator-opt-in
 * auto-merge lane runs the following blocking gates in order:
 *
 *   1. FLAG CHECK — SF010_AUTOMERGE must be "1". If off, returns "disabled".
 *   2. CIRCUIT BREAKER — if state/sf010-circuit-open.sentinel exists, refuses.
 *   3. ARCHETYPE ALLOWLIST — archetype must be on the allowlist.
 *   4. BASELINE CHECK — SF-002 agreement baseline ≥ 20 resolved decisions.
 *   5. SLO GATE — SF-005 yield_floor must not be in unreviewed breach.
 *   6. SCENARIO GATE — run each scenario spec 3× in SF-009; require ≥90% pass.
 *   7. SNAKE PIT — red-team adversarial cases; require 0 critical failures.
 *   8. OPERATOR APPROVAL — a short-lived signed receipt binds the exact PR head.
 *   9. PROMOTION EVIDENCE — complete held-out and rollback evidence is frozen.
 *  10. REVIEW ATTESTATION — Claude Code plus Codex CLI, or a signed human-for-Claude
 *      substitution plus Codex CLI, approved the exact implementation commit and evidence.
 *  11. CONSTITUTION — the authenticated persona evidence and held-out gates
 *      satisfy the constitutional promotion contract.
 *
 * If all gates pass: writes immutable intent, calls FnMerger (real: gh pr merge
 * --squash), writes immutable completion, spawns the canary watcher, and returns
 * "merged". A completion-write failure records merged_unreconciled and requires
 * operator reconciliation without falsely reporting a completed workflow.
 *
 * If any gate fails: writes an operator-queue record, returns "operator".
 *
 * Advisory posture (SF010_AUTOMERGE=0, the default):
 *  - The gate still EVALUATES all checks and logs the would-be decision.
 *  - The audit record is written with merge_result.method="dry-run".
 *  - Nothing is merged. This lets operators build the 20-decision baseline
 *    without ever risking an unintended merge.
 *
 * All injectable — no real gh/git/SLO calls in tests.
 *
 * CLI (requires SF010_AUTOMERGE=1 for live merge; 0 = advisory only):
 *   bun auto-merge-lane.ts evaluate --pr <ref> --archetype <type> \
 *     [--ticket <ZOU-N — the ticket the attestation certifies; defaults to the PR ref>] \
 *     [--attestation <persona-promotion-attestation.json>] [--repo-dir <git-checkout>] \
 *     [--merge-repo <owner/repo>] \
 *     [--authority-config <FACTORY_STATE_DIR/promotion-authority.json>] \
 *     [--scenario <spec.yaml>...] [--diff <file>] [--json]
 *   bun auto-merge-lane.ts status [--json]
 *
 * Live-mode wiring: --attestation/--repo-dir feed Gates 6, 10, and 11 (without them the
 * lane fails closed to the operator queue); with SF010_AUTOMERGE=1 the merger
 * is the real `gh pr merge --squash` against --merge-repo (default
 * marlandoj/zouroboros) and a detached canary watcher (auto-rollback.ts watch)
 * is spawned after a confirmed merge.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { agreementStats, calibrationGate, readLedger, type CalibrationGateResult } from "./approval-ledger";
import {
  checkArchetypeAllowlist,
  getAllowedArchetypes,
} from "./archetype-allowlist";
import { checkCircuit } from "./auto-rollback";
import {
  certificationLaneBlockDecision,
  defaultSloSources,
  laneBlockDecision,
  readSloStateFile,
  type SloState,
} from "./factory-slo";
import {
  type AutoMergeAudit,
  type MergeResult,
  writeAuditRecord,
  writeMergeCompletionRecord,
  writeMergeIntentRecord,
  reconcileMergeAttempt,
  type MergeReconciliationResult,
} from "./merge-audit-trail";
import type { RiskVerdict } from "./risk-classifier";
import type { ScenarioRunRecord } from "./scenario-run";
import { runScenario, scenarioSpecSha256 } from "./scenario-run";
import { catalogManifestSha256, scenariosForArchetype } from "./scenario-catalog";
import { runSnakePit, type SnakePitReport } from "./snake-pit";
import {
  validateCertificationValidationEvidence,
  type CertificationValidationEvidenceBinding,
} from "./promotion-execution-context";
import {
  DEFAULT_PERSONA_REVIEW_KEY_PATH,
  runPersonaPromotionReview,
  verifyPersonaPromotionAttestation,
} from "../../../Skills/zouroboros-governance/scripts/persona-promotion-review";
import {
  resolveUniqueRepositoryRemote,
  verifyProviderNativePromotionAttestation,
} from "../../../Skills/zouroboros-governance/scripts/provider-native-promotion-attestation";
import { issueProviderNativePromotionAttestation } from "../../../Skills/zouroboros-governance/scripts/provider-native-promotion-issuer";
import {
  DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
  verifyEvidenceGenerationApproval,
  verifyOperatorPromotionApproval,
  type EvidenceGenerationApproval,
  type OperatorPromotionApproval,
  type PullRequestBinding,
} from "../../../Skills/zouroboros-governance/scripts/operator-promotion-approval";
import {
  evaluateConstitution,
  type ConstitutionInput,
} from "../../../Skills/zouroboros-governance/scripts/constitution-gate";
import {
  loadPromotionAuthorityConfig,
  promotionCertificationAttemptStore,
  type ConsumedAuthorizationReceipt,
  type PromotionAuthorityConfig,
} from "../../../Skills/zouroboros-governance/scripts/promotion-authorization-ledger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AutoMergeLaneConfig {
  /** Minimum scenario pass rate (default 0.9 = 90%). */
  min_scenario_pass_rate: number;
  /** Number of runs per scenario spec (default 3). */
  scenario_runs: number;
  /** Minimum resolved SF-002 decisions before the auto-lane can act (default 20). */
  min_baseline_decisions: number;
}

export const DEFAULT_LANE_CONFIG: AutoMergeLaneConfig = {
  min_scenario_pass_rate: 0.9,
  scenario_runs: 3,
  min_baseline_decisions: 20,
};

export function resolvePromotionAuthorityConfig(
  explicitPath?: string,
  testOnlyPromotionAuthority?: PromotionAuthorityConfig,
): PromotionAuthorityConfig {
  if (explicitPath && testOnlyPromotionAuthority) {
    throw new Error("explicit and test-only promotion authority selections are mutually exclusive");
  }
  if (testOnlyPromotionAuthority) {
    if (process.env.FACTORY_STATE_MODE !== "test") {
      throw new Error("test-only promotion authority injection is prohibited outside FACTORY_STATE_MODE=test");
    }
    return testOnlyPromotionAuthority;
  }
  if (!explicitPath) return loadPromotionAuthorityConfig();
  const expectedPath = factoryStatePath("promotion-authority.json");
  const selectedPath = resolveFactoryStateOverride(explicitPath, "promotion-authority.json");
  if (selectedPath !== expectedPath || selectedPath !== join(factoryStateRoot(), "promotion-authority.json")) {
    throw new Error("explicit promotion authority must equal FACTORY_STATE_DIR/promotion-authority.json");
  }
  return loadPromotionAuthorityConfig(selectedPath);
}

export interface LaneGateResult {
  gate: string;
  passed: boolean;
  reason: string;
}

export type AutoMergeDecision = "merged" | "certified" | "operator" | "disabled" | "advisory";

export interface AutoMergeLaneResult {
  decision: AutoMergeDecision;
  pr_ref: string;
  archetype: string;
  gates: LaneGateResult[];
  reason: string;
  audit_path?: string;
  intent_path?: string;
  completion_path?: string;
  evidence_path?: string;
  audit_error?: string;
  external_effect?: "none" | "certification" | "unknown" | "merged_unreconciled" | "merged";
  merge_result?: MergeResult;
  merge_ts?: string;
  canary?: { started: boolean; reason: string; pid?: number; log?: string };
  authorization?: ConsumedAuthorizationReceipt;
  advisory_only: boolean;
}

/** Injectable merger — real: gh pr merge --squash --auto */
export type FnMerger = (prRef: string, expectedHeadSha: string) => Promise<MergeResult>;

/** Injectable scenario runner — real: runScenario(specPath) */
export type FnScenarioRunner = (specPath: string) => Promise<ScenarioRunRecord>;

export interface PullRequestSnapshot extends PullRequestBinding {
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  statusChecks: Array<{ name: string; status: string; conclusion: string | null }>;
}

export type FnPullRequestResolver = (prRef: string, repository: string) => PullRequestSnapshot;
export type FnDraftReadyTransition = (target: PullRequestSnapshot) => PullRequestSnapshot;

export interface SelectionBarrierResult {
  passed: boolean;
  reason: string;
  repository: string;
  baseRef: string;
  requiredStatusContexts: string[];
  strictHeadFreshness: boolean;
  requiredApprovingReviewCount: number | null;
  dismissStaleReviews: boolean;
  enforceAdmins: boolean;
  forcePushesProhibited: boolean;
  deletionsProhibited: boolean;
}

export type FnSelectionBarrierResolver = (repository: string, baseRef: string) => SelectionBarrierResult;

export interface SelectionBarrierProtection {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  };
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    dismiss_stale_reviews?: boolean;
  };
  enforce_admins?: { enabled?: boolean };
  allow_force_pushes?: { enabled?: boolean };
  allow_deletions?: { enabled?: boolean };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function operatorQueuePath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "operator-queue.jsonl");
}

function appendOperatorQueue(entry: object, base = PROJECT_DIR): void {
  const path = operatorQueuePath(base);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableSha256(value: unknown): string {
  const serialized = JSON.stringify(value, (key, current) => ["ts", "duration_ms", "generated_at", "created_at", "started_at", "completed_at"].includes(key) ? undefined : current);
  return sha256(serialized ?? "undefined");
}

function normalizeRepository(value: string): string {
  return value.trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "$1/")
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function normalizePullRequestStatusCheck(check: Record<string, unknown>): {
  name: string;
  status: string;
  conclusion: string | null;
} {
  const name = String(check.name ?? check.context ?? check.workflowName ?? "unknown");
  if (typeof check.status === "string") {
    return {
      name,
      status: check.status.toUpperCase(),
      conclusion: typeof check.conclusion === "string" ? check.conclusion.toUpperCase() : null,
    };
  }
  const state = typeof check.state === "string" ? check.state.toUpperCase() : "UNKNOWN";
  if (state === "SUCCESS") return { name, status: "COMPLETED", conclusion: "SUCCESS" };
  if (state === "FAILURE" || state === "ERROR") return { name, status: "COMPLETED", conclusion: state };
  if (state === "PENDING" || state === "EXPECTED") return { name, status: "IN_PROGRESS", conclusion: null };
  return { name, status: "UNKNOWN", conclusion: null };
}

function statusChecksSatisfyBarrier(
  statusChecks: PullRequestSnapshot["statusChecks"],
  requiredContexts: readonly string[] = [],
): boolean {
  if (statusChecks.length === 0) return false;
  const successful = statusChecks.every((check) => String(check.status ?? "UNKNOWN").toUpperCase() === "COMPLETED"
    && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes((check.conclusion ?? "").toUpperCase()));
  if (!successful) return false;
  const observedContexts = new Set(statusChecks.map((check) => check.name));
  return requiredContexts.every((context) => observedContexts.has(context));
}

function failedSelectionBarrier(repository: string, baseRef: string, reason: string): SelectionBarrierResult {
  return {
    passed: false,
    reason,
    repository: normalizeRepository(repository),
    baseRef,
    requiredStatusContexts: [],
    strictHeadFreshness: false,
    requiredApprovingReviewCount: null,
    dismissStaleReviews: false,
    enforceAdmins: false,
    forcePushesProhibited: false,
    deletionsProhibited: false,
  };
}

function defaultPullRequestResolver(prRef: string, repository: string): PullRequestSnapshot {
  const result = spawnSync("gh", [
    "pr", "view", prRef, "--repo", repository,
    "--json", "number,headRefOid,baseRefName,headRefName,isDraft,state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup",
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim() ?? `gh pr view exited ${result.status}`);
  }
  const value = JSON.parse(result.stdout) as {
    number?: number;
    headRefOid?: string;
    baseRefName?: string;
    headRefName?: string;
    isDraft?: boolean;
    state?: string;
    mergeable?: string;
    mergeStateStatus?: string;
    reviewDecision?: string;
    statusCheckRollup?: Array<Record<string, unknown>>;
  };
  return {
    repository: normalizeRepository(repository),
    number: Number(value.number),
    headSha: String(value.headRefOid ?? ""),
    baseRef: String(value.baseRefName ?? ""),
    headRef: String(value.headRefName ?? ""),
    isDraft: value.isDraft === true,
    state: String(value.state ?? "UNKNOWN"),
    mergeable: String(value.mergeable ?? "UNKNOWN"),
    mergeStateStatus: String(value.mergeStateStatus ?? "UNKNOWN"),
    reviewDecision: String(value.reviewDecision ?? "UNKNOWN"),
    statusChecks: (value.statusCheckRollup ?? []).map(normalizePullRequestStatusCheck),
  };
}

function defaultDraftReadyTransition(target: PullRequestSnapshot): PullRequestSnapshot {
  const ready = spawnSync("gh", ["pr", "ready", String(target.number), "--repo", target.repository], { encoding: "utf8" });
  if (ready.error || ready.status !== 0) throw new Error(ready.error?.message ?? ready.stderr.trim() ?? `gh pr ready exited ${ready.status}`);
  return defaultPullRequestResolver(String(target.number), target.repository);
}

export function evaluateSelectionBarrierProtection(
  protection: SelectionBarrierProtection,
  repository: string,
  baseRef: string,
): SelectionBarrierResult {
  const requiredContexts = new Set([
    ...(protection.required_status_checks?.contexts ?? []),
    ...(protection.required_status_checks?.checks ?? []).map((check) => check.context ?? ""),
  ].filter(Boolean));
  const missingContexts = ["governance-docs", "build-and-test"].filter((name) => !requiredContexts.has(name));
  const reviewSettings = protection.required_pull_request_reviews;
  const approvalCount = reviewSettings?.required_approving_review_count;
  const strictHeadFreshness = protection.required_status_checks?.strict === true;
  const dismissStaleReviews = reviewSettings?.dismiss_stale_reviews === true;
  const enforceAdmins = protection.enforce_admins?.enabled === true;
  const forcePushesProhibited = protection.allow_force_pushes?.enabled === false;
  const deletionsProhibited = protection.allow_deletions?.enabled === false;
  const failures: string[] = [];
  if (!strictHeadFreshness) failures.push("strict head freshness is not enforced");
  if (missingContexts.length > 0) failures.push(`required checks are missing: ${missingContexts.join(", ")}`);
  if (!reviewSettings) failures.push("pull-request review settings are unavailable");
  if (!Number.isInteger(approvalCount) || Number(approvalCount) < 0) failures.push("required approving review count is invalid");
  if (!dismissStaleReviews) failures.push("stale reviews are not dismissed");
  if (!enforceAdmins) failures.push("administrator enforcement is disabled");
  if (!forcePushesProhibited) failures.push("force pushes are not prohibited");
  if (!deletionsProhibited) failures.push("branch deletion is not prohibited");
  return {
    passed: failures.length === 0,
    reason: failures.length === 0
      ? `GitHub selection barrier protects ${normalizeRepository(repository)}:${baseRef} with strict required checks, request-scoped operator approval, and ${approvalCount} configured GitHub approval(s)`
      : `GitHub selection barrier is incomplete: ${failures.join("; ")}`,
    repository: normalizeRepository(repository),
    baseRef,
    requiredStatusContexts: [...requiredContexts].sort(),
    strictHeadFreshness,
    requiredApprovingReviewCount: Number.isInteger(approvalCount) ? Number(approvalCount) : null,
    dismissStaleReviews,
    enforceAdmins,
    forcePushesProhibited,
    deletionsProhibited,
  };
}

function defaultSelectionBarrierResolver(repository: string, baseRef: string): SelectionBarrierResult {
  const branch = spawnSync("gh", [
    "api",
    `repos/${normalizeRepository(repository)}/branches/${encodeURIComponent(baseRef)}`,
  ], { encoding: "utf8" });
  if (branch.error || branch.status !== 0) {
    return failedSelectionBarrier(
      repository,
      baseRef,
      branch.error?.message ?? branch.stderr.trim() ?? `GitHub branch query exited ${branch.status}`,
    );
  }
  try {
    const state = JSON.parse(branch.stdout) as { protected?: boolean };
    if (state.protected !== true) return failedSelectionBarrier(repository, baseRef, `GitHub reports ${normalizeRepository(repository)}:${baseRef} protected=false`);
  } catch (error) {
    return failedSelectionBarrier(repository, baseRef, `GitHub branch response is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = spawnSync("gh", [
    "api",
    `repos/${normalizeRepository(repository)}/branches/${encodeURIComponent(baseRef)}/protection`,
  ], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return failedSelectionBarrier(
      repository,
      baseRef,
      result.error?.message ?? result.stderr.trim() ?? `GitHub branch-protection query exited ${result.status}`,
    );
  }
  try {
    const protection = JSON.parse(result.stdout) as SelectionBarrierProtection;
    return evaluateSelectionBarrierProtection(protection, repository, baseRef);
  } catch (error) {
    return failedSelectionBarrier(repository, baseRef, `GitHub branch-protection response is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writePromotionEvidence(input: {
  base: string;
  ticket: string;
  target: PullRequestSnapshot;
  diff: string;
  gates: LaneGateResult[];
  scenarios: ScenarioRunRecord[];
  snakePit: SnakePitReport;
  rollbackEvidencePath: string;
  promotionAuthority: PromotionAuthorityConfig;
  selectionBarrier?: SelectionBarrierResult;
  certificationValidation?: CertificationValidationEvidenceBinding;
  operatorApproval?: { path: string; sha256: string; approval: OperatorPromotionApproval };
  stage?: "promotion_complete" | "draft_evidence_only";
  generationAuthorization?: { approval: EvidenceGenerationApproval; approval_sha256: string };
}): string {
  if (!existsSync(input.rollbackEvidencePath)) throw new Error(`rollback evidence is unavailable: ${input.rollbackEvidencePath}`);
  const generatedAt = new Date();
  const expiresAt = promotionEvidenceExpiry(generatedAt, input.certificationValidation?.evidence.expiresAt);
  const rollbackSha256 = sha256(readFileSync(input.rollbackEvidencePath));
  const implementationDiffSha256 = sha256(input.diff);
  const sourceDigests: Record<string, string> = {
    implementation_diff_sha256: implementationDiffSha256,
    gates_sha256: stableSha256(input.gates),
    scenarios_sha256: stableSha256(input.scenarios),
    snake_pit_sha256: stableSha256(input.snakePit),
    ...(input.certificationValidation ? {
      certification_validation_evidence_sha256: input.certificationValidation.sha256,
    } : {}),
  };
  const stage = input.stage ?? "promotion_complete";
  if (stage === "draft_evidence_only" && !input.generationAuthorization) {
    throw new Error("draft evidence requires a signed evidence-generation authorization");
  }
  if (stage === "promotion_complete" && input.generationAuthorization) {
    throw new Error("promotion evidence may not embed an evidence-generation authorization");
  }
  if (stage === "promotion_complete" && !input.selectionBarrier?.passed) {
    throw new Error("promotion evidence requires a passing structured selection barrier");
  }
  if (stage === "promotion_complete" && !input.operatorApproval) {
    throw new Error("promotion evidence requires the verified operator approval");
  }
  if (input.selectionBarrier) {
    sourceDigests.selection_barrier_sha256 = stableSha256(input.selectionBarrier);
  }
  if (input.operatorApproval) {
    sourceDigests.operator_approval_sha256 = input.operatorApproval.sha256;
  }
  const payload = {
    schema_version: 3,
    stage,
    issuer: "zouroboros-software-factory:auto-merge-lane",
    generated_at: generatedAt.toISOString(),
    expires_at: expiresAt,
    ticket: input.ticket,
    target: input.target,
    implementation_diff_sha256: implementationDiffSha256,
    source_digests: sourceDigests,
    rollback_evidence: {
      path: input.rollbackEvidencePath,
      sha256: rollbackSha256,
    },
    ...(input.selectionBarrier ? { selection_barrier: input.selectionBarrier } : {}),
    ...(input.certificationValidation ? {
      certification_validation_evidence: {
        path: input.certificationValidation.path,
        sha256: input.certificationValidation.sha256,
        ...input.certificationValidation.evidence,
      },
      predecessor_provenance: input.certificationValidation.evidence.predecessorProvenance,
      finding_closures: input.certificationValidation.evidence.findingClosures,
    } : {}),
    ...(input.operatorApproval ? { operator_approval: input.operatorApproval } : {}),
    gates: input.gates,
    scenarios: input.scenarios,
    snake_pit: input.snakePit,
    required_persona_attestation: {
      schema_version: input.promotionAuthority.requiredPersonaAttestationSchemaVersion,
      transport: input.promotionAuthority.requiredPersonaAttestationSchemaVersion === 3 ? "provider-native" : "zo-api",
      provider_contract_sha256: input.promotionAuthority.providerContractSha256,
    },
    ...(input.generationAuthorization ? { generation_authorization: input.generationAuthorization } : {}),
  };
  const directory = factoryStatePathForProject(input.base, "promotion-evidence");
  mkdirSync(directory, { recursive: true });
  const prefix = `${input.ticket.replace(/[^a-z0-9_-]/gi, "-")}-${input.target.headSha}-`;
  for (const file of readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort().reverse()) {
    const candidate = join(directory, file);
    try {
      const existing = JSON.parse(readFileSync(candidate, "utf8")) as typeof payload;
      const reusable = existing.schema_version === payload.schema_version
        && existing.stage === payload.stage
        && existing.issuer === payload.issuer
        && existing.ticket === payload.ticket
        && normalizeRepository(existing.target?.repository ?? "") === normalizeRepository(payload.target.repository)
        && existing.target?.number === payload.target.number
        && existing.target?.headSha === payload.target.headSha
        && existing.target?.baseRef === payload.target.baseRef
        && existing.target?.headRef === payload.target.headRef
        && existing.rollback_evidence?.path === payload.rollback_evidence.path
        && existing.rollback_evidence?.sha256 === payload.rollback_evidence.sha256
        && stableSha256(existing.selection_barrier) === stableSha256(payload.selection_barrier)
        && stableSha256(existing.required_persona_attestation) === stableSha256(payload.required_persona_attestation)
        && stableSha256(existing.source_digests) === stableSha256(payload.source_digests)
        && stableSha256(existing.operator_approval) === stableSha256(payload.operator_approval)
        && stableSha256(existing.predecessor_provenance) === stableSha256(payload.predecessor_provenance)
        && stableSha256(existing.finding_closures) === stableSha256(payload.finding_closures)
        && stableSha256(existing.generation_authorization) === stableSha256(payload.generation_authorization)
        && Date.parse(existing.expires_at) > Date.now();
      if (reusable) return candidate;
    } catch {
      continue;
    }
  }
  const path = join(directory, `${prefix}${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  return path;
}

export function promotionEvidenceExpiry(generatedAt: Date, certificationExpiresAt?: string): string {
  const outerExpiry = generatedAt.getTime() + 2 * 60 * 60_000;
  if (certificationExpiresAt === undefined) return new Date(outerExpiry).toISOString();
  const innerExpiry = Date.parse(certificationExpiresAt);
  if (!Number.isFinite(innerExpiry) || innerExpiry <= generatedAt.getTime()) {
    throw new Error("certification validation evidence is expired or has an invalid expiry");
  }
  return new Date(Math.min(outerExpiry, innerExpiry)).toISOString();
}

// ─── Flag ────────────────────────────────────────────────────────────────────

export function automergeEnabled(): boolean {
  return process.env.SF010_AUTOMERGE === "1";
}

export function certificationEnabled(): boolean {
  return process.env.SF010_CERTIFY === "1";
}

// ─── Scenario gate (3× per spec, ≥90% pass) ──────────────────────────────────

export async function runScenariosGate(
  specPaths: string[],
  runner: FnScenarioRunner,
  config: AutoMergeLaneConfig,
  binding: { evaluatedCommit?: string | null; manifestSha256?: string | null } = {},
): Promise<{ gate: LaneGateResult; records: ScenarioRunRecord[] }> {
  if (specPaths.length === 0) {
    return {
      gate: { gate: "scenario_runner", passed: true, reason: "no scenario specs provided — gate skipped" },
      records: [],
    };
  }

  const records: ScenarioRunRecord[] = [];
  let totalRuns = 0;
  let totalPassed = 0;
  const failures: string[] = [];

  const previousCommit = process.env.SF009_EVALUATED_COMMIT;
  const previousManifest = process.env.SF009_SCENARIO_MANIFEST_SHA256;

  try {
    if (binding.evaluatedCommit) process.env.SF009_EVALUATED_COMMIT = binding.evaluatedCommit;
    else delete process.env.SF009_EVALUATED_COMMIT;
    if (binding.manifestSha256) process.env.SF009_SCENARIO_MANIFEST_SHA256 = binding.manifestSha256;
    else delete process.env.SF009_SCENARIO_MANIFEST_SHA256;

    for (const specPath of specPaths) {
      for (let run = 0; run < config.scenario_runs; run++) {
        try {
          const record = await runner(specPath);
          records.push(record);
          totalRuns++;
          const bindingFailures = [
            ...(binding.evaluatedCommit && record.evaluated_commit !== binding.evaluatedCommit
              ? [`evaluated commit ${record.evaluated_commit ?? "missing"} !== ${binding.evaluatedCommit}`]
              : []),
            ...(binding.manifestSha256 && record.scenario_manifest_sha256 !== binding.manifestSha256
              ? [`manifest ${record.scenario_manifest_sha256 ?? "missing"} !== ${binding.manifestSha256}`]
              : []),
            ...(binding.manifestSha256 && record.scenario_spec_sha256 !== scenarioSpecSha256(specPath)
              ? ["scenario spec hash does not match the committed spec"]
              : []),
          ];
          if (record.verdict === "passed" && bindingFailures.length === 0) {
            totalPassed++;
          } else {
            failures.push(`${specPath} run ${run + 1}: ${[...record.failures, ...bindingFailures].join("; ") || "binding failed"}`);
          }
        } catch (err) {
          totalRuns++;
          failures.push(`${specPath} run ${run + 1}: runner threw ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } finally {
    if (previousCommit === undefined) delete process.env.SF009_EVALUATED_COMMIT;
    else process.env.SF009_EVALUATED_COMMIT = previousCommit;
    if (previousManifest === undefined) delete process.env.SF009_SCENARIO_MANIFEST_SHA256;
    else process.env.SF009_SCENARIO_MANIFEST_SHA256 = previousManifest;
  }

  const passRate = totalRuns > 0 ? totalPassed / totalRuns : 0;
  const passed = passRate >= config.min_scenario_pass_rate;

  return {
    gate: {
      gate: "scenario_runner",
      passed,
      reason: passed
        ? `${totalPassed}/${totalRuns} runs passed (${(passRate * 100).toFixed(1)}% ≥ ${config.min_scenario_pass_rate * 100}%)`
        : `${totalPassed}/${totalRuns} runs passed (${(passRate * 100).toFixed(1)}% < ${config.min_scenario_pass_rate * 100}%); failures: ${failures.slice(0, 3).join(" | ")}`,
    },
    records,
  };
}

// ─── Core lane evaluation (all injectable) ───────────────────────────────────

// ─── Evidence-only lane (blocking, no promotion authority) ────────────────────
//
// Produces one fresh schema-version-3 draft evidence artifact for an exact clean
// draft pull request. Structurally unreachable from this function: draft-to-ready
// transition, Gate 10 persona attestation, Gate 11 Constitution promotion,
// authorization consumption, merge intent, merger, completion audit, legacy merge
// audit, and the canary watcher. The dependency surface admits no merger,
// transition, reconciler, attestation, or audit/intent/completion writer.

export interface EvidenceOnlyLaneResult {
  decision: "evidence" | "operator";
  pr_ref: string;
  archetype: string;
  gates: LaneGateResult[];
  reason: string;
  external_effect: "none";
  advisory_only: false;
  authorization: "absent";
  evidence_path: string | null;
}

export interface EvidenceOnlyLaneDeps {
  base?: string;
  config?: Partial<AutoMergeLaneConfig>;
  mergeRepo?: string;
  repoDir?: string;
  evidenceApprovalPath?: string;
  evidenceApprovalKeyPath?: string;
  rollbackEvidencePath?: string;
  scenarioRunner?: FnScenarioRunner;
  pullRequestResolver?: FnPullRequestResolver;
  testOnlyPromotionAuthority?: PromotionAuthorityConfig;
}

export async function runEvidenceOnlyLane(
  prRef: string,
  archetype: string,
  riskVerdict: RiskVerdict,
  scenarioSpecPaths: string[],
  diff: string,
  deps: EvidenceOnlyLaneDeps = {},
): Promise<EvidenceOnlyLaneResult> {
  const base = deps.base ?? PROJECT_DIR;
  const cfg = { ...DEFAULT_LANE_CONFIG, ...(deps.config ?? {}) };
  const gates: LaneGateResult[] = [];
  const blocked = (reason: string): EvidenceOnlyLaneResult => {
    appendOperatorQueue({
      ts: new Date().toISOString(),
      pr_ref: prRef,
      archetype,
      mode: "evidence_only",
      reason,
      gates,
    }, base);
    return {
      decision: "operator",
      pr_ref: prRef,
      archetype,
      gates,
      reason,
      external_effect: "none",
      advisory_only: false,
      authorization: "absent",
      evidence_path: null,
    };
  };

  const circuit = checkCircuit(base);
  gates.push({
    gate: "circuit_breaker",
    passed: !circuit.tripped,
    reason: circuit.tripped
      ? `circuit open — ${circuit.consecutive} consecutive auto-rollbacks; reset required`
      : `circuit closed (${circuit.consecutive} consecutive rollbacks)`,
  });
  if (circuit.tripped) return blocked(gates[gates.length - 1].reason);

  const allowed = getAllowedArchetypes(factoryStatePathForProject(base, "archetype-allowlist.json"));
  const archetypeDecision = checkArchetypeAllowlist(archetype, allowed);
  gates.push({
    gate: "archetype_allowlist",
    passed: archetypeDecision.allowed,
    reason: archetypeDecision.reason,
  });
  if (!archetypeDecision.allowed) return blocked(archetypeDecision.reason);

  let resolvedDecisions = 0;
  let calib: CalibrationGateResult | null = null;
  const baselineDisabled = cfg.min_baseline_decisions <= 0;
  if (!baselineDisabled) {
    try {
      const ledger = readLedger(factoryStatePathForProject(base, "approval-ledger.jsonl"));
      const stats = agreementStats(ledger);
      resolvedDecisions = stats.resolved;
      calib = calibrationGate(stats.calibration, cfg.min_baseline_decisions);
    } catch { /* read failure = no calibration = blocked */ }
  }
  const countOk = resolvedDecisions >= cfg.min_baseline_decisions;
  const baselinePassed = baselineDisabled || (countOk && calib !== null && calib.eligible);
  gates.push({
    gate: "sf002_baseline",
    passed: baselinePassed,
    reason: baselineDisabled
      ? "baseline gate disabled by config (min_baseline_decisions=0)"
      : baselinePassed
      ? `baseline met: ${resolvedDecisions} resolved decisions`
      : !countOk
        ? `baseline not met: ${resolvedDecisions}/${cfg.min_baseline_decisions} resolved decisions`
        : calib === null
          ? "calibration unavailable (ledger read failure) — fail closed"
          : `calibration gate failed: ${calib.reasons.join("; ")}`,
  });
  if (!baselinePassed) return blocked(gates[gates.length - 1].reason);

  const sloState = readSloStateFile(defaultSloSources().statePath);
  const sloBlock = laneBlockDecision(sloState);
  gates.push({ gate: "slo_yield_floor", passed: !sloBlock.blocked, reason: sloBlock.reason });
  if (sloBlock.blocked) return blocked(sloBlock.reason);

  const mergeRepo = deps.mergeRepo?.trim() ?? "";
  let target: PullRequestSnapshot;
  let actualDiff = "";
  let remoteName = "";
  try {
    if (!mergeRepo) throw new Error("merge repository is required");
    if (!deps.repoDir) throw new Error("repository checkout is required");
    target = (deps.pullRequestResolver ?? defaultPullRequestResolver)(prRef, mergeRepo);
    remoteName = resolveUniqueRepositoryRemote(deps.repoDir, target.repository);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: deps.repoDir, encoding: "utf8" });
    if (head.error || head.status !== 0) throw new Error(head.error?.message ?? head.stderr.trim() ?? "unable to resolve repository HEAD");
    if (head.stdout.trim() !== target.headSha) throw new Error("repository HEAD does not match the actual pull-request head");
    const patch = spawnSync("git", ["diff", "--binary", "--full-index", `${remoteName}/${target.baseRef}...${target.headSha}`], {
      cwd: deps.repoDir,
      encoding: "utf8",
    });
    if (patch.error || patch.status !== 0) throw new Error(patch.error?.message ?? patch.stderr.trim() ?? "unable to compute pull-request diff");
    actualDiff = patch.stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gates.push({ gate: "pull_request_binding", passed: false, reason });
    return blocked(reason);
  }

  const checksTerminalSuccessful = statusChecksSatisfyBarrier(target.statusChecks);
  const certificationReviewBlocked = target.mergeable === "MERGEABLE"
    && target.mergeStateStatus === "BLOCKED"
    && target.reviewDecision === "REVIEW_REQUIRED";
  const cleanDraft = target.state === "OPEN"
    && target.isDraft
    && target.mergeable === "MERGEABLE"
    && (target.mergeStateStatus === "CLEAN" || certificationReviewBlocked)
    && checksTerminalSuccessful;
  gates.push({
    gate: "clean_draft_binding",
    passed: cleanDraft,
    reason: cleanDraft
      ? certificationReviewBlocked
        ? `${target.repository}#${target.number} is an open, conflict-free draft with terminal successful checks, bound to ${target.headSha}; independent GitHub review remains required`
        : `${target.repository}#${target.number} is an open clean draft with terminal successful checks, bound to ${target.headSha} via unique remote '${remoteName}'`
      : `pull request is not an exact clean draft: state=${target.state} draft=${target.isDraft} mergeable=${target.mergeable} merge=${target.mergeStateStatus} review=${target.reviewDecision} terminal_checks=${checksTerminalSuccessful} checks=${target.statusChecks.length}`,
  });
  if (!cleanDraft) return blocked(gates[gates.length - 1].reason);

  const diffCheck = spawnSync("git", ["diff", "--check", `${remoteName}/${target.baseRef}...${target.headSha}`], {
    cwd: deps.repoDir,
    encoding: "utf8",
  });
  const mechanicalPassed = !diffCheck.error && diffCheck.status === 0 && (diff.length === 0 || sha256(diff) === sha256(actualDiff));
  gates.push({
    gate: "mechanical_diff",
    passed: mechanicalPassed,
    reason: diffCheck.error || diffCheck.status !== 0
      ? diffCheck.error?.message ?? diffCheck.stderr.trim() ?? "git diff --check failed"
      : diff.length > 0 && sha256(diff) !== sha256(actualDiff)
        ? "caller-supplied diff does not match the actual pull-request diff"
        : "actual pull-request diff passed git diff --check",
  });
  if (!mechanicalPassed) return blocked(gates[gates.length - 1].reason);

  const productionRunner = deps.scenarioRunner === undefined;
  const runner: FnScenarioRunner = deps.scenarioRunner ?? (async (specPath) => runScenario(specPath));
  const catalogEntries = scenariosForArchetype(archetype);
  const effectiveScenarioPaths = scenarioSpecPaths.length > 0
    ? scenarioSpecPaths
    : catalogEntries.map((entry) => entry.path);
  const manifestEntries = scenarioSpecPaths.length > 0
    ? scenarioSpecPaths.map((path) => ({ id: path, path, coverage: [] as readonly string[] }))
    : catalogEntries;
  const scenarioManifestSha256 = productionRunner && manifestEntries.length > 0
    ? catalogManifestSha256(manifestEntries)
    : null;
  const evaluatedCommit = productionRunner ? target.headSha : null;
  const missingProductionBinding = productionRunner && (
    !evaluatedCommit || !scenarioManifestSha256 || process.env.SF009_SCENARIOS !== "1"
  );
  const { gate: scenGate, records: scenRecords } = await runScenariosGate(
    effectiveScenarioPaths,
    runner,
    cfg,
    { evaluatedCommit, manifestSha256: scenarioManifestSha256 },
  );
  if (missingProductionBinding) {
    scenGate.passed = false;
    scenGate.reason = process.env.SF009_SCENARIOS !== "1"
      ? "scenario gate requires SF009_SCENARIOS=1"
      : !evaluatedCommit
      ? "scenario gate requires a verified implementation commit"
      : "scenario gate requires a non-empty committed scenario catalog";
  }
  gates.push(scenGate);
  if (!scenGate.passed) return blocked(scenGate.reason);

  const pitReport = await runSnakePit(prRef, actualDiff, runner, { seed: riskVerdict.score * 1e6 });
  gates.push({
    gate: "snake_pit",
    passed: pitReport.verdict === "pass",
    reason: pitReport.verdict === "pass"
      ? `snake pit: ${pitReport.cases_passed}/${pitReport.cases_generated} passed, 0 critical failures`
      : `snake pit: ${pitReport.critical_failures.length} critical failure(s): ${pitReport.critical_failures.map((f) => f.description).join("; ")}`,
  });
  if (pitReport.verdict !== "pass") return blocked(gates[gates.length - 1].reason);

  const evidenceApproval = verifyEvidenceGenerationApproval(
    deps.evidenceApprovalPath,
    riskVerdict.identifier,
    target,
    deps.evidenceApprovalKeyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
  );
  gates.push({
    gate: "evidence_generation_approval",
    passed: evidenceApproval.passed,
    reason: evidenceApproval.reason,
  });
  if (!evidenceApproval.passed || !evidenceApproval.approval) return blocked(evidenceApproval.reason);

  let evidencePath: string;
  try {
    if (!deps.rollbackEvidencePath) throw new Error("rollback evidence path is required");
    const promotionAuthority = resolvePromotionAuthorityConfig(undefined, deps.testOnlyPromotionAuthority);
    evidencePath = writePromotionEvidence({
      base,
      ticket: riskVerdict.identifier,
      target,
      diff: actualDiff,
      gates,
      scenarios: scenRecords,
      snakePit: pitReport,
      rollbackEvidencePath: deps.rollbackEvidencePath,
      promotionAuthority,
      stage: "draft_evidence_only",
      generationAuthorization: {
        approval: evidenceApproval.approval,
        approval_sha256: sha256(readFileSync(deps.evidenceApprovalPath as string)),
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gates.push({ gate: "draft_evidence", passed: false, reason });
    return blocked(reason);
  }
  gates.push({
    gate: "draft_evidence",
    passed: true,
    reason: `fresh draft evidence persisted at ${evidencePath}`,
  });

  return {
    decision: "evidence",
    pr_ref: prRef,
    archetype,
    gates,
    reason: `draft evidence generated for ${target.repository}#${target.number} at exact head ${target.headSha}; no external effect, no promotion authority`,
    external_effect: "none",
    advisory_only: false,
    authorization: "absent",
    evidence_path: evidencePath,
  };
}

export async function runAutoMergeLane(
  prRef: string,
  archetype: string,
  riskVerdict: RiskVerdict,
  scenarioSpecPaths: string[],
  diff: string,
  deps: {
    merger?: FnMerger;
    scenarioRunner?: FnScenarioRunner;
    base?: string;
    config?: Partial<AutoMergeLaneConfig>;
    personaAttestationPath?: string;
    personaRepoDir?: string;
    personaKeyPath?: string;
    operatorApprovalPath?: string;
    operatorApprovalKeyPath?: string;
    rollbackEvidencePath?: string;
    certificationValidationEvidencePath?: string;
    authorityConfigPath?: string;
    mergeRepo?: string;
    pullRequestResolver?: FnPullRequestResolver;
    draftReadyTransition?: FnDraftReadyTransition;
    testOnlySelectionBarrier?: FnSelectionBarrierResolver;
    testOnlyPromotionAuthority?: PromotionAuthorityConfig;
    auditWriter?: typeof writeAuditRecord;
    intentWriter?: typeof writeMergeIntentRecord;
    completionWriter?: typeof writeMergeCompletionRecord;
    mergeReconciler?: (attemptId: string, base: string) => MergeReconciliationResult;
    testOnlySloState?: SloState | null | "corrupt";
  } = {},
): Promise<AutoMergeLaneResult> {
  const base = deps.base ?? PROJECT_DIR;
  const cfg = { ...DEFAULT_LANE_CONFIG, ...(deps.config ?? {}) };
  const mergeEnabled = automergeEnabled();
  const certification = certificationEnabled();
  const advisory = !mergeEnabled && !certification;
  const gates: LaneGateResult[] = [];

  // ── Gate 1: Flag check ────────────────────────────────────────────────────
  gates.push({
    gate: "flag_sf010",
    passed: !(mergeEnabled && !certification),
    reason: `SF010_CERTIFY=${certification ? "1" : "0"}; SF010_AUTOMERGE=${mergeEnabled ? "1 — live merge enabled" : "0 — merge disabled"}`,
  });
  if (mergeEnabled && !certification) {
    const reason = "SF010_AUTOMERGE=1 requires SF010_CERTIFY=1; merge-only execution is prohibited before promotion authority loading";
    gates[0] = { gate: "flag_sf010", passed: false, reason };
    return buildOperatorResult(prRef, archetype, gates, reason, advisory, base);
  }

  // ── Gate 2: Circuit breaker ───────────────────────────────────────────────
  const circuit = checkCircuit(base);
  const circuitGate: LaneGateResult = {
    gate: "circuit_breaker",
    passed: !circuit.tripped,
    reason: circuit.tripped
      ? `circuit open — ${circuit.consecutive} consecutive auto-rollbacks; reset required`
      : `circuit closed (${circuit.consecutive} consecutive rollbacks)`,
  };
  gates.push(circuitGate);
  if (circuit.tripped && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, "circuit breaker open", advisory, base);
  }

  // ── Gate 3: Archetype allowlist ───────────────────────────────────────────
  const allowed = getAllowedArchetypes(factoryStatePathForProject(base, "archetype-allowlist.json"));
  const archetypeDecision = checkArchetypeAllowlist(archetype, allowed);
  const archetypeGate: LaneGateResult = {
    gate: "archetype_allowlist",
    passed: archetypeDecision.allowed,
    reason: archetypeDecision.allowed || advisory
      ? archetypeDecision.reason
      : `${archetypeDecision.reason}; awaiting request-scoped approval for the exact pull-request head`,
  };
  gates.push(archetypeGate);

  // ── Gate 4: SF-002 baseline + calibration (ZOU-1110) ──────────────────────
  // Count-only eligibility is forbidden: the deduped ticket+action sample must
  // meet the minimum AND the confusion matrix must show 0 false approvals and a
  // false-hold rate within tolerance. Ledger read failure fails closed.
  let resolvedDecisions = 0;
  let calib: CalibrationGateResult | null = null;
  const baselineDisabled = cfg.min_baseline_decisions <= 0;
  if (!baselineDisabled) {
    try {
      // base-scoped: the lane must read the ledger belonging to the state tree
      // it evaluates (and selftests must never depend on live state).
      const ledger = readLedger(factoryStatePathForProject(base, "approval-ledger.jsonl"));
      const stats = agreementStats(ledger);
      resolvedDecisions = stats.resolved;  // operator-responded only — pending entries don't count
      calib = calibrationGate(stats.calibration, cfg.min_baseline_decisions);
    } catch { /* read failure = no calibration = blocked */ }
  }
  const countOk = resolvedDecisions >= cfg.min_baseline_decisions;
  const baselinePassed = baselineDisabled || (countOk && calib !== null && calib.eligible);
  const baselineGate: LaneGateResult = {
    gate: "sf002_baseline",
    passed: baselinePassed,
    reason: baselineDisabled
      ? "baseline gate disabled by config (min_baseline_decisions=0)"
      : baselinePassed && calib
      ? `baseline met: ${resolvedDecisions} resolved rows, ${calib.matrix.deduped_decisions} calibrated ticket+action decisions ≥ ${cfg.min_baseline_decisions}, 0 false approvals, false-hold ${calib.matrix.false_hold_rate !== null ? (calib.matrix.false_hold_rate * 100).toFixed(1) + "%" : "n/a"} within tolerance`
      : !countOk
        ? `baseline not met: ${resolvedDecisions}/${cfg.min_baseline_decisions} resolved decisions — build the baseline before enabling auto-merge`
        : calib === null
          ? "calibration unavailable (ledger read failure) — fail closed"
          : `calibration gate failed: ${calib.reasons.join("; ")}`,
  };
  gates.push(baselineGate);
  if (!baselineGate.passed && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, baselineGate.reason, advisory, base);
  }

  // ── Gate 5: SF-005 SLO ────────────────────────────────────────────────────
  const sloSrc = defaultSloSources();
  if (deps.testOnlySloState !== undefined && process.env.FACTORY_STATE_MODE !== "test") {
    return buildOperatorResult(prRef, archetype, gates, "test-only SLO state is disabled outside FACTORY_STATE_MODE=test", advisory, base);
  }
  const sloState = deps.testOnlySloState !== undefined ? deps.testOnlySloState : readSloStateFile(sloSrc.statePath);
  const sloBlock = certification || mergeEnabled
    ? certificationLaneBlockDecision(sloState)
    : laneBlockDecision(sloState);
  const sloGate: LaneGateResult = {
    gate: "slo_yield_floor",
    passed: !sloBlock.blocked,
    reason: sloBlock.reason,
  };
  gates.push(sloGate);
  if (sloBlock.blocked && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, sloBlock.reason, advisory, base);
  }

  const mergeRepo = deps.mergeRepo?.trim() ?? "";
  let target: PullRequestSnapshot;
  let actualDiff = "";
  try {
    if (!mergeRepo) throw new Error("merge repository is required");
    if (!deps.personaRepoDir) throw new Error("promotion repository checkout is required");
    target = (deps.pullRequestResolver ?? defaultPullRequestResolver)(prRef, mergeRepo);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: deps.personaRepoDir, encoding: "utf8" });
    if (head.error || head.status !== 0) throw new Error(head.error?.message ?? head.stderr.trim() ?? "unable to resolve repository HEAD");
    if (head.stdout.trim() !== target.headSha) throw new Error("repository HEAD does not match the actual pull-request head");
    const patch = spawnSync("git", ["diff", "--binary", "--full-index", `origin/${target.baseRef}...${target.headSha}`], {
      cwd: deps.personaRepoDir,
      encoding: "utf8",
    });
    if (patch.error || patch.status !== 0) throw new Error(patch.error?.message ?? patch.stderr.trim() ?? "unable to compute pull-request diff");
    actualDiff = patch.stdout;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gates.push({ gate: "pull_request_binding", passed: false, reason });
    return buildOperatorResult(prRef, archetype, gates, reason, advisory, base);
  }
  if (target.isDraft && !advisory) {
    const draftApproval = verifyOperatorPromotionApproval(
      deps.operatorApprovalPath,
      riskVerdict.identifier,
      target,
      deps.operatorApprovalKeyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
    );
    if (!draftApproval.passed || !deps.draftReadyTransition) {
      const reason = !draftApproval.passed ? draftApproval.reason : "authorized draft-to-ready transition is unavailable";
      gates.push({ gate: "draft_to_ready", passed: false, reason });
      return buildOperatorResult(prRef, archetype, gates, reason, advisory, base);
    }
    const priorHead = target.headSha;
    target = deps.draftReadyTransition(target);
    const transitionPassed = !target.isDraft && target.state === "OPEN" && target.headSha === priorHead;
    const reason = transitionPassed ? "request-scoped operator approval transitioned the exact PR head to ready" : "draft-to-ready transition changed or failed to ready the approved PR head";
    gates.push({ gate: "draft_to_ready", passed: transitionPassed, reason });
    if (!transitionPassed) return buildOperatorResult(prRef, archetype, gates, reason, advisory, base);
  }
  let selection: SelectionBarrierResult;
  if (deps.testOnlySelectionBarrier && process.env.FACTORY_STATE_MODE !== "test") {
    const reason = "test-only selection-barrier injection is prohibited outside FACTORY_STATE_MODE=test";
    gates.push({ gate: "github_selection_barrier", passed: false, reason });
    return buildOperatorResult(prRef, archetype, gates, reason, advisory, base);
  }
  try {
    selection = (deps.testOnlySelectionBarrier ?? defaultSelectionBarrierResolver)(target.repository, target.baseRef);
  } catch (error) {
    selection = failedSelectionBarrier(
      target.repository,
      target.baseRef,
      error instanceof Error ? error.message : String(error),
    );
  }
  gates.push({ gate: "github_selection_barrier", passed: selection.passed, reason: selection.reason });
  if (!selection.passed) {
    return buildOperatorResult(prRef, archetype, gates, selection.reason, advisory, base);
  }

  const checksPassed = statusChecksSatisfyBarrier(target.statusChecks, selection.requiredStatusContexts);
  const mergeReady = target.mergeable === "MERGEABLE"
    && target.mergeStateStatus === "CLEAN"
    && target.reviewDecision === "APPROVED";
  const protectedZeroApprovalReady = selection.requiredApprovingReviewCount === 0
    && target.mergeable === "MERGEABLE"
    && target.mergeStateStatus === "CLEAN"
    && (target.reviewDecision === "" || target.reviewDecision === "UNKNOWN");
  const certificationReviewBlocked = certification
    && !mergeEnabled
    && target.mergeable === "MERGEABLE"
    && target.mergeStateStatus === "BLOCKED"
    && target.reviewDecision === "REVIEW_REQUIRED";
  const pullRequestPassed = target.state === "OPEN"
    && !target.isDraft
    && (mergeReady || certificationReviewBlocked || protectedZeroApprovalReady)
    && checksPassed;
  const pullRequestGate: LaneGateResult = {
    gate: "pull_request_binding",
    passed: pullRequestPassed,
    reason: pullRequestPassed
      ? certificationReviewBlocked
        ? `${target.repository}#${target.number} is certification-ready and bound to ${target.headSha}; independent GitHub review remains required and merge authority is disabled`
        : protectedZeroApprovalReady
          ? `${target.repository}#${target.number} is certification-ready under the protected zero-approval single-owner policy and bound to ${target.headSha}; ${mergeEnabled ? "provider certification and all promotion gates remain required before merge" : "merge authority is disabled"}`
          : `${target.repository}#${target.number} is open, CI-green, review-approved, mergeable, and bound to ${target.headSha}`
      : `pull request is not promotion-ready: state=${target.state} draft=${target.isDraft} mergeable=${target.mergeable} merge=${target.mergeStateStatus} review=${target.reviewDecision} required_contexts=${selection.requiredStatusContexts.join(",")} terminal_checks=${checksPassed} checks=${target.statusChecks.length}`,
  };
  gates.push(pullRequestGate);
  if (!pullRequestPassed) return buildOperatorResult(prRef, archetype, gates, pullRequestGate.reason, advisory, base);

  const diffCheck = spawnSync("git", ["diff", "--check", `origin/${target.baseRef}...${target.headSha}`], {
    cwd: deps.personaRepoDir,
    encoding: "utf8",
  });
  const mechanicalGate: LaneGateResult = {
    gate: "mechanical_diff",
    passed: !diffCheck.error && diffCheck.status === 0 && (diff.length === 0 || sha256(diff) === sha256(actualDiff)),
    reason: diffCheck.error || diffCheck.status !== 0
      ? diffCheck.error?.message ?? diffCheck.stderr.trim() ?? "git diff --check failed"
      : diff.length > 0 && sha256(diff) !== sha256(actualDiff)
        ? "caller-supplied diff does not match the actual pull-request diff"
        : "actual pull-request diff passed git diff --check",
  };
  gates.push(mechanicalGate);
  if (!mechanicalGate.passed) return buildOperatorResult(prRef, archetype, gates, mechanicalGate.reason, advisory, base);

  // ── Gate 6: Scenario runner (3× per spec, ≥90%) ──────────────────────────
  const productionRunner = deps.scenarioRunner === undefined;
  const runner: FnScenarioRunner = deps.scenarioRunner ?? (async (specPath) => runScenario(specPath));
  const catalogEntries = scenariosForArchetype(archetype);
  const effectiveScenarioPaths = scenarioSpecPaths.length > 0
    ? scenarioSpecPaths
    : catalogEntries.map((entry) => entry.path);
  const manifestEntries = scenarioSpecPaths.length > 0
    ? scenarioSpecPaths.map((path) => ({ id: path, path, coverage: [] as readonly string[] }))
    : catalogEntries;
  const scenarioManifestSha256 = productionRunner && manifestEntries.length > 0
    ? catalogManifestSha256(manifestEntries)
    : null;
  const evaluatedCommit = productionRunner ? target.headSha : null;
  const missingProductionBinding = productionRunner && !advisory && (
    !evaluatedCommit || !scenarioManifestSha256 || process.env.SF009_SCENARIOS !== "1"
  );
  const { gate: scenGate, records: scenRecords } = await runScenariosGate(
    effectiveScenarioPaths,
    runner,
    cfg,
    { evaluatedCommit, manifestSha256: scenarioManifestSha256 },
  );
  if (missingProductionBinding) {
    scenGate.passed = false;
    scenGate.reason = process.env.SF009_SCENARIOS !== "1"
      ? "scenario gate requires SF009_SCENARIOS=1"
      : !evaluatedCommit
      ? "scenario gate requires a verified persona-reviewed implementation commit"
      : "scenario gate requires a non-empty committed scenario catalog";
  }
  gates.push(scenGate);
  if (!scenGate.passed && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, scenGate.reason, advisory, base);
  }

  // ── Gate 7: Snake Pit ─────────────────────────────────────────────────────
  const pitReport = await runSnakePit(prRef, actualDiff, runner, { seed: riskVerdict.score * 1e6 });
  const pitGate: LaneGateResult = {
    gate: "snake_pit",
    passed: pitReport.verdict === "pass",
    reason: pitReport.verdict === "pass"
      ? `snake pit: ${pitReport.cases_passed}/${pitReport.cases_generated} passed, 0 critical failures`
      : `snake pit: ${pitReport.critical_failures.length} critical failure(s): ${pitReport.critical_failures.map((f) => f.description).join("; ")}`,
  };
  gates.push(pitGate);
  if (pitReport.verdict !== "pass" && !advisory) {
    return buildOperatorResult(prRef, archetype, gates, pitGate.reason, advisory, base, {
      snake_pit: pitReport,
      slo: sloState,
      scenarios: scenRecords,
    });
  }

  // ── Gate 8: request-scoped operator approval ───────────────────────────────
  const operatorApproval = verifyOperatorPromotionApproval(
    deps.operatorApprovalPath,
    riskVerdict.identifier,
    target,
    deps.operatorApprovalKeyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
  );
  const operatorApprovalGate: LaneGateResult = {
    gate: "operator_approval",
    passed: operatorApproval.passed,
    reason: operatorApproval.reason,
  };
  gates.push(operatorApprovalGate);
  if (!operatorApproval.passed) {
    return buildOperatorResult(prRef, archetype, gates, operatorApproval.reason, advisory, base, {
      snake_pit: pitReport,
      slo: sloState,
      scenarios: scenRecords,
    });
  }
  if (!archetypeDecision.allowed) {
    archetypeGate.passed = true;
    archetypeGate.reason = `request-scoped operator approval authorizes archetype '${archetypeDecision.archetype}' for the exact pull-request head without changing the global allowlist`;
  }

  // ── Gate 9: complete promotion evidence ────────────────────────────────────
  let promotionEvidencePath: string;
  let promotionAuthority: PromotionAuthorityConfig;
  try {
    if (!deps.rollbackEvidencePath) throw new Error("rollback evidence path is required");
    if (deps.authorityConfigPath && !(certification || mergeEnabled)) {
      throw new Error("explicit promotion authority is valid only for certification-capable execution");
    }
    promotionAuthority = resolvePromotionAuthorityConfig(
      deps.authorityConfigPath,
      deps.testOnlyPromotionAuthority,
    );
    let certificationValidation: CertificationValidationEvidenceBinding | undefined;
    if (certification || mergeEnabled) {
      if (!deps.certificationValidationEvidencePath) {
        throw new Error("certification validation evidence path is required before Gate 9");
      }
      if (!deps.personaRepoDir) {
        throw new Error("certification validation requires the exact repository checkout before Gate 9");
      }
      certificationValidation = validateCertificationValidationEvidence(
        deps.certificationValidationEvidencePath,
        {
          repository: target.repository,
          repoDir: deps.personaRepoDir,
          pullRequest: target.number,
          baseRef: target.baseRef,
          headRef: target.headRef,
          headSha: target.headSha,
        },
        undefined,
        { requireV2: true },
      );
    }
    if (!operatorApproval.approval || !deps.operatorApprovalPath) {
      throw new Error("verified operator approval is unavailable before Gate 9");
    }
    promotionEvidencePath = writePromotionEvidence({
      base,
      ticket: riskVerdict.identifier,
      target,
      diff: actualDiff,
      gates,
      scenarios: scenRecords,
      snakePit: pitReport,
      rollbackEvidencePath: deps.rollbackEvidencePath,
      promotionAuthority,
      selectionBarrier: selection,
      certificationValidation,
      operatorApproval: {
        path: deps.operatorApprovalPath,
        sha256: sha256(readFileSync(deps.operatorApprovalPath)),
        approval: operatorApproval.approval,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gates.push({ gate: "promotion_evidence", passed: false, reason });
    return buildOperatorResult(prRef, archetype, gates, reason, advisory, base, {
      snake_pit: pitReport,
      slo: sloState,
      scenarios: scenRecords,
    });
  }
  gates.push({
    gate: "promotion_evidence",
    passed: true,
    reason: `complete promotion evidence persisted before persona review at ${promotionEvidencePath}`,
  });

  if (certification) {
    if (!deps.personaAttestationPath || !deps.personaRepoDir || !deps.operatorApprovalPath) {
      const reason = "SF010_CERTIFY requires an attestation output path, repository checkout, and exact operator approval";
      gates.push({ gate: "persona_attestation_issuance", passed: false, reason });
      return { ...buildOperatorResult(prRef, archetype, gates, reason, advisory, base), decision: "operator", evidence_path: promotionEvidencePath };
    }
    try {
      if (promotionAuthority.requiredPersonaAttestationSchemaVersion === 3) {
        await issueProviderNativePromotionAttestation({
          ticket: riskVerdict.identifier,
          repoDir: deps.personaRepoDir,
          evidencePath: promotionEvidencePath,
          outputPath: deps.personaAttestationPath,
          target,
          operatorApprovalPath: deps.operatorApprovalPath,
          promotionAuthority,
        });
      } else {
        await runPersonaPromotionReview({
          ticket: riskVerdict.identifier,
          repoDir: deps.personaRepoDir,
          evidencePath: promotionEvidencePath,
          outputPath: deps.personaAttestationPath,
          target,
          keyPath: deps.personaKeyPath ?? promotionAuthority.attestationKeyPath,
          operatorApprovalPath: deps.operatorApprovalPath,
          operatorApprovalKeyPath: deps.operatorApprovalKeyPath ?? promotionAuthority.operatorApprovalKeyPath,
          attemptStore: promotionCertificationAttemptStore(promotionAuthority),
        });
      }
      gates.push({
        gate: "persona_attestation_issuance",
        passed: true,
        reason: `one exact certification attempt produced ${deps.personaAttestationPath}`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      gates.push({ gate: "persona_attestation_issuance", passed: false, reason });
      return { ...buildOperatorResult(prRef, archetype, gates, reason, advisory, base), decision: "operator", evidence_path: promotionEvidencePath };
    }
  }

  // ── Gate 10: mandatory persona attestation ─────────────────────────────────
  const persona = promotionAuthority.requiredPersonaAttestationSchemaVersion === 3
    ? verifyProviderNativePromotionAttestation(deps.personaAttestationPath, {
        ticket: riskVerdict.identifier,
        repoDir: deps.personaRepoDir ?? "",
        evidencePath: promotionEvidencePath,
        evidenceSha256: sha256(readFileSync(promotionEvidencePath)),
        operatorApprovalPath: deps.operatorApprovalPath ?? "",
        target,
        attestationKeyPath: promotionAuthority.attestationKeyPath,
        operatorApprovalKeyPath: promotionAuthority.operatorApprovalKeyPath,
        providerContractPath: promotionAuthority.providerContractPath,
        providerContractSha256: promotionAuthority.providerContractSha256,
      })
    : verifyPersonaPromotionAttestation(
        deps.personaAttestationPath,
        riskVerdict.identifier,
        deps.personaRepoDir,
        target,
        deps.personaKeyPath ?? DEFAULT_PERSONA_REVIEW_KEY_PATH,
        deps.operatorApprovalKeyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
      );
  if (persona.passed && persona.attestation?.evidencePath !== promotionEvidencePath) {
    persona.passed = false;
    persona.reason = "persona attestation does not bind the complete promotion evidence artifact";
  }
  const personaGate: LaneGateResult = {
    gate: "persona_attestation",
    passed: persona.passed,
    reason: persona.reason,
  };
  gates.push(personaGate);
  if (!persona.passed || !persona.attestation) {
    return {
      ...buildOperatorResult(prRef, archetype, gates, persona.reason, advisory, base, {
        snake_pit: pitReport,
        slo: sloState,
        scenarios: scenRecords,
      }),
      decision: certification ? "operator" : (advisory ? "advisory" : "operator"),
      evidence_path: promotionEvidencePath,
    };
  }

  // ── Gate 11: constitutional promotion ──────────────────────────────────────
  const attestation = persona.attestation;
  let targetFiles: string[] = [];
  let targetFilesError: string | null = null;
  try {
    const changed = spawnSync("git", [
      "diff",
      "--name-only",
      `${attestation.baseCommit}..${attestation.implementationCommit}`,
    ], { cwd: deps.personaRepoDir, encoding: "utf8" });
    if (changed.error || changed.status !== 0) {
      targetFilesError = changed.error?.message
        ?? changed.stderr.trim()
        ?? `git diff --name-only exited ${changed.status}`;
    } else {
      targetFiles = changed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    }
  } catch (error) {
    targetFilesError = error instanceof Error ? error.message : String(error);
  }
  const constitutionInput: ConstitutionInput = {
    operation: `factory-promotion:${riskVerdict.identifier}`,
    description: `Promote ${riskVerdict.identifier} after deterministic, held-out, adversarial, and persona verification`,
    targetFiles,
    modifiesModelWeights: false,
    reversible: true,
    rollbackPlan: `Revert the resulting squash merge commit recorded in the completion audit; dry-run evidence: ${deps.rollbackEvidencePath}`,
    blastRadius: "shared",
    humanApproved: operatorApproval.passed,
    provenance: {
      rationale: riskVerdict.reasons.join("; ") || "Factory promotion",
      evidence: [
        deps.personaAttestationPath ?? "",
        promotionEvidencePath,
        deps.operatorApprovalPath ?? "",
        deps.rollbackEvidencePath ?? "",
      ].filter(Boolean),
      actor: "zouroboros-software-factory",
      traceId: riskVerdict.execution_id,
    },
    budgetBounded: cfg.scenario_runs > 0 && effectiveScenarioPaths.length > 0,
    layerIntegrity: true,
    failClosed: true,
    verification: {
      mechanical: mechanicalGate.passed && scenGate.passed && pitGate.passed,
      heldOut: scenGate.passed,
      regressionFree: pitGate.passed,
      ticket: riskVerdict.identifier,
      commitSha: attestation.implementationCommit,
      repoDir: deps.personaRepoDir ?? "",
      evidencePath: promotionEvidencePath,
      evidenceSha256: attestation.evidenceSha256,
      personaAttestationPath: deps.personaAttestationPath ?? "",
      operatorApprovalPath: deps.operatorApprovalPath ?? "",
      target,
      requiredPersonaAttestationSchemaVersion: promotionAuthority.requiredPersonaAttestationSchemaVersion,
    },
  };
  if (certification && !mergeEnabled) {
    return {
      decision: "certified",
      pr_ref: prRef,
      archetype,
      gates,
      reason: "Gate 10 verified the exact newly issued attestation; constitutional promotion authorization and merge remain unconsumed",
      evidence_path: promotionEvidencePath,
      merge_result: { sha: null, method: "dry-run", duration_ms: 0 },
      external_effect: "certification",
      advisory_only: false,
    };
  }
  if (advisory) {
    const gate: LaneGateResult = {
      gate: "constitutional_promotion",
      passed: false,
      reason: "single-use constitutional authorization is not consumed in advisory mode",
    };
    gates.push(gate);
    return {
      decision: "advisory",
      pr_ref: prRef,
      archetype,
      gates,
      reason: gate.reason,
      evidence_path: promotionEvidencePath,
      merge_result: { sha: null, method: "dry-run", duration_ms: 0 },
      external_effect: "none",
      advisory_only: true,
    };
  }
  if (!deps.merger) {
    const gate: LaneGateResult = {
      gate: "constitutional_promotion",
      passed: false,
      reason: "live promotion requires a real merger dependency before consuming authorization",
    };
    gates.push(gate);
    return {
      ...buildOperatorResult(prRef, archetype, gates, gate.reason, advisory, base),
      evidence_path: promotionEvidencePath,
    };
  }
  const constitutional = targetFilesError
    ? null
    : evaluateConstitution(constitutionInput, "promotion", {
          canonicalRoot: deps.personaRepoDir,
          mirrorRoot: deps.personaRepoDir,
          personaReviewKeyPath: deps.personaKeyPath ?? DEFAULT_PERSONA_REVIEW_KEY_PATH,
          operatorApprovalKeyPath: deps.operatorApprovalKeyPath ?? DEFAULT_OPERATOR_APPROVAL_KEY_PATH,
          promotionAuthority,
        });
  const constitutionGate: LaneGateResult = {
    gate: "constitutional_promotion",
    passed: constitutional?.decision === "ALLOW" && constitutional.authorization !== undefined,
    reason: targetFilesError
      ? `constitutional target-file resolution failed: ${targetFilesError}`
      : constitutional?.decision === "ALLOW"
      ? constitutional.authorization
        ? "constitutional promotion gate consumed the exact persona-reviewed authorization"
        : "constitutional promotion gate returned ALLOW without a consumed-authorization receipt"
      : constitutional?.violations.map((item) => `${item.code}: ${item.message}`).join("; ")
        ?? "constitutional promotion gate returned no decision",
  };
  gates.push(constitutionGate);
  if (!constitutionGate.passed) {
    return buildOperatorResult(prRef, archetype, gates, constitutionGate.reason, advisory, base, {
      snake_pit: pitReport,
      slo: sloState,
      scenarios: scenRecords,
    });
  }
  const authorization = constitutional!.authorization!;

  // ── All gates passed — decide action ─────────────────────────────────────
  const allPassed = gates.every((g) => g.passed);
  const ts = new Date().toISOString();
  const dryRunResult: MergeResult = { sha: null, method: "dry-run", duration_ms: 0 };
  const audit = (mergeResult: MergeResult): AutoMergeAudit => ({
    schema_version: 1,
    pr_ref: prRef,
    archetype,
    ts,
    risk_verdict: riskVerdict,
    scenario_results: scenRecords,
    snake_pit_report: pitReport,
    slo_snapshot: sloState === "corrupt" ? null : sloState,
    ...(deps.personaAttestationPath ? {
      persona_attestation: {
        path: deps.personaAttestationPath,
        ticket: attestation.ticket,
        repository_remote: attestation.repositoryRemote,
        base_commit: attestation.baseCommit,
        implementation_commit: attestation.implementationCommit,
        implementation_diff_sha256: attestation.implementationDiffSha256,
        evidence_path: attestation.evidencePath,
        evidence_sha256: attestation.evidenceSha256,
        reviewer_persona_ids: attestation.reviews.map((review) => review.personaId),
      },
    } : {}),
    merge_result: mergeResult,
  });

  if (!allPassed) {
    let auditPath: string | undefined;
    let auditError: string | undefined;
    try {
      auditPath = (deps.auditWriter ?? writeAuditRecord)(audit(dryRunResult), base);
    } catch (error) {
      auditError = error instanceof Error ? error.message : String(error);
    }
    return {
      decision: "advisory",
      pr_ref: prRef,
      archetype,
      gates,
      reason: `advisory mode — all ${gates.length} gates ${allPassed ? "passed" : "had failures"}; no merge executed${auditError ? `; audit persistence failed: ${auditError}` : ""}`,
      audit_path: auditPath,
      evidence_path: promotionEvidencePath,
      authorization,
      ...(auditError ? { audit_error: auditError } : {}),
      merge_result: dryRunResult,
      merge_ts: ts,
      external_effect: "none",
      advisory_only: true,
    };
  }

  const attemptId = `promotion-${riskVerdict.identifier}-${target.number}-${target.headSha.slice(0, 12)}-${operatorApproval.approval?.nonce ?? randomUUID()}`;
  let intentPath: string;
  try {
    intentPath = (deps.intentWriter ?? writeMergeIntentRecord)({
      schema_version: 2,
      kind: "merge_intent",
      attempt_id: attemptId,
      ticket: riskVerdict.identifier,
      target,
      ts,
      evidence_path: promotionEvidencePath,
      evidence_sha256: attestation.evidenceSha256,
      persona_attestation_path: deps.personaAttestationPath ?? "",
      operator_approval_path: deps.operatorApprovalPath ?? "",
      rollback_plan: constitutionInput.rollbackPlan,
      constitutional_decision: "ALLOW",
    }, base);
  } catch (error) {
    const reason = `pre-merge intent persistence failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...buildOperatorResult(prRef, archetype, gates, reason, advisory, base),
      evidence_path: promotionEvidencePath,
      audit_error: reason,
      external_effect: "none",
    };
  }

  const mergeStart = Date.now();
  let mergeResult: MergeResult;
  try {
    mergeResult = await deps.merger(prRef, target.headSha);
    mergeResult.duration_ms = Date.now() - mergeStart;
    if (!mergeResult.sha || !/^[a-f0-9]{40}$/i.test(mergeResult.sha) || mergeResult.method === "error" || mergeResult.method === "dry-run") {
      throw new Error("merger did not return a confirmed merge commit");
    }
  } catch (error) {
    const reason = `merger failed after durable intent: ${error instanceof Error ? error.message : String(error)}`;
    const reconciliation = deps.mergeReconciler
      ? deps.mergeReconciler(attemptId, base)
      : { status: "blocked", attempt_id: attemptId, reason: "reconciliation dependency is unavailable", external_effect: "unknown" } as MergeReconciliationResult;
    if ((reconciliation.status === "reconciled_merged" || reconciliation.status === "completed") && reconciliation.merge_sha) {
      return {
        decision: "merged",
        pr_ref: prRef,
        archetype,
        gates,
        reason: `${reason}; ${reconciliation.reason}`,
        intent_path: intentPath,
        completion_path: reconciliation.completion_path,
        evidence_path: promotionEvidencePath,
        authorization,
        merge_result: { sha: reconciliation.merge_sha, method: "squash", duration_ms: Date.now() - mergeStart },
        merge_ts: ts,
        external_effect: "merged",
        advisory_only: false,
      };
    }
    return {
      ...buildOperatorResult(prRef, archetype, gates, reason, advisory, base),
      intent_path: intentPath,
      evidence_path: promotionEvidencePath,
      authorization,
      merge_result: { sha: null, method: "error", duration_ms: Date.now() - mergeStart, error: `${reason}; ${reconciliation.reason}` },
      external_effect: reconciliation.external_effect === "none" ? "none" : "unknown",
    };
  }

  let completionPath: string;
  try {
    completionPath = (deps.completionWriter ?? writeMergeCompletionRecord)({
      schema_version: 2,
      kind: "merge_completion",
      attempt_id: attemptId,
      ticket: riskVerdict.identifier,
      target,
      intent_path: intentPath,
      ts: new Date().toISOString(),
      merge_result: mergeResult,
    }, base);
  } catch (error) {
    const reason = `merge completed but completion audit persistence failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      ...buildOperatorResult(prRef, archetype, gates, reason, advisory, base),
      intent_path: intentPath,
      evidence_path: promotionEvidencePath,
      authorization,
      audit_error: reason,
      merge_result: mergeResult,
      merge_ts: ts,
      external_effect: "merged_unreconciled",
    };
  }

  let legacyAuditError: string | undefined;
  try {
    (deps.auditWriter ?? writeAuditRecord)(audit(mergeResult), base);
  } catch (error) {
    legacyAuditError = error instanceof Error ? error.message : String(error);
  }
  return {
    decision: "merged",
    pr_ref: prRef,
    archetype,
    gates,
    reason: `all gates passed — PR#${prRef} merged at ${mergeResult.sha}; immutable intent and completion audits persisted`,
    audit_path: completionPath,
    intent_path: intentPath,
    completion_path: completionPath,
    evidence_path: promotionEvidencePath,
    authorization,
    ...(legacyAuditError ? { audit_error: `legacy projection audit failed: ${legacyAuditError}` } : {}),
    merge_result: mergeResult,
    merge_ts: ts,
    external_effect: "merged",
    advisory_only: false,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildOperatorResult(
  prRef: string,
  archetype: string,
  gates: LaneGateResult[],
  reason: string,
  advisory: boolean,
  base: string,
  extras?: { snake_pit?: SnakePitReport; slo?: unknown; scenarios?: ScenarioRunRecord[] },
): AutoMergeLaneResult {
  const entry = {
    pr_ref: prRef,
    archetype,
    ts: new Date().toISOString(),
    reason,
    gates,
    ...extras,
  };
  appendOperatorQueue(entry, base);
  return {
    decision: advisory ? "advisory" : "operator",
    pr_ref: prRef,
    archetype,
    gates,
    reason,
    advisory_only: advisory,
  };
}

const noopPassRunner: FnScenarioRunner = async (_specPath) => ({
  scenario_id: "noop",
  seed: 0,
  verdict: "passed" as const,
  steps_total: 1,
  steps_passed: 1,
  failed_step: null,
  failures: [],
  twin: null,
  twin_requests: 0,
  twin_transcript_sha256: null,
  scenario_spec_sha256: "",
  scenario_manifest_sha256: null,
  evaluated_commit: null,
  duration_ms: 0,
  ts: new Date().toISOString(),
});

/** Injectable gh invocation — real: spawnSync("gh", args). */
export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultGhRunner: GhRunner = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Real merger for live canary runs: gh pr merge --squash, then confirm the
 * merge state and resolve the real squash sha. Any failure throws, which the
 * lane converts into a fail-closed operator-queue routing.
 */
export function realGhMerger(mergeRepo: string, gh: GhRunner = defaultGhRunner): FnMerger {
  return async (prRef, expectedHeadSha) => {
    if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha)) throw new Error("expected pull-request head SHA is invalid");
    const merge = gh(["pr", "merge", prRef, "--squash", "--match-head-commit", expectedHeadSha, "--repo", mergeRepo]);
    if (merge.status !== 0) {
      throw new Error(`gh pr merge failed: ${(merge.stderr || merge.stdout || "unknown error").trim()}`);
    }
    const view = gh(["pr", "view", prRef, "--repo", mergeRepo, "--json", "state,mergeCommit,headRefOid"]);
    if (view.status !== 0) {
      throw new Error(`gh pr view failed after merge: ${(view.stderr || "unknown error").trim()}`);
    }
    const parsed = JSON.parse(view.stdout) as { state?: string; mergeCommit?: { oid?: string } | null; headRefOid?: string };
    const sha = parsed.mergeCommit?.oid ?? null;
    if (parsed.state !== "MERGED" || parsed.headRefOid !== expectedHeadSha || !sha || !/^[a-f0-9]{40}$/i.test(sha)) {
      throw new Error(`merge not confirmed: state=${parsed.state ?? "unknown"} sha=${sha ?? "null"}`);
    }
    return { sha, method: "squash", duration_ms: 0 };
  };
}

export function spawnCanaryWatcher(prRef: string, mergeSha: string, mergeTs: string, base = PROJECT_DIR): { pid: number | undefined; log: string } {
  const canaryDir = factoryStatePathForProject(base, "canary");
  mkdirSync(canaryDir, { recursive: true });
  const log = join(canaryDir, `watch-${prRef.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.log`);
  const out = openSync(log, "a");
  const child = spawn(
    "bun",
    [join(import.meta.dir, "auto-rollback.ts"), "watch", "--pr", prRef, "--sha", mergeSha, "--ts", mergeTs, "--json"],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  return { pid: child.pid, log };
}

export type FnCanaryWatcherSpawner = typeof spawnCanaryWatcher;

export function startCanaryWatcherForResult(
  result: AutoMergeLaneResult,
  base = PROJECT_DIR,
  spawner: FnCanaryWatcherSpawner = spawnCanaryWatcher,
): { started: boolean; reason: string; pid?: number; log?: string } {
  const externallyMerged = result.external_effect === "merged" || result.external_effect === "merged_unreconciled";
  if (result.decision !== "merged" && !externallyMerged) {
    return { started: false, reason: `decision=${result.decision}; watcher not required` };
  }
  const mergeSha = result.merge_result?.sha ?? null;
  const mergeTs = result.merge_ts ?? null;
  if (!mergeSha || !mergeTs) {
    return { started: false, reason: "confirmed merge sha or timestamp missing" };
  }
  const watcher = spawner(result.pr_ref, mergeSha, mergeTs, base);
  return {
    started: true,
    reason: result.external_effect === "merged_unreconciled"
      ? "watcher started for an externally confirmed merge while completion audit awaits operator reconciliation"
      : result.audit_error
      ? `watcher started from confirmed merge result despite audit error: ${result.audit_error}`
      : "watcher started from confirmed merge result",
    ...(watcher.pid !== undefined ? { pid: watcher.pid } : {}),
    log: watcher.log,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      archetype: { type: "string" },
      scenario: { type: "string", multiple: true },
      diff: { type: "string" },
      json: { type: "boolean" },
      attestation: { type: "string" },
      ticket: { type: "string" },
      "repo-dir": { type: "string" },
      "merge-repo": { type: "string" },
      approval: { type: "string" },
      "approval-key": { type: "string" },
      "rollback-evidence": { type: "string" },
      "validation-evidence": { type: "string" },
      "authority-config": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  const [cmd] = positionals;

  if (cmd === "evaluate") {
    const prRef = values.pr;
    const archetype = values.archetype ?? "doc_fix";
    if (!prRef) { console.error("--pr <ref> required"); process.exit(1); }

    const diff = values.diff
      ? readFileSync(String(values.diff), "utf-8")
      : "";

    // --ticket binds Gate 8 to the ticket the attestation certifies; the PR ref
    // is NOT a ticket id, and the attestation verifier rejects the mismatch.
    const ticketIdentifier = values.ticket ? String(values.ticket) : String(prRef);
    const mockVerdict: RiskVerdict = {
      verdict_id: `cli-${Date.now()}`,
      execution_id: "cli",
      ticket_id: ticketIdentifier,
      identifier: ticketIdentifier,
      tier: "low",
      score: 0.1,
      reasons: ["CLI evaluation"],
      inputs: {
        archetype: String(archetype),
        target_repo: "cli",
        repro: "",
        acceptance_criteria: "",
        gate_decision: "DIRECT",
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
    };

    const attestationPath = values.attestation ? String(values.attestation) : undefined;
    const repoDir = values["repo-dir"] ? String(values["repo-dir"]) : PROJECT_DIR;
    const mergeRepo = String(values["merge-repo"] ?? "marlandoj/zouroboros");

    const result = await runAutoMergeLane(
      String(prRef),
      String(archetype),
      mockVerdict,
      (values.scenario as string[] | undefined) ?? [],
      diff,
      {
        personaRepoDir: repoDir,
        mergeRepo,
        ...(attestationPath ? { personaAttestationPath: attestationPath } : {}),
        ...(values.approval ? { operatorApprovalPath: String(values.approval) } : {}),
        ...(values["approval-key"] ? { operatorApprovalKeyPath: String(values["approval-key"]) } : {}),
        ...(values["rollback-evidence"] ? { rollbackEvidencePath: String(values["rollback-evidence"]) } : {}),
        ...(values["validation-evidence"] ? { certificationValidationEvidencePath: String(values["validation-evidence"]) } : {}),
        ...(values["authority-config"] ? { authorityConfigPath: String(values["authority-config"]) } : {}),
        ...(automergeEnabled() ? { merger: realGhMerger(mergeRepo) } : {}),
        ...(automergeEnabled() ? { mergeReconciler: reconcileMergeAttempt } : {}),
        ...(automergeEnabled() ? { draftReadyTransition: defaultDraftReadyTransition } : {}),
      },
    );

    if (result.decision === "merged" || result.external_effect === "merged_unreconciled") {
      let watcher: ReturnType<typeof startCanaryWatcherForResult>;
      try {
        watcher = startCanaryWatcherForResult(result);
      } catch (error) {
        watcher = { started: false, reason: error instanceof Error ? error.message : String(error) };
      }
      result.canary = watcher;
      if (watcher.started) {
        console.error(`canary watcher spawned: pid=${watcher.pid ?? "unknown"} log=${watcher.log}`);
        if (result.audit_error) console.error(`WARNING: ${watcher.reason}`);
      } else {
        const reason = `externally confirmed merge has no canary watcher: ${watcher.reason}`;
        result.decision = "operator";
        result.external_effect = "merged_unreconciled";
        result.audit_error = [result.audit_error, reason].filter(Boolean).join("; ");
        result.reason = `${result.reason}; ${reason}`;
        console.error(`FATAL: ${reason}`);
      }
    }

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nAuto-Merge Lane: ${result.decision.toUpperCase()}`);
      console.log(`PR: ${result.pr_ref}  Archetype: ${result.archetype}`);
      for (const g of result.gates) {
        console.log(`  ${g.passed ? "✓" : "✗"} [${g.gate}] ${g.reason}`);
      }
      console.log(`\nOutcome: ${result.reason}`);
      if (result.audit_path) console.log(`Audit: ${result.audit_path}`);
    }
    process.exit(result.decision === "merged" || result.decision === "certified" || result.decision === "advisory" ? 0 : 1);

  } else if (cmd === "evidence") {
    const prRef = values.pr;
    const archetype = values.archetype ?? "doc_fix";
    if (!prRef) { console.error("--pr <ref> required"); process.exit(1); }
    if (values["validation-evidence"]) {
      console.error("--validation-evidence is valid only for the promotion-capable evaluate command");
      process.exit(1);
    }
    const diff = values.diff ? readFileSync(String(values.diff), "utf-8") : "";
    const ticketIdentifier = values.ticket ? String(values.ticket) : String(prRef);
    const evidenceVerdict: RiskVerdict = {
      verdict_id: `cli-evidence-${Date.now()}`,
      execution_id: "cli",
      ticket_id: ticketIdentifier,
      identifier: ticketIdentifier,
      tier: "low",
      score: 0.1,
      reasons: ["CLI evidence-only evaluation"],
      inputs: {
        archetype: String(archetype),
        target_repo: "cli",
        repro: "",
        acceptance_criteria: "",
        gate_decision: "DIRECT",
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
    };
    const result = await runEvidenceOnlyLane(
      String(prRef),
      String(archetype),
      evidenceVerdict,
      (values.scenario as string[] | undefined) ?? [],
      diff,
      {
        repoDir: values["repo-dir"] ? String(values["repo-dir"]) : PROJECT_DIR,
        mergeRepo: String(values["merge-repo"] ?? "marlandoj/zouroboros"),
        ...(values.approval ? { evidenceApprovalPath: String(values.approval) } : {}),
        ...(values["approval-key"] ? { evidenceApprovalKeyPath: String(values["approval-key"]) } : {}),
        ...(values["rollback-evidence"] ? { rollbackEvidencePath: String(values["rollback-evidence"]) } : {}),
      },
    );
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nEvidence-Only Lane: ${result.decision.toUpperCase()}`);
      console.log(`PR: ${result.pr_ref}  Archetype: ${result.archetype}`);
      for (const g of result.gates) {
        console.log(`  ${g.passed ? "✓" : "✗"} [${g.gate}] ${g.reason}`);
      }
      console.log(`\nOutcome: ${result.reason}`);
      if (result.evidence_path) console.log(`Evidence: ${result.evidence_path}`);
    }
    process.exit(result.decision === "evidence" ? 0 : 1);

  } else if (cmd === "status") {
    const { listAuditRecords } = await import("./merge-audit-trail");
    const { consecutiveRollbacks } = await import("./merge-audit-trail");
    const records = listAuditRecords();
    const circuit = checkCircuit();
    const enabled = automergeEnabled();
    const info = {
      enabled,
      circuit_status: circuit,
      total_auto_merges: records.length,
      total_rollbacks: records.filter((r) => r.rollback).length,
      consecutive_rollbacks: consecutiveRollbacks(),
    };
    if (values.json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`SF010_AUTOMERGE: ${enabled ? "ON" : "OFF"}`);
      console.log(`Circuit: ${circuit.tripped ? "OPEN" : "CLOSED"} (${circuit.consecutive} consecutive rollbacks)`);
      console.log(`Auto-merges: ${info.total_auto_merges} total, ${info.total_rollbacks} rolled back`);
    }
  } else {
    console.log("Usage: bun auto-merge-lane.ts <evaluate|evidence|status> [options]");
    process.exit(0);
  }
}
