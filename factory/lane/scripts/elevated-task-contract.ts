#!/usr/bin/env bun
/**
 * Elevated task contract v1 — typed request, five-category policy, and
 * classification for the Command Center elevated-execution path.
 *
 * This module is pure: no I/O, no clock reads except through the injected
 * `now`, no environment reads except through the injected `env`. It reuses
 * the authority-envelope rung ladder as the category vocabulary so that an
 * elevated request maps one-to-one onto an authority envelope rung cap.
 *
 * Contract doc: ../contracts/elevated-task-v1.md
 * JSON schema:  ../contracts/elevated-task-v1.schema.json
 */

import { createHash, randomBytes } from "node:crypto";

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export const ELEVATED_TASK_CONTRACT_ID = "zouroboros-elevated-task/v1" as const;
export const ELEVATED_AUDIT_CONTRACT_ID = "zouroboros-elevated-audit/v1" as const;
export const ELEVATED_SCHEMA_VERSION = 1 as const;

/** Identical to the authority-envelope rung ladder, lowest to highest. */
export const ELEVATED_CATEGORIES = ["read-only", "branch-write", "open-pr", "staging", "production"] as const;
export const ELEVATED_TARGETS = ["repo", "full-vps"] as const;
export const ELEVATED_PRINCIPAL_KINDS = ["operator", "agent", "automation", "service"] as const;
export const ELEVATED_STATUSES = [
  "submitted",
  "classified",
  "awaiting_approval",
  "approved",
  "executing",
  "completed",
  "failed",
  "timed_out",
  "held",
  "rejected",
  "cancelled",
] as const;
export const DETECTOR_VERDICTS = ["clear", "raise", "reject", "unclassifiable"] as const;
export const CLASSIFICATION_OUTCOMES = ["auto_execute", "await_approval", "held", "rejected"] as const;
export const PLAN_GATE_MODES = ["disabled", "advisory", "enforce"] as const;
export const EXECUTION_SITES = ["broker", "helper"] as const;
export const ELEVATED_MODES = ["disabled", "shadow", "enforce"] as const;
export const CLASSIFICATION_REASONS = [
  "malformed_request",
  "detector_reject",
  "detector_unclassifiable",
  "detector_raised_category",
  "target_requires_production",
  "rung_cap_exceeded",
  "target_not_allowed_for_category",
  "approval_required",
  "auto_execute_permitted",
  "elevated_disabled",
  "shadow_mode",
] as const;

export const ELEVATED_ENABLED_ENV = "CC_ELEVATED_ENABLED";
export const ELEVATED_MODE_ENV = "CC_ELEVATED_MODE";

export type ElevatedCategory = (typeof ELEVATED_CATEGORIES)[number];
export type ElevatedTarget = (typeof ELEVATED_TARGETS)[number];
export type ElevatedPrincipalKind = (typeof ELEVATED_PRINCIPAL_KINDS)[number];
export type ElevatedStatus = (typeof ELEVATED_STATUSES)[number];
export type DetectorVerdict = (typeof DETECTOR_VERDICTS)[number];
export type ClassificationOutcome = (typeof CLASSIFICATION_OUTCOMES)[number];
export type PlanGateMode = (typeof PLAN_GATE_MODES)[number];
export type ExecutionSite = (typeof EXECUTION_SITES)[number];
export type ElevatedMode = (typeof ELEVATED_MODES)[number];
export type ClassificationReason = (typeof CLASSIFICATION_REASONS)[number];

// ─── Request ──────────────────────────────────────────────────────────────────

export interface ElevatedCommand {
  /** Program and arguments, executed without a shell. */
  argv: string[];
  /** Absolute working directory. */
  cwd: string;
  /** Optional stdin payload (UTF-8). */
  stdin: string | null;
}

export interface ElevatedTaskRequest {
  contract_id: typeof ELEVATED_TASK_CONTRACT_ID;
  schema_version: typeof ELEVATED_SCHEMA_VERSION;
  /** Client idempotency key; the broker dedupes on this plus the request hash. */
  client_request_id: string;
  principal: { kind: ElevatedPrincipalKind; id: string };
  /** The category the submitter believes applies. The detector can only raise it. */
  requested_category: ElevatedCategory;
  target: ElevatedTarget;
  command: ElevatedCommand;
  /** Environment variable names the command needs. Filtered by the executor allowlist. */
  env_keys: string[];
  /** Declared write scope: paths the command intends to touch. Informational for the operator. */
  resources: string[];
  /** Human-readable justification shown at approval time. */
  reason: string;
  submitted_at: string;
}

export interface ElevatedIssue {
  path: string;
  message: string;
}

// ─── Policy ───────────────────────────────────────────────────────────────────

export interface CategoryPolicy {
  rule_id: string;
  category: ElevatedCategory;
  /** `auto` executes with a receipt; `approval` waits for a nonce-bound operator approval. */
  execution: "auto" | "approval";
  approval: { nonce: boolean; second_secret: boolean };
  plan_gate_mode: PlanGateMode;
  timeout_ms: number;
  output_cap_bytes: number;
  max_concurrent: number;
  nonce_ttl_ms: number;
  targets: ElevatedTarget[];
  executes_in: ExecutionSite;
}

const KIB = 1024;

/** Policies are shared by reference into every decision; freeze them so a caller cannot loosen a bound in place. */
function deepFreezePolicies(table: Record<ElevatedCategory, CategoryPolicy>): Readonly<Record<ElevatedCategory, CategoryPolicy>> {
  for (const policy of Object.values(table)) {
    Object.freeze(policy.approval);
    Object.freeze(policy.targets);
    Object.freeze(policy);
  }
  return Object.freeze(table);
}

export const OUTPUT_CAP_BYTES = 256 * KIB;
export const APPROVAL_NONCE_TTL_MAX_MS = 10 * 60_000;

/** Five-category policy mapped onto the existing rung ladder (threat-model R4/R6). */
export const CATEGORY_POLICY: Readonly<Record<ElevatedCategory, CategoryPolicy>> = deepFreezePolicies({
  "read-only": {
    rule_id: "ET-POL-READ-ONLY",
    category: "read-only",
    execution: "auto",
    approval: { nonce: false, second_secret: false },
    plan_gate_mode: "disabled",
    timeout_ms: 60_000,
    output_cap_bytes: OUTPUT_CAP_BYTES,
    max_concurrent: 2,
    nonce_ttl_ms: 0,
    targets: ["repo"],
    executes_in: "broker",
  },
  "branch-write": {
    rule_id: "ET-POL-BRANCH-WRITE",
    category: "branch-write",
    execution: "auto",
    approval: { nonce: false, second_secret: false },
    plan_gate_mode: "disabled",
    timeout_ms: 300_000,
    output_cap_bytes: OUTPUT_CAP_BYTES,
    max_concurrent: 2,
    nonce_ttl_ms: 0,
    targets: ["repo"],
    executes_in: "broker",
  },
  "open-pr": {
    rule_id: "ET-POL-OPEN-PR",
    category: "open-pr",
    execution: "auto",
    approval: { nonce: false, second_secret: false },
    plan_gate_mode: "advisory",
    timeout_ms: 300_000,
    output_cap_bytes: OUTPUT_CAP_BYTES,
    max_concurrent: 2,
    nonce_ttl_ms: 0,
    targets: ["repo"],
    executes_in: "broker",
  },
  staging: {
    rule_id: "ET-POL-STAGING",
    category: "staging",
    execution: "approval",
    approval: { nonce: true, second_secret: false },
    plan_gate_mode: "enforce",
    timeout_ms: 900_000,
    output_cap_bytes: OUTPUT_CAP_BYTES,
    max_concurrent: 1,
    nonce_ttl_ms: APPROVAL_NONCE_TTL_MAX_MS,
    targets: ["repo"],
    executes_in: "broker",
  },
  production: {
    rule_id: "ET-POL-PRODUCTION",
    category: "production",
    execution: "approval",
    approval: { nonce: true, second_secret: true },
    plan_gate_mode: "enforce",
    timeout_ms: 900_000,
    output_cap_bytes: OUTPUT_CAP_BYTES,
    max_concurrent: 1,
    nonce_ttl_ms: APPROVAL_NONCE_TTL_MAX_MS,
    targets: ["repo", "full-vps"],
    executes_in: "helper",
  },
});

export function categoryIndex(category: string): number {
  return ELEVATED_CATEGORIES.indexOf(category as ElevatedCategory);
}

export function isElevatedCategory(value: unknown): value is ElevatedCategory {
  return typeof value === "string" && categoryIndex(value) >= 0;
}

/** Highest of the given categories. Unknown values are ignored; all-unknown yields null. */
export function maxCategory(...categories: Array<ElevatedCategory | null | undefined>): ElevatedCategory | null {
  let best = -1;
  for (const category of categories) {
    if (category === null || category === undefined) continue;
    best = Math.max(best, categoryIndex(category));
  }
  return best < 0 ? null : ELEVATED_CATEGORIES[best]!;
}

export function policyFor(category: ElevatedCategory): CategoryPolicy {
  return CATEGORY_POLICY[category];
}

export function planGateModeFor(category: ElevatedCategory): PlanGateMode {
  return CATEGORY_POLICY[category].plan_gate_mode;
}

// ─── Canonical hashing ────────────────────────────────────────────────────────

/** Deterministic JSON: sorted object keys, no whitespace, arrays in given order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Hex(payload: string | Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The bound-arguments hash covers everything that determines what will run:
 * the canonical command, the target, and the effective category. It is
 * computed before the operator sees the request, and an approval nonce is
 * bound to it. Any change to these fields produces a different hash and
 * invalidates outstanding approvals.
 */
export function computeBoundArgumentsSha256(request: ElevatedTaskRequest, effectiveCategory: ElevatedCategory): string {
  return sha256Hex(
    canonicalJson({
      argv: request.command.argv,
      cwd: request.command.cwd,
      stdin: request.command.stdin,
      env_keys: [...request.env_keys].sort(),
      resources: [...request.resources].sort(),
      target: request.target,
      category: effectiveCategory,
    }),
  );
}

/** Hash of the full redacted-safe request (no secrets are permitted in a request). */
export function computeRequestSha256(request: ElevatedTaskRequest): string {
  return sha256Hex(canonicalJson(request));
}

// ─── Identity ─────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ELEVATED_REQUEST_ID = /^et-[0-9A-HJKMNP-TV-Z]{26}$/;

export function crockfordUlid(now: Date = new Date(), random: (bytes: number) => Uint8Array = (n) => randomBytes(n)): string {
  let time = now.getTime();
  const timeChars: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    timeChars.unshift(CROCKFORD[time % 32]!);
    time = Math.floor(time / 32);
  }
  const bytes = random(10);
  let randomChars = "";
  for (let index = 0; index < 16; index += 1) {
    randomChars += CROCKFORD[bytes[index % bytes.length]! % 32];
  }
  return `${timeChars.join("")}${randomChars}`;
}

export function newElevatedRequestId(now?: Date): string {
  return `et-${crockfordUlid(now)}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_ARGV = 256;
export const MAX_ARG_LENGTH = 4096;
export const MAX_STDIN_BYTES = 64 * KIB;
export const MAX_REASON_LENGTH = 2000;
export const MAX_RESOURCES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(issues: ElevatedIssue[], value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ path: `${path}/${key}`, message: "unknown field" });
  }
  for (const key of allowed) {
    if (!(key in value)) issues.push({ path: `${path}/${key}`, message: "missing field" });
  }
}

export function validateElevatedTaskRequest(input: unknown): { ok: boolean; issues: ElevatedIssue[] } {
  const issues: ElevatedIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "", message: "expected object" }] };
  checkKeys(issues, input, "", [
    "contract_id",
    "schema_version",
    "client_request_id",
    "principal",
    "requested_category",
    "target",
    "command",
    "env_keys",
    "resources",
    "reason",
    "submitted_at",
  ]);
  if (input.contract_id !== ELEVATED_TASK_CONTRACT_ID) issues.push({ path: "/contract_id", message: "invalid contract id" });
  if (input.schema_version !== ELEVATED_SCHEMA_VERSION) issues.push({ path: "/schema_version", message: "invalid schema version" });
  if (typeof input.client_request_id !== "string" || !CLIENT_REQUEST_ID.test(input.client_request_id)) {
    issues.push({ path: "/client_request_id", message: "expected 1-128 chars of [A-Za-z0-9._:-]" });
  }
  if (!isRecord(input.principal)) {
    issues.push({ path: "/principal", message: "expected object" });
  } else {
    checkKeys(issues, input.principal, "/principal", ["kind", "id"]);
    if (!ELEVATED_PRINCIPAL_KINDS.includes(input.principal.kind as ElevatedPrincipalKind)) {
      issues.push({ path: "/principal/kind", message: "invalid principal kind" });
    }
    if (typeof input.principal.id !== "string" || input.principal.id.length === 0 || input.principal.id.length > 256) {
      issues.push({ path: "/principal/id", message: "expected non-empty string" });
    }
  }
  if (!isElevatedCategory(input.requested_category)) issues.push({ path: "/requested_category", message: "invalid category" });
  if (!ELEVATED_TARGETS.includes(input.target as ElevatedTarget)) issues.push({ path: "/target", message: "invalid target" });
  if (!isRecord(input.command)) {
    issues.push({ path: "/command", message: "expected object" });
  } else {
    checkKeys(issues, input.command, "/command", ["argv", "cwd", "stdin"]);
    const argv = input.command.argv;
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGV) {
      issues.push({ path: "/command/argv", message: `expected 1-${MAX_ARGV} strings` });
    } else {
      argv.forEach((arg, index) => {
        if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || arg.includes("\0")) {
          issues.push({ path: `/command/argv/${index}`, message: "expected string without NUL" });
        }
      });
      if (typeof argv[0] === "string" && argv[0].trim().length === 0) {
        issues.push({ path: "/command/argv/0", message: "program must be non-empty" });
      }
    }
    if (typeof input.command.cwd !== "string" || !input.command.cwd.startsWith("/") || input.command.cwd.includes("\0")) {
      issues.push({ path: "/command/cwd", message: "expected absolute path" });
    }
    if (input.command.stdin !== null) {
      if (typeof input.command.stdin !== "string") {
        issues.push({ path: "/command/stdin", message: "expected string or null" });
      } else if (Buffer.byteLength(input.command.stdin, "utf8") > MAX_STDIN_BYTES) {
        issues.push({ path: "/command/stdin", message: `stdin exceeds ${MAX_STDIN_BYTES} bytes` });
      }
    }
  }
  if (!Array.isArray(input.env_keys)) {
    issues.push({ path: "/env_keys", message: "expected array" });
  } else {
    input.env_keys.forEach((key, index) => {
      if (typeof key !== "string" || !ENV_KEY.test(key)) issues.push({ path: `/env_keys/${index}`, message: "invalid environment key" });
    });
    if (new Set(input.env_keys).size !== input.env_keys.length) issues.push({ path: "/env_keys", message: "duplicate keys" });
  }
  if (!Array.isArray(input.resources) || input.resources.length > MAX_RESOURCES) {
    issues.push({ path: "/resources", message: `expected array of at most ${MAX_RESOURCES}` });
  } else {
    input.resources.forEach((resource, index) => {
      if (typeof resource !== "string" || resource.length === 0 || resource.length > 512 || resource.includes("\0")) {
        issues.push({ path: `/resources/${index}`, message: "expected non-empty string" });
      }
    });
    if (new Set(input.resources).size !== input.resources.length) issues.push({ path: "/resources", message: "duplicate resources" });
  }
  if (typeof input.reason !== "string" || input.reason.trim().length === 0 || input.reason.length > MAX_REASON_LENGTH) {
    issues.push({ path: "/reason", message: `expected non-empty string of at most ${MAX_REASON_LENGTH} chars` });
  }
  if (typeof input.submitted_at !== "string" || !TIMESTAMP.test(input.submitted_at) || Number.isNaN(Date.parse(input.submitted_at))) {
    issues.push({ path: "/submitted_at", message: "expected RFC 3339 timestamp" });
  }
  return { ok: issues.length === 0, issues };
}

// ─── Classification ───────────────────────────────────────────────────────────

/** Minimal detector result the classifier consumes (full shape in elevated-task-detector.ts). */
export interface DetectorSummary {
  verdict: DetectorVerdict;
  minimum_category: ElevatedCategory | null;
  rule_ids: string[];
}

export interface ClassificationOptions {
  /** Effective authority-envelope rung cap for the principal. Defaults to `production` (no cap). */
  rung_cap?: ElevatedCategory;
  /** Rollout mode. Anything but `enforce` never acts. */
  mode?: ElevatedMode;
  now?: Date;
  request_id?: string;
}

export interface ElevatedTaskDecision {
  contract_id: typeof ELEVATED_TASK_CONTRACT_ID;
  schema_version: typeof ELEVATED_SCHEMA_VERSION;
  request_id: string;
  request_sha256: string | null;
  bound_arguments_sha256: string | null;
  requested_category: ElevatedCategory | null;
  effective_category: ElevatedCategory | null;
  target: ElevatedTarget | null;
  detector: DetectorSummary;
  policy_rule_id: string | null;
  policy: CategoryPolicy | null;
  outcome: ClassificationOutcome;
  status: ElevatedStatus;
  reasons: ClassificationReason[];
  issues: ElevatedIssue[];
  mode: ElevatedMode;
  /** True only when the mode is `enforce` and the outcome permits execution or approval. */
  acted: boolean;
  classified_at: string;
}

export function resolveElevatedMode(env: Record<string, string | undefined>): ElevatedMode {
  if (env[ELEVATED_ENABLED_ENV] !== "1") return "disabled";
  const mode = env[ELEVATED_MODE_ENV];
  return mode === "enforce" ? "enforce" : "shadow";
}

export function classifyElevatedTask(
  input: unknown,
  detector: DetectorSummary,
  options: ClassificationOptions = {},
): ElevatedTaskDecision {
  const now = options.now ?? new Date();
  const mode = options.mode ?? "shadow";
  const requestId = options.request_id ?? newElevatedRequestId(now);
  const validation = validateElevatedTaskRequest(input);
  const reasons: ClassificationReason[] = [];
  const base: Omit<ElevatedTaskDecision, "outcome" | "status" | "acted"> = {
    contract_id: ELEVATED_TASK_CONTRACT_ID,
    schema_version: ELEVATED_SCHEMA_VERSION,
    request_id: requestId,
    request_sha256: null,
    bound_arguments_sha256: null,
    requested_category: null,
    effective_category: null,
    target: null,
    detector: { verdict: detector.verdict, minimum_category: detector.minimum_category, rule_ids: [...detector.rule_ids] },
    policy_rule_id: null,
    policy: null,
    outcome: undefined as never,
    reasons,
    issues: validation.issues,
    mode,
    classified_at: now.toISOString(),
  } as Omit<ElevatedTaskDecision, "outcome" | "status" | "acted">;

  const finish = (outcome: ClassificationOutcome, status: ElevatedStatus): ElevatedTaskDecision => {
    if (mode === "disabled") reasons.push("elevated_disabled");
    else if (mode === "shadow") reasons.push("shadow_mode");
    const acted = mode === "enforce" && (outcome === "auto_execute" || outcome === "await_approval");
    return { ...base, outcome, status, acted };
  };

  if (!validation.ok) {
    reasons.push("malformed_request");
    return finish("rejected", "rejected");
  }
  const request = input as ElevatedTaskRequest;
  base.request_sha256 = computeRequestSha256(request);
  base.requested_category = request.requested_category;
  base.target = request.target;

  // Target minimum: anything outside the repo worktree is production by definition.
  let effective: ElevatedCategory = request.requested_category;
  if (request.target === "full-vps" && categoryIndex(effective) < categoryIndex("production")) {
    effective = "production";
    reasons.push("target_requires_production");
  }

  // Detector can only raise or reject; a miss never lowers.
  if (detector.verdict === "reject") {
    reasons.push("detector_reject");
    base.effective_category = maxCategory(effective, detector.minimum_category);
    base.bound_arguments_sha256 = computeBoundArgumentsSha256(request, base.effective_category ?? effective);
    return finish("rejected", "rejected");
  }
  if (detector.verdict === "unclassifiable") {
    reasons.push("detector_unclassifiable");
    base.effective_category = maxCategory(effective, detector.minimum_category);
    base.bound_arguments_sha256 = computeBoundArgumentsSha256(request, base.effective_category ?? effective);
    return finish("held", "held");
  }
  if (detector.verdict === "raise" && detector.minimum_category !== null) {
    const raised = maxCategory(effective, detector.minimum_category)!;
    if (raised !== effective) reasons.push("detector_raised_category");
    effective = raised;
  }
  base.effective_category = effective;
  base.bound_arguments_sha256 = computeBoundArgumentsSha256(request, effective);
  const policy = policyFor(effective);
  base.policy = policy;
  base.policy_rule_id = policy.rule_id;

  const cap = options.rung_cap ?? "production";
  if (categoryIndex(effective) > categoryIndex(cap)) {
    reasons.push("rung_cap_exceeded");
    return finish("held", "held");
  }
  if (!policy.targets.includes(request.target)) {
    reasons.push("target_not_allowed_for_category");
    return finish("held", "held");
  }
  if (policy.execution === "approval") {
    reasons.push("approval_required");
    return finish("await_approval", "awaiting_approval");
  }
  reasons.push("auto_execute_permitted");
  return finish("auto_execute", "classified");
}

// ─── Explicit-Approval Escalation ───────────────────────────────────────────

export interface ElevatedApproval {
  contract_id: typeof ELEVATED_TASK_CONTRACT_ID;
  schema_version: typeof ELEVATED_SCHEMA_VERSION;
  request_id: string;
  /** Cryptographically bound arguments hash to prevent any command manipulation in flight (T4, R4). */
  bound_arguments_sha256: string;
  /** Single-use nonce issued during classification, bound to this specific request. */
  nonce: string;
  /** Optional SHA-256 hash of the secondary approval secret (mandatory for production tier). */
  second_secret_hash?: string;
  /** SHA-256 prefix/fingerprint of the operator token used to sign/approve this task. */
  approver_fingerprint: string;
  approved_at: string;
}

export interface VerifyApprovalOptions {
  /** The current validation time. Defaults to new Date(). */
  now?: Date;
  /** The expected active nonce for the request. */
  expected_nonce?: string;
  /** Stored second secret hash used to verify the provided secondary secret. */
  stored_second_secret_hash?: string;
  /** The secondary secret provided at approval time (not persisted in localStorage). */
  second_secret?: string;
}

/**
 * Validates an operator approval against the request, decision, and policy.
 * Any modification of command arguments, target, or category invalidates the approval
 * because the bound_arguments_sha256 will no longer match (defense-in-depth, R4).
 */
export function verifyApproval(
  request: ElevatedTaskRequest,
  decision: ElevatedTaskDecision,
  approval: ElevatedApproval,
  options: VerifyApprovalOptions = {},
): { ok: boolean; message?: string } {
  const now = options.now ?? new Date();

  if (approval.contract_id !== ELEVATED_TASK_CONTRACT_ID) {
    return { ok: false, message: "invalid approval contract id" };
  }
  if (approval.schema_version !== ELEVATED_SCHEMA_VERSION) {
    return { ok: false, message: "invalid approval schema version" };
  }
  if (approval.request_id !== decision.request_id) {
    return {
      ok: false,
      message: `request id mismatch: expected ${decision.request_id}, got ${approval.request_id}`,
    };
  }

  // 1. Bound-arguments cryptographic binding check (T4, R4)
  const expectedBoundArgsSha256 = decision.bound_arguments_sha256;
  if (!expectedBoundArgsSha256 || approval.bound_arguments_sha256 !== expectedBoundArgsSha256) {
    return {
      ok: false,
      message: "bound arguments hash mismatch: any change to command, target, or category invalidates approvals",
    };
  }

  // Ensure the current request matches the cryptographic signature of the approval
  const requestBoundArgsSha256 = computeBoundArgumentsSha256(request, decision.effective_category ?? request.requested_category);
  if (requestBoundArgsSha256 !== approval.bound_arguments_sha256) {
    return {
      ok: false,
      message: "bound arguments hash mismatch: request does not match the approved command, target, or category",
    };
  }

  const policy = decision.policy;
  if (!policy) {
    return { ok: false, message: "no category policy in decision" };
  }

  // 2. Nonce validation
  if (policy.approval.nonce) {
    if (!options.expected_nonce) {
      return { ok: false, message: "policy requires nonce but no expected nonce was provided for validation" };
    }
    if (approval.nonce !== options.expected_nonce) {
      return { ok: false, message: "nonce mismatch" };
    }

    const classifiedTime = Date.parse(decision.classified_at);
    if (Number.isNaN(classifiedTime)) {
      return { ok: false, message: "invalid classification timestamp in decision" };
    }
    const approvedTime = Date.parse(approval.approved_at);
    if (Number.isNaN(approvedTime)) {
      return { ok: false, message: "invalid approval timestamp" };
    }

    // Nonce TTL check
    const ttl = policy.nonce_ttl_ms;
    if (approvedTime - classifiedTime > ttl) {
      return { ok: false, message: "approval nonce has expired" };
    }
    const nowTime = now.getTime();
    if (nowTime - classifiedTime > ttl) {
      return { ok: false, message: "nonce has expired at validation time" };
    }
  }

  // 3. Second-secret validation (mandatory for production / full-vps tier)
  if (policy.approval.second_secret) {
    if (options.stored_second_secret_hash) {
      if (!options.second_secret) {
        return { ok: false, message: "policy requires second secret but none was provided" };
      }
      const hashedInput = sha256Hex(options.second_secret);
      if (hashedInput !== options.stored_second_secret_hash) {
        return { ok: false, message: "invalid second secret" };
      }
    } else if (approval.second_secret_hash) {
      if (!options.second_secret) {
        return { ok: false, message: "policy requires second secret but none was provided" };
      }
      const hashedInput = sha256Hex(options.second_secret);
      if (hashedInput !== approval.second_secret_hash) {
        return { ok: false, message: "invalid second secret" };
      }
    } else {
      return { ok: false, message: "policy requires second secret but no verification hash is available" };
    }
  }

  return { ok: true };
}

// ─── Execution Bounds ───────────────────────────────────────────────────────────

export interface ElevatedExecutionResult {
  request_id: string;
  exit_code: number | null;
  signal: string | null;
  /** Full or truncated stdout + stderr, redacted of secrets. */
  output: string;
  /** Hash of the UNTRUNCATED output. */
  output_sha256: string;
  output_bytes: number;
  truncated: boolean;
  duration_ms: number;
  executed_at: string;
  completed_at: string;
}

/**
 * Computes the SHA-256 hash of the original untruncated output, then caps the returned
 * output safely to output_cap_bytes, avoiding half-UTF8 character splits at the boundary.
 */
export function truncateAndHashOutput(
  output: string,
  capBytes: number = OUTPUT_CAP_BYTES,
): { output: string; truncated: boolean; originalLength: number; sha256: string } {
  const hash = sha256Hex(output);
  const buf = Buffer.from(output, "utf8");
  const originalLength = buf.length;
  if (originalLength <= capBytes) {
    return { output, truncated: false, originalLength, sha256: hash };
  }
  const slicedBuf = buf.subarray(0, capBytes);
  let slicedStr = slicedBuf.toString("utf8");
  // If slicing cut a multibyte character in half, standard toString will put a replacement character (U+FFFD) at the end.
  if (slicedStr.length > 0 && slicedStr.codePointAt(slicedStr.length - 1) === 0xfffd) {
    slicedStr = slicedStr.slice(0, -1);
  }
  return { output: slicedStr, truncated: true, originalLength, sha256: hash };
}

// ─── Secret-Safe Audit Schema & Redaction ───────────────────────────────────────

export const DEFAULT_REDACT_PATTERNS = [
  /(bearer|token|auth|password|key|secret|credential|session|jwt|cookie)\s+([A-Za-z0-9._~%+\/-]{8,})/gi,
  /(bearer|token|auth|password|key|secret|credential|session|jwt|cookie)["']?\s*[:=]\s*["']?([A-Za-z0-9._~%+\/-]{8,})["']?/gi,
];

/**
 * Scrupolously redacts exact match secret values and regex patterns from any text.
 * Only exact strings >= 8 characters are redacted to avoid destroying ordinary text.
 */
export function redactSecrets(
  text: string,
  secrets: Set<string> | string[],
  patterns: RegExp[] = DEFAULT_REDACT_PATTERNS,
): string {
  if (!text) return text;
  let redacted = text;

  // 1. Value-based matching (exact secret value replacement)
  const secretSet = Array.isArray(secrets) ? new Set(secrets) : secrets;
  for (const secret of secretSet) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    // Escape special regex characters
    const escaped = secret.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(escaped, "g");
    redacted = redacted.replace(regex, "[REDACTED_SECRET]");
  }

  // 2. Key-name pattern-based matching (key-value patterns)
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match, ...args) => {
      const captureGroups = args.slice(0, -2) as string[];
      const secret = captureGroups[captureGroups.length - 1];
      if (!secret) return match;

      // Do not redact request ids
      if (secret.startsWith("et-") && secret.length === 29) return match;
      const index = match.lastIndexOf(secret);
      if (index !== -1) {
        return match.slice(0, index) + "[REDACTED_SECRET]" + match.slice(index + secret.length);
      }
      return "[REDACTED_SECRET]";
    });
  }

  return redacted;
}

export interface ElevatedAuditRecord {
  contract_id: typeof ELEVATED_AUDIT_CONTRACT_ID;
  schema_version: typeof ELEVATED_SCHEMA_VERSION;
  request_id: string;
  request_sha256: string;
  bound_arguments_sha256: string;
  principal: { kind: ElevatedPrincipalKind; id: string };
  category: ElevatedCategory;
  rule_id: string;
  detector_verdict: DetectorVerdict;
  approver_fingerprint: string | null;
  nonce_id: string | null;
  target: ElevatedTarget;
  argv: string[];
  cwd: string;
  env_keys: string[];
  resources: string[];
  reason: string;
  submitted_at: string;
  classified_at: string;
  approved_at: string | null;
  executed_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  signal: string | null;
  duration_ms: number | null;
  output_sha256: string | null;
  output_bytes: number | null;
  truncated: boolean | null;
  error_message: string | null;
}

export function createAuditRecord(
  request: ElevatedTaskRequest,
  decision: ElevatedTaskDecision,
  approval: ElevatedApproval | null,
  result: ElevatedExecutionResult | null,
  errorMessage: string | null = null,
): ElevatedAuditRecord {
  return {
    contract_id: ELEVATED_AUDIT_CONTRACT_ID,
    schema_version: ELEVATED_SCHEMA_VERSION,
    request_id: decision.request_id,
    request_sha256: decision.request_sha256 ?? "",
    bound_arguments_sha256: decision.bound_arguments_sha256 ?? "",
    principal: { ...request.principal },
    category: decision.effective_category ?? request.requested_category,
    rule_id: decision.policy_rule_id ?? "",
    detector_verdict: decision.detector.verdict,
    approver_fingerprint: approval?.approver_fingerprint ?? null,
    nonce_id: approval?.nonce ?? null,
    target: request.target,
    argv: [...request.command.argv],
    cwd: request.command.cwd,
    env_keys: [...request.env_keys],
    resources: [...request.resources],
    reason: request.reason,
    submitted_at: request.submitted_at,
    classified_at: decision.classified_at,
    approved_at: approval?.approved_at ?? null,
    executed_at: result?.executed_at ?? null,
    completed_at: result?.completed_at ?? null,
    exit_code: result?.exit_code ?? null,
    signal: result?.signal ?? null,
    duration_ms: result?.duration_ms ?? null,
    output_sha256: result?.output_sha256 ?? null,
    output_bytes: result?.output_bytes ?? null,
    truncated: result?.truncated ?? null,
    error_message: errorMessage,
  };
}

/**
 * Produces a deeply redacted copy of the audit record, removing any secrets
 * from user-supplied text fields (argv, reason, error_message).
 */
export function redactAuditRecord(record: ElevatedAuditRecord, secrets: Set<string> | string[]): ElevatedAuditRecord {
  return {
    ...record,
    argv: record.argv.map((arg) => redactSecrets(arg, secrets)),
    reason: redactSecrets(record.reason, secrets),
    error_message: record.error_message ? redactSecrets(record.error_message, secrets) : null,
  };
}
