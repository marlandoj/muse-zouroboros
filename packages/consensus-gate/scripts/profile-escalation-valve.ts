#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  decideProfileEscalation,
  isConsensusSnapshot,
  isValidRoutingPolicyOptions,
  type ConsensusSnapshot,
  type ProfileTrigger,
} from "./profile-escalation-policy";

export type ProfileValveMode = "shadow" | "enforce";
export type ValveProfile = "fast" | "flagship";

interface DissentClaim {
  claim?: string;
  severity?: "high" | "medium" | "low";
}

export interface ProfileConsensusResult extends ConsensusSnapshot {
  id?: string;
  gate_run_id?: string;
  lineup_profile?: ValveProfile;
  lineup_source?: string;
  panel?: string[];
  panel_fingerprint?: string;
  verdicts?: Array<{
    model?: string;
    pass?: boolean;
    confidence?: number;
    issues?: string[];
    dissent_claims?: DissentClaim[];
  }>;
}

export interface ProfileValveInput {
  code: string;
  criteria: string;
  label: string;
  reviewMode?: "code-review" | "judge";
  mode: ProfileValveMode;
  minConfidence: number;
  author?: string;
  ledgerPath?: string;
  enforceLedgerPath?: string;
  promotionArtifactPath?: string;
  gatePath?: string;
  timeoutMs?: number;
}

export interface ProfileRun {
  profile: ValveProfile;
  ok: boolean;
  result: ProfileConsensusResult | null;
  consensusId: string | null;
  gateRunId: string | null;
  panel: string[];
  panelFingerprint: string | null;
  latencyMs: number;
  error: string | null;
  failureTrigger: "panel_failure" | "malformed" | null;
}

export interface PromotionVerification {
  eligible: boolean;
  blockers: string[];
}

export interface ProfileValveDependencies {
  executeProfile?: (profile: ValveProfile, input: ProfileValveInput) => Promise<unknown>;
  verifyPromotion?: (artifactPath: string, ledgerPath: string) => Promise<PromotionVerification> | PromotionVerification;
  now?: () => Date;
  runId?: () => string;
}

export interface ProfileValveResult {
  valveRunId: string;
  requestedMode: ProfileValveMode;
  effectiveMode: ProfileValveMode;
  decisionSource: ValveProfile;
  decision: ProfileConsensusResult | null;
  trigger: ProfileTrigger;
  escalated: boolean;
  flagshipInvoked: boolean;
  severeMiss: boolean;
  fast: ProfileRun;
  flagship: ProfileRun | null;
  totalLatencyMs: number;
  promotionEligible: boolean;
  promotionBlockers: string[];
  auditError?: string;
}

export interface ProfileEscalationLedgerRow {
  schema_version: 1;
  valve_run_id: string;
  timestamp: string;
  input_sha256: string;
  requested_mode: ProfileValveMode;
  effective_mode: ProfileValveMode;
  primary_profile: "fast";
  escalation_profile: "flagship";
  trigger: ProfileTrigger;
  escalated: boolean;
  flagship_invoked: boolean;
  decision_source: ValveProfile;
  severe_miss: boolean;
  fast: LedgerProfileRun;
  flagship: LedgerProfileRun | null;
  total_latency_ms: number;
  promotion_eligible: boolean;
  promotion_blockers: string[];
}

interface LedgerProfileRun {
  ok: boolean;
  consensus_id: string | null;
  gate_run_id: string | null;
  panel: string[];
  panel_fingerprint: string | null;
  status: string | null;
  confidence: number | null;
  unanimous: boolean | null;
  latency_ms: number;
}

const DEFAULT_LEDGER_PATH = process.env.PROFILE_ESCALATION_LEDGER
  ?? `${process.env.HOME}/.zouroboros/profile-escalation-shadow.jsonl`;
const DEFAULT_ARTIFACT_PATH = process.env.PROFILE_ESCALATION_PROMOTION
  ?? `${process.env.HOME}/.zouroboros/profile-escalation-promotion.json`;
const DEFAULT_ENFORCE_LEDGER_PATH = process.env.PROFILE_ESCALATION_ENFORCE_LEDGER
  ?? `${process.env.HOME}/.zouroboros/profile-escalation-enforce.jsonl`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractResult(stdout: string): ProfileConsensusResult {
  const marker = "__CG_JSON__";
  const line = stdout.split("\n").reverse().find((candidate) => candidate.startsWith(marker));
  if (!line) throw new Error("consensus gate emitted no JSON sentinel");
  return JSON.parse(line.slice(marker.length)) as ProfileConsensusResult;
}

function fingerprintPanel(models: string[]): string {
  return createHash("sha256").update(JSON.stringify(models)).digest("hex");
}

class MalformedProfileResultError extends Error {}
class ProfilePanelFailureError extends Error {}

function validateProfileResult(profile: ValveProfile, result: ProfileConsensusResult): void {
  if (!isCompleteConsensusResult(result)) {
    throw new MalformedProfileResultError(`consensus ${profile} result is structurally incomplete`);
  }
  if (
    result.lineup_source !== "persisted-profile" ||
    result.lineup_profile !== profile ||
    !Array.isArray(result.panel) ||
    typeof result.panel_fingerprint !== "string" ||
    result.panel_fingerprint !== fingerprintPanel(result.panel)
  ) {
    throw new ProfilePanelFailureError(`consensus ${profile} result lacks matching persisted-profile proof`);
  }
  if (isPanelFailure(result)) {
    throw new ProfilePanelFailureError(`consensus ${profile} panel failed`);
  }
}

export async function executeConsensusProfile(
  profile: ValveProfile,
  input: ProfileValveInput,
): Promise<ProfileConsensusResult> {
  const gatePath = input.gatePath ?? process.env.CONSENSUS_GATE_PATH ?? path.join(import.meta.dir, "consensus-gate.ts");
  const args = [
    "bun",
    gatePath,
    "validate",
    "--json",
    "--mode",
    input.reviewMode ?? "code-review",
    "--code",
    input.code,
    "--criteria",
    input.criteria,
    "--label",
    `${input.label}-${profile}`,
  ];
  if (input.author) args.push("--author", input.author);

  const childEnv: Record<string, string | undefined> = { ...process.env, GATE_LINEUP_PROFILE: profile };
  delete childEnv.CONSENSUS_MODELS;
  const proc = Bun.spawn(args, {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), input.timeoutMs ?? 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`consensus ${profile} process failed (${exitCode}): ${stderr.trim().slice(0, 300)}`);
    }
    const result = extractResult(stdout);
    validateProfileResult(profile, result);
    return result;
  } catch (error) {
    proc.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runProfile(
  profile: ValveProfile,
  input: ProfileValveInput,
  executeProfile: NonNullable<ProfileValveDependencies["executeProfile"]>,
): Promise<ProfileRun> {
  const started = performance.now();
  try {
    const result = await executeProfile(profile, input) as ProfileConsensusResult;
    validateProfileResult(profile, result);
    return {
      profile,
      ok: true,
      result,
      consensusId: typeof result?.id === "string" ? result.id : null,
      gateRunId: typeof result?.gate_run_id === "string" ? result.gate_run_id : null,
      panel: [...(result.panel ?? [])],
      panelFingerprint: result.panel_fingerprint ?? null,
      latencyMs: Math.round(performance.now() - started),
      error: null,
      failureTrigger: null,
    };
  } catch (error) {
    return {
      profile,
      ok: false,
      result: null,
      consensusId: null,
      gateRunId: null,
      panel: [],
      panelFingerprint: null,
      latencyMs: Math.round(performance.now() - started),
      error: errorMessage(error),
      failureTrigger: error instanceof MalformedProfileResultError ? "malformed" : "panel_failure",
    };
  }
}

function normalizedHighSeverityClaims(result: ProfileConsensusResult | null): Set<string> {
  const claims = result?.verdicts?.flatMap((verdict) => verdict.dissent_claims ?? []) ?? [];
  return new Set(
    claims
      .filter((claim) => claim.severity === "high" && typeof claim.claim === "string")
      .map((claim) => claim.claim!.toLowerCase().replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

function isCompleteConsensusResult(result: ProfileConsensusResult | null): boolean {
  return Boolean(
    result &&
    isConsensusSnapshot(result) &&
    typeof result.id === "string" &&
    Array.isArray(result.verdicts) &&
    result.verdicts.length > 0 &&
    typeof result.status === "string" &&
    typeof result.consensus === "object" &&
    result.consensus !== null
  );
}

function isPanelFailure(result: ProfileConsensusResult | null): boolean {
  if (!result?.verdicts?.length || !result.panel?.length) return true;
  return result.panel.some((model) => {
    const verdict = result.verdicts!.find((candidate) => candidate.model === model);
    if (!verdict) return true;
    return verdict.confidence === 0 || Boolean(
      verdict.issues?.length && verdict.issues.every((issue) =>
        /^(?:empty response|unparseable verdict|api error:|call failed:)/i.test(issue)
      )
    );
  });
}

function ledgerRun(run: ProfileRun): LedgerProfileRun {
  return {
    ok: run.ok,
    consensus_id: run.consensusId,
    gate_run_id: run.gateRunId,
    panel: run.panel,
    panel_fingerprint: run.panelFingerprint,
    status: typeof run.result?.status === "string" ? run.result.status : null,
    confidence: typeof run.result?.consensus?.confidence === "number" ? run.result.consensus.confidence : null,
    unanimous: typeof run.result?.consensus?.unanimous === "boolean" ? run.result.consensus.unanimous : null,
    latency_ms: run.latencyMs,
  };
}

function appendLedger(pathname: string, row: ProfileEscalationLedgerRow): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.appendFileSync(pathname, `${JSON.stringify(row)}\n`);
}

async function defaultVerifyPromotion(artifactPath: string, ledgerPath: string): Promise<PromotionVerification> {
  const { verifyPromotionArtifact } = await import("./profile-escalation-promotion");
  return verifyPromotionArtifact(artifactPath, ledgerPath);
}

export async function runProfileEscalation(
  input: ProfileValveInput,
  dependencies: ProfileValveDependencies = {},
): Promise<ProfileValveResult> {
  if (!input.code) throw new Error("code is required");
  if (!input.criteria) throw new Error("criteria is required");
  if (!input.label) throw new Error("label is required");
  if (!isValidRoutingPolicyOptions({ minConfidence: input.minConfidence })) {
    throw new RangeError("minConfidence must be a finite number between 0 and 1");
  }

  const executeProfile = dependencies.executeProfile ?? executeConsensusProfile;
  const verifyPromotion = dependencies.verifyPromotion ?? defaultVerifyPromotion;
  const ledgerPath = input.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const requestedMode = input.mode;
  let effectiveMode = requestedMode;
  let promotion: PromotionVerification = { eligible: false, blockers: [] };

  if (requestedMode === "enforce") {
    try {
      promotion = await verifyPromotion(input.promotionArtifactPath ?? DEFAULT_ARTIFACT_PATH, ledgerPath);
    } catch (error) {
      promotion = { eligible: false, blockers: [`promotion verification failed: ${errorMessage(error)}`] };
    }
    if (!promotion.eligible) effectiveMode = "shadow";
  }

  const started = performance.now();
  const fast = await runProfile("fast", input, executeProfile);
  const fastSnapshot: ConsensusSnapshot = !fast.ok
    ? fast.failureTrigger === "malformed" ? {} : { executionFailure: true }
    : fast.result!;
  const routing = decideProfileEscalation(fastSnapshot, { minConfidence: input.minConfidence });
  const flagshipInvoked = effectiveMode === "shadow" || routing.escalate;
  const flagship = flagshipInvoked ? await runProfile("flagship", input, executeProfile) : null;
  const decisionSource: ValveProfile = flagshipInvoked ? "flagship" : "fast";
  const decision = flagshipInvoked ? (flagship?.ok ? flagship.result : null) : fast.result;
  const trigger: ProfileTrigger = effectiveMode === "shadow" && routing.trigger === "none"
    ? "forced_shadow"
    : routing.trigger;
  const fastHighClaims = normalizedHighSeverityClaims(fast.result);
  const flagshipHighClaims = normalizedHighSeverityClaims(flagship?.result ?? null);
  const severeMiss = Boolean(
    fast.ok && flagship?.ok && [...flagshipHighClaims].some((claim) => !fastHighClaims.has(claim))
  );

  const result: ProfileValveResult = {
    valveRunId: dependencies.runId?.() ?? `pv-${randomUUID()}`,
    requestedMode,
    effectiveMode,
    decisionSource,
    decision,
    trigger,
    escalated: routing.escalate,
    flagshipInvoked,
    severeMiss,
    fast,
    flagship,
    totalLatencyMs: Math.round(performance.now() - started),
    promotionEligible: promotion.eligible,
    promotionBlockers: promotion.blockers,
  };

  const auditLedgerPath = effectiveMode === "shadow"
    ? ledgerPath
    : input.enforceLedgerPath
      ?? (input.ledgerPath ? `${ledgerPath.replace(/\.jsonl$/, "")}-enforce.jsonl` : DEFAULT_ENFORCE_LEDGER_PATH);
  const ledgerRow: ProfileEscalationLedgerRow = {
    schema_version: 1,
    valve_run_id: result.valveRunId,
    timestamp: (dependencies.now?.() ?? new Date()).toISOString(),
    input_sha256: createHash("sha256").update(input.code).digest("hex"),
    requested_mode: requestedMode,
    effective_mode: effectiveMode,
    primary_profile: "fast",
    escalation_profile: "flagship",
    trigger,
    escalated: routing.escalate,
    flagship_invoked: flagshipInvoked,
    decision_source: decisionSource,
    severe_miss: severeMiss,
    fast: ledgerRun(fast),
    flagship: flagship ? ledgerRun(flagship) : null,
    total_latency_ms: result.totalLatencyMs,
    promotion_eligible: promotion.eligible,
    promotion_blockers: promotion.blockers,
  };
  try {
    appendLedger(auditLedgerPath, ledgerRow);
  } catch (error) {
    result.auditError = `profile escalation audit write failed: ${errorMessage(error)}`;
  }

  return result;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      code: { type: "string" },
      file: { type: "string" },
      criteria: { type: "string", default: "correctness,security" },
      label: { type: "string", default: "profile-valve" },
      mode: { type: "string", default: "shadow" },
      "review-mode": { type: "string", default: "code-review" },
      "min-confidence": { type: "string", default: process.env.PROFILE_ESCALATION_MIN_CONFIDENCE ?? "0.8" },
      ledger: { type: "string" },
      "enforce-ledger": { type: "string" },
      promotion: { type: "string" },
      "gate-path": { type: "string" },
      author: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const mode = values.mode as ProfileValveMode;
  const reviewMode = values["review-mode"] as "code-review" | "judge";
  if (mode !== "shadow" && mode !== "enforce") throw new Error("--mode must be shadow or enforce");
  if (reviewMode !== "code-review" && reviewMode !== "judge") throw new Error("--review-mode must be code-review or judge");
  const code = values.code ?? (values.file ? fs.readFileSync(values.file, "utf8") : "");
  const result = await runProfileEscalation({
    code,
    criteria: values.criteria ?? "correctness,security",
    label: values.label ?? "profile-valve",
    mode,
    reviewMode,
    minConfidence: Number(values["min-confidence"] ?? "0.8"),
    ledgerPath: values.ledger,
    enforceLedgerPath: values["enforce-ledger"],
    promotionArtifactPath: values.promotion,
    gatePath: values["gate-path"],
    author: values.author,
  });
  if (values.json) console.log(`__PROFILE_VALVE_JSON__${JSON.stringify(result)}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
