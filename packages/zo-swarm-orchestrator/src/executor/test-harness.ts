#!/usr/bin/env bun
/**
 * test-harness.ts — Integration test for executor bridges.
 *
 * Spawns each bridge with a trivial prompt, validates output, and measures timing.
 *
 * Usage:
 *   bun test-harness.ts                  # Test all executors
 *   bun test-harness.ts --executor <id>  # Test a specific executor
 *   bun test-harness.ts --timeout 120    # Override timeout (seconds)
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { getWorkspaceRoot } from "zouroboros-core";
import { resolveExecutorRegistryPath } from "../registry/loader";
import type { ExecutorRegistry } from "./types/executor";

const WORKSPACE = process.env.SWARM_WORKSPACE || process.env.ZOUROBOROS_WORKSPACE_ROOT || getWorkspaceRoot();
const REGISTRY_PATH = resolveExecutorRegistryPath();

const TEST_PROMPT = 'Respond with exactly: BRIDGE_OK';
const EXPECTED_PATTERN = "BRIDGE_OK";

interface TestResult {
  executor: string;
  status: "pass" | "fail" | "skip";
  elapsed_ms: number;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function loadRegistry(): ExecutorRegistry {
  const raw = readFileSync(REGISTRY_PATH, "utf-8");
  return JSON.parse(raw);
}

async function testExecutor(
  id: string,
  bridgePath: string,
  timeoutSec: number
): Promise<TestResult> {
  const absBridge = resolve(WORKSPACE, bridgePath);
  const start = performance.now();

  try {
    const proc = Bun.spawn(["bash", absBridge, TEST_PROMPT], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: WORKSPACE,
      env: { ...process.env },
    });

    // Race between process completion and timeout
    const timeout = new Promise<"timeout">((res) =>
      setTimeout(() => res("timeout"), timeoutSec * 1000)
    );
    const result = await Promise.race([proc.exited, timeout]);

    const elapsed = Math.round(performance.now() - start);

    if (result === "timeout") {
      proc.kill();
      return {
        executor: id,
        status: "fail",
        elapsed_ms: elapsed,
        stdout: "",
        stderr: `Timed out after ${timeoutSec}s`,
        exitCode: -1,
      };
    }

    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = (await new Response(proc.stderr).text()).trim();
    const exitCode = result as number;

    const pass = exitCode === 0 && stdout.includes(EXPECTED_PATTERN);

    return {
      executor: id,
      status: pass ? "pass" : "fail",
      elapsed_ms: elapsed,
      stdout: stdout.slice(0, 500),
      stderr: stderr.slice(0, 500),
      exitCode,
    };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    return {
      executor: id,
      status: "fail",
      elapsed_ms: elapsed,
      stdout: "",
      stderr: `Spawn error: ${err}`,
      exitCode: -1,
    };
  }
}

// --- Main ---

const args = process.argv.slice(2);
const executorFilter = args.includes("--executor")
  ? args[args.indexOf("--executor") + 1]
  : null;
const timeoutSec = args.includes("--timeout")
  ? parseInt(args[args.indexOf("--timeout") + 1], 10)
  : 120;

const registry = loadRegistry();
let executors = registry.executors;

if (executorFilter) {
  executors = executors.filter((e) => e.id === executorFilter);
  if (executors.length === 0) {
    console.error(`Executor not found: ${executorFilter}`);
    process.exit(1);
  }
}

console.log(`\n  zo-swarm-executors test-harness`);
console.log(`  Testing ${executors.length} executor(s) with timeout=${timeoutSec}s\n`);

const results: TestResult[] = [];

for (const entry of executors) {
  const symbol = "⏳";
  process.stdout.write(`  ${symbol} ${entry.id} ... `);

  if (!entry.bridge) {
    const result: TestResult = {
      executor: entry.id,
      status: "skip",
      elapsed_ms: 0,
      stdout: "",
      stderr: "native transport has no bridge",
      exitCode: 0,
    };
    results.push(result);
    console.log("skip (native transport)");
    continue;
  }

  const result = await testExecutor(entry.id, entry.bridge, timeoutSec);
  results.push(result);

  const icon = result.status === "pass" ? "✓" : "✗";
  const color = result.status === "pass" ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";
  console.log(`${color}${icon}${reset} ${result.elapsed_ms}ms`);

  if (result.status === "fail") {
    if (result.stderr) console.log(`    stderr: ${result.stderr.slice(0, 200)}`);
    if (result.exitCode !== 0) console.log(`    exit: ${result.exitCode}`);
    if (result.stdout && !result.stdout.includes(EXPECTED_PATTERN)) {
      console.log(`    stdout (no BRIDGE_OK): ${result.stdout.slice(0, 200)}`);
    }
  }
}

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;

console.log(`\n  Results: ${passed} passed, ${failed} failed out of ${results.length}\n`);

if (failed > 0) process.exit(1);
