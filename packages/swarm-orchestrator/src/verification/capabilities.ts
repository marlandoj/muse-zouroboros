/**
 * Capability Manifest — declarative registry of swarm capabilities,
 * their source modules, expected importers, and runtime data prerequisites.
 *
 * Used by verify-wiring.ts and gap-audit.ts to mechanically confirm
 * that every capability is built, wired, AND populated.
 */

export interface CapabilityEdge {
  /** Source module that exports the capability */
  sourceModule: string;
  /** Exported symbol(s) */
  exports: string[];
  /** Modules that must import at least one of the exports */
  expectedImporters: string[];
  /** Call sites: file + function/method that actually invokes the export */
  callSites: Array<{ file: string; pattern: string }>;
}

export interface DataPrerequisite {
  id: string;
  description: string;
  /** Shell command that exits 0 if prerequisite is met */
  checkCommand?: string;
  /** Programmatic check function name (resolved at runtime) */
  checkFn?: string;
  /** Minimum expected value for count-based checks */
  minCount?: number;
}

export interface CrossBoundaryCheck {
  id: string;
  description: string;
  /** Environment variable that must be set */
  envVar?: string;
  /** File sentinel that must exist */
  fileSentinel?: string;
  /** Process that must be running */
  processName?: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  /** Wiring edges: module → importer → call site */
  edges: CapabilityEdge[];
  /** Data that must exist at runtime */
  dataPrerequisites: DataPrerequisite[];
  /** Cross-boundary state that must survive process restarts */
  crossBoundary: CrossBoundaryCheck[];
}

/**
 * The canonical capability manifest.
 * Add new capabilities here when they're implemented.
 */
export const CAPABILITY_MANIFEST: Capability[] = [
  {
    id: 'executor-selector',
    name: 'Executor Selector',
    description: 'Dynamic task→executor routing via tag heuristics, role resolution, budget, and health',
    edges: [
      {
        sourceModule: 'selector/executor-selector.ts',
        exports: ['selectExecutor', 'inferComplexity'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'selectExecutor\\(' },
        ],
      },
    ],
    dataPrerequisites: [
      {
        id: 'executor-registry-loaded',
        description: 'At least 1 executor in registry',
        checkFn: 'checkExecutorRegistryLoaded',
        minCount: 1,
      },
    ],
    crossBoundary: [
      {
        id: 'executor-registry-file',
        description: 'Executor registry JSON must exist on disk',
        fileSentinel: 'executor/registry/executor-registry.json',
      },
    ],
  },
  {
    id: 'rag-enrichment',
    name: 'RAG Enrichment',
    description: 'Pre-flight memory context injection into task prompts',
    edges: [
      {
        sourceModule: 'rag/index.ts',
        exports: ['shouldEnrichWithRAG', 'enrichTaskWithRAG', 'prefetchRAGForTasks'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'prefetchRAGForTasks\\(' },
        ],
      },
      {
        sourceModule: 'rag/enrichment.ts',
        exports: ['shouldEnrichWithRAG', 'enrichTaskWithRAG', 'prefetchRAGForTasks'],
        expectedImporters: ['rag/index.ts'],
        callSites: [],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'hierarchical-delegation',
    name: 'Hierarchical Delegation',
    description: 'Parent-child task decomposition with write-scope isolation',
    edges: [
      {
        sourceModule: 'hierarchical.ts',
        exports: ['evaluateDelegation', 'renderHierarchicalPolicyBlock', 'stripDelegationReport'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'evaluateDelegation\\(' },
          { file: 'orchestrator.ts', pattern: 'renderHierarchicalPolicyBlock\\(' },
          { file: 'orchestrator.ts', pattern: 'stripDelegationReport\\(' },
        ],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'role-registry',
    name: 'Role Registry',
    description: 'Named roles mapped to executor + model, backed by SQLite',
    edges: [
      {
        sourceModule: 'roles/registry.ts',
        exports: ['RoleRegistry'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'this\\.roleRegistry\\.resolve\\(' },
          { file: 'orchestrator.ts', pattern: 'new RoleRegistry\\(' },
        ],
      },
      {
        sourceModule: 'roles/persona-seeder.ts',
        exports: ['seedPersonasToRegistry'],
        expectedImporters: ['index.ts'],
        callSites: [],
      },
    ],
    dataPrerequisites: [
      {
        id: 'roles-seeded',
        description: 'RoleRegistry must have seeded roles (not empty)',
        checkFn: 'checkRolesSeeded',
        minCount: 1,
      },
    ],
    crossBoundary: [
      {
        id: 'swarm-db-file',
        description: 'SQLite database file must exist for role persistence',
        fileSentinel: 'swarm.db',
      },
    ],
  },
  {
    id: 'budget-governor',
    name: 'Budget Governor',
    description: 'Per-swarm budget tracking, cost estimation, and hard-cap enforcement',
    edges: [
      {
        sourceModule: 'budget/governor.ts',
        exports: ['BudgetGovernor'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'new BudgetGovernor\\(' },
          { file: 'orchestrator.ts', pattern: 'budgetGov\\.recordUsage\\(' },
          { file: 'orchestrator.ts', pattern: 'budgetGov\\.getState\\(' },
          { file: 'orchestrator.ts', pattern: 'budgetGov\\.getDowngradeTarget\\(' },
        ],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'routing-engine',
    name: '6-Signal Routing Engine',
    description: 'Composite routing with capability, health, complexity, history, procedure, temporal signals',
    edges: [
      {
        sourceModule: 'routing/engine.ts',
        exports: ['RoutingEngine'],
        expectedImporters: ['orchestrator.ts', 'index.ts', 'selector/executor-selector.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'new RoutingEngine\\(' },
        ],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'circuit-breaker',
    name: 'Circuit Breaker',
    description: 'Per-executor circuit breaker with CLOSED/OPEN/HALF_OPEN states',
    edges: [
      {
        sourceModule: 'circuit/breaker.ts',
        exports: ['CircuitBreaker', 'CircuitBreakerRegistry'],
        expectedImporters: ['orchestrator.ts', 'index.ts', 'transport/bridge-transport.ts', 'transport/acp-transport.ts', 'transport/factory.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'new CircuitBreakerRegistry\\(' },
          { file: 'orchestrator.ts', pattern: 'this\\.circuitBreakers\\.get\\(' },
        ],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'dag-executor',
    name: 'DAG Executor',
    description: 'Dependency-aware task execution in streaming or wave mode with ECC-009 loop guard',
    edges: [
      {
        sourceModule: 'dag/executor.ts',
        exports: ['DAGExecutor'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'new DAGExecutor\\(' },
          { file: 'orchestrator.ts', pattern: 'dag\\.execute\\(' },
        ],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'transport-abstraction',
    name: 'Transport Abstraction',
    description: 'Bridge and ACP transports behind a common interface',
    edges: [
      {
        sourceModule: 'transport/factory.ts',
        exports: ['createTransport'],
        expectedImporters: ['orchestrator.ts', 'index.ts'],
        callSites: [
          { file: 'orchestrator.ts', pattern: 'createTransport\\(' },
        ],
      },
      {
        sourceModule: 'transport/bridge-transport.ts',
        exports: ['BridgeTransport'],
        expectedImporters: ['transport/factory.ts', 'index.ts'],
        callSites: [],
      },
      {
        sourceModule: 'transport/acp-transport.ts',
        exports: ['ACPTransport'],
        expectedImporters: ['transport/factory.ts', 'index.ts'],
        callSites: [],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'cascade-manager',
    name: 'Cascade Manager',
    description: 'Failure cascade analysis and partial DAG recovery',
    edges: [
      {
        sourceModule: 'cascade/manager.ts',
        exports: ['CascadeManager'],
        expectedImporters: ['index.ts', 'dag/executor.ts'],
        callSites: [
          { file: 'dag/executor.ts', pattern: 'cascadeManager\\?' },
        ],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'stagnation-detector',
    name: 'Stagnation Detector',
    description: 'Loop and stagnation detection with auto-recovery',
    edges: [
      {
        sourceModule: 'stagnation/detector.ts',
        exports: ['StagnationDetector'],
        expectedImporters: ['index.ts'],
        callSites: [],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
  {
    id: 'heartbeat-scheduler',
    name: 'Heartbeat Scheduler',
    description: 'Periodic health monitoring of circuit breaker states',
    edges: [
      {
        sourceModule: 'heartbeat/scheduler.ts',
        exports: ['HeartbeatScheduler'],
        expectedImporters: ['index.ts'],
        callSites: [],
      },
    ],
    dataPrerequisites: [],
    crossBoundary: [],
  },
];

/** Look up a capability by ID */
export function getCapability(id: string): Capability | undefined {
  return CAPABILITY_MANIFEST.find(c => c.id === id);
}

/** Get all capability IDs */
export function getCapabilityIds(): string[] {
  return CAPABILITY_MANIFEST.map(c => c.id);
}
