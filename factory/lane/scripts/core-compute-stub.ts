/**
 * core-compute-stub.ts — Faithful local reimplementation of packages/core's
 * compute routing helpers.
 *
 * The upstream module (packages/core/src/compute.ts) is not vendored in this
 * distribution. `DEFAULT_ROUTING_POLICY` and `routeExecution` are pure
 * functions reimplemented here verbatim in behavior. The router is
 * fail-closed by design: it holds unless every authorization and evidence
 * prerequisite is present, and the default policy is disabled/shadow.
 */

export type DataClassification = 'public' | 'internal' | 'sensitive';
export type ComputeProvider = 'local' | 'modal' | 'hetzner' | 'hold';
export type ComputeNodeKind = 'agent' | 'compute' | 'verification';
export type DispatchMode = 'off' | 'shadow' | 'enforce';

export type HoldReason =
  | 'global_disabled'
  | 'provider_disabled'
  | 'environment_disabled'
  | 'workload_disabled'
  | 'missing_approval'
  | 'missing_classification'
  | 'missing_cost_evidence'
  | 'missing_callback_identity'
  | 'missing_cleanup_policy'
  | 'non_idempotent_work'
  | 'unauthorized_mutation'
  | 'invalid_contract'
  | 'sensitive_data'
  | 'cost_cap_exceeded';

export interface RoutingInput {
  nodeKind: ComputeNodeKind;
  workloadClass: string;
  environment?: string;
  provider?: ComputeProvider;
  approvalId?: string;
  classification?: DataClassification;
  costEstimateUsd?: number;
  callbackId?: string;
  cleanupRequired?: boolean;
  idempotent?: boolean;
  canonicalWrites?: boolean;
  externalMutations?: boolean;
}

export interface RoutingPolicy {
  policyVersion: string;
  enabled: boolean;
  mode: DispatchMode;
  environment: string;
  environmentEnabled: Readonly<Record<string, boolean>>;
  providerEnabled: Readonly<Record<Exclude<ComputeProvider, 'hold'>, boolean>>;
  workloadClassEnabled: Readonly<Record<string, boolean>>;
  allowSensitiveRemote: boolean;
  maxCostUsdByProvider: Readonly<Record<Exclude<ComputeProvider, 'hold'>, number>>;
}

export interface RoutingDecision {
  action: 'dispatch' | 'shadow' | 'hold';
  provider: ComputeProvider;
  policyVersion: string;
  reasons: readonly string[];
  holdReason?: HoldReason;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = Object.freeze({
  policyVersion: 'compute-routing-v1',
  enabled: false,
  mode: 'shadow',
  environment: 'default',
  environmentEnabled: Object.freeze({ default: true }),
  providerEnabled: Object.freeze({ local: true, modal: false, hetzner: false }),
  workloadClassEnabled: Object.freeze({}),
  allowSensitiveRemote: false,
  maxCostUsdByProvider: Object.freeze({ local: 0, modal: 0, hetzner: 0 }),
});

function decision(policy: RoutingPolicy, input: Omit<RoutingDecision, 'policyVersion'>): RoutingDecision {
  return Object.freeze({ ...input, policyVersion: policy.policyVersion });
}

export function routeExecution(input: RoutingInput, policy: RoutingPolicy = DEFAULT_ROUTING_POLICY): RoutingDecision {
  if (input.canonicalWrites || input.externalMutations) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['provider execution cannot mutate canonical or external state'], holdReason: 'unauthorized_mutation' });
  if (input.nodeKind === 'agent') return decision(policy, { action: 'dispatch', provider: 'local', reasons: ['agent nodes remain on the incumbent executor path'] });
  if (!input.approvalId) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['operator approval is required'], holdReason: 'missing_approval' });
  if (!input.classification) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['data classification is required'], holdReason: 'missing_classification' });
  if (input.costEstimateUsd === undefined || !Number.isFinite(input.costEstimateUsd) || input.costEstimateUsd < 0) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['cost evidence is required'], holdReason: 'missing_cost_evidence' });
  if (!input.callbackId) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['callback identity is required'], holdReason: 'missing_callback_identity' });
  if (input.cleanupRequired !== true) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['cleanup policy is required'], holdReason: 'missing_cleanup_policy' });
  if (input.idempotent !== true) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['remote retries require idempotent work'], holdReason: 'non_idempotent_work' });
  const provider = input.provider ?? 'local';
  if (provider === 'hold') return decision(policy, { action: 'hold', provider, reasons: ['provider was explicitly held'], holdReason: 'invalid_contract' });
  if (!policy.enabled) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['compute routing is disabled by default'], holdReason: 'global_disabled' });
  const environment = input.environment ?? policy.environment;
  if (policy.environmentEnabled[environment] !== true) return decision(policy, { action: 'hold', provider: 'hold', reasons: [`environment ${environment} is disabled`], holdReason: 'environment_disabled' });
  if (!policy.providerEnabled[provider]) return decision(policy, { action: 'hold', provider: 'hold', reasons: [`provider ${provider} is disabled`], holdReason: 'provider_disabled' });
  if (policy.workloadClassEnabled[input.workloadClass] !== true) return decision(policy, { action: 'hold', provider: 'hold', reasons: [`workload class ${input.workloadClass} is disabled`], holdReason: 'workload_disabled' });
  if (input.classification === 'sensitive' && provider !== 'local' && !policy.allowSensitiveRemote) return decision(policy, { action: 'hold', provider: 'hold', reasons: ['sensitive data cannot leave the local provider'], holdReason: 'sensitive_data' });
  if (input.costEstimateUsd > policy.maxCostUsdByProvider[provider]) return decision(policy, { action: 'hold', provider: 'hold', reasons: [`estimated cost exceeds the ${provider} cap`], holdReason: 'cost_cap_exceeded' });
  if (policy.mode === 'shadow') return decision(policy, { action: 'shadow', provider, reasons: ['routing decision recorded without provider dispatch'] });
  return decision(policy, { action: 'dispatch', provider, reasons: ['all authorization and evidence prerequisites are present'] });
}
