#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T2 (SF-012) — Decision Signals: unified misjudgment feedstock
 *
 * One derived stream over the THREE decision-signal sources that actually
 * exist today:
 *   1. classifier_disagreement — SF-011 declared-vs-inferred mismatches
 *      (exec records' archetype.disagreement stamp; previously unlogged).
 *   2. approval_disagreement — SF-002 approval-ledger rows where the
 *      classifier and the operator resolved differently (agreement=false).
 *   3. gate_failure — SF-010 operator-queue rows with failed lane gates.
 *
 * Derivation is PURE; the sources remain authoritative and the ledger at
 * state/decision-signals.jsonl is a re-derivable materialization. Harvest is
 * idempotent by (source, source_key) — re-runs append zero duplicates.
 * Consensus dissent intentionally ships only as an optional verdict-sidecar
 * field (factory-verdict.ts) — per-model votes do not exist and no LLM
 * polling is added here.
 *
 * Usage:
 *   bun decision-signals.ts harvest [--json]   (SF012_SURVIVAL=1 only)
 *   bun decision-signals.ts show [--json]      (SF012_SURVIVAL=1 only)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readLedger, type LedgerEntry } from "./approval-ledger";
import { isExecutionRecordFileName } from "./execution-lifecycle";
import {
  computeSurvivability,
  loadSurvivabilityConfig,
  readFateLedger,
  sf012Flags,
} from "./survivability-core";

// ─── Types ────────────────────────────────────────────────────────────────────

export const SIGNAL_SOURCES = [
  "classifier_disagreement",
  "approval_disagreement",
  "gate_failure",
] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export interface DecisionSignal {
  source: SignalSource;
  /** Unique within its source — idempotency key with it. */
  source_key: string;
  ticket_id: string | null;
  archetype: string | null;
  detail: string;
  ts: string;
}

export function signalKey(s: Pick<DecisionSignal, "source" | "source_key">): string {
  return `${s.source}::${s.source_key}`;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function signalsPath(): string {
  return resolveFactoryStateOverride(process.env.SF012_SIGNALS_PATH, "decision-signals.jsonl");
}

export function operatorQueuePathForSignals(): string {
  return resolveFactoryStateOverride(process.env.SF012_QUEUE_PATH, "operator-queue.jsonl");
}

export function execStateDirForSignals(): string {
  return resolveFactoryStateOverride(process.env.SF012_EXEC_STATE_DIR);
}

// ─── Source shapes (read-only views of other modules' rows) ───────────────────

export interface ExecSignalView {
  execution_id: string;
  ticket_id: string;
  identifier: string | null;
  started_at: string;
  archetype?: { line: string; source: string; fine: string | null; disagreement: boolean };
}

export interface OperatorQueueRow {
  pr_ref: string;
  archetype?: string;
  ts: string;
  reason?: string;
  gates?: Array<{ gate: string; passed: boolean; reason: string }>;
}

// ─── Pure derivation ──────────────────────────────────────────────────────────

export function deriveDecisionSignals(inputs: {
  execs: ExecSignalView[];
  approvals: LedgerEntry[];
  queueRows: OperatorQueueRow[];
}): DecisionSignal[] {
  const signals: DecisionSignal[] = [];

  for (const e of inputs.execs) {
    const a = e.archetype;
    if (a && a.disagreement === true) {
      signals.push({
        source: "classifier_disagreement",
        source_key: e.execution_id,
        ticket_id: e.ticket_id,
        archetype: a.line,
        detail: `declared-vs-inferred mismatch: line=${a.line} source=${a.source}${a.fine ? ` fine=${a.fine}` : ""}`,
        ts: e.started_at,
      });
    }
  }

  for (const entry of inputs.approvals) {
    if (entry.agreement !== false) continue;
    const v = entry.verdict;
    signals.push({
      source: "approval_disagreement",
      source_key: v.verdict_id,
      ticket_id: v.ticket_id,
      archetype: null,
      detail: `classifier tier=${v.tier} (${v.tier === "low" ? "would proceed" : "would hold"}) vs operator ${entry.operator_verdict}`,
      ts: entry.harvested_at ?? entry.appended_at,
    });
  }

  for (const row of inputs.queueRows) {
    for (const gate of row.gates ?? []) {
      if (gate.passed) continue;
      signals.push({
        source: "gate_failure",
        source_key: `${row.pr_ref}:${row.ts}:${gate.gate}`,
        ticket_id: null,
        archetype: row.archetype ?? null,
        detail: `${gate.gate}: ${gate.reason}`,
        ts: row.ts,
      });
    }
  }

  return signals;
}

// ─── Source readers (torn-tolerant, read-only) ────────────────────────────────

export function readExecsForSignals(stateDir = execStateDirForSignals()): ExecSignalView[] {
  const out: ExecSignalView[] = [];
  if (!existsSync(stateDir)) return out;
  for (const f of readdirSync(stateDir).sort()) {
    if (!isExecutionRecordFileName(f)) continue;
    try {
      const rec = JSON.parse(readFileSync(join(stateDir, f), "utf-8")) as ExecSignalView;
      if (typeof rec.execution_id === "string" && rec.execution_id !== "") out.push(rec);
    } catch {
      // torn exec file: skip
    }
  }
  return out;
}

export function readOperatorQueue(path = operatorQueuePathForSignals()): OperatorQueueRow[] {
  const out: OperatorQueueRow[] = [];
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as OperatorQueueRow;
      if (typeof row.pr_ref === "string" && typeof row.ts === "string") out.push(row);
    } catch {
      // torn line: skip
    }
  }
  return out;
}

export interface SignalLedger {
  records: DecisionSignal[];
  torn_lines: number;
}

export function readSignals(path = signalsPath()): SignalLedger {
  const out: SignalLedger = { records: [], torn_lines: 0 };
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as DecisionSignal;
      if (
        (SIGNAL_SOURCES as readonly string[]).includes(s.source) &&
        typeof s.source_key === "string" &&
        s.source_key !== ""
      ) {
        out.records.push(s);
      } else {
        out.torn_lines++;
      }
    } catch {
      out.torn_lines++;
    }
  }
  return out;
}

// ─── Harvest (idempotent by (source, source_key)) ─────────────────────────────

export interface SignalHarvestSummary {
  derived: number;
  appended: number;
  duplicates: number;
  by_source: Record<SignalSource, number>;
}

export function harvestSignals(derived: DecisionSignal[], path = signalsPath()): SignalHarvestSummary {
  const existing = new Set(readSignals(path).records.map(signalKey));
  const summary: SignalHarvestSummary = {
    derived: derived.length,
    appended: 0,
    duplicates: 0,
    by_source: { classifier_disagreement: 0, approval_disagreement: 0, gate_failure: 0 },
  };
  const fresh: DecisionSignal[] = [];
  for (const s of derived) {
    const key = signalKey(s);
    if (existing.has(key)) {
      summary.duplicates++;
      continue;
    }
    existing.add(key); // in-batch dedup too
    fresh.push(s);
    summary.appended++;
    summary.by_source[s.source]++;
  }
  if (fresh.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, fresh.map((s) => JSON.stringify(s)).join("\n") + "\n");
  }
  return summary;
}

export function gatherAndHarvest(path = signalsPath()): SignalHarvestSummary {
  // SF012_APPROVAL_LEDGER_PATH mirrors the other SF012_* input overrides so the
  // selftest can sandbox this source too — bare readLedger() reads live state.
  const approvalLedgerPath = resolveFactoryStateOverride(process.env.SF012_APPROVAL_LEDGER_PATH, "approval-ledger.jsonl");
  const derived = deriveDecisionSignals({
    execs: readExecsForSignals(),
    approvals: [...readLedger(approvalLedgerPath).values()],
    queueRows: readOperatorQueue(),
  });
  return harvestSignals(derived, path);
}

// ─── Observability (SF-012 snapshot for shadow-validate) ─────────────────────

export interface SF012Snapshot {
  flag_survival: boolean;
  flag_feedback: boolean;
  config_source: "file" | "defaults" | "invalid";
  config_hash: string | null;
  config_error: string | null;
  min_sample: number | null;
  distinct_prs: number;
  by_fate: Record<string, number>;
  fate_torn_lines: number;
  global_sufficient: boolean;
  signals_total: number;
  signals_by_source: Record<string, number>;
  signal_torn_lines: number;
  rubric_governance: { train: number; calibration: number; holdout: number; provenance: number; annotation_coverage: number; drifted: string[] } | null;
}

/** Never throws — corrupt config/ledgers degrade to counted warnings. */
export function sf012Snapshot(): SF012Snapshot {
  const snap: SF012Snapshot = {
    flag_survival: process.env.SF012_SURVIVAL === "1",
    flag_feedback: process.env.SF012_FEEDBACK === "1",
    config_source: "invalid",
    config_hash: null,
    config_error: null,
    min_sample: null,
    distinct_prs: 0,
    by_fate: {},
    fate_torn_lines: 0,
    global_sufficient: false,
    signals_total: 0,
    signals_by_source: {},
    signal_torn_lines: 0,
    rubric_governance: null,
  };
  try {
    const loaded = loadSurvivabilityConfig();
    snap.config_source = loaded.source;
    snap.config_hash = loaded.hash;
    snap.min_sample = loaded.config.min_sample;
    try {
      const ledger = readFateLedger();
      const report = computeSurvivability(ledger.records, loaded.config, ledger.torn_lines);
      snap.distinct_prs = report.distinct_prs;
      snap.fate_torn_lines = report.torn_lines;
      snap.global_sufficient = !report.global.insufficient_data;
      snap.by_fate = {
        survived: report.global.survived,
        reverted: report.global.reverted,
        hotfixed: report.global.hotfixed,
      };
    } catch {
      // fate ledger unreadable: zero counts stand
    }
  } catch (err) {
    snap.config_error = err instanceof Error ? err.message : String(err);
  }
  try {
    const ledger = readSignals();
    snap.signals_total = ledger.records.length;
    snap.signal_torn_lines = ledger.torn_lines;
    for (const s of ledger.records) {
      snap.signals_by_source[s.source] = (snap.signals_by_source[s.source] ?? 0) + 1;
    }
  } catch {
    // signals ledger unreadable: zero counts stand
  }
  try {
    const governancePath = process.env.CONSENSUS_COHORT_MANIFEST_PATH || join(
      PROJECT_DIR, "..", "..", "Skills", "consensus-gate", "data", "calibration", "cohort-manifests.v1.json",
    );
    if (existsSync(governancePath)) {
      const governance = JSON.parse(readFileSync(governancePath, "utf8")) as any;
      snap.rubric_governance = {
        train: governance.manifests?.train?.case_count ?? 0,
        calibration: governance.manifests?.calibration?.case_count ?? 0,
        holdout: governance.manifests?.holdout?.case_count ?? 0,
        provenance: Array.isArray(governance.provenance) ? governance.provenance.length : 0,
        annotation_coverage: governance.report?.annotation_coverage ?? 0,
        drifted: Array.isArray(governance.report?.manifests_drifted) ? governance.report.manifests_drifted : [],
      };
    }
  } catch {
    snap.rubric_governance = null;
  }
  return snap;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "harvest" && cmd !== "show") {
    console.error("usage: decision-signals.ts harvest|show [--json]   (requires SF012_SURVIVAL=1)");
    process.exit(2);
  }
  // Flag gate BEFORE any read/write (SF-008/SF-009 precedent).
  if (!sf012Flags().survival) process.exit(0);
  if (cmd === "harvest") {
    const summary = gatherAndHarvest();
    if (rest.includes("--json")) console.log(JSON.stringify(summary, null, 2));
    else
      console.log(
        `[sf012] signal harvest: derived=${summary.derived} appended=${summary.appended} duplicates=${summary.duplicates} (classifier=${summary.by_source.classifier_disagreement} approval=${summary.by_source.approval_disagreement} gates=${summary.by_source.gate_failure})`,
      );
  } else {
    const ledger = readSignals();
    if (rest.includes("--json")) console.log(JSON.stringify(ledger, null, 2));
    else {
      const counts: Record<string, number> = {};
      for (const s of ledger.records) counts[s.source] = (counts[s.source] ?? 0) + 1;
      console.log(
        `[sf012] signals: total=${ledger.records.length}${ledger.torn_lines ? ` torn=${ledger.torn_lines}` : ""} ${Object.entries(counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ") || "(none yet)"}`,
      );
    }
  }
  process.exit(0);
}
