#!/usr/bin/env bun
/**
 * Swarm Event HTTP Callback Server
 *
 * Receives watch pattern events via POST and writes file sentinels.
 * This enables reactive DAG transitions from any HTTP-capable source.
 *
 * Endpoint: POST http://localhost:7821/swarm/event
 * Health:   GET  http://localhost:7821/health
 *
 * Usage:
 *   bun event-server.ts [--port 7821] [--sentinel-dir /tmp/swarm-events]
 */

import { writeSentinel, type SwarmEvent } from "./sentinel";

const PORT = parseInt(process.env.SWARM_EVENT_PORT || "7821", 10);
const SENTINEL_DIR = process.env.SWARM_SENTINEL_DIR || "/tmp/swarm-events";

const rateLimiter = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(taskId: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(taskId);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimiter.set(taskId, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function validateEvent(body: unknown): { valid: boolean; event?: SwarmEvent; error?: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  if (!obj.task_id || typeof obj.task_id !== "string") {
    return { valid: false, error: "Missing or invalid task_id" };
  }

  const validTypes = ["pattern_match", "task_complete", "task_failed", "health_check"];
  if (!obj.event_type || !validTypes.includes(obj.event_type as string)) {
    return { valid: false, error: `event_type must be one of: ${validTypes.join(", ")}` };
  }

  const event: SwarmEvent = {
    task_id: obj.task_id as string,
    event_type: obj.event_type as SwarmEvent["event_type"],
    pattern: typeof obj.pattern === "string" ? obj.pattern : undefined,
    matched_line: typeof obj.matched_line === "string" ? obj.matched_line : undefined,
    timestamp: typeof obj.timestamp === "string" ? obj.timestamp : new Date().toISOString(),
    source: typeof obj.source === "string" ? obj.source : "http-callback",
    metadata: typeof obj.metadata === "object" && obj.metadata !== null
      ? obj.metadata as Record<string, unknown>
      : undefined,
  };

  return { valid: true, event };
}

let totalReceived = 0;
let totalWritten = 0;
let totalRejected = 0;
const startTime = Date.now();

const server = Bun.serve({
  port: PORT,
  hostname: process.env.SWARM_EVENT_HOST || "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({
        status: "ok",
        uptime_ms: Date.now() - startTime,
        stats: { received: totalReceived, written: totalWritten, rejected: totalRejected },
        sentinel_dir: SENTINEL_DIR,
      });
    }

    if (req.method === "POST" && url.pathname === "/swarm/event") {
      totalReceived++;

      return req.json().then(body => {
        const result = validateEvent(body);
        if (!result.valid || !result.event) {
          totalRejected++;
          return Response.json({ error: result.error }, { status: 400 });
        }

        if (!checkRateLimit(result.event.task_id)) {
          totalRejected++;
          return Response.json(
            { error: `Rate limited: max ${RATE_LIMIT} events/min per task_id` },
            { status: 429 }
          );
        }

        const path = writeSentinel(result.event, { dir: SENTINEL_DIR });
        totalWritten++;

        return Response.json({ accepted: true, sentinel: path }, { status: 202 });
      }).catch(() => {
        totalRejected++;
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[swarm-event-server] Listening on http://localhost:${server.port}`);
console.log(`[swarm-event-server] Sentinel dir: ${SENTINEL_DIR}`);
