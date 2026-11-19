#!/usr/bin/env bun
/**
 * SWARM-bench: Docker-based Evaluation Harness for Swarm Task Quality
 * 
 * Adapted from SWE-bench methodology. Provides empirical validation
 * of swarm task completion quality with acceptance criteria verification.
 * 
 * Usage:
 *   bun swarm-bench.ts init <name>              # Create new benchmark
 *   bun swarm-bench.ts run <benchmark.json>     # Run benchmark suite
 *   bun swarm-bench.ts verify <result.json>     # Verify AC compliance
 *   bun swarm-bench.ts leaderboard              # Show executor rankings
 *   bun swarm-bench.ts compare <run1> <run2>   # Compare two runs
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { spawn } from "child_process";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { resolveExecutorRegistryPath } from "../src/registry/loader";
import { getWorkspaceRoot } from "zouroboros-core";

// ============================================================================
// PATHS & CONFIG
// ============================================================================

const WORKSPACE = process.env.SWARM_WORKSPACE || process.env.ZOUROBOROS_WORKSPACE_ROOT || getWorkspaceRoot();
const HOME = process.env.HOME || "/root";
const SWARM_DIR = join(HOME, ".swarm");
const BENCH_DIR = join(SWARM_DIR, "bench");
const BENCH_DATASETS = join(BENCH_DIR, "datasets");
const BENCH_RESULTS = join(BENCH_DIR, "results");
const BENCH_LEADERBOARD = join(BENCH_DIR, "leaderboard.json");
const REGISTRY = resolveExecutorRegistryPath();
const TOOL_EVALS_DB = process.env.ZOUROBOROS_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

function recordBenchToolEval(row: {
  toolName: string;
  outcome: "success" | "failure";
  durationMs: number;
  errorType?: string;
  errorMessage?: string;
  persona?: string;
  sessionId?: string;
}): void {
  try {
    if (!existsSync(TOOL_EVALS_DB)) return;
    const db = new Database(TOOL_EVALS_DB);
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      db.run(
        "INSERT INTO swarm_task_evals(id, tool_name, tool_args, outcome, precision_score, recall_score, argument_accuracy, error_type, error_message, duration_ms, persona, session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          randomUUID(),
          row.toolName,
          null,
          row.outcome,
          null,
          null,
          null,
          row.errorType ?? null,
          row.errorMessage ?? null,
          row.durationMs,
          row.persona ?? "swarm-bench",
          row.sessionId ?? null,
        ]
      );
    } finally {
      db.close();
    }
  } catch {
    // never block the bench on telemetry failure
  }
}

// Ensure directories exist
[BENCH_DIR, BENCH_DATASETS, BENCH_RESULTS].forEach(d => mkdirSync(d, { recursive: true }));

// ============================================================================
// TYPES
// ============================================================================

type ACType = "file_exists" | "content_match" | "schema_validation" | "test_pass" | "semantic_similarity" | "no_error";
type TaskDifficulty = "trivial" | "simple" | "moderate" | "complex" | "deep_research";
type VerificationResult = "pass" | "partial" | "fail" | "skip";

interface AcceptanceCriterion {
  type: ACType;
  description: string;
  weight: number; // 0-1, contributes to overall score
  // file_exists
  path?: string;
  // content_match
  file?: string;
  pattern?: string;
  contains?: string[];
  // schema_validation
  schema?: object;
  data_path?: string;
  // test_pass
  test_command?: string;
  expected_exit_code?: number;
  // semantic_similarity
  reference_output?: string;
  similarity_threshold?: number; // 0-1
  // no_error
  error_pattern?: string[];
}

interface BenchmarkInstance {
  id: string;
  name: string;
  description: string;
  difficulty: TaskDifficulty;
  category: string; // e.g., "coding", "analysis", "refactoring", "documentation"
  
  // Task definition
  task: string;
  persona: string;
  executor?: string;
  timeout_seconds?: number;
  
  // Context
  setup_script?: string; // Bash script to prepare workspace
  initial_files?: Array<{ path: string; content: string }>;
  
  // Acceptance criteria
  acceptance_criteria: AcceptanceCriterion[];
  
  // Ground truth for comparison
  ground_truth?: {
    expected_output?: string;
    expected_files?: Array<{ path: string; content?: string; pattern?: string }>;
  };
  
  // Metadata
  tags?: string[];
  source?: string; // e.g., "github-issue-123", "production-incident"
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

interface BenchmarkRun {
  id: string;
  suite_name: string;
  timestamp: number;
  executor: string;
  results: InstanceResult[];
  summary: {
    total: number;
    passed: number;
    partial: number;
    failed: number;
    skipped: number;
    avg_score: number;
    total_duration_ms: number;
  };
}

interface InstanceResult {
  instance_id: string;
  success: boolean;
  score: number; // 0-1 weighted AC score
  duration_ms: number;
  output?: string;
  error?: string;
  ac_results: ACVerification[];
  tokens_used?: number;
}

interface ACVerification {
  criterion: AcceptanceCriterion;
  result: VerificationResult;
  details: string;
  score: number; // 0-1 for this AC
}

interface LeaderboardEntry {
  executor: string;
  runs: number;
  avg_score: number;
  pass_rate: number;
  avg_duration_ms: number;
  by_difficulty: Record<TaskDifficulty, { avg_score: number; count: number }>;
  by_category: Record<string, { avg_score: number; count: number }>;
  last_run: number;
}

// ============================================================================
// BENCHMARK SUITE INITIALIZATION
// ============================================================================

const SAMPLE_BENCHMARK: BenchmarkSuite = {
  name: "swarm-validation-v1",
  version: "1.0.0",
  description: "Initial validation suite for swarm task quality",
  config: {
    concurrency: 4,
    default_timeout: 300,
    workspace_isolation: "git_worktree",
  },
  instances: [
    {
      id: "basic-file-creation",
      name: "Create Configuration File",
      description: "Create a JSON config file with specific structure",
      difficulty: "trivial",
      category: "coding",
      task: "Create a file at /tmp/test-project/config.json containing a valid JSON object with fields: name (string), version (string), enabled (boolean). Use values: name='test-app', version='1.0.0', enabled=true.",
      persona: "codex",
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
      persona: "claude-code",
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
          contains: ["@", ".", "return", "boolean"],
        },
      ],
      ground_truth: {
        expected_files: [
          { path: "/tmp/test-project/validate.ts", pattern: "isValidEmail.*email.*string.*boolean" },
        ],
      },
    },
    {
      id: "api-error-handling",
      name: "Implement API Error Handling",
      description: "Add proper error handling to an API endpoint",
      difficulty: "moderate",
      category: "refactoring",
      task: "Modify /tmp/test-project/api.ts to add proper error handling with try-catch, status code checks (200 vs 400/500), and user-friendly error messages. The current implementation has a TODO comment for error handling.",
      persona: "claude-code",
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
          contains: ["ok", "status", "response.ok", "if (!response"],
        },
        {
          type: "content_match",
          description: "Returns user-friendly error",
          weight: 0.4,
          file: "/tmp/test-project/api.ts",
          contains: ["throw", "Error", "message"],
        },
      ],
    },
    {
      id: "security-audit-analysis",
      name: "Security Vulnerability Analysis",
      description: "Analyze code for security vulnerabilities and report findings",
      difficulty: "moderate",
      category: "analysis",
      task: "Analyze the provided code snippet for security vulnerabilities. The code is in /tmp/test-project/vulnerable.ts. Identify at least 2 specific vulnerabilities and provide recommended fixes.",
      persona: "hermes",
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
          file: "/tmp/test-project/output.md", // Output file agent creates
          contains: ["SQL injection", "SQLi", "parameterized", "prepared statement"],
        },
        {
          type: "content_match",
          description: "Identifies XSS vulnerability",
          weight: 0.4,
          file: "/tmp/test-project/output.md",
          contains: ["XSS", "cross-site scripting", "sanitize", "escape", "innerHTML"],
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
// WORKSPACE ISOLATION
// ============================================================================

interface Workspace {
  path: string;
  cleanup: () => void;
}

async function createIsolatedWorkspace(instance: BenchmarkInstance, baseDir: string): Promise<Workspace> {
  const workspaceId = `bench_${instance.id}_${Date.now()}`;
  const workspacePath = join(baseDir, workspaceId);
  
  mkdirSync(workspacePath, { recursive: true });
  
  // Run setup script if provided
  if (instance.setup_script) {
    await new Promise((resolve, reject) => {
      const proc = spawn("bash", ["-c", instance.setup_script], {
        cwd: workspacePath,
        env: { ...process.env, WORKSPACE: workspacePath },
      });
      
      proc.on("close", (code) => {
        if (code === 0) resolve(null);
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
  
  // Cleanup function
  const cleanup = () => {
    try {
      // Remove workspace
      spawn("rm", ["-rf", workspacePath]);
    } catch {}
  };
  
  return { path: workspacePath, cleanup };
}

// ============================================================================
// ACCEPTANCE CRITERIA VERIFICATION
// ============================================================================

async function verifyAC(criterion: AcceptanceCriterion, workspacePath: string, output?: string): Promise<ACVerification> {
  const startTime = Date.now();
  
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
        const proc = spawn("bash", ["-c", cmd], {
          cwd: workspacePath,
        });
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
      // Simple string similarity as proxy for semantic similarity
      // In production, would use embeddings
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
// TASK EXECUTION
// ============================================================================

async function runInstance(
  instance: BenchmarkInstance,
  executor: string,
  config: BenchmarkSuite["config"]
): Promise<InstanceResult> {
  const startTime = Date.now();
  const workspace = await createIsolatedWorkspace(instance, BENCH_RESULTS);
  
  try {
    // Load executor bridge
    const bridge = loadBridge(executor);
    if (!bridge) {
      throw new Error(`No bridge found for executor: ${executor}`);
    }
    
    // Prepare task with workspace context
    const taskWithContext = instance.task.replace(/\/tmp\/test-project/g, workspace.path);
    
    // Execute via bridge
    const output = await callExecutor(executor, bridge, taskWithContext, config?.default_timeout || 300);
    
    // Verify acceptance criteria
    const acResults: ACVerification[] = [];
    for (const ac of instance.acceptance_criteria) {
      const result = await verifyAC(ac, workspace.path, output);
      acResults.push(result);
    }
    
    // Calculate weighted score
    const totalWeight = instance.acceptance_criteria.reduce((sum, ac) => sum + ac.weight, 0);
    const weightedScore = acResults.reduce((sum, r) => sum + (r.score * r.criterion.weight), 0) / totalWeight;
    
    // Determine overall result
    const allPassed = acResults.every(r => r.result === "pass");
    const anyFailed = acResults.some(r => r.result === "fail");
    const durationMs = Date.now() - startTime;

    recordBenchToolEval({
      toolName: `bench:${executor}:${instance.id}`,
      outcome: allPassed ? "success" : "failure",
      durationMs,
      errorType: anyFailed ? "ac_failed" : undefined,
      errorMessage: anyFailed
        ? acResults.filter(r => r.result === "fail").map(r => r.details).join("; ").slice(0, 500)
        : undefined,
      persona: instance.persona || executor,
    });

    return {
      instance_id: instance.id,
      success: allPassed,
      score: weightedScore,
      duration_ms: durationMs,
      output: output.slice(0, 10000), // Limit output size
      ac_results: acResults,
    };

  } catch (error) {
    const durationMs = Date.now() - startTime;
    recordBenchToolEval({
      toolName: `bench:${executor}:${instance.id}`,
      outcome: "failure",
      durationMs,
      errorType: "execution_error",
      errorMessage: String(error).slice(0, 500),
      persona: instance.persona || executor,
    });
    return {
      instance_id: instance.id,
      success: false,
      score: 0,
      duration_ms: durationMs,
      error: String(error),
      ac_results: instance.acceptance_criteria.map(ac => ({
        criterion: ac,
        result: "fail",
        details: `Execution error: ${error}`,
        score: 0,
      })),
    };
  } finally {
    workspace.cleanup();
  }
}

function loadBridge(executorId: string): string | null {
  try {
    if (!existsSync(REGISTRY)) return null;
    
    const registry = JSON.parse(readFileSync(REGISTRY, "utf-8"));
    const executor = registry.executors?.find((e: any) => e.id === executorId);
    
    if (executor?.bridge) {
      const bridgePath = join(WORKSPACE, executor.bridge);
      return existsSync(bridgePath) ? bridgePath : null;
    }
    
    return null;
  } catch {
    return null;
  }
}

async function callExecutor(executorId: string, bridge: string, prompt: string, timeoutSeconds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const resultFile = join("/tmp", `bench-result-${randomUUID()}.json`);
    
    const proc = spawn("bash", [bridge, prompt], {
      env: {
        ...process.env,
        RESULT_PATH: resultFile,
        SWARM_TASK_ID: executorId,
      },
    });
    
    let stdout = "";
    let stderr = "";
    let timeoutId: any;
    
    proc.stdout?.on("data", (data) => { stdout += data.toString(); });
    proc.stderr?.on("data", (data) => { stderr += data.toString(); });
    
    timeoutId = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);
    
    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      
      // Try structured result first
      try {
        if (existsSync(resultFile)) {
          const content = readFileSync(resultFile, "utf-8");
          const structured = JSON.parse(content);
          if (structured.output !== undefined) {
            resolve(structured.output);
            return;
          }
        }
      } catch {}
      
      if (code === 0) {
        resolve(stdout.trim() || "OK");
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

// ============================================================================
// BENCHMARK RUN ORCHESTRATION
// ============================================================================

async function runBenchmark(suitePath: string, executor?: string): Promise<void> {
  if (!existsSync(suitePath)) {
    console.error(`Benchmark suite not found: ${suitePath}`);
    process.exit(1);
  }
  
  const suite: BenchmarkSuite = JSON.parse(readFileSync(suitePath, "utf-8"));
  const targetExecutor = executor || "claude-code";
  
  console.log(`\n🚀 SWARM-bench: ${suite.name}`);
  console.log(`   Version: ${suite.version}`);
  console.log(`   Executor: ${targetExecutor}`);
  console.log(`   Instances: ${suite.instances.length}`);
  console.log(`   Concurrency: ${suite.config?.concurrency || 4}`);
  console.log("");
  
  const runId = `bench_${suite.name}_${targetExecutor}_${Date.now()}`;
  const results: InstanceResult[] = [];
  
  // Run instances with concurrency control
  const concurrency = suite.config?.concurrency || 4;
  const queue = [...suite.instances];
  const running = new Map<string, Promise<InstanceResult>>();
  
  while (queue.length > 0 || running.size > 0) {
    // Start new tasks up to concurrency limit
    while (running.size < concurrency && queue.length > 0) {
      const instance = queue.shift()!;
      const promise = runInstance(instance, targetExecutor, suite.config);
      running.set(instance.id, promise);
    }
    
    // Wait for at least one to complete
    if (running.size > 0) {
      const [completedId, result] = await Promise.race(
        Array.from(running.entries()).map(async ([id, p]) => [id, await p] as [string, InstanceResult])
      );
      
      results.push(result);
      running.delete(completedId);
      
      // Print progress
      const progress = results.length;
      const total = suite.instances.length;
      const status = result.success ? "✅" : result.score > 0.5 ? "⚠️" : "❌";
      console.log(`  ${status} [${progress}/${total}] ${result.instance_id}: score=${(result.score * 100).toFixed(0)}% (${result.duration_ms}ms)`);
    }
  }
  
  // Compile final results
  const run: BenchmarkRun = {
    id: runId,
    suite_name: suite.name,
    timestamp: Date.now(),
    executor: targetExecutor,
    results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.success).length,
      partial: results.filter(r => !r.success && r.score > 0.5).length,
      failed: results.filter(r => !r.success && r.score <= 0.5).length,
      skipped: 0,
      avg_score: results.reduce((sum, r) => sum + r.score, 0) / results.length,
      total_duration_ms: results.reduce((sum, r) => sum + r.duration_ms, 0),
    },
  };
  
  // Save results
  const resultPath = join(BENCH_RESULTS, `${runId}.json`);
  writeFileSync(resultPath, JSON.stringify(run, null, 2));
  
  // Update leaderboard
  await updateLeaderboard(run);
  
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
  console.log(`   Results:   ${resultPath}`);
  console.log("=".repeat(60));
}

// ============================================================================
// LEADERBOARD
// ============================================================================

async function updateLeaderboard(run: BenchmarkRun): Promise<void> {
  let leaderboard: LeaderboardEntry[] = [];
  
  if (existsSync(BENCH_LEADERBOARD)) {
    leaderboard = JSON.parse(readFileSync(BENCH_LEADERBOARD, "utf-8"));
  }
  
  const existing = leaderboard.find(e => e.executor === run.executor);
  
  if (existing) {
    // Update existing entry
    const totalRuns = existing.runs + 1;
    existing.avg_score = (existing.avg_score * existing.runs + run.summary.avg_score) / totalRuns;
    existing.pass_rate = (existing.pass_rate * existing.runs + (run.summary.passed / run.summary.total)) / totalRuns;
    existing.avg_duration_ms = (existing.avg_duration_ms * existing.runs + run.summary.total_duration_ms) / totalRuns;
    existing.runs = totalRuns;
    existing.last_run = run.timestamp;
    
    // Update by difficulty/category would require parsing instance metadata
  } else {
    // Create new entry
    leaderboard.push({
      executor: run.executor,
      runs: 1,
      avg_score: run.summary.avg_score,
      pass_rate: run.summary.passed / run.summary.total,
      avg_duration_ms: run.summary.total_duration_ms,
      by_difficulty: {} as any,
      by_category: {} as any,
      last_run: run.timestamp,
    });
  }
  
  // Sort by average score descending
  leaderboard.sort((a, b) => b.avg_score - a.avg_score);
  
  writeFileSync(BENCH_LEADERBOARD, JSON.stringify(leaderboard, null, 2));
}

function showLeaderboard(): void {
  if (!existsSync(BENCH_LEADERBOARD)) {
    console.log("No leaderboard data yet. Run a benchmark first.");
    return;
  }
  
  const leaderboard: LeaderboardEntry[] = JSON.parse(readFileSync(BENCH_LEADERBOARD, "utf-8"));
  
  console.log("\n🏆 SWARM-bench Leaderboard");
  console.log("=".repeat(80));
  console.log(`${"Rank".padEnd(6)} ${"Executor".padEnd(20)} ${"Runs".padEnd(8)} ${"Avg Score".padEnd(12)} ${"Pass Rate".padEnd(12)} ${"Avg Duration".padEnd(15)}`);
  console.log("-".repeat(80));
  
  leaderboard.forEach((entry, i) => {
    const rank = (i + 1).toString().padEnd(6);
    const exec = entry.executor.padEnd(20);
    const runs = entry.runs.toString().padEnd(8);
    const score = `${(entry.avg_score * 100).toFixed(1)}%`.padEnd(12);
    const pass = `${(entry.pass_rate * 100).toFixed(1)}%`.padEnd(12);
    const duration = `${(entry.avg_duration_ms / 1000).toFixed(1)}s`.padEnd(15);
    
    console.log(`${rank} ${exec} ${runs} ${score} ${pass} ${duration}`);
  });
  
  console.log("=".repeat(80));
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
  console.log("=".repeat(60));
  console.log(`${"Metric".padEnd(20)} ${run1.executor.padEnd(15)} ${run2.executor.padEnd(15)} ${"Delta".padEnd(15)}`);
  console.log("-".repeat(60));
  
  const metrics = [
    { name: "Avg Score", v1: run1.summary.avg_score, v2: run2.summary.avg_score, fmt: (v: number) => `${(v * 100).toFixed(1)}%` },
    { name: "Pass Rate", v1: run1.summary.passed / run1.summary.total, v2: run2.summary.passed / run2.summary.total, fmt: (v: number) => `${(v * 100).toFixed(1)}%` },
    { name: "Total Duration", v1: run1.summary.total_duration_ms / 1000, v2: run2.summary.total_duration_ms / 1000, fmt: (v: number) => `${v.toFixed(1)}s` },
  ];
  
  for (const m of metrics) {
    const delta = m.v2 - m.v1;
    const deltaStr = delta > 0 ? `+${m.fmt(delta)}` : m.fmt(Math.abs(delta));
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
    console.log(`${m.name.padEnd(20)} ${m.fmt(m.v1).padEnd(15)} ${m.fmt(m.v2).padEnd(15)} ${arrow} ${deltaStr}`);
  }
  
  // Per-instance comparison
  console.log("\n📋 Per-Instance Comparison:");
  for (const r1 of run1.results) {
    const r2 = run2.results.find(r => r.instance_id === r1.instance_id);
    if (r2) {
      const delta = r2.score - r1.score;
      const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
      console.log(`  ${r1.instance_id}: ${(r1.score * 100).toFixed(0)}% → ${(r2.score * 100).toFixed(0)}% ${arrow} ${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}%`);
    }
  }
  
  console.log("=".repeat(60));
}

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log("SWARM-bench: Docker-based Evaluation Harness");
    console.log("");
    console.log("Usage:");
    console.log("  bun swarm-bench.ts init <name>              Create new benchmark suite");
    console.log("  bun swarm-bench.ts run <benchmark.json>     Run benchmark suite");
    console.log("  bun swarm-bench.ts run <benchmark.json> --executor <name>  Run with specific executor");
    console.log("  bun swarm-bench.ts verify <result.json>     Verify AC compliance");
    console.log("  bun swarm-bench.ts leaderboard              Show executor rankings");
    console.log("  bun swarm-bench.ts compare <run1> <run2>   Compare two benchmark runs");
    console.log("");
    console.log("Examples:");
    console.log("  bun swarm-bench.ts init my-validation");
    console.log("  bun swarm-bench.ts run ~/.swarm/bench/datasets/my-validation.json");
    console.log("  bun swarm-bench.ts run my-validation.json --executor hermes");
    console.log("  bun swarm-bench.ts verify ~/.swarm/bench/results/bench_xxx.json");
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
      
    case "run":
      if (args.length < 2) {
        console.log("Usage: swarm-bench.ts run <benchmark.json> [--executor <name>]");
        process.exit(1);
      }
      const executor = args.includes("--executor") ? args[args.indexOf("--executor") + 1] : undefined;
      await runBenchmark(args[1], executor);
      break;
      
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
      
    default:
      console.log(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(e => {
  console.error(`Fatal error: ${e}`);
  process.exit(1);
});
