#!/usr/bin/env bun
/**
 * zo-swarm-orchestrator MCP Server v1.0
 *
 * Exposes swarm orchestration as MCP tools for AI assistants.
 * Enables spawning parallel agent campaigns, checking status, and retrieving results.
 *
 * Tools:
 *   swarm_execute   — Execute a campaign with task JSON
 *   swarm_status    — Check status of running/completed swarm
 *   swarm_results   — Retrieve results from completed swarm
 *   swarm_benchmark — Run memory strategy benchmark
 *   swarm_list      — List recent swarm runs
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { $ } from "bun";
import { runMcpCampaign } from "./run-mcp-campaign";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { resolveTraceId } from "../src/standalone/trace-bridge";

// --- Config ---
const SWARM_SCRIPTS_DIR = import.meta.dir;
const RESULTS_DIR = join(process.env.HOME || "/root", ".swarm", "results");

// --- Helpers ---
function listRecentSwarms(limit = 10): Array<{
  id: string;
  status: string;
  timestamp: number;
  hasResults: boolean;
}> {
  if (!existsSync(RESULTS_DIR)) return [];
  
  const files = readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const path = join(RESULTS_DIR, f);
      const stat = existsSync(path) ? { mtimeMs: 0 } : { mtimeMs: 0 };
      return { name: f.replace(".json", ""), path, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return files.map(f => {
    try {
      const content = JSON.parse(readFileSync(f.path, "utf-8"));
      return {
        id: content.swarmId || f.name,
        status: content.status || "unknown",
        timestamp: content.completedAt || content.startedAt || f.mtime,
        hasResults: true,
      };
    } catch {
      return { id: f.name, status: "unknown", timestamp: f.mtime, hasResults: false };
    }
  });
}

// ==========================================================================
// TOOL IMPLEMENTATIONS
// ==========================================================================

async function toolSwarmExecute(args: {
  tasks: Array<{
    id?: string;
    task: string;
    priority?: "critical" | "high" | "medium" | "low";
    timeoutSeconds?: number;
    expectedMutations?: Array<{ file: string; contains: string }>;
  }>;
  campaignName?: string;
  persona?: string;
  localConcurrency?: number;
  waitForCompletion?: boolean;
  timeoutMinutes?: number;
}): Promise<string> {
  const campaignId = args.campaignName || `mcp-${Date.now()}`;
  const persona = args.persona || "claude-code";
  const concurrency = args.localConcurrency || 2;
  const traceId = resolveTraceId();
  const childEnv = traceId ? { ...process.env, ZO_TRACE_ID: traceId } : { ...process.env };
  
  // Build task array with defaults
  const tasks = args.tasks.map((t, i) => ({
    id: t.id || `t${i + 1}`,
    task: t.task,
    persona: persona,
    priority: t.priority || "medium",
    timeoutSeconds: t.timeoutSeconds || 300,
    expectedMutations: t.expectedMutations || [],
  }));

  // Write tasks to temp file
  const tasksPath = `/tmp/swarm-tasks-${campaignId}.json`;
  await Bun.write(tasksPath, JSON.stringify(tasks, null, 2));

  // Build command (v5.3: sentinel events enabled by default)
  const cmd = [
    "bun", "run", `${SWARM_SCRIPTS_DIR}/orchestrate-v5.ts`,
    tasksPath,
    "--swarm-id", campaignId,
    "--concurrency", concurrency.toString(),
    "--swarm-events",
  ];

  if (args.waitForCompletion) {
    // Run synchronously and wait
    try {
      const result = await runMcpCampaign(cmd, args.timeoutMinutes ? args.timeoutMinutes * 60 * 1000 : 600000, childEnv);
      
      // Check for results
      const resultsPath = join(RESULTS_DIR, `${campaignId}.json`);
      if (existsSync(resultsPath)) {
        const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
        const successCount = results.results?.filter((r: any) => r.success).length || 0;
        const totalCount = tasks.length;
        
        return `Swarm campaign "${campaignId}" completed.\n` +
          `Success: ${successCount}/${totalCount} tasks\n` +
          `Results: ${resultsPath}`;
      }
      
      return `Swarm campaign "${campaignId}" completed.\nOutput:\n${result.stdout}`;
    } catch (error: any) {
      return `Swarm campaign "${campaignId}" failed or timed out.\nError: ${error.stderr || error.message}`;
    }
  } else {
    // Run asynchronously (fire and forget)
    const proc = Bun.spawn(cmd, {
      detached: true,
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.unref();
    
    return `Swarm campaign "${campaignId}" started asynchronously.\n` +
      `Tasks: ${tasks.length}\n` +
      `Check status with: swarm_status { "swarmId": "${campaignId}" }`;
  }
}

function toolSwarmStatus(args: {
  swarmId: string;
}): string {
  const resultsPath = join(RESULTS_DIR, `${args.swarmId}.json`);
  const lockPath = `/dev/shm/${args.swarmId}.lock`;
  
  const isRunning = existsSync(lockPath);
  
  if (!existsSync(resultsPath)) {
    if (isRunning) {
      return `Swarm "${args.swarmId}" is currently running.\nLock file present at ${lockPath}`;
    }
    return `Swarm "${args.swarmId}" not found. Check the ID or wait for completion.`;
  }
  
  try {
    const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
    const successCount = results.results?.filter((r: any) => r.success).length || 0;
    const totalCount = results.results?.length || 0;
    const failedCount = totalCount - successCount;
    
    let output = `Swarm "${args.swarmId}" status: ${results.status || (isRunning ? "running" : "completed")}\n`;
    output += `Progress: ${successCount}/${totalCount} successful`;
    if (failedCount > 0) output += `, ${failedCount} failed`;
    output += `\n`;
    
    if (results.startedAt) {
      output += `Started: ${new Date(results.startedAt).toISOString()}\n`;
    }
    if (results.completedAt) {
      const duration = (results.completedAt - results.startedAt) / 1000;
      output += `Completed: ${new Date(results.completedAt).toISOString()} (${duration.toFixed(1)}s)\n`;
    }
    
    if (failedCount > 0 && results.results) {
      output += `\nFailed tasks:\n`;
      results.results
        .filter((r: any) => !r.success)
        .slice(0, 5)
        .forEach((r: any) => {
          output += `  - ${r.taskId}: ${r.error?.substring(0, 100) || "Unknown error"}\n`;
        });
    }
    
    return output;
  } catch (error: any) {
    return `Error reading swarm results: ${error.message}`;
  }
}

function toolSwarmResults(args: {
  swarmId: string;
  includeOutput?: boolean;
}): string {
  const resultsPath = join(RESULTS_DIR, `${args.swarmId}.json`);
  
  if (!existsSync(resultsPath)) {
    return `Results for swarm "${args.swarmId}" not found.`;
  }
  
  try {
    const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
    
    let output = `Results for swarm "${args.swarmId}":\n\n`;
    
    if (results.results) {
      results.results.forEach((r: any, i: number) => {
        const icon = r.success ? "\u2713" : "\u2717";
        output += `${icon} Task ${r.taskId || i + 1}: ${r.success ? "SUCCESS" : "FAILED"}\n`;
        
        if (args.includeOutput && r.output) {
          const truncated = r.output.length > 500 
            ? r.output.substring(0, 500) + "... [truncated]" 
            : r.output;
          output += `  Output: ${truncated}\n`;
        }
        
        if (r.expectedMutations) {
          const verified = r.verifiedMutations?.length || 0;
          const total = r.expectedMutations.length;
          output += `  Mutations: ${verified}/${total} verified\n`;
        }
        
        if (r.durationMs) {
          output += `  Duration: ${(r.durationMs / 1000).toFixed(1)}s\n`;
        }
        
        output += `\n`;
      });
    }
    
    return output;
  } catch (error: any) {
    return `Error reading results: ${error.message}`;
  }
}

async function toolSwarmBenchmark(args: {
  iterations?: number;
}): Promise<string> {
  try {
    const result = await $`bun ${SWARM_SCRIPTS_DIR}/benchmark.ts --iterations ${args.iterations || 3}`.quiet();
    return `Benchmark completed:\n\n${result.stdout}`;
  } catch (error: any) {
    return `Benchmark failed: ${error.stderr || error.message}`;
  }
}

function toolSwarmList(args: {
  limit?: number;
}): string {
  const swarms = listRecentSwarms(args.limit || 10);
  
  if (swarms.length === 0) {
    return "No recent swarm runs found.";
  }
  
  let output = `Recent swarm runs (${swarms.length}):\n\n`;
  swarms.forEach(s => {
    const date = new Date(s.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const icon = s.status === "completed" ? "\u2713" : s.status === "running" ? "\u25cb" : "?";
    output += `${icon} ${s.id} — ${s.status} — ${date}\n`;
  });
  
  output += `\nGet details: swarm_status { "swarmId": "<id>" }`;
  return output;
}

// ==========================================================================
// MCP SERVER SETUP
// ==========================================================================

const server = new Server(
  { name: "zo-swarm-orchestrator", version: "4.6.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "swarm_execute",
      description: "Execute a swarm campaign with multiple parallel tasks. Spawns AI agents to work on tasks concurrently with dependency resolution and circuit breaker protection.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tasks: {
            type: "array",
            description: "Array of tasks to execute",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID (auto-generated if omitted)" },
                task: { type: "string", description: "The task description/prompt" },
                priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Task priority" },
                timeoutSeconds: { type: "number", description: "Timeout for this task (default: 300)" },
                expectedMutations: {
                  type: "array",
                  description: "Files that should be modified by this task",
                  items: {
                    type: "object",
                    properties: {
                      file: { type: "string", description: "Absolute file path" },
                      contains: { type: "string", description: "String that should exist in file after task" },
                    },
                    required: ["file", "contains"],
                  },
                },
              },
              required: ["task"],
            },
          },
          campaignName: { type: "string", description: "Name for this campaign (auto-generated if omitted)" },
          persona: { type: "string", description: "Default persona for all tasks (default: claude-code)" },
          localConcurrency: { type: "number", description: "Number of parallel agents (default: 2)" },
          waitForCompletion: { type: "boolean", description: "Wait for all tasks to complete before returning (default: false)" },
          timeoutMinutes: { type: "number", description: "Maximum wait time in minutes when waitForCompletion is true" },
        },
        required: ["tasks"],
      },
    },
    {
      name: "swarm_status",
      description: "Check the status of a running or completed swarm campaign.",
      inputSchema: {
        type: "object" as const,
        properties: {
          swarmId: { type: "string", description: "The swarm campaign ID" },
        },
        required: ["swarmId"],
      },
    },
    {
      name: "swarm_results",
      description: "Retrieve detailed results from a completed swarm campaign.",
      inputSchema: {
        type: "object" as const,
        properties: {
          swarmId: { type: "string", description: "The swarm campaign ID" },
          includeOutput: { type: "boolean", description: "Include full output from each task (may be large)" },
        },
        required: ["swarmId"],
      },
    },
    {
      name: "swarm_benchmark",
      description: "Run a benchmark comparing different swarm memory strategies.",
      inputSchema: {
        type: "object" as const,
        properties: {
          iterations: { type: "number", description: "Number of benchmark iterations (default: 3)" },
        },
      },
    },
    {
      name: "swarm_list",
      description: "List recent swarm campaign runs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Maximum number of results (default: 10)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case "swarm_execute":
        result = await toolSwarmExecute(args as any);
        break;
      case "swarm_status":
        result = toolSwarmStatus(args as any);
        break;
      case "swarm_results":
        result = toolSwarmResults(args as any);
        break;
      case "swarm_benchmark":
        result = await toolSwarmBenchmark(args as any);
        break;
      case "swarm_list":
        result = toolSwarmList(args as any);
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    return { content: [{ type: "text", text: result }] };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message || error}` }],
      isError: true,
    };
  }
});

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("zo-swarm-orchestrator MCP server running on stdio");
}

main().catch(console.error);
