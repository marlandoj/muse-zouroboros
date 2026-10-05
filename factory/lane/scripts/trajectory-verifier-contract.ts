import { createHash } from "node:crypto";
import { canonicalize } from "./run-receipt-contract.ts";

export const TRAJECTORY_REQUEST_KEYS = [
  "schema_version",
  "request_id",
  "scenario_id",
  "seed",
  "claims",
  "redacted_observations",
  "source_receipt_id",
  "source_receipt_hash",
  "generator_model_id",
  "generator_prompt_sha256",
  "generator_history_sha256",
  "verifier_model_id",
  "verifier_prompt_sha256",
  "verifier_history_sha256",
  "rubric_sha256",
  "replay_tool_url",
] as const;

export const TRAJECTORY_FORBIDDEN_FIELDS = [
  "fixture_path",
  "manifest_path",
  "golden_patch",
  "hidden_answer",
  "expectedTerminal",
  "fault",
  "recovery",
  "approval",
  "generator_prompt",
  "generator_history",
  "holdout_plaintext",
  "credential",
] as const;

export const TRAJECTORY_CLAIM_FIELDS = [
  "terminal",
  "attempts",
  "delay_ms",
  "committed",
  "compensated",
  "resumed",
  "state_version",
] as const;

export type TrajectoryClaimField = typeof TRAJECTORY_CLAIM_FIELDS[number];
export type TrajectoryPrimitive = string | number | boolean;
export type TrajectoryDisposition = "PASS" | "HOLD";

export interface TrajectoryClaim {
  claim_id: string;
  field: TrajectoryClaimField;
  expected: TrajectoryPrimitive;
  evidence_sha256: string;
}

export interface TrajectoryQualitativeEvidence {
  artifact_id: string;
  verifier_model_id: string;
  verifier_prompt_sha256: string;
  verifier_history_sha256: string;
  rubric_sha256: string;
  request_sha256: string;
  score: number;
  confidence: number;
  rationale_sha256: string;
}

export interface TrajectoryRedactedObservations {
  transcript_sha256: string;
  initial_response_sha256: string;
  generator_root_sha256: string;
  verifier_root_sha256: string;
  qualitative_evidence: TrajectoryQualitativeEvidence;
}

export interface TrajectoryVerifierRequest {
  schema_version: 1;
  request_id: string;
  scenario_id: string;
  seed: number;
  claims: TrajectoryClaim[];
  redacted_observations: TrajectoryRedactedObservations;
  source_receipt_id: string;
  source_receipt_hash: string;
  generator_model_id: string;
  generator_prompt_sha256: string;
  generator_history_sha256: string;
  verifier_model_id: string;
  verifier_prompt_sha256: string;
  verifier_history_sha256: string;
  rubric_sha256: string;
  replay_tool_url: string;
}

export interface TrajectoryReplayObservation {
  terminal: string;
  attempts: number;
  delay_ms: number;
  committed: boolean;
  compensated: boolean;
  resumed: boolean;
  state_version: number;
}

export interface TrajectoryClaimResult extends TrajectoryClaim {
  observed: TrajectoryPrimitive | null;
  reproduced: boolean;
  reproduced_evidence_sha256: string;
}

export interface TrajectoryBoundaryObservations {
  environment_secret_free: boolean;
  loopback_only: boolean;
  generator_root_absent: boolean;
  answer_fields_absent: boolean;
}

export interface TrajectoryVerifierReport {
  schema_version: 1;
  report_id: string;
  request_id: string;
  scenario_id: string;
  source_receipt_id: string;
  source_receipt_hash: string;
  verifier_model_id: string;
  verifier_prompt_sha256: string;
  verifier_history_sha256: string;
  rubric_sha256: string;
  claims: TrajectoryClaimResult[];
  qualitative_evidence: TrajectoryQualitativeEvidence;
  reproduction_ratio: number;
  confidence: number;
  unresolved_uncertainty: string[];
  boundary_observations: TrajectoryBoundaryObservations;
  disposition: TrajectoryDisposition;
  report_hash: string;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{2,127}$/i;
const SECRET_VALUE = /(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/i;
const CLAIM_KEYS = new Set(["claim_id", "field", "expected", "evidence_sha256"]);
const OBSERVATION_KEYS = new Set([
  "transcript_sha256", "initial_response_sha256", "generator_root_sha256", "verifier_root_sha256",
  "qualitative_evidence",
]);
const QUALITATIVE_KEYS = new Set([
  "artifact_id", "verifier_model_id", "verifier_prompt_sha256", "verifier_history_sha256",
  "rubric_sha256", "request_sha256", "score", "confidence", "rationale_sha256",
]);
const REPORT_KEYS = new Set([
  "schema_version", "report_id", "request_id", "scenario_id", "source_receipt_id", "source_receipt_hash",
  "verifier_model_id", "verifier_prompt_sha256", "verifier_history_sha256", "rubric_sha256", "claims",
  "qualitative_evidence", "reproduction_ratio", "confidence", "unresolved_uncertainty",
  "boundary_observations", "disposition", "report_hash",
]);
const CLAIM_RESULT_KEYS = new Set([...CLAIM_KEYS, "observed", "reproduced", "reproduced_evidence_sha256"]);
const BOUNDARY_KEYS = new Set(["environment_secret_free", "loopback_only", "generator_root_absent", "answer_fields_absent"]);
const FORBIDDEN = new Set<string>(TRAJECTORY_FORBIDDEN_FIELDS);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value) || SECRET_VALUE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function finiteRatio(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  return value;
}

function primitive(value: unknown, label: string): TrajectoryPrimitive {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`${label} must be a primitive`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error(`${label} is secret-shaped`);
  return value;
}

function assertNoForbidden(value: unknown, path = "request"): void {
  if (typeof value === "string" && SECRET_VALUE.test(value)) throw new Error(`${path} contains a secret-shaped value`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbidden(entry, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new Error(`${path} contains forbidden field: ${key}`);
    assertNoForbidden(entry, `${path}.${key}`);
  }
}

function parseQualitative(value: unknown): TrajectoryQualitativeEvidence {
  if (!isObject(value)) throw new Error("qualitative_evidence must be an object");
  exactKeys(value, QUALITATIVE_KEYS, "qualitative_evidence");
  return {
    artifact_id: text(value.artifact_id, "qualitative_evidence.artifact_id"),
    verifier_model_id: text(value.verifier_model_id, "qualitative_evidence.verifier_model_id"),
    verifier_prompt_sha256: hash(value.verifier_prompt_sha256, "qualitative_evidence.verifier_prompt_sha256"),
    verifier_history_sha256: hash(value.verifier_history_sha256, "qualitative_evidence.verifier_history_sha256"),
    rubric_sha256: hash(value.rubric_sha256, "qualitative_evidence.rubric_sha256"),
    request_sha256: hash(value.request_sha256, "qualitative_evidence.request_sha256"),
    score: finiteRatio(value.score, "qualitative_evidence.score"),
    confidence: finiteRatio(value.confidence, "qualitative_evidence.confidence"),
    rationale_sha256: hash(value.rationale_sha256, "qualitative_evidence.rationale_sha256"),
  };
}

function parseClaim(value: unknown, index: number): TrajectoryClaim {
  if (!isObject(value)) throw new Error(`claims[${index}] must be an object`);
  exactKeys(value, CLAIM_KEYS, `claims[${index}]`);
  if (!TRAJECTORY_CLAIM_FIELDS.includes(value.field as TrajectoryClaimField)) throw new Error(`claims[${index}].field is invalid`);
  return {
    claim_id: text(value.claim_id, `claims[${index}].claim_id`),
    field: value.field as TrajectoryClaimField,
    expected: primitive(value.expected, `claims[${index}].expected`),
    evidence_sha256: hash(value.evidence_sha256, `claims[${index}].evidence_sha256`),
  };
}

function parseReplayUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("replay_tool_url is invalid");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !url.port) {
    throw new Error("replay_tool_url must be an unauthenticated 127.0.0.1 ephemeral HTTP URL");
  }
  return url.toString();
}

export function trajectorySha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

export function computeTrajectoryRequestHash(request: TrajectoryVerifierRequest): string {
  const copy = structuredClone(request);
  copy.redacted_observations.qualitative_evidence.request_sha256 = "0".repeat(64);
  copy.replay_tool_url = "http://127.0.0.1:0/replay";
  return trajectorySha256(copy);
}

export function trajectoryClaimEvidenceHash(field: TrajectoryClaimField, expected: TrajectoryPrimitive, sourceReceiptHash: string): string {
  return trajectorySha256({ field, expected, source_receipt_hash: sourceReceiptHash });
}

export function parseTrajectoryVerifierRequest(value: unknown): TrajectoryVerifierRequest {
  assertNoForbidden(value);
  if (!isObject(value)) throw new Error("trajectory request must be an object");
  exactKeys(value, new Set<string>(TRAJECTORY_REQUEST_KEYS), "trajectory request");
  if (value.schema_version !== 1) throw new Error("trajectory request schema_version must be 1");
  if (!Number.isSafeInteger(value.seed) || (value.seed as number) < 0) throw new Error("trajectory request seed is invalid");
  if (!Array.isArray(value.claims) || value.claims.length === 0) throw new Error("trajectory request claims are required");
  if (!isObject(value.redacted_observations)) throw new Error("redacted_observations must be an object");
  exactKeys(value.redacted_observations, OBSERVATION_KEYS, "redacted_observations");
  const request: TrajectoryVerifierRequest = {
    schema_version: 1,
    request_id: text(value.request_id, "request_id"),
    scenario_id: text(value.scenario_id, "scenario_id"),
    seed: value.seed as number,
    claims: value.claims.map(parseClaim),
    redacted_observations: {
      transcript_sha256: hash(value.redacted_observations.transcript_sha256, "redacted_observations.transcript_sha256"),
      initial_response_sha256: hash(value.redacted_observations.initial_response_sha256, "redacted_observations.initial_response_sha256"),
      generator_root_sha256: hash(value.redacted_observations.generator_root_sha256, "redacted_observations.generator_root_sha256"),
      verifier_root_sha256: hash(value.redacted_observations.verifier_root_sha256, "redacted_observations.verifier_root_sha256"),
      qualitative_evidence: parseQualitative(value.redacted_observations.qualitative_evidence),
    },
    source_receipt_id: text(value.source_receipt_id, "source_receipt_id"),
    source_receipt_hash: hash(value.source_receipt_hash, "source_receipt_hash"),
    generator_model_id: text(value.generator_model_id, "generator_model_id"),
    generator_prompt_sha256: hash(value.generator_prompt_sha256, "generator_prompt_sha256"),
    generator_history_sha256: hash(value.generator_history_sha256, "generator_history_sha256"),
    verifier_model_id: text(value.verifier_model_id, "verifier_model_id"),
    verifier_prompt_sha256: hash(value.verifier_prompt_sha256, "verifier_prompt_sha256"),
    verifier_history_sha256: hash(value.verifier_history_sha256, "verifier_history_sha256"),
    rubric_sha256: hash(value.rubric_sha256, "rubric_sha256"),
    replay_tool_url: parseReplayUrl(value.replay_tool_url),
  };
  if (new Set(request.claims.map((claim) => claim.claim_id)).size !== request.claims.length) throw new Error("trajectory request has duplicate claim ids");
  return request;
}

export function trajectoryRequestIssues(request: TrajectoryVerifierRequest): string[] {
  const issues: string[] = [];
  if (request.generator_model_id === request.verifier_model_id) issues.push("generator and verifier model identities are equal");
  if (request.generator_prompt_sha256 === request.verifier_prompt_sha256) issues.push("generator and verifier prompt hashes are equal");
  if (request.generator_history_sha256 === request.verifier_history_sha256) issues.push("generator and verifier history hashes are equal");
  if (request.redacted_observations.generator_root_sha256 === request.redacted_observations.verifier_root_sha256) {
    issues.push("generator and verifier root hashes are equal");
  }
  const qualitative = request.redacted_observations.qualitative_evidence;
  if (qualitative.verifier_model_id !== request.verifier_model_id
    || qualitative.verifier_prompt_sha256 !== request.verifier_prompt_sha256
    || qualitative.verifier_history_sha256 !== request.verifier_history_sha256
    || qualitative.rubric_sha256 !== request.rubric_sha256) {
    issues.push("qualitative evidence identity binding mismatch");
  }
  if (qualitative.request_sha256 !== computeTrajectoryRequestHash(request)) issues.push("qualitative evidence request hash mismatch");
  for (const claim of request.claims) {
    if (claim.evidence_sha256 !== trajectoryClaimEvidenceHash(claim.field, claim.expected, request.source_receipt_hash)) {
      issues.push(`claim evidence mismatch: ${claim.claim_id}`);
    }
  }
  return issues;
}

export function parseTrajectoryReplayObservation(value: unknown): TrajectoryReplayObservation {
  if (!isObject(value)) throw new Error("replay observation must be an object");
  const keys = new Set(["terminal", "attempts", "delay_ms", "committed", "compensated", "resumed", "state_version"]);
  exactKeys(value, keys, "replay observation");
  if (typeof value.terminal !== "string" || !["completed", "failed", "cancelled"].includes(value.terminal)) throw new Error("replay terminal is invalid");
  for (const key of ["attempts", "delay_ms", "state_version"] as const) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) throw new Error(`replay ${key} is invalid`);
  }
  for (const key of ["committed", "compensated", "resumed"] as const) {
    if (typeof value[key] !== "boolean") throw new Error(`replay ${key} is invalid`);
  }
  return value as unknown as TrajectoryReplayObservation;
}

export function computeTrajectoryReportHash(report: TrajectoryVerifierReport): string {
  const copy = structuredClone(report) as unknown as Record<string, unknown>;
  delete copy.report_hash;
  return trajectorySha256(copy);
}

export function buildTrajectoryReport(
  request: TrajectoryVerifierRequest,
  replay: TrajectoryReplayObservation,
  environmentSecretFree = true,
): TrajectoryVerifierReport {
  const requestIssues = trajectoryRequestIssues(request);
  const claims = request.claims.map((claim): TrajectoryClaimResult => {
    const observed = replay[claim.field];
    const reproduced = observed === claim.expected;
    return {
      ...claim,
      observed,
      reproduced,
      reproduced_evidence_sha256: trajectorySha256({ claim_id: claim.claim_id, observed, source_receipt_hash: request.source_receipt_hash }),
    };
  });
  const unresolved = [...requestIssues, ...claims.filter((claim) => !claim.reproduced).map((claim) => `claim not reproduced: ${claim.claim_id}`)];
  const boundary: TrajectoryBoundaryObservations = {
    environment_secret_free: environmentSecretFree,
    loopback_only: new URL(request.replay_tool_url).hostname === "127.0.0.1",
    generator_root_absent: true,
    answer_fields_absent: true,
  };
  if (!environmentSecretFree) unresolved.push("worker environment contains a secret-shaped name");
  const reproduced = claims.filter((claim) => claim.reproduced).length;
  const reproductionRatio = reproduced / claims.length;
  const complete = unresolved.length === 0 && Object.values(boundary).every(Boolean);
  const base = {
    schema_version: 1 as const,
    report_id: `tvr-${trajectorySha256({ request_id: request.request_id, source_receipt_hash: request.source_receipt_hash }).slice(0, 32)}`,
    request_id: request.request_id,
    scenario_id: request.scenario_id,
    source_receipt_id: request.source_receipt_id,
    source_receipt_hash: request.source_receipt_hash,
    verifier_model_id: request.verifier_model_id,
    verifier_prompt_sha256: request.verifier_prompt_sha256,
    verifier_history_sha256: request.verifier_history_sha256,
    rubric_sha256: request.rubric_sha256,
    claims,
    qualitative_evidence: structuredClone(request.redacted_observations.qualitative_evidence),
    reproduction_ratio: reproductionRatio,
    confidence: reproductionRatio * request.redacted_observations.qualitative_evidence.confidence,
    unresolved_uncertainty: unresolved,
    boundary_observations: boundary,
    disposition: complete ? "PASS" as const : "HOLD" as const,
    report_hash: "0".repeat(64),
  };
  return { ...base, report_hash: computeTrajectoryReportHash(base) };
}

export function buildTrajectoryHoldReport(
  request: TrajectoryVerifierRequest,
  reason: string,
  boundary: Partial<TrajectoryBoundaryObservations> = {},
): TrajectoryVerifierReport {
  const claims = request.claims.map((claim): TrajectoryClaimResult => ({
    ...claim,
    observed: null,
    reproduced: false,
    reproduced_evidence_sha256: trajectorySha256({ claim_id: claim.claim_id, observed: null, source_receipt_hash: request.source_receipt_hash }),
  }));
  const observations: TrajectoryBoundaryObservations = {
    environment_secret_free: boundary.environment_secret_free ?? false,
    loopback_only: boundary.loopback_only ?? true,
    generator_root_absent: boundary.generator_root_absent ?? true,
    answer_fields_absent: boundary.answer_fields_absent ?? true,
  };
  const base: TrajectoryVerifierReport = {
    schema_version: 1,
    report_id: `tvr-${trajectorySha256({ request_id: request.request_id, source_receipt_hash: request.source_receipt_hash }).slice(0, 32)}`,
    request_id: request.request_id,
    scenario_id: request.scenario_id,
    source_receipt_id: request.source_receipt_id,
    source_receipt_hash: request.source_receipt_hash,
    verifier_model_id: request.verifier_model_id,
    verifier_prompt_sha256: request.verifier_prompt_sha256,
    verifier_history_sha256: request.verifier_history_sha256,
    rubric_sha256: request.rubric_sha256,
    claims,
    qualitative_evidence: structuredClone(request.redacted_observations.qualitative_evidence),
    reproduction_ratio: 0,
    confidence: 0,
    unresolved_uncertainty: [reason],
    boundary_observations: observations,
    disposition: "HOLD",
    report_hash: "0".repeat(64),
  };
  return { ...base, report_hash: computeTrajectoryReportHash(base) };
}

export function parseTrajectoryVerifierReport(value: unknown): TrajectoryVerifierReport {
  if (!isObject(value)) throw new Error("trajectory report must be an object");
  exactKeys(value, REPORT_KEYS, "trajectory report");
  if (value.schema_version !== 1) throw new Error("trajectory report schema_version must be 1");
  if (!Array.isArray(value.claims) || value.claims.length === 0) throw new Error("trajectory report claims are required");
  const claims = value.claims.map((entry, index): TrajectoryClaimResult => {
    if (!isObject(entry)) throw new Error(`report claims[${index}] must be an object`);
    exactKeys(entry, CLAIM_RESULT_KEYS, `report claims[${index}]`);
    const claim = parseClaim({
      claim_id: entry.claim_id,
      field: entry.field,
      expected: entry.expected,
      evidence_sha256: entry.evidence_sha256,
    }, index);
    if (entry.observed !== null) primitive(entry.observed, `report claims[${index}].observed`);
    if (typeof entry.reproduced !== "boolean") throw new Error(`report claims[${index}].reproduced is invalid`);
    return { ...claim, observed: entry.observed as TrajectoryPrimitive | null, reproduced: entry.reproduced, reproduced_evidence_sha256: hash(entry.reproduced_evidence_sha256, `report claims[${index}].reproduced_evidence_sha256`) };
  });
  if (!isObject(value.boundary_observations)) throw new Error("trajectory report boundary_observations must be an object");
  const boundaryRaw = value.boundary_observations;
  exactKeys(boundaryRaw, BOUNDARY_KEYS, "boundary_observations");
  const boundary = Object.fromEntries([...BOUNDARY_KEYS].map((key) => {
    if (typeof boundaryRaw[key] !== "boolean") throw new Error(`boundary_observations.${key} is invalid`);
    return [key, boundaryRaw[key]];
  })) as unknown as TrajectoryBoundaryObservations;
  if (!Array.isArray(value.unresolved_uncertainty) || value.unresolved_uncertainty.some((entry) => typeof entry !== "string" || entry.trim() === "" || SECRET_VALUE.test(entry))) {
    throw new Error("trajectory report unresolved_uncertainty is invalid");
  }
  if (value.disposition !== "PASS" && value.disposition !== "HOLD") throw new Error("trajectory report disposition is invalid");
  const report: TrajectoryVerifierReport = {
    schema_version: 1,
    report_id: text(value.report_id, "report_id"),
    request_id: text(value.request_id, "request_id"),
    scenario_id: text(value.scenario_id, "scenario_id"),
    source_receipt_id: text(value.source_receipt_id, "source_receipt_id"),
    source_receipt_hash: hash(value.source_receipt_hash, "source_receipt_hash"),
    verifier_model_id: text(value.verifier_model_id, "verifier_model_id"),
    verifier_prompt_sha256: hash(value.verifier_prompt_sha256, "verifier_prompt_sha256"),
    verifier_history_sha256: hash(value.verifier_history_sha256, "verifier_history_sha256"),
    rubric_sha256: hash(value.rubric_sha256, "rubric_sha256"),
    claims,
    qualitative_evidence: parseQualitative(value.qualitative_evidence),
    reproduction_ratio: finiteRatio(value.reproduction_ratio, "reproduction_ratio"),
    confidence: finiteRatio(value.confidence, "confidence"),
    unresolved_uncertainty: [...value.unresolved_uncertainty] as string[],
    boundary_observations: boundary,
    disposition: value.disposition,
    report_hash: hash(value.report_hash, "report_hash"),
  };
  if (report.report_hash !== computeTrajectoryReportHash(report)) throw new Error("trajectory report hash mismatch");
  return report;
}
