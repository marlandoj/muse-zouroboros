#!/usr/bin/env bun
/**
 * Swarm Memory Strategy Benchmark
 * 
 * Compares different memory strategies:
 * - Sequential (full history)
 * - Sliding Window (recent N items)
 * - Hierarchical (working + long-term)
 * - None (no memory)
 */

import { SequentialMemory, SlidingWindowMemory, HierarchicalMemory, MemoryItem } from "./token-optimizer";

// ============================================================================
// MOCK TASK DATA
// ============================================================================

const MOCK_TASKS = [
  {
    id: "task1",
    persona: "frontend-developer",
    task: "Analyze the user interface and suggest improvements for accessibility and responsive design.",
    output: "## UI Analysis\n\n### Accessibility Issues\n1. Missing ARIA labels on navigation\n2. Low contrast on form fields (ratio 3.2:1, need 4.5:1)\n3. No keyboard navigation for dropdown menus\n\n### Responsive Design\n4. Breakpoints not optimized for tablets\n5. Font sizes don't scale properly on mobile\n\n### Recommendations\n- Add ARIA attributes to interactive elements\n- Increase color contrast to WCAG AA standards\n- Implement keyboard navigation patterns\n- Add tablet-specific breakpoints at 768px and 1024px\n- Use responsive typography units (rem/em)",
    priority: "high",
  },
  {
    id: "task2",
    persona: "backend-architect",
    task: "Review the API design and suggest architectural improvements for scalability and performance.",
    output: "## API Architecture Review\n\n### Current State\n- RESTful API with basic endpoints\n- Monolithic service architecture\n- In-memory caching only\n\n### Scalability Issues\n1. No rate limiting - vulnerable to abuse\n2. Single database instance - bottleneck under load\n3. Synchronous request handling - blocks on I/O\n\n### Performance Recommendations\n4. Implement Redis caching with TTL\n5. Add API gateway for rate limiting and request routing\n6. Microservices decomposition for independent scaling\n7. Async processing with job queue (Bull/RabbitMQ)\n8. Database read replicas for query performance\n\n### Proposed Architecture\nClient -> API Gateway -> Rate Limiter -> Load Balancer -> Services\n                                    |\n                              Cache Cluster + Job Queue",
    priority: "high",
  },
  {
    id: "task3",
    persona: "security-engineer",
    task: "Perform a security audit and identify vulnerabilities with suggested fixes.",
    output: "## Security Audit Report\n\n### Critical Issues\n1. SQL Injection Risk\n   - Location: User search endpoint\n   - Fix: Use parameterized queries\n2. XSS Vulnerability\n   - Location: User profile display\n   - Fix: Sanitize and escape user output\n3. Missing CORS Configuration\n   - Wildcard allows all origins\n   - Fix: Whitelist specific domains\n\n### Medium Priority\n4. No rate limiting on auth endpoints\n5. Session tokens not rotating\n6. Missing CSP headers\n\n### Recommendations\n- Implement OWASP security headers\n- Add input validation on all endpoints\n- Enable security middleware (Helmet.js)\n- Regular dependency updates\n- Security testing in CI/CD pipeline",
    priority: "critical",
  },
  {
    id: "task4",
    persona: "product-manager",
    task: "Define product requirements and user stories for the next sprint based on stakeholder feedback.",
    output: "## Sprint Requirements\n\n### User Stories\nUS-1: As a user, I want to filter search results so that I can find relevant items quickly.\n- Acceptance: Filter by category, price, rating\n- Priority: High\n\nUS-2: As an admin, I want bulk edit capabilities so that I can manage inventory efficiently.\n- Acceptance: Select multiple items, batch edit fields\n- Priority: Medium\n\nUS-3: As a customer, I want order tracking so that I know when to expect delivery.\n- Acceptance: Real-time status updates, estimated delivery date\n- Priority: Critical\n\n### Technical Dependencies\n- US-1 requires search API v2\n- US-2 requires admin auth refactor\n- US-3 requires shipping integration\n\n### Stakeholder Feedback Summary\n- Search performance is top customer complaint (42%)\n- Admin UX needs simplification (internal team)\n- Order visibility requested by enterprise clients",
    priority: "high",
  },
  {
    id: "task5",
    persona: "qa-automation",
    task: "Design test automation strategy and identify critical test cases for regression testing.",
    output: "## Test Automation Strategy\n\n### Test Pyramid\n       /\\ E2E Tests (10%)\n      /  \\      - Critical user journeys\n     /____\\     - Browser tests (Playwright)\n    /      \\\n   / API Tests \\ Integration Tests (30%)\n  / (30%)    \\ - Service interactions\n /____________\\ - Contract testing\n/  Unit Tests   \\ Unit Tests (60%)\n\\ (60%)        / - Fast, isolated\n\n### Critical Regression Tests\n1. User Authentication Flow\n   - Login, logout, password reset\n   - Third-party OAuth (Google/GitHub)\n\n2. Checkout Process\n   - Cart -> payment -> confirmation\n   - Payment failures handling\n\n3. Product Search & Display\n   - Search relevance\n   - Filter combinations\n\n### Recommended Tools\n- Playwright for E2E\n- Jest + Supertest for API\n- Vitest for unit tests\n- TestRail for test management",
    priority: "medium",
  },
];

// ============================================================================
// BENCHMARK EXECUTER
// ============================================================================

interface BenchmarkResult {
  strategy: string;
  tasksCompleted: number;
  totalPromptTokens: number;
  avgPromptTokens: number;
  totalOutputTokens: number;
  avgOutputTokens: number;
  totalTimeMs: number;
  memoryItems: number;
  memoryUtilization: number;
}

async function runBenchmark(strategy: string): Promise<BenchmarkResult> {
  const startTime = Date.now();
  let memory: any;
  let promptTokens = 0;
  let outputTokens = 0;

  switch (strategy) {
    case "sequential":
      memory = new SequentialMemory();
      break;
    case "sliding":
      memory = new SlidingWindowMemory(3);
      break;
    case "hierarchical":
      memory = new HierarchicalMemory({
        workingMemorySize: 2,
        longTermMemorySize: 2,
        enableDeduplication: true,
        enableHTMLStripping: true,
        maxTokens: 8000,
      });
      break;
    case "none":
      // No memory
      break;
  }

  const results: BenchmarkResult = {
    strategy,
    tasksCompleted: 0,
    totalPromptTokens: 0,
    avgPromptTokens: 0,
    totalOutputTokens: 0,
    avgOutputTokens: 0,
    totalTimeMs: 0,
    memoryItems: 0,
    memoryUtilization: 0,
  };

  // Simulate processing tasks
  for (const task of MOCK_TASKS) {
    // Build prompt with memory context
    let promptContext = "";
    if (memory && strategy !== "none") {
      promptContext = memory.getContextString();
    }

    const fullPrompt = `${promptContext}\n\n## Your Task\n\n${task.task}`;
    const promptTok = Math.ceil(fullPrompt.length / 4);
    promptTokens += promptTok;

    // Simulate agent output (add to memory)
    const outputTok = Math.ceil(task.output.length / 4);
    outputTokens += outputTok;

    if (memory && strategy !== "none") {
      memory.add({
        content: task.output,
        metadata: {
          sourceAgent: task.persona,
          category: "analysis",
          priority: task.priority,
        },
      });
    }

    results.tasksCompleted++;
  }

  results.totalPromptTokens = promptTokens;
  results.avgPromptTokens = Math.round(promptTokens / MOCK_TASKS.length);
  results.totalOutputTokens = outputTokens;
  results.avgOutputTokens = Math.round(outputTokens / MOCK_TASKS.length);
  results.totalTimeMs = Date.now() - startTime;

  if (memory && strategy !== "none") {
    const stats = memory.getStats();
    results.memoryItems = stats.totalContextSize;
    results.memoryUtilization = stats.budgetUtilization || 0;
  }

  return results;
}

// ============================================================================
// BENCHMARK COMPARISON
// ============================================================================

async function runAllBenchmarks(): Promise<BenchmarkResult[]> {
  const strategies = ["none", "sliding", "hierarchical", "sequential"];
  const results: BenchmarkResult[] = [];

  console.log("Running Swarm Memory Strategy Benchmark...\n");

  for (const strategy of strategies) {
    process.stdout.write(`  Testing ${strategy.padEnd(12)} ... `);
    const result = await runBenchmark(strategy);
    results.push(result);
    console.log("✓");
  }

  return results;
}

function printComparison(results: BenchmarkResult[]): void {
  console.log("\n" + "=".repeat(90));
  console.log("SWARM MEMORY STRATEGY BENCHMARK RESULTS");
  console.log("=".repeat(90) + "\n");

  // Table header
  console.log(
    "Strategy".padEnd(15) +
    "Prompt Tok".padEnd(12) +
    "Output Tok".padEnd(12) +
    "Total Tok".padEnd(12) +
    "Memory Items".padEnd(14) +
    "Time (ms)".padEnd(10) +
    "Savings"
  );
  console.log("-".repeat(90));

  const baseline = results.find(r => r.strategy === "sequential");

  for (const result of results) {
    const savings = baseline && baseline.totalPromptTokens > 0
      ? Math.round((1 - result.totalPromptTokens / baseline.totalPromptTokens) * 100)
      : 0;

    console.log(
      result.strategy.padEnd(15) +
      result.avgPromptTokens.toLocaleString().padEnd(12) +
      result.avgOutputTokens.toLocaleString().padEnd(12) +
      (result.totalPromptTokens + result.totalOutputTokens).toLocaleString().padEnd(12) +
      result.memoryItems.toString().padEnd(14) +
      result.totalTimeMs.toString().padEnd(10) +
      (savings > 0 ? `-${savings}%` : `${savings}%`)
    );
  }

  console.log("-".repeat(90));

  // Analysis
  console.log("\n📊 Key Findings:\n");

  const sortedBySavings = [...results]
    .filter(r => r.strategy !== "sequential")
    .sort((a, b) => a.totalPromptTokens - b.totalPromptTokens);

  for (let i = 0; i < sortedBySavings.length; i++) {
    const r = sortedBySavings[i];
    const baselineTok = baseline?.totalPromptTokens || 0;
    const savings = ((baselineTok - r.totalPromptTokens) / baselineTok * 100).toFixed(1);
    console.log(
      `${i + 1}. ${r.strategy.charAt(0).toUpperCase() + r.strategy.slice(1)}` +
      `: ~${savings}% token reduction` +
      ` (${(baselineTok - r.totalPromptTokens).toLocaleString()} tokens saved per ${MOCK_TASKS.length} tasks)`
    );
  }

  console.log("\n💰 Cost Projection (GPT-4 pricing: ~$30/1M input tokens):");
  const tasksPerMonth = 1000;
  console.log(`   Assuming ${tasksPerMonth.toLocaleString()} tasks/month:\n`);

  for (const result of results) {
    const monthlyInputTk = result.avgPromptTokens * tasksPerMonth;
    const monthlyOutputTk = result.avgOutputTokens * tasksPerMonth;
    const monthlyCost = (monthlyInputTk / 1000000 * 30) + (monthlyOutputTk / 1000000 * 60);

    console.log(
      `   ${result.strategy.padEnd(15)}` +
      `$${monthlyCost.toFixed(2)}/month` +
      ` (${monthlyInputTk.toLocaleString()} input + ${monthlyOutputTk.toLocaleString()} output tokens)`
    );
  }

  console.log("\n" + "=".repeat(90));
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function main() {
  const args = process.argv.slice(1);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Swarm Memory Strategy Benchmark");
    console.log("\nUsage: bun benchmark.ts");
    console.log("\nOptions:");
    console.log("  --help, -h    Show this help");
    console.log("\nThis will run a comparative benchmark of:");
    console.log("  1. No Memory (baseline)");
    console.log("  2. Sliding Window (3 items)");
    console.log("  3. Hierarchical (working 2 + LTM 2)");
    console.log("  4. Sequential (full history)");
    process.exit(0);
  }

  const results = await runAllBenchmarks();
  printComparison(results);
}

if (import.meta.main) {
  main();
}

export { BenchmarkResult, runBenchmark };
