#!/usr/bin/env bun
/**
 * Bridge Test Suite
 * Tests each executor bridge with a simple diagnostic prompt
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const WORKSPACE = "/home/workspace";
const BRIDGES_DIR = join(WORKSPACE, "Skills", "zo-swarm-executors", "bridges");

interface BridgeTest {
  id: string;
  name: string;
  bridge: string;
  timeout: number;
}

const BRIDGES: BridgeTest[] = [
  { id: "claude-code", name: "Claude Code", bridge: "claude-code-bridge.sh", timeout: 90000 },
  { id: "codex", name: "Codex CLI", bridge: "codex-bridge.sh", timeout: 60000 },
  { id: "gemini", name: "Gemini CLI", bridge: "gemini-bridge.sh", timeout: 60000 },
  { id: "hermes", name: "Hermes Agent", bridge: "hermes-bridge.sh", timeout: 60000 },
];

const TEST_PROMPT = "Respond with exactly: BRIDGE_OK";

async function testBridge(bridge: BridgeTest): Promise<{ success: boolean; output: string; duration: number; error?: string }> {
  const bridgePath = join(BRIDGES_DIR, bridge.bridge);
  
  if (!existsSync(bridgePath)) {
    return { success: false, output: "", duration: 0, error: `Bridge not found: ${bridgePath}` };
  }

  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const proc = spawn("bash", [bridgePath, TEST_PROMPT], {
      env: { ...process.env, WORKSPACE },
      timeout: bridge.timeout,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => stdout += data.toString());
    proc.stderr.on("data", (data) => stderr += data.toString());

    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0 && stdout.includes("BRIDGE_OK");
      
      resolve({
        success,
        output: stdout.trim(),
        duration,
        error: code !== 0 ? `Exit code: ${code}. Stderr: ${stderr.slice(0, 200)}` : undefined,
      });
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        output: "",
        duration: Date.now() - startTime,
        error: `Spawn error: ${err.message}`,
      });
    });
  });
}

async function main() {
  console.log("=".repeat(70));
  console.log("Swarm Bridge Test Suite");
  console.log("=".repeat(70));
  console.log(`Test prompt: "${TEST_PROMPT}"`);
  console.log();

  let passed = 0;
  let failed = 0;

  for (const bridge of BRIDGES) {
    process.stdout.write(`Testing ${bridge.name}... `.padEnd(40));
    
    const result = await testBridge(bridge);
    
    if (result.success) {
      console.log(`✅ PASS (${result.duration}ms)`);
      passed++;
    } else {
      console.log(`❌ FAIL (${result.duration}ms)`);
      console.log(`   Error: ${result.error || "No BRIDGE_OK in output"}`);
      console.log(`   Output preview: ${result.output.slice(0, 100)}...`);
      failed++;
    }
  }

  console.log();
  console.log("=".repeat(70));
  console.log(`Results: ${passed}/${BRIDGES.length} passed, ${failed} failed`);
  console.log("=".repeat(70));
  
  process.exit(failed > 0 ? 1 : 0);
}

main();
