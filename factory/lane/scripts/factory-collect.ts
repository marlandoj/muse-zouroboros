#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T2 (SF-004) — Factory-Log Collector (derive-on-read)
 *
 * Derives one FactoryRecord per unit of factory work from artifacts that
 * ALREADY exist (state/exec-*.json, approval-ledger.jsonl, pool campaigns,
 * seed stamps, verdict sidecars) and appends to state/factory-log.jsonl.
 * Zero new writers in dispatch/hot paths — this is a read-side collector.
 *
 * Idempotent by execution_id: re-collect with no new artifacts appends
 * nothing. When an artifact changes (e.g. a verdict sidecar lands later),
 * a superseding row is appended; reads resolve latest-row-wins.
 *
 * Stage stamps are three-valued and never fabricated:
 *   ISO string  = stage reached at that time
 *   "unknown"   = stage reached, timestamp not recorded (pre-instrumentation)
 *   null        = stage not reached
 *
 * Yield ground truth: `verdict` is copied ONLY from resolveVerdict() sidecar
 * resolution — no self-reported status ever feeds it. measured=false runs can
 * never count as passed.
 *
 * Usage:
 *   bun factory-collect.ts collect [--dry-run]
 *   bun factory-collect.ts tick            # conveyor entry: no-op unless SF004_METRICS=1
 *   bun factory-collect.ts list
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { PipelineExecution } from "./swarm-exec";
import { isExecutionRecordFileName, normalizeExecutionLifecycle } from "./execution-lifecycle";
import { loadCampaigns, type Campaign } from "./pool-queue";
import {
  resolveVerdict,
  listSidecarPaths,
  parseVerdict,
  type Verdict,
} from "./factory-verdict";
import {
  reconcileOutcomeEvidence,
  type OutcomeEvidenceSources,
  type OutcomeReconcileReport,
} from "./outcome-evidence-reconcile";

// ─── Types ────────────────────────────────────────────────────────────────────

export type StageName = "decision" | "seed" | "execute" | "postflight" | "pr";

/** ISO = reached at time; "unknown" = reached, time unknown; null = not reached. */
export type StageStamp = string | null;

export interface FactoryStages {
  decision: StageStamp;
  seed: StageStamp;
  execute: StageStamp;
  postflight: StageStamp;
  pr: StageStamp;
}

export interface FactoryRecord {
  execution_id: string; // exec id, campaign_id, or sidecar id for ticket-level units
  kind: "execution" | "campaign" | "ticket";
  ticket_id: string;
  identifier: string;
  gate_decision: string; // "unknown" when not recorded
  shadow_phase: string | null;
  status: string | null;
  stages: FactoryStages;
  verdict_ref: string | null;
  measured: boolean;
  verdict: { verdict: "pass" | "fail"; rework: boolean } | null; // copied from sidecar ONLY
  cycle_time_hours: number | null;
  /** SF-011 assembly line (coarse). Present ONLY when the exec record was
   * stamped (SF011_LINES on) — absent-field parity keeps pre-SF-011 rows from
   * being superseded by re-collection. */
  archetype?: string;
  /** ZOU-1529 shadow evidence. Present only when swarm-exec attempted the
   * first-pass path, preserving byte-level parity for mode=off executions. */
  first_pass_validation?: {
    mode: "shadow";
    contract_digest: string | null;
    ledger_record_id: string | null;
    verdict: "pass" | "fail" | "flaky" | "held" | null;
    repository: string;
    harness: string;
    validator_version: string;
    errors: number;
  };
  collected_at: string;
}

export interface CollectorSources {
  stateDir: string;
  evaluationsDir: string;
  seedDir: string;
  ledgerPath: string;
  logPath: string;
}

export interface CollectResult {
  appended: FactoryRecord[];
  unchanged: number;
  superseded: number;
  invalid_sidecars: string[];
  warnings: string[];
}

const OUTCOME_EVIDENCE_MODES = ["off", "shadow", "advisory", "bounded_canary", "enforce"] as const;
type OutcomeEvidenceMode = (typeof OUTCOME_EVIDENCE_MODES)[number];

export function collectOutcomeEvidenceForMode(options: {
  mode?: string;
  sources?: Partial<OutcomeEvidenceSources>;
  now?: string;
  instrumentationStartedAt?: string;
} = {}): OutcomeReconcileReport | null {
  const mode = options.mode ?? process.env.OUTCOME_EVIDENCE_MODE ?? "off";
  if (mode === "off") return null;
  if (!(OUTCOME_EVIDENCE_MODES as readonly string[]).includes(mode)) {
    throw new Error(`OUTCOME_EVIDENCE_MODE must be one of ${OUTCOME_EVIDENCE_MODES.join("|")}`);
  }
  return reconcileOutcomeEvidence({
    apply: true,
    ...(options.sources ? { sources: options.sources } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.instrumentationStartedAt ? { instrumentationStartedAt: options.instrumentationStartedAt } : {}),
  });
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function defaultSources(): CollectorSources {
  return {
    stateDir: factoryStateRoot(),
    evaluationsDir: join(PROJECT_DIR, "evaluations"),
    seedDir: PROJECT_DIR,
    ledgerPath: factoryStatePath("approval-ledger.jsonl"),
    logPath: factoryStatePath("factory-log.jsonl"),
  };
}

// ─── Artifact readers (torn-file tolerant — a bad file never aborts collection) ─

function loadExecRecords(
  stateDir: string,
  warnings: string[],
): PipelineExecution[] {
  if (!existsSync(stateDir)) return [];
  const out: PipelineExecution[] = [];
  for (const f of readdirSync(stateDir).sort()) {
    if (!isExecutionRecordFileName(f)) continue;
    const path = join(stateDir, f);
    try {
      const rec = JSON.parse(readFileSync(path, "utf-8")) as PipelineExecution;
      if (typeof rec.execution_id !== "string" || rec.execution_id === "") {
        warnings.push(`skipped ${f}: missing execution_id`);
        continue;
      }
      out.push(rec);
    } catch (e) {
      warnings.push(`skipped ${f}: malformed JSON (${(e as Error).message})`);
    }
  }
  return out;
}

/** execution_id → classified_at, from the approval ledger (latest row wins). */
function loadClassificationTimes(
  ledgerPath: string,
  warnings: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(ledgerPath)) return out;
  for (const line of readFileSync(ledgerPath, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as {
        verdict?: { execution_id?: string; classified_at?: string };
      };
      const execId = row.verdict?.execution_id;
      const at = row.verdict?.classified_at;
      if (typeof execId === "string" && typeof at === "string") out.set(execId, at);
    } catch {
      warnings.push(`approval-ledger: skipped one torn/malformed line`);
    }
  }
  return out;
}

/** Read `created:` stamp from a seed YAML; null if unreadable/absent. */
function seedStamp(seedPath: string): string | null {
  try {
    const m = readFileSync(seedPath, "utf-8").match(/^created:\s*"?([^"\n]+)"?\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Find seed-<slug>-*.yaml for a ticket like "SF-001" → slug "sf001". */
function findTicketSeed(seedDir: string, ticket: string): string | null {
  const slug = ticket.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (slug === "" || !existsSync(seedDir)) return null;
  for (const f of readdirSync(seedDir).sort()) {
    if (f.startsWith(`seed-${slug}-`) && f.endsWith(".yaml")) return join(seedDir, f);
  }
  return null;
}

interface SidecarEntry {
  id: string;
  path: string;
  verdict: Verdict;
}

function loadValidSidecars(
  evaluationsDir: string,
  invalid: string[],
): SidecarEntry[] {
  const out: SidecarEntry[] = [];
  for (const path of listSidecarPaths(evaluationsDir)) {
    try {
      const parsed = parseVerdict(JSON.parse(readFileSync(path, "utf-8")));
      if (parsed.ok) {
        out.push({ id: basename(path).replace(/\.verdict\.json$/, ""), path, verdict: parsed.verdict });
      } else {
        invalid.push(path);
      }
    } catch {
      invalid.push(path);
    }
  }
  return out;
}

// ─── Pure derivation ──────────────────────────────────────────────────────────

function hoursBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round(((to - from) / 3_600_000) * 100) / 100;
}

function cycleTime(stages: FactoryStages): number | null {
  const start = stages.decision !== null && stages.decision !== "unknown"
    ? stages.decision
    : stages.execute !== null && stages.execute !== "unknown"
      ? stages.execute
      : null;
  const end = stages.postflight !== null && stages.postflight !== "unknown"
    ? stages.postflight
    : null;
  if (start === null || end === null) return null;
  return hoursBetween(start, end);
}

function verdictFields(res: ReturnType<typeof resolveVerdict>): Pick<FactoryRecord, "verdict_ref" | "measured" | "verdict"> {
  if (!res.measured) return { verdict_ref: null, measured: false, verdict: null };
  return {
    verdict_ref: res.path,
    measured: true,
    verdict: { verdict: res.verdict.verdict, rework: res.verdict.rework },
  };
}

function deriveExecutionRecord(
  exec: PipelineExecution,
  classifiedAt: Map<string, string>,
  sources: CollectorSources,
  collectedAt: string,
): FactoryRecord {
  // Exec runs resolve sidecars by execution_id ONLY — a ticket-level sidecar
  // (e.g. SF-001's build) must never be claimed by an unrelated exec run.
  const res = resolveVerdict({ executionId: exec.execution_id }, sources.evaluationsDir);
  const lifecycle = normalizeExecutionLifecycle(exec);
  const stages: FactoryStages = {
    decision: classifiedAt.get(exec.execution_id) ?? "unknown", // exec exists ⇒ decision reached
    seed: exec.seed_path ? (seedStamp(join(sources.seedDir, basename(exec.seed_path))) ?? seedStamp(exec.seed_path) ?? "unknown") : null,
    execute: exec.started_at,
    postflight: res.measured ? res.verdict.decided_at : null,
    pr: exec.pr_number !== null ? (exec.completed_at ?? "unknown") : null,
  };
  return {
    execution_id: exec.execution_id,
    kind: "execution",
    ticket_id: exec.ticket_id,
    identifier: exec.identifier,
    gate_decision: exec.gate_decision || "unknown",
    shadow_phase: exec.shadow_phase ?? null,
    status: lifecycle.state,
    stages,
    ...verdictFields(res),
    cycle_time_hours: cycleTime(stages),
    ...(exec.archetype && typeof exec.archetype.line === "string" ? { archetype: exec.archetype.line } : {}),
    ...(exec.first_pass_validation
      ? {
          first_pass_validation: {
            mode: "shadow" as const,
            contract_digest: exec.first_pass_validation.contract_digest,
            ledger_record_id: exec.first_pass_validation.ledger_record_id,
            verdict: exec.first_pass_validation.verdict,
            repository: exec.repo_path ?? "unrecorded",
            harness: exec.executor_harness ?? exec.model_provenance?.harness ?? "unrecorded",
            validator_version: exec.first_pass_validation.validator_version,
            errors: exec.first_pass_validation.errors.length,
          },
        }
      : {}),
    collected_at: collectedAt,
  };
}

function deriveCampaignRecord(
  campaign: Campaign,
  sources: CollectorSources,
  collectedAt: string,
): FactoryRecord {
  const res = resolveVerdict(
    { executionId: campaign.campaign_id, ticket: campaign.identifier },
    sources.evaluationsDir,
  );
  const executeReached = campaign.state !== "active" || campaign.cost_spent_usd > 0;
  const stages: FactoryStages = {
    decision: "unknown", // campaign exists ⇒ dispatch decision reached; time not recorded
    seed: campaign.seed_path ? (seedStamp(campaign.seed_path) ?? "unknown") : null,
    execute: executeReached ? "unknown" : null,
    postflight: res.measured ? res.verdict.decided_at : null,
    pr: null,
  };
  return {
    execution_id: campaign.campaign_id,
    kind: "campaign",
    ticket_id: campaign.ticket_id,
    identifier: campaign.identifier,
    gate_decision: "unknown",
    shadow_phase: null,
    status: campaign.state,
    stages,
    ...verdictFields(res),
    cycle_time_hours: cycleTime(stages),
    collected_at: collectedAt,
  };
}

/** Sidecar-only units (e.g. backfilled SF-001..003 builds) not claimed by any exec/campaign. */
function deriveTicketRecord(
  entry: SidecarEntry,
  sources: CollectorSources,
  collectedAt: string,
): FactoryRecord {
  const seedPath = findTicketSeed(sources.seedDir, entry.verdict.ticket);
  const stages: FactoryStages = {
    decision: "unknown",
    seed: seedPath ? (seedStamp(seedPath) ?? "unknown") : null,
    execute: "unknown", // a decided verdict implies the build ran; time not recorded
    postflight: entry.verdict.decided_at,
    pr: null,
  };
  return {
    execution_id: entry.id,
    kind: "ticket",
    ticket_id: entry.verdict.ticket,
    identifier: entry.verdict.ticket,
    gate_decision: "unknown",
    shadow_phase: null,
    status: null,
    stages,
    verdict_ref: entry.path,
    measured: true,
    verdict: { verdict: entry.verdict.verdict, rework: entry.verdict.rework },
    cycle_time_hours: cycleTime(stages),
    collected_at: collectedAt,
  };
}

export function deriveAll(sources: CollectorSources): {
  records: FactoryRecord[];
  invalid_sidecars: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const invalid_sidecars: string[] = [];
  const collectedAt = new Date().toISOString();

  const execs = loadExecRecords(sources.stateDir, warnings);
  const classifiedAt = loadClassificationTimes(sources.ledgerPath, warnings);
  const sidecars = loadValidSidecars(sources.evaluationsDir, invalid_sidecars);

  let campaigns: Campaign[] = [];
  try {
    campaigns = Object.values(loadCampaigns());
  } catch (e) {
    warnings.push(`pool campaigns unreadable: ${(e as Error).message}`);
  }

  const records: FactoryRecord[] = [
    ...execs.map((e) => deriveExecutionRecord(e, classifiedAt, sources, collectedAt)),
    ...campaigns.map((c) => deriveCampaignRecord(c, sources, collectedAt)),
  ];

  const claimedExecIds = new Set(records.map((r) => r.execution_id));
  const claimedTickets = new Set(
    records.filter((r) => r.measured).map((r) => r.ticket_id).concat(
      records.filter((r) => r.measured).map((r) => r.identifier),
    ),
  );
  for (const entry of sidecars) {
    const claimedById = entry.verdict.execution_id !== null && claimedExecIds.has(entry.verdict.execution_id);
    const claimedByTicket = claimedTickets.has(entry.verdict.ticket);
    if (!claimedById && !claimedByTicket) {
      records.push(deriveTicketRecord(entry, sources, collectedAt));
    }
  }

  return { records, invalid_sidecars, warnings };
}

// ─── Log I/O (append-only, latest-row-wins) ──────────────────────────────────

export function readFactoryLog(logPath: string): Map<string, FactoryRecord> {
  const latest = new Map<string, FactoryRecord>();
  if (!existsSync(logPath)) return latest;
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const rec = JSON.parse(line) as FactoryRecord;
      if (typeof rec.execution_id === "string") latest.set(rec.execution_id, rec);
    } catch {
      // torn line: latest-row-wins reads stay usable; collect re-appends if needed
    }
  }
  return latest;
}

/**
 * Material content = record minus collected_at (re-collect must not churn rows).
 * Keys are sorted at every level so equality is insensitive to serialization
 * order — a field reorder in a future code version must not supersede rows
 * (consensus-mined, cg-1782992189510-md0ox1).
 */
function canonical(rec: FactoryRecord): string {
  const { collected_at: _ignored, ...rest } = rec;
  return JSON.stringify(rest, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}

export function collect(
  sources: CollectorSources = defaultSources(),
  opts: { dryRun?: boolean } = {},
): CollectResult {
  const { records, invalid_sidecars, warnings } = deriveAll(sources);
  const existing = readFactoryLog(sources.logPath);

  const appended: FactoryRecord[] = [];
  let unchanged = 0;
  let superseded = 0;

  for (const rec of records) {
    const prior = existing.get(rec.execution_id);
    if (prior && canonical(prior) === canonical(rec)) {
      unchanged++;
      continue;
    }
    if (prior) superseded++;
    appended.push(rec);
  }

  if (!opts.dryRun && appended.length > 0) {
    const dir = join(sources.logPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(
      sources.logPath,
      appended.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
  }

  return { appended, unchanged, superseded, invalid_sidecars, warnings };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printResult(result: CollectResult, dryRun: boolean): void {
  const verb = dryRun ? "would append" : "appended";
  console.log(
    `[factory-collect] ${verb} ${result.appended.length} (${result.superseded} superseding), unchanged ${result.unchanged}`,
  );
  for (const rec of result.appended) {
    const v = rec.measured && rec.verdict
      ? `${rec.verdict.verdict}${rec.verdict.rework ? "+rework" : ""}`
      : "unmeasured";
    console.log(`  + ${rec.execution_id} (${rec.kind}) ${rec.identifier} — ${v}`);
  }
  for (const w of result.warnings) console.error(`  ⚠ ${w}`);
  for (const p of result.invalid_sidecars) console.error(`  ⚠ INVALID sidecar (unmeasured): ${p}`);
}

function printOutcomeResult(mode: OutcomeEvidenceMode, result: OutcomeReconcileReport): void {
  console.log(
    `[outcome-evidence] mode=${mode} appended=${result.appended} unchanged=${result.unchanged} `
      + `measured=${result.measured} held=${result.held_unmeasured} excluded=${result.excluded}`,
  );
  for (const error of result.source_errors) {
    console.error(`  ⚠ outcome source ${error.source}: ${error.error}`);
  }
  for (const error of result.ledger_errors) console.error(`  ⚠ outcome ledger: ${error}`);
  if (result.write_blocked) console.error("  ⚠ outcome ledger write blocked; factory decisions remain unchanged");
}

function cliList(): number {
  const log = readFactoryLog(defaultSources().logPath);
  if (log.size === 0) {
    console.log("factory-log empty (run collect)");
    return 0;
  }
  for (const rec of [...log.values()].sort((a, b) => a.execution_id.localeCompare(b.execution_id))) {
    const reached = (Object.keys(rec.stages) as StageName[])
      .filter((s) => rec.stages[s] !== null)
      .join("→");
    const v = rec.measured && rec.verdict
      ? `${rec.verdict.verdict}${rec.verdict.rework ? "+rework" : ""}${rec.verdict.verdict === "pass" && !rec.verdict.rework ? " (first-pass)" : ""}`
      : "unmeasured";
    console.log(
      `${rec.execution_id}  ${rec.kind.padEnd(9)} ${rec.identifier.padEnd(8)} gate=${rec.gate_decision.padEnd(8)} stages=${reached}  verdict=${v}  cycle=${rec.cycle_time_hours ?? "—"}h`,
    );
  }
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "collect": {
      const dryRun = rest.includes("--dry-run");
      printResult(collect(defaultSources(), { dryRun }), dryRun);
      process.exit(0);
    }
    case "tick": {
      // Conveyor entry point: flags-off byte-identical (no log created, no output).
      if (process.env.SF004_METRICS !== "1") process.exit(0);
      printResult(collect(), false);
      const mode = process.env.OUTCOME_EVIDENCE_MODE ?? "off";
      try {
        const outcome = collectOutcomeEvidenceForMode({ mode });
        if (outcome) printOutcomeResult(mode as OutcomeEvidenceMode, outcome);
      } catch (error) {
        console.error(`[outcome-evidence] configuration error: ${(error as Error).message}`);
        process.exit(2);
      }
      process.exit(0);
    }
    case "list":
      process.exit(cliList());
    default:
      console.error("usage: factory-collect.ts collect [--dry-run] | tick | list");
      process.exit(2);
  }
}
