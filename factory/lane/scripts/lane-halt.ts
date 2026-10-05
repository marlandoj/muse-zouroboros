#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FH-07 (P0-7) — Halt the lane after a repeated deterministic error.
 *
 * The ZBRE run let one malformed `LINEUP_ROLE_CHAINS` value propagate through
 * ZOU-929, ZOU-930, ZOU-931 and ZOU-933. Nothing noticed that the *same* defect
 * had already failed a previous ticket, so each successor inherited it.
 *
 * The rule: two occurrences of the same deterministic fingerprint within one
 * project pause that project's lane. Provider flakiness never counts — only
 * classes `failure-policy.ts` marks deterministic (`repair` disposition and
 * `unknown`), because those recur identically until an input changes.
 *
 * State lives on disk, never in the environment. The conveyor issues each step
 * as a separate shell invocation, so an exported variable is lost between
 * steps; a sentinel file is the only carrier that survives (the same reason
 * `auto-rollback.ts` writes `state/sf010-circuit-open.sentinel`).
 *
 * Consumers (reachability):
 *   - `project-preflight.ts` refuses to promote while a halt is open.
 *   - `conveyor-smoke-test.ts` reports halt status as a smoke step.
 *   - CLI: `bun lane-halt.ts status|record|clear`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { classifyFailure, countsTowardHalt, type FailureVerdict } from "./failure-policy";

const PROJECT_DIR = join(import.meta.dir, "..");

/** Two occurrences of one defect in a project is propagation, not bad luck. */
export const DEFAULT_HALT_THRESHOLD = 2;

export function haltSentinelPath(project: string, base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, `lane-halt-${safeSegment(project)}.sentinel`);
}

export function deterministicLedgerPath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "deterministic-failures.jsonl");
}

/** Project keys transit Linear; never let one escape its path segment. */
function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return safe || "unscoped";
}

export interface DeterministicFailure {
  ts: string;
  project: string;
  ticket: string;
  execution_id: string;
  failure_class: string;
  fingerprint: string;
  subject: string | null;
  rationale: string;
}

export interface HaltState {
  halted: boolean;
  project: string;
  fingerprint: string | null;
  occurrences: number;
  /** Tickets that already hit this defect, oldest first. */
  tickets: string[];
  reason: string;
  halted_at?: string;
}

function readLedger(base = PROJECT_DIR): DeterministicFailure[] {
  const path = deterministicLedgerPath(base);
  if (!existsSync(path)) return [];
  const rows: DeterministicFailure[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as DeterministicFailure;
      // A torn concurrent append must not blind the whole ledger.
      if (row && typeof row.fingerprint === "string" && typeof row.project === "string") rows.push(row);
    } catch {
      // Skip corrupt lines, same tolerance as the flight journal.
    }
  }
  return rows;
}

/**
 * Record one classified failure. Returns the resulting halt state so the caller
 * can stop before promoting a successor. Non-deterministic classes are ignored
 * entirely — they are not evidence of propagation.
 */
export function recordFailure(
  input: {
    project: string;
    ticket: string;
    execution_id: string;
    verdict: FailureVerdict;
  },
  options: { threshold?: number; base?: string; now?: string } = {},
): HaltState {
  const base = options.base ?? PROJECT_DIR;
  const threshold = options.threshold ?? DEFAULT_HALT_THRESHOLD;
  const now = options.now ?? new Date().toISOString();

  if (!countsTowardHalt(input.verdict)) {
    return {
      halted: false,
      project: input.project,
      fingerprint: input.verdict.fingerprint,
      occurrences: 0,
      tickets: [],
      reason: `${input.verdict.failure_class} is not deterministic — does not count toward halt`,
    };
  }

  const row: DeterministicFailure = {
    ts: now,
    project: input.project,
    ticket: input.ticket,
    execution_id: input.execution_id,
    failure_class: input.verdict.failure_class,
    fingerprint: input.verdict.fingerprint,
    subject: input.verdict.subject,
    rationale: input.verdict.rationale,
  };

  mkdirSync(factoryStatePathForProject(base), { recursive: true });
  appendFileSync(deterministicLedgerPath(base), JSON.stringify(row) + "\n");

  return evaluateHalt(input.project, input.verdict.fingerprint, { threshold, base, now, write: true });
}

/**
 * Pure-ish evaluation over the ledger. Idempotent: re-running against the same
 * ledger yields the same verdict, and the sentinel is only written once.
 *
 * Occurrences are deduplicated by ticket. One ticket retrying the same defect
 * is a single occurrence; the halt condition is *propagation to a successor*.
 */
export function evaluateHalt(
  project: string,
  fingerprint: string | null,
  options: { threshold?: number; base?: string; now?: string; write?: boolean } = {},
): HaltState {
  const base = options.base ?? PROJECT_DIR;
  const threshold = options.threshold ?? DEFAULT_HALT_THRESHOLD;
  const now = options.now ?? new Date().toISOString();

  const existing = readHalt(project, base);
  if (existing.halted) return existing;

  const rows = readLedger(base).filter((row) => row.project === project);
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const tickets = groups.get(row.fingerprint) ?? [];
    if (!tickets.includes(row.ticket)) tickets.push(row.ticket);
    groups.set(row.fingerprint, tickets);
  }

  const candidates = fingerprint && groups.has(fingerprint)
    ? [[fingerprint, groups.get(fingerprint)!] as const]
    : [...groups.entries()];
  const breach = candidates.find(([, tickets]) => tickets.length >= threshold);

  if (!breach) {
    const observed = fingerprint ? (groups.get(fingerprint)?.length ?? 0) : 0;
    return {
      halted: false,
      project,
      fingerprint,
      occurrences: observed,
      tickets: fingerprint ? (groups.get(fingerprint) ?? []) : [],
      reason: `no deterministic defect has reached ${threshold} distinct tickets in ${project}`,
    };
  }

  const [breachFingerprint, tickets] = breach;
  const sample = rows.find((row) => row.fingerprint === breachFingerprint);
  const reason = [
    `deterministic defect repeated across ${tickets.length} tickets in ${project}`,
    sample?.subject ? `subject ${sample.subject}` : null,
    sample?.rationale ?? null,
    `tickets: ${tickets.join(", ")}`,
  ].filter(Boolean).join(" — ");

  const state: HaltState = {
    halted: true,
    project,
    fingerprint: breachFingerprint,
    occurrences: tickets.length,
    tickets,
    reason,
    halted_at: now,
  };

  if (options.write !== false) writeHalt(state, base);
  return state;
}

function writeHalt(state: HaltState, base = PROJECT_DIR): void {
  mkdirSync(factoryStatePathForProject(base), { recursive: true });
  writeFileSync(
    haltSentinelPath(state.project, base),
    JSON.stringify({
      ...state,
      reset_instruction: `bun lane-halt.ts clear --project ${state.project} --by <operator>`,
    }, null, 2) + "\n",
  );
}

/** Absent sentinel = not halted. Unreadable sentinel = halted (fail-closed). */
export function readHalt(project: string, base = PROJECT_DIR): HaltState {
  const path = haltSentinelPath(project, base);
  if (!existsSync(path)) {
    return {
      halted: false,
      project,
      fingerprint: null,
      occurrences: 0,
      tickets: [],
      reason: "no halt sentinel present",
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as HaltState;
    if (typeof parsed?.halted !== "boolean") throw new Error("malformed sentinel");
    return { ...parsed, halted: true };
  } catch {
    return {
      halted: true,
      project,
      fingerprint: null,
      occurrences: 0,
      tickets: [],
      reason: "halt sentinel unreadable — fail-closed",
    };
  }
}

export function clearHalt(project: string, operator: string, base = PROJECT_DIR): { cleared: boolean; reason: string } {
  const path = haltSentinelPath(project, base);
  if (!existsSync(path)) return { cleared: false, reason: `lane ${project} is not halted` };
  unlinkSync(path);
  return { cleared: true, reason: `lane ${project} resumed by ${operator} at ${new Date().toISOString()}` };
}

/** Convenience for callers holding a raw error rather than a classified one. */
export function recordRawFailure(
  input: { project: string; ticket: string; execution_id: string; message: string; stage?: string; reason_code?: string | null },
  options: { threshold?: number; base?: string; now?: string } = {},
): HaltState {
  const verdict = classifyFailure({
    message: input.message,
    stage: input.stage ?? null,
    reason_code: input.reason_code ?? null,
  });
  return recordFailure({ ...input, verdict }, options);
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      project: { type: "string" },
      ticket: { type: "string" },
      execution: { type: "string" },
      message: { type: "string" },
      by: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
  });
  const project = String(values.project ?? "").trim();

  if (cmd === "status") {
    if (!project) {
      console.error("Usage: bun lane-halt.ts status --project <key> [--json]");
      process.exit(2);
    }
    const state = evaluateHalt(project, null, { write: false });
    if (values.json) console.log(JSON.stringify(state, null, 2));
    else console.log(state.halted ? `HALTED — ${state.reason}` : `RUNNING — ${state.reason}`);
    process.exit(state.halted ? 1 : 0);
  } else if (cmd === "record") {
    if (!project || !values.ticket || !values.message) {
      console.error("Usage: bun lane-halt.ts record --project <key> --ticket <id> --message <text> [--execution <id>]");
      process.exit(2);
    }
    const state = recordRawFailure({
      project,
      ticket: String(values.ticket),
      execution_id: String(values.execution ?? "unknown"),
      message: String(values.message),
    });
    if (values.json) console.log(JSON.stringify(state, null, 2));
    else console.log(state.halted ? `HALTED — ${state.reason}` : `recorded — ${state.reason}`);
    process.exit(state.halted ? 1 : 0);
  } else if (cmd === "clear") {
    if (!project) {
      console.error("Usage: bun lane-halt.ts clear --project <key> --by <operator>");
      process.exit(2);
    }
    const result = clearHalt(project, String(values.by ?? "operator"));
    console.log(result.reason);
    process.exit(result.cleared ? 0 : 1);
  } else {
    console.log("Usage: bun lane-halt.ts <status|record|clear> --project <key> [--ticket id] [--message text] [--by operator] [--json]");
    process.exit(0);
  }
}
