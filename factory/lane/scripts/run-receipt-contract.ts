import { createHash } from "node:crypto";

export const CONTRACT_ID = "zouroboros-run-receipt/v1" as const;
export const RECEIPT_SCHEMA_VERSION = 1 as const;
export const REDACTED_VALUE = "[REDACTED]" as const;

export const TRIGGER_KINDS = [
  "operator", "schedule", "automation", "webhook", "agent", "consensus", "factory", "evaluator",
] as const;
export const AUTHORITY_KINDS = [
  "operator_approval", "seed_authority", "receipt_authority", "consensus_quorum", "autonomy_policy", "none",
] as const;
export const EVENT_KINDS = [
  "operation.accepted",
  "attempt.started",
  "tool.called",
  "tool.completed",
  "attempt.completed",
  "operation.completed",
  "operation.failed",
  "operation.held",
  "delivery.visible",
] as const;
export const ATTEMPT_STATUSES = ["success", "failure", "timeout", "cancelled"] as const;
export const TERMINAL_OUTCOMES = ["success", "failure", "partial", "timeout", "cancelled", "held"] as const;
export const SIDE_EFFECT_KINDS = [
  "file_write", "file_delete", "api_call", "ledger_append", "service_register",
  "git_push", "linear_mutation", "qdrant_upsert", "qdrant_delete",
] as const;
export const CHECK_KINDS = ["mechanical", "consensus", "parity", "gap_audit", "constitutional"] as const;
export const ARTIFACT_KINDS = ["file", "pr", "ledger_entry", "service", "report", "evaluation"] as const;

export type TriggerKind = typeof TRIGGER_KINDS[number];
export type AuthorityKind = typeof AUTHORITY_KINDS[number];
export type RunEventKind = typeof EVENT_KINDS[number];
export type AttemptStatus = typeof ATTEMPT_STATUSES[number];
export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];
export type SideEffectKind = typeof SIDE_EFFECT_KINDS[number];
export type CheckKind = typeof CHECK_KINDS[number];
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface RunEvent {
  event_id: string;
  source_event_id: string;
  causal_parent_id: string | null;
  sequence: number;
  cursor: string;
  kind: RunEventKind;
  ts: string;
  attempt_n: number | null;
  tool_call_id: string | null;
  tool_result_for: string | null;
  payload_hash: string;
}

export interface RunSideEffect {
  effect_id: string;
  kind: SideEffectKind;
  target: string;
  committed: boolean;
  reversible: boolean;
  rollback_ref: string | null;
}

export interface RunAttempt {
  attempt_n: number;
  ts_start: string;
  ts_end: string | null;
  status: AttemptStatus;
  side_effects: RunSideEffect[];
  error: string | null;
  retry_reason: string | null;
}

export interface RunAcknowledgement {
  kind: "accepted" | "completed" | "user_visible";
  event_id: string;
  ts: string;
  evidence_ref: string;
}

export interface RunReceipt {
  $schema?: string;
  contract_id: typeof CONTRACT_ID;
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  receipt_id: string;
  operation_id: string;
  idempotency_key: string;
  receipt_hash: string;
  trigger: {
    kind: TriggerKind;
    identity: string;
    intent: string;
    input_hash: string;
    ts: string;
  };
  lineage: {
    parent_receipt_id: string | null;
    trace_id: string;
    span_id: string;
    inherited_state_refs: string[];
    wave_id: string | null;
    seed_id: string | null;
  };
  versions: {
    contract_version: typeof CONTRACT_ID;
    policy_version: string | null;
    model_versions: Record<string, string>;
    tool_versions: Record<string, string>;
    schema_migrations: string[];
  };
  authority: {
    envelope_kind: AuthorityKind;
    approving_authority: string | null;
    approval_ts: string | null;
    approval_ref: string | null;
    autonomy_tier: "T0" | "T1" | "T2" | null;
    authorization_evidence_ref: string | null;
  };
  events: RunEvent[];
  attempts: RunAttempt[];
  terminal: {
    outcome: TerminalOutcome;
    committed_state_hash: string;
    artifacts: Array<{ kind: ArtifactKind; ref: string; hash: string | null; description: string }>;
    ledger_entries: Array<{ ledger: string; record_hash: string; chain_verified: boolean }>;
  };
  acknowledgements: {
    accepted: RunAcknowledgement;
    completed: RunAcknowledgement | null;
    user_visible: RunAcknowledgement | null;
  };
  verification: {
    verifier_identity: string;
    verifier_org_separate: boolean;
    checks: Array<{ check_id: string; kind: CheckKind; pass: boolean; evidence_ref: string | null; detail: string }>;
    edge_proof: { chain_ok: boolean; anchor_ok: boolean; ledger_head: string | null };
  };
  observation: {
    user_visible_outcome: string | null;
    user_confirmed: boolean | null;
    feedback_ref: string | null;
  };
  redaction?: {
    redacted_fields: string[];
    redaction_reason: string;
    redaction_hash: string;
  };
  ts_created: string;
  ts_terminal: string;
}

export type ReceiptErrorCode =
  | "schema_invalid"
  | "idempotency_conflict"
  | "conflicting_event"
  | "sequence_gap"
  | "cursor_mismatch"
  | "causal_order"
  | "missing_transition"
  | "dangling_tool_call"
  | "duplicate_committed_effect"
  | "authority_missing"
  | "ack_mismatch"
  | "terminal_mismatch"
  | "edge_proof_mismatch"
  | "hash_mismatch"
  | "secret_unredacted"
  | "cursor_invalid"
  | "cursor_operation_mismatch"
  | "cursor_out_of_range";

export interface ReceiptValidationIssue {
  code: ReceiptErrorCode;
  path: string;
  message: string;
}

export interface ReceiptValidationResult {
  ok: boolean;
  errors: ReceiptValidationIssue[];
}

export class ReceiptContractError extends Error {
  constructor(
    public readonly code: ReceiptErrorCode,
    message: string,
    public readonly path = "",
  ) {
    super(message);
    this.name = "ReceiptContractError";
  }
}

const HASH = /^[0-9a-f]{64}$/;
const RECEIPT_ID = /^rr-[0-9A-HJKMNP-TV-Z]{26}$/;
const OPERATION_ID = /^op-[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_ID = /^evt-[A-Za-z0-9._:-]{1,128}$/;
const SECRET_KEY = /(^|[_-])(secret|password|token|api[_-]?key)([_-]|$)/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function inEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function canonicalize(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new ReceiptContractError("schema_invalid", "non-finite number cannot be canonicalized");
      return input;
    }
    if (Array.isArray(input)) return input.map(normalize);
    if (isObject(input)) {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        if (input[key] !== undefined) output[key] = normalize(input[key]);
      }
      return output;
    }
    throw new ReceiptContractError("schema_invalid", `unsupported canonical value type: ${typeof input}`);
  }
  return JSON.stringify(normalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function computeReceiptHash(receipt: RunReceipt): string {
  const input = deepClone(receipt) as unknown as Record<string, unknown>;
  delete input.receipt_hash;
  return sha256(canonicalize(input));
}

export function finalizeReceipt(receipt: RunReceipt): RunReceipt {
  const output = deepClone(receipt);
  output.receipt_hash = computeReceiptHash(output);
  return output;
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new ReceiptContractError("schema_invalid", `invalid JSON pointer: ${pointer}`);
  }
  return pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function setPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointerParts(pointer);
  let current: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(current) && !Array.isArray(current)) {
      throw new ReceiptContractError("schema_invalid", `redaction path is not traversable: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (!isObject(current) && !Array.isArray(current)) {
    throw new ReceiptContractError("schema_invalid", `redaction parent is not traversable: ${pointer}`);
  }
  const key = parts.at(-1)!;
  if (!(key in current)) throw new ReceiptContractError("schema_invalid", `redaction path does not exist: ${pointer}`);
  (current as Record<string, unknown>)[key] = value;
}

export function redactReceipt(receipt: RunReceipt, paths: readonly string[], reason: string): RunReceipt {
  if (!reason.trim() || paths.length === 0) {
    throw new ReceiptContractError("schema_invalid", "redaction requires paths and a reason");
  }
  const output = deepClone(receipt);
  const preimage = deepClone(output) as unknown as Record<string, unknown>;
  delete preimage.receipt_hash;
  delete preimage.redaction;
  const redactionHash = sha256(canonicalize(preimage));
  for (const path of [...new Set(paths)].sort()) setPointer(output as unknown as Record<string, unknown>, path, REDACTED_VALUE);
  output.redaction = {
    redacted_fields: [...new Set(paths)].sort(),
    redaction_reason: reason,
    redaction_hash: redactionHash,
  };
  return finalizeReceipt(output);
}

function structuralIssues(input: unknown): ReceiptValidationIssue[] {
  const errors: ReceiptValidationIssue[] = [];
  const add = (path: string, message: string) => errors.push({ code: "schema_invalid", path, message });
  const shape = (value: Record<string, unknown>, path: string, requiredKeys: readonly string[], optionalKeys: readonly string[] = []) => {
    for (const key of requiredKeys) if (!(key in value)) add(`${path}/${key}`, "required field is missing");
    const keys = new Set([...requiredKeys, ...optionalKeys]);
    for (const key of Object.keys(value)) if (!keys.has(key)) add(`${path}/${key}`, "unknown property");
  };
  if (!isObject(input)) return [{ code: "schema_invalid", path: "", message: "receipt must be an object" }];

  const required = [
    "contract_id", "schema_version", "receipt_id", "operation_id", "idempotency_key", "receipt_hash",
    "trigger", "lineage", "versions", "authority", "events", "attempts", "terminal", "acknowledgements",
    "verification", "observation", "ts_created", "ts_terminal",
  ];
  for (const key of required) if (!(key in input)) add(`/${key}`, "required field is missing");
  const allowed = new Set(["$schema", ...required, "redaction"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) add(`/${key}`, "unknown top-level property");
  if (input.contract_id !== CONTRACT_ID) add("/contract_id", `must equal ${CONTRACT_ID}`);
  if (input.schema_version !== RECEIPT_SCHEMA_VERSION) add("/schema_version", "must equal 1");
  if (typeof input.receipt_id !== "string" || !RECEIPT_ID.test(input.receipt_id)) add("/receipt_id", "invalid receipt ID");
  if (typeof input.operation_id !== "string" || !OPERATION_ID.test(input.operation_id)) add("/operation_id", "invalid operation ID");
  if (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 || input.idempotency_key.length > 256) add("/idempotency_key", "must contain 1-256 characters");
  if (typeof input.receipt_hash !== "string" || !HASH.test(input.receipt_hash)) add("/receipt_hash", "must be lowercase SHA-256");
  if (!isIso(input.ts_created)) add("/ts_created", "must be an ISO timestamp");
  if (!isIso(input.ts_terminal)) add("/ts_terminal", "must be an ISO timestamp");

  if (!isObject(input.trigger)) add("/trigger", "must be an object");
  else {
    shape(input.trigger, "/trigger", ["kind", "identity", "intent", "input_hash", "ts"]);
    if (!inEnum(input.trigger.kind, TRIGGER_KINDS)) add("/trigger/kind", "invalid trigger kind");
    if (typeof input.trigger.identity !== "string" || !input.trigger.identity) add("/trigger/identity", "must be non-empty");
    if (typeof input.trigger.intent !== "string" || !input.trigger.intent) add("/trigger/intent", "must be non-empty");
    if (typeof input.trigger.input_hash !== "string" || !HASH.test(input.trigger.input_hash)) add("/trigger/input_hash", "must be lowercase SHA-256");
    if (!isIso(input.trigger.ts)) add("/trigger/ts", "must be an ISO timestamp");
  }

  if (!isObject(input.lineage)) add("/lineage", "must be an object");
  else {
    shape(input.lineage, "/lineage", ["parent_receipt_id", "trace_id", "span_id", "inherited_state_refs", "wave_id", "seed_id"]);
    if (input.lineage.parent_receipt_id !== null && (typeof input.lineage.parent_receipt_id !== "string" || !RECEIPT_ID.test(input.lineage.parent_receipt_id))) add("/lineage/parent_receipt_id", "invalid parent receipt ID");
    if (typeof input.lineage.trace_id !== "string" || !/^[0-9a-f]{32}$/.test(input.lineage.trace_id)) add("/lineage/trace_id", "invalid trace ID");
    if (typeof input.lineage.span_id !== "string" || !/^[0-9a-f]{16}$/.test(input.lineage.span_id)) add("/lineage/span_id", "invalid span ID");
    if (!Array.isArray(input.lineage.inherited_state_refs)) add("/lineage/inherited_state_refs", "must be an array");
  }

  if (!isObject(input.versions)) add("/versions", "must be an object");
  else {
    shape(input.versions, "/versions", ["contract_version", "policy_version", "model_versions", "tool_versions", "schema_migrations"]);
    if (input.versions.contract_version !== CONTRACT_ID) add("/versions/contract_version", `must equal ${CONTRACT_ID}`);
    if (!isObject(input.versions.model_versions)) add("/versions/model_versions", "must be an object");
    if (!isObject(input.versions.tool_versions)) add("/versions/tool_versions", "must be an object");
    if (!Array.isArray(input.versions.schema_migrations)) add("/versions/schema_migrations", "must be an array");
  }
  if (!isObject(input.authority)) add("/authority", "must be an object");
  else {
    shape(input.authority, "/authority", ["envelope_kind", "approving_authority", "approval_ts", "approval_ref", "autonomy_tier", "authorization_evidence_ref"]);
    if (!inEnum(input.authority.envelope_kind, AUTHORITY_KINDS)) add("/authority/envelope_kind", "invalid authority kind");
  }

  if (!Array.isArray(input.events) || input.events.length === 0) add("/events", "must be a non-empty array");
  else input.events.forEach((event, index) => {
    const path = `/events/${index}`;
    if (!isObject(event)) return add(path, "must be an object");
    shape(event, path, ["event_id", "source_event_id", "causal_parent_id", "sequence", "cursor", "kind", "ts", "attempt_n", "tool_call_id", "tool_result_for", "payload_hash"]);
    if (typeof event.event_id !== "string" || !EVENT_ID.test(event.event_id)) add(`${path}/event_id`, "invalid event ID");
    if (typeof event.source_event_id !== "string" || !event.source_event_id) add(`${path}/source_event_id`, "must be non-empty");
    if (event.causal_parent_id !== null && (typeof event.causal_parent_id !== "string" || !EVENT_ID.test(event.causal_parent_id))) add(`${path}/causal_parent_id`, "invalid causal parent");
    if (!Number.isInteger(event.sequence) || (event.sequence as number) < 1) add(`${path}/sequence`, "must be a positive integer");
    if (typeof event.cursor !== "string") add(`${path}/cursor`, "must be a string");
    if (!inEnum(event.kind, EVENT_KINDS)) add(`${path}/kind`, "invalid event kind");
    if (!isIso(event.ts)) add(`${path}/ts`, "must be an ISO timestamp");
    if (event.attempt_n !== null && (!Number.isInteger(event.attempt_n) || (event.attempt_n as number) < 1)) add(`${path}/attempt_n`, "must be null or a positive integer");
    if (event.tool_call_id !== null && typeof event.tool_call_id !== "string") add(`${path}/tool_call_id`, "must be null or string");
    if (event.tool_result_for !== null && typeof event.tool_result_for !== "string") add(`${path}/tool_result_for`, "must be null or string");
    if (typeof event.payload_hash !== "string" || !HASH.test(event.payload_hash)) add(`${path}/payload_hash`, "must be lowercase SHA-256");
  });

  if (!Array.isArray(input.attempts) || input.attempts.length === 0) add("/attempts", "must be a non-empty array");
  else input.attempts.forEach((attempt, index) => {
    const path = `/attempts/${index}`;
    if (!isObject(attempt)) return add(path, "must be an object");
    shape(attempt, path, ["attempt_n", "ts_start", "ts_end", "status", "side_effects", "error", "retry_reason"]);
    if (!Number.isInteger(attempt.attempt_n) || (attempt.attempt_n as number) < 1) add(`${path}/attempt_n`, "must be a positive integer");
    if (!inEnum(attempt.status, ATTEMPT_STATUSES)) add(`${path}/status`, "invalid attempt status");
    if (!isIso(attempt.ts_start)) add(`${path}/ts_start`, "must be an ISO timestamp");
    if (attempt.ts_end !== null && !isIso(attempt.ts_end)) add(`${path}/ts_end`, "must be null or an ISO timestamp");
    if (!Array.isArray(attempt.side_effects)) add(`${path}/side_effects`, "must be an array");
    else attempt.side_effects.forEach((effect, effectIndex) => {
      const effectPath = `${path}/side_effects/${effectIndex}`;
      if (!isObject(effect)) return add(effectPath, "must be an object");
      shape(effect, effectPath, ["effect_id", "kind", "target", "committed", "reversible", "rollback_ref"]);
      if (typeof effect.effect_id !== "string" || !effect.effect_id) add(`${effectPath}/effect_id`, "must be non-empty");
      if (!inEnum(effect.kind, SIDE_EFFECT_KINDS)) add(`${effectPath}/kind`, "invalid side-effect kind");
      if (typeof effect.target !== "string" || !effect.target) add(`${effectPath}/target`, "must be non-empty");
      if (typeof effect.committed !== "boolean") add(`${effectPath}/committed`, "must be boolean");
      if (typeof effect.reversible !== "boolean") add(`${effectPath}/reversible`, "must be boolean");
      if (effect.rollback_ref !== null && typeof effect.rollback_ref !== "string") add(`${effectPath}/rollback_ref`, "must be null or string");
    });
  });

  if (!isObject(input.terminal)) add("/terminal", "must be an object");
  else {
    shape(input.terminal, "/terminal", ["outcome", "committed_state_hash", "artifacts", "ledger_entries"]);
    if (!inEnum(input.terminal.outcome, TERMINAL_OUTCOMES)) add("/terminal/outcome", "invalid terminal outcome");
    if (typeof input.terminal.committed_state_hash !== "string" || !HASH.test(input.terminal.committed_state_hash)) add("/terminal/committed_state_hash", "must be lowercase SHA-256");
    if (!Array.isArray(input.terminal.artifacts)) add("/terminal/artifacts", "must be an array");
    else input.terminal.artifacts.forEach((artifact, index) => {
      const path = `/terminal/artifacts/${index}`;
      if (!isObject(artifact)) return add(path, "must be an object");
      shape(artifact, path, ["kind", "ref", "hash", "description"]);
      if (!inEnum(artifact.kind, ARTIFACT_KINDS)) add(`${path}/kind`, "invalid artifact kind");
    });
    if (!Array.isArray(input.terminal.ledger_entries)) add("/terminal/ledger_entries", "must be an array");
    else input.terminal.ledger_entries.forEach((entry, index) => {
      const path = `/terminal/ledger_entries/${index}`;
      if (!isObject(entry)) return add(path, "must be an object");
      shape(entry, path, ["ledger", "record_hash", "chain_verified"]);
      if (typeof entry.record_hash !== "string" || !HASH.test(entry.record_hash)) add(`${path}/record_hash`, "must be lowercase SHA-256");
      if (typeof entry.chain_verified !== "boolean") add(`${path}/chain_verified`, "must be boolean");
    });
  }
  if (!isObject(input.acknowledgements)) add("/acknowledgements", "must be an object");
  else {
    shape(input.acknowledgements, "/acknowledgements", ["accepted", "completed", "user_visible"]);
    for (const key of ["accepted", "completed", "user_visible"] as const) {
      const acknowledgement = input.acknowledgements[key];
      if (acknowledgement === null && key !== "accepted") continue;
      if (!isObject(acknowledgement)) {
        add(`/acknowledgements/${key}`, "must be an acknowledgement object");
        continue;
      }
      shape(acknowledgement, `/acknowledgements/${key}`, ["kind", "event_id", "ts", "evidence_ref"]);
      if (acknowledgement.kind !== key) add(`/acknowledgements/${key}/kind`, `must equal ${key}`);
      if (typeof acknowledgement.event_id !== "string" || !EVENT_ID.test(acknowledgement.event_id)) add(`/acknowledgements/${key}/event_id`, "invalid event ID");
      if (!isIso(acknowledgement.ts)) add(`/acknowledgements/${key}/ts`, "must be an ISO timestamp");
    }
  }
  if (!isObject(input.verification)) add("/verification", "must be an object");
  else {
    shape(input.verification, "/verification", ["verifier_identity", "verifier_org_separate", "checks", "edge_proof"]);
    if (!Array.isArray(input.verification.checks)) add("/verification/checks", "must be an array");
    else input.verification.checks.forEach((check, index) => {
      const path = `/verification/checks/${index}`;
      if (!isObject(check)) return add(path, "must be an object");
      shape(check, path, ["check_id", "kind", "pass", "evidence_ref", "detail"]);
      if (!inEnum(check.kind, CHECK_KINDS)) add(`${path}/kind`, "invalid verification kind");
      if (typeof check.pass !== "boolean") add(`${path}/pass`, "must be boolean");
    });
    if (!isObject(input.verification.edge_proof)) add("/verification/edge_proof", "must be an object");
    else shape(input.verification.edge_proof, "/verification/edge_proof", ["chain_ok", "anchor_ok", "ledger_head"]);
  }
  if (!isObject(input.observation)) add("/observation", "must be an object");
  else shape(input.observation, "/observation", ["user_visible_outcome", "user_confirmed", "feedback_ref"]);
  if (input.redaction !== undefined) {
    if (!isObject(input.redaction)) add("/redaction", "must be an object");
    else {
      shape(input.redaction, "/redaction", ["redacted_fields", "redaction_reason", "redaction_hash"]);
      if (!Array.isArray(input.redaction.redacted_fields) || input.redaction.redacted_fields.length === 0) add("/redaction/redacted_fields", "must be a non-empty array");
      if (typeof input.redaction.redaction_hash !== "string" || !HASH.test(input.redaction.redaction_hash)) add("/redaction/redaction_hash", "must be lowercase SHA-256");
    }
  }
  return errors;
}

function issue(code: ReceiptErrorCode, path: string, message: string): ReceiptValidationIssue {
  return { code, path, message };
}

export function reduceRunEvents(events: readonly RunEvent[], operationId: string): RunEvent[] {
  const byEvent = new Map<string, string>();
  const bySource = new Map<string, string>();
  const deduped: RunEvent[] = [];
  for (const event of events) {
    const encoded = canonicalize(event);
    const eventPrior = byEvent.get(event.event_id);
    const sourcePrior = bySource.get(event.source_event_id);
    if ((eventPrior && eventPrior !== encoded) || (sourcePrior && sourcePrior !== encoded)) {
      throw new ReceiptContractError("conflicting_event", `conflicting event identity ${event.event_id}/${event.source_event_id}`, "/events");
    }
    if (eventPrior || sourcePrior) continue;
    byEvent.set(event.event_id, encoded);
    bySource.set(event.source_event_id, encoded);
    deduped.push(deepClone(event));
  }
  deduped.sort((a, b) => a.sequence - b.sequence);
  if (deduped[0]?.kind !== "operation.accepted") {
    throw new ReceiptContractError("missing_transition", "first event must be operation.accepted", "/events/0");
  }

  const startedAttempts = new Set<number>();
  const completedAttempts = new Set<number>();
  const openTools = new Map<string, number>();
  let terminal: RunEvent | null = null;
  for (let index = 0; index < deduped.length; index++) {
    const event = deduped[index];
    const expected = index + 1;
    if (event.sequence !== expected) throw new ReceiptContractError("sequence_gap", `expected sequence ${expected}, got ${event.sequence}`, `/events/${index}/sequence`);
    const expectedCursor = `rrc:${operationId}:${event.sequence}`;
    if (event.cursor !== expectedCursor) throw new ReceiptContractError("cursor_mismatch", `expected ${expectedCursor}`, `/events/${index}/cursor`);
    const expectedParent = index === 0 ? null : deduped[index - 1].event_id;
    if (event.causal_parent_id !== expectedParent) throw new ReceiptContractError("causal_order", `expected parent ${expectedParent ?? "null"}`, `/events/${index}/causal_parent_id`);

    if (event.kind === "attempt.started") {
      if (event.attempt_n === null || startedAttempts.has(event.attempt_n)) throw new ReceiptContractError("missing_transition", "attempt.started requires a new attempt_n", `/events/${index}`);
      startedAttempts.add(event.attempt_n);
    } else if (event.kind === "tool.called") {
      if (event.attempt_n === null || !startedAttempts.has(event.attempt_n) || completedAttempts.has(event.attempt_n)) throw new ReceiptContractError("missing_transition", "tool.called requires an active attempt", `/events/${index}`);
      if (!event.tool_call_id || openTools.has(event.tool_call_id)) throw new ReceiptContractError("conflicting_event", "tool.called requires a unique tool_call_id", `/events/${index}/tool_call_id`);
      openTools.set(event.tool_call_id, event.attempt_n);
    } else if (event.kind === "tool.completed") {
      const attempt = event.tool_result_for ? openTools.get(event.tool_result_for) : undefined;
      if (!event.tool_result_for || attempt === undefined || attempt !== event.attempt_n) throw new ReceiptContractError("dangling_tool_call", "tool.completed must reference an open call in the same attempt", `/events/${index}/tool_result_for`);
      openTools.delete(event.tool_result_for);
    } else if (event.kind === "attempt.completed") {
      if (event.attempt_n === null || !startedAttempts.has(event.attempt_n)) throw new ReceiptContractError("missing_transition", "attempt.completed requires attempt.started", `/events/${index}`);
      if ([...openTools.values()].includes(event.attempt_n)) throw new ReceiptContractError("dangling_tool_call", "attempt completed with an unresolved tool call", `/events/${index}`);
      completedAttempts.add(event.attempt_n);
    } else if (["operation.completed", "operation.failed", "operation.held"].includes(event.kind)) {
      if (terminal) throw new ReceiptContractError("conflicting_event", "operation has multiple terminal events", `/events/${index}`);
      if (openTools.size > 0) throw new ReceiptContractError("dangling_tool_call", "operation terminated with an unresolved tool call", `/events/${index}`);
      if ([...startedAttempts].some((attempt) => !completedAttempts.has(attempt))) throw new ReceiptContractError("missing_transition", "operation terminated before attempt completion", `/events/${index}`);
      terminal = event;
    } else if (event.kind === "delivery.visible" && !terminal) {
      throw new ReceiptContractError("missing_transition", "delivery.visible requires a terminal operation event", `/events/${index}`);
    }
  }
  if (!terminal) throw new ReceiptContractError("missing_transition", "operation terminal event is missing", "/events");
  if (openTools.size > 0) throw new ReceiptContractError("dangling_tool_call", "receipt contains unresolved tool calls", "/events");
  return deduped;
}

function semanticIssues(receipt: RunReceipt, verifyHash: boolean): ReceiptValidationIssue[] {
  const errors: ReceiptValidationIssue[] = [];
  let events: RunEvent[];
  try {
    events = reduceRunEvents(receipt.events, receipt.operation_id);
  } catch (error) {
    if (error instanceof ReceiptContractError) errors.push(issue(error.code, error.path, error.message));
    else throw error;
    return errors;
  }

  const attempts = [...receipt.attempts].sort((a, b) => a.attempt_n - b.attempt_n);
  attempts.forEach((attempt, index) => {
    if (attempt.attempt_n !== index + 1) errors.push(issue("missing_transition", `/attempts/${index}/attempt_n`, "attempt numbers must be contiguous"));
  });
  const eventAttempts = new Set(events.flatMap((event) => event.attempt_n === null ? [] : [event.attempt_n]));
  for (const attempt of attempts) if (!eventAttempts.has(attempt.attempt_n)) errors.push(issue("missing_transition", "/attempts", `attempt ${attempt.attempt_n} has no events`));

  const effects = new Set<string>();
  const committedEffects = attempts.flatMap((attempt) => attempt.side_effects).filter((effect) => effect.committed);
  for (const effect of committedEffects) {
    if (effects.has(effect.effect_id)) errors.push(issue("duplicate_committed_effect", "/attempts", `duplicate committed effect ${effect.effect_id}`));
    effects.add(effect.effect_id);
    if (effect.reversible && !effect.rollback_ref) errors.push(issue("schema_invalid", "/attempts", `reversible effect ${effect.effect_id} requires rollback_ref`));
  }
  if (committedEffects.length > 0 && receipt.authority.envelope_kind === "none") errors.push(issue("authority_missing", "/authority/envelope_kind", "committed side effects require authority"));
  if (committedEffects.length > 0 && !receipt.verification.verifier_org_separate) errors.push(issue("edge_proof_mismatch", "/verification/verifier_org_separate", "mutating run requires separate verifier"));

  const byId = new Map(events.map((event) => [event.event_id, event]));
  const accepted = byId.get(receipt.acknowledgements.accepted.event_id);
  if (!accepted || accepted.kind !== "operation.accepted" || receipt.acknowledgements.accepted.kind !== "accepted") errors.push(issue("ack_mismatch", "/acknowledgements/accepted", "accepted acknowledgement must reference operation.accepted"));
  const completedAck = receipt.acknowledgements.completed;
  const completedEvent = completedAck ? byId.get(completedAck.event_id) : null;
  if (!completedAck || !completedEvent || !["operation.completed", "operation.failed", "operation.held"].includes(completedEvent.kind) || completedAck.kind !== "completed") errors.push(issue("ack_mismatch", "/acknowledgements/completed", "completed acknowledgement must reference the terminal event"));
  const visibleAck = receipt.acknowledgements.user_visible;
  const visibleEvent = visibleAck ? byId.get(visibleAck.event_id) : null;
  if (visibleAck && (!visibleEvent || visibleEvent.kind !== "delivery.visible" || visibleAck.kind !== "user_visible")) errors.push(issue("ack_mismatch", "/acknowledgements/user_visible", "user-visible acknowledgement must reference delivery.visible"));
  if (!visibleAck && events.some((event) => event.kind === "delivery.visible")) errors.push(issue("ack_mismatch", "/acknowledgements/user_visible", "delivery.visible requires a user-visible acknowledgement"));

  const terminalEvent = events.find((event) => ["operation.completed", "operation.failed", "operation.held"].includes(event.kind));
  const allowedTerminalKind = receipt.terminal.outcome === "held"
    ? "operation.held"
    : ["failure", "timeout", "cancelled"].includes(receipt.terminal.outcome)
      ? "operation.failed"
      : "operation.completed";
  if (terminalEvent?.kind !== allowedTerminalKind) errors.push(issue("terminal_mismatch", "/terminal/outcome", `${receipt.terminal.outcome} requires ${allowedTerminalKind}`));

  const ledgerInvalid = receipt.terminal.ledger_entries.some((entry) => !entry.chain_verified);
  if (ledgerInvalid || !receipt.verification.edge_proof.chain_ok || !receipt.verification.edge_proof.anchor_ok) errors.push(issue("edge_proof_mismatch", "/verification/edge_proof", "ledger chain and anchor proof must agree and pass"));
  if (receipt.terminal.ledger_entries.length > 0 && !receipt.verification.edge_proof.ledger_head) errors.push(issue("edge_proof_mismatch", "/verification/edge_proof/ledger_head", "ledger head is required when ledger entries exist"));

  function scanSecrets(value: unknown, path: string): void {
    if (Array.isArray(value)) return value.forEach((item, index) => scanSecrets(item, `${path}/${index}`));
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}/${key}`;
      if (SECRET_KEY.test(key) && child !== REDACTED_VALUE) errors.push(issue("secret_unredacted", childPath, "secret-like field must be redacted"));
      else scanSecrets(child, childPath);
    }
  }
  scanSecrets(receipt, "");

  if (verifyHash && receipt.receipt_hash !== computeReceiptHash(receipt)) errors.push(issue("hash_mismatch", "/receipt_hash", "receipt hash does not match canonical redacted content"));
  return errors;
}

export function validateRunReceipt(input: unknown, options: { verifyHash?: boolean } = {}): ReceiptValidationResult {
  const structural = structuralIssues(input);
  if (structural.length > 0) return { ok: false, errors: structural };
  const semantic = semanticIssues(input as unknown as RunReceipt, options.verifyHash !== false);
  return { ok: semantic.length === 0, errors: semantic };
}

export function parseRunReceipt(input: unknown): RunReceipt {
  const result = validateRunReceipt(input);
  if (!result.ok) {
    const first = result.errors[0];
    throw new ReceiptContractError(first.code, first.message, first.path);
  }
  return deepClone(input as RunReceipt);
}

export function validateReceiptSet(receipts: readonly RunReceipt[]): ReceiptValidationResult {
  const errors: ReceiptValidationIssue[] = [];
  const byIdempotency = new Map<string, RunReceipt>();
  for (const [index, receipt] of receipts.entries()) {
    const result = validateRunReceipt(receipt);
    errors.push(...result.errors.map((entry) => ({ ...entry, path: `/receipts/${index}${entry.path}` })));
    const previous = byIdempotency.get(receipt.idempotency_key);
    if (previous && (previous.operation_id !== receipt.operation_id || previous.trigger.input_hash !== receipt.trigger.input_hash)) {
      errors.push(issue("idempotency_conflict", `/receipts/${index}/idempotency_key`, `idempotency key ${receipt.idempotency_key} maps to conflicting operations`));
    } else if (!previous) byIdempotency.set(receipt.idempotency_key, receipt);
  }
  return { ok: errors.length === 0, errors };
}

export function eventsAfterCursor(receipt: RunReceipt, cursor: string): RunEvent[] {
  const match = cursor.match(/^(rrc):(op-[0-9A-HJKMNP-TV-Z]{26}):([1-9][0-9]*)$/);
  if (!match) throw new ReceiptContractError("cursor_invalid", "cursor is malformed", "/cursor");
  if (match[2] !== receipt.operation_id) throw new ReceiptContractError("cursor_operation_mismatch", "cursor belongs to another operation", "/cursor");
  const sequence = Number(match[3]);
  const events = reduceRunEvents(receipt.events, receipt.operation_id);
  if (sequence > events.at(-1)!.sequence) throw new ReceiptContractError("cursor_out_of_range", "cursor is beyond the receipt head", "/cursor");
  return events.filter((event) => event.sequence > sequence).map(deepClone);
}

function acknowledgement(kind: RunAcknowledgement["kind"], event: RunEvent): RunAcknowledgement {
  return { kind, event_id: event.event_id, ts: event.ts, evidence_ref: event.source_event_id };
}

export function reconstructRunReceipt(template: RunReceipt, sourceEvents: readonly RunEvent[]): RunReceipt {
  const events = reduceRunEvents(sourceEvents, template.operation_id);
  const accepted = events.find((event) => event.kind === "operation.accepted")!;
  const completed = events.find((event) => ["operation.completed", "operation.failed", "operation.held"].includes(event.kind))!;
  const visible = events.find((event) => event.kind === "delivery.visible") ?? null;
  const output: RunReceipt = {
    ...deepClone(template),
    events,
    acknowledgements: {
      accepted: acknowledgement("accepted", accepted),
      completed: acknowledgement("completed", completed),
      user_visible: visible ? acknowledgement("user_visible", visible) : null,
    },
    ts_created: accepted.ts,
    ts_terminal: completed.ts,
    receipt_hash: "0".repeat(64),
  };
  return finalizeReceipt(output);
}

export function mapLegacyShippingOutcome(outcome: unknown): TerminalOutcome | null {
  if (["merged", "deployed", "accepted", "already_merged"].includes(String(outcome))) return "success";
  if (["failed", "rejected"].includes(String(outcome))) return "failure";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "timeout") return "timeout";
  if (outcome === "held" || outcome === "needs-review") return "held";
  return null;
}
