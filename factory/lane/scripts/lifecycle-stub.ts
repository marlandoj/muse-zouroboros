/**
 * lifecycle-stub.ts — Local stand-ins for the skill-security-gate lifecycle
 * modules (Skills/skill-security-gate/scripts/lifecycle/*).
 *
 * The upstream modules are not vendored in this distribution.
 *
 * Faithfully reimplemented (pure, deterministic, no authority):
 * - canonicalJson / sha256 / canonicalHash — stable content hashing used for
 *   dedupe keys and revision hashes. Bit-identical to upstream.
 * - validateLifecycleTransition — purely structural state-machine check.
 *   Bit-identical to upstream.
 *
 * Fail-closed:
 * - validateLifecycleRecord always returns DENY with reason
 *   "lifecycle validation is not vendored". The deep validation (identity
 *   canonicalization, security evidence, evaluation contracts) requires the
 *   full upstream module. In the shadow bridge this surfaces as a HOLD
 *   disposition, never a promotion recommendation.
 */

import { createHash } from "node:crypto";

export type Sha256Digest = `sha256:${string}`;

export type LifecycleState =
  | "candidate"
  | "quarantined"
  | "approved"
  | "promoted"
  | "rejected"
  | "rolled_back";

export type LifecycleDecision = "PASS" | "HOLD" | "DENY";

export interface LifecycleIssue {
  code: string;
  disposition: Exclude<LifecycleDecision, "PASS">;
  path: string;
  message: string;
}

export interface LifecycleGateResult {
  decision: LifecycleDecision;
  subjectHash: Sha256Digest | null;
  issues: LifecycleIssue[];
}

export interface SkillLifecycleRecord {
  schemaVersion: 1;
  subjectHash: Sha256Digest;
  identity: Record<string, unknown>;
  state: LifecycleState;
  security: Record<string, unknown>;
  evaluation: Record<string, unknown>;
}

export interface EvaluationTaskClass {
  name: string;
  version: string;
  required: boolean;
  inputContractHash: Sha256Digest;
  outputContractHash: Sha256Digest;
  verifierContractHash: Sha256Digest;
  fixtureHashes: Sha256Digest[];
  minimumScore: number;
}

export interface CompatibilityRow {
  taskClass: string;
  taskClassVersion: string;
  subjectHash: Sha256Digest;
  contractHash: Sha256Digest;
  model: {
    provider: string;
    id: string;
    revision: string;
  };
  harness: {
    name: string;
    version: string;
    configHash: Sha256Digest;
  };
  seed: string;
  passed: boolean;
  score: number;
  threshold: number;
  cost: {
    amount: number;
    currency: string;
  };
  latencyMs: number;
  receiptHash: Sha256Digest;
  failure: string | null;
  contamination: {
    checked: boolean;
    detected: boolean;
    evidenceHash: Sha256Digest;
  };
}

export interface LifecycleGateOptions {
  now?: Date | string | number;
  requireModelEvidence?: boolean;
}

// ─── canonical hashing (faithful) ────────────────────────────────────────────

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("canonical JSON accepts plain objects only");
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareUtf8)
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined)
          throw new Error(`canonical JSON rejects undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function sha256(value: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalHash(value: unknown): Sha256Digest {
  return sha256(canonicalJson(value));
}

// ─── lifecycle validation ────────────────────────────────────────────────────

const STATES = new Set<LifecycleState>([
  "candidate",
  "quarantined",
  "approved",
  "promoted",
  "rejected",
  "rolled_back",
]);

const TRANSITIONS = new Set([
  "candidate->quarantined",
  "quarantined->approved",
  "approved->promoted",
  "promoted->quarantined",
  "quarantined->rolled_back",
]);

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(
  issues: LifecycleIssue[],
  code: string,
  disposition: Exclude<LifecycleDecision, "PASS">,
  path: string,
  message: string,
): void {
  issues.push({ code, disposition, path, message });
}

/**
 * Fail-closed: the deep record validation (identity canonicalization,
 * security evidence, evaluation contracts) requires the full upstream
 * lifecycle module. Without it we cannot affirm a record, so we deny with a
 * clear reason. Callers surface this as HOLD, never as a promotion.
 */
export function validateLifecycleRecord(
  _raw: unknown,
  _options: LifecycleGateOptions = {},
): LifecycleGateResult {
  return {
    decision: "DENY",
    subjectHash: null,
    issues: [
      {
        code: "LIFECYCLE_VALIDATION_UNAVAILABLE",
        disposition: "DENY",
        path: "",
        message:
          "lifecycle record validation requires the skill-security-gate lifecycle module, which is not vendored in this distribution",
      },
    ],
  };
}

/**
 * Faithfully reimplemented: purely structural transition check.
 */
export function validateLifecycleTransition(
  previous: unknown,
  next: unknown,
): LifecycleGateResult {
  const issues: LifecycleIssue[] = [];
  const from = record(previous);
  const to = record(next);
  const subject =
    typeof to?.subjectHash === "string" && SHA256_RE.test(to.subjectHash)
      ? (to.subjectHash as Sha256Digest)
      : null;
  if (!from || !to) {
    issue(issues, "INVALID_RECORD", "DENY", "", "both transition records are required");
  } else {
    if (!STATES.has(from.state as LifecycleState) || !STATES.has(to.state as LifecycleState))
      issue(issues, "UNKNOWN_STATE", "DENY", "state", "transition contains an unknown state");
    else if (!TRANSITIONS.has(`${from.state}->${to.state}`))
      issue(
        issues,
        "UNKNOWN_TRANSITION",
        "DENY",
        "state",
        `${from.state} -> ${to.state} is not allowed`,
      );
    if (from.subjectHash !== to.subjectHash)
      issue(issues, "SUBJECT_HASH_MISMATCH", "DENY", "subjectHash", "transition cannot change subject identity");
    if (canonicalHash(from.identity) !== canonicalHash(to.identity))
      issue(issues, "IDENTITY_DRIFT", "DENY", "identity", "transition cannot mutate version identity");
  }
  return { decision: issues.length > 0 ? "DENY" : "PASS", subjectHash: subject, issues };
}
