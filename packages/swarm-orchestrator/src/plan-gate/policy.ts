/**
 * Plan Consensus Gate – risk-based policy classification.
 *
 * Classifies a plan artifact as mandatory, advisory, or exempt based on:
 *   - Artifact risk level
 *   - Execution context (SWARM / FORCE_SWARM)
 *   - Task path patterns (schema, infra, security, financial, irreversible)
 *   - Structural indicators (multi-phase dependency chains)
 *
 * No hard-coded absolute workspace paths are used; pattern matching operates
 * on the relative paths declared inside the plan artifact's task list.
 */

import type { PlanArtifact, PlanGatePolicy, PolicyMode } from './types.js';

// ---------------------------------------------------------------------------
// Execution context
// ---------------------------------------------------------------------------

export interface PlanGateContext {
  /** 'SWARM' or 'FORCE_SWARM' trigger mandatory policy regardless of risk. */
  execution_mode?: string;
  /** Override: force mandatory regardless of artifact content. */
  force_mandatory?: boolean;
  /** Override: exempt from gate (e.g. explicit operator opt-out). */
  force_exempt?: boolean;
}

// ---------------------------------------------------------------------------
// Path-pattern tables (relative paths only; no absolute workspace roots)
// ---------------------------------------------------------------------------

const SCHEMA_PATTERNS: RegExp[] = [
  /\.sql$/i,
  /migration/i,
  /schema/i,
  /alter[_-]table/i,
  /add[_-]column/i,
  /drop[_-]column/i,
];

const INFRA_PATTERNS: RegExp[] = [
  /infra\//i,
  /deploy/i,
  /\.env(\.|$)/i,
  /production\.(env|json|ya?ml|ts|js)$/i,
  /docker/i,
  /kubernetes/i,
  /k8s/i,
  /terraform/i,
  /helm/i,
];

const SECURITY_PATTERNS: RegExp[] = [
  /secret/i,
  /vault/i,
  /credential/i,
  /\bauth\b/i,
  /\bkey\b/i,
  /\btoken\b/i,
  /cert(ificate)?/i,
  /\btls\b/i,
  /\bssl\b/i,
  /signing/i,
];

const FINANCIAL_PATTERNS: RegExp[] = [
  /payment/i,
  /billing/i,
  /finance/i,
  /stripe/i,
  /invoice/i,
  /transaction/i,
  /ledger/i,
  /revenue/i,
];

const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /drop[_-]table/i,
  /truncate/i,
  /delete[_-]all/i,
  /purge/i,
  /irreversible/i,
  /destroy/i,
  /wipe/i,
];

const DOCUMENTATION_PATTERNS: RegExp[] = [
  /\.md$/i,
  /\.txt$/i,
  /readme/i,
  /changelog/i,
  /\/docs?\//i,
  /documentation/i,
  /\.rst$/i,
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PolicyTrigger =
  | 'execution_mode_swarm'
  | 'execution_mode_force_swarm'
  | 'multi_phase_dependent_tasks'
  | 'artifact_risk_high'
  | 'schema_change'
  | 'infrastructure_change'
  | 'security_sensitive'
  | 'financial_change'
  | 'irreversible_change'
  | 'force_mandatory'
  | 'documentation_only'
  | 'artifact_risk_low'
  | 'artifact_risk_medium'
  | 'force_exempt';

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function collectAllPaths(artifact: PlanArtifact): string[] {
  const paths: string[] = [];
  for (const task of artifact.tasks) {
    if (Array.isArray(task.paths)) {
      for (const p of task.paths) {
        if (typeof p === 'string') paths.push(p);
      }
    }
  }
  return paths;
}

function hasMultiPhaseDependentTasks(artifact: PlanArtifact): boolean {
  return artifact.tasks.some(
    (t) => Array.isArray(t.depends_on) && t.depends_on.length > 0
  );
}

function isDocumentationOnly(allPaths: string[]): boolean {
  if (allPaths.length === 0) return false;
  return allPaths.every((p) => matchesAny(p, DOCUMENTATION_PATTERNS));
}

function detectPathTriggers(allPaths: string[]): PolicyTrigger[] {
  const triggered: PolicyTrigger[] = [];
  const checks: [RegExp[], PolicyTrigger][] = [
    [SCHEMA_PATTERNS, 'schema_change'],
    [INFRA_PATTERNS, 'infrastructure_change'],
    [SECURITY_PATTERNS, 'security_sensitive'],
    [FINANCIAL_PATTERNS, 'financial_change'],
    [IRREVERSIBLE_PATTERNS, 'irreversible_change'],
  ];
  for (const [patterns, trigger] of checks) {
    if (allPaths.some((p) => matchesAny(p, patterns))) {
      triggered.push(trigger);
    }
  }
  return triggered;
}

const MANDATORY_TRIGGERS: Set<PolicyTrigger> = new Set([
  'execution_mode_swarm',
  'execution_mode_force_swarm',
  'artifact_risk_high',
  'schema_change',
  'infrastructure_change',
  'security_sensitive',
  'financial_change',
  'irreversible_change',
  'multi_phase_dependent_tasks',
  'force_mandatory',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a plan artifact as requiring mandatory, advisory, or exempt plan
 * consensus, using risk indicators, path patterns, and execution context.
 *
 * Mandatory triggers take precedence over advisory; explicit force_exempt
 * takes precedence over everything else (operator-opted-out plans only).
 */
export function evaluatePlanGatePolicy(
  artifact: PlanArtifact,
  context?: PlanGateContext
): PlanGatePolicy {
  // Explicit context overrides
  if (context?.force_exempt) {
    return {
      mode: 'exempt',
      rationale: 'Gate exemption explicitly requested by context.',
      triggered_by: ['force_exempt'],
    };
  }

  const triggers: PolicyTrigger[] = [];

  if (context?.force_mandatory) {
    triggers.push('force_mandatory');
  }

  // Execution mode
  const execMode = context?.execution_mode?.toUpperCase();
  if (execMode === 'SWARM') triggers.push('execution_mode_swarm');
  if (execMode === 'FORCE_SWARM') triggers.push('execution_mode_force_swarm');

  // Multi-phase structure
  if (hasMultiPhaseDependentTasks(artifact)) {
    triggers.push('multi_phase_dependent_tasks');
  }

  // Artifact risk level
  if (artifact.risk === 'high') triggers.push('artifact_risk_high');
  if (artifact.risk === 'medium') triggers.push('artifact_risk_medium');
  if (artifact.risk === 'low') triggers.push('artifact_risk_low');

  // Path-based pattern triggers
  const allPaths = collectAllPaths(artifact);
  triggers.push(...detectPathTriggers(allPaths));

  const uniqueTriggers: PolicyTrigger[] = [...new Set(triggers)];
  const hasMandatory = uniqueTriggers.some((t) => MANDATORY_TRIGGERS.has(t));

  if (hasMandatory) {
    const mandatoryOnes = uniqueTriggers.filter((t) => MANDATORY_TRIGGERS.has(t));
    return {
      mode: 'mandatory',
      rationale: `Mandatory gate required by: ${mandatoryOnes.join(', ')}.`,
      triggered_by: uniqueTriggers,
    };
  }

  // Advisory: documentation-only or low/medium risk with no mandatory triggers
  if (isDocumentationOnly(allPaths)) {
    uniqueTriggers.push('documentation_only');
  }

  return {
    mode: 'advisory',
    rationale: 'No mandatory triggers found; plan consensus is advisory.',
    triggered_by: uniqueTriggers,
  };
}

/**
 * Check whether a PolicyMode requires blocking gate enforcement.
 * Advisory and exempt modes never block execution.
 */
export function isMandatoryGate(policy: PlanGatePolicy): boolean {
  return policy.mode === 'mandatory';
}
