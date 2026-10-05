#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T5 (SF-002) — Hold Notification Path
 *
 * Reads unnotified HoldRecords (state/hold-*.json). Enforce mode only:
 *   high/manual review → emits SMS payload (the [SYS] Factory Conveyor agent sends it)
 *   medium/low→ folded into the conveyor cycle summary table
 * No-op in shadow mode or when there are 0 holds. SMS delivery is acknowledged
 * separately so an interrupted or failed send remains retryable.
 *
 * Usage:
 *   bun hold-notify.ts run                        # process unnotified holds → JSON payload
 *   bun hold-notify.ts table                      # markdown held-items table (for cycle summary)
 *   bun hold-notify.ts ack <execution_id> --channel sms
 *   bun hold-notify.ts release <execution_id> --by <operator> [--note "why"]
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { HoldRecord, PipelineExecution } from "./swarm-exec";
import { normalizeExecutionLifecycle, transitionExecutionLifecycle } from "./execution-lifecycle";
import { releaseFailurePark } from "./failure-fingerprint";
import { writeReleaseGrant } from "./release-grant";

const STATE_DIR = factoryStateRoot();

// ─── Hold I/O ─────────────────────────────────────────────────────────────────

function holdPath(executionId: string, stateDir = STATE_DIR): string {
  return join(stateDir, `hold-${executionId}.json`);
}

export function loadHolds(stateDir = STATE_DIR): HoldRecord[] {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((f) => f.startsWith("hold-") && f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(stateDir, f), "utf-8")) as HoldRecord);
}

function saveHold(hold: HoldRecord, stateDir = STATE_DIR): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(holdPath(hold.execution_id, stateDir), JSON.stringify(hold, null, 2));
}

function loadExec(executionId: string, stateDir = STATE_DIR): PipelineExecution | null {
  const p = join(stateDir, `exec-${executionId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as PipelineExecution;
}

// ─── run: process unnotified holds ────────────────────────────────────────────

export interface NotifyPayload {
  mode: "shadow" | "enforce";
  holds_found: number;
  sms: Array<{ execution_id: string; identifier: string; text: string }>;
  summary: Array<{ execution_id: string; identifier: string; tier: string }>;
}

export interface ProcessHoldsOptions {
  state_dir?: string;
  now?: () => string;
  sms_sender?: (text: string) => void;
}

export interface NotificationAuditRow {
  execution_id: string;
  identifier: string;
  channel: "sms" | "summary";
  attempted_at: string;
  status: "queued" | "delivered" | "failed";
  error: string | null;
}

function notificationEnforced(): boolean {
  return process.env.FACTORY_HOLD_NOTIFY_ENFORCE === "1" || process.env.SF002_ENFORCE === "1";
}

function requiresImmediateNotification(hold: HoldRecord): boolean {
  return hold.tier === "high" || hold.reason === "consensus_manual_review";
}

function auditNotification(stateDir: string, row: NotificationAuditRow): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "hold-notification-attempts.jsonl"), `${JSON.stringify(row)}\n`);
}

export function processHolds(options: ProcessHoldsOptions = {}): NotifyPayload {
  const stateDir = options.state_dir ?? STATE_DIR;
  const timestamp = options.now ?? (() => new Date().toISOString());
  const enforce = notificationEnforced();
  const payload: NotifyPayload = {
    mode: enforce ? "enforce" : "shadow",
    holds_found: 0,
    sms: [],
    summary: [],
  };

  const unnotified = loadHolds(stateDir).filter((h) => h.notified === "none" && h.released_at === null);
  payload.holds_found = unnotified.length;

  // Shadow-parity: never notify in shadow mode (holds in shadow are an anomaly
  // surfaced by shadow-validate, not by SMS).
  if (!enforce || unnotified.length === 0) return payload;

  for (const hold of unnotified) {
    const exec = loadExec(hold.execution_id, stateDir);
    const identifier = exec?.identifier ?? hold.execution_id;
    if (requiresImmediateNotification(hold)) {
      const message = {
        execution_id: hold.execution_id,
        identifier,
        text: hold.reason === "consensus_manual_review"
          ? `[Factory] Manual review required: ${identifier} (${hold.execution_id}). Consensus could not form a responsive quorum. Linear is In Review. Retry or approve with factory-review-recovery.ts.`
          : hold.reason === "diversity_of_thought_review"
            ? `[Factory] Diversity review required: ${identifier} (${hold.execution_id}). Required persona review did not pass. Linear is In Review. Approve only after reviewing dissent, tests, and diff: bun factory-review-recovery.ts approve ${hold.execution_id} --by <you> --note "review evidence"`
            : `[Factory] HIGH-risk hold: ${identifier} (${hold.execution_id}) parked at ${hold.held_at}. Score ${exec?.risk?.score ?? "?"}. Release: bun hold-notify.ts release ${hold.execution_id} --by <you>`,
      };
      payload.sms.push(message);
      const audit: NotificationAuditRow = {
        execution_id: hold.execution_id,
        identifier,
        channel: "sms",
        attempted_at: timestamp(),
        status: options.sms_sender ? "delivered" : "queued",
        error: null,
      };
      try {
        if (options.sms_sender) {
          options.sms_sender(message.text);
          hold.notified = "sms";
        }
      } catch (error) {
        audit.status = "failed";
        audit.error = error instanceof Error ? error.message : String(error);
        payload.sms.pop();
      }
      auditNotification(stateDir, audit);
    } else {
      payload.summary.push({ execution_id: hold.execution_id, identifier, tier: hold.tier });
      hold.notified = "summary";
      auditNotification(stateDir, {
        execution_id: hold.execution_id,
        identifier,
        channel: "summary",
        attempted_at: timestamp(),
        status: "queued",
        error: null,
      });
    }
    saveHold(hold, stateDir);
  }

  return payload;
}

export function acknowledgeNotification(
  executionId: string,
  channel: "sms" | "summary",
  options: Pick<ProcessHoldsOptions, "state_dir" | "now"> = {},
): HoldRecord {
  const stateDir = options.state_dir ?? STATE_DIR;
  const path = holdPath(executionId, stateDir);
  if (!existsSync(path)) throw new Error(`no hold record for ${executionId}`);
  const hold = JSON.parse(readFileSync(path, "utf-8")) as HoldRecord;
  if (hold.notified === channel) return hold;
  if (hold.notified !== "none") {
    throw new Error(`hold ${executionId} already acknowledged via ${hold.notified}`);
  }

  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  hold.notified = channel;
  saveHold(hold, stateDir);
  const exec = loadExec(executionId, stateDir);
  auditNotification(stateDir, {
    execution_id: executionId,
    identifier: exec?.identifier ?? executionId,
    channel,
    attempted_at: timestamp,
    status: "delivered",
    error: null,
  });
  return hold;
}

// ─── table: held-items markdown for the conveyor cycle summary ────────────────

export function heldItemsTable(): string {
  const active = loadHolds().filter((h) => h.released_at === null);
  if (active.length === 0) return "No held executions.";
  const rows = active.map((h) => {
    const exec = loadExec(h.execution_id);
    return `| ${exec?.identifier ?? "?"} | ${h.execution_id} | ${h.tier} | ${h.held_at} | ${h.notified} |`;
  });
  return ["| Ticket | Execution | Tier | Held at | Notified |", "|---|---|---|---|---|", ...rows].join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const cmd = Bun.argv[2];
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(3),
    options: {
      by: { type: "string" },
      note: { type: "string", default: "" },
      channel: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (cmd === "run") {
    const payload = processHolds();
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  if (cmd === "table") {
    console.log(heldItemsTable());
    process.exit(0);
  }

  if (cmd === "ack") {
    const id = positionals[0];
    const channel = values.channel ? String(values.channel) : "";
    if (!id || (channel !== "sms" && channel !== "summary")) {
      console.error("Usage: hold-notify.ts ack <execution_id> --channel <sms|summary>");
      process.exit(2);
    }
    try {
      acknowledgeNotification(id, channel);
      console.log(`acknowledged ${channel} notification for ${id}`);
      process.exit(0);
    } catch (error) {
      console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  }

  if (cmd === "release") {
    const id = positionals[0];
    const by = values.by ? String(values.by) : "";
    if (!id || !by) {
      console.error('Usage: hold-notify.ts release <execution_id> --by <operator> [--note "why"]');
      process.exit(2);
    }
    const p = holdPath(id);
    if (!existsSync(p)) {
      console.error(`FATAL: no hold record for ${id}`);
      process.exit(2);
    }
    const hold = JSON.parse(readFileSync(p, "utf-8")) as HoldRecord;
    if (hold.released_at) {
      console.log(`already released at ${hold.released_at} by ${hold.released_by}`);
      process.exit(0);
    }
    hold.released_by = by;
    hold.released_at = new Date().toISOString();
    saveHold(hold);
    const exec = loadExec(id);
    if (exec) {
      if (hold.reason === "failure_streak") {
        releaseFailurePark(exec.identifier, `release:${id}`, by, { state_dir: STATE_DIR, now: () => hold.released_at! });
      } else {
        const released = transitionExecutionLifecycle(
          normalizeExecutionLifecycle(exec),
          "executing",
          { kind: "operator-release", reference: by, recorded_at: hold.released_at },
          { now: hold.released_at },
        );
        Object.assign(exec, released);
        exec.stage = "executing";
        exec.status = "executing";
        exec.completed_at = null;
        // ZOU-1568: releasing never spawns an executor, so the record is reaped
        // and retried; persist the operator's sign-off so the retry dispatch can
        // consume it instead of re-parking at the SF-002 approval gate. Grants
        // apply only to approval-gate holds — SLO and other gate kinds re-hold.
        const heldEvidence = exec.evidence?.held ?? [];
        if (heldEvidence.some((e) => e.kind === "approval-gate")) {
          const grant = writeReleaseGrant(
            {
              identifier: exec.identifier,
              ticket_id: exec.ticket_id ?? null,
              source_execution_id: id,
              tier: hold.tier,
              granted_by: by,
              note: values.note ? String(values.note) : null,
            },
            STATE_DIR,
          );
          console.log(`release grant written for ${grant.identifier} (tier=${grant.tier}, expires ${grant.expires_at})`);
        }
      }
      exec.result_summary = `${exec.result_summary ?? ""} | released by ${by} at ${hold.released_at}${values.note ? ` — ${values.note}` : ""}`.trim();
      writeFileSync(join(STATE_DIR, `exec-${id}.json`), JSON.stringify(exec, null, 2));
    }
    console.log(`released ${id} by ${by}`);
    process.exit(0);
  }

  console.error("Commands: run | table | ack <execution_id> --channel <sms|summary> | release <execution_id> --by <operator>");
  process.exit(2);
}

if (import.meta.main) main();
