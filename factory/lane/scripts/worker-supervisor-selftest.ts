#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLease, loadCheckpoints, loadDeadLetters, loadLeases, loadWorkers, reconcileSupervisor, supervisorSnapshot } from "./worker-supervisor";
import { enqueueDirect } from "./pool-queue";
import { loadAssignments, mockComplete } from "./pool-worker";
import { reconcile } from "./pool-manager";

let passed = 0;
let failed = 0;
const root = `/tmp/worker-supervisor-selftest-${process.pid}`;
const state = join(root, "state");
const worktrees = join(root, "worktrees");

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function reset(): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(worktrees, { recursive: true });
  process.env.SF003_POOL_STATE_DIR = state;
  process.env.FACTORY_CODING_CASCADE_WORKTREES_ROOT = worktrees;
  delete process.env.SF003_WORKER_ID;
}

async function run(): Promise<void> {
  reset();
  enqueueDirect({
    campaign_id: "sup-life",
    ticket_id: "SUP-1",
    identifier: "SUP-1",
    name: "supervised task",
    description: "durable lease lifecycle",
  });
  await reconcile({ mode: "act", mock: true, max_dispatch: 1 });
  const assignment = loadAssignments().find((candidate) => candidate.campaign_id === "sup-life")!;
  check("dispatch stamps a durable worker identity", Boolean(assignment.worker_id && assignment.lease_id));
  check("worker and lease survive a fresh snapshot", supervisorSnapshot().workers.length === 1 && supervisorSnapshot().active_leases.length === 1);
  const sameLease = acquireLease({
    assignment_id: assignment.assignment_id,
    campaign_id: assignment.campaign_id,
    task_id: assignment.task_id,
    timeout_min: assignment.timeout_min,
  });
  check("restart-style re-acquire is idempotent", sameLease.idempotent && sameLease.lease.lease_id === assignment.lease_id);
  let duplicateBlocked = false;
  try {
    acquireLease({ assignment_id: "duplicate-assignment", campaign_id: assignment.campaign_id, task_id: assignment.task_id, timeout_min: 30 });
  } catch (error) {
    duplicateBlocked = String(error).includes("duplicate claim blocked");
  }
  check("duplicate claim is rejected", duplicateBlocked);
  mockComplete(assignment, "success", "durable result");
  await reconcile({ mode: "act", mock: true, max_dispatch: 1 });
  check("result durability releases the lease", loadLeases().find((lease) => lease.lease_id === assignment.lease_id)?.status === "released");
  check("result and release checkpoints are present", loadCheckpoints().some((checkpoint) => checkpoint.stage === "result-durable") && loadCheckpoints().some((checkpoint) => checkpoint.stage === "released"));

  reset();
  const orphan = join(worktrees, "cascade-restart-orphan");
  mkdirSync(orphan, { recursive: true });
  const acquiredAt = new Date("2026-08-07T00:00:00.000Z");
  const stale = acquireLease({
    assignment_id: "stale-assignment",
    campaign_id: "stale-campaign",
    task_id: "T1",
    timeout_min: 1,
    worktree_path: orphan,
    now: acquiredAt,
    lease_ttl_ms: 1_000,
  });
  const recovery = reconcileSupervisor({
    assignments: [{ assignment_id: "stale-assignment", campaign_id: "stale-campaign", task_id: "T1", outcome: null }],
    now: new Date("2026-08-07T00:00:05.000Z"),
  });
  check("expired lease is reaped after restart", recovery.expired === 1 && loadLeases().find((lease) => lease.lease_id === stale.lease.lease_id)?.status === "expired");
  check("stale lease creates a dead letter", loadDeadLetters().some((letter) => letter.assignment_id === "stale-assignment" && letter.cleanup === "cleaned"));
  check("orphan worktree is cleaned only inside the managed root", !existsSync(orphan));
  check("expired worker returns to an observable idle state", loadWorkers().every((worker) => worker.status !== "leased"));

  const checkpointPath = join(state, "supervisor", "checkpoints.jsonl");
  writeFileSync(checkpointPath, readFileSync(checkpointPath, "utf8") + "{torn");
  check("torn checkpoint evidence does not hide prior rows", loadCheckpoints().length >= 2);
}

try {
  await run();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nWorker supervisor self-test: ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
