#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-007 T1 — Signal ledger core.
 *
 * Append-only JSONL record of every signal the factory has seen, keyed by
 * fingerprint = sha256(source :: stable-id). Derive-on-read index rebuilt from
 * the file on every read (latest-row-wins per fingerprint, torn trailing line
 * tolerated) — no in-memory state survives a process boundary, by design
 * (SF-006 discipline).
 *
 * Two row kinds:
 *   sighting — an adapter observed the signal (re-polls append nothing new
 *              while a sighting for the same fingerprint is inside cooldown)
 *   filed    — a ticket was created (or would be, in shadow) for the signal;
 *              carries ticket_identifier when acted
 *
 * CLI:
 *   bun signal-ledger.ts append --fingerprint <h> --source <s> --class <c> \
 *     --summary <text> [--kind sighting|filed] [--ticket <ZOU-nnn>]
 *   bun signal-ledger.ts index
 *   bun signal-ledger.ts lookup --fingerprint <h>
 *
 * Exit codes: 0 ok · 1 error · 2 usage.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export const SIGNAL_SOURCES = ["slo-breach", "agent-failure", "inbox"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_CLASSES = ["incident", "feature"] as const;
export type SignalClass = (typeof SIGNAL_CLASSES)[number];

export const ROW_KINDS = ["sighting", "filed"] as const;
export type RowKind = (typeof ROW_KINDS)[number];

/** Normalized signal as emitted by an adapter (T2). */
export interface SignalRecord {
  fingerprint: string;
  source: SignalSource;
  signal_class: SignalClass;
  observed_at: string;
  summary: string;
  payload: Record<string, unknown>;
}

export interface SignalLedgerRow {
  fingerprint: string;
  source: SignalSource;
  signal_class: SignalClass;
  kind: RowKind;
  observed_at: string;
  summary: string;
  ticket_identifier: string | null;
  /** false in shadow — a "filed" row that was only logged, never sent to Linear */
  acted: boolean;
  ts: string;
}

export interface SignalLedgerIndex {
  byFingerprint: Map<string, SignalLedgerRow[]>;
  /** Latest row per fingerprint — file order is append order. */
  latest: Map<string, SignalLedgerRow>;
  rows: SignalLedgerRow[];
  torn_lines: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export const COOLDOWN_HOURS = 72; // SF-006 constant, deliberately shared

export const AUTOFILE_RUNGS = ["off", "unlabeled", "labeled"] as const;
export type AutofileRung = (typeof AUTOFILE_RUNGS)[number];

export interface Sf007Flags {
  signals: boolean;
  autofile: AutofileRung;
}

export function ledgerPath(): string {
  return (
    resolveFactoryStateOverride(process.env.SF007_LEDGER_PATH, "signal-ledger.jsonl")
  );
}

export function currentFlags(): Sf007Flags {
  const rung = process.env.SF007_AUTOFILE || "off";
  if (!AUTOFILE_RUNGS.includes(rung as AutofileRung)) {
    // Fail-loud: a typo'd rung must never silently mean "labeled" — or "off".
    throw new Error(`SF007_AUTOFILE invalid: "${rung}" (${AUTOFILE_RUNGS.join("|")})`);
  }
  return {
    signals: process.env.SF007_SIGNALS !== "0", // default ON (shadow log-only)
    autofile: rung as AutofileRung,
  };
}

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/**
 * Stable identity for a signal: same source + same stable-id always collide,
 * regardless of when the signal is observed. Stable-id choice is the
 * adapter's contract (T2): SLO = rule id + frozen breach line, agent-failure =
 * agent_id + run ts, inbox = message id.
 */
export function signalFingerprint(source: SignalSource, stableId: string): string {
  if (!SIGNAL_SOURCES.includes(source)) {
    throw new Error(`signal source invalid: "${source}" (${SIGNAL_SOURCES.join("|")})`);
  }
  if (!stableId.trim()) throw new Error("signal stable-id must be non-empty");
  return createHash("sha256").update(`${source}::${stableId}`).digest("hex");
}

// ─── Append ───────────────────────────────────────────────────────────────────

export interface AppendSignalInput {
  fingerprint: string;
  source: SignalSource;
  signal_class: SignalClass;
  kind: RowKind;
  observed_at: string;
  summary: string;
  ticket_identifier?: string | null;
  acted?: boolean;
  ts?: string;
}

export function appendSignal(input: AppendSignalInput, path: string = ledgerPath()): SignalLedgerRow {
  if (!input.fingerprint?.trim()) throw new Error("ledger append requires fingerprint");
  if (!SIGNAL_SOURCES.includes(input.source)) {
    throw new Error(`ledger source invalid: "${input.source}" (${SIGNAL_SOURCES.join("|")})`);
  }
  if (!SIGNAL_CLASSES.includes(input.signal_class)) {
    throw new Error(`ledger class invalid: "${input.signal_class}" (${SIGNAL_CLASSES.join("|")})`);
  }
  if (!ROW_KINDS.includes(input.kind)) {
    throw new Error(`ledger kind invalid: "${input.kind}" (${ROW_KINDS.join("|")})`);
  }
  const row: SignalLedgerRow = {
    fingerprint: input.fingerprint,
    source: input.source,
    signal_class: input.signal_class,
    kind: input.kind,
    observed_at: input.observed_at,
    summary: oneLine(input.summary),
    ticket_identifier: input.ticket_identifier ?? null,
    acted: input.acted ?? false,
    ts: input.ts ?? new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  return row;
}

/** Newline/control-char sanitize — SF-005 injection precedent. */
export function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

// ─── Derive-on-read index ─────────────────────────────────────────────────────

function isLedgerRow(v: unknown): v is SignalLedgerRow {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.fingerprint === "string" &&
    typeof r.source === "string" &&
    SIGNAL_SOURCES.includes(r.source as SignalSource) &&
    typeof r.signal_class === "string" &&
    SIGNAL_CLASSES.includes(r.signal_class as SignalClass) &&
    typeof r.kind === "string" &&
    ROW_KINDS.includes(r.kind as RowKind) &&
    typeof r.ts === "string"
  );
}

export function deriveIndex(path: string = ledgerPath()): SignalLedgerIndex {
  const index: SignalLedgerIndex = {
    byFingerprint: new Map(),
    latest: new Map(),
    rows: [],
    torn_lines: 0,
  };
  if (!existsSync(path)) return index;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    let row: SignalLedgerRow;
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
    index.latest.set(row.fingerprint, row);
    const bucket = index.byFingerprint.get(row.fingerprint) ?? [];
    bucket.push(row);
    index.byFingerprint.set(row.fingerprint, bucket);
  }
  return index;
}

// ─── Cooldown + filed-ticket queries ─────────────────────────────────────────

/**
 * True while the most recent row for the fingerprint is younger than the
 * cooldown window — re-triage is suppressed (AC2). Absent fingerprint = no
 * cooldown. Invalid ts on the latest row = treat as inside cooldown
 * (fail toward suppression, never toward duplicate filing).
 */
export function cooldownActive(
  index: SignalLedgerIndex,
  fingerprint: string,
  now: Date,
  hours: number = COOLDOWN_HOURS,
): boolean {
  const latest = index.latest.get(fingerprint);
  if (!latest) return false;
  const t = Date.parse(latest.ts);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t < hours * 3_600_000;
}

/** Latest filed row (acted or shadow) for a fingerprint, if any. */
export function latestFiled(index: SignalLedgerIndex, fingerprint: string): SignalLedgerRow | null {
  const rows = index.byFingerprint.get(fingerprint) ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === "filed") return rows[i];
  }
  return null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    [
      "usage:",
      "  signal-ledger.ts append --fingerprint <h> --source <slo-breach|agent-failure|inbox>",
      "    --class <incident|feature> --summary <text> [--kind sighting|filed] [--ticket <ZOU-nnn>]",
      "  signal-ledger.ts index",
      "  signal-ledger.ts lookup --fingerprint <h>",
    ].join("\n"),
  );
  process.exit(2);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function summarize(row: SignalLedgerRow): string {
  const ticket = row.ticket_identifier ? ` ticket=${row.ticket_identifier}` : "";
  return (
    `${row.fingerprint.slice(0, 12)} ${row.source}/${row.signal_class} ${row.kind}` +
    `${ticket} acted=${row.acted} @ ${row.ts} — ${row.summary.slice(0, 80)}`
  );
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "append": {
      const fingerprint = flagValue(args, "--fingerprint");
      const source = flagValue(args, "--source");
      const signalClass = flagValue(args, "--class");
      const summary = flagValue(args, "--summary");
      if (!fingerprint || !source || !signalClass || !summary) usage();
      const row = appendSignal({
        fingerprint,
        source: source as SignalSource,
        signal_class: signalClass as SignalClass,
        kind: (flagValue(args, "--kind") ?? "sighting") as RowKind,
        observed_at: new Date().toISOString(),
        summary,
        ticket_identifier: flagValue(args, "--ticket") ?? null,
      });
      console.log(`appended: ${summarize(row)}`);
      break;
    }
    case "index": {
      const index = deriveIndex();
      console.log(
        `signal ledger: ${index.rows.length} rows · ${index.latest.size} fingerprints · ` +
          `${index.torn_lines} torn lines skipped`,
      );
      for (const row of index.latest.values()) console.log(`  ${summarize(row)}`);
      break;
    }
    case "lookup": {
      const fingerprint = flagValue(args, "--fingerprint");
      if (!fingerprint) usage();
      const rows = deriveIndex().byFingerprint.get(fingerprint) ?? [];
      if (rows.length === 0) {
        console.error(`no ledger rows for fingerprint "${fingerprint}"`);
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
    console.error(`signal-ledger: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
