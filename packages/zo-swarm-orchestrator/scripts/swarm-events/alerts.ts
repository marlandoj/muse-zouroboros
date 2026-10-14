#!/usr/bin/env bun
/**
 * Swarm & Autoloop SMS Alert System
 *
 * Sends SMS alerts via Zo's send_sms_to_user for critical events:
 * - Swarm task failures (after retries exhausted)
 * - Autoloop regressions (metric dropped below session baseline)
 * - Service health critical (process crashed 3+ times)
 *
 * Rate limited: max 1 SMS per event type per 15 minutes.
 *
 * Usage:
 *   import { sendAlert, AlertType } from "./alerts";
 *   await sendAlert("swarm_failure", "Wave 2 failed: build task timed out after 3 retries");
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export type AlertType =
  | "swarm_failure"
  | "autoloop_regression"
  | "service_critical"
  | "sentinel_overload";

interface AlertRecord {
  type: AlertType;
  lastSent: number;
  count: number;
}

const RATE_LIMIT_MS = 15 * 60 * 1000; // 15 minutes per event type
const STATE_FILE = "/tmp/swarm-alert-state.json";
// ZO_API_URL removed (governance review 2026-10-14): the Zo /zo/ask SMS
// path is gone with the retired platform; sendAlert logs locally.

function loadState(): Map<AlertType, AlertRecord> {
  const map = new Map<AlertType, AlertRecord>();
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      for (const [key, val] of Object.entries(data)) {
        map.set(key as AlertType, val as AlertRecord);
      }
    }
  } catch {}
  return map;
}

function saveState(state: Map<AlertType, AlertRecord>): void {
  const obj: Record<string, AlertRecord> = {};
  for (const [key, val] of state) {
    obj[key] = val;
  }
  writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
}

function isRateLimited(type: AlertType): boolean {
  const state = loadState();
  const record = state.get(type);
  if (!record) return false;
  return Date.now() - record.lastSent < RATE_LIMIT_MS;
}

function recordSent(type: AlertType): void {
  const state = loadState();
  const existing = state.get(type);
  state.set(type, {
    type,
    lastSent: Date.now(),
    count: (existing?.count || 0) + 1,
  });
  saveState(state);
}

export async function sendAlert(
  type: AlertType,
  summary: string,
  options: { force?: boolean } = {}
): Promise<{ sent: boolean; reason?: string }> {
  if (!options.force && isRateLimited(type)) {
    return { sent: false, reason: `Rate limited (${type}): max 1 per 15min` };
  }

  // The Zo API SMS path was removed outright (governance review 2026-10-14,
  // operator's order): Zo Computer is retired. Alerts are written to the
  // local log for manual review.
  const alertLog = "/tmp/swarm-alerts.log";
  const entry = `[${new Date().toISOString()}] ${type}: ${summary}\n`;
  try {
    const { appendFileSync } = await import("fs");
    appendFileSync(alertLog, entry);
  } catch {}
  return { sent: false, reason: "Zo SMS removed (platform retired) — logged to /tmp/swarm-alerts.log" };
}

export async function sendSwarmFailureAlert(
  swarmId: string,
  taskId: string,
  error: string
): Promise<{ sent: boolean; reason?: string }> {
  return sendAlert(
    "swarm_failure",
    `Swarm ${swarmId}: task "${taskId}" failed — ${error.slice(0, 120)}`
  );
}

export async function sendAutoloopRegressionAlert(
  programName: string,
  baseline: number,
  current: number
): Promise<{ sent: boolean; reason?: string }> {
  const drop = ((baseline - current) / baseline * 100).toFixed(1);
  return sendAlert(
    "autoloop_regression",
    `Autoloop "${programName}": metric dropped ${drop}% (${baseline.toFixed(4)} → ${current.toFixed(4)})`
  );
}

export async function sendServiceCriticalAlert(
  serviceName: string,
  crashCount: number
): Promise<{ sent: boolean; reason?: string }> {
  return sendAlert(
    "service_critical",
    `Service "${serviceName}" crashed ${crashCount}x — check /dev/shm/${serviceName}_err.log`
  );
}

// CLI mode
if (import.meta.main) {
  const [type, ...rest] = process.argv.slice(2);
  if (!type) {
    console.log("Usage: bun alerts.ts <type> <summary>");
    console.log("Types: swarm_failure, autoloop_regression, service_critical, sentinel_overload");
    process.exit(1);
  }
  const summary = rest.join(" ") || "Test alert";
  const result = await sendAlert(type as AlertType, summary);
  console.log(JSON.stringify(result, null, 2));
}
