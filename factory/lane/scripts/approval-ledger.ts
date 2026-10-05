#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T3 (SF-002) — Approval Ledger + Harvest
 *
 * Append-only JSONL at state/approval-ledger.jsonl. Every classification is
 * appended at classification time (operator_verdict=pending). `harvest` fills
 * operator verdicts mechanically from gh PR state + Linear ticket state — no
 * self-report. Append-only discipline: harvest appends a superseding row for
 * the same verdict_id; reads resolve latest-row-wins. Idempotent by verdict_id
 * Resolved Linear rejections are rechecked only to append a machine-verifiable
 * supersession exclusion; existing history is never rewritten.
 *
 * Usage:
 *   bun approval-ledger.ts append --verdict <json-file|->
 *   bun approval-ledger.ts harvest
 *   bun approval-ledger.ts stats
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RiskVerdict, RiskTier } from "./risk-classifier";
import { autoLaneEligibleInputs, scoreRisk, tierFor } from "./risk-classifier";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OperatorVerdict = "approved" | "rejected" | "pending";

export interface CalibrationExclusion {
  reason: "superseded";
  source: "linear_duplicate_relation";
  related_issue_id: string;
  related_issue_identifier: string;
  observed_at: string;
}

export interface FlagsState {
  SF002_CLASSIFY: boolean;
  SF002_ENFORCE: boolean;
  SF002_AUTO_PROMOTE: boolean;
}

export interface LedgerEntry {
  verdict: RiskVerdict;
  operator_verdict: OperatorVerdict;
  harvested_at: string | null;
  harvest_source: "pr" | "linear" | null;
  agreement: boolean | null;
  calibration_exclusion?: CalibrationExclusion | null;
  flags: FlagsState;
  appended_at: string;
}

// ─── Paths / flags ────────────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();
export const LEDGER_PATH = join(STATE_DIR, "approval-ledger.jsonl");

export function currentFlags(): FlagsState {
  return {
    SF002_CLASSIFY: process.env.SF002_CLASSIFY !== "0",
    SF002_ENFORCE: process.env.SF002_ENFORCE === "1",
    SF002_AUTO_PROMOTE: process.env.SF002_AUTO_PROMOTE === "1",
  };
}

// ─── Core API ─────────────────────────────────────────────────────────────────

function appendRow(entry: LedgerEntry): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n");
}

export function appendVerdict(verdict: RiskVerdict): LedgerEntry {
  const entry: LedgerEntry = {
    verdict,
    operator_verdict: "pending",
    harvested_at: null,
    harvest_source: null,
    agreement: null,
    calibration_exclusion: null,
    flags: currentFlags(),
    appended_at: new Date().toISOString(),
  };
  appendRow(entry);
  return entry;
}

/** Read all rows; resolve latest-row-wins per verdict_id. Optional path override
 *  lets callers (e.g. l4-qualification) read a specific state dir's ledger. */
export function readLedger(path: string = LEDGER_PATH): Map<string, LedgerEntry> {
  const latest = new Map<string, LedgerEntry>();
  if (!existsSync(path)) return latest;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as LedgerEntry;
    latest.set(entry.verdict.verdict_id, entry);
  }
  return latest;
}

/**
 * Classifier said proceed (low) vs hold (medium/high); operator approved vs rejected.
 * ZOU-1110: a high-tier hold that the operator approves is the DESIGNED
 * human-authorization flow, not classifier disagreement — high-risk work must
 * always be held for review regardless of the eventual verdict.
 */
export function computeAgreement(tier: RiskTier, operator: OperatorVerdict): boolean | null {
  if (operator === "pending") return null;
  if (tier === "high" && operator === "approved") return true;
  const classifierWouldProceed = tier === "low";
  return classifierWouldProceed === (operator === "approved");
}

// ─── Calibration (ZOU-1110 / FR-01) ──────────────────────────────────────────

export const CALIBRATION_MIN_SAMPLE = 20;
export const FALSE_HOLD_MAX_RATE = 0.1;

/** The classifier's action decision for dedup purposes: low → allow, medium/high → hold. */
export type ActionDecision = "allow" | "hold";

export function actionDecisionOf(tier: RiskTier): ActionDecision {
  return tier === "low" ? "allow" : "hold";
}

export interface CalibrationMatrix {
  /** Resolved ledger rows before dedup (the old, distorted denominator). */
  resolved_rows: number;
  /** Distinct ticket + action-decision pairs — the calibrated denominator. */
  deduped_decisions: number;
  low_decisions: number;
  medium_decisions: number;
  high_decisions: number;
  /** low tier, operator approved. */
  correct_allow: number;
  /** low tier, operator rejected — classifier would have proceeded on rejected work. */
  false_approval: number;
  /** medium/high tier, operator rejected — the hold caught bad work. */
  correct_hold: number;
  /**
   * Approved holds that are the review lane working as designed: every high-tier
   * approval (human-authorization flow) plus medium-tier approvals of work the
   * auto-lane was never eligible to merge (features, refactors, …). FR-01's
   * "acted approvals are expected, not disagreement" principle, applied to both
   * hold tiers (ZOU-1196).
   */
  expected_hold_approvals: number;
  /** Auto-lane-eligible work (allowlist archetype, benign surfaces) held at medium/high yet operator-approved — the true over-hold signal. */
  false_hold: number;
  /** Decisions whose work was auto-lane-eligible (allowlist archetype, no schema/secret/infra, easy reversibility), any tier. */
  eligible_work_decisions: number;
  /**
   * Decisions whose tier changed when re-scored by the CURRENT classifier over
   * stored inputs. The matrix always scores with the current classifier so a
   * classifier fix is measured immediately instead of after months of new data;
   * operator verdicts remain the historical ground truth (ZOU-1196).
   */
  retiered_decisions: number;
  /** false_approval / low_decisions; null when no low-tier evidence exists. */
  false_approval_rate: number | null;
  /** false_hold / eligible_work_decisions; null when no auto-lane-eligible evidence exists. */
  false_hold_rate: number | null;
}

/**
 * Deduplicate resolved ledger entries by distinct ticket + action decision.
 * Hourly re-dispatch produces correlated verdicts per ticket; latest resolved
 * row wins per (ticket_id, allow|hold) pair.
 */
export function dedupeResolvedByTicketAction(entries?: Map<string, LedgerEntry>): Map<string, LedgerEntry> {
  const map = entries ?? readLedger();
  const deduped = new Map<string, LedgerEntry>();
  for (const e of map.values()) {
    if (e.operator_verdict === "pending") continue;
    const key = `${e.verdict.ticket_id}::${actionDecisionOf(e.verdict.tier)}`;
    const prev = deduped.get(key);
    if (!prev || e.appended_at > prev.appended_at) deduped.set(key, e);
  }
  return deduped;
}

export function computeCalibration(entries?: Map<string, LedgerEntry>): CalibrationMatrix {
  const map = entries ?? readLedger();
  let resolvedRows = 0;
  for (const e of map.values()) if (e.operator_verdict !== "pending") resolvedRows++;
  const deduped = dedupeResolvedByTicketAction(map);
  const m: CalibrationMatrix = {
    resolved_rows: resolvedRows,
    deduped_decisions: deduped.size,
    low_decisions: 0,
    medium_decisions: 0,
    high_decisions: 0,
    correct_allow: 0,
    false_approval: 0,
    correct_hold: 0,
    expected_hold_approvals: 0,
    false_hold: 0,
    eligible_work_decisions: 0,
    retiered_decisions: 0,
    false_approval_rate: null,
    false_hold_rate: null,
  };
  for (const e of deduped.values()) {
    // Score with the CURRENT classifier over the stored input snapshot; the
    // stored tier is what an older classifier version said, not what today's
    // lane would do. Rows without inputs fall back to the stored tier.
    const inputs = e.verdict.inputs;
    const tier = inputs ? tierFor(scoreRisk(inputs).score) : e.verdict.tier;
    if (tier !== e.verdict.tier) m.retiered_decisions++;
    const eligibleWork = inputs ? autoLaneEligibleInputs(inputs) : false;
    if (eligibleWork) m.eligible_work_decisions++;
    const approved = e.operator_verdict === "approved";
    if (tier === "low") {
      m.low_decisions++;
      if (approved) m.correct_allow++;
      else m.false_approval++;
    } else if (tier === "medium") {
      m.medium_decisions++;
      if (approved) {
        if (eligibleWork) m.false_hold++;
        else m.expected_hold_approvals++;
      } else m.correct_hold++;
    } else {
      m.high_decisions++;
      if (approved) {
        if (eligibleWork) m.false_hold++;
        else m.expected_hold_approvals++;
      } else m.correct_hold++;
    }
  }
  if (m.low_decisions > 0) m.false_approval_rate = Number((m.false_approval / m.low_decisions).toFixed(4));
  if (m.eligible_work_decisions > 0) m.false_hold_rate = Number((m.false_hold / m.eligible_work_decisions).toFixed(4));
  return m;
}

export interface CalibrationGateResult {
  eligible: boolean;
  min_sample: number;
  reasons: string[];
  matrix: CalibrationMatrix;
}

/**
 * Fail-closed calibration gate for auto-lane eligibility. Count alone is never
 * sufficient: the deduped sample must meet the minimum, allow and hold behavior
 * must both have evidence, false approvals must be zero, and the false-hold
 * rate must stay within tolerance.
 */
export function calibrationGate(matrix?: CalibrationMatrix, minSample = CALIBRATION_MIN_SAMPLE): CalibrationGateResult {
  const m = matrix ?? computeCalibration();
  const reasons: string[] = [];
  if (m.deduped_decisions < minSample) {
    reasons.push(`qualifying sample ${m.deduped_decisions}/${minSample} distinct ticket+action decisions`);
  }
  if (m.false_approval_rate === null) {
    reasons.push("no low-tier (allow) decisions — allow calibration unproven");
  } else if (m.false_approval_rate > 0) {
    reasons.push(`false-approval rate ${(m.false_approval_rate * 100).toFixed(1)}% > 0% (${m.false_approval} false approval(s))`);
  }
  if (m.medium_decisions + m.high_decisions === 0) {
    reasons.push("no hold-tier decisions — hold behavior unexercised");
  }
  if (m.false_hold_rate === null) {
    reasons.push("no auto-lane-eligible decisions — hold calibration unproven");
  } else if (m.false_hold_rate > FALSE_HOLD_MAX_RATE) {
    reasons.push(`false-hold rate ${(m.false_hold_rate * 100).toFixed(1)}% > ${(FALSE_HOLD_MAX_RATE * 100).toFixed(0)}% (${m.false_hold}/${m.eligible_work_decisions} auto-lane-eligible decisions over-held)`);
  }
  return { eligible: reasons.length === 0, min_sample: minSample, reasons, matrix: m };
}

// ─── Harvest (mechanical: gh PR state + Linear ticket state) ─────────────────

interface ExecRecordLite {
  pr_number: number | null;
}

function loadExecRecord(executionId: string): ExecRecordLite | null {
  const p = join(STATE_DIR, `exec-${executionId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ExecRecordLite;
  } catch {
    return null;
  }
}

async function harvestFromPR(prNumber: number): Promise<OperatorVerdict | null> {
  try {
    const proc = Bun.spawn(["gh", "pr", "view", String(prNumber), "--json", "state"], {
      cwd: join(import.meta.dir, "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const state = (JSON.parse(out).state as string) ?? "";
    if (state === "MERGED") return "approved";
    if (state === "CLOSED") return "rejected";
    return "pending";
  } catch {
    return null;
  }
}

export interface LinearIssueOutcome {
  id?: string;
  identifier?: string;
  state?: { type?: string };
  relations?: {
    nodes?: Array<{
      type?: string;
      relatedIssue?: { id?: string; identifier?: string };
    }>;
  };
}

export interface LinearHarvestOutcome {
  operator_verdict: OperatorVerdict;
  calibration_exclusion: CalibrationExclusion | null;
}

export interface HarvestSelection extends LinearHarvestOutcome {
  harvest_source: "pr" | "linear";
}

export function classifyLinearIssueOutcome(
  issue: LinearIssueOutcome | null | undefined,
  observedAt = new Date().toISOString(),
): LinearHarvestOutcome | null {
  const type = issue?.state?.type;
  if (!type) return null;
  if (type === "completed") {
    return { operator_verdict: "approved", calibration_exclusion: null };
  }
  const duplicate = issue.relations?.nodes?.find(
    (relation) =>
      relation.type === "duplicate" &&
      Boolean(relation.relatedIssue?.id) &&
      Boolean(relation.relatedIssue?.identifier),
  );
  if ((type === "canceled" || type === "duplicate") && duplicate?.relatedIssue?.id && duplicate.relatedIssue.identifier) {
    return {
      operator_verdict: "pending",
      calibration_exclusion: {
        reason: "superseded",
        source: "linear_duplicate_relation",
        related_issue_id: duplicate.relatedIssue.id,
        related_issue_identifier: duplicate.relatedIssue.identifier,
        observed_at: observedAt,
      },
    };
  }
  if (type === "canceled" || type === "duplicate") {
    return { operator_verdict: "rejected", calibration_exclusion: null };
  }
  return { operator_verdict: "pending", calibration_exclusion: null };
}

export function selectHarvestOutcome(
  prVerdict: OperatorVerdict | null,
  linearOutcome: LinearHarvestOutcome | null,
): HarvestSelection | null {
  if (prVerdict === "approved" || prVerdict === "rejected") {
    return {
      operator_verdict: prVerdict,
      calibration_exclusion: null,
      harvest_source: "pr",
    };
  }
  if (
    linearOutcome &&
    (linearOutcome.operator_verdict === "approved" ||
      linearOutcome.operator_verdict === "rejected" ||
      linearOutcome.calibration_exclusion !== null)
  ) {
    return { ...linearOutcome, harvest_source: "linear" };
  }
  return null;
}

export function reconcileSupersededLinearRejection(
  entry: LedgerEntry,
  outcome: LinearHarvestOutcome | null,
): LedgerEntry | null {
  if (
    entry.operator_verdict !== "rejected" ||
    entry.harvest_source !== "linear" ||
    entry.calibration_exclusion ||
    !outcome?.calibration_exclusion
  ) {
    return null;
  }
  return {
    ...entry,
    operator_verdict: "pending",
    harvested_at: outcome.calibration_exclusion.observed_at,
    harvest_source: "linear",
    agreement: null,
    calibration_exclusion: outcome.calibration_exclusion,
    appended_at: new Date().toISOString(),
  };
}

export function reconcileCalibrationExclusion(
  entry: LedgerEntry,
  prVerdict: OperatorVerdict | null,
  linearOutcome: LinearHarvestOutcome | null,
): LedgerEntry | null {
  const existing = entry.calibration_exclusion;
  if (!existing) return null;

  let selected: HarvestSelection | null = null;
  if (prVerdict === "approved" || prVerdict === "rejected") {
    selected = selectHarvestOutcome(prVerdict, linearOutcome);
  } else if (linearOutcome) {
    selected = { ...linearOutcome, harvest_source: "linear" };
  }
  if (!selected) return null;

  const nextExclusion = selected.calibration_exclusion;
  if (
    nextExclusion &&
    existing.reason === nextExclusion.reason &&
    existing.source === nextExclusion.source &&
    existing.related_issue_id === nextExclusion.related_issue_id &&
    existing.related_issue_identifier === nextExclusion.related_issue_identifier
  ) {
    return null;
  }

  return {
    ...entry,
    operator_verdict: selected.operator_verdict,
    harvested_at: nextExclusion?.observed_at ?? new Date().toISOString(),
    harvest_source: selected.harvest_source,
    agreement: computeAgreement(entry.verdict.tier, selected.operator_verdict),
    calibration_exclusion: nextExclusion,
    appended_at: new Date().toISOString(),
  };
}

const LINEAR_HARVEST_BATCH_SIZE = 25;

export type LinearFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface LinearHarvestOptions {
  apiKey?: string;
  apiUrl?: string;
  batchSize?: number;
  fetcher?: LinearFetch;
}

export async function harvestLinearOutcomes(
  ticketIds: string[],
  options: LinearHarvestOptions = {},
): Promise<Map<string, LinearHarvestOutcome>> {
  const key = options.apiKey ?? process.env.LINEAR_API_KEY;
  const outcomes = new Map<string, LinearHarvestOutcome>();
  if (!key) return outcomes;
  const uniqueIds = [...new Set(ticketIds)];
  const batchSize = options.batchSize ?? LINEAR_HARVEST_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("Linear harvest batch size must be a positive safe integer");
  }
  const apiUrl = options.apiUrl ?? process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
  const fetcher: LinearFetch = options.fetcher ?? ((input, init) => fetch(input, init));

  const fetchBatch = async (batch: string[]): Promise<void> => {
    if (batch.length === 0) return;
    const declarations = batch.map((_, index) => `$id${index}: String!`).join(", ");
    const selections = batch
      .map(
        (_, index) => `issue${index}: issue(id: $id${index}) {
          id
          identifier
          state { type }
          relations(first: 20) {
            nodes { type relatedIssue { id identifier } }
          }
        }`,
      )
      .join("\n");
    const variables = Object.fromEntries(batch.map((ticketId, index) => [`id${index}`, ticketId]));
    try {
      const res = await fetcher(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query: `query(${declarations}) { ${selections} }`, variables }),
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: Record<string, LinearIssueOutcome | null>;
        errors?: Array<{ message?: string }>;
      };
      const observedAt = new Date().toISOString();
      const missing: string[] = [];
      for (const [index, ticketId] of batch.entries()) {
        const issue = json.data?.[`issue${index}`];
        if (!issue) {
          missing.push(ticketId);
          continue;
        }
        const outcome = classifyLinearIssueOutcome(issue, observedAt);
        if (outcome) outcomes.set(ticketId, outcome);
      }
      const containsMissingIssueError = json.errors?.some((error) =>
        /entity not found:\s*issue/i.test(error.message ?? ""),
      ) ?? false;
      if (containsMissingIssueError && missing.length > 1 && missing.length === batch.length) {
        const midpoint = Math.ceil(missing.length / 2);
        await fetchBatch(missing.slice(0, midpoint));
        await fetchBatch(missing.slice(midpoint));
      } else if (containsMissingIssueError && missing.length > 0 && batch.length > 1) {
        await fetchBatch(missing);
      }
    } catch {
      return;
    }
  };

  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    await fetchBatch(uniqueIds.slice(offset, offset + batchSize));
  }
  return outcomes;
}

async function harvestFromLinear(ticketId: string): Promise<LinearHarvestOutcome | null> {
  return (await harvestLinearOutcomes([ticketId])).get(ticketId) ?? null;
}

export async function harvest(): Promise<{ checked: number; resolved: number; excluded: number; reclassified: number; skipped: number }> {
  const entries = readLedger();
  const reconciliationCandidates = [...entries.values()].filter(
    (entry) =>
      Boolean(entry.calibration_exclusion) ||
      (entry.operator_verdict === "rejected" &&
        entry.harvest_source === "linear" &&
        !entry.calibration_exclusion),
  );
  const reconciliationOutcomes = await harvestLinearOutcomes(
    reconciliationCandidates.map((entry) => entry.verdict.ticket_id),
  );
  let checked = 0;
  let resolved = 0;
  let excluded = 0;
  let reclassified = 0;
  let skipped = 0;

  for (const entry of entries.values()) {
    if (entry.calibration_exclusion) {
      checked++;
      let prVerdict: OperatorVerdict | null = null;
      const exec = loadExecRecord(entry.verdict.execution_id);
      if (exec?.pr_number != null) prVerdict = await harvestFromPR(exec.pr_number);
      const correction = reconcileCalibrationExclusion(
        entry,
        prVerdict,
        reconciliationOutcomes.get(entry.verdict.ticket_id) ?? null,
      );
      if (!correction) {
        skipped++;
        continue;
      }
      appendRow(correction);
      if (correction.calibration_exclusion) excluded++;
      else if (correction.operator_verdict === "approved" || correction.operator_verdict === "rejected") resolved++;
      else reclassified++;
      continue;
    }
    if (entry.operator_verdict !== "pending") {
      if (entry.operator_verdict === "rejected" && entry.harvest_source === "linear") {
        checked++;
        const correction = reconcileSupersededLinearRejection(
          entry,
          reconciliationOutcomes.get(entry.verdict.ticket_id) ?? null,
        );
        if (correction) {
          appendRow(correction);
          excluded++;
          continue;
        }
      }
      skipped++;
      continue;
    }
    checked++;

    let prVerdict: OperatorVerdict | null = null;
    let linearOutcome: LinearHarvestOutcome | null = null;

    const exec = loadExecRecord(entry.verdict.execution_id);
    if (exec?.pr_number != null) {
      prVerdict = await harvestFromPR(exec.pr_number);
    }
    if (prVerdict === null || prVerdict === "pending") {
      linearOutcome = await harvestFromLinear(entry.verdict.ticket_id);
    }

    const selected = selectHarvestOutcome(prVerdict, linearOutcome);
    if (selected) {
      const updated: LedgerEntry = {
        ...entry,
        operator_verdict: selected.operator_verdict,
        harvested_at: selected.calibration_exclusion?.observed_at ?? new Date().toISOString(),
        harvest_source: selected.harvest_source,
        agreement: computeAgreement(entry.verdict.tier, selected.operator_verdict),
        calibration_exclusion: selected.calibration_exclusion,
        appended_at: new Date().toISOString(),
      };
      appendRow(updated);
      if (selected.calibration_exclusion) excluded++;
      else resolved++;
    }
  }

  return { checked, resolved, excluded, reclassified, skipped };
}

// ─── Agreement stats ──────────────────────────────────────────────────────────

export interface AgreementStats {
  total: number;
  resolved: number;
  pending: number;
  excluded: number;
  agree: number;
  rate: number | null;
  /** Distinct tickets among resolved verdicts — hourly re-dispatch in dry-run
   *  produces correlated verdicts per ticket; operators should judge the
   *  ≥20 baseline against this too. */
  distinct_tickets_resolved: number;
  by_tier: Record<RiskTier, { n: number; agree: number }>;
  /** ZOU-1110: deduped confusion matrix — the calibrated evidence base. */
  calibration: CalibrationMatrix;
}

export function agreementStats(entries?: Map<string, LedgerEntry>): AgreementStats {
  const map = entries ?? readLedger();
  const stats: AgreementStats = {
    total: map.size,
    resolved: 0,
    pending: 0,
    excluded: 0,
    agree: 0,
    rate: null,
    distinct_tickets_resolved: 0,
    by_tier: { low: { n: 0, agree: 0 }, medium: { n: 0, agree: 0 }, high: { n: 0, agree: 0 } },
    calibration: computeCalibration(map),
  };
  const distinct = new Set<string>();
  for (const e of map.values()) {
    if (e.agreement !== null) distinct.add(e.verdict.ticket_id);
  }
  stats.distinct_tickets_resolved = distinct.size;
  for (const e of map.values()) {
    if (e.calibration_exclusion) {
      stats.excluded++;
      continue;
    }
    if (e.agreement === null) {
      stats.pending++;
      continue;
    }
    stats.resolved++;
    stats.by_tier[e.verdict.tier].n++;
    if (e.agreement) {
      stats.agree++;
      stats.by_tier[e.verdict.tier].agree++;
    }
  }
  stats.rate = stats.resolved > 0 ? Number((stats.agree / stats.resolved).toFixed(3)) : null;
  return stats;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = Bun.argv[2];

  if (cmd === "append") {
    const flagIdx = Bun.argv.indexOf("--verdict");
    const src = flagIdx >= 0 ? Bun.argv[flagIdx + 1] : undefined;
    if (!src) {
      console.error("Usage: approval-ledger.ts append --verdict <json-file|->");
      process.exit(2);
    }
    const raw = src === "-" ? await Bun.stdin.text() : readFileSync(src, "utf-8");
    const verdict = JSON.parse(raw) as RiskVerdict;
    if (!verdict.verdict_id || !verdict.tier) {
      console.error("FATAL: input is not a RiskVerdict (missing verdict_id/tier)");
      process.exit(2);
    }
    const entry = appendVerdict(verdict);
    console.log(`appended ${entry.verdict.verdict_id} (${entry.verdict.identifier}, tier=${entry.verdict.tier})`);
    process.exit(0);
  }

  if (cmd === "harvest") {
    const r = await harvest();
    console.log(`harvest: ${r.checked} checked, ${r.resolved} resolved, ${r.excluded} excluded, ${r.reclassified} reclassified, ${r.skipped} skipped`);
    process.exit(0);
  }

  if (cmd === "stats") {
    const s = agreementStats();
    const m = s.calibration;
    const gate = calibrationGate(m);
    console.log(`Ledger entries : ${s.total} (${s.resolved} resolved, ${s.pending} pending, ${s.excluded} excluded)`);
    console.log(`Agreement      : ${s.agree}/${s.resolved}${s.rate !== null ? ` (${(s.rate * 100).toFixed(1)}%)` : ""}`);
    for (const tier of ["low", "medium", "high"] as RiskTier[]) {
      const t = s.by_tier[tier];
      console.log(`  ${tier.padEnd(6)} : ${t.agree}/${t.n}`);
    }
    console.log(`Calibration (deduped ticket+action, ${m.deduped_decisions} decisions from ${m.resolved_rows} rows):`);
    console.log(`  correct allow  : ${m.correct_allow}`);
    console.log(`  false approval : ${m.false_approval}${m.false_approval_rate !== null ? ` (${(m.false_approval_rate * 100).toFixed(1)}% of ${m.low_decisions} low)` : ""}`);
    console.log(`  correct hold   : ${m.correct_hold}`);
    console.log(`  expected hold approvals (review lane) : ${m.expected_hold_approvals}`);
    console.log(`  false hold     : ${m.false_hold}${m.false_hold_rate !== null ? ` (${(m.false_hold_rate * 100).toFixed(1)}% of ${m.eligible_work_decisions} auto-lane-eligible)` : " (no auto-lane-eligible evidence)"}`);
    console.log(`  retiered by current classifier : ${m.retiered_decisions}`);
    console.log(`Auto-lane gate : ${gate.eligible ? `ELIGIBLE (${m.deduped_decisions} calibrated decisions, 0 false approvals, false-hold within tolerance)` : `BLOCKED — ${gate.reasons.join("; ")}`}`);
    process.exit(0);
  }

  console.error("Commands: append --verdict <json|-> | harvest | stats");
  process.exit(2);
}

if (import.meta.main) main();
