#!/usr/bin/env bun
/**
 * Swarm Status Monitor
 * Check running swarm operations and history
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";

const LOG_FILE = "/dev/shm/swarm-orchestrator.log";

interface SwarmRun {
  timestamp: string;
  query: string;
  agents: number;
  duration: number;
  status: "running" | "completed" | "failed";
}

async function parseLogFile(): Promise<SwarmRun[]> {
  if (!existsSync(LOG_FILE)) {
    return [];
  }
  
  const content = await readFile(LOG_FILE, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());
  
  const runs: SwarmRun[] = [];
  let currentRun: Partial<SwarmRun> = {};
  
  for (const line of lines) {
    // Parse timestamp
    const timestampMatch = line.match(/^\[(.+?)\]/);
    if (!timestampMatch) continue;
    
    const timestamp = timestampMatch[1];
    
    if (line.includes("Starting Swarm Orchestrator")) {
      // New run starting
      if (currentRun.timestamp) {
        runs.push(currentRun as SwarmRun);
      }
      currentRun = { timestamp, status: "running" };
    } else if (line.includes("Query:")) {
      currentRun.query = line.split("Query:")[1]?.trim();
    } else if (line.includes("Spawning")) {
      const match = line.match(/Spawning (\d+) agents/);
      if (match) currentRun.agents = parseInt(match[1]);
    } else if (line.includes("Swarm completed")) {
      const match = line.match(/completed in (\d+)ms/);
      if (match) currentRun.duration = parseInt(match[1]);
      currentRun.status = "completed";
      runs.push(currentRun as SwarmRun);
      currentRun = {};
    }
  }
  
  return runs;
}

async function showStatus() {
  const runs = await parseLogFile();
  
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              SWARM ORCHESTRATOR STATUS                   ║
╚══════════════════════════════════════════════════════════╝

Total Runs: ${runs.length}

Recent Activity (last 10 runs):
${runs.slice(-10).map(r => `
  [${r.timestamp}] ${r.status.toUpperCase()}
  Query: ${(r.query || "N/A").substring(0, 50)}${(r.query || "").length > 50 ? "..." : ""}
  Agents: ${r.agents || "N/A"} | Duration: ${r.duration ? r.duration + "ms" : "N/A"}
`).join("\n")}

Status Legend:
  🟢 RUNNING  - Currently executing
  ✅ COMPLETED - Finished successfully
  ❌ FAILED   - Encountered errors

Log File: ${LOG_FILE}
`);
}

async function showStats() {
  const runs = await parseLogFile();
  
  if (runs.length === 0) {
    console.log("No swarm runs recorded yet.");
    return;
  }
  
  const completed = runs.filter(r => r.status === "completed");
  const failed = runs.filter(r => r.status === "failed");
  const avgDuration = completed.length > 0 
    ? completed.reduce((sum, r) => sum + (r.duration || 0), 0) / completed.length 
    : 0;
  const avgAgents = runs.reduce((sum, r) => sum + (r.agents || 0), 0) / runs.length;
  
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              SWARM STATISTICS                            ║
╚══════════════════════════════════════════════════════════╝

Total Runs:        ${runs.length}
Completed:         ${completed.length} (${Math.round(completed.length/runs.length*100)}%)
Failed:            ${failed.length} (${Math.round(failed.length/runs.length*100)}%)
Avg Duration:      ${Math.round(avgDuration)}ms
Avg Agents/Run:    ${avgAgents.toFixed(1)}

Success Rate:      ${(completed.length/runs.length*100).toFixed(1)}%
`);
}

async function tailLog(lines: number = 20) {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found.");
    return;
  }
  
  const content = await readFile(LOG_FILE, "utf-8");
  const allLines = content.split("\n").filter(l => l.trim());
  const recentLines = allLines.slice(-lines);
  
  console.log(`
╔══════════════════════════════════════════════════════════╗
║              RECENT LOG ENTRIES                          ║
╚══════════════════════════════════════════════════════════╝

${recentLines.join("\n")}
`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Swarm Status Monitor

Usage: bun swarm-status.ts [command] [options]

Commands:
  (no args)           Show current status
  --stats, -s         Show statistics
  --tail [n], -t [n]  Show last n log lines (default: 20)
  --help, -h          Show this help

Examples:
  bun swarm-status.ts
  bun swarm-status.ts --stats
  bun swarm-status.ts --tail 50
`);
    return;
  }
  
  if (args.includes("--stats") || args.includes("-s")) {
    await showStats();
  } else if (args.includes("--tail") || args.includes("-t")) {
    const index = args.findIndex(a => a === "--tail" || a === "-t");
    const lines = args[index + 1] ? parseInt(args[index + 1]) : 20;
    await tailLog(lines);
  } else {
    await showStatus();
  }
}

main().catch(console.error);
