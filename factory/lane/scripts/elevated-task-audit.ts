#!/usr/bin/env bun
/**
 * Append-only audit persistence for elevated tasks (threat-model R7).
 *
 * Layout under a StateDirectory (never the repo worktree):
 *
 *   <state_dir>/                     0700
 *     audit/elevated-audit.jsonl     0600, append-only, hash-chained rows
 *     outputs/<request_id>.log       0600, full redacted output, sha256 in the row
 *
 * Row order follows the operation-journal contract: a `decision` row when a
 * request is classified, an `intent` row before dispatch, an `effect` row after
 * the outcome is known, and a `held` row when the outcome is unknown. Rows are
 * never rewritten. Every row is also emitted as one line on stdout so journald
 * carries the same trail.
 *
 * Secrets never reach this module unredacted: callers pass records through
 * `redactAuditRecord` and outputs through the executor's redaction first; the
 * store redacts again with the same secret set as a belt-and-braces step.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ELEVATED_AUDIT_CONTRACT_ID,
  ELEVATED_SCHEMA_VERSION,
  canonicalJson,
  redactAuditRecord,
  redactSecrets,
  sha256Hex,
  type ElevatedAuditRecord,
  type ExecutionSite,
} from "./elevated-task-contract";

export const AUDIT_ROW_KINDS = ["decision", "approval", "intent", "effect", "held", "rejected", "cancelled"] as const;
export type AuditRowKind = (typeof AUDIT_ROW_KINDS)[number];

export interface PlanGateAuditSummary {
  mode: string;
  action: "proceed" | "hold";
  reason: string;
  ledger_ref: string | null;
}

export interface AuditRowContext {
  execution_site: ExecutionSite | null;
  helper_pid: number | null;
  broker_instance: string | null;
  /** SHA-256 prefix of the credential presented for this row's action; never the credential. */
  actor_fingerprint: string | null;
  /** Edge identity forwarded by tailscale serve, when present. Informational only. */
  edge_identity: string | null;
  plan_gate: PlanGateAuditSummary | null;
  outcome_code: string | null;
  note: string | null;
}

export interface ElevatedAuditRow {
  contract_id: typeof ELEVATED_AUDIT_CONTRACT_ID;
  schema_version: typeof ELEVATED_SCHEMA_VERSION;
  seq: number;
  kind: AuditRowKind;
  at: string;
  request_id: string;
  record: ElevatedAuditRecord;
  context: AuditRowContext;
  prior_row_sha256: string | null;
  row_sha256: string;
}

export const EMPTY_CONTEXT: AuditRowContext = Object.freeze({
  execution_site: null,
  helper_pid: null,
  broker_instance: null,
  actor_fingerprint: null,
  edge_identity: null,
  plan_gate: null,
  outcome_code: null,
  note: null,
});

export function rowHash(row: Omit<ElevatedAuditRow, "row_sha256">): string {
  return sha256Hex(canonicalJson(row));
}

export interface AuditStoreOptions {
  /** Absolute StateDirectory path. Created 0700 if missing. */
  state_dir: string;
  /** Secret values scrubbed from every persisted row and output. */
  secrets?: Iterable<string>;
  /** Line emitter for journald; defaults to console.log. Pass a no-op in tests. */
  emit?: (line: string) => void;
  now?: () => Date;
}

export class ElevatedAuditStore {
  readonly stateDir: string;
  readonly auditPath: string;
  readonly outputsDir: string;
  private readonly secrets: string[];
  private readonly emit: (line: string) => void;
  private readonly now: () => Date;
  private seq = 0;
  private head: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AuditStoreOptions) {
    this.stateDir = options.state_dir;
    this.auditPath = join(options.state_dir, "audit", "elevated-audit.jsonl");
    this.outputsDir = join(options.state_dir, "outputs");
    this.secrets = [...(options.secrets ?? [])];
    this.emit = options.emit ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.stateDir, "audit"), { recursive: true, mode: 0o700 });
    mkdirSync(this.outputsDir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.stateDir, 0o700); } catch {}
    this.recoverHead();
  }

  private recoverHead(): void {
    if (!existsSync(this.auditPath)) return;
    const lines = readFileSync(this.auditPath, "utf8").split("\n").filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (!last) return;
    const row = JSON.parse(last) as ElevatedAuditRow;
    this.seq = row.seq;
    this.head = row.row_sha256;
  }

  get sequence(): number {
    return this.seq;
  }

  get chainHead(): string | null {
    return this.head;
  }

  /** Appends one row, serialised so sequence numbers and the chain stay ordered. */
  append(kind: AuditRowKind, record: ElevatedAuditRecord, context: Partial<AuditRowContext> = {}): Promise<ElevatedAuditRow> {
    let resolved!: (row: ElevatedAuditRow) => void;
    let rejected!: (error: unknown) => void;
    const result = new Promise<ElevatedAuditRow>((resolve, reject) => { resolved = resolve; rejected = reject; });
    this.queue = this.queue.then(() => {
      try {
        resolved(this.appendNow(kind, record, context));
      } catch (error) {
        rejected(error);
      }
    });
    return result;
  }

  private appendNow(kind: AuditRowKind, record: ElevatedAuditRecord, context: Partial<AuditRowContext>): ElevatedAuditRow {
    const redacted = redactAuditRecord(record, this.secrets);
    const fullContext: AuditRowContext = {
      ...EMPTY_CONTEXT,
      ...context,
      note: context.note ? redactSecrets(context.note, this.secrets) : null,
    };
    const body: Omit<ElevatedAuditRow, "row_sha256"> = {
      contract_id: ELEVATED_AUDIT_CONTRACT_ID,
      schema_version: ELEVATED_SCHEMA_VERSION,
      seq: this.seq + 1,
      kind,
      at: this.now().toISOString(),
      request_id: record.request_id,
      record: redacted,
      context: fullContext,
      prior_row_sha256: this.head,
    };
    const row: ElevatedAuditRow = { ...body, row_sha256: rowHash(body) };
    const line = `${JSON.stringify(row)}\n`;
    const fd = openSync(this.auditPath, "a", 0o600);
    try {
      appendFileSync(fd, line, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(this.auditPath, 0o600); } catch {}
    this.seq = row.seq;
    this.head = row.row_sha256;
    this.emit(`[elevated-audit] ${JSON.stringify({
      seq: row.seq,
      kind: row.kind,
      request_id: row.request_id,
      category: row.record.category,
      rule_id: row.record.rule_id,
      detector_verdict: row.record.detector_verdict,
      execution_site: fullContext.execution_site,
      outcome_code: fullContext.outcome_code,
      exit_code: row.record.exit_code,
      duration_ms: row.record.duration_ms,
      output_sha256: row.record.output_sha256,
      row_sha256: row.row_sha256,
    })}`);
    return row;
  }

  /** Persists the full redacted output 0600 and returns its path and hash. */
  writeFullOutput(request_id: string, text: string): { path: string; sha256: string; bytes: number } {
    const redacted = redactSecrets(text, this.secrets);
    const path = join(this.outputsDir, `${request_id}.log`);
    writeFileSync(path, redacted, { mode: 0o600, flag: "wx" });
    try { chmodSync(path, 0o600); } catch {}
    return { path, sha256: sha256Hex(redacted), bytes: Buffer.byteLength(redacted, "utf8") };
  }

  outputPath(request_id: string): string | null {
    const path = join(this.outputsDir, `${request_id}.log`);
    return existsSync(path) ? path : null;
  }

  /** Reads rows for one request, in order. */
  rowsFor(request_id: string): ElevatedAuditRow[] {
    return readAuditRows(this.auditPath).filter((row) => row.request_id === request_id);
  }
}

export function readAuditRows(path: string): ElevatedAuditRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ElevatedAuditRow);
}

export interface ChainVerification {
  ok: boolean;
  rows: number;
  issues: Array<{ seq: number; message: string }>;
  mode: number | null;
}

/** Verifies sequence continuity and the hash chain of an audit file. */
export function verifyAuditChain(path: string): ChainVerification {
  const issues: ChainVerification["issues"] = [];
  const rows = readAuditRows(path);
  let prior: string | null = null;
  rows.forEach((row, index) => {
    const { row_sha256, ...body } = row;
    if (row.seq !== index + 1) issues.push({ seq: row.seq, message: `expected seq ${index + 1}` });
    if (row.prior_row_sha256 !== prior) issues.push({ seq: row.seq, message: "prior hash mismatch" });
    if (rowHash(body) !== row_sha256) issues.push({ seq: row.seq, message: "row hash mismatch" });
    prior = row_sha256;
  });
  let mode: number | null = null;
  try { mode = statSync(path).mode & 0o777; } catch {}
  if (mode !== null && mode !== 0o600) issues.push({ seq: 0, message: `audit file mode ${mode.toString(8)} is not 0600` });
  return { ok: issues.length === 0, rows: rows.length, issues, mode };
}
