import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PlanGateLedger,
  type LedgerRecord,
} from "../../../packages/workflow/src/plan-gate/index.ts";
import {
  analyzePlanGateEvidence,
  monitorPlanGateEvidence,
} from "./plan-gate-evidence-monitor.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyCounts() {
  return {
    substantive: 0,
    infrastructure: 0,
    formatting: 0,
    out_of_scope: 0,
    provider_failure: 0,
    abstention: 0,
    malformed_output: 0,
  };
}

function record(overrides: Partial<LedgerRecord> = {}): LedgerRecord {
  return {
    record_id: crypto.randomUUID(),
    artifact_sha256: "a".repeat(64),
    revision: 1,
    gate_run_id: crypto.randomUUID(),
    decision: "passed",
    policy_mode: "mandatory",
    timestamp: "2026-07-27T16:00:00.000Z",
    provider_health_summary: {},
    call_count: 0,
    cost_usd: 0,
    finding_counts: emptyCounts(),
    execution_action: "proceed",
    would_hold: true,
    reason: "shadow_or_advisory_would_hold",
    audit_event: "plan_gate_shadow_hold",
    ticket_id: "ticket-1",
    identifier: "ZOU-1",
    execution_id: crypto.randomUUID(),
    execution_mode: "SWARM",
    ...overrides,
  };
}

describe("plan gate evidence monitor", () => {
  test("deduplicates qualifying events by ticket and artifact revision", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-gate-monitor-"));
    tempDirs.push(dir);
    const ledger = new PlanGateLedger({ ledgerPath: join(dir, "audit.jsonl") });
    ledger.append(record());
    ledger.append(record());
    ledger.append(record({
      record_id: crypto.randomUUID(),
      artifact_sha256: "0".repeat(64),
      policy_mode: "advisory",
      reason: "plan_artifact_missing",
      audit_event: "plan_gate_artifact_missing",
      ticket_id: "ticket-2",
      identifier: "ZOU-2",
    }));

    const status = analyzePlanGateEvidence(
      ledger.readAll(),
      ledger.verify(),
      { target: 2, now: new Date("2026-07-27T17:00:00.000Z") },
    );

    expect(status.status).toBe("collecting");
    expect(status.qualifying_records).toBe(2);
    expect(status.unique_qualifying_events).toBe(1);
    expect(status.duplicate_qualifying_records).toBe(1);
    expect(status.missing_artifact_records).toBe(1);
    expect(status.provenance_complete_records).toBe(2);
    expect(status.remaining).toBe(1);
  });

  test("verifies the chain and writes an atomic status artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-gate-monitor-state-"));
    tempDirs.push(dir);
    const ledgerPath = join(dir, "audit.jsonl");
    const statePath = join(dir, "status.json");
    const ledger = new PlanGateLedger({ ledgerPath });
    ledger.append(record());

    const status = monitorPlanGateEvidence({
      ledgerPath,
      statePath,
      target: 1,
      now: new Date("2026-07-27T17:00:00.000Z"),
    });
    const stored = JSON.parse(readFileSync(statePath, "utf8"));

    expect(status.status).toBe("ready");
    expect(status.integrity.valid).toBe(true);
    expect(stored.unique_qualifying_events).toBe(1);
    expect(stored.status).toBe("ready");
  });
});
