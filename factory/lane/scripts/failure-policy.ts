#!/usr/bin/env bun
/**
 * FH-02 (P0-2) — Typed failure policy.
 *
 * The ZBRE run retried deterministic defects unchanged. `gate_error` was a
 * catch-all: a `LINEUP_ROLE_CHAINS` value wrapped in Markdown backticks failed
 * at `JSON.parse`, was classified `gate_error`, and `gateCompletedExecution()`
 * repeated the byte-identical invocation. The same defect then propagated
 * through ZOU-929, ZOU-930, ZOU-931 and the first ZOU-933 attempt.
 *
 * This module is the single classifier. A failure is retryable only when its
 * class is *known to vary between attempts*. Everything else is either a
 * deterministic defect (repair once, never blind-retry) or a human decision.
 *
 * Consumers (reachability):
 *   - `factory-consensus.ts` `gateCompletedExecution()` — gates the retry loop.
 *   - `lane-halt.ts` — counts repeated deterministic fingerprints per project.
 *   - `project-preflight.ts` — emits `configuration_error` findings pre-promotion.
 */

export const FAILURE_CLASSES = [
  "configuration_error",
  "provider_unavailable",
  "quality_rejection",
  "quality_split",
  "executor_failure",
  "shipping_failure",
  "transient",
  "unknown",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Disposition drives control flow; the class only names the cause. */
export type FailureDisposition =
  /** Vary the attempt (backoff, re-lineup) and try again. */
  | "retry"
  /** Deterministic: repair the input once, then re-run. Never blind-retry. */
  | "repair"
  /** Requires a human decision; hold and notify. */
  | "escalate";

export interface FailureVerdict {
  failure_class: FailureClass;
  disposition: FailureDisposition;
  /** Stable identity of the *defect*, for repeat detection across tickets. */
  fingerprint: string;
  /** Why this classification fired — surfaced in escalation packets. */
  rationale: string;
  /** Which field/route the defect is attributable to, when derivable. */
  subject: string | null;
}

const DISPOSITION: Readonly<Record<FailureClass, FailureDisposition>> = {
  configuration_error: "repair",
  provider_unavailable: "retry",
  quality_rejection: "repair",
  quality_split: "escalate",
  executor_failure: "retry",
  shipping_failure: "retry",
  transient: "retry",
  unknown: "escalate",
};

export function dispositionFor(failureClass: FailureClass): FailureDisposition {
  return DISPOSITION[failureClass];
}

/**
 * Only `retry` may repeat an unchanged invocation. `repair` must mutate the
 * input first; `escalate` must not re-run at all.
 */
export function isBlindRetryable(failureClass: FailureClass): boolean {
  return DISPOSITION[failureClass] === "retry";
}

/** A defect that will recur identically until an input changes. */
export function isDeterministic(failureClass: FailureClass): boolean {
  return DISPOSITION[failureClass] === "repair" || failureClass === "unknown";
}

export interface ClassifyInput {
  /** Existing `FactoryConsensusReasonCode`, when the failure came from the gate. */
  reason_code?: string | null;
  /** Error text as recorded on the execution or thrown by a step. */
  message?: string | null;
  /** Conveyor step that produced the failure (executor, consensus, shipping…). */
  stage?: string | null;
}

/** Env keys a malformed Model Policy can carry. Order matters: longest first. */
const POLICY_FIELDS = [
  "LINEUP_ROLE_CHAINS",
  "LINEUP_PIN_AGGREGATOR",
  "LINEUP_PIN_PROPOSERS",
  "CG_OPENROUTER_FAILOVER",
  "CG_OPENCODE_FAILOVER",
  "FACTORY_MODEL_CHAIN",
] as const;

/**
 * Deterministic-configuration signatures. Each is a defect in *input we
 * control*, so no number of retries can clear it.
 */
const CONFIGURATION_SIGNALS: ReadonlyArray<{ pattern: RegExp; rationale: string }> = [
  {
    pattern: /Unrecognized token|Unexpected token .* is not valid JSON|JSON Parse error|is not valid JSON|Unexpected end of JSON input/i,
    rationale: "a policy or contract value failed to parse as JSON",
  },
  {
    pattern: /must contain 1-12 model ids|contains invalid model id|must contain exactly one model id|must be 0 or 1|must not be empty/i,
    rationale: "a Model Policy value was rejected by the production parser",
  },
  {
    pattern: /unknown (?:provider|model|alias)|unsupported provider|no such (?:branch|repository)/i,
    rationale: "a policy referenced an identifier that does not resolve",
  },
  {
    pattern: /has no diff against origin\/main|has no branch name/i,
    rationale: "the execution produced nothing reviewable",
  },
  {
    pattern: /schema|invalid contract|missing required field/i,
    rationale: "a ticket contract failed schema validation",
  },
];

/** Typed harness transport failures eligible for one bounded execution recovery. */
const TRANSIENT_SIGNALS: ReadonlyArray<RegExp> = [/\b(?:fail\([^)]*\)|throw):transport:/i];

/** Provider-scoped failures that require route rotation rather than replay. */
const PROVIDER_SIGNALS: ReadonlyArray<RegExp> = [
  /\b(?:429|500|502|503|504|529)\b/,
  /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i,
  /rate.?limit|overloaded|capacity|temporarily unavailable/i,
  /no responsive quorum|emitted no machine result|empty response/i,
];

/** Auth/routing failures: permanent for the credential, not for the ticket. */
const CREDENTIAL_SIGNALS = /\b(?:400|401|403|404)\b|unauthorized|forbidden|invalid api key|not found/i;

function normalize(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\bexec-[0-9a-f]{6,}\b/gi, "<exec>")
    .replace(/\b[A-Z]{2,6}-\d+\b/g, "<ticket>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<ts>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function subjectOf(message: string): string | null {
  for (const field of POLICY_FIELDS) {
    if (message.includes(field)) return field;
  }
  return null;
}

/**
 * Classify one failure. Pure — no I/O, no clock.
 *
 * Precedence is deliberate: a deterministic signature wins over a transport
 * signature, because a malformed policy can *also* surface a timeout downstream
 * and retrying that would repeat the original defect.
 */
export function classifyFailure(input: ClassifyInput): FailureVerdict {
  const message = (input.message ?? "").trim();
  const stage = (input.stage ?? "").trim();
  const subject = subjectOf(message);

  const build = (failureClass: FailureClass, rationale: string): FailureVerdict => ({
    failure_class: failureClass,
    disposition: DISPOSITION[failureClass],
    fingerprint: `${failureClass}:${normalize(message) || stage || "unspecified"}`,
    rationale,
    subject,
  });

  // Gate reason codes that are already unambiguous.
  if (input.reason_code === "quality_rejected") {
    return build("quality_rejection", "consensus rejected the implementation on quality grounds");
  }
  if (input.reason_code === "quality_split") {
    return build("quality_split", "consensus reviewers require human adjudication");
  }
  // ZOU-1103 — the deterministic stub scanner rejected obviously-incomplete work
  // before the panel ran. Deterministic (repair): the same diff always fails,
  // so it must never be blind-retried; the reason feeds the retry brief.
  if (input.reason_code === "stub_rejected") {
    return build("quality_rejection", "deterministic stub scan rejected obviously-incomplete work");
  }

  // A configuration defect is deterministic wherever it surfaces.
  for (const signal of CONFIGURATION_SIGNALS) {
    if (signal.pattern.test(message)) return build("configuration_error", signal.rationale);
  }

  // A policy field named in the message is a configuration defect even when the
  // wording is novel — the parser only names a field when it rejected it.
  if (subject) {
    return build("configuration_error", `${subject} was rejected before the call was made`);
  }

  if (input.reason_code === "vendor_unavailable") {
    return build("provider_unavailable", "no LLM vendor returned a usable verdict");
  }

  if (CREDENTIAL_SIGNALS.test(message)) {
    // Permanent for that route, but re-lineup can route around it, so this is a
    // retry with a *changed* lineup — not a blind repeat of the same seat.
    return build("provider_unavailable", "a provider route returned an auth or routing failure");
  }

  if (stage === "executor") {
    for (const signal of TRANSIENT_SIGNALS) {
      if (signal.test(message)) return build("transient", "the executor harness reported a typed transport failure");
    }
    if (/\b(?:fail\([^)]*\)|throw):execution:/i.test(message)) {
      return build("executor_failure", "the executor reported a non-transport execution failure");
    }
  }

  for (const signal of PROVIDER_SIGNALS) {
    if (signal.test(message)) return build("provider_unavailable", "a provider route requires rotation");
  }

  if (stage === "shipping" || /shipping|merge queue|auto-merge|pull request/i.test(message)) {
    return build("shipping_failure", "post-approval shipping did not reach a terminal state");
  }

  if (stage === "executor" || /executor|harness|worktree/i.test(message)) {
    return build("executor_failure", "the executor harness failed to complete");
  }

  if (input.reason_code === "gate_not_run") {
    return build("transient", "the gate was not reached for this execution stage");
  }

  return build("unknown", message ? "no classifier matched this failure" : "failure recorded with no message");
}

/**
 * Two occurrences of the same fingerprint within one project is the halt
 * condition (FH-07). Only deterministic classes count — a provider timing out
 * twice is expected, a policy failing to parse twice is propagation.
 */
export function countsTowardHalt(verdict: FailureVerdict): boolean {
  return isDeterministic(verdict.failure_class);
}

export function formatVerdict(verdict: FailureVerdict): string {
  const subject = verdict.subject ? ` [${verdict.subject}]` : "";
  return `${verdict.failure_class}/${verdict.disposition}${subject} — ${verdict.rationale}`;
}
