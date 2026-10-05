/**
 * Zouroboros Swarm
 * 
 * Multi-agent orchestration with circuit breakers, adaptive 6/8-signal routing, and DAG execution.
 * 
 * @module zouroboros-swarm
 */

// Core types
export type {
  Task,
  TaskResult,
  SwarmConfig,
  ExecutorCapability,
  ExecutorRegistryEntry,
  RouteDecision,
  RoutingStrategy,
  DAGMode,
  ErrorCategory,
  CircuitBreakerState,
  RAGEnrichmentConfig,
  SwarmPlanGateConfig,
  ComputeIntent,
} from './types.js';

// Circuit breaker
export { CircuitBreaker, CircuitBreakerRegistry } from './circuit/breaker.js';

// Routing
export { RoutingEngine, type RoutingContext } from './routing/engine.js';
export {
  DEFAULT_MODEL_CATALOG_PATH,
  buildModelCatalog,
  catalogIsFresh,
  publishModelCatalog,
  readBestModelCatalogSync,
  readModelCatalog,
  readModelCatalogSync,
  resolveCatalogModel,
} from './routing/model-catalog.js';
export type {
  CatalogCandidate,
  CatalogRoute,
  CatalogTier,
  ModelCatalog,
  QualificationEvidence,
} from './routing/model-catalog.js';

// Registry
export {
  loadRegistry,
  findExecutor,
  listExecutors,
  getLocalExecutors,
  getAutoRoutableExecutors,
  isExecutorAutoRoutingEnabled,
} from './registry/loader.js';

// Executor
export { BridgeExecutor, type BridgeExecutionOptions } from './executor/bridge.js';
export {
  PORTABLE_HARNESS_IDS,
  buildPortableHarnessInventory,
  detectHarness,
  loadHarnessContract,
  renderCompatibilityMatrix,
  resolvePortableHarness,
  validateHarnessContract,
} from './executor/portability.js';
export type {
  HarnessContract,
  HarnessDetectionInput,
  HarnessId,
  PortableHarnessInventory,
  PortableHarnessInventoryEntry,
  PortableTool,
  ResolvedPortableHarness,
} from './executor/portability.js';

// DAG
export { DAGExecutor, type ExecutionContext, type ExecutionProgress } from './dag/executor.js';
export { createComputeDispatcher, type ComputeDispatcher, type ComputeDispatcherOptions } from './compute/dispatcher.js';

// Streaming capture
export { StreamCapture, type StreamCaptureConfig, type CapturedChunk, type StreamStats } from './streaming/capture.js';

// Stagnation detection
export {
  StagnationDetector,
  type StagnationConfig,
  type StagnationEvent,
  type TaskMonitorState,
  type StagnationType,
  type RecoveryAction,
} from './stagnation/detector.js';

// Cascade manager
export {
  CascadeManager,
  type CascadeConfig,
  type CascadeEvent,
  type TaskDependencyInfo,
  type CascadePolicy,
  type FailureImpact,
} from './cascade/manager.js';

// Cross-task context sharing
export {
  ContextSharingManager,
  type ContextSharingConfig,
  type SharedContext,
  type TaskOutputSummary,
  type ContextScope,
  type ArtifactType,
} from './context/sharing.js';

// Token optimizer
export {
  TokenOptimizer,
  type TokenOptimizerConfig,
  type TokenBudget,
  type ContextInjection,
  type TokenUsageReport,
  type MemoryStrategy,
  type InjectionTier,
} from './tokens/optimizer.js';

// RAG enrichment
export { shouldEnrichWithRAG, enrichTaskWithRAG, prefetchRAGForTasks, type RAGEnrichmentOptions } from './rag/index.js';

// Hierarchical delegation
export {
  evaluateDelegation,
  renderHierarchicalPolicyBlock,
  stripDelegationReport,
  getDelegationProfile,
  taskNeedsWriteScopes,
  hasDisjointWriteScopes,
  type HierarchicalDelegationDecision,
  type HierarchicalDelegationProfile,
} from './hierarchical.js';

// Role registry + persona seeder
export { RoleRegistry, type Role, type RoleResolution } from './roles/registry.js';
export { seedPersonasToRegistry, type PersonaEntry, type PersonaSeedOptions } from './roles/persona-seeder.js';
export {
  consultSpecialists,
  invokeZoSpecialist,
  renderSpecialistOutputs,
  resolveSpecialistConsultMode,
} from './persona/specialist-consult.js';
export type {
  ConsultSpecialistsOptions,
  SpecialistAssignment,
  SpecialistConsultEvidence,
  SpecialistConsultMode,
  SpecialistConsultPhase,
  SpecialistConsultResult,
  SpecialistRolePhase,
} from './persona/specialist-consult.js';

// Budget governor
export { BudgetGovernor, type BudgetConfig } from './budget/governor.js';

// Executor selector
export { selectExecutor, inferComplexity, type ExecutorSelection, type BudgetSnapshot, type HealthSnapshot } from './selector/executor-selector.js';

// Main orchestrator
export { SwarmOrchestrator } from './orchestrator.js';
export {
  evaluateSwarmPlanGatePreflight,
  loadSwarmPlanGateConfig,
  runSwarmPlanGatePreflight,
} from './plan-gate-preflight.js';
export type {
  SwarmPlanGateDecision,
  SwarmPlanGateFileOptions,
} from './plan-gate-preflight.js';

// Per-executor RAG-enriched SDK client
export { ExecutorClient, type ExecutorClientOptions, type RunResult } from './client/executor-client.js';

// Transport abstraction layer
export {
  BridgeTransport,
} from './transport/bridge-transport.js';
export { createTransport } from './transport/factory.js';
export type {
  ExecutorTransport,
  SessionUpdate,
  TransportOptions,
  HealthStatus,
  TransportType,
} from './transport/types.js';

// ACP transport
export { ACPTransport, type ACPTransportConfig } from './transport/acp-transport.js';

// Heartbeat
export { HeartbeatScheduler } from './heartbeat/scheduler.js';

// Verification & gap audit
export {
  CAPABILITY_MANIFEST,
  getCapability,
  getCapabilityIds,
  verifyWiring,
  printWiringReport,
  runGapAudit,
  printGapAuditReport,
} from './verification/index.js';
export type {
  Capability,
  CapabilityEdge,
  DataPrerequisite,
  CrossBoundaryCheck,
  WiringIssue,
  WiringReport,
  Gap,
  GapAuditReport,
  GapSeverity,
  GapCategory,
} from './verification/index.js';
