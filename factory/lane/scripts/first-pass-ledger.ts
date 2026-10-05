import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  VALIDATOR_DEFECT_CLASSES,
  VALIDATOR_VERDICTS,
  type ValidatorDefectClass,
  type ValidatorVerdict,
} from "./validator-authority";

export const FIRST_PASS_LEDGER_SCHEMA = "zsf.first-pass-ledger-row.v1" as const;
export const FIRST_PASS_LEDGER_VERSION = 1 as const;

export interface FirstPassStratum {
  archetype: string;
  repository: string;
  harness: string;
  validator_version: string;
}

export interface FirstPassLedgerRow {
  schema: typeof FIRST_PASS_LEDGER_SCHEMA;
  schema_version: typeof FIRST_PASS_LEDGER_VERSION;
  record_id: string;
  previous_hash: string | null;
  execution_id: string;
  ticket: string;
  candidate_cycle_id: string;
  cycle_number: number;
  supersedes_cycle_id: string | null;
  candidate_commit_digest: string;
  validation_contract_digest: string;
  validator_environment_digest: string;
  evidence_digest: string;
  validator_verdict: ValidatorVerdict["verdict"];
  defect_classes: ValidatorDefectClass[];
  stratum: FirstPassStratum;
  recorded_at: string;
}

export interface FirstPassRecordInput {
  ticket: string;
  verdict: ValidatorVerdict;
  cycle_number: number;
  prior_cycle?: FirstPassLedgerRow | null;
  stratum: FirstPassStratum;
  recorded_at: string;
}

export interface FirstPassLedgerParseResult {
  rows: FirstPassLedgerRow[];
  errors: string[];
}

export interface FirstPassAppendResult {
  appended: boolean;
  duplicate: boolean;
  row: FirstPassLedgerRow;
}

export interface FirstPassMetrics {
  executions: number;
  validation_cycles: number;
  first_pass_passes: number;
  repaired_executions: number;
  first_pass_yield: number | null;
  rework_rate: number | null;
  flaky_cycles: number;
  held_cycles: number;
  failed_cycles: number;
  defect_classes: Record<ValidatorDefectClass, number>;
  strata: Record<string, { executions: number; first_pass_passes: number; repaired_executions: number }>;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROW_KEYS = new Set([
  "schema",
  "schema_version",
  "record_id",
  "previous_hash",
  "execution_id",
  "ticket",
  "candidate_cycle_id",
  "cycle_number",
  "supersedes_cycle_id",
  "candidate_commit_digest",
  "validation_contract_digest",
  "validator_environment_digest",
  "evidence_digest",
  "validator_verdict",
  "defect_classes",
  "stratum",
  "recorded_at",
]);
const STRATUM_KEYS = new Set(["archetype", "repository", "harness", "validator_version"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digestPayload(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;
}

function rowId(row: Omit<FirstPassLedgerRow, "record_id">): string {
  return digestPayload(row);
}

function requiredString(value: unknown, path: string, errors: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path}: required non-empty string`);
    return "";
  }
  return value.trim();
}

function requiredDigest(value: unknown, path: string, errors: string[]): string {
  const result = requiredString(value, path, errors);
  if (result && !SHA256_PATTERN.test(result)) errors.push(`${path}: must be sha256:<64 lowercase hex>`);
  return result;
}

function stratum(value: unknown, path: string, errors: string[]): FirstPassStratum | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  for (const key of Object.keys(value)) if (!STRATUM_KEYS.has(key)) errors.push(`${path}.${key}: unknown field`);
  const archetype = requiredString(value.archetype, `${path}.archetype`, errors);
  const repository = requiredString(value.repository, `${path}.repository`, errors);
  const harness = requiredString(value.harness, `${path}.harness`, errors);
  const validator_version = requiredString(value.validator_version, `${path}.validator_version`, errors);
  return archetype && repository && harness && validator_version
    ? { archetype, repository, harness, validator_version }
    : null;
}

function validateSequence(rows: readonly FirstPassLedgerRow[], errors: string[]): void {
  const latestByExecution = new Map<string, FirstPassLedgerRow>();
  for (const [index, row] of rows.entries()) {
    const prior = latestByExecution.get(row.execution_id);
    if (!prior) {
      if (row.cycle_number !== 0) errors.push(`line ${index + 1}: first candidate cycle must be 0`);
      if (row.supersedes_cycle_id !== null) errors.push(`line ${index + 1}: first candidate cannot supersede a prior cycle`);
    } else {
      if (row.cycle_number !== prior.cycle_number + 1) errors.push(`line ${index + 1}: candidate cycle must increase by exactly one`);
      if (row.supersedes_cycle_id !== prior.candidate_cycle_id) errors.push(`line ${index + 1}: repair must supersede the latest candidate cycle`);
      if (row.candidate_cycle_id === prior.candidate_cycle_id) errors.push(`line ${index + 1}: repair must create a new candidate cycle id`);
      if (row.candidate_commit_digest === prior.candidate_commit_digest) errors.push(`line ${index + 1}: repair must bind a new candidate commit`);
      if (row.validation_contract_digest === prior.validation_contract_digest) errors.push(`line ${index + 1}: repair must compile a new candidate-cycle contract`);
    }
    latestByExecution.set(row.execution_id, row);
  }
}

export function createFirstPassLedgerRow(input: FirstPassRecordInput, previousHash: string | null): FirstPassLedgerRow {
  if (!Number.isSafeInteger(input.cycle_number) || input.cycle_number < 0) throw new Error("cycle_number must be a non-negative integer");
  if (!Number.isFinite(Date.parse(input.recorded_at))) throw new Error("recorded_at must be an ISO-8601 timestamp");
  const prior = input.prior_cycle ?? null;
  if (input.cycle_number === 0 && prior) throw new Error("cycle 0 cannot have a prior candidate");
  if (input.cycle_number > 0 && !prior) throw new Error("a repair cycle requires the prior candidate");
  if (prior && prior.execution_id !== input.verdict.execution_id) throw new Error("repair cannot cross execution identities");
  if (prior && input.cycle_number !== prior.cycle_number + 1) throw new Error("repair cycle must increase by exactly one");
  if (prior && input.verdict.candidate_cycle_id === prior.candidate_cycle_id) throw new Error("repair must create a new candidate cycle id");
  if (prior && input.verdict.candidate_commit_digest === prior.candidate_commit_digest) throw new Error("repair must bind a new candidate commit");
  if (prior && input.verdict.validation_contract_digest === prior.validation_contract_digest) throw new Error("repair must compile a new candidate-cycle contract");
  if (!(VALIDATOR_VERDICTS as readonly string[]).includes(input.verdict.verdict)) throw new Error("validator_verdict is invalid");
  for (const defectClass of input.verdict.defect_classes) {
    if (!(VALIDATOR_DEFECT_CLASSES as readonly string[]).includes(defectClass)) throw new Error(`invalid defect class ${defectClass}`);
  }
  const payload: Omit<FirstPassLedgerRow, "record_id"> = {
    schema: FIRST_PASS_LEDGER_SCHEMA,
    schema_version: FIRST_PASS_LEDGER_VERSION,
    previous_hash: previousHash,
    execution_id: input.verdict.execution_id,
    ticket: input.ticket.trim(),
    candidate_cycle_id: input.verdict.candidate_cycle_id,
    cycle_number: input.cycle_number,
    supersedes_cycle_id: prior?.candidate_cycle_id ?? null,
    candidate_commit_digest: input.verdict.candidate_commit_digest,
    validation_contract_digest: input.verdict.validation_contract_digest,
    validator_environment_digest: input.verdict.validator_environment_digest,
    evidence_digest: input.verdict.evidence_digest,
    validator_verdict: input.verdict.verdict,
    defect_classes: [...new Set(input.verdict.defect_classes)].sort(),
    stratum: structuredClone(input.stratum),
    recorded_at: new Date(Date.parse(input.recorded_at)).toISOString(),
  };
  if (!payload.ticket) throw new Error("ticket is required");
  const validationErrors: string[] = [];
  requiredDigest(payload.candidate_commit_digest, "candidate_commit_digest", validationErrors);
  requiredDigest(payload.validation_contract_digest, "validation_contract_digest", validationErrors);
  requiredDigest(payload.validator_environment_digest, "validator_environment_digest", validationErrors);
  requiredDigest(payload.evidence_digest, "evidence_digest", validationErrors);
  if (payload.previous_hash !== null) requiredDigest(payload.previous_hash, "previous_hash", validationErrors);
  stratum(payload.stratum, "stratum", validationErrors);
  if (validationErrors.length > 0) throw new Error(`invalid first-pass row: ${validationErrors.join("; ")}`);
  return { ...payload, record_id: rowId(payload) };
}

export function parseFirstPassLedger(text: string): FirstPassLedgerParseResult {
  const rows: FirstPassLedgerRow[] = [];
  const errors: string[] = [];
  let previousHash: string | null = null;
  const recordIds = new Set<string>();
  const cycleIds = new Set<string>();
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      errors.push(`line ${index + 1}: malformed JSON (${(error as Error).message})`);
      continue;
    }
    if (!isRecord(raw)) {
      errors.push(`line ${index + 1}: row must be an object`);
      continue;
    }
    const rowErrors: string[] = [];
    for (const key of Object.keys(raw)) if (!ROW_KEYS.has(key)) rowErrors.push(`unknown field ${key}`);
    if (raw.schema !== FIRST_PASS_LEDGER_SCHEMA || raw.schema_version !== FIRST_PASS_LEDGER_VERSION) {
      errors.push(`line ${index + 1}: invalid schema or version`);
      continue;
    }
    const execution_id = requiredString(raw.execution_id, "execution_id", rowErrors);
    const ticket = requiredString(raw.ticket, "ticket", rowErrors);
    const candidate_cycle_id = requiredString(raw.candidate_cycle_id, "candidate_cycle_id", rowErrors);
    const candidate_commit_digest = requiredDigest(raw.candidate_commit_digest, "candidate_commit_digest", rowErrors);
    const validation_contract_digest = requiredDigest(raw.validation_contract_digest, "validation_contract_digest", rowErrors);
    const validator_environment_digest = requiredDigest(raw.validator_environment_digest, "validator_environment_digest", rowErrors);
    const evidence_digest = requiredDigest(raw.evidence_digest, "evidence_digest", rowErrors);
    const recorded_at = requiredString(raw.recorded_at, "recorded_at", rowErrors);
    if (recorded_at && !Number.isFinite(Date.parse(recorded_at))) rowErrors.push("recorded_at: must be an ISO-8601 timestamp");
    const cycle_number = Number.isSafeInteger(raw.cycle_number) && (raw.cycle_number as number) >= 0 ? raw.cycle_number as number : -1;
    if (cycle_number < 0) rowErrors.push("cycle_number: must be a non-negative integer");
    const supersedes_cycle_id = raw.supersedes_cycle_id === null ? null : requiredString(raw.supersedes_cycle_id, "supersedes_cycle_id", rowErrors);
    const previous_hash = raw.previous_hash === null ? null : requiredDigest(raw.previous_hash, "previous_hash", rowErrors);
    if (previous_hash !== previousHash) rowErrors.push("previous_hash: does not match prior ledger row");
    const validator_verdict = raw.validator_verdict;
    if (!(["pass", "fail", "flaky", "held"] as const).includes(validator_verdict as ValidatorVerdict["verdict"])) {
      rowErrors.push("validator_verdict: invalid verdict");
    }
    const defect_classes = Array.isArray(raw.defect_classes)
      ? raw.defect_classes.filter((value): value is ValidatorDefectClass =>
        typeof value === "string" && (VALIDATOR_DEFECT_CLASSES as readonly string[]).includes(value))
      : [];
    if (!Array.isArray(raw.defect_classes) || defect_classes.length !== raw.defect_classes.length) {
      rowErrors.push("defect_classes: must contain only known defect classes");
    }
    const parsedStratum = stratum(raw.stratum, "stratum", rowErrors);
    const suppliedRecordId = requiredDigest(raw.record_id, "record_id", rowErrors);
    if (rowErrors.length > 0 || !parsedStratum) {
      errors.push(...rowErrors.map((error) => `line ${index + 1}: ${error}`));
      continue;
    }
    const payload: Omit<FirstPassLedgerRow, "record_id"> = {
      schema: FIRST_PASS_LEDGER_SCHEMA,
      schema_version: FIRST_PASS_LEDGER_VERSION,
      previous_hash,
      execution_id,
      ticket,
      candidate_cycle_id,
      cycle_number,
      supersedes_cycle_id,
      candidate_commit_digest,
      validation_contract_digest,
      validator_environment_digest,
      evidence_digest,
      validator_verdict: validator_verdict as ValidatorVerdict["verdict"],
      defect_classes: [...new Set(defect_classes)].sort(),
      stratum: parsedStratum,
      recorded_at,
    };
    const expectedId = rowId(payload);
    if (suppliedRecordId !== expectedId) {
      errors.push(`line ${index + 1}: record_id digest mismatch`);
      continue;
    }
    if (recordIds.has(expectedId)) {
      errors.push(`line ${index + 1}: duplicate record_id ${expectedId}`);
      continue;
    }
    if (cycleIds.has(candidate_cycle_id)) {
      errors.push(`line ${index + 1}: duplicate candidate_cycle_id ${candidate_cycle_id}`);
      continue;
    }
    const row = { ...payload, record_id: expectedId };
    rows.push(row);
    recordIds.add(expectedId);
    cycleIds.add(candidate_cycle_id);
    previousHash = expectedId;
  }
  validateSequence(rows, errors);
  return { rows: errors.length > 0 ? [] : rows, errors };
}

export function appendFirstPassLedger(path: string, input: FirstPassRecordInput): FirstPassAppendResult {
  const parsed = existsSync(path) ? parseFirstPassLedger(readFileSync(path, "utf8")) : { rows: [], errors: [] };
  if (parsed.errors.length > 0) throw new Error(`first-pass ledger is invalid: ${parsed.errors.join("; ")}`);
  const prior = input.prior_cycle ?? null;
  const existingCycle = parsed.rows.find((entry) => entry.candidate_cycle_id === input.verdict.candidate_cycle_id);
  if (existingCycle) {
    const same = existingCycle.execution_id === input.verdict.execution_id
      && existingCycle.ticket === input.ticket.trim()
      && existingCycle.cycle_number === input.cycle_number
      && existingCycle.supersedes_cycle_id === (prior?.candidate_cycle_id ?? null)
      && existingCycle.candidate_commit_digest === input.verdict.candidate_commit_digest
      && existingCycle.validation_contract_digest === input.verdict.validation_contract_digest
      && existingCycle.validator_environment_digest === input.verdict.validator_environment_digest
      && existingCycle.evidence_digest === input.verdict.evidence_digest
      && existingCycle.validator_verdict === input.verdict.verdict
      && JSON.stringify(existingCycle.defect_classes) === JSON.stringify([...new Set(input.verdict.defect_classes)].sort())
      && JSON.stringify(existingCycle.stratum) === JSON.stringify(input.stratum)
      && existingCycle.recorded_at === new Date(Date.parse(input.recorded_at)).toISOString();
    if (!same) throw new Error(`candidate cycle ${existingCycle.candidate_cycle_id} already exists with different evidence`);
    return { appended: false, duplicate: true, row: existingCycle };
  }
  const latestForExecution = [...parsed.rows].reverse().find((row) => row.execution_id === input.verdict.execution_id) ?? null;
  if ((latestForExecution?.record_id ?? null) !== (prior?.record_id ?? null)) throw new Error("prior_cycle is not the latest recorded candidate for this execution");
  const row = createFirstPassLedgerRow(input, parsed.rows.at(-1)?.record_id ?? null);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, `${JSON.stringify(row)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { appended: true, duplicate: false, row };
}

export function computeFirstPassMetrics(rows: readonly FirstPassLedgerRow[]): FirstPassMetrics {
  const byExecution = new Map<string, FirstPassLedgerRow[]>();
  for (const row of rows) byExecution.set(row.execution_id, [...(byExecution.get(row.execution_id) ?? []), row]);
  let firstPassPasses = 0;
  let repairedExecutions = 0;
  let flakyCycles = 0;
  let heldCycles = 0;
  let failedCycles = 0;
  const defectClasses = Object.fromEntries([
    "acceptance_gap",
    "behavioral_regression",
    "deterministic_test_failure",
    "flaky_test",
    "environment_mismatch",
    "evidence_invalid",
    "authority_violation",
    "heldout_failure",
  ].map((name) => [name, 0])) as Record<ValidatorDefectClass, number>;
  const strata: FirstPassMetrics["strata"] = {};
  for (const cycles of byExecution.values()) {
    const ordered = [...cycles].sort((left, right) => left.cycle_number - right.cycle_number);
    const first = ordered[0];
    if (!first) continue;
    if (first.validator_verdict === "pass") firstPassPasses++;
    if (ordered.length > 1) repairedExecutions++;
    const key = [first.stratum.archetype, first.stratum.repository, first.stratum.harness, first.stratum.validator_version].join("|");
    const bucket = strata[key] ?? { executions: 0, first_pass_passes: 0, repaired_executions: 0 };
    bucket.executions++;
    if (first.validator_verdict === "pass") bucket.first_pass_passes++;
    if (ordered.length > 1) bucket.repaired_executions++;
    strata[key] = bucket;
  }
  for (const row of rows) {
    if (row.validator_verdict === "flaky") flakyCycles++;
    if (row.validator_verdict === "held") heldCycles++;
    if (row.validator_verdict === "fail") failedCycles++;
    for (const defectClass of row.defect_classes) defectClasses[defectClass]++;
  }
  const executions = byExecution.size;
  return {
    executions,
    validation_cycles: rows.length,
    first_pass_passes: firstPassPasses,
    repaired_executions: repairedExecutions,
    first_pass_yield: executions > 0 ? Number((firstPassPasses / executions).toFixed(4)) : null,
    rework_rate: executions > 0 ? Number((repairedExecutions / executions).toFixed(4)) : null,
    flaky_cycles: flakyCycles,
    held_cycles: heldCycles,
    failed_cycles: failedCycles,
    defect_classes: defectClasses,
    strata,
  };
}
