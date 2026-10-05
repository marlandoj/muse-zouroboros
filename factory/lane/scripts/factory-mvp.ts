#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * factory-mvp.ts — FR-10: the Minimum Viable Factory Path (ZOU-1119).
 *
 * One queue, one worker, one worktree, one gate. This is the DEFAULT setup for
 * a new operator: a single bounded example project runs the complete factory
 * lifecycle deterministically — enqueue → supervised lease → isolated cascade
 * worktree → mock implementation → deterministic review gate → harvest →
 * evidence-durable cleanup — with ZERO model calls and ZERO writes outside its
 * own isolated state directory.
 *
 * Advanced features stay opt-in exactly as before: the pool (SF003_POOL=1),
 * fleet (SF008_FLEET=1), and auto-merge (SF010_AUTOMERGE=0 until the operator
 * flips it) are NOT enabled, referenced, or modified by this path.
 *
 * Usage:
 *   factory-mvp.ts init  [--state-dir <dir>]   scaffold isolated state + bounded example repo
 *   factory-mvp.ts run   [--state-dir <dir>]   run the example through the full path (deterministic)
 *   factory-mvp.ts status [--state-dir <dir>]  read-only snapshot of queue/leases/checkpoints
 *   factory-mvp.ts smoke                       hermetic smoke test in a throwaway dir, exit 0/1
 *
 * State isolation: everything lives under --state-dir (default
 * state/mvp under this project). Production pool state (state/pool) and the
 * production worktrees root (~/.factory-worktrees) are never touched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_STATE_DIR = factoryStatePath("mvp");

interface MvpEnv {
  stateDir: string;
  poolStateDir: string;
  worktreesRoot: string;
  exampleRepo: string;
}

function resolveMvpEnv(stateDirArg?: string): MvpEnv {
  const stateDir = resolve(stateDirArg ?? DEFAULT_STATE_DIR);
  const workspaceRoot = resolve(process.env.ZOUROBOROS_WORKSPACE ?? PROJECT_ROOT);
  if (stateDir === workspaceRoot || !stateDir.startsWith(workspaceRoot + "/")) {
    throw new Error(`--state-dir must be inside ${workspaceRoot} (cascade worktree safety boundary), got ${stateDir}`);
  }
  const prodPool = factoryStatePath("pool");
  if (stateDir === prodPool || stateDir.startsWith(prodPool + "/")) {
    throw new Error(`--state-dir must not point at the production pool state (${prodPool})`);
  }
  return {
    stateDir,
    poolStateDir: join(stateDir, "pool"),
    worktreesRoot: join(stateDir, "worktrees"),
    exampleRepo: join(stateDir, "example-project"),
  };
}

/** Apply the MVP environment. The pool/supervisor/gate modules read these lazily per call. */
function applyMvpEnv(env: MvpEnv): void {
  process.env.SF003_POOL_STATE_DIR = env.poolStateDir;
  process.env.FACTORY_CODING_CASCADE = "enforce";
  process.env.FACTORY_CODING_CASCADE_WORKTREES_ROOT = env.worktreesRoot;
  process.env.FACTORY_REVIEW_GATE_MODE = "enforce";
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

// ─── init ─────────────────────────────────────────────────────────────────────

/**
 * Bounded example project: a two-file TypeScript module plus a deterministic
 * verification script. Small enough to read in one sitting; real enough that
 * the review gate, worktree isolation, and evidence trail are exercised
 * exactly as they are for production tickets.
 */
export function initExampleRepo(env: MvpEnv): { base_commit: string; created: boolean } {
  mkdirSync(env.poolStateDir, { recursive: true });
  mkdirSync(env.worktreesRoot, { recursive: true });
  if (existsSync(join(env.exampleRepo, ".git"))) {
    return { base_commit: git(env.exampleRepo, ["rev-parse", "HEAD"]), created: false };
  }
  mkdirSync(join(env.exampleRepo, "src"), { recursive: true });
  writeFileSync(
    join(env.exampleRepo, "README.md"),
    [
      "# MVP Example Project",
      "",
      "Bounded example used by the Minimum Viable Factory Path (FR-10).",
      "The factory task: make `bun src/verify.ts` exit 0.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(env.exampleRepo, "src", "greet.ts"),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  );
  writeFileSync(
    join(env.exampleRepo, "src", "verify.ts"),
    [
      'import { greet } from "./greet";',
      "",
      'if (greet("factory") !== "Hello, factory!") {',
      '  console.error("FAIL: greet(\\"factory\\") mismatch");',
      "  process.exit(1);",
      "}",
      'console.log("verify: OK");',
      "",
    ].join("\n"),
  );
  git(env.exampleRepo, ["init", "-q"]);
  git(env.exampleRepo, ["add", "-A"]);
  execFileSync(
    "git",
    [
      "-C", env.exampleRepo,
      "-c", "user.name=factory-mvp",
      "-c", "user.email=factory-mvp@localhost",
      "commit", "-q", "-m", "mvp example project baseline",
    ],
    { encoding: "utf8" },
  );
  return { base_commit: git(env.exampleRepo, ["rev-parse", "HEAD"]), created: true };
}

// ─── run ──────────────────────────────────────────────────────────────────────

export interface MvpRunEvidence {
  ok: boolean;
  campaign_id: string;
  campaign_state: string;
  assignment_id: string;
  worker_id: string | null;
  lease_id: string | null;
  lease_released: boolean;
  worktree_created: boolean;
  worktree_cleaned: boolean;
  review_pass: boolean;
  review_summary: string;
  checkpoint_stages: string[];
  dead_letters: number;
  verify_exit: number;
  failures: string[];
}

export async function runMvpPath(env: MvpEnv): Promise<MvpRunEvidence> {
  applyMvpEnv(env);
  const { enqueueDirect, loadCampaigns } = await import("./pool-queue");
  const { dispatchWorker, mockComplete, reviewWorkerImplementation, loadAssignments } = await import("./pool-worker");
  const { reconcile } = await import("./pool-manager");
  const { loadLeases, loadCheckpoints, loadDeadLetters, supervisorSnapshot } = await import("./worker-supervisor");

  const failures: string[] = [];
  const { base_commit } = initExampleRepo(env);
  const stamp = Date.now().toString(36);
  const campaignId = `mvp-${stamp}`;

  const { campaign, items } = enqueueDirect({
    campaign_id: campaignId,
    ticket_id: `mvp-local-${stamp}`,
    identifier: "MVP-EXAMPLE",
    name: "Bounded example: verify greet module",
    description: "Run the bounded example project through the minimum viable factory path. Acceptance: bun src/verify.ts exits 0.",
    cost_ceiling_usd: 1,
    risk_tier: "low",
    target_repository: env.exampleRepo,
    base_commit,
    validation_commands: [{ label: "bounded greet verification", command: "bun", args: ["src/verify.ts"] }],
  });
  const item = items[0];
  if (!item) throw new Error("enqueue produced no work item");

  const assignment = await dispatchWorker(campaign, item, { mock: true });
  const worktree = assignment.worktree_path ?? null;
  const worktreeCreated = worktree !== null && existsSync(worktree);
  if (!worktreeCreated) failures.push("cascade worktree was not created");
  if (!assignment.lease_id) failures.push("supervisor lease was not acquired");

  let verifyExit = 1;
  if (worktree) {
    try {
      writeFileSync(
        join(worktree, "FACTORY_EVIDENCE.md"),
        "# Factory MVP Evidence\n\nThe bounded implementation completed in an isolated worktree.\n",
      );
      git(worktree, ["add", "FACTORY_EVIDENCE.md"]);
      execFileSync("bun", [join(worktree, "src", "verify.ts")], { encoding: "utf8" });
      verifyExit = 0;
    } catch {
      failures.push("deterministic verification failed in the worktree");
    }
  }

  mockComplete(assignment, verifyExit === 0 ? "success" : "failure", `bounded example verify exit ${verifyExit}`, 0);

  const review = await reviewWorkerImplementation(campaign, item, assignment, {
    shadow_phase: "mvp",
    target_repo: worktree ?? env.exampleRepo,
    ticket_description: item.description,
  });
  const reviewPass = review?.pass === true;
  if (!reviewPass) failures.push(`review gate did not pass: ${review?.deterministic.summary ?? "no review result"}`);

  await reconcile({ mode: "act", mock: true });

  const finalAssignment = loadAssignments().find((a) => a.assignment_id === assignment.assignment_id);
  const lease = loadLeases().find((l) => l.assignment_id === assignment.assignment_id);
  const checkpoints = loadCheckpoints()
    .filter((c) => c.assignment_id === assignment.assignment_id)
    .map((c) => c.stage);
  const campaignState = loadCampaigns()[campaignId]?.state ?? "missing";
  if (campaignState !== "complete") failures.push(`campaign state is ${campaignState}, expected complete`);
  if (finalAssignment?.outcome !== "success") failures.push(`assignment outcome is ${finalAssignment?.outcome ?? "null"}, expected success`);
  const leaseReleased = lease?.status === "released";
  if (!leaseReleased) failures.push(`lease status is ${lease?.status ?? "missing"}, expected released`);
  if (!checkpoints.includes("result-durable")) failures.push("missing result-durable checkpoint");

  let worktreeCleaned = false;
  if (worktree && leaseReleased && finalAssignment?.outcome === "success") {
    worktreeCleaned = !existsSync(worktree);
    if (!worktreeCleaned) {
      try {
        execFileSync("git", ["-C", env.exampleRepo, "worktree", "remove", "--force", worktree], { encoding: "utf8" });
        worktreeCleaned = !existsSync(worktree);
      } catch {
        worktreeCleaned = false;
      }
    }
    if (!worktreeCleaned) failures.push("worktree cleanup after durable evidence failed");
  }

  const deadLetters = loadDeadLetters().length;
  if (deadLetters > 0) failures.push(`${deadLetters} dead letter(s) filed during a healthy run`);
  void supervisorSnapshot();

  return {
    ok: failures.length === 0,
    campaign_id: campaignId,
    campaign_state: campaignState,
    assignment_id: assignment.assignment_id,
    worker_id: assignment.worker_id ?? null,
    lease_id: assignment.lease_id ?? null,
    lease_released: leaseReleased,
    worktree_created: worktreeCreated,
    worktree_cleaned: worktreeCleaned,
    review_pass: reviewPass,
    review_summary: review?.deterministic.summary ?? "no review",
    checkpoint_stages: checkpoints,
    dead_letters: deadLetters,
    verify_exit: verifyExit,
    failures,
  };
}

// ─── status ───────────────────────────────────────────────────────────────────

export async function mvpStatus(env: MvpEnv): Promise<Record<string, unknown>> {
  applyMvpEnv(env);
  const { loadCampaigns, loadQueue } = await import("./pool-queue");
  const { supervisorSnapshot } = await import("./worker-supervisor");
  const campaigns = loadCampaigns();
  const queue = loadQueue();
  const snapshot = supervisorSnapshot();
  return {
    state_dir: env.stateDir,
    campaigns: Object.values(campaigns).map((c) => ({ campaign_id: c.campaign_id, state: c.state })),
    queue: queue.map((i) => ({ campaign_id: i.campaign_id, task_id: i.task_id, state: i.state, attempts: i.attempts })),
    workers: snapshot.workers.length,
    active_leases: snapshot.active_leases.length,
    checkpoints: snapshot.checkpoints,
    dead_letters: snapshot.dead_letters.length,
  };
}

// ─── smoke ────────────────────────────────────────────────────────────────────

export async function runSmoke(): Promise<boolean> {
  mkdirSync(factoryStateRoot(), { recursive: true });
  const smokeRoot = mkdtempSync(factoryStatePath("mvp-smoke-"));
  const env = resolveMvpEnv(smokeRoot);
  let evidence: MvpRunEvidence | null = null;
  try {
    evidence = await runMvpPath(env);
  } finally {
    try {
      if (existsSync(join(env.exampleRepo, ".git"))) git(env.exampleRepo, ["worktree", "prune"]);
    } catch {
      /* best-effort prune before removal */
    }
    rmSync(smokeRoot, { recursive: true, force: true });
  }
  const checks: Array<[string, boolean]> = [
    ["queue: campaign completed", evidence.campaign_state === "complete"],
    ["worker: supervised lease acquired", evidence.lease_id !== null],
    ["worker: lease released after terminal evidence", evidence.lease_released],
    ["worktree: isolated cascade worktree created", evidence.worktree_created],
    ["worktree: cleaned only after durable evidence", evidence.worktree_cleaned],
    ["gate: deterministic review passed", evidence.review_pass],
    ["evidence: result-durable checkpoint recorded", evidence.checkpoint_stages.includes("result-durable")],
    ["evidence: bounded example verification exit 0", evidence.verify_exit === 0],
    ["safety: zero dead letters", evidence.dead_letters === 0],
    ["overall: no failures recorded", evidence.ok],
  ];
  let pass = true;
  for (const [label, okCheck] of checks) {
    console.log(`${okCheck ? "PASS" : "FAIL"}  ${label}`);
    if (!okCheck) pass = false;
  }
  if (!pass && evidence) console.log(`failures: ${evidence.failures.join("; ")}`);
  console.log(pass ? "MVP smoke: PASS (10/10)" : "MVP smoke: FAIL");
  return pass;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(msg?: string): never {
  if (msg) console.error(`ERROR: ${msg}\n`);
  console.error(`Usage:
  factory-mvp.ts init  [--state-dir <dir>]
  factory-mvp.ts run   [--state-dir <dir>]
  factory-mvp.ts status [--state-dir <dir>]
  factory-mvp.ts smoke

The MVP path is deterministic: no model calls, no production state writes.
Advanced pool/fleet/auto-merge features remain opt-in and are not touched.
Docs: MVP_PATH.md (credential scoping, rollback, operator authority, outcomes).`);
  process.exit(2);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const stateDirArg = flagValue(args, "--state-dir");
  try {
    switch (cmd) {
      case "init": {
        const env = resolveMvpEnv(stateDirArg);
        const { base_commit, created } = initExampleRepo(env);
        console.log(JSON.stringify({ ok: true, state_dir: env.stateDir, example_repo: env.exampleRepo, base_commit, created }, null, 2));
        break;
      }
      case "run": {
        const env = resolveMvpEnv(stateDirArg);
        const evidence = await runMvpPath(env);
        console.log(JSON.stringify(evidence, null, 2));
        process.exit(evidence.ok ? 0 : 1);
      }
      case "status": {
        const env = resolveMvpEnv(stateDirArg);
        console.log(JSON.stringify(await mvpStatus(env), null, 2));
        break;
      }
      case "smoke": {
        const pass = await runSmoke();
        process.exit(pass ? 0 : 1);
      }
      default:
        usage(cmd ? `unknown command: ${cmd}` : undefined);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
