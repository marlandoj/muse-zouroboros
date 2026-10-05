#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const FAILURE_PARK_THRESHOLD = 2;

export interface FailureFingerprintInput {
  ticket_identifier: string;
  failing_stage: string;
  error_class: string;
  error_signature: string;
  cycle_id: string;
}

export interface FailureFingerprint {
  ticket_identifier: string;
  failing_stage: string;
  error_class: string;
  normalized_signature: string;
  digest: string;
}

export interface NotificationAttempt {
  attempt_id: string;
  fingerprint_digest: string;
  cycle_id: string;
  attempted_at: string;
  completed_at: string | null;
  status: "started" | "delivered" | "failed";
  error: string | null;
}

export interface FailureStreakRecord {
  version: 1;
  ticket_identifier: string;
  current_fingerprint: FailureFingerprint | null;
  consecutive_failures: number;
  processed_cycles: Array<{ cycle_id: string; fingerprint_digest: string; observed_at: string }>;
  parked_at: string | null;
  parked_cycle_id: string | null;
  notification_delivered_at: string | null;
  notification_attempts: NotificationAttempt[];
  last_success_at: string | null;
  updated_at: string;
}

export type FailureCycleAction = "retry" | "park_and_notify" | "parked_noop" | "duplicate_cycle";

export interface FailureCycleDecision {
  action: FailureCycleAction;
  fingerprint: FailureFingerprint;
  record: FailureStreakRecord;
  should_dispatch: boolean;
  should_park: boolean;
  should_notify: boolean;
  fingerprint_changed: boolean;
}

export interface FailureStateOptions {
  state_dir: string;
  now?: () => string;
  attempt_id?: () => string;
}

export type NotificationSender = (message: string) => void;

export interface NotificationDeliveryResult {
  status: "delivered" | "failed" | "skipped";
  attempt: NotificationAttempt | null;
  record: FailureStreakRecord;
}

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const GENERATED_ID = /\b(?:exec(?:ution)?|run|job|request|trace|span)[-_:/= ]+[a-z0-9][a-z0-9._-]{7,}\b/gi;
const LONG_HEX = /\b[0-9a-f]{16,}\b/gi;
const RETRY_COUNTER = /\b(?:attempt|retry|retries|cycle)\s*(?:#|=|:)?\s*\d+\b/gi;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be non-empty`);
  return trimmed;
}

export function normalizeFailureSignature(signature: string): string {
  return requireText(signature, "error_signature")
    .toLowerCase()
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(UUID, "<uuid>")
    .replace(GENERATED_ID, (value) => `${value.split(/[-_:/= ]/)[0]}=<generated-id>`)
    .replace(LONG_HEX, "<generated-id>")
    .replace(RETRY_COUNTER, (value) => `${value.split(/\s/)[0]} <n>`)
    .replace(/\s+/g, " ")
    .trim();
}

export function createFailureFingerprint(input: Omit<FailureFingerprintInput, "cycle_id">): FailureFingerprint {
  const ticketIdentifier = requireText(input.ticket_identifier, "ticket_identifier");
  const failingStage = requireText(input.failing_stage, "failing_stage").toLowerCase();
  const errorClass = requireText(input.error_class, "error_class").toLowerCase();
  const normalizedSignature = normalizeFailureSignature(input.error_signature);
  const digest = sha256(JSON.stringify([ticketIdentifier, failingStage, errorClass, normalizedSignature]));
  return {
    ticket_identifier: ticketIdentifier,
    failing_stage: failingStage,
    error_class: errorClass,
    normalized_signature: normalizedSignature,
    digest,
  };
}

function statePath(stateDir: string, ticketIdentifier: string): string {
  return join(stateDir, `failure-streak-${sha256(ticketIdentifier).slice(0, 24)}.json`);
}

export function notificationLedgerPath(stateDir: string): string {
  return join(stateDir, "failure-notification-attempts.jsonl");
}

function initialRecord(ticketIdentifier: string, timestamp: string): FailureStreakRecord {
  return {
    version: 1,
    ticket_identifier: ticketIdentifier,
    current_fingerprint: null,
    consecutive_failures: 0,
    processed_cycles: [],
    parked_at: null,
    parked_cycle_id: null,
    notification_delivered_at: null,
    notification_attempts: [],
    last_success_at: null,
    updated_at: timestamp,
  };
}

export function loadFailureStreak(ticketIdentifier: string, stateDir: string): FailureStreakRecord | null {
  const path = statePath(stateDir, ticketIdentifier);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as FailureStreakRecord;
  if (parsed.version !== 1 || parsed.ticket_identifier !== ticketIdentifier) {
    throw new Error(`invalid failure streak record for ${ticketIdentifier}`);
  }
  return parsed;
}

export function activeFailurePark(ticketIdentifier: string, stateDir: string): FailureStreakRecord | null {
  const record = loadFailureStreak(ticketIdentifier, stateDir);
  return record?.parked_at !== null && record?.current_fingerprint !== null ? record : null;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may already have been atomically renamed.
    }
    throw error;
  }
}

function saveFailureStreak(record: FailureStreakRecord, stateDir: string): void {
  atomicWrite(statePath(stateDir, record.ticket_identifier), record);
}

function appendAudit(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordFailureCycle(input: FailureFingerprintInput, options: FailureStateOptions): FailureCycleDecision {
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const cycleId = requireText(input.cycle_id, "cycle_id");
  const fingerprint = createFailureFingerprint(input);
  const existing = loadFailureStreak(fingerprint.ticket_identifier, options.state_dir)
    ?? initialRecord(fingerprint.ticket_identifier, timestamp);
  const priorCycle = existing.processed_cycles.find((cycle) => cycle.cycle_id === cycleId);

  if (priorCycle) {
    if (priorCycle.fingerprint_digest !== fingerprint.digest) {
      throw new Error(`cycle ${cycleId} already recorded with a different failure fingerprint`);
    }
    return {
      action: "duplicate_cycle",
      fingerprint,
      record: existing,
      should_dispatch: existing.consecutive_failures < FAILURE_PARK_THRESHOLD,
      should_park: existing.consecutive_failures >= FAILURE_PARK_THRESHOLD,
      should_notify: existing.consecutive_failures >= FAILURE_PARK_THRESHOLD && existing.notification_delivered_at === null,
      fingerprint_changed: false,
    };
  }

  const fingerprintChanged = existing.current_fingerprint !== null && existing.current_fingerprint.digest !== fingerprint.digest;
  const consecutiveFailures = existing.current_fingerprint?.digest === fingerprint.digest
    ? existing.consecutive_failures + 1
    : 1;
  const firstPark = consecutiveFailures >= FAILURE_PARK_THRESHOLD && existing.parked_at === null;
  const record: FailureStreakRecord = {
    ...existing,
    current_fingerprint: fingerprint,
    consecutive_failures: consecutiveFailures,
    processed_cycles: [...existing.processed_cycles, { cycle_id: cycleId, fingerprint_digest: fingerprint.digest, observed_at: timestamp }].slice(-128),
    parked_at: firstPark ? timestamp : fingerprintChanged ? null : existing.parked_at,
    parked_cycle_id: firstPark ? cycleId : fingerprintChanged ? null : existing.parked_cycle_id,
    notification_delivered_at: fingerprintChanged ? null : existing.notification_delivered_at,
    notification_attempts: fingerprintChanged ? [] : existing.notification_attempts,
    updated_at: timestamp,
  };
  saveFailureStreak(record, options.state_dir);

  const parked = consecutiveFailures >= FAILURE_PARK_THRESHOLD;
  return {
    action: firstPark ? "park_and_notify" : parked ? "parked_noop" : "retry",
    fingerprint,
    record,
    should_dispatch: !parked,
    should_park: parked,
    should_notify: firstPark,
    fingerprint_changed: fingerprintChanged,
  };
}

export function recordFailureSuccess(
  ticketIdentifier: string,
  cycleId: string,
  options: FailureStateOptions,
): FailureStreakRecord {
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const identifier = requireText(ticketIdentifier, "ticket_identifier");
  const record: FailureStreakRecord = {
    ...(loadFailureStreak(identifier, options.state_dir) ?? initialRecord(identifier, timestamp)),
    current_fingerprint: null,
    consecutive_failures: 0,
    processed_cycles: [],
    parked_at: null,
    parked_cycle_id: null,
    notification_delivered_at: null,
    notification_attempts: [],
    last_success_at: timestamp,
    updated_at: timestamp,
  };
  saveFailureStreak(record, options.state_dir);
  appendAudit(join(options.state_dir, "failure-cycle-events.jsonl"), {
    event: "success_reset",
    ticket_identifier: identifier,
    cycle_id: requireText(cycleId, "cycle_id"),
    recorded_at: timestamp,
  });
  return record;
}

export function releaseFailurePark(
  ticketIdentifier: string,
  cycleId: string,
  releasedBy: string,
  options: FailureStateOptions,
): FailureStreakRecord {
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const identifier = requireText(ticketIdentifier, "ticket_identifier");
  const existing = loadFailureStreak(identifier, options.state_dir);
  if (!existing) throw new Error(`missing failure streak for ${identifier}`);
  const record: FailureStreakRecord = {
    ...existing,
    current_fingerprint: null,
    consecutive_failures: 0,
    processed_cycles: [],
    parked_at: null,
    parked_cycle_id: null,
    notification_delivered_at: null,
    notification_attempts: [],
    updated_at: timestamp,
  };
  saveFailureStreak(record, options.state_dir);
  appendAudit(join(options.state_dir, "failure-cycle-events.jsonl"), {
    event: "operator_release",
    ticket_identifier: identifier,
    cycle_id: requireText(cycleId, "cycle_id"),
    released_by: requireText(releasedBy, "released_by"),
    recorded_at: timestamp,
  });
  return record;
}

export function failureNotificationText(decision: FailureCycleDecision): string {
  return `[Factory] ${decision.fingerprint.ticket_identifier} parked after ${decision.record.consecutive_failures} consecutive ${decision.fingerprint.error_class} failures at ${decision.fingerprint.failing_stage}. Fingerprint ${decision.fingerprint.digest.slice(0, 12)}.`;
}

export function deliverFailureNotification(
  decision: FailureCycleDecision,
  sender: NotificationSender,
  options: FailureStateOptions,
): NotificationDeliveryResult {
  const latest = loadFailureStreak(decision.fingerprint.ticket_identifier, options.state_dir);
  if (!latest) throw new Error(`missing failure streak for ${decision.fingerprint.ticket_identifier}`);
  if (latest.current_fingerprint?.digest !== decision.fingerprint.digest || latest.consecutive_failures < FAILURE_PARK_THRESHOLD) {
    return { status: "skipped", attempt: null, record: latest };
  }
  if (latest.notification_delivered_at !== null) {
    return { status: "skipped", attempt: null, record: latest };
  }

  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  const attempt: NotificationAttempt = {
    attempt_id: (options.attempt_id ?? randomUUID)(),
    fingerprint_digest: decision.fingerprint.digest,
    cycle_id: latest.parked_cycle_id ?? "unknown",
    attempted_at: timestamp,
    completed_at: null,
    status: "started",
    error: null,
  };
  latest.notification_attempts = [...latest.notification_attempts, attempt];
  latest.updated_at = timestamp;
  saveFailureStreak(latest, options.state_dir);
  appendAudit(notificationLedgerPath(options.state_dir), attempt);

  try {
    sender(failureNotificationText(decision));
    const completedAt = (options.now ?? (() => new Date().toISOString()))();
    attempt.status = "delivered";
    attempt.completed_at = completedAt;
    latest.notification_delivered_at = completedAt;
    latest.updated_at = completedAt;
    saveFailureStreak(latest, options.state_dir);
    appendAudit(notificationLedgerPath(options.state_dir), attempt);
    return { status: "delivered", attempt, record: latest };
  } catch (error) {
    const completedAt = (options.now ?? (() => new Date().toISOString()))();
    attempt.status = "failed";
    attempt.completed_at = completedAt;
    attempt.error = error instanceof Error ? error.message : String(error);
    latest.updated_at = completedAt;
    saveFailureStreak(latest, options.state_dir);
    appendAudit(notificationLedgerPath(options.state_dir), attempt);
    return { status: "failed", attempt, record: latest };
  }
}
