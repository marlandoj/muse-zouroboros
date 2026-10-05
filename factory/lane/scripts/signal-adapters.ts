#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-007 T2 — Signal adapters.
 *
 * Extensible SignalAdapter interface: poll(ctx) → SignalRecord[]. All three
 * v1 adapters are PURE FILE READERS — the only tool-driven source (Gmail) is
 * dumped to state/signals-inbox/*.json by the conveyor agent's Gmail step, so
 * scripts stay deterministic and sandbox-testable (interview decision 1).
 *
 * Adapters:
 *   slo-breach     state/slo-status.md ❌ BREACH lines (SF-005 surface; frozen
 *                  line text = stable identity). Absent file = 0 signals.
 *   agent-failure  .zo/agent-runs.jsonl rows with exit_code != 0 inside the
 *                  lookback window. Corrupt rows skipped with a warning count.
 *   inbox          state/signals-inbox/*.json normalized email dumps
 *                  ({message_id, subject, body?, from?, received_at?, class_hint?}).
 *
 * CLI: bun signal-adapters.ts poll [--lookback-hours N]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type SignalRecord,
  type SignalSource,
  signalFingerprint,
  oneLine,
} from "./signal-ledger.ts";
import { classifySignal } from "./signal-triage.ts";

// ─── Adapter contract ─────────────────────────────────────────────────────────

export interface AdapterCtx {
  now: Date;
  lookbackHours: number;
  paths: {
    sloStatusMd: string;
    agentRunsJsonl: string;
    inboxDir: string;
  };
  /** corrupt/unparseable source rows land here as warnings, never crashes */
  warnings: string[];
}

export interface SignalAdapter {
  name: SignalSource;
  poll(ctx: AdapterCtx): SignalRecord[];
}

export const DEFAULT_LOOKBACK_HOURS = 24;

const PROJECT_DIR = join(import.meta.dir, "..");

export function defaultCtx(now: Date = new Date()): AdapterCtx {
  return {
    now,
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    paths: {
      sloStatusMd: resolveFactoryStateOverride(process.env.SF007_SLO_STATUS_PATH, "slo-status.md"),
      agentRunsJsonl:
        process.env.SF007_AGENT_RUNS_PATH || join(PROJECT_DIR, "..", "..", ".zo", "agent-runs.jsonl"),
      inboxDir: resolveFactoryStateOverride(process.env.SF007_INBOX_DIR, "signals-inbox"),
    },
    warnings: [],
  };
}

// ─── slo-breach ───────────────────────────────────────────────────────────────

const BREACH_LINE_RE = /^- \[ \] ❌ BREACH (\S+) — (.+)$/;

export const sloBreachAdapter: SignalAdapter = {
  name: "slo-breach",
  poll(ctx) {
    if (!existsSync(ctx.paths.sloStatusMd)) return []; // SF005_SLO off ⇒ never rendered
    const signals: SignalRecord[] = [];
    for (const line of readFileSync(ctx.paths.sloStatusMd, "utf-8").split("\n")) {
      const m = line.match(BREACH_LINE_RE);
      if (!m) continue;
      const [, sloId, detail] = m;
      // Frozen breach line text is the stable identity (SF-005 freezes
      // value-at-breach, so the line is constant for the breach's lifetime).
      signals.push({
        fingerprint: signalFingerprint("slo-breach", line.trim()),
        source: "slo-breach",
        signal_class: classifySignal("slo-breach"),
        observed_at: ctx.now.toISOString(),
        summary: `SLO breach: ${sloId} — ${oneLine(detail)}`,
        payload: { slo_id: sloId, breach_line: line.trim() },
      });
    }
    return signals;
  },
};

// ─── agent-failure ────────────────────────────────────────────────────────────

interface AgentRunRow {
  ts: string;
  agent_id: string;
  agent_name?: string;
  model?: string;
  exit_code: number;
  duration_ms?: number;
  source?: string;
}

function isAgentRunRow(v: unknown): v is AgentRunRow {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.ts === "string" && typeof r.agent_id === "string" && typeof r.exit_code === "number";
}

export const agentFailureAdapter: SignalAdapter = {
  name: "agent-failure",
  poll(ctx) {
    if (!existsSync(ctx.paths.agentRunsJsonl)) return [];
    const cutoff = ctx.now.getTime() - ctx.lookbackHours * 3_600_000;
    const signals: SignalRecord[] = [];
    let corrupt = 0;
    for (const line of readFileSync(ctx.paths.agentRunsJsonl, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      let row: AgentRunRow;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isAgentRunRow(parsed)) {
          corrupt++;
          continue;
        }
        row = parsed;
      } catch {
        corrupt++;
        continue;
      }
      if (row.exit_code === 0) continue;
      const t = Date.parse(row.ts);
      if (Number.isNaN(t) || t < cutoff) continue;
      signals.push({
        fingerprint: signalFingerprint("agent-failure", `${row.agent_id}::${row.ts}`),
        source: "agent-failure",
        signal_class: classifySignal("agent-failure"),
        observed_at: row.ts,
        summary: `agent run failed: ${oneLine(row.agent_name ?? row.agent_id)} exit=${row.exit_code} model=${row.model ?? "?"}`,
        payload: { ...row },
      });
    }
    if (corrupt > 0) ctx.warnings.push(`agent-failure: skipped ${corrupt} corrupt rows`);
    return signals;
  },
};

// ─── inbox ────────────────────────────────────────────────────────────────────

interface InboxDump {
  message_id: string;
  subject: string;
  body?: string;
  from?: string;
  received_at?: string;
  class_hint?: string;
}

function isInboxDump(v: unknown): v is InboxDump {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.message_id === "string" && r.message_id.trim() !== "" && typeof r.subject === "string";
}

export const inboxAdapter: SignalAdapter = {
  name: "inbox",
  poll(ctx) {
    if (!existsSync(ctx.paths.inboxDir)) return [];
    const signals: SignalRecord[] = [];
    for (const name of readdirSync(ctx.paths.inboxDir).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = join(ctx.paths.inboxDir, name);
      let dump: InboxDump;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
        if (!isInboxDump(parsed)) {
          ctx.warnings.push(`inbox: ${name} missing message_id/subject — skipped`);
          continue;
        }
        dump = parsed;
      } catch {
        ctx.warnings.push(`inbox: ${name} unparseable — skipped`);
        continue;
      }
      signals.push({
        fingerprint: signalFingerprint("inbox", dump.message_id),
        source: "inbox",
        signal_class: classifySignal("inbox", dump.class_hint),
        observed_at: dump.received_at ?? ctx.now.toISOString(),
        summary: `inbound report: ${oneLine(dump.subject)}`,
        payload: { ...dump },
      });
    }
    return signals;
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const ALL_ADAPTERS: ReadonlyArray<SignalAdapter> = [
  sloBreachAdapter,
  agentFailureAdapter,
  inboxAdapter,
];

export function pollAll(
  ctx: AdapterCtx,
  adapters: ReadonlyArray<SignalAdapter> = ALL_ADAPTERS,
): SignalRecord[] {
  const out: SignalRecord[] = [];
  for (const adapter of adapters) {
    try {
      out.push(...adapter.poll(ctx));
    } catch (err) {
      // One broken source must never take down the whole poll (AC1).
      ctx.warnings.push(`${adapter.name}: poll failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "poll") {
    console.error("usage: signal-adapters.ts poll [--lookback-hours N]");
    process.exit(2);
  }
  const ctx = defaultCtx();
  const lb = args.indexOf("--lookback-hours");
  if (lb >= 0 && args[lb + 1]) {
    const n = Number(args[lb + 1]);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`--lookback-hours invalid: "${args[lb + 1]}"`);
      process.exit(2);
    }
    ctx.lookbackHours = n;
  }
  const signals = pollAll(ctx);
  console.log(JSON.stringify({ signals, warnings: ctx.warnings }, null, 2));
}
