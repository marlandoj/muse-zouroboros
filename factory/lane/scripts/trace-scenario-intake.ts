#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  evaluateHoldoutContamination,
  readHoldoutState,
  recordHoldoutAccess,
  validateAccessLedger,
  validateHoldoutManifest,
  writeHoldoutState,
  type ContaminationResult,
  type HoldoutState,
} from "./heldout-cohort";
import {
  canonicalize,
  validateRunReceipt,
  type RunReceipt,
} from "./run-receipt-contract";
import type { ScenarioSpec } from "./scenario-spec";

export const TRACE_INTAKE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TraceIntakeMode = "off" | "shadow" | "enforce";
export type CandidateState = "quarantined" | "admitted" | "rejected" | "expired";
export type ReviewDecision = "admit" | "reject";

export interface TraceScenarioDraft {
  observedFailure: string;
  hypothesizedCause: string;
  expectedBehavior: string;
  scenarioVersion: string;
  scenario: ScenarioSpec;
}

export interface TraceCandidateContract {
  observedFailure: string;
  hypothesizedCause: string;
  expectedBehavior: string;
  scenarioVersion: string;
  scenario: ScenarioSpec;
}

export interface TraceCandidate {
  candidateId: string;
  candidateHash: string;
  sourceReceiptId: string;
  sourceReceiptHash: string;
  contract: TraceCandidateContract;
  state: CandidateState;
  holdoutManifestHash: string;
  quarantineReasons: string[];
  maximumHoldoutOverlap: number;
  createdAt: string;
  expiresAt: string;
  admittedReviewId: string | null;
  admittedReviewHash: string | null;
}

export interface TraceReviewRecord {
  reviewId: string;
  candidateId: string;
  candidateHash: string;
  actor: string;
  reviewerKind: "human";
  decision: ReviewDecision;
  reason: string;
  holdoutManifestHash: string;
  maximumHoldoutOverlap: number;
  quarantineReasons: string[];
  ts: string;
  previousHash: string | null;
  recordHash: string;
}

export interface TraceIntakeState {
  schemaVersion: typeof TRACE_INTAKE_SCHEMA_VERSION;
  candidates: TraceCandidate[];
  reviews: TraceReviewRecord[];
}

export interface IntakeResult {
  disposition: "quarantined" | "hold" | "duplicate";
  candidate: TraceCandidate | null;
  reasons: string[];
  contamination: ContaminationResult | null;
}

export interface ReviewResult {
  candidate: TraceCandidate;
  review: TraceReviewRecord;
  scenarioOutputPath: string | null;
}

export interface ScenarioLineage {
  source_receipt_id: string;
  source_receipt_hash: string;
  candidate_id: string;
  candidate_hash: string;
  review_id: string;
  review_hash: string;
  scenario_version: string;
}

const HASH = /^[0-9a-f]{64}$/;
const SECRET_KEY = /(^|[_-])(secret|password|passwd|token|api[_-]?key|private[_-]?key|credential|authorization)([_-]|$)/i;
const CREDENTIAL_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${sha256(path).slice(0, 12)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, value, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function statePath(root: string): string {
  return join(resolve(root), "trace-intake-state.json");
}

function emptyState(): TraceIntakeState {
  return { schemaVersion: TRACE_INTAKE_SCHEMA_VERSION, candidates: [], reviews: [] };
}

function reviewPayload(record: Omit<TraceReviewRecord, "recordHash">): string {
  return canonicalize(record);
}

export function validateReviewLedger(records: readonly TraceReviewRecord[]): string[] {
  const errors: string[] = [];
  let previous: string | null = null;
  for (const [index, record] of records.entries()) {
    if (record.previousHash !== previous) errors.push(`review previous hash mismatch at ${index}`);
    const { recordHash, ...payload } = record;
    if (recordHash !== sha256(reviewPayload(payload))) errors.push(`review record hash mismatch at ${index}`);
    previous = record.recordHash;
  }
  return errors;
}

export function validateTraceIntakeState(state: TraceIntakeState): string[] {
  const errors: string[] = [];
  if (state.schemaVersion !== TRACE_INTAKE_SCHEMA_VERSION) errors.push("unknown trace intake schema");
  errors.push(...validateReviewLedger(state.reviews));
  const ids = new Set<string>();
  for (const candidate of state.candidates) {
    if (ids.has(candidate.candidateId)) errors.push(`duplicate candidate id: ${candidate.candidateId}`);
    ids.add(candidate.candidateId);
    const expectedHash = sha256(canonicalize({
      sourceReceiptHash: candidate.sourceReceiptHash,
      contract: candidate.contract,
    }));
    if (candidate.candidateHash !== expectedHash) errors.push(`candidate hash mismatch: ${candidate.candidateId}`);
    if (candidate.candidateId !== `trace-${expectedHash.slice(0, 24)}`) errors.push(`candidate id mismatch: ${candidate.candidateId}`);
    if (!HASH.test(candidate.sourceReceiptHash)) errors.push(`invalid source receipt hash: ${candidate.candidateId}`);
    if (!HASH.test(candidate.holdoutManifestHash)) errors.push(`invalid holdout manifest hash: ${candidate.candidateId}`);
    if (!Number.isFinite(candidate.maximumHoldoutOverlap)
      || candidate.maximumHoldoutOverlap < 0
      || candidate.maximumHoldoutOverlap > 1) {
      errors.push(`invalid holdout overlap: ${candidate.candidateId}`);
    }
    if (candidate.state === "admitted") {
      if (!candidate.admittedReviewId || !candidate.admittedReviewHash) errors.push(`admitted candidate lacks review: ${candidate.candidateId}`);
      const review = state.reviews.find((entry) => entry.reviewId === candidate.admittedReviewId);
      if (!review || review.recordHash !== candidate.admittedReviewHash || review.decision !== "admit") {
        errors.push(`admitted candidate review binding mismatch: ${candidate.candidateId}`);
      }
    }
  }
  for (const review of state.reviews) {
    const candidate = state.candidates.find((entry) => entry.candidateId === review.candidateId);
    if (!candidate) {
      errors.push(`review candidate missing: ${review.reviewId}`);
      continue;
    }
    if (review.candidateHash !== candidate.candidateHash
      || review.holdoutManifestHash !== candidate.holdoutManifestHash
      || review.maximumHoldoutOverlap !== candidate.maximumHoldoutOverlap
      || canonicalize(review.quarantineReasons) !== canonicalize(candidate.quarantineReasons)) {
      errors.push(`review evidence binding mismatch: ${review.reviewId}`);
    }
  }
  return errors;
}

export function readTraceIntakeState(root: string): TraceIntakeState {
  const path = statePath(root);
  if (!existsSync(path)) return emptyState();
  const state = JSON.parse(readFileSync(path, "utf8")) as TraceIntakeState;
  const errors = validateTraceIntakeState(state);
  if (errors.length > 0) throw new Error(`invalid trace intake state: ${errors.join("; ")}`);
  return state;
}

export function writeTraceIntakeState(root: string, state: TraceIntakeState): void {
  const errors = validateTraceIntakeState(state);
  if (errors.length > 0) throw new Error(`refuse to persist invalid trace intake state: ${errors.join("; ")}`);
  atomicWrite(statePath(root), `${canonicalize(state)}\n`);
}

function secretFindings(value: unknown, path = "$", findings: string[] = []): string[] {
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE.test(value)) findings.push(`${path} contains a credential-shaped value`);
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => secretFindings(entry, `${path}[${index}]`, findings));
    return findings;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) findings.push(`${path}.${key} is a secret-shaped key`);
      secretFindings(entry, `${path}.${key}`, findings);
    }
  }
  return findings;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function cleanDraft(draft: TraceScenarioDraft): TraceCandidateContract {
  const findings = secretFindings(draft);
  if (findings.length > 0) throw new Error(`secret rejection: ${findings.join("; ")}`);
  const source = structuredClone(draft.scenario);
  if (!source || typeof source !== "object") throw new Error("scenario is required");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(source.scenario_id)) throw new Error("scenario_id is invalid");
  if (!Number.isInteger(source.seed) || source.seed < 0) throw new Error("scenario seed is invalid");
  if (!Array.isArray(source.steps) || source.steps.length === 0) throw new Error("scenario steps are required");
  let twin: ScenarioSpec["twin"];
  if (source.twin?.kind === "linear") {
    twin = { kind: "linear", fixture: source.twin.fixture };
  } else if (source.twin?.kind === "actor-system") {
    twin = {
      kind: "actor-system",
      fixture: source.twin.fixture,
      contract_id: source.twin.contract_id,
      authority_kind: source.twin.authority_kind,
      manifest_sha256: source.twin.manifest_sha256,
      contract_sha256: source.twin.contract_sha256,
      review_sha256: source.twin.review_sha256,
    };
  } else if (source.twin !== undefined) {
    throw new Error("scenario twin kind is unsupported");
  }
  const scenario: ScenarioSpec = {
    scenario_id: source.scenario_id,
    ...(typeof source.description === "string" ? { description: source.description.trim() } : {}),
    seed: source.seed,
    ...(twin ? { twin } : {}),
    ...(source.env ? { env: Object.fromEntries(Object.entries(source.env).map(([name, value]) => [name, String(value)])) } : {}),
    steps: source.steps.map((step) => ({
      name: step.name,
      run: step.run,
      ...(step.timeout_ms === undefined ? {} : { timeout_ms: step.timeout_ms }),
      expect: {
        ...(step.expect.exit_code === undefined ? {} : { exit_code: step.expect.exit_code }),
        ...(step.expect.stdout_contains === undefined ? {} : { stdout_contains: [...step.expect.stdout_contains] }),
        ...(step.expect.stderr_contains === undefined ? {} : { stderr_contains: [...step.expect.stderr_contains] }),
        ...(step.expect.files_exist === undefined ? {} : { files_exist: [...step.expect.files_exist] }),
      },
    })),
  };
  return {
    observedFailure: requireText(draft.observedFailure, "observedFailure"),
    hypothesizedCause: requireText(draft.hypothesizedCause, "hypothesizedCause"),
    expectedBehavior: requireText(draft.expectedBehavior, "expectedBehavior"),
    scenarioVersion: requireText(draft.scenarioVersion, "scenarioVersion"),
    scenario,
  };
}

export function validateSufficientReceipt(receipt: RunReceipt): string[] {
  const result = validateRunReceipt(receipt, { verifyHash: true });
  const errors = result.errors.map((error) => `${error.code}:${error.path}`);
  if (receipt.authority?.envelope_kind === "none") errors.push("authority is unavailable");
  if (!receipt.trigger?.identity || !receipt.trigger.intent) errors.push("trigger evidence is unavailable");
  if (!Array.isArray(receipt.events) || receipt.events.length === 0) errors.push("operation events are unavailable");
  if (!Array.isArray(receipt.attempts) || receipt.attempts.length === 0) errors.push("attempt evidence is unavailable");
  if (!receipt.acknowledgements?.completed) errors.push("terminal acknowledgement is unavailable");
  if (!HASH.test(receipt.terminal?.committed_state_hash ?? "")) errors.push("committed state evidence is unavailable");
  if (receipt.verification?.edge_proof?.chain_ok !== true) errors.push("edge chain proof is unavailable");
  if (receipt.verification?.edge_proof?.anchor_ok !== true) errors.push("edge anchor proof is unavailable");
  if ((receipt.terminal?.ledger_entries?.length ?? 0) > 0 && !receipt.verification.edge_proof.ledger_head) {
    errors.push("edge ledger anchor is unavailable");
  }
  return [...new Set(errors)];
}

function auditHoldoutCheck(path: string, actor: string, now: string): { state: HoldoutState | null; reasons: string[] } {
  let state: HoldoutState;
  try {
    state = readHoldoutState(path);
  } catch (error) {
    return { state: null, reasons: [String(error)] };
  }
  const evidenceErrors = [...validateHoldoutManifest(state.manifest), ...validateAccessLedger(state.accessLedger)];
  if (evidenceErrors.length > 0 || state.manifest.items.length === 0) {
    return { state: null, reasons: evidenceErrors.length > 0 ? evidenceErrors : ["empty holdout manifest"] };
  }
  let current = state;
  for (const item of current.manifest.items) {
    const result = recordHoldoutAccess(current, {
      itemId: item.itemId,
      actor,
      purpose: "contamination_check",
      ts: now,
    });
    if (result.decision === "hold") return { state: null, reasons: result.reasons };
    current = { manifest: result.manifest, accessLedger: result.accessLedger };
  }
  writeHoldoutState(path, current);
  return { state: current, reasons: [] };
}

export function intakeTraceCandidate(input: {
  receipt: RunReceipt;
  draft: TraceScenarioDraft;
  holdoutStatePath: string;
  stateRoot: string;
  actor: string;
  now: string;
  expiresAt?: string;
}): IntakeResult {
  const nowMs = parseTime(input.now, "now");
  const receiptErrors = validateSufficientReceipt(input.receipt);
  if (receiptErrors.length > 0) return { disposition: "hold", candidate: null, reasons: receiptErrors, contamination: null };
  const contract = cleanDraft(input.draft);
  const evidence = auditHoldoutCheck(input.holdoutStatePath, requireText(input.actor, "actor"), input.now);
  if (!evidence.state) return { disposition: "hold", candidate: null, reasons: evidence.reasons, contamination: null };

  const contaminationInput = canonicalize(contract);
  const contamination = evaluateHoldoutContamination(contaminationInput, evidence.state.manifest, input.now);
  if (contamination.disposition === "hold") {
    return { disposition: "hold", candidate: null, reasons: contamination.reasons, contamination };
  }

  const candidateHash = sha256(canonicalize({ sourceReceiptHash: input.receipt.receipt_hash, contract }));
  const state = readTraceIntakeState(input.stateRoot);
  const duplicate = state.candidates.find((candidate) =>
    candidate.candidateHash === candidateHash
    || (candidate.sourceReceiptId === input.receipt.receipt_id
      && candidate.sourceReceiptHash === input.receipt.receipt_hash
      && candidate.contract.scenarioVersion === contract.scenarioVersion
      && candidate.contract.scenario.scenario_id === contract.scenario.scenario_id));
  if (duplicate) return { disposition: "duplicate", candidate: structuredClone(duplicate), reasons: ["duplicate candidate"], contamination };

  const expiresAt = input.expiresAt ?? new Date(nowMs + DEFAULT_CANDIDATE_TTL_MS).toISOString();
  if (parseTime(expiresAt, "expiresAt") <= nowMs) throw new Error("expiresAt must follow now");
  const candidate: TraceCandidate = {
    candidateId: `trace-${candidateHash.slice(0, 24)}`,
    candidateHash,
    sourceReceiptId: input.receipt.receipt_id,
    sourceReceiptHash: input.receipt.receipt_hash,
    contract,
    state: "quarantined",
    holdoutManifestHash: evidence.state.manifest.manifestHash,
    quarantineReasons: contamination.disposition === "quarantine" ? contamination.reasons : [],
    maximumHoldoutOverlap: contamination.maximumOverlap,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(parseTime(expiresAt, "expiresAt")).toISOString(),
    admittedReviewId: null,
    admittedReviewHash: null,
  };
  writeTraceIntakeState(input.stateRoot, { ...state, candidates: [...state.candidates, candidate] });
  return {
    disposition: "quarantined",
    candidate: structuredClone(candidate),
    reasons: candidate.quarantineReasons.length > 0 ? candidate.quarantineReasons : ["human review required"],
    contamination,
  };
}

function appendReview(
  reviews: readonly TraceReviewRecord[],
  input: Omit<TraceReviewRecord, "reviewId" | "previousHash" | "recordHash">,
): TraceReviewRecord {
  const errors = validateReviewLedger(reviews);
  if (errors.length > 0) throw new Error(`cannot append to broken review ledger: ${errors.join("; ")}`);
  const previousHash = reviews.at(-1)?.recordHash ?? null;
  const reviewId = `review-${sha256(canonicalize({ ...input, previousHash })).slice(0, 24)}`;
  const payload: Omit<TraceReviewRecord, "recordHash"> = { ...input, reviewId, previousHash };
  return { ...payload, recordHash: sha256(reviewPayload(payload)) };
}

function scenarioDocument(candidate: TraceCandidate, review: TraceReviewRecord): ScenarioSpec & { lineage: ScenarioLineage } {
  const scenario = structuredClone(candidate.contract.scenario);
  if (scenario.twin?.kind === "actor-system" && scenario.twin.authority_kind === "admitted_lineage") {
    scenario.twin.review_sha256 = review.recordHash;
  }
  return {
    ...scenario,
    lineage: {
      source_receipt_id: candidate.sourceReceiptId,
      source_receipt_hash: candidate.sourceReceiptHash,
      candidate_id: candidate.candidateId,
      candidate_hash: candidate.candidateHash,
      review_id: review.reviewId,
      review_hash: review.recordHash,
      scenario_version: candidate.contract.scenarioVersion,
    },
  };
}

export function expireTraceCandidates(root: string, now: string): TraceIntakeState {
  const nowMs = parseTime(now, "now");
  const state = readTraceIntakeState(root);
  const candidates = state.candidates.map((candidate) => {
    if (candidate.state !== "quarantined" || nowMs < parseTime(candidate.expiresAt, "expiresAt")) return structuredClone(candidate);
    return { ...structuredClone(candidate), state: "expired" as const };
  });
  const next = { ...state, candidates };
  writeTraceIntakeState(root, next);
  return next;
}

export function reviewTraceCandidate(input: {
  stateRoot: string;
  candidateId: string;
  candidateHash: string;
  actor: string;
  reviewerKind: "human";
  decision: ReviewDecision;
  reason: string;
  now: string;
  scenarioOutputPath?: string;
  injectFailureAfterScenarioWrite?: boolean;
}): ReviewResult {
  const nowMs = parseTime(input.now, "now");
  const actor = requireText(input.actor, "actor");
  const reason = requireText(input.reason, "reason");
  if (input.reviewerKind !== "human") throw new Error("reviewerKind must be human");
  if (input.decision !== "admit" && input.decision !== "reject") throw new Error("decision must be admit or reject");
  const state = readTraceIntakeState(input.stateRoot);
  const index = state.candidates.findIndex((candidate) => candidate.candidateId === input.candidateId);
  if (index < 0) throw new Error("candidate not found");
  const candidate = structuredClone(state.candidates[index]);
  if (candidate.candidateHash !== input.candidateHash) throw new Error("candidate hash mismatch");
  if (candidate.state !== "quarantined") throw new Error(`candidate is immutable in state ${candidate.state}`);
  if (nowMs >= parseTime(candidate.expiresAt, "expiresAt")) {
    const candidates = state.candidates.map((entry, candidateIndex) => candidateIndex === index ? { ...entry, state: "expired" as const } : entry);
    writeTraceIntakeState(input.stateRoot, { ...state, candidates });
    throw new Error("candidate expired");
  }
  if (input.decision === "admit" && candidate.quarantineReasons.length > 0) {
    throw new Error(`contaminated candidate cannot be admitted: ${candidate.quarantineReasons.join(", ")}`);
  }
  const review = appendReview(state.reviews, {
    candidateId: candidate.candidateId,
    candidateHash: candidate.candidateHash,
    actor,
    reviewerKind: "human",
    decision: input.decision,
    reason,
    holdoutManifestHash: candidate.holdoutManifestHash,
    maximumHoldoutOverlap: candidate.maximumHoldoutOverlap,
    quarantineReasons: [...candidate.quarantineReasons],
    ts: new Date(nowMs).toISOString(),
  });
  const nextCandidate: TraceCandidate = {
    ...candidate,
    state: input.decision === "admit" ? "admitted" : "rejected",
    admittedReviewId: input.decision === "admit" ? review.reviewId : null,
    admittedReviewHash: input.decision === "admit" ? review.recordHash : null,
  };
  const nextState: TraceIntakeState = {
    ...state,
    candidates: state.candidates.map((entry, candidateIndex) => candidateIndex === index ? nextCandidate : entry),
    reviews: [...state.reviews, review],
  };

  if (input.decision === "reject") {
    writeTraceIntakeState(input.stateRoot, nextState);
    return { candidate: structuredClone(nextCandidate), review, scenarioOutputPath: null };
  }
  if (!input.scenarioOutputPath) throw new Error("scenarioOutputPath is required for admission");

  const output = resolve(input.scenarioOutputPath);
  const existed = existsSync(output);
  const previous = existed ? readFileSync(output) : null;
  try {
    atomicWrite(output, `${canonicalize(scenarioDocument(nextCandidate, review))}\n`);
    if (input.injectFailureAfterScenarioWrite) throw new Error("injected post-write failure");
    writeTraceIntakeState(input.stateRoot, nextState);
  } catch (error) {
    if (previous) atomicWrite(output, previous.toString("utf8"));
    else rmSync(output, { force: true });
    throw error;
  }
  return { candidate: structuredClone(nextCandidate), review, scenarioOutputPath: output };
}

export function traceIntakeMode(env: NodeJS.ProcessEnv = process.env): TraceIntakeMode {
  const value = env.SF009_TRACE_INTAKE ?? "off";
  if (value === "off" || value === "shadow" || value === "enforce") return value;
  return "off";
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

if (import.meta.main) {
  const mode = traceIntakeMode();
  if (mode === "off") process.exit(0);
  try {
    const args = process.argv.slice(2);
    if (args[0] === "intake") {
      const result = intakeTraceCandidate({
        receipt: JSON.parse(readFileSync(option(args, "--receipt"), "utf8")) as RunReceipt,
        draft: JSON.parse(readFileSync(option(args, "--draft"), "utf8")) as TraceScenarioDraft,
        holdoutStatePath: option(args, "--holdouts"),
        stateRoot: option(args, "--root"),
        actor: option(args, "--actor"),
        now: option(args, "--now"),
      });
      console.log(JSON.stringify(result));
      process.exit(result.disposition === "hold" ? 3 : 0);
    }
    if (args[0] === "review") {
      const decision = option(args, "--decision") as ReviewDecision;
      if (decision === "admit" && mode !== "enforce") {
        throw new Error("scenario admission requires SF009_TRACE_INTAKE=enforce");
      }
      const result = reviewTraceCandidate({
        stateRoot: option(args, "--root"),
        candidateId: option(args, "--candidate-id"),
        candidateHash: option(args, "--candidate-hash"),
        actor: option(args, "--actor"),
        reviewerKind: option(args, "--reviewer-kind") as "human",
        decision,
        reason: option(args, "--reason"),
        now: option(args, "--now"),
        scenarioOutputPath: args.includes("--output") ? option(args, "--output") : undefined,
      });
      console.log(JSON.stringify(result));
      process.exit(0);
    }
    throw new Error("usage: trace-scenario-intake.ts intake|review [options]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
