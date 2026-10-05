export const DELIVERY_STATES = [
  "implementation_complete",
  "verified",
  "pr_ready",
  "ci_green",
  "merged",
  "deployed",
  "accepted",
] as const;

export const EXECUTION_STATES = [
  "executing",
  ...DELIVERY_STATES,
  "failed",
  "held",
  "dry_run",
  "pool_enqueued",
] as const;

export const DELIVERY_TARGETS = DELIVERY_STATES;
export const TERMINAL_OUTCOME_STATES = ["failed", "held", "dry_run"] as const;
export const SURVIVABILITY_WINDOWS_DAYS = [7, 30] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryTarget = DeliveryState;
export type ExecutionState = (typeof EXECUTION_STATES)[number];
export type TerminalOutcomeState = (typeof TERMINAL_OUTCOME_STATES)[number];
export type SurvivabilityStatus = "pending" | "passed" | "failed" | "not_applicable";
export type SurvivabilityWindowDays = (typeof SURVIVABILITY_WINDOWS_DAYS)[number];
export type SurvivabilityCheckStatus = "pending" | "passed" | "failed";

export interface LifecycleEvidenceReference {
  kind: string;
  reference: string;
  recorded_at: string;
  details?: Record<string, unknown>;
}

export type LifecycleEvidenceInput =
  | string
  | LifecycleEvidenceReference
  | {
      kind?: string;
      reference?: string;
      ref?: string;
      recorded_at?: string;
      details?: Record<string, unknown>;
    };

export type LifecycleEvidence = Partial<Record<ExecutionState, LifecycleEvidenceReference[]>>;

export interface SurvivabilityCheck {
  window_days: SurvivabilityWindowDays;
  due_at: string;
  status: SurvivabilityCheckStatus;
  checked_at: string | null;
  evidence: LifecycleEvidenceReference[];
}

export interface ExecutionLifecycle {
  state: ExecutionState;
  delivery_target: DeliveryTarget;
  target_reached: boolean;
  state_updated_at: string;
  evidence: LifecycleEvidence;
  post_merge_survivability: SurvivabilityStatus;
  post_merge_survivability_reason: string | null;
  post_merge_survivability_checks: SurvivabilityCheck[];
}

export interface LegacyExecutionRecord {
  state?: unknown;
  stage?: unknown;
  status?: unknown;
  delivery_target?: unknown;
  target_reached?: unknown;
  state_updated_at?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  evidence?: unknown;
  post_merge_survivability?: unknown;
  post_merge_survivability_reason?: unknown;
  post_merge_survivability_checks?: unknown;
  error?: unknown;
  result_summary?: unknown;
  [key: string]: unknown;
}

export interface NormalizeLifecycleOptions {
  delivery_target?: DeliveryTarget;
  now?: string;
}

export interface TransitionLifecycleOptions {
  now?: string;
}

export class LifecycleTransitionError extends Error {
  readonly from: ExecutionState;
  readonly to: ExecutionState;

  constructor(from: ExecutionState, to: ExecutionState, reason: string) {
    super(`Invalid lifecycle transition ${from} -> ${to}: ${reason}`);
    this.name = "LifecycleTransitionError";
    this.from = from;
    this.to = to;
  }
}

const DELIVERY_RANK = new Map<DeliveryState, number>(
  DELIVERY_STATES.map((state, index) => [state, index]),
);

const VALID_TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  executing: ["implementation_complete", "failed", "held", "dry_run", "pool_enqueued"],
  implementation_complete: ["verified", "failed", "held"],
  verified: ["pr_ready", "failed", "held"],
  pr_ready: ["ci_green", "failed", "held"],
  ci_green: ["merged", "failed", "held"],
  merged: ["deployed"],
  deployed: ["accepted"],
  accepted: [],
  failed: [],
  held: ["executing", "failed"],
  dry_run: [],
  pool_enqueued: ["executing", "failed", "held"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function requireIsoTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  return value;
}

export function isExecutionState(value: unknown): value is ExecutionState {
  return typeof value === "string" && (EXECUTION_STATES as readonly string[]).includes(value);
}

export function isDeliveryState(value: unknown): value is DeliveryState {
  return typeof value === "string" && (DELIVERY_STATES as readonly string[]).includes(value);
}

export function isDeliveryTarget(value: unknown): value is DeliveryTarget {
  return isDeliveryState(value);
}

export function isTerminalOutcomeState(value: unknown): value is TerminalOutcomeState {
  return typeof value === "string" && (TERMINAL_OUTCOME_STATES as readonly string[]).includes(value);
}

/**
 * ZOU-1450 — the one definition of "this state file is an execution record".
 *
 * A record is written as `exec-<execution_id>.json`. Sidecar artifacts are
 * written beside it under the same prefix with an extra name segment —
 * `exec-<id>.autopsy.json` is the one that degraded the lifecycle projection to
 * `executions: []`, because an autopsy's `evidence` is an array where a record's
 * is a state-keyed map. Every consumer that enumerated the state directory with
 * `startsWith("exec-") && endsWith(".json")` admitted them (ZOU-1410 fixed the
 * in-flight counter alone). The extra dot segment is the discriminator: no
 * execution id contains one.
 */
export function isExecutionRecordFileName(name: string): boolean {
  if (!name.startsWith("exec-") || !name.endsWith(".json")) return false;
  return !name.slice(0, -".json".length).includes(".");
}

/** The record file name agrees with the `execution_id` the file claims. */
export function isExecutionRecordIdentity(fileName: string, value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const id = (value as Record<string, unknown>).execution_id;
  return typeof id === "string" && id.length > 0 && fileName === `exec-${id}.json`;
}

export function hasReachedDeliveryTarget(state: ExecutionState, target: DeliveryTarget): boolean {
  if (!isDeliveryState(state)) return false;
  return (DELIVERY_RANK.get(state) ?? -1) >= (DELIVERY_RANK.get(target) ?? Number.MAX_SAFE_INTEGER);
}

export const targetReached = hasReachedDeliveryTarget;

/**
 * True when a persisted delivery state has already advanced past the one a
 * caller is about to write over it.
 *
 * `transitionExecutionLifecycle` protects a lifecycle that is mutated in place,
 * but a caller holding a stale record and writing it wholesale bypasses that
 * entirely. `exec-d0aecec5` showed the cost: an executor pass dispatched at
 * 02:55 finished at 03:00:56 and wrote `implementation_complete` over a `merged`
 * execution, silently dropping `pr_number: 9`. Nothing threw — the shipped state
 * simply vanished.
 *
 * Only delivery states are compared, so a run that genuinely ends in `failed`,
 * `held` or `dry_run` is still reported.
 */
export function wouldDowngradeDelivery(persisted: unknown, incoming: unknown): boolean {
  if (!isDeliveryState(persisted) || !isDeliveryState(incoming)) return false;
  if (persisted === incoming) return false;
  return hasReachedDeliveryTarget(persisted, incoming);
}

export function hasProvenDeliveryState(
  lifecycle: Pick<ExecutionLifecycle, "evidence">,
  target: DeliveryTarget,
): boolean {
  const strongestEvidence = strongestContiguousDeliveryEvidence(lifecycle.evidence);
  return strongestEvidence !== null && hasReachedDeliveryTarget(strongestEvidence, target);
}

export function hasReachedTarget(
  lifecycle: Pick<ExecutionLifecycle, "state" | "delivery_target"> & Partial<Pick<ExecutionLifecycle, "target_reached">>,
): boolean {
  if (typeof lifecycle.target_reached === "boolean") return lifecycle.target_reached;
  return hasReachedDeliveryTarget(lifecycle.state, lifecycle.delivery_target);
}

export function isTerminalExecution(
  lifecycle: Pick<ExecutionLifecycle, "state" | "delivery_target"> & Partial<Pick<ExecutionLifecycle, "target_reached">>,
): boolean {
  return isTerminalOutcomeState(lifecycle.state) || hasReachedTarget(lifecycle);
}

export const isTerminalLifecycle = isTerminalExecution;

export function isInFlightExecution(
  lifecycle: Pick<ExecutionLifecycle, "state" | "delivery_target"> & Partial<Pick<ExecutionLifecycle, "target_reached">>,
): boolean {
  return !isTerminalExecution(lifecycle);
}

export const isInFlightLifecycle = isInFlightExecution;

function normalizeLegacyState(value: unknown): ExecutionState | null {
  if (value === "complete") return "implementation_complete";
  if (value === "dry-run") return "dry_run";
  if (value === "pending-implementation") return "executing";
  if (value === "pool-enqueued") return "pool_enqueued";
  return isExecutionState(value) ? value : null;
}

function evidenceIdentity(evidence: LifecycleEvidenceReference): string {
  return JSON.stringify([
    evidence.kind,
    evidence.reference,
    evidence.recorded_at,
    evidence.details ?? null,
  ]);
}

function normalizeEvidenceReference(
  input: LifecycleEvidenceInput,
  fallbackTimestamp: string,
): LifecycleEvidenceReference {
  if (typeof input === "string") {
    if (!input.trim()) throw new TypeError("evidence reference must not be empty");
    return { kind: "reference", reference: input, recorded_at: fallbackTimestamp };
  }

  if (!isRecord(input)) throw new TypeError("evidence must be a reference string or object");
  const reference = typeof input.reference === "string"
    ? input.reference.trim()
    : typeof input.ref === "string"
      ? input.ref.trim()
      : "";
  if (!reference) throw new TypeError("evidence.reference must not be empty");

  const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : "reference";
  const recordedAt = typeof input.recorded_at === "string" ? input.recorded_at : fallbackTimestamp;
  requireIsoTimestamp(recordedAt, "evidence.recorded_at");

  return {
    kind,
    reference,
    recorded_at: recordedAt,
    ...(isRecord(input.details) ? { details: { ...input.details } } : {}),
  };
}

function normalizeEvidence(value: unknown, fallbackTimestamp: string): LifecycleEvidence {
  if (!isRecord(value)) return {};
  const normalized: LifecycleEvidence = {};

  for (const [state, rawReferences] of Object.entries(value)) {
    const canonicalState = normalizeLegacyState(state);
    if (!canonicalState) continue;
    const references = Array.isArray(rawReferences) ? rawReferences : [rawReferences];
    const seen = new Set<string>();
    const accepted: LifecycleEvidenceReference[] = [];
    for (const reference of references) {
      try {
        const item = normalizeEvidenceReference(reference as LifecycleEvidenceInput, fallbackTimestamp);
        const identity = evidenceIdentity(item);
        if (!seen.has(identity)) {
          seen.add(identity);
          accepted.push(item);
        }
      } catch {
        // Invalid legacy evidence cannot prove a transition.
      }
    }
    if (accepted.length > 0) normalized[canonicalState] = accepted;
  }

  return normalized;
}

function strongestContiguousDeliveryEvidence(evidence: LifecycleEvidence): DeliveryState | null {
  let strongest: DeliveryState | null = null;
  for (const state of DELIVERY_STATES) {
    if ((evidence[state]?.length ?? 0) === 0) break;
    strongest = state;
  }
  return strongest;
}

function latestEvidenceTimestamp(evidence: LifecycleEvidence, state: ExecutionState): string | null {
  const timestamps = (evidence[state] ?? [])
    .map((entry) => entry.recorded_at)
    .filter(isIsoTimestamp)
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return timestamps[0] ?? null;
}

function addDays(timestamp: string, days: number): string {
  return new Date(Date.parse(timestamp) + days * 24 * 60 * 60 * 1000).toISOString();
}

function defaultSurvivabilityChecks(mergedAt: string): SurvivabilityCheck[] {
  return SURVIVABILITY_WINDOWS_DAYS.map((windowDays) => ({
    window_days: windowDays,
    due_at: addDays(mergedAt, windowDays),
    status: "pending",
    checked_at: null,
    evidence: [],
  }));
}

function normalizeSurvivabilityChecks(value: unknown, mergedAt: string): SurvivabilityCheck[] {
  if (!Array.isArray(value)) return defaultSurvivabilityChecks(mergedAt);

  const byWindow = new Map<SurvivabilityWindowDays, SurvivabilityCheck>();
  for (const raw of value) {
    if (!isRecord(raw) || !SURVIVABILITY_WINDOWS_DAYS.includes(raw.window_days as SurvivabilityWindowDays)) continue;
    const windowDays = raw.window_days as SurvivabilityWindowDays;
    const requestedStatus = raw.status === "passed" || raw.status === "failed" ? raw.status : "pending";
    const dueAt = addDays(mergedAt, windowDays);
    const checkedAt = requestedStatus !== "pending" && isIsoTimestamp(raw.checked_at) ? raw.checked_at : null;
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence.flatMap((item) => {
          try {
            return [normalizeEvidenceReference(item as LifecycleEvidenceInput, checkedAt ?? mergedAt)];
          } catch {
            return [];
          }
      })
      : [];
    const status = requestedStatus !== "pending"
      && checkedAt
      && Date.parse(checkedAt) >= Date.parse(dueAt)
      && evidence.length > 0
      ? requestedStatus
      : "pending";
    byWindow.set(windowDays, {
      window_days: windowDays,
      due_at: dueAt,
      status,
      checked_at: status === "pending" ? null : checkedAt,
      evidence,
    });
  }

  return defaultSurvivabilityChecks(mergedAt).map((fallback) => byWindow.get(fallback.window_days) ?? fallback);
}

function unmergedReason(state: ExecutionState, record?: LegacyExecutionRecord): string {
  if (typeof record?.post_merge_survivability_reason === "string" && record.post_merge_survivability_reason.trim()) {
    return record.post_merge_survivability_reason.trim();
  }
  if (state === "failed" && typeof record?.error === "string" && record.error.trim()) return record.error.trim();
  if (state === "held") return "execution_held_before_merge";
  if (state === "dry_run") return "dry_run_not_merged";
  return `${state}_not_merged`;
}

function resolveSurvivability(
  state: ExecutionState,
  stateUpdatedAt: string,
  evidence: LifecycleEvidence,
  record?: LegacyExecutionRecord,
): Pick<
  ExecutionLifecycle,
  "post_merge_survivability" | "post_merge_survivability_reason" | "post_merge_survivability_checks"
> {
  if (!isDeliveryState(state) || (DELIVERY_RANK.get(state) ?? -1) < (DELIVERY_RANK.get("merged") ?? 4)) {
    return {
      post_merge_survivability: "not_applicable",
      post_merge_survivability_reason: unmergedReason(state, record),
      post_merge_survivability_checks: [],
    };
  }

  const mergedAt = latestEvidenceTimestamp(evidence, "merged") ?? stateUpdatedAt;
  const checks = normalizeSurvivabilityChecks(record?.post_merge_survivability_checks, mergedAt);
  const derivedStatus: SurvivabilityStatus = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.every((check) => check.status === "passed")
      ? "passed"
      : "pending";

  return {
    post_merge_survivability: derivedStatus,
    post_merge_survivability_reason: null,
    post_merge_survivability_checks: checks,
  };
}

export function createExecutionLifecycle(
  deliveryTarget: DeliveryTarget,
  now = new Date().toISOString(),
): ExecutionLifecycle {
  if (!isDeliveryTarget(deliveryTarget)) throw new TypeError(`Unknown delivery target: ${String(deliveryTarget)}`);
  requireIsoTimestamp(now, "now");
  const state: ExecutionState = "executing";
  return {
    state,
    delivery_target: deliveryTarget,
    target_reached: false,
    state_updated_at: now,
    evidence: {},
    ...resolveSurvivability(state, now, {}),
  };
}

export const createLifecycle = createExecutionLifecycle;

export function normalizeExecutionLifecycle(
  record: LegacyExecutionRecord,
  options: NormalizeLifecycleOptions = {},
): ExecutionLifecycle {
  const now = options.now ?? new Date().toISOString();
  requireIsoTimestamp(now, "options.now");

  const baseTimestamp = [record.state_updated_at, record.completed_at, record.started_at]
    .find(isIsoTimestamp) ?? now;
  const evidence = normalizeEvidence(record.evidence, baseTimestamp);
  const rawState = normalizeLegacyState(record.state)
    ?? normalizeLegacyState(record.status)
    ?? normalizeLegacyState(record.stage)
    ?? "executing";
  const provenState = strongestContiguousDeliveryEvidence(evidence);
  const state = isDeliveryState(rawState) && provenState
    && (DELIVERY_RANK.get(provenState) ?? -1) > (DELIVERY_RANK.get(rawState) ?? -1)
    ? provenState
    : rawState;
  const deliveryTarget = isDeliveryTarget(record.delivery_target)
    ? record.delivery_target
    : options.delivery_target ?? "accepted";
  const stateUpdatedAt = latestEvidenceTimestamp(evidence, state) ?? baseTimestamp;
  const targetReached = hasReachedDeliveryTarget(state, deliveryTarget)
    && hasProvenDeliveryState({ evidence }, deliveryTarget);

  return {
    state,
    delivery_target: deliveryTarget,
    target_reached: targetReached,
    state_updated_at: stateUpdatedAt,
    evidence,
    ...resolveSurvivability(state, stateUpdatedAt, evidence, record),
  };
}

export const normalizeLifecycle = normalizeExecutionLifecycle;

export function canTransitionLifecycle(from: ExecutionState, to: ExecutionState): boolean {
  return from === to || VALID_TRANSITIONS[from].includes(to);
}

export const canTransition = canTransitionLifecycle;

function appendEvidence(
  evidence: LifecycleEvidence,
  state: ExecutionState,
  input: LifecycleEvidenceInput | readonly LifecycleEvidenceInput[],
  timestamp: string,
): LifecycleEvidence {
  const incoming = (Array.isArray(input) ? input : [input]).map((item) =>
    normalizeEvidenceReference(item, timestamp)
  );
  if (incoming.length === 0) throw new TypeError("a lifecycle transition requires evidence");

  const next: LifecycleEvidence = Object.fromEntries(
    Object.entries(evidence).map(([key, references]) => [key, references?.map((entry) => ({ ...entry }))]),
  );
  const existing = next[state] ?? [];
  const seen = new Set(existing.map(evidenceIdentity));
  for (const item of incoming) {
    if (!seen.has(evidenceIdentity(item))) {
      existing.push(item);
      seen.add(evidenceIdentity(item));
    }
  }
  next[state] = existing;
  return next;
}

function appendEvidenceReferences(
  existing: readonly LifecycleEvidenceReference[],
  input: LifecycleEvidenceInput | readonly LifecycleEvidenceInput[],
  timestamp: string,
): LifecycleEvidenceReference[] {
  return appendEvidence({ accepted: [...existing] }, "accepted", input, timestamp).accepted ?? [];
}

export function transitionExecutionLifecycle(
  lifecycle: ExecutionLifecycle,
  to: ExecutionState,
  evidenceInput: LifecycleEvidenceInput | readonly LifecycleEvidenceInput[],
  options: TransitionLifecycleOptions = {},
): ExecutionLifecycle {
  if (!isExecutionState(to)) throw new TypeError(`Unknown execution state: ${String(to)}`);
  const current = normalizeExecutionLifecycle(lifecycle as unknown as LegacyExecutionRecord, {
    delivery_target: lifecycle.delivery_target,
    now: options.now ?? lifecycle.state_updated_at,
  });
  if (current.state === to) return current;
  if (!VALID_TRANSITIONS[current.state].includes(to)) {
    throw new LifecycleTransitionError(current.state, to, "transition is not allowed");
  }
  if (isDeliveryState(current.state) && isDeliveryState(to)) {
    const provenState = strongestContiguousDeliveryEvidence(current.evidence);
    if (provenState === null || !hasReachedDeliveryTarget(provenState, current.state)) {
      throw new LifecycleTransitionError(current.state, to, "current delivery state lacks contiguous evidence");
    }
  }

  const now = options.now ?? new Date().toISOString();
  requireIsoTimestamp(now, "options.now");
  const evidence = appendEvidence(current.evidence, to, evidenceInput, now);
  const next: ExecutionLifecycle = {
    ...current,
    state: to,
    target_reached: hasReachedDeliveryTarget(to, current.delivery_target)
      && hasProvenDeliveryState({ evidence }, current.delivery_target),
    state_updated_at: now,
    evidence,
    ...resolveSurvivability(to, now, evidence),
  };
  return next;
}

export const transitionLifecycle = transitionExecutionLifecycle;

export function recordSurvivabilityCheck(
  lifecycle: ExecutionLifecycle,
  windowDays: SurvivabilityWindowDays,
  status: Exclude<SurvivabilityCheckStatus, "pending">,
  evidenceInput: LifecycleEvidenceInput | readonly LifecycleEvidenceInput[],
  checkedAt = new Date().toISOString(),
): ExecutionLifecycle {
  requireIsoTimestamp(checkedAt, "checkedAt");
  const current = normalizeExecutionLifecycle(lifecycle as unknown as LegacyExecutionRecord, {
    delivery_target: lifecycle.delivery_target,
    now: lifecycle.state_updated_at,
  });
  if (current.post_merge_survivability === "not_applicable") {
    throw new LifecycleTransitionError(current.state, current.state, "survivability cannot be evaluated before merge");
  }
  if (!SURVIVABILITY_WINDOWS_DAYS.includes(windowDays)) {
    throw new TypeError(`Unsupported survivability window: ${String(windowDays)}`);
  }
  const selectedCheck = current.post_merge_survivability_checks.find((check) => check.window_days === windowDays);
  if (!selectedCheck) throw new TypeError(`Missing survivability window: ${String(windowDays)}`);
  if (Date.parse(checkedAt) < Date.parse(selectedCheck.due_at)) {
    throw new TypeError(`Survivability window ${windowDays}d is not due until ${selectedCheck.due_at}`);
  }

  const checks = current.post_merge_survivability_checks.map((check) => {
    if (check.window_days !== windowDays) return check;
    const evidence = appendEvidenceReferences(check.evidence, evidenceInput, checkedAt);
    return { ...check, status, checked_at: checkedAt, evidence };
  });
  const survivability: SurvivabilityStatus = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.every((check) => check.status === "passed")
      ? "passed"
      : "pending";

  return {
    ...current,
    post_merge_survivability: survivability,
    post_merge_survivability_reason: null,
    post_merge_survivability_checks: checks,
  };
}
