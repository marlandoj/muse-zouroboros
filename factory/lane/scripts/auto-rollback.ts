#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-010 T3 — Post-Merge Canary + Auto-Rollback
 *
 * After an auto-merge lands, this module watches the SF-005 SLO state for
 * yield_floor breaches within a configurable canary window. On breach, it:
 *   1. Calls an injected GitRevertFn (real: `git revert <sha>`)
 *   2. Opens an incident via an injected IncidentFn (real: `gh issue create`)
 *   3. Patches the audit record with the rollback outcome
 *   4. Checks the circuit breaker — after K consecutive auto-rollbacks, the
 *      lane is disabled by writing an SF010_AUTOMERGE=0 sentinel file
 *
 * Circuit breaker:
 *  - Reads consecutiveRollbacks() from the audit trail
 *  - If count ≥ circuitBreakerK, writes state/sf010-circuit-open.sentinel
 *    and returns tripped=true
 *  - The lane checks this sentinel at startup and refuses to run
 *
 * Honesty:
 *  - All injectable → no real git/gh calls in tests
 *  - The canary window is elapsed-time-based via injected clock
 *  - SLO state is polled via injected SloProbe
 *  - "no breach" = not blocked by laneBlockDecision (respects SF-005 semantics)
 *
 * CLI:
 *   bun auto-rollback.ts circuit-status
 *   bun auto-rollback.ts reset-circuit --by <operator>
 *   bun auto-rollback.ts watch --pr <ref> --sha <merge-sha> [--ts <iso>] [--window <ms>] [--merge-repo <owner/repo>] [--json]
 *
 * `watch` runs the canary window against the live SF-005 SLO state with the
 * real revert (revert branch + PR via the zbr remote — main is protected) and
 * real gh incident implementations; the outcome is persisted to state/canary/.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { laneBlockDecision, readSloStateFile, type SloState } from "./factory-slo";
import { consecutiveRollbacks, patchRollback } from "./merge-audit-trail";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RollbackConfig {
  /** How long to poll for SLO breaches after auto-merge (default: 10 min). */
  canary_window_ms: number;
  /** Poll interval within the canary window (default: 30s). */
  poll_interval_ms: number;
  /** After this many consecutive rollbacks, trip the circuit breaker (default: 3). */
  circuit_breaker_k: number;
}

export const DEFAULT_ROLLBACK_CONFIG: RollbackConfig = {
  canary_window_ms: 10 * 60 * 1000,
  poll_interval_ms: 30 * 1000,
  circuit_breaker_k: 3,
};

export interface RollbackOutcome {
  action: "none" | "rollback";
  reason: string;
  slo_breach?: string;
  revert_sha?: string | null;
  incident_url?: string | null;
  circuit_tripped?: boolean;
  circuit_consecutive?: number;
  revert_error?: string;
}

/** Injectable SLO probe — reads state from a file path. */
export type SloProbe = (statePath: string) => SloState | null | "corrupt";

/** Injectable git revert function. */
export type GitRevertFn = (sha: string) => Promise<{ success: boolean; sha: string | null; error?: string }>;

/** Injectable incident creation function. */
export type IncidentFn = (title: string, body: string) => Promise<{ url: string | null; error?: string }>;

/** Injectable sleep function (for tests: instant no-op). */
export type SleepFn = (ms: number) => Promise<void>;

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function circuitSentinelPath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "sf010-circuit-open.sentinel");
}

export function sloStatePath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "slo-state.json");
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

export interface CircuitStatus {
  tripped: boolean;
  consecutive: number;
  sentinel_exists: boolean;
}

export function checkCircuit(base = PROJECT_DIR): CircuitStatus {
  const sentinel = circuitSentinelPath(base);
  const consecutive = consecutiveRollbacks(base);
  const sentinel_exists = existsSync(sentinel);
  return { tripped: sentinel_exists, consecutive, sentinel_exists };
}

export function tripCircuit(consecutive: number, reason: string, base = PROJECT_DIR): void {
  const path = circuitSentinelPath(base);
  mkdirSync(factoryStatePathForProject(base), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      tripped_at: new Date().toISOString(),
      consecutive_rollbacks: consecutive,
      reason,
      reset_instruction: "bun auto-rollback.ts reset-circuit --by <operator>",
    }, null, 2) + "\n",
  );
}

export function resetCircuit(operator: string, base = PROJECT_DIR): { reset: boolean; reason: string } {
  const path = circuitSentinelPath(base);
  if (!existsSync(path)) {
    return { reset: false, reason: "circuit is not open — no sentinel to clear" };
  }
  const { unlinkSync } = require("node:fs") as typeof import("node:fs");
  unlinkSync(path);
  return { reset: true, reason: `circuit reset by ${operator} at ${new Date().toISOString()}` };
}

// ─── Canary window watcher ────────────────────────────────────────────────────

export async function watchCanaryWindow(
  prRef: string,
  mergeSha: string,
  mergeTs: string,
  config: Partial<RollbackConfig> = {},
  deps: {
    sloProbe?: SloProbe;
    gitRevert?: GitRevertFn;
    incident?: IncidentFn;
    sleep?: SleepFn;
    base?: string;
  } = {},
): Promise<RollbackOutcome> {
  const cfg = { ...DEFAULT_ROLLBACK_CONFIG, ...config };
  const base = deps.base ?? PROJECT_DIR;
  const probe = deps.sloProbe ?? ((p) => readSloStateFile(p));
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const deadline = Date.now() + cfg.canary_window_ms;
  const statePath = sloStatePath(base);

  while (Date.now() < deadline) {
    const state = probe(statePath);
    const block = laneBlockDecision(state);

    if (block.blocked) {
      // Breach detected in canary window — initiate rollback
      const revert = deps.gitRevert ?? noopRevert;
      const incidentFn = deps.incident ?? noopIncident;

      let revertSha: string | null = null;
      let revertError: string | undefined;
      let incidentUrl: string | null = null;

      try {
        const rv = await revert(mergeSha);
        revertSha = rv.sha;
        if (!rv.success) revertError = rv.error;
      } catch (err) {
        revertError = err instanceof Error ? err.message : String(err);
      }

      try {
        const inc = await incidentFn(
          `[SF-010] Auto-rollback: PR#${prRef} breached yield_floor`,
          [
            `Auto-merge of PR#${prRef} (sha: ${mergeSha}) triggered an SLO breach within the canary window.`,
            ``,
            `**Breach reason:** ${block.reason}`,
            `**Merge time:** ${mergeTs}`,
            `**Rollback sha:** ${revertSha ?? "failed — manual revert required"}`,
            `${revertError ? `**Revert error:** ${revertError}` : ""}`,
            ``,
            `The SF-010 auto-merge lane has been notified. Check the circuit breaker status.`,
          ].join("\n"),
        );
        incidentUrl = inc.url;
      } catch { /* incident creation failure is non-blocking */ }

      // Patch audit record
      try {
        patchRollback(prRef, mergeTs, {
          triggered_at: new Date().toISOString(),
          reason: block.reason,
          slo_breach: block.reason,
          revert_sha: revertSha,
          incident_url: incidentUrl,
          ...(revertError ? { revert_error: revertError } : {}),
        }, base);
      } catch { /* patch failure is non-blocking — we already have the outcome */ }

      // Check circuit breaker
      const consecutive = consecutiveRollbacks(base);
      let circuitTripped = false;
      if (consecutive >= cfg.circuit_breaker_k) {
        tripCircuit(consecutive, `${consecutive} consecutive auto-rollbacks — lane disabled`, base);
        circuitTripped = true;
      }

      return {
        action: "rollback",
        reason: block.reason,
        slo_breach: block.reason,
        revert_sha: revertSha,
        incident_url: incidentUrl,
        circuit_tripped: circuitTripped,
        circuit_consecutive: consecutive,
        ...(revertError ? { revert_error: revertError } : {}),
      };
    }

    await sleep(cfg.poll_interval_ms);
  }

  return { action: "none", reason: `canary window (${cfg.canary_window_ms}ms) elapsed with no SLO breach` };
}

// ─── No-op defaults (safe for tests) ─────────────────────────────────────────

const noopRevert: GitRevertFn = async (_sha) => ({ success: true, sha: "noop-revert-sha" });
const noopIncident: IncidentFn = async (_title, _body) => ({ url: null });

// ─── Real revert / incident implementations (live watch mode) ────────────────

/**
 * Real revert: fetch the merge target, revert the squash sha in a throwaway
 * worktree, push a revert branch, and open a PR. main is branch-protected, so
 * the revert lands through the normal PR + CI path — the returned sha is the
 * local revert commit, and the PR URL rides in the incident body.
 */
export type GhRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultGhRunner: GhRunner = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export function realGitRevert(deps: { repoRoot: string; remote: string; mergeRepo: string; gh?: GhRunner }): GitRevertFn {
  return async (sha) => {
    const gh = deps.gh ?? defaultGhRunner;
    const g = (args: string[], cwd = deps.repoRoot) => spawnSync("git", args, { cwd, encoding: "utf8" });
    const fetched = g(["fetch", deps.remote, "main"]);
    if (fetched.status !== 0) return { success: false, sha: null, error: `fetch failed: ${(fetched.stderr || "").trim()}` };
    const wt = mkdtempSync(join(tmpdir(), "sf010-revert-"));
    try {
      const add = g(["worktree", "add", "--detach", wt, "FETCH_HEAD"]);
      if (add.status !== 0) return { success: false, sha: null, error: `worktree add failed: ${(add.stderr || "").trim()}` };
      const revert = g(["revert", "--no-edit", sha], wt);
      if (revert.status !== 0) return { success: false, sha: null, error: `git revert failed: ${(revert.stderr || "").trim()}` };
      const revertSha = g(["rev-parse", "HEAD"], wt).stdout.trim();
      const branch = `sf010/revert-${sha.slice(0, 12)}`;
      const push = g(["push", deps.remote, `HEAD:refs/heads/${branch}`], wt);
      if (push.status !== 0) return { success: false, sha: revertSha || null, error: `push failed: ${(push.stderr || "").trim()}` };
      const pr = gh([
        "pr", "create", "--repo", deps.mergeRepo, "--head", branch, "--base", "main",
        "--title", `[SF-010] Auto-rollback: revert ${sha.slice(0, 12)}`,
        "--body", `Automated canary rollback of squash commit ${sha}. Opened by auto-rollback.ts watch after a yield_floor breach inside the canary window.`,
      ]);
      if (pr.status !== 0) return { success: false, sha: revertSha || null, error: `revert branch pushed but gh pr create failed: ${(pr.stderr || "").trim()}` };
      return { success: true, sha: revertSha || null };
    } finally {
      g(["worktree", "remove", "--force", wt]);
    }
  };
}

export function realGhIncident(mergeRepo: string): IncidentFn {
  return async (title, body) => {
    const r = spawnSync("gh", ["issue", "create", "--repo", mergeRepo, "--title", title, "--body", body], { encoding: "utf8" });
    if (r.status !== 0) return { url: null, error: (r.stderr || "").trim() };
    return { url: r.stdout.trim() || null };
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      by: { type: "string" },
      json: { type: "boolean" },
      pr: { type: "string" },
      sha: { type: "string" },
      ts: { type: "string" },
      window: { type: "string" },
      "merge-repo": { type: "string" },
      base: { type: "string" },
    },
    strict: false,
  });

  if (cmd === "circuit-status") {
    const status = checkCircuit();
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(status.tripped
        ? `Circuit OPEN — ${status.consecutive} consecutive rollbacks. Run reset-circuit --by <op> to clear.`
        : `Circuit CLOSED — ${status.consecutive} consecutive rollbacks (threshold: ${DEFAULT_ROLLBACK_CONFIG.circuit_breaker_k})`
      );
    }
    process.exit(status.tripped ? 1 : 0);
  } else if (cmd === "reset-circuit") {
    const op = String(values.by ?? "operator");
    const result = resetCircuit(op);
    console.log(result.reset ? `Reset: ${result.reason}` : `Skipped: ${result.reason}`);
    process.exit(result.reset ? 0 : 1);
  } else if (cmd === "watch") {
    const pr = values.pr ? String(values.pr) : "";
    const sha = values.sha ? String(values.sha) : "";
    const ts = values.ts ? String(values.ts) : new Date().toISOString();
    if (!pr || !sha) {
      console.error("watch requires --pr <ref> and --sha <merge-sha>");
      process.exit(1);
    }
    const watchBase = values.base ? String(values.base) : PROJECT_DIR;
    const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: watchBase, encoding: "utf8" }).stdout.trim() || watchBase;
    const mergeRepo = String(values["merge-repo"] ?? "marlandoj/zouroboros");
    const windowMs = values.window ? Number(values.window) : NaN;
    const outcome = await watchCanaryWindow(
      pr,
      sha,
      ts,
      Number.isFinite(windowMs) && windowMs > 0 ? { canary_window_ms: windowMs } : {},
      {
        gitRevert: realGitRevert({ repoRoot, remote: "zbr", mergeRepo }),
        incident: realGhIncident(mergeRepo),
        base: watchBase,
      },
    );
    const canaryDir = factoryStatePathForProject(watchBase, "canary");
    mkdirSync(canaryDir, { recursive: true });
    const outPath = join(canaryDir, `outcome-${pr.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify({ pr_ref: pr, merge_sha: sha, merge_ts: ts, outcome }, null, 2));
    if (values.json) {
      console.log(JSON.stringify({ ...outcome, outcome_path: outPath }, null, 2));
    } else {
      console.log(`Canary ${outcome.action === "none" ? "CLEAN" : "ROLLBACK"}: ${outcome.reason}`);
      console.log(`Outcome: ${outPath}`);
    }
    process.exit(outcome.action === "rollback" ? 2 : 0);
  } else {
    console.log("Usage: bun auto-rollback.ts <circuit-status|reset-circuit|watch> [--by operator] [--pr ref --sha sha [--ts iso] [--window ms] [--merge-repo owner/repo]] [--json]");
    process.exit(0);
  }
}
