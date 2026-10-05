import { createHash } from "node:crypto";
import { canonicalize, REDACTED_VALUE } from "./run-receipt-contract";

export const EDGE_PROOF_CONTRACT_ID = "zouroboros-edge-proof-record/v1" as const;
export const MAX_EDGE_PROOF_POLL_ATTEMPTS = 12;
export const MAX_EDGE_PROOF_OBSERVATIONS = 16;
export const MAX_EDGE_PROOF_TOTAL_POLL_MS = 300_000;
export const MAX_EDGE_PROOF_BUNDLE_BYTES = 8 * 1024;

export const EDGE_PROOF_REQUIREMENTS = ["required", "notApplicable"] as const;
export const EDGE_PROOF_CLASSIFICATIONS = ["required", "notApplicable", "unavailable"] as const;
export const EDGE_ACKNOWLEDGEMENT_TIERS = ["none", "transport_accepted", "durable_confirmed", "user_visible_confirmed"] as const;
export const EDGE_ADAPTER_KINDS = ["github", "linear", "workspace"] as const;

export type EdgeProofRequirement = typeof EDGE_PROOF_REQUIREMENTS[number];
export type EdgeProofClassification = typeof EDGE_PROOF_CLASSIFICATIONS[number];
export type EdgeAcknowledgementTier = typeof EDGE_ACKNOWLEDGEMENT_TIERS[number];
export type EdgeAdapterKind = typeof EDGE_ADAPTER_KINDS[number];
export type EdgeProbeStatus = "confirmed" | "retryable" | "unavailable";

const HASH = /^[0-9a-f]{64}$/;
const SECRET_KEY = /(^|[_-])(secret|password|token|api[_-]?key|authorization|cookie)([_-]|$)/i;
const NETWORK_LOCATION = /https?:\/\//i;
const OPAQUE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FORBIDDEN_URI_SCHEME = /^(?:data|file|ftp|ftps|mailto|ssh|urn):/i;
const SECRET_TARGET_SEGMENT = /(^|[:_-])(secret|password|token|api[-_]?key|authorization|cookie)([:_-]|$)/i;
const SENSITIVE_BINDING = /(^|[:_-])(secret|password|token|api[_-]?key|authorization|cookie)([:_-]|$)/i;

export class EdgeProofError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EdgeProofError";
  }
}

export interface EdgeProofPlanInput {
  operationId: string;
  traceId: string;
  actorHash: string;
  verifierIdentityHash: string;
  adapterKind: EdgeAdapterKind;
  adapterVersion: string;
  targetId: string;
  expectedStateHash: string;
  requirement: EdgeProofRequirement;
  preRegisteredNoSideEffects: boolean;
  declaredExternalEffects: number;
  createdAt: string;
  deadline: string;
  maxAttempts: number;
  probeTimeoutMs: number;
  pollIntervalMs: number;
}

export interface EdgeProofPlan {
  contract_id: typeof EDGE_PROOF_CONTRACT_ID;
  plan_id: string;
  operation_id: string;
  trace_id: string;
  actor_hash: string;
  verifier_identity_hash: string;
  adapter: { kind: EdgeAdapterKind; version: string };
  target_ref: string;
  target_hash: string;
  expected_state_hash: string;
  requirement: EdgeProofRequirement;
  pre_registered_no_side_effects: boolean;
  declared_external_effects: number;
  created_at: string;
  deadline: string;
  max_attempts: number;
  probe_timeout_ms: number;
  poll_interval_ms: number;
  plan_hash: string;
}

export interface EdgeReadAuthority {
  scopes: string[];
  expiresAt: string | null;
}

export interface EdgeProbeRequest {
  operationId: string;
  traceId: string;
  actorHash: string;
  planCreatedAt: string;
  targetRef: string;
  targetHash: string;
  expectedStateHash: string;
  attempt: number;
  timeoutMs: number;
}

export interface EdgeProbeResponse {
  status: EdgeProbeStatus;
  acknowledgementTier: EdgeAcknowledgementTier;
  operationId: string;
  actorHash: string;
  targetHash: string;
  observedStateHash: string | null;
  observedAt: string;
  sourceRevision: string | null;
  providerEventId: string | null;
  payloadHash: string | null;
  reasonCode: string | null;
}

export interface EdgeProofAdapter {
  readonly kind: EdgeAdapterKind;
  readonly version: string;
  probe(request: Readonly<EdgeProbeRequest>): EdgeProbeResponse | Promise<EdgeProbeResponse>;
}

export interface EdgeProofObservation {
  observation_id: string;
  plan_id: string;
  attempt: number;
  status: EdgeProbeStatus;
  acknowledgement_tier: EdgeAcknowledgementTier;
  operation_id: string;
  actor_hash: string;
  target_hash: string;
  expected_state_hash: string;
  observed_state_hash: string | null;
  observed_at: string;
  source_revision: string | null;
  provider_event_id: string | null;
  payload_hash: string | null;
  reason_code: string | null;
  predecessor_hash: string | null;
  next_poll_at: string | null;
  observation_hash: string;
}

export interface EdgeProofReceiptBinding {
  receiptId: string;
  receiptHash: string;
  terminalEventId: string;
  terminalSourceRef: string;
}

export interface EdgeProofRecord {
  contract_id: typeof EDGE_PROOF_CONTRACT_ID;
  record_id: string;
  plan_id: string;
  proof_id: string;
  operation_id: string;
  trace_id: string;
  actor_hash: string;
  verifier: { adapter: EdgeAdapterKind; version: string; identity_hash: string };
  target_hash: string;
  expected_state_hash: string;
  observed_state_hash: string | null;
  receipt_id: string;
  receipt_hash: string;
  terminal_event_id: string;
  terminal_source_ref: string;
  classification: EdgeProofClassification;
  acknowledgement_tier: EdgeAcknowledgementTier;
  timeliness: "within_deadline" | "late" | "not_applicable";
  observed_at: string | null;
  source_revision: string | null;
  provider_event_id: string | null;
  payload_hash: string | null;
  redaction: { manifest: string[]; raw_provider_response_persisted: false };
  predecessor_record_hash: string | null;
  record_hash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableId(prefix: string, value: string): string {
  return `${prefix}${sha256(value).slice(0, 26).toUpperCase()}`;
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new EdgeProofError("timestamp_invalid", `${label} must be RFC 3339`);
  return parsed;
}

function assertHash(value: string, label: string): void {
  if (!HASH.test(value)) throw new EdgeProofError("hash_invalid", `${label} must be lowercase SHA-256`);
}

function assertOpaqueBinding(value: string | null, label: string): void {
  if (value === null) return;
  if (!value || value.length > 256) throw new EdgeProofError("source_binding_invalid", `${label} must contain 1-256 characters`);
  if (!OPAQUE_TARGET.test(value) || NETWORK_LOCATION.test(value) || FORBIDDEN_URI_SCHEME.test(value) || value.includes("..") || SENSITIVE_BINDING.test(value)) {
    throw new EdgeProofError("source_binding_sensitive", `${label} must be an opaque non-sensitive identifier`);
  }
}

function assertOpaqueTargetRef(value: string): void {
  if (!value || value.length > 256) throw new EdgeProofError("target_ref_invalid", "target ref must contain 1-256 characters");
  if (
    !OPAQUE_TARGET.test(value)
    || NETWORK_LOCATION.test(value)
    || FORBIDDEN_URI_SCHEME.test(value)
    || SECRET_TARGET_SEGMENT.test(value)
    || value.includes("..")
    || SENSITIVE_BINDING.test(value)
    || value.split(":").some((segment) => segment.length === 0)
  ) {
    throw new EdgeProofError("target_ref_sensitive", "target ref must be opaque and cannot contain a URL, path, or control character");
  }
}

function assertNoSecretFields(value: unknown, path = ""): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecretFields(item, `${path}/${index}`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && child !== REDACTED_VALUE) throw new EdgeProofError("secret_unredacted", `secret-like field at ${path}/${key}`);
    assertNoSecretFields(child, `${path}/${key}`);
  }
}

function canonicalHash<T extends { [key: string]: unknown }>(value: T, hashKey: keyof T): string {
  const copy = structuredClone(value);
  delete copy[hashKey];
  return sha256(canonicalize(copy));
}

export function hashEdgeTarget(targetId: string): string {
  assertOpaqueTargetRef(targetId);
  return sha256(targetId);
}

export function createEdgeProofPlan(input: EdgeProofPlanInput): EdgeProofPlan {
  if (!input.operationId.startsWith("op-") || !input.traceId || !input.adapterVersion) throw new EdgeProofError("plan_invalid", "operation, trace, and adapter version are required");
  assertHash(input.actorHash, "actorHash");
  assertHash(input.verifierIdentityHash, "verifierIdentityHash");
  if (input.verifierIdentityHash === input.actorHash) throw new EdgeProofError("verifier_not_independent", "verifier identity must differ from the operation actor");
  assertHash(input.expectedStateHash, "expectedStateHash");
  if (!EDGE_ADAPTER_KINDS.includes(input.adapterKind)) throw new EdgeProofError("adapter_unregistered", `unsupported adapter ${input.adapterKind}`);
  if (!EDGE_PROOF_REQUIREMENTS.includes(input.requirement)) throw new EdgeProofError("requirement_invalid", `unsupported requirement ${input.requirement}`);
  if (input.requirement === "notApplicable" && (!input.preRegisteredNoSideEffects || input.declaredExternalEffects !== 0)) {
    throw new EdgeProofError("not_applicable_forbidden", "notApplicable requires a preregistered no-side-effect operation");
  }
  if (input.requirement === "required" && input.preRegisteredNoSideEffects) throw new EdgeProofError("plan_contradiction", "required proof cannot claim the no-side-effect exemption");
  if (!Number.isInteger(input.declaredExternalEffects) || input.declaredExternalEffects < 0) throw new EdgeProofError("effects_invalid", "declared external effects must be a non-negative integer");
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_EDGE_PROOF_POLL_ATTEMPTS) throw new EdgeProofError("attempts_invalid", `max attempts must be 1-${MAX_EDGE_PROOF_POLL_ATTEMPTS}`);
  if (!Number.isInteger(input.probeTimeoutMs) || input.probeTimeoutMs < 1 || input.probeTimeoutMs > 30_000) throw new EdgeProofError("timeout_invalid", "probe timeout must be 1-30000ms");
  if (!Number.isInteger(input.pollIntervalMs) || input.pollIntervalMs < 0 || input.pollIntervalMs > 300_000) throw new EdgeProofError("poll_interval_invalid", "poll interval must be 0-300000ms");
  const totalPollMs = parseTime(input.deadline, "deadline") - parseTime(input.createdAt, "createdAt");
  if (totalPollMs < 0) throw new EdgeProofError("deadline_invalid", "deadline precedes plan creation");
  if (totalPollMs > MAX_EDGE_PROOF_TOTAL_POLL_MS) throw new EdgeProofError("deadline_invalid", "proof deadline exceeds the 300000ms total polling ceiling");
  const targetHash = hashEdgeTarget(input.targetId);
  const draft: EdgeProofPlan = {
    contract_id: EDGE_PROOF_CONTRACT_ID,
    plan_id: stableId("epp-", `${input.operationId}\0${targetHash}`),
    operation_id: input.operationId,
    trace_id: input.traceId,
    actor_hash: input.actorHash,
    verifier_identity_hash: input.verifierIdentityHash,
    adapter: { kind: input.adapterKind, version: input.adapterVersion },
    target_ref: input.targetId,
    target_hash: targetHash,
    expected_state_hash: input.expectedStateHash,
    requirement: input.requirement,
    pre_registered_no_side_effects: input.preRegisteredNoSideEffects,
    declared_external_effects: input.declaredExternalEffects,
    created_at: input.createdAt,
    deadline: input.deadline,
    max_attempts: input.maxAttempts,
    probe_timeout_ms: input.probeTimeoutMs,
    poll_interval_ms: input.pollIntervalMs,
    plan_hash: "0".repeat(64),
  };
  draft.plan_hash = canonicalHash(draft as unknown as Record<string, unknown>, "plan_hash");
  if (Buffer.byteLength(canonicalize(draft), "utf8") > MAX_EDGE_PROOF_BUNDLE_BYTES) throw new EdgeProofError("bundle_too_large", "canonical edge proof plan exceeds 8 KiB");
  return draft;
}

export function validateEdgeProofPlan(plan: EdgeProofPlan): void {
  if (plan.contract_id !== EDGE_PROOF_CONTRACT_ID) throw new EdgeProofError("contract_invalid", "edge proof plan contract id is invalid");
  if (!plan.operation_id.startsWith("op-") || !plan.trace_id || !plan.adapter.version) throw new EdgeProofError("plan_invalid", "operation, trace, and adapter version are required");
  if (!EDGE_ADAPTER_KINDS.includes(plan.adapter.kind)) throw new EdgeProofError("adapter_unregistered", `unsupported adapter ${plan.adapter.kind}`);
  if (!EDGE_PROOF_REQUIREMENTS.includes(plan.requirement)) throw new EdgeProofError("requirement_invalid", `unsupported requirement ${plan.requirement}`);
  assertHash(plan.actor_hash, "actorHash");
  assertHash(plan.verifier_identity_hash, "verifierIdentityHash");
  if (plan.verifier_identity_hash === plan.actor_hash) throw new EdgeProofError("verifier_not_independent", "verifier identity must differ from the operation actor");
  assertHash(plan.target_hash, "targetHash");
  assertOpaqueTargetRef(plan.target_ref);
  if (hashEdgeTarget(plan.target_ref) !== plan.target_hash) throw new EdgeProofError("target_mismatch", "target ref does not match target hash");
  assertHash(plan.expected_state_hash, "expectedStateHash");
  if (plan.requirement === "notApplicable" && (!plan.pre_registered_no_side_effects || plan.declared_external_effects !== 0)) throw new EdgeProofError("not_applicable_forbidden", "notApplicable requires a preregistered no-side-effect operation");
  if (plan.requirement === "required" && plan.pre_registered_no_side_effects) throw new EdgeProofError("plan_contradiction", "required proof cannot claim the no-side-effect exemption");
  if (!Number.isInteger(plan.max_attempts) || plan.max_attempts < 1 || plan.max_attempts > MAX_EDGE_PROOF_POLL_ATTEMPTS) throw new EdgeProofError("attempts_invalid", "plan attempt budget is out of bounds");
  if (!Number.isInteger(plan.probe_timeout_ms) || plan.probe_timeout_ms < 1 || plan.probe_timeout_ms > 30_000) throw new EdgeProofError("timeout_invalid", "plan probe timeout is out of bounds");
  if (!Number.isInteger(plan.poll_interval_ms) || plan.poll_interval_ms < 0 || plan.poll_interval_ms > MAX_EDGE_PROOF_TOTAL_POLL_MS) throw new EdgeProofError("poll_interval_invalid", "plan poll interval is out of bounds");
  const totalPollMs = parseTime(plan.deadline, "deadline") - parseTime(plan.created_at, "createdAt");
  if (totalPollMs < 0) throw new EdgeProofError("deadline_invalid", "deadline precedes plan creation");
  if (totalPollMs > MAX_EDGE_PROOF_TOTAL_POLL_MS) throw new EdgeProofError("deadline_invalid", "proof deadline exceeds the 300000ms total polling ceiling");
  if (plan.plan_hash !== canonicalHash(plan as unknown as Record<string, unknown>, "plan_hash")) throw new EdgeProofError("plan_hash_mismatch", "edge proof plan hash does not match canonical content");
  assertNoSecretFields(plan);
  if (Buffer.byteLength(canonicalize(plan), "utf8") > MAX_EDGE_PROOF_BUNDLE_BYTES) throw new EdgeProofError("bundle_too_large", "canonical edge proof plan exceeds 8 KiB");
}

function unavailableObservation(plan: EdgeProofPlan, prior: readonly EdgeProofObservation[], now: string, reasonCode: string): EdgeProofObservation {
  return finalizeObservation(plan, prior, {
    status: "unavailable",
    acknowledgementTier: "none",
    operationId: plan.operation_id,
    actorHash: plan.actor_hash,
    targetHash: plan.target_hash,
    observedStateHash: null,
    observedAt: now,
    sourceRevision: null,
    providerEventId: null,
    payloadHash: null,
    reasonCode,
  }, null);
}

function finalizeObservation(
  plan: EdgeProofPlan,
  prior: readonly EdgeProofObservation[],
  response: EdgeProbeResponse,
  nextPollAt: string | null,
): EdgeProofObservation {
  const attempt = prior.length + 1;
  const predecessor = prior.at(-1)?.observation_hash ?? null;
  const draft: EdgeProofObservation = {
    observation_id: stableId("epo-", `${plan.plan_id}\0${attempt}\0${canonicalize(response)}`),
    plan_id: plan.plan_id,
    attempt,
    status: response.status,
    acknowledgement_tier: response.acknowledgementTier,
    operation_id: response.operationId,
    actor_hash: response.actorHash,
    target_hash: response.targetHash,
    expected_state_hash: plan.expected_state_hash,
    observed_state_hash: response.observedStateHash,
    observed_at: response.observedAt,
    source_revision: response.sourceRevision,
    provider_event_id: response.providerEventId,
    payload_hash: response.payloadHash,
    reason_code: response.reasonCode,
    predecessor_hash: predecessor,
    next_poll_at: nextPollAt,
    observation_hash: "0".repeat(64),
  };
  assertNoSecretFields(draft);
  draft.observation_hash = canonicalHash(draft as unknown as Record<string, unknown>, "observation_hash");
  if (Buffer.byteLength(canonicalize(draft), "utf8") > MAX_EDGE_PROOF_BUNDLE_BYTES) throw new EdgeProofError("bundle_too_large", "canonical edge proof observation exceeds 8 KiB");
  return draft;
}

function validateProbeResponse(plan: EdgeProofPlan, response: EdgeProbeResponse): void {
  if (!EDGE_ACKNOWLEDGEMENT_TIERS.includes(response.acknowledgementTier)) throw new EdgeProofError("tier_invalid", "adapter returned an invalid acknowledgement tier");
  if (response.operationId !== plan.operation_id) throw new EdgeProofError("operation_mismatch", "readback operation does not match plan");
  if (response.actorHash !== plan.actor_hash) throw new EdgeProofError("actor_mismatch", "readback actor does not match plan");
  if (response.targetHash !== plan.target_hash) throw new EdgeProofError("target_mismatch", "readback target does not match plan");
  if (response.observedStateHash) assertHash(response.observedStateHash, "observedStateHash");
  if (response.payloadHash) assertHash(response.payloadHash, "payloadHash");
  assertOpaqueBinding(response.sourceRevision, "sourceRevision");
  assertOpaqueBinding(response.providerEventId, "providerEventId");
  assertOpaqueBinding(response.reasonCode, "reasonCode");
  parseTime(response.observedAt, "observedAt");
  if (parseTime(response.observedAt, "observedAt") < parseTime(plan.created_at, "createdAt")) throw new EdgeProofError("stale_observation", "readback predates the frozen proof plan");
  if (response.status === "confirmed") {
    if (!response.observedStateHash || response.observedStateHash !== plan.expected_state_hash) throw new EdgeProofError("result_mismatch", "confirmed readback does not match expected state");
    if (!response.sourceRevision && !response.providerEventId && !response.payloadHash) throw new EdgeProofError("source_binding_missing", "confirmed readback requires an immutable source binding");
  }
  if (response.status !== "confirmed" && ["durable_confirmed", "user_visible_confirmed"].includes(response.acknowledgementTier)) {
    throw new EdgeProofError("tier_invalid", "unconfirmed readback cannot claim durable or user-visible confirmation");
  }
}

export function recordLateEdgeConfirmation(
  plan: EdgeProofPlan,
  prior: readonly EdgeProofObservation[],
  response: EdgeProbeResponse,
): EdgeProofObservation {
  validateEdgeProofPlan(plan);
  if (prior.at(-1)?.status === "confirmed") throw new EdgeProofError("already_confirmed", "edge proof is already confirmed");
  if (plan.requirement !== "required") throw new EdgeProofError("not_applicable_forbidden", "notApplicable plan cannot receive late confirmation");
  if (prior.length >= MAX_EDGE_PROOF_OBSERVATIONS) throw new EdgeProofError("attempts_exhausted", "edge proof observation budget is exhausted");
  validateProbeResponse(plan, response);
  if (response.status !== "confirmed") throw new EdgeProofError("late_confirmation_invalid", "late supplement requires confirmed readback");
  if (parseTime(response.observedAt, "observedAt") <= parseTime(plan.deadline, "deadline")) throw new EdgeProofError("late_confirmation_invalid", "late supplement must arrive after the proof deadline");
  return finalizeObservation(plan, prior, response, null);
}

export async function probeEdgeOnce(
  plan: EdgeProofPlan,
  prior: readonly EdgeProofObservation[],
  adapter: EdgeProofAdapter,
  authority: EdgeReadAuthority,
  now: string,
): Promise<EdgeProofObservation> {
  validateEdgeProofPlan(plan);
  if (plan.requirement === "notApplicable") return unavailableObservation(plan, prior, now, "not_applicable_no_probe");
  if (prior.length >= plan.max_attempts || prior.length >= MAX_EDGE_PROOF_POLL_ATTEMPTS) throw new EdgeProofError("attempts_exhausted", "edge proof attempt budget is exhausted");
  const previous = prior.at(-1);
  if (previous?.status === "confirmed") throw new EdgeProofError("already_confirmed", "edge proof is already confirmed");
  if (previous && previous.status !== "retryable") throw new EdgeProofError("non_retryable_observation", "only a transient retryable observation may advance polling");
  const nowMs = parseTime(now, "now");
  if (nowMs > parseTime(plan.deadline, "deadline")) return unavailableObservation(plan, prior, now, "deadline_exhausted");
  const requiredScope = `observe:${plan.adapter.kind}`;
  if ((!authority.scopes.includes("*") && !authority.scopes.includes(requiredScope)) || (authority.expiresAt && parseTime(authority.expiresAt, "authority.expiresAt") <= nowMs)) {
    return unavailableObservation(plan, prior, now, "read_authority_unavailable");
  }
  if (adapter.kind !== plan.adapter.kind || adapter.version !== plan.adapter.version) return unavailableObservation(plan, prior, now, "adapter_mismatch");
  const nextDue = prior.at(-1)?.next_poll_at;
  if (nextDue && nowMs < parseTime(nextDue, "nextPollAt")) throw new EdgeProofError("poll_not_due", "persisted next_poll_at has not elapsed");

  const request: EdgeProbeRequest = {
    operationId: plan.operation_id,
    traceId: plan.trace_id,
    actorHash: plan.actor_hash,
    planCreatedAt: plan.created_at,
    targetRef: plan.target_ref,
    targetHash: plan.target_hash,
    expectedStateHash: plan.expected_state_hash,
    attempt: prior.length + 1,
    timeoutMs: plan.probe_timeout_ms,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      Promise.resolve(adapter.probe(Object.freeze(request))),
      new Promise<EdgeProbeResponse>((_, reject) => { timer = setTimeout(() => reject(new EdgeProofError("probe_timeout", "edge readback timed out")), plan.probe_timeout_ms); }),
    ]);
    validateProbeResponse(plan, response);
    const retry = response.status === "retryable" && prior.length + 1 < plan.max_attempts;
    const nextPollAt = retry ? new Date(nowMs + plan.poll_interval_ms).toISOString() : null;
    return finalizeObservation(plan, prior, response, nextPollAt);
  } catch (error) {
    const code = error instanceof EdgeProofError ? error.code : "probe_unavailable";
    return unavailableObservation(plan, prior, now, code);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function validateEdgeProofObservation(plan: EdgeProofPlan, observation: EdgeProofObservation): void {
  if (observation.plan_id !== plan.plan_id) throw new EdgeProofError("plan_mismatch", "observation belongs to another plan");
  if (observation.operation_id !== plan.operation_id) throw new EdgeProofError("operation_mismatch", "observation operation does not match plan");
  if (observation.actor_hash !== plan.actor_hash) throw new EdgeProofError("actor_mismatch", "observation actor does not match plan");
  if (observation.target_hash !== plan.target_hash) throw new EdgeProofError("target_mismatch", "observation target does not match plan");
  if (observation.expected_state_hash !== plan.expected_state_hash) throw new EdgeProofError("result_mismatch", "observation expected state does not match plan");
  if (observation.attempt < 1 || observation.attempt > MAX_EDGE_PROOF_OBSERVATIONS) throw new EdgeProofError("attempts_invalid", "observation attempt is out of bounds");
  assertNoSecretFields(observation);
  if (observation.observation_hash !== canonicalHash(observation as unknown as Record<string, unknown>, "observation_hash")) {
    throw new EdgeProofError("observation_hash_mismatch", "observation hash does not match canonical content");
  }
  if (observation.status === "confirmed" && (observation.observed_state_hash !== plan.expected_state_hash || observation.acknowledgement_tier === "none")) {
    throw new EdgeProofError("result_mismatch", "confirmed observation is not bound to the expected state");
  }
}

export function buildEdgeProofRecord(
  plan: EdgeProofPlan,
  receipt: EdgeProofReceiptBinding,
  observation: EdgeProofObservation | null,
  predecessorRecordHash: string | null,
): EdgeProofRecord {
  validateEdgeProofPlan(plan);
  assertHash(receipt.receiptHash, "receiptHash");
  if (predecessorRecordHash) assertHash(predecessorRecordHash, "predecessorRecordHash");
  if (plan.requirement === "required" && !observation) throw new EdgeProofError("observation_required", "required proof record needs an observation");
  if (observation && observation.plan_id !== plan.plan_id) throw new EdgeProofError("plan_mismatch", "observation belongs to another plan");
  const classification: EdgeProofClassification = plan.requirement === "notApplicable"
    ? "notApplicable"
    : observation?.status === "confirmed" ? "required" : "unavailable";
  const timeliness = classification === "notApplicable"
    ? "not_applicable"
    : observation && parseTime(observation.observed_at, "observedAt") <= parseTime(plan.deadline, "deadline") ? "within_deadline" : "late";
  const draft: EdgeProofRecord = {
    contract_id: EDGE_PROOF_CONTRACT_ID,
    record_id: "",
    plan_id: plan.plan_id,
    proof_id: "",
    operation_id: plan.operation_id,
    trace_id: plan.trace_id,
    actor_hash: plan.actor_hash,
    verifier: { adapter: plan.adapter.kind, version: plan.adapter.version, identity_hash: plan.verifier_identity_hash },
    target_hash: plan.target_hash,
    expected_state_hash: plan.expected_state_hash,
    observed_state_hash: observation?.observed_state_hash ?? null,
    receipt_id: receipt.receiptId,
    receipt_hash: receipt.receiptHash,
    terminal_event_id: receipt.terminalEventId,
    terminal_source_ref: receipt.terminalSourceRef,
    classification,
    acknowledgement_tier: classification === "notApplicable" ? "none" : observation?.acknowledgement_tier ?? "none",
    timeliness,
    observed_at: observation?.observed_at ?? null,
    source_revision: observation?.source_revision ?? null,
    provider_event_id: observation?.provider_event_id ?? null,
    payload_hash: observation?.payload_hash ?? null,
    redaction: { manifest: ["target_id", "raw_provider_response", "credentials", "payload_body"], raw_provider_response_persisted: false },
    predecessor_record_hash: predecessorRecordHash,
    record_hash: "0".repeat(64),
  };
  draft.proof_id = stableId("proof-", `${plan.plan_id}\0${observation?.observation_hash ?? "notApplicable"}`);
  draft.record_id = stableId("epr-", `${receipt.receiptHash}\0${draft.proof_id}\0${predecessorRecordHash ?? "root"}`);
  assertNoSecretFields(draft);
  draft.record_hash = canonicalHash(draft as unknown as Record<string, unknown>, "record_hash");
  if (Buffer.byteLength(canonicalize(draft), "utf8") > MAX_EDGE_PROOF_BUNDLE_BYTES) throw new EdgeProofError("bundle_too_large", "canonical edge proof exceeds 8 KiB");
  return draft;
}

export function validateEdgeProofRecord(record: EdgeProofRecord): void {
  if (record.contract_id !== EDGE_PROOF_CONTRACT_ID) throw new EdgeProofError("contract_invalid", "edge proof contract id is invalid");
  if (!EDGE_PROOF_CLASSIFICATIONS.includes(record.classification)) throw new EdgeProofError("classification_invalid", "edge proof classification is invalid");
  if (!EDGE_ACKNOWLEDGEMENT_TIERS.includes(record.acknowledgement_tier)) throw new EdgeProofError("tier_invalid", "edge proof tier is invalid");
  if (!["within_deadline", "late", "not_applicable"].includes(record.timeliness)) throw new EdgeProofError("timeliness_invalid", "edge proof timeliness is invalid");
  assertHash(record.actor_hash, "actorHash");
  assertHash(record.verifier.identity_hash, "verifierIdentityHash");
  assertHash(record.target_hash, "targetHash");
  assertHash(record.expected_state_hash, "expectedStateHash");
  if (record.observed_state_hash) assertHash(record.observed_state_hash, "observedStateHash");
  assertHash(record.receipt_hash, "receiptHash");
  if (record.payload_hash) assertHash(record.payload_hash, "payloadHash");
  if (record.predecessor_record_hash) assertHash(record.predecessor_record_hash, "predecessorRecordHash");
  assertOpaqueBinding(record.source_revision, "sourceRevision");
  assertOpaqueBinding(record.provider_event_id, "providerEventId");
  assertNoSecretFields(record);
  if (record.record_hash !== canonicalHash(record as unknown as Record<string, unknown>, "record_hash")) throw new EdgeProofError("record_hash_mismatch", "edge proof record hash does not match canonical content");
  if (record.classification === "notApplicable" && (record.timeliness !== "not_applicable" || record.acknowledgement_tier !== "none")) throw new EdgeProofError("not_applicable_invalid", "notApplicable record cannot carry acknowledgement evidence");
  if (record.classification === "required" && record.observed_state_hash !== record.expected_state_hash) throw new EdgeProofError("result_mismatch", "required proof does not confirm the expected state");
  if (record.classification === "unavailable" && ["durable_confirmed", "user_visible_confirmed"].includes(record.acknowledgement_tier)) {
    throw new EdgeProofError("visibility_unproven", "unavailable proof cannot claim durable or user-visible confirmation");
  }
}

export function edgeBindingMetrics(records: readonly EdgeProofRecord[]): { numerator: number; denominator: number; ratio: number } {
  const denominator = records.filter((record) => record.classification !== "notApplicable").length;
  const numerator = records.filter((record) => record.classification === "required" && record.acknowledgement_tier === "user_visible_confirmed" && record.timeliness === "within_deadline").length;
  return { numerator, denominator, ratio: denominator === 0 ? 1 : numerator / denominator };
}

export interface NormalizedReadClient {
  read(request: Readonly<EdgeProbeRequest>): EdgeProbeResponse | Promise<EdgeProbeResponse>;
}

function createAdapter(kind: EdgeAdapterKind, version: string, client: NormalizedReadClient): EdgeProofAdapter {
  if (!version) throw new EdgeProofError("adapter_version_missing", "adapter version is required");
  return Object.freeze({ kind, version, probe: (request: Readonly<EdgeProbeRequest>) => client.read(request) });
}

export function createGitHubEdgeProofAdapter(version: string, client: NormalizedReadClient): EdgeProofAdapter {
  return createAdapter("github", version, client);
}

export function createLinearEdgeProofAdapter(version: string, client: NormalizedReadClient): EdgeProofAdapter {
  return createAdapter("linear", version, client);
}

export function createWorkspaceEdgeProofAdapter(version: string, client: NormalizedReadClient): EdgeProofAdapter {
  return createAdapter("workspace", version, client);
}
