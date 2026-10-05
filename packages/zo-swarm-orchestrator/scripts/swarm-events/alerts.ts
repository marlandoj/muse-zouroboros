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
const ZO_API_URL = "https://api.zo.computer/zo/ask";

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

const SEVERITY_EMOJI: Record<AlertType, string> = {
  swarm_failure: "🔴",
  autoloop_regression: "⚠️",
  service_critical: "🔴",
  sentinel_overload: "⚡",
};

export async function sendAlert(
  type: AlertType,
  summary: string,
  options: { force?: boolean } = {}
): Promise<{ sent: boolean; reason?: string }> {
  if (!options.force && isRateLimited(type)) {
    return { sent: false, reason: `Rate limited (${type}): max 1 per 15min` };
  }

  const emoji = SEVERITY_EMOJI[type] || "⚠️";
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Phoenix" });
  const message = `${emoji} ${type.replace("_", " ").toUpperCase()}\n${summary}\n${timestamp}`;

  // Use Zo API to send SMS
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) {
    // Fallback: write to file for manual review
    const alertLog = "/tmp/swarm-alerts.log";
    const entry = `[${new Date().toISOString()}] ${type}: ${summary}\n`;
    try {
      const { appendFileSync } = await import("fs");
      appendFileSync(alertLog, entry);
    } catch {}
    return { sent: false, reason: "No ZO_CLIENT_IDENTITY_TOKEN — logged to /tmp/swarm-alerts.log" };
  }

  try {
    const resp = await fetch(ZO_API_URL, {
      method: "POST",
      headers: {
        authorization: token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: `Send an SMS to the user with this exact message (do not modify it): ${message}`,
        // Portable: operator may pin a model via SWARM_ALERT_MODEL_NAME; otherwise
        // omit it so /zo/ask falls back to the workspace default model.
        model_name: process.env.SWARM_ALERT_MODEL_NAME || undefined,
      }),
    });

    if (resp.ok) {
      recordSent(type);
      return { sent: true };
    } else {
      return { sent: false, reason: `Zo API returned ${resp.status}` };
    }
  } catch (err) {
    return { sent: false, reason: `Zo API error: ${err}` };
  }
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
