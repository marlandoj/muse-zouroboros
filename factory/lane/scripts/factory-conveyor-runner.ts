#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";

export const CONVEYOR_RUNNER_SCHEMA_VERSION = 1 as const;
export const CONVEYOR_RUNNER_VERSION = "zsf-conveyor-runner/v1" as const;
export const CONVEYOR_RUNNER_MODES = ["off", "shadow", "enforce"] as const;
export const CONVEYOR_PHASES = [
  "preflight",
  "recovery",
  "capacity_guard",
  "serial_promotion",
  "signal_intake",
  "prespec",
  "pull",
  "contract",
  "open_execution_guard",
  "dispatch",
  "execute",
  "validate",
  "housekeeping",
  "pool_reconcile",
  "collect",
  "cleanup",
  "report",
] as const;
export const PHASE_EVENTS = ["started", "succeeded", "skipped", "failed", "held"] as const;

export type ConveyorRunnerMode = typeof CONVEYOR_RUNNER_MODES[number];
export type ConveyorPhase = typeof CONVEYOR_PHASES[number];
export type PhaseEvent = typeof PHASE_EVENTS[number];
export type CycleStatus = "ready" | "running" | "failed" | "held" | "complete";

export interface ConveyorCycleIdentity {
  schema_version: typeof CONVEYOR_RUNNER_SCHEMA_VERSION;
  runner_version: typeof CONVEYOR_RUNNER_VERSION;
  cycle_id: string;
  idempotency_key: string;
  idempotency_hash: string;
  mode: Exclude<ConveyorRunnerMode, "off">;
  created_at: string;
  plan_hash: string;
}

export interface ConveyorPhaseReceipt {
  schema_version: typeof CONVEYOR_RUNNER_SCHEMA_VERSION;
  runner_version: typeof CONVEYOR_RUNNER_VERSION;
  cycle_id: string;
  sequence: number;
  phase: ConveyorPhase;
  phase_index: number;
  attempt: number;
  event: PhaseEvent;
  transition_key: string;
  at: string;
  input_hash: string | null;
  output_hash: string | null;
  reason: string | null;
  error: string | null;
  previous_hash: string;
  record_hash: string;
}

export interface ConveyorCycleSnapshot {
  identity: ConveyorCycleIdentity;
  receipts: ConveyorPhaseReceipt[];
  status: CycleStatus;
  next_phase: ConveyorPhase | null;
  open_phase: ConveyorPhase | null;
  terminal_receipt: ConveyorPhaseReceipt | null;
}

export interface CreateCycleInput {
  cycleId: string;
  idempotencyKey: string;
  mode: Exclude<ConveyorRunnerMode, "off">;
  stateDir?: string;
  createdAt?: string;
}

export interface RecordPhaseInput {
  cycleId: string;
  phase: ConveyorPhase;
  event: PhaseEvent;
  stateDir?: string;
  transitionKey?: string;
  at?: string;
  inputHash?: string | null;
  outputHash?: string | null;
  reason?: string | null;
  error?: string | null;
  staleLockMs?: number;
}

export class ConveyorRunnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConveyorRunnerError";
  }
}

const CYCLE_ID = /^cyc-[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const ZERO_HASH = "0".repeat(64);
const DEFAULT_STALE_LOCK_MS = 2 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertIso(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new ConveyorRunnerError("invalid_timestamp", `${field} must be an RFC 3339 timestamp`);
  }
}

function assertHash(value: string | null | undefined, field: string, nullable = false): void {
  if (nullable && value === null) return;
  if (!value || !HASH.test(value)) {
    throw new ConveyorRunnerError("invalid_hash", `${field} must be a lowercase SHA-256 digest`);
  }
}

function assertCycleId(value: string): void {
  if (!CYCLE_ID.test(value)) {
    throw new ConveyorRunnerError("invalid_cycle_id", "cycle_id must use the cyc- namespace and path-safe characters");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function conveyorPlanHash(): string {
  return sha256(canonicalJson({
    runner_version: CONVEYOR_RUNNER_VERSION,
    schema_version: CONVEYOR_RUNNER_SCHEMA_VERSION,
    phases: CONVEYOR_PHASES,
  }));
}

function runnerRoot(explicit?: string): string {
  if (explicit) return resolveFactoryStateOverride(explicit);
  return join(factoryStateRoot(), "conveyor-runner");
}

function cycleDir(root: string, cycleId: string): string {
  assertCycleId(cycleId);
  return join(root, "cycles", cycleId);
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConveyorRunnerError("invalid_json", `invalid JSON at ${path}: ${String(error)}`);
  }
}

function writeTempFile(path: string, body: string): string {
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

function writeImmutable(path: string, value: unknown): "created" | "existing" {
  mkdirSync(join(path, ".."), { recursive: true });
  const body = `${canonicalJson(value)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === body) return "existing";
    throw new ConveyorRunnerError("immutable_conflict", `immutable record already exists with different content: ${path}`);
  }

  const temp = writeTempFile(path, body);
  try {
    linkSync(temp, path);
    return "created";
  } catch (error) {
    if (existsSync(path) && readFileSync(path, "utf8") === body) return "existing";
    throw new ConveyorRunnerError("immutable_write_failed", `failed to create immutable record ${path}: ${String(error)}`);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function writeLockOwner(lockDir: string): void {
  writeFileSync(join(lockDir, "owner.json"), `${canonicalJson({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function acquireCycleLock(directory: string, staleLockMs: number): () => void {
  const lockDir = join(directory, ".lock");
  mkdirSync(directory, { recursive: true });
  try {
    mkdirSync(lockDir);
    writeLockOwner(lockDir);
  } catch (error) {
    if (!existsSync(lockDir)) {
      throw new ConveyorRunnerError("lock_failed", `failed to acquire cycle lock: ${String(error)}`);
    }
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age <= staleLockMs) {
      throw new ConveyorRunnerError("cycle_locked", `cycle lock is active (${Math.round(age)}ms old)`);
    }
    const preserved = `${lockDir}.stale.${Math.floor(statSync(lockDir).mtimeMs)}.${process.pid}`;
    try {
      renameSync(lockDir, preserved);
      mkdirSync(lockDir);
      writeLockOwner(lockDir);
    } catch (recoveryError) {
      throw new ConveyorRunnerError("stale_lock_recovery_failed", `failed to preserve and replace stale cycle lock: ${String(recoveryError)}`);
    }
  }

  return () => {
    rmSync(lockDir, { recursive: true, force: true });
  };
}

function parseIdentity(value: unknown): ConveyorCycleIdentity {
  if (!isObject(value)) throw new ConveyorRunnerError("identity_invalid", "cycle identity must be an object");
  const identity = value as unknown as ConveyorCycleIdentity;
  if (identity.schema_version !== CONVEYOR_RUNNER_SCHEMA_VERSION) {
    throw new ConveyorRunnerError("schema_incompatible", `unsupported cycle schema ${String(identity.schema_version)}`);
  }
  if (identity.runner_version !== CONVEYOR_RUNNER_VERSION) {
    throw new ConveyorRunnerError("runner_incompatible", `unsupported runner version ${String(identity.runner_version)}`);
  }
  assertCycleId(identity.cycle_id);
  if (!identity.idempotency_key) throw new ConveyorRunnerError("identity_invalid", "idempotency_key is required");
  assertHash(identity.idempotency_hash, "idempotency_hash");
  if (identity.idempotency_hash !== sha256(identity.idempotency_key)) {
    throw new ConveyorRunnerError("idempotency_mismatch", "idempotency hash does not match the cycle identity");
  }
  if (identity.mode !== "shadow" && identity.mode !== "enforce") {
    throw new ConveyorRunnerError("identity_invalid", "cycle mode must be shadow or enforce");
  }
  assertIso(identity.created_at, "created_at");
  if (identity.plan_hash !== conveyorPlanHash()) {
    throw new ConveyorRunnerError("plan_incompatible", "cycle plan does not match this runner version");
  }
  return identity;
}

function receiptHash(receipt: Omit<ConveyorPhaseReceipt, "record_hash">): string {
  return sha256(canonicalJson(receipt));
}

function parseReceipt(value: unknown): ConveyorPhaseReceipt {
  if (!isObject(value)) throw new ConveyorRunnerError("receipt_invalid", "phase receipt must be an object");
  const receipt = value as unknown as ConveyorPhaseReceipt;
  if (receipt.schema_version !== CONVEYOR_RUNNER_SCHEMA_VERSION) {
    throw new ConveyorRunnerError("schema_incompatible", `unsupported receipt schema ${String(receipt.schema_version)}`);
  }
  if (receipt.runner_version !== CONVEYOR_RUNNER_VERSION) {
    throw new ConveyorRunnerError("runner_incompatible", `unsupported receipt runner ${String(receipt.runner_version)}`);
  }
  assertCycleId(receipt.cycle_id);
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    throw new ConveyorRunnerError("receipt_invalid", "receipt sequence must be a positive integer");
  }
  if (!CONVEYOR_PHASES.includes(receipt.phase)) throw new ConveyorRunnerError("receipt_invalid", "unknown conveyor phase");
  if (receipt.phase_index !== CONVEYOR_PHASES.indexOf(receipt.phase)) {
    throw new ConveyorRunnerError("receipt_invalid", "phase index does not match phase");
  }
  if (!Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1) {
    throw new ConveyorRunnerError("receipt_invalid", "phase attempt must be a positive integer");
  }
  if (!PHASE_EVENTS.includes(receipt.event)) throw new ConveyorRunnerError("receipt_invalid", "unknown phase event");
  if (!receipt.transition_key) throw new ConveyorRunnerError("receipt_invalid", "transition_key is required");
  assertIso(receipt.at, "receipt.at");
  assertHash(receipt.input_hash, "input_hash", true);
  assertHash(receipt.output_hash, "output_hash", true);
  assertHash(receipt.previous_hash, "previous_hash");
  assertHash(receipt.record_hash, "record_hash");
  const { record_hash, ...unsigned } = receipt;
  if (record_hash !== receiptHash(unsigned)) {
    throw new ConveyorRunnerError("receipt_hash_mismatch", `receipt ${receipt.sequence} hash mismatch`);
  }
  return receipt;
}

function loadReceipts(directory: string, identity: ConveyorCycleIdentity): ConveyorPhaseReceipt[] {
  const receiptsDir = join(directory, "receipts");
  if (!existsSync(receiptsDir)) return [];
  const receipts = readdirSync(receiptsDir)
    .filter((name) => /^\d{6}-[a-z_]+-[a-z]+\.json$/.test(name))
    .map((name) => parseReceipt(parseJsonFile(join(receiptsDir, name))))
    .sort((a, b) => a.sequence - b.sequence);

  let previousHash = ZERO_HASH;
  let open: ConveyorPhaseReceipt | null = null;
  let completedPhaseIndex = -1;
  let terminal = false;
  const transitionKeys = new Map<string, string>();

  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    if (receipt.cycle_id !== identity.cycle_id) throw new ConveyorRunnerError("cycle_mismatch", "receipt belongs to another cycle");
    if (receipt.sequence !== index + 1) throw new ConveyorRunnerError("sequence_gap", "phase receipt sequence is not contiguous");
    if (receipt.previous_hash !== previousHash) throw new ConveyorRunnerError("chain_mismatch", "phase receipt hash chain is invalid");
    if (terminal) throw new ConveyorRunnerError("transition_after_terminal", "phase receipt appears after a terminal cycle event");
    const priorHash = transitionKeys.get(receipt.transition_key);
    if (priorHash && priorHash !== receipt.record_hash) {
      throw new ConveyorRunnerError("transition_key_conflict", "transition_key is reused with different content");
    }
    transitionKeys.set(receipt.transition_key, receipt.record_hash);

    if (receipt.event === "started") {
      if (open) throw new ConveyorRunnerError("phase_overlap", "a phase started before the previous phase terminated");
      if (receipt.phase_index !== completedPhaseIndex + 1) {
        throw new ConveyorRunnerError("phase_order", "phase start does not match the next planned phase");
      }
      open = receipt;
    } else {
      if (!open || open.phase !== receipt.phase || open.attempt !== receipt.attempt) {
        throw new ConveyorRunnerError("phase_transition", "terminal phase event lacks its matching start event");
      }
      open = null;
      if (receipt.event === "succeeded" || receipt.event === "skipped") completedPhaseIndex = receipt.phase_index;
      else terminal = true;
    }
    previousHash = receipt.record_hash;
  }
  return receipts;
}

function snapshot(identity: ConveyorCycleIdentity, receipts: ConveyorPhaseReceipt[]): ConveyorCycleSnapshot {
  const last = receipts.at(-1) ?? null;
  const started = [...receipts].reverse().find((receipt) => receipt.event === "started") ?? null;
  const terminated = started
    ? receipts.some((receipt) => receipt.phase === started.phase && receipt.attempt === started.attempt && receipt.event !== "started")
    : true;
  const open = started && !terminated ? started : null;
  const terminal = last && (last.event === "failed" || last.event === "held") ? last : null;
  const completed = last !== null
    && last.phase === CONVEYOR_PHASES.at(-1)
    && (last.event === "succeeded" || last.event === "skipped");
  const completedPhaseIndex = [...receipts].reverse().find(
    (receipt) => receipt.event === "succeeded" || receipt.event === "skipped",
  )?.phase_index ?? -1;
  const status: CycleStatus = terminal?.event === "failed"
    ? "failed"
    : terminal?.event === "held"
      ? "held"
      : completed
        ? "complete"
        : open
          ? "running"
          : "ready";
  return {
    identity,
    receipts,
    status,
    next_phase: status === "ready" ? CONVEYOR_PHASES[completedPhaseIndex + 1] ?? null : null,
    open_phase: open?.phase ?? null,
    terminal_receipt: terminal,
  };
}

export function createCycle(input: CreateCycleInput): ConveyorCycleSnapshot {
  assertCycleId(input.cycleId);
  if (!input.idempotencyKey.trim()) throw new ConveyorRunnerError("idempotency_required", "idempotency_key is required");
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertIso(createdAt, "created_at");
  const root = runnerRoot(input.stateDir);
  const directory = cycleDir(root, input.cycleId);
  const identity: ConveyorCycleIdentity = {
    schema_version: CONVEYOR_RUNNER_SCHEMA_VERSION,
    runner_version: CONVEYOR_RUNNER_VERSION,
    cycle_id: input.cycleId,
    idempotency_key: input.idempotencyKey,
    idempotency_hash: sha256(input.idempotencyKey),
    mode: input.mode,
    created_at: createdAt,
    plan_hash: conveyorPlanHash(),
  };

  mkdirSync(directory, { recursive: true });
  const release = acquireCycleLock(directory, DEFAULT_STALE_LOCK_MS);
  try {
    const identityPath = join(directory, "cycle.json");
    const idempotencyPath = join(root, "idempotency", `${identity.idempotency_hash}.json`);
    if (existsSync(identityPath)) {
      const existing = parseIdentity(parseJsonFile(identityPath));
      if (existing.idempotency_key !== identity.idempotency_key || existing.mode !== identity.mode) {
        throw new ConveyorRunnerError("cycle_identity_conflict", "cycle_id is already bound to different intent");
      }
      if (existsSync(idempotencyPath)) {
        const claim = parseJsonFile(idempotencyPath);
        if (!isObject(claim) || claim.cycle_id !== existing.cycle_id || claim.idempotency_hash !== existing.idempotency_hash) {
          throw new ConveyorRunnerError("idempotency_conflict", "idempotency_key is already bound to another cycle");
        }
      } else {
        writeImmutable(idempotencyPath, {
          schema_version: CONVEYOR_RUNNER_SCHEMA_VERSION,
          idempotency_hash: existing.idempotency_hash,
          cycle_id: existing.cycle_id,
          runner_version: existing.runner_version,
        });
      }
      return snapshot(existing, loadReceipts(directory, existing));
    }

    if (existsSync(idempotencyPath)) {
      const existing = parseJsonFile(idempotencyPath);
      if (!isObject(existing) || existing.cycle_id !== identity.cycle_id) {
        throw new ConveyorRunnerError("idempotency_conflict", "idempotency_key is already bound to another cycle");
      }
    }
    writeImmutable(identityPath, identity);
    writeImmutable(idempotencyPath, {
      schema_version: CONVEYOR_RUNNER_SCHEMA_VERSION,
      idempotency_hash: identity.idempotency_hash,
      cycle_id: identity.cycle_id,
      runner_version: identity.runner_version,
    });
    return snapshot(identity, []);
  } finally {
    release();
  }
}

export function inspectCycle(cycleId: string, stateDir?: string): ConveyorCycleSnapshot {
  const root = runnerRoot(stateDir);
  const directory = cycleDir(root, cycleId);
  const identityPath = join(directory, "cycle.json");
  if (!existsSync(identityPath)) throw new ConveyorRunnerError("cycle_missing", `cycle does not exist: ${cycleId}`);
  const identity = parseIdentity(parseJsonFile(identityPath));
  return snapshot(identity, loadReceipts(directory, identity));
}

function equivalentTransition(existing: ConveyorPhaseReceipt, input: RecordPhaseInput): boolean {
  return existing.phase === input.phase
    && existing.event === input.event
    && existing.input_hash === (input.inputHash ?? null)
    && existing.output_hash === (input.outputHash ?? null)
    && existing.reason === (input.reason ?? null)
    && existing.error === (input.error ?? null);
}

export function recordPhase(input: RecordPhaseInput): ConveyorPhaseReceipt {
  const root = runnerRoot(input.stateDir);
  const directory = cycleDir(root, input.cycleId);
  const release = acquireCycleLock(directory, input.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  try {
    const identityPath = join(directory, "cycle.json");
    if (!existsSync(identityPath)) throw new ConveyorRunnerError("cycle_missing", `cycle does not exist: ${input.cycleId}`);
    const identity = parseIdentity(parseJsonFile(identityPath));
    const receipts = loadReceipts(directory, identity);
    const state = snapshot(identity, receipts);
    const transitionKey = input.transitionKey ?? `${identity.cycle_id}:${input.phase}:${input.event}`;
    const replay = receipts.find((receipt) => receipt.transition_key === transitionKey);
    if (replay) {
      if (equivalentTransition(replay, input)) return replay;
      throw new ConveyorRunnerError("transition_key_conflict", "transition_key is already bound to different content");
    }

    const phaseIndex = CONVEYOR_PHASES.indexOf(input.phase);
    if (phaseIndex < 0) throw new ConveyorRunnerError("phase_unknown", `unknown conveyor phase: ${input.phase}`);
    if (state.status === "failed" || state.status === "held" || state.status === "complete") {
      throw new ConveyorRunnerError("cycle_terminal", `cycle is already ${state.status}`);
    }

    const lastStarted = [...receipts].reverse().find((receipt) => receipt.event === "started" && receipt.phase === input.phase);
    const lastAttempt = Math.max(0, ...receipts.filter((receipt) => receipt.phase === input.phase).map((receipt) => receipt.attempt));
    let attempt: number;
    if (input.event === "started") {
      if (state.status !== "ready" || state.next_phase !== input.phase) {
        throw new ConveyorRunnerError("phase_order", `expected ${state.next_phase ?? "no phase"}, received ${input.phase}`);
      }
      attempt = lastAttempt + 1;
      assertHash(input.inputHash ?? null, "input_hash");
      if (input.outputHash !== undefined && input.outputHash !== null) {
        throw new ConveyorRunnerError("phase_transition", "started events cannot carry output_hash");
      }
    } else {
      if (state.status !== "running" || state.open_phase !== input.phase || !lastStarted) {
        throw new ConveyorRunnerError("phase_transition", `phase ${input.phase} is not currently running`);
      }
      attempt = lastStarted.attempt;
      if (input.event === "succeeded") assertHash(input.outputHash ?? null, "output_hash");
      if ((input.event === "failed" || input.event === "held") && !input.reason && !input.error) {
        throw new ConveyorRunnerError("terminal_reason_required", `${input.event} events require reason or error evidence`);
      }
    }

    const at = input.at ?? new Date().toISOString();
    assertIso(at, "receipt.at");
    const unsigned: Omit<ConveyorPhaseReceipt, "record_hash"> = {
      schema_version: CONVEYOR_RUNNER_SCHEMA_VERSION,
      runner_version: CONVEYOR_RUNNER_VERSION,
      cycle_id: identity.cycle_id,
      sequence: receipts.length + 1,
      phase: input.phase,
      phase_index: phaseIndex,
      attempt,
      event: input.event,
      transition_key: transitionKey,
      at,
      input_hash: input.inputHash ?? null,
      output_hash: input.outputHash ?? null,
      reason: input.reason ?? null,
      error: input.error ?? null,
      previous_hash: receipts.at(-1)?.record_hash ?? ZERO_HASH,
    };
    const receipt: ConveyorPhaseReceipt = { ...unsigned, record_hash: receiptHash(unsigned) };
    const file = `${String(receipt.sequence).padStart(6, "0")}-${receipt.phase}-${receipt.event}.json`;
    writeImmutable(join(directory, "receipts", file), receipt);
    return receipt;
  } finally {
    release();
  }
}

export function runCycleScaffold(input: {
  mode: ConveyorRunnerMode;
  cycleId?: string;
  idempotencyKey?: string;
  stateDir?: string;
}): { ok: boolean; mode: ConveyorRunnerMode; mutated: boolean; snapshot: ConveyorCycleSnapshot | null } {
  if (input.mode === "off") return { ok: true, mode: "off", mutated: false, snapshot: null };
  if (input.mode === "enforce") {
    throw new ConveyorRunnerError("enforce_unauthorized", "enforce mode is not implemented or authorized in this release");
  }
  if (!input.cycleId || !input.idempotencyKey) {
    throw new ConveyorRunnerError("cycle_identity_required", "shadow mode requires --cycle-id and --idempotency-key");
  }
  return {
    ok: true,
    mode: "shadow",
    mutated: true,
    snapshot: createCycle({
      cycleId: input.cycleId,
      idempotencyKey: input.idempotencyKey,
      mode: "shadow",
      stateDir: input.stateDir,
    }),
  };
}

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        "cycle-id": { type: "string" },
        "idempotency-key": { type: "string" },
        mode: { type: "string", default: "off" },
        "state-dir": { type: "string" },
      },
    });
    const command = positionals[0] ?? "cycle";
    if (command === "status") {
      if (!values["cycle-id"]) throw new ConveyorRunnerError("cycle_identity_required", "status requires --cycle-id");
      console.log(JSON.stringify(inspectCycle(values["cycle-id"], values["state-dir"]), null, 2));
      process.exit(0);
    }
    if (command !== "cycle") throw new ConveyorRunnerError("command_unknown", `unknown command: ${command}`);
    if (!CONVEYOR_RUNNER_MODES.includes(values.mode as ConveyorRunnerMode)) {
      throw new ConveyorRunnerError("mode_invalid", "mode must be off, shadow, or enforce");
    }
    const report = runCycleScaffold({
      mode: values.mode as ConveyorRunnerMode,
      cycleId: values["cycle-id"],
      idempotencyKey: values["idempotency-key"],
      stateDir: values["state-dir"],
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const code = error instanceof ConveyorRunnerError ? error.code : "unexpected_error";
    console.error(JSON.stringify({ ok: false, code, error: String(error) }));
    process.exit(1);
  }
}
