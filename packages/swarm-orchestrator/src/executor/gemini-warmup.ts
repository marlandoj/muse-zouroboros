#!/usr/bin/env bun
/**
 * Gemini Warm-Up & Daemon Manager
 * Pre-loads Gemini CLI and manages the persistent daemon for fast execution.
 *
 * Usage:
 *   bun gemini-warmup.ts                  # One-time warm-up (starts daemon if not running)
 *   bun gemini-warmup.ts --daemon         # Start persistent daemon in background
 *   bun gemini-warmup.ts --stop           # Stop daemon
 *   bun gemini-warmup.ts --status         # Check warm/daemon status
 *   bun gemini-warmup.ts --no-daemon      # One-time warm-up only, skip daemon
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { getWorkspaceRoot } from "zouroboros-core";

const WARMUP_MARKER = "/tmp/gemini-warm.timestamp";
const DAEMON_SOCKET = "/tmp/gemini-daemon.sock";
const DAEMON_PID_FILE = "/tmp/gemini-daemon.pid";
const DAEMON_SCRIPT = new URL("./gemini-daemon.ts", import.meta.url).pathname;
const PING_TIMEOUT_MS = 20000;
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

interface WarmupOptions {
  daemon?: boolean;
  stop?: boolean;
  status?: boolean;
  noDaemon?: boolean;
  verbose?: boolean;
}

function parseArgs(): WarmupOptions {
  const args = process.argv.slice(2);
  return {
    daemon: args.includes("--daemon"),
    stop: args.includes("--stop"),
    status: args.includes("--status"),
    noDaemon: args.includes("--no-daemon"),
    verbose: args.includes("--verbose") || args.includes("-v"),
  };
}

function log(msg: string, verbose = true): void {
  if (verbose) console.log(`[gemini-warmup] ${msg}`);
}

async function isGeminiWarm(): Promise<boolean> {
  if (!existsSync(WARMUP_MARKER)) return false;
  const stats = await Bun.file(WARMUP_MARKER).text();
  const lastWarm = parseInt(stats.trim(), 10);
  return (Date.now() - lastWarm) < 5 * 60 * 1000;
}

async function markWarm(): Promise<void> {
  await Bun.write(WARMUP_MARKER, Date.now().toString());
}

async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_SOCKET)) return false;
  if (!existsSync(DAEMON_PID_FILE)) return false;
  const pid = parseInt(await Bun.file(DAEMON_PID_FILE).text(), 10);
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startDaemon(): Promise<boolean> {
  if (await isDaemonRunning()) {
    log("Daemon already running");
    return true;
  }

  if (!existsSync(DAEMON_SCRIPT)) {
    log("Daemon script not found: " + DAEMON_SCRIPT);
    return false;
  }

  log("Starting gemini daemon...");

  const proc = spawn("bun", [DAEMON_SCRIPT, "--background"], {
    cwd: getWorkspaceRoot(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  proc.unref();

  // Wait for socket to appear (max 15s)
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(500);
    if (existsSync(DAEMON_SOCKET)) {
      log("Daemon started successfully");
      return true;
    }
  }

  log("Daemon failed to start within 15s");
  return false;
}

async function stopDaemon(): Promise<void> {
  if (!existsSync(DAEMON_PID_FILE)) {
    console.log("No daemon running");
    return;
  }
  const pid = parseInt(await Bun.file(DAEMON_PID_FILE).text(), 10);
  try { process.kill(pid, "SIGTERM"); } catch {}
  try { if (existsSync(DAEMON_SOCKET)) Bun.spawnSync({ cmd: ["rm", "-f", DAEMON_SOCKET] }); } catch {}
  try { if (existsSync(DAEMON_PID_FILE)) Bun.spawnSync({ cmd: ["rm", "-f", DAEMON_PID_FILE] }); } catch {}
  console.log(`Stopped gemini-daemon (PID ${pid})`);
}

function findGeminiBinary(): string | null {
  const paths = ["/usr/bin/gemini", "/usr/local/bin/gemini", `${process.env.HOME}/.local/bin/gemini`];
  for (const p of paths) { if (existsSync(p)) return p; }
  const result = Bun.spawnSync({ cmd: ["which", "gemini"], stdout: "pipe", stderr: "pipe" });
  if (result.success && result.stdout) return result.stdout.toString().trim();
  return null;
}

async function warmupDirect(verbose: boolean): Promise<boolean> {
  const geminiBin = findGeminiBinary();
  if (!geminiBin) {
    log("ERROR: Gemini binary not found", verbose);
    return false;
  }

  log(`Using: ${geminiBin}, model: ${DEFAULT_MODEL}`, verbose);

  return new Promise((resolve) => {
    const proc = spawn(geminiBin, [
      "-p", "respond with OK",
      "--yolo", "--output-format", "text",
      "-m", DEFAULT_MODEL, "--sandbox=false",
    ], { cwd: getWorkspaceRoot(), timeout: PING_TIMEOUT_MS });

    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); }, PING_TIMEOUT_MS);

    proc.on("exit", async (code) => {
      clearTimeout(timeout);
      if (timedOut) { log("Warm-up timed out", verbose); resolve(false); return; }
      if (code === 0 || code === null) {
        await markWarm();
        log("Gemini is warm and ready", verbose);
        resolve(true);
      } else {
        log(`Warm-up exited with code ${code}`, verbose);
        resolve(false);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      log(`Warm-up error: ${err.message}`, verbose);
      resolve(false);
    });
  });
}

async function checkStatus(): Promise<void> {
  const warm = await isGeminiWarm();
  const daemonUp = await isDaemonRunning();
  const geminiBin = findGeminiBinary();

  console.log("Gemini Warm-Up Status:");
  console.log(`  Binary: ${geminiBin ? "found" : "missing"} ${geminiBin || ""}`);
  console.log(`  Model: ${DEFAULT_MODEL}`);
  console.log(`  Warm: ${warm ? "yes" : "no (cold)"}`);
  console.log(`  Daemon: ${daemonUp ? "running" : "stopped"}`);

  if (existsSync(WARMUP_MARKER)) {
    const lastWarm = parseInt(await Bun.file(WARMUP_MARKER).text(), 10);
    console.log(`  Last warm-up: ${Math.round((Date.now() - lastWarm) / 1000)}s ago`);
  }

  if (daemonUp) {
    try {
      const resp = await fetch("http://localhost/health", {
        // @ts-ignore - Bun supports unix sockets
        unix: DAEMON_SOCKET,
      });
      const data = await resp.json() as Record<string, unknown>;
      console.log(`  Daemon uptime: ${data.uptimeMin}min, requests: ${data.totalRequests}`);
    } catch {
      console.log("  Daemon health check failed");
    }
  }

  process.exit(warm || daemonUp ? 0 : 1);
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.stop) { await stopDaemon(); return; }
  if (options.status) { await checkStatus(); return; }

  if (options.daemon) {
    const ok = await startDaemon();
    process.exit(ok ? 0 : 1);
    return;
  }

  // Default: warm up + start daemon
  console.log("[gemini-warmup] Warming up Gemini...");

  if (!options.noDaemon) {
    const daemonOk = await startDaemon();
    if (daemonOk) {
      await markWarm();
      console.log("[gemini-warmup] Daemon running — bridge calls will be ~10x faster");
      process.exit(0);
      return;
    }
    console.log("[gemini-warmup] Daemon failed, falling back to direct warm-up");
  }

  const success = await warmupDirect(true);
  if (success) {
    console.log("[gemini-warmup] Ready for swarm execution");
  } else {
    console.log("[gemini-warmup] Warm-up failed, but Gemini may still work");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[gemini-warmup] Fatal error:", err);
  process.exit(1);
});
