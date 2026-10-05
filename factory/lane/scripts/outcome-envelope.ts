export const OUTCOME_ENVELOPE_SCHEMA = "zsf.outcome-envelope.v1" as const;
export const OUTCOME_ENVELOPE_VERSION = 1 as const;

export const OUTCOME_DISPOSITIONS = ["measured", "excluded", "held_unmeasured"] as const;
export const OUTCOME_TERMINAL_STATES = ["accepted", "failed", "held", "dry_run"] as const;
export const OUTCOME_EXCLUSION_CODES = [
  "invalid",
  "duplicate",
  "canceled",
  "superseded",
  "operator_aborted",
  "pre_instrumentation",
] as const;
export const OUTCOME_EVIDENCE_FAILURES = [
  "missing",
  "stale",
  "malformed",
  "duplicate",
  "forged",
  "mismatched",
] as const;

export type OutcomeDisposition = (typeof OUTCOME_DISPOSITIONS)[number];
export type OutcomeTerminalState = (typeof OUTCOME_TERMINAL_STATES)[number];
export type OutcomeExclusionCode = (typeof OUTCOME_EXCLUSION_CODES)[number];
export type OutcomeEvidenceFailure = (typeof OUTCOME_EVIDENCE_FAILURES)[number];
export type OutcomeVerdict = "pass" | "fail";
export type PullRequestFate = "none" | "open" | "closed" | "merged";

export interface OutcomeActor {
  id: string;
  harness: string;
  model: string;
}

export interface OutcomeVerification extends OutcomeActor {
  verdict: OutcomeVerdict;
  decided_at: string;
  commit_digest: string;
  evidence_digest: string;
}

export interface OutcomeExclusion {
  code: OutcomeExclusionCode;
  reason: string;
}

export interface OutcomeHold {
  code: OutcomeEvidenceFailure;
  detail: string;
}

export interface OutcomePullRequest {
  number: number | null;
  fate: PullRequestFate;
}

export interface OutcomeCost {
  amount_usd: number;
  source: string;
}

export interface OutcomeEnvelope {
  schema: typeof OUTCOME_ENVELOPE_SCHEMA;
  schema_version: typeof OUTCOME_ENVELOPE_VERSION;
  execution_id: string;
  ticket: string;
  terminal_state: OutcomeTerminalState;
  disposition: OutcomeDisposition;
  started_at: string;
  terminal_at: string;
  recorded_at: string;
  executor: OutcomeActor;
  commit_digest: string | null;
  verification: OutcomeVerification | null;
  exclusion: OutcomeExclusion | null;
  hold: OutcomeHold | null;
  pull_request: OutcomePullRequest;
  cost: OutcomeCost | null;
}

export type OutcomeEnvelopeParseResult =
  | { ok: true; envelope: OutcomeEnvelope }
  | { ok: false; errors: string[] };

export interface ResolveOutcomeEnvelopeInput {
  execution_id: unknown;
  ticket: unknown;
  terminal_state: unknown;
  started_at: unknown;
  terminal_at: unknown;
  recorded_at: unknown;
  executor: unknown;
  commit_digest: unknown;
  verification?: unknown;
  exclusion?: unknown;
  forced_hold?: OutcomeHold;
  pull_request?: unknown;
  cost?: unknown;
}

const ENVELOPE_KEYS = new Set([
  "schema",
  "schema_version",
  "execution_id",
  "ticket",
  "terminal_state",
  "disposition",
  "started_at",
  "terminal_at",
  "recorded_at",
  "executor",
  "commit_digest",
  "verification",
  "exclusion",
  "hold",
  "pull_request",
  "cost",
]);
const ACTOR_KEYS = new Set(["id", "harness", "model"]);
const VERIFICATION_KEYS = new Set([
  "id",
  "harness",
  "model",
  "verdict",
  "decided_at",
  "commit_digest",
  "evidence_digest",
]);
const EXCLUSION_KEYS = new Set(["code", "reason"]);
const HOLD_KEYS = new Set(["code", "detail"]);
const PULL_REQUEST_KEYS = new Set(["number", "fate"]);
const COST_KEYS = new Set(["amount_usd", "source"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function pushUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key}: unknown field`);
  }
}

function requireString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: required non-empty string`);
    return "";
  }
  return value.trim();
}

function requireTimestamp(value: unknown, path: string, errors: string[]): string {
  const result = requireString(value, path, errors);
  if (result && !Number.isFinite(Date.parse(result))) errors.push(`${path}: must be an ISO-8601 timestamp`);
  return result;
}

function requireDigest(value: unknown, path: string, errors: string[]): string {
  const result = requireString(value, path, errors);
  if (result && !SHA256_PATTERN.test(result)) errors.push(`${path}: must be sha256:<64 lowercase hex>`);
  return result;
}

function parseActor(value: unknown, path: string, errors: string[]): OutcomeActor | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  pushUnknownKeys(value, ACTOR_KEYS, path, errors);
  const id = requireString(value.id, `${path}.id`, errors);
  const harness = requireString(value.harness, `${path}.harness`, errors);
  const model = requireString(value.model, `${path}.model`, errors);
  return id && harness && model ? { id, harness, model } : null;
}

function parseVerification(value: unknown, path: string, errors: string[]): OutcomeVerification | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  pushUnknownKeys(value, VERIFICATION_KEYS, path, errors);
  const id = requireString(value.id, `${path}.id`, errors);
  const harness = requireString(value.harness, `${path}.harness`, errors);
  const model = requireString(value.model, `${path}.model`, errors);
  const decided_at = requireTimestamp(value.decided_at, `${path}.decided_at`, errors);
  const commit_digest = requireDigest(value.commit_digest, `${path}.commit_digest`, errors);
  const evidence_digest = requireDigest(value.evidence_digest, `${path}.evidence_digest`, errors);
  const verdict = value.verdict === "pass" || value.verdict === "fail" ? value.verdict : null;
  if (!verdict) errors.push(`${path}.verdict: must be pass|fail`);
  return id && harness && model && verdict && decided_at && commit_digest && evidence_digest
    ? { id, harness, model, verdict, decided_at, commit_digest, evidence_digest }
    : null;
}

function parseExclusion(value: unknown, path: string, errors: string[]): OutcomeExclusion | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  pushUnknownKeys(value, EXCLUSION_KEYS, path, errors);
  const code = isMember(OUTCOME_EXCLUSION_CODES, value.code) ? value.code : null;
  if (!code) errors.push(`${path}.code: invalid exclusion code`);
  const reason = requireString(value.reason, `${path}.reason`, errors);
  return code && reason ? { code, reason } : null;
}

function parseHold(value: unknown, path: string, errors: string[]): OutcomeHold | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  pushUnknownKeys(value, HOLD_KEYS, path, errors);
  const code = isMember(OUTCOME_EVIDENCE_FAILURES, value.code) ? value.code : null;
  if (!code) errors.push(`${path}.code: invalid evidence failure`);
  const detail = requireString(value.detail, `${path}.detail`, errors);
  return code && detail ? { code, detail } : null;
}

function parsePullRequest(value: unknown, path: string, errors: string[]): OutcomePullRequest | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  pushUnknownKeys(value, PULL_REQUEST_KEYS, path, errors);
  const number = value.number === null
    ? null
    : Number.isInteger(value.number) && (value.number as number) > 0
      ? value.number as number
      : undefined;
  if (number === undefined) errors.push(`${path}.number: must be a positive integer or null`);
  const fate = value.fate === "none" || value.fate === "open" || value.fate === "closed" || value.fate === "merged"
    ? value.fate
    : null;
  if (!fate) errors.push(`${path}.fate: must be none|open|closed|merged`);
  if (fate === "none" && number !== null) errors.push(`${path}: fate none requires number null`);
  if (fate && fate !== "none" && number === null) errors.push(`${path}: fate ${fate} requires a PR number`);
  return number !== undefined && fate ? { number, fate } : null;
}

function parseCost(value: unknown, path: string, errors: string[]): OutcomeCost | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  pushUnknownKeys(value, COST_KEYS, path, errors);
  const amount_usd = typeof value.amount_usd === "number" && Number.isFinite(value.amount_usd) && value.amount_usd >= 0
    ? value.amount_usd
    : null;
  if (amount_usd === null) errors.push(`${path}.amount_usd: must be a finite non-negative number`);
  const source = requireString(value.source, `${path}.source`, errors);
  return amount_usd !== null && source ? { amount_usd, source } : null;
}

function defaultPullRequest(): OutcomePullRequest {
  return { number: null, fate: "none" };
}

function evidenceFailure(input: {
  executor: OutcomeActor;
  commit_digest: string | null;
  commit_failure: OutcomeHold | null;
  terminal_at: string;
  verification: unknown;
}): { verification: OutcomeVerification | null; hold: OutcomeHold | null } {
  if (input.verification === undefined || input.verification === null) {
    return { verification: null, hold: { code: "missing", detail: "verifier-owned evidence is absent" } };
  }
  const errors: string[] = [];
  const verification = parseVerification(input.verification, "verification", errors);
  if (!verification || errors.length > 0) {
    return { verification: null, hold: { code: "malformed", detail: errors.join("; ") } };
  }
  if (input.commit_failure) return { verification, hold: input.commit_failure };
  if (verification.id === input.executor.id) {
    return { verification, hold: { code: "forged", detail: "executor cannot verify its own execution" } };
  }
  if (Date.parse(verification.decided_at) < Date.parse(input.terminal_at)) {
    return { verification, hold: { code: "stale", detail: "verification predates the terminal lifecycle boundary" } };
  }
  if (verification.commit_digest !== input.commit_digest) {
    return { verification, hold: { code: "mismatched", detail: "verification is bound to a different commit digest" } };
  }
  return { verification, hold: null };
}

export function resolveOutcomeEnvelope(input: ResolveOutcomeEnvelopeInput): OutcomeEnvelopeParseResult {
  const errors: string[] = [];
  const execution_id = requireString(input.execution_id, "execution_id", errors);
  const ticket = requireString(input.ticket, "ticket", errors);
  const terminal_state = isMember(OUTCOME_TERMINAL_STATES, input.terminal_state) ? input.terminal_state : null;
  if (!terminal_state) errors.push("terminal_state: invalid terminal state");
  const started_at = requireTimestamp(input.started_at, "started_at", errors);
  const terminal_at = requireTimestamp(input.terminal_at, "terminal_at", errors);
  const recorded_at = requireTimestamp(input.recorded_at, "recorded_at", errors);
  const executor = parseActor(input.executor, "executor", errors);
  const commitErrors: string[] = [];
  const parsedCommitDigest = input.commit_digest === undefined || input.commit_digest === null
    ? null
    : requireDigest(input.commit_digest, "commit_digest", commitErrors);
  const commit_digest = commitErrors.length > 0 ? null : parsedCommitDigest;
  const commit_failure: OutcomeHold | null = input.commit_digest === undefined || input.commit_digest === null
    ? { code: "missing", detail: "execution commit digest is absent" }
    : commitErrors.length > 0
      ? { code: "malformed", detail: commitErrors.join("; ") }
      : null;
  const pull_request = input.pull_request === undefined
    ? defaultPullRequest()
    : parsePullRequest(input.pull_request, "pull_request", errors);
  const cost = input.cost === undefined || input.cost === null ? null : parseCost(input.cost, "cost", errors);
  if (started_at && terminal_at && Date.parse(terminal_at) < Date.parse(started_at)) {
    errors.push("terminal_at: must not precede started_at");
  }
  if (terminal_at && recorded_at && Date.parse(recorded_at) < Date.parse(terminal_at)) {
    errors.push("recorded_at: must not precede terminal_at");
  }
  if (errors.length > 0 || !terminal_state || !executor || !pull_request) return { ok: false, errors };

  if (input.exclusion !== undefined && input.exclusion !== null) {
    if (input.forced_hold) {
      return { ok: false, errors: ["forced_hold: excluded outcomes cannot also be held"] };
    }
    const exclusionErrors: string[] = [];
    const exclusion = parseExclusion(input.exclusion, "exclusion", exclusionErrors);
    if (!exclusion || exclusionErrors.length > 0) return { ok: false, errors: exclusionErrors };
    if (input.verification !== undefined && input.verification !== null) {
      return { ok: false, errors: ["verification: excluded outcomes cannot carry verification evidence"] };
    }
    return {
      ok: true,
      envelope: {
        schema: OUTCOME_ENVELOPE_SCHEMA,
        schema_version: OUTCOME_ENVELOPE_VERSION,
        execution_id,
        ticket,
        terminal_state,
        disposition: "excluded",
        started_at,
        terminal_at,
        recorded_at,
        executor,
        commit_digest,
        verification: null,
        exclusion,
        hold: null,
        pull_request,
        cost,
      },
    };
  }

  const evidence = evidenceFailure({
    executor,
    commit_digest,
    commit_failure,
    terminal_at,
    verification: input.verification,
  });
  if (input.forced_hold) evidence.hold = input.forced_hold;
  const measured = evidence.hold === null;
  if (measured && terminal_state === "accepted" && evidence.verification?.verdict !== "pass") {
    evidence.hold = { code: "mismatched", detail: "accepted terminal requires a passing verifier verdict" };
  }
  return {
    ok: true,
    envelope: {
      schema: OUTCOME_ENVELOPE_SCHEMA,
      schema_version: OUTCOME_ENVELOPE_VERSION,
      execution_id,
      ticket,
      terminal_state,
      disposition: evidence.hold === null ? "measured" : "held_unmeasured",
      started_at,
      terminal_at,
      recorded_at,
      executor,
      commit_digest,
      verification: evidence.verification,
      exclusion: null,
      hold: evidence.hold,
      pull_request,
      cost,
    },
  };
}

export function parseOutcomeEnvelope(raw: unknown): OutcomeEnvelopeParseResult {
  if (!isRecord(raw)) return { ok: false, errors: ["envelope: must be an object"] };
  const errors: string[] = [];
  pushUnknownKeys(raw, ENVELOPE_KEYS, "envelope", errors);
  if (raw.schema !== OUTCOME_ENVELOPE_SCHEMA) errors.push(`schema: must be ${OUTCOME_ENVELOPE_SCHEMA}`);
  if (raw.schema_version !== OUTCOME_ENVELOPE_VERSION) errors.push("schema_version: must be 1");
  if (!isMember(OUTCOME_DISPOSITIONS, raw.disposition)) errors.push("disposition: invalid disposition");
  const disposition = isMember(OUTCOME_DISPOSITIONS, raw.disposition) ? raw.disposition : null;
  const suppliedHold = raw.hold === null ? null : parseHold(raw.hold, "hold", errors);
  const resolved = resolveOutcomeEnvelope({
    execution_id: raw.execution_id,
    ticket: raw.ticket,
    terminal_state: raw.terminal_state,
    started_at: raw.started_at,
    terminal_at: raw.terminal_at,
    recorded_at: raw.recorded_at,
    executor: raw.executor,
    commit_digest: raw.commit_digest,
    verification: raw.verification,
    exclusion: raw.exclusion,
    ...(suppliedHold?.code === "duplicate" ? { forced_hold: suppliedHold } : {}),
    pull_request: raw.pull_request,
    cost: raw.cost,
  });
  if (resolved.ok === false) errors.push(...resolved.errors);
  if (resolved.ok && disposition && resolved.envelope.disposition !== disposition) {
    errors.push(`disposition: expected ${resolved.envelope.disposition} from evidence and exclusion contract`);
  }
  if (resolved.ok) {
    const expectedHold = resolved.envelope.hold;
    if (JSON.stringify(suppliedHold) !== JSON.stringify(expectedHold)) {
      errors.push("hold: does not match deterministic evidence classification");
    }
  }
  if (errors.length > 0 || resolved.ok === false) return { ok: false, errors };
  return { ok: true, envelope: resolved.envelope };
}

export function serializeOutcomeEnvelope(envelope: OutcomeEnvelope): string {
  const parsed = parseOutcomeEnvelope(envelope);
  if (parsed.ok === false) throw new TypeError(`invalid outcome envelope: ${parsed.errors.join("; ")}`);
  return `${JSON.stringify(parsed.envelope)}\n`;
}
