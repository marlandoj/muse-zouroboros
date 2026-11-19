#!/usr/bin/env bun
/**
 * Swarm Event Sentinel — File-based event bus for watch pattern → orchestrator communication.
 *
 * Events are written atomically (write-tmp → rename) to a sentinel directory.
 * The orchestrator consumes sentinels between waves or on poll intervals.
 *
 * Usage:
 *   import { writeSentinel, consumeSentinels, cleanStaleSentinels } from "./sentinel";
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const DEFAULT_SENTINEL_DIR = process.env.SWARM_SENTINEL_DIR || "/tmp/swarm-events";
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

export interface SwarmEvent {
  task_id: string;
  event_type: "pattern_match" | "task_complete" | "task_failed" | "health_check";
  pattern?: string;
  matched_line?: string;
  timestamp: string;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface SentinelOptions {
  dir?: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeSentinel(event: SwarmEvent, opts: SentinelOptions = {}): string {
  const dir = opts.dir || DEFAULT_SENTINEL_DIR;
  ensureDir(dir);

  const filename = `${event.task_id}_${Date.now()}_${randomUUID().slice(0, 8)}.json`;
  const targetPath = join(dir, filename);
  const tmpPath = join(dir, `.tmp_${filename}`);

  writeFileSync(tmpPath, JSON.stringify(event, null, 2));
  renameSync(tmpPath, targetPath);

  return targetPath;
}

export function readSentinel(filePath: string): SwarmEvent | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed.task_id || !parsed.event_type || !parsed.timestamp || !parsed.source) {
      console.warn(`[sentinel] Malformed sentinel, skipping: ${filePath}`);
      return null;
    }
    return parsed as SwarmEvent;
  } catch (err) {
    console.warn(`[sentinel] Failed to read sentinel ${filePath}: ${err}`);
    return null;
  }
}

export function consumeSentinels(
  taskIds?: Set<string>,
  opts: SentinelOptions = {}
): SwarmEvent[] {
  const dir = opts.dir || DEFAULT_SENTINEL_DIR;
  if (!existsSync(dir)) return [];

  const events: SwarmEvent[] = [];
  const files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith(".tmp_"));

  for (const file of files) {
    const filePath = join(dir, file);
    const event = readSentinel(filePath);
    if (!event) {
      try { unlinkSync(filePath); } catch {}
      continue;
    }

    if (taskIds && !taskIds.has(event.task_id)) continue;

    events.push(event);
    try { unlinkSync(filePath); } catch {}
  }

  return events;
}

export function cleanStaleSentinels(opts: SentinelOptions = {}): number {
  const dir = opts.dir || DEFAULT_SENTINEL_DIR;
  if (!existsSync(dir)) return 0;

  let cleaned = 0;
  const now = Date.now();
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(dir, file);
    const event = readSentinel(filePath);
    if (!event) {
      try { unlinkSync(filePath); cleaned++; } catch {}
      continue;
    }

    const eventTime = new Date(event.timestamp).getTime();
    if (now - eventTime > STALE_THRESHOLD_MS) {
      try { unlinkSync(filePath); cleaned++; } catch {}
    }
  }

  return cleaned;
}

export function listSentinels(opts: SentinelOptions = {}): SwarmEvent[] {
  const dir = opts.dir || DEFAULT_SENTINEL_DIR;
  if (!existsSync(dir)) return [];

  const events: SwarmEvent[] = [];
  const files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith(".tmp_"));

  for (const file of files) {
    const event = readSentinel(join(dir, file));
    if (event) events.push(event);
  }

  return events;
}
