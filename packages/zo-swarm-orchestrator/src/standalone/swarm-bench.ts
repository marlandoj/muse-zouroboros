#!/usr/bin/env bun
/**
 * SWARM-bench: Trifecta-integrated Evaluation Harness for Swarm Task Quality
 *
 * Uses the full Trifecta stack:
 * - Executor Selector for intelligent task→executor routing
 * - Budget Governor for per-executor cost tracking
 * - Transport factory for real executor dispatch (bridge + ACP)
 * - Circuit breakers for health-aware fallback
 *
 * Usage:
 *   bun swarm-bench.ts init <name>              # Create new benchmark suite
 *   bun swarm-bench.ts run <benchmark.json>     # Run benchmark suite
 *   bun swarm-bench.ts run <suite> --executor auto  # Let selector choose
 *   bun swarm-bench.ts run <suite> --budget 5.00    # Set budget cap ($)
 *   bun swarm-bench.ts verify <result.json>     # Verify AC compliance
 *   bun swarm-bench.ts leaderboard              # Show executor rankings
 *   bun swarm-bench.ts compare <run1> <run2>    # Compare two runs
 *   bun swarm-bench.ts report                   # Generate HTML report
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

// Trifecta imports
import { selectExecutor, type BudgetSnapshot, type HealthSnapshot } from '../selector/executor-selector.js';
import { BudgetGovernor } from '../budget/governor.js';
import { RoleRegistry } from '../roles/registry.js';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';
import { loadRegistry, getLocalExecutors } from '../registry/loader.js';
import { createTransport } from '../transport/factory.js';
import type { ExecutorTransport, TransportOptions } from '../transport/types.js';
import type { Task, TaskResult, ExecutorRegistryEntry } from '../types.js';
import { closeDb, getDb } from '../db/schema.js';

// ============================================================================
// PATHS & CONFIG
// ============================================================================

const WORKSPACE = process.env.SWARM_WORKSPACE || "/home/workspace";
const HOME = process.env.HOME || "/root";
const SWARM_DIR = join(HOME, ".swarm");
const BENCH_DIR = join(SWARM_DIR, "bench");
const BENCH_DATASETS = join(BENCH_DIR, "datasets");
const BENCH_RESULTS = join(BENCH_DIR, "results");
const BENCH_WORKSPACES = join(BENCH_DIR, "workspaces");
const BENCH_LEADERBOARD = join(BENCH_DIR, "leaderboard.json");
const BENCH_DB = process.env.BENCH_DB || join(BENCH_DIR, "bench.db");
const BENCH_REPORT = join(BENCH_DIR, "report.html");

// Ensure directories exist
[BENCH_DIR, BENCH_DATASETS, BENCH_RESULTS, BENCH_WORKSPACES].forEach(d => mkdirSync(d, { recursive: true }));

// ============================================================================
// TYPES
// ============================================================================

type ACType = "file_exists" | "content_match" | "schema_validation" | "test_pass" | "semantic_similarity" | "no_error";
type TaskDifficulty = "trivial" | "simple" | "moderate" | "complex" | "deep_research";
type VerificationResult = "pass" | "partial" | "fail" | "skip";

interface AcceptanceCriterion {
  type: ACType;
  description: string;
  weight: number;
  // file_exists
  path?: string;
  // content_match
  file?: string;
  pattern?: string;
  pattern_flags?: string;
  contains?: string[];
  // test_pass
  test_command?: string;
  command?: string;
  expected_exit_code?: number;
  // semantic_similarity
  reference_output?: string;
  similarity_threshold?: number;
  // no_error
  error_pattern?: string[];
  // schema_validation
  schema?: object;
  data_path?: string;
}

interface BenchmarkInstance {
  id: string;
  name: string;
  description: string;
  difficulty: TaskDifficulty;
  category: string;
  task: string;
  persona: string;
  executor?: string;
  role?: string;
  timeout_seconds?: number;
  setup_script?: string;
  initial_files?: Array<{ path: string; content: string }>;
  acceptance_criteria: AcceptanceCriterion[];
  ground_truth?: {
    expected_output?: string;
    expected_files?: Array<{ path: string; content?: string; pattern?: string }>;
  };
  tags?: string[];
  source?: string;
}

interface BenchmarkSuite {
  name: string;
  version: string;
  description: string;
  instances: BenchmarkInstance[];
  config?: {
    concurrency?: number;
    default_timeout?: number;
    workspace_isolation?: "git_worktree" | "copy" | "none";
  };
}

interface ExecutorSelectionRecord {
  executorId: string;
  confidence: number;
  reasoning: string;
  fallbacks: string[];
  model?: string;
}

interface InstanceResult {
  instance_id: string;
  success: boolean;
  score: number;
  duration_ms: number;
  output?: string;
  error?: string;
  ac_results: ACVerification[];
  tokens_used?: number;
  model_used?: string;
  routing_decision?: ExecutorSelectionRecord;
  cost_usd?: number;
}

interface ACVerification {
  criterion: AcceptanceCriterion;
  result: VerificationResult;
  details: string;
  score: number;
}

interface BenchmarkRun {
  id: string;
  suite_name: string;
  timestamp: number;
  executor: string;
  budget_config?: { totalBudgetUSD: number };
  results: InstanceResult[];
  summary: {
    total: number;
    passed: number;
    partial: number;
    failed: number;
    skipped: number;
    avg_score: number;
    total_duration_ms: number;
    total_cost_usd: number;
    budget_remaining_usd?: number;
  };
}

interface LeaderboardEntry {
  executor: string;
  runs: number;
  avg_score: number;
  pass_rate: number;
  avg_duration_ms: number;
  total_cost_usd: number;
  by_difficulty: Record<string, { avg_score: number; count: number }>;
  by_category: Record<string, { avg_score: number; count: number }>;
  last_run: number;
}

// ============================================================================
// TRIFECTA HARNESS — initializes transports, budget, selector
// ============================================================================

interface BenchHarness {
  transports: Map<string, ExecutorTransport>;
  registryEntries: ExecutorRegistryEntry[];
  circuitBreakers: CircuitBreakerRegistry;
  budgetGovernor: BudgetGovernor;
  roleRegistry: RoleRegistry;
}

function initHarness(budgetUSD?: number, forceBridge: boolean = true): BenchHarness {
  // Use dedicated bench DB to avoid polluting production
  const budgetGovernor = new BudgetGovernor(BENCH_DB);
  const roleRegistry = new RoleRegistry(BENCH_DB);
  const circuitBreakers = new CircuitBreakerRegistry();

  // Load executor registry
  const registry = loadRegistry();
  const localExecutors = getLocalExecutors(registry);

  // Build transport map — default to bridge for bench stability (ACP can crash the process)
  const transports = new Map<string, ExecutorTransport>();
  for (const entry of localExecutors) {
    try {
      const cb = circuitBreakers.get(entry.id);
      const entryForTransport = forceBridge
        ? { ...entry, transport: 'bridge' as const }
        : entry;
      const transport = createTransport(entryForTransport, cb);
      transports.set(entry.id, transport);
    } catch (err) {
      console.warn(`  ⚠ Could not create transport for ${entry.id}: ${err}`);
    }
  }

  // Initialize budget if specified
  if (budgetUSD && budgetUSD > 0) {
    budgetGovernor.initSwarm({
      swarmId: 'bench',
      totalBudgetUSD: budgetUSD,
      alertThresholdPct: 80,
      hardCapAction: 'downgrade',
    });
  }

  return { transports, registryEntries: localExecutors, circuitBreakers, budgetGovernor, roleRegistry };
}

function buildHealthSnapshot(harness: BenchHarness): HealthSnapshot {
  const status = harness.circuitBreakers.getStatus();
  const health: HealthSnapshot = {};
  for (const [id, state] of Object.entries(status)) {
    health[id] = { state: state.state, failures: state.failures };
  }
  return health;
}

function buildBudgetSnapshot(harness: BenchHarness): BudgetSnapshot | null {
  try {
    const state = harness.budgetGovernor.getState('bench');
    if (state.totalBudgetUSD > 0) {
      return {
        totalSpentUSD: state.totalSpentUSD,
        totalBudgetUSD: state.totalBudgetUSD,
        perExecutor: state.perExecutor,
      };
    }
  } catch {}
  return null;
}

// ============================================================================
// SAMPLE BENCHMARK
// ============================================================================

const SAMPLE_BENCHMARK: BenchmarkSuite = {
  name: "swarm-validation-v1",
  version: "2.0.0",
  description: "Trifecta-integrated validation suite for swarm task quality",
  config: {
    concurrency: 1,
    default_timeout: 300,
    workspace_isolation: "copy",
  },
  instances: [
    {
      id: "basic-file-creation",
      name: "Create Configuration File",
      description: "Create a JSON config file with specific structure",
      difficulty: "trivial",
      category: "coding",
      task: "Create a file at /tmp/test-project/config.json containing a valid JSON object with fields: name (string), version (string), enabled (boolean). Use values: name='test-app', version='1.0.0', enabled=true.",
      persona: "auto",
      timeout_seconds: 60,
      acceptance_criteria: [
        {
          type: "file_exists",
          description: "Config file exists at correct path",
          weight: 0.3,
          path: "/tmp/test-project/config.json",
        },
        {
          type: "content_match",
          description: "Config has required fields",
          weight: 0.7,
          file: "/tmp/test-project/config.json",
          contains: ['"name"', '"version"', '"enabled"', '"test-app"', '"1.0.0"', "true"],
        },
      ],
      setup_script: "mkdir -p /tmp/test-project",
    },
    {
      id: "function-implementation",
      name: "Implement Validation Function",
      description: "Implement a TypeScript validation function with tests",
      difficulty: "simple",
      category: "coding",
      task: "Create a TypeScript file at /tmp/test-project/validate.ts containing a function `isValidEmail(email: string): boolean` that returns true for valid email addresses (contains @ and . after @) and false otherwise. Also export the function.",
      persona: "auto",
      timeout_seconds: 120,
      initial_files: [
        {
          path: "/tmp/test-project/package.json",
          content: '{"name": "test-project", "version": "1.0.0"}',
        },
      ],
      acceptance_criteria: [
        {
          type: "file_exists",
          description: "Validation file exists",
          weight: 0.2,
          path: "/tmp/test-project/validate.ts",
        },
        {
          type: "content_match",
          description: "Contains isValidEmail function",
          weight: 0.4,
          file: "/tmp/test-project/validate.ts",
          pattern: "function isValidEmail|export.*isValidEmail|const isValidEmail",
        },
        {
          type: "content_match",
          description: "Has proper email validation logic",
          weight: 0.4,
          file: "/tmp/test-project/validate.ts",
          contains: ["@", "return"],
        },
      ],
    },
    {
      id: "api-error-handling",
      name: "Implement API Error Handling",
      description: "Add proper error handling to an API endpoint",
      difficulty: "moderate",
      category: "refactoring",
      task: "Modify /tmp/test-project/api.ts to add proper error handling with try-catch, status code checks (200 vs 400/500), and user-friendly error messages. The current implementation has a TODO comment for error handling.",
      persona: "auto",
      timeout_seconds: 180,
      initial_files: [
        {
          path: "/tmp/test-project/api.ts",
          content: `async function fetchUser(id: string) {
  // TODO: Add error handling
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}`,
        },
      ],
      acceptance_criteria: [
        {
          type: "content_match",
          description: "Has try-catch block",
          weight: 0.3,
          file: "/tmp/test-project/api.ts",
          contains: ["try", "catch"],
        },
        {
          type: "content_match",
          description: "Checks response status",
          weight: 0.3,
          file: "/tmp/test-project/api.ts",
          pattern: "response\\.ok|response\\.status|!response",
        },
        {
          type: "content_match",
          description: "Returns user-friendly error",
          weight: 0.4,
          file: "/tmp/test-project/api.ts",
          contains: ["throw", "Error"],
        },
      ],
    },
    {
      id: "security-audit-analysis",
      name: "Security Vulnerability Analysis",
      description: "Analyze code for security vulnerabilities and report findings",
      difficulty: "moderate",
      category: "analysis",
      task: "Analyze the provided code snippet for security vulnerabilities. The code is in /tmp/test-project/vulnerable.ts. Identify at least 2 specific vulnerabilities and write your findings to /tmp/test-project/output.md.",
      persona: "auto",
      timeout_seconds: 180,
      initial_files: [
        {
          path: "/tmp/test-project/vulnerable.ts",
          content: `function login(username: string, password: string) {
  const query = "SELECT * FROM users WHERE username='" + username + "' AND password='" + password + "'";
  return db.exec(query);
}

app.get('/user/:id', (req, res) => {
  res.send("<div>User: " + req.params.id + "</div>");
});`,
        },
      ],
      acceptance_criteria: [
        {
          type: "content_match",
          description: "Identifies SQL injection",
          weight: 0.4,
          file: "/tmp/test-project/output.md",
          pattern: "SQL.?injection|SQLi|parameterized|prepared.?statement",
          pattern_flags: "i",
        },
        {
          type: "content_match",
          description: "Identifies XSS vulnerability",
          weight: 0.4,
          file: "/tmp/test-project/output.md",
          pattern: "XSS|cross.?site.?script|sanitiz|escap",
          pattern_flags: "i",
        },
        {
          type: "no_error",
          description: "No critical execution errors",
          weight: 0.2,
          error_pattern: ["Error:", "Exception:", "Failed"],
        },
      ],
    },
  ],
};

// ============================================================================
// WORKSPACE ISOLATION
// ============================================================================

interface IsolatedWorkspace {
  path: string;
  cleanup: () => void;
}

async function createIsolatedWorkspace(instance: BenchmarkInstance): Promise<IsolatedWorkspace> {
  const workspaceId = `bench_${instance.id}_${Date.now()}`;
  const workspacePath = join(BENCH_WORKSPACES, workspaceId);

  mkdirSync(workspacePath, { recursive: true });

  // Run setup script if provided
  if (instance.setup_script) {
    const setupCmd = instance.setup_script.replace(/\/tmp\/test-project/g, workspacePath);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("bash", ["-c", setupCmd], {
        cwd: workspacePath,
        env: { ...process.env, WORKSPACE: workspacePath },
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Setup script failed with code ${code}`));
      });
    });
  }

  // Create initial files
  if (instance.initial_files) {
    for (const file of instance.initial_files) {
      const filePath = file.path.replace(/^\/tmp\/test-project/, workspacePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content);
    }
  }

  const cleanup = () => {
    try {
      spawn("rm", ["-rf", workspacePath]);
    } catch {}
  };

  return { path: workspacePath, cleanup };
}

// ============================================================================
// ACCEPTANCE CRITERIA VERIFICATION
// ============================================================================

async function verifyAC(criterion: AcceptanceCriterion, workspacePath: string, output?: string): Promise<ACVerification> {
  switch (criterion.type) {
    case "file_exists": {
      const targetPath = criterion.path!.replace(/^\/tmp\/test-project/, workspacePath);
      const exists = existsSync(targetPath);
      return {
        criterion,
        result: exists ? "pass" : "fail",
        details: exists ? `File exists: ${criterion.path}` : `File not found: ${criterion.path}`,
        score: exists ? 1 : 0,
      };
    }

    case "content_match": {
      const targetPath = criterion.file!.replace(/^\/tmp\/test-project/, workspacePath);
      if (!existsSync(targetPath)) {
        return {
          criterion,
          result: "fail",
          details: `File not found: ${criterion.file}`,
          score: 0,
        };
      }

      const content = readFileSync(targetPath, "utf-8");
      let matched = true;
      let details = "All patterns matched";

      if (criterion.contains) {
        const missing = criterion.contains.filter(c => !content.includes(c));
        if (missing.length > 0) {
          matched = false;
          details = `Missing patterns: ${missing.join(", ")}`;
        }
      }

      if (criterion.pattern) {
        const regex = new RegExp(criterion.pattern, criterion.pattern_flags || "");
        if (!regex.test(content)) {
          matched = false;
          details = `Pattern not found: ${criterion.pattern}`;
        }
      }

      return {
        criterion,
        result: matched ? "pass" : "fail",
        details,
        score: matched ? 1 : 0,
      };
    }

    case "test_pass": {
      const exitCode = await new Promise<number>((resolve) => {
        const rawCmd = criterion.test_command ?? criterion.command ?? "true";
        const cmd = rawCmd.replace(/\/tmp\/test-project/g, workspacePath);
        const proc = spawn("bash", ["-c", cmd], { cwd: workspacePath });
        proc.on("close", resolve);
      });

      const expected = criterion.expected_exit_code ?? 0;
      const passed = exitCode === expected;

      return {
        criterion,
        result: passed ? "pass" : "fail",
        details: `Exit code: ${exitCode}, expected: ${expected}`,
        score: passed ? 1 : 0,
      };
    }

    case "semantic_similarity": {
      const reference = criterion.reference_output!;
      const target = output || "";

      // Jaccard similarity
      const refWords = new Set(reference.toLowerCase().split(/\s+/));
      const targetWords = new Set(target.toLowerCase().split(/\s+/));
      const intersection = new Set([...refWords].filter(x => targetWords.has(x)));
      const union = new Set([...refWords, ...targetWords]);
      const similarity = union.size === 0 ? 0 : intersection.size / union.size;

      const threshold = criterion.similarity_threshold ?? 0.7;
      const passed = similarity >= threshold;

      return {
        criterion,
        result: passed ? "pass" : similarity > 0.5 ? "partial" : "fail",
        details: `Similarity: ${(similarity * 100).toFixed(1)}% (threshold: ${threshold * 100}%)`,
        score: similarity,
      };
    }

    case "no_error": {
      const target = output || "";
      const patterns = criterion.error_pattern || ["Error:", "Exception:", "Failed"];
      const found = patterns.filter(p => target.includes(p));

      return {
        criterion,
        result: found.length === 0 ? "pass" : "fail",
        details: found.length === 0 ? "No error patterns found" : `Found error patterns: ${found.join(", ")}`,
        score: found.length === 0 ? 1 : 0,
      };
    }

    default:
      return {
        criterion,
        result: "skip",
        details: `Unknown criterion type: ${criterion.type}`,
        score: 0,
      };
  }
}

// ============================================================================
// TASK EXECUTION VIA TRIFECTA
// ============================================================================

async function executeInstance(
  instance: BenchmarkInstance,
  targetExecutor: string,
  harness: BenchHarness,
  config?: BenchmarkSuite["config"],
): Promise<InstanceResult> {
  const startTime = Date.now();
  const workspace = await createIsolatedWorkspace(instance);

  try {
    // Build Task from BenchmarkInstance
    const task: Task = {
      id: `bench-${instance.id}-${Date.now()}`,
      persona: instance.persona || targetExecutor,
      task: instance.task.replace(/\/tmp\/test-project/g, workspace.path),
      priority: 'medium',
      executor: targetExecutor === 'auto' ? undefined : targetExecutor,
    };

    // Resolve executor via Selector if 'auto'
    let routingDecision: ExecutorSelectionRecord | undefined;

    if (!task.executor || task.executor === 'auto') {
      const health = buildHealthSnapshot(harness);
      const budget = buildBudgetSnapshot(harness);

      let roleResolution = null;
      if (instance.role) {
        roleResolution = harness.roleRegistry.resolve(instance.role);
      }

      const selection = selectExecutor(task, budget, health, harness.registryEntries, roleResolution);
      task.executor = selection.executorId;
      if (selection.model) task.model = selection.model;

      routingDecision = {
        executorId: selection.executorId,
        confidence: selection.confidence,
        reasoning: selection.reasoning,
        fallbacks: selection.fallbacks,
        model: selection.model,
      };
    }

    const executorId = task.executor!;
    const transport = harness.transports.get(executorId);
    if (!transport) {
      throw new Error(`No transport available for executor: ${executorId}. Available: ${[...harness.transports.keys()].join(', ')}`);
    }

    // Execute via transport
    const timeoutMs = (instance.timeout_seconds || config?.default_timeout || 300) * 1000;
    const options: TransportOptions = {
      timeoutMs,
      workdir: workspace.path,
    };

    console.log(`    Dispatching to ${executorId} via transport (timeout: ${timeoutMs / 1000}s)...`);
    let taskResult: TaskResult;
    try {
      taskResult = await transport.execute(task, options);
    } catch (transportErr) {
      // Transport-level failure — record as execution error but don't crash the harness
      throw new Error(`Transport error (${executorId}): ${transportErr}`);
    }
    const output = taskResult.output || '';

    // Record budget usage
    let costUSD = 0;
    if (taskResult.tokensUsed && taskResult.tokensUsed > 0) {
      const model = taskResult.modelUsed || task.model || 'sonnet';
      const inputTokens = Math.round(taskResult.tokensUsed * 0.7);
      const outputTokens = Math.round(taskResult.tokensUsed * 0.3);
      try {
        const budgetState = harness.budgetGovernor.recordUsage('bench', executorId, model, inputTokens, outputTokens);
        costUSD = budgetState.totalSpentUSD;
      } catch {}
    }

    // Verify acceptance criteria
    const acResults: ACVerification[] = [];
    for (const ac of instance.acceptance_criteria) {
      const result = await verifyAC(ac, workspace.path, output);
      acResults.push(result);
    }

    // Calculate weighted score
    const totalWeight = instance.acceptance_criteria.reduce((sum, ac) => sum + ac.weight, 0);
    const weightedScore = totalWeight > 0
      ? acResults.reduce((sum, r) => sum + (r.score * r.criterion.weight), 0) / totalWeight
      : 0;

    const allPassed = acResults.every(r => r.result === "pass");

    return {
      instance_id: instance.id,
      success: allPassed,
      score: weightedScore,
      duration_ms: Date.now() - startTime,
      output: output.slice(0, 10000),
      ac_results: acResults,
      tokens_used: taskResult.tokensUsed,
      model_used: taskResult.modelUsed,
      routing_decision: routingDecision,
      cost_usd: costUSD,
    };

  } catch (error) {
    return {
      instance_id: instance.id,
      success: false,
      score: 0,
      duration_ms: Date.now() - startTime,
      error: String(error),
      ac_results: instance.acceptance_criteria.map(ac => ({
        criterion: ac,
        result: "fail" as VerificationResult,
        details: `Execution error: ${error}`,
        score: 0,
      })),
    };
  } finally {
    workspace.cleanup();
  }
}

// ============================================================================
// BENCHMARK RUN ORCHESTRATION
// ============================================================================

async function runBenchmark(suitePath: string, executor?: string, budgetUSD?: number, useAcp: boolean = false): Promise<void> {
  if (!existsSync(suitePath)) {
    console.error(`Benchmark suite not found: ${suitePath}`);
    process.exit(1);
  }

  const suite: BenchmarkSuite = JSON.parse(readFileSync(suitePath, "utf-8"));
  const targetExecutor = executor || "auto";

  console.log(`\n🚀 SWARM-bench v2 (Trifecta-integrated)`);
  console.log(`   Suite: ${suite.name} v${suite.version}`);
  console.log(`   Executor: ${targetExecutor}${targetExecutor === 'auto' ? ' (Selector will route each task)' : ''}`);
  console.log(`   Instances: ${suite.instances.length}`);
  console.log(`   Concurrency: ${suite.config?.concurrency || 2}`);
  if (budgetUSD) console.log(`   Budget cap: $${budgetUSD.toFixed(2)}`);

  // Initialize Trifecta harness
  console.log(`\n⚙ Initializing Trifecta harness...`);
  const harness = initHarness(budgetUSD, !useAcp);
  console.log(`   Transports: ${[...harness.transports.keys()].join(', ') || 'none'}`);
  console.log(`   Registry entries: ${harness.registryEntries.length}`);

  if (harness.transports.size === 0) {
    console.error(`\n❌ No executor transports available. Check executor registry.`);
    process.exit(1);
  }

  console.log('');

  const runId = `bench_${suite.name}_${targetExecutor}_${Date.now()}`;
  const results: InstanceResult[] = [];

  // Run instances with concurrency control
  const concurrency = suite.config?.concurrency || 2;
  const queue = [...suite.instances];
  const running = new Map<string, Promise<InstanceResult>>();

  while (queue.length > 0 || running.size > 0) {
    // Start new tasks up to concurrency limit
    while (running.size < concurrency && queue.length > 0) {
      const instance = queue.shift()!;
      console.log(`  ▶ Starting: ${instance.id} [${instance.difficulty}/${instance.category}]`);
      const promise = executeInstance(instance, targetExecutor, harness, suite.config);
      running.set(instance.id, promise);
    }

    // Wait for at least one to complete
    if (running.size > 0) {
      const [completedId, result] = await Promise.race(
        Array.from(running.entries()).map(async ([id, p]) => [id, await p] as [string, InstanceResult])
      );

      results.push(result);
      running.delete(completedId);

      const progress = results.length;
      const total = suite.instances.length;
      const status = result.success ? "✅" : result.score > 0.5 ? "⚠️" : "❌";
      const routing = result.routing_decision
        ? ` → ${result.routing_decision.executorId} (${(result.routing_decision.confidence * 100).toFixed(0)}%)`
        : '';
      const cost = result.cost_usd ? ` $${result.cost_usd.toFixed(4)}` : '';
      console.log(`  ${status} [${progress}/${total}] ${result.instance_id}: score=${(result.score * 100).toFixed(0)}% (${result.duration_ms}ms)${routing}${cost}`);
    }
  }

  // Get final budget state
  let totalCostUSD = 0;
  let budgetRemaining: number | undefined;
  try {
    const budgetState = harness.budgetGovernor.getState('bench');
    totalCostUSD = budgetState.totalSpentUSD;
    if (budgetState.totalBudgetUSD > 0) {
      budgetRemaining = budgetState.remaining;
    }
  } catch {}

  // Compile final results
  const run: BenchmarkRun = {
    id: runId,
    suite_name: suite.name,
    timestamp: Date.now(),
    executor: targetExecutor,
    budget_config: budgetUSD ? { totalBudgetUSD: budgetUSD } : undefined,
    results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.success).length,
      partial: results.filter(r => !r.success && r.score > 0.5).length,
      failed: results.filter(r => !r.success && r.score <= 0.5).length,
      skipped: 0,
      avg_score: results.length > 0 ? results.reduce((sum, r) => sum + r.score, 0) / results.length : 0,
      total_duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
      total_cost_usd: totalCostUSD,
      budget_remaining_usd: budgetRemaining,
    },
  };

  // Save results
  const resultPath = join(BENCH_RESULTS, `${runId}.json`);
  writeFileSync(resultPath, JSON.stringify(run, null, 2));

  // Update leaderboard
  updateLeaderboard(run);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 Benchmark Complete");
  console.log("=".repeat(60));
  console.log(`   Total:     ${run.summary.total}`);
  console.log(`   Passed:    ${run.summary.passed} ✅`);
  console.log(`   Partial:   ${run.summary.partial} ⚠️`);
  console.log(`   Failed:    ${run.summary.failed} ❌`);
  console.log(`   Avg Score: ${(run.summary.avg_score * 100).toFixed(1)}%`);
  console.log(`   Duration:  ${(run.summary.total_duration_ms / 1000).toFixed(1)}s`);
  console.log(`   Cost:      $${run.summary.total_cost_usd.toFixed(4)}`);
  if (budgetRemaining !== undefined) {
    console.log(`   Budget:    $${budgetRemaining.toFixed(2)} remaining`);
  }

  // Routing breakdown (if auto mode)
  if (targetExecutor === 'auto') {
    const routingBreakdown: Record<string, number> = {};
    for (const r of results) {
      if (r.routing_decision) {
        routingBreakdown[r.routing_decision.executorId] = (routingBreakdown[r.routing_decision.executorId] || 0) + 1;
      }
    }
    if (Object.keys(routingBreakdown).length > 0) {
      console.log(`   Routing:   ${Object.entries(routingBreakdown).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  }

  console.log(`   Results:   ${resultPath}`);
  console.log("=".repeat(60));

  // Cleanup
  await Promise.all([...harness.transports.values()].map(t => t.shutdown().catch(() => {})));
  closeDb();
}

// ============================================================================
// LEADERBOARD
// ============================================================================

function updateLeaderboard(run: BenchmarkRun): void {
  let leaderboard: LeaderboardEntry[] = [];

  if (existsSync(BENCH_LEADERBOARD)) {
    leaderboard = JSON.parse(readFileSync(BENCH_LEADERBOARD, "utf-8"));
  }

  // Determine effective executor for each result
  const effectiveExecutors = new Set<string>();
  for (const r of run.results) {
    effectiveExecutors.add(r.routing_decision?.executorId || run.executor);
  }

  // Update per-executor entries when in auto mode
  for (const executorId of effectiveExecutors) {
    const executorResults = run.results.filter(r =>
      (r.routing_decision?.executorId || run.executor) === executorId
    );
    if (executorResults.length === 0) continue;

    const existing = leaderboard.find(e => e.executor === executorId);
    const avgScore = executorResults.reduce((s, r) => s + r.score, 0) / executorResults.length;
    const passRate = executorResults.filter(r => r.success).length / executorResults.length;
    const avgDuration = executorResults.reduce((s, r) => s + r.duration_ms, 0) / executorResults.length;
    const totalCost = executorResults.reduce((s, r) => s + (r.cost_usd || 0), 0);

    if (existing) {
      const totalRuns = existing.runs + 1;
      existing.avg_score = (existing.avg_score * existing.runs + avgScore) / totalRuns;
      existing.pass_rate = (existing.pass_rate * existing.runs + passRate) / totalRuns;
      existing.avg_duration_ms = (existing.avg_duration_ms * existing.runs + avgDuration) / totalRuns;
      existing.total_cost_usd = (existing.total_cost_usd || 0) + totalCost;
      existing.runs = totalRuns;
      existing.last_run = run.timestamp;
    } else {
      leaderboard.push({
        executor: executorId,
        runs: 1,
        avg_score: avgScore,
        pass_rate: passRate,
        avg_duration_ms: avgDuration,
        total_cost_usd: totalCost,
        by_difficulty: {},
        by_category: {},
        last_run: run.timestamp,
      });
    }
  }

  leaderboard.sort((a, b) => b.avg_score - a.avg_score);
  writeFileSync(BENCH_LEADERBOARD, JSON.stringify(leaderboard, null, 2));
}

function showLeaderboard(): void {
  if (!existsSync(BENCH_LEADERBOARD)) {
    console.log("No leaderboard data yet. Run a benchmark first.");
    return;
  }

  const leaderboard: LeaderboardEntry[] = JSON.parse(readFileSync(BENCH_LEADERBOARD, "utf-8"));

  console.log("\n🏆 SWARM-bench Leaderboard (Trifecta)");
  console.log("=".repeat(90));
  console.log(`${"Rank".padEnd(6)} ${"Executor".padEnd(16)} ${"Runs".padEnd(6)} ${"Avg Score".padEnd(12)} ${"Pass Rate".padEnd(12)} ${"Avg Duration".padEnd(14)} ${"Cost".padEnd(10)}`);
  console.log("-".repeat(90));

  leaderboard.forEach((entry, i) => {
    console.log(
      `${(i + 1).toString().padEnd(6)} ${entry.executor.padEnd(16)} ${entry.runs.toString().padEnd(6)} ` +
      `${((entry.avg_score * 100).toFixed(1) + '%').padEnd(12)} ${((entry.pass_rate * 100).toFixed(1) + '%').padEnd(12)} ` +
      `${formatDuration(entry.avg_duration_ms).padEnd(14)} $${(entry.total_cost_usd || 0).toFixed(4)}`
    );
  });

  console.log("=".repeat(90));
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

function generateReport(): void {
  // Collect all result files
  const resultFiles = readdirSync(BENCH_RESULTS).filter(f => f.endsWith('.json'));
  if (resultFiles.length === 0) {
    console.log("No benchmark results found. Run a benchmark first.");
    return;
  }

  const runs: BenchmarkRun[] = resultFiles.map(f =>
    JSON.parse(readFileSync(join(BENCH_RESULTS, f), "utf-8"))
  ).sort((a, b) => b.timestamp - a.timestamp);

  const latestRun = runs[0];
  const totalRuns = runs.length;
  const avgScore = runs.reduce((s, r) => s + r.summary.avg_score, 0) / totalRuns;
  const passRate = runs.reduce((s, r) => s + (r.summary.passed / r.summary.total), 0) / totalRuns;
  const totalCost = runs.reduce((s, r) => s + (r.summary.total_cost_usd || 0), 0);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SWARM-bench Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    h1 { color: #f8fafc; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 12px; padding: 1.5rem; border: 1px solid #334155; }
    .card h3 { color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .card .value { font-size: 2rem; font-weight: 700; }
    .pass { color: #22c55e; } .fail { color: #ef4444; } .score { color: #3b82f6; } .cost { color: #f59e0b; } .time { color: #a78bfa; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid #334155; }
    th { color: #94a3b8; font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
    tr:hover { background: #1e293b; }
    .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
    .badge.pass { background: #22c55e20; color: #22c55e; }
    .badge.fail { background: #ef444420; color: #ef4444; }
    .badge.partial { background: #f59e0b20; color: #f59e0b; }
    .section { margin-bottom: 3rem; }
    .section h2 { color: #f8fafc; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #334155; }
    .routing { font-size: 0.8rem; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <h1>SWARM-bench Report (Trifecta)</h1>
    <p class="subtitle">Generated: ${new Date().toISOString()} | ${totalRuns} run(s)</p>

    <div class="grid">
      <div class="card"><h3>Total Runs</h3><div class="value">${totalRuns}</div></div>
      <div class="card"><h3>Avg Score</h3><div class="value score">${(avgScore * 100).toFixed(1)}%</div></div>
      <div class="card"><h3>Pass Rate</h3><div class="value ${passRate >= 0.7 ? 'pass' : 'fail'}">${(passRate * 100).toFixed(1)}%</div></div>
      <div class="card"><h3>Total Cost</h3><div class="value cost">$${totalCost.toFixed(4)}</div></div>
    </div>

    <div class="section">
      <h2>Latest Run: ${latestRun.suite_name}</h2>
      <table>
        <thead>
          <tr><th>Instance</th><th>Executor</th><th>Score</th><th>Duration</th><th>Cost</th><th>Routing</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${latestRun.results.map(r => `
          <tr>
            <td>${r.instance_id}</td>
            <td>${r.routing_decision?.executorId || latestRun.executor}</td>
            <td>${(r.score * 100).toFixed(0)}%</td>
            <td>${formatDuration(r.duration_ms)}</td>
            <td>$${(r.cost_usd || 0).toFixed(4)}</td>
            <td class="routing">${r.routing_decision?.reasoning || 'explicit'}</td>
            <td><span class="badge ${r.success ? 'pass' : r.score > 0.5 ? 'partial' : 'fail'}">${r.success ? 'PASS' : r.score > 0.5 ? 'PARTIAL' : 'FAIL'}</span></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>AC Details (Latest Run)</h2>
      <table>
        <thead>
          <tr><th>Instance</th><th>Criterion</th><th>Type</th><th>Result</th><th>Details</th></tr>
        </thead>
        <tbody>
          ${latestRun.results.flatMap(r => r.ac_results.map(ac => `
          <tr>
            <td>${r.instance_id}</td>
            <td>${ac.criterion.description}</td>
            <td>${ac.criterion.type}</td>
            <td><span class="badge ${ac.result}">${ac.result.toUpperCase()}</span></td>
            <td>${ac.details}</td>
          </tr>`)).join('')}
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Run History</h2>
      <table>
        <thead>
          <tr><th>Suite</th><th>Executor</th><th>Passed</th><th>Avg Score</th><th>Duration</th><th>Cost</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${runs.slice(0, 20).map(r => `
          <tr>
            <td>${r.suite_name}</td>
            <td>${r.executor}</td>
            <td>${r.summary.passed}/${r.summary.total}</td>
            <td>${(r.summary.avg_score * 100).toFixed(1)}%</td>
            <td>${formatDuration(r.summary.total_duration_ms)}</td>
            <td>$${(r.summary.total_cost_usd || 0).toFixed(4)}</td>
            <td>${new Date(r.timestamp).toLocaleString()}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  writeFileSync(BENCH_REPORT, html);
  console.log(`Report saved to: ${BENCH_REPORT}`);
}

// ============================================================================
// VERIFICATION & COMPARISON
// ============================================================================

function verifyResult(resultPath: string): void {
  if (!existsSync(resultPath)) {
    console.error(`Result file not found: ${resultPath}`);
    return;
  }

  const run: BenchmarkRun = JSON.parse(readFileSync(resultPath, "utf-8"));

  console.log(`\n🔍 Verification Report: ${run.id}`);
  console.log(`   Suite: ${run.suite_name}`);
  console.log(`   Executor: ${run.executor}`);
  console.log(`   Timestamp: ${new Date(run.timestamp).toISOString()}`);
  console.log("");

  for (const result of run.results) {
    console.log(`${result.success ? "✅" : result.score > 0.5 ? "⚠️" : "❌"} ${result.instance_id}`);
    console.log(`   Score: ${(result.score * 100).toFixed(1)}% | Duration: ${result.duration_ms}ms`);

    if (result.routing_decision) {
      console.log(`   Routing: ${result.routing_decision.executorId} (${(result.routing_decision.confidence * 100).toFixed(0)}% confidence)`);
      console.log(`   Reason: ${result.routing_decision.reasoning}`);
    }

    if (result.ac_results.length > 0) {
      console.log("   Acceptance Criteria:");
      for (const ac of result.ac_results) {
        const status = ac.result === "pass" ? "✓" : ac.result === "partial" ? "~" : "✗";
        console.log(`     ${status} ${ac.criterion.type}: ${ac.details}`);
      }
    }

    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }

    console.log("");
  }
}

function compareRuns(path1: string, path2: string): void {
  if (!existsSync(path1) || !existsSync(path2)) {
    console.error("One or both result files not found");
    return;
  }

  const run1: BenchmarkRun = JSON.parse(readFileSync(path1, "utf-8"));
  const run2: BenchmarkRun = JSON.parse(readFileSync(path2, "utf-8"));

  console.log("\n📊 Run Comparison");
  console.log("=".repeat(70));
  console.log(`${"Metric".padEnd(20)} ${run1.executor.padEnd(18)} ${run2.executor.padEnd(18)} ${"Delta".padEnd(12)}`);
  console.log("-".repeat(70));

  const metrics = [
    { name: "Avg Score", v1: run1.summary.avg_score, v2: run2.summary.avg_score, fmt: (v: number) => `${(v * 100).toFixed(1)}%` },
    { name: "Pass Rate", v1: run1.summary.passed / run1.summary.total, v2: run2.summary.passed / run2.summary.total, fmt: (v: number) => `${(v * 100).toFixed(1)}%` },
    { name: "Duration", v1: run1.summary.total_duration_ms / 1000, v2: run2.summary.total_duration_ms / 1000, fmt: (v: number) => `${v.toFixed(1)}s` },
    { name: "Cost", v1: run1.summary.total_cost_usd || 0, v2: run2.summary.total_cost_usd || 0, fmt: (v: number) => `$${v.toFixed(4)}` },
  ];

  for (const m of metrics) {
    const delta = m.v2 - m.v1;
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    console.log(`${m.name.padEnd(20)} ${m.fmt(m.v1).padEnd(18)} ${m.fmt(m.v2).padEnd(18)} ${arrow} ${delta > 0 ? '+' : ''}${m.fmt(Math.abs(delta))}`);
  }

  console.log("\n📋 Per-Instance:");
  for (const r1 of run1.results) {
    const r2 = run2.results.find(r => r.instance_id === r1.instance_id);
    if (r2) {
      const delta = r2.score - r1.score;
      const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
      console.log(`  ${r1.instance_id}: ${(r1.score * 100).toFixed(0)}% → ${(r2.score * 100).toFixed(0)}% ${arrow}`);
    }
  }

  console.log("=".repeat(70));
}

// ============================================================================
// INIT
// ============================================================================

function initBenchmark(name: string): void {
  const benchPath = join(BENCH_DATASETS, `${name}.json`);
  if (existsSync(benchPath)) {
    console.log(`Benchmark already exists: ${benchPath}`);
    return;
  }

  const suite: BenchmarkSuite = {
    ...SAMPLE_BENCHMARK,
    name,
    instances: SAMPLE_BENCHMARK.instances.map(i => ({
      ...i,
      id: `${name}-${i.id}`,
    })),
  };

  writeFileSync(benchPath, JSON.stringify(suite, null, 2));
  console.log(`✅ Created benchmark: ${benchPath}`);
  console.log(`   Instances: ${suite.instances.length}`);
  console.log(`   Categories: ${[...new Set(suite.instances.map(i => i.category))].join(", ")}`);
  console.log(`\nEdit ${benchPath} to customize your benchmark instances.`);
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log("SWARM-bench v2: Trifecta-integrated Evaluation Harness");
    console.log("");
    console.log("Usage:");
    console.log("  bun swarm-bench.ts init <name>              Create new benchmark suite");
    console.log("  bun swarm-bench.ts run <benchmark.json>     Run benchmark suite");
    console.log("  bun swarm-bench.ts run <suite> --executor <name|auto>  Route tasks");
    console.log("  bun swarm-bench.ts run <suite> --budget 5.00            Set budget cap ($)");
    console.log("  bun swarm-bench.ts verify <result.json>     Verify AC compliance");
    console.log("  bun swarm-bench.ts leaderboard              Show executor rankings");
    console.log("  bun swarm-bench.ts compare <run1> <run2>    Compare two benchmark runs");
    console.log("  bun swarm-bench.ts report                   Generate HTML report");
    console.log("");
    console.log("Examples:");
    console.log("  bun swarm-bench.ts init my-validation");
    console.log("  bun swarm-bench.ts run ~/.swarm/bench/datasets/my-validation.json");
    console.log("  bun swarm-bench.ts run my-suite.json --executor auto --budget 2.00");
    console.log("  bun swarm-bench.ts leaderboard");
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case "init":
      if (args.length < 2) {
        console.log("Usage: swarm-bench.ts init <name>");
        process.exit(1);
      }
      initBenchmark(args[1]);
      break;

    case "run": {
      if (args.length < 2) {
        console.log("Usage: swarm-bench.ts run <benchmark.json> [--executor <name|auto>] [--budget <usd>]");
        process.exit(1);
      }
      const executor = args.includes("--executor") ? args[args.indexOf("--executor") + 1] : undefined;
      const budgetIdx = args.indexOf("--budget");
      const budgetUSD = budgetIdx !== -1 ? parseFloat(args[budgetIdx + 1]) : undefined;
      const useAcp = args.includes("--acp");
      await runBenchmark(args[1], executor, budgetUSD, useAcp);
      break;
    }

    case "verify":
      if (args.length < 2) {
        console.log("Usage: swarm-bench.ts verify <result.json>");
        process.exit(1);
      }
      verifyResult(args[1]);
      break;

    case "leaderboard":
      showLeaderboard();
      break;

    case "compare":
      if (args.length < 3) {
        console.log("Usage: swarm-bench.ts compare <run1.json> <run2.json>");
        process.exit(1);
      }
      compareRuns(args[1], args[2]);
      break;

    case "report":
      generateReport();
      break;

    default:
      console.log(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(e => {
  console.error(`Fatal error: ${e}`);
  process.exit(1);
});
