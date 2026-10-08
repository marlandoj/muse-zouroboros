#!/usr/bin/env bun
/**
 * Swarm Orchestrator v5.0.0 — Current TypeScript Runtime
 *
 * This is the current full-featured TypeScript runtime with:
 * - Circuit Breaker V2 (CLOSED/OPEN/HALF_OPEN with probes)
 * - Backpressure monitoring
 * - 6-signal composite routing (+procedure, +temporal)
 * - Static tier-to-model fallback for executors the model router does not cover
 * - Error classification (8 categories)
 * - Agency persona resolution
 * - Pre-flight validation
 * - Streaming & wave DAG execution modes
 * - Memory gate integration
 * - Wikilink resolution
 * - Token-optimized memory strategies
 * - Notifications (SMS/Email)
 * - Cognitive profiles
 * - Stagnation detection + auto-unstuck
 * - Mutation verification
 * - Circuit breaker persistence
 *
 * Usage:
 *   bun orchestrate-v5.ts <tasks.json> [options]
 *   bun orchestrate-v5.ts status <swarm-id>
 *   bun orchestrate-v5.ts doctor
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import {
  evaluateDelegation,
  hasDisjointWriteScopes,
  renderHierarchicalPolicyBlock,
  stripDelegationReport,
} from "../src/hierarchical";
import {
  loadSwarmPlanGateConfig,
  runSwarmPlanGatePreflight,
} from "../src/plan-gate-preflight";
import type { SwarmPlanGateFileOptions } from "../src/plan-gate-preflight";
import type { SwarmPlanGateConfig, ExecutorRegistryEntry } from "../src/types";
// RB-23: single tier-to-model contract — the CC campaign path consults the
// shared model router instead of emitting tier labels for bridges to translate.
import { resolveModelForExecutor } from "../src/routing/model-router";
import { EXECUTOR_REGISTRY_RELATIVE, resolveExecutorRegistryPath } from "../src/registry/loader";
import { bridgeOutputFailure } from "../src/executor/bridge-output";
import { captureOutcome } from "../src/standalone/trace-outcome";
import { syncEpisodeDocument } from "../src/episode-document";
import {
  consultSpecialists,
  renderSpecialistOutputs,
  resolveSpecialistConsultMode,
  type SpecialistAssignment,
  type SpecialistConsultEvidence,
} from "../src/persona/specialist-consult";

// ============================================================================
// IMPORTS FROM EXISTING MODULES
// ============================================================================

// Tier resolve for static tier-to-model fallback
import {
  estimateComplexitySync,
  TIER_TO_COMBO as STATIC_TIER_TO_COMBO,
  type TaskType,
  type ComplexityEstimate as TierResolveEstimate,
} from "./tier-resolve";

// Swarm memory and token optimizer
import { SwarmMemory, getSwarmMemory, ContextAccessMode, MemoryQuery } from "./swarm-memory";
import { HierarchicalMemory, SlidingWindowMemory, MemoryItem, MemoryStrategy } from "./token-optimizer";

// v5.1: RAG enrichment — auto-inject relevant SDK patterns from Agentic RAG
import { enrichTaskWithRAG, shouldEnrichWithRAG } from "./rag-enrichment";

// v5.2: Dep-graph — file dependency analysis for write-scope conflict detection
import { buildDepGraph } from "./dep-graph";
import { getMemoryDbPath, getWorkspaceRoot } from "zouroboros-core";

// v5.3: Swarm events — sentinel-based watch pattern integration
import { consumeSentinels, cleanStaleSentinels, type SwarmEvent } from "./swarm-events/sentinel";

// v5.4: SMS alerts for swarm failures
import { sendSwarmFailureAlert } from "./swarm-events/alerts";

// ============================================================================
// PATHS & CONFIG
// ============================================================================

function resolveSwarmWorkspace(): string {
  if (process.env.SWARM_WORKSPACE) return process.env.SWARM_WORKSPACE;
  if (process.env.ZOUROBOROS_WORKSPACE_ROOT) return process.env.ZOUROBOROS_WORKSPACE_ROOT;

  const initial = getWorkspaceRoot();
  let candidate = initial;
  while (true) {
    if (existsSync(join(candidate, EXECUTOR_REGISTRY_RELATIVE))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return initial;
    candidate = parent;
  }
}

const WORKSPACE = resolveSwarmWorkspace();
const HOME = process.env.HOME || "/root";
const SWARM_DIR = process.env.SWARM_DIR?.trim() || join(HOME, ".swarm");
const LOGS_DIR = join(SWARM_DIR, "logs");
const RESULTS_DIR = join(SWARM_DIR, "results");
const HISTORY_DB = join(SWARM_DIR, "executor-history.db");
const HISTORY_JSON = join(SWARM_DIR, "executor-history.json");
const CIRCUIT_STATE_FILE = join(SWARM_DIR, "circuit-breaker-state.json");
const MEMORY_DB = getMemoryDbPath();
const REGISTRY = resolveExecutorRegistryPath(undefined, WORKSPACE);
const MONOREPO_PERSONA_REGISTRY = join(WORKSPACE, "packages", "swarm", "assets", "persona-registry.json");
const LEGACY_PERSONA_REGISTRY = join(WORKSPACE, "Skills", "zo-swarm-orchestrator", "assets", "persona-registry.json");
const PERSONA_REGISTRY = process.env.SWARM_PERSONA_REGISTRY
  ?? (existsSync(MONOREPO_PERSONA_REGISTRY) ? MONOREPO_PERSONA_REGISTRY : LEGACY_PERSONA_REGISTRY);
const AGENCY_PERSONAS = join(WORKSPACE, "IDENTITY", "agency-agents-personas.json");
const LOCK_DIR = "/dev/shm";

// Ensure directories exist
[LOGS_DIR, RESULTS_DIR].forEach(d => mkdirSync(d, { recursive: true }));

// ============================================================================
// CONSTANTS
// ============================================================================

const CB_MAX_COOLDOWN_MS = 300_000; // 5 min cap
const CB_BACKOFF_MULTIPLIER = 2.0;
const CB_PERSIST_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour max age

// Error classification categories
const ERROR_CATEGORIES = [
  "timeout",
  "rate_limited",
  "credit_exhausted",
  "permission_denied",
  "context_overflow",
  "mutation_failed",
  "syntax_error",
  "runtime_error",
  "unknown",
] as const;
type ErrorCategory = typeof ERROR_CATEGORIES[number];

// Category-aware failure thresholds
const CB_FAILURE_THRESHOLDS: Record<ErrorCategory, number> = {
  timeout: 2,
  rate_limited: 1,
  credit_exhausted: 1,
  permission_denied: 1,
  context_overflow: 2,
  mutation_failed: 3,
  syntax_error: 3,
  runtime_error: 3,
  unknown: 3,
};

// Category-aware base cooldowns (ms)
const CB_BASE_COOLDOWN_MS: Record<ErrorCategory, number> = {
  rate_limited: 60_000,
  credit_exhausted: 600_000,
  permission_denied: 300_000,
  timeout: 30_000,
  context_overflow: 30_000,
  mutation_failed: 15_000,
  syntax_error: 15_000,
  runtime_error: 15_000,
  unknown: 30_000,
};

// Complexity affinity matrix
const COMPLEXITY_AFFINITY: Record<string, Record<string, number>> = {
  "codex":       { trivial: 0.90, simple: 0.85, moderate: 0.55, complex: 0.30 },
  "gemini":      { trivial: 0.75, simple: 0.80, moderate: 0.90, complex: 0.85 },
  "hermes":      { trivial: 0.70, simple: 0.75, moderate: 0.85, complex: 0.80 },
  "claude-code": { trivial: 0.65, simple: 0.75, moderate: 0.90, complex: 1.00 },
};

// Routing strategy weights (4-signal)
const STRATEGY_WEIGHTS = {
  fast:     { capability: 0.15, health: 0.25, complexityFit: 0.45, history: 0.15 },
  reliable: { capability: 0.20, health: 0.45, complexityFit: 0.15, history: 0.20 },
  balanced: { capability: 0.30, health: 0.35, complexityFit: 0.20, history: 0.15 },
  explore:  { capability: 0.40, health: 0.20, complexityFit: 0.20, history: 0.20 },
};

// 6-signal weights
const STRATEGY_WEIGHTS_6SIGNAL = {
  fast:     { capability: 0.12, health: 0.20, complexityFit: 0.40, history: 0.12, procedure: 0.08, temporal: 0.08 },
  reliable: { capability: 0.15, health: 0.35, complexityFit: 0.12, history: 0.18, procedure: 0.12, temporal: 0.08 },
  balanced: { capability: 0.25, health: 0.28, complexityFit: 0.16, history: 0.15, procedure: 0.10, temporal: 0.06 },
  explore:  { capability: 0.35, health: 0.16, complexityFit: 0.18, history: 0.16, procedure: 0.10, temporal: 0.05 },
};

// Static tier mapping (fallback when the model router has no spec for an executor)
const TIER_TO_COMBO: Record<string, string> = { ...STATIC_TIER_TO_COMBO };

// ============================================================================
// TYPES
// ============================================================================

type PriorityQueue = "critical" | "high" | "medium" | "low";
type ComplexityTier = "trivial" | "simple" | "moderate" | "complex";
type RoutingStrategy = "fast" | "reliable" | "balanced" | "explore";
type DAGMode = "streaming" | "waves";
type NotificationChannel = "none" | "sms" | "email";
type DelegationMode = "auto" | "disabled";

interface ChildWriteScope {
  childId: string;
  paths: string[];
}

interface TaskDelegationConfig {
  mode?: DelegationMode;
  maxChildren?: number;
  writeScopes?: ChildWriteScope[];
}

interface ChildTaskRecord {
  childId: string;
  parentTaskId: string;
  executorId: string;
  delegatedModel?: string;
  writeScope?: string[];
  toolset?: string[];
  status: "success" | "failure" | "blocked" | "skipped";
  durationMs?: number;
  artifacts?: string[];
  source?: "executor_bridge" | "parent_summary" | "logger_synthesis";
  summary?: string;
}

interface HierarchicalDelegationConfig {
  enabled: boolean;
  maxDepth: number;
  defaultMode: DelegationMode;
  claudeCodeMaxChildren: number;
  hermesMaxChildren: number;
}

interface Task {
  id: string;
  persona: string;
  task: string;
  priority: PriorityQueue;

  // Separate executor from persona
  executor?: string;
  agencyPersona?: string;

  // DAG dependencies
  dependsOn?: string[];

  // Memory configuration
  memoryStrategy?: "hierarchical" | "sliding" | "none";
  contextAccess?: ContextAccessMode;
  contextQuery?: MemoryQuery;
  contextTags?: string[];
  outputToMemory?: boolean;
  memoryMetadata?: {
    category?: string;
    priority?: PriorityQueue;
    tags?: string[];
    previousAttemptContext?: {
      previous_executor: string;
      error_type: string;
      error: string;
      suggested_action: string;
      suggested_persona?: string;
      stagnation_score?: number;
    };
  };

  // Task configuration
  timeoutSeconds?: number;
  expectedMutations?: Array<{ file: string; contains: string }>;
  model?: string;
  delegation?: TaskDelegationConfig;
  specialists?: SpecialistAssignment[];
  specialistMode?: "off" | "shadow" | "enforce";
}

interface TaskResult {
  task: Task;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
  retries: number;
  tokensUsed?: number;
  artifacts?: string[];
  childRecords?: ChildTaskRecord[];
  delegated?: boolean;
  modelUsed?: string;
  effectiveExecutor?: string;
  specialistEvidence?: SpecialistConsultEvidence[];
  specialistCostUsd?: number;
}

type PipelineMode = "full" | "execute-only" | "skip";

interface PipelineConfig {
  seedEvalGate: boolean;
  interactiveApproval: boolean;
  postFlightEval: boolean;
  gapAudit: boolean;
  memoryGateIntegration: boolean;
}

interface SeedEvalResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  score: number;
  amended: boolean;
}

interface PostFlightResult {
  passed: boolean;
  stage1: { tscClean: boolean; testsPass: boolean; buildClean: boolean; errors: string[] };
  stage2: { criteriaChecked: number; criteriaPassed: number; failures: string[] };
  stage3: { consensusNeeded: boolean; consensusResult?: string };
}

interface GapAuditResult {
  passed: boolean;
  reachability: { passed: boolean; findings: string[] };
  dataPrerequisites: { passed: boolean; findings: string[] };
  crossBoundaryState: { passed: boolean; findings: string[] };
  evalProductionParity: { passed: boolean; findings: string[] };
}

interface OrchestratorConfig {
  localConcurrency: number;
  timeoutSeconds: number;
  maxRetries: number;
  enableMemory: boolean;
  defaultMemoryStrategy: "hierarchical" | "sliding" | "none";
  maxContextTokens: number;
  crossTaskContextWindow: number;
  dagMode: DAGMode;
  memoryDbPath?: string;
  modelName?: string;
  notifyOnComplete: NotificationChannel;
  routingStrategy: RoutingStrategy;
  useSixSignalRouting: boolean;
  // Intelligence features
  stagnationEnabled: boolean;
  autoUnstuckMode: "log" | "advisory" | "activate";
  enableStreamingCapture: boolean;
  // Cascade
  cascadeMode: boolean;
  hierarchicalDelegation: HierarchicalDelegationConfig;
  // Pipeline enforcement (v5.1)
  pipeline: PipelineConfig;
  // Swarm events (v5.3)
  enableSentinelEvents: boolean;
  sentinelDir: string;
  planGate?: SwarmPlanGateConfig;
}

interface LocalAgentInvocation {
  output: string;
  modelUsed?: string;
  artifacts: string[];
  childRecords: ChildTaskRecord[];
  delegated: boolean;
}

interface ExecutorHistoryRow {
  attempts: number;
  successes: number;
  avg_ms: number;
  delegated_attempts: number;
  delegated_successes: number;
  child_attempts: number;
  child_successes: number;
  avg_child_count: number;
  avg_child_duration_ms: number;
}

interface HistorySignal {
  score: number;
  baseScore: number;
  delegationTelemetry: number;
}

interface PersistedResultsFile {
  swarmId: string;
  status?: string;
  completed?: number;
  failed?: number;
  total?: number;
  delegatedTasks?: number;
  childTaskCount?: number;
  elapsedMs?: number;
  results?: TaskResult[];
}

interface PersistedTelemetrySummary {
  delegatedTasks: number;
  childTaskCount: number;
  artifactCount: number;
  reroutedTasks: number;
  effectiveExecutors: string[];
}

interface ExecutorHistoryReportRow extends ExecutorHistoryRow {
  executor: string;
  category: string;
  last_updated: number;
}

function summarizePersistedTelemetry(resultsFile: PersistedResultsFile): PersistedTelemetrySummary {
  const results = resultsFile.results || [];
  const delegatedTasks = typeof resultsFile.delegatedTasks === "number"
    ? resultsFile.delegatedTasks
    : results.filter(result => result.delegated).length;
  const childTaskCount = typeof resultsFile.childTaskCount === "number"
    ? resultsFile.childTaskCount
    : results.reduce((sum, result) => sum + (result.childRecords?.length || 0), 0);
  const artifactCount = results.reduce((sum, result) => sum + (result.artifacts?.length || 0), 0);
  const reroutedTasks = results.filter(result => {
    const requested = result.task.executor;
    const effective = result.effectiveExecutor;
    return Boolean(requested && effective && requested !== effective);
  }).length;
  const effectiveExecutors = [...new Set(
    results
      .map(result => result.effectiveExecutor || result.task.executor)
      .filter((executor): executor is string => Boolean(executor)),
  )];

  return {
    delegatedTasks,
    childTaskCount,
    artifactCount,
    reroutedTasks,
    effectiveExecutors,
  };
}

function readExecutorHistory(limit = 10): ExecutorHistoryReportRow[] {
  try {
    ensureExecutorHistorySchema();
    const db = new Database(HISTORY_DB, { readonly: true });
    const rows = db.query(
      `SELECT
        executor,
        category,
        attempts,
        successes,
        avg_ms,
        delegated_attempts,
        delegated_successes,
        child_attempts,
        child_successes,
        avg_child_count,
        avg_child_duration_ms,
        last_updated
      FROM executor_history
      ORDER BY delegated_attempts DESC, child_attempts DESC, attempts DESC, last_updated DESC
      LIMIT ?`,
    ).all(limit) as ExecutorHistoryReportRow[];
    db.close();
    return rows;
  } catch {
    return [];
  }
}

// Circuit Breaker V2
interface CircuitBreakerV2 {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  totalFailures: number;
  lastFailure: number;
  lastSuccess: number;
  cooldownMs: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  backoffMultiplier: number;
  probeInFlight: boolean;
  failureCategories: Map<ErrorCategory, number>;
}

// Backpressure monitoring
interface BackpressureState {
  executorId: string;
  recentDurationsMs: number[];
  baselineDurationMs: number;
  pressureScore: number;
  trend: "improving" | "stable" | "degrading";
}

// Local executor
interface LocalExecutor {
  id: string;
  bridge: string;
  name: string;
}

// Executor capability
interface ExecutorCapability {
  id: string;
  name: string;
  expertise: string[];
  bestFor: string[];
  isLocal: boolean;
}

// Route decision
interface RouteDecision {
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
  };
  method: "composite" | "fallback";
}

// Stagnation signal
interface StagnationSignal {
  stagnationScore: number;
  isStagnant: boolean;
  windowSize: number;
  consecutiveSimilarity: number[];
  suggestedPersona: string;
  trigger: "similarity" | "timeout" | "mutation" | "none";
}

// Error classification
interface ErrorClassification {
  type: ErrorCategory;
  retryable: boolean;
  suggestedAction: string;
}

// Cognitive profile
interface CognitiveProfile {
  executorId: string;
  category: string;
  attempts: number;
  successes: number;
  avgDurationMs: number;
  failurePatterns: Map<string, number>;
  entityAffinities: Map<string, number>;
}

// Persisted circuit state
interface PersistedCircuitState {
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
  totalFailures: number;
  cooldownMs: number;
  lastFailure: number;
  lastSuccess: number;
  failureCategories: Record<string, number>;
  savedAt: number;
  backpressure?: {
    baselineDurationMs: number;
    pressureScore: number;
  };
}

// Progress data
interface ProgressData {
  ts: string;
  swarmId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  percentComplete: number;
  elapsedMs: number;
  status: string;
  personaMappings?: Record<string, string>;
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_CONFIG: OrchestratorConfig = {
  localConcurrency: 8,
  timeoutSeconds: 600,
  maxRetries: 3,
  enableMemory: true,
  defaultMemoryStrategy: "hierarchical",
  maxContextTokens: 16000,
  crossTaskContextWindow: 3,
  dagMode: "streaming",
  notifyOnComplete: "none",
  routingStrategy: "balanced",
  useSixSignalRouting: true,
  stagnationEnabled: true,
  autoUnstuckMode: "log",
  enableStreamingCapture: false,
  cascadeMode: true,
  hierarchicalDelegation: {
    enabled: true,
    maxDepth: 1,
    defaultMode: "auto",
    claudeCodeMaxChildren: 2,
    hermesMaxChildren: 3,
  },
  pipeline: {
    seedEvalGate: true,
    interactiveApproval: false,
    postFlightEval: true,
    gapAudit: true,
    memoryGateIntegration: true,
  },
  enableSentinelEvents: false,
  sentinelDir: process.env.SWARM_SENTINEL_DIR || "/tmp/swarm-events",
};

function ensureExecutorHistorySchema(): void {
  try {
    const db = new Database(HISTORY_DB);
    db.run(`CREATE TABLE IF NOT EXISTS executor_history (
      executor TEXT NOT NULL,
      category TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      avg_ms REAL NOT NULL DEFAULT 0,
      delegated_attempts INTEGER NOT NULL DEFAULT 0,
      delegated_successes INTEGER NOT NULL DEFAULT 0,
      child_attempts INTEGER NOT NULL DEFAULT 0,
      child_successes INTEGER NOT NULL DEFAULT 0,
      avg_child_count REAL NOT NULL DEFAULT 0,
      avg_child_duration_ms REAL NOT NULL DEFAULT 0,
      last_updated INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (executor, category)
    )`);

    const columns = new Set(
      (db.query(`PRAGMA table_info(executor_history)`).all() as Array<{ name: string }>).map(col => col.name),
    );
    const requiredColumns: Array<[string, string]> = [
      ["delegated_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["delegated_successes", "INTEGER NOT NULL DEFAULT 0"],
      ["child_attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["child_successes", "INTEGER NOT NULL DEFAULT 0"],
      ["avg_child_count", "REAL NOT NULL DEFAULT 0"],
      ["avg_child_duration_ms", "REAL NOT NULL DEFAULT 0"],
    ];

    for (const [name, definition] of requiredColumns) {
      if (!columns.has(name)) {
        db.run(`ALTER TABLE executor_history ADD COLUMN ${name} ${definition}`);
      }
    }

    db.close();
  } catch {}
}

ensureExecutorHistorySchema();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function nlog(path: string, event: string, extra: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...extra,
  });
  try {
    writeFileSync(path, entry + "\n", { flag: "a" });
  } catch {}
}

// Wikilink resolution
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
function resolveOutputWikilinks(output: string): string {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  const seen = new Set<string>();
  while ((m = WIKILINK_RE.exec(output)) !== null) {
    const entity = m[1].trim();
    if (!seen.has(entity)) {
      seen.add(entity);
      matches.push(entity);
    }
  }
  if (matches.length === 0) return "";
  try {
    const dbPath = process.env.ZO_MEMORY_DB || MEMORY_DB;
    const db = new Database(dbPath, { readonly: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      "SELECT entity, key, value FROM facts WHERE entity = ? AND value != '' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1"
    );
    const entries: string[] = [];
    for (const entity of matches) {
      const row = stmt.get(entity, nowSec) as { entity: string; key: string; value: string } | null;
      if (row) {
        entries.push(`- [[${row.entity}]].${row.key}: ${row.value.slice(0, 150)}`);
      }
    }
    db.close();
    if (entries.length === 0) return "";
    return `\n### Resolved Wikilinks\n${entries.join("\n")}`;
  } catch {
    return "";
  }
}

// Token estimation (approximate)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Truncate to budget
function truncateToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n...[truncated]";
}

// Jaccard similarity for stagnation detection
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ============================================================================
// CIRCUIT BREAKER V2
// ============================================================================

function createDefaultCircuitBreaker(): CircuitBreakerV2 {
  return {
    state: "CLOSED",
    failures: 0,
    totalFailures: 0,
    lastFailure: 0,
    lastSuccess: 0,
    cooldownMs: 30_000,
    baseCooldownMs: 30_000,
    maxCooldownMs: CB_MAX_COOLDOWN_MS,
    backoffMultiplier: CB_BACKOFF_MULTIPLIER,
    probeInFlight: false,
    failureCategories: new Map(),
  };
}

function canAttempt(cb: CircuitBreakerV2): boolean {
  if (cb.state === "CLOSED") return true;
  if (cb.state === "OPEN") {
    if (Date.now() - cb.lastFailure > cb.cooldownMs) {
      cb.state = "HALF_OPEN";
      cb.probeInFlight = false;
      return !cb.probeInFlight;
    }
    return false;
  }
  if (cb.state === "HALF_OPEN") {
    return !cb.probeInFlight;
  }
  return false;
}

function recordSuccess(cb: CircuitBreakerV2): void {
  cb.failures = 0;
  cb.lastSuccess = Date.now();
  if (cb.state === "HALF_OPEN") {
    cb.state = "CLOSED";
    cb.cooldownMs = cb.baseCooldownMs;
  }
  cb.probeInFlight = false;
}

function recordFailure(cb: CircuitBreakerV2, category?: ErrorCategory): void {
  cb.failures++;
  cb.totalFailures++;
  cb.lastFailure = Date.now();

  if (category) {
    cb.failureCategories.set(category, (cb.failureCategories.get(category) || 0) + 1);
  }

  const threshold = category ? CB_FAILURE_THRESHOLDS[category] : 3;

  if (cb.state === "HALF_OPEN") {
    cb.state = "OPEN";
    cb.cooldownMs = Math.min(cb.cooldownMs * cb.backoffMultiplier, cb.maxCooldownMs);
    cb.probeInFlight = false;
  } else if (cb.failures >= threshold) {
    cb.state = "OPEN";
    if (category) {
      cb.baseCooldownMs = CB_BASE_COOLDOWN_MS[category];
      cb.cooldownMs = cb.baseCooldownMs;
    }
  }
}

function serializeCircuitBreakers(
  breakers: Map<string, CircuitBreakerV2>,
  backpressure: Map<string, BackpressureState>
): Record<string, PersistedCircuitState> {
  const result: Record<string, PersistedCircuitState> = {};
  for (const [id, cb] of breakers) {
    const bp = backpressure.get(id);
    const cats: Record<string, number> = {};
    for (const [k, v] of cb.failureCategories) cats[k] = v;
    result[id] = {
      state: cb.state,
      failures: cb.failures,
      totalFailures: cb.totalFailures,
      cooldownMs: cb.cooldownMs,
      lastFailure: cb.lastFailure,
      lastSuccess: cb.lastSuccess,
      failureCategories: cats,
      savedAt: Date.now(),
      backpressure: bp ? {
        baselineDurationMs: bp.baselineDurationMs,
        pressureScore: bp.pressureScore,
      } : undefined,
    };
  }
  return result;
}

function deserializeCircuitBreakers(
  data: Record<string, PersistedCircuitState>
): { breakers: Map<string, CircuitBreakerV2>; backpressure: Map<string, BackpressureState> } {
  const breakers = new Map<string, CircuitBreakerV2>();
  const bp = new Map<string, BackpressureState>();
  const now = Date.now();

  for (const [id, persisted] of Object.entries(data)) {
    if (now - persisted.savedAt > CB_PERSIST_MAX_AGE_MS) {
      breakers.set(id, createDefaultCircuitBreaker());
      continue;
    }

    const cats = new Map<ErrorCategory, number>();
    for (const [k, v] of Object.entries(persisted.failureCategories)) {
      cats.set(k as ErrorCategory, v);
    }

    breakers.set(id, {
      state: persisted.state,
      failures: persisted.failures,
      totalFailures: persisted.totalFailures,
      lastFailure: persisted.lastFailure,
      lastSuccess: persisted.lastSuccess,
      cooldownMs: persisted.cooldownMs,
      baseCooldownMs: 30_000,
      maxCooldownMs: CB_MAX_COOLDOWN_MS,
      backoffMultiplier: CB_BACKOFF_MULTIPLIER,
      probeInFlight: false,
      failureCategories: cats,
    });

    if (persisted.backpressure) {
      bp.set(id, {
        executorId: id,
        recentDurationsMs: [],
        baselineDurationMs: persisted.backpressure.baselineDurationMs,
        pressureScore: persisted.backpressure.pressureScore,
        trend: "stable",
      });
    }
  }

  return { breakers, backpressure: bp };
}

// ============================================================================
// BACKPRESSURE MONITORING
// ============================================================================

function createDefaultBackpressure(executorId: string): BackpressureState {
  return {
    executorId,
    recentDurationsMs: [],
    baselineDurationMs: 30_000,
    pressureScore: 0.0,
    trend: "stable",
  };
}

function updateBackpressure(state: BackpressureState, durationMs: number): void {
  state.recentDurationsMs.push(durationMs);
  if (state.recentDurationsMs.length > 10) state.recentDurationsMs.shift();

  const avgRecent = state.recentDurationsMs.reduce((a, b) => a + b, 0) / state.recentDurationsMs.length;
  const ratio = state.baselineDurationMs > 0 ? avgRecent / state.baselineDurationMs : 1.0;

  if (ratio < 1.5) state.pressureScore = 0.0;
  else if (ratio < 2.0) state.pressureScore = 0.3;
  else if (ratio < 3.0) state.pressureScore = 0.6;
  else state.pressureScore = 0.9;

  if (ratio < 1.5) {
    state.baselineDurationMs = state.baselineDurationMs * 0.9 + durationMs * 0.1;
  }

  if (state.recentDurationsMs.length >= 5) {
    const firstHalf = state.recentDurationsMs.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const secondHalf = state.recentDurationsMs.slice(-5).reduce((a, b) => a + b, 0) / 5;
    state.trend = secondHalf < firstHalf * 0.9 ? "improving"
      : secondHalf > firstHalf * 1.1 ? "degrading" : "stable";
  }
}

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

function classifyError(errorStr: string): ErrorClassification {
  const e = errorStr.toLowerCase();

  if (e.includes("timeout") || e.includes("deadline exceeded") || e.includes("timed out")) {
    return { type: "timeout", retryable: true, suggestedAction: "Retry with longer timeout or reduce task scope" };
  }
  if (e.includes("credit") || e.includes("quota exceeded") || e.includes("402") || e.includes("payment required") || e.includes("insufficient") || e.includes("billing") || e.includes("usage limit")) {
    return { type: "credit_exhausted", retryable: true, suggestedAction: "Reroute to different executor — credits depleted on this one" };
  }
  if (e.includes("rate limit") || e.includes("too many requests") || e.includes("429")) {
    return { type: "rate_limited", retryable: true, suggestedAction: "Wait and retry with exponential backoff" };
  }
  if (e.includes("permission") || e.includes("unauthorized") || e.includes("403") || e.includes("access denied")) {
    return { type: "permission_denied", retryable: false, suggestedAction: "Check credentials and permissions" };
  }
  if (e.includes("context") || e.includes("token") || e.includes("too long") || e.includes("maximum context")) {
    return { type: "context_overflow", retryable: true, suggestedAction: "Reduce prompt size or split into smaller tasks" };
  }
  if (e.includes("mutation") || e.includes("expected file") || e.includes("must contain")) {
    return { type: "mutation_failed", retryable: true, suggestedAction: "Verify file paths and mutation constraints" };
  }
  if (e.includes("syntax") || e.includes("parse error") || e.includes("unexpected token")) {
    return { type: "syntax_error", retryable: false, suggestedAction: "Fix syntax in task description or code" };
  }
  if (e.includes("runtime") || e.includes("execution") || e.includes("exception")) {
    return { type: "runtime_error", retryable: true, suggestedAction: "Review runtime environment and dependencies" };
  }

  return { type: "unknown", retryable: true, suggestedAction: "Investigate error and retry" };
}

// ============================================================================
// STAGNATION DETECTION
// ============================================================================

const STAGNATION_THRESHOLD = 0.85;
const STAGNATION_WINDOW = 3;

function detectStagnation(
  recentOutputs: string[],
  currentTask: Task,
  elapsedMs: number,
  timeoutMs: number
): StagnationSignal {
  const signal: StagnationSignal = {
    stagnationScore: 0,
    isStagnant: false,
    windowSize: recentOutputs.length,
    consecutiveSimilarity: [],
    suggestedPersona: "",
    trigger: "none",
  };

  if (recentOutputs.length < 2) return signal;

  const similarities: number[] = [];
  for (let i = 1; i < recentOutputs.length; i++) {
    similarities.push(jaccardSimilarity(recentOutputs[i - 1], recentOutputs[i]));
  }
  signal.consecutiveSimilarity = similarities;

  const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const recentAvg = similarities.slice(-Math.min(3, similarities.length)).reduce((a, b) => a + b, 0) / Math.min(3, similarities.length);

  if (recentAvg > STAGNATION_THRESHOLD && similarities.length >= STAGNATION_WINDOW - 1) {
    signal.stagnationScore = recentAvg;
    signal.isStagnant = true;
    signal.trigger = "similarity";
  }

  if (elapsedMs > timeoutMs * 0.8) {
    signal.stagnationScore = Math.max(signal.stagnationScore, 0.7);
    signal.isStagnant = true;
    signal.trigger = "timeout";
  }

  return signal;
}

// ============================================================================
// EXECUTOR REGISTRY & CAPABILITIES
// ============================================================================

function loadExecutors(): Record<string, ExecutorCapability> {
  const executors: Record<string, ExecutorCapability> = {};

  // Load ONLY local executors from persona registry
  try {
    if (existsSync(PERSONA_REGISTRY)) {
      const registry = JSON.parse(readFileSync(PERSONA_REGISTRY, "utf-8"));
      const personas = registry.personas || [];
      for (const p of personas) {
        // Only include if it has executor === "local" AND a bridge
        if (p.executor === "local" && p.bridge) {
          const bridgePath = p.bridge.startsWith("/") ? p.bridge : join(WORKSPACE, p.bridge);
          // Verify the bridge actually exists
          if (existsSync(bridgePath)) {
            executors[p.id] = {
              id: p.id,
              name: p.name || p.id,
              expertise: p.expertise || [],
              bestFor: p.best_for || [],
              isLocal: true,
            };
          }
        }
      }
    }
  } catch {}

  // Enrich from executor registry (also only local executors)
  try {
    if (existsSync(REGISTRY)) {
      const execRegistry = JSON.parse(readFileSync(REGISTRY, "utf-8"));
      for (const ex of execRegistry.executors || []) {
        if (!ex.id) continue;
        // Only include local executors with valid bridges
        if (ex.executor !== "local") continue;
        const bridgePath = ex.bridge
          ? (ex.bridge.startsWith("/") ? ex.bridge : join(WORKSPACE, ex.bridge))
          : null;
        if (!bridgePath || !existsSync(bridgePath)) continue;

        const existing = executors[ex.id];
        if (existing) {
          // Merge expertise and best_for
          const mergedExpertise = new Set([...existing.expertise, ...(ex.expertise || [])]);
          const mergedBestFor = new Set([...existing.bestFor, ...(ex.best_for || [])]);
          existing.expertise = [...mergedExpertise];
          existing.bestFor = [...mergedBestFor];
        } else {
          executors[ex.id] = {
            id: ex.id,
            name: ex.name || ex.id,
            expertise: ex.expertise || [],
            bestFor: ex.best_for || [],
            isLocal: true,
          };
        }
      }
    }
  } catch {}

  return executors;
}

function getBridge(exid: string, executors: Record<string, ExecutorCapability>): string | null {
  const ex = executors[exid];
  if (!ex) return null;

  // Try executor-registry bridge path
  try {
    const execRegistry = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    for (const e of execRegistry.executors || []) {
      if (e.id === exid && e.bridge) {
        const p = e.bridge.startsWith("/") ? e.bridge : join(WORKSPACE, e.bridge);
        if (existsSync(p)) return p;
      }
    }
  } catch {}

  // Fallback to persona registry
  try {
    const registry = JSON.parse(readFileSync(PERSONA_REGISTRY, "utf-8"));
    for (const p of registry.personas || []) {
      if (p.id === exid && p.bridge) {
        const bridgePath = p.bridge.startsWith("/") ? p.bridge : join(WORKSPACE, p.bridge);
        if (existsSync(bridgePath)) return bridgePath;
      }
    }
  } catch {}

  // Try workspace root fallback
  const alt = join(WORKSPACE, exid + "-bridge.sh");
  if (existsSync(alt)) return alt;

  return null;
}

// ============================================================================
// AGENCY PERSONA RESOLUTION
// ============================================================================

const personaCache = new Map<string, string>();

function resolveAgencyPersona(personaName: string): string {
  if (personaCache.has(personaName)) {
    return personaCache.get(personaName)!;
  }

  try {
    if (!existsSync(AGENCY_PERSONAS)) return "";

    const index = JSON.parse(readFileSync(AGENCY_PERSONAS, "utf-8"));
    const personas = index.personas || [];

    for (const p of personas) {
      if (p.name === personaName || p.id === personaName) {
        let content = "";
        if (p.system_prompt) {
          content = p.system_prompt;
        } else if (p.prompt_file) {
          const promptPath = join(WORKSPACE, p.prompt_file);
          if (existsSync(promptPath)) {
            content = readFileSync(promptPath, "utf-8");
          }
        }
        personaCache.set(personaName, content);
        return content;
      }
    }
  } catch {}

  return "";
}

function getEffectiveExecutor(task: Task): string {
  if (task.executor) return task.executor;
  if (task.persona && task.persona !== "auto") return task.persona;
  return "";
}

// ============================================================================
// ROUTING ENGINE
// ============================================================================

function estimateComplexity(task: Task): { tier: ComplexityTier; signals: any } {
  const text = task.task || "";
  const result = estimateComplexitySync(text);
  return {
    tier: result.tier,
    signals: {
      wordCount: result._legacy?.wordCount || 0,
      fileCount: result._legacy?.fileCount || 0,
      hasMultiStep: result._legacy?.hasMultiStep || false,
      hasTool: result._legacy?.hasTool || false,
      hasAnalysis: result._legacy?.hasAnalysis || false,
    },
  };
}

function complexityFitScore(executorId: string, complexity: ComplexityTier): number {
  return COMPLEXITY_AFFINITY[executorId]?.[complexity] ?? 0.5;
}

function capScore(task: Task, ex: ExecutorCapability): number {
  const text = (task.task + " " + (task.memoryMetadata?.category || "")).toLowerCase();
  const kw = [...ex.expertise, ...ex.bestFor].map(k => k.toLowerCase());
  if (kw.length === 0) return 0.5;
  const hits = kw.filter(k => text.includes(k)).length;
  return Math.min(1.0, hits / kw.length);
}

function healthScore(cb: CircuitBreakerV2 | undefined): number {
  if (!cb) return 1.0;
  if (cb.state === "OPEN") return 0.0;
  return Math.max(0.0, 1.0 - cb.failures * 0.3);
}

function getExecutorHistoryRow(exid: string, cat: string): ExecutorHistoryRow | null {
  try {
    ensureExecutorHistorySchema();
    const db = new Database(HISTORY_DB, { readonly: true });
    const row = db.query(
      `SELECT
        attempts,
        successes,
        avg_ms,
        delegated_attempts,
        delegated_successes,
        child_attempts,
        child_successes,
        avg_child_count,
        avg_child_duration_ms
      FROM executor_history
      WHERE executor=? AND category=?`,
    ).get(exid, cat || "general") as ExecutorHistoryRow | null;
    db.close();
    return row;
  } catch {
    return null;
  }
}

function computeDelegationTelemetryScore(
  task: Task,
  executorId: string,
  row: ExecutorHistoryRow | null,
  config: OrchestratorConfig,
): number {
  const decision = evaluateDelegation(task, executorId, config);
  if (!decision.allowed || !row || row.delegated_attempts < 2) {
    return 0.5;
  }

  const delegatedSuccessRate = row.delegated_successes / Math.max(row.delegated_attempts, 1);
  const childSuccessRate = row.child_attempts >= 2
    ? row.child_successes / Math.max(row.child_attempts, 1)
    : delegatedSuccessRate;
  const childUtilization = Math.min(1, row.avg_child_count / Math.max(decision.maxChildren, 1));
  const childLatency = row.avg_child_duration_ms > 0
    ? Math.max(0, 1 - row.avg_child_duration_ms / 60_000)
    : 0.5;

  return (
    delegatedSuccessRate * 0.55 +
    childSuccessRate * 0.25 +
    childUtilization * 0.10 +
    childLatency * 0.10
  );
}

function getHistorySignal(
  exid: string,
  cat: string,
  task: Task,
  config: OrchestratorConfig,
): HistorySignal {
  const row = getExecutorHistoryRow(exid, cat);
  const baseScore = row && row.attempts >= 3 ? row.successes / row.attempts : 0.5;
  const delegationTelemetry = computeDelegationTelemetryScore(task, exid, row, config);

  if (delegationTelemetry === 0.5) {
    return { score: baseScore, baseScore, delegationTelemetry };
  }

  return {
    score: Math.max(0, Math.min(1, baseScore * 0.7 + delegationTelemetry * 0.3)),
    baseScore,
    delegationTelemetry,
  };
}

function recordHistory(
  exid: string,
  cat: string,
  ok: boolean,
  ms: number,
  telemetry?: { delegated?: boolean; childRecords?: ChildTaskRecord[] },
): void {
  try {
    ensureExecutorHistorySchema();
    const db = new Database(HISTORY_DB);
    const now = Math.floor(Date.now() / 1000);
    const childRecords = telemetry?.childRecords || [];
    const delegatedAttempt = telemetry?.delegated ? 1 : 0;
    const delegatedSuccess = telemetry?.delegated && ok ? 1 : 0;
    const childAttempts = childRecords.length;
    const childSuccesses = childRecords.filter(record => record.status === "success").length;
    const avgChildDurationMs = childRecords.length > 0
      ? childRecords.reduce((sum, record) => sum + (record.durationMs || 0), 0) / childRecords.length
      : 0;

    db.run(`INSERT INTO executor_history (
        executor,
        category,
        attempts,
        successes,
        avg_ms,
        delegated_attempts,
        delegated_successes,
        child_attempts,
        child_successes,
        avg_child_count,
        avg_child_duration_ms,
        last_updated
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(executor,category)
      DO UPDATE SET
        attempts = attempts + 1,
        successes = successes + excluded.successes,
        avg_ms = ((avg_ms * attempts) + excluded.avg_ms) / (attempts + 1),
        delegated_attempts = delegated_attempts + excluded.delegated_attempts,
        delegated_successes = delegated_successes + excluded.delegated_successes,
        child_attempts = child_attempts + excluded.child_attempts,
        child_successes = child_successes + excluded.child_successes,
        avg_child_count = CASE
          WHEN (delegated_attempts + excluded.delegated_attempts) > 0
          THEN ((avg_child_count * delegated_attempts) + (excluded.avg_child_count * excluded.delegated_attempts))
            / (delegated_attempts + excluded.delegated_attempts)
          ELSE avg_child_count
        END,
        avg_child_duration_ms = CASE
          WHEN (child_attempts + excluded.child_attempts) > 0
          THEN ((avg_child_duration_ms * child_attempts) + (excluded.avg_child_duration_ms * excluded.child_attempts))
            / (child_attempts + excluded.child_attempts)
          ELSE avg_child_duration_ms
        END,
        last_updated = excluded.last_updated`,
      [
        exid,
        cat || "general",
        1,
        ok ? 1 : 0,
        ms,
        delegatedAttempt,
        delegatedSuccess,
        childAttempts,
        childSuccesses,
        delegatedAttempt ? childAttempts : 0,
        avgChildDurationMs,
        now,
      ]);
    db.close();
  } catch {}
}

// Get procedure success rate
function getProcedureSuccessRate(executorId: string, category?: string): number {
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    const query = category
      ? "SELECT outcome FROM procedures WHERE executor=? AND category=?"
      : "SELECT outcome FROM procedures WHERE executor=?";
    const stmt = db.prepare(query);
    const rows = category
      ? stmt.all(executorId, category) as { outcome: string }[]
      : stmt.all(executorId) as { outcome: string }[];
    db.close();

    if (rows.length === 0) return 0.5;
    const successes = rows.filter(r => r.outcome === "success").length;
    return successes / rows.length;
  } catch {
    return 0.5;
  }
}

// Get recent episodic success rate
function getRecentEpisodicRate(executorId: string, sinceDays: number = 7): number {
  try {
    const db = new Database(MEMORY_DB, { readonly: true });
    const since = Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60;
    const stmt = db.prepare(
      "SELECT outcome FROM episodes WHERE entities LIKE ? AND happened_at > ?"
    );
    const rows = stmt.all(`%executor.${executorId}%`, since) as { outcome: string }[];
    db.close();

    if (rows.length === 0) return 0.5;
    const successes = rows.filter(r => r.outcome === "success").length;
    return successes / rows.length;
  } catch {
    return 0.5;
  }
}

function route(
  task: Task,
  executors: Record<string, ExecutorCapability>,
  cbs: Map<string, CircuitBreakerV2>,
  strategy: string,
  useSixSignal: boolean,
  config: OrchestratorConfig,
): RouteDecision {
  const complexity = estimateComplexity(task);
  const cat = task.memoryMetadata?.category || "general";

  const weights = useSixSignal
    ? STRATEGY_WEIGHTS_6SIGNAL[strategy as keyof typeof STRATEGY_WEIGHTS_6SIGNAL] || STRATEGY_WEIGHTS_6SIGNAL.balanced
    : STRATEGY_WEIGHTS[strategy as keyof typeof STRATEGY_WEIGHTS] || STRATEGY_WEIGHTS.balanced;

  const candidates: Array<{ id: string; name: string; score: number; breakdown: any }> = [];

  for (const [eid, ex] of Object.entries(executors)) {
    const cap = capScore(task, ex);
    const hl = healthScore(cbs.get(eid));
    const cf = complexityFitScore(eid, complexity.tier);
    const history = getHistorySignal(eid, cat, task, config);
    const hi = history.score;

    let score: number;
    let breakdown: any;

    if (useSixSignal) {
      const proc = getProcedureSuccessRate(eid, cat);
      const temp = getRecentEpisodicRate(eid, 7);
      score = weights.capability * cap + weights.health * hl + weights.complexityFit * cf +
              weights.history * hi + (weights as any).procedure * proc + (weights as any).temporal * temp;
      breakdown = {
        capability: cap,
        health: hl,
        complexityFit: cf,
        history: hi,
        historyBase: history.baseScore,
        delegationTelemetry: history.delegationTelemetry,
        procedure: proc,
        temporal: temp,
      };
    } else {
      score = weights.capability * cap + weights.health * hl + weights.complexityFit * cf + weights.history * hi;
      breakdown = {
        capability: cap,
        health: hl,
        complexityFit: cf,
        history: hi,
        historyBase: history.baseScore,
        delegationTelemetry: history.delegationTelemetry,
      };
    }

    candidates.push({ id: eid, name: ex.name, score, breakdown });
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  const top3 = candidates.slice(0, 3);

  console.log(
    `  [route:${complexity.tier}] ` +
    top3.map(c => `${c.id}(${c.score.toFixed(2)})`).join(" vs ") +
    ` -> ${top.id}`
  );

  return {
    executorId: top.id,
    executorName: top.name,
    compositeScore: top.score,
    breakdown: top.breakdown,
    method: "composite",
  };
}

// ============================================================================
// STATIC TIER FALLBACK
// ============================================================================

function resolveModelFromTier(task: Task): { model: string; source: string } {
  if (task.model) {
    return { model: task.model, source: "task_override" };
  }
  const complexity = estimateComplexity(task);
  return { model: TIER_TO_COMBO[complexity.tier] || "swarm-mid", source: "tier_static" };
}

// RB-23: registry-entry cache so the CC campaign path consults the shared
// model router with the same modelRouter overrides the factory path uses.
let _registryEntryCache: Map<string, ExecutorRegistryEntry> | null = null;

function getRegistryEntry(executorId: string): ExecutorRegistryEntry | undefined {
  if (!_registryEntryCache) {
    _registryEntryCache = new Map();
    try {
      const parsed = JSON.parse(readFileSync(REGISTRY, "utf-8"));
      for (const raw of parsed.executors || []) {
        if (!raw?.id) continue;
        _registryEntryCache.set(raw.id, {
          ...raw,
          bestFor: raw.bestFor ?? raw.best_for ?? [],
        } as ExecutorRegistryEntry);
      }
    } catch {}
  }
  return _registryEntryCache.get(executorId);
}

// RB-23: router-first resolution for local executors. Returns null when the
// router has no spec for the executor (caller falls back to resolveModelFromTier).
function resolveModelViaRouter(
  task: Task,
  executorId: string,
  tier: ComplexityTier,
): { model: string; source: string } | null {
  const res = resolveModelForExecutor(task, executorId, tier, getRegistryEntry(executorId));
  if (!res) return null;
  return { model: res.model, source: `model-router:${res.source}` };
}

// ============================================================================
// MEMORY MANAGER (Corrected for actual interfaces)
// ============================================================================

class MemoryManager {
  private swarmId: string;
  private config: OrchestratorConfig;
  private swarmMemory: SwarmMemory | null = null;
  private hierarchical: HierarchicalMemory | null = null;
  private sliding: SlidingWindowMemory | null = null;
  private contextIds: string[] = [];

  constructor(swarmId: string, config: OrchestratorConfig) {
    this.swarmId = swarmId;
    this.config = config;

    if (config.enableMemory) {
      this.swarmMemory = getSwarmMemory(config.memoryDbPath);

      if (config.defaultMemoryStrategy === "hierarchical") {
        this.hierarchical = new HierarchicalMemory({ maxTokens: config.maxContextTokens });
      } else if (config.defaultMemoryStrategy === "sliding") {
        this.sliding = new SlidingWindowMemory(Math.max(1, Math.floor(config.maxContextTokens / 2000)));
      }
    }
  }

  getContext(task: Task): string {
    if (!this.config.enableMemory || !this.swarmMemory) return "";

    // Query relevant contexts
    const query: MemoryQuery = {
      swarmId: this.swarmId,
      category: task.memoryMetadata?.category,
      priority: task.memoryMetadata?.priority,
      limit: this.config.crossTaskContextWindow,
    };

    const contexts = this.swarmMemory.queryContexts(query);
    if (contexts.length === 0) return "";

    // Build context string
    const contextStr = contexts.map(ctx => ctx.content).join("\n\n---\n\n");

    // Apply memory strategy
    if (this.hierarchical) {
      this.hierarchical.add({
        content: contextStr,
        metadata: {
          sourceAgent: "swarm_memory",
          category: task.memoryMetadata?.category,
          priority: task.memoryMetadata?.priority,
        },
      });
      return this.hierarchical.getContextString();
    }

    if (this.sliding) {
      // SlidingWindowMemory stores items internally
      return `## Prior Context\n\n${contextStr.slice(0, this.config.maxContextTokens * 4)}`;
    }

    return contextStr;
  }

  addAgentOutput(persona: string, output: string, metadata: any): void {
    if (!this.swarmMemory) return;

    const context = this.swarmMemory.writeContext(this.swarmId, output, {
      category: metadata?.category,
      priority: metadata?.priority,
      sourceAgent: persona,
      tags: metadata?.tags,
    });

    this.contextIds.push(context.id);
  }

  getStats(): any {
    if (!this.swarmMemory) return null;
    return { contexts: this.contextIds.length };
  }
}

// ============================================================================
// NDJSON LOGGER
// ============================================================================

class NdjsonLogger {
  private logPath: string;
  private buffer: any[] = [];
  private flushInterval: any;

  constructor(swarmId: string) {
    this.logPath = join(LOGS_DIR, `${swarmId}.ndjson`);
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  log(event: string, data: Record<string, unknown>): void {
    this.buffer.push({
      ts: new Date().toISOString(),
      event,
      ...data,
    });
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const lines = this.buffer.map(e => JSON.stringify(e)).join("\n") + "\n";
    try {
      writeFileSync(this.logPath, lines, { flag: "a" });
      this.buffer = [];
    } catch {}
  }

  async close(): Promise<void> {
    clearInterval(this.flushInterval);
    await this.flush();
  }
}

// ============================================================================
// ORCHESTRATOR CLASS
// ============================================================================

class SwarmOrchestrator {
  private config: OrchestratorConfig;
  private memoryManager: MemoryManager | null = null;
  private swarmId: string;
  private sessionId: string;
  private circuitBreakers: Map<string, CircuitBreakerV2> = new Map();
  private backpressureStates: Map<string, BackpressureState> = new Map();
  private results: TaskResult[] = [];
  private completedOutputs: Array<{ persona: string; category: string; summary: string }> = [];
  private logger: NdjsonLogger;
  private executors: Record<string, ExecutorCapability> = {};
  private localExecutors: Map<string, LocalExecutor> = new Map();
  private progressFile: string;
  private runStartTime: number = 0;
  private totalTaskCount: number = 0;

  constructor(swarmId: string, config: Partial<OrchestratorConfig> = {}) {
    this.swarmId = swarmId;
    this.sessionId = `${swarmId}_${Date.now()}`;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new NdjsonLogger(swarmId);
    this.progressFile = join(LOCK_DIR, `${swarmId}-progress.json`);

    if (this.config.enableMemory) {
      this.memoryManager = new MemoryManager(swarmId, this.config);
    }

    this.loadExecutors();
    this.loadCircuitBreakerState();
  }

  private loadExecutors(): void {
    this.executors = loadExecutors();

    // Load local executor bridges
    try {
      if (existsSync(PERSONA_REGISTRY)) {
        const registry = JSON.parse(readFileSync(PERSONA_REGISTRY, "utf-8"));
        for (const p of registry.personas || []) {
          if (p.executor === "local" && p.bridge) {
            const bridgePath = p.bridge.startsWith("/") ? p.bridge : join(WORKSPACE, p.bridge);
            if (existsSync(bridgePath)) {
              this.localExecutors.set(p.id, { id: p.id, bridge: bridgePath, name: p.name || p.id });
            }
          }
        }
      }
    } catch {}

    // Also try executor registry
    try {
      if (existsSync(REGISTRY)) {
        const execRegistry = JSON.parse(readFileSync(REGISTRY, "utf-8"));
        for (const ex of execRegistry.executors || []) {
          if (ex.executor === "local" && ex.bridge) {
            const bridgePath = ex.bridge.startsWith("/") ? ex.bridge : join(WORKSPACE, ex.bridge);
            if (existsSync(bridgePath)) {
              this.localExecutors.set(ex.id, { id: ex.id, bridge: bridgePath, name: ex.name || ex.id });
            }
          }
        }
      }
    } catch {}

    console.log(`  Local executors: ${[...this.localExecutors.keys()].join(", ") || "none"}`);
  }

  private loadCircuitBreakerState(): void {
    try {
      if (existsSync(CIRCUIT_STATE_FILE)) {
        const data = JSON.parse(readFileSync(CIRCUIT_STATE_FILE, "utf-8"));
        const { breakers, backpressure } = deserializeCircuitBreakers(data);
        this.circuitBreakers = breakers;
        this.backpressureStates = backpressure;
      }
    } catch {}
  }

  private saveCircuitBreakerState(): void {
    try {
      const data = serializeCircuitBreakers(this.circuitBreakers, this.backpressureStates);
      writeFileSync(CIRCUIT_STATE_FILE, JSON.stringify(data, null, 2));
    } catch {}
  }

  private writeProgress(extra: Record<string, unknown> = {}): void {
    try {
      const successful = this.results.filter(r => r.success).length;
      const failed = this.results.filter(r => !r.success).length;
      const progress: ProgressData = {
        ts: new Date().toISOString(),
        swarmId: this.swarmId,
        totalTasks: this.totalTaskCount,
        completed: successful,
        failed,
        percentComplete: this.totalTaskCount > 0 ? Math.round(((successful + failed) / this.totalTaskCount) * 100) : 0,
        elapsedMs: Date.now() - this.runStartTime,
        status: "running",
        ...extra,
      };
      writeFileSync(this.progressFile, JSON.stringify(progress, null, 2));
    } catch {}
  }

  // --------------------------------------------------------------------------
  // PREFLIGHT VALIDATION
  // --------------------------------------------------------------------------

  private async preflight(tasks: Task[]): Promise<{ ok: boolean; errors: string[] }> {
    const errors: string[] = [];

    const planGate = runSwarmPlanGatePreflight(this.config.planGate);
    console.log(`  [PLAN GATE:${planGate.mode}] ${planGate.action.toUpperCase()} - ${planGate.reason}`);
    if (planGate.auditError) console.log(`  [PLAN GATE WARN] audit failed: ${planGate.auditError}`);
    if (planGate.action === "hold") {
      errors.push(`Plan gate held execution: ${planGate.reason}`);
      return { ok: false, errors };
    }

    // Validate task structure
    for (const task of tasks) {
      const effectiveExec = getEffectiveExecutor(task);
      if (!task.id || !task.task) {
        errors.push(`Invalid task: missing required fields (id=${task.id}, executor=${effectiveExec})`);
      }
      if (task.delegation?.writeScopes && task.delegation.writeScopes.length > 0 && !hasDisjointWriteScopes(task)) {
        errors.push(`Task ${task.id} has overlapping or invalid delegation write scopes`);
      }
    }

    // v5.2: Dep-graph cross-task write-scope conflict detection
    const writeScopeTasks = tasks.filter(t => t.delegation?.writeScopes?.length);
    if (writeScopeTasks.length > 1) {
      try {
        const allWritePaths = new Map<string, string[]>();
        const allPaths: string[] = [];
        for (const task of writeScopeTasks) {
          const paths: string[] = [];
          for (const scope of task.delegation!.writeScopes!) {
            paths.push(...scope.paths);
          }
          allWritePaths.set(task.id, paths);
          allPaths.push(...paths);
        }

        const depGraph = await buildDepGraph({ path: WORKSPACE, impactFiles: allPaths });

        for (let i = 0; i < writeScopeTasks.length; i++) {
          for (let j = i + 1; j < writeScopeTasks.length; j++) {
            const tA = writeScopeTasks[i], tB = writeScopeTasks[j];
            const pathsA = allWritePaths.get(tA.id) || [];
            const pathsB = allWritePaths.get(tB.id) || [];
            const radiusA = new Set(pathsA.flatMap(p => depGraph.impactRadius[p] || []));
            const radiusB = new Set(pathsB.flatMap(p => depGraph.impactRadius[p] || []));
            const aAffectsB = pathsB.some(p => radiusA.has(p));
            const bAffectsA = pathsA.some(p => radiusB.has(p));
            if (aAffectsB || bAffectsA) {
              const direction = aAffectsB && bAffectsA ? "bidirectional" : aAffectsB ? `${tA.id}→${tB.id}` : `${tB.id}→${tA.id}`;
              errors.push(`Dep-graph conflict: tasks ${tA.id} and ${tB.id} have overlapping impact radii (${direction}) — add dependsOn to sequence them`);
            }
          }
        }

        if (depGraph.cycles.length > 0) {
          console.log(`  ⚠️  Dep-graph: ${depGraph.cycles.length} import cycle(s) detected in workspace`);
        }
      } catch (e) {
        console.log(`  ⚠️  Dep-graph analysis skipped: ${e}`);
      }
    }

    // Check for duplicates
    const ids = tasks.map(t => t.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      errors.push(`Duplicate task IDs: ${[...new Set(dupes)].join(", ")}`);
    }

    // Verify executor bridges
    for (const task of tasks) {
      const effectiveExec = getEffectiveExecutor(task);
      if (!effectiveExec) continue;
      const bridge = getBridge(effectiveExec, this.executors);
      if (!bridge) {
        errors.push(`No bridge found for executor: ${effectiveExec}`);
      }
    }

    // Verify DAG dependencies
    const taskIds = new Set(tasks.map(t => t.id));
    for (const task of tasks) {
      for (const dep of task.dependsOn || []) {
        if (!taskIds.has(dep)) {
          errors.push(`Task ${task.id} depends on unknown task: ${dep}`);
        }
      }
    }

    // Check for cycles
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const hasCycle = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      const task = taskMap.get(id);
      for (const dep of task?.dependsOn || []) {
        if (hasCycle(dep)) return true;
      }
      inStack.delete(id);
      return false;
    };
    for (const task of tasks) {
      visited.clear();
      inStack.clear();
      if (hasCycle(task.id)) {
        errors.push(`Dependency cycle detected involving task: ${task.id}`);
        break;
      }
    }

    // Check memory system
    if (this.config.enableMemory && this.memoryManager) {
      try {
        const stats = this.memoryManager.getStats();
        if (!stats) {
          errors.push("Memory system returned null stats");
        }
      } catch (e) {
        errors.push(`Memory system error: ${e}`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // --------------------------------------------------------------------------
  // MAIN EXECUTION
  // --------------------------------------------------------------------------

  async run(tasks: Task[]): Promise<TaskResult[]> {
    const startTime = Date.now();
    this.runStartTime = startTime;
    this.totalTaskCount = tasks.length;

    console.log(`\n🚀 Swarm ${this.swarmId} v5.0.0`);
    console.log(`   Tasks: ${tasks.length} | Concurrency: ${this.config.localConcurrency} | Strategy: ${this.config.routingStrategy}`);

    if (this.config.enableSentinelEvents) {
      const cleaned = cleanStaleSentinels({ dir: this.config.sentinelDir });
      if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} stale sentinel(s)`);
      console.log(`   📡 Sentinel events enabled: ${this.config.sentinelDir}`);
    }

    // Campaign locking
    const lockPath = join(LOCK_DIR, `${this.swarmId}.lock`);
    const STALE_LOCK_MS = 30 * 60 * 1000;
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        if (lock.pid !== process.pid && Date.now() - lock.ts < STALE_LOCK_MS) {
          console.log(`   ❌ Swarm ${this.swarmId} is already running (PID: ${lock.pid})`);
          return [];
        }
      } catch {}
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }));

    // Pre-flight
    const preflight = await this.preflight(tasks);
    if (!preflight.ok) {
      console.log("   ❌ Pre-flight failed:");
      for (const err of preflight.errors) console.log(`      - ${err}`);
      unlinkSync(lockPath);
      await this.logger.close();
      return [];
    }

    console.log("   ✓ Pre-flight passed\n");

    // Execute based on DAG mode
    if (this.config.dagMode === "waves") {
      await this.runDAGWaves(tasks);
    } else {
      await this.runDAGStreaming(tasks);
    }

    const totalDuration = Date.now() - startTime;
    await this.saveResults(totalDuration);
    await this.printSummary(totalDuration);
    await this.sendCompletionNotification(totalDuration);

    this.saveCircuitBreakerState();

    try { unlinkSync(lockPath); } catch {}
    await this.logger.close();

    return this.results;
  }

  // --------------------------------------------------------------------------
  // SENTINEL EVENT CONSUMPTION (v5.3)
  // --------------------------------------------------------------------------

  private processSentinelEvents(
    taskIds: Set<string>,
    completed: Set<string>,
    failed: Set<string>,
  ): SwarmEvent[] {
    if (!this.config.enableSentinelEvents) return [];

    const events = consumeSentinels(taskIds, { dir: this.config.sentinelDir });
    for (const event of events) {
      const label = `[sentinel:${event.event_type}] ${event.task_id}`;
      if (event.event_type === "pattern_match") {
        console.log(`  📡 ${label} — pattern="${event.pattern}" line="${event.matched_line?.slice(0, 80)}"`);
        this.logger.log("sentinel_event", {
          task_id: event.task_id,
          event_type: event.event_type,
          pattern: event.pattern,
          matched_line: event.matched_line,
          source: event.source,
        });
      } else if (event.event_type === "task_complete") {
        console.log(`  📡 ${label} — external completion signal`);
        completed.add(event.task_id);
        this.logger.log("sentinel_completion", { task_id: event.task_id, source: event.source });
      } else if (event.event_type === "task_failed") {
        console.log(`  📡 ${label} — external failure signal`);
        failed.add(event.task_id);
        this.logger.log("sentinel_failure", { task_id: event.task_id, source: event.source });
      }
    }

    return events;
  }

  // --------------------------------------------------------------------------
  // DAG STREAMING EXECUTION
  // --------------------------------------------------------------------------

  private async runDAGStreaming(tasks: Task[]): Promise<void> {
    const pending = new Map(tasks.map(t => [t.id, t]));
    const running = new Map<string, Promise<void>>();
    const completed = new Set<string>();
    const failed = new Set<string>();
    const failedRoots = new Set<string>();

    const canRun = (task: Task): boolean => {
      const deps = task.dependsOn || [];
      if (deps.length === 0) return true;

      if (!this.config.cascadeMode) {
        // Cascade-off: skip if any dep is a failed root
        for (const d of deps) {
          if (failed.has(d) && failedRoots.has(d)) return false;
        }
      }

      return deps.every(d => completed.has(d) || failed.has(d));
    };

    while (pending.size > 0 || running.size > 0) {
      // Start new tasks
      while (running.size < this.config.localConcurrency && pending.size > 0) {
        let started = false;
        for (const [id, task] of pending) {
          if (canRun(task)) {
            pending.delete(id);

            // Cascade-off: mark as skipped if downstream of failed root
            if (!this.config.cascadeMode) {
              const deps = task.dependsOn || [];
              for (const d of deps) {
                if (failed.has(d) && failedRoots.has(d)) {
                  console.log(`  SKIP [${id}] (downstream of failed root: ${d})`);
                  failed.add(id);
                  completed.add(id);
                  started = true;
                  break;
                }
              }
              if (completed.has(id)) continue;
            }

            const promise = this.executeTaskWithResilience(task).then(result => {
              this.results.push(result);
              if (result.success) {
                completed.add(id);
              } else {
                failed.add(id);
                if ((task.dependsOn || []).length === 0) {
                  failedRoots.add(id);
                }
              }
              running.delete(id);
              this.writeProgress();
            });
            running.set(id, promise);
            started = true;
            break;
          }
        }
        if (!started) break;
      }

      // Wait for at least one task to complete
      if (running.size > 0) {
        await Promise.race(running.values());
      }

      // Check sentinel events between iterations (v5.3)
      const allTaskIds = new Set([...pending.keys(), ...running.keys(), ...completed, ...failed]);
      this.processSentinelEvents(allTaskIds, completed, failed);

      await new Promise(r => setTimeout(r, 100));
    }
  }

  // --------------------------------------------------------------------------
  // DAG WAVES EXECUTION
  // --------------------------------------------------------------------------

  private async runDAGWaves(tasks: Task[]): Promise<void> {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const remaining = new Set(tasks.map(t => t.id));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const failedRoots = new Set<string>();

    let wave = 0;
    while (remaining.size > 0) {
      wave++;
      const waveTasks: Task[] = [];

      for (const id of remaining) {
        const task = taskMap.get(id)!;
        const deps = task.dependsOn || [];
        const depsMet = deps.every(d => completed.has(d) || failed.has(d));

        if (depsMet) {
          // Cascade-off: check if downstream of failed root
          if (!this.config.cascadeMode) {
            let skip = false;
            for (const d of deps) {
              if (failed.has(d) && failedRoots.has(d)) {
                console.log(`  SKIP [${id}] (downstream of failed root: ${d})`);
                failed.add(id);
                remaining.delete(id);
                skip = true;
                break;
              }
            }
            if (skip) continue;
          }
          waveTasks.push(task);
        }
      }

      if (waveTasks.length === 0) {
        if (remaining.size > 0) {
          console.log(`  ⚠️  Deadlock detected: ${remaining.size} tasks remain but none can run`);
          for (const id of remaining) {
            failed.add(id);
          }
        }
        break;
      }

      console.log(`\n📊 Wave ${wave}: ${waveTasks.length} tasks`);

      // Execute wave in parallel
      const waveResults = await Promise.all(
        waveTasks.map(t => this.executeTaskWithResilience(t))
      );

      for (const result of waveResults) {
        this.results.push(result);
        remaining.delete(result.task.id);
        if (result.success) {
          completed.add(result.task.id);
        } else {
          failed.add(result.task.id);
          if ((result.task.dependsOn || []).length === 0) {
            failedRoots.add(result.task.id);
          }
        }
      }

      this.writeProgress();

      // Check sentinel events between waves (v5.3)
      const allTaskIds = new Set([...remaining, ...completed, ...failed]);
      this.processSentinelEvents(allTaskIds, completed, failed);
    }
  }

  // --------------------------------------------------------------------------
  // TASK EXECUTION WITH RESILIENCE
  // --------------------------------------------------------------------------

  private async executeTaskWithResilience(task: Task): Promise<TaskResult> {
    const startTime = Date.now();
    const originalPersona = task.persona;
    const originalExecutor = task.executor;
    const cat = task.memoryMetadata?.category || "general";
    const specialistMode = resolveSpecialistConsultMode(task.specialistMode);
    const specialistEvidence: SpecialistConsultEvidence[] = [];
    let specialistCostUsd = 0;
    let specialistAdvice = "";

    if (task.specialists?.some((assignment) => assignment.phases.includes("advise"))) {
      const advice = await consultSpecialists({
        mode: specialistMode,
        phase: "advise",
        taskId: task.id,
        task: task.task,
        assignments: task.specialists,
        modelName: task.model,
        timeoutMs: (task.timeoutSeconds || this.config.timeoutSeconds) * 1000,
      });
      specialistEvidence.push(...advice.evidence);
      specialistCostUsd += advice.totalCostUsd;
      if (!advice.ok) {
        return {
          task,
          success: false,
          error: `Required specialist advice failed: ${advice.blockedReason}`,
          durationMs: Date.now() - startTime,
          retries: 0,
          specialistEvidence,
          specialistCostUsd,
        };
      }
      specialistAdvice = renderSpecialistOutputs(advice);
    }

    let retries = 0;
    let reroutes = 0;
    const MAX_REROUTES = Object.keys(this.executors).length;
    const tried = new Set<string>();
    const exhaustedExecutors = new Set<string>();
    let recentOutputs: string[] = [];

    while (retries <= this.config.maxRetries) {
      // Route to executor — with fallback chain awareness
      let exid: string;
      if (task.executor && retries === 0 && reroutes === 0) {
        exid = task.executor;
      } else if (task.persona && task.persona !== "auto" && retries === 0 && reroutes === 0) {
        exid = task.persona;
      } else {
        const decision = route(
          task,
          this.executors,
          this.circuitBreakers,
          this.config.routingStrategy,
          this.config.useSixSignalRouting,
          this.config,
        );
        exid = decision.executorId;

        // Skip exhausted executors and those already tried
        if (exhaustedExecutors.has(exid) || (tried.has(exid) && tried.size < Object.keys(this.executors).length)) {
          const alternatives = Object.keys(this.executors)
            .filter(e => !exhaustedExecutors.has(e) && !tried.has(e));
          if (alternatives.length > 0) {
            exid = alternatives[0];
            console.log(`  🔄 [${task.id}] Rerouting to ${exid} (avoiding ${[...exhaustedExecutors].join(", ") || "tried executors"})`);
          } else {
            // All executors exhausted or tried — fall back to least-recently-failed
            const fallback = Object.keys(this.executors).filter(e => !exhaustedExecutors.has(e));
            if (fallback.length > 0) {
              exid = fallback[0];
              console.log(`  🔄 [${task.id}] Last-resort reroute to ${exid}`);
            }
          }
        }
      }

      tried.add(exid);

      if (!this.circuitBreakers.has(exid)) {
        this.circuitBreakers.set(exid, createDefaultCircuitBreaker());
      }
      const cb = this.circuitBreakers.get(exid)!;

      if (!this.backpressureStates.has(exid)) {
        this.backpressureStates.set(exid, createDefaultBackpressure(exid));
      }
      const bp = this.backpressureStates.get(exid)!;

      if (!canAttempt(cb)) {
        // If circuit open, try to reroute instead of waiting
        if (reroutes < MAX_REROUTES) {
          const alternatives = Object.keys(this.executors)
            .filter(e => !exhaustedExecutors.has(e) && e !== exid);
          if (alternatives.length > 0) {
            exhaustedExecutors.add(exid);
            reroutes++;
            console.log(`  ⏏️  [${task.id}] Circuit OPEN for ${exid}, rerouting (not waiting)`);
            continue;
          }
        }
        console.log(`  ⏏️  [${task.id}] Circuit OPEN for ${exid}, no alternatives — waiting ${Math.round(cb.cooldownMs / 1000)}s...`);
        await new Promise(r => setTimeout(r, cb.cooldownMs));
        continue;
      }

      const bridge = getBridge(exid, this.executors);
      if (!bridge) {
        return { task, success: false, error: `No bridge for executor: ${exid}`, durationMs: Date.now() - startTime, retries };
      }

      const timeout = task.timeoutSeconds || this.config.timeoutSeconds;

      // Resolve model for this task.
      // RB-23 (2026-09-07): tier→model resolution is owned by model-router.ts
      // (resolveModelForExecutor). The CC campaign path consults the router for
      // every registry-known executor, so bridges receive concrete models and no
      // longer translate tier labels. resolveModelFromTier remains as the
      // static fallback for executors the router does not cover.
      const complexity = estimateComplexity(task);
      const routed = resolveModelViaRouter(task, exid, complexity.tier);
      const { model: resolvedModel, source: modelSource } = routed ?? resolveModelFromTier(task);

      // Build optimized prompt
      const prompt = await this.buildOptimizedPrompt(task, exid, retries > 0 ? recentOutputs : [], specialistAdvice);

      console.log(`  ▶️  [${task.id}] ${exid} (attempt ${retries + 1}/${this.config.maxRetries + 1}, reroute ${reroutes}/${MAX_REROUTES}) model=${resolvedModel} [${modelSource}] tier=${complexity.tier}`);

      const t0 = Date.now();
      try {
        const invocation = await this.callLocalAgent(exid, bridge, prompt, timeout, resolvedModel, complexity.tier);
        const duration = Date.now() - t0;
        const childRecords = invocation.childRecords.map(record => ({
          ...record,
          parentTaskId: task.id,
          executorId: record.executorId || exid,
        }));
        const artifacts = invocation.artifacts || [];

        if (task.specialists?.some((assignment) => assignment.phases.includes("review"))) {
          const review = await consultSpecialists({
            mode: specialistMode,
            phase: "review",
            taskId: task.id,
            task: task.task,
            implementationOutput: invocation.output,
            assignments: task.specialists,
            implementerModelName: invocation.modelUsed ?? resolvedModel,
            timeoutMs: timeout * 1000,
          });
          specialistEvidence.push(...review.evidence);
          specialistCostUsd += review.totalCostUsd;
          if (!review.ok) {
            return {
              task,
              success: false,
              output: invocation.output,
              error: `Required specialist review failed: ${review.blockedReason}`,
              durationMs: Date.now() - startTime,
              retries,
              artifacts,
              childRecords,
              delegated: invocation.delegated,
              modelUsed: invocation.modelUsed,
              effectiveExecutor: exid,
              specialistEvidence,
              specialistCostUsd,
            };
          }
        }

        // Update circuit breaker and backpressure
        recordSuccess(cb);
        updateBackpressure(bp, duration);

        // Record history
        recordHistory(exid, cat, true, duration, {
          delegated: invocation.delegated,
          childRecords,
        });

        // Add to memory
        if (this.memoryManager) {
          this.memoryManager.addAgentOutput(exid, invocation.output, { ...task.memoryMetadata, outputToMemory: task.outputToMemory });
        }

        // Update completed outputs for cross-task context
        this.completedOutputs.push({ persona: exid, category: cat, summary: invocation.output.slice(0, 300) });

        // Restore original persona/executor
        task.persona = originalPersona;
        if (task.executor !== undefined) task.executor = originalExecutor;

        this.logger.log("task_success", {
          taskId: task.id,
          executor: exid,
          durationMs: duration,
          delegated: invocation.delegated,
          childCount: childRecords.length,
          reroutes,
        });
        if (childRecords.length > 0) {
          this.logger.log("task_child_records", { taskId: task.id, executor: exid, childRecords });
        }

        return {
          task,
          success: true,
          output: invocation.output,
          durationMs: duration,
          retries,
          artifacts,
          childRecords,
          delegated: invocation.delegated,
          modelUsed: invocation.modelUsed,
          effectiveExecutor: exid,
          specialistEvidence: specialistEvidence.length > 0 ? specialistEvidence : undefined,
          specialistCostUsd: specialistCostUsd > 0 ? specialistCostUsd : undefined,
        };

      } catch (error) {
        const duration = Date.now() - t0;
        const errorStr = String(error);
        const classified = classifyError(errorStr);

        // Update circuit breaker
        recordFailure(cb, classified.type);
        updateBackpressure(bp, duration * 2); // Penalize failures

        // Record history
        recordHistory(exid, cat, false, duration);

        recentOutputs.push(errorStr);

        console.log(`  ⚠️  [${task.id}] ${exid} failed (${classified.type}): ${errorStr.slice(0, 80)}`);
        this.logger.log("task_error", {
          taskId: task.id,
          executor: exid,
          attempt: retries,
          reroute: reroutes,
          errorType: classified.type,
          retryable: classified.retryable,
        });

        // Store previous attempt context for retry
        if (!task.memoryMetadata) task.memoryMetadata = {};
        task.memoryMetadata.previousAttemptContext = {
          previous_executor: exid,
          error_type: classified.type,
          error: errorStr.slice(0, 500),
          suggested_action: classified.suggestedAction,
        };

        // Credit exhaustion or rate limit: reroute immediately without burning a retry
        if ((classified.type === "credit_exhausted" || classified.type === "rate_limited") && reroutes < MAX_REROUTES) {
          exhaustedExecutors.add(exid);
          reroutes++;
          console.log(`  💳 [${task.id}] ${exid} ${classified.type} — rerouting to next executor (reroute ${reroutes}/${MAX_REROUTES}, retries preserved at ${retries})`);
          continue;
        }

        retries++;

        if (retries <= this.config.maxRetries && classified.retryable) {
          const wait = Math.pow(2, retries - 1) * 1000;
          console.log(`  ⏳ [${task.id}] Retrying in ${wait}ms...`);
          await new Promise(r => setTimeout(r, wait));
        } else if (!classified.retryable) {
          break;
        }
      }
    }

    task.persona = originalPersona;
    if (task.executor !== undefined) task.executor = originalExecutor;

    // Fire SMS alert for task failures after all retries/reroutes exhausted.
    sendSwarmFailureAlert(
      this.swarmId,
      task.id,
      recentOutputs.length > 0 ? recentOutputs[recentOutputs.length - 1] : "Max retries exceeded"
    ).catch(() => {/* alert failure must never crash orchestrator */});

    return {
      task,
      success: false,
      error: "Max retries exceeded",
      durationMs: Date.now() - startTime,
      retries,
      specialistEvidence: specialistEvidence.length > 0 ? specialistEvidence : undefined,
      specialistCostUsd: specialistCostUsd > 0 ? specialistCostUsd : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // PROMPT BUILDING
  // --------------------------------------------------------------------------

  private async buildOptimizedPrompt(task: Task, executorId: string, recentOutputs: string[], specialistAdvice = ""): Promise<string> {
    const basePrompt = task.task;
    const delegation = evaluateDelegation(task, executorId, this.config);

    // v5.1: RAG enrichment — auto-inject relevant SDK patterns
    let ragContext = "";
    let ragPatterns = 0;
    if (shouldEnrichWithRAG(basePrompt)) {
      const { context, latencyMs, patterns, error } = await enrichTaskWithRAG(basePrompt, { topK: 3 });
      ragContext = context;
      ragPatterns = patterns;
      this.logger.log("rag_enrichment", { taskId: task.id, patterns, latencyMs, error });
    }

    // Resolve agency persona
    let personaContext = "";
    if (task.agencyPersona) {
      const personaMd = resolveAgencyPersona(task.agencyPersona);
      if (personaMd) {
        personaContext = `<persona>\n${personaMd}\n</persona>\n\n` +
          `You are acting as the "${task.agencyPersona}" persona. ` +
          `Follow the identity, rules, and deliverable formats defined above.\n`;
      }
    }

    // Get memory context
    const memoryContext = this.memoryManager?.getContext(task) || "";

    // Build cross-task context
    let crossTaskContext = "";
    if (this.completedOutputs.length > 0) {
      const isSynthesis = task.memoryMetadata?.category === "synthesis" ||
        task.id.toLowerCase().includes("synthesis") ||
        executorId.toLowerCase().includes("manager");

      const window = isSynthesis
        ? this.completedOutputs
        : this.completedOutputs.slice(-this.config.crossTaskContextWindow);

      const entries = window.map(o => `### ${o.persona} (${o.category}):\n${o.summary}`).join("\n\n");
      crossTaskContext = `## Prior Specialist Findings (${window.length})\n${entries}`;
    }

    // Failure context from previous attempts
    let failureContext = "";
    if (task.memoryMetadata?.previousAttemptContext) {
      const prev = task.memoryMetadata.previousAttemptContext;
      failureContext = `<previous-attempt-context>
Previous attempt by "${prev.previous_executor}" failed with: ${prev.error_type}
Error: ${prev.error.slice(0, 300)}
Suggestion: ${prev.suggested_action}
</previous-attempt-context>\n\n`;
    }

    // Stagnation advisory
    let unstuckAdvisory = "";
    if (recentOutputs.length > 0 && this.config.stagnationEnabled) {
      const stagnation = detectStagnation(recentOutputs, task, 0, (task.timeoutSeconds || this.config.timeoutSeconds) * 1000);
      if (stagnation.isStagnant && this.config.autoUnstuckMode !== "log") {
        unstuckAdvisory = `<unstuck-advisory>
Stagnation detected (score: ${stagnation.stagnationScore.toFixed(2)}).
Consider approaching this as a "${stagnation.suggestedPersona}" would.
</unstuck-advisory>\n\n`;
      }
    }

    // Assemble prompt
    let fullPrompt = "";
    if (specialistAdvice) fullPrompt += `## Specialist Advice\n${specialistAdvice}\n\n`;
    if (personaContext) fullPrompt += personaContext + "\n";
    if (failureContext) fullPrompt += failureContext;
    if (unstuckAdvisory) fullPrompt += unstuckAdvisory;
    if (memoryContext) fullPrompt += memoryContext + "\n\n";
    if (crossTaskContext) fullPrompt += crossTaskContext + "\n\n";
    if (ragContext) fullPrompt += ragContext + "\n\n";

    fullPrompt += renderHierarchicalPolicyBlock(task, executorId, delegation);

    fullPrompt += `## Your Task\n\n${basePrompt}`;

    // Token budget check
    const estimatedTokens = estimateTokens(fullPrompt);
    if (estimatedTokens > this.config.maxContextTokens * 0.9) {
      console.log(`  [${task.id}] Prompt exceeds token budget (${estimatedTokens}), truncating...`);

      // Truncate cross-task context first
      if (crossTaskContext && estimatedTokens > this.config.maxContextTokens) {
        const reduced = this.completedOutputs.slice(-Math.max(1, this.config.crossTaskContextWindow - 1));
        const truncated = `## Prior Specialist Findings (${reduced.length}, trimmed)\n` +
          reduced.map(o => `### ${o.persona} (${o.category}):\n${o.summary.slice(0, 200)}`).join("\n\n");
        fullPrompt = (memoryContext ? memoryContext + "\n\n" : "") + truncated + `\n\n## Your Task\n\n${basePrompt}`;
      }

      // Still over? Truncate memory
      const stillOver = estimateTokens(fullPrompt);
      if (stillOver > this.config.maxContextTokens * 0.9 && memoryContext) {
        const budgetExcess = stillOver - (this.config.maxContextTokens * 0.8);
        const truncatedMemory = truncateToBudget(memoryContext, memoryContext.length - Math.ceil(budgetExcess * 4));
        fullPrompt = truncatedMemory + "\n\n" + `## Your Task\n\n${basePrompt}`;
      }
    }

    // Mutation requirements
    if (task.expectedMutations && task.expectedMutations.length > 0) {
      const mutationList = task.expectedMutations.map(m => `- ${m.file} (must contain: "${m.contains}")`).join("\n");
      fullPrompt += `\n\nREQUIRED CHANGES:\n${mutationList}\nYou must modify these files using your file editing tools.`;
    }

    return fullPrompt;
  }

  // --------------------------------------------------------------------------
  // AGENT COMMUNICATION
  // --------------------------------------------------------------------------

  private async callLocalAgent(executorId: string, bridge: string, prompt: string, timeoutSeconds: number, resolvedModel?: string, tier?: string): Promise<LocalAgentInvocation> {
    const timeoutMs = timeoutSeconds * 1000;

    const resultFileName = `result-${randomUUID()}.json`;
    const resultFilePath = join("/tmp", resultFileName);

    try { unlinkSync(resultFilePath); } catch {}

    const env: Record<string, string | undefined> = {
      ...process.env,
      RESULT_PATH: resultFilePath,
      SWARM_TASK_ID: executorId,
      SWARM_RESOLVED_MODEL: resolvedModel || undefined,
      SWARM_TIER: tier || undefined,
      WORKSPACE,
      HOME,
    };

    const proc = spawn("bash", [bridge, prompt, WORKSPACE], { stdio: ["ignore", "pipe", "pipe"], env });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timeoutId: any;

      proc.stdout?.on("data", (data) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data) => { stderr += data.toString(); });

      timeoutId = setTimeout(() => {
        proc.kill();
        reject(new Error(`Timeout after ${timeoutSeconds}s`));
      }, timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timeoutId);

        // Try structured result first
        try {
          if (existsSync(resultFilePath)) {
            const content = readFileSync(resultFilePath, "utf-8");
            const structured = JSON.parse(content);
            if (structured.output !== undefined) {
              const rawStructuredOut = String(structured.output || "");
              const failure = bridgeOutputFailure(rawStructuredOut, stderr);
              if (failure) {
                reject(new Error(`Bridge failure: ${failure}`));
                return;
              }
              const parsed = stripDelegationReport(String(structured.output || ""));
              const childRecords = parsed.childRecords.map(record => ({
                ...record,
                parentTaskId: record.parentTaskId || executorId,
              }));
              resolve({
                output: parsed.cleanOutput,
                modelUsed: typeof structured.metrics?.model === "string" ? structured.metrics.model.trim() : undefined,
                artifacts: [
                  ...(Array.isArray(structured.artifacts?.filesCreated) ? structured.artifacts.filesCreated : []),
                  ...(Array.isArray(structured.artifacts?.filesModified) ? structured.artifacts.filesModified : []),
                  ...(Array.isArray(structured.artifacts?.filesDeleted) ? structured.artifacts.filesDeleted : []),
                  ...parsed.artifacts,
                ],
                childRecords,
                delegated: parsed.delegated,
              });
              return;
            }
          }
        } catch {}

        if (code === 0) {
          const failure = bridgeOutputFailure(stdout, stderr);
          if (failure) {
            reject(new Error(`Bridge failure: ${failure}`));
            return;
          }
          const parsed = stripDelegationReport(stdout.trim() || "OK");
          resolve({
            output: parsed.cleanOutput,
            artifacts: parsed.artifacts,
            childRecords: parsed.childRecords.map(record => ({
              ...record,
              parentTaskId: record.parentTaskId || executorId,
            })),
            delegated: parsed.delegated,
            modelUsed: undefined,
          });
        } else {
          reject(new Error(stderr || `Exit code ${code}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });
  }

  // --------------------------------------------------------------------------
  // RESULTS & NOTIFICATIONS
  // --------------------------------------------------------------------------

  private async saveResults(totalDurationMs: number): Promise<void> {
    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const delegatedTasks = this.results.filter(r => r.delegated).length;
    const childTaskCount = this.results.reduce((sum, result) => sum + (result.childRecords?.length || 0), 0);

    const results = {
      swarmId: this.swarmId,
      status: "complete",
      cascadeMode: this.config.cascadeMode,
      completed: successful,
      failed,
      total: this.results.length,
      delegatedTasks,
      childTaskCount,
      elapsedMs: totalDurationMs,
      results: this.results,
    };

    const resultsPath = join(RESULTS_DIR, `${this.swarmId}.json`);
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    // Create episode
    this.createEpisode(successful, failed, totalDurationMs, delegatedTasks, childTaskCount);
  }

  private createEpisode(successful: number, failed: number, durationMs: number, delegatedTasks: number, childTaskCount: number): void {
    let db: Database | undefined;
    try {
      if (!existsSync(MEMORY_DB)) return;

      db = new Database(MEMORY_DB);
      const episodeDb = db;
      const outcome = failed === 0 ? "success" : "failure";
      episodeDb.transaction(() => {
        episodeDb.run(`CREATE TABLE IF NOT EXISTS episodes (
          id TEXT PRIMARY KEY, summary TEXT NOT NULL, outcome TEXT NOT NULL,
          happened_at INTEGER NOT NULL, duration_ms INTEGER, procedure_id TEXT, metadata TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now')))`);

        const summary = `Swarm ${this.swarmId}: ${successful} succeeded, ${failed} failed in ${Math.round(durationMs / 1000)}s`;
        const executorIds = [...this.localExecutors.keys()];
        const episodeId = randomUUID();
        const metadata = {
          swarm_id: this.swarmId,
          tasks: this.results.length,
          succeeded: successful,
          failed,
          elapsed_ms: durationMs,
          delegated_tasks: delegatedTasks,
          child_task_count: childTaskCount,
          executors: executorIds,
          ...(process.env.ZO_TRACE_ID ? { trace_id: process.env.ZO_TRACE_ID } : {}),
        };

        episodeDb.run(
          `INSERT INTO episodes (id,summary,outcome,happened_at,duration_ms,metadata)
           VALUES (?,?,?,?,?,?)`,
          [
            episodeId,
            summary,
            outcome,
            Math.floor(Date.now() / 1000),
            durationMs,
            JSON.stringify(metadata),
          ]
        );

        syncEpisodeDocument(episodeDb, episodeId, summary, metadata);

        // Capture child task episodes for hierarchical/delegated runs
        const now = Math.floor(Date.now() / 1000);
        for (const result of this.results) {
          if (!result.childRecords?.length) continue;
          for (const child of result.childRecords) {
            const childEpisodeId = randomUUID();
            const childOutcome = child.status === "success" ? "success" : child.status === "failure" ? "failure" : "ongoing";
            const childSummary = child.summary
              ? child.summary
              : `Child task ${child.childId} (${child.executorId}): ${child.status} in ${Math.round((child.durationMs || 0) / 1000)}s`;
            const childMetadata = {
              swarm_id: this.swarmId,
              parent_episode_id: episodeId,
              parent_task_id: child.parentTaskId,
              child_id: child.childId,
              executor_id: child.executorId,
              delegated_model: child.delegatedModel,
              source: child.source,
              artifacts: child.artifacts,
            };
            episodeDb.run(
              `INSERT OR IGNORE INTO episodes (id,summary,outcome,happened_at,duration_ms,metadata)
               VALUES (?,?,?,?,?,?)`,
              [
                childEpisodeId,
                childSummary,
                childOutcome,
                now,
                child.durationMs || 0,
                JSON.stringify(childMetadata),
              ]
            );
            syncEpisodeDocument(episodeDb, childEpisodeId, childSummary, childMetadata);
          }
        }
      })();
      captureOutcome(process.env.ZO_TRACE_ID, outcome, `swarm:${this.swarmId}`, {
        tasks: this.results.length, succeeded: successful, failed, elapsed_ms: durationMs,
      });
    } catch (error) {
      console.error(`[episodes] Failed to persist swarm episode: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db?.close();
    }
  }

  private async printSummary(totalDurationMs: number): Promise<void> {
    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const telemetry = summarizePersistedTelemetry({
      swarmId: this.swarmId,
      delegatedTasks: this.results.filter(r => r.delegated).length,
      childTaskCount: this.results.reduce((sum, result) => sum + (result.childRecords?.length || 0), 0),
      results: this.results,
    });

    console.log("\n" + "=".repeat(60));
    console.log(`📊 Swarm ${this.swarmId} Summary`);
    console.log("=".repeat(60));
    console.log(`   Total tasks: ${this.results.length}`);
    console.log(`   Successful:  ${successful} ✅`);
    console.log(`   Failed:      ${failed} ${failed > 0 ? "❌" : ""}`);
    console.log(`   Duration:    ${Math.round(totalDurationMs / 1000)}s`);
    console.log(`   Delegated:   ${telemetry.delegatedTasks} parent / ${telemetry.childTaskCount} child`);
    console.log(`   Artifacts:   ${telemetry.artifactCount}`);
    console.log(`   Reroutes:    ${telemetry.reroutedTasks}`);
    console.log(`   Executors:   ${telemetry.effectiveExecutors.join(", ") || "n/a"}`);
    console.log(`   Results:     ${join(RESULTS_DIR, `${this.swarmId}.json`)}`);
    console.log("=".repeat(60));
  }

  private async sendCompletionNotification(totalDurationMs: number): Promise<void> {
    if (this.config.notifyOnComplete === "none") return;

    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;
    const message = `Swarm ${this.swarmId} complete: ${successful}/${this.results.length} tasks in ${Math.round(totalDurationMs / 1000)}s`;

    // This would integrate with Zo notification system
    // For now, just log it
    console.log(`\n📱 Notification (${this.config.notifyOnComplete}): ${message}`);
  }
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

function statusCmd(swid: string): void {
  const pf = join(LOGS_DIR, `${swid}_progress.json`);
  const rf = join(RESULTS_DIR, `${swid}.json`);

  if (existsSync(pf)) {
    const d = JSON.parse(readFileSync(pf, "utf-8")) as ProgressData;
    console.log(`🔍 Swarm Status: ${d.swarmId}`);
    console.log(`   Status: ${d.status}`);
    console.log(`   Progress: ${d.completed}/${d.totalTasks} (${d.percentComplete}%)`);
    console.log(`   Failed: ${d.failed}`);
    console.log(`   Elapsed: ${Math.round(d.elapsedMs / 1000)}s`);
  } else {
    console.log(`No progress file for swarm: ${swid}`);
  }

  if (existsSync(rf)) {
    const stats = readFileSync(rf);
    console.log(`   Results: ${rf} (${Math.round(stats.length / 1024)}KB)`);
    try {
      const results = JSON.parse(stats.toString("utf8")) as PersistedResultsFile;
      const telemetry = summarizePersistedTelemetry(results);
      const elapsedSeconds = typeof results.elapsedMs === "number" ? Math.round(results.elapsedMs / 1000) : null;
      const completed = typeof results.completed === "number" ? results.completed : results.results?.filter(result => result.success).length;
      const failed = typeof results.failed === "number" ? results.failed : results.results?.filter(result => !result.success).length;
      const total = typeof results.total === "number" ? results.total : results.results?.length;

      console.log(`   Outcome: ${completed ?? 0}/${total ?? 0} succeeded, ${failed ?? 0} failed`);
      if (elapsedSeconds !== null) {
        console.log(`   Duration: ${elapsedSeconds}s`);
      }
      console.log(`   Delegated: ${telemetry.delegatedTasks} parent / ${telemetry.childTaskCount} child`);
      console.log(`   Artifacts: ${telemetry.artifactCount}`);
      console.log(`   Reroutes: ${telemetry.reroutedTasks}`);
      console.log(`   Executors: ${telemetry.effectiveExecutors.join(", ") || "n/a"}`);
    } catch {}
  }
}

function historyCmd(limit = 10): void {
  const rows = readExecutorHistory(limit);

  console.log("📚 Swarm Executor History");
  console.log(`   DB: ${HISTORY_DB}`);

  if (rows.length === 0) {
    console.log("   No executor history found.");
    return;
  }

  for (const row of rows) {
    const successRate = row.attempts > 0 ? Math.round((row.successes / row.attempts) * 100) : 0;
    const delegatedRate = row.delegated_attempts > 0
      ? Math.round((row.delegated_successes / row.delegated_attempts) * 100)
      : null;
    const childRate = row.child_attempts > 0
      ? Math.round((row.child_successes / row.child_attempts) * 100)
      : null;
    const updated = row.last_updated ? new Date(row.last_updated * 1000).toISOString() : "n/a";

    console.log(`\n   ${row.executor} [${row.category}]`);
    console.log(`     Base: ${row.successes}/${row.attempts} (${successRate}%) avg ${Math.round(row.avg_ms)}ms`);
    console.log(
      `     Delegation: ${row.delegated_attempts} attempts`
      + (delegatedRate !== null ? ` (${delegatedRate}% success)` : ""),
    );
    console.log(
      `     Children: ${row.child_successes}/${row.child_attempts}`
      + (childRate !== null ? ` (${childRate}%)` : "")
      + ` avg count ${row.avg_child_count.toFixed(1)} avg child ${Math.round(row.avg_child_duration_ms)}ms`,
    );
    console.log(`     Updated: ${updated}`);
  }
}

function readRegistryEntries(path: string, key: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const entries = parsed[key];
    if (!Array.isArray(entries)) return null;
    return entries.filter(
      (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
    );
  } catch {
    return null;
  }
}

function doctorCmd(): boolean {
  console.log("🔧 Swarm Doctor v5.0.0\n");

  let healthy = true;
  const reportRequired = (label: string, path: string, passed: boolean): void => {
    console.log(`${passed ? "✅" : "❌"} ${label}: ${path}`);
    if (!passed) healthy = false;
  };

  [SWARM_DIR, LOGS_DIR, RESULTS_DIR].forEach((directory) => {
    reportRequired("Directory", directory, existsSync(directory));
  });

  console.log("\nRequired state:");
  reportRequired("Memory DB", MEMORY_DB, existsSync(MEMORY_DB));

  const executorEntries = readRegistryEntries(REGISTRY, "executors");
  const personaEntries = readRegistryEntries(PERSONA_REGISTRY, "personas");
  reportRequired(
    "Executor registry",
    REGISTRY,
    executorEntries !== null && executorEntries.length > 0,
  );
  reportRequired(
    "Persona registry",
    PERSONA_REGISTRY,
    personaEntries !== null && personaEntries.length > 0,
  );

  console.log("\nExecutors:");
  const localExecutors = (executorEntries ?? []).filter((entry) => entry.executor === "local");
  if (localExecutors.length === 0) {
    console.log("  ❌ No local executors are registered");
    healthy = false;
  }
  for (const entry of localExecutors) {
    const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : "<missing-id>";
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id;
    const bridgeRef = typeof entry.bridge === "string" && entry.bridge.length > 0
      ? entry.bridge
      : null;
    const bridgePath = bridgeRef
      ? (bridgeRef.startsWith("/") ? bridgeRef : join(WORKSPACE, bridgeRef))
      : null;
    const transport = typeof entry.transport === "string" ? entry.transport : null;
    const acp = typeof entry.acp === "object" && entry.acp !== null
      ? entry.acp as Record<string, unknown>
      : null;
    const adapterBin = typeof acp?.adapterBin === "string" ? acp.adapterBin : null;
    const nativeTransportPath = transport === "acp" && adapterBin ? Bun.which(adapterBin) : null;
    const transportOk = bridgePath !== null
      ? existsSync(bridgePath)
      : nativeTransportPath !== null;
    const executorOk = id !== "<missing-id>" && transportOk;
    const transportDetail = bridgePath ?? nativeTransportPath ?? (transport ? `${transport} transport` : "");
    console.log(`  ${executorOk ? "✅" : "❌"} ${id}: ${name}${transportDetail ? ` (${transportDetail})` : ""}`);
    if (!executorOk) healthy = false;
  }

  const agencyConfigured = existsSync(AGENCY_PERSONAS);
  const agencyEntries = agencyConfigured ? readRegistryEntries(AGENCY_PERSONAS, "personas") : null;
  if (!agencyConfigured) {
    console.log(`\nℹ️ Optional agency personas not configured: ${AGENCY_PERSONAS}`);
  } else {
    console.log(
      `\n${agencyEntries !== null ? "✅" : "⚠️"} Optional agency personas: ${AGENCY_PERSONAS}`,
    );
  }

  console.log(healthy ? "\n✅ Doctor complete" : "\n❌ Doctor failed");
  return healthy;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log("Usage: bun orchestrate-v5.ts <tasks.json> [options]");
    console.log("       bun orchestrate-v5.ts status <swarm-id>");
    console.log("       bun orchestrate-v5.ts history [limit]");
    console.log("       bun orchestrate-v5.ts doctor");
    console.log("\nOptions:");
    console.log("  --swarm-id ID         Set swarm ID");
    console.log("  --concurrency N       Max parallel tasks (default: 8)");
    console.log("  --timeout S          Per-task timeout (default: 600s)");
    console.log("  --max-retries N      Max retries per task (default: 3)");
    console.log("  --strategy STRAT     balanced|fast|reliable|explore (default: balanced)");
    console.log("  --dag-mode MODE      streaming|waves (default: streaming)");
    console.log("  --no-cascade         Skip downstream tasks when root fails");
    console.log("  --notify CHANNEL     none|sms|email (default: none)");
    console.log("  --4-signal           Use 4-signal routing (default: 6-signal)");
    console.log("  --swarm-events       Enable sentinel event consumption from watch patterns");
    console.log("  --sentinel-dir DIR   Sentinel directory (default: /tmp/swarm-events)");
    console.log("  --plan-gate-mode M   disabled|advisory|shadow|enforce");
    console.log("  --plan-gate-plan P   Structured plan artifact path");
    console.log("  --plan-gate-receipt P Approval receipt path");
    console.log("  --plan-gate-ledger P Audit ledger path");
    process.exit(1);
  }

  if (args[0] === "status") {
    if (args.length < 2) {
      console.log("Usage: orchestrate-v5.ts status <swarm-id>");
      process.exit(1);
    }
    statusCmd(args[1]);
    process.exit(0);
  }

  if (args[0] === "doctor") {
    process.exit(doctorCmd() ? 0 : 1);
  }

  if (args[0] === "history") {
    const limit = args[1] ? parseInt(args[1], 10) : 10;
    historyCmd(Number.isFinite(limit) && limit > 0 ? limit : 10);
    process.exit(0);
  }

  const campaign = args[0];
  if (!existsSync(campaign)) {
    console.log(`File not found: ${campaign}`);
    process.exit(1);
  }

  // Parse tasks
  let tasks: Task[];
  try {
    tasks = JSON.parse(readFileSync(campaign, "utf-8"));
  } catch (e) {
    console.log(`Invalid JSON: ${e}`);
    process.exit(1);
  }

  // Parse options
  let swarmId = `swarm_${Date.now()}`;
  const config: Partial<OrchestratorConfig> = {};
  const planGateOptions: SwarmPlanGateFileOptions = {};

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--swarm-id":
        if (i + 1 < args.length) swarmId = args[++i];
        break;
      case "--concurrency":
        if (i + 1 < args.length) config.localConcurrency = parseInt(args[++i]);
        break;
      case "--timeout":
        if (i + 1 < args.length) config.timeoutSeconds = parseInt(args[++i]);
        break;
      case "--max-retries":
        if (i + 1 < args.length) config.maxRetries = parseInt(args[++i]);
        break;
      case "--strategy":
        if (i + 1 < args.length) config.routingStrategy = args[++i] as RoutingStrategy;
        break;
      case "--dag-mode":
        if (i + 1 < args.length) config.dagMode = args[++i] as DAGMode;
        break;
      case "--no-cascade":
        config.cascadeMode = false;
        break;
      case "--notify":
        if (i + 1 < args.length) config.notifyOnComplete = args[++i] as NotificationChannel;
        break;
      case "--4-signal":
        config.useSixSignalRouting = false;
        break;
      case "--swarm-events":
        config.enableSentinelEvents = true;
        break;
      case "--sentinel-dir":
        if (i + 1 < args.length) {
          config.sentinelDir = args[++i];
          config.enableSentinelEvents = true;
        }
        break;
      case "--plan-gate-mode":
        if (i + 1 < args.length) planGateOptions.mode = args[++i];
        break;
      case "--plan-gate-plan":
        if (i + 1 < args.length) planGateOptions.planPath = args[++i];
        break;
      case "--plan-gate-receipt":
        if (i + 1 < args.length) planGateOptions.receiptPath = args[++i];
        break;
      case "--plan-gate-ledger":
        if (i + 1 < args.length) planGateOptions.ledgerPath = args[++i];
        break;
    }
  }

  config.planGate = loadSwarmPlanGateConfig(planGateOptions);

  // Run orchestrator
  const orchestrator = new SwarmOrchestrator(swarmId, config);
  await orchestrator.run(tasks);
}

main().catch(e => {
  console.error(`Fatal error: ${e}`);
  process.exit(1);
});
