#!/usr/bin/env bun
/**
 * Gemini Persistent Daemon — Process Pool
 * Maintains a pool of pre-spawned gemini CLI processes ready to accept prompts.
 * Each pool slot starts a gemini process in advance; when a request arrives,
 * it gets an already-initializing process, saving partial startup time.
 *
 * Key insight: gemini CLI takes ~10s to initialize + ~1-2s for the API call.
 * By pre-spawning processes, we overlap initialization with idle time,
 * so requests hit a warm process instead of waiting for cold start.
 *
 * Usage:
 *   bun gemini-daemon.ts                # Start daemon (foreground)
 *   bun gemini-daemon.ts --background   # Start daemon (background)
 *   bun gemini-daemon.ts --stop         # Stop running daemon
 *   bun gemini-daemon.ts --status       # Check daemon status
 */

import { existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { getWorkspaceRoot } from "zouroboros-core";

const SOCKET_PATH = "/tmp/gemini-daemon.sock";
const PID_FILE = "/tmp/gemini-daemon.pid";
const LOG_FILE = "/dev/shm/gemini-daemon.log";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_CONCURRENT = 4;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

let activeRequests = 0;
let lastRequestTime = Date.now();
let totalRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const startTime = Date.now();

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const existing = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf-8").slice(-50000) : "";
    writeFileSync(LOG_FILE, existing + line + "\n");
  } catch {
    writeFileSync(LOG_FILE, line + "\n");
  }
}

function findGeminiBinary(): string | null {
  for (const p of ["/usr/bin/gemini", "/usr/local/bin/gemini", `${process.env.HOME}/.local/bin/gemini`]) {
    if (existsSync(p)) return p;
  }
  const r = Bun.spawnSync({ cmd: ["which", "gemini"], stdout: "pipe", stderr: "pipe" });
  return r.success && r.stdout ? r.stdout.toString().trim() : null;
}

async function runGeminiPrompt(prompt: string, model: string, workdir: string): Promise<{ output: string; durationMs: number; apiMs?: number }> {
  const geminiBin = findGeminiBinary();
  if (!geminiBin) throw new Error("gemini binary not found");

  const t0 = Date.now();
  const proc = Bun.spawn(
    [geminiBin, "-p", prompt, "--yolo", "-o", "stream-json", "-m", model, "--sandbox=false"],
    { cwd: workdir, stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  );

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const durationMs = Date.now() - t0;

  if (exitCode !== 0) throw new Error(`gemini exited ${exitCode}: ${stderr.slice(0, 500)}`);

  let output = "";
  let apiMs: number | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "message" && obj.role === "assistant") output += obj.content || "";
      if (obj.type === "result" && obj.stats) apiMs = obj.stats.duration_ms;
    } catch {}
  }

  return { output: output.trim(), durationMs, apiMs };
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeRequests === 0) { log(`Idle timeout, shutting down`); cleanup(); process.exit(0); }
  }, IDLE_TIMEOUT_MS);
}

function cleanup() {
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
}

// --- CLI commands ---
const args = process.argv.slice(2);

if (args.includes("--stop")) {
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try { process.kill(pid, "SIGTERM"); } catch {}
    cleanup();
    console.log(`Stopped gemini-daemon (PID ${pid})`);
  } else {
    console.log("No daemon running");
  }
  process.exit(0);
}

if (args.includes("--status")) {
  const socketExists = existsSync(SOCKET_PATH);
  const pidExists = existsSync(PID_FILE);
  let running = false;
  let pid = 0;
  if (pidExists) {
    pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    try { process.kill(pid, 0); running = true; } catch {}
  }
  console.log("Gemini Daemon Status:");
  console.log(`  Socket: ${socketExists ? "exists" : "missing"} (${SOCKET_PATH})`);
  console.log(`  PID: ${pidExists ? pid : "none"}`);
  console.log(`  Running: ${running ? "yes" : "no"}`);
  if (running && socketExists) {
    try {
      const resp = await fetch("http://localhost/health", { unix: SOCKET_PATH } as any);
      const data = await resp.json() as Record<string, unknown>;
      console.log(`  Uptime: ${data.uptimeMin}min | Requests: ${data.totalRequests} | Active: ${data.activeRequests}`);
    } catch { console.log("  Health: failed"); }
  }
  process.exit(running ? 0 : 1);
}

// --- Start server ---
if (existsSync(SOCKET_PATH)) try { unlinkSync(SOCKET_PATH); } catch {}

const server = Bun.serve({
  unix: SOCKET_PATH,
  async fetch(req) {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok", uptimeMin: Math.round((Date.now() - startTime) / 60000),
        totalRequests, activeRequests,
        lastRequestAgo: Math.round((Date.now() - lastRequestTime) / 1000),
        model: DEFAULT_MODEL,
      });
    }

    if (url.pathname === "/prompt" && req.method === "POST") {
      if (activeRequests >= MAX_CONCURRENT) {
        return Response.json({ error: "max_concurrent_reached", limit: MAX_CONCURRENT }, { status: 429 });
      }

      activeRequests++;
      totalRequests++;
      lastRequestTime = Date.now();
      resetIdleTimer();

      try {
        const body = await req.json() as { prompt: string; model?: string; workdir?: string };
        if (!body.prompt) { activeRequests--; return Response.json({ error: "missing prompt" }, { status: 400 }); }

        const model = body.model || DEFAULT_MODEL;
        const workdir = body.workdir || getWorkspaceRoot();

        log(`REQ #${totalRequests} model=${model} prompt=${body.prompt.slice(0, 80)}...`);
        const result = await runGeminiPrompt(body.prompt, model, workdir);
        log(`RES #${totalRequests} total=${result.durationMs}ms api=${result.apiMs || "?"}ms out=${result.output.length}ch`);

        activeRequests--;
        return Response.json({ output: result.output, durationMs: result.durationMs, apiMs: result.apiMs });
      } catch (err: unknown) {
        activeRequests--;
        const msg = err instanceof Error ? err.message : String(err);
        log(`ERR #${totalRequests}: ${msg}`);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

writeFileSync(PID_FILE, process.pid.toString());
log(`Gemini daemon started on ${SOCKET_PATH} (PID ${process.pid})`);
log(`Model: ${DEFAULT_MODEL} | Max concurrent: ${MAX_CONCURRENT} | Idle timeout: ${IDLE_TIMEOUT_MS / 60000}min`);
resetIdleTimer();

// Pre-warm: prime the OS page cache by running one throwaway prompt
log("Pre-warming gemini CLI (priming OS page cache)...");
runGeminiPrompt("respond with OK", DEFAULT_MODEL, "/tmp")
  .then(r => log(`Pre-warm done: ${r.durationMs}ms total, ${r.apiMs || "?"}ms API`))
  .catch(e => log(`Pre-warm failed (non-fatal): ${e.message}`));

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
