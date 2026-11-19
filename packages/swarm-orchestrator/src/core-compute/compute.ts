import { createHash } from 'node:crypto';

export const EXECUTION_CONTRACT_VERSION = 1 as const;

export type ComputeProvider = 'local' | 'modal' | 'hetzner' | 'hold';
export type DispatchMode = 'shadow' | 'enforce';
export type ComputeNodeKind = 'agent' | 'compute' | 'verification';
export type DataClassification = 'public' | 'internal' | 'sensitive';
export type ExecutionState = 'pending' | 'leased' | 'running' | 'succeeded' | 'failed' | 'held' | 'quarantined' | 'cancelled';
export type TerminalExecutionState = Extract<ExecutionState, 'succeeded' | 'failed' | 'held' | 'quarantined' | 'cancelled'>;
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
  | 'unauthorized_mutation'
  | 'non_idempotent_work'
  | 'sensitive_data'
  | 'cost_cap_exceeded'
  | 'invalid_contract';

export interface ArtifactManifest {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  artifactId: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  immutable: true;
  contentAddressed: true;
}

export interface ExecutionCallbackIdentity {
  callbackId: string;
  nonce: string;
  expiresAt: string;
}

export interface CleanupPolicy {
  required: true;
  deadlineAt: string;
}

export interface ExecutionLease {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  leaseId: string;
  executionId: string;
  issuedAt: string;
  expiresAt: string;
  maxRuntimeMs: number;
  maxAttempts: number;
  maxCostUsd: number;
}

export interface ExecutionEnvelope {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  executionId: string;
  traceId: string;
  nodeKind: ComputeNodeKind;
  workloadClass: string;
  provider: Exclude<ComputeProvider, 'hold'>;
  policyVersion: string;
  approvalId: string;
  classification: DataClassification;
  canonicalWrites: false;
  externalMutations: false;
  inputManifest: readonly ArtifactManifest[];
  outputLimits: {
    maxArtifacts: number;
    maxBytes: number;
  };
  callback: ExecutionCallbackIdentity;
  cleanup: CleanupPolicy;
  lease: ExecutionLease;
  idempotencyKey: string;
  costEstimateUsd: number;
  createdAt: string;
}

export interface ExecutionAttempt {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  executionId: string;
  leaseId: string;
  attemptId: string;
  attemptNumber: number;
  provider: Exclude<ComputeProvider, 'hold'>;
  idempotencyKey: string;
  startedAt: string;
  maxRuntimeMs: number;
}

export interface CallbackReceipt {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  executionId: string;
  attemptId: string;
  callbackId: string;
  nonce: string;
  receivedAt: string;
  terminalState: TerminalExecutionState;
  resultDigest: string;
}

export interface CleanupReceipt {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  executionId: string;
  attemptId: string;
  clean: boolean;
  completedAt: string;
}

export interface ExecutionResult {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  executionId: string;
  attemptId: string;
  provider: Exclude<ComputeProvider, 'hold'>;
  terminalState: TerminalExecutionState;
  outputManifest: readonly ArtifactManifest[];
  callback: CallbackReceipt;
  cleanup: CleanupReceipt;
  costActualUsd?: number;
  providerRequestId?: string;
}

export interface ExecutionTelemetry {
  schemaVersion: typeof EXECUTION_CONTRACT_VERSION;
  executionId: string;
  attemptId: string;
  traceId: string;
  provider: Exclude<ComputeProvider, 'hold'>;
  workloadClass: string;
  queueLatencyMs: number;
  runLatencyMs: number;
  callbackLatencyMs: number;
  outputArtifacts: number;
  outputBytes: number;
  costEstimateUsd: number;
  costActualUsd: number | null;
  costPerVerifiedArtifactUsd: number | null;
  cleanupComplete: boolean;
  terminalState: TerminalExecutionState;
}

export interface ProviderAdapter {
  readonly provider: Exclude<ComputeProvider, 'hold'>;
  execute(envelope: ExecutionEnvelope, attempt: ExecutionAttempt): Promise<ExecutionResult>;
  cancel(envelope: ExecutionEnvelope, attempt: ExecutionAttempt): Promise<void>;
}

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

const DATA_CLASSIFICATIONS: readonly DataClassification[] = ['public', 'internal', 'sensitive'];
const NODE_KINDS: readonly ComputeNodeKind[] = ['agent', 'compute', 'verification'];
const PROVIDERS: readonly Exclude<ComputeProvider, 'hold'>[] = ['local', 'modal', 'hetzner'];
const TERMINAL_STATES: readonly TerminalExecutionState[] = ['succeeded', 'failed', 'held', 'quarantined', 'cancelled'];
const LEGAL_TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = Object.freeze({
  pending: ['leased', 'held', 'cancelled'],
  leased: ['running', 'held', 'cancelled'],
  running: ['succeeded', 'failed', 'quarantined', 'cancelled'],
  succeeded: [],
  failed: [],
  held: [],
  quarantined: [],
  cancelled: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredFiniteNumber(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(`${field} must be a finite number >= ${minimum}`);
  return value;
}

function requiredInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = requiredFiniteNumber(value, field, minimum);
  if (!Number.isInteger(parsed)) throw new Error(`${field} must be an integer`);
  return parsed;
}

function requiredIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`);
  return timestamp;
}

function requiredSha256(value: unknown, field: string): string {
  const digest = requiredString(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function validateManifest(value: unknown, field: string, maxBytes: number): ArtifactManifest {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (value.schemaVersion !== EXECUTION_CONTRACT_VERSION) throw new Error(`${field}.schemaVersion is unsupported`);
  const sizeBytes = requiredInteger(value.sizeBytes, `${field}.sizeBytes`);
  if (sizeBytes > maxBytes) throw new Error(`${field}.sizeBytes exceeds the envelope limit`);
  if (value.immutable !== true || value.contentAddressed !== true) throw new Error(`${field} must be immutable and content-addressed`);
  return Object.freeze({
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    artifactId: requiredString(value.artifactId, `${field}.artifactId`),
    mediaType: requiredString(value.mediaType, `${field}.mediaType`),
    sizeBytes,
    sha256: requiredSha256(value.sha256, `${field}.sha256`),
    immutable: true,
    contentAddressed: true,
  });
}

function totalBytes(manifest: readonly ArtifactManifest[]): number {
  return manifest.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
}

function validateLease(value: unknown, executionId: string): ExecutionLease {
  if (!isRecord(value)) throw new Error('execution envelope lease is required');
  if (value.schemaVersion !== EXECUTION_CONTRACT_VERSION) throw new Error('lease.schemaVersion is unsupported');
  if (value.executionId !== executionId) throw new Error('lease.executionId does not match envelope');
  const issuedAt = requiredIsoTimestamp(value.issuedAt, 'lease.issuedAt');
  const expiresAt = requiredIsoTimestamp(value.expiresAt, 'lease.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new Error('lease.expiresAt must be after lease.issuedAt');
  return Object.freeze({
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    leaseId: requiredString(value.leaseId, 'lease.leaseId'),
    executionId,
    issuedAt,
    expiresAt,
    maxRuntimeMs: requiredInteger(value.maxRuntimeMs, 'lease.maxRuntimeMs', 1),
    maxAttempts: requiredInteger(value.maxAttempts, 'lease.maxAttempts', 1),
    maxCostUsd: requiredFiniteNumber(value.maxCostUsd, 'lease.maxCostUsd'),
  });
}

export function computeResultDigest(manifest: readonly ArtifactManifest[]): string {
  const canonical = [...manifest]
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .map((artifact) => `${artifact.artifactId}\u0000${artifact.mediaType}\u0000${artifact.sizeBytes}\u0000${artifact.sha256}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

export class CallbackReplayGuard {
  private readonly consumed = new Set<string>();

  consume(receipt: Pick<CallbackReceipt, 'callbackId' | 'nonce'>): void {
    const key = `${receipt.callbackId}\u0000${receipt.nonce}`;
    if (this.consumed.has(key)) throw new Error('execution result callback receipt was replayed');
    this.consumed.add(key);
  }
}

export function assertExecutionTransition(from: ExecutionState, to: ExecutionState): void {
  if (!LEGAL_TRANSITIONS[from]?.includes(to)) throw new Error(`illegal execution transition: ${from} -> ${to}`);
}

export function validateExecutionEnvelope(input: unknown): ExecutionEnvelope {
  if (!isRecord(input)) throw new Error('execution envelope must be an object');
  if (input.schemaVersion !== EXECUTION_CONTRACT_VERSION) throw new Error('execution envelope schemaVersion is unsupported');
  if (!PROVIDERS.includes(input.provider as Exclude<ComputeProvider, 'hold'>)) throw new Error('execution envelope provider is invalid');
  if (!NODE_KINDS.includes(input.nodeKind as ComputeNodeKind)) throw new Error('execution envelope nodeKind is invalid');
  if (input.canonicalWrites !== false || input.externalMutations !== false) throw new Error('provider execution cannot mutate canonical or external state');
  const executionId = requiredString(input.executionId, 'executionId');
  const outputLimits = input.outputLimits;
  if (!isRecord(outputLimits)) throw new Error('execution envelope outputLimits are required');
  const maxArtifacts = requiredInteger(outputLimits.maxArtifacts, 'outputLimits.maxArtifacts', 1);
  const maxBytes = requiredInteger(outputLimits.maxBytes, 'outputLimits.maxBytes', 1);
  if (!Array.isArray(input.inputManifest)) throw new Error('execution envelope inputManifest is required');
  if (input.inputManifest.length > maxArtifacts) throw new Error('inputManifest exceeds the artifact limit');
  const inputManifest = input.inputManifest.map((manifest, index) => validateManifest(manifest, `inputManifest[${index}]`, maxBytes));
  if (totalBytes(inputManifest) > maxBytes) throw new Error('inputManifest exceeds the aggregate byte limit');
  if (!isRecord(input.callback)) throw new Error('execution envelope callback identity is required');
  if (!isRecord(input.cleanup) || input.cleanup.required !== true) throw new Error('execution envelope cleanup policy is required');
  if (!DATA_CLASSIFICATIONS.includes(input.classification as DataClassification)) throw new Error('execution envelope classification is invalid');
  const callback = Object.freeze({
    callbackId: requiredString(input.callback.callbackId, 'callback.callbackId'),
    nonce: requiredString(input.callback.nonce, 'callback.nonce'),
    expiresAt: requiredIsoTimestamp(input.callback.expiresAt, 'callback.expiresAt'),
  });
  const cleanup = Object.freeze({
    required: true as const,
    deadlineAt: requiredIsoTimestamp(input.cleanup.deadlineAt, 'cleanup.deadlineAt'),
  });
  const envelope: ExecutionEnvelope = {
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId,
    traceId: requiredString(input.traceId, 'traceId'),
    nodeKind: input.nodeKind as ComputeNodeKind,
    workloadClass: requiredString(input.workloadClass, 'workloadClass'),
    provider: input.provider as Exclude<ComputeProvider, 'hold'>,
    policyVersion: requiredString(input.policyVersion, 'policyVersion'),
    approvalId: requiredString(input.approvalId, 'approvalId'),
    classification: input.classification as DataClassification,
    canonicalWrites: false,
    externalMutations: false,
    inputManifest: Object.freeze(inputManifest),
    outputLimits: Object.freeze({ maxArtifacts, maxBytes }),
    callback,
    cleanup,
    lease: validateLease(input.lease, executionId),
    idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
    costEstimateUsd: requiredFiniteNumber(input.costEstimateUsd, 'costEstimateUsd'),
    createdAt: requiredIsoTimestamp(input.createdAt, 'createdAt'),
  };
  if (envelope.costEstimateUsd > envelope.lease.maxCostUsd) throw new Error('costEstimateUsd exceeds lease.maxCostUsd');
  return Object.freeze(envelope);
}

export function validateExecutionAttempt(envelope: ExecutionEnvelope, input: unknown): ExecutionAttempt {
  if (!isRecord(input)) throw new Error('execution attempt must be an object');
  if (input.schemaVersion !== EXECUTION_CONTRACT_VERSION) throw new Error('execution attempt schemaVersion is unsupported');
  if (input.executionId !== envelope.executionId || input.leaseId !== envelope.lease.leaseId) throw new Error('execution attempt does not match envelope lease');
  if (input.provider !== envelope.provider || input.idempotencyKey !== envelope.idempotencyKey) throw new Error('execution attempt provider or idempotency key does not match envelope');
  const attemptNumber = requiredInteger(input.attemptNumber, 'attempt.attemptNumber', 1);
  if (attemptNumber > envelope.lease.maxAttempts) throw new Error('execution attempt exceeds lease.maxAttempts');
  const maxRuntimeMs = requiredInteger(input.maxRuntimeMs, 'attempt.maxRuntimeMs', 1);
  if (maxRuntimeMs > envelope.lease.maxRuntimeMs) throw new Error('execution attempt exceeds lease.maxRuntimeMs');
  return Object.freeze({
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId: envelope.executionId,
    leaseId: envelope.lease.leaseId,
    attemptId: requiredString(input.attemptId, 'attempt.attemptId'),
    attemptNumber,
    provider: envelope.provider,
    idempotencyKey: envelope.idempotencyKey,
    startedAt: requiredIsoTimestamp(input.startedAt, 'attempt.startedAt'),
    maxRuntimeMs,
  });
}

export function validateExecutionResult(
  envelope: ExecutionEnvelope,
  result: unknown,
  options: { attempt?: ExecutionAttempt; replayGuard?: CallbackReplayGuard } = {},
): ExecutionResult {
  if (!isRecord(result)) throw new Error('execution result must be an object');
  if (result.schemaVersion !== EXECUTION_CONTRACT_VERSION) throw new Error('execution result schemaVersion is unsupported');
  if (result.executionId !== envelope.executionId) throw new Error('execution result executionId does not match envelope');
  if (result.provider !== envelope.provider) throw new Error('execution result provider does not match envelope');
  if (!TERMINAL_STATES.includes(result.terminalState as TerminalExecutionState)) throw new Error('execution result terminalState is invalid');
  const attemptId = requiredString(result.attemptId, 'result.attemptId');
  if (options.attempt && attemptId !== options.attempt.attemptId) throw new Error('execution result attemptId does not match attempt');
  if (!Array.isArray(result.outputManifest)) throw new Error('execution result outputManifest is required');
  if (result.outputManifest.length > envelope.outputLimits.maxArtifacts) throw new Error('outputManifest exceeds the artifact limit');
  const outputManifest = result.outputManifest.map((manifest, index) => validateManifest(manifest, `outputManifest[${index}]`, envelope.outputLimits.maxBytes));
  if (totalBytes(outputManifest) > envelope.outputLimits.maxBytes) throw new Error('outputManifest exceeds the aggregate byte limit');
  if (!isRecord(result.callback)) throw new Error('execution result callback receipt is required');
  const callback: CallbackReceipt = {
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId: requiredString(result.callback.executionId, 'callback.executionId'),
    attemptId: requiredString(result.callback.attemptId, 'callback.attemptId'),
    callbackId: requiredString(result.callback.callbackId, 'callback.callbackId'),
    nonce: requiredString(result.callback.nonce, 'callback.nonce'),
    receivedAt: requiredIsoTimestamp(result.callback.receivedAt, 'callback.receivedAt'),
    terminalState: result.callback.terminalState as TerminalExecutionState,
    resultDigest: requiredSha256(result.callback.resultDigest, 'callback.resultDigest'),
  };
  if (!TERMINAL_STATES.includes(callback.terminalState)) throw new Error('callback.terminalState is invalid');
  if (
    callback.executionId !== envelope.executionId
    || callback.attemptId !== attemptId
    || callback.callbackId !== envelope.callback.callbackId
    || callback.nonce !== envelope.callback.nonce
  ) throw new Error('execution result callback receipt does not match envelope');
  if (callback.terminalState !== result.terminalState) throw new Error('execution result terminal state does not match callback');
  if (callback.resultDigest !== computeResultDigest(outputManifest)) throw new Error('execution result digest does not match output manifest');
  options.replayGuard?.consume(callback);
  if (!isRecord(result.cleanup)) throw new Error('execution result cleanup receipt is required');
  const cleanup: CleanupReceipt = {
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId: requiredString(result.cleanup.executionId, 'cleanup.executionId'),
    attemptId: requiredString(result.cleanup.attemptId, 'cleanup.attemptId'),
    clean: result.cleanup.clean === true,
    completedAt: requiredIsoTimestamp(result.cleanup.completedAt, 'cleanup.completedAt'),
  };
  if (!cleanup.clean || cleanup.executionId !== envelope.executionId || cleanup.attemptId !== attemptId) throw new Error('execution result cleanup receipt is incomplete');
  const costActualUsd = result.costActualUsd === undefined
    ? undefined
    : requiredFiniteNumber(result.costActualUsd, 'result.costActualUsd');
  if (costActualUsd !== undefined && costActualUsd > envelope.lease.maxCostUsd) throw new Error('execution result cost exceeds lease.maxCostUsd');
  return Object.freeze({
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId: envelope.executionId,
    attemptId,
    provider: envelope.provider,
    terminalState: result.terminalState as TerminalExecutionState,
    outputManifest: Object.freeze(outputManifest),
    callback: Object.freeze(callback),
    cleanup: Object.freeze(cleanup),
    ...(costActualUsd === undefined ? {} : { costActualUsd }),
    ...(result.providerRequestId === undefined ? {} : { providerRequestId: requiredString(result.providerRequestId, 'result.providerRequestId') }),
  });
}

export function createExecutionTelemetry(
  envelope: ExecutionEnvelope,
  attempt: ExecutionAttempt,
  result: ExecutionResult,
): ExecutionTelemetry {
  const createdMs = Date.parse(envelope.createdAt);
  const startedMs = Date.parse(attempt.startedAt);
  const callbackMs = Date.parse(result.callback.receivedAt);
  const cleanupMs = Date.parse(result.cleanup.completedAt);
  const verifiedArtifacts = result.terminalState === 'succeeded' ? result.outputManifest.length : 0;
  const actual = result.costActualUsd ?? null;
  return Object.freeze({
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId: envelope.executionId,
    attemptId: attempt.attemptId,
    traceId: envelope.traceId,
    provider: envelope.provider,
    workloadClass: envelope.workloadClass,
    queueLatencyMs: Math.max(0, startedMs - createdMs),
    runLatencyMs: Math.max(0, callbackMs - startedMs),
    callbackLatencyMs: Math.max(0, cleanupMs - callbackMs),
    outputArtifacts: result.outputManifest.length,
    outputBytes: totalBytes(result.outputManifest),
    costEstimateUsd: envelope.costEstimateUsd,
    costActualUsd: actual,
    costPerVerifiedArtifactUsd: actual !== null && verifiedArtifacts > 0 ? actual / verifiedArtifacts : null,
    cleanupComplete: result.cleanup.clean,
    terminalState: result.terminalState,
  });
}

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
