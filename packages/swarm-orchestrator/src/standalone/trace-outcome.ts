/**
 * trace-outcome.ts — Learned-credit-assignment outcome capture.
 *
 * Records the DISTANT downstream outcome of a trace (swarm success/failure,
 * eval pass/fail, repair resolution) keyed by trace_id. The reputation system
 * joins these outcomes back to gate-vote participation to compute outcome_credit
 * — credit/blame for distant consequences, not just local agreement.
 *
 * Format (append-only JSONL at ~/.zouroboros/trace-outcomes.jsonl):
 *   { trace_id, outcome: "success"|"failure", source, timestamp, details? }
 *
 * First write per trace_id wins (idempotent on retry — the earliest observed
 * outcome is the ground truth; later replays are dropped).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { parseArgs } from "util";

export function getOutcomesPath(): string {
  return `${process.env.HOME}/.zouroboros/trace-outcomes.jsonl`;
}

export type Outcome = "success" | "failure";

export interface OutcomeRecord {
  trace_id: string;
  outcome: Outcome;
  source: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export function captureOutcome(
  traceId: string | undefined,
  outcome: Outcome,
  source: string,
  details?: Record<string, unknown>
): void {
  if (!traceId) return; // no trace → no credit assignment possible; skip silently
  const outcomesPath = getOutcomesPath();
  if (hasOutcome(traceId, outcomesPath)) return; // first write wins (idempotent on retry)

  mkdirSync(dirname(outcomesPath), { recursive: true });
  const rec: OutcomeRecord = {
    trace_id: traceId,
    outcome,
    source,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {}),
  };
  appendFileSync(outcomesPath, JSON.stringify(rec) + "\n");
}

export function hasOutcome(traceId: string, outcomesPath: string = getOutcomesPath()): boolean {
  return readOutcomes(outcomesPath).has(traceId);
}

export function readOutcomes(outcomesPath: string = getOutcomesPath()): Map<string, OutcomeRecord> {
  const map = new Map<string, OutcomeRecord>();
  if (!existsSync(outcomesPath)) return map;
  const lines = readFileSync(outcomesPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as OutcomeRecord;
      if (rec.trace_id && !map.has(rec.trace_id)) map.set(rec.trace_id, rec); // first wins
    } catch {
      // skip malformed lines
    }
  }
  return map;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean" as const, default: false },
      "trace-id": { type: "string" as const },
      outcome: { type: "string" as const }, // success|failure
      source: { type: "string" as const, default: "manual" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`Usage:
  bun trace-outcome.ts capture --trace-id <id> --outcome success|failure [--source <s>]
  bun trace-outcome.ts list
  bun trace-outcome.ts stats

Capture a downstream outcome keyed by trace_id (idempotent: first write wins).
Reputation.ts joins these to gate votes to compute outcome_credit.`);
    process.exit(0);
  }

  const cmd = positionals[0];

  if (cmd === "list") {
    const m = readOutcomes();
    if (m.size === 0) {
      console.log("(no outcomes recorded yet)");
      return;
    }
    for (const rec of m.values()) {
      console.log(`${rec.timestamp}  ${rec.trace_id}  ${rec.outcome}  [${rec.source}]`);
    }
    return;
  }

  if (cmd === "stats") {
    const m = readOutcomes();
    let s = 0, f = 0;
    for (const r of m.values()) r.outcome === "success" ? s++ : f++;
    console.log(`trace-outcomes: ${m.size} total (${s} success, ${f} failure)`);
    console.log(`path: ${getOutcomesPath()}`);
    return;
  }

  if (cmd === "capture") {
    if (!values["trace-id"] || !values.outcome) {
      console.error("capture requires --trace-id and --outcome (success|failure)");
      process.exit(1);
    }
    if (values.outcome !== "success" && values.outcome !== "failure") {
      console.error("--outcome must be 'success' or 'failure'");
      process.exit(1);
    }
    const before = readOutcomes().size;
    captureOutcome(values["trace-id"], values.outcome as Outcome, values.source);
    const after = readOutcomes().size;
    console.log(after > before ? `captured ${values.outcome} for ${values["trace-id"]}` : `already recorded for ${values["trace-id"]} (first-write-wins)`);
    return;
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch(console.error);
}
