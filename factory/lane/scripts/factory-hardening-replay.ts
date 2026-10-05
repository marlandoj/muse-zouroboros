#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSeedFile } from "./dedup-gate";
import {
  activeFailurePark,
  deliverFailureNotification,
  recordFailureCycle,
} from "./failure-fingerprint";
import { reapDir } from "./reap-stale-execs";
import { recoverExecutionArtifacts } from "./recovery-artifacts";
import {
  appendEmittedFingerprint,
  planDraftPr,
  readEmittedFingerprints,
  selectNewShipReadyEvents,
} from "./ship-ready-core";
import { selectShipReady } from "./ship-ready-scan";

export const CORPUS_PATH = "/home/workspace/Projects/zouroboros-factory-hardening/incidents/ori-incidents.v1.yaml";
export const CORPUS_SHA256 = "6b23631b1beb48b5b340c93dc65d166c86feb537e2a4d84ccc6a8e448ba58900";
const HARDENING_ROOT = "/home/workspace/Projects/zouroboros-factory-hardening";

export type ReplayStatus = "pass" | "fail" | "deferred";

export interface ReplayCaseResult {
  case_id: string;
  status: ReplayStatus;
  expected_outcomes: string[];
  forbidden_outcomes: string[];
  evidence: Record<string, unknown>;
  reason: string;
}

export interface ReplayReport {
  corpus_sha256: string;
  corpus_valid: boolean;
  scope: "wave1" | "full";
  cases: ReplayCaseResult[];
  passed: number;
  failed: number;
  deferred: number;
  verdict: "PASS" | "FAIL" | "DEFERRED";
  full_replay_prerequisites: Record<string, boolean>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadCorpus(): any {
  const parsed = Bun.YAML.parse(readFileSync(CORPUS_PATH, "utf8")) as any;
  const ids = parsed?.cases?.map((entry: any) => entry.case_id) ?? [];
  if (parsed?.status !== "frozen" || ids.join(",") !== "ORI-INC-001,ORI-INC-002,ORI-INC-003,ORI-INC-004,ORI-INC-005") {
    throw new Error("unexpected Ori incident corpus structure");
  }
  return parsed;
}

function git(repo: string, args: string[]): string {
  const run = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Factory Replay",
      GIT_AUTHOR_EMAIL: "factory-replay@example.invalid",
      GIT_COMMITTER_NAME: "Factory Replay",
      GIT_COMMITTER_EMAIL: "factory-replay@example.invalid",
    },
  });
  if (run.status !== 0) throw new Error(run.stderr || `git ${args.join(" ")} failed`);
  return run.stdout;
}

function staleExecution(root: string, identifier: string, executionId: string): { state: string; path: string } {
  const state = factoryStatePathForProject(root);
  mkdirSync(state, { recursive: true });
  const path = join(state, `exec-${executionId}.json`);
  writeFileSync(path, JSON.stringify({
    execution_id: executionId,
    identifier,
    state: "executing",
    delivery_target: "accepted",
    target_reached: false,
    state_updated_at: "2026-07-13T03:00:00.000Z",
    evidence: {},
    post_merge_survivability: "not_applicable",
    post_merge_survivability_reason: "not merged",
    post_merge_survivability_checks: [],
    status: "executing",
    stage: "executing",
    started_at: "2026-07-13T03:00:00.000Z",
    completed_at: null,
  }));
  return { state, path };
}

function replayStale(root: string, caseId: "ORI-INC-001" | "ORI-INC-002", identifier: string): ReplayCaseResult {
  const fixture = staleExecution(root, identifier, caseId.toLowerCase());
  const reaped = reapDir(fixture.state, {
    staleMinutes: 20,
    dryRun: false,
    recoveryRoot: join(root, "recovery"),
    repositoryRoots: [],
    temporaryRoots: [],
    nowMs: Date.parse("2026-07-13T03:40:00.000Z"),
    processAlive: () => false,
  });
  const record = JSON.parse(readFileSync(fixture.path, "utf8"));
  const pass = reaped.reaped.length === 1 && record.state === "failed" && record.retry_eligible === true && existsSync(record.recovery_manifest);
  return {
    case_id: caseId,
    status: pass ? "pass" : "fail",
    expected_outcomes: ["orphan reaped", "retry eligible", "one replacement dispatch authorized"],
    forbidden_outcomes: pass ? [] : ["silent non-terminal execution"],
    evidence: { cycles: 1, minutes: 40, reaped: reaped.reaped.length, retry_eligible: record.retry_eligible, recovery_manifest: record.recovery_manifest },
    reason: pass ? "reaper closed the orphan within one simulated cycle" : "reaper contract failed",
  };
}

function replayDirtyWorktree(root: string): ReplayCaseResult {
  const repo = join(root, "dirty-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "factory/ori-dirty"]);
  for (let index = 0; index < 20; index++) writeFileSync(join(repo, `file-${index}.ts`), `export const value${index} = 1;\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  for (let index = 0; index < 20; index++) writeFileSync(join(repo, `file-${index}.ts`), `export const value${index} = 2;\n`);

  const recovery = recoverExecutionArtifacts({
    execution_id: "ori-inc-003",
    identifier: "ZOU-568",
    branch_name: "factory/ori-dirty",
    repo_path: repo,
  }, {
    recoveryRoot: join(root, "recovery"),
    repositoryRoots: [repo],
    temporaryRoots: [],
    now: () => new Date("2026-07-13T04:00:00.000Z"),
  });
  const status = git(repo, ["status", "--porcelain"]);
  const patch = recovery.manifest.worktree?.patch_path;
  const pass = recovery.manifest.retry_decision === "manual_review"
    && recovery.manifest.worktree?.dirty === true
    && Boolean(patch && existsSync(patch))
    && status.trim().split("\n").length === 20;
  return {
    case_id: "ORI-INC-003",
    status: pass ? "pass" : "fail",
    expected_outcomes: ["dirty work preserved with digest", "automatic retry parked", "zero file loss"],
    forbidden_outcomes: pass ? [] : ["retry against unclassified dirty worktree"],
    evidence: {
      manifest: recovery.manifestPath,
      status_digest: recovery.manifest.worktree?.status_digest,
      patch_sha256: patch ? sha256(patch) : null,
      dirty_files_preserved: status.trim().split("\n").filter(Boolean).length,
      retry_decision: recovery.manifest.retry_decision,
    },
    reason: pass ? "dirty work is durably preserved and automatic retry fails safe to manual review" : "dirty-work recovery contract failed",
  };
}

function replayCorruptSeedAndPark(root: string): ReplayCaseResult {
  const fixture = staleExecution(root, "ZOU-572", "ori-inc-004");
  const seed = join(root, "seed-zou-572.yaml");
  writeFileSync(seed, "tasks: [\n");
  const record = JSON.parse(readFileSync(fixture.path, "utf8"));
  record.seed_path = seed;
  writeFileSync(fixture.path, JSON.stringify(record));
  const advisoryHash = hashSeedFile(seed);
  const reaped = reapDir(fixture.state, {
    staleMinutes: 20,
    dryRun: false,
    recoveryRoot: join(root, "recovery"),
    repositoryRoots: [],
    temporaryRoots: [],
    nowMs: Date.parse("2026-07-13T03:40:00.000Z"),
    processAlive: () => false,
  });
  const first = recordFailureCycle({
    ticket_identifier: "ZOU-572",
    failing_stage: "dispatch",
    error_class: "transport",
    error_signature: "request exec-first timed out on retry 1 at 2026-07-13T03:40:00Z",
    cycle_id: "cycle-1",
  }, { state_dir: fixture.state, now: () => "2026-07-13T03:40:00.000Z" });
  const second = recordFailureCycle({
    ticket_identifier: "ZOU-572",
    failing_stage: "dispatch",
    error_class: "transport",
    error_signature: "request exec-second timed out on retry 2 at 2026-07-13T04:00:00Z",
    cycle_id: "cycle-2",
  }, { state_dir: fixture.state, now: () => "2026-07-13T04:00:00.000Z" });
  let notifications = 0;
  const delivered = deliverFailureNotification(second, () => { notifications++; }, { state_dir: fixture.state });
  const duplicate = deliverFailureNotification(second, () => { notifications++; }, { state_dir: fixture.state });
  const park = activeFailurePark("ZOU-572", fixture.state);
  const pass = advisoryHash === null
    && reaped.reaped.length === 1
    && first.should_dispatch
    && second.should_park
    && !second.should_dispatch
    && notifications === 1
    && delivered.status === "delivered"
    && duplicate.status === "skipped"
    && park !== null;
  return {
    case_id: "ORI-INC-004",
    status: pass ? "pass" : "fail",
    expected_outcomes: ["corrupt seed quarantined", "advisory null hash", "second equivalent failure parks and notifies once"],
    forbidden_outcomes: pass ? [] : ["fatal seed retry loop", "more than two equivalent dispatches"],
    evidence: { advisory_seed_hash: advisoryHash, reaped: reaped.reaped.length, first_dispatch: first.should_dispatch, second_dispatch: second.should_dispatch, notifications, parked_at: park?.parked_at },
    reason: pass ? "corrupt artifact recovery and two-strike escalation both passed" : "corrupt-seed escalation contract failed",
  };
}

function replayShipGateObservation(root: string): ReplayCaseResult {
  const now = Date.parse("2026-07-13T05:00:00.000Z");
  const records = [{
    execution_id: "ori-ship-gate",
    identifier: "ORI-PHASE-14-SHIP-GATE",
    state: "verified",
    delivery_target: "accepted",
    target_reached: false,
    state_updated_at: "2026-07-13T04:00:00.000Z",
    evidence: {},
    post_merge_survivability: "not_applicable",
    post_merge_survivability_reason: "not merged",
    post_merge_survivability_checks: [],
    completed_at: "2026-07-13T04:00:00.000Z",
    pr_number: null,
    branch_name: "factory/ori-phase-14",
  }];
  const options = { nowMs: now, minAgeMinutes: 35, unshippedIdentifiers: new Set(["ORI-PHASE-14-SHIP-GATE"]) };
  const ledgerDir = join(root, "ship-ready-ledger");
  const firstScan = selectShipReady(records, options);
  const firstEvents = selectNewShipReadyEvents(firstScan, readEmittedFingerprints(ledgerDir));
  if (firstEvents[0]) appendEmittedFingerprint(firstEvents[0], ledgerDir);
  const secondScan = selectShipReady(records, options);
  const secondEvents = selectNewShipReadyEvents(secondScan, readEmittedFingerprints(ledgerDir));
  const draftPlan = firstEvents[0] ? planDraftPr(firstEvents[0]) : null;
  const pass = firstScan.length === 1
    && firstEvents.length === 1
    && secondScan.length === 1
    && secondEvents.length === 0
    && draftPlan?.draft === true
    && draftPlan.auto_merge === false
    && records[0]?.state === "verified"
    && records[0]?.target_reached === false
    && records[0]?.pr_number === null;
  return {
    case_id: "ORI-INC-005",
    status: pass ? "pass" : "fail",
    expected_outcomes: ["one actionable ship-ready event", "durable notification deduplication", "truthful verified state"],
    forbidden_outcomes: pass ? [] : ["duplicate ship-ready event", "auto-merge", "false accepted state"],
    evidence: {
      first_scan_items: firstScan.length,
      first_emitted_events: firstEvents.length,
      second_scan_items: secondScan.length,
      second_emitted_events: secondEvents.length,
      event_fingerprint: firstEvents[0]?.fingerprint ?? null,
      draft: draftPlan?.draft ?? null,
      auto_merge: draftPlan?.auto_merge ?? null,
      target_reached: records[0]?.target_reached,
      pr_number: records[0]?.pr_number,
    },
    reason: pass
      ? "one durable ship-ready event emitted; replay deduplicated; draft plan preserved the human merge gate"
      : "ship-ready deduplication or human-gated draft contract failed",
  };
}

export function fullReplayPrerequisites(): Record<string, boolean> {
  return Object.fromEntries([1, 2, 3, 4, 5, 6].map((number) => {
    const prefix = `fh${String(number).padStart(2, "0")}-`;
    const evaluations = join(HARDENING_ROOT, "evaluations");
    const names = existsSync(evaluations) ? Array.from(new Bun.Glob(`${prefix}*.md`).scanSync(evaluations)) : [];
    return [`FH-${String(number).padStart(2, "0")}`, names.some((name) => name.includes("postflight")) && names.some((name) => name.includes("gap-audit"))];
  }));
}

export function runReplay(scope: "wave1" | "full" = "wave1"): ReplayReport {
  loadCorpus();
  const corpusDigest = sha256(CORPUS_PATH);
  const root = mkdtempSync(join(tmpdir(), "factory-hardening-replay-"));
  try {
    const cases = [
      replayStale(join(root, "case-1"), "ORI-INC-001", "ZOU-462"),
      replayStale(join(root, "case-2"), "ORI-INC-002", "ZOU-566"),
      replayDirtyWorktree(join(root, "case-3")),
      replayCorruptSeedAndPark(join(root, "case-4")),
      replayShipGateObservation(join(root, "case-5")),
    ];
    const prerequisites = fullReplayPrerequisites();
    if (scope === "wave1") {
      cases[4] = { ...cases[4], status: "deferred", reason: "ORI-INC-005 is outside the Wave 1 replay scope" };
    } else if (!Object.values(prerequisites).every(Boolean)) {
      cases[4] = { ...cases[4], status: "deferred", reason: "full replay is blocked until FH-01 through FH-06 post-flight and gap-audit evidence exists" };
    }
    const passed = cases.filter((entry) => entry.status === "pass").length;
    const failed = cases.filter((entry) => entry.status === "fail").length;
    const deferred = cases.filter((entry) => entry.status === "deferred").length;
    return {
      corpus_sha256: corpusDigest,
      corpus_valid: corpusDigest === CORPUS_SHA256,
      scope,
      cases,
      passed,
      failed,
      deferred,
      verdict: failed > 0 ? "FAIL" : deferred > 0 ? "DEFERRED" : "PASS",
      full_replay_prerequisites: prerequisites,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const scope = process.argv.includes("--full") ? "full" : "wave1";
  const report = runReplay(scope);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "FAIL" || (scope === "full" && report.verdict !== "PASS") ? 1 : 0);
}
