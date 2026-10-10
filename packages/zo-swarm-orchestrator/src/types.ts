/**
 * Core types for Zouroboros Swarm
 * 
 * @module zouroboros-swarm/types
 */

export type PriorityQueue = 'critical' | 'high' | 'medium' | 'low';
export type ComplexityTier = 'trivial' | 'simple' | 'moderate' | 'complex';
export type RoutingStrategy = 'fast' | 'reliable' | 'balanced' | 'explore';
export type DAGMode = 'streaming' | 'waves';
export type NotificationChannel = 'none' | 'sms' | 'email';
export type ErrorCategory = 'timeout' | 'rate_limited' | 'permission_denied' | 'context_overflow' | 'mutation_failed' | 'syntax_error' | 'runtime_error' | 'unknown';
export type DelegationMode = 'auto' | 'disabled';

import type {
  ApprovalReceipt,
  PlanArtifact,
  PlanGateMode,
  PlanGateContext,
  TrustedPublicKeys,
} from 'zouroboros-workflow/plan-gate';
import type {
  ArtifactManifest,
  CleanupPolicy,
  ComputeNodeKind,
  ComputeProvider,
  DataClassification,
  ExecutionCallbackIdentity,
  ExecutionResult,
  ExecutionTelemetry,
  RoutingDecision,
  RoutingPolicy,
} from 'zouroboros-core';
import type {
  SpecialistAssignment,
  SpecialistConsultEvidence,
  SpecialistConsultMode,
  SpecialistModelIdentity,
} from './persona/specialist-consult.js';

export interface ComputeIntent {
  nodeKind: Exclude<ComputeNodeKind, 'agent'>;
  provider?: ComputeProvider;
  workloadClass: string;
  environment?: string;
  approvalId?: string;
  classification?: DataClassification;
  costEstimateUsd?: number;
  canonicalWrites?: boolean;
  externalMutations?: boolean;
  idempotent?: boolean;
  inputManifest?: readonly ArtifactManifest[];
  outputLimits?: { maxArtifacts: number; maxBytes: number };
  callback?: ExecutionCallbackIdentity;
  cleanup?: CleanupPolicy;
  idempotencyKey?: string;
  maxRuntimeMs?: number;
  maxAttempts?: number;
  maxCostUsd?: number;
}

export interface ChildWriteScope {
  childId: string;
  paths: string[];
}

export interface TaskDelegationConfig {
  mode?: DelegationMode;
  maxChildren?: number;
  writeScopes?: ChildWriteScope[];
}

export interface ChildTaskRecord {
  childId: string;
  parentTaskId: string;
  executorId: string;
  delegatedModel?: string;
  writeScope?: string[];
  toolset?: string[];
  status: 'success' | 'failure' | 'blocked' | 'skipped';
  durationMs?: number;
  artifacts?: string[];
  source?: 'executor_bridge' | 'parent_summary' | 'logger_synthesis';
  summary?: string;
}

export interface HierarchicalDelegationConfig {
  enabled: boolean;
  maxDepth: number;
  defaultMode: DelegationMode;
  claudeCodeMaxChildren: number;
  hermesMaxChildren: number;
}

export interface Task {
  id: string;
  persona: string;
  task: string;
  priority: PriorityQueue;
  executor?: string;
  agencyPersona?: string;
  role?: string;
  dependsOn?: string[];
  memoryStrategy?: 'hierarchical' | 'sliding' | 'none';
  timeoutSeconds?: number;
  expectedMutations?: Array<{ file: string; contains: string }>;
  model?: string;
  delegation?: TaskDelegationConfig;
  outputToMemory?: boolean;
  ragContext?: string;
  memoryMetadata?: {
    category?: string;
    priority?: PriorityQueue;
    tags?: string[];
  };
  /** Ordered fallback executor IDs populated during executor resolution */
  fallbackExecutors?: string[];
  /**
   * Structured inputs payload checked against role.inputs schema by the
   * execution validator (M10 W3 t7). Optional — when absent, the orchestrator
   * derives a default payload from `task.task` + RAG context.
   */
  inputs?: Record<string, unknown>;
  compute?: ComputeIntent;
  specialists?: SpecialistAssignment[];
  specialistMode?: SpecialistConsultMode;
}

export interface TaskResult {
  task: Task;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  retries: number;
  tokensUsed?: number;
  /** Bridge-reported input token count (claude-code-bridge.sh parses the CLI's
   *  --output-format json). When present, the t3-run synthesizer uses it
   *  directly instead of the 70/30 split fallback over `tokensUsed`. */
  inputTokens?: number;
  /** Bridge-reported output token count. See `inputTokens`. */
  outputTokens?: number;
  /** Bridge-reported total cost in USD (the CLI's real total_cost_usd, which
   *  accounts for cache reads and mid-run model switches). Preferred over the
   *  static per-1M rate table when present. */
  costUsd?: number;
  artifacts?: string[];
  childRecords?: ChildTaskRecord[];
  delegated?: boolean;
  modelUsed?: string;
  modelProvenance?: ModelProvenance;
  effectiveExecutor?: string;
  /** Number of fallback executors tried before success/final failure */
  fallbacksAttempted?: number;
  computeDecision?: RoutingDecision;
  computeResult?: ExecutionResult;
  computeTelemetry?: ExecutionTelemetry;
  specialistEvidence?: SpecialistConsultEvidence[];
  specialistCostUsd?: number;
}

export interface LoopGuardConfig {
  /** Maximum DAG nesting depth before a LoopDetectedError is thrown. Default: 10 */
  maxLoopDepth: number;
  /** Milliseconds before a recursive chain times out. Default: 30000 */
  loopTimeoutMs: number;
  /** Whether to open the circuit breaker on loop detection. Default: true */
  openCircuitOnLoop: boolean;
}

export interface RAGEnrichmentConfig {
  enabled: boolean;
  topK?: number;
  minScore?: number;
  collections?: string[];
}

export interface PipelineGateConfig {
  /** Run seed validation gate before execution. Default: true */
  seedValidation: boolean;
  /** Run post-flight evaluation after execution. Default: true */
  postFlightEval: boolean;
  /** Run gap audit loop after post-flight eval. Default: true */
  gapAuditLoop: boolean;
  /** Abort execution if seed validation finds critical gaps. Default: true */
  blockOnSeedFailure: boolean;
}

export interface PlanGateAuditContext {
  ticketId?: string;
  identifier?: string;
  executionId?: string;
}

export interface SwarmPlanGateConfig {
  mode: PlanGateMode;
  artifact?: PlanArtifact;
  receipt?: ApprovalReceipt;
  trustedKeys?: TrustedPublicKeys;
  workspaceRoot?: string;
  ledgerPath?: string;
  audit?: boolean;
  policyContext?: PlanGateContext;
  auditContext?: PlanGateAuditContext;
}

export interface SwarmConfig {
  localConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  dagMode: DAGMode;
  notifyOnComplete: NotificationChannel;
  routingStrategy: RoutingStrategy;
  useSixSignalRouting: boolean;
  stagnationEnabled: boolean;
  dbPath?: string;
  hierarchicalDelegation?: HierarchicalDelegationConfig;
  ragEnrichment?: RAGEnrichmentConfig;
  loopGuard?: Partial<LoopGuardConfig>;
  /** Pipeline gate enforcement — all gates ON by default */
  pipelineGates?: Partial<PipelineGateConfig>;
  planGate?: SwarmPlanGateConfig;
  computeRouting?: RoutingPolicy;
  specialistConsult?: {
    mode?: SpecialistConsultMode;
    modelName?: string;
    reviewerModels?: SpecialistModelIdentity[];
    requireDistinctReviewerModel?: boolean;
    requireReviewerVendorDiversity?: boolean;
    timeoutMs?: number;
  };
}

export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  totalFailures: number;
  totalSuccesses?: number;
  lastFailure: number;
  lastSuccess: number;
  cooldownMs: number;
  probeInFlight: boolean;
  failureCategories: Map<ErrorCategory, number>;
}

export interface ExecutorCapability {
  id: string;
  name: string;
  expertise: string[];
  bestFor: string[];
  isLocal: boolean;
}

export interface ExecutorCapabilities {
  fileRead: boolean;
  fileWrite: boolean;
  shellExec: boolean;
  webResearch: boolean;
  imageGen: boolean;
  mcp: boolean;
  streaming: boolean;
}

export interface ACPModelSelection {
  method: 'env' | 'session-config' | 'extension';
  envVar?: string;
  configId?: string;
  category?: string;
  extensionMethod?: string;
  providerSeparator?: '/' | ':';
}

export interface ACPMcpConfig {
  configPath?: string;
  includeShared?: boolean;
  includeZo?: boolean;
  includeMemoryBriefing?: boolean;
}

/**
 * Wayfinder local skill suggester.
 *
 * Sibling of `mcpConfig` on the executor registry `acp` block. In `shadow`
 * mode the factory never injects a suggestion into a task prompt: it ranks
 * the skill catalog out of band and appends the pick to the shadow log.
 * `canary` / `live` allow the pick to be injected into the task prompt, but
 * only when `WAYFINDER_LIVE_INJECT=1` is present in the environment — without
 * it they degrade to shadow. An unrecognized mode is rejected at the type
 * layer and at the seam, rather than silently changing prompts.
 */
export interface WayfinderShadowConfig {
  /** Absent or false means no ranking and no child process. */
  enabled?: boolean;
  /**
   * 'shadow' (default): rank out of band, log only, never touch the prompt.
   * 'canary': inject the pick into the prompt on the canary harness only.
   * 'live': inject the pick into the prompt on every harness.
   * Canary/live require WAYFINDER_LIVE_INJECT=1; without it they degrade to
   * shadow. WAYFINDER_DRY_RUN=1 resolves the pick but never injects it.
   */
  mode?: 'shadow' | 'canary' | 'live';
  /** Absolute path to the Wayfinder checkout (the directory holding engine/run.py). */
  engineDir?: string;
  /** Label recorded in the shadow log. Defaults to the executor id. */
  harness?: string;
  /**
   * Harness id that receives canary injection. Defaults to `harness`.
   * Ignored unless mode is 'canary'.
   */
  canaryHarness?: string;
  /** Colon-separated catalog roots; the first root wins on duplicate names. */
  skillsRoots?: string[];
  /** Wall-clock bound for the ranking worker. Shadow never blocks the task on it; live injection awaits it up to this bound. */
  timeoutMs?: number;
  /** Wayfinder state directory for modes, logs and backups. */
  home?: string;
}

export interface ACPExecutorConfig {
  adapterBin: string;
  adapterArgs?: string[];
  extraEnv?: Record<string, string>;
  allowedTools?: string[];
  mcpConfig?: ACPMcpConfig;
  modelSelection?: ACPModelSelection;
  endpointClass?: string;
  providerTemplates?: Record<string, {
    endpointClass: string;
    credentialEnv: string;
    launchConfig?: {
      envVar: string;
      value: Record<string, unknown>;
    };
  }>;
}

export interface ExecutorRollout {
  autoRoutingEnv?: string;
  factoryRoutingEnv?: string;
}

export interface TransportFallback {
  envVar: string;
  equals: string;
  transport: 'bridge' | 'acp';
}

export interface ExecutorRegistryEntry {
  id: string;
  name: string;
  executor: 'local' | 'remote';
  bridge?: string;
  description: string;
  expertise: string[];
  bestFor: string[];
  config: {
    defaultTimeout: number;
    model?: string;
    envVars?: Record<string, string>;
  };
  transport?: 'bridge' | 'acp';
  transportFallback?: TransportFallback;
  acp?: ACPExecutorConfig;
  rollout?: ExecutorRollout;
  capabilities?: ExecutorCapabilities;
  /**
   * P1-3: Persona-based tool restrictions. When a task carries a persona that
   * forbids certain capabilities, any executor whose capabilities intersect
   * with the forbidden set is excluded from selection. This converts advisory
   * prompt rules (e.g. Financial Advisor "no system tools") into mechanical
   * enforcement in the dispatch path.
   */
  forbiddenCapabilities?: Partial<ExecutorCapabilities>;
  modelRouter?: {
    defaultModel?: string;
    fallbackModel?: string;
    acceptedPrefixes?: string[];
    rejectPrefixes?: string[];
    stripPrefixes?: string[];
    passthrough?: boolean;
    tierMap?: Record<string, string>;
  };
  modelFamilies?: Array<{
    name: string;
    sourcePrefixes: string[];
    stripPrefix?: string;
  }>;
  modelPins?: Partial<Record<ComplexityTier | 'light' | 'mid' | 'heavy' | 'failover', string>>;
  healthCheck?: {
    command: string;
    expectedPattern: string;
    description: string;
  };
  sdk?: {
    ragCorpus: string;
    package: string;
    version: string;
    runtimeVersion: string;
    language: string;
    sourceType: string;
    reference: string;
    surfaces: string[];
    runtimeStatus: string;
    promotionRequired: boolean;
  };
}

export interface ModelProvenance {
  selectionEvidence?: "provider-response" | "cli-argument" | "session-config" | "environment";
  harness: string;
  requestedProvider?: string;
  requestedModel?: string;
  resolvedModel?: string;
  modelFamily?: string;
  servingProvider?: string;
  endpointClass?: string;
  credentialEnvironment?: string;
}

export interface RouteDecision {
  executorId: string;
  executorName: string;
  compositeScore: number;
  breakdown: {
    capability: number;
    health: number;
    complexityFit: number;
    history: number;
    procedure?: number;
    temporal?: number;
    budget?: number;
    role?: number;
  };
  method: 'composite' | 'fallback';
}

export interface BudgetSnapshot {
  totalSpentUSD: number;
  totalBudgetUSD: number;
  perExecutor: Record<string, number>;
}

export interface HealthSnapshot {
  [executorId: string]: { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; failures: number };
}

export interface ErrorClassification {
  type: ErrorCategory;
  retryable: boolean;
  suggestedAction: string;
}

export interface SwarmCampaign {
  id: string;
  name: string;
  tasks: Task[];
  config: Partial<SwarmConfig>;
  createdAt: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}
