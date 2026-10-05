#!/usr/bin/env bun
/**
 * T4 (SF-P3 / ZOU-435) — Learned Auto-Approval advisory report.
 *
 * Read-only. Reads the approval ledger and prints the per-archetype earned-credit
 * table (which archetypes would qualify for the SF-002 auto-promote lane on their own
 * outcome record). Zero behavior change — this is the operator-facing surface,
 * analogous to agreement-baseline.ts. Enabling enforcement is a separate explicit act
 * (SF002_REPUTATION_ENFORCE, itself gated behind SF002_AUTO_PROMOTE + SF002_ENFORCE).
 *
 * Usage:
 *   bun reputation-report.ts                         # markdown to stdout (live ledger)
 *   bun reputation-report.ts --json                  # JSON table
 *   bun reputation-report.ts --write                 # also write evaluations/reputation-<date>.md
 *   bun reputation-report.ts --ledger <path>         # score an alternate ledger (testing / audit)
 *   bun reputation-report.ts --min-tickets 8 --min-rate 0.9
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LEDGER_PATH, type LedgerEntry } from "./approval-ledger";
import {
  computeReputation,
  formatReputation,
  reputationGate,
  REPUTATION_MIN_RATE,
  REPUTATION_MIN_TICKETS,
  type ReputationOpts,
} from "./reputation-core";

const EVAL_DIR = join(import.meta.dir, "..", "evaluations");

/** Load a ledger file into the latest-row-wins map (mirrors approval-ledger.readLedger). */
export function readLedgerFrom(path: string): Map<string, LedgerEntry> {
  const latest = new Map<string, LedgerEntry>();
  if (!existsSync(path)) return latest;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as LedgerEntry;
    latest.set(entry.verdict.verdict_id, entry);
  }
  return latest;
}

function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      ledger: { type: "string" },
      "min-tickets": { type: "string" },
      "min-rate": { type: "string" },
    },
    strict: false,
  });

  const opts: ReputationOpts = {
    minTickets: values["min-tickets"] ? Number(values["min-tickets"]) : REPUTATION_MIN_TICKETS,
    minRate: values["min-rate"] ? Number(values["min-rate"]) : REPUTATION_MIN_RATE,
  };

  const ledgerPath = (values.ledger as string) ?? LEDGER_PATH;
  const table = computeReputation(readLedgerFrom(ledgerPath));

  if (values.json) {
    const rows = [...table.values()].map((b) => ({ ...b, gate: reputationGate(b.archetype, table, opts) }));
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), opts, ledger: ledgerPath, rows }, null, 2));
  } else {
    console.log(formatReputation(table, opts));
  }

  if (values.write) {
    if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
    const path = join(EVAL_DIR, `reputation-${new Date().toISOString().slice(0, 10)}.md`);
    writeFileSync(path, formatReputation(table, opts) + "\n");
    console.error(`[reputation] written: ${path}`);
  }

  process.exit(0);
}

if (import.meta.main) main();
