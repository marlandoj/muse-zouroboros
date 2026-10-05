#!/usr/bin/env bun
/**
 * SF-003 T6 — Pool self-test harness.
 *
 * Synthetic multi-wave campaigns against throwaway state dirs (SF003_POOL_STATE_DIR).
 * No /zo/ask calls (mock dispatch), no real state touched, no scheduled agents.
 *
 * Scenarios:
 *   1. lifecycle       — 3-wave DAG: enqueue → dispatch → complete → harvest → campaign complete
 *   2. stall-failover  — timeout → bounded retry down the model chain → park stall:
 *   3. cap-overflow    — 25 ready tasks vs global cap: overflow parks capacity:, zero drops, full drain
 *   4. ceiling-breach  — cost fold breaches ceiling → park ceiling:; operator raises → auto-release
 *   5. idempotency     — double reconcile with no new events = byte-identical state
 *   6. plan-mode       — plan reconcile is log-only: would-dispatch notes, zero mutation
 *   7. read-only       — snapshot/loaders on unused pool create no state files
 *  11. campaign chain  — FR-05 cross-campaign promotion, fail-closed blocking, no duplicate dispatch
 *  12. starvation order — FR-05 oldest ready work drains first under throttle
 *  13. persona association — ZOU-1282 seed→campaign→item→restart, fail-closed, absent-field parity
 *  14. project delegation — complete-block parsing, partial-block rejection, legacy parity
 *
 * Exit 0 = all green.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type SeedTask,
  enqueueCampaign,
  loadCampaigns,
  loadQueue,
  markItem,
  parseCascadeValidationCommands,
  parseSeedContract,
  personaAssociationLineage,
  saveCampaigns,
} from "./pool-queue";
import {
  MODEL_FALLBACK_CHAIN,
  buildZoAskBody,
  loadAssignments,
  mockComplete,
  saveAssignment,
  shouldDispatchThroughHarness,
} from "./pool-worker";
import {
  POOL_GLOBAL_CAP,
  externalInFlight,
  loadEvents,
  loadRecoveryEvents,
  reconcile,
  reconcilePoolHandoff,
  retryFailedTask,
  sf003Snapshot,
} from "./pool-manager";
import type { ExecutionPolicy } from "./model-policy";

declare const Bun: { sleep(ms: number): Promise<void> };
import { CODING_CASCADE_MODELS, classifyCascadeFailure, integrateCascadeWorktree } from "./coding-cascade";

// ─── Harness ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SANDBOX_ROOT = `/home/workspace/.sf003-selftest-${process.pid}`;

function sandbox(name: string): string {
  const dir = join(SANDBOX_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  process.env.SF003_POOL_STATE_DIR = dir;
  return dir;
}

function chain(n: number): SeedTask[] {
  // A → B → C … linear DAG of n tasks
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    name: `task ${i + 1}`,
    description: `synthetic task ${i + 1}`,
    deps: i === 0 ? [] : [`T${i}`],
  }));
}

function independent(n: number): SeedTask[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `T${i + 1}`,
    name: `task ${i + 1}`,
    description: `synthetic task ${i + 1}`,
    deps: [],
  }));
}

function openAssignment(campaign_id: string, task_id: string) {
  return loadAssignments().find(
    (a) => a.campaign_id === campaign_id && a.task_id === task_id && a.outcome === null
  );
}

function stateFingerprint(dir: string): string {
  const parts: string[] = [];
  for (const f of ["campaigns.json", "queue.json"]) {
    const p = join(dir, f);
    parts.push(existsSync(p) ? readFileSync(p, "utf8") : "∅");
  }
  parts.push(
    JSON.stringify(
      loadAssignments().sort((a, b) => a.assignment_id.localeCompare(b.assignment_id))
    )
  );
  return parts.join("\n---\n");
}

function minutesLater(min: number): Date {
  return new Date(Date.now() + min * 60000);
}

// ─── 1. Full lifecycle ────────────────────────────────────────────────────────

async function scenarioLifecycle(): Promise<void> {
  console.log("\n[1] lifecycle — 3-wave DAG enqueue → dispatch → complete → harvest");
  sandbox("lifecycle");
  enqueueCampaign({
    campaign_id: "c-life",
    ticket_id: "SYN-1",
    identifier: "SYN-1",
    seed_path: null,
    tasks: chain(3),
  });

  let ev = await reconcile({ mode: "act", mock: true });
  const firstAssignment = openAssignment("c-life", "T1")!;
  check(
    "cascade off preserves legacy assignment evidence shape",
    !("requested_model" in firstAssignment) && !("cascade_mode" in firstAssignment) && !("cascade_decision" in firstAssignment),
  );
  check("wave 1 dispatches only the dep-free task", ev.dispatched === 1, `dispatched=${ev.dispatched}`);
  check("T2/T3 stay queued (deps unmet)", loadQueue().filter((i) => i.state === "ready").length === 2);

  mockComplete(openAssignment("c-life", "T1")!, "success", "done", 0.01);
  ev = await reconcile({ mode: "act", mock: true });
  check("wave 2 harvests T1 and dispatches T2", ev.harvested === 1 && ev.dispatched === 1);

  mockComplete(openAssignment("c-life", "T2")!, "success", "done", 0.01);
  ev = await reconcile({ mode: "act", mock: true });
  check("wave 3 harvests T2 and dispatches T3", ev.harvested === 1 && ev.dispatched === 1);

  mockComplete(openAssignment("c-life", "T3")!, "success", "done", 0.01);
  ev = await reconcile({ mode: "act", mock: true });
  const c = loadCampaigns()["c-life"];
  check("final harvest completes campaign", ev.harvested === 1 && c.state === "complete", `state=${c.state}`);
  check("cost folded from result sentinels", Math.abs(c.cost_spent_usd - 0.03) < 1e-9, `spent=${c.cost_spent_usd}`);
  check("all items done", loadQueue().every((i) => i.state === "done"));
}

// ─── 2. Stall → retry → failover → park ──────────────────────────────────────

async function scenarioStallFailover(): Promise<void> {
  console.log("\n[2] stall → bounded retry down failover chain → park");
  sandbox("stall");
  enqueueCampaign({
    campaign_id: "c-stall",
    ticket_id: "SYN-2",
    identifier: "SYN-2",
    seed_path: null,
    tasks: independent(1),
  });

  await reconcile({ mode: "act", mock: true }); // attempt 1
  let a = loadAssignments().filter((x) => x.campaign_id === "c-stall");
  check("attempt 1 on rung 1", a.length === 1 && a[0].model === MODEL_FALLBACK_CHAIN[0].id);

  let ev = await reconcile({ mode: "act", mock: true, now: minutesLater(31) });
  check("timeout → stale + retry + redispatch same cycle", ev.stalled === 1 && ev.retried === 1 && ev.dispatched === 1);
  a = loadAssignments().filter((x) => x.campaign_id === "c-stall" && x.outcome === null);
  check("attempt 2 fails over to rung 2", a.length === 1 && a[0].attempt === 1 && a[0].model === MODEL_FALLBACK_CHAIN[1].id, a[0]?.model);

  ev = await reconcile({ mode: "act", mock: true, now: minutesLater(62) });
  a = loadAssignments().filter((x) => x.campaign_id === "c-stall" && x.outcome === null);
  check("attempt 3 fails over to rung 3 (terminal)", ev.retried === 1 && a[0]?.attempt === 2 && a[0]?.model === MODEL_FALLBACK_CHAIN[2].id, a[0]?.model);

  ev = await reconcile({ mode: "act", mock: true, now: minutesLater(93) });
  const item = loadQueue().find((i) => i.campaign_id === "c-stall")!;
  check("chain exhausted → parked with stall: reason", ev.parked === 1 && item.state === "parked" && (item.park_reason ?? "").startsWith("stall:"), item.park_reason ?? "");
  check("campaign rolls up parked", loadCampaigns()["c-stall"].state === "parked");
}

async function scenarioCodingCascade(): Promise<void> {
  console.log("\n[3] coding cascade — shadow parity, enforced clean Opus-to-Sol-to-Kimi fallback");
  const savedMode = process.env.FACTORY_CODING_CASCADE;
  const savedRoot = process.env.FACTORY_CODING_CASCADE_WORKTREES_ROOT;
  const savedWorkspace = process.env.ZOUROBOROS_WORKSPACE;
  const repositoryRoot = `/home/workspace/.factory-cascade-selftest-${process.pid}`;
  const repository = join(repositoryRoot, "repo");
  const validationCommands = [{ label: "diff-check", command: "git", args: ["diff", "--check"] }];
  const parsedValidation = parseCascadeValidationCommands(
    [{ label: " tests ", command: " bun ", args: ["test"], timeout_ms: 1_000 }],
    "selftest",
  );
  check(
    "validation command parser normalizes structured input",
    parsedValidation[0]?.label === "tests" && parsedValidation[0]?.command === "bun" && parsedValidation[0]?.timeout_ms === 1_000,
  );
  let rejectedMalformedValidation = false;
  try {
    process.env.ZOUROBOROS_WORKSPACE = "/home/workspace";
    parseCascadeValidationCommands([{ label: "tests", command: "bun", args: "test" }], "selftest");
  } catch {
    rejectedMalformedValidation = true;
  }
  check("validation command parser rejects non-array arguments", rejectedMalformedValidation);
  let rejectedEmptyValidation = false;
  try {
    parseCascadeValidationCommands([], "selftest");
  } catch {
    rejectedEmptyValidation = true;
  }
  check("validation command parser rejects an empty gate", rejectedEmptyValidation);
  const run = (args: string[], cwd = repository): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(result.stderr || `git exited ${result.status}`);
    return (result.stdout ?? "").trim();
  };

  try {
    sandbox("cascade-shadow");
    process.env.FACTORY_CODING_CASCADE = "shadow";
    enqueueCampaign({
      campaign_id: "c-cascade-shadow",
      ticket_id: "SYN-CS",
      identifier: "SYN-CS",
      seed_path: null,
      tasks: independent(1),
    });
    await reconcile({ mode: "act", mock: true });
    let shadow = openAssignment("c-cascade-shadow", "T1")!;
    check("shadow dispatch preserves incumbent primary", shadow.model === MODEL_FALLBACK_CHAIN[0].id);
    await reconcile({ mode: "act", mock: true, now: minutesLater(31) });
    shadow = loadAssignments().find((assignment) => assignment.assignment_id === shadow.assignment_id)!;
    check("shadow records would-retry decision", shadow.cascade_decision?.action === "would_retry");
    check("shadow preserves incumbent retry mutation", openAssignment("c-cascade-shadow", "T1")?.model === MODEL_FALLBACK_CHAIN[1].id);

    rmSync(repositoryRoot, { recursive: true, force: true });
    mkdirSync(repository, { recursive: true });
    run(["init", "-q"]);
    run(["config", "user.email", "pool-cascade-selftest@example.invalid"]);
    run(["config", "user.name", "Pool Cascade Selftest"]);
    writeFileSync(join(repository, "tracked.txt"), "base\n");
    run(["add", "tracked.txt"]);
    run(["commit", "-qm", "base"]);
    const baseCommit = run(["rev-parse", "HEAD"]);

    sandbox("cascade-enforce");
    process.env.FACTORY_CODING_CASCADE = "enforce";
    process.env.FACTORY_CODING_CASCADE_WORKTREES_ROOT = join(repositoryRoot, "worktrees");
    enqueueCampaign({
      campaign_id: "c-cascade-enforce",
      ticket_id: "SYN-CE",
      identifier: "SYN-CE",
      seed_path: null,
      tasks: independent(1),
      target_repository: repository,
      base_commit: baseCommit,
      validation_commands: validationCommands,
    });
    await reconcile({ mode: "act", mock: true });
    const primary = openAssignment("c-cascade-enforce", "T1")!;
    check("enforce dispatches exact Opus primary", primary.model === CODING_CASCADE_MODELS[0].id);
    check("primary records repository and base commit", primary.target_repository === repository && primary.base_commit === baseCommit);
    check("primary records a clean worktree", Boolean(primary.worktree_path && existsSync(primary.worktree_path)));
    writeFileSync(join(primary.worktree_path!, "tracked.txt"), "unverified primary diff\n");

    let ev = await reconcile({ mode: "act", mock: true, now: minutesLater(31) });
    const fallback = openAssignment("c-cascade-enforce", "T1")!;
    const completedPrimary = loadAssignments().find((assignment) => assignment.assignment_id === primary.assignment_id)!;
    check("timeout triggers exactly one enforced retry", ev.retried === 1 && completedPrimary.cascade_decision?.action === "retry");
    check("fallback dispatches exact Sol route", fallback.model === CODING_CASCADE_MODELS[1].id);
    check("fallback has a distinct worktree", fallback.worktree_path !== primary.worktree_path);
    check("fallback excludes primary diff", readFileSync(join(fallback.worktree_path!, "tracked.txt"), "utf8") === "base\n");
    check("fallback starts clean", run(["status", "--porcelain"], fallback.worktree_path!) === "");

    ev = await reconcile({ mode: "act", mock: true, now: minutesLater(62) });
    const finalFallback = openAssignment("c-cascade-enforce", "T1")!;
    check("Sol timeout triggers the final Kimi retry", ev.retried === 1 && finalFallback.model === CODING_CASCADE_MODELS[2].id);

    ev = await reconcile({ mode: "act", mock: true, now: minutesLater(93) });
    const exhaustedItem = loadQueue().find((item) => item.campaign_id === "c-cascade-enforce")!;
    check("Kimi timeout exhausts at three attempts", ev.parked === 1 && exhaustedItem.state === "parked" && exhaustedItem.attempts === 3);
    check("exactly three default assignments exist", loadAssignments().filter((assignment) => assignment.campaign_id === "c-cascade-enforce").length === 3);

    check(
      "cascade enforce cannot substitute a model-opaque harness",
      !shouldDispatchThroughHarness("enforce", true, "claude-code"),
    );

    sandbox("cascade-integration");
    const integrationBase = run(["rev-parse", "HEAD"]);
    enqueueCampaign({
      campaign_id: "c-cascade-integration",
      ticket_id: "SYN-CI",
      identifier: "SYN-CI",
      seed_path: null,
      tasks: independent(1),
      target_repository: repository,
      base_commit: integrationBase,
      validation_commands: validationCommands,
    });
    await reconcile({ mode: "act", mock: true });
    const integrated = openAssignment("c-cascade-integration", "T1")!;
    writeFileSync(join(integrated.worktree_path!, "tracked.txt"), "integrated\n");
    mockComplete(integrated, "success", "implementation complete");
    process.env.FACTORY_CODING_CASCADE = "off";
    ev = await reconcile({ mode: "act", mock: true });
    process.env.FACTORY_CODING_CASCADE = "enforce";
    const integratedRecord = loadAssignments().find((assignment) => assignment.assignment_id === integrated.assignment_id)!;
    check("harvest honors the persisted assignment mode across processes", integratedRecord.validation?.pass === true);
    check("validated patch is committed before task is done", ev.harvested === 1 && Boolean(integratedRecord.implementation_commit));
    check("integration updates the factory-owned target", readFileSync(join(repository, "tracked.txt"), "utf8") === "integrated\n");
    check("integrated assignment has a durable receipt", Boolean(integratedRecord.integration_receipt_path && existsSync(integratedRecord.integration_receipt_path)));
    check("only the integrated assignment worktree is reclaimed", !existsSync(integrated.worktree_path!));
    const replayedReceipt = integrateCascadeWorktree({
      assignment_id: integratedRecord.assignment_id,
      campaign_id: integratedRecord.campaign_id,
      task_id: integratedRecord.task_id,
      source_worktree: integratedRecord.worktree_path!,
      target_repository: repository,
      base_commit: integratedRecord.base_commit!,
      receipt_path: integratedRecord.integration_receipt_path!,
      validation: integratedRecord.validation!,
    });
    check("integration receipt replay proves the commit and patch hash", replayedReceipt.implementation_commit === integratedRecord.implementation_commit);

    sandbox("cascade-downstream");
    const downstreamBase = run(["rev-parse", "HEAD"]);
    enqueueCampaign({
      campaign_id: "c-cascade-downstream",
      ticket_id: "SYN-CD",
      identifier: "SYN-CD",
      seed_path: null,
      tasks: chain(2),
      target_repository: repository,
      base_commit: downstreamBase,
      validation_commands: validationCommands,
    });
    await reconcile({ mode: "act", mock: true });
    const upstream = openAssignment("c-cascade-downstream", "T1")!;
    writeFileSync(join(upstream.worktree_path!, "tracked.txt"), "upstream\n");
    mockComplete(upstream, "success", "upstream complete");
    await reconcile({ mode: "act", mock: true });
    const upstreamRecord = loadAssignments().find((assignment) => assignment.assignment_id === upstream.assignment_id)!;
    const downstream = openAssignment("c-cascade-downstream", "T2")!;
    check("downstream task starts from integrated upstream head", downstream.base_commit === upstreamRecord.implementation_commit);
    check("downstream worktree includes upstream patch", readFileSync(join(downstream.worktree_path!, "tracked.txt"), "utf8") === "upstream\n");

    sandbox("cascade-mechanical");
    const mechanicalBase = run(["rev-parse", "HEAD"]);
    enqueueCampaign({
      campaign_id: "c-cascade-mechanical",
      ticket_id: "SYN-CM",
      identifier: "SYN-CM",
      seed_path: null,
      tasks: independent(1),
      target_repository: repository,
      base_commit: mechanicalBase,
      validation_commands: validationCommands,
    });
    await reconcile({ mode: "act", mock: true });
    const mechanical = openAssignment("c-cascade-mechanical", "T1")!;
    writeFileSync(join(mechanical.worktree_path!, "tracked.txt"), "validation failure  \n");
    mockComplete(mechanical, "failure", "worker reported test failure");
    ev = await reconcile({ mode: "act", mock: true });
    const failedMechanical = loadAssignments().find((assignment) => assignment.assignment_id === mechanical.assignment_id)!;
    const mechanicalFallback = openAssignment("c-cascade-mechanical", "T1")!;
    check("factory-owned validation classifies the real failure", failedMechanical.failure?.kind === "mechanical_validation");
    check("real mechanical validation failure triggers Sol fallback", ev.retried === 1 && mechanicalFallback.model === CODING_CASCADE_MODELS[1].id);
    check("rejected validation worktree is retained", existsSync(mechanical.worktree_path!));
    check("Sol retry excludes the rejected validation diff", readFileSync(join(mechanicalFallback.worktree_path!, "tracked.txt"), "utf8") === "upstream\n");

    sandbox("cascade-missing-provenance");
    enqueueCampaign({
      campaign_id: "c-cascade-missing-provenance",
      ticket_id: "SYN-CP",
      identifier: "SYN-CP",
      seed_path: null,
      tasks: independent(1),
    });
    ev = await reconcile({ mode: "act", mock: true });
    const missingProvenance = loadQueue().find((item) => item.campaign_id === "c-cascade-missing-provenance")!;
    check("enforcement without repository provenance fails closed", ev.parked === 1 && missingProvenance.state === "parked" && loadAssignments().filter((assignment) => assignment.campaign_id === "c-cascade-missing-provenance").length === 0);

    sandbox("cascade-missing-validation");
    enqueueCampaign({
      campaign_id: "c-cascade-missing-validation",
      ticket_id: "SYN-CV",
      identifier: "SYN-CV",
      seed_path: null,
      tasks: independent(1),
      target_repository: repository,
      base_commit: run(["rev-parse", "HEAD"]),
    });
    ev = await reconcile({ mode: "act", mock: true });
    const missingValidation = loadQueue().find((item) => item.campaign_id === "c-cascade-missing-validation")!;
    check("enforcement without validation commands fails closed", ev.parked === 1 && missingValidation.state === "parked");

    sandbox("cascade-terminal");
    enqueueCampaign({
      campaign_id: "c-cascade-terminal",
      ticket_id: "SYN-CT",
      identifier: "SYN-CT",
      seed_path: null,
      tasks: independent(1),
      target_repository: repository,
      base_commit: run(["rev-parse", "HEAD"]),
      validation_commands: validationCommands,
    });
    await reconcile({ mode: "act", mock: true });
    const terminal = openAssignment("c-cascade-terminal", "T1")!;
    terminal.failure = classifyCascadeFailure({ cause: "governance", detail: "consensus rejected" });
    saveAssignment(terminal);
    mockComplete(terminal, "failure", "consensus rejected");
    ev = await reconcile({ mode: "act", mock: true });
    check("governance failure is terminal", ev.retried === 0 && loadQueue().find((item) => item.campaign_id === "c-cascade-terminal")?.state === "failed");

    sandbox("cascade-conflict");
    const conflictBase = run(["rev-parse", "HEAD"]);
    enqueueCampaign({
      campaign_id: "c-cascade-conflict",
      ticket_id: "SYN-CC",
      identifier: "SYN-CC",
      seed_path: null,
      tasks: independent(2),
      target_repository: repository,
      base_commit: conflictBase,
      validation_commands: validationCommands,
    });
    await reconcile({ mode: "act", mock: true });
    const conflictAssignments = loadAssignments()
      .filter((assignment) => assignment.campaign_id === "c-cascade-conflict")
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
    writeFileSync(join(conflictAssignments[0].worktree_path!, "tracked.txt"), "conflict-one\n");
    writeFileSync(join(conflictAssignments[1].worktree_path!, "tracked.txt"), "conflict-two\n");
    mockComplete(conflictAssignments[0], "success", "first parallel patch");
    mockComplete(conflictAssignments[1], "success", "second parallel patch");
    await reconcile({ mode: "act", mock: true });
    const conflictRecords = loadAssignments().filter((assignment) => assignment.campaign_id === "c-cascade-conflict");
    const conflictWinners = conflictRecords.filter((assignment) =>
      assignment.outcome === "success"
      && Boolean(assignment.implementation_commit)
      && Boolean(assignment.integration_receipt_path && existsSync(assignment.integration_receipt_path)),
    );
    const conflictLosers = conflictRecords.filter((assignment) =>
      assignment.outcome === "failure" && assignment.failure?.kind === "unsafe_scope",
    );
    const conflictWinner = conflictWinners[0];
    const conflictLoser = conflictLosers[0];
    const winnerContent = conflictWinner?.task_id === "T1"
      ? "conflict-one\n"
      : conflictWinner?.task_id === "T2" ? "conflict-two\n" : null;
    check(
      "parallel patch conflict yields one verified winner and one unsafe-scope loser",
      conflictWinners.length === 1 && conflictLosers.length === 1,
    );
    check(
      "integration conflict does not trigger Sol or a third assignment",
      conflictRecords.length === 2 && conflictRecords.every((assignment) => assignment.attempt === 0),
    );
    check(
      "conflict target bytes match the verified winner",
      winnerContent !== null && readFileSync(join(repository, "tracked.txt"), "utf8") === winnerContent,
    );
    check(
      "conflict reclaims the winner and retains the loser for recovery",
      Boolean(conflictWinner?.worktree_path && !existsSync(conflictWinner.worktree_path))
        && Boolean(conflictLoser?.worktree_path && existsSync(conflictLoser.worktree_path)),
    );
  } finally {
    if (savedMode === undefined) delete process.env.FACTORY_CODING_CASCADE;
    else process.env.FACTORY_CODING_CASCADE = savedMode;
    if (savedRoot === undefined) delete process.env.FACTORY_CODING_CASCADE_WORKTREES_ROOT;
    else process.env.FACTORY_CODING_CASCADE_WORKTREES_ROOT = savedRoot;
    if (savedWorkspace === undefined) delete process.env.ZOUROBOROS_WORKSPACE;
    else process.env.ZOUROBOROS_WORKSPACE = savedWorkspace;
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

// ─── 3. Capacity overflow → park → drain ──────────────────────────────────────

async function scenarioCapOverflow(): Promise<void> {
  console.log("\n[3] cap overflow — parks capacity:, zero drops, drains fully");
  sandbox("cap");
  const external = externalInFlight();
  const headroom = Math.max(0, POOL_GLOBAL_CAP - external);
  const N = POOL_GLOBAL_CAP + 5;
  enqueueCampaign({
    campaign_id: "c-cap",
    ticket_id: "SYN-3",
    identifier: "SYN-3",
    seed_path: null,
    tasks: independent(N),
    cost_ceiling_usd: 100,
  });

  const ev = await reconcile({ mode: "act", mock: true });
  check(`dispatches up to headroom (${headroom})`, ev.dispatched === Math.min(N, headroom), `dispatched=${ev.dispatched}`);
  check("overflow parks — zero drops", ev.dispatched + ev.parked === N, `d=${ev.dispatched} p=${ev.parked}`);
  const capParks = loadQueue().filter((i) => i.state === "parked");
  check("parks carry capacity: reason", capParks.every((i) => (i.park_reason ?? "").startsWith("capacity:")) && capParks.length === ev.parked);

  // Drain: complete in-flight, reconcile releases parked ≤ headroom, repeat.
  let iterations = 0;
  while (loadCampaigns()["c-cap"].state !== "complete" && iterations < 10) {
    for (const a of loadAssignments().filter((x) => x.campaign_id === "c-cap" && x.outcome === null)) {
      mockComplete(a, "success");
    }
    await reconcile({ mode: "act", mock: true });
    iterations++;
  }
  check("parked items auto-release and campaign drains to complete", loadCampaigns()["c-cap"].state === "complete", `iterations=${iterations}`);
  check("every task done, none dropped", loadQueue().filter((i) => i.campaign_id === "c-cap" && i.state === "done").length === N);
}

// ─── 4. Ceiling breach → park → operator raise → release ─────────────────────

async function scenarioCeiling(): Promise<void> {
  console.log("\n[4] ceiling breach — park ceiling:, release when raised");
  sandbox("ceiling");
  enqueueCampaign({
    campaign_id: "c-ceil",
    ticket_id: "SYN-4",
    identifier: "SYN-4",
    seed_path: null,
    tasks: chain(2),
    cost_ceiling_usd: 0.5,
  });

  await reconcile({ mode: "act", mock: true }); // dispatch T1
  mockComplete(openAssignment("c-ceil", "T1")!, "success", "done", 0.75); // breaches $0.50
  const ev = await reconcile({ mode: "act", mock: true });
  const t2 = loadQueue().find((i) => i.campaign_id === "c-ceil" && i.task_id === "T2")!;
  check("harvest folds cost past ceiling", loadCampaigns()["c-ceil"].cost_spent_usd === 0.75);
  check("next task parks with ceiling: reason", ev.parked === 1 && t2.state === "parked" && (t2.park_reason ?? "").startsWith("ceiling:"), t2.park_reason ?? "");

  // Operator raises the ceiling (the only way ceiling: clears).
  const campaigns = loadCampaigns();
  campaigns["c-ceil"].cost_ceiling_usd = 2.0;
  saveCampaigns(campaigns);
  const ev2 = await reconcile({ mode: "act", mock: true });
  check("ceiling cleared → auto-release + dispatch", ev2.released === 1 && ev2.dispatched === 1, `rel=${ev2.released} d=${ev2.dispatched}`);
}

// ─── 5. Idempotent double reconcile ───────────────────────────────────────────

async function scenarioIdempotency(): Promise<void> {
  console.log("\n[5] idempotency — reconcile with no new events mutates nothing");
  const dir = sandbox("idem");
  enqueueCampaign({
    campaign_id: "c-idem",
    ticket_id: "SYN-5",
    identifier: "SYN-5",
    seed_path: null,
    tasks: independent(2),
  });
  await reconcile({ mode: "act", mock: true });
  mockComplete(openAssignment("c-idem", "T1")!, "success");
  await reconcile({ mode: "act", mock: true }); // harvest T1; T2 stays in-flight

  const before = stateFingerprint(dir);
  const eventsBefore = loadEvents().length;
  const ev1 = await reconcile({ mode: "act", mock: true });
  const ev2 = await reconcile({ mode: "act", mock: true });
  const after = stateFingerprint(dir);

  check("state byte-identical after double reconcile", before === after);
  check(
    "both cycles report zero activity",
    [ev1, ev2].every((e) => e.harvested + e.stalled + e.retried + e.dispatched + e.parked + e.released === 0)
  );
  check("only audit events appended", loadEvents().length === eventsBefore + 2);
}

// ─── 6. Plan mode is log-only ─────────────────────────────────────────────────

async function scenarioPlanMode(): Promise<void> {
  console.log("\n[6] plan mode — would-dispatch notes, zero mutation");
  const dir = sandbox("plan");
  enqueueCampaign({
    campaign_id: "c-plan",
    ticket_id: "SYN-6",
    identifier: "SYN-6",
    seed_path: null,
    tasks: independent(3),
  });

  const before = stateFingerprint(dir);
  const ev = await reconcile({ mode: "plan" });
  const after = stateFingerprint(dir);

  check("plan reconcile mutates nothing", before === after);
  check("no assignments created", loadAssignments().length === 0);
  check("would-dispatch logged for each ready item", ev.notes.filter((n) => n.startsWith("would-dispatch")).length === 3);
  check("dispatched counter stays zero", ev.dispatched === 0);

  await reconcile({ mode: "act", mock: true, campaign_id: "c-plan", task_id: "T1" });
  const assignment = openAssignment("c-plan", "T1")!;
  mockComplete(assignment, "success");
  const beforeHarvestPlan = stateFingerprint(dir);
  const planHarvest = await reconcile({ mode: "plan", campaign_id: "c-plan", task_id: "T1" });
  check("plan mode does not harvest result sentinels", planHarvest.harvested === 0 && stateFingerprint(dir) === beforeHarvestPlan);
  check("plan mode reports the deferred harvest", planHarvest.notes.some((note) => note.startsWith("would-harvest")));
}

// ─── 7. Unused pool creates no state ──────────────────────────────────────────

function scenarioReadOnly(): void {
  console.log("\n[7] read-only — snapshot on unused pool creates no state");
  const dir = join(SANDBOX_ROOT, "readonly-nonexistent");
  rmSync(dir, { recursive: true, force: true });
  process.env.SF003_POOL_STATE_DIR = dir;

  const snap = sf003Snapshot();
  check("snapshot reads cleanly from nothing", snap.queue_depth_ready === 0 && snap.in_flight === 0 && snap.reconcile_events === 0);
  check("fleet separation holds on empty pool", snap.fleet_separation_ok);
  check("loaders create no files", !existsSync(dir));
}

// ─── 8. Consensus-review regressions ──────────────────────────────────────────

async function scenarioConsensusRegressions(): Promise<void> {
  console.log("\n[8] consensus regressions — torn audit line, dispatch-failure containment");
  const dir = sandbox("consensus");
  enqueueCampaign({
    campaign_id: "c-rev",
    ticket_id: "SYN-8",
    identifier: "SYN-8",
    seed_path: null,
    tasks: independent(2),
  });

  // Real (non-mock) act dispatch with no /zo/ask token → dispatchWorker throws
  // AFTER persisting assignment + in-flight. Cycle must survive and keep its audit.
  const savedToken = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  delete process.env.ZO_CLIENT_IDENTITY_TOKEN;
  let ev;
  try {
    ev = await reconcile({ mode: "act" });
  } finally {
    if (savedToken !== undefined) process.env.ZO_CLIENT_IDENTITY_TOKEN = savedToken;
  }
  check("dispatch failure does not abort the cycle", ev.notes.filter((n) => n.startsWith("dispatch-failed")).length === 2 && ev.dispatched === 0);
  check("failed dispatches are visibly parked with no phantom opens", loadQueue().every((i) => i.state === "parked" && (i.park_reason ?? "").startsWith("dispatch:")) && loadAssignments().filter((a) => a.outcome === null).length === 0);
  check(
    "failed dispatch completion never predates assignment start",
    loadAssignments().every((assignment) => assignment.completed_at !== null && assignment.completed_at >= assignment.started_at),
  );
  check("audit event still appended", loadEvents().length === 1);

  // Torn append (non-atomic appendFileSync) must not make history unreadable.
  const before = loadEvents().length;
  appendFileSync(join(dir, "events.jsonl"), '{"event_id":"rec-torn","ran_at":"2026-07-0');
  check("torn audit line skipped, history readable", loadEvents().length === before);
  check("snapshot survives torn audit line", sf003Snapshot().reconcile_events === before);
}

async function scenarioRecovery(): Promise<void> {
  console.log("\n[9] recovery — scoped reconcile, audited retry, and reachable handoff");
  sandbox("recovery");
  const policy: ExecutionPolicy = {
    tier: "Reasoning",
    pin_proposers: ["hf:glm", "hf:kimi", "hf:nemotron"],
    pin_aggregator: "hf:minimax",
    role_chains: null,
    model_chain: ["byok:verified-a", "byok:verified-b", "byok:verified-c"],
    review_level: "consensus",
  };
  const verified = [...policy.model_chain];

  enqueueCampaign({
    campaign_id: "c-recover",
    ticket_id: "SYN-9",
    identifier: "SYN-9",
    seed_path: null,
    tasks: chain(2),
  });
  await reconcile({ mode: "act", mock: true, campaign_id: "c-recover" });
  mockComplete(openAssignment("c-recover", "T1")!, "success");
  await reconcile({ mode: "act", mock: true, campaign_id: "c-recover" });
  mockComplete(openAssignment("c-recover", "T2")!, "failure", "provider unavailable");
  await reconcile({ mode: "act", campaign_id: "c-recover" });
  const historicalAssignments = loadAssignments().filter((a) => a.campaign_id === "c-recover").map((a) => a.assignment_id).sort();

  const recovered = retryFailedTask({
    recovery_id: "recover-c-recover-t2",
    campaign_id: "c-recover",
    task_id: "T2",
    reason: "funded provider chain restored",
    execution_policy: policy,
    verified_models: verified,
  });
  const recoveredItem = loadQueue().find((i) => i.campaign_id === "c-recover" && i.task_id === "T2")!;
  check("failed task resets to ready with fresh retry budget", recoveredItem.state === "ready" && recoveredItem.attempts === 0);
  check("campaign policy replaced and campaign active", JSON.stringify(loadCampaigns()["c-recover"].execution_policy) === JSON.stringify(policy) && loadCampaigns()["c-recover"].state === "active");
  check("historical assignments preserved", JSON.stringify(loadAssignments().filter((a) => a.campaign_id === "c-recover").map((a) => a.assignment_id).sort()) === JSON.stringify(historicalAssignments));
  check("recovery intent and append-only event persisted", !recovered.idempotent && loadRecoveryEvents().length === 1 && existsSync(join(process.env.SF003_POOL_STATE_DIR!, "recovery-intents", "recover-c-recover-t2.json")));

  const duplicateRecovery = retryFailedTask({
    recovery_id: "recover-c-recover-t2",
    campaign_id: "c-recover",
    task_id: "T2",
    reason: "funded provider chain restored",
    execution_policy: policy,
    verified_models: verified,
  });
  check("repeating the same recovery id is an idempotent no-op", duplicateRecovery.idempotent && loadRecoveryEvents().length === 1);

  const [handoff, concurrentHandoff] = await Promise.all([
    reconcilePoolHandoff("c-recover", { mode: "act", mock: true, task_id: "T2" }),
    reconcilePoolHandoff("c-recover", { mode: "act", mock: true, task_id: "T2" }),
  ]);
  const assignmentCount = loadAssignments().filter((a) => a.campaign_id === "c-recover" && a.task_id === "T2").length;
  const repeatedHandoff = await reconcilePoolHandoff("c-recover", { mode: "act", mock: true, task_id: "T2" });
  check("approved handoff creates one reachable assignment", handoff.reachability === "active_assignment" && handoff.assignment_id !== null);
  check("concurrent and repeated handoff create no duplicate", concurrentHandoff.assignment_id === handoff.assignment_id && repeatedHandoff.assignment_id === handoff.assignment_id && loadAssignments().filter((a) => a.campaign_id === "c-recover" && a.task_id === "T2").length === assignmentCount);

  mockComplete(openAssignment("c-recover", "T2")!, "success");
  const planBeforeHarvest = stateFingerprint(process.env.SF003_POOL_STATE_DIR!);
  const plannedHarvest = await reconcile({ mode: "plan", campaign_id: "c-recover" });
  check("plan reconcile leaves a completed sentinel untouched", plannedHarvest.harvested === 0 && stateFingerprint(process.env.SF003_POOL_STATE_DIR!) === planBeforeHarvest);
  const harvest = await reconcile({ mode: "act", campaign_id: "c-recover" });
  check("act reconcile harvests result without dispatching another task", harvest.harvested === 1 && harvest.dispatched === 0 && loadCampaigns()["c-recover"].state === "complete");

  enqueueCampaign({ campaign_id: "c-other", ticket_id: "SYN-9B", identifier: "SYN-9B", seed_path: null, tasks: independent(1) });
  enqueueCampaign({ campaign_id: "c-scope", ticket_id: "SYN-9C", identifier: "SYN-9C", seed_path: null, tasks: independent(1) });
  await reconcile({ mode: "act", mock: true, campaign_id: "c-scope" });
  check("campaign-scoped reconcile does not dispatch unrelated ready work", openAssignment("c-scope", "T1") !== undefined && openAssignment("c-other", "T1") === undefined);

  enqueueCampaign({ campaign_id: "c-plan-handoff", ticket_id: "SYN-9D", identifier: "SYN-9D", seed_path: null, tasks: independent(1) });
  const planned = await reconcilePoolHandoff("c-plan-handoff", { mode: "plan", mock: true });
  check("plan-only handoff returns visible retry state without dispatch", planned.reachability === "parked_with_retry" && openAssignment("c-plan-handoff", "T1") === undefined);

  enqueueCampaign({ campaign_id: "c-invalid", ticket_id: "SYN-9E", identifier: "SYN-9E", seed_path: null, tasks: independent(1) });
  markItem("c-invalid", "T1", "failed");
  let unverifiedRejected = false;
  try {
    retryFailedTask({ recovery_id: "recover-unverified", campaign_id: "c-invalid", task_id: "T1", reason: "test", execution_policy: policy, verified_models: [] });
  } catch (error) {
    unverifiedRejected = String(error).includes("unverified");
  }
  check("unverified model chain is rejected", unverifiedRejected);

  enqueueCampaign({ campaign_id: "c-unmet", ticket_id: "SYN-9F", identifier: "SYN-9F", seed_path: null, tasks: chain(2) });
  markItem("c-unmet", "T2", "failed");
  let unmetRejected = false;
  try {
    retryFailedTask({ recovery_id: "recover-unmet", campaign_id: "c-unmet", task_id: "T2", reason: "test", execution_policy: policy, verified_models: verified });
  } catch (error) {
    unmetRejected = String(error).includes("unmet dependencies");
  }
  check("failed task with unmet dependencies is rejected", unmetRejected);

  enqueueCampaign({ campaign_id: "c-open", ticket_id: "SYN-9G", identifier: "SYN-9G", seed_path: null, tasks: independent(1) });
  await reconcile({ mode: "act", mock: true, campaign_id: "c-open" });
  markItem("c-open", "T1", "failed");
  let openRejected = false;
  try {
    retryFailedTask({ recovery_id: "recover-open", campaign_id: "c-open", task_id: "T1", reason: "test", execution_policy: policy, verified_models: verified });
  } catch (error) {
    openRejected = String(error).includes("open assignment");
  }
  check("failed task with an open assignment is rejected", openRejected);

  let mismatchedDuplicateRejected = false;
  try {
    retryFailedTask({ recovery_id: "recover-c-recover-t2", campaign_id: "c-recover", task_id: "T2", reason: "changed reason", execution_policy: policy, verified_models: verified });
  } catch (error) {
    mismatchedDuplicateRejected = String(error).includes("different inputs");
  }
  check("reused recovery id with changed inputs is rejected", mismatchedDuplicateRejected);

  enqueueCampaign({ campaign_id: "c-partial", ticket_id: "SYN-9H", identifier: "SYN-9H", seed_path: null, tasks: independent(1) });
  markItem("c-partial", "T1", "failed");
  let partialFaulted = false;
  try {
    retryFailedTask({
      recovery_id: "recover-partial",
      campaign_id: "c-partial",
      task_id: "T1",
      reason: "fault replay",
      execution_policy: policy,
      verified_models: verified,
      fault_after_policy: true,
    });
  } catch (error) {
    partialFaulted = String(error).includes("injected recovery fault");
  }
  const pendingDispatch = await reconcile({ mode: "act", mock: true, campaign_id: "c-partial" });
  check("partial recovery intent blocks dispatch", partialFaulted && pendingDispatch.dispatched === 0 && pendingDispatch.notes.some((note) => note.startsWith("recovery-pending")));
  const replayed = retryFailedTask({
    recovery_id: "recover-partial",
    campaign_id: "c-partial",
    task_id: "T1",
    reason: "fault replay",
    execution_policy: policy,
    verified_models: verified,
  });
  check("partial recovery replays to one applied event", !replayed.idempotent && loadQueue().find((item) => item.campaign_id === "c-partial")?.state === "ready");

  enqueueCampaign({ campaign_id: "c-dispatch-parked", ticket_id: "SYN-9I", identifier: "SYN-9I", seed_path: null, tasks: independent(1) });
  const savedToken = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  delete process.env.ZO_CLIENT_IDENTITY_TOKEN;
  try {
    await reconcile({ mode: "act", campaign_id: "c-dispatch-parked" });
  } finally {
    if (savedToken !== undefined) process.env.ZO_CLIENT_IDENTITY_TOKEN = savedToken;
  }
  const dispatchParked = loadQueue().find((item) => item.campaign_id === "c-dispatch-parked")!;
  check("dispatch failure parks with an explicit retry contract", dispatchParked.state === "parked" && (dispatchParked.park_reason ?? "").includes("explicit retry required"));
  retryFailedTask({
    recovery_id: "recover-dispatch-parked",
    campaign_id: "c-dispatch-parked",
    task_id: "T1",
    reason: "provider timeout cleared",
    execution_policy: policy,
    verified_models: verified,
  });
  const recoveredDispatchPark = loadQueue().find((item) => item.campaign_id === "c-dispatch-parked")!;
  check("dispatch-parked task resets to ready with a fresh retry budget", recoveredDispatchPark.state === "ready" && recoveredDispatchPark.attempts === 0);

  let missingCampaignRejected = false;
  try {
    retryFailedTask({ recovery_id: "recover-missing", campaign_id: "c-missing", task_id: "T1", reason: "test", execution_policy: policy, verified_models: verified });
  } catch (error) {
    missingCampaignRejected = String(error).includes("no campaign");
  }
  check("missing campaign recovery is rejected", missingCampaignRejected);

  enqueueCampaign({ campaign_id: "c-not-failed", ticket_id: "SYN-9J", identifier: "SYN-9J", seed_path: null, tasks: independent(1) });
  let nonFailedRejected = false;
  try {
    retryFailedTask({ recovery_id: "recover-not-failed", campaign_id: "c-not-failed", task_id: "T1", reason: "test", execution_policy: policy, verified_models: verified });
  } catch (error) {
    nonFailedRejected = String(error).includes("expected failed or dispatch-parked");
  }
  check("non-failed task recovery is rejected", nonFailedRejected);

  let shortChainRejected = false;
  try {
    retryFailedTask({
      recovery_id: "recover-short-chain",
      campaign_id: "c-not-failed",
      task_id: "T1",
      reason: "test",
      execution_policy: { ...policy, model_chain: [] },
      verified_models: verified,
    });
  } catch (error) {
    shortChainRejected = String(error).includes("exactly 3 distinct");
  }
  check("empty recovery chain is rejected", shortChainRejected);
}

// ─── 11. FR-05 campaign chain — multi-ticket assembly line ────────────────────

async function scenarioCampaignChain(): Promise<void> {
  console.log("\n[11] campaign chain (FR-05) — cross-campaign promotion, fail-closed blocking, no duplicate dispatch");
  sandbox("campaign-chain");
  const policy: ExecutionPolicy = {
    tier: "Reasoning",
    pin_proposers: ["hf:glm", "hf:kimi", "hf:nemotron"],
    pin_aggregator: "hf:minimax",
    role_chains: null,
    model_chain: ["byok:verified-a", "byok:verified-b", "byok:verified-c"],
    review_level: "consensus",
  };
  const verified = [...policy.model_chain];

  let unknownRejected = false;
  try {
    enqueueCampaign({ campaign_id: "c-b", ticket_id: "SYN-11B", identifier: "SYN-11B", seed_path: null, tasks: independent(1), depends_on_campaigns: ["c-a"] });
  } catch (error) {
    unknownRejected = String(error).includes("unknown campaign");
  }
  check("unknown upstream campaign is rejected at enqueue", unknownRejected);

  enqueueCampaign({ campaign_id: "c-a", ticket_id: "SYN-11A", identifier: "SYN-11A", seed_path: null, tasks: independent(1) });
  let selfRejected = false;
  try {
    enqueueCampaign({ campaign_id: "c-self", ticket_id: "SYN-11S", identifier: "SYN-11S", seed_path: null, tasks: independent(1), depends_on_campaigns: ["c-self"] });
  } catch (error) {
    selfRejected = String(error).includes("depend on itself");
  }
  check("self-dependency is rejected", selfRejected);

  enqueueCampaign({ campaign_id: "c-b", ticket_id: "SYN-11B", identifier: "SYN-11B", seed_path: null, tasks: independent(1), depends_on_campaigns: ["c-a"] });
  enqueueCampaign({ campaign_id: "c-c", ticket_id: "SYN-11C", identifier: "SYN-11C", seed_path: null, tasks: independent(1), depends_on_campaigns: ["c-b"] });

  const rerun = enqueueCampaign({ campaign_id: "c-b", ticket_id: "SYN-11B", identifier: "SYN-11B", seed_path: null, tasks: independent(1), depends_on_campaigns: ["c-a"] });
  check("re-enqueue with identical chain is an idempotent no-op", rerun.already_existed);
  let mismatchRejected = false;
  try {
    enqueueCampaign({ campaign_id: "c-b", ticket_id: "SYN-11B", identifier: "SYN-11B", seed_path: null, tasks: independent(1), depends_on_campaigns: [] });
  } catch (error) {
    mismatchRejected = String(error).includes("different campaign dependencies");
  }
  check("re-enqueue with different chain fails loud", mismatchRejected);

  let ev = await reconcile({ mode: "act", mock: true });
  check("stage 1 dispatches alone — downstream campaigns blocked", ev.dispatched === 1 && openAssignment("c-a", "T1") !== undefined && openAssignment("c-b", "T1") === undefined && openAssignment("c-c", "T1") === undefined);
  check("blocked chain is visible in the audit trail", ev.notes.some((n) => n.startsWith("blocked-upstream c-b/T1")) && ev.notes.some((n) => n.startsWith("blocked-upstream c-c/T1")));

  mockComplete(openAssignment("c-a", "T1")!, "success");
  ev = await reconcile({ mode: "act", mock: true });
  check("stage 1 completion promotes stage 2 in the same cycle", ev.harvested === 1 && ev.dispatched === 1 && loadCampaigns()["c-a"].state === "complete" && openAssignment("c-b", "T1") !== undefined);
  check("stage 3 remains blocked while stage 2 runs", openAssignment("c-c", "T1") === undefined);

  mockComplete(openAssignment("c-b", "T1")!, "failure", "verification failed");
  ev = await reconcile({ mode: "act", mock: true });
  const cItem = loadQueue().find((i) => i.campaign_id === "c-c" && i.task_id === "T1")!;
  check("failed stage blocks successors — fail closed", loadCampaigns()["c-b"].state === "failed" && cItem.state === "ready" && loadAssignments().filter((a) => a.campaign_id === "c-c").length === 0);
  check("snapshot reports the blocked chain", sf003Snapshot().upstream_blocked.some((b) => b.campaign_id === "c-c" && b.waiting_on.includes("c-b")));

  ev = await reconcile({ mode: "act", mock: true });
  check("blocked successor never dispatches while upstream is failed", ev.dispatched === 0 && loadAssignments().filter((a) => a.campaign_id === "c-c").length === 0);

  retryFailedTask({
    recovery_id: "recover-c-b-t1",
    campaign_id: "c-b",
    task_id: "T1",
    reason: "verification environment repaired",
    execution_policy: policy,
    verified_models: verified,
  });
  ev = await reconcile({ mode: "act", mock: true });
  check("recovered stage re-dispatches exactly once", ev.dispatched === 1 && loadAssignments().filter((a) => a.campaign_id === "c-b").length === 2);
  mockComplete(openAssignment("c-b", "T1")!, "success");
  ev = await reconcile({ mode: "act", mock: true });
  check("recovery completion promotes the final stage exactly once", ev.harvested === 1 && ev.dispatched === 1 && loadAssignments().filter((a) => a.campaign_id === "c-c").length === 1);
  mockComplete(openAssignment("c-c", "T1")!, "success");
  await reconcile({ mode: "act", mock: true });
  const finalCampaigns = loadCampaigns();
  check("full chain drains to complete with one assignment per stage plus the recovery", finalCampaigns["c-a"].state === "complete" && finalCampaigns["c-b"].state === "complete" && finalCampaigns["c-c"].state === "complete" && loadAssignments().length === 4);
}

// ─── 12. FR-05 starvation ordering ────────────────────────────────────────────

async function scenarioStarvationOrder(): Promise<void> {
  console.log("\n[12] starvation order (FR-05) — oldest ready work drains first under throttle");
  const dir = sandbox("starvation");
  enqueueCampaign({ campaign_id: "c-old", ticket_id: "SYN-12A", identifier: "SYN-12A", seed_path: null, tasks: independent(1) });
  await Bun.sleep(5);
  enqueueCampaign({ campaign_id: "c-new", ticket_id: "SYN-12B", identifier: "SYN-12B", seed_path: null, tasks: independent(1) });

  const shuffled = [...loadQueue()].reverse();
  writeFileSync(join(dir, "queue.json"), JSON.stringify(shuffled, null, 2));
  check("queue file order is newest-first (adversarial setup)", loadQueue()[0].campaign_id === "c-new");

  let ev = await reconcile({ mode: "act", mock: true, max_dispatch: 1 });
  check("oldest campaign dispatches first despite file order", ev.dispatched === 1 && openAssignment("c-old", "T1") !== undefined && openAssignment("c-new", "T1") === undefined);
  const wait = sf003Snapshot().oldest_ready_wait_min;
  check("snapshot exposes oldest ready wait", wait !== null && wait >= 0);
  ev = await reconcile({ mode: "act", mock: true, max_dispatch: 1 });
  check("next cycle drains the newer campaign", ev.dispatched === 1 && openAssignment("c-new", "T1") !== undefined);
}

// ─── 13. ZOU-1282 persona association propagation ─────────────────────────────

const PERSONA_SHA = "c".repeat(64);

function personaSeedYaml(overrides: { sha?: string; cap?: number; authority?: string; ownedPath?: string } = {}): string {
  const sha = overrides.sha ?? PERSONA_SHA;
  const cap = overrides.cap ?? 1;
  const authority = overrides.authority ?? "implement";
  const ownedPath = overrides.ownedPath ?? "src/render/shader.ts";
  return [
    "persona_association:",
    '  template_reference: "game@1.0.0"',
    '  version: "1.0.0"',
    `  sha256: "${sha}"`,
    "  declared_capabilities:",
    "    - realtime-3d",
    "  selector_values:",
    "    engine: unity",
    "  fleet:",
    '    - role_id: "game-designer"',
    '      persona_name: "GameDev · Game Designer"',
    "      required: true",
    "      phases: [advise, review]",
    "      required_scopes: [files:read]",
    "      invocation_cap: 2",
    '    - role_id: "technical-artist"',
    '      persona_name: "GameDev · Technical Artist"',
    "      required: false",
    "      phases: [advise, implement, review]",
    "      required_scopes: [files:read, files:write]",
    `      invocation_cap: ${cap}`,
    "  omitted_roles:",
    '    - role_id: "level-designer"',
    '      reason: "capability-mismatch"',
    "tasks:",
    "  - id: T1",
    "    name: render pass",
    "    deps: []",
    "    files:",
    "      - src/render/",
    "    persona_assignments:",
    '      - role_id: "technical-artist"',
    `        authority: "${authority}"`,
    "        owned_paths:",
    `          - ${ownedPath}`,
    '      - role_id: "game-designer"',
    '        authority: "review"',
    "        owned_paths: []",
    "  - id: T2",
    "    name: plain follow-up",
    '    deps: ["T1"]',
    "    files:",
    "      - src/audio/",
  ].join("\n");
}

function threwWith(fn: () => unknown, fragment: string): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(fragment);
  }
}

async function scenarioPersonaPropagation(): Promise<void> {
  console.log("\n[13] persona association (ZOU-1282) — seed → campaign → work item → restart, fail-closed");
  const dir = sandbox("persona");
  const seedPath = join(dir, "seed-persona.yaml");
  writeFileSync(seedPath, personaSeedYaml());

  const contract = parseSeedContract(seedPath);
  check(
    "seed contract resolves the association without resolving identities",
    contract.persona_association?.template_reference === "game@1.0.0" &&
      contract.persona_association.fleet.every((role) => !("persona_id" in role) && !("model" in role)),
  );
  check(
    "advise/review is the default and implement is explicit per task",
    contract.tasks[0].persona_assignments?.find((a) => a.role_id === "game-designer")?.authority === "review" &&
      contract.tasks[0].persona_assignments?.find((a) => a.role_id === "technical-artist")?.authority === "implement" &&
      contract.tasks[1].persona_assignments === undefined,
  );

  const enq = enqueueCampaign({
    campaign_id: "c-persona",
    ticket_id: "SYN-13",
    identifier: "SYN-13",
    seed_path: seedPath,
    tasks: contract.tasks,
    persona_association: contract.persona_association,
  });
  check("campaign stores the versioned lineage", enq.campaign.persona_association?.version === "1.0.0" && enq.campaign.persona_association?.sha256 === PERSONA_SHA);

  const t1 = loadQueue().find((i) => i.task_id === "T1")!;
  const t2 = loadQueue().find((i) => i.task_id === "T2")!;
  check("assigned work item carries assignments + owned files", t1.persona_assignments?.length === 2 && t1.owned_files?.[0] === "src/render/");
  check("unassigned work item in the same campaign gains no persona keys", !("persona_assignments" in t2) && !("owned_files" in t2));

  // Restart: everything is re-read from disk through the normal loaders.
  const restartedCampaign = loadCampaigns()["c-persona"];
  const restartedItem = loadQueue().find((i) => i.task_id === "T1")!;
  check(
    "restart preserves lineage and assignments identically",
    JSON.stringify(restartedCampaign.persona_association) === JSON.stringify(contract.persona_association) &&
      JSON.stringify(restartedItem.persona_assignments) === JSON.stringify(contract.tasks[0].persona_assignments),
  );

  const lineage = personaAssociationLineage(contract.persona_association!);
  check(
    "execution lineage is identity-free and names required + implement roles",
    lineage.required_role_ids.join(",") === "game-designer" &&
      lineage.implement_role_ids.join(",") === "technical-artist" &&
      lineage.omitted_role_ids.join(",") === "level-designer" &&
      !JSON.stringify(lineage).includes("persona_name"),
  );

  // Hash drift: a body edit under an unchanged declared sha256 must not re-enqueue.
  const driftPath = join(dir, "seed-drift.yaml");
  writeFileSync(driftPath, personaSeedYaml({ cap: 9 }));
  const drifted = parseSeedContract(driftPath);
  check("declared sha256 is unchanged by the body edit (adversarial setup)", drifted.persona_association?.sha256 === PERSONA_SHA);
  check(
    "re-enqueue with an edited fleet is rejected as hash drift",
    threwWith(
      () =>
        enqueueCampaign({
          campaign_id: "c-persona",
          ticket_id: "SYN-13",
          identifier: "SYN-13",
          seed_path: driftPath,
          tasks: drifted.tasks,
          persona_association: drifted.persona_association,
        }),
      "hash drift",
    ),
  );
  check("rejected drift left the recorded lineage untouched", loadCampaigns()["c-persona"].persona_association?.fleet[1].invocation_cap === 1);

  // Fail-closed publication validation.
  const rejectPath = join(dir, "seed-reject.yaml");
  const rejects = (body: string, fragment: string): boolean => {
    writeFileSync(rejectPath, body);
    return threwWith(() => parseSeedContract(rejectPath), fragment);
  };
  check("unknown role is rejected", rejects(personaSeedYaml().replace('"technical-artist"\n        authority', '"vfx-lead"\n        authority'), "unknown role"));
  check("authority escalation is rejected", rejects(personaSeedYaml().replace('role_id: "game-designer"\n        authority: "review"', 'role_id: "game-designer"\n        authority: "implement"'), "escalates beyond association phases"));
  check("implement path outside the task's owned files is rejected", rejects(personaSeedYaml({ ownedPath: "src/audio/mixer.ts" }), "outside the task's owned files"));
  check(
    "task assignments without top-level lineage are rejected as disagreement",
    rejects(personaSeedYaml().replace(/^persona_association:[\s\S]*?(?=^tasks:)/m, ""), "without a top-level persona_association"),
  );

  // Programmatic disagreement (recovery/retry paths that build tasks by hand).
  check(
    "enqueue re-checks hand-built tasks against the association",
    threwWith(
      () =>
        enqueueCampaign({
          campaign_id: "c-persona-mismatch",
          ticket_id: "SYN-13B",
          identifier: "SYN-13B",
          seed_path: null,
          tasks: [{ ...contract.tasks[0], files: [] }],
          persona_association: contract.persona_association,
        }),
      "requires the task to declare owned files",
    ),
  );

  // Absent-field parity: a legacy campaign is byte-identical to pre-ZOU-1282.
  enqueueCampaign({ campaign_id: "c-legacy", ticket_id: "SYN-13C", identifier: "SYN-13C", seed_path: null, tasks: independent(2) });
  const legacyCampaign = loadCampaigns()["c-legacy"];
  const legacyItems = loadQueue().filter((i) => i.campaign_id === "c-legacy");
  check(
    "legacy campaign serializes no persona fields",
    !("persona_association" in legacyCampaign)
      && contract.delegation === null
      && contract.delegation_remote_action === null
      && legacyItems.every((i) => !("persona_assignments" in i) && !("owned_files" in i)),
  );

  const delegationPrefix = [
    "delegation:",
    "  mandate_path: /tmp/mandate.json",
    "  activation_receipt_path: /tmp/activation.json",
    "  receipt_path: /tmp/receipt.json",
    "  action_payload_path: /tmp/action.json",
    "  evidence_path: /tmp/evidence.json",
  ].join("\n");
  const remoteDelegationPrefix = delegationPrefix.replace("delegation:", "delegation_remote_action:");
  writeFileSync(rejectPath, `${delegationPrefix}\n${remoteDelegationPrefix}\n${personaSeedYaml()}`);
  const delegatedContract = parseSeedContract(rejectPath);
  check("complete L1 and L2 delegation blocks parse without changing the task contract", delegatedContract.delegation?.receipt_path === "/tmp/receipt.json" && delegatedContract.delegation_remote_action?.receipt_path === "/tmp/receipt.json" && delegatedContract.tasks.length === contract.tasks.length);
  check(
    "partial delegation block fails closed",
    rejects(`${delegationPrefix}\n${remoteDelegationPrefix.replace("  evidence_path: /tmp/evidence.json", "")}\n${personaSeedYaml()}`, "delegation is incomplete"),
  );
  check(
    "complete L1 with absent L2 delegation fails closed",
    rejects(`${delegationPrefix}\n${personaSeedYaml()}`, "requires complete L1 and L2"),
  );

  // Dispatch still works normally — persona metadata changes no routing.
  const ev = await reconcile({ mode: "act", mock: true });
  check("persona metadata does not change dispatch behavior", ev.dispatched > 0);
  const assignment = loadAssignments().find((a) => a.campaign_id === "c-persona" && a.task_id === "T1");
  check(
    "assignment still routes by model/harness, not persona",
    assignment?.model === MODEL_FALLBACK_CHAIN[0].id && assignment.harness === undefined,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("SF-003 pool self-test (sandboxed, mock dispatch, no /zo/ask)");
const askBody = buildZoAskBody("test prompt", "test:model");
check("/zo/ask payload uses input", askBody.input === "test prompt" && askBody.model_name === "test:model");
check("/zo/ask payload has no legacy message field", !("message" in askBody));
await scenarioLifecycle();
await scenarioStallFailover();
await scenarioCodingCascade();
await scenarioCapOverflow();
await scenarioCeiling();
await scenarioIdempotency();
await scenarioPlanMode();
scenarioReadOnly();
await scenarioConsensusRegressions();
await scenarioRecovery();
await scenarioCampaignChain();
await scenarioStarvationOrder();
await scenarioPersonaPropagation();

rmSync(SANDBOX_ROOT, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
