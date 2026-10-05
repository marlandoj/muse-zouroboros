#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-010 T5 — Immutable Auto-Merge Audit Trail
 *
 * Every lane evaluation produces a single JSON artifact written to
 * state/auto-merge-audit/{ISO-timestamp}_{pr}.json. The file is written once
 * and never mutated — any subsequent write attempt for the same evaluation
 * key is rejected. Timestamp-scoped keys allow an advisory rehearsal and a
 * live decision for the same PR on the same day without losing either record.
 *
 * Record fields:
 *   pr_ref             — PR number / ref (e.g. "42" or "org/repo#42")
 *   archetype          — SF-011 archetype (e.g. "dependency_bump")
 *   ts                 — ISO timestamp of the merge decision
 *   risk_verdict       — SF-002 RiskVerdict snapshot
 *   scenario_results   — SF-009 ScenarioRunRecord array (3 runs per spec)
 *   snake_pit_report   — SF-010 SnakePitReport
 *   slo_snapshot       — SF-005 SloState | null (null = SF-005 inactive)
 *   merge_result       — outcome of the gh pr merge call
 *   rollback           — populated post-merge if auto-rollback fired
 *
 * CLI:
 *   bun merge-audit-trail.ts list
 *   bun merge-audit-trail.ts show <pr>
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { SloState } from "./factory-slo";
import type { RiskVerdict } from "./risk-classifier";
import type { ScenarioRunRecord } from "./scenario-run";
import type { SnakePitReport } from "./snake-pit";
import type { PullRequestBinding } from "../../../Skills/zouroboros-governance/scripts/operator-promotion-approval";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MergeResult {
  sha: string | null;
  method: "squash" | "merge" | "rebase" | "dry-run" | "error";
  duration_ms: number;
  error?: string;
}

export interface RollbackRecord {
  triggered_at: string;
  reason: string;
  slo_breach: string;
  revert_sha: string | null;
  incident_url: string | null;
  revert_error?: string;
}

export interface AutoMergeAudit {
  schema_version: 1;
  pr_ref: string;
  archetype: string;
  ts: string;
  risk_verdict: RiskVerdict;
  scenario_results: ScenarioRunRecord[];
  snake_pit_report: SnakePitReport;
  slo_snapshot: SloState | null;
  consensus_attestation?: {
    path: string;
    ticket: string;
    gate_id: string;
    repository_remote: string;
    base_commit: string;
    implementation_commit: string;
    implementation_diff_sha256: string;
    gate_evidence_hmac: string;
  };
  persona_attestation?: {
    path: string;
    ticket: string;
    repository_remote: string;
    base_commit: string;
    implementation_commit: string;
    implementation_diff_sha256: string;
    evidence_path: string;
    evidence_sha256: string;
    reviewer_persona_ids: string[];
  };
  merge_result: MergeResult;
  rollback?: RollbackRecord;
}

export interface AutoMergeIntentAudit {
  schema_version: 2;
  kind: "merge_intent";
  attempt_id: string;
  ticket: string;
  target: PullRequestBinding;
  ts: string;
  evidence_path: string;
  evidence_sha256: string;
  persona_attestation_path: string;
  operator_approval_path: string;
  rollback_plan: string;
  constitutional_decision: "ALLOW";
}

export interface AutoMergeCompletionAudit {
  schema_version: 2;
  kind: "merge_completion";
  attempt_id: string;
  ticket: string;
  target: PullRequestBinding;
  intent_path: string;
  ts: string;
  merge_result: MergeResult;
  reconciliation?: {
    inspected_at: string;
    repository_state: string;
    repository_head_sha: string;
  };
}

export interface MergeAttemptAudit {
  attempt_id: string;
  intent_path: string;
  completion_path: string | null;
  intent: AutoMergeIntentAudit;
  completion: AutoMergeCompletionAudit | null;
}

export interface MergeReconciliationResult {
  status: "completed" | "reconciled_merged" | "open_no_external_effect" | "blocked";
  attempt_id: string;
  reason: string;
  external_effect: "merged" | "none" | "unknown";
  completion_path?: string;
  merge_sha?: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function auditDir(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "auto-merge-audit");
}

function sanitizePrRef(prRef: string): string {
  return prRef.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64);
}

export function auditFilePath(prRef: string, ts: string, base = PROJECT_DIR): string {
  const timestamp = ts.replace(/[^a-z0-9_-]/gi, "-").slice(0, 48);
  const safe = sanitizePrRef(prRef);
  return join(auditDir(base), `${timestamp}_${safe}.json`);
}

function legacyAuditFilePath(prRef: string, ts: string, base = PROJECT_DIR): string {
  const date = ts.slice(0, 10);
  return join(auditDir(base), `${date}_${sanitizePrRef(prRef)}.json`);
}

// ─── Write (write-once, never mutates) ───────────────────────────────────────

export class AuditWriteError extends Error {}

function writeOnce(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AuditWriteError(`unable to write immutable audit record at ${path}: ${detail}`);
  }
  return path;
}

export function writeAuditRecord(
  record: AutoMergeAudit,
  base = PROJECT_DIR,
): string {
  const path = auditFilePath(record.pr_ref, record.ts, base);
  return writeOnce(path, record);
}

export function writeMergeIntentRecord(record: AutoMergeIntentAudit, base = PROJECT_DIR): string {
  const safeAttempt = record.attempt_id.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80);
  return writeOnce(join(auditDir(base), `${safeAttempt}_intent.json`), record);
}

export function writeMergeCompletionRecord(record: AutoMergeCompletionAudit, base = PROJECT_DIR): string {
  const safeAttempt = record.attempt_id.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80);
  return writeOnce(join(auditDir(base), `${safeAttempt}_completion.json`), record);
}

function validIntent(value: unknown): value is AutoMergeIntentAudit {
  const record = value as Partial<AutoMergeIntentAudit> | null;
  return Boolean(record
    && record.schema_version === 2
    && record.kind === "merge_intent"
    && typeof record.attempt_id === "string"
    && record.attempt_id.length > 0
    && typeof record.ticket === "string"
    && record.ticket.length > 0
    && typeof record.target?.repository === "string"
    && Number.isInteger(record.target?.number)
    && typeof record.target?.headSha === "string"
    && /^[a-f0-9]{40}$/i.test(record.target.headSha));
}

function validCompletion(value: unknown): value is AutoMergeCompletionAudit {
  const record = value as Partial<AutoMergeCompletionAudit> | null;
  return Boolean(record
    && record.schema_version === 2
    && record.kind === "merge_completion"
    && typeof record.attempt_id === "string"
    && typeof record.intent_path === "string"
    && record.merge_result
    && typeof record.merge_result.sha === "string"
    && /^[a-f0-9]{40}$/i.test(record.merge_result.sha));
}

export function readMergeAttempt(attemptId: string, base = PROJECT_DIR): MergeAttemptAudit | null {
  const safeAttempt = attemptId.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80);
  if (!safeAttempt || safeAttempt !== attemptId) return null;
  const intentPath = join(auditDir(base), `${safeAttempt}_intent.json`);
  const completionPath = join(auditDir(base), `${safeAttempt}_completion.json`);
  if (!existsSync(intentPath)) return null;
  let intent: unknown;
  try {
    intent = JSON.parse(readFileSync(intentPath, "utf8"));
  } catch {
    throw new AuditWriteError(`merge intent is invalid JSON: ${intentPath}`);
  }
  if (!validIntent(intent) || intent.attempt_id !== attemptId) throw new AuditWriteError(`merge intent schema/binding is invalid: ${intentPath}`);
  if (!existsSync(completionPath)) return { attempt_id: attemptId, intent_path: intentPath, completion_path: null, intent, completion: null };
  let completion: unknown;
  try {
    completion = JSON.parse(readFileSync(completionPath, "utf8"));
  } catch {
    throw new AuditWriteError(`merge completion is invalid JSON: ${completionPath}`);
  }
  if (!validCompletion(completion)
    || completion.attempt_id !== attemptId
    || completion.intent_path !== intentPath
    || completion.ticket !== intent.ticket
    || completion.target.repository !== intent.target.repository
    || completion.target.number !== intent.target.number
    || completion.target.headSha !== intent.target.headSha) {
    throw new AuditWriteError(`merge completion does not match its intent: ${completionPath}`);
  }
  return { attempt_id: attemptId, intent_path: intentPath, completion_path: completionPath, intent, completion };
}

export type MergeStateInspector = (target: PullRequestBinding) => {
  state: string;
  headSha: string;
  mergeSha: string | null;
};

function inspectMergeState(target: PullRequestBinding): ReturnType<MergeStateInspector> {
  const view = spawnSync("gh", ["pr", "view", String(target.number), "--repo", target.repository, "--json", "state,headRefOid,mergeCommit"], { encoding: "utf8" });
  if (view.error || view.status !== 0) throw new Error(view.error?.message ?? view.stderr.trim() ?? `gh pr view exited ${view.status}`);
  const parsed = JSON.parse(view.stdout) as { state?: string; headRefOid?: string; mergeCommit?: { oid?: string } | null };
  return { state: String(parsed.state ?? "UNKNOWN"), headSha: String(parsed.headRefOid ?? ""), mergeSha: parsed.mergeCommit?.oid ?? null };
}

export function reconcileMergeAttempt(
  attemptId: string,
  base = PROJECT_DIR,
  inspector: MergeStateInspector = inspectMergeState,
): MergeReconciliationResult {
  const attempt = readMergeAttempt(attemptId, base);
  if (!attempt) return { status: "blocked", attempt_id: attemptId, reason: "merge intent is unavailable", external_effect: "unknown" };
  if (attempt.completion?.merge_result.sha) {
    return { status: "completed", attempt_id: attemptId, reason: "immutable completion already exists", external_effect: "merged", completion_path: attempt.completion_path ?? undefined, merge_sha: attempt.completion.merge_result.sha };
  }
  let state: ReturnType<MergeStateInspector>;
  try {
    state = inspector(attempt.intent.target);
  } catch (error) {
    return { status: "blocked", attempt_id: attemptId, reason: `repository inspection failed: ${error instanceof Error ? error.message : String(error)}`, external_effect: "unknown" };
  }
  if (state.headSha !== attempt.intent.target.headSha) {
    return { status: "blocked", attempt_id: attemptId, reason: "repository PR head differs from the durable merge intent", external_effect: "unknown" };
  }
  if (state.state === "OPEN") {
    return { status: "open_no_external_effect", attempt_id: attemptId, reason: "GitHub confirms the exact intended head remains open", external_effect: "none" };
  }
  if (state.state !== "MERGED" || !state.mergeSha || !/^[a-f0-9]{40}$/i.test(state.mergeSha)) {
    return { status: "blocked", attempt_id: attemptId, reason: `ambiguous GitHub state=${state.state} merge_sha=${state.mergeSha ?? "null"}`, external_effect: "unknown" };
  }
  const completionPath = writeMergeCompletionRecord({
    schema_version: 2,
    kind: "merge_completion",
    attempt_id: attemptId,
    ticket: attempt.intent.ticket,
    target: attempt.intent.target,
    intent_path: attempt.intent_path,
    ts: new Date().toISOString(),
    merge_result: { sha: state.mergeSha, method: "squash", duration_ms: 0 },
    reconciliation: { inspected_at: new Date().toISOString(), repository_state: state.state, repository_head_sha: state.headSha },
  }, base);
  return { status: "reconciled_merged", attempt_id: attemptId, reason: "GitHub confirmed the exact intended head was merged and completion was persisted", external_effect: "merged", completion_path: completionPath, merge_sha: state.mergeSha };
}

function findAuditRecordPath(prRef: string, ts: string, base: string): string | null {
  const candidates = [
    auditFilePath(prRef, ts, base),
    legacyAuditFilePath(prRef, ts, base),
  ];
  const dir = auditDir(base);
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      candidates.push(join(dir, file));
    }
  }
  for (const path of [...new Set(candidates)]) {
    if (!existsSync(path)) continue;
    try {
      const record = JSON.parse(readFileSync(path, "utf-8")) as AutoMergeAudit;
      if (record.schema_version === 1 && record.pr_ref === prRef && record.ts === ts) return path;
    } catch {
      // Corrupt and unrelated files are ignored; the caller fails closed if no exact record remains.
    }
  }
  return null;
}

/** Append rollback info to an existing audit record (only mutation allowed). */
export function patchRollback(
  prRef: string,
  ts: string,
  rollback: RollbackRecord,
  base = PROJECT_DIR,
): void {
  const path = findAuditRecordPath(prRef, ts, base);
  if (!path) throw new AuditWriteError(`audit record not found for ${prRef} at ${ts}`);
  const record = JSON.parse(readFileSync(path, "utf-8")) as AutoMergeAudit;
  if (record.rollback) {
    throw new AuditWriteError(`rollback already recorded for ${prRef} — cannot overwrite`);
  }
  record.rollback = rollback;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function listAuditRecords(base = PROJECT_DIR): AutoMergeAudit[] {
  const dir = auditDir(base);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const records: AutoMergeAudit[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8")) as AutoMergeAudit;
      if (raw.schema_version === 1) records.push(raw);
    } catch {
      // corrupt file — skip
    }
  }
  return records.sort((a, b) => {
    const byTime = Date.parse(a.ts) - Date.parse(b.ts);
    return Number.isFinite(byTime) && byTime !== 0 ? byTime : a.pr_ref.localeCompare(b.pr_ref);
  });
}

export function findAuditRecord(prRef: string, base = PROJECT_DIR, ts?: string): AutoMergeAudit | null {
  const records = listAuditRecords(base);
  const matching = records.filter((record) => record.pr_ref === prRef && (!ts || record.ts === ts));
  return matching.at(-1) ?? null;
}

/** Count consecutive rollbacks at the tail of the audit log (circuit breaker input). */
export function consecutiveRollbacks(base = PROJECT_DIR): number {
  const records = listAuditRecords(base);
  let count = 0;
  for (const rec of [...records].reverse()) {
    if (rec.rollback) count++;
    else break;
  }
  return count;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      base: { type: "string", default: PROJECT_DIR },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [cmd, arg] = positionals;
  if (cmd === "list") {
    const records = listAuditRecords(values.base);
    if (!records.length) { console.log("No auto-merge audit records."); process.exit(0); }
    for (const r of records) {
      const status = r.rollback ? "ROLLED_BACK" : "merged";
      console.log(`${r.ts.slice(0, 19)}  PR#${r.pr_ref}  ${r.archetype}  ${status}  merge_sha=${r.merge_result.sha ?? "n/a"}`);
    }
  } else if (cmd === "show") {
    if (!arg) { console.error("Usage: show <pr_ref>"); process.exit(1); }
    const rec = findAuditRecord(arg, values.base);
    if (!rec) { console.error(`No audit record for PR '${arg}'`); process.exit(1); }
    console.log(JSON.stringify(rec, null, 2));
  } else if (cmd === "reconcile") {
    if (!arg) { console.error("Usage: reconcile <attempt_id> [--base <factory-root>] [--json]"); process.exit(1); }
    const result = reconcileMergeAttempt(arg, values.base);
    console.log(values.json ? JSON.stringify(result, null, 2) : `${result.status}: ${result.reason}`);
    if (result.status === "blocked") process.exit(2);
  } else {
    console.log("Usage: bun merge-audit-trail.ts <list|show|reconcile> [identifier] [--base <factory-root>] [--json]");
    process.exit(0);
  }
}
