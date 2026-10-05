import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { ConveyorRunnerError, canonicalJson } from "./factory-conveyor-runner";

export const CONVEYOR_PARITY_SCHEMA_VERSION = 2 as const;
export const CONVEYOR_DECISIONS = [
  "preflight_abort",
  "cap_reached",
  "empty_queue",
  "contract_rejected",
  "open_execution_guard",
  "dedup_skip",
  "dispatched",
  "execution_failed",
] as const;

export type ConveyorDecision = typeof CONVEYOR_DECISIONS[number];
export type ParitySource = "incumbent" | "runner";
export type ConveyorParityEvidenceClass = "structural_projection";

export interface ConveyorCycleObservation {
  schema_version: typeof CONVEYOR_PARITY_SCHEMA_VERSION;
  source: ParitySource;
  cycle_key: string;
  observed_version: string;
  decision: ConveyorDecision;
  ticket_id: string | null;
  identifier: string | null;
  dispatch_count: 0 | 1;
  side_effect_keys: string[];
  evidence_hash: string;
  observation_hash: string;
}

export interface CreateObservationInput {
  source: ParitySource;
  cycleKey: string;
  observedVersion: string;
  decision: ConveyorDecision;
  ticketId?: string | null;
  identifier?: string | null;
  dispatchCount: 0 | 1;
  sideEffectKeys?: string[];
  evidenceHash: string;
}

export interface ParityMismatch {
  field: "decision" | "ticket_id" | "identifier" | "dispatch_count" | "side_effect_keys";
  incumbent_hash: string;
  runner_hash: string;
}

export interface ConveyorParityComparison {
  schema_version: typeof CONVEYOR_PARITY_SCHEMA_VERSION;
  comparison_id: string;
  cycle_key: string;
  compared_at: string;
  incumbent_observation_hash: string;
  runner_observation_hash: string;
  evidence_class: ConveyorParityEvidenceClass;
  match: boolean;
  mismatches: ParityMismatch[];
  previous_hash: string;
  record_hash: string;
}

export interface ConveyorParitySummary {
  schema_version: typeof CONVEYOR_PARITY_SCHEMA_VERSION;
  target: number;
  comparisons: number;
  qualifying_comparisons: number;
  structural_projections: number;
  matching_cycles: number;
  mismatched_cycles: number;
  held_unmeasured: number;
  remaining: number;
  eligible: boolean;
  latest_record_hash: string;
}

export interface ConveyorParityHold {
  schema_version: typeof CONVEYOR_PARITY_SCHEMA_VERSION;
  hold_id: string;
  cycle_key: string;
  observed_at: string;
  reason_code: string;
  evidence_hash: string;
  previous_hash: string;
  record_hash: string;
}

const HASH = /^[0-9a-f]{64}$/;
const CYCLE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,255}$/;
const SIDE_EFFECT_KEY = /^[A-Za-z0-9][A-Za-z0-9:/._-]{2,255}$/;
const ZERO_HASH = "0".repeat(64);
const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/;

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertHash(value: string, field: string): void {
  if (!HASH.test(value)) throw new ConveyorRunnerError("parity_hash_invalid", `${field} must be a lowercase SHA-256 digest`);
}

function assertTimestamp(value: string): void {
  if (!value || Number.isNaN(Date.parse(value))) throw new ConveyorRunnerError("parity_timestamp_invalid", "compared_at must be RFC 3339");
}

function normalizeSideEffects(values: string[]): string[] {
  const normalized = [...new Set(values)].sort();
  if (normalized.some((value) => !SIDE_EFFECT_KEY.test(value))) {
    throw new ConveyorRunnerError("parity_side_effect_invalid", "side-effect keys must be path-safe identifiers");
  }
  return normalized;
}

function observationUnsigned(observation: Omit<ConveyorCycleObservation, "observation_hash">): unknown {
  return observation;
}

export function createCycleObservation(input: CreateObservationInput): ConveyorCycleObservation {
  if (input.source !== "incumbent" && input.source !== "runner") throw new ConveyorRunnerError("parity_source_invalid", "source must be incumbent or runner");
  if (!CYCLE_KEY.test(input.cycleKey)) throw new ConveyorRunnerError("parity_cycle_key_invalid", "cycle key must be stable and path-safe");
  if (!input.observedVersion.trim()) throw new ConveyorRunnerError("parity_version_required", "observed version is required");
  if (!CONVEYOR_DECISIONS.includes(input.decision)) throw new ConveyorRunnerError("parity_decision_invalid", "unknown conveyor decision");
  if (input.dispatchCount !== 0 && input.dispatchCount !== 1) throw new ConveyorRunnerError("parity_dispatch_count_invalid", "dispatch_count must be 0 or 1");
  assertHash(input.evidenceHash, "evidence_hash");
  const unsigned: Omit<ConveyorCycleObservation, "observation_hash"> = {
    schema_version: CONVEYOR_PARITY_SCHEMA_VERSION,
    source: input.source,
    cycle_key: input.cycleKey,
    observed_version: input.observedVersion,
    decision: input.decision,
    ticket_id: input.ticketId ?? null,
    identifier: input.identifier ?? null,
    dispatch_count: input.dispatchCount,
    side_effect_keys: normalizeSideEffects(input.sideEffectKeys ?? []),
    evidence_hash: input.evidenceHash,
  };
  return { ...unsigned, observation_hash: hash(observationUnsigned(unsigned)) };
}

export function validateCycleObservation(observation: ConveyorCycleObservation): void {
  const rebuilt = createCycleObservation({
    source: observation.source,
    cycleKey: observation.cycle_key,
    observedVersion: observation.observed_version,
    decision: observation.decision,
    ticketId: observation.ticket_id,
    identifier: observation.identifier,
    dispatchCount: observation.dispatch_count,
    sideEffectKeys: observation.side_effect_keys,
    evidenceHash: observation.evidence_hash,
  });
  if (observation.schema_version !== CONVEYOR_PARITY_SCHEMA_VERSION) throw new ConveyorRunnerError("parity_schema_incompatible", "unsupported observation schema");
  if (observation.observation_hash !== rebuilt.observation_hash) throw new ConveyorRunnerError("parity_observation_hash_mismatch", "observation hash mismatch");
  if (canonicalJson(observation.side_effect_keys) !== canonicalJson(rebuilt.side_effect_keys)) {
    throw new ConveyorRunnerError("parity_side_effect_order", "side-effect keys must be sorted and unique");
  }
}

function fieldHash(value: unknown): string {
  return hash(value);
}

export function compareCycleObservations(input: {
  incumbent: ConveyorCycleObservation;
  runner: ConveyorCycleObservation;
  comparedAt?: string;
  previousHash?: string;
}): ConveyorParityComparison {
  validateCycleObservation(input.incumbent);
  validateCycleObservation(input.runner);
  if (input.incumbent.source !== "incumbent" || input.runner.source !== "runner") {
    throw new ConveyorRunnerError("parity_source_order", "comparison requires incumbent then runner observations");
  }
  if (input.incumbent.cycle_key !== input.runner.cycle_key) throw new ConveyorRunnerError("parity_cycle_mismatch", "observations belong to different cycles");
  const comparedAt = input.comparedAt ?? new Date().toISOString();
  assertTimestamp(comparedAt);
  const previousHash = input.previousHash ?? ZERO_HASH;
  assertHash(previousHash, "previous_hash");
  const mismatches: ParityMismatch[] = [];
  const pairs: Array<[ParityMismatch["field"], unknown, unknown]> = [
    ["decision", input.incumbent.decision, input.runner.decision],
    ["ticket_id", input.incumbent.ticket_id, input.runner.ticket_id],
    ["identifier", input.incumbent.identifier, input.runner.identifier],
    ["dispatch_count", input.incumbent.dispatch_count, input.runner.dispatch_count],
    ["side_effect_keys", input.incumbent.side_effect_keys, input.runner.side_effect_keys],
  ];
  for (const [field, incumbent, runner] of pairs) {
    if (canonicalJson(incumbent) !== canonicalJson(runner)) {
      mismatches.push({ field, incumbent_hash: fieldHash(incumbent), runner_hash: fieldHash(runner) });
    }
  }
  const comparisonId = `par-${hash(input.incumbent.cycle_key).slice(0, 32)}`;
  const unsigned: Omit<ConveyorParityComparison, "record_hash"> = {
    schema_version: CONVEYOR_PARITY_SCHEMA_VERSION,
    comparison_id: comparisonId,
    cycle_key: input.incumbent.cycle_key,
    compared_at: comparedAt,
    incumbent_observation_hash: input.incumbent.observation_hash,
    runner_observation_hash: input.runner.observation_hash,
    evidence_class: "structural_projection",
    match: mismatches.length === 0,
    mismatches,
    previous_hash: previousHash,
  };
  return { ...unsigned, record_hash: hash(unsigned) };
}

function parityRoot(explicit?: string): string {
  if (explicit) return resolveFactoryStateOverride(explicit);
  return join(factoryStateRoot(), "conveyor-runner");
}

function comparisonsDir(root: string): string {
  return join(root, "parity", "comparisons");
}

function holdsDir(root: string): string {
  return join(root, "parity", "holds");
}

function withParityWriteLock<T>(root: string, write: () => T): T {
  const directory = join(root, "parity");
  const lock = join(directory, ".write-lock");
  mkdirSync(directory, { recursive: true });
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    throw new ConveyorRunnerError("parity_write_locked", `parity writer lock is already held: ${String(error)}`);
  }
  try {
    return write();
  } finally {
    rmdirSync(lock);
  }
}

function readComparison(path: string): ConveyorParityComparison {
  let parsed: ConveyorParityComparison;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ConveyorParityComparison;
  } catch (error) {
    throw new ConveyorRunnerError("parity_json_invalid", `invalid parity JSON at ${path}: ${String(error)}`);
  }
  if (parsed.schema_version !== CONVEYOR_PARITY_SCHEMA_VERSION) throw new ConveyorRunnerError("parity_schema_incompatible", "unsupported comparison schema");
  assertTimestamp(parsed.compared_at);
  assertHash(parsed.incumbent_observation_hash, "incumbent_observation_hash");
  assertHash(parsed.runner_observation_hash, "runner_observation_hash");
  if (parsed.evidence_class !== "structural_projection") {
    throw new ConveyorRunnerError("parity_evidence_class_invalid", "unknown parity evidence class");
  }
  assertHash(parsed.previous_hash, "previous_hash");
  assertHash(parsed.record_hash, "record_hash");
  const { record_hash, ...unsigned } = parsed;
  if (record_hash !== hash(unsigned)) throw new ConveyorRunnerError("parity_record_hash_mismatch", `parity record hash mismatch at ${path}`);
  return parsed;
}

function loadComparisons(root: string): ConveyorParityComparison[] {
  const directory = comparisonsDir(root);
  if (!existsSync(directory)) return [];
  const records = readdirSync(directory)
    .filter((name) => /^\d{6}-par-[0-9a-f]{32}\.json$/.test(name))
    .sort()
    .map((name) => readComparison(join(directory, name)));
  const cycleKeys = new Set<string>();
  let previousHash = ZERO_HASH;
  for (const record of records) {
    if (cycleKeys.has(record.cycle_key)) throw new ConveyorRunnerError("parity_cycle_duplicate", `duplicate parity cycle ${record.cycle_key}`);
    if (record.previous_hash !== previousHash) throw new ConveyorRunnerError("parity_chain_mismatch", "parity comparison chain is invalid");
    cycleKeys.add(record.cycle_key);
    previousHash = record.record_hash;
  }
  return records;
}

function writeImmutable(path: string, value: unknown): void {
  const body = `${canonicalJson(value)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === body) return;
    throw new ConveyorRunnerError("parity_immutable_conflict", `parity record already exists with different content: ${path}`);
  }
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
  } catch (error) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== body) {
      throw new ConveyorRunnerError("parity_write_failed", `failed to write parity record ${path}: ${String(error)}`);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

function readHold(path: string): ConveyorParityHold {
  let parsed: ConveyorParityHold;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ConveyorParityHold;
  } catch (error) {
    throw new ConveyorRunnerError("parity_hold_json_invalid", `invalid parity hold JSON at ${path}: ${String(error)}`);
  }
  if (parsed.schema_version !== CONVEYOR_PARITY_SCHEMA_VERSION) throw new ConveyorRunnerError("parity_schema_incompatible", "unsupported hold schema");
  if (!/^hold-[0-9a-f]{32}$/.test(parsed.hold_id)) throw new ConveyorRunnerError("parity_hold_id_invalid", "invalid parity hold id");
  if (!CYCLE_KEY.test(parsed.cycle_key) || !REASON_CODE.test(parsed.reason_code)) throw new ConveyorRunnerError("parity_hold_invalid", "invalid parity hold identity");
  assertTimestamp(parsed.observed_at);
  assertHash(parsed.evidence_hash, "evidence_hash");
  assertHash(parsed.previous_hash, "previous_hash");
  assertHash(parsed.record_hash, "record_hash");
  const { record_hash, ...unsigned } = parsed;
  if (record_hash !== hash(unsigned)) throw new ConveyorRunnerError("parity_hold_hash_mismatch", `parity hold hash mismatch at ${path}`);
  return parsed;
}

function loadHolds(root: string): ConveyorParityHold[] {
  const directory = holdsDir(root);
  if (!existsSync(directory)) return [];
  const records = readdirSync(directory)
    .filter((name) => /^\d{6}-hold-[0-9a-f]{32}\.json$/.test(name))
    .sort()
    .map((name) => readHold(join(directory, name)));
  const cycleKeys = new Set<string>();
  let previousHash = ZERO_HASH;
  for (const record of records) {
    if (cycleKeys.has(record.cycle_key)) throw new ConveyorRunnerError("parity_hold_duplicate", `duplicate parity hold ${record.cycle_key}`);
    if (record.previous_hash !== previousHash) throw new ConveyorRunnerError("parity_hold_chain_mismatch", "parity hold chain is invalid");
    cycleKeys.add(record.cycle_key);
    previousHash = record.record_hash;
  }
  return records;
}

export function recordParityHold(input: {
  cycleKey: string;
  reasonCode: string;
  evidenceHash: string;
  stateDir?: string;
  observedAt?: string;
}): ConveyorParityHold {
  if (!CYCLE_KEY.test(input.cycleKey)) throw new ConveyorRunnerError("parity_cycle_key_invalid", "cycle key must be stable and path-safe");
  if (!REASON_CODE.test(input.reasonCode)) throw new ConveyorRunnerError("parity_hold_reason_invalid", "hold reason code is invalid");
  assertHash(input.evidenceHash, "evidence_hash");
  const observedAt = input.observedAt ?? new Date().toISOString();
  assertTimestamp(observedAt);
  const root = parityRoot(input.stateDir);
  return withParityWriteLock(root, () => {
    if (loadComparisons(root).some((record) => record.cycle_key === input.cycleKey)) {
      throw new ConveyorRunnerError("parity_disposition_conflict", `cycle ${input.cycleKey} already has a comparison disposition`);
    }
    const existing = loadHolds(root);
    const holdId = `hold-${hash(input.cycleKey).slice(0, 32)}`;
    const replay = existing.find((record) => record.hold_id === holdId);
    if (replay) {
      if (replay.reason_code === input.reasonCode && replay.evidence_hash === input.evidenceHash) return replay;
      throw new ConveyorRunnerError("parity_hold_conflict", `cycle ${input.cycleKey} already has different hold evidence`);
    }
    const unsigned: Omit<ConveyorParityHold, "record_hash"> = {
      schema_version: CONVEYOR_PARITY_SCHEMA_VERSION,
      hold_id: holdId,
      cycle_key: input.cycleKey,
      observed_at: observedAt,
      reason_code: input.reasonCode,
      evidence_hash: input.evidenceHash,
      previous_hash: existing.at(-1)?.record_hash ?? ZERO_HASH,
    };
    const record = { ...unsigned, record_hash: hash(unsigned) };
    const directory = holdsDir(root);
    mkdirSync(directory, { recursive: true });
    writeImmutable(join(directory, `${String(existing.length + 1).padStart(6, "0")}-${holdId}.json`), record);
    return record;
  });
}

export function recordParityComparison(input: {
  incumbent: ConveyorCycleObservation;
  runner: ConveyorCycleObservation;
  stateDir?: string;
  comparedAt?: string;
}): ConveyorParityComparison {
  const root = parityRoot(input.stateDir);
  return withParityWriteLock(root, () => {
    const existing = loadComparisons(root);
    if (loadHolds(root).some((record) => record.cycle_key === input.incumbent.cycle_key)) {
      throw new ConveyorRunnerError("parity_disposition_conflict", `cycle ${input.incumbent.cycle_key} already has a held disposition`);
    }
    const prior = existing.at(-1)?.record_hash ?? ZERO_HASH;
    const comparison = compareCycleObservations({ ...input, previousHash: prior });
    const replay = existing.find((record) => record.comparison_id === comparison.comparison_id);
    if (replay) {
      if (replay.record_hash === comparison.record_hash || (
        replay.incumbent_observation_hash === comparison.incumbent_observation_hash
        && replay.runner_observation_hash === comparison.runner_observation_hash
        && replay.evidence_class === comparison.evidence_class
      )) return replay;
      throw new ConveyorRunnerError("parity_cycle_conflict", `cycle ${comparison.cycle_key} already has different parity evidence`);
    }
    const directory = comparisonsDir(root);
    mkdirSync(directory, { recursive: true });
    const file = `${String(existing.length + 1).padStart(6, "0")}-${comparison.comparison_id}.json`;
    writeImmutable(join(directory, file), comparison);
    return comparison;
  });
}

export function summarizeParity(stateDir?: string, target = 20): ConveyorParitySummary {
  if (!Number.isSafeInteger(target) || target < 1) throw new ConveyorRunnerError("parity_target_invalid", "parity target must be a positive integer");
  const records = loadComparisons(parityRoot(stateDir));
  const matching = 0;
  const mismatched = 0;
  const projections = records.length;
  const held = loadHolds(parityRoot(stateDir));
  return {
    schema_version: CONVEYOR_PARITY_SCHEMA_VERSION,
    target,
    comparisons: records.length,
    qualifying_comparisons: 0,
    structural_projections: projections,
    matching_cycles: matching,
    mismatched_cycles: mismatched,
    held_unmeasured: held.length,
    remaining: Math.max(0, target - matching),
    eligible: false,
    latest_record_hash: records.at(-1)?.record_hash ?? ZERO_HASH,
  };
}
