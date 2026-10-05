#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ENVELOPE_CONTRACT_ID = "zouroboros-authority-envelope/v1" as const;
export const ENVELOPE_SCHEMA_VERSION = 1 as const;
export const ENVELOPE_RUNGS = ["read-only", "branch-write", "open-pr", "staging", "production"] as const;
export const PRINCIPAL_KINDS = ["operator", "agent", "automation", "service"] as const;
export const ISOLATION_MODES = ["isolated-worktree", "disposable-temp", "read-only"] as const;
export const LIFETIME_KINDS = ["terminal", "run", "session"] as const;
export const ENVELOPE_TERMINAL_OUTCOMES = ["success", "failure", "partial", "timeout", "cancelled", "held"] as const;
export const EVIDENCE_KINDS = ["fixture", "ledger", "receipt"] as const;
export const DECISIONS = ["PERMIT", "DENY"] as const;
export const DENY_REASONS = [
  "malformed_envelope",
  "malformed_request",
  "unknown_capability",
  "resource_not_listed",
  "argument_constraint_violation",
  "credential_class_not_granted",
  "validity_window_not_started",
  "validity_window_expired",
  "environment_mismatch",
  "missing_enforcement_evidence",
  "unverifiable_enforcement_evidence",
  "terminal_grant_revoked",
  "delegation_excess",
] as const;
export const DELEGATION_DIMENSIONS = [
  "lineage",
  "depth",
  "capability",
  "resource",
  "argument",
  "credential_class",
  "lifetime",
  "validity",
  "rung",
] as const;
export const AUTHORITY_EVENT_KINDS = ["decision", "violation"] as const;

export type EnvelopeRung = (typeof ENVELOPE_RUNGS)[number];
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
export type IsolationMode = (typeof ISOLATION_MODES)[number];
export type LifetimeKind = (typeof LIFETIME_KINDS)[number];
export type EnvelopeTerminalOutcome = (typeof ENVELOPE_TERMINAL_OUTCOMES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type Decision = (typeof DECISIONS)[number];
export type DenyReason = (typeof DENY_REASONS)[number];
export type DelegationDimension = (typeof DELEGATION_DIMENSIONS)[number];
export type AuthorityEventKind = (typeof AUTHORITY_EVENT_KINDS)[number];

const HASH = /^[0-9a-f]{64}$/;
const ENVELOPE_ID = /^ae-[0-9A-HJKMNP-TV-Z]{26}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const CREDENTIAL_CLASS = /^[a-z][a-z0-9-]{0,63}$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9._:@/-]+(\/\*)?$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export class AuthorityEnvelopeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthorityEnvelopeError";
  }
}

export interface ArgumentConstraint {
  const?: string | number | boolean;
  pattern?: string;
  enum?: Array<string | number | boolean>;
  max_length?: number;
}

export interface CapabilityGrant {
  capability: string;
  resources: string[];
  argument_constraints: Record<string, ArgumentConstraint>;
  credential_classes: string[];
  revoked_at: string | null;
}

export interface AuthorityEnvelope {
  contract_id: typeof ENVELOPE_CONTRACT_ID;
  schema_version: typeof ENVELOPE_SCHEMA_VERSION;
  envelope_id: string;
  principal: { kind: PrincipalKind; id: string };
  capabilities: CapabilityGrant[];
  validity: { not_before: string; expires_at: string };
  environment: { runtime_root: string; isolation_mode: IsolationMode; repository: string; state_dir: string };
  approval_binding: {
    actor: string;
    session_id: string;
    run_id: string;
    tool: string;
    bound_arguments_sha256: string;
    lifetime: { kind: LifetimeKind };
    required_terminal_outcome: EnvelopeTerminalOutcome | null;
  };
  global_rung_cap: EnvelopeRung;
  delegation: { parent_envelope_ref: string | null; depth: number };
  integration_refs: {
    permission_rung_ref: string | null;
    skillspector_finding_refs: string[];
    mcp_finding_refs: string[];
    provenance_evidence_refs: string[];
  };
  enforcement_evidence: { kind: EvidenceKind; evidence_ref: string; sha256: string };
}

export interface EvaluationRequest {
  capability: string;
  resource: string;
  arguments: Record<string, string | number | boolean>;
  credential_class: string | null;
  ts: string;
  environment: { runtime_root: string; isolation_mode: string; repository: string; state_dir: string };
  enforcement_evidence: { kind: string; evidence_ref: string; payload: string } | null;
}

export interface EvaluationContext {
  receipt_terminalized: boolean;
  terminal_outcome: string | null;
}

export interface AuthorityEvent {
  sequence: number;
  kind: AuthorityEventKind;
  capability: string;
  decision: Decision;
  reason: DenyReason | null;
  ts: string;
}

export interface EvaluationResult {
  decision: Decision;
  reasons: DenyReason[];
  events: AuthorityEvent[];
}

export interface EnvelopeIssue {
  path: string;
  message: string;
}

export interface DelegationIssue {
  dimension: DelegationDimension;
  message: string;
}

export interface CapabilityEnvelopeBlock {
  envelope_ref: string;
  envelope_sha256: string;
  evaluation_summary: { decision: Decision; evaluated_at: string; reason_count: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function pushIssue(issues: EnvelopeIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function checkString(issues: EnvelopeIssue[], value: unknown, path: string, max = 512): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    pushIssue(issues, path, "expected non-empty string");
    return false;
  }
  return true;
}

function checkTimestamp(issues: EnvelopeIssue[], value: unknown, path: string): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    pushIssue(issues, path, "expected RFC 3339 timestamp");
    return false;
  }
  return true;
}

function checkKeys(issues: EnvelopeIssue[], value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) pushIssue(issues, `${path}/${key}`, "unknown field");
  }
}

function validateArgumentConstraint(issues: EnvelopeIssue[], value: unknown, path: string): void {
  if (!isRecord(value)) {
    pushIssue(issues, path, "expected object");
    return;
  }
  checkKeys(issues, value, path, ["const", "pattern", "enum", "max_length"]);
  if (Object.keys(value).length === 0) pushIssue(issues, path, "constraint requires at least one clause");
  if ("const" in value && !isScalar(value.const)) pushIssue(issues, `${path}/const`, "expected scalar");
  if ("pattern" in value) {
    if (typeof value.pattern !== "string" || value.pattern.length === 0) {
      pushIssue(issues, `${path}/pattern`, "expected non-empty string");
    } else {
      try {
        new RegExp(value.pattern);
      } catch {
        pushIssue(issues, `${path}/pattern`, "invalid regular expression");
      }
    }
  }
  if ("enum" in value && (!Array.isArray(value.enum) || value.enum.length === 0 || !value.enum.every(isScalar))) {
    pushIssue(issues, `${path}/enum`, "expected non-empty scalar array");
  }
  if ("max_length" in value && (!Number.isInteger(value.max_length) || (value.max_length as number) < 0)) {
    pushIssue(issues, `${path}/max_length`, "expected non-negative integer");
  }
}

function validateGrant(issues: EnvelopeIssue[], value: unknown, path: string): void {
  if (!isRecord(value)) {
    pushIssue(issues, path, "expected object");
    return;
  }
  checkKeys(issues, value, path, ["capability", "resources", "argument_constraints", "credential_classes", "revoked_at"]);
  if (typeof value.capability !== "string" || !CAPABILITY_ID.test(value.capability)) {
    pushIssue(issues, `${path}/capability`, "invalid capability id");
  }
  if (!Array.isArray(value.resources) || value.resources.length === 0) {
    pushIssue(issues, `${path}/resources`, "expected non-empty array");
  } else {
    value.resources.forEach((resource, index) => {
      if (typeof resource !== "string" || resource.length > 512 || !RESOURCE_PATTERN.test(resource)) {
        pushIssue(issues, `${path}/resources/${index}`, "invalid resource pattern");
      }
    });
    if (new Set(value.resources).size !== value.resources.length) {
      pushIssue(issues, `${path}/resources`, "duplicate resource patterns");
    }
  }
  if (!isRecord(value.argument_constraints)) {
    pushIssue(issues, `${path}/argument_constraints`, "expected object");
  } else {
    for (const [key, constraint] of Object.entries(value.argument_constraints)) {
      validateArgumentConstraint(issues, constraint, `${path}/argument_constraints/${key}`);
    }
  }
  if (!Array.isArray(value.credential_classes)) {
    pushIssue(issues, `${path}/credential_classes`, "expected array");
  } else {
    value.credential_classes.forEach((entry, index) => {
      if (typeof entry !== "string" || !CREDENTIAL_CLASS.test(entry)) {
        pushIssue(issues, `${path}/credential_classes/${index}`, "invalid credential class identifier");
      }
    });
    if (new Set(value.credential_classes).size !== value.credential_classes.length) {
      pushIssue(issues, `${path}/credential_classes`, "duplicate credential classes");
    }
  }
  if (value.revoked_at !== null) checkTimestamp(issues, value.revoked_at, `${path}/revoked_at`);
}

export function validateEnvelope(input: unknown): { ok: boolean; issues: EnvelopeIssue[] } {
  const issues: EnvelopeIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "expected object" }] };
  checkKeys(issues, input, "", [
    "$schema",
    "contract_id",
    "schema_version",
    "envelope_id",
    "principal",
    "capabilities",
    "validity",
    "environment",
    "approval_binding",
    "global_rung_cap",
    "delegation",
    "integration_refs",
    "enforcement_evidence",
  ]);
  if (input.contract_id !== ENVELOPE_CONTRACT_ID) pushIssue(issues, "/contract_id", "invalid contract id");
  if (input.schema_version !== ENVELOPE_SCHEMA_VERSION) pushIssue(issues, "/schema_version", "invalid schema version");
  if (typeof input.envelope_id !== "string" || !ENVELOPE_ID.test(input.envelope_id)) {
    pushIssue(issues, "/envelope_id", "invalid envelope id");
  }
  if (!isRecord(input.principal)) {
    pushIssue(issues, "/principal", "expected object");
  } else {
    checkKeys(issues, input.principal, "/principal", ["kind", "id"]);
    if (!PRINCIPAL_KINDS.includes(input.principal.kind as PrincipalKind)) {
      pushIssue(issues, "/principal/kind", "invalid principal kind");
    }
    checkString(issues, input.principal.id, "/principal/id", 256);
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    pushIssue(issues, "/capabilities", "expected non-empty array");
  } else {
    input.capabilities.forEach((grant, index) => validateGrant(issues, grant, `/capabilities/${index}`));
  }
  if (!isRecord(input.validity)) {
    pushIssue(issues, "/validity", "expected object");
  } else {
    checkKeys(issues, input.validity, "/validity", ["not_before", "expires_at"]);
    checkTimestamp(issues, input.validity.not_before, "/validity/not_before");
    checkTimestamp(issues, input.validity.expires_at, "/validity/expires_at");
  }
  if (!isRecord(input.environment)) {
    pushIssue(issues, "/environment", "expected object");
  } else {
    checkKeys(issues, input.environment, "/environment", ["runtime_root", "isolation_mode", "repository", "state_dir"]);
    checkString(issues, input.environment.runtime_root, "/environment/runtime_root");
    if (!ISOLATION_MODES.includes(input.environment.isolation_mode as IsolationMode)) {
      pushIssue(issues, "/environment/isolation_mode", "invalid isolation mode");
    }
    checkString(issues, input.environment.repository, "/environment/repository", 256);
    checkString(issues, input.environment.state_dir, "/environment/state_dir");
  }
  if (!isRecord(input.approval_binding)) {
    pushIssue(issues, "/approval_binding", "expected object");
  } else {
    const binding = input.approval_binding;
    checkKeys(issues, binding, "/approval_binding", [
      "actor",
      "session_id",
      "run_id",
      "tool",
      "bound_arguments_sha256",
      "lifetime",
      "required_terminal_outcome",
    ]);
    checkString(issues, binding.actor, "/approval_binding/actor", 256);
    checkString(issues, binding.session_id, "/approval_binding/session_id", 256);
    checkString(issues, binding.run_id, "/approval_binding/run_id", 256);
    checkString(issues, binding.tool, "/approval_binding/tool", 256);
    if (typeof binding.bound_arguments_sha256 !== "string" || !HASH.test(binding.bound_arguments_sha256)) {
      pushIssue(issues, "/approval_binding/bound_arguments_sha256", "expected sha256 hex digest");
    }
    if (!isRecord(binding.lifetime)) {
      pushIssue(issues, "/approval_binding/lifetime", "expected object");
    } else {
      checkKeys(issues, binding.lifetime, "/approval_binding/lifetime", ["kind"]);
      if (!LIFETIME_KINDS.includes(binding.lifetime.kind as LifetimeKind)) {
        pushIssue(issues, "/approval_binding/lifetime/kind", "invalid lifetime kind");
      }
    }
    if (
      binding.required_terminal_outcome !== null &&
      !ENVELOPE_TERMINAL_OUTCOMES.includes(binding.required_terminal_outcome as EnvelopeTerminalOutcome)
    ) {
      pushIssue(issues, "/approval_binding/required_terminal_outcome", "invalid terminal outcome");
    }
  }
  if (!ENVELOPE_RUNGS.includes(input.global_rung_cap as EnvelopeRung)) {
    pushIssue(issues, "/global_rung_cap", "invalid rung");
  }
  if (!isRecord(input.delegation)) {
    pushIssue(issues, "/delegation", "expected object");
  } else {
    checkKeys(issues, input.delegation, "/delegation", ["parent_envelope_ref", "depth"]);
    if (input.delegation.parent_envelope_ref !== null) {
      if (typeof input.delegation.parent_envelope_ref !== "string" || !ENVELOPE_ID.test(input.delegation.parent_envelope_ref)) {
        pushIssue(issues, "/delegation/parent_envelope_ref", "invalid envelope reference");
      }
    }
    if (!Number.isInteger(input.delegation.depth) || (input.delegation.depth as number) < 0 || (input.delegation.depth as number) > 8) {
      pushIssue(issues, "/delegation/depth", "expected integer in [0, 8]");
    }
  }
  if (!isRecord(input.integration_refs)) {
    pushIssue(issues, "/integration_refs", "expected object");
  } else {
    const refs = input.integration_refs;
    checkKeys(issues, refs, "/integration_refs", [
      "permission_rung_ref",
      "skillspector_finding_refs",
      "mcp_finding_refs",
      "provenance_evidence_refs",
    ]);
    if (refs.permission_rung_ref !== null && typeof refs.permission_rung_ref !== "string") {
      pushIssue(issues, "/integration_refs/permission_rung_ref", "expected string or null");
    }
    for (const key of ["skillspector_finding_refs", "mcp_finding_refs", "provenance_evidence_refs"] as const) {
      const list = refs[key];
      if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string" && entry.length > 0)) {
        pushIssue(issues, `/integration_refs/${key}`, "expected array of non-empty strings");
      } else if (new Set(list).size !== list.length) {
        pushIssue(issues, `/integration_refs/${key}`, "duplicate references");
      }
    }
  }
  if (!isRecord(input.enforcement_evidence)) {
    pushIssue(issues, "/enforcement_evidence", "expected object");
  } else {
    checkKeys(issues, input.enforcement_evidence, "/enforcement_evidence", ["kind", "evidence_ref", "sha256"]);
    if (!EVIDENCE_KINDS.includes(input.enforcement_evidence.kind as EvidenceKind)) {
      pushIssue(issues, "/enforcement_evidence/kind", "invalid evidence kind");
    }
    checkString(issues, input.enforcement_evidence.evidence_ref, "/enforcement_evidence/evidence_ref");
    if (typeof input.enforcement_evidence.sha256 !== "string" || !HASH.test(input.enforcement_evidence.sha256)) {
      pushIssue(issues, "/enforcement_evidence/sha256", "expected sha256 hex digest");
    }
  }
  return { ok: issues.length === 0, issues };
}

function validateRequestShape(input: unknown): input is EvaluationRequest {
  if (!isRecord(input)) return false;
  const keys = Object.keys(input);
  const allowed = ["capability", "resource", "arguments", "credential_class", "ts", "environment", "enforcement_evidence"];
  if (!keys.every((key) => allowed.includes(key)) || !allowed.every((key) => keys.includes(key))) return false;
  if (typeof input.capability !== "string" || input.capability.length === 0) return false;
  if (typeof input.resource !== "string" || input.resource.length === 0) return false;
  if (!isRecord(input.arguments) || !Object.values(input.arguments).every(isScalar)) return false;
  if (input.credential_class !== null && typeof input.credential_class !== "string") return false;
  if (typeof input.ts !== "string" || !TIMESTAMP.test(input.ts) || Number.isNaN(Date.parse(input.ts))) return false;
  if (!isRecord(input.environment)) return false;
  const env = input.environment;
  const envKeys = ["runtime_root", "isolation_mode", "repository", "state_dir"];
  if (!envKeys.every((key) => typeof env[key] === "string")) return false;
  if (Object.keys(env).some((key) => !envKeys.includes(key))) return false;
  if (input.enforcement_evidence !== null) {
    if (!isRecord(input.enforcement_evidence)) return false;
    const evidence = input.enforcement_evidence;
    const evidenceKeys = ["kind", "evidence_ref", "payload"];
    if (!evidenceKeys.every((key) => typeof evidence[key] === "string")) return false;
    if (Object.keys(evidence).some((key) => !evidenceKeys.includes(key))) return false;
  }
  return true;
}

export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function resourceMatches(pattern: string, resource: string): boolean {
  if (pattern === resource) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return resource.startsWith(prefix) && resource.length > prefix.length;
  }
  return false;
}

function constraintSatisfied(constraint: ArgumentConstraint, value: string | number | boolean): boolean {
  if ("const" in constraint && constraint.const !== value) return false;
  if (constraint.pattern !== undefined && !new RegExp(constraint.pattern).test(String(value))) return false;
  if (constraint.enum !== undefined && !constraint.enum.includes(value)) return false;
  if (constraint.max_length !== undefined && String(value).length > constraint.max_length) return false;
  return true;
}

export function evaluateRequest(
  envelope: unknown,
  request: unknown,
  context: EvaluationContext = { receipt_terminalized: false, terminal_outcome: null },
): EvaluationResult {
  const reasons: DenyReason[] = [];
  const events: AuthorityEvent[] = [];
  const envelopeCheck = validateEnvelope(envelope);
  const requestOk = validateRequestShape(request);
  const capability = requestOk ? (request as EvaluationRequest).capability : "unknown";
  const ts = requestOk ? (request as EvaluationRequest).ts : "1970-01-01T00:00:00Z";
  const record = (reason: DenyReason): void => {
    reasons.push(reason);
    events.push({ sequence: events.length + 1, kind: "violation", capability, decision: "DENY", reason, ts });
  };
  if (!envelopeCheck.ok) record("malformed_envelope");
  if (!requestOk) record("malformed_request");
  if (envelopeCheck.ok && requestOk) {
    const env = envelope as AuthorityEnvelope;
    const req = request as EvaluationRequest;
    const requestMs = Date.parse(req.ts);
    if (requestMs < Date.parse(env.validity.not_before)) record("validity_window_not_started");
    if (requestMs > Date.parse(env.validity.expires_at)) record("validity_window_expired");
    if (
      req.environment.runtime_root !== env.environment.runtime_root ||
      req.environment.isolation_mode !== env.environment.isolation_mode ||
      req.environment.repository !== env.environment.repository ||
      req.environment.state_dir !== env.environment.state_dir
    ) {
      record("environment_mismatch");
    }
    const grant = env.capabilities.find((entry) => entry.capability === req.capability);
    if (grant === undefined) {
      record("unknown_capability");
    } else {
      const revokedByContext = context.receipt_terminalized && env.approval_binding.lifetime.kind === "terminal";
      if (grant.revoked_at !== null || revokedByContext) record("terminal_grant_revoked");
      if (!grant.resources.some((pattern) => resourceMatches(pattern, req.resource))) record("resource_not_listed");
      for (const [key, constraint] of Object.entries(grant.argument_constraints)) {
        const value = req.arguments[key];
        if (value === undefined || !constraintSatisfied(constraint, value)) {
          record("argument_constraint_violation");
          break;
        }
      }
      if (req.credential_class !== null && !grant.credential_classes.includes(req.credential_class)) {
        record("credential_class_not_granted");
      }
    }
    if (req.enforcement_evidence === null) {
      record("missing_enforcement_evidence");
    } else if (
      req.enforcement_evidence.kind !== env.enforcement_evidence.kind ||
      req.enforcement_evidence.evidence_ref !== env.enforcement_evidence.evidence_ref ||
      sha256Hex(req.enforcement_evidence.payload) !== env.enforcement_evidence.sha256
    ) {
      record("unverifiable_enforcement_evidence");
    }
  }
  const decision: Decision = reasons.length === 0 ? "PERMIT" : "DENY";
  events.push({ sequence: events.length + 1, kind: "decision", capability, decision, reason: null, ts });
  return { decision, reasons, events };
}

function lifetimeIndex(kind: LifetimeKind): number {
  return LIFETIME_KINDS.indexOf(kind);
}

function rungIndex(rung: string): number {
  return ENVELOPE_RUNGS.indexOf(rung as EnvelopeRung);
}

function resourceCoveredByParent(parentResources: readonly string[], childPattern: string): boolean {
  for (const parentPattern of parentResources) {
    if (parentPattern === childPattern) return true;
    if (parentPattern.endsWith("/*")) {
      const prefix = parentPattern.slice(0, -1);
      if (childPattern.endsWith("/*")) {
        const childPrefix = childPattern.slice(0, -1);
        if (childPrefix.startsWith(prefix) && childPrefix.length > prefix.length) return true;
      } else if (resourceMatches(parentPattern, childPattern)) {
        return true;
      }
    }
  }
  return false;
}

function constraintEqual(a: ArgumentConstraint, b: ArgumentConstraint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateDelegation(
  parent: unknown,
  child: unknown,
): { ok: boolean; issues: DelegationIssue[]; events: AuthorityEvent[] } {
  const issues: DelegationIssue[] = [];
  const parentCheck = validateEnvelope(parent);
  const childCheck = validateEnvelope(child);
  if (!parentCheck.ok) issues.push({ dimension: "lineage", message: "parent envelope is malformed" });
  if (!childCheck.ok) issues.push({ dimension: "lineage", message: "child envelope is malformed" });
  let ts = "1970-01-01T00:00:00Z";
  let capability = "delegation";
  if (parentCheck.ok && childCheck.ok) {
    const parentEnvelope = parent as AuthorityEnvelope;
    const childEnvelope = child as AuthorityEnvelope;
    ts = childEnvelope.validity.not_before;
    if (childEnvelope.delegation.parent_envelope_ref !== parentEnvelope.envelope_id) {
      issues.push({ dimension: "lineage", message: "child parent_envelope_ref does not reference the parent" });
    }
    if (childEnvelope.delegation.depth !== parentEnvelope.delegation.depth + 1) {
      issues.push({ dimension: "depth", message: "child depth must be parent depth + 1" });
    }
    if (lifetimeIndex(childEnvelope.approval_binding.lifetime.kind) > lifetimeIndex(parentEnvelope.approval_binding.lifetime.kind)) {
      issues.push({ dimension: "lifetime", message: "child lifetime exceeds parent lifetime" });
    }
    if (
      Date.parse(childEnvelope.validity.not_before) < Date.parse(parentEnvelope.validity.not_before) ||
      Date.parse(childEnvelope.validity.expires_at) > Date.parse(parentEnvelope.validity.expires_at)
    ) {
      issues.push({ dimension: "validity", message: "child validity window exceeds parent window" });
    }
    if (rungIndex(childEnvelope.global_rung_cap) > rungIndex(parentEnvelope.global_rung_cap)) {
      issues.push({ dimension: "rung", message: "child rung cap exceeds parent rung cap" });
    }
    for (const childGrant of childEnvelope.capabilities) {
      const parentGrant = parentEnvelope.capabilities.find((entry) => entry.capability === childGrant.capability);
      if (parentGrant === undefined) {
        capability = childGrant.capability;
        issues.push({ dimension: "capability", message: `capability ${childGrant.capability} is not granted by the parent` });
        continue;
      }
      for (const resource of childGrant.resources) {
        if (!resourceCoveredByParent(parentGrant.resources, resource)) {
          capability = childGrant.capability;
          issues.push({ dimension: "resource", message: `resource ${resource} is not covered by the parent grant` });
        }
      }
      for (const [key, parentConstraint] of Object.entries(parentGrant.argument_constraints)) {
        const childConstraint = childGrant.argument_constraints[key];
        if (childConstraint === undefined || !constraintEqual(parentConstraint, childConstraint)) {
          capability = childGrant.capability;
          issues.push({ dimension: "argument", message: `argument constraint ${key} is loosened or dropped` });
        }
      }
      for (const credentialClass of childGrant.credential_classes) {
        if (!parentGrant.credential_classes.includes(credentialClass)) {
          capability = childGrant.capability;
          issues.push({ dimension: "credential_class", message: `credential class ${credentialClass} is not granted by the parent` });
        }
      }
    }
  }
  const events: AuthorityEvent[] = issues.map((issue, index) => ({
    sequence: index + 1,
    kind: "violation",
    capability,
    decision: "DENY",
    reason: "delegation_excess",
    ts,
  }));
  const decision: Decision = issues.length === 0 ? "PERMIT" : "DENY";
  events.push({ sequence: events.length + 1, kind: "decision", capability, decision, reason: null, ts });
  return { ok: issues.length === 0, issues, events };
}

export function composeEffectiveRung(globalRung: string, envelopeCap: string): EnvelopeRung {
  const globalIndex = rungIndex(globalRung);
  const capIndex = rungIndex(envelopeCap);
  if (globalIndex < 0 || capIndex < 0) return "read-only";
  return ENVELOPE_RUNGS[Math.min(globalIndex, capIndex)]!;
}

export interface GlobalRungFixture {
  ladder: string[];
  current: string;
}

export function loadGlobalRungFixture(path: string): GlobalRungFixture {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.ladder) || typeof parsed.current !== "string") {
    throw new AuthorityEnvelopeError("rung_fixture_invalid", "global rung fixture is malformed");
  }
  if (JSON.stringify(parsed.ladder) !== JSON.stringify([...ENVELOPE_RUNGS])) {
    throw new AuthorityEnvelopeError("rung_fixture_invalid", "global rung fixture ladder does not match the pinned ladder");
  }
  if (!ENVELOPE_RUNGS.includes(parsed.current as EnvelopeRung)) {
    throw new AuthorityEnvelopeError("rung_fixture_invalid", "global rung fixture current rung is unknown");
  }
  return { ladder: parsed.ladder as string[], current: parsed.current };
}

export function revokeTerminalGrants(envelope: AuthorityEnvelope, revokedAt: string): AuthorityEnvelope {
  if (envelope.approval_binding.lifetime.kind !== "terminal") return structuredClone(envelope);
  const copy = structuredClone(envelope);
  for (const grant of copy.capabilities) {
    if (grant.revoked_at === null) grant.revoked_at = revokedAt;
  }
  return copy;
}

export function validateCapabilityEnvelopeBlock(input: unknown): { ok: boolean; issues: EnvelopeIssue[] } {
  const issues: EnvelopeIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "expected object" }] };
  checkKeys(issues, input, "", ["envelope_ref", "envelope_sha256", "evaluation_summary"]);
  checkString(issues, input.envelope_ref, "/envelope_ref");
  if (typeof input.envelope_sha256 !== "string" || !HASH.test(input.envelope_sha256)) {
    pushIssue(issues, "/envelope_sha256", "expected sha256 hex digest");
  }
  if (!isRecord(input.evaluation_summary)) {
    pushIssue(issues, "/evaluation_summary", "expected object");
  } else {
    const summary = input.evaluation_summary;
    checkKeys(issues, summary, "/evaluation_summary", ["decision", "evaluated_at", "reason_count"]);
    if (!DECISIONS.includes(summary.decision as Decision)) {
      pushIssue(issues, "/evaluation_summary/decision", "invalid decision");
    }
    checkTimestamp(issues, summary.evaluated_at, "/evaluation_summary/evaluated_at");
    if (!Number.isInteger(summary.reason_count) || (summary.reason_count as number) < 0) {
      pushIssue(issues, "/evaluation_summary/reason_count", "expected non-negative integer");
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateAuthorityEvents(input: unknown): { ok: boolean; issues: EnvelopeIssue[] } {
  const issues: EnvelopeIssue[] = [];
  if (!Array.isArray(input)) return { ok: false, issues: [{ path: "", message: "expected array" }] };
  input.forEach((entry, index) => {
    const path = `/${index}`;
    if (!isRecord(entry)) {
      pushIssue(issues, path, "expected object");
      return;
    }
    checkKeys(issues, entry, path, ["sequence", "kind", "capability", "decision", "reason", "ts"]);
    if (entry.sequence !== index + 1) pushIssue(issues, `${path}/sequence`, "expected contiguous ascending sequence starting at 1");
    if (!AUTHORITY_EVENT_KINDS.includes(entry.kind as AuthorityEventKind)) pushIssue(issues, `${path}/kind`, "invalid event kind");
    if (typeof entry.capability !== "string" || entry.capability.length === 0) {
      pushIssue(issues, `${path}/capability`, "expected non-empty string");
    }
    if (!DECISIONS.includes(entry.decision as Decision)) pushIssue(issues, `${path}/decision`, "invalid decision");
    if (entry.kind === "violation") {
      if (!DENY_REASONS.includes(entry.reason as DenyReason)) pushIssue(issues, `${path}/reason`, "violation requires a deny reason");
    } else if (entry.reason !== null) {
      pushIssue(issues, `${path}/reason`, "decision events carry a null reason");
    }
    checkTimestamp(issues, entry.ts, `${path}/ts`);
  });
  return { ok: issues.length === 0, issues };
}

const DRILL_EVIDENCE_PAYLOAD = "authority-envelope-drill-evidence-v1";

export function buildDrillEnvelope(withGrant: boolean): AuthorityEnvelope {
  const capabilities: CapabilityGrant[] = [
    {
      capability: "fixture.noop",
      resources: ["drill/noop"],
      argument_constraints: {},
      credential_classes: [],
      revoked_at: null,
    },
  ];
  if (withGrant) {
    capabilities.push({
      capability: "fixture.write",
      resources: ["drill/out/*"],
      argument_constraints: { mode: { enum: ["append"] } },
      credential_classes: ["drill-local"],
      revoked_at: null,
    });
  }
  return {
    contract_id: ENVELOPE_CONTRACT_ID,
    schema_version: ENVELOPE_SCHEMA_VERSION,
    envelope_id: "ae-01J00000000000000000000001",
    principal: { kind: "operator", id: "drill-operator" },
    capabilities,
    validity: { not_before: "2026-01-01T00:00:00Z", expires_at: "2026-12-31T23:59:59Z" },
    environment: {
      runtime_root: "drill-root",
      isolation_mode: "disposable-temp",
      repository: "drill/repository",
      state_dir: "drill-state",
    },
    approval_binding: {
      actor: "drill-operator",
      session_id: "drill-session",
      run_id: "drill-run",
      tool: "authority-envelope-drill",
      bound_arguments_sha256: sha256Hex("drill-arguments"),
      lifetime: { kind: "terminal" },
      required_terminal_outcome: "success",
    },
    global_rung_cap: "open-pr",
    delegation: { parent_envelope_ref: null, depth: 0 },
    integration_refs: {
      permission_rung_ref: "fixture:global-rung.json",
      skillspector_finding_refs: [],
      mcp_finding_refs: [],
      provenance_evidence_refs: [],
    },
    enforcement_evidence: {
      kind: "fixture",
      evidence_ref: "drill/evidence",
      sha256: sha256Hex(DRILL_EVIDENCE_PAYLOAD),
    },
  };
}

export function buildDrillRequest(): EvaluationRequest {
  return {
    capability: "fixture.write",
    resource: "drill/out/report.json",
    arguments: { mode: "append" },
    credential_class: "drill-local",
    ts: "2026-06-01T12:00:00Z",
    environment: {
      runtime_root: "drill-root",
      isolation_mode: "disposable-temp",
      repository: "drill/repository",
      state_dir: "drill-state",
    },
    enforcement_evidence: {
      kind: "fixture",
      evidence_ref: "drill/evidence",
      payload: DRILL_EVIDENCE_PAYLOAD,
    },
  };
}

export interface DrillStage {
  name: string;
  decision: Decision;
  reasons: DenyReason[];
}

export function runRollbackDrill(root?: string): { ok: boolean; root: string; stages: DrillStage[] } {
  const drillRoot = root ?? mkdtempSync(join(tmpdir(), "authority-envelope-drill-"));
  const cleanup = root === undefined;
  try {
    const request = buildDrillRequest();
    const stages: DrillStage[] = [];
    const stage = (name: string, envelope: AuthorityEnvelope, context?: EvaluationContext): DrillStage => {
      const envelopePath = join(drillRoot, `${name}.envelope.json`);
      const requestPath = join(drillRoot, `${name}.request.json`);
      writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`);
      writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
      const rereadEnvelope: unknown = JSON.parse(readFileSync(envelopePath, "utf8"));
      const rereadRequest: unknown = JSON.parse(readFileSync(requestPath, "utf8"));
      const result = evaluateRequest(rereadEnvelope, rereadRequest, context);
      const entry: DrillStage = { name, decision: result.decision, reasons: result.reasons };
      stages.push(entry);
      return entry;
    };
    const preGrant = stage("pre-grant", buildDrillEnvelope(false));
    const granted = stage("granted", buildDrillEnvelope(true));
    const revoked = stage(
      "terminalized",
      revokeTerminalGrants(buildDrillEnvelope(true), "2026-06-01T12:30:00Z"),
      { receipt_terminalized: true, terminal_outcome: "success" },
    );
    const ok =
      preGrant.decision === "DENY" &&
      preGrant.reasons.includes("unknown_capability") &&
      granted.decision === "PERMIT" &&
      revoked.decision === "DENY" &&
      revoked.reasons.includes("terminal_grant_revoked") &&
      revoked.decision === preGrant.decision;
    return { ok, root: drillRoot, stages };
  } finally {
    if (cleanup) rmSync(drillRoot, { recursive: true, force: true });
  }
}

const USAGE = [
  "usage: bun authority-envelope.ts <command>",
  "  --help                                        print usage and exit",
  "  check <envelope.json> [--rung-fixture <path>] validate an envelope (read-only)",
  "  evaluate <envelope.json> <request.json> [--terminalized] [--terminal-outcome <outcome>]",
  "  drill [--root <dir>]                          rollback drill on disposable temp fixtures",
].join("\n");

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function main(argv: readonly string[]): number {
  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const [command, ...rest] = argv;
  if (command === "check") {
    const paths = rest.filter((arg) => !arg.startsWith("--"));
    const envelopePath = paths[0];
    if (envelopePath === undefined) {
      console.error("check requires an envelope path");
      return 2;
    }
    const parsed = readJsonFile(envelopePath);
    if (!parsed.ok) {
      emit({ ok: false, issues: [{ path: "", message: `unreadable envelope: ${parsed.error}` }] });
      return 1;
    }
    const result = validateEnvelope(parsed.value);
    const fixtureFlag = rest.indexOf("--rung-fixture");
    if (result.ok && fixtureFlag !== -1) {
      const fixturePath = rest[fixtureFlag + 1];
      if (fixturePath === undefined) {
        console.error("--rung-fixture requires a path");
        return 2;
      }
      try {
        const fixture = loadGlobalRungFixture(fixturePath);
        const envelope = parsed.value as AuthorityEnvelope;
        const effective = composeEffectiveRung(fixture.current, envelope.global_rung_cap);
        const capOnly = rungIndex(effective) <= rungIndex(fixture.current);
        emit({ ok: capOnly, issues: [], global_rung: fixture.current, envelope_cap: envelope.global_rung_cap, effective_rung: effective });
        return capOnly ? 0 : 1;
      } catch (error) {
        emit({ ok: false, issues: [{ path: "", message: error instanceof Error ? error.message : String(error) }] });
        return 1;
      }
    }
    emit(result);
    return result.ok ? 0 : 1;
  }
  if (command === "evaluate") {
    const paths = rest.filter((arg) => !arg.startsWith("--"));
    const terminalOutcomeFlag = rest.indexOf("--terminal-outcome");
    const terminalOutcome = terminalOutcomeFlag === -1 ? null : rest[terminalOutcomeFlag + 1] ?? null;
    const envelopePath = paths[0];
    const requestPath = terminalOutcomeFlag !== -1 && paths[1] === terminalOutcome ? paths[2] : paths[1];
    if (envelopePath === undefined || requestPath === undefined) {
      console.error("evaluate requires an envelope path and a request path");
      return 2;
    }
    const envelope = readJsonFile(envelopePath);
    const request = readJsonFile(requestPath);
    if (!envelope.ok || !request.ok) {
      emit({ decision: "DENY", reasons: ["malformed_request"], events: [] });
      return 1;
    }
    const result = evaluateRequest(envelope.value, request.value, {
      receipt_terminalized: rest.includes("--terminalized"),
      terminal_outcome: terminalOutcome,
    });
    emit(result);
    if (result.reasons.includes("malformed_envelope") || result.reasons.includes("malformed_request")) return 1;
    return result.decision === "PERMIT" ? 0 : 3;
  }
  if (command === "drill") {
    const rootFlag = rest.indexOf("--root");
    const root = rootFlag === -1 ? undefined : rest[rootFlag + 1];
    if (rootFlag !== -1 && root === undefined) {
      console.error("--root requires a directory path");
      return 2;
    }
    const result = runRollbackDrill(root);
    emit({ ok: result.ok, stages: result.stages });
    return result.ok ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
