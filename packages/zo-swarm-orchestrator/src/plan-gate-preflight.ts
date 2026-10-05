import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  PlanGateLedger,
  evaluatePlanGatePreflight,
  parsePlanArtifactInput,
  parseTrustedPublicKeys,
  type FindingType,
  type PlanAcceptanceCriterion,
  type PlanArtifact,
  type PlanGatePreflightResult,
  type PolicyMode,
} from 'zouroboros-workflow/plan-gate';
import type { CanonicalizeFormat } from 'zouroboros-workflow/plan-gate';
import type { SwarmPlanGateConfig } from './types.js';

export interface SwarmPlanGateDecision {
  action: 'proceed' | 'hold';
  mode: SwarmPlanGateConfig['mode'];
  required: boolean;
  wouldHold: boolean;
  reason: string;
  auditEvent: string;
  result?: PlanGatePreflightResult;
  constitution?: {
    decision: 'ALLOW' | 'BLOCK';
    violations: Array<{ article: string; code: string; message: string }>;
  };
  auditError?: string;
}

export interface SwarmPlanGateFileOptions {
  mode?: string;
  planPath?: string;
  receiptPath?: string;
  workspaceRoot?: string;
  ledgerPath?: string;
  audit?: boolean;
  executionMode?: 'SWARM' | 'FORCE_SWARM';
  auditContext?: SwarmPlanGateConfig['auditContext'];
}

function formatForPath(planPath: string): CanonicalizeFormat {
  if (/\.json$/i.test(planPath)) return 'json';
  if (/\.md$/i.test(planPath)) return 'markdown';
  return 'yaml';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizePlanArtifactInput(input: Record<string, unknown>): PlanArtifact {
  const tasks = Array.isArray(input.tasks)
    ? input.tasks.map((value) => {
      const task = record(value) ?? {};
      return {
        ...task,
        id: typeof task.id === 'string' ? task.id : '',
        title: typeof task.title === 'string'
          ? task.title
          : typeof task.name === 'string' ? task.name : '',
        paths: Array.isArray(task.paths)
          ? task.paths
          : Array.isArray(task.files) ? task.files : [],
        depends_on: Array.isArray(task.depends_on)
          ? task.depends_on
          : Array.isArray(task.deps) ? task.deps : [],
      };
    })
    : [];
  const rawAcceptance = Array.isArray(input.acceptance_criteria)
    ? input.acceptance_criteria
    : Array.isArray(input.acceptance) ? input.acceptance : [];
  const acceptanceCriteria: Array<string | PlanAcceptanceCriterion> = rawAcceptance.map((value) => {
    if (typeof value === 'string') return value;
    const criterion = record(value);
    if (!criterion) return { criterion: '' };
    if (typeof criterion.criterion === 'string') {
      return { ...criterion, criterion: criterion.criterion };
    }
    const name = typeof criterion.name === 'string' ? criterion.name.trim() : '';
    const expect = typeof criterion.expect === 'string' ? criterion.expect.trim() : '';
    return { ...criterion, criterion: [name, expect].filter(Boolean).join(': ') };
  });
  const exitConditions = (Array.isArray(input.exit_conditions) ? input.exit_conditions : [])
    .map((value, index) => {
      if (typeof value === 'string') {
        return { name: `Exit condition ${index + 1}`, criteria: value };
      }
      const condition = record(value) ?? {};
      return {
        ...condition,
        name: typeof condition.name === 'string' ? condition.name : '',
        criteria: typeof condition.criteria === 'string' ? condition.criteria : '',
      };
    });

  return {
    ...input,
    id: typeof input.id === 'string'
      ? input.id
      : typeof input.project_id === 'string' ? input.project_id : '',
    title: typeof input.title === 'string'
      ? input.title
      : typeof input.project_name === 'string' ? input.project_name : '',
    risk: (input.risk ?? input.risk_level) as PlanArtifact['risk'],
    tasks,
    acceptance_criteria: acceptanceCriteria,
    exit_conditions: exitConditions,
    rollback: input.rollback === undefined ? null : input.rollback as PlanArtifact['rollback'],
  };
}

export function loadSwarmPlanGateConfig(
  options: SwarmPlanGateFileOptions = {},
): SwarmPlanGateConfig {
  const mode = options.mode ?? process.env.PLAN_GATE_MODE ?? 'disabled';
  if (!['disabled', 'advisory', 'shadow', 'enforce'].includes(mode)) {
    throw new Error(`Invalid plan gate mode '${mode}'`);
  }
  const planPath = options.planPath ?? process.env.PLAN_GATE_PLAN;
  const receiptPath = options.receiptPath ?? process.env.PLAN_GATE_RECEIPT;
  return {
    mode: mode as SwarmPlanGateConfig['mode'],
    artifact: planPath
      ? normalizePlanArtifactInput(parsePlanArtifactInput(
        readFileSync(planPath, 'utf8'),
        formatForPath(planPath),
      ))
      : undefined,
    receipt: receiptPath
      ? JSON.parse(readFileSync(receiptPath, 'utf8'))
      : undefined,
    trustedKeys: parseTrustedPublicKeys(process.env.PLAN_GATE_TRUSTED_PUBLIC_KEYS),
    workspaceRoot: options.workspaceRoot ?? process.env.ZO_WORKSPACE,
    ledgerPath: options.ledgerPath ?? process.env.PLAN_GATE_LEDGER_PATH,
    audit: options.audit,
    policyContext: options.executionMode
      ? { execution_mode: options.executionMode }
      : undefined,
    auditContext: options.auditContext,
  };
}

function missingArtifactDecision(
  mode: SwarmPlanGateConfig['mode'],
  executionMode?: string,
): SwarmPlanGateDecision {
  const enforce = mode === 'enforce';
  const required = enforce || executionMode === 'SWARM' || executionMode === 'FORCE_SWARM';
  return {
    action: enforce ? 'hold' : 'proceed',
    mode,
    required,
    wouldHold: mode !== 'disabled' && required,
    reason: mode === 'disabled' ? 'plan_gate_disabled' : 'plan_artifact_missing',
    auditEvent: enforce ? 'plan_gate_hold' : 'plan_gate_artifact_missing',
  };
}

export function evaluateSwarmPlanGatePreflight(
  config: SwarmPlanGateConfig | undefined,
): SwarmPlanGateDecision {
  const effective = config ?? { mode: 'disabled' as const };
  if (!effective.artifact) {
    return missingArtifactDecision(effective.mode, effective.policyContext?.execution_mode);
  }
  const result = evaluatePlanGatePreflight({
    artifact: effective.artifact,
    mode: effective.mode,
    receipt: effective.receipt,
    trustedKeys: effective.trustedKeys,
    validationOptions: { workspaceRoot: effective.workspaceRoot },
    policyContext: effective.policyContext,
  });
  return {
    action: result.action,
    mode: result.mode,
    required: result.required,
    wouldHold: result.would_hold,
    reason: result.reason,
    auditEvent: result.audit_event,
    result,
  };
}

function evaluateConstitution(
  config: SwarmPlanGateConfig,
  receiptValid: boolean,
): SwarmPlanGateDecision['constitution'] {
  if (!config.artifact || config.mode === 'disabled') return undefined;
  const artifact = config.artifact;
  const surface = [
    artifact.title,
    artifact.description || '',
    ...artifact.tasks.flatMap(task => [task.title, ...(task.paths || [])]),
  ].join('\n');
  const input = {
    operation: `swarm:${artifact.id}:r${artifact.revision ?? 1}`,
    description: artifact.description || artifact.title,
    targetFiles: artifact.tasks.flatMap(task => task.paths || []),
    modifiesModelWeights: /\b(fine[- ]?tun|train(?:ing)?\s+(?:a\s+)?model|model\s+weights?|gradient)\b/i.test(surface),
    reversible: artifact.rollback !== null && JSON.stringify(artifact.rollback).length > 2,
    rollbackPlan: typeof artifact.rollback === 'string'
      ? artifact.rollback
      : artifact.rollback ? JSON.stringify(artifact.rollback) : '',
    blastRadius: artifact.risk === 'high' ? 'high' : artifact.risk === 'medium' ? 'shared' : 'local',
    humanApproved: config.receipt?.actor?.authorization
      ? receiptValid
      : false,
    provenance: {
      rationale: artifact.description || artifact.title,
      evidence: [`plan:${artifact.id}`, `revision:${artifact.revision ?? 1}`],
      actor: config.receipt?.actor?.id || 'zouroboros-swarm',
    },
    budgetBounded: artifact.tasks.length > 0 && artifact.exit_conditions.length > 0,
    layerIntegrity: true,
    failClosed: true,
  };
  const gatePath = process.env.ZOUROBOROS_CONSTITUTION_GATE
    || '/home/workspace/Skills/zouroboros-governance/scripts/constitution-gate.ts';
  const args = [gatePath, 'check', '--phase', 'preflight', '--input', JSON.stringify(input)];
  if (config.audit === false) args.push('--skip-audit');

  let output = '';
  try {
    output = execFileSync('bun', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error: any) {
    output = String(error?.stdout || '');
    if (!output.trim()) {
      return {
        decision: 'BLOCK',
        violations: [{
          article: 'Article IX',
          code: 'IX-GATE-UNAVAILABLE',
          message: String(error?.stderr || error?.message || error).slice(0, 500),
        }],
      };
    }
  }

  try {
    const parsed = JSON.parse(output) as SwarmPlanGateDecision['constitution'];
    return parsed?.decision === 'ALLOW' || parsed?.decision === 'BLOCK'
      ? parsed
      : { decision: 'BLOCK', violations: [{ article: 'Article IX', code: 'IX-MALFORMED-DECISION', message: 'Constitution gate returned no decision' }] };
  } catch (error) {
    return {
      decision: 'BLOCK',
      violations: [{ article: 'Article IX', code: 'IX-MALFORMED-OUTPUT', message: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function findingCounts(result?: PlanGatePreflightResult): Record<FindingType, number> {
  const counts: Record<FindingType, number> = {
    substantive: 0, infrastructure: 0, formatting: 0, out_of_scope: 0,
    provider_failure: 0, abstention: 0, malformed_output: 0,
  };
  for (const finding of result?.deterministic_report.findings ?? []) {
    counts[finding.category ?? 'substantive'] += 1;
  }
  return counts;
}

function auditDecision(config: SwarmPlanGateConfig, decision: SwarmPlanGateDecision): void {
  if (config.audit === false || config.mode === 'disabled') return;
  const policyMode: PolicyMode = decision.result?.policy.mode ?? (decision.required ? 'mandatory' : 'advisory');
  new PlanGateLedger({ ledgerPath: config.ledgerPath }).append({
    record_id: randomUUID(),
    artifact_sha256: decision.result?.artifact_sha256 ?? '0'.repeat(64),
    revision: config.artifact?.revision ?? 1,
    gate_run_id: `swarm-preflight-${randomUUID()}`,
    decision: decision.action === 'hold' ? 'rejected' : 'passed',
    policy_mode: policyMode,
    timestamp: new Date().toISOString(),
    receipt_type: config.receipt?.receipt_type,
    actor_id: config.receipt?.actor.id,
    provider_health_summary: {},
    call_count: 0,
    cost_usd: 0,
    finding_counts: findingCounts(decision.result),
    execution_action: decision.action,
    would_hold: decision.wouldHold,
    reason: decision.reason,
    audit_event: decision.auditEvent,
    ticket_id: config.auditContext?.ticketId,
    identifier: config.auditContext?.identifier,
    execution_id: config.auditContext?.executionId,
    execution_mode: config.policyContext?.execution_mode,
  });
}

export function runSwarmPlanGatePreflight(
  config: SwarmPlanGateConfig | undefined,
): SwarmPlanGateDecision {
  const effective = config ?? { mode: 'disabled' as const };
  let decision = evaluateSwarmPlanGatePreflight(effective);
  const constitution = evaluateConstitution(
    effective,
    decision.result?.receipt_verification?.valid === true,
  );
  if (constitution?.decision === 'BLOCK') {
    const enforce = effective.mode === 'enforce';
    const alreadyHeld = decision.action === 'hold';
    decision = {
      ...decision,
      action: enforce ? 'hold' : decision.action,
      wouldHold: true,
      reason: alreadyHeld
        ? decision.reason
        : enforce ? 'constitution_blocked' : decision.wouldHold ? decision.reason : 'constitution_would_hold',
      auditEvent: alreadyHeld
        ? decision.auditEvent
        : enforce ? 'constitution_gate_hold' : decision.wouldHold ? decision.auditEvent : 'constitution_gate_would_hold',
      constitution,
    };
  } else if (constitution) {
    decision = { ...decision, constitution };
  }
  try {
    auditDecision(effective, decision);
    return decision;
  } catch (error) {
    const auditError = error instanceof Error ? error.message : String(error);
    if (effective.mode === 'enforce') {
      return {
        ...decision,
        action: 'hold',
        wouldHold: true,
        reason: 'plan_gate_audit_failed',
        auditEvent: 'plan_gate_hold',
        auditError,
      };
    }
    return { ...decision, auditError };
  }
}
