#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FH-05 (P0-5) — Canonical lifecycle projection.
 *
 * After the ZBRE run, six stores answered "what state is ZOU-933 in?" and gave
 * six different answers: the execution JSON said `pr_ready` with
 * `target_reached: false`, the flight journal recorded
 * `reconcile.execution-merged` for PR #400, the shipping receipt said
 * `merge_queued`, GitHub said merged, Linear said Done, and the service was
 * live. Every one was honestly derived. None was canonical.
 *
 * This module is the reducer that materializes one state per execution.
 *
 * Design constraints taken from the audit, and why:
 *
 *   - No parallel state sequence. States are exactly `EXECUTION_STATES` from
 *     `execution-lifecycle.ts`. Intake, consensus, approval and promotion are
 *     *evidence and markers*, never states — adding them would fork the
 *     vocabulary that `flight-status.ts` and the explorer already speak.
 *
 *   - Idempotent under duplicate and out-of-order appends. Resumed conveyor
 *     cycles demonstrably re-emit `gate.decision` and plan-gate events for the
 *     same execution ID (ZOU-913 four times, ZOU-931 four times). The reducer
 *     is therefore a *max over ranked evidence*, not a sequential walk, and
 *     events are deduplicated by identity before folding. Replaying the same
 *     journal twice yields a byte-identical projection.
 *
 *   - Divergence is reported, never silently resolved. When the journal proves
 *     a stronger state than the mutable record, the projection takes the
 *     stronger one and records the disagreement so the cross-store consistency
 *     SLO has something to measure.
 *
 *   - Materialization failure is explicit. A projection that could not be built
 *     returns `ok: false` with a reason. Gating consumers must treat a degraded
 *     projection as unknown and fail closed; display consumers may fail open.
 *     Silence is the one thing it never returns.
 *
 * Consumers (reachability): `flight-status.ts`, `factory-metrics.ts`, and the
 * ZouroBench Results Explorer Operations view read `projectLifecycle()`.
 * CLI: `bun lifecycle-projection.ts [--json] [--execution <id>] [--days N]`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DELIVERY_STATES,
  isDeliveryState,
  isExecutionRecordFileName,
  isExecutionRecordIdentity,
  normalizeExecutionLifecycle,
  type ExecutionLifecycle,
  type ExecutionState,
  type LifecycleEvidence,
  type LifecycleEvidenceReference,
} from "./execution-lifecycle";
import { readFlightEvents, type FlightEvent } from "./flight-recorder";

const PROJECT_DIR = join(import.meta.dir, "..");

/**
 * Journal kind → lifecycle state. Kinds absent from this table are not state
 * transitions; several of them are markers, handled separately below.
 */
export const KIND_TO_STATE: Readonly<Record<string, ExecutionState>> = {
  "exec.start": "executing",
  "executor.start": "executing",
  "exec.implementation_complete": "implementation_complete",
  "exec.complete": "implementation_complete",
  "executor.ok": "implementation_complete",
  "exec.verified": "verified",
  "exec.pr_ready": "pr_ready",
  "exec.ci_green": "ci_green",
  "reconcile.execution-merged": "merged",
  "reconcile.enforced": "merged",
  "exec.merged": "merged",
  "exec.deployed": "deployed",
  "exec.accepted": "accepted",
  "exec.failed": "failed",
  "executor.fail": "failed",
  "executor.throw": "failed",
  "exec.held": "held",
  "exec.dry-run": "dry_run",
  "exec.pool-enqueued": "pool_enqueued",
};

/** Kinds that attach context without advancing the lifecycle. */
export const MARKER_KINDS: ReadonlySet<string> = new Set([
  "consensus.complete",
  "gate.decision",
  "manual-review.requested",
  "serial-promotion.promoted",
  "serial-promotion.canonical-complete",
  "model-policy.applied",
  "plan-gate.would-hold",
  "shipping.provenance-repaired",
  "evidence.persisted",
  "recovery.resolved",
]);

const DELIVERY_RANK = new Map<string, number>(DELIVERY_STATES.map((state, index) => [state, index]));

/** Rank only orders delivery progress; non-delivery states are unranked. */
function rankOf(state: ExecutionState): number {
  return DELIVERY_RANK.get(state) ?? -1;
}

export interface LifecycleMarkers {
  /** Latest consensus outcome seen in the journal, if any. */
  consensus: { status: string | null; gate_id: string | null; at: string | null } | null;
  /** Set when a human hold was requested and not yet superseded by progress. */
  manual_review: { at: string; detail: string | null } | null;
  /** Serial-promotion evidence, the exactly-once signal FH-11 consumes. */
  promotion: { promoted_at: string | null; canonical_complete_at: string | null } | null;
}

export interface ExecutionProjection {
  execution_id: string;
  identifier: string | null;
  /** The materialized answer. Built by `normalizeExecutionLifecycle`. */
  lifecycle: ExecutionLifecycle;
  /** Strongest state each store asserts independently. */
  sources: { journal: ExecutionState | null; record: ExecutionState | null };
  divergence: { diverged: boolean; reason: string };
  markers: LifecycleMarkers;
  events_applied: number;
  last_event_at: string | null;
}

export interface LifecycleProjectionResult {
  ok: boolean;
  /** Non-null exactly when `ok` is false. Gating consumers must fail closed. */
  degraded_reason: string | null;
  generated_at: string;
  executions: ExecutionProjection[];
}

/** Stable identity for deduplicating a re-emitted event. */
function eventIdentity(event: FlightEvent): string {
  return JSON.stringify([event.execution_id, event.kind, event.ts ?? "", event.detail ?? ""]);
}

/**
 * Post-merge reconciliation and serial promotion record their events under
 * synthetic ids — `reconcile-ZOU-902`, `serial-ZOU-902` — not the execution id
 * that did the work. That is a direct cause of the fragmentation this module
 * exists to fix: run the reducer without alias folding and ZOU-902 shows
 * `verified` on `exec-ed5547e3` while a phantom `reconcile-ZOU-902` separately
 * shows `merged`, so the merge proof never reaches the canonical execution.
 *
 * Aliases fold into the canonical `exec-*` execution for the same ticket. When
 * no canonical execution exists, the alias stands on its own rather than being
 * dropped.
 */
const ALIAS_PREFIX = /^(reconcile|serial|shipping)-(.+)$/;

export function isAliasExecutionId(executionId: string): boolean {
  return ALIAS_PREFIX.test(executionId);
}

export function resolveAliases(
  executionIds: readonly string[],
  identifierOf: (executionId: string) => string | null,
): Map<string, string> {
  const canonicalByIdentifier = new Map<string, string>();
  for (const id of executionIds) {
    if (isAliasExecutionId(id)) continue;
    const identifier = identifierOf(id);
    if (!identifier) continue;
    // Deterministic pick when a ticket somehow has two real executions.
    const existing = canonicalByIdentifier.get(identifier);
    if (!existing || id < existing) canonicalByIdentifier.set(identifier, id);
  }

  const mapping = new Map<string, string>();
  for (const id of executionIds) {
    const alias = id.match(ALIAS_PREFIX);
    if (!alias) {
      mapping.set(id, id);
      continue;
    }
    const identifier = identifierOf(id) ?? alias[2];
    mapping.set(id, canonicalByIdentifier.get(identifier) ?? id);
  }
  return mapping;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function strongestJournalState(states: ReadonlySet<ExecutionState>): ExecutionState | null {
  let best: ExecutionState | null = null;
  for (const state of states) {
    if (!isDeliveryState(state)) continue;
    if (best === null || rankOf(state) > rankOf(best)) best = state;
  }
  if (best) return best;
  // No delivery progress: report the most specific outcome that was observed.
  for (const candidate of ["failed", "held", "dry_run", "pool_enqueued", "executing"] as const) {
    if (states.has(candidate)) return candidate;
  }
  return null;
}

function markersFrom(events: readonly FlightEvent[]): LifecycleMarkers {
  let consensus: LifecycleMarkers["consensus"] = null;
  let manualReview: LifecycleMarkers["manual_review"] = null;
  let promotedAt: string | null = null;
  let canonicalAt: string | null = null;
  let strongestProgressAt: string | null = null;

  for (const event of events) {
    const at = isIso(event.ts) ? event.ts : null;
    if (event.kind === "consensus.complete") {
      const data = event.data ?? {};
      const status = typeof data.status === "string" ? data.status : null;
      if (consensus === null || (at && consensus.at && at >= consensus.at) || consensus.at === null) {
        consensus = {
          status,
          gate_id: typeof data.gate_id === "string" ? data.gate_id : null,
          at,
        };
      }
    } else if (event.kind === "manual-review.requested" && at) {
      manualReview = { at, detail: event.detail ?? null };
    } else if (event.kind === "serial-promotion.promoted" && at) {
      promotedAt = at;
    } else if (event.kind === "serial-promotion.canonical-complete" && at) {
      canonicalAt = at;
    } else if (event.kind === "recovery.resolved" && at) {
      // FH-06 — an operator answered the hold; that answer must be able to
      // clear the marker even when no delivery state advanced with it.
      if (strongestProgressAt === null || at > strongestProgressAt) strongestProgressAt = at;
    }
    // Any delivery progress after a hold supersedes that hold.
    const state = KIND_TO_STATE[event.kind];
    if (state && isDeliveryState(state) && at && (strongestProgressAt === null || at > strongestProgressAt)) {
      strongestProgressAt = at;
    }
  }

  if (manualReview && strongestProgressAt && strongestProgressAt > manualReview.at) manualReview = null;

  return {
    consensus,
    manual_review: manualReview,
    promotion: promotedAt || canonicalAt
      ? { promoted_at: promotedAt, canonical_complete_at: canonicalAt }
      : null,
  };
}

/**
 * Fold one execution's events plus its mutable record into a projection.
 * Pure — no I/O, no clock beyond the injected `now`.
 */
export function projectExecution(
  executionId: string,
  events: readonly FlightEvent[],
  record: Record<string, unknown> | null,
  now = new Date().toISOString(),
): ExecutionProjection {
  // Deduplicate first: resumed cycles re-emit identical events.
  const seen = new Set<string>();
  const unique: FlightEvent[] = [];
  for (const event of events) {
    const identity = eventIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(event);
  }
  // Sort for deterministic evidence ordering; the fold itself is order-free.
  unique.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  const observed = new Set<ExecutionState>();
  const journalEvidence: LifecycleEvidence = {};
  let lastEventAt: string | null = null;

  for (const event of unique) {
    if (isIso(event.ts) && (lastEventAt === null || event.ts > lastEventAt)) lastEventAt = event.ts;
    const state = KIND_TO_STATE[event.kind];
    if (!state) continue;
    observed.add(state);
    const reference: LifecycleEvidenceReference = {
      kind: event.kind,
      reference: `journal:${event.kind}:${event.ts ?? "unknown"}`,
      recorded_at: isIso(event.ts) ? event.ts : now,
      ...(event.detail ? { details: { detail: event.detail } } : {}),
    };
    (journalEvidence[state] ??= []).push(reference);
  }

  const journalState = strongestJournalState(observed);
  const recordState = record && typeof record.state === "string" && isDeliveryState(record.state)
    ? (record.state as ExecutionState)
    : record && typeof record.state === "string"
      ? (record.state as ExecutionState)
      : null;

  // Merge evidence: the record's own evidence plus everything the journal
  // proves. `normalizeExecutionLifecycle` then applies the contiguity rule, so
  // `target_reached` still requires an unbroken chain — the journal can raise
  // the reported state without fabricating proof.
  const recordEvidence = (record?.evidence ?? {}) as LifecycleEvidence;
  const mergedEvidence: LifecycleEvidence = {};
  for (const key of new Set([...Object.keys(recordEvidence), ...Object.keys(journalEvidence)])) {
    const state = key as ExecutionState;
    mergedEvidence[state] = [...(recordEvidence[state] ?? []), ...(journalEvidence[state] ?? [])];
  }

  const candidates: ExecutionState[] = [];
  if (journalState) candidates.push(journalState);
  if (recordState) candidates.push(recordState);
  const materialized = candidates.length === 0
    ? "executing"
    : candidates.reduce((best, state) => (rankOf(state) > rankOf(best) ? state : best));

  const lifecycle = normalizeExecutionLifecycle(
    {
      ...(record ?? {}),
      state: materialized,
      evidence: mergedEvidence,
    },
    { now },
  );

  const diverged = Boolean(
    journalState && recordState && journalState !== recordState
    && (isDeliveryState(journalState) || isDeliveryState(recordState)),
  );

  return {
    execution_id: executionId,
    identifier: unique.find((event) => event.identifier)?.identifier
      ?? (typeof record?.identifier === "string" ? record.identifier : null),
    lifecycle,
    sources: { journal: journalState, record: recordState },
    divergence: {
      diverged,
      reason: diverged
        ? `journal proves ${journalState} while the execution record says ${recordState}; projection takes ${lifecycle.state}`
        : "stores agree",
    },
    markers: markersFrom(unique),
    events_applied: unique.length,
    last_event_at: lastEventAt,
  };
}

export interface ProjectLifecycleOptions {
  events?: readonly FlightEvent[];
  records?: ReadonlyArray<Record<string, unknown>>;
  days?: number;
  base?: string;
  now?: string;
}

/**
 * Materialize every execution visible in the journal or the state directory.
 * Never throws: an unreadable source degrades the result rather than killing
 * the conveyor step that called it.
 */
export function projectLifecycle(options: ProjectLifecycleOptions = {}): LifecycleProjectionResult {
  const now = options.now ?? new Date().toISOString();
  const base = options.base ?? PROJECT_DIR;

  let events: readonly FlightEvent[];
  let records: ReadonlyArray<Record<string, unknown>>;
  try {
    events = options.events ?? readFlightEvents({ days: options.days ?? 14 });
    records = options.records ?? readExecutionRecords(base);
  } catch (error) {
    return {
      ok: false,
      degraded_reason: `projection sources unreadable: ${error instanceof Error ? error.message : String(error)}`,
      generated_at: now,
      executions: [],
    };
  }

  try {
    const rawByExecution = new Map<string, FlightEvent[]>();
    for (const event of events) {
      if (!event?.execution_id) continue;
      const bucket = rawByExecution.get(event.execution_id);
      if (bucket) bucket.push(event);
      else rawByExecution.set(event.execution_id, [event]);
    }
    const recordsById = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const id = typeof record.execution_id === "string" ? record.execution_id : null;
      if (id) recordsById.set(id, record);
    }

    const allIds = [...new Set([...rawByExecution.keys(), ...recordsById.keys()])].sort();
    const identifierOf = (executionId: string): string | null => {
      const fromEvents = rawByExecution.get(executionId)?.find((event) => event.identifier)?.identifier;
      if (fromEvents) return fromEvents;
      const record = recordsById.get(executionId);
      return typeof record?.identifier === "string" ? record.identifier : null;
    };

    // Fold reconcile/serial/shipping aliases into their canonical execution so
    // merge and promotion proof lands on the execution that did the work.
    const aliasMap = resolveAliases(allIds, identifierOf);
    const byExecution = new Map<string, FlightEvent[]>();
    for (const [rawId, bucket] of rawByExecution) {
      const canonical = aliasMap.get(rawId) ?? rawId;
      const target = byExecution.get(canonical);
      if (target) target.push(...bucket);
      else byExecution.set(canonical, [...bucket]);
    }

    const ids = [...new Set([...byExecution.keys(), ...recordsById.keys()])]
      .filter((id) => (aliasMap.get(id) ?? id) === id)
      .sort();
    const executions = ids.map((id) =>
      projectExecution(id, byExecution.get(id) ?? [], recordsById.get(id) ?? null, now)
    );

    return { ok: true, degraded_reason: null, generated_at: now, executions };
  } catch (error) {
    return {
      ok: false,
      degraded_reason: `projection fold failed: ${error instanceof Error ? error.message : String(error)}`,
      generated_at: now,
      executions: [],
    };
  }
}

export function readExecutionRecords(base = PROJECT_DIR): Array<Record<string, unknown>> {
  const dir = factoryStatePathForProject(base);
  if (!existsSync(dir)) return [];
  const records: Array<Record<string, unknown>> = [];
  for (const name of readdirSync(dir)) {
    if (!isExecutionRecordFileName(name)) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8"));
      if (isExecutionRecordIdentity(name, parsed)) records.push(parsed);
    } catch {
      // One corrupt record must not blind the whole projection.
    }
  }
  return records;
}

/** Executions whose stores disagree — the cross-store consistency measure. */
export function divergentExecutions(result: LifecycleProjectionResult): ExecutionProjection[] {
  return result.executions.filter((execution) => execution.divergence.diverged);
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean" },
      execution: { type: "string" },
      days: { type: "string" },
      divergent: { type: "boolean" },
    },
    strict: false,
  });

  const days = Number.parseInt(String(values.days ?? "14"), 10);
  const result = projectLifecycle({ days: Number.isFinite(days) && days > 0 ? days : 14 });
  const selected = values.execution
    ? result.executions.filter((execution) =>
        execution.execution_id === values.execution || execution.identifier === values.execution)
    : values.divergent
      ? divergentExecutions(result)
      : result.executions;

  if (values.json) {
    // Single-line JSON: conveyor stdout is consumed by shell pipes.
    console.log(JSON.stringify({ ...result, executions: selected }));
  } else if (!result.ok) {
    console.error(`projection DEGRADED — ${result.degraded_reason}`);
  } else {
    for (const execution of selected) {
      const flag = execution.divergence.diverged ? " ⚠ divergent" : "";
      console.log(
        `${execution.identifier ?? "?"} ${execution.execution_id} ${execution.lifecycle.state}`
        + ` (target_reached=${execution.lifecycle.target_reached})${flag}`,
      );
    }
    console.log(`${selected.length} execution(s); ${divergentExecutions(result).length} divergent`);
  }
  process.exit(result.ok ? 0 : 1);
}
