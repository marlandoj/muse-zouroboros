/**
 * plan-gate-stub.ts — Fully local stand-in for the plan gate evaluation.
 *
 * The upstream evaluation engine (`zouroboros-workflow/plan-gate`, ~3000
 * lines) is not vendored in this distribution, so the swarm's
 * `plan-gate-preflight.ts` cannot load here either. This stub implements the
 * small observable surface the factory actually needs, locally and
 * fail-closed:
 *
 * - mode "disabled" (default) → proceed, no gate evaluated, no ledger write.
 * - invalid mode → hold, with auditError (matches upstream).
 * - plan artifact missing → proceed in shadow/advisory, hold in enforce,
 *   reason "plan_artifact_missing" (matches upstream's missingArtifactDecision).
 * - shadow/advisory + plan → proceed, ledger record appended (artifact hash,
 *   execution action, policy mode, provenance).
 * - enforce + plan → HOLD. The real findings evaluation engine is not
 *   vendored, so enforcing a verdict we cannot compute would be dishonest;
 *   fail-closed with reason "plan_gate_evaluation_unavailable".
 *
 * Ledger records use the same field names as the swarm's auditDecision so
 * downstream readers (observatory, tests) see a consistent shape.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

export interface OperationalPlanGateDecision {
  action: "proceed" | "hold";
  mode: string;
  wouldHold: boolean;
  reason: string;
  auditEvent: string;
  auditError?: string;
}

export interface OperationalPlanGateOptions {
  mode?: string;
  planPath?: string;
  workspaceRoot?: string;
  ledgerPath?: string;
  executionMode?: string;
  auditContext?: Record<string, string | undefined>;
}

const VALID_MODES = ["disabled", "advisory", "shadow", "enforce"];

function configuredMode(options: OperationalPlanGateOptions): string {
  return options.mode ?? process.env.PLAN_GATE_MODE ?? "disabled";
}

function artifactHash(planPath: string): string {
  return createHash("sha256").update(readFileSync(planPath)).digest("hex");
}

function appendLedgerRecord(
  ledgerPath: string | undefined,
  record: Record<string, unknown>,
): void {
  if (!ledgerPath) return;
  appendFileSync(ledgerPath, JSON.stringify(record) + "\n", "utf8");
}

export async function runOperationalPlanGatePreflight(
  options: OperationalPlanGateOptions = {},
): Promise<OperationalPlanGateDecision> {
  const mode = configuredMode(options);
  if (!VALID_MODES.includes(mode)) {
    return {
      action: "hold",
      mode,
      wouldHold: true,
      reason: "invalid_plan_gate_mode",
      auditEvent: "plan_gate_hold",
      auditError: `Invalid plan gate mode '${mode}'`,
    };
  }
  if (mode === "disabled") {
    return {
      action: "proceed",
      mode,
      wouldHold: false,
      reason: "plan_gate_disabled",
      auditEvent: "plan_gate_disabled",
    };
  }

  const enforce = mode === "enforce";
  const executionMode = options.executionMode;
  const required =
    enforce || executionMode === "SWARM" || executionMode === "FORCE_SWARM";
  const ledgerPath = options.ledgerPath ?? process.env.PLAN_GATE_LEDGER_PATH;
  const ctx = options.auditContext ?? {};
  const baseRecord = {
    record_id: randomUUID(),
    revision: 1,
    gate_run_id: `factory-preflight-${randomUUID()}`,
    timestamp: new Date().toISOString(),
    policy_mode: required ? "mandatory" : "advisory",
    ticket_id: ctx.ticketId,
    identifier: ctx.identifier,
    execution_id: ctx.executionId,
    execution_mode: executionMode,
  };

  if (!options.planPath) {
    const decision: OperationalPlanGateDecision = {
      action: enforce ? "hold" : "proceed",
      mode,
      wouldHold: mode !== "disabled" && required,
      reason: "plan_artifact_missing",
      auditEvent: enforce ? "plan_gate_hold" : "plan_gate_artifact_missing",
    };
    appendLedgerRecord(ledgerPath, {
      ...baseRecord,
      artifact_sha256: "0".repeat(64),
      decision: decision.action === "hold" ? "rejected" : "passed",
      execution_action: decision.action,
      would_hold: decision.wouldHold,
      reason: decision.reason,
      audit_event: decision.auditEvent,
    });
    return decision;
  }

  if (enforce) {
    // Fail closed: the findings evaluation engine is not vendored, so we
    // cannot compute a real verdict. Holding is the honest answer.
    const decision: OperationalPlanGateDecision = {
      action: "hold",
      mode,
      wouldHold: true,
      reason: "plan_gate_evaluation_unavailable",
      auditEvent: "plan_gate_hold",
      auditError:
        "Plan gate evaluation engine (zouroboros-workflow) is not vendored in this distribution",
    };
    appendLedgerRecord(ledgerPath, {
      ...baseRecord,
      artifact_sha256: artifactHash(options.planPath),
      decision: "rejected",
      execution_action: "hold",
      would_hold: true,
      reason: decision.reason,
      audit_event: decision.auditEvent,
    });
    return decision;
  }

  // shadow / advisory: record, never block.
  const decision: OperationalPlanGateDecision = {
    action: "proceed",
    mode,
    wouldHold: false,
    reason: "plan_gate_shadow_recorded",
    auditEvent: "plan_gate_shadow",
  };
  appendLedgerRecord(ledgerPath, {
    ...baseRecord,
    artifact_sha256: artifactHash(options.planPath),
    decision: "passed",
    execution_action: "proceed",
    would_hold: false,
    reason: decision.reason,
    audit_event: decision.auditEvent,
  });
  return decision;
}
