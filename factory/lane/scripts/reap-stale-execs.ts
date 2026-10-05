#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * reap-stale-execs.ts — Self-healing reaper for orphaned exec-*.json records.
 *
 * Root cause it addresses: executeSwarm (swarm-exec.ts) writes an
 * { status:"executing", completed_at:null } checkpoint BEFORE the long /zo/ask
 * call. If the process dies mid-call (30-min Zo session cap, turn end, crash),
 * the record is never closed to a terminal state. The conveyor's in-flight cap
 * then counts that ghost as "executing" forever, halting dispatch.
 * (ZOU-462 stalled this way 2026-07-05.)
 *
 * Reaps a record only when ALL hold:
 *   - status is reapable (executing | pending-implementation)
 *   - completed_at === null           (every terminal writer stamps completed_at)
 *   - age since started_at > stale-minutes
 *   - no live local process references its execution_id or branch_name
 * → sets status/stage = "failed", completed_at = now, error = "[reaper] …".
 * Terminal executions also trigger targeted isolated-worktree cleanup. Dirty
 * worktrees require a recovery manifest before removal; cleanup failure leaves
 * stale execution records in-flight so the conveyor fails closed. Held records
 * remain resumable and are never treated as terminal cleanup candidates.
 *
 * Why "failed" (not a novel "halted"): the conveyor's per-ticket gate treats
 * only {complete, failed, dry-run} as terminal. A record left in any other
 * status is read as "still in-flight" and the ticket is skipped forever. So the
 * reaper marks orphans with the pipeline's own death status — swarm-exec writes
 * exactly this ({status:"failed", stage:"failed", completed_at}) in its catch.
 *
 * Idempotent: "failed" is terminal (not reapable), so re-runs are no-ops.
 * Machine output: SINGLE-LINE JSON on stdout. All human logs go to stderr, so
 * the conveyor's `… 2>/dev/null | tail -1` pipe reads clean JSON.
 *
 * Usage:
 *   bun reap-stale-execs.ts                 # reap; default stale = 20 min
 *   bun reap-stale-execs.ts --dry-run       # report only, mutate nothing
 *   bun reap-stale-execs.ts --stale-minutes 30
 *   bun reap-stale-execs.ts --selftest      # self-contained tmpdir checks
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { recoverExecutionArtifacts, type RecoveryManifest } from "./recovery-artifacts";
import {
  isExecutionRecordFileName,
  isTerminalExecution,
  normalizeExecutionLifecycle,
  transitionExecutionLifecycle,
} from "./execution-lifecycle";
import {
  activeWorktreeForExecution,
  reclaimIsolatedWorktree,
  type IsolatedWorktreeOptions,
  type WorktreeExecutionIdentity,
} from "./execution-repository";
import { reconcileExpiredTicketClaims } from "./ticket-claim";
import type { FactoryStateMutationEvidenceMode } from "./factory-state-mutation-evidence";
import { analyzeDredge, writeDredgeReport } from "./dredge";

const STATE_DIR = factoryStateRoot();
const DEFAULT_STALE_MINUTES = Number(process.env.STALE_EXEC_MINUTES ?? 20);

function now(): string {
  return new Date().toISOString();
}

function log(msg: string): void {
  process.stderr.write(`[reaper] ${msg}\n`);
}

interface ExecLike {
  execution_id?: string;
  pid?: number;
  ticket_id?: string;
  identifier?: string;
  repo_path?: string;
  status?: string;
  stage?: string;
  branch_name?: string | null;
  started_at?: string;
  completed_at?: string | null;
  error?: string | null;
  retry_eligible?: boolean;
  recovery_manifest?: string;
  recovery_retry_decision?: RecoveryManifest["retry_decision"];
  executor_timeout_ms?: number;
  [k: string]: unknown;
}

export interface ReapDecision {
  file: string;
  execution_id: string;
  identifier: string;
  status: string;
  reap: boolean;
  reason: string;
  age_minutes: number | null;
  recovery_manifest?: string;
  retry_decision?: RecoveryManifest["retry_decision"];
  worktree_path?: string;
  autopsy_path?: string;
}

/** Pure decision: given a record + context, should it be reaped? */
export function decideReap(
  exec: ExecLike,
  opts: { nowMs: number; staleMinutes: number; processAlive: (e: ExecLike) => boolean },
): { reap: boolean; reason: string; ageMinutes: number | null } {
  const lifecycle = normalizeExecutionLifecycle(exec);
  const status = lifecycle.state;
  if (status !== "executing" && status !== "pool_enqueued") {
    return { reap: false, reason: `not reapable state=${status}`, ageMinutes: null };
  }
  if (exec.completed_at) return { reap: false, reason: "has completed_at (closed)", ageMinutes: null };
  if (!exec.started_at) return { reap: false, reason: "no started_at — cannot age", ageMinutes: null };

  const startedMs = Date.parse(exec.started_at);
  if (Number.isNaN(startedMs)) return { reap: false, reason: "unparseable started_at", ageMinutes: null };
  const ageMinutes = (opts.nowMs - startedMs) / 60000;
  const declaredTimeoutMinutes =
    typeof exec.executor_timeout_ms === "number" && Number.isFinite(exec.executor_timeout_ms) && exec.executor_timeout_ms > 0
      ? exec.executor_timeout_ms / 60000
      : 0;
  const effectiveStaleMinutes = Math.max(opts.staleMinutes, declaredTimeoutMinutes + (declaredTimeoutMinutes > 0 ? 5 : 0));

  if (ageMinutes <= effectiveStaleMinutes)
    return { reap: false, reason: `fresh (${ageMinutes.toFixed(1)}m ≤ ${effectiveStaleMinutes.toFixed(1)}m)`, ageMinutes };
  if (opts.processAlive(exec))
    return { reap: false, reason: "live process referencing it", ageMinutes };

  return { reap: true, reason: `stale ${ageMinutes.toFixed(1)}m > ${effectiveStaleMinutes.toFixed(1)}m, no live process`, ageMinutes };
}

function liveProcessChecker(): (e: ExecLike) => boolean {
  let psOut = "";
  try {
    psOut = execSync("ps aux", { encoding: "utf8" });
  } catch {
    psOut = ""; // no ps ⇒ treat as none alive; age guard still protects fresh records
  }
  // Drop the reaper's own process line so its script name / args never
  // false-match an execution_id or branch (self-match guard).
  const lines = psOut.split("\n").filter((l) => !l.includes("reap-stale-execs"));
  return (e: ExecLike) => {
    if (typeof e.pid === "number" && Number.isInteger(e.pid) && e.pid > 0) {
      try {
        process.kill(e.pid, 0);
        return true;
      } catch {
        // Fall through to execution and branch identity matching.
      }
    }
    const id = e.execution_id;
    const br = e.branch_name;
    return lines.some((l) => (id && l.includes(id)) || (br && l.includes(br)));
  };
}

export interface ReapDirOptions {
  staleMinutes: number;
  dryRun: boolean;
  recoveryRoot?: string;
  repositoryRoots?: string[];
  temporaryRoots?: string[];
  nowMs?: number;
  processAlive?: (e: ExecLike) => boolean;
  worktreeOptions?: IsolatedWorktreeOptions;
  claimMutationEvidenceMode?: FactoryStateMutationEvidenceMode;
}

export interface ReapDirResult {
  scanned: number;
  reaped: ReapDecision[];
  skipped: number;
  recovery_failed: number;
  cleanup_failed: number;
  worktrees_reclaimed: string[];
  worktrees_planned: string[];
  claims_reclaimed: string[];
  claims_planned: string[];
  claim_reconcile_failed: number;
  claim_evidence_receipts: string[];
  claim_recovered: string[];
  claim_would_reject: Array<{ ticket_id: string; reason: string }>;
  autopsies_written: string[];
  autopsies_planned: string[];
  autopsy_failed: number;
}

function executionWorktreeIdentity(exec: ExecLike): WorktreeExecutionIdentity | null {
  const ticketIds = [exec.ticket_id, exec.identifier]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  if (ticketIds.length === 0) return null;
  return {
    ticketIds,
    ...(typeof exec.repo_path === "string" && exec.repo_path.trim()
      ? { worktreePath: exec.repo_path.trim() }
      : {}),
  };
}

export function reapDir(
  dir: string,
  opts: ReapDirOptions,
): ReapDirResult {
  const decisions: ReapDecision[] = [];
  const worktreesReclaimed: string[] = [];
  const worktreesPlanned: string[] = [];
  const autopsiesWritten: string[] = [];
  const autopsiesPlanned: string[] = [];
  let scanned = 0;
  let skipped = 0;
  let recoveryFailed = 0;
  let cleanupFailed = 0;
  let autopsyFailed = 0;
  const alive = opts.processAlive ?? liveProcessChecker();
  const nowMs = opts.nowMs ?? Date.now();
  const recoveryRoot = opts.recoveryRoot ?? join(dir, "recovery");

  const files = existsSync(dir) ? readdirSync(dir).filter(isExecutionRecordFileName) : [];
  for (const file of files) {
    const path = join(dir, file);
    let exec: ExecLike;
    try {
      exec = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      skipped++;
      continue;
    }
    scanned++;
    const lifecycle = normalizeExecutionLifecycle(exec);
    const d = decideReap(exec, { nowMs, staleMinutes: opts.staleMinutes, processAlive: alive });
    const terminal = lifecycle.state !== "held" && isTerminalExecution(lifecycle);
    const worktreeIdentity = executionWorktreeIdentity(exec);
    let activeWorktree = null;
    if (worktreeIdentity) {
      try {
        activeWorktree = activeWorktreeForExecution(worktreeIdentity, opts.worktreeOptions);
      } catch (error) {
        cleanupFailed++;
        skipped++;
        log(`${exec.identifier ?? "?"} ${exec.execution_id ?? "?"}: cleanup failed closed — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    if (!d.reap && (!terminal || !activeWorktree)) {
      skipped++;
      continue;
    }
    if (opts.dryRun && activeWorktree) {
      worktreesPlanned.push(activeWorktree.worktreePath);
    }
    const decision: ReapDecision = {
      file,
      execution_id: exec.execution_id ?? "?",
      identifier: exec.identifier ?? "?",
      status: exec.status ?? "?",
      reap: true,
      reason: d.reason,
      age_minutes: d.ageMinutes,
      ...(activeWorktree ? { worktree_path: activeWorktree.worktreePath } : {}),
    };
    if (d.reap) {
      decision.autopsy_path = path.replace(/\.json$/, ".autopsy.json");
      if (opts.dryRun) autopsiesPlanned.push(decision.autopsy_path);
    }
    let recovery: ReturnType<typeof recoverExecutionArtifacts> | null = null;
    if (d.reap) {
      try {
        recovery = recoverExecutionArtifacts(exec, {
          recoveryRoot,
          repositoryRoots: opts.repositoryRoots ?? [process.env.SF_MULTI_HARNESS_WORKDIR || join(import.meta.dir, "..", "..", "..")],
          temporaryRoots: opts.temporaryRoots ?? [join(dir, "tmp"), tmpdir()],
          now: () => new Date(nowMs),
          dryRun: opts.dryRun,
        });
        decision.recovery_manifest = recovery.manifestPath;
        decision.retry_decision = recovery.manifest.retry_decision;
      } catch (error) {
        recoveryFailed++;
        skipped++;
        log(`${decision.identifier} ${decision.execution_id}: recovery failed closed — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    if (activeWorktree && !opts.dryRun && worktreeIdentity) {
      try {
        let reclaimed;
        try {
          reclaimed = reclaimIsolatedWorktree(worktreeIdentity, opts.worktreeOptions);
        } catch (error) {
          const dirty = error instanceof Error && error.message.includes("dirty isolated worktree");
          if (!dirty) throw error;
          if (!recovery) {
            recovery = recoverExecutionArtifacts(exec, {
              recoveryRoot,
              repositoryRoots: opts.repositoryRoots ?? [process.env.SF_MULTI_HARNESS_WORKDIR || join(import.meta.dir, "..", "..", "..")],
              temporaryRoots: opts.temporaryRoots ?? [join(dir, "tmp"), tmpdir()],
              now: () => new Date(nowMs),
              dryRun: false,
            });
          }
          reclaimed = reclaimIsolatedWorktree(worktreeIdentity, {
            ...opts.worktreeOptions,
            allowDirtyWithRecoveryManifest: recovery.manifestPath,
          });
        }
        if (reclaimed.status === "reclaimed" && reclaimed.worktreePath) {
          worktreesReclaimed.push(reclaimed.worktreePath);
        }
      } catch (error) {
        cleanupFailed++;
        skipped++;
        log(`${decision.identifier} ${decision.execution_id}: cleanup failed closed — ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    if (!d.reap) {
      log(`${decision.identifier} ${decision.execution_id}: terminal worktree ${opts.dryRun ? "WOULD be reclaimed" : "reclaimed"}`);
      continue;
    }
    decisions.push(decision);
    if (!opts.dryRun) {
      const failedAt = now();
      const lifecycle = transitionExecutionLifecycle(
        normalizeExecutionLifecycle(exec),
        "failed",
        { kind: "reaper", reference: recovery!.manifestPath, recorded_at: failedAt },
        { now: failedAt },
      );
      Object.assign(exec, lifecycle);
      exec.status = "failed";
      exec.stage = "failed";
      exec.completed_at = failedAt;
      exec.error = `[reaper] failed orphaned '${decision.status}' record (reaped: ${d.reason}); prior error=${exec.error ?? "none"}`;
      exec.retry_eligible = recovery!.manifest.retry_decision === "retry";
      exec.recovery_manifest = recovery!.manifestPath;
      exec.recovery_retry_decision = recovery!.manifest.retry_decision;
      const executionRecordText = JSON.stringify(exec, null, 2);
      writeFileSync(path, executionRecordText);
      try {
        const report = analyzeDredge({
          executionRecordText,
          executionRecordPath: path,
        }, { now: () => new Date(nowMs) });
        writeDredgeReport(report, decision.autopsy_path!, { overwrite: true });
        autopsiesWritten.push(decision.autopsy_path!);
      } catch (error) {
        autopsyFailed++;
        log(`${decision.identifier} ${decision.execution_id}: autopsy failed — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    log(`${decision.identifier} ${decision.execution_id}: ${opts.dryRun ? "WOULD reap" : "reaped"} — ${d.reason}`);
  }
  const claims = reconcileExpiredTicketClaims({
    stateDir: dir,
    nowMs,
    dryRun: opts.dryRun,
    executionAlive: (claim) => alive({ execution_id: claim.execution_id, pid: claim.pid }),
    mutationEvidenceMode: opts.claimMutationEvidenceMode,
  });
  return {
    scanned,
    reaped: decisions,
    skipped,
    recovery_failed: recoveryFailed,
    cleanup_failed: cleanupFailed,
    worktrees_reclaimed: worktreesReclaimed,
    worktrees_planned: worktreesPlanned,
    claims_reclaimed: claims.reclaimed,
    claims_planned: claims.planned,
    claim_reconcile_failed: claims.failed,
    claim_evidence_receipts: claims.evidence_receipts,
    claim_recovered: claims.recovered,
    claim_would_reject: claims.would_reject,
    autopsies_written: autopsiesWritten,
    autopsies_planned: autopsiesPlanned,
    autopsy_failed: autopsyFailed,
  };
}

function selftest(): number {
  const tmp = mkdtempSync(join(tmpdir(), "factory-reaper-selftest-"));
  mkdirSync(tmp, { recursive: true });
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean) => {
    if (cond) {
      pass++;
      log(`PASS ${name}`);
    } else {
      fail++;
      log(`FAIL ${name}`);
    }
  };
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();

  const write = (id: string, rec: ExecLike) => writeFileSync(join(tmp, `exec-${id}.json`), JSON.stringify(rec, null, 2));

  write("aaaa1111", { execution_id: "aaaa1111", identifier: "T-1", status: "executing", completed_at: null, started_at: iso(120), branch_name: "factory/none-xyz" });
  write("bbbb2222", { execution_id: "bbbb2222", identifier: "T-2", status: "executing", completed_at: null, started_at: iso(5) });
  write("cccc3333", { execution_id: "cccc3333", identifier: "T-3", status: "complete", completed_at: iso(120), started_at: iso(130) });
  write("dddd4444", { execution_id: "dddd4444", identifier: "T-4", status: "pending-implementation", completed_at: null, started_at: iso(200) });
  write("eeee5555", { execution_id: "eeee5555", identifier: "T-5", status: "executing", completed_at: iso(1), started_at: iso(200) });

  const r = reapDir(tmp, {
    staleMinutes: 20,
    dryRun: false,
    recoveryRoot: join(tmp, "recovery"),
    repositoryRoots: [],
    temporaryRoots: [join(tmp, "tmp")],
    processAlive: () => false,
  });
  const reapedIds = new Set(r.reaped.map((d) => d.execution_id));
  check("stale executing reaped", reapedIds.has("aaaa1111"));
  check("stale pending-implementation reaped", reapedIds.has("dddd4444"));
  check("fresh executing NOT reaped", !reapedIds.has("bbbb2222"));
  check("terminal complete NOT reaped", !reapedIds.has("cccc3333"));
  check("executing-with-completed_at NOT reaped (closed)", !reapedIds.has("eeee5555"));

  const reaped = JSON.parse(readFileSync(join(tmp, "exec-aaaa1111.json"), "utf8"));
  check("reaped record status=failed (pipeline-terminal)", reaped.status === "failed");
  check("reaped record stage=failed", reaped.stage === "failed");
  check("reaped record has completed_at", Boolean(reaped.completed_at));
  check("reaped record is retry eligible", reaped.retry_eligible === true);
  check("reaped record has durable recovery manifest", existsSync(reaped.recovery_manifest));
  const autopsy = JSON.parse(readFileSync(join(tmp, "exec-aaaa1111.autopsy.json"), "utf8"));
  check("reaped record has structured Dredge autopsy", autopsy.execution_id === "aaaa1111" && autopsy.status === "classified");
  check("reaper failure classifies as stall", autopsy.classification?.category === "stall");
  check("reaper reports the autopsy path", r.autopsies_written.includes(join(tmp, "exec-aaaa1111.autopsy.json")));

  // idempotency: second pass reaps nothing
  const r2 = reapDir(tmp, {
    staleMinutes: 20,
    dryRun: false,
    recoveryRoot: join(tmp, "recovery"),
    repositoryRoots: [],
    temporaryRoots: [join(tmp, "tmp")],
    processAlive: () => false,
  });
  check("idempotent — second pass reaps 0", r2.reaped.length === 0);

  rmSync(tmp, { recursive: true, force: true });
  log(`selftest: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      "stale-minutes": { type: "string" },
      selftest: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.selftest) {
    process.exit(selftest());
  }

  const staleMinutes = values["stale-minutes"] ? Number(values["stale-minutes"]) : DEFAULT_STALE_MINUTES;
  const dryRun = Boolean(values["dry-run"]);
  const r = reapDir(STATE_DIR, { staleMinutes, dryRun });

  const summary = {
    ok: true,
    dry_run: dryRun,
    stale_minutes: staleMinutes,
    scanned: r.scanned,
    reaped: r.reaped.length,
    skipped: r.skipped,
    recovery_failed: r.recovery_failed,
    cleanup_failed: r.cleanup_failed,
    worktrees_reclaimed: r.worktrees_reclaimed,
    worktrees_planned: r.worktrees_planned,
    claims_reclaimed: r.claims_reclaimed,
    claims_planned: r.claims_planned,
    claim_reconcile_failed: r.claim_reconcile_failed,
    claim_evidence_receipts: r.claim_evidence_receipts,
    claim_recovered: r.claim_recovered,
    claim_would_reject: r.claim_would_reject,
    autopsies_written: r.autopsies_written,
    autopsies_planned: r.autopsies_planned,
    autopsy_failed: r.autopsy_failed,
    reaped_ids: r.reaped.map((d) => ({ identifier: d.identifier, execution_id: d.execution_id, reason: d.reason })),
  };
  log(`scanned=${r.scanned} reaped=${r.reaped.length} skipped=${r.skipped} (stale>${staleMinutes}m, dry_run=${dryRun})`);
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (import.meta.main) main();
