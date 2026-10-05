#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isExecutionRecordFileName, normalizeExecutionLifecycle } from "./execution-lifecycle";
import { factoryStateRoot } from "./factory-state-root";
import { parseVerdict, type Verdict } from "./factory-verdict";
import {
  OUTCOME_TERMINAL_STATES,
  parseOutcomeEnvelope,
  resolveOutcomeEnvelope,
  serializeOutcomeEnvelope,
  type OutcomeActor,
  type OutcomeCost,
  type OutcomeEnvelope,
  type OutcomeHold,
  type OutcomePullRequest,
  type OutcomeVerification,
} from "./outcome-envelope";

export const OUTCOME_LEDGER_VERSION = 1 as const;
export const DEFAULT_INSTRUMENTATION_START = "2026-08-27T00:00:00.000Z";

export interface OutcomeEvidenceSources {
  stateDir: string;
  evaluationsDir: string;
  ledgerPath: string;
}

export interface OutcomeEvidenceLedgerRow {
  ledger_version: typeof OUTCOME_LEDGER_VERSION;
  record_id: string;
  supersedes: string | null;
  envelope: OutcomeEnvelope;
}

export interface OutcomeSourceError {
  source: string;
  error: string;
  execution_id?: string;
}

export interface OutcomeReconcileReport {
  apply: boolean;
  scanned: number;
  terminal: number;
  measured: number;
  excluded: number;
  held_unmeasured: number;
  appended: number;
  unchanged: number;
  superseded: number;
  write_blocked: boolean;
  generated: OutcomeEvidenceLedgerRow[];
  source_errors: OutcomeSourceError[];
  ledger_errors: string[];
}

interface SidecarClaim {
  path: string;
  verdict: Verdict;
  raw: Record<string, unknown>;
}

interface VerdictIndex {
  valid: Map<string, SidecarClaim[]>;
  invalid: Map<string, string[]>;
  errors: OutcomeSourceError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function recordId(envelope: OutcomeEnvelope, supersedes: string | null): string {
  return sha256(JSON.stringify({
    ledger_version: OUTCOME_LEDGER_VERSION,
    supersedes,
    envelope: JSON.parse(serializeOutcomeEnvelope(envelope)),
  }));
}

function materialId(envelope: OutcomeEnvelope): string {
  return sha256(serializeOutcomeEnvelope({ ...envelope, recorded_at: envelope.terminal_at }));
}

function actor(value: unknown): OutcomeActor | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const harness = text(value.harness);
  const model = text(value.model);
  return id && harness && model ? { id, harness, model } : null;
}

function executorActor(record: Record<string, unknown>): OutcomeActor | null {
  const direct = actor(record.executor);
  if (direct) return direct;
  const harness = text(record.executor_harness);
  const model = text(record.model_used);
  const id = text(record.executor_id) ?? (harness && model ? `${harness}:${model}` : null);
  return id && harness && model ? { id, harness, model } : null;
}

function directCommitDigest(record: Record<string, unknown>): unknown {
  if (record.commit_digest !== undefined) return record.commit_digest;
  return isRecord(record.artifact) ? record.artifact.commit_digest : undefined;
}

function cost(record: Record<string, unknown>): OutcomeCost | null {
  const amount = record.model_cost_usd ?? record.cost_usd;
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
    ? { amount_usd: amount, source: "execution-record" }
    : null;
}

function pullRequest(record: Record<string, unknown>, terminalState: string): OutcomePullRequest {
  const number = Number.isInteger(record.pr_number) && (record.pr_number as number) > 0
    ? record.pr_number as number
    : null;
  if (number === null) return { number: null, fate: "none" };
  const explicit = record.pr_fate;
  if (explicit === "open" || explicit === "closed" || explicit === "merged") return { number, fate: explicit };
  return { number, fate: terminalState === "accepted" ? "merged" : "open" };
}

function loadVerdictIndex(evaluationsDir: string): VerdictIndex {
  const index: VerdictIndex = { valid: new Map(), invalid: new Map(), errors: [] };
  if (!existsSync(evaluationsDir)) return index;
  for (const file of readdirSync(evaluationsDir).filter((item) => item.endsWith(".verdict.json")).sort()) {
    const path = join(evaluationsDir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      index.errors.push({ source: path, error: `malformed JSON: ${(error as Error).message}` });
      continue;
    }
    const executionId = isRecord(raw) ? text(raw.execution_id) : null;
    const parsed = parseVerdict(raw);
    if (parsed.ok === false) {
      index.errors.push({ source: path, error: parsed.errors.join("; "), ...(executionId ? { execution_id: executionId } : {}) });
      if (executionId) index.invalid.set(executionId, [...(index.invalid.get(executionId) ?? []), path]);
      continue;
    }
    if (!executionId || !isRecord(raw)) continue;
    const claims = index.valid.get(executionId) ?? [];
    claims.push({ path, verdict: parsed.verdict, raw });
    index.valid.set(executionId, claims);
  }
  return index;
}

function verificationFromClaim(claim: SidecarClaim): OutcomeVerification | undefined {
  const verifier = actor(claim.raw.outcome_verifier);
  const commitDigest = text(claim.raw.commit_digest);
  const evidenceDigest = text(claim.raw.evidence_digest)
    ?? text(claim.raw.evidence_manifest_hash);
  if (!verifier || !commitDigest || !evidenceDigest) return undefined;
  return {
    ...verifier,
    verdict: claim.verdict.verdict,
    decided_at: claim.verdict.decided_at,
    commit_digest: commitDigest,
    evidence_digest: evidenceDigest,
  };
}

function explicitExclusion(record: Record<string, unknown>): unknown {
  return record.outcome_exclusion;
}

export function parseOutcomeLedger(textValue: string): {
  rows: OutcomeEvidenceLedgerRow[];
  errors: string[];
} {
  const rows: OutcomeEvidenceLedgerRow[] = [];
  const errors: string[] = [];
  const byId = new Map<string, OutcomeEvidenceLedgerRow>();
  const latestByExecution = new Map<string, OutcomeEvidenceLedgerRow>();
  const lines = textValue.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      errors.push(`line ${index + 1}: malformed JSON (${(error as Error).message})`);
      continue;
    }
    if (!isRecord(raw) || raw.ledger_version !== OUTCOME_LEDGER_VERSION) {
      errors.push(`line ${index + 1}: invalid ledger version or row shape`);
      continue;
    }
    const parsed = parseOutcomeEnvelope(raw.envelope);
    if (parsed.ok === false) {
      errors.push(`line ${index + 1}: invalid envelope (${parsed.errors.join("; ")})`);
      continue;
    }
    let supersedes: string | null | undefined;
    if (raw.supersedes === null) supersedes = null;
    else if (typeof raw.supersedes === "string") supersedes = raw.supersedes;
    if (supersedes === undefined) {
      errors.push(`line ${index + 1}: supersedes must be a string or null`);
      continue;
    }
    const expectedId = recordId(parsed.envelope, supersedes);
    if (raw.record_id !== expectedId) {
      errors.push(`line ${index + 1}: record_id digest mismatch`);
      continue;
    }
    if (byId.has(expectedId)) {
      errors.push(`line ${index + 1}: duplicate record_id ${expectedId}`);
      continue;
    }
    const prior = latestByExecution.get(parsed.envelope.execution_id);
    if (supersedes === null && prior) {
      errors.push(`line ${index + 1}: later execution row must supersede ${prior.record_id}`);
      continue;
    }
    if (supersedes !== null && (!prior || prior.record_id !== supersedes || !byId.has(supersedes))) {
      errors.push(`line ${index + 1}: supersedes does not reference the latest prior row for this execution`);
      continue;
    }
    const row: OutcomeEvidenceLedgerRow = {
      ledger_version: OUTCOME_LEDGER_VERSION,
      record_id: expectedId,
      supersedes,
      envelope: parsed.envelope,
    };
    byId.set(expectedId, row);
    latestByExecution.set(parsed.envelope.execution_id, row);
    rows.push(row);
  }
  return { rows, errors };
}

function latestRows(rows: OutcomeEvidenceLedgerRow[]): Map<string, OutcomeEvidenceLedgerRow> {
  const latest = new Map<string, OutcomeEvidenceLedgerRow>();
  for (const row of rows) latest.set(row.envelope.execution_id, row);
  return latest;
}

function ledgerRow(envelope: OutcomeEnvelope, previous: OutcomeEvidenceLedgerRow | undefined): OutcomeEvidenceLedgerRow {
  const supersedes = previous?.record_id ?? null;
  return {
    ledger_version: OUTCOME_LEDGER_VERSION,
    record_id: recordId(envelope, supersedes),
    supersedes,
    envelope,
  };
}

function loadLedger(path: string): { rows: OutcomeEvidenceLedgerRow[]; errors: string[] } {
  return existsSync(path) ? parseOutcomeLedger(readFileSync(path, "utf8")) : { rows: [], errors: [] };
}

export function readOutcomeEvidenceLedger(path: string): {
  available: boolean;
  rows: OutcomeEvidenceLedgerRow[];
  current: OutcomeEnvelope[];
  errors: string[];
} {
  const available = existsSync(path);
  const ledger = loadLedger(path);
  return {
    available,
    rows: ledger.rows,
    current: [...latestRows(ledger.rows).values()].map((row) => row.envelope),
    errors: ledger.errors,
  };
}

function appendLedgerRows(path: string, rows: OutcomeEvidenceLedgerRow[]): void {
  if (rows.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function terminalEnvelope(
  record: Record<string, unknown>,
  verdicts: VerdictIndex,
  instrumentationStartedAt: string,
  now: string,
): { envelope: OutcomeEnvelope | null; error?: string } {
  const lifecycle = normalizeExecutionLifecycle(record);
  if (!(OUTCOME_TERMINAL_STATES as readonly string[]).includes(lifecycle.state)) return { envelope: null };
  const executionId = text(record.execution_id);
  const ticket = text(record.identifier);
  const startedAt = iso(record.started_at);
  const terminalAt = iso(record.completed_at) ?? iso(record.state_updated_at);
  if (!executionId || !ticket || !startedAt || !terminalAt) {
    return { envelope: null, error: "terminal execution is missing exact identity or lifecycle timestamps" };
  }

  const resolvedExecutor = executorActor(record);
  const executor = resolvedExecutor ?? { id: "unknown-executor", harness: "unknown", model: "unknown" };
  const validClaims = verdicts.valid.get(executionId) ?? [];
  const invalidClaims = verdicts.invalid.get(executionId) ?? [];
  let forcedHold: OutcomeHold | undefined;
  if (validClaims.length > 1) {
    forcedHold = { code: "duplicate", detail: `${validClaims.length} verifier sidecars claim this execution` };
  }

  const preInstrumentation = Date.parse(terminalAt) < Date.parse(instrumentationStartedAt);
  const exclusion = explicitExclusion(record) ?? (preInstrumentation
    ? { code: "pre_instrumentation", reason: `terminal boundary predates ${instrumentationStartedAt}` }
    : undefined);
  const claim = validClaims.length === 1 && invalidClaims.length === 0 && resolvedExecutor
    ? validClaims[0]
    : undefined;
  const resolved = resolveOutcomeEnvelope({
    execution_id: executionId,
    ticket,
    terminal_state: lifecycle.state,
    started_at: startedAt,
    terminal_at: terminalAt,
    recorded_at: now,
    executor,
    commit_digest: directCommitDigest(record),
    verification: claim ? verificationFromClaim(claim) : undefined,
    exclusion,
    ...(exclusion === undefined && forcedHold ? { forced_hold: forcedHold } : {}),
    pull_request: pullRequest(record, lifecycle.state),
    cost: cost(record),
  });
  return resolved.ok === true
    ? { envelope: resolved.envelope }
    : { envelope: null, error: resolved.errors.join("; ") };
}

export function reconcileOutcomeEvidence(options: {
  sources?: Partial<OutcomeEvidenceSources>;
  apply?: boolean;
  now?: string;
  instrumentationStartedAt?: string;
} = {}): OutcomeReconcileReport {
  const projectDir = join(import.meta.dir, "..");
  const stateRoot = factoryStateRoot();
  const sources: OutcomeEvidenceSources = {
    stateDir: options.sources?.stateDir ?? stateRoot,
    evaluationsDir: options.sources?.evaluationsDir ?? join(projectDir, "evaluations"),
    ledgerPath: options.sources?.ledgerPath ?? join(stateRoot, "outcome-evidence-ledger.jsonl"),
  };
  const apply = options.apply ?? false;
  const now = options.now ?? new Date().toISOString();
  const instrumentationStartedAt = options.instrumentationStartedAt ?? DEFAULT_INSTRUMENTATION_START;
  const report: OutcomeReconcileReport = {
    apply,
    scanned: 0,
    terminal: 0,
    measured: 0,
    excluded: 0,
    held_unmeasured: 0,
    appended: 0,
    unchanged: 0,
    superseded: 0,
    write_blocked: false,
    generated: [],
    source_errors: [],
    ledger_errors: [],
  };

  const lockPath = `${sources.ledgerPath}.lock`;
  let lockFd: number | null = null;
  if (apply) {
    mkdirSync(dirname(sources.ledgerPath), { recursive: true });
    try {
      lockFd = openSync(lockPath, "wx");
    } catch (error) {
      report.write_blocked = true;
      report.ledger_errors.push(`reconciliation lock unavailable: ${(error as Error).message}`);
      return report;
    }
  }

  try {
    const ledger = loadLedger(sources.ledgerPath);
    report.ledger_errors.push(...ledger.errors);
    const latest = latestRows(ledger.rows);
    const verdicts = loadVerdictIndex(sources.evaluationsDir);
    report.source_errors.push(...verdicts.errors);

    if (existsSync(sources.stateDir)) {
      for (const file of readdirSync(sources.stateDir).filter(isExecutionRecordFileName).sort()) {
        report.scanned++;
        const path = join(sources.stateDir, file);
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
          report.source_errors.push({ source: path, error: `malformed JSON: ${(error as Error).message}` });
          continue;
        }
        if (!isRecord(raw)) {
          report.source_errors.push({ source: path, error: "execution record must be an object" });
          continue;
        }
        const lifecycle = normalizeExecutionLifecycle(raw);
        if (!(OUTCOME_TERMINAL_STATES as readonly string[]).includes(lifecycle.state)) continue;
        report.terminal++;
        const result = terminalEnvelope(raw, verdicts, instrumentationStartedAt, now);
        if (!result.envelope) {
          report.source_errors.push({
            source: path,
            error: result.error ?? "terminal execution could not be resolved",
            ...(text(raw.execution_id) ? { execution_id: text(raw.execution_id)! } : {}),
          });
          continue;
        }
        report[result.envelope.disposition]++;
        const previous = latest.get(result.envelope.execution_id);
        if (previous && materialId(previous.envelope) === materialId(result.envelope)) {
          report.unchanged++;
          continue;
        }
        const row = ledgerRow(result.envelope, previous);
        if (previous) report.superseded++;
        report.generated.push(row);
        latest.set(result.envelope.execution_id, row);
      }
    }

    if (apply && report.ledger_errors.length > 0) {
      report.write_blocked = true;
      return report;
    }
    if (apply) {
      appendLedgerRows(sources.ledgerPath, report.generated);
      report.appended = report.generated.length;
    }
    return report;
  } finally {
    if (lockFd !== null) {
      closeSync(lockFd);
      unlinkSync(lockPath);
    }
  }
}

if (import.meta.main) {
  const apply = Bun.argv.includes("--apply");
  const report = reconcileOutcomeEvidence({ apply });
  console.log(JSON.stringify(report, null, 2));
  if (report.write_blocked || report.source_errors.length > 0 || report.ledger_errors.length > 0) process.exitCode = 1;
}
