/**
 * plan-gate-stub.ts — Local stand-in for the zouroboros skill's
 * plan-gate-runtime module.
 *
 * The upstream module (Skills/zouroboros/skills/swarm/scripts/
 * plan-gate-runtime.ts) is not vendored in this distribution. This stub
 * replicates its graceful-degradation wrapper verbatim in behavior, but
 * resolves the shared plan-gate implementation to the module this
 * distribution actually ships (packages/zo-swarm-orchestrator):
 *
 * - mode "disabled" (default) → proceed, no gate evaluated.
 * - shared module missing → proceed, except "enforce" mode → hold.
 * - shared module present → delegate to its loadSwarmPlanGateConfig /
 *   runSwarmPlanGatePreflight.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

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

const SHARED_PLAN_GATE_MODULE =
  process.env.ZOUROBOROS_PLAN_GATE_MODULE ??
  resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "packages", "zo-swarm-orchestrator", "src", "plan-gate-preflight.ts");

function configuredMode(options: OperationalPlanGateOptions): string {
  return options.mode ?? process.env.PLAN_GATE_MODE ?? "disabled";
}

export async function runOperationalPlanGatePreflight(
  options: OperationalPlanGateOptions = {},
): Promise<OperationalPlanGateDecision> {
  const mode = configuredMode(options);
  if (!["disabled", "advisory", "shadow", "enforce"].includes(mode)) {
    return {
      action: "hold",
      mode,
      wouldHold: true,
      reason: "invalid_plan_gate_mode",
      auditEvent: "plan_gate_hold",
      auditError: `Invalid plan gate mode '${mode}'`,
    };
  }
  if (!existsSync(SHARED_PLAN_GATE_MODULE)) {
    const enforce = mode === "enforce";
    return {
      action: enforce ? "hold" : "proceed",
      mode,
      wouldHold: mode !== "disabled",
      reason: "shared_plan_gate_unavailable",
      auditEvent: enforce ? "plan_gate_hold" : "plan_gate_unavailable",
      auditError: `Shared plan gate not found: ${SHARED_PLAN_GATE_MODULE}`,
    };
  }

  try {
    const shared = await import(pathToFileURL(SHARED_PLAN_GATE_MODULE).href);
    const config = shared.loadSwarmPlanGateConfig(options);
    return shared.runSwarmPlanGatePreflight(config);
  } catch (error) {
    return {
      action: mode === "enforce" ? "hold" : "proceed",
      mode,
      wouldHold: mode !== "disabled",
      reason: "shared_plan_gate_error",
      auditEvent: "plan_gate_unavailable",
      auditError: error instanceof Error ? error.message : String(error),
    };
  }
}
