#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-007 T4 — Signal intake orchestrator.
 *
 * Per conveyor tick (step 5e): poll adapters → fingerprint/cooldown dedup →
 * pre-file probe → triage → decision. Every decision is appended to
 * state/signal-decisions.jsonl carrying the full source signal + reasoning
 * (audit, AC6). Fail-closed: a probe error parks the signal — never a silent
 * file, never a silent drop (AC5).
 *
 * Autonomy ladder (interview decision 4):
 *   SF007_SIGNALS=0            → tick exits before ANY read/write (AC8)
 *   SF007_AUTOFILE=off         → shadow: would_file logged, ZERO Linear writes
 *   SF007_AUTOFILE=unlabeled   → files ticket WITHOUT factory-ready (human triage)
 *   SF007_AUTOFILE=labeled     → + factory-ready label, priority Urgent for incidents
 *
 * Expedite = ordering only: incidents get Linear priority Urgent and
 * linear-puller sorts urgent-first. Every filed ticket still crosses the
 * SF-001 decision gate and SF-002 classifier (interview decision 3).
 *
 * CLI: bun signal-intake.ts tick [--lookback-hours N]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Sf007Flags,
  type SignalLedgerIndex,
  type SignalRecord,
  appendSignal,
  cooldownActive,
  currentFlags,
  deriveIndex,
  ledgerPath,
  oneLine,
} from "./signal-ledger.ts";
import { type AdapterCtx, defaultCtx, pollAll } from "./signal-adapters.ts";
import {
  FINGERPRINT_MARKER,
  type LlmRunner,
  type TriageOutcome,
  liveRunner,
  renderDescription,
  triageSignal,
} from "./signal-triage.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export const DECISIONS = [
  "would_file",
  "filed",
  "skip_duplicate",
  "park_human_triage",
  "park_probe_failed",
  "cooldown_suppressed",
] as const;
export type Decision = (typeof DECISIONS)[number];

export interface FileProbeResult {
  /** state of the most recent prior ticket carrying this fingerprint marker */
  ticket: "open" | "closed" | "none" | "unknown" | "error";
  ticket_ref: string | null;
  /** state of any PR claimed by that prior ticket (SF-006 intake ledger) */
  pr: "open" | "none" | "unknown" | "error";
}

/** Injected pre-file liveness check (SF-006 pattern) — mocked in selftest. */
export type FileProbe = (fingerprint: string) => Promise<FileProbeResult>;

export interface FiledTicket {
  identifier: string;
}

/** Injected Linear filer — ONLY invoked at autofile rungs, spied in selftest. */
export type TicketFiler = (input: {
  title: string;
  description: string;
  labeled: boolean;
  urgent: boolean;
}) => Promise<FiledTicket>;

export interface SignalDecision {
  fingerprint: string;
  source: string;
  signal_class: string;
  decision: Decision;
  ticket_identifier: string | null;
  reason: string;
  acted: boolean;
  triage_reasoning: string | null;
  park_reason: string | null;
  summary: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface TickOptions {
  ctx: AdapterCtx;
  flags: Sf007Flags;
  now: Date;
  probe: FileProbe;
  runner: LlmRunner;
  filer: TicketFiler;
  ledgerPath: string;
  decisionsPath: string;
}

export interface TickReport {
  polled: number;
  decisions: SignalDecision[];
  warnings: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function decisionsPath(): string {
  return (
    resolveFactoryStateOverride(process.env.SF007_DECISIONS_PATH, "signal-decisions.jsonl")
  );
}

// ─── Decision core ────────────────────────────────────────────────────────────

function logDecision(
  path: string,
  signal: SignalRecord,
  decision: Decision,
  fields: Partial<SignalDecision>,
  now: Date,
): SignalDecision {
  const row: SignalDecision = {
    fingerprint: signal.fingerprint,
    source: signal.source,
    signal_class: signal.signal_class,
    decision,
    ticket_identifier: fields.ticket_identifier ?? null,
    reason: oneLine(fields.reason ?? ""),
    acted: fields.acted ?? false,
    triage_reasoning: fields.triage_reasoning ?? null,
    park_reason: fields.park_reason ?? null,
    summary: signal.summary,
    payload: signal.payload,
    ts: now.toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
  return row;
}

/** Park description when triage itself failed — raw signal, honest note. */
function parkDescription(signal: SignalRecord, outcome: TriageOutcome): string {
  if (outcome.description) return outcome.description;
  return [
    `${FINGERPRINT_MARKER} ${signal.fingerprint}`,
    "",
    "## Source Signal",
    `- source: ${signal.source}`,
    `- class: ${signal.signal_class}`,
    `- observed_at: ${signal.observed_at}`,
    `- summary: ${oneLine(signal.summary)}`,
    "```json",
    JSON.stringify(signal.payload, null, 2),
    "```",
    "",
    "## Triage",
    `Auto-triage could not produce a contract-valid draft (${outcome.park_reason}).`,
    "A human needs to shape this ticket before it can be factory-ready.",
  ].join("\n");
}

/**
 * One signal through the full decision sequence. Returns the logged decision.
 * Ledger/probe/triage/filer interactions follow the invariants:
 *   cooldown      → no ledger append (identity already inside window)
 *   skip/park     → sighting append (resets cooldown, keeps hourly ticks cheap)
 *   would_file    → filed row acted=false (shadow evidence trail)
 *   filed         → filed row acted=true with the real identifier
 */
export async function decideSignal(
  signal: SignalRecord,
  index: SignalLedgerIndex,
  opts: TickOptions,
): Promise<SignalDecision> {
  const { flags, now } = opts;

  if (cooldownActive(index, signal.fingerprint, now)) {
    return logDecision(opts.decisionsPath, signal, "cooldown_suppressed", {
      reason: `latest ledger row younger than cooldown window`,
    }, now);
  }

  let probed: FileProbeResult;
  try {
    probed = await opts.probe(signal.fingerprint);
  } catch (err) {
    probed = { ticket: "error", ticket_ref: null, pr: "error" };
    opts.ctx.warnings.push(
      `probe threw for ${signal.fingerprint.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (probed.ticket === "error" || probed.ticket === "unknown" || probed.pr === "error" || probed.pr === "unknown") {
    appendSignal(
      {
        fingerprint: signal.fingerprint,
        source: signal.source,
        signal_class: signal.signal_class,
        kind: "sighting",
        observed_at: signal.observed_at,
        summary: signal.summary,
      },
      opts.ledgerPath,
    );
    return logDecision(opts.decisionsPath, signal, "park_probe_failed", {
      reason: `pre-file probe uncertain (ticket=${probed.ticket}, pr=${probed.pr}) — fail-closed, no filing`,
    }, now);
  }

  if (probed.ticket === "open" || probed.pr === "open") {
    appendSignal(
      {
        fingerprint: signal.fingerprint,
        source: signal.source,
        signal_class: signal.signal_class,
        kind: "sighting",
        observed_at: signal.observed_at,
        summary: signal.summary,
      },
      opts.ledgerPath,
    );
    return logDecision(opts.decisionsPath, signal, "skip_duplicate", {
      reason: `prior work still live (ticket=${probed.ticket}${probed.ticket_ref ? ` ${probed.ticket_ref}` : ""}, pr=${probed.pr})`,
      ticket_identifier: probed.ticket_ref,
    }, now);
  }

  // New (or fully closed-out) signal — triage it.
  const outcome = await triageSignal(signal, opts.runner);

  if (!outcome.ok) {
    if (flags.autofile === "off") {
      appendSignal(
        {
          fingerprint: signal.fingerprint,
          source: signal.source,
          signal_class: signal.signal_class,
          kind: "sighting",
          observed_at: signal.observed_at,
          summary: signal.summary,
        },
        opts.ledgerPath,
      );
      return logDecision(opts.decisionsPath, signal, "park_human_triage", {
        reason: `triage not contract-valid (${outcome.park_reason}${outcome.missing_fields.length ? `: missing ${outcome.missing_fields.join(",")}` : ""}) — shadow, log only`,
        park_reason: outcome.park_reason,
        triage_reasoning: outcome.draft?.reasoning ?? null,
      }, now);
    }
    // Autofile rungs park by filing an UNLABELED ticket — human triage gate.
    const filed = await opts.filer({
      title: outcome.draft?.title || `[signal] ${signal.summary.slice(0, 80)}`,
      description: parkDescription(signal, outcome),
      labeled: false,
      urgent: false,
    });
    appendSignal(
      {
        fingerprint: signal.fingerprint,
        source: signal.source,
        signal_class: signal.signal_class,
        kind: "filed",
        observed_at: signal.observed_at,
        summary: signal.summary,
        ticket_identifier: filed.identifier,
        acted: true,
      },
      opts.ledgerPath,
    );
    return logDecision(opts.decisionsPath, signal, "park_human_triage", {
      reason: `triage not contract-valid (${outcome.park_reason}) — filed unlabeled for human triage`,
      ticket_identifier: filed.identifier,
      acted: true,
      park_reason: outcome.park_reason,
      triage_reasoning: outcome.draft?.reasoning ?? null,
    }, now);
  }

  const description = outcome.description ?? renderDescription(signal, outcome.draft!);

  if (flags.autofile === "off") {
    appendSignal(
      {
        fingerprint: signal.fingerprint,
        source: signal.source,
        signal_class: signal.signal_class,
        kind: "filed",
        observed_at: signal.observed_at,
        summary: signal.summary,
        acted: false,
      },
      opts.ledgerPath,
    );
    return logDecision(opts.decisionsPath, signal, "would_file", {
      reason: `contract-valid draft (confidence ${outcome.draft!.confidence.toFixed(2)}) — shadow, not filed`,
      triage_reasoning: outcome.draft!.reasoning,
    }, now);
  }

  const filed = await opts.filer({
    title: outcome.draft!.title,
    description,
    labeled: flags.autofile === "labeled",
    urgent: flags.autofile === "labeled" && signal.signal_class === "incident",
  });
  appendSignal(
    {
      fingerprint: signal.fingerprint,
      source: signal.source,
      signal_class: signal.signal_class,
      kind: "filed",
      observed_at: signal.observed_at,
      summary: signal.summary,
      ticket_identifier: filed.identifier,
      acted: true,
    },
    opts.ledgerPath,
  );
  return logDecision(opts.decisionsPath, signal, "filed", {
    reason: `auto-filed at rung ${flags.autofile}${signal.signal_class === "incident" && flags.autofile === "labeled" ? " (urgent — expedited lane)" : ""}`,
    ticket_identifier: filed.identifier,
    acted: true,
    triage_reasoning: outcome.draft!.reasoning,
  }, now);
}

// ─── Tick ─────────────────────────────────────────────────────────────────────

export async function tick(opts: TickOptions): Promise<TickReport> {
  // Flag gate FIRST — SF007_SIGNALS=0 must be byte-identical to no SF-007 (AC8).
  if (!opts.flags.signals) {
    return { polled: 0, decisions: [], warnings: [] };
  }
  const signals = pollAll(opts.ctx);
  // One index for the whole batch: cooldown is per-fingerprint and the seen
  // set already blocks same-fingerprint reprocessing, so re-deriving per
  // signal would be pure N+1 I/O (consensus cg-1783006916272-rjg1jg).
  const index = deriveIndex(opts.ledgerPath);
  const seen = new Set<string>();
  const decisions: SignalDecision[] = [];
  for (const signal of signals) {
    if (seen.has(signal.fingerprint)) continue; // in-batch dedup, first wins
    seen.add(signal.fingerprint);
    try {
      decisions.push(await decideSignal(signal, index, opts));
    } catch (err) {
      // One bad signal must never kill the batch. Recovery is safe either
      // way: a pre-append throw leaves no ledger row so the signal re-polls
      // next tick; a post-file throw heals via the pre-file probe
      // (skip_duplicate) or cooldown. Never a silent drop.
      opts.ctx.warnings.push(
        `decide failed for ${signal.fingerprint.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { polled: signals.length, decisions, warnings: opts.ctx.warnings };
}

// ─── Observability snapshot (shadow-validate) ────────────────────────────────

export interface SF007Snapshot {
  signals_enabled: boolean;
  autofile_rung: string;
  ledger_rows: number;
  ledger_fingerprints: number;
  ledger_torn_lines: number;
  signals_by_source: Record<string, number>;
  decisions_total: number;
  decisions_by_type: Record<Decision, number>;
  would_file: number;
  filed_acted: number;
  last_decision: string | null;
}

/** Read-only aggregate over ledger + decision log. Never throws — a typo'd
 *  rung must not take down the whole shadow-validate report. */
export function sf007Snapshot(): SF007Snapshot {
  let rung: string;
  try {
    rung = currentFlags().autofile;
  } catch {
    rung = `INVALID(${process.env.SF007_AUTOFILE})`;
  }
  const index = deriveIndex(ledgerPath());
  const bySource: Record<string, number> = {};
  for (const row of index.rows) bySource[row.source] = (bySource[row.source] ?? 0) + 1;

  const byType = Object.fromEntries(DECISIONS.map((d) => [d, 0])) as Record<Decision, number>;
  let total = 0;
  let wouldFile = 0;
  let filedActed = 0;
  let last: string | null = null;
  const dPath = decisionsPath();
  if (existsSync(dPath)) {
    for (const line of readFileSync(dPath, "utf-8").split("\n")) {
      if (line.trim() === "") continue;
      let row: SignalDecision;
      try {
        row = JSON.parse(line) as SignalDecision;
      } catch {
        continue; // torn trailing line
      }
      if (!DECISIONS.includes(row.decision)) continue;
      total++;
      byType[row.decision]++;
      if (row.decision === "would_file") wouldFile++;
      if (row.acted && (row.decision === "filed" || row.decision === "park_human_triage")) filedActed++;
      last = `${row.decision} ${row.fingerprint.slice(0, 12)} @ ${row.ts}`;
    }
  }
  return {
    signals_enabled: process.env.SF007_SIGNALS !== "0",
    autofile_rung: rung,
    ledger_rows: index.rows.length,
    ledger_fingerprints: index.latest.size,
    ledger_torn_lines: index.torn_lines,
    signals_by_source: bySource,
    decisions_total: total,
    decisions_by_type: byType,
    would_file: wouldFile,
    filed_acted: filedActed,
    last_decision: last,
  };
}

// ─── Real probe + filer (Linear) ──────────────────────────────────────────────

const API = "https://api.linear.app/graphql";
const INTAKE_PROJECT_ID = "b621d7a1-bb3d-4df9-ae11-3034789e204c";
const FACTORY_READY_LABEL = "f4a73851-6c6b-4a19-b397-c2bd62eeb694";

async function gql<T>(query: string, vars: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables: vars }),
    signal: AbortSignal.timeout(15_000), // SF-006 lesson: never hang, fail-closed park
  });
  if (!r.ok) throw new Error(`Linear API ${r.status}`);
  const j = (await r.json()) as { data?: T; errors?: unknown[] };
  if (j.errors?.length) throw new Error(`Linear GQL: ${JSON.stringify(j.errors).slice(0, 300)}`);
  if (!j.data) throw new Error("Linear GQL: empty data");
  return j.data;
}

/** Real probe: search Intake issues for the fingerprint marker; PR state via SF-006 ledger claim.
 *  Errors PROPAGATE — decideSignal's catch parks fail-closed and logs the real
 *  message as a warning (a swallowing catch here made that branch dead and the
 *  failure cause invisible; consensus cg-1783006916272-rjg1jg). */
export function linearProbe(): FileProbe {
  return async (fingerprint) => {
    const data = await gql<{ searchIssues: { nodes: Array<{ identifier: string; state: { type: string } }> } }>(
      `query($term: String!) {
        searchIssues(term: $term, first: 5) {
          nodes { identifier state { type } }
        }
      }`,
      { term: `${FINGERPRINT_MARKER} ${fingerprint}` },
    );
    const nodes = data.searchIssues?.nodes ?? [];
    if (nodes.length === 0) return { ticket: "none", ticket_ref: null, pr: "none" };
    const open = nodes.find((n) => !["completed", "canceled"].includes(n.state.type));
    if (open) return { ticket: "open", ticket_ref: open.identifier, pr: "none" };
    // All prior tickets closed — live-verify any PR claim in the SF-006
    // intake ledger via the shared dedup-gate probe (AC5: shares SF-006).
    const { deriveIndex: deriveIntakeIndex } = await import("./intake-ledger.ts");
    const { realProbe } = await import("./dedup-gate.ts");
    const prProbe = realProbe();
    const intake = deriveIntakeIndex();
    for (const n of nodes) {
      for (const row of intake.rows) {
        if (row.identifier === n.identifier && row.pr_number !== null && row.stage === "pr") {
          const prState = await prProbe("pr", String(row.pr_number));
          if (prState === "open") return { ticket: "closed", ticket_ref: n.identifier, pr: "open" };
          if (prState === "error" || prState === "unknown") {
            return { ticket: "closed", ticket_ref: n.identifier, pr: "unknown" };
          }
          // merged/closed — prior work fully landed or abandoned, proceed
        }
      }
    }
    return { ticket: "closed", ticket_ref: nodes[0].identifier, pr: "none" };
  };
}

/** Real filer: issueCreate in the Intake project (team resolved from project). */
export function linearFiler(): TicketFiler {
  let teamId: string | null = null;
  return async ({ title, description, labeled, urgent }) => {
    if (!teamId) {
      const data = await gql<{ project: { teams: { nodes: Array<{ id: string }> } } }>(
        `query($id: String!) { project(id: $id) { teams { nodes { id } } } }`,
        { id: INTAKE_PROJECT_ID },
      );
      teamId = data.project?.teams?.nodes?.[0]?.id ?? null;
      if (!teamId) throw new Error("could not resolve Intake project team");
    }
    const input: Record<string, unknown> = {
      teamId,
      projectId: INTAKE_PROJECT_ID,
      title,
      description,
    };
    if (labeled) input.labelIds = [FACTORY_READY_LABEL];
    if (urgent) input.priority = 1;
    const data = await gql<{ issueCreate: { success: boolean; issue: { identifier: string } } }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { identifier } }
      }`,
      { input },
    );
    if (!data.issueCreate?.success) throw new Error("issueCreate failed");
    return { identifier: data.issueCreate.issue.identifier };
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "tick") {
    console.error("usage: signal-intake.ts tick [--lookback-hours N]");
    process.exit(2);
  }
  const flags = currentFlags();
  if (!flags.signals) {
    // Exit before ANY read/write — flags-off byte-identity (AC8).
    process.exit(0);
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
  const report = await tick({
    ctx,
    flags,
    now: new Date(),
    probe: linearProbe(),
    runner: liveRunner(),
    filer: linearFiler(),
    ledgerPath: ledgerPath(),
    decisionsPath: decisionsPath(),
  });
  const byDecision: Record<string, number> = {};
  for (const d of report.decisions) byDecision[d.decision] = (byDecision[d.decision] ?? 0) + 1;
  console.log(
    `[sf007] polled=${report.polled} decisions=${JSON.stringify(byDecision)} ` +
      `rung=${flags.autofile} warnings=${report.warnings.length}`,
  );
  for (const w of report.warnings) console.log(`  warn: ${w}`);
}
