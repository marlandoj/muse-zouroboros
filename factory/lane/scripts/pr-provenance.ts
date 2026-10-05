#!/usr/bin/env bun
/**
 * FH-15 (P1-12) — Validate pull-request title and body provenance.
 *
 * PR #400 was opened with an executor-narration title. PR #401 fixed the
 * symptom by bounding title *length*, but `buildPullRequestTitle()` still
 * derives from `execution.result_summary` — free text the harness produced.
 * A bounded piece of narration is still narration: length was never what made
 * the title wrong.
 *
 * The title an operator reads has to come from something that was verified.
 * `deriveTitle()` prefers the Linear ticket title, falls back to the execution
 * summary only when no ticket title exists, and records which source it used so
 * the choice is auditable rather than implicit.
 *
 * `validateProvenance()` is the assertion that runs before creation. It rejects
 * the narration shapes actually observed — first-person commentary, "I've
 * implemented…", trailing ellipses from truncation, a title that is only the
 * ticket id, and a body that cites no verified evidence.
 *
 * Reachability: `ship-ready-runner.ts` calls `deriveTitle()` in place of the
 * old builder and asserts `validateProvenance()` before `gh pr create`.
 */

/**
 * GitHub's hard cap, and the single source of truth for it — shipped by
 * PR #401 as `MAX_PULL_REQUEST_TITLE_LENGTH` in `ship-ready-runner.ts`, which
 * now re-exports this constant rather than keeping a second copy.
 *
 * FH-15 deliberately does NOT tighten this. The defect in PR #400 was where the
 * title came from, not how long it was, and quietly narrowing a bound shipped a
 * week ago would be an unrelated behaviour change riding along.
 */
export const MAX_TITLE_LENGTH = 256;
export const MIN_TITLE_LENGTH = 12;

export type TitleSource = "linear_ticket" | "execution_summary" | "fallback";

export interface TitleDerivation {
  title: string;
  source: TitleSource;
  /** True when the untruncated candidate exceeded the cap. */
  truncated: boolean;
}

export interface ProvenanceInput {
  identifier: string;
  /** Title of the Linear ticket. The preferred source. */
  ticket_title?: string | null;
  /** Executor narration. Used only when no ticket title exists. */
  result_summary?: string | null;
  execution_id: string;
}

const TICKET_ID = /^[A-Z]{2,6}-\d+$/;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Strip a leading ticket id so `ZOU-933: ZOU-933: …` cannot happen. */
function withoutIdentifier(value: string, identifier: string): string {
  return clean(value.replace(new RegExp(`^${identifier}\\s*[:\\-—]\\s*`, "i"), ""));
}

/**
 * Normalise a Linear ticket title into the `ticket_title` an execution record
 * carries for `deriveTitle`.
 *
 * Nothing wrote that field before ZOU-954, so `deriveTitle` always fell through
 * to `result_summary` — raw executor narration ("I'll start by verifying remote
 * state…"), which trips the `narration_voice` check and makes the shipper refuse
 * to open the PR at all. ZOU-953 stranded on it and had to be backfilled by
 * hand; ZOU-951 only escaped because its PR was merged out of band, so the
 * shipper took the `already_merged` path and never built a title.
 *
 * Leading bracketed groups are queue routing metadata — `[Factory Intake]`,
 * `[OFS-006]` — not a description of the change, so they are dropped. A title
 * that is nothing but brackets keeps its original text rather than becoming
 * empty and silently falling back to narration again.
 */
export function ticketTitleForExecution(title: string | null | undefined): string | null {
  const raw = clean(title ?? "");
  if (!raw) return null;
  const stripped = clean(raw.replace(/^(?:\s*\[[^\]]*\])+/, ""));
  return stripped || raw;
}

export function deriveTitle(input: ProvenanceInput): TitleDerivation {
  const ticketTitle = clean(input.ticket_title ?? "");
  const summary = clean(input.result_summary ?? "");

  let source: TitleSource;
  let subject: string;
  if (ticketTitle && !TICKET_ID.test(ticketTitle)) {
    source = "linear_ticket";
    subject = withoutIdentifier(ticketTitle, input.identifier);
  } else if (summary) {
    source = "execution_summary";
    subject = withoutIdentifier(summary, input.identifier);
  } else {
    source = "fallback";
    subject = `factory execution ${input.execution_id}`;
  }

  const full = `${input.identifier}: ${subject}`;
  const truncated = Array.from(full).length > MAX_TITLE_LENGTH;
  // Truncate on a word boundary where possible — a mid-word cut reads as
  // corruption and is what made PR #400's title look machine-generated.
  let title = full;
  if (truncated) {
    const hard = Array.from(full).slice(0, MAX_TITLE_LENGTH).join("");
    const lastSpace = hard.lastIndexOf(" ");
    title = (lastSpace > input.identifier.length + 8 ? hard.slice(0, lastSpace) : hard).trimEnd();
  }

  return { title, source, truncated };
}

export type ProvenanceViolation =
  | "missing_identifier"
  | "too_short"
  | "too_long"
  | "identifier_only"
  | "narration_voice"
  | "truncation_artifact"
  | "unverified_body";

export interface ProvenanceVerdict {
  ok: boolean;
  violations: ProvenanceViolation[];
  reasons: string[];
}

/**
 * First-person and conversational openers. These are the shapes an executor
 * emits when it narrates rather than names a change.
 */
const NARRATION = [
  /\b(?:I|I've|I'll|I have|we|we've|let me|here'?s)\b/i,
  /\b(?:successfully|now|just)\s+(?:implemented|added|created|fixed|updated)\b/i,
  /^\s*(?:okay|sure|done|great)\b/i,
  /\b(?:as requested|per your request)\b/i,
];

export function validateProvenance(input: {
  identifier: string;
  title: string;
  body?: string | null;
  /** Evidence references the body must cite — gate id, checks, commit. */
  evidence?: readonly string[];
}): ProvenanceVerdict {
  const violations: ProvenanceViolation[] = [];
  const reasons: string[] = [];
  const title = input.title ?? "";
  const add = (violation: ProvenanceViolation, reason: string) => {
    violations.push(violation);
    reasons.push(reason);
  };

  if (!title.startsWith(`${input.identifier}:`)) {
    add("missing_identifier", `title must begin with "${input.identifier}:"`);
  }

  const length = Array.from(title).length;
  if (length > MAX_TITLE_LENGTH) add("too_long", `title is ${length} characters; cap is ${MAX_TITLE_LENGTH}`);
  if (length < MIN_TITLE_LENGTH) add("too_short", `title is ${length} characters; minimum is ${MIN_TITLE_LENGTH}`);

  const subject = clean(title.replace(new RegExp(`^${input.identifier}\\s*:\\s*`), ""));
  if (!subject) add("identifier_only", "title carries no subject beyond the ticket identifier");

  for (const pattern of NARRATION) {
    if (pattern.test(subject)) {
      add("narration_voice", "title reads as executor narration rather than a change description");
      break;
    }
  }

  if (/(?:\.\.\.|…)$/.test(title.trimEnd())) {
    add("truncation_artifact", "title ends in an ellipsis — it was cut rather than composed");
  }

  // A body with no verified reference is unauditable. Absence of a body is
  // permitted; a body that cites nothing is not.
  if (input.body !== undefined && input.body !== null && clean(input.body).length > 0) {
    const cites = (input.evidence ?? []).some((reference) => reference && input.body!.includes(reference));
    if ((input.evidence ?? []).length > 0 && !cites) {
      add("unverified_body", "body cites none of the verified evidence references");
    }
  }

  return { ok: violations.length === 0, violations, reasons };
}

/**
 * Convenience for callers that want a title and its assertion in one step.
 * Throws rather than returning a bad title: opening a PR is the point of no
 * return, and PR #400 showed that a wrong title outlives the run.
 */
export function derivedTitleOrThrow(input: ProvenanceInput): TitleDerivation {
  const derivation = deriveTitle(input);
  const verdict = validateProvenance({ identifier: input.identifier, title: derivation.title });
  if (!verdict.ok) {
    throw new Error(`pull request title failed provenance validation: ${verdict.reasons.join("; ")}`);
  }
  return derivation;
}
