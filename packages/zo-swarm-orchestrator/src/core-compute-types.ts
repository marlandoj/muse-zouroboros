/**
 * Core compute contract types — vendored from the Zouroboros monorepo
 * (packages/core/src/compute.ts), verbatim.
 *
 * The npm-published zouroboros-core@2.2.0 does not export these members
 * (same version number, older content), so they are defined locally to keep
 * this package's typecheck green. Types only — no runtime behavior.
 *
 * If the published zouroboros-core ever exports them, delete this file and
 * restore the `from 'zouroboros-core'` import in types.ts.
 */

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

export interface ProviderAdapter {
  readonly provider: Exclude<ComputeProvider, 'hold'>;
  execute(envelope: ExecutionEnvelope, attempt: ExecutionAttempt): Promise<ExecutionResult>;
  cancel(envelope: ExecutionEnvelope, attempt: ExecutionAttempt): Promise<void>;
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
