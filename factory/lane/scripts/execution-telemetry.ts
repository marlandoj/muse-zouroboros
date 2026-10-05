/**
 * FH-06 / ZOU-600 — Yield, cost, and intervention telemetry (pure core)
 *
 * Assembles one canonical per-execution telemetry record from artifacts that
 * already exist (exec-*.json lifecycle, verdict sidecars, campaign spend, hold
 * records). Every metric is derived — never self-reported — and every genuinely
 * unmeasured field is `null`, never `0`.
 *
 * Charter honesty mandate (PROJECT.md): "Unknown baselines must never be
 * represented as zero." A null here means *unknown*, and every null-because-
 * unknown field is additionally named in `unknowns[]` so no downstream reader
 * can silently coerce it into a fabricated zero.
 *
 * Survivability (AC#7) is delegated to `normalizeExecutionLifecycle` — the same
 * state machine production uses — so merged executions schedule 7/30-day checks
 * and unmerged executions resolve to `not_applicable` with a terminal reason.
 *
 * This module is pure: no fs, no network, no clock beyond an injected `now`.
 * All joins (cost, operator intervention, verdict) are supplied by the caller;
 * the CLI wires the real readers.
 */

import {
  normalizeExecutionLifecycle,
  type ExecutionState,
  type LegacyExecutionRecord,
  type SurvivabilityCheckStatus,
  type SurvivabilityStatus,
  type SurvivabilityWindowDays,
} from "./execution-lifecycle";

// ─── Types ────────────────────────────────────────────────────────────────────

/** An execution record with the identity fields telemetry needs to attribute it. */
export interface TelemetryRecord extends LegacyExecutionRecord {
  execution_id: string;
  identifier: string;
  ticket_id: string;
}

/** Externally-resolved joins. Omitted / `null` values are treated as unknown. */
export interface TelemetryJoins {
  /** Real recorded spend for this unit of work (campaign spend). null = unknown. */
  model_cost_usd?: number | null;
  /** Minutes an operator spent unblocking this execution. null = unknown. */
  operator_intervention_minutes?: number | null;
  /** Post-flight verdict resolved by execution_id/ticket. null = unmeasured. */
  verdict?: { verdict: "pass" | "fail"; rework: boolean } | null;
}

export interface TelemetrySurvivabilityCheck {
  window_days: SurvivabilityWindowDays;
  due_at: string;
  status: SurvivabilityCheckStatus;
  /** True when a pending check's due_at has passed relative to `now`. */
  overdue: boolean;
}

export interface TelemetrySurvivability {
  status: SurvivabilityStatus;
  reason: string | null;
  checks: TelemetrySurvivabilityCheck[];
}

export interface ExecutionTelemetry {
  execution_id: string;
  identifier: string;
  ticket_id: string;
  state: ExecutionState;
  /** started_at → completed_at, minutes. null while in-flight or unparseable. */
  cycle_time_minutes: number | null;
  /** pass && !rework. null when unmeasured (no verdict sidecar). */
  first_pass: boolean | null;
  /** Measured rework flag from the verdict. null when unmeasured. */
  rework: boolean | null;
  /** Failover/retry attempts beyond the first. null when not instrumented. */
  retry_count: number | null;
  model_cost_usd: number | null;
  operator_intervention_minutes: number | null;
  survivability: TelemetrySurvivability;
  /** Field names that are null *because unknown* — makes honesty auditable. */
  unknowns: string[];
}

// ─── Pure derivations ───────────────────────────────────────────────────────────

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function minutesBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round(((to - from) / 60_000) * 100) / 100;
}

/**
 * Cycle time = started_at → completed_at. An execution that has not completed
 * has *no* final cycle time yet — that is genuinely unknown, so we return null
 * rather than measuring against a moving "now".
 */
export function cycleTimeMinutes(record: TelemetryRecord): number | null {
  const start = isoOrNull(record.started_at);
  const end = isoOrNull(record.completed_at);
  if (start === null || end === null) return null;
  return minutesBetween(start, end);
}

/**
 * Retries beyond the first attempt, parsed from the SF-013 failover trail.
 * `swarm-exec` writes the trail on EVERY executor run as `result.trail.join(" -> ")`,
 * so a single-entry trail ("claude-code") is a clean first-executor success ⇒ 0
 * retries, and "a -> b -> c" ⇒ 2 retries. Only an absent/blank trail is genuinely
 * unknown ⇒ `null` (never a fabricated 0) — a record predating SF-013 has no trail.
 * A non-blank but unparseable trail (splits to zero models) is likewise unknown.
 */
export function retryCount(record: TelemetryRecord): number | null {
  const trail = record.failover_trail;
  if (typeof trail !== "string" || trail.trim() === "") return null;
  const attempts = trail.split(/→|->/).map((s) => s.trim()).filter(Boolean).length;
  return attempts >= 1 ? attempts - 1 : null;
}

/** pass && !rework; null when there is no measured verdict. */
export function firstPass(verdict: TelemetryJoins["verdict"]): boolean | null {
  if (!verdict) return null;
  return verdict.verdict === "pass" && !verdict.rework;
}

/**
 * A non-negative, finite number or `null`. One helper for every measured quantity
 * (cost, operator minutes) so their honesty guards cannot drift apart — a NaN,
 * Infinity, or negative value is unknown, never a trusted zero.
 */
function nonNegativeFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Assemble the canonical telemetry record for one execution. Pure: survivability
 * is resolved by the shared lifecycle normalizer using the injected `now`.
 */
export function computeTelemetry(
  record: TelemetryRecord,
  joins: TelemetryJoins = {},
  now: string = new Date().toISOString(),
): ExecutionTelemetry {
  const lifecycle = normalizeExecutionLifecycle(record, { now });
  const nowMs = Date.parse(now);

  const checks: TelemetrySurvivabilityCheck[] = lifecycle.post_merge_survivability_checks.map((check) => ({
    window_days: check.window_days,
    due_at: check.due_at,
    status: check.status,
    overdue: check.status === "pending" && Number.isFinite(nowMs) && Date.parse(check.due_at) <= nowMs,
  }));

  const verdict = joins.verdict ?? null;
  const cycle = cycleTimeMinutes(record);
  const fp = firstPass(verdict);
  const rework = verdict ? verdict.rework : null;
  const retries = retryCount(record);
  const cost = nonNegativeFinite(joins.model_cost_usd);
  const intervention = nonNegativeFinite(joins.operator_intervention_minutes);

  const unknowns: string[] = [];
  if (cycle === null) unknowns.push("cycle_time_minutes");
  if (fp === null) unknowns.push("first_pass");
  if (rework === null) unknowns.push("rework");
  if (retries === null) unknowns.push("retry_count");
  if (cost === null) unknowns.push("model_cost_usd");
  if (intervention === null) unknowns.push("operator_intervention_minutes");

  return {
    execution_id: record.execution_id,
    identifier: record.identifier,
    ticket_id: record.ticket_id,
    state: lifecycle.state,
    cycle_time_minutes: cycle,
    first_pass: fp,
    rework,
    retry_count: retries,
    model_cost_usd: cost,
    operator_intervention_minutes: intervention,
    survivability: {
      status: lifecycle.post_merge_survivability,
      reason: lifecycle.post_merge_survivability_reason,
      checks,
    },
    unknowns,
  };
}

// ─── Survivability scheduling (AC#7) ────────────────────────────────────────────

export interface DueSurvivabilityCheck {
  execution_id: string;
  identifier: string;
  window_days: SurvivabilityWindowDays;
  due_at: string;
  overdue: boolean;
}

export interface SurvivabilitySchedule {
  /** Merged executions whose pending check is due now (due_at ≤ now). */
  due: DueSurvivabilityCheck[];
  /** Merged executions whose pending check is still in the future. */
  upcoming: DueSurvivabilityCheck[];
  /** Unmerged executions: survivability is not_applicable, with the terminal reason. */
  not_applicable: Array<{ execution_id: string; identifier: string; reason: string | null }>;
}

/**
 * From assembled telemetry, produce the survivability work list: which 7/30-day
 * checks are due now, which are upcoming, and which executions are terminally
 * not_applicable (never merged). Resolved (passed/failed) checks are omitted —
 * there is nothing left to do for them.
 */
export function survivabilitySchedule(
  telemetries: ExecutionTelemetry[],
  now: string = new Date().toISOString(),
): SurvivabilitySchedule {
  const nowMs = Date.parse(now);
  const due: DueSurvivabilityCheck[] = [];
  const upcoming: DueSurvivabilityCheck[] = [];
  const notApplicable: SurvivabilitySchedule["not_applicable"] = [];

  for (const t of telemetries) {
    if (t.survivability.status === "not_applicable") {
      notApplicable.push({
        execution_id: t.execution_id,
        identifier: t.identifier,
        reason: t.survivability.reason,
      });
      continue;
    }
    for (const check of t.survivability.checks) {
      if (check.status !== "pending") continue;
      const item: DueSurvivabilityCheck = {
        execution_id: t.execution_id,
        identifier: t.identifier,
        window_days: check.window_days,
        due_at: check.due_at,
        overdue: check.overdue,
      };
      const isDue = Number.isFinite(nowMs) && Date.parse(check.due_at) <= nowMs;
      (isDue ? due : upcoming).push(item);
    }
  }

  due.sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  upcoming.sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  return { due, upcoming, not_applicable: notApplicable };
}

// ─── Rollup summary (yield / cost / intervention) ───────────────────────────────

export interface TelemetrySummary {
  total: number;
  /** Executions with a measured verdict (first_pass !== null). */
  measured: number;
  first_pass_count: number;
  /** first_pass_count / measured; null when nothing was measured (never 0/0). */
  first_pass_rate: number | null;
  rework_count: number;
  cost_known: number;
  cost_unknown: number;
  /** Sum over known-cost executions; null when no cost was known (never a fake 0). */
  cost_total_usd: number | null;
  intervention_known: number;
  intervention_unknown: number;
  /** Sum over known-intervention executions; null when none known. */
  intervention_total_minutes: number | null;
  /** Count of pending survivability checks whose due_at has passed. */
  survivability_overdue: number;
}

export function summarizeTelemetry(telemetries: ExecutionTelemetry[]): TelemetrySummary {
  let measured = 0;
  let firstPassCount = 0;
  let reworkCount = 0;
  let costKnown = 0;
  let costTotal = 0;
  let interventionKnown = 0;
  let interventionTotal = 0;
  let overdue = 0;

  for (const t of telemetries) {
    if (t.first_pass !== null) {
      measured++;
      if (t.first_pass) firstPassCount++;
    }
    if (t.rework === true) reworkCount++;
    if (t.model_cost_usd !== null) {
      costKnown++;
      costTotal += t.model_cost_usd;
    }
    if (t.operator_intervention_minutes !== null) {
      interventionKnown++;
      interventionTotal += t.operator_intervention_minutes;
    }
    for (const check of t.survivability.checks) {
      if (check.overdue) overdue++;
    }
  }

  const total = telemetries.length;
  return {
    total,
    measured,
    first_pass_count: firstPassCount,
    first_pass_rate: measured > 0 ? Math.round((firstPassCount / measured) * 1000) / 1000 : null,
    rework_count: reworkCount,
    cost_known: costKnown,
    cost_unknown: total - costKnown,
    cost_total_usd: costKnown > 0 ? Math.round(costTotal * 1_000_000) / 1_000_000 : null,
    intervention_known: interventionKnown,
    intervention_unknown: total - interventionKnown,
    intervention_total_minutes: interventionKnown > 0 ? Math.round(interventionTotal * 100) / 100 : null,
    survivability_overdue: overdue,
  };
}
