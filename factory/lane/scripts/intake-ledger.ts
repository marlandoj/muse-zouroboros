#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-006 T1 — Intake ledger core.
 *
 * Append-only JSONL idempotency record for every ticket's journey through the
 * factory pipeline. One row per stage checkpoint, keyed by
 * (ticket_id, execution_id); the derive-on-read index is rebuilt from the file
 * on every read (latest-row-wins, torn trailing line tolerated) — no in-memory
 * state survives a process boundary, by design.
 *
 * canonicalSeedHash: sorted-key JSON with timestamp/UUID string values
 * stripped before hashing, so "same work, new ticket" collides within the
 * fuzzy-dedup cooldown even when regenerated seeds differ only in ids/dates.
 *
 * CLI:
 *   bun intake-ledger.ts append --ticket <uuid> --identifier <ZOU-nnn> \
 *     --execution <id> --stage <decision|prespec|seed|execute|post-flight|pr> \
 *     [--seed-hash <h>] [--pr <n>] [--branch <name>]
 *   bun intake-ledger.ts index
 *   bun intake-ledger.ts lookup --ticket <uuid-or-identifier>
 *   bun intake-ledger.ts history --ticket <uuid-or-identifier>
 *
 * Exit codes: 0 ok · 1 error · 2 usage.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export const LEDGER_STAGES = ["decision", "prespec", "seed", "execute", "evidence-blocked", "post-flight", "pr"] as const;
export type LedgerStage = (typeof LEDGER_STAGES)[number];

export interface LedgerFlags {
  dedup: boolean;
  enforce: boolean;
}

export interface LedgerRow {
  ticket_id: string; // Linear issue UUID
  identifier: string; // ZOU-nnn
  execution_id: string;
  stage: LedgerStage;
  seed_hash: string | null;
  pr_number: number | null;
  branch_name: string | null;
  ts: string;
  flags: LedgerFlags;
}

export interface LedgerIndex {
  /** Latest row per (ticket_id, execution_id) — file order is append order. */
  byExecution: Map<string, LedgerRow>;
  /** Latest row per ticket_id across all executions. */
  latestByTicket: Map<string, LedgerRow>;
  /** All parseable rows per canonical seed hash (fuzzy-dedup layer input). */
  bySeedHash: Map<string, LedgerRow[]>;
  rows: LedgerRow[];
  torn_lines: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function ledgerPath(): string {
  return (
    resolveFactoryStateOverride(process.env.SF006_LEDGER_PATH, "intake-ledger.jsonl")
  );
}

export function currentFlags(): LedgerFlags {
  return {
    dedup: process.env.SF006_DEDUP !== "0", // default ON (shadow log-only)
    enforce: process.env.SF006_ENFORCE === "1", // default OFF (operator-only)
  };
}

export function executionKey(ticketId: string, executionId: string): string {
  return `${ticketId}::${executionId}`;
}

// ─── Canonical seed hash ──────────────────────────────────────────────────────

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isVolatileString(value: unknown): boolean {
  return typeof value === "string" && (ISO_TIMESTAMP_RE.test(value) || UUID_RE.test(value));
}

/** Deep transform: sort object keys, drop timestamp/UUID string values. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((v) => !isVolatileString(v)).map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => !isVolatileString(v))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * sha256 of the canonical form. Two seeds that differ only in generated
 * ids/timestamps hash identically (sorted keys at every level — same equality
 * discipline as factory-collect canonical(), cg-1782992189510-md0ox1).
 */
export function canonicalSeedHash(seed: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(seed))).digest("hex");
}

/**
 * Stable identity of a ticket's *authored intent* (title + description).
 * ZOU-437 speculative pre-spec stamps this into a cached seed at generation
 * time; the conveyor consume-guard re-derives it at pull and refuses any cached
 * seed whose stamp no longer matches — i.e. the ticket was re-scoped after the
 * seed was pre-generated. Single source of truth so producer (prespec-runner)
 * and consumer (swarm-exec) can never drift into a false match. Hand-authored
 * seeds carry no stamp and are trusted unchanged.
 */
export function sourceHash(title: string, description: string): string {
  return createHash("sha256").update(`${title}\n${description}`).digest("hex");
}

// ─── Append ───────────────────────────────────────────────────────────────────

export interface AppendInput {
  ticket_id: string;
  identifier: string;
  execution_id: string;
  stage: LedgerStage;
  seed_hash?: string | null;
  pr_number?: number | null;
  branch_name?: string | null;
  ts?: string;
  flags?: LedgerFlags;
}

export function appendRow(input: AppendInput, path: string = ledgerPath()): LedgerRow {
  if (!input.ticket_id || !input.identifier || !input.execution_id) {
    throw new Error(
      `ledger append requires ticket_id, identifier, execution_id (got ${JSON.stringify({
        ticket_id: input.ticket_id,
        identifier: input.identifier,
        execution_id: input.execution_id,
      })})`,
    );
  }
  if (!LEDGER_STAGES.includes(input.stage)) {
    throw new Error(`ledger stage invalid: "${input.stage}" (${LEDGER_STAGES.join("|")})`);
  }
  const row: LedgerRow = {
    ticket_id: input.ticket_id,
    identifier: input.identifier,
    execution_id: input.execution_id,
    stage: input.stage,
    seed_hash: input.seed_hash ?? null,
    pr_number: input.pr_number ?? null,
    branch_name: input.branch_name ?? null,
    ts: input.ts ?? new Date().toISOString(),
    flags: input.flags ?? currentFlags(),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  return row;
}

// ─── Derive-on-read index ─────────────────────────────────────────────────────

function isLedgerRow(v: unknown): v is LedgerRow {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ticket_id === "string" &&
    typeof r.identifier === "string" &&
    typeof r.execution_id === "string" &&
    typeof r.stage === "string" &&
    LEDGER_STAGES.includes(r.stage as LedgerStage)
  );
}

export function deriveIndex(path: string = ledgerPath()): LedgerIndex {
  const index: LedgerIndex = {
    byExecution: new Map(),
    latestByTicket: new Map(),
    bySeedHash: new Map(),
    rows: [],
    torn_lines: 0,
  };
  if (!existsSync(path)) return index;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    let row: LedgerRow;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isLedgerRow(parsed)) {
        index.torn_lines++;
        continue;
      }
      row = parsed;
    } catch {
      // appendFileSync is not atomic — a torn trailing line must never make
      // the whole ledger unreadable (SF-003 lesson)
      index.torn_lines++;
      continue;
    }
    index.rows.push(row);
    index.byExecution.set(executionKey(row.ticket_id, row.execution_id), row);
    index.latestByTicket.set(row.ticket_id, row);
    if (row.seed_hash) {
      const bucket = index.bySeedHash.get(row.seed_hash) ?? [];
      bucket.push(row);
      index.bySeedHash.set(row.seed_hash, bucket);
    }
  }
  return index;
}

/** Resolve --ticket by UUID or ZOU-nnn identifier. */
export function resolveTicket(index: LedgerIndex, ref: string): LedgerRow[] {
  return index.rows.filter((r) => r.ticket_id === ref || r.identifier === ref);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    [
      "usage:",
      "  intake-ledger.ts append --ticket <uuid> --identifier <ZOU-nnn> --execution <id>",
      `    --stage <${LEDGER_STAGES.join("|")}> [--seed-hash <h>] [--pr <n>] [--branch <name>]`,
      "  intake-ledger.ts index",
      "  intake-ledger.ts lookup --ticket <uuid-or-identifier>",
      "  intake-ledger.ts history --ticket <uuid-or-identifier>",
    ].join("\n"),
  );
  process.exit(2);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function summarize(row: LedgerRow): string {
  const pr = row.pr_number !== null ? ` pr#${row.pr_number}` : "";
  const branch = row.branch_name ? ` ${row.branch_name}` : "";
  return `${row.identifier} exec=${row.execution_id} stage=${row.stage}${pr}${branch} @ ${row.ts}`;
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "append": {
      const ticket = flagValue(args, "--ticket");
      const identifier = flagValue(args, "--identifier");
      const execution = flagValue(args, "--execution");
      const stage = flagValue(args, "--stage");
      if (!ticket || !identifier || !execution || !stage) usage();
      const prRaw = flagValue(args, "--pr");
      const prNumber = prRaw !== undefined ? Number.parseInt(prRaw, 10) : null;
      if (prNumber !== null && Number.isNaN(prNumber)) {
        throw new Error(`--pr must be a number (got "${prRaw}")`);
      }
      const row = appendRow({
        ticket_id: ticket,
        identifier,
        execution_id: execution,
        stage: stage as LedgerStage,
        seed_hash: flagValue(args, "--seed-hash") ?? null,
        pr_number: prNumber,
        branch_name: flagValue(args, "--branch") ?? null,
      });
      console.log(`appended: ${summarize(row)}`);
      break;
    }
    case "index": {
      const index = deriveIndex();
      console.log(
        `ledger: ${index.rows.length} rows · ${index.latestByTicket.size} tickets · ` +
          `${index.byExecution.size} executions · ${index.bySeedHash.size} seed hashes · ` +
          `${index.torn_lines} torn lines skipped`,
      );
      for (const row of index.latestByTicket.values()) console.log(`  ${summarize(row)}`);
      break;
    }
    case "lookup": {
      const ref = flagValue(args, "--ticket");
      if (!ref) usage();
      const rows = resolveTicket(deriveIndex(), ref);
      if (rows.length === 0) {
        console.error(`no ledger rows for ticket "${ref}"`);
        process.exit(1);
      }
      console.log(summarize(rows[rows.length - 1]));
      break;
    }
    case "history": {
      const ref = flagValue(args, "--ticket");
      if (!ref) usage();
      const rows = resolveTicket(deriveIndex(), ref);
      if (rows.length === 0) {
        console.error(`no ledger rows for ticket "${ref}"`);
        process.exit(1);
      }
      for (const row of rows) console.log(summarize(row));
      break;
    }
    default:
      usage();
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`intake-ledger: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
