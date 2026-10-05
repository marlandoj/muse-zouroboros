#!/usr/bin/env bun
import { resolveFactoryStateOverride } from "./factory-state-root";

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecutionPolicy } from "./model-policy";
import type { PersonaReviewGateResult } from "./persona-orchestrator";
import type { OutcomeActor } from "./outcome-envelope";
import { verdictCanAdvance, type ValidatorVerdict } from "./validator-authority";

export type FactoryReviewMode = "shadow" | "enforce";

export interface ReviewCheckResult {
  pass: boolean;
  summary: string;
}

export interface ConsensusReviewResult extends ReviewCheckResult {
  consensus_id: string | null;
  confidence: number | null;
}

/**
 * Historical or operator verification recorded before this gate ran.
 *
 * The deterministic review is `git diff --check` — a whitespace and
 * conflict-marker check, not a judgement about whether the code is correct. It
 * is not substantive implementation evidence. Promotion review intentionally
 * occurs later, after PR-bound held-out and rollback evidence is complete.
 */
export interface PriorVerification {
  kind: "consensus" | "operator";
  status: string;
  reference: string | null;
}

export interface FactoryReviewInput {
  execution_id: string;
  identifier: string;
  implementation_summary: string;
  ticket_context: string;
  workdir: string;
  artifact_commit?: string;
  policy: ExecutionPolicy | null;
  risk_tier: string | null;
  state_dir?: string;
  prior_verification?: PriorVerification | null;
  first_pass_validation?: ValidatorVerdict | null;
  first_pass_required?: boolean;
}

export interface FactoryReviewResult {
  version: 1;
  execution_id: string;
  identifier: string;
  mode: FactoryReviewMode;
  review_level: "deterministic" | "diversity";
  review_strategy: "deterministic" | "diversity-of-thought";
  deterministic: ReviewCheckResult;
  consensus: ConsensusReviewResult | null;
  diversity_terminal_state: "pass" | "pass_with_dissent" | "hold" | "shadow" | "no_review";
  dissent_count: number;
  pass: boolean;
  blocking: boolean;
  substantiated: boolean;
  substantiation: string;
  advance_to_verified: boolean;
  reviewed_at: string;
  artifact_commit?: string;
  outcome_verifier: OutcomeActor | null;
  first_pass_validation: ValidatorVerdict | null;
  persona_reviews?: PersonaReviewGateResult;
}

export interface FactoryReviewDeps {
  deterministic?: (input: FactoryReviewInput) => Promise<ReviewCheckResult> | ReviewCheckResult;
  /** @deprecated Factory review no longer invokes model-based consensus. */
  consensus?: (input: FactoryReviewInput) => Promise<ConsensusReviewResult>;
  now?: () => string;
  mode?: FactoryReviewMode;
  write_result?: boolean;
  /** @deprecated Retained for source compatibility; model review authorization is ignored. */
  model_review_authorized?: boolean;
  persona_review?: (deterministic: ReviewCheckResult) => Promise<PersonaReviewGateResult>;
}

export function resolveReviewMode(env: Record<string, string | undefined> = process.env): FactoryReviewMode {
  const mode = env.FACTORY_REVIEW_GATE_MODE ?? "shadow";
  if (mode !== "shadow" && mode !== "enforce") throw new Error(`FACTORY_REVIEW_GATE_MODE must be shadow|enforce, got ${mode}`);
  return mode;
}

export function requiresDiversityReview(
  policy: ExecutionPolicy | null,
  riskTier: string | null,
): boolean {
  return policy?.review_level === "consensus" || riskTier?.toLowerCase() === "high";
}

function enforcePersonaEvidenceComplete(result: PersonaReviewGateResult): boolean {
  if (result.mode !== "enforce" || result.required_count === 0) return true;
  const required = result.reviews.filter((review) => review.required);
  return result.invoked_count >= result.required_count
    && required.length === result.required_count
    && required.every((review) => review.status === "invoked"
      && review.verdict === "pass"
      && review.distinct_model === true
      && review.vendor_diverse === true);
}

export function reviewArtifact(input: FactoryReviewInput): string {
  return [
    `Ticket: ${input.identifier}`,
    `Execution: ${input.execution_id}`,
    `Risk: ${input.risk_tier ?? "unknown"}`,
    `Policy: ${input.policy?.tier ?? "default"}/${input.policy?.review_level ?? "deterministic"}`,
    `Artifact commit: ${input.artifact_commit ?? "unbound"}`,
    "",
    "Ticket context:",
    input.ticket_context.slice(0, 20_000),
    "",
    "Implementation evidence:",
    input.implementation_summary.slice(0, 40_000),
    "",
    `First-pass validation: ${input.first_pass_validation?.verdict ?? "absent"}`,
    `First-pass contract: ${input.first_pass_validation?.validation_contract_digest ?? "absent"}`,
  ].join("\n");
}

export function defaultDeterministicReview(input: FactoryReviewInput): ReviewCheckResult {
  // Scope to the workdir subtree and skip submodules: recursing the meta-repo's
  // submodules while an executor is concurrently committing caused transient
  // `git ETIMEDOUT` (ZOU-619). 120s cap leaves margin for that lock/stat
  // contention; steady-state this check is sub-second.
  const check = spawnSync("git", ["diff", "--check", "--ignore-submodules=all", "--", "."], {
    cwd: input.workdir,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (check.error) return { pass: false, summary: check.error.message };
  return {
    pass: check.status === 0,
    summary: check.status === 0 ? "git diff --check passed" : (check.stderr || check.stdout || "git diff --check failed").trim(),
  };
}

/** Decide whether implementation review is substantive enough to prepare a PR. */
export function substantiate(
  _consensus: ConsensusReviewResult | null,
  prior: PriorVerification | null,
  personaReviews: PersonaReviewGateResult | null = null,
): { substantiated: boolean; reason: string } {
  if (personaReviews?.mode === "enforce"
    && personaReviews.required_count > 0
    && personaReviews.pass
    && enforcePersonaEvidenceComplete(personaReviews)) {
    return { substantiated: true, reason: `${personaReviews.required_count} required persona review(s) passed after deterministic review` };
  }
  if (prior?.kind === "operator" && prior.status === "passed") {
    return {
      substantiated: false,
      reason: `operator approval by ${prior.reference ?? "unknown"} does not replace substantive implementation review`,
    };
  }
  if (prior?.kind === "consensus" && prior.status === "passed") {
    return { substantiated: false, reason: "legacy Model Consensus does not confer implementation or promotion credit" };
  }
  return {
    substantiated: false,
    reason: prior
      ? `prior verification is ${prior.status}; substantive persona diversity review is still required`
      : "required pre-promotion persona diversity review is absent or did not pass",
  };
}

function writeResult(path: string, result: FactoryReviewResult): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temp, path);
}

export async function runFactoryReviewGate(
  input: FactoryReviewInput,
  deps: FactoryReviewDeps = {},
): Promise<FactoryReviewResult> {
  const mode = deps.mode ?? resolveReviewMode();
  const deterministic = await (deps.deterministic ?? defaultDeterministicReview)(input);
  const personaReviews = deps.persona_review ? await deps.persona_review(deterministic) : null;
  const diversityRequired = requiresDiversityReview(input.policy, input.risk_tier);
  const reviewLevel = deps.persona_review || diversityRequired ? "diversity" : "deterministic";
  const consensus: ConsensusReviewResult | null = null;
  const personaPass = personaReviews?.mode !== "enforce"
    || (personaReviews.pass && enforcePersonaEvidenceComplete(personaReviews));
  const requiredDiversityMissing = diversityRequired
    && (!personaReviews || personaReviews.required_count === 0 || !enforcePersonaEvidenceComplete(personaReviews));
  const firstPassRequired = input.first_pass_required === true;
  const firstPassReady = verdictCanAdvance(input.first_pass_validation);
  const requiredFirstPassMissing = firstPassRequired && !firstPassReady;
  const pass = deterministic.pass
    && personaPass
    && !(mode === "enforce" && requiredDiversityMissing)
    && !(mode === "enforce" && requiredFirstPassMissing);
  const substantiation = substantiate(consensus, input.prior_verification ?? null, personaReviews);
  const dissentCount = personaReviews?.reviews.filter((review) => review.verdict === "fail").length ?? 0;
  const diversityTerminalState = personaReviews?.mode === "shadow"
      ? "shadow"
    : !personaReviews || personaReviews.reviews.length === 0
      ? "no_review"
      : !personaPass
        ? "hold"
        : dissentCount > 0
          ? "pass_with_dissent"
          : "pass";
  const result: FactoryReviewResult = {
    version: 1,
    execution_id: input.execution_id,
    identifier: input.identifier,
    mode,
    review_level: reviewLevel,
    review_strategy: reviewLevel === "diversity" ? "diversity-of-thought" : "deterministic",
    deterministic,
    consensus,
    diversity_terminal_state: diversityTerminalState,
    dissent_count: dissentCount,
    pass,
    blocking: (mode === "enforce" && !pass) || (personaReviews?.mode === "enforce" && !personaPass),
    substantiated: substantiation.substantiated,
    substantiation: substantiation.reason,
    // Enforce may promote an implementation to `verified`, which is what makes
    // it shippable. Requiring substantive verification here is the difference
    // between "the diff is clean" and "something actually reviewed this".
    advance_to_verified: mode === "enforce" && pass && substantiation.substantiated && !requiredFirstPassMissing,
    reviewed_at: (deps.now ?? (() => new Date().toISOString()))(),
    ...(input.artifact_commit ? { artifact_commit: input.artifact_commit } : {}),
    outcome_verifier: pass && substantiation.substantiated
      ? {
          id: `factory-review-gate:${input.execution_id}`,
          harness: "factory-review-gate",
          model: input.prior_verification?.kind === "operator"
            ? "operator-attested/deterministic-review-v1"
            : personaReviews
              ? "persona-attested/deterministic-review-v1"
              : "evidence-attested/deterministic-review-v1",
        }
      : null,
    first_pass_validation: input.first_pass_validation ?? null,
    ...(personaReviews ? { persona_reviews: personaReviews } : {}),
  };
  if (deps.write_result !== false) {
    const stateDir = resolveFactoryStateOverride(input.state_dir);
    writeResult(join(stateDir, `review-${input.execution_id}.json`), result);
  }
  return result;
}

export function loadFactoryReview(path: string): FactoryReviewResult {
  return JSON.parse(readFileSync(path, "utf8")) as FactoryReviewResult;
}
