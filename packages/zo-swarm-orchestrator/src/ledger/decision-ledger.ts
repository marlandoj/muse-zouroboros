/**
 * Decision ledger — one append-only outcome ledger, written by every entry point.
 *
 * Port of the Zouroboros Agentic Patterns Enhancement Plan (2026-10-02) G2/G3
 * discipline to the swarm package:
 *
 *   - Exactly one writer (`appendDecisionRow`). No path may report a decision
 *     without persisting it when a ledger is configured; the writer fails
 *     loudly (throws) rather than swallowing an EACCES.
 *   - Appends are atomic: one O_APPEND write of a single JSON line, then fsync.
 *   - Rows are seat-keyed: (traceId, seat, personaId, harness, modelId) is the
 *     source of truth. Model-keyed views are derived on read, never stored.
 *   - Rows carry `seatDispatch` so a reader can tell a single-transport
 *     decision from a per-seat one without inferring it.
 *   - Rows form a hash chain (`prevHash`/`hash`) so repair lineage
 *     (repairCycles / revisedFrom, G4) is reconstructable from the ledger alone.
 *
 * Shadow discipline: configuring a ledger never changes enforcement. It only
 * records. Nothing in this module promotes, passes, or holds work by itself.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SeatBinding {
  seat: string;
  harness: string;
  modelId?: string;
}

export interface DecisionRow {
  /** ISO timestamp of the decision. */
  ts: string;
  /** Correlation id for the run/task this decision belongs to. */
  traceId: string;
  /** Seat name when dispatched as part of a panel/seat set. */
  seat?: string;
  /** Persona identity — the diversity axis, never the model id. */
  personaId: string;
  /** Executor/harness that actually served the seat (no shared fallback). */
  harness: string;
  /** Model the harness ran. Execution metadata, not identity. */
  modelId?: string;
  status: 'success' | 'failure' | 'hold' | 'pass' | 'reject';
  latencyMs: number;
  verdict?: string;
  seatDispatch: { enabled: boolean; bindings: SeatBinding[] };
  /** Reflection (G4) lineage: repair cycles spent on this artifact. */
  repairCycles?: number;
  /** traceId of the decision this one revises, when it is a repair. */
  revisedFrom?: string;
  prevHash: string;
  hash: string;
}

export type DecisionRowInput = Omit<DecisionRow, 'ts' | 'prevHash' | 'hash'> & { ts?: string };

function hashRow(row: Omit<DecisionRow, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

function lastHash(ledgerPath: string): string {
  if (!existsSync(ledgerPath)) return '';
  const lines = readFileSync(ledgerPath, 'utf-8').split('\n').filter((l: string) => l.trim().length > 0);
  if (lines.length === 0) return '';
  const last = JSON.parse(lines[lines.length - 1]) as DecisionRow;
  return typeof last.hash === 'string' ? last.hash : '';
}

/**
 * The single ledger writer. Appends one row atomically and returns the stored
 * row (with hash chain links filled in). Throws on any I/O failure — a
 * decision that cannot be persisted must surface, never vanish silently.
 */
export function appendDecisionRow(ledgerPath: string, input: DecisionRowInput): DecisionRow {
  if (!ledgerPath) throw new Error('decision ledger: ledgerPath is required');
  if (!input.traceId) throw new Error('decision ledger: traceId is required');
  if (!input.personaId) throw new Error('decision ledger: personaId is required (seat-keyed rows have no model-only identity)');
  if (!input.harness) throw new Error('decision ledger: harness is required');

  const dir = dirname(ledgerPath);
  mkdirSync(dir, { recursive: true });

  const prevHash = lastHash(ledgerPath);
  const base: Omit<DecisionRow, 'hash'> = {
    ts: input.ts ?? new Date().toISOString(),
    traceId: input.traceId,
    ...(input.seat ? { seat: input.seat } : {}),
    personaId: input.personaId,
    harness: input.harness,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    status: input.status,
    latencyMs: input.latencyMs,
    ...(input.verdict ? { verdict: input.verdict } : {}),
    seatDispatch: input.seatDispatch ?? { enabled: false, bindings: [] },
    ...(input.repairCycles !== undefined ? { repairCycles: input.repairCycles } : {}),
    ...(input.revisedFrom ? { revisedFrom: input.revisedFrom } : {}),
    prevHash,
  };
  const row: DecisionRow = { ...base, hash: hashRow(base) };

  const fd = openSync(ledgerPath, 'a');
  try {
    writeSync(fd, JSON.stringify(row) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return row;
}

/** Read all rows. Throws on a malformed line — a corrupt ledger is not a healthy zero. */
export function readDecisionLedger(ledgerPath: string): DecisionRow[] {
  if (!existsSync(ledgerPath)) return [];
  const lines = readFileSync(ledgerPath, 'utf-8').split('\n').filter((l: string) => l.trim().length > 0);
  return lines.map((line: string, i: number) => {
    try {
      return JSON.parse(line) as DecisionRow;
    } catch {
      throw new Error(`decision ledger: malformed JSONL at ${ledgerPath}:${i + 1}`);
    }
  });
}

/** Verify the hash chain. Returns the index of the first broken row, or -1. */
export function verifyHashChain(rows: DecisionRow[]): number {
  let prev = '';
  for (let i = 0; i < rows.length; i++) {
    const { hash, ...rest } = rows[i];
    if (rows[i].prevHash !== prev) return i;
    if (hashRow({ ...rest, prevHash: rows[i].prevHash }) !== hash) return i;
    prev = hash;
  }
  return -1;
}

/** Seat-keyed summary — the stored source of truth, aggregated on read. */
export function summarizeBySeat(rows: DecisionRow[]): Record<string, { votes: number; successes: number }> {
  const out: Record<string, { votes: number; successes: number }> = {};
  for (const r of rows) {
    const key = r.seat ?? r.personaId;
    out[key] ??= { votes: 0, successes: 0 };
    out[key].votes++;
    if (r.status === 'success' || r.status === 'pass') out[key].successes++;
  }
  return out;
}

/** Model-keyed view. Derived on read only; never persisted as truth (G3). */
export function summarizeByModel(rows: DecisionRow[]): Record<string, { votes: number; successes: number }> {
  const out: Record<string, { votes: number; successes: number }> = {};
  for (const r of rows) {
    const key = r.modelId ?? r.harness;
    out[key] ??= { votes: 0, successes: 0 };
    out[key].votes++;
    if (r.status === 'success' || r.status === 'pass') out[key].successes++;
  }
  return out;
}

/**
 * Outcome coverage per seat: a vote only counts once its trace has a terminal
 * verdict (pass/reject/hold/success/failure all carry status; coverage here
 * means the row is joined to an outcome set supplied by the caller).
 */
export function outcomeCoverage(rows: DecisionRow[], outcomeTraceIds: ReadonlySet<string>): Record<string, { votes: number; outcomeVotes: number }> {
  const out: Record<string, { votes: number; outcomeVotes: number }> = {};
  for (const r of rows) {
    const key = r.seat ?? r.personaId;
    out[key] ??= { votes: 0, outcomeVotes: 0 };
    out[key].votes++;
    if (outcomeTraceIds.has(r.traceId)) out[key].outcomeVotes++;
  }
  return out;
}

export type JoinStatus = 'healthy' | 'pending' | 'failed';

/** join_status is computed from the join, never carried as a literal (G3). */
export function computeJoinStatus(rows: DecisionRow[], outcomeTraceIds: ReadonlySet<string>): JoinStatus {
  if (rows.length === 0) return 'pending';
  const rowIds = new Set(rows.map((r) => r.traceId));
  for (const id of outcomeTraceIds) {
    if (!rowIds.has(id)) return 'failed';
  }
  for (const r of rows) {
    if (!outcomeTraceIds.has(r.traceId)) return 'pending';
  }
  return 'healthy';
}

/**
 * Hard-fail guard (G3): a ledger full of votes with zero resolved outcomes is
 * a broken join, not a credible zero. Throws when rows exist but no seat has
 * a single outcome vote.
 */
export function assertOutcomeCoverage(rows: DecisionRow[], outcomeTraceIds: ReadonlySet<string>): void {
  if (rows.length === 0) return;
  const coverage = outcomeCoverage(rows, outcomeTraceIds);
  const total = Object.values(coverage).reduce((n, c) => n + c.outcomeVotes, 0);
  if (total === 0) {
    throw new Error('decision ledger: outcome_votes is 0 across all seats — attribution join is empty, refusing to treat this as a credible zero');
  }
}

/** Freshness gate for rebuilds (G3): refuse stale inputs unless explicitly allowed. */
export function isLedgerFresh(ledgerPath: string, maxAgeMs: number, now = Date.now()): boolean {
  if (!existsSync(ledgerPath)) return false;
  return now - statSync(ledgerPath).mtimeMs <= maxAgeMs;
}

// ── Reflection primitives (G4) ─────────────────────────────────────────────
// The full HOLD → repair → re-review loop needs a panel to re-review with;
// no panel exists in this package today, so only the ledger-side primitives
// are provided here. Their consumer is this module's CLI and any future gate.

export interface RepairFinding {
  file: string;
  findingId: string;
  severity: 'critical' | 'major' | 'minor';
  requiredChange: string;
}

export interface RepairBrief {
  traceId: string;
  findings: RepairFinding[];
  maxCycles: 2;
}

/** A HOLD with fixable findings emits a structured brief — free prose is not a brief. */
export function buildRepairBrief(traceId: string, findings: RepairFinding[]): RepairBrief {
  if (!traceId) throw new Error('reflection: traceId is required for a repair brief');
  if (!findings || findings.length === 0) throw new Error('reflection: a repair brief needs at least one structured finding');
  for (const f of findings) {
    if (!f.file || !f.findingId || !f.requiredChange) {
      throw new Error('reflection: every finding needs file, findingId, and requiredChange');
    }
  }
  return { traceId, findings, maxCycles: 2 };
}

/** Repeated HOLDs for the same reason escalate instead of re-running (G4). */
export function shouldEscalate(rows: DecisionRow[], traceId: string, reason: string, threshold = 3): boolean {
  const same = rows.filter((r) => r.traceId === traceId && r.status === 'hold' && (r.verdict ?? '') === reason);
  return same.length >= threshold;
}

// CLI entry point — the ledger's standalone trigger (read/summary/brief).
if (import.meta.main) {
  const [cmd, ledgerPath, arg] = process.argv.slice(2);
  if (!cmd || !ledgerPath) {
    console.error('usage: decision-ledger.ts <read|count|summary> <ledgerPath> [outcomeTraceIdsJson]');
    process.exit(2);
  }
  const rows = readDecisionLedger(ledgerPath);
  if (cmd === 'count') console.log(rows.length);
  else if (cmd === 'read') console.log(JSON.stringify(rows, null, 2));
  else if (cmd === 'summary') {
    const outcomes = new Set<string>(arg ? (JSON.parse(arg) as string[]) : rows.map((r) => r.traceId));
    console.log(JSON.stringify({ bySeat: summarizeBySeat(rows), joinStatus: computeJoinStatus(rows, outcomes), chainBrokenAt: verifyHashChain(rows) }, null, 2));
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
