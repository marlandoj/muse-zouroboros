import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { dirname, resolve } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import {
  PlanGateLedger,
  type HashChainResult,
  type StoredLedgerRecord,
} from "../../../packages/workflow/src/plan-gate/index.ts";

export interface PlanGateEvidenceOptions {
  target?: number;
  staleHours?: number;
  now?: Date;
}

export interface PlanGateEvidenceStatus {
  status: "collecting" | "ready" | "integrity_failed";
  generated_at: string;
  target: number;
  total_records: number;
  qualifying_records: number;
  unique_qualifying_events: number;
  remaining: number;
  missing_artifact_records: number;
  instrumentation_records: number;
  provenance_complete_records: number;
  duplicate_qualifying_records: number;
  latest_qualifying_at: string | null;
  integrity: HashChainResult;
  alerts: string[];
}

const ZERO_HASH = "0".repeat(64);

function eventKey(record: StoredLedgerRecord): string {
  const artifact = `${record.artifact_sha256}:r${record.revision}`;
  return record.ticket_id ? `${record.ticket_id}:${artifact}` : artifact;
}

function hasCompleteProvenance(record: StoredLedgerRecord): boolean {
  return Boolean(
    record.ticket_id
    && record.identifier
    && record.execution_id
    && (record.execution_mode === "SWARM" || record.execution_mode === "FORCE_SWARM"),
  );
}

export function analyzePlanGateEvidence(
  records: StoredLedgerRecord[],
  integrity: HashChainResult,
  options: PlanGateEvidenceOptions = {},
): PlanGateEvidenceStatus {
  const target = options.target ?? 30;
  const staleHours = options.staleHours ?? 72;
  const now = options.now ?? new Date();
  const qualifying = records.filter(
    record => record.artifact_sha256 !== ZERO_HASH && record.policy_mode === "mandatory",
  );
  const uniqueEvents = new Set(qualifying.map(eventKey));
  const missingArtifact = records.filter(record => record.reason === "plan_artifact_missing");
  const provenanceComplete = qualifying.filter(hasCompleteProvenance);
  const latestQualifyingAt = qualifying
    .map(record => record.timestamp)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const alerts: string[] = [];

  if (!integrity.valid) alerts.push(`ledger_integrity_failed:${integrity.reason ?? "unknown"}`);
  if (records.length > 0 && missingArtifact.length / records.length > 0.25) {
    alerts.push("missing_artifact_ratio_above_25_percent");
  }
  if (qualifying.length > 0 && provenanceComplete.length < qualifying.length) {
    alerts.push("qualifying_records_missing_provenance");
  }
  if (latestQualifyingAt) {
    const ageHours = (now.getTime() - new Date(latestQualifyingAt).getTime()) / 3_600_000;
    if (ageHours > staleHours) alerts.push(`qualifying_evidence_stalled_over_${staleHours}_hours`);
  }

  const uniqueCount = uniqueEvents.size;
  const status = !integrity.valid
    ? "integrity_failed"
    : uniqueCount >= target ? "ready" : "collecting";

  return {
    status,
    generated_at: now.toISOString(),
    target,
    total_records: records.length,
    qualifying_records: qualifying.length,
    unique_qualifying_events: uniqueCount,
    remaining: Math.max(0, target - uniqueCount),
    missing_artifact_records: missingArtifact.length,
    instrumentation_records: records.length - qualifying.length,
    provenance_complete_records: provenanceComplete.length,
    duplicate_qualifying_records: qualifying.length - uniqueCount,
    latest_qualifying_at: latestQualifyingAt,
    integrity,
    alerts,
  };
}

function integerFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name} value`);
  return value;
}

function stringFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function writeStatus(path: string, status: PlanGateEvidenceStatus): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(status, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}

export function monitorPlanGateEvidence(input: {
  ledgerPath: string;
  statePath?: string;
  target?: number;
  staleHours?: number;
  retentionDays?: number;
  prune?: boolean;
  now?: Date;
}): PlanGateEvidenceStatus {
  const ledger = new PlanGateLedger({
    ledgerPath: input.ledgerPath,
    retentionDays: input.retentionDays ?? 90,
  });
  const integrity = ledger.verify();
  const records = integrity.valid ? ledger.readAll() : [];
  const status = analyzePlanGateEvidence(records, integrity, {
    target: input.target,
    staleHours: input.staleHours,
    now: input.now,
  });
  if (input.prune !== false) ledger.pruneArchives();
  if (input.statePath) writeStatus(input.statePath, status);
  return status;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ledgerPath = stringFlag(args, "--ledger")
    ?? resolveFactoryStateOverride(process.env.PLAN_GATE_LEDGER_PATH, "plan-gate-shadow-audit.jsonl");
  const statePath = stringFlag(args, "--state")
    ?? process.env.PLAN_GATE_EVIDENCE_STATUS_PATH;
  const status = monitorPlanGateEvidence({
    ledgerPath,
    statePath,
    target: integerFlag(args, "--target", 30),
    staleHours: integerFlag(args, "--stale-hours", 72),
    retentionDays: integerFlag(args, "--retention-days", 90),
    prune: !args.includes("--no-prune"),
  });
  console.log(JSON.stringify(status));
  if (status.status === "integrity_failed") process.exitCode = 2;
}
