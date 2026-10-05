#!/usr/bin/env bun
/**
 * zo-swarm-orchestrator MCP Server — HTTP Transport v1.0
 *
 * Streamable HTTP MCP server for network access by all agents and personas.
 * Runs as a Zo hosted service on PORT env var.
 *
 * Endpoints:
 *   POST /mcp   — MCP Streamable HTTP (JSON-RPC)
 *   GET  /mcp   — SSE stream for server-initiated messages
 *   DELETE /mcp — Session teardown
 *   GET  /health — Health check
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { $ } from "bun";
import { runMcpCampaign } from "./run-mcp-campaign";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

// --- Config ---
const PORT = parseInt(process.env.PORT || "48401");
const SWARM_SCRIPTS_DIR = import.meta.dir;
const RESULTS_DIR = join(process.env.HOME || "/root", ".swarm", "results");
const BEARER_TOKEN = process.env.ZO_SWARM_MCP_TOKEN || "";

// --- Helpers ---
function listRecentSwarms(limit = 10) {
  if (!existsSync(RESULTS_DIR)) return [];
  
  const files = readdirSync(RESULTS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const path = join(RESULTS_DIR, f);
      return { name: f.replace(".json", ""), path, mtime: 0 };
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
  tasks: Array<any>;
  campaignName?: string;
  persona?: string;
  localConcurrency?: number;
  waitForCompletion?: boolean;
  timeoutMinutes?: number;
}): Promise<string> {
  const campaignId = args.campaignName || `mcp-${Date.now()}`;
  const persona = args.persona || "claude-code";
  const concurrency = args.localConcurrency || 2;
  
  const tasks = args.tasks.map((t, i) => ({
    id: t.id || `t${i + 1}`,
    task: t.task,
    persona: persona,
    priority: t.priority || "medium",
    timeoutSeconds: t.timeoutSeconds || 300,
    expectedMutations: t.expectedMutations || [],
  }));

  const tasksPath = `/tmp/swarm-tasks-${campaignId}.json`;
  await Bun.write(tasksPath, JSON.stringify(tasks, null, 2));

  const cmd = [
    "bun", "run", `${SWARM_SCRIPTS_DIR}/orchestrate-v5.ts`,
    tasksPath,
    "--swarm-id", campaignId,
    "--concurrency", concurrency.toString(),
    "--swarm-events",
  ];

  if (args.waitForCompletion) {
    try {
      const result = await runMcpCampaign(cmd, args.timeoutMinutes ? args.timeoutMinutes * 60 * 1000 : 600000);
      
      const resultsPath = join(RESULTS_DIR, `${campaignId}.json`);
      if (existsSync(resultsPath)) {
        const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
        const successCount = results.results?.filter((r: any) => r.success).length || 0;
        return `Swarm "${campaignId}" completed. Success: ${successCount}/${tasks.length} tasks`;
      }
      
      return `Swarm "${campaignId}" completed.\n${result.stdout}`;
    } catch (error: any) {
      return `Swarm "${campaignId}" failed: ${error.stderr || error.message}`;
    }
  } else {
    const proc = Bun.spawn(cmd, {
      detached: true,
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.unref();
    
    return `Swarm "${campaignId}" started with ${tasks.length} tasks.`;
  }
}

function toolSwarmStatus(args: { swarmId: string }): string {
  const resultsPath = join(RESULTS_DIR, `${args.swarmId}.json`);
  const lockPath = `/dev/shm/${args.swarmId}.lock`;
  const isRunning = existsSync(lockPath);
  
  if (!existsSync(resultsPath)) {
    return isRunning 
      ? `Swarm "${args.swarmId}" is running.`
      : `Swarm "${args.swarmId}" not found.`;
  }
  
  try {
    const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
    const successCount = results.results?.filter((r: any) => r.success).length || 0;
    const totalCount = results.results?.length || 0;
    
    return `Swarm "${args.swarmId}": ${successCount}/${totalCount} successful`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function toolSwarmResults(args: { swarmId: string; includeOutput?: boolean }): string {
  const resultsPath = join(RESULTS_DIR, `${args.swarmId}.json`);
  if (!existsSync(resultsPath)) return `Results not found for "${args.swarmId}"`;
  
  try {
    const results = JSON.parse(readFileSync(resultsPath, "utf-8"));
    return JSON.stringify(results, null, 2);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

async function toolSwarmBenchmark(args: { iterations?: number }): Promise<string> {
  try {
    const result = await $`bun ${SWARM_SCRIPTS_DIR}/benchmark.ts --iterations ${args.iterations || 3}`.quiet();
    return result.stdout;
  } catch (error: any) {
    return `Benchmark failed: ${error.stderr || error.message}`;
  }
}

function toolSwarmList(args: { limit?: number }): string {
  const swarms = listRecentSwarms(args.limit || 10);
  if (swarms.length === 0) return "No recent swarms found.";
  return swarms.map(s => `${s.id}: ${s.status}`).join("\n");
}

// ==========================================================================
// MCP SERVER + HTTP TRANSPORT
// ==========================================================================

const TOOLS_DEFINITION = [
  {
    name: "swarm_execute",
    description: "Execute a swarm campaign with multiple parallel tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              task: { type: "string" },
              priority: { type: "string", enum: ["critical", "high", "medium", "low"] },
              timeoutSeconds: { type: "number" },
              expectedMutations: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    contains: { type: "string" },
                  },
                  required: ["file", "contains"],
                },
              },
            },
            required: ["task"],
          },
        },
        campaignName: { type: "string" },
        persona: { type: "string" },
        localConcurrency: { type: "number" },
        waitForCompletion: { type: "boolean" },
        timeoutMinutes: { type: "number" },
      },
      required: ["tasks"],
    },
  },
  {
    name: "swarm_status",
    description: "Check swarm campaign status.",
    inputSchema: {
      type: "object" as const,
      properties: { swarmId: { type: "string" } },
      required: ["swarmId"],
    },
  },
  {
    name: "swarm_results",
    description: "Get swarm results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        swarmId: { type: "string" },
        includeOutput: { type: "boolean" },
      },
      required: ["swarmId"],
    },
  },
  {
    name: "swarm_benchmark",
    description: "Run benchmark.",
    inputSchema: {
      type: "object" as const,
      properties: { iterations: { type: "number" } },
    },
  },
  {
    name: "swarm_list",
    description: "List recent swarms.",
    inputSchema: {
      type: "object" as const,
      properties: { limit: { type: "number" } },
    },
  },
];

const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: Server }>();

function createSessionServer(requestedSessionId?: string) {
  const mcpServer = new Server(
    { name: "zo-swarm-orchestrator", version: "4.6.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS_DEFINITION }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result: string;
      switch (name) {
        case "swarm_execute": result = await toolSwarmExecute(args as any); break;
        case "swarm_status": result = toolSwarmStatus(args as any); break;
        case "swarm_results": result = toolSwarmResults(args as any); break;
        case "swarm_benchmark": result = await toolSwarmBenchmark(args as any); break;
        case "swarm_list": result = toolSwarmList(args as any); break;
        default: result = `Unknown tool: ${name}`;
      }
      return { content: [{ type: "text", text: result }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => requestedSessionId || randomUUID(),
    onsessioninitialized: (sessionId) => {
      console.error(`[zo-swarm-mcp] Session: ${sessionId}`);
    },
    onsessionclosed: (sessionId) => {
      console.error(`[zo-swarm-mcp] Closed: ${sessionId}`);
      sessions.delete(sessionId);
    },
  });

  mcpServer.connect(transport);
  return { transport, server: mcpServer };
}

function checkAuth(req: Request): boolean {
  if (!BEARER_TOKEN) return true;
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  if (token.length !== BEARER_TOKEN.length) return false;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ BEARER_TOKEN.charCodeAt(i);
  }
  return mismatch === 0;
}

// --- Bun HTTP server ---
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        version: "4.6.0",
        tools: TOOLS_DEFINITION.map(t => t.name),
        sessions: sessions.size,
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/mcp") {
      if (!checkAuth(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const sessionId = req.headers.get("mcp-session-id") || url.searchParams.get("sessionId");

      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!.transport.handleRequest(req);
      }

      const { transport, server: mcpServer } = createSessionServer(sessionId || undefined);
      const response = await transport.handleRequest(req);

      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server: mcpServer });
      }

      return response;
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.error(`[zo-swarm-mcp] HTTP server on http://0.0.0.0:${PORT}/mcp`);
console.error(`[zo-swarm-mcp] Auth: ${BEARER_TOKEN ? "required" : "none"}`);
