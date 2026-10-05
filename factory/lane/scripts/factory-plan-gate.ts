import { existsSync } from "node:fs";
import {
  runOperationalPlanGatePreflight,
  type OperationalPlanGateDecision,
} from "../../../Skills/zouroboros/skills/swarm/scripts/plan-gate-runtime";
import {
  checkSeedRepositoryDrift,
  type RepositoryDriftDecision,
  type RepositoryDriftInput,
} from "./repository-drift";

export type FactoryPlanGateDecision = OperationalPlanGateDecision & {
  plan_path: string | null;
  repository_drift?: RepositoryDriftDecision;
};

export interface FactoryPlanGateInput {
  decision: "DIRECT" | "SWARM" | "FORCE_SWARM" | "SUGGEST" | "ERROR";
  seedPath: string;
  workspaceRoot: string;
  mode?: string;
  ledgerPath?: string;
  ticketId?: string;
  identifier?: string;
  executionId?: string;
  dryRun?: boolean;
}

export interface FactoryPlanGateDependencies {
  repositoryDrift?: (input: RepositoryDriftInput) => RepositoryDriftDecision;
}

export async function runFactoryPlanGate(
  input: FactoryPlanGateInput,
  dependencies: FactoryPlanGateDependencies = {},
): Promise<FactoryPlanGateDecision | null> {
  const mode = input.mode ?? process.env.PLAN_GATE_MODE ?? "disabled";
  if (input.decision !== "SWARM" && input.decision !== "FORCE_SWARM") return null;

  const planPath = existsSync(input.seedPath) ? input.seedPath : undefined;
  const repositoryDrift = planPath
    ? (dependencies.repositoryDrift ?? checkSeedRepositoryDrift)({
        seedPath: planPath,
        workspaceRoot: input.workspaceRoot,
        dryRun: input.dryRun,
        ticketId: input.ticketId,
        identifier: input.identifier,
        executionId: input.executionId,
      })
    : undefined;
  if (repositoryDrift?.action === "hold") {
    return {
      action: "hold",
      mode,
      wouldHold: true,
      reason: repositoryDrift.reason,
      auditEvent: "repository_drift_hold",
      auditError: repositoryDrift.journal_error,
      plan_path: planPath ?? null,
      repository_drift: repositoryDrift,
    };
  }
  if (mode === "disabled") {
    if (!repositoryDrift || repositoryDrift.status === "not_declared") return null;
    return {
      action: "proceed",
      mode,
      wouldHold: false,
      reason: repositoryDrift.reason,
      auditEvent: "repository_drift_checked",
      plan_path: planPath ?? null,
      repository_drift: repositoryDrift,
    };
  }

  const decision = await runOperationalPlanGatePreflight({
    mode,
    planPath,
    workspaceRoot: input.workspaceRoot,
    ledgerPath: input.ledgerPath ?? process.env.PLAN_GATE_LEDGER_PATH,
    executionMode: input.decision,
    auditContext: {
      ticketId: input.ticketId,
      identifier: input.identifier,
      executionId: input.executionId,
    },
  });
  return {
    ...decision,
    plan_path: planPath ?? null,
    ...(repositoryDrift ? { repository_drift: repositoryDrift } : {}),
  };
}
