#!/usr/bin/env bun
import { factoryWorktreeReadRoots, factoryWorktreesRoot, loadFactoryPathProfile } from "../../../packages/swarm/src/transport/factory-path-profile";

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { poolStateDir, writeJsonAtomic } from "./pool-queue";

export type WorkerStatus = "idle" | "leased" | "stale";
export type LeaseStatus = "active" | "released" | "expired";
export type CheckpointStage = "claimed" | "heartbeat" | "result-durable" | "terminal" | "released";

export interface WorkerRecord {
  worker_id: string;
  created_at: string;
  last_seen_at: string;
  status: WorkerStatus;
}

export interface WorkerLease {
  lease_id: string;
  worker_id: string;
  assignment_id: string;
  campaign_id: string;
  task_id: string;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  status: LeaseStatus;
  released_at: string | null;
  outcome: string | null;
  worktree_path?: string;
}

export interface WorkerCheckpoint {
  checkpoint_id: string;
  assignment_id: string;
  lease_id: string;
  worker_id: string;
  stage: CheckpointStage;
  recorded_at: string;
  detail?: string;
}

export interface WorkerDeadLetter {
  dead_letter_id: string;
  lease_id: string;
  assignment_id: string;
  worker_id: string;
  campaign_id: string;
  task_id: string;
  detected_at: string;
  reason: "lease-expired";
  worktree_path: string | null;
  cleanup: "cleaned" | "absent" | "rejected" | "failed";
}

export interface SupervisorAssignmentLike {
  assignment_id: string;
  campaign_id: string;
  task_id: string;
  outcome: string | null;
  result_path?: string;
  heartbeat_path?: string;
  worker_id?: string;
  lease_id?: string;
  worktree_path?: string;
}

export interface AcquireLeaseInput {
  assignment_id: string;
  campaign_id: string;
  task_id: string;
  timeout_min: number;
  worker_id?: string;
  worktree_path?: string;
  now?: Date;
  lease_ttl_ms?: number;
}

export interface AcquireLeaseResult {
  worker: WorkerRecord;
  lease: WorkerLease;
  idempotent: boolean;
}

export interface SupervisorReconcileResult {
  renewed: number;
  released: number;
  expired: number;
  dead_letters: number;
}

export interface SupervisorSnapshot {
  workers: WorkerRecord[];
  active_leases: WorkerLease[];
  expired_leases: number;
  checkpoints: number;
  dead_letters: WorkerDeadLetter[];
}

const DEFAULT_LEASE_GRACE_MS = 5 * 60_000;
const SUPERVISOR_LOCK_STALE_MS = 5 * 60_000;

function supervisorDir(): string {
  return join(poolStateDir(), "supervisor");
}

function workersPath(): string {
  return join(supervisorDir(), "workers.json");
}

function leasesPath(): string {
  return join(supervisorDir(), "leases.json");
}

function checkpointsPath(): string {
  return join(supervisorDir(), "checkpoints.jsonl");
}

function deadLettersPath(): string {
  return join(supervisorDir(), "dead-letters.jsonl");
}

function lockPath(): string {
  return join(supervisorDir(), ".lock");
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return rows;
}

function withSupervisorLock<T>(fn: () => T): T {
  mkdirSync(supervisorDir(), { recursive: true });
  const path = lockPath();
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs > SUPERVISOR_LOCK_STALE_MS) unlinkSync(path);
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    throw new Error(`worker supervisor lock is held: ${path}`);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(path);
  }
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function leaseTtlMs(timeoutMin: number, configured?: number): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) throw new Error("lease_ttl_ms must be a positive integer");
    return configured;
  }
  const raw = process.env.SF003_WORKER_LEASE_GRACE_MIN;
  const grace = raw === undefined ? DEFAULT_LEASE_GRACE_MS : Number(raw) * 60_000;
  if (!Number.isFinite(grace) || grace <= 0) throw new Error(`SF003_WORKER_LEASE_GRACE_MIN invalid: ${raw}`);
  return Math.max(60_000, timeoutMin * 60_000 + grace);
}

function activeLeaseForTask(leases: WorkerLease[], campaignId: string, taskId: string): WorkerLease | undefined {
  return leases.find((lease) => lease.status === "active" && lease.campaign_id === campaignId && lease.task_id === taskId);
}

function activeLeasesForWorker(leases: WorkerLease[], workerId: string): WorkerLease[] {
  return leases.filter((lease) => lease.status === "active" && lease.worker_id === workerId);
}

function loadWorkersUnsafe(): WorkerRecord[] {
  return readJson<WorkerRecord[]>(workersPath(), []);
}

function loadLeasesUnsafe(): WorkerLease[] {
  return readJson<WorkerLease[]>(leasesPath(), []);
}

function loadCheckpointsUnsafe(): WorkerCheckpoint[] {
  return readJsonl<WorkerCheckpoint>(checkpointsPath());
}

function loadDeadLettersUnsafe(): WorkerDeadLetter[] {
  return readJsonl<WorkerDeadLetter>(deadLettersPath());
}

function saveWorkersUnsafe(workers: WorkerRecord[]): void {
  writeJsonAtomic(workersPath(), workers);
}

function saveLeasesUnsafe(leases: WorkerLease[]): void {
  writeJsonAtomic(leasesPath(), leases);
}

function appendCheckpointUnsafe(checkpoint: Omit<WorkerCheckpoint, "checkpoint_id">): WorkerCheckpoint {
  const rows = loadCheckpointsUnsafe();
  const existing = rows.find(
    (row) => row.assignment_id === checkpoint.assignment_id && row.stage === checkpoint.stage,
  );
  if (existing) return existing;
  const row: WorkerCheckpoint = { checkpoint_id: `checkpoint-${randomUUID()}`, ...checkpoint };
  mkdirSync(supervisorDir(), { recursive: true });
  appendFileSync(checkpointsPath(), JSON.stringify(row) + "\n");
  return row;
}

function appendDeadLetterUnsafe(row: Omit<WorkerDeadLetter, "dead_letter_id">): WorkerDeadLetter {
  const rows = loadDeadLettersUnsafe();
  const existing = rows.find((candidate) => candidate.lease_id === row.lease_id);
  if (existing) return existing;
  const deadLetter: WorkerDeadLetter = { dead_letter_id: `dead-${randomUUID()}`, ...row };
  mkdirSync(supervisorDir(), { recursive: true });
  appendFileSync(deadLettersPath(), JSON.stringify(deadLetter) + "\n");
  return deadLetter;
}

function chooseWorkerUnsafe(workers: WorkerRecord[], leases: WorkerLease[], requested?: string): WorkerRecord {
  const timestamp = new Date().toISOString();
  const workerId = requested?.trim() || process.env.SF003_WORKER_ID?.trim();
  if (workerId) {
    const existing = workers.find((worker) => worker.worker_id === workerId);
    if (activeLeasesForWorker(leases, workerId).length > 0) {
      throw new Error(`worker ${workerId} already holds an active lease`);
    }
    return existing ?? { worker_id: workerId, created_at: timestamp, last_seen_at: timestamp, status: "idle" };
  }
  const available = workers
    .filter((worker) => activeLeasesForWorker(leases, worker.worker_id).length === 0)
    .sort((a, b) => a.worker_id.localeCompare(b.worker_id))[0];
  if (available) return available;
  const slots = workers
    .map((worker) => Number(worker.worker_id.match(/^factory-worker-(\d+)$/)?.[1] ?? 0))
    .filter((slot) => slot > 0);
  const next = slots.length === 0 ? 1 : Math.max(...slots) + 1;
  return { worker_id: `factory-worker-${next}`, created_at: timestamp, last_seen_at: timestamp, status: "idle" };
}

export function loadWorkers(): WorkerRecord[] {
  return loadWorkersUnsafe();
}

export function loadLeases(): WorkerLease[] {
  return loadLeasesUnsafe();
}

export function loadCheckpoints(): WorkerCheckpoint[] {
  return loadCheckpointsUnsafe();
}

export function loadDeadLetters(): WorkerDeadLetter[] {
  return loadDeadLettersUnsafe();
}

export function acquireLease(input: AcquireLeaseInput): AcquireLeaseResult {
  return withSupervisorLock(() => {
    const timestamp = nowIso(input.now);
    const workers = loadWorkersUnsafe();
    const leases = loadLeasesUnsafe();
    const existing = leases.find(
      (lease) => lease.status === "active" && lease.assignment_id === input.assignment_id,
    );
    if (existing) {
      const worker = workers.find((candidate) => candidate.worker_id === existing.worker_id);
      if (!worker) throw new Error(`lease ${existing.lease_id} references missing worker ${existing.worker_id}`);
      return { worker, lease: existing, idempotent: true };
    }
    const duplicate = activeLeaseForTask(leases, input.campaign_id, input.task_id);
    if (duplicate) {
      throw new Error(`duplicate claim blocked for ${input.campaign_id}/${input.task_id}: lease ${duplicate.lease_id}`);
    }
    const worker = chooseWorkerUnsafe(workers, leases, input.worker_id);
    const lease: WorkerLease = {
      lease_id: `lease-${randomUUID()}`,
      worker_id: worker.worker_id,
      assignment_id: input.assignment_id,
      campaign_id: input.campaign_id,
      task_id: input.task_id,
      acquired_at: timestamp,
      renewed_at: timestamp,
      expires_at: new Date(new Date(timestamp).getTime() + leaseTtlMs(input.timeout_min, input.lease_ttl_ms)).toISOString(),
      status: "active",
      released_at: null,
      outcome: null,
      ...(input.worktree_path ? { worktree_path: input.worktree_path } : {}),
    };
    const updatedWorker: WorkerRecord = { ...worker, last_seen_at: timestamp, status: "leased" };
    saveWorkersUnsafe([...workers.filter((candidate) => candidate.worker_id !== worker.worker_id), updatedWorker]);
    saveLeasesUnsafe([...leases, lease]);
    appendCheckpointUnsafe({
      assignment_id: lease.assignment_id,
      lease_id: lease.lease_id,
      worker_id: lease.worker_id,
      stage: "claimed",
      recorded_at: timestamp,
    });
    return { worker: updatedWorker, lease, idempotent: false };
  });
}

export function recordResultDurable(assignmentId: string, recordedAt = new Date()): WorkerCheckpoint | null {
  return withSupervisorLock(() => {
    const lease = loadLeasesUnsafe().find((candidate) => candidate.assignment_id === assignmentId);
    if (!lease) return null;
    return appendCheckpointUnsafe({
      assignment_id: assignmentId,
      lease_id: lease.lease_id,
      worker_id: lease.worker_id,
      stage: "result-durable",
      recorded_at: recordedAt.toISOString(),
    });
  });
}

export function releaseLeaseForAssignment(assignmentId: string, outcome: string, releasedAt = new Date()): boolean {
  return withSupervisorLock(() => {
    const leases = loadLeasesUnsafe();
    const lease = leases.find((candidate) => candidate.status === "active" && candidate.assignment_id === assignmentId);
    if (!lease) return false;
    const timestamp = releasedAt.toISOString();
    const nextLease: WorkerLease = { ...lease, status: "released", released_at: timestamp, outcome };
    saveLeasesUnsafe(leases.map((candidate) => candidate.lease_id === lease.lease_id ? nextLease : candidate));
    const workers = loadWorkersUnsafe();
    const updatedWorkers = workers.map((worker) => worker.worker_id === lease.worker_id
      ? { ...worker, last_seen_at: timestamp, status: "idle" as const }
      : worker);
    saveWorkersUnsafe(updatedWorkers);
    appendCheckpointUnsafe({
      assignment_id: assignmentId,
      lease_id: lease.lease_id,
      worker_id: lease.worker_id,
      stage: "released",
      recorded_at: timestamp,
      detail: outcome,
    });
    return true;
  });
}

function safeCleanupWorktree(worktreePath: string | undefined): "cleaned" | "absent" | "rejected" | "failed" {
  if (!worktreePath) return "absent";
  const roots = factoryWorktreeReadRoots();
  const candidate = resolve(worktreePath);
  const root = roots.find(value => candidate.startsWith(`${value}/`));
  if (!root) return "rejected";
  if (loadFactoryPathProfile() && root !== factoryWorktreesRoot()) return "rejected";
  const child = relative(root, candidate);
  if (!child || child.startsWith("..")) {
    return "rejected";
  }
  if (!basename(candidate).startsWith("cascade-")) {
    return "rejected";
  }
  if (!existsSync(candidate)) return "absent";
  try {
    rmSync(candidate, { recursive: true, force: true });
    return "cleaned";
  } catch {
    return "failed";
  }
}

export function reconcileSupervisor(input: {
  assignments: SupervisorAssignmentLike[];
  now?: Date;
}): SupervisorReconcileResult {
  return withSupervisorLock(() => {
    const timestamp = input.now ?? new Date();
    const timestampIso = timestamp.toISOString();
    const nowMs = timestamp.getTime();
    const workers = loadWorkersUnsafe();
    const leases = loadLeasesUnsafe();
    let renewed = 0;
    let released = 0;
    let expired = 0;
    let deadLetters = 0;
    const nextLeases = leases.map((lease) => {
      if (lease.status !== "active") return lease;
      const assignment = input.assignments.find((candidate) => candidate.assignment_id === lease.assignment_id);
      const resultDurable = assignment?.result_path ? existsSync(assignment.result_path) : false;
      if (resultDurable || assignment?.outcome !== null && assignment?.outcome !== undefined) {
        const outcome = assignment?.outcome ?? "result-durable";
        appendCheckpointUnsafe({
          assignment_id: lease.assignment_id,
          lease_id: lease.lease_id,
          worker_id: lease.worker_id,
          stage: resultDurable ? "result-durable" : "terminal",
          recorded_at: timestampIso,
        });
        appendCheckpointUnsafe({
          assignment_id: lease.assignment_id,
          lease_id: lease.lease_id,
          worker_id: lease.worker_id,
          stage: "released",
          recorded_at: timestampIso,
          detail: outcome,
        });
        released++;
        return { ...lease, status: "released" as const, released_at: timestampIso, outcome };
      }
      const heartbeatMs = assignment?.heartbeat_path && existsSync(assignment.heartbeat_path)
        ? statSync(assignment.heartbeat_path).mtimeMs
        : 0;
      const renewedMs = new Date(lease.renewed_at).getTime();
      if (heartbeatMs > renewedMs && heartbeatMs < nowMs + 60_000) {
        renewed++;
        appendCheckpointUnsafe({
          assignment_id: lease.assignment_id,
          lease_id: lease.lease_id,
          worker_id: lease.worker_id,
          stage: "heartbeat",
          recorded_at: new Date(heartbeatMs).toISOString(),
        });
        const ttlMs = Math.max(60_000, new Date(lease.expires_at).getTime() - renewedMs);
        return { ...lease, renewed_at: new Date(heartbeatMs).toISOString(), expires_at: new Date(heartbeatMs + ttlMs).toISOString() };
      }
      if (nowMs < new Date(lease.expires_at).getTime()) return lease;
      const cleanup = safeCleanupWorktree(lease.worktree_path ?? assignment?.worktree_path);
      appendDeadLetterUnsafe({
        lease_id: lease.lease_id,
        assignment_id: lease.assignment_id,
        worker_id: lease.worker_id,
        campaign_id: lease.campaign_id,
        task_id: lease.task_id,
        detected_at: timestampIso,
        reason: "lease-expired",
        worktree_path: lease.worktree_path ?? assignment?.worktree_path ?? null,
        cleanup,
      });
      appendCheckpointUnsafe({
        assignment_id: lease.assignment_id,
        lease_id: lease.lease_id,
        worker_id: lease.worker_id,
        stage: "terminal",
        recorded_at: timestampIso,
        detail: `lease expired; orphan cleanup=${cleanup}`,
      });
      expired++;
      deadLetters++;
      return { ...lease, status: "expired" as const, released_at: timestampIso, outcome: "stale" };
    });
    if (leases.length > 0) saveLeasesUnsafe(nextLeases);
    const activeWorkerIds = new Set(nextLeases.filter((lease) => lease.status === "active").map((lease) => lease.worker_id));
    if (workers.length > 0) {
      saveWorkersUnsafe(workers.map((worker) => ({
        ...worker,
        status: activeWorkerIds.has(worker.worker_id) ? "leased" : (new Date(worker.last_seen_at).getTime() < nowMs - 2 * 60 * 60_000 ? "stale" : "idle"),
        last_seen_at: activeWorkerIds.has(worker.worker_id) ? timestampIso : worker.last_seen_at,
      })));
    }
    return { renewed, released, expired, dead_letters: deadLetters };
  });
}

export function supervisorSnapshot(): SupervisorSnapshot {
  const workers = loadWorkersUnsafe();
  const leases = loadLeasesUnsafe();
  return {
    workers,
    active_leases: leases.filter((lease) => lease.status === "active"),
    expired_leases: leases.filter((lease) => lease.status === "expired").length,
    checkpoints: loadCheckpointsUnsafe().length,
    dead_letters: loadDeadLettersUnsafe(),
  };
}

function usage(): never {
  console.error("Usage: worker-supervisor.ts status [--json] | reconcile");
  process.exit(2);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "status") {
    const snapshot = supervisorSnapshot();
    if (args.includes("--json")) console.log(JSON.stringify(snapshot, null, 2));
    else console.log(`workers=${snapshot.workers.length} active_leases=${snapshot.active_leases.length} expired=${snapshot.expired_leases} checkpoints=${snapshot.checkpoints} dead_letters=${snapshot.dead_letters.length}`);
  } else if (command === "reconcile") {
    console.error("reconcile requires the pool manager to supply assignment state");
    process.exit(2);
  } else {
    usage();
  }
}
