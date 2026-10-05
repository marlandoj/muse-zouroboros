import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { isTerminalExecution, normalizeExecutionLifecycle } from "./execution-lifecycle";

export const FACTORY_STATE_MUTATION_EVIDENCE_VERSION = 1 as const;
export const FACTORY_STATE_MUTATION_EVIDENCE_ROOT = "state-mutation-evidence";
export const FACTORY_STATE_MUTATION_RECEIPT_MAX_BYTES = 131_072;
export const FACTORY_STATE_MUTATION_PAYLOAD_MAX_BYTES = 65_536;

export type FactoryStateMutationEvidenceMode = "off" | "shadow" | "enforce";
export type FactoryStateMutationAction = "atomic-replace" | "claim-release";
export type FactoryStateMutationScope = "scheduled-cycle" | "background";
export type FactoryStateMutationTargetSchema =
  | "lane-current-cycle/v1"
  | "product-gate/v1"
  | "slo-state/v1"
  | "ticket-claim-owner/v1";
export type FactoryStateClaimReleaseStage = "prepared" | "committed";

export interface FactoryStateMutationCycleBinding {
  scope: FactoryStateMutationScope;
  cycle_id: string;
  requested_cycle_id: string | null;
  producer_id: string;
  sentinel_path: string | null;
  lane_log_path: string | null;
  reason: string | null;
}

export interface TicketClaimOwnerEvidence {
  schema_version: 1;
  ticket_id: string;
  execution_id: string;
  claimed_at: string;
  lease_expires_at: string;
  pid: number;
}

export interface FactoryStateClaimTerminalProof {
  execution_record_path: string;
  execution_record_sha256: string;
  ticket_id: string;
  execution_id: string;
  lifecycle_state: string;
}

export interface FactoryStateClaimReleaseEvidence {
  stage: FactoryStateClaimReleaseStage;
  claim_key: string;
  claim_directory_path: string;
  owner_path: string;
  owner_sha256: string;
  owner: TicketClaimOwnerEvidence;
  terminal: FactoryStateClaimTerminalProof;
  prepared_receipt_id?: string;
}

export interface FactoryStateMutationReceiptInput {
  action: FactoryStateMutationAction;
  binding: FactoryStateMutationCycleBinding;
  target_path: string;
  target_schema: FactoryStateMutationTargetSchema;
  before_payload: string;
  after_payload: string;
  allowed_transitions: string[];
  recorded_at: string;
  claim_release?: FactoryStateClaimReleaseEvidence;
}

interface FactoryStateMutationReceiptUnsigned {
  schema_version: typeof FACTORY_STATE_MUTATION_EVIDENCE_VERSION;
  action: FactoryStateMutationAction;
  scope: FactoryStateMutationScope;
  cycle_id: string;
  producer_id: string;
  target_path: string;
  target_schema: FactoryStateMutationTargetSchema;
  before_sha256: string;
  after_sha256: string;
  before_payload: string;
  after_payload: string;
  allowed_transitions: string[];
  observed_transitions: string[];
  recorded_at: string;
  binding: FactoryStateMutationCycleBinding;
  claim_release?: FactoryStateClaimReleaseEvidence;
}

export interface FactoryStateMutationReceipt extends FactoryStateMutationReceiptUnsigned {
  receipt_id: string;
  content_hash: string;
}

export interface WriteFactoryStateMutationReceiptOptions {
  stateDir: string;
}

export interface ResolveFactoryStateMutationCycleOptions {
  producerId: string;
  requestedCycleId?: string | null;
  sentinelPath?: string;
  laneLogPath?: string;
  pendingSentinelReplacement?: { beforePayload: string; afterPayload: string };
}

export interface RecordFactoryStateAtomicReplacementOptions extends ResolveFactoryStateMutationCycleOptions {
  mode?: FactoryStateMutationEvidenceMode;
  stateDir: string;
  targetPath: string;
  targetSchema: Exclude<FactoryStateMutationTargetSchema, "ticket-claim-owner/v1">;
  beforePayload: string;
  afterPayload: string;
  recordedAt?: string;
}

export interface FactoryStateAtomicReplacementEvidenceResult {
  mode: FactoryStateMutationEvidenceMode;
  binding: FactoryStateMutationCycleBinding | null;
  receipt: FactoryStateMutationReceipt | null;
  receipt_path: string | null;
  would_reject: boolean;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function factoryStateMutationPayloadSha256(value: string): string {
  return sha256Text(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("mutation evidence contains a non-JSON value");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new TypeError("mutation evidence contains a non-JSON value");
}

function assertIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}

function assertTransition(value: string): void {
  if (!/^(?:\$[A-Za-z0-9._:-]+|\/(?:[^~/]|~[01])*(?:\/(?:[^~/]|~[01])*)*)$/.test(value)) {
    throw new Error(`allowed transition is invalid: ${value}`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a SHA-256 digest`);
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO-8601 timestamp`);
}

function assertExactPath(path: string, field: string): void {
  if (!path || path.includes("\0") || /[*?\[\]{}!]/.test(path)) throw new Error(`${field} must be exact`);
  if (normalize(path) !== path || path.endsWith("/")) throw new Error(`${field} must be normalized`);
}

function assertBoundedPayload(payload: string, field: string): void {
  if (Buffer.byteLength(payload) > FACTORY_STATE_MUTATION_PAYLOAD_MAX_BYTES) {
    throw new Error(`${field} exceeds ${FACTORY_STATE_MUTATION_PAYLOAD_MAX_BYTES} bytes`);
  }
}

function parseJsonObject(payload: string, schema: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`${schema} payload is not JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${schema} payload must be an object`);
  return parsed;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], schema: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${schema} payload contains unknown keys: ${extra.sort().join(",")}`);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
}

function assertNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
}

function assertNullableString(value: unknown, field: string): void {
  if (value !== null && typeof value !== "string") throw new Error(`${field} must be a string or null`);
}

function assertNullableNumber(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${field} must be a finite number or null`);
  }
}

function parseLaneCycle(payload: string): string {
  if (!payload.endsWith("\n") || payload.slice(0, -1).includes("\n") || payload.includes("\r")) {
    throw new Error("lane-current-cycle/v1 must contain one normalized line");
  }
  const cycleId = payload.slice(0, -1);
  assertIdentifier(cycleId, "lane cycle_id");
  return cycleId;
}

export function readFactoryStateMutationCycleId(path: string): string | null {
  try {
    return parseLaneCycle(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseProductGate(payload: string): Record<string, unknown> {
  const state = parseJsonObject(payload, "product-gate/v1");
  assertExactKeys(state, ["schema_version", "ticket_id", "identifier", "preflight", "launch", "updated_at"], "product-gate/v1");
  if (state.schema_version !== 1) throw new Error("product-gate/v1 schema_version must remain 1");
  assertString(state.ticket_id, "product-gate/v1 ticket_id");
  assertString(state.identifier, "product-gate/v1 identifier");
  assertObject(state.preflight, "product-gate/v1 preflight");
  assertExactKeys(
    state.preflight,
    ["phase", "mode", "applicability", "decision", "acted", "reason_code", "archetype", "evidence", "comment_posted", "evaluated_at"],
    "product-gate/v1 preflight",
  );
  if (state.preflight.phase !== "pre_dispatch") throw new Error("product-gate/v1 preflight phase is invalid");
  if (!(["off", "shadow", "enforce"] as unknown[]).includes(state.preflight.mode)) throw new Error("product-gate/v1 preflight mode is invalid");
  if (!(["required", "not_applicable"] as unknown[]).includes(state.preflight.applicability)) throw new Error("product-gate/v1 applicability is invalid");
  if (!(["off", "pass", "hold", "not_applicable"] as unknown[]).includes(state.preflight.decision)) throw new Error("product-gate/v1 preflight decision is invalid");
  assertBoolean(state.preflight.acted, "product-gate/v1 preflight acted");
  assertString(state.preflight.reason_code, "product-gate/v1 preflight reason_code");
  assertString(state.preflight.archetype, "product-gate/v1 preflight archetype");
  assertBoolean(state.preflight.comment_posted, "product-gate/v1 preflight comment_posted");
  assertString(state.preflight.evaluated_at, "product-gate/v1 preflight evaluated_at");
  assertIsoTimestamp(state.preflight.evaluated_at, "product-gate/v1 preflight evaluated_at");
  assertObject(state.preflight.evidence, "product-gate/v1 preflight evidence");
  assertExactKeys(
    state.preflight.evidence,
    ["repo_path", "path", "source", "sha256", "valid", "reason", "ticket_source_hash"],
    "product-gate/v1 preflight evidence",
  );
  assertNullableString(state.preflight.evidence.repo_path, "product-gate/v1 evidence repo_path");
  assertNullableString(state.preflight.evidence.path, "product-gate/v1 evidence path");
  if (!(["explicit", "root", "agents-context", "docs", "none"] as unknown[]).includes(state.preflight.evidence.source)) {
    throw new Error("product-gate/v1 evidence source is invalid");
  }
  assertNullableString(state.preflight.evidence.sha256, "product-gate/v1 evidence sha256");
  assertBoolean(state.preflight.evidence.valid, "product-gate/v1 evidence valid");
  assertString(state.preflight.evidence.reason, "product-gate/v1 evidence reason");
  assertString(state.preflight.evidence.ticket_source_hash, "product-gate/v1 evidence ticket_source_hash");
  if (state.launch !== undefined) {
    assertObject(state.launch, "product-gate/v1 launch");
    assertExactKeys(
      state.launch,
      ["phase", "mode", "applicability", "decision", "acted", "reason_code", "verdict", "report_path", "report_sha256", "context_sha256", "audit_exit_code", "audit_error", "evaluated_at"],
      "product-gate/v1 launch",
    );
    if (state.launch.phase !== "post_verification") throw new Error("product-gate/v1 launch phase is invalid");
    if (!(["off", "shadow", "enforce"] as unknown[]).includes(state.launch.mode)) throw new Error("product-gate/v1 launch mode is invalid");
    if (!(["required", "not_applicable"] as unknown[]).includes(state.launch.applicability)) throw new Error("product-gate/v1 launch applicability is invalid");
    if (!(["off", "pass", "hold", "not_applicable"] as unknown[]).includes(state.launch.decision)) throw new Error("product-gate/v1 launch decision is invalid");
    assertBoolean(state.launch.acted, "product-gate/v1 launch acted");
    assertString(state.launch.reason_code, "product-gate/v1 launch reason_code");
    assertNullableString(state.launch.verdict, "product-gate/v1 launch verdict");
    assertNullableString(state.launch.report_path, "product-gate/v1 launch report_path");
    assertNullableString(state.launch.report_sha256, "product-gate/v1 launch report_sha256");
    assertNullableString(state.launch.context_sha256, "product-gate/v1 launch context_sha256");
    assertNullableNumber(state.launch.audit_exit_code, "product-gate/v1 launch audit_exit_code");
    assertNullableString(state.launch.audit_error, "product-gate/v1 launch audit_error");
    assertString(state.launch.evaluated_at, "product-gate/v1 launch evaluated_at");
    assertIsoTimestamp(state.launch.evaluated_at, "product-gate/v1 launch evaluated_at");
  }
  assertString(state.updated_at, "product-gate/v1 updated_at");
  assertIsoTimestamp(state.updated_at, "product-gate/v1 updated_at");
  return state;
}

function parseSloState(payload: string): Record<string, unknown> {
  const state = parseJsonObject(payload, "slo-state/v1");
  assertExactKeys(
    state,
    ["version", "evaluated_at", "evaluations", "reviewed", "breach_meta", "transitions", "benchmark_reliability"],
    "slo-state/v1",
  );
  if (state.version !== 1) throw new Error("slo-state/v1 version must remain 1");
  assertString(state.evaluated_at, "slo-state/v1 evaluated_at");
  assertIsoTimestamp(state.evaluated_at, "slo-state/v1 evaluated_at");
  assertObject(state.evaluations, "slo-state/v1 evaluations");
  assertObject(state.reviewed, "slo-state/v1 reviewed");
  assertObject(state.breach_meta, "slo-state/v1 breach_meta");
  if (!Array.isArray(state.transitions)) throw new Error("slo-state/v1 transitions must be an array");
  const sloIds = ["cycle_time", "yield_floor", "auto_approval_error"];
  assertExactKeys(state.evaluations, sloIds, "slo-state/v1 evaluations");
  assertExactKeys(state.reviewed, sloIds, "slo-state/v1 reviewed");
  assertExactKeys(state.breach_meta, sloIds, "slo-state/v1 breach_meta");
  for (const [id, raw] of Object.entries(state.evaluations)) {
    assertObject(raw, `slo-state/v1 evaluation ${id}`);
    assertExactKeys(raw, ["id", "status", "value", "threshold", "denominator", "min_samples", "window_days"], `slo-state/v1 evaluation ${id}`);
    if (raw.id !== id) throw new Error(`slo-state/v1 evaluation ${id} identity mismatch`);
    if (!(["ok", "breach", "insufficient_data"] as unknown[]).includes(raw.status)) throw new Error(`slo-state/v1 evaluation ${id} status is invalid`);
    assertNullableNumber(raw.value, `slo-state/v1 evaluation ${id} value`);
    for (const field of ["threshold", "denominator", "min_samples", "window_days"] as const) {
      assertNumber(raw[field], `slo-state/v1 evaluation ${id} ${field}`);
    }
  }
  for (const [id, raw] of Object.entries(state.reviewed)) {
    assertObject(raw, `slo-state/v1 review ${id}`);
    assertExactKeys(raw, ["reviewed", "by", "at", "note"], `slo-state/v1 review ${id}`);
    assertBoolean(raw.reviewed, `slo-state/v1 review ${id} reviewed`);
    assertNullableString(raw.by, `slo-state/v1 review ${id} by`);
    assertNullableString(raw.at, `slo-state/v1 review ${id} at`);
    assertNullableString(raw.note, `slo-state/v1 review ${id} note`);
  }
  for (const [id, raw] of Object.entries(state.breach_meta)) {
    assertObject(raw, `slo-state/v1 breach_meta ${id}`);
    assertExactKeys(raw, ["started_at", "value_at_breach", "denominator_at_breach"], `slo-state/v1 breach_meta ${id}`);
    assertString(raw.started_at, `slo-state/v1 breach_meta ${id} started_at`);
    assertIsoTimestamp(raw.started_at, `slo-state/v1 breach_meta ${id} started_at`);
    assertNullableNumber(raw.value_at_breach, `slo-state/v1 breach_meta ${id} value_at_breach`);
    assertNumber(raw.denominator_at_breach, `slo-state/v1 breach_meta ${id} denominator_at_breach`);
  }
  for (const [index, raw] of state.transitions.entries()) {
    assertObject(raw, `slo-state/v1 transition ${index}`);
    assertExactKeys(raw, ["slo", "from", "to", "at", "by", "note"], `slo-state/v1 transition ${index}`);
    if (!sloIds.includes(String(raw.slo))) throw new Error(`slo-state/v1 transition ${index} slo is invalid`);
    if (raw.from !== null && !(["ok", "breach", "insufficient_data"] as unknown[]).includes(raw.from)) throw new Error(`slo-state/v1 transition ${index} from is invalid`);
    if (!(["ok", "breach", "insufficient_data"] as unknown[]).includes(raw.to)) throw new Error(`slo-state/v1 transition ${index} to is invalid`);
    assertString(raw.at, `slo-state/v1 transition ${index} at`);
    assertIsoTimestamp(raw.at, `slo-state/v1 transition ${index} at`);
    assertString(raw.by, `slo-state/v1 transition ${index} by`);
    if (typeof raw.note !== "string") throw new Error(`slo-state/v1 transition ${index} note must be a string`);
  }
  if (state.benchmark_reliability !== undefined) {
    assertObject(state.benchmark_reliability, "slo-state/v1 benchmark_reliability");
    assertExactKeys(
      state.benchmark_reliability,
      ["schema_version", "run_directory", "generated_at", "files_scanned", "files_consumed", "ignored_files", "invalid_files", "benchmarks"],
      "slo-state/v1 benchmark_reliability",
    );
    if (state.benchmark_reliability.schema_version !== 1) throw new Error("slo-state/v1 benchmark_reliability schema_version must be 1");
    assertString(state.benchmark_reliability.run_directory, "slo-state/v1 benchmark_reliability run_directory");
    assertString(state.benchmark_reliability.generated_at, "slo-state/v1 benchmark_reliability generated_at");
    assertIsoTimestamp(state.benchmark_reliability.generated_at, "slo-state/v1 benchmark_reliability generated_at");
    for (const field of ["files_scanned", "files_consumed"] as const) assertNumber(state.benchmark_reliability[field], `slo-state/v1 benchmark_reliability ${field}`);
    for (const field of ["ignored_files", "invalid_files", "benchmarks"] as const) {
      if (!Array.isArray(state.benchmark_reliability[field])) throw new Error(`slo-state/v1 benchmark_reliability ${field} must be an array`);
    }
  }
  return state;
}

export function parseTicketClaimOwnerPayload(payload: string): TicketClaimOwnerEvidence {
  const owner = parseJsonObject(payload, "ticket-claim-owner/v1");
  assertExactKeys(owner, ["schema_version", "ticket_id", "execution_id", "claimed_at", "lease_expires_at", "pid"], "ticket-claim-owner/v1");
  if (owner.schema_version !== 1) throw new Error("ticket-claim-owner/v1 schema_version must remain 1");
  assertString(owner.ticket_id, "ticket-claim-owner/v1 ticket_id");
  assertString(owner.execution_id, "ticket-claim-owner/v1 execution_id");
  assertString(owner.claimed_at, "ticket-claim-owner/v1 claimed_at");
  assertString(owner.lease_expires_at, "ticket-claim-owner/v1 lease_expires_at");
  assertIsoTimestamp(owner.claimed_at, "ticket-claim-owner/v1 claimed_at");
  assertIsoTimestamp(owner.lease_expires_at, "ticket-claim-owner/v1 lease_expires_at");
  if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) throw new Error("ticket-claim-owner/v1 pid must be a positive integer");
  return owner as unknown as TicketClaimOwnerEvidence;
}

function jsonPointerToken(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function collectJsonDifferences(before: unknown, after: unknown, path: string, changes: Set<string>): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      collectJsonDifferences(before[index], after[index], `${path}/${index}`, changes);
    }
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      collectJsonDifferences(before[key], after[key], `${path}/${jsonPointerToken(key)}`, changes);
    }
    return;
  }
  changes.add(path || "/");
}

export function deriveFactoryStateMutationTransitions(
  schema: FactoryStateMutationTargetSchema,
  beforePayload: string,
  afterPayload: string,
): string[] {
  assertBoundedPayload(beforePayload, "before_payload");
  assertBoundedPayload(afterPayload, "after_payload");
  if (schema === "lane-current-cycle/v1") {
    const before = parseLaneCycle(beforePayload);
    const after = parseLaneCycle(afterPayload);
    return before === after ? [] : ["$cycle_id"];
  }
  if (schema === "ticket-claim-owner/v1") {
    const before = parseTicketClaimOwnerPayload(beforePayload);
    if (afterPayload !== "") throw new Error("ticket claim release after_payload must be empty");
    return Object.keys(before).length > 0 ? ["$claim_removed"] : [];
  }
  const before = schema === "product-gate/v1" ? parseProductGate(beforePayload) : parseSloState(beforePayload);
  const after = schema === "product-gate/v1" ? parseProductGate(afterPayload) : parseSloState(afterPayload);
  if (schema === "product-gate/v1") {
    for (const key of ["schema_version", "ticket_id", "identifier"] as const) {
      if (before[key] !== after[key]) throw new Error(`product-gate/v1 invariant changed: ${key}`);
    }
  }
  const changes = new Set<string>();
  collectJsonDifferences(before, after, "", changes);
  return [...changes].sort();
}

function parseLaneRows(path: string, cycleId: string): { opens: number; outcomes: number } {
  let opens = 0;
  let outcomes = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error("lane utilization log contains invalid JSON");
    }
    if (!isRecord(row) || row.cycle_id !== cycleId) continue;
    if (row.phase === "open") opens += 1;
    if (row.phase === "outcome") outcomes += 1;
  }
  return { opens, outcomes };
}

export function resolveFactoryStateMutationCycle(
  options: ResolveFactoryStateMutationCycleOptions,
): FactoryStateMutationCycleBinding {
  assertIdentifier(options.producerId, "producer_id");
  const requested = options.requestedCycleId?.trim() || null;
  const background = (reason: string): FactoryStateMutationCycleBinding => ({
    scope: "background",
    cycle_id: `background:${options.producerId}`,
    requested_cycle_id: requested,
    producer_id: options.producerId,
    sentinel_path: options.sentinelPath ?? null,
    lane_log_path: options.laneLogPath ?? null,
    reason,
  });
  if (!requested) return background("no explicit cycle_id");
  assertIdentifier(requested, "requested cycle_id");
  if (!options.sentinelPath || !options.laneLogPath) return background("scheduled-cycle evidence paths are missing");
  try {
    const current = parseLaneCycle(readFileSync(options.sentinelPath, "utf8"));
    if (current !== requested) {
      const pending = options.pendingSentinelReplacement;
      if (
        !pending ||
        parseLaneCycle(pending.beforePayload) !== current ||
        parseLaneCycle(pending.afterPayload) !== requested
      ) return background("cycle_id does not match current-cycle sentinel");
    }
    const rows = parseLaneRows(options.laneLogPath, requested);
    if (rows.opens !== 1 || rows.outcomes !== 0) {
      return background(`cycle_id requires exactly one unmatched open row; found opens=${rows.opens}, outcomes=${rows.outcomes}`);
    }
  } catch (error) {
    return background(error instanceof Error ? error.message : String(error));
  }
  return {
    scope: "scheduled-cycle",
    cycle_id: requested,
    requested_cycle_id: requested,
    producer_id: options.producerId,
    sentinel_path: options.sentinelPath,
    lane_log_path: options.laneLogPath,
    reason: null,
  };
}

export function assertFactoryStateMutationMayProceed(
  mode: FactoryStateMutationEvidenceMode,
  binding: FactoryStateMutationCycleBinding,
): void {
  if (!(["off", "shadow", "enforce"] as string[]).includes(mode)) throw new Error("mutation evidence mode is invalid");
  if (mode === "enforce" && binding.scope !== "scheduled-cycle") {
    throw new Error(`scheduled mutation is unbound: ${binding.reason ?? "unknown reason"}`);
  }
}

export function factoryStateMutationEvidenceMode(
  env: Record<string, string | undefined> = process.env,
): FactoryStateMutationEvidenceMode {
  const value = env.FACTORY_STATE_MUTATION_EVIDENCE?.trim() || "off";
  if (!(["off", "shadow", "enforce"] as string[]).includes(value)) {
    throw new Error("FACTORY_STATE_MUTATION_EVIDENCE must be off, shadow, or enforce");
  }
  return value as FactoryStateMutationEvidenceMode;
}

export function recordFactoryStateAtomicReplacement(
  options: RecordFactoryStateAtomicReplacementOptions,
): FactoryStateAtomicReplacementEvidenceResult {
  const mode = options.mode ?? factoryStateMutationEvidenceMode();
  if (mode === "off") {
    return { mode, binding: null, receipt: null, receipt_path: null, would_reject: false, reason: null };
  }
  const binding = resolveFactoryStateMutationCycle(options);
  const wouldReject = binding.requested_cycle_id !== null && binding.scope !== "scheduled-cycle";
  try {
    assertFactoryStateMutationMayProceed(mode, binding);
    const transitions = deriveFactoryStateMutationTransitions(options.targetSchema, options.beforePayload, options.afterPayload);
    if (transitions.length === 0) throw new Error("atomic replacement did not change the typed payload");
    const receipt = createFactoryStateMutationReceipt({
      action: "atomic-replace",
      binding,
      target_path: options.targetPath,
      target_schema: options.targetSchema,
      before_payload: options.beforePayload,
      after_payload: options.afterPayload,
      allowed_transitions: transitions,
      recorded_at: options.recordedAt ?? new Date().toISOString(),
    });
    const receiptPath = writeFactoryStateMutationReceipt(receipt, { stateDir: options.stateDir });
    return {
      mode,
      binding,
      receipt,
      receipt_path: receiptPath,
      would_reject: wouldReject,
      reason: binding.reason,
    };
  } catch (error) {
    if (mode === "enforce") throw error;
    return {
      mode,
      binding,
      receipt: null,
      receipt_path: null,
      would_reject: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function validateFactoryStateClaimTerminalProof(
  owner: TicketClaimOwnerEvidence,
  executionRecordPath: string,
): FactoryStateClaimTerminalProof {
  if (!isAbsolute(executionRecordPath)) throw new Error("execution record path must be absolute");
  const payload = readFileSync(executionRecordPath, "utf8");
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  if (parsed.execution_id !== owner.execution_id || parsed.ticket_id !== owner.ticket_id) {
    throw new Error("terminal execution record identity does not match claim owner");
  }
  const lifecycle = normalizeExecutionLifecycle(parsed);
  if (!isTerminalExecution(lifecycle)) throw new Error("execution record lifecycle is not terminal");
  return {
    execution_record_path: executionRecordPath,
    execution_record_sha256: sha256Text(payload),
    ticket_id: owner.ticket_id,
    execution_id: owner.execution_id,
    lifecycle_state: lifecycle.state,
  };
}

function validateClaimRelease(receipt: FactoryStateMutationReceiptUnsigned): void {
  const proof = receipt.claim_release;
  if (receipt.action !== "claim-release") {
    if (proof !== undefined) throw new Error("atomic replacement cannot include claim_release evidence");
    return;
  }
  if (!proof) throw new Error("claim release evidence is required");
  if (receipt.target_schema !== "ticket-claim-owner/v1") throw new Error("claim release target schema is invalid");
  assertIdentifier(proof.claim_key, "claim_key");
  assertExactPath(proof.claim_directory_path, "claim_directory_path");
  assertExactPath(proof.owner_path, "owner_path");
  if (basename(proof.claim_directory_path) !== proof.claim_key) throw new Error("claim directory does not match claim_key");
  if (proof.owner_path !== join(proof.claim_directory_path, "owner.json")) throw new Error("claim owner path is not exact");
  if (receipt.target_path !== proof.claim_directory_path) throw new Error("claim release target path mismatch");
  assertSha256(proof.owner_sha256, "owner_sha256");
  if (proof.owner_sha256 !== receipt.before_sha256) throw new Error("claim owner hash does not match before payload");
  const parsedOwner = parseTicketClaimOwnerPayload(receipt.before_payload);
  if (canonicalJson(parsedOwner) !== canonicalJson(proof.owner)) throw new Error("claim owner evidence does not match before payload");
  if (proof.terminal.ticket_id !== proof.owner.ticket_id || proof.terminal.execution_id !== proof.owner.execution_id) {
    throw new Error("terminal proof identity does not match claim owner");
  }
  assertSha256(proof.terminal.execution_record_sha256, "terminal execution record SHA-256");
  if (!isAbsolute(proof.terminal.execution_record_path)) throw new Error("terminal execution record path must be absolute");
  if (proof.stage === "committed") {
    if (!proof.prepared_receipt_id) throw new Error("committed claim release requires prepared_receipt_id");
    assertIdentifier(proof.prepared_receipt_id, "prepared_receipt_id");
  } else if (proof.prepared_receipt_id !== undefined) {
    throw new Error("prepared claim release cannot reference another prepared receipt");
  }
}

function unsignedReceipt(input: FactoryStateMutationReceiptInput): FactoryStateMutationReceiptUnsigned {
  assertExactPath(input.target_path, "target_path");
  assertIsoTimestamp(input.recorded_at, "recorded_at");
  assertBoundedPayload(input.before_payload, "before_payload");
  assertBoundedPayload(input.after_payload, "after_payload");
  const allowed = [...new Set(input.allowed_transitions)].sort();
  if (allowed.length === 0) throw new Error("allowed_transitions must not be empty");
  for (const transition of allowed) assertTransition(transition);
  const observed = deriveFactoryStateMutationTransitions(input.target_schema, input.before_payload, input.after_payload);
  if (observed.some((transition) => !allowed.includes(transition))) {
    throw new Error(`observed transition is not allowed: ${observed.filter((transition) => !allowed.includes(transition)).join(",")}`);
  }
  const receipt: FactoryStateMutationReceiptUnsigned = {
    schema_version: FACTORY_STATE_MUTATION_EVIDENCE_VERSION,
    action: input.action,
    scope: input.binding.scope,
    cycle_id: input.binding.cycle_id,
    producer_id: input.binding.producer_id,
    target_path: input.target_path,
    target_schema: input.target_schema,
    before_sha256: sha256Text(input.before_payload),
    after_sha256: sha256Text(input.after_payload),
    before_payload: input.before_payload,
    after_payload: input.after_payload,
    allowed_transitions: allowed,
    observed_transitions: observed,
    recorded_at: input.recorded_at,
    binding: input.binding,
    ...(input.claim_release ? { claim_release: input.claim_release } : {}),
  };
  validateClaimRelease(receipt);
  return receipt;
}

export function createFactoryStateMutationReceipt(input: FactoryStateMutationReceiptInput): FactoryStateMutationReceipt {
  const unsigned = unsignedReceipt(input);
  const digest = sha256Text(canonicalJson(unsigned));
  return {
    ...unsigned,
    receipt_id: `mutation:${digest}`,
    content_hash: digest,
  };
}

export function serializeFactoryStateMutationReceipt(receipt: FactoryStateMutationReceipt): string {
  const errors = validateFactoryStateMutationReceipt(receipt);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const serialized = `${canonicalJson(receipt)}\n`;
  if (Buffer.byteLength(serialized) > FACTORY_STATE_MUTATION_RECEIPT_MAX_BYTES) {
    throw new Error(`mutation receipt exceeds ${FACTORY_STATE_MUTATION_RECEIPT_MAX_BYTES} bytes`);
  }
  return serialized;
}

export function validateFactoryStateMutationReceipt(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["mutation receipt must be an object"];
  const receipt = value as unknown as FactoryStateMutationReceipt;
  try {
    if (receipt.schema_version !== 1) throw new Error("schema_version must be 1");
    if (!(["atomic-replace", "claim-release"] as string[]).includes(receipt.action)) throw new Error("action is invalid");
    if (!(["scheduled-cycle", "background"] as string[]).includes(receipt.scope)) throw new Error("scope is invalid");
    assertIdentifier(receipt.cycle_id, "cycle_id");
    assertIdentifier(receipt.producer_id, "producer_id");
    assertExactPath(receipt.target_path, "target_path");
    assertSha256(receipt.before_sha256, "before_sha256");
    assertSha256(receipt.after_sha256, "after_sha256");
    assertSha256(receipt.content_hash, "content_hash");
    assertIdentifier(receipt.receipt_id, "receipt_id");
    assertIsoTimestamp(receipt.recorded_at, "recorded_at");
    assertBoundedPayload(receipt.before_payload, "before_payload");
    assertBoundedPayload(receipt.after_payload, "after_payload");
    if (receipt.before_sha256 !== sha256Text(receipt.before_payload)) throw new Error("before_sha256 mismatch");
    if (receipt.after_sha256 !== sha256Text(receipt.after_payload)) throw new Error("after_sha256 mismatch");
    const observed = deriveFactoryStateMutationTransitions(receipt.target_schema, receipt.before_payload, receipt.after_payload);
    if (canonicalJson(observed) !== canonicalJson(receipt.observed_transitions)) throw new Error("observed_transitions mismatch");
    if (observed.some((transition) => !receipt.allowed_transitions.includes(transition))) throw new Error("observed transition is not allowed");
    if (receipt.scope !== receipt.binding.scope || receipt.cycle_id !== receipt.binding.cycle_id || receipt.producer_id !== receipt.binding.producer_id) {
      throw new Error("cycle binding mismatch");
    }
    validateClaimRelease(receipt);
    const { receipt_id: _receiptId, content_hash: _contentHash, ...unsigned } = receipt;
    const digest = sha256Text(canonicalJson(unsigned));
    if (receipt.content_hash !== digest || receipt.receipt_id !== `mutation:${digest}`) throw new Error("content-address mismatch");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function mutationReceiptPath(stateDir: string, receipt: FactoryStateMutationReceipt): string {
  const root = resolve(stateDir, FACTORY_STATE_MUTATION_EVIDENCE_ROOT);
  const candidate = join(root, `${receipt.content_hash}.json`);
  if (relative(root, candidate).startsWith("..")) throw new Error("mutation receipt path escapes evidence root");
  return candidate;
}

export function writeFactoryStateMutationReceipt(
  receipt: FactoryStateMutationReceipt,
  options: WriteFactoryStateMutationReceiptOptions,
): string {
  const serialized = serializeFactoryStateMutationReceipt(receipt);
  const root = resolve(options.stateDir, FACTORY_STATE_MUTATION_EVIDENCE_ROOT);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error("mutation evidence root must be a real 0700 directory");
  }
  const path = mutationReceiptPath(options.stateDir, receipt);
  if (existsSync(path)) {
    const receiptStat = lstatSync(path);
    if (
      readFileSync(path, "utf8") === serialized &&
      receiptStat.isFile() &&
      !receiptStat.isSymbolicLink() &&
      (receiptStat.mode & 0o777) === 0o600
    ) return path;
    throw new Error(`refusing to replace write-once mutation receipt: ${path}`);
  }
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, serialized, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(root);
  return path;
}

export function readFactoryStateMutationReceipt(path: string): FactoryStateMutationReceipt {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const errors = validateFactoryStateMutationReceipt(parsed);
  if (errors.length > 0) throw new Error(`invalid mutation receipt: ${errors.join("; ")}`);
  return parsed as FactoryStateMutationReceipt;
}
