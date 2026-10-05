#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { canonicalize, validateRunReceipt, type RunReceipt } from "./run-receipt-contract";
import { type EdgeAcknowledgementTier, type EdgeProofRecord } from "./run-edge-proof";
import { RECEIPT_SHADOW_RUN_CLASSES, type ReceiptShadowRunClass } from "./run-receipt-shadow";

export const RECEIPT_SHADOW_REPORT_ID = "zouroboros-run-receipt-shadow-report/v1" as const;

export interface ShadowClassReport {
  operations: number;
  excluded: number;
  receipts: number;
  complete: number;
  completenessRatio: number;
  edgeBound: number;
  edgeBindingRatio: number;
  requiredTier: EdgeAcknowledgementTier;
}

export interface ShadowIncidentSample {
  operationId: string;
  runClass: ReceiptShadowRunClass;
  score: number;
  checks: Record<string, boolean>;
}

export interface ReceiptShadowReport {
  contract_id: typeof RECEIPT_SHADOW_REPORT_ID;
  database_bytes: number;
  classes: Record<ReceiptShadowRunClass, ShadowClassReport>;
  totals: { operations: number; receipts: number; completenessRatio: number; edgeBindingRatio: number };
  producer_overhead_ms: { count: number; p50: number | null; p95: number | null; max: number | null };
  max_bundle_bytes_gzip: number;
  restart_state: { openOperations: number; incompleteAttempts: number };
  duplicates: { idempotency: number; committedEffects: number };
  incident_sample: ShadowIncidentSample[];
  gates: {
    volume: boolean;
    completeness: boolean;
    edgeBinding: boolean;
    producerLatency: boolean;
    bundleSize: boolean;
    databaseSize: boolean;
    integrity: boolean;
    incidentDiagnosis: boolean;
  };
  qualifies: boolean;
}

const REQUIRED_TIER: Record<ReceiptShadowRunClass, EdgeAcknowledgementTier> = {
  scheduled_agent: "durable_confirmed",
  factory_execution: "durable_confirmed",
  external_side_effect: "user_visible_confirmed",
};

const TIER_RANK: Record<EdgeAcknowledgementTier, number> = {
  none: 0,
  transport_accepted: 1,
  durable_confirmed: 2,
  user_visible_confirmed: 3,
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function runClassFromScope(scope: string): ReceiptShadowRunClass | null {
  const value = scope.replace(/^receipt-shadow:/, "") as ReceiptShadowRunClass;
  return RECEIPT_SHADOW_RUN_CLASSES.includes(value) ? value : null;
}

export function hasExactCohortVolume(counts: Record<ReceiptShadowRunClass, number>): boolean {
  return RECEIPT_SHADOW_RUN_CLASSES.every((runClass) => counts[runClass] === 30);
}

function diagnosticSample(operationId: string, runClass: ReceiptShadowRunClass, receipt: RunReceipt, edge: EdgeProofRecord | undefined): ShadowIncidentSample {
  const checks = {
    trigger: Boolean(receipt.trigger.identity && receipt.trigger.input_hash),
    authority: receipt.authority.envelope_kind !== "none",
    attempts: receipt.attempts.length > 0,
    outcome: Boolean(receipt.terminal.outcome),
    sideEffects: receipt.attempts.some((attempt) => attempt.side_effects.length > 0),
    edgeState: Boolean(edge?.classification),
    replayIdentity: Boolean(receipt.idempotency_key),
    rollback: receipt.attempts.every((attempt) => attempt.side_effects.every((effect) => !effect.reversible || Boolean(effect.rollback_ref))),
    sourceRevision: Boolean(receipt.versions.tool_versions.source_revision),
    rawLogIndependent: receipt.verification.checks.every((check) => !check.evidence_ref?.includes("raw-log")),
  };
  return { operationId, runClass, score: Object.values(checks).filter(Boolean).length, checks };
}

export function buildReceiptShadowReport(dbPath: string): ReceiptShadowReport {
  if (!isAbsolute(dbPath) || !existsSync(dbPath)) throw new Error("receipt shadow report requires an existing absolute database path");
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const operations = db.query("SELECT operation_id, scope FROM operations WHERE scope LIKE 'receipt-shadow:%' ORDER BY created_at")
      .all() as Array<{ operation_id: string; scope: string }>;
    const receiptRows = db.query("SELECT operation_id, canonical_receipt FROM receipts")
      .all() as Array<{ operation_id: string; canonical_receipt: string }>;
    const receipts = new Map(receiptRows.map((row) => [row.operation_id, JSON.parse(row.canonical_receipt) as RunReceipt]));
    const edgeRows = db.query("SELECT operation_id, canonical_record FROM edge_proof_records ORDER BY commit_sequence")
      .all() as Array<{ operation_id: string; canonical_record: string }>;
    const latestEdges = new Map<string, EdgeProofRecord>();
    for (const row of edgeRows) latestEdges.set(row.operation_id, JSON.parse(row.canonical_record) as EdgeProofRecord);
    const terminalRows = db.query("SELECT operation_id, reason_code FROM terminal_records")
      .all() as Array<{ operation_id: string; reason_code: string }>;
    const terminalReasons = new Map(terminalRows.map((row) => [row.operation_id, row.reason_code]));

    const classes = Object.fromEntries(RECEIPT_SHADOW_RUN_CLASSES.map((runClass) => [runClass, {
      operations: 0,
      excluded: 0,
      receipts: 0,
      complete: 0,
      completenessRatio: 0,
      edgeBound: 0,
      edgeBindingRatio: 0,
      requiredTier: REQUIRED_TIER[runClass],
    }])) as Record<ReceiptShadowRunClass, ShadowClassReport>;

    let maxBundleBytes = 0;
    const samples: Record<ReceiptShadowRunClass, ShadowIncidentSample[]> = {
      scheduled_agent: [],
      factory_execution: [],
      external_side_effect: [],
    };
    for (const operation of operations) {
      const runClass = runClassFromScope(operation.scope);
      if (!runClass) continue;
      const report = classes[runClass];
      if (runClass === "external_side_effect" && terminalReasons.get(operation.operation_id) === "shipping_no_patch_novel") {
        report.excluded++;
        continue;
      }
      report.operations++;
      const receipt = receipts.get(operation.operation_id);
      if (!receipt) continue;
      report.receipts++;
      if (validateRunReceipt(receipt).ok) report.complete++;
      const edge = latestEdges.get(operation.operation_id);
      if (edge && edge.classification === "required" && edge.timeliness === "within_deadline" && TIER_RANK[edge.acknowledgement_tier] >= TIER_RANK[report.requiredTier]) {
        report.edgeBound++;
      }
      const bundle = canonicalize({ receipt, edge: edge ?? null });
      maxBundleBytes = Math.max(maxBundleBytes, gzipSync(bundle).byteLength);
      if (samples[runClass].length < 4) samples[runClass].push(diagnosticSample(operation.operation_id, runClass, receipt, edge));
    }
    for (const runClass of RECEIPT_SHADOW_RUN_CLASSES) {
      classes[runClass].completenessRatio = ratio(classes[runClass].complete, classes[runClass].operations);
      classes[runClass].edgeBindingRatio = ratio(classes[runClass].edgeBound, classes[runClass].operations);
    }

    const eventRows = db.query("SELECT canonical_payload FROM journal_events WHERE kind IN ('attempt.started', 'attempt.completed')")
      .all() as Array<{ canonical_payload: string }>;
    const overhead = eventRows.flatMap((row) => {
      const payload = JSON.parse(row.canonical_payload) as { shadow_timing?: { producer_overhead_ms?: unknown } };
      const value = payload.shadow_timing?.producer_overhead_ms;
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    });
    const totalOperations = RECEIPT_SHADOW_RUN_CLASSES.reduce((sum, runClass) => sum + classes[runClass].operations, 0);
    const totalReceipts = RECEIPT_SHADOW_RUN_CLASSES.reduce((sum, runClass) => sum + classes[runClass].receipts, 0);
    const complete = RECEIPT_SHADOW_RUN_CLASSES.reduce((sum, runClass) => sum + classes[runClass].complete, 0);
    const edgeBound = RECEIPT_SHADOW_RUN_CLASSES.reduce((sum, runClass) => sum + classes[runClass].edgeBound, 0);
    const openOperations = Number((db.query(`
      SELECT COUNT(*) AS count FROM operations o
      WHERE o.scope LIKE 'receipt-shadow:%' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.operation_id = o.operation_id)
    `).get() as { count: number }).count);
    const incompleteAttempts = Number((db.query(`
      SELECT COUNT(*) AS count FROM journal_events started
      WHERE started.kind = 'attempt.started'
        AND EXISTS (SELECT 1 FROM operations o WHERE o.operation_id = started.operation_id AND o.scope LIKE 'receipt-shadow:%')
        AND NOT EXISTS (
          SELECT 1 FROM journal_events completed
          WHERE completed.operation_id = started.operation_id AND completed.kind = 'attempt.completed'
            AND json_extract(completed.canonical_payload, '$.attempt_n') = json_extract(started.canonical_payload, '$.attempt_n')
        )
    `).get() as { count: number }).count);
    const idempotencyDuplicates = Number((db.query(`
      SELECT COUNT(*) AS count FROM (
        SELECT scope, idempotency_key FROM operations WHERE scope LIKE 'receipt-shadow:%'
        GROUP BY scope, idempotency_key HAVING COUNT(*) > 1
      )
    `).get() as { count: number }).count);
    const committedEffectDuplicates = Number((db.query(`
      SELECT COUNT(*) AS count FROM (
        SELECT d.operation_id, d.adapter_kind, d.target
        FROM effect_definitions d JOIN effect_states s ON s.effect_id = d.effect_id AND s.state = 'committed'
        GROUP BY d.operation_id, d.adapter_kind, d.target HAVING COUNT(DISTINCT d.effect_id) > 1
      )
    `).get() as { count: number }).count);
    const incidentSample = RECEIPT_SHADOW_RUN_CLASSES.flatMap((runClass) => samples[runClass]);
    const databaseBytes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .reduce((sum, candidate) => sum + (existsSync(candidate) ? statSync(candidate).size : 0), 0);
    const classCounts = Object.fromEntries(
      RECEIPT_SHADOW_RUN_CLASSES.map((runClass) => [runClass, classes[runClass].operations]),
    ) as Record<ReceiptShadowRunClass, number>;
    const gates = {
      volume: hasExactCohortVolume(classCounts),
      completeness: totalOperations >= 90 && ratio(complete, totalOperations) >= 0.99,
      edgeBinding: totalOperations >= 90 && ratio(edgeBound, totalOperations) >= 0.99,
      producerLatency: overhead.length > 0 && (percentile(overhead, 0.95) ?? Infinity) <= 250,
      bundleSize: maxBundleBytes <= 65_536,
      databaseSize: databaseBytes <= 64 * 1024 * 1024,
      integrity: idempotencyDuplicates === 0 && committedEffectDuplicates === 0,
      incidentDiagnosis: incidentSample.length === 12 && incidentSample.every((sample) => sample.score >= 8),
    };
    return {
      contract_id: RECEIPT_SHADOW_REPORT_ID,
      database_bytes: databaseBytes,
      classes,
      totals: {
        operations: totalOperations,
        receipts: totalReceipts,
        completenessRatio: ratio(complete, totalOperations),
        edgeBindingRatio: ratio(edgeBound, totalOperations),
      },
      producer_overhead_ms: {
        count: overhead.length,
        p50: percentile(overhead, 0.5),
        p95: percentile(overhead, 0.95),
        max: overhead.length ? Math.max(...overhead) : null,
      },
      max_bundle_bytes_gzip: maxBundleBytes,
      restart_state: { openOperations, incompleteAttempts },
      duplicates: { idempotency: idempotencyDuplicates, committedEffects: committedEffectDuplicates },
      incident_sample: incidentSample,
      gates,
      qualifies: Object.values(gates).every(Boolean),
    };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  if (dbIndex < 0 || !args[dbIndex + 1]) {
    console.error("usage: bun run-receipt-shadow-report.ts --db <absolute-path>");
    process.exit(2);
  }
  console.log(JSON.stringify(buildReceiptShadowReport(args[dbIndex + 1]), null, 2));
}
