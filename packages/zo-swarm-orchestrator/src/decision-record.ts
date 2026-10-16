/**
 * Decision records — the atomic unit of accountability for the decision factory.
 *
 * Every consequential action in the swarm (an ACP tool permission, an executor
 * dispatch) is proposed, tiered, approved or denied, and recorded. The record
 * exists BEFORE the action can proceed: the enforcement points in
 * `transport/acp-transport.ts` refuse any path that has no record and no tier
 * verdict. Fail closed on any ambiguity.
 *
 * Naming note: this is deliberately distinct from the seat-keyed outcome rows
 * in `ledger/decision-ledger.ts`, which record task outcomes after the fact.
 * This module records authority: who was allowed to do what, decided by whom,
 * under which policy.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Blast-radius classification of a proposed action. */
export type BlastRadius = 'read_only' | 'local_write' | 'network' | 'delegated' | 'destructive';

/**
 * Approval tier. Ordered: auto < delegate < human. Escalation is one-way (up
 * only); see `escalateTier` in approval-tiers.ts.
 */
export type ApprovalTier = 'auto' | 'delegate' | 'human';

/** Terminal verdict for one proposal. There is no third state on the wire. */
export type DecisionOutcome = 'approved' | 'denied';

/** Which lane produced the decision (locked Q4: both are instrumented). */
export type DecisionOrigin = 'swarm' | 'factory';

/**
 * Record verbosity per locked Q4: fine-grained records for swarm tool calls,
 * coarse `delegated` records for factory executor dispatches.
 */
export type DecisionGranularity = 'fine' | 'coarse';

export interface ProposedAction {
  /** What kind of action is being proposed. */
  kind: 'tool_call' | 'executor_dispatch';
  /** Tool title (tool calls) or executor id (dispatches). */
  tool: string;
  /** Concrete target when one exists: a file path, URL, or workdir. */
  target?: string;
  /** One-line human-readable statement of the proposal. */
  summary: string;
  /** Raw tool input, kept for audit; never interpreted by the policy. */
  rawInput?: unknown;
}

export interface DecisionBudgetSnapshot {
  tier: ApprovalTier;
  used: number;
  cap: number;
}

export interface DecisionRecord {
  schema_version: 1;
  decision_id: string;
  /** Persona/seat on whose behalf the action was proposed. */
  actor: string;
  origin: DecisionOrigin;
  granularity: DecisionGranularity;
  /** Tier the proposal was finally evaluated at (after any escalation). */
  tier: ApprovalTier;
  blast_radius: BlastRadius;
  proposed_action: ProposedAction;
  outcome: DecisionOutcome;
  /** Why the outcome is what it is — always present, especially for denials. */
  reason: string;
  /** Authority that decided: 'policy:<version>', 'delegated:<decision_id>', 'human:<name>', or 'fail-closed'. */
  decided_by: string;
  decided_at: string;
  created_at: string;
  /** Dispatch record this tool decision executed under (delegated linkage). */
  parent_decision_id?: string;
  policy_version: string;
  trace_id?: string;
  task_id?: string;
  session_id?: string;
  budget?: DecisionBudgetSnapshot;
  evidence_refs?: string[];
  replay_pointer?: string;
}

/**
 * Event taxonomy. Events narrate a decision's lifecycle; the record carries
 * the verdict. Factory-origin tool permissions (coarse mode) log as events on
 * the parent delegated record instead of full records — except denials, which
 * always produce a durable full record.
 */
export type DecisionEventType =
  | 'proposed'
  | 'tier_assigned'
  | 'escalated'
  | 'approved'
  | 'denied'
  | 'retry_after_denial'
  | 'delegated_child';

export interface DecisionEvent {
  schema_version: 1;
  event_id: string;
  decision_id: string;
  type: DecisionEventType;
  at: string;
  detail?: Record<string, unknown>;
}

export interface DecisionRecordStore {
  /** Persist one record. MUST throw on failure — a lost record denies the action. */
  appendRecord(record: DecisionRecord): void;
  /** Persist one lifecycle event. MUST throw on failure. */
  appendEvent(event: DecisionEvent): void;
  records(): DecisionRecord[];
  events(): DecisionEvent[];
}

/** In-memory store. Appends cannot fail; used when no ledger path is configured. */
export class MemoryDecisionRecordStore implements DecisionRecordStore {
  private _records: DecisionRecord[] = [];
  private _events: DecisionEvent[] = [];

  appendRecord(record: DecisionRecord): void {
    this._records.push(record);
  }

  appendEvent(event: DecisionEvent): void {
    this._events.push(event);
  }

  records(): DecisionRecord[] {
    return [...this._records];
  }

  events(): DecisionEvent[] {
    return [...this._events];
  }
}

type StoredLine =
  | ({ line_kind: 'record' } & DecisionRecord)
  | ({ line_kind: 'event' } & DecisionEvent);

/**
 * Append-only JSONL store. One fsynced O_APPEND write per line (same
 * discipline as ledger/decision-ledger.ts). Any I/O failure throws, and the
 * gate converts that throw into a denial: a decision that cannot be recorded
 * is a decision that does not happen.
 */
export class FileDecisionRecordStore implements DecisionRecordStore {
  constructor(private readonly path: string) {
    if (!path) throw new Error('decision records: store path is required');
  }

  private appendLine(line: StoredLine): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, JSON.stringify(line) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private readLines(): StoredLine[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf-8')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, i) => {
        try {
          return JSON.parse(line) as StoredLine;
        } catch {
          throw new Error(`decision records: malformed JSONL at ${this.path}:${i + 1}`);
        }
      });
  }

  appendRecord(record: DecisionRecord): void {
    this.appendLine({ line_kind: 'record', ...record });
  }

  appendEvent(event: DecisionEvent): void {
    this.appendLine({ line_kind: 'event', ...event });
  }

  records(): DecisionRecord[] {
    return this.readLines()
      .filter((l): l is { line_kind: 'record' } & DecisionRecord => l.line_kind === 'record')
      .map(({ line_kind: _kind, ...record }) => record);
  }

  events(): DecisionEvent[] {
    return this.readLines()
      .filter((l): l is { line_kind: 'event' } & DecisionEvent => l.line_kind === 'event')
      .map(({ line_kind: _kind, ...event }) => event);
  }
}

/** Env var naming the durable JSONL decision-record ledger. */
export const DECISION_RECORDS_ENV = 'ZOUROBOROS_DECISION_RECORDS';

const sharedMemoryStore = new MemoryDecisionRecordStore();

/**
 * Process-wide in-memory store, used when no file ledger is configured.
 * Exported so tests and probes can inspect what the transport recorded.
 */
export function sharedDecisionRecordStore(): MemoryDecisionRecordStore {
  return sharedMemoryStore;
}

/**
 * Resolve the store the enforcement points use: the configured JSONL ledger
 * when `ZOUROBOROS_DECISION_RECORDS` names a path, else the shared in-memory
 * store. There is no "off": every decision is recorded somewhere.
 */
export function resolveDecisionRecordStore(
  env: Record<string, string | undefined> = process.env,
): DecisionRecordStore {
  const path = env[DECISION_RECORDS_ENV]?.trim();
  return path ? new FileDecisionRecordStore(path) : sharedMemoryStore;
}

export function newDecisionEvent(
  decisionId: string,
  type: DecisionEventType,
  detail?: Record<string, unknown>,
): DecisionEvent {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    decision_id: decisionId,
    type,
    at: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
}
