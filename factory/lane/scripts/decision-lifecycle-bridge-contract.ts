import type { LifecycleDecision, LifecycleIssue, LifecycleState, SkillLifecycleRecord } from "../../../Skills/skill-security-gate/scripts/lifecycle/types.ts";
import { canonicalHash } from "../../../Skills/skill-security-gate/scripts/lifecycle/canonical.ts";
import { validateLifecycleRecord, validateLifecycleTransition } from "../../../Skills/skill-security-gate/scripts/lifecycle/gate.ts";
import {
  assertPromotionBoundary,
  parsePromotionSignature,
  parseSkillPromotionProtocol,
  parseSkillPromotionSummary,
  type PromotionDecision,
} from "./skill-promotion-decision-contract.ts";

export const DECISION_LIFECYCLE_BRIDGE_REQUEST = "decision-lifecycle-bridge-request/v1" as const;
export const DECISION_LIFECYCLE_SHADOW_OBSERVATION = "decision-lifecycle-shadow-observation/v1" as const;
export const DECISION_LIFECYCLE_BRIDGE_VERSION = "1.0.0" as const;
export const DECISION_LIFECYCLE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type DecisionLifecycleBridgeMode = "off" | "shadow";
export type DecisionLifecycleBridgeDisposition = "OFF" | "HOLD" | "WOULD_REQUEST_PROMOTION";

export interface DecisionLifecycleShadowRequest {
  schema: typeof DECISION_LIFECYCLE_BRIDGE_REQUEST;
  trace_id: string;
  observed_at: string;
  actor: {
    id: string;
    authority: "observe-only";
  };
  protocol: unknown;
  summary: unknown;
  signature: unknown;
  lifecycle_record: unknown;
}

export interface DecisionLifecycleShadowObservation {
  schema: typeof DECISION_LIFECYCLE_SHADOW_OBSERVATION;
  bridge_version: typeof DECISION_LIFECYCLE_BRIDGE_VERSION;
  trace_id: string;
  observed_at: string;
  actor: {
    id: string;
    authority: "observe-only";
  };
  source_decision: PromotionDecision;
  subject: {
    skill_slug: string;
    version: string;
    subject_sha256: string;
  };
  input_hashes: {
    protocol_sha256: string;
    summary_sha256: string;
    signature_sha256: string | null;
    lifecycle_revision_sha256: string;
  };
  requested_transition: {
    from: "approved";
    to: "promoted";
  } | null;
  lifecycle_dry_verdict: LifecycleDecision;
  lifecycle_issues: LifecycleIssue[];
  disposition: Exclude<DecisionLifecycleBridgeDisposition, "OFF">;
  reasons: string[];
  dedupe_key: string;
  authority: {
    promotion: false;
    quarantine: false;
    restore: false;
    install: false;
    routing: false;
    merge: false;
    approval: false;
  };
  observation_sha256: string;
}

export type DecisionLifecycleBridgeResult =
  | { mode: "off"; disposition: "OFF"; observation: null; reasons: [] }
  | {
      mode: "shadow";
      disposition: Exclude<DecisionLifecycleBridgeDisposition, "OFF">;
      observation: DecisionLifecycleShadowObservation | null;
      reasons: string[];
    };

const REQUEST_KEYS = new Set(["schema", "trace_id", "observed_at", "actor", "protocol", "summary", "signature", "lifecycle_record"]);
const ACTOR_KEYS = new Set(["id", "authority"]);
const LIFECYCLE_KEYS = new Set(["schemaVersion", "subjectHash", "identity", "state", "security", "evaluation"]);
const OBSERVATION_KEYS = new Set([
  "schema", "bridge_version", "trace_id", "observed_at", "actor", "source_decision", "subject",
  "input_hashes", "requested_transition", "lifecycle_dry_verdict", "lifecycle_issues", "disposition",
  "reasons", "dedupe_key", "authority", "observation_sha256",
]);
const SUBJECT_KEYS = new Set(["skill_slug", "version", "subject_sha256"]);
const INPUT_HASH_KEYS = new Set(["protocol_sha256", "summary_sha256", "signature_sha256", "lifecycle_revision_sha256"]);
const TRANSITION_KEYS = new Set(["from", "to"]);
const ISSUE_KEYS = new Set(["code", "disposition", "path", "message"]);
const AUTHORITY_KEYS = new Set(["promotion", "quarantine", "restore", "install", "routing", "merge", "approval"]);
const ID = /^[a-z0-9][a-z0-9._:-]{2,191}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${label} has unknown fields [${unknown}] or missing fields [${missing}]`);
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a bounded identifier`);
  return value;
}

function hash(value: unknown, label: string, prefixed = false): string {
  if (typeof value !== "string" || !(prefixed ? DIGEST : HASH).test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256${prefixed ? " digest" : ""}`);
  }
  return value;
}

function reasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512)) {
    throw new Error("observation.reasons must contain bounded strings");
  }
  return [...value] as string[];
}

function timestamp(value: unknown, label: string): { value: string; milliseconds: number } {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO timestamp`);
  return { value, milliseconds };
}

function hold(reason: string): DecisionLifecycleBridgeResult {
  return { mode: "shadow", disposition: "HOLD", observation: null, reasons: [reason] };
}

function lifecycleReason(issue: LifecycleIssue): string {
  return `${issue.code}:${issue.path || "record"}`;
}

function observationHash(value: Omit<DecisionLifecycleShadowObservation, "observation_sha256">): string {
  return canonicalHash(value);
}

export function parseDecisionLifecycleShadowObservation(value: unknown): DecisionLifecycleShadowObservation {
  assertPromotionBoundary(value, "decision_lifecycle_observation");
  const raw = record(value, "decision_lifecycle_observation");
  exactKeys(raw, OBSERVATION_KEYS, "decision_lifecycle_observation");
  if (raw.schema !== DECISION_LIFECYCLE_SHADOW_OBSERVATION || raw.bridge_version !== DECISION_LIFECYCLE_BRIDGE_VERSION) {
    throw new Error("decision lifecycle observation schema or version drift");
  }
  const actor = record(raw.actor, "decision_lifecycle_observation.actor");
  exactKeys(actor, ACTOR_KEYS, "decision_lifecycle_observation.actor");
  const parsedActor = {
    id: identifier(actor.id, "decision_lifecycle_observation.actor.id"),
    authority: actor.authority,
  };
  if (parsedActor.authority !== "observe-only") throw new Error("observation actor must remain observe-only");
  const subject = record(raw.subject, "decision_lifecycle_observation.subject");
  exactKeys(subject, SUBJECT_KEYS, "decision_lifecycle_observation.subject");
  const parsedSubject = {
    skill_slug: identifier(subject.skill_slug, "decision_lifecycle_observation.subject.skill_slug"),
    version: identifier(subject.version, "decision_lifecycle_observation.subject.version"),
    subject_sha256: hash(subject.subject_sha256, "decision_lifecycle_observation.subject.subject_sha256", true),
  };
  const inputHashes = record(raw.input_hashes, "decision_lifecycle_observation.input_hashes");
  exactKeys(inputHashes, INPUT_HASH_KEYS, "decision_lifecycle_observation.input_hashes");
  const parsedInputHashes = {
    protocol_sha256: hash(inputHashes.protocol_sha256, "decision_lifecycle_observation.input_hashes.protocol_sha256"),
    summary_sha256: hash(inputHashes.summary_sha256, "decision_lifecycle_observation.input_hashes.summary_sha256"),
    signature_sha256: inputHashes.signature_sha256 === null
      ? null
      : hash(inputHashes.signature_sha256, "decision_lifecycle_observation.input_hashes.signature_sha256"),
    lifecycle_revision_sha256: hash(inputHashes.lifecycle_revision_sha256, "decision_lifecycle_observation.input_hashes.lifecycle_revision_sha256", true),
  };
  let transition: DecisionLifecycleShadowObservation["requested_transition"] = null;
  if (raw.requested_transition !== null) {
    const parsedTransition = record(raw.requested_transition, "decision_lifecycle_observation.requested_transition");
    exactKeys(parsedTransition, TRANSITION_KEYS, "decision_lifecycle_observation.requested_transition");
    if (parsedTransition.from !== "approved" || parsedTransition.to !== "promoted") throw new Error("unknown requested lifecycle transition");
    transition = { from: "approved", to: "promoted" };
  }
  if (!Array.isArray(raw.lifecycle_issues)) throw new Error("observation lifecycle issues must be an array");
  const lifecycleIssues = raw.lifecycle_issues.map((entry, index): LifecycleIssue => {
    const parsed = record(entry, `decision_lifecycle_observation.lifecycle_issues[${index}]`);
    exactKeys(parsed, ISSUE_KEYS, `decision_lifecycle_observation.lifecycle_issues[${index}]`);
    const disposition = parsed.disposition;
    if (disposition !== "HOLD" && disposition !== "DENY") throw new Error(`invalid lifecycle issue disposition at ${index}`);
    return {
      code: identifier(parsed.code, `decision_lifecycle_observation.lifecycle_issues[${index}].code`),
      disposition,
      path: typeof parsed.path === "string" ? parsed.path : (() => { throw new Error(`invalid lifecycle issue path at ${index}`); })(),
      message: typeof parsed.message === "string" && parsed.message.length > 0 && parsed.message.length <= 512
        ? parsed.message
        : (() => { throw new Error(`invalid lifecycle issue message at ${index}`); })(),
    };
  });
  const authority = record(raw.authority, "decision_lifecycle_observation.authority");
  exactKeys(authority, AUTHORITY_KEYS, "decision_lifecycle_observation.authority");
  if (Object.values(authority).some((entry) => entry !== false)) throw new Error("observation grants forbidden lifecycle authority");
  if (!(["PROMOTION_RECOMMENDED", "HOLD", "DENY"] as unknown[]).includes(raw.source_decision)) throw new Error("unknown source decision");
  if (!(["PASS", "HOLD", "DENY"] as unknown[]).includes(raw.lifecycle_dry_verdict)) throw new Error("unknown lifecycle dry verdict");
  if (raw.disposition !== "HOLD" && raw.disposition !== "WOULD_REQUEST_PROMOTION") throw new Error("unknown bridge disposition");
  const parsedReasons = reasons(raw.reasons);
  if (raw.disposition === "WOULD_REQUEST_PROMOTION") {
    if (!transition || raw.source_decision !== "PROMOTION_RECOMMENDED" || raw.lifecycle_dry_verdict !== "PASS" || parsedReasons.length > 0 || lifecycleIssues.length > 0 || parsedInputHashes.signature_sha256 === null) {
      throw new Error("promotion request lacks a clean signed lifecycle PASS");
    }
  } else if (transition) throw new Error("HOLD observation cannot request a lifecycle transition");
  const expectedDedupe = canonicalHash({
    summary_sha256: parsedInputHashes.summary_sha256,
    signature_sha256: parsedInputHashes.signature_sha256,
    subject_sha256: parsedSubject.subject_sha256,
    lifecycle_revision_sha256: parsedInputHashes.lifecycle_revision_sha256,
  });
  if (hash(raw.dedupe_key, "decision_lifecycle_observation.dedupe_key", true) !== expectedDedupe) throw new Error("observation dedupe key drift");
  const parsed: DecisionLifecycleShadowObservation = {
    schema: DECISION_LIFECYCLE_SHADOW_OBSERVATION,
    bridge_version: DECISION_LIFECYCLE_BRIDGE_VERSION,
    trace_id: identifier(raw.trace_id, "decision_lifecycle_observation.trace_id"),
    observed_at: timestamp(raw.observed_at, "decision_lifecycle_observation.observed_at").value,
    actor: { id: parsedActor.id, authority: "observe-only" },
    source_decision: raw.source_decision as PromotionDecision,
    subject: parsedSubject,
    input_hashes: parsedInputHashes,
    requested_transition: transition,
    lifecycle_dry_verdict: raw.lifecycle_dry_verdict as LifecycleDecision,
    lifecycle_issues: lifecycleIssues,
    disposition: raw.disposition,
    reasons: parsedReasons,
    dedupe_key: expectedDedupe,
    authority: {
      promotion: false,
      quarantine: false,
      restore: false,
      install: false,
      routing: false,
      merge: false,
      approval: false,
    },
    observation_sha256: hash(raw.observation_sha256, "decision_lifecycle_observation.observation_sha256", true),
  };
  const { observation_sha256: parsedHash, ...parsedBody } = parsed;
  if (observationHash(parsedBody) !== parsedHash) throw new Error("observation hash drift");
  return parsed;
}

export function resolveDecisionLifecycleBridgeMode(value = process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE): DecisionLifecycleBridgeMode {
  if (value === undefined || value === "" || value === "off") return "off";
  if (value === "shadow") return "shadow";
  throw new Error(`unsupported decision-to-lifecycle bridge mode: ${value}`);
}

export function evaluateDecisionLifecycleShadow(input: unknown): DecisionLifecycleBridgeResult {
  try {
    assertPromotionBoundary(input, "decision_lifecycle_request");
    const request = record(input, "decision_lifecycle_request");
    exactKeys(request, REQUEST_KEYS, "decision_lifecycle_request");
    if (request.schema !== DECISION_LIFECYCLE_BRIDGE_REQUEST) throw new Error("decision lifecycle request schema drift");
    const traceId = identifier(request.trace_id, "decision_lifecycle_request.trace_id");
    const observedAt = timestamp(request.observed_at, "decision_lifecycle_request.observed_at");
    const actor = record(request.actor, "decision_lifecycle_request.actor");
    exactKeys(actor, ACTOR_KEYS, "decision_lifecycle_request.actor");
    const actorId = identifier(actor.id, "decision_lifecycle_request.actor.id");
    if (actor.authority !== "observe-only") throw new Error("bridge actor must remain observe-only");

    const protocol = parseSkillPromotionProtocol(request.protocol);
    const summary = parseSkillPromotionSummary(request.summary);
    const signature = parsePromotionSignature(request.signature);
    if (
      summary.protocol_id !== protocol.protocol_id
      || summary.protocol_sha256 !== protocol.protocol_sha256
      || summary.evidence_class !== protocol.evidence_class
    ) throw new Error("promotion summary is not bound to the exact protocol");
    const evaluatedAt = timestamp(protocol.evaluation_time, "protocol.evaluation_time");
    const age = observedAt.milliseconds - evaluatedAt.milliseconds;
    if (age < -5 * 60_000 || age > DECISION_LIFECYCLE_MAX_AGE_MS) throw new Error("promotion decision is stale or future-dated");
    if (summary.decision === "PROMOTION_RECOMMENDED") {
      if (!signature || !summary.human_signature_valid) throw new Error("promotion recommendation requires the exact human signature artifact");
      if (signature.evidence_preimage_sha256 !== summary.evidence_preimage_sha256) {
        throw new Error("promotion signature does not bind the exact decision evidence preimage");
      }
      const signedAt = timestamp(signature.signed_at, "signature.signed_at");
      if (signedAt.milliseconds < evaluatedAt.milliseconds || signedAt.milliseconds > observedAt.milliseconds + 5 * 60_000) {
        throw new Error("promotion signature timestamp is outside the decision observation window");
      }
    }

    const lifecycleRaw = record(request.lifecycle_record, "decision_lifecycle_request.lifecycle_record");
    exactKeys(lifecycleRaw, LIFECYCLE_KEYS, "decision_lifecycle_request.lifecycle_record");
    const identity = record(lifecycleRaw.identity, "decision_lifecycle_request.lifecycle_record.identity");
    const slug = identifier(identity.slug, "decision_lifecycle_request.lifecycle_record.identity.slug");
    const version = identifier(identity.version, "decision_lifecycle_request.lifecycle_record.identity.version");
    if (
      lifecycleRaw.subjectHash !== protocol.candidate_subject_sha256
      || slug !== protocol.skill_slug
      || version !== protocol.candidate_version
    ) throw new Error("promotion decision and lifecycle record do not bind the same exact skill subject");

    const lifecycleRevision = canonicalHash(lifecycleRaw);
    const lifecycle = validateLifecycleRecord(lifecycleRaw, { now: observedAt.value });
    const reasons = summary.decision === "PROMOTION_RECOMMENDED" ? [] : [`source-decision:${summary.decision}`];
    reasons.push(...summary.reasons.map((reason) => `source-reason:${reason}`));
    reasons.push(...lifecycle.issues.map(lifecycleReason));

    let dryVerdict: LifecycleDecision = lifecycle.decision;
    let requestedTransition: DecisionLifecycleShadowObservation["requested_transition"] = null;
    if (summary.decision === "PROMOTION_RECOMMENDED" && lifecycle.decision === "PASS") {
      if (lifecycleRaw.state !== "approved") {
        dryVerdict = "HOLD";
        reasons.push(`lifecycle-state:${String(lifecycleRaw.state)}`);
      } else {
        const next = { ...lifecycleRaw, state: "promoted" as LifecycleState };
        const transition = validateLifecycleTransition(lifecycleRaw, next);
        dryVerdict = transition.decision;
        reasons.push(...transition.issues.map(lifecycleReason));
        if (transition.decision === "PASS") requestedTransition = { from: "approved", to: "promoted" };
      }
    }

    const disposition = requestedTransition ? "WOULD_REQUEST_PROMOTION" : "HOLD";
    const dedupeKey = canonicalHash({
      summary_sha256: summary.summary_sha256,
      signature_sha256: signature?.signature_sha256 ?? null,
      subject_sha256: protocol.candidate_subject_sha256,
      lifecycle_revision_sha256: lifecycleRevision,
    });
    const body: Omit<DecisionLifecycleShadowObservation, "observation_sha256"> = {
      schema: DECISION_LIFECYCLE_SHADOW_OBSERVATION,
      bridge_version: DECISION_LIFECYCLE_BRIDGE_VERSION,
      trace_id: traceId,
      observed_at: observedAt.value,
      actor: { id: actorId, authority: "observe-only" },
      source_decision: summary.decision,
      subject: {
        skill_slug: protocol.skill_slug,
        version: protocol.candidate_version,
        subject_sha256: protocol.candidate_subject_sha256,
      },
      input_hashes: {
        protocol_sha256: protocol.protocol_sha256,
        summary_sha256: summary.summary_sha256,
        signature_sha256: signature?.signature_sha256 ?? null,
        lifecycle_revision_sha256: lifecycleRevision,
      },
      requested_transition: requestedTransition,
      lifecycle_dry_verdict: dryVerdict,
      lifecycle_issues: lifecycle.issues,
      disposition,
      reasons,
      dedupe_key: dedupeKey,
      authority: {
        promotion: false,
        quarantine: false,
        restore: false,
        install: false,
        routing: false,
        merge: false,
        approval: false,
      },
    };
    const observation = { ...body, observation_sha256: observationHash(body) };
    return { mode: "shadow", disposition, observation, reasons };
  } catch (error) {
    return hold(error instanceof Error ? error.message : String(error));
  }
}

export function runDecisionLifecycleBridge(
  mode: DecisionLifecycleBridgeMode,
  loadInput: () => unknown,
): DecisionLifecycleBridgeResult {
  if (mode === "off") return { mode: "off", disposition: "OFF", observation: null, reasons: [] };
  return evaluateDecisionLifecycleShadow(loadInput());
}
