#!/usr/bin/env bun
/**
 * doctor.ts — Health check for all registered executors.
 *
 * Verifies: bridge exists + executable, health check command passes,
 * required env vars are set, identity file exists (if applicable).
 * For ACP executors: also validates adapter binary presence.
 *
 * Usage:
 *   bun doctor.ts                  # Check all executors
 *   bun doctor.ts --executor <id>  # Check a specific executor
 *   bun doctor.ts --json           # Output JSON instead of table
 */

import { readFileSync, accessSync, constants, existsSync } from "fs";
import { join, resolve } from "path";
import { getWorkspaceRoot } from "zouroboros-core";
import { resolveExecutorRegistryPath } from "../registry/loader";
import type { ExecutorRegistry, ExecutorEntry } from "./types/executor";

const WORKSPACE = process.env.SWARM_WORKSPACE || process.env.ZOUROBOROS_WORKSPACE_ROOT || getWorkspaceRoot();
const REGISTRY_PATH = resolveExecutorRegistryPath();

/** ACP adapter binary per executor id (gemini uses native --acp flag) */
const ACP_ADAPTER_BINS: Record<string, string> = {
  "claude-code": "claude-agent-acp",
  "codex": "codex-acp",
  "gemini": "gemini",
  "hermes": "hermes",
};

interface CheckResult {
  executor: string;
  check: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

function loadRegistry(): ExecutorRegistry {
  const raw = readFileSync(REGISTRY_PATH, "utf-8");
  return JSON.parse(raw);
}

function checkBridgeExists(entry: ExecutorEntry): CheckResult | null {
  if (!entry.bridge) return null;
  const bridgePath = resolve(WORKSPACE, entry.bridge);
  try {
    accessSync(bridgePath, constants.F_OK);
    return { executor: entry.id, check: "bridge-exists", status: "pass", detail: bridgePath };
  } catch {
    return { executor: entry.id, check: "bridge-exists", status: "fail", detail: `Not found: ${bridgePath}` };
  }
}

function checkBridgeExecutable(entry: ExecutorEntry): CheckResult | null {
  if (!entry.bridge) return null;
  const bridgePath = resolve(WORKSPACE, entry.bridge);
  try {
    accessSync(bridgePath, constants.X_OK);
    return { executor: entry.id, check: "bridge-executable", status: "pass", detail: "executable" };
  } catch {
    return { executor: entry.id, check: "bridge-executable", status: "fail", detail: `Not executable: ${bridgePath}` };
  }
}

async function checkACPAdapter(entry: ExecutorEntry): Promise<CheckResult | null> {
  if (entry.transport !== "acp") return null;
  const bin = entry.acp?.adapterBin;
  if (!bin) {
    return {
      executor: entry.id,
      check: "acp-adapter",
      status: "fail",
      detail: "ACP transport has no registry acp.adapterBin",
    };
  }
  return new Promise<CheckResult>((resolve) => {
    const { spawn } = require("child_process");
    const command = entry.id === "hermes" ? bin : "which";
    const commandArgs = entry.id === "hermes" ? ["acp", "--check"] : [bin];
    const proc = spawn(command, commandArgs, { stdio: "pipe", timeout: 5000 });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code: number | null) => {
      if (code === 0) {
        const detail = entry.id === "hermes" ? out.trim() : `${bin} at ${out.trim()}`;
        resolve({ executor: entry.id, check: "acp-adapter", status: "pass", detail });
      } else {
        resolve({ executor: entry.id, check: "acp-adapter", status: "fail", detail: `${bin} not found — install adapter to enable ACP transport` });
      }
    });
    proc.on("error", () => {
      resolve({ executor: entry.id, check: "acp-adapter", status: "fail", detail: `${bin} not found — install adapter to enable ACP transport` });
    });
  });
}

async function checkHealthCommand(entry: ExecutorEntry): Promise<CheckResult> {
  if (!entry.healthCheck?.command) {
    return { executor: entry.id, check: "health-command", status: "warn", detail: "No health check defined" };
  }
  try {
    const proc = Bun.spawn(["bash", "-c", entry.healthCheck.command], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: WORKSPACE,
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    if (exitCode !== 0) {
      return { executor: entry.id, check: "health-command", status: "fail", detail: `Exit ${exitCode}: ${entry.healthCheck.description}` };
    }

    if (entry.healthCheck.expectedPattern && !stdout.includes(entry.healthCheck.expectedPattern)) {
      return { executor: entry.id, check: "health-command", status: "warn", detail: `Output missing expected pattern: "${entry.healthCheck.expectedPattern}"` };
    }

    return { executor: entry.id, check: "health-command", status: "pass", detail: entry.healthCheck.description };
  } catch (err) {
    return { executor: entry.id, check: "health-command", status: "fail", detail: `Error: ${err}` };
  }
}

function checkEnvVars(entry: ExecutorEntry): CheckResult[] {
  const results: CheckResult[] = [];
  const envVars = entry.config?.envVars || {};

  for (const [varName, desc] of Object.entries(envVars)) {
    const value = process.env[varName];
    const isRequired = (desc as string).toLowerCase().startsWith("required");
    if (isRequired && !value) {
      results.push({ executor: entry.id, check: `env:${varName}`, status: "fail", detail: `Missing required: ${desc}` });
    } else if (!value) {
      results.push({ executor: entry.id, check: `env:${varName}`, status: "warn", detail: `Optional, not set: ${desc}` });
    } else {
      results.push({ executor: entry.id, check: `env:${varName}`, status: "pass", detail: "Set" });
    }
  }
  return results;
}

function formatTable(results: CheckResult[]): void {
  const statusSymbol = { pass: "✓", fail: "✗", warn: "⚠" };
  const statusColor = { pass: "\x1b[32m", fail: "\x1b[31m", warn: "\x1b[33m" };
  const reset = "\x1b[0m";

  let currentExecutor = "";
  for (const r of results) {
    if (r.executor !== currentExecutor) {
      currentExecutor = r.executor;
      console.log(`\n  ${currentExecutor}`);
      console.log("  " + "─".repeat(60));
    }
    const sym = statusSymbol[r.status];
    const color = statusColor[r.status];
    const checkName = r.check.padEnd(22);
    console.log(`  ${color}${sym}${reset}  ${checkName} ${r.detail}`);
  }
}

// --- Main ---

const args = process.argv.slice(2);
const executorFilter = args.includes("--executor")
  ? args[args.indexOf("--executor") + 1]
  : null;
const jsonOutput = args.includes("--json");

const registry = loadRegistry();
let executors = registry.executors;

if (executorFilter) {
  executors = executors.filter((e) => e.id === executorFilter);
  if (executors.length === 0) {
    console.error(`Executor not found: ${executorFilter}`);
    console.error(`Available: ${registry.executors.map((e) => e.id).join(", ")}`);
    process.exit(1);
  }
}

console.log(`\n  zo-swarm-executors doctor`);
console.log(`  Registry: ${REGISTRY_PATH}`);
console.log(`  Workspace: ${WORKSPACE}`);
console.log(`  Executors: ${executors.length}`);

const allResults: CheckResult[] = [];

for (const entry of executors) {
  const bridgeExists = checkBridgeExists(entry);
  const bridgeExecutable = checkBridgeExecutable(entry);
  if (bridgeExists) allResults.push(bridgeExists);
  if (bridgeExecutable) allResults.push(bridgeExecutable);
  allResults.push(await checkHealthCommand(entry));

  const acpCheck = await checkACPAdapter(entry);
  if (acpCheck) allResults.push(acpCheck);

  allResults.push(...checkEnvVars(entry));
}

if (jsonOutput) {
  console.log(JSON.stringify(allResults, null, 2));
} else {
  formatTable(allResults);

  const failures = allResults.filter((r) => r.status === "fail");
  const warnings = allResults.filter((r) => r.status === "warn");
  console.log(`\n  Summary: ${allResults.length} checks, ${failures.length} failed, ${warnings.length} warnings\n`);

  if (failures.length > 0) {
    process.exit(1);
  }
}
