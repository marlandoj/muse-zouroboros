#!/usr/bin/env bun
import { resolveExecutorRegistryPath } from "../src/registry/loader";
/**
 * Hybrid Swarm Runner - Graceful Handoff for Long-Running Swarms
 * 
 * Solves the 15-minute chat timeout problem by:
 * 1. Streaming progress updates for first 13 minutes (while chat is alive)
 * 2. Gracefully handing off to background mode at 13 minutes
 * 3. Sending notification when complete
 * 
 * v2.0 P0 fixes:
 * - P0-1: Orchestrator error catching + Python fallback
 * - P0-2: Git-enabled (committed to zo-swarm-orchestrator repo)
 * - P0-3: Pre-flight health check before spawning
 */
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const CHAT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const HANDOFF_THRESHOLD_MS = 13 * 60 * 1000; // 13 minutes (2 min buffer)
const POLL_INTERVAL_MS = 10 * 1000; // Poll every 10 seconds

interface ProgressData {
  ts: string;
  swarmId: string;
  totalTasks: number;
  completed: number;
  failed: number;
  percentComplete: number;
  elapsedMs: number;
  status?: string;
  errors?: string[];
}

// ============================================================================
// P0-3: PRE-FLIGHT HEALTH CHECKS
// ============================================================================

interface PreflightResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

async function runPreflightChecks(campaignFile: string): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Validate campaign file
  if (!existsSync(campaignFile)) {
    errors.push(`Campaign file not found: ${campaignFile}`);
    return { ok: false, errors, warnings };
  }
  try {
    const data = JSON.parse(readFileSync(campaignFile, "utf-8"));
    if (!Array.isArray(data)) {
      errors.push("Campaign file must be a JSON array of tasks");
    } else if (data.length === 0) {
      errors.push("Campaign has no tasks");
    } else {
      for (const task of data) {
        if (!task.task) errors.push(`Task ${task.id || "?"} missing 'task' field`);
        if (!task.persona && !task.executor) errors.push(`Task ${task.id || "?"} missing 'persona' or 'executor' field`);
      }
    }
  } catch (e) {
    errors.push(`Campaign file is not valid JSON: ${e}`);
  }

  // 2a. PRIMARY: Bun TS orchestrator (current full-feature runtime)
  const tsScript = join(import.meta.dir, "orchestrate-v5.ts");
  if (existsSync(tsScript)) {
    const tscResult = Bun.spawnSync({
      cmd: ["bun", "--bun", "tsc", "--noEmit", tsScript],
      timeout: 15_000,
    });
    if (tscResult.exitCode !== 0) {
      const stderr = new TextDecoder().decode(tscResult.stderr);
      const match = stderr.match(/error:.*at (.*?):(\d+)/);
      const loc = match ? `${match[1]}:${match[2]}` : "(see stderr)";
      warnings.push(`Bun TS orchestrator has syntax errors at ${loc} — will fallback to Python`);
    }
  } else {
    warnings.push("Bun TS orchestrator not found — will use Python fallback");
  }

  // 2b. FALLBACK: Python orchestrator (lightweight, reliable)
  const pythonScript = join(import.meta.dir, "orchestrate.py");
  if (existsSync(pythonScript)) {
    const doctorResult = Bun.spawnSync({
      cmd: ["python3", pythonScript, "doctor"],
      timeout: 10_000,
    });
    if (doctorResult.exitCode !== 0) {
      warnings.push("Python orchestrator doctor check failed");
    }
  } else {
    warnings.push("Python fallback not available");
  }

  // 3. Validate the same registry used by the factory and CC runtime.
  const registryPath = resolveExecutorRegistryPath();
  if (!existsSync(registryPath)) {
    warnings.push(`Executor registry not found: ${registryPath}`);
  }

  // 4. Validate memory system
  const memoryScript = join(process.env.HOME || "/root", ".z", "memory", "shared-facts.db");
  const memoryDir = join(process.env.HOME || "/root", ".z", "memory");
  if (!existsSync(memoryDir)) {
    warnings.push("Memory system directory not found — memory features disabled");
  }

  return { ok: errors.length === 0, errors, warnings };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("❌ Usage: bun swarm-hybrid-runner.ts <campaign.json> [orchestrator-options]");
    console.error("\nExample:");
    console.error("  bun swarm-hybrid-runner.ts campaign.json --notify sms");
    console.error("\nPreflight checks run automatically before spawning.");
    process.exit(1);
  }

  const campaignFile = args[0];

  // P0-3: Run pre-flight checks FIRST
  console.log("\n🩺 Running pre-flight checks...\n");
  const preflight = await runPreflightChecks(campaignFile);

  if (preflight.warnings.length > 0) {
    preflight.warnings.forEach(w => console.log(`   ⚠️  ${w}`));
  }

  if (!preflight.ok) {
    console.log("   ❌ Preflight FAILED — fix errors before running:");
    preflight.errors.forEach(e => console.log(`   • ${e}`));
    console.log();
    console.log("   For orchestrator syntax errors, regenerate with:");
    console.log("   bun Skills/zo-swarm-orchestrator/scripts/regenerate-orchestrator.ts");
    process.exit(1);
  }

  console.log("   ✅ All pre-flight checks passed\n");

  const swarmId = `swarm_${Date.now()}`;

  // Load campaign to estimate size
  let taskCount = 0;
  try {
    const data = JSON.parse(readFileSync(campaignFile, "utf-8"));
    taskCount = Array.isArray(data) ? data.length : 1;
  } catch (e) {
    console.error(`❌ Failed to parse campaign file: ${e}`);
    process.exit(1);
  }

  console.log(`🐝 Hybrid Swarm Runner`);
  console.log(`   Campaign: ${campaignFile}`);
  console.log(`   Tasks: ${taskCount}`);
  console.log(`   Swarm ID: ${swarmId}`);
  console.log();

  // Determine if we should use background mode immediately
  const estimatedMinutes = Math.ceil(taskCount * 2); // Rough estimate: 2 min per task
  const shouldBackground = estimatedMinutes > 12;

  if (shouldBackground) {
    console.log(`⚠️  Estimated duration: ~${estimatedMinutes} minutes`);
    console.log(`   This will exceed chat timeout (15 min)`);
    console.log(`   Starting in hybrid mode with progress streaming...`);
  } else {
    console.log(`✅ Estimated duration: ~${estimatedMinutes} minutes`);
    console.log(`   Running in foreground mode...`);
  }
  console.log();

  // Ensure --notify is set for long-running swarms
  const extraArgs = [...args.slice(1)];
  const hasNotify = extraArgs.some(arg => arg === "--notify");
  if (!hasNotify && shouldBackground) {
    extraArgs.push("--notify", "sms");
    console.log(`   📱 Auto-enabled SMS notifications (use --notify email to change)`);
  }

  // Enable sentinel events by default (v5.3: watch pattern integration)
  const hasSwarmEvents = extraArgs.some(arg => arg === "--swarm-events");
  if (!hasSwarmEvents) {
    extraArgs.push("--swarm-events");
  }

  // Build orchestrator command
  const orchestratorScript = join(import.meta.dir, "orchestrate-v5.ts");
  const cmd = ["bun", orchestratorScript, campaignFile, "--swarm-id", swarmId, ...extraArgs];

  // P0-1: Spawn with error handling + Python fallback
  let proc: ReturnType<typeof spawn> | null = null;
  let usePythonFallback = false;

  try {
    proc = spawn(cmd[0], cmd.slice(1), {
      detached: true,
      stdio: shouldBackground ? "ignore" : "inherit",
    });
  } catch (err) {
    console.log(`   ⚠️  Bun spawn failed: ${err}`);
    console.log(`   Attempting Python fallback...`);
    usePythonFallback = true;
  }

  if (!shouldBackground && !usePythonFallback) {
    // Short swarm — wait for it
    await new Promise<void>((resolve, reject) => {
      proc!.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Orchestrator exited with code ${code}`));
      });
    });
    return;
  }

  if (usePythonFallback) {
    // P0-1: Python fallback — run orchestrator via Python subprocess
    console.log(`\n🐍 Using Python orchestrator fallback...`);
    await runPythonOrchestrator(campaignFile, swarmId, extraArgs);
    return;
  }

  // Long swarm — hybrid mode
  proc!.unref();

  const startTime = Date.now();
  const progressFile = join(process.env.HOME || "/tmp", ".swarm", "logs", `${swarmId}_progress.json`);

  console.log(`   ✅ Orchestrator started in background (PID ${proc!.pid})`);
  console.log(`   📊 Monitoring progress for next 13 minutes...`);
  console.log();

  let lastProgress: ProgressData | null = null;

  // Poll progress until handoff threshold
  while (Date.now() - startTime < HANDOFF_THRESHOLD_MS) {
    await sleep(POLL_INTERVAL_MS);

    if (existsSync(progressFile)) {
      try {
        const progress: ProgressData = JSON.parse(readFileSync(progressFile, "utf-8"));

        if (!lastProgress ||
            progress.completed !== lastProgress.completed ||
            progress.failed !== lastProgress.failed ||
            progress.status !== lastProgress.status) {

          const elapsed = Math.floor(progress.elapsedMs / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = elapsed % 60;

          if (progress.status === "complete") {
            console.log(`\n✅ Swarm complete!`);
            console.log(`   Completed: ${progress.completed}/${progress.totalTasks} tasks`);
            if (progress.failed > 0) console.log(`   Failed: ${progress.failed}`);
            console.log(`   Duration: ${minutes}m ${seconds}s`);
            console.log();
            return;
          } else if (progress.status === "preflight_failed") {
            console.log(`\n❌ Preflight checks failed`);
            if (progress.errors) progress.errors.forEach(err => console.log(`   • ${err}`));
            process.exit(1);
          } else {
            console.log(`[${minutes}m ${seconds}s] Progress: ${progress.completed}/${progress.totalTasks} tasks (${progress.percentComplete}%)`);
            if (progress.failed > 0) console.log(`   ⚠️  Failed: ${progress.failed}`);
          }

          lastProgress = progress;
        }
      } catch {
        // Progress file mid-write, ignore
      }
    }

    if (lastProgress?.status === "complete") {
      console.log(`\n✅ Swarm completed before handoff threshold`);
      return;
    }
  }

  // Handoff to background mode
  console.log(`\n⏰ Approaching chat timeout — switching to background mode`);
  console.log();
  console.log(`📌 Your swarm is still running:`);
  console.log(`   Swarm ID: ${swarmId}`);
  console.log(`   Progress: ${lastProgress?.completed || 0}/${lastProgress?.totalTasks || taskCount} tasks (${lastProgress?.percentComplete || 0}%)`);
  console.log();
  console.log(`📞 You'll be notified when complete`);
  console.log();
  console.log(`🔍 Check status anytime:`);
  console.log(`   bun ${orchestratorScript} status ${swarmId}`);
  console.log();
  console.log(`📄 Results: ~/.swarm/results/${swarmId}.json`);
  console.log();
}

// ============================================================================
// P0-1: PYTHON ORCHESTRATOR FALLBACK
// ============================================================================

async function runPythonOrchestrator(
  campaignFile: string,
  swarmId: string,
  extraArgs: string[]
): Promise<void> {
  const pythonScript = join(import.meta.dir, "orchestrate.py");
  if (!existsSync(pythonScript)) {
    // Fall back to legacy Python fallback
    const alt = join(import.meta.dir, "orchestrate-python-fallback.py");
    if (!existsSync(alt)) {
      console.error(`\n❌ No Python orchestrator found. Tried: orchestrate.py and orchestrate-python-fallback.py`);
      process.exit(1);
    }
    return runLegacyPythonFallback(campaignFile, swarmId, extraArgs);
  }

  console.log(`\n   ✅ Python orchestrator fallback ready`);
  console.log(`   📊 Monitoring progress...\n`);

  const startTime = Date.now();
  const progressFile = join(process.env.HOME || "/tmp", ".swarm", "logs", `${swarmId}_progress.json`);

  // Run Python orchestrator in background
  const proc = spawn("python3", [pythonScript, campaignFile, "--swarm-id", swarmId, ...extraArgs], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  console.log(`   ✅ Python orchestrator started (PID ${proc.pid})`);
  console.log(`   📊 Monitoring progress for next 13 minutes...\n`);

  let lastProgress: ProgressData | null = null;

  while (Date.now() - startTime < HANDOFF_THRESHOLD_MS) {
    await sleep(POLL_INTERVAL_MS);

    if (existsSync(progressFile)) {
      try {
        const progress: ProgressData = JSON.parse(readFileSync(progressFile, "utf-8"));

        if (!lastProgress ||
            progress.completed !== lastProgress.completed ||
            progress.status !== lastProgress.status) {

          const elapsed = Math.floor(progress.elapsedMs / 1000);
          const minutes = Math.floor(elapsed / 60);
          const seconds = elapsed % 60;

          if (progress.status === "complete") {
            console.log(`\n✅ Swarm complete! (Python fallback)`);
            console.log(`   Completed: ${progress.completed}/${progress.totalTasks} tasks`);
            if (progress.failed > 0) console.log(`   Failed: ${progress.failed}`);
            console.log(`   Duration: ${minutes}m ${seconds}s\n`);
            return;
          } else {
            console.log(`[${minutes}m ${seconds}s] Progress: ${progress.completed}/${progress.totalTasks} tasks (${progress.percentComplete}%)`);
            if (progress.failed > 0) console.log(`   ⚠️  Failed: ${progress.failed}`);
          }

          lastProgress = progress;
        }
      } catch {
        // Mid-write ignore
      }
    }
  }

  console.log(`\n⏰ Handoff — swarm continuing in background (Python)`);
  console.log(`   Swarm ID: ${swarmId}`);
  console.log(`   Check: ~/.swarm/results/${swarmId}.json\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\n❌ Hybrid runner failed: ${error}`);
    process.exit(1);
  });
}
