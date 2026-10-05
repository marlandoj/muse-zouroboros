#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readRows, readSentinel } from "./lane-utilization";
import { beginShadowRun, receiptShadowConfig, receiptShadowMode, shadowAuthority, type ShadowWriteResult } from "./run-receipt-shadow";
import type { IntakeTicket, ValidationResult } from "./ticket-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LANE_OPEN_AGE_MS = 60 * 60 * 1000;

export interface FactoryAcceptanceResult {
  mode: "off" | "shadow";
  status: "off" | "recorded" | "held" | "error";
  cycleId: string | null;
  ticketId: string | null;
  operationId: string | null;
  reasonCode: string | null;
}

export interface FactoryAcceptanceOptions {
  ticketsPath: string;
  laneLedgerPath?: string;
  env?: Record<string, string | undefined>;
  now?: () => string;
}

function output(result: ShadowWriteResult, cycleId: string, ticketId: string): FactoryAcceptanceResult {
  if (result.mode === "off") return { mode: "off", status: "off", cycleId: null, ticketId: null, operationId: null, reasonCode: null };
  const status = result.status === "recorded" ? "recorded" : result.status === "error" ? "error" : "held";
  return {
    mode: "shadow",
    status,
    cycleId,
    ticketId,
    operationId: result.operationId,
    reasonCode: "reasonCode" in result ? result.reasonCode ?? null : null,
  };
}

function held(reasonCode: string, cycleId: string | null = null, ticketId: string | null = null): FactoryAcceptanceResult {
  return { mode: "shadow", status: "held", cycleId, ticketId, operationId: null, reasonCode };
}

function oneValidatedTicket(path: string): IntakeTicket {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ValidationResult>;
  if (!Array.isArray(parsed.valid) || parsed.valid.length !== 1) throw new Error("exactly_one_validated_ticket_required");
  const ticket = parsed.valid[0];
  if (!ticket || !UUID.test(ticket.linear_id) || !ticket.identifier?.trim()) throw new Error("validated_ticket_identity_invalid");
  return ticket;
}

export function acceptFactoryShadow(options: FactoryAcceptanceOptions): FactoryAcceptanceResult {
  const env = options.env ?? process.env;
  try {
    if (receiptShadowMode(env) === "off") return { mode: "off", status: "off", cycleId: null, ticketId: null, operationId: null, reasonCode: null };
  } catch {
    return held("receipt_shadow_config_invalid");
  }
  try {
    const config = receiptShadowConfig(env);
    if (!config || config.mode !== "shadow") return held("receipt_shadow_config_invalid");
    const ticket = oneValidatedTicket(options.ticketsPath);
    const cycleId = readSentinel(options.laneLedgerPath);
    if (!cycleId) return held("current_lane_cycle_missing", null, ticket.linear_id);
    const rows = readRows(options.laneLedgerPath).rows.filter((row) => row.cycle_id === cycleId);
    const openRows = rows.filter((row) => row.phase === "open");
    const outcomeRows = rows.filter((row) => row.phase === "outcome");
    if (openRows.length !== 1) return held("lane_open_row_not_unique", cycleId, ticket.linear_id);
    if (outcomeRows.length !== 0) return held("lane_cycle_already_resolved", cycleId, ticket.linear_id);
    const open = openRows[0];
    if (open.ticket_id && open.ticket_id !== ticket.linear_id) return held("lane_ticket_conflict", cycleId, ticket.linear_id);
    const createdAt = open.ts;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) return held("lane_open_timestamp_invalid", cycleId, ticket.linear_id);
    const nowMs = Date.parse((options.now ?? (() => new Date().toISOString()))());
    if (!Number.isFinite(nowMs)) return held("acceptance_clock_invalid", cycleId, ticket.linear_id);
    if (createdMs > nowMs) return held("lane_open_timestamp_future", cycleId, ticket.linear_id);
    if (nowMs - createdMs > MAX_LANE_OPEN_AGE_MS) return held("lane_open_timestamp_stale", cycleId, ticket.linear_id);
    const write = beginShadowRun({
      producerId: "factory-cycle-contract",
      runClass: "factory_execution",
      idempotencyKey: `factory:${cycleId}:${ticket.linear_id}`,
      intent: { cycle_id: cycleId, ticket_id: ticket.linear_id, identifier: ticket.identifier },
      triggerIdentity: config.automation_id,
      authority: shadowAuthority(env),
      observedEffect: {
        adapterKind: "workspace-lane-ledger",
        sideEffectKind: "file_write",
        target: `lane:${cycleId}:factory-accepted`,
        input: { cycle_id: cycleId, ticket_id: ticket.linear_id, identifier: ticket.identifier },
        authorityScope: "observe:workspace",
        source: {
          writer: "factory-cycle-contract",
          eventId: `factory:${cycleId}:${ticket.linear_id}:accepted`,
        },
        evidence: { lane_open_ts: createdAt, durable: true },
      },
      edge: {
        targetId: `factory:${ticket.linear_id}:${cycleId}`,
        expectedState: { cycle_id: cycleId, ticket_id: ticket.linear_id, terminal: true },
        createdAt,
        deadline: new Date(createdMs + 300_000).toISOString(),
      },
    }, env);
    return output(write, cycleId, ticket.linear_id);
  } catch (error) {
    return held(error instanceof Error ? error.message : "factory_acceptance_failed");
  }
}

export function frozenFactoryAutomationDiff(
  runtimeRoot: string,
  activationHash: string,
  effectiveConfigHash: string,
): { environment: string; beforeSwarmExec: string; cycleContract: string; harvester: string } {
  if (!runtimeRoot.startsWith("/home/workspace/.runtime/") || runtimeRoot.includes("\n")) throw new Error("runtime root is invalid");
  if (!/^[0-9a-f]{64}$/.test(activationHash) || !/^[0-9a-f]{64}$/.test(effectiveConfigHash)) throw new Error("activation bindings are invalid");
  return {
    environment: `export FACTORY_RECEIPT_SHADOW_MODE=shadow FACTORY_RECEIPT_SHADOW_AUTOMATION_ID=7760679f-6ac8-461c-a567-43fae21c3eee FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH=${activationHash} FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH=${effectiveConfigHash} FACTORY_RECEIPT_SHADOW_CONFIG_PATH=/home/workspace/.runtime/evidence-substrate/config/run-receipt-shadow-runtime.json`,
    beforeSwarmExec: `bun ${runtimeRoot}/Projects/zouroboros-software-factory/scripts/run-receipt-shadow-accept.ts --tickets \"$VALIDATED_TICKETS\"`,
    cycleContract: `bun ${runtimeRoot}/Projects/zouroboros-software-factory/scripts/cycle-contract.ts --ticket-id \"$LINEAR_ID\" --cycle-id \"$CYCLE_ID\"`,
    harvester: `bun ${runtimeRoot}/Projects/zouroboros-software-factory/scripts/run-receipt-shadow-harvest.ts --max-plans 12`,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      tickets: { type: "string" },
      "lane-ledger": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log("Usage: bun run-receipt-shadow-accept.ts --tickets <validated-ticket-contract.json> [--lane-ledger <path>]");
    process.exit(0);
  }
  const ticketsPath = values.tickets ?? "";
  const result = acceptFactoryShadow({ ticketsPath, laneLedgerPath: values["lane-ledger"] });
  console.log(JSON.stringify(result));
}
