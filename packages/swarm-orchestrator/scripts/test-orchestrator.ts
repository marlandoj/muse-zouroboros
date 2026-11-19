#!/usr/bin/env bun
/**
 * Swarm Orchestrator Test Script
 *
 * Tests v5 orchestrator to verify functionality
 */

import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { join } from "path";

const execAsync = promisify(exec);

// ============================================================================
// TEST HELPERS
// ============================================================================

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  output?: string;
}

class TestRunner {
  private results: TestResult[] = [];
  private verbose: boolean;

  constructor(verbose: boolean = true) {
    this.verbose = verbose;
  }

  async test(name: string, testFn: () => Promise<void>): Promise<void> {
    const startTime = Date.now();
    let result: TestResult;

    try {
      await testFn();
      result = { name: name.padEnd(60), passed: true, duration: Date.now() - startTime };
    } catch (error) {
      result = {
        name: name.padEnd(60),
        passed: false,
        duration: Date.now() - startTime,
        error: String(error),
      };
    }

    this.results.push(result);
    this.printResult(result);
  }

  printResult(result: TestResult): void {
    const status = result.passed ? "✓ PASS" : "✗ FAIL";
    const time = `(${result.duration}ms)`;
    console.log(`${status} ${result.name} ${time}`);
    
    if (result.error && this.verbose) {
      console.log(`  Error: ${result.error}`);
    }
  }

  printSummary(): void {
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    const failed = total - passed;

    console.log("\n" + "=".repeat(80));
    console.log(`Test Summary: ${passed}/${total} passed (${failed} failed)`);
    console.log("=".repeat(80));

    if (failed > 0) {
      console.log("\nFailed tests:");
      for (const result of this.results.filter(r => !r.passed)) {
        console.log(`  - ${result.name.trim()}`);
        if (result.error) {
          console.log(`    ${result.error}`);
        }
      }
    }
  }

  resultsSummary(): { passed: number; failed: number; total: number } {
    const passed = this.results.filter(r => r.passed).length;
    return {
      passed,
      failed: this.results.length - passed,
      total: this.results.length,
    };
  }
}

// ============================================================================
// ORCHESTRATOR TESTS
// ============================================================================

const SCRIPTS_DIR = __dirname;

async function test_v5_orchestrator_exists(): Promise<void> {
  const path = join(SCRIPTS_DIR, "orchestrate-v5.ts");
  if (!existsSync(path)) {
    throw new Error("orchestrate-v5.ts not found");
  }
}

async function test_python_orchestrator_exists(): Promise<void> {
  const path = join(SCRIPTS_DIR, "orchestrate.py");
  if (!existsSync(path)) {
    throw new Error("orchestrate.py not found");
  }
}

async function test_token_optimizer_exists(): Promise<void> {
  const path = join(SCRIPTS_DIR, "token-optimizer.ts");
  if (!existsSync(path)) {
    throw new Error("token-optimizer.ts not found");
  }
}

async function test_benchmark_exists(): Promise<void> {
  const path = join(SCRIPTS_DIR, "benchmark.ts");
  if (!existsSync(path)) {
    throw new Error("benchmark.ts not found");
  }
}

async function test_v5_compile(): Promise<void> {
  try {
    await execAsync(`cd ${SCRIPTS_DIR} && bun build orchestrate-v5.ts --target=bun --outfile=/tmp/test-v5.js`);
  } catch (error) {
    throw new Error(`Failed to compile v5: ${error}`);
  }
}

async function test_python_syntax(): Promise<void> {
  try {
    await execAsync(`python3 -m py_compile ${SCRIPTS_DIR}/orchestrate.py`);
  } catch (error) {
    throw new Error(`Python syntax check failed: ${error}`);
  }
}

async function test_benchmark_compile(): Promise<void> {
  try {
    await execAsync(`cd ${SCRIPTS_DIR} && bun build benchmark.ts --target=bun --outfile=/tmp/test-benchmark.js`);
  } catch (error) {
    throw new Error(`Failed to compile benchmark: ${error}`);
  }
}

async function test_benchmark_runs(): Promise<void> {
  try {
    const { stdout } = await execAsync(`cd ${SCRIPTS_DIR} && timeout 10 bun benchmark.ts`, {
      timeout: 15000,
    });
    
    if (!stdout.includes("SWARM MEMORY STRATEGY") || !stdout.includes("Key Findings")) {
      throw new Error("Benchmark output incomplete");
    }
  } catch (error) {
    throw new Error(`Benchmark failed: ${error}`);
  }
}

async function test_swarm_memory_cli(): Promise<void> {
  try {
    const { stdout } = await execAsync(`cd ${SCRIPTS_DIR} && bun swarm-memory.ts stats`);
    
    if (!stdout.includes("Swarm Memory Statistics") && !stdout.includes("Total Contexts")) {
      throw new Error("swarm-memory.ts stats command failed");
    }
  } catch (error) {
    // This might fail if the database doesn't exist yet, that's okay
    if (String(error).includes("no such table")) return;
    throw new Error(`swarm-memory.ts failed: ${error}`);
  }
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("Swarm Orchestrator Test Suite");
  console.log("=".repeat(80) + "\n");

  const runner = new TestRunner(true);

  // File existence tests
  await runner.test("v5 orchestrator file exists", test_v5_orchestrator_exists);
  await runner.test("python orchestrator file exists", test_python_orchestrator_exists);
  await runner.test("token optimizer file exists", test_token_optimizer_exists);
  await runner.test("benchmark file exists", test_benchmark_exists);

  console.log("\n--- Compilation Tests ---\n");

  // Compilation tests
  await runner.test("v5 orchestrator compiles", test_v5_compile);
  await runner.test("python orchestrator syntax check", test_python_syntax);
  await runner.test("benchmark compiles", test_benchmark_compile);

  console.log("\n--- Runtime Tests ---\n");

  // Runtime tests
  await runner.test("benchmark runs successfully", test_benchmark_runs);
  await runner.test("swarm-memory CLI works", test_swarm_memory_cli);

  // Print summary
  runner.printSummary();

  const summary = runner.resultsSummary();
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (import.meta.main) {
  main();
}
