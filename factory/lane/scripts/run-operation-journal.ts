import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  ATTEMPT_STATUSES,
  AUTHORITY_KINDS,
  canonicalize,
  EVENT_KINDS,
  parseRunReceipt,
  reconstructRunReceipt,
  REDACTED_VALUE,
  SIDE_EFFECT_KINDS,
  TERMINAL_OUTCOMES,
  TRIGGER_KINDS,
  validateRunReceipt,
  type AttemptStatus,
  type AuthorityKind,
  type RunAttempt,
  type RunEvent,
  type RunEventKind,
  type RunReceipt,
  type RunSideEffect,
  type SideEffectKind,
  type TerminalOutcome,
  type TriggerKind,
} from "./run-receipt-contract";
import {
  assertDatabaseResourceCeiling,
  checkpointJournal,
  DEFAULT_BUSY_TIMEOUT_MS,
  openJournalDatabase,
  resolveJournalPath,
  type OpenJournalOptions,
} from "./run-operation-journal-schema";
import {
  buildEdgeProofRecord,
  validateEdgeProofPlan,
  validateEdgeProofObservation,
  validateEdgeProofRecord,
  type EdgeProofObservation,
  type EdgeProofPlan,
  type EdgeProofRecord,
} from "./run-edge-proof";

export const MAX_EVENT_PAYLOAD_BYTES = 65_536;
export const DEFAULT_WRITE_DEADLINE_MS = 5_000;
export const DEFAULT_MAX_BUSY_RETRIES = 1;
export const OBSERVATIONAL_EFFECT_WRITERS = [
  "factory-conveyor-scheduled",
  "factory-cycle-contract",
  "factory-github-shipping",
] as const;

const SECRET_KEY = /(^|[_-])(secret|password|token|api[_-]?key)([_-]|$)/i;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type EffectState = "intended" | "dispatch_started" | "committed" | "not_committed" | "ambiguous" | "compensated";
export type CrashBoundary = "reservation" | "effect_intent" | "dispatch_start" | "adapter_result" | "terminal_event" | "receipt_publish" | "checkpoint";

export interface JournalAuthority {
  envelopeKind: AuthorityKind;
  approvingAuthority: string | null;
  approvalTs: string | null;
  approvalRef: string | null;
  autonomyTier: "T0" | "T1" | "T2" | null;
  authorizationEvidenceRef: string | null;
  scopes: string[];
  expiresAt: string | null;
}

export interface ReservationInput {
  scope: string;
  idempotencyKey: string;
  intent: unknown;
  triggerKind: TriggerKind;
  triggerIdentity: string;
  authority: JournalAuthority;
  requiredAuthorityScope?: string;
  operationDeadline?: string | null;
  sourceWriter?: string;
  sourceEventId?: string;
}

export interface ReservedOperation {
  status: "reserved";
  operationId: string;
  inputHash: string;
  existing: boolean;
}

export interface AuthorityHold {
  status: "held";
  holdId: string;
  reasonCode: string;
  inputHash: string;
}

export interface EffectSpec {
  attemptN: number;
  adapterKind: string;
  sideEffectKind: SideEffectKind;
  target: string;
  input: unknown;
  reversible: boolean;
  rollbackRef: string | null;
  authorityScope: string;
}

export interface AdapterEffect {
  effectId: string;
  operationId: string;
  adapterKind: string;
  target: string;
  input: unknown;
  rollbackRef: string | null;
}

export interface AdapterObservation {
  state: "committed" | "not_committed" | "ambiguous";
  evidence: unknown;
}

export interface EffectAdapter {
  dispatch(effect: AdapterEffect): AdapterObservation | Promise<AdapterObservation>;
  probe(effect: AdapterEffect): AdapterObservation | Promise<AdapterObservation>;
  compensate?(effect: AdapterEffect): AdapterObservation | Promise<AdapterObservation>;
}

export interface EffectExecutionResult {
  status: "completed" | "held";
  effectId: string | null;
  state: EffectState | "authority_held";
  reasonCode?: string;
}

export type ObservationalEffectWriter = typeof OBSERVATIONAL_EFFECT_WRITERS[number];

export interface ObservationalEffectSource {
  writer: ObservationalEffectWriter;
  eventId: string;
  payloadHash?: string;
}

export interface OperationJournalOptions extends OpenJournalOptions {
  now?: () => string;
  writeDeadlineMs?: number;
  maxBusyRetries?: number;
  crashInjector?: (boundary: CrashBoundary) => void;
}

export interface AttemptTimingMetadata {
  producerOverheadMs?: number;
}

export interface TerminalEdgeProofInput {
  plan: EdgeProofPlan;
  observation: EdgeProofObservation | null;
}

interface OperationRow {
  operation_id: string;
  scope: string;
  idempotency_key: string;
  input_hash: string;
  canonical_input: string;
  trigger_kind: TriggerKind;
  trigger_identity: string;
  authority_json: string;
  created_at: string;
  operation_deadline: string | null;
}

interface EffectRow {
  effect_id: string;
  operation_id: string;
  attempt_n: number;
  tool_call_id: string;
  adapter_kind: string;
  side_effect_kind: SideEffectKind;
  target: string;
  input_hash: string;
  canonical_input: string;
  reversible: number;
  rollback_ref: string | null;
  authority_scope: string;
  created_at: string;
}

interface EffectStateRow {
  commit_sequence: number;
  state_id: string;
  effect_id: string;
  state_sequence: number;
  state: EffectState;
  canonical_evidence: string;
  evidence_hash: string;
  created_at: string;
}

interface JournalEventRow {
  event_id: string;
  operation_id: string;
  event_sequence: number;
  kind: RunEventKind;
  canonical_payload: string;
  payload_hash: string;
  prior_event_hash: string | null;
  event_hash: string;
  source_writer: string | null;
  source_event_id: string | null;
  source_payload_hash: string | null;
  created_at: string;
}

export class OperationJournalError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OperationJournalError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableId(prefix: string, seed: string): string {
  let value = BigInt(`0x${sha256(seed)}`);
  let suffix = "";
  for (let index = 0; index < 26; index++) {
    suffix = CROCKFORD[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `${prefix}${suffix}`;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED_VALUE : redact(child);
  }
  return output;
}

function canonicalRedacted(value: unknown): string {
  return canonicalize(redact(value));
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function authorityFailure(authority: JournalAuthority, requiredScope: string, now: string): string | null {
  if (!AUTHORITY_KINDS.includes(authority.envelopeKind) || authority.envelopeKind === "none") return "authority_missing";
  if (authority.expiresAt && (!Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.parse(now))) return "authority_expired";
  if (!authority.scopes.includes("*") && !authority.scopes.includes(requiredScope)) return "authority_scope_mismatch";
  return null;
}

function terminalEventKind(outcome: TerminalOutcome): RunEventKind {
  if (outcome === "held") return "operation.held";
  if (["failure", "timeout", "cancelled"].includes(outcome)) return "operation.failed";
  return "operation.completed";
}

export class OperationJournal {
  readonly db: Database;
  readonly path: string;
  private readonly now: () => string;
  private readonly writeDeadlineMs: number;
  private readonly maxBusyRetries: number;
  private readonly crashInjector?: (boundary: CrashBoundary) => void;

  constructor(path: string, options: OperationJournalOptions = {}) {
    this.path = resolveJournalPath({ path, env: process.env });
    this.now = options.now ?? (() => new Date().toISOString());
    this.writeDeadlineMs = options.writeDeadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
    this.maxBusyRetries = options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES;
    if (!Number.isInteger(this.writeDeadlineMs) || this.writeDeadlineMs < 1 || this.writeDeadlineMs > DEFAULT_WRITE_DEADLINE_MS) {
      throw new OperationJournalError("write_deadline_invalid", `write deadline must be between 1 and ${DEFAULT_WRITE_DEADLINE_MS}`);
    }
    if (!Number.isInteger(this.maxBusyRetries) || this.maxBusyRetries < 0 || this.maxBusyRetries > DEFAULT_MAX_BUSY_RETRIES) {
      throw new OperationJournalError("busy_retries_invalid", `busy retries must be between 0 and ${DEFAULT_MAX_BUSY_RETRIES}`);
    }
    this.crashInjector = options.crashInjector;
    this.db = openJournalDatabase(this.path, options);
  }

  close(): void {
    this.db.close();
  }

  private boundary(boundary: CrashBoundary): void {
    this.crashInjector?.(boundary);
  }

  private transaction<T>(action: () => T): T {
    const started = Date.now();
    let attempts = 0;
    while (true) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const result = action();
          this.db.exec("COMMIT");
          assertDatabaseResourceCeiling(this.path);
          return result;
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } catch (error) {
        if (!isBusy(error) || attempts >= this.maxBusyRetries || Date.now() - started >= this.writeDeadlineMs) throw error;
        attempts++;
      }
    }
  }

  private recordAuthorityHold(scope: string, key: string, inputHash: string, authority: JournalAuthority, reasonCode: string): AuthorityHold {
    return this.transaction(() => {
      const holdId = stableId("hold-", `${scope}\0${key}\0${inputHash}\0${reasonCode}`);
      this.db.query(`
        INSERT OR IGNORE INTO authority_holds
          (hold_id, scope, idempotency_key, input_hash, reason_code, canonical_authority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(holdId, scope, key, inputHash, reasonCode, canonicalRedacted(authority), this.now());
      return { status: "held", holdId, reasonCode, inputHash };
    });
  }

  private appendEventTx(
    operationId: string,
    kind: RunEventKind,
    payload: Record<string, unknown>,
    source?: { writer: string; eventId: string; payloadHash?: string },
  ): RunEvent {
    if (!EVENT_KINDS.includes(kind)) throw new OperationJournalError("event_kind_invalid", `unsupported event kind ${kind}`);
    const prior = this.db.query(`
      SELECT event_sequence, event_id, event_hash FROM journal_events
      WHERE operation_id = ? ORDER BY event_sequence DESC LIMIT 1
    `).get(operationId) as { event_sequence: number; event_id: string; event_hash: string } | null;
    const sequence = (prior?.event_sequence ?? 0) + 1;
    const canonicalPayload = canonicalRedacted(payload);
    if (Buffer.byteLength(canonicalPayload, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
      throw new OperationJournalError("event_payload_too_large", `event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`);
    }
    const payloadHash = sha256(canonicalPayload);
    const eventId = stableId("evt-", `${operationId}\0${sequence}\0${kind}\0${payloadHash}`);
    const sourceWriter = source?.writer ?? "run-operation-journal";
    const sourceEventId = source?.eventId ?? eventId;
    const sourcePayloadHash = source?.payloadHash ?? payloadHash;
    const eventHash = sha256(canonicalize({
      operation_id: operationId,
      event_sequence: sequence,
      prior_event_hash: prior?.event_hash ?? null,
      kind,
      canonical_payload: canonicalPayload,
      source_writer: sourceWriter,
      source_event_id: sourceEventId,
      source_payload_hash: sourcePayloadHash,
    }));
    const createdAt = this.now();
    this.db.query(`
      INSERT INTO journal_events
        (event_id, operation_id, event_sequence, kind, canonical_payload, payload_hash,
         prior_event_hash, event_hash, source_writer, source_event_id, source_payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, operationId, sequence, kind, canonicalPayload, payloadHash,
      prior?.event_hash ?? null, eventHash, sourceWriter, sourceEventId, sourcePayloadHash, createdAt,
    );
    return {
      event_id: eventId,
      source_event_id: sourceEventId,
      causal_parent_id: prior?.event_id ?? null,
      sequence,
      cursor: `rrc:${operationId}:${sequence}`,
      kind,
      ts: createdAt,
      attempt_n: typeof payload.attempt_n === "number" ? payload.attempt_n : null,
      tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : null,
      tool_result_for: typeof payload.tool_result_for === "string" ? payload.tool_result_for : null,
      payload_hash: payloadHash,
    };
  }

  registerEdgeProofPlan(plan: EdgeProofPlan): EdgeProofPlan {
    validateEdgeProofPlan(plan);
    if (plan.operation_id !== this.operation(plan.operation_id).operation_id) throw new OperationJournalError("edge_plan_operation", "edge proof plan operation is unavailable");
    const canonicalPlan = canonicalize(plan);
    return this.transaction(() => {
      const existing = this.db.query("SELECT canonical_plan FROM edge_proof_plans WHERE plan_id = ?").get(plan.plan_id) as { canonical_plan: string } | null;
      if (existing) {
        if (existing.canonical_plan !== canonicalPlan) throw new OperationJournalError("edge_plan_conflict", "edge proof plan id is already bound to different content");
        return plan;
      }
      this.db.query(`
        INSERT INTO edge_proof_plans
          (plan_id, operation_id, target_hash, requirement, canonical_plan, plan_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(plan.plan_id, plan.operation_id, plan.target_hash, plan.requirement, canonicalPlan, plan.plan_hash, plan.created_at);
      return plan;
    });
  }

  appendEdgeProofObservation(plan: EdgeProofPlan, observation: EdgeProofObservation): EdgeProofObservation {
    validateEdgeProofObservation(plan, observation);
    const planRow = this.db.query("SELECT plan_hash FROM edge_proof_plans WHERE plan_id = ?").get(plan.plan_id) as { plan_hash: string } | null;
    if (!planRow || planRow.plan_hash !== plan.plan_hash) throw new OperationJournalError("edge_plan_missing", "edge proof plan must be frozen before observation");
    const canonicalObservation = canonicalize(observation);
    const sourceBindingHash = observation.source_revision || observation.provider_event_id || observation.payload_hash
      ? sha256(canonicalize({
        adapter: plan.adapter.kind,
        target_hash: plan.target_hash,
        source_revision: observation.source_revision,
        provider_event_id: observation.provider_event_id,
        payload_hash: observation.payload_hash,
      }))
      : null;
    return this.transaction(() => {
      const existing = this.db.query("SELECT canonical_observation FROM edge_proof_observations WHERE observation_id = ?").get(observation.observation_id) as { canonical_observation: string } | null;
      if (existing) {
        if (existing.canonical_observation !== canonicalObservation) throw new OperationJournalError("edge_observation_conflict", "edge observation id is already bound to different content");
        return observation;
      }
      if (sourceBindingHash) {
        const replay = this.db.query("SELECT observation_id FROM edge_proof_observations WHERE source_binding_hash = ?").get(sourceBindingHash) as { observation_id: string } | null;
        if (replay) throw new OperationJournalError("edge_source_replay", "authoritative edge source binding was already consumed");
      }
      this.db.query(`
        INSERT INTO edge_proof_observations
          (observation_id, plan_id, attempt, status, acknowledgement_tier, canonical_observation,
           observation_hash, source_binding_hash, predecessor_hash, observed_at, next_poll_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.observation_id, observation.plan_id, observation.attempt, observation.status,
        observation.acknowledgement_tier, canonicalObservation, observation.observation_hash,
        sourceBindingHash, observation.predecessor_hash, observation.observed_at, observation.next_poll_at,
      );
      return observation;
    });
  }

  reserve(input: ReservationInput): ReservedOperation | AuthorityHold {
    if (!TRIGGER_KINDS.includes(input.triggerKind)) throw new OperationJournalError("trigger_invalid", `unsupported trigger ${input.triggerKind}`);
    if (!input.scope || !input.idempotencyKey || !input.triggerIdentity) throw new OperationJournalError("reservation_invalid", "scope, idempotency key, and trigger identity are required");
    const canonicalInput = canonicalRedacted(input.intent);
    const inputHash = sha256(canonicalInput);
    const now = this.now();
    const reason = authorityFailure(input.authority, input.requiredAuthorityScope ?? "operation.reserve", now);
    if (reason) return this.recordAuthorityHold(input.scope, input.idempotencyKey, inputHash, input.authority, reason);

    const result = this.transaction(() => {
      const existing = this.db.query("SELECT operation_id, input_hash FROM operations WHERE scope = ? AND idempotency_key = ?")
        .get(input.scope, input.idempotencyKey) as { operation_id: string; input_hash: string } | null;
      if (existing) {
        if (existing.input_hash !== inputHash) throw new OperationJournalError("idempotency_conflict", "idempotency key is already bound to different input");
        return { status: "reserved", operationId: existing.operation_id, inputHash, existing: true } as ReservedOperation;
      }
      const operationId = stableId("op-", `${input.scope}\0${input.idempotencyKey}\0${inputHash}`);
      this.db.query(`
        INSERT INTO operations
          (operation_id, scope, idempotency_key, input_hash, canonical_input, trigger_kind,
           trigger_identity, authority_json, created_at, operation_deadline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operationId, input.scope, input.idempotencyKey, inputHash, canonicalInput, input.triggerKind,
        input.triggerIdentity, canonicalRedacted(input.authority), now, input.operationDeadline ?? null,
      );
      this.appendEventTx(operationId, "operation.accepted", { intent_hash: inputHash }, input.sourceWriter && input.sourceEventId ? {
        writer: input.sourceWriter,
        eventId: input.sourceEventId,
        payloadHash: inputHash,
      } : undefined);
      return { status: "reserved", operationId, inputHash, existing: false } as ReservedOperation;
    });
    if (!result.existing) this.boundary("reservation");
    return result;
  }

  findOperation(scope: string, idempotencyKey: string): ReservedOperation | null {
    const row = this.db.query("SELECT operation_id, input_hash FROM operations WHERE scope = ? AND idempotency_key = ?")
      .get(scope, idempotencyKey) as { operation_id: string; input_hash: string } | null;
    return row ? { status: "reserved", operationId: row.operation_id, inputHash: row.input_hash, existing: true } : null;
  }

  assertOperationAuthority(operationId: string, authority: JournalAuthority): void {
    const operation = this.operation(operationId);
    if (operation.authority_json !== canonicalRedacted(authority)) {
      throw new OperationJournalError("authority_drift", "operation authority differs from the reserved envelope");
    }
  }

  beginAttempt(operationId: string, attemptN: number, metadata?: AttemptTimingMetadata): RunEvent {
    if (!Number.isInteger(attemptN) || attemptN < 1) throw new OperationJournalError("attempt_invalid", "attempt number must be positive");
    return this.transaction(() => {
      this.operation(operationId);
      const existing = this.runEvents(operationId).find((event) => event.kind === "attempt.started" && event.attempt_n === attemptN);
      if (existing) return existing;
      return this.appendEventTx(operationId, "attempt.started", {
        attempt_n: attemptN,
        ...(metadata ? { shadow_timing: { producer_overhead_ms: metadata.producerOverheadMs } } : {}),
      });
    });
  }

  completeAttempt(
    operationId: string,
    attemptN: number,
    status: AttemptStatus,
    error: string | null = null,
    retryReason: string | null = null,
    metadata?: AttemptTimingMetadata,
  ): RunEvent {
    if (!ATTEMPT_STATUSES.includes(status)) throw new OperationJournalError("attempt_status_invalid", `unsupported attempt status ${status}`);
    return this.transaction(() => {
      const events = this.runEvents(operationId);
      if (!events.some((event) => event.kind === "attempt.started" && event.attempt_n === attemptN)) {
        throw new OperationJournalError("attempt_missing", `attempt ${attemptN} has not started`);
      }
      const existing = events.find((event) => event.kind === "attempt.completed" && event.attempt_n === attemptN);
      if (existing) {
        const row = this.db.query("SELECT canonical_payload FROM journal_events WHERE event_id = ?").get(existing.event_id) as { canonical_payload: string };
        const payload = parseJson<Record<string, unknown>>(row.canonical_payload);
        if (payload.status !== status || payload.error !== error || payload.retry_reason !== retryReason) {
          throw new OperationJournalError("attempt_completion_conflict", `attempt ${attemptN} is already completed with different content`);
        }
        return existing;
      }
      return this.appendEventTx(operationId, "attempt.completed", {
        attempt_n: attemptN,
        status,
        error,
        retry_reason: retryReason,
        ...(metadata ? { shadow_timing: { producer_overhead_ms: metadata.producerOverheadMs } } : {}),
      });
    });
  }

  private operation(operationId: string): OperationRow {
    const row = this.db.query("SELECT * FROM operations WHERE operation_id = ?").get(operationId) as OperationRow | null;
    if (!row) throw new OperationJournalError("operation_missing", `operation ${operationId} does not exist`);
    return row;
  }

  private effect(effectId: string): EffectRow {
    const row = this.db.query("SELECT * FROM effect_definitions WHERE effect_id = ?").get(effectId) as EffectRow | null;
    if (!row) throw new OperationJournalError("effect_missing", `effect ${effectId} does not exist`);
    return row;
  }

  private latestEffectState(effectId: string): EffectStateRow | null {
    return this.db.query("SELECT * FROM effect_states WHERE effect_id = ? ORDER BY state_sequence DESC LIMIT 1")
      .get(effectId) as EffectStateRow | null;
  }

  private appendEffectStateTx(effectId: string, state: EffectState, evidence: unknown): EffectStateRow {
    const prior = this.latestEffectState(effectId);
    const sequence = (prior?.state_sequence ?? 0) + 1;
    const canonicalEvidence = canonicalRedacted(evidence);
    const evidenceHash = sha256(canonicalEvidence);
    const stateId = stableId("state-", `${effectId}\0${sequence}\0${state}\0${evidenceHash}`);
    const createdAt = this.now();
    this.db.query(`
      INSERT INTO effect_states
        (state_id, effect_id, state_sequence, state, canonical_evidence, evidence_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(stateId, effectId, sequence, state, canonicalEvidence, evidenceHash, createdAt);
    return this.latestEffectState(effectId)!;
  }

  private completeToolTx(
    effect: EffectRow,
    state: EffectState,
    evidence: unknown,
    source?: { writer: string; eventId: string; payloadHash?: string },
  ): void {
    const rows = this.db.query(`
      SELECT canonical_payload, source_writer, source_event_id
      FROM journal_events WHERE operation_id = ? AND kind = 'tool.completed'
    `).all(effect.operation_id) as Array<{
      canonical_payload: string;
      source_writer: string | null;
      source_event_id: string | null;
    }>;
    const existing = rows.find((row) => parseJson<Record<string, unknown>>(row.canonical_payload).tool_result_for === effect.tool_call_id);
    if (existing) {
      if (source && (existing.source_writer !== source.writer || existing.source_event_id !== source.eventId)) {
        throw new OperationJournalError("observational_source_conflict", "observed effect is already bound to a different source event");
      }
      return;
    }
    this.appendEventTx(effect.operation_id, "tool.completed", {
      attempt_n: effect.attempt_n,
      tool_result_for: effect.tool_call_id,
      effect_id: effect.effect_id,
      state,
      evidence,
    }, source);
  }

  private defineEffect(operationId: string, spec: EffectSpec, authority: JournalAuthority): EffectRow | AuthorityHold {
    if (!SIDE_EFFECT_KINDS.includes(spec.sideEffectKind)) throw new OperationJournalError("side_effect_kind_invalid", `unsupported side effect ${spec.sideEffectKind}`);
    const canonicalInput = canonicalRedacted(spec.input);
    const inputHash = sha256(canonicalInput);
    const reason = authorityFailure(authority, spec.authorityScope, this.now());
    if (reason) return this.recordAuthorityHold(operationId, `${spec.adapterKind}:${spec.target}`, inputHash, authority, reason);
    const effectId = stableId("eff-", `${operationId}\0${spec.adapterKind}\0${spec.target}\0${inputHash}`);
    return this.transaction(() => {
      const existing = this.db.query(`
        SELECT * FROM effect_definitions
        WHERE operation_id = ? AND adapter_kind = ? AND target = ? AND input_hash = ?
      `).get(operationId, spec.adapterKind, spec.target, inputHash) as EffectRow | null;
      if (existing) return existing;
      const toolCallId = stableId("tool-", effectId);
      const createdAt = this.now();
      this.db.query(`
        INSERT INTO effect_definitions
          (effect_id, operation_id, attempt_n, tool_call_id, adapter_kind, side_effect_kind,
           target, input_hash, canonical_input, reversible, rollback_ref, authority_scope, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        effectId, operationId, spec.attemptN, toolCallId, spec.adapterKind, spec.sideEffectKind,
        spec.target, inputHash, canonicalInput, spec.reversible ? 1 : 0, spec.rollbackRef, spec.authorityScope, createdAt,
      );
      this.appendEffectStateTx(effectId, "intended", { input_hash: inputHash });
      this.appendEventTx(operationId, "tool.called", {
        attempt_n: spec.attemptN,
        tool_call_id: toolCallId,
        effect_id: effectId,
        adapter_kind: spec.adapterKind,
        target: spec.target,
      });
      return this.effect(effectId);
    });
  }

  private adapterEffect(effect: EffectRow): AdapterEffect {
    return {
      effectId: effect.effect_id,
      operationId: effect.operation_id,
      adapterKind: effect.adapter_kind,
      target: effect.target,
      input: parseJson(effect.canonical_input),
      rollbackRef: effect.rollback_ref,
    };
  }

  private persistObservation(effect: EffectRow, observation: AdapterObservation, completeTool = true): EffectStateRow {
    return this.transaction(() => {
      const row = this.appendEffectStateTx(effect.effect_id, observation.state, observation.evidence);
      if (completeTool) this.completeToolTx(effect, row.state, observation.evidence);
      return row;
    });
  }

  async executeEffect(operationId: string, spec: EffectSpec, authority: JournalAuthority, adapter: EffectAdapter): Promise<EffectExecutionResult> {
    this.operation(operationId);
    const definition = this.defineEffect(operationId, spec, authority);
    if ("status" in definition) return { status: "held", effectId: null, state: "authority_held", reasonCode: definition.reasonCode };
    const effect = definition;
    if (this.latestEffectState(effect.effect_id)?.state === "intended") this.boundary("effect_intent");
    let dispatches = 0;
    while (true) {
      const latest = this.latestEffectState(effect.effect_id)!;
      if (["committed", "compensated"].includes(latest.state)) return { status: "completed", effectId: effect.effect_id, state: latest.state };
      if (latest.state === "dispatch_started" || latest.state === "ambiguous") {
        let probed: AdapterObservation;
        try {
          probed = await adapter.probe(this.adapterEffect(effect));
        } catch (error) {
          probed = { state: "ambiguous", evidence: { error: error instanceof Error ? error.message : String(error) } };
        }
        if (probed.state === "ambiguous") {
          this.transaction(() => this.completeToolTx(effect, "ambiguous", probed.evidence));
          return { status: "held", effectId: effect.effect_id, state: "ambiguous", reasonCode: "external_state_ambiguous" };
        }
        const row = this.persistObservation(effect, probed, probed.state === "committed");
        this.boundary("adapter_result");
        if (row.state === "committed") return { status: "completed", effectId: effect.effect_id, state: row.state };
      }

      if (dispatches > this.maxBusyRetries) {
        this.transaction(() => this.completeToolTx(effect, "not_committed", { reason: "retry_budget_exhausted" }));
        return { status: "completed", effectId: effect.effect_id, state: "not_committed", reasonCode: "retry_budget_exhausted" };
      }
      this.transaction(() => this.appendEffectStateTx(effect.effect_id, "dispatch_started", { dispatch: dispatches + 1 }));
      this.boundary("dispatch_start");
      let observation: AdapterObservation;
      try {
        observation = await adapter.dispatch(this.adapterEffect(effect));
      } catch (error) {
        observation = { state: "ambiguous", evidence: { error: error instanceof Error ? error.message : String(error) } };
      }
      const row = this.persistObservation(effect, observation, observation.state !== "not_committed");
      this.boundary("adapter_result");
      dispatches++;
      if (row.state === "committed") return { status: "completed", effectId: effect.effect_id, state: row.state };
      if (row.state === "ambiguous") return { status: "held", effectId: effect.effect_id, state: row.state, reasonCode: "external_state_ambiguous" };
    }
  }

  importObservedEffect(
    operationId: string,
    spec: EffectSpec,
    authority: JournalAuthority,
    source: ObservationalEffectSource,
    evidence: unknown,
  ): EffectExecutionResult {
    this.assertOperationAuthority(operationId, authority);
    if (!OBSERVATIONAL_EFFECT_WRITERS.includes(source.writer)) {
      throw new OperationJournalError("observational_writer_unregistered", `writer ${source.writer} is not registered for observational import`);
    }
    if (!source.eventId) throw new OperationJournalError("observational_source_invalid", "observational source event id is required");
    const inputHash = sha256(canonicalRedacted(spec.input));
    const committed = this.db.query(`
      SELECT d.input_hash FROM effect_definitions d
      JOIN effect_states s ON s.effect_id = d.effect_id
      WHERE d.operation_id = ? AND d.adapter_kind = ? AND d.target = ? AND s.state = 'committed'
      LIMIT 1
    `).get(operationId, spec.adapterKind, spec.target) as { input_hash: string } | null;
    if (committed && committed.input_hash !== inputHash) {
      throw new OperationJournalError("observational_effect_conflict", "a committed effect already exists for this operation, adapter, and target");
    }
    const definition = this.defineEffect(operationId, spec, authority);
    if ("status" in definition) {
      return { status: "held", effectId: null, state: "authority_held", reasonCode: definition.reasonCode };
    }
    const effect = definition;
    return this.transaction(() => {
      const duplicate = this.db.query(`
        SELECT d.effect_id FROM effect_definitions d
        JOIN effect_states s ON s.effect_id = d.effect_id
        WHERE d.operation_id = ? AND d.adapter_kind = ? AND d.target = ? AND d.effect_id != ?
          AND s.state = 'committed'
        LIMIT 1
      `).get(operationId, spec.adapterKind, spec.target, effect.effect_id) as { effect_id: string } | null;
      if (duplicate) {
        throw new OperationJournalError("observational_effect_conflict", "a committed effect already exists for this operation, adapter, and target");
      }
      let latest = this.latestEffectState(effect.effect_id)!;
      if (latest.state === "committed") {
        this.completeToolTx(effect, "committed", evidence, source);
        return { status: "completed", effectId: effect.effect_id, state: "committed" };
      }
      if (latest.state === "intended") {
        latest = this.appendEffectStateTx(effect.effect_id, "dispatch_started", {
          observational_import: true,
          source_writer: source.writer,
          source_event_id: source.eventId,
        });
      }
      if (latest.state !== "dispatch_started") {
        throw new OperationJournalError("observational_effect_state", `cannot import observed effect from state ${latest.state}`);
      }
      latest = this.appendEffectStateTx(effect.effect_id, "committed", evidence);
      this.completeToolTx(effect, latest.state, evidence, source);
      return { status: "completed", effectId: effect.effect_id, state: latest.state };
    });
  }

  async compensateOperation(
    operationId: string,
    attemptN: number,
    authority: JournalAuthority,
    adapterFor: (kind: string) => EffectAdapter | undefined,
  ): Promise<EffectExecutionResult[]> {
    const effects = this.db.query(`
      SELECT d.* FROM effect_definitions d
      JOIN effect_states s ON s.effect_id = d.effect_id
      WHERE d.operation_id = ? AND d.reversible = 1 AND s.state = 'committed'
        AND s.commit_sequence = (SELECT MAX(x.commit_sequence) FROM effect_states x WHERE x.effect_id = d.effect_id)
      ORDER BY s.commit_sequence DESC
    `).all(operationId) as EffectRow[];
    const results: EffectExecutionResult[] = [];
    for (const original of effects) {
      const adapter = adapterFor(original.adapter_kind);
      const authorityScope = `compensate:${original.adapter_kind}`;
      const reason = authorityFailure(authority, authorityScope, this.now());
      if (!adapter?.compensate || reason) {
        results.push({ status: "held", effectId: original.effect_id, state: "authority_held", reasonCode: reason ?? "compensation_unavailable" });
        break;
      }
      const compensationSpec: EffectSpec = {
        attemptN,
        adapterKind: `${original.adapter_kind}.compensation`,
        sideEffectKind: original.side_effect_kind,
        target: `compensation:${original.effect_id}`,
        input: { original_effect_id: original.effect_id, rollback_ref: original.rollback_ref },
        reversible: false,
        rollbackRef: null,
        authorityScope,
      };
      const compensation = this.defineEffect(operationId, compensationSpec, authority);
      if ("status" in compensation) {
        results.push({ status: "held", effectId: original.effect_id, state: "authority_held", reasonCode: compensation.reasonCode });
        break;
      }
      this.boundary("effect_intent");
      this.transaction(() => this.appendEffectStateTx(compensation.effect_id, "dispatch_started", { original_effect_id: original.effect_id }));
      this.boundary("dispatch_start");
      let observation: AdapterObservation;
      try {
        observation = await adapter.compensate(this.adapterEffect(original));
      } catch (error) {
        observation = { state: "ambiguous", evidence: { error: error instanceof Error ? error.message : String(error) } };
      }
      this.persistObservation(compensation, observation);
      this.boundary("adapter_result");
      if (observation.state !== "committed") {
        results.push({ status: "held", effectId: original.effect_id, state: observation.state, reasonCode: "compensation_incomplete" });
        break;
      }
      this.transaction(() => this.appendEffectStateTx(original.effect_id, "compensated", { compensation_effect_id: compensation.effect_id }));
      results.push({ status: "completed", effectId: original.effect_id, state: "compensated" });
    }
    return results;
  }

  private runEvents(operationId: string): RunEvent[] {
    const rows = this.db.query("SELECT * FROM journal_events WHERE operation_id = ? ORDER BY event_sequence")
      .all(operationId) as JournalEventRow[];
    return rows.map((row, index) => {
      const payload = parseJson<Record<string, unknown>>(row.canonical_payload);
      return {
        event_id: row.event_id,
        source_event_id: row.source_event_id ?? row.event_id,
        causal_parent_id: index === 0 ? null : rows[index - 1].event_id,
        sequence: row.event_sequence,
        cursor: `rrc:${operationId}:${row.event_sequence}`,
        kind: row.kind,
        ts: row.created_at,
        attempt_n: typeof payload.attempt_n === "number" ? payload.attempt_n : null,
        tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : null,
        tool_result_for: typeof payload.tool_result_for === "string" ? payload.tool_result_for : null,
        payload_hash: row.payload_hash,
      };
    });
  }

  private runAttempts(operationId: string, events: readonly RunEvent[]): RunAttempt[] {
    const rows = this.db.query("SELECT * FROM journal_events WHERE operation_id = ? ORDER BY event_sequence")
      .all(operationId) as JournalEventRow[];
    const payloads = new Map(rows.map((row) => [row.event_id, parseJson<Record<string, unknown>>(row.canonical_payload)]));
    const definitions = this.db.query("SELECT * FROM effect_definitions WHERE operation_id = ? ORDER BY attempt_n, created_at")
      .all(operationId) as EffectRow[];
    const attempts = events.filter((event) => event.kind === "attempt.started").map((started): RunAttempt => {
      const completed = events.find((event) => event.kind === "attempt.completed" && event.attempt_n === started.attempt_n);
      const completedPayload = completed ? payloads.get(completed.event_id) ?? {} : {};
      const sideEffects: RunSideEffect[] = definitions.filter((effect) => effect.attempt_n === started.attempt_n).map((effect) => {
        const state = this.latestEffectState(effect.effect_id)?.state;
        return {
          effect_id: effect.effect_id,
          kind: effect.side_effect_kind,
          target: effect.target,
          committed: state === "committed",
          reversible: effect.reversible === 1,
          rollback_ref: effect.rollback_ref,
        };
      });
      return {
        attempt_n: started.attempt_n!,
        ts_start: started.ts,
        ts_end: completed?.ts ?? null,
        status: (completedPayload.status ?? "failure") as AttemptStatus,
        side_effects: sideEffects,
        error: typeof completedPayload.error === "string" ? completedPayload.error : null,
        retry_reason: typeof completedPayload.retry_reason === "string" ? completedPayload.retry_reason : null,
      };
    });
    return attempts.sort((left, right) => left.attempt_n - right.attempt_n);
  }

  terminalize(
    operationId: string,
    outcome: TerminalOutcome,
    reasonCode: string,
    template: RunReceipt,
    edgeProof?: TerminalEdgeProofInput,
  ): RunReceipt {
    if (!TERMINAL_OUTCOMES.includes(outcome)) throw new OperationJournalError("terminal_outcome_invalid", `unsupported outcome ${outcome}`);
    const existing = this.db.query("SELECT canonical_receipt FROM receipts WHERE operation_id = ?").get(operationId) as { canonical_receipt: string } | null;
    if (existing) return parseRunReceipt(parseJson(existing.canonical_receipt));
    const operation = this.operation(operationId);
    const latestStates = this.db.query(`
      SELECT s.state FROM effect_states s
      JOIN effect_definitions d ON d.effect_id = s.effect_id
      WHERE d.operation_id = ?
        AND s.commit_sequence = (SELECT MAX(x.commit_sequence) FROM effect_states x WHERE x.effect_id = s.effect_id)
    `).all(operationId) as Array<{ state: EffectState }>;
    if (latestStates.some((row) => ["dispatch_started", "ambiguous"].includes(row.state)) && outcome !== "held") {
      throw new OperationJournalError("terminal_state_ambiguous", "unknown external state requires held outcome");
    }
    if (edgeProof) {
      if (edgeProof.plan.operation_id !== operationId) throw new OperationJournalError("edge_plan_operation", "edge proof plan belongs to another operation");
      const planRow = this.db.query("SELECT plan_hash FROM edge_proof_plans WHERE plan_id = ?").get(edgeProof.plan.plan_id) as { plan_hash: string } | null;
      if (!planRow || planRow.plan_hash !== edgeProof.plan.plan_hash) throw new OperationJournalError("edge_plan_missing", "edge proof plan must be frozen before terminalization");
      if (edgeProof.observation) {
        validateEdgeProofObservation(edgeProof.plan, edgeProof.observation);
        const observationRow = this.db.query("SELECT observation_hash FROM edge_proof_observations WHERE observation_id = ?").get(edgeProof.observation.observation_id) as { observation_hash: string } | null;
        if (!observationRow || observationRow.observation_hash !== edgeProof.observation.observation_hash) throw new OperationJournalError("edge_observation_missing", "edge proof observation must be persisted before terminalization");
      }
    }

    return this.transaction(() => {
      const terminalEvent = this.appendEventTx(operationId, terminalEventKind(outcome), { outcome, reason_code: reasonCode });
      this.boundary("terminal_event");
      if (edgeProof?.observation?.status === "confirmed" && edgeProof.observation.acknowledgement_tier === "user_visible_confirmed") {
        this.appendEventTx(operationId, "delivery.visible", {
          proof_id: edgeProof.observation.observation_id,
          target_hash: edgeProof.plan.target_hash,
        }, {
          writer: `edge-proof:${edgeProof.plan.adapter.kind}`,
          eventId: edgeProof.observation.provider_event_id ?? edgeProof.observation.observation_id,
          payloadHash: edgeProof.observation.payload_hash ?? edgeProof.observation.observation_hash,
        });
      }
      const events = this.runEvents(operationId);
      const attempts = this.runAttempts(operationId, events);
      const authority = parseJson<JournalAuthority>(operation.authority_json);
      const committedStateHash = sha256(canonicalize(latestStates));
      const receiptId = stableId("rr-", operationId);
      const receiptTemplate: RunReceipt = {
        ...template,
        receipt_id: receiptId,
        operation_id: operationId,
        idempotency_key: operation.idempotency_key,
        receipt_hash: "0".repeat(64),
        trigger: {
          kind: operation.trigger_kind,
          identity: operation.trigger_identity,
          intent: operation.canonical_input,
          input_hash: operation.input_hash,
          ts: operation.created_at,
        },
        authority: {
          envelope_kind: authority.envelopeKind,
          approving_authority: authority.approvingAuthority,
          approval_ts: authority.approvalTs,
          approval_ref: authority.approvalRef,
          autonomy_tier: authority.autonomyTier,
          authorization_evidence_ref: authority.authorizationEvidenceRef,
        },
        events,
        attempts,
        terminal: {
          ...template.terminal,
          outcome,
          committed_state_hash: committedStateHash,
        },
        acknowledgements: {
          accepted: template.acknowledgements.accepted,
          completed: template.acknowledgements.completed,
          user_visible: null,
        },
        observation: {
          user_visible_outcome: null,
          user_confirmed: null,
          feedback_ref: null,
        },
        ts_created: operation.created_at,
        ts_terminal: terminalEvent.ts,
      };
      const receipt = reconstructRunReceipt(receiptTemplate, events);
      const validation = validateRunReceipt(receipt);
      if (!validation.ok) throw new OperationJournalError("receipt_invalid", canonicalize(validation.errors));
      const canonicalReceipt = canonicalize(receipt);
      this.db.query(`
        INSERT INTO terminal_records
          (operation_id, outcome, reason_code, terminal_event_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(operationId, outcome, reasonCode, terminalEvent.event_id, terminalEvent.ts);
      this.db.query(`
        INSERT INTO receipts
          (operation_id, receipt_id, receipt_hash, canonical_receipt, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(operationId, receipt.receipt_id, receipt.receipt_hash, canonicalReceipt, terminalEvent.ts);
      if (edgeProof) this.appendEdgeProofRecordTx(operationId, edgeProof.plan, edgeProof.observation, receipt, terminalEvent);
      this.boundary("receipt_publish");
      return receipt;
    });
  }

  private appendEdgeProofRecordTx(
    operationId: string,
    plan: EdgeProofPlan,
    observation: EdgeProofObservation | null,
    receipt: RunReceipt,
    terminalEvent?: RunEvent,
  ): EdgeProofRecord {
    const terminal = terminalEvent ?? receipt.events.find((event) => ["operation.completed", "operation.failed", "operation.held"].includes(event.kind));
    if (!terminal) throw new OperationJournalError("terminal_event_missing", "receipt terminal event is unavailable");
    const prior = this.db.query("SELECT record_hash FROM edge_proof_records WHERE operation_id = ? ORDER BY commit_sequence DESC LIMIT 1")
      .get(operationId) as { record_hash: string } | null;
    const record = buildEdgeProofRecord(plan, {
      receiptId: receipt.receipt_id,
      receiptHash: receipt.receipt_hash,
      terminalEventId: terminal.event_id,
      terminalSourceRef: terminal.source_event_id,
    }, observation, prior?.record_hash ?? null);
    validateEdgeProofRecord(record);
    const canonicalRecord = canonicalize(record);
    this.db.query(`
      INSERT INTO edge_proof_records
        (record_id, proof_id, operation_id, receipt_id, receipt_hash, plan_id, classification,
         acknowledgement_tier, timeliness, canonical_record, predecessor_record_hash, record_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.record_id, record.proof_id, operationId, record.receipt_id, record.receipt_hash, record.plan_id,
      record.classification, record.acknowledgement_tier, record.timeliness, canonicalRecord,
      record.predecessor_record_hash, record.record_hash, record.observed_at ?? terminal.ts,
    );
    return record;
  }

  appendEdgeProofSupplement(plan: EdgeProofPlan, observation: EdgeProofObservation | null): EdgeProofRecord {
    const receipt = this.receipt(plan.operation_id);
    if (!receipt) throw new OperationJournalError("receipt_missing", "edge proof supplement requires an immutable receipt");
    const planRow = this.db.query("SELECT plan_hash FROM edge_proof_plans WHERE plan_id = ?").get(plan.plan_id) as { plan_hash: string } | null;
    if (!planRow || planRow.plan_hash !== plan.plan_hash) throw new OperationJournalError("edge_plan_missing", "edge proof plan must be frozen before supplement publication");
    if (observation) {
      validateEdgeProofObservation(plan, observation);
      const observationRow = this.db.query("SELECT observation_hash FROM edge_proof_observations WHERE observation_id = ?").get(observation.observation_id) as { observation_hash: string } | null;
      if (!observationRow || observationRow.observation_hash !== observation.observation_hash) throw new OperationJournalError("edge_observation_missing", "edge proof observation must be persisted before supplement publication");
    }
    return this.transaction(() => this.appendEdgeProofRecordTx(plan.operation_id, plan, observation, receipt));
  }

  edgeProofRecords(operationId: string): EdgeProofRecord[] {
    return (this.db.query("SELECT canonical_record FROM edge_proof_records WHERE operation_id = ? ORDER BY commit_sequence")
      .all(operationId) as Array<{ canonical_record: string }>).map((row) => parseJson<EdgeProofRecord>(row.canonical_record));
  }

  receipt(operationId: string): RunReceipt | null {
    const row = this.db.query("SELECT canonical_receipt FROM receipts WHERE operation_id = ?").get(operationId) as { canonical_receipt: string } | null;
    return row ? parseRunReceipt(parseJson(row.canonical_receipt)) : null;
  }

  checkpoint(): void {
    checkpointJournal(this.db);
    this.boundary("checkpoint");
  }
}

export class InMemoryEffectAdapter implements EffectAdapter {
  readonly committed = new Set<string>();
  readonly compensationOrder: string[] = [];

  dispatch(effect: AdapterEffect): AdapterObservation {
    this.committed.add(effect.effectId);
    return { state: "committed", evidence: { effect_id: effect.effectId } };
  }

  probe(effect: AdapterEffect): AdapterObservation {
    return this.committed.has(effect.effectId)
      ? { state: "committed", evidence: { effect_id: effect.effectId, probe: true } }
      : { state: "not_committed", evidence: { effect_id: effect.effectId, probe: true } };
  }

  compensate(effect: AdapterEffect): AdapterObservation {
    this.compensationOrder.push(effect.effectId);
    this.committed.delete(effect.effectId);
    return { state: "committed", evidence: { compensated_effect_id: effect.effectId } };
  }
}

export async function runOperationJournalSelfTest(path: string): Promise<{ ok: true; operationId: string; receiptHash: string }> {
  const authority: JournalAuthority = {
    envelopeKind: "operator_approval",
    approvingAuthority: "selftest",
    approvalTs: new Date(0).toISOString(),
    approvalRef: "selftest",
    autonomyTier: "T0",
    authorizationEvidenceRef: "selftest",
    scopes: ["operation.reserve", "tool:test"],
    expiresAt: null,
  };
  const journal = new OperationJournal(path, { busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS });
  try {
    const reserved = journal.reserve({
      scope: "selftest",
      idempotencyKey: "selftest",
      intent: { action: "selftest", api_token: "must-redact" },
      triggerKind: "operator",
      triggerIdentity: "selftest",
      authority,
    });
    if (reserved.status !== "reserved") throw new OperationJournalError("selftest_held", reserved.reasonCode);
    journal.beginAttempt(reserved.operationId, 1);
    const effect = await journal.executeEffect(reserved.operationId, {
      attemptN: 1,
      adapterKind: "test",
      sideEffectKind: "api_call",
      target: "selftest",
      input: { api_key: "must-redact", value: 1 },
      reversible: true,
      rollbackRef: "selftest:rollback",
      authorityScope: "tool:test",
    }, authority, new InMemoryEffectAdapter());
    if (effect.state !== "committed") throw new OperationJournalError("selftest_effect", `unexpected state ${effect.state}`);
    journal.completeAttempt(reserved.operationId, 1, "success");
    const template = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "run-receipt", "valid-success.json"), "utf8")) as RunReceipt;
    const receipt = journal.terminalize(reserved.operationId, "success", "selftest_complete", template);
    journal.checkpoint();
    if (!validateRunReceipt(receipt).ok) throw new OperationJournalError("selftest_receipt", "receipt validation failed");
    return { ok: true, operationId: reserved.operationId, receiptHash: receipt.receipt_hash };
  } finally {
    journal.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  if (!args.includes("--selftest") || dbIndex < 0 || !args[dbIndex + 1]) {
    console.error("Usage: bun run-operation-journal.ts --selftest --db /absolute/path.sqlite");
    process.exit(2);
  }
  const result = await runOperationJournalSelfTest(args[dbIndex + 1]);
  console.log(JSON.stringify(result));
}
