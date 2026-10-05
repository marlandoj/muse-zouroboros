#!/usr/bin/env bun
/**
 * SF-006 T4 — Dedup Self-Test Harness
 *
 * Fully sandboxed: every ledger/decision-log fixture lives in a mkdtemp dir
 * via SF006_LEDGER_PATH; probes are injected (no gh/Linear calls). Real
 * state/ is never read or written. Sandbox removed in finally.
 *
 * Sections:
 *   1. canonical seed hash (sorted keys, timestamp/UUID strip)
 *   2. ledger core (append/index, latest-row-wins, torn write, CLI round-trip)
 *   3. exact layer + resume (open/merged/closed/error probe, mid-pipeline)
 *   4. fuzzy layer (71h/73h cooldown boundary, verify-on-hit, fail-closed)
 *   5. decision log + sf006Snapshot
 *   6. flags-off identity (dispatcher + swarm-exec byte-identical, no state)
 *   7. wiring guards (source-order checks, slo-selftest convention)
 *
 * Exit 0 = all green.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRow,
  canonicalSeedHash,
  deriveIndex,
  executionKey,
  type LedgerFlags,
} from "./intake-ledger";
import {
  decideDedup,
  logDecision,
  readDecisions,
  resumeTarget,
  sf006Snapshot,
  FUZZY_COOLDOWN_MS,
  type DedupDecision,
  type ProbeRunner,
  type ProbeState,
} from "./dedup-gate";

const SCRIPT_DIR = import.meta.dir;
const NOW = Date.parse("2026-07-02T12:00:00.000Z");

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const SHADOW: LedgerFlags = { dedup: true, enforce: false };
const ENFORCE: LedgerFlags = { dedup: true, enforce: true };

function probeOf(map: Record<string, ProbeState>): ProbeRunner {
  return async (kind, ref) => map[`${kind}:${ref}`] ?? "unknown";
}

function hoursAgo(h: number): string {
  return new Date(NOW - h * 3_600_000).toISOString();
}

const sandbox = mkdtempSync(join(tmpdir(), "sf006-selftest-"));
writeFileSync(join(sandbox, "shadow-state.json"), JSON.stringify({
  current_phase: "live",
  phase_started_at: "2026-07-02T00:00:00.000Z",
  dry_run_started_at: "2026-06-25T00:00:00.000Z",
  shadow_pr_started_at: "2026-06-28T00:00:00.000Z",
  live_started_at: "2026-07-01T00:00:00.000Z",
  transitions: [],
  safe_executions: 0,
  unsafe_auto_executions: 0,
}));
const savedLedgerPath = process.env.SF006_LEDGER_PATH;
const savedDedup = process.env.SF006_DEDUP;
const savedEnforce = process.env.SF006_ENFORCE;

try {
  // ─── 1. canonical seed hash ──────────────────────────────────────────────
  section("1. canonical seed hash");
  {
    const a = {
      goal: "x",
      created: "2026-07-02T13:40:00Z",
      id: "aaaa1111-2222-3333-4444-555566667777",
      tasks: [{ name: "t1", deps: [] }],
    };
    const b = {
      tasks: [{ deps: [], name: "t1" }],
      id: "ffff9999-8888-7777-6666-555544443333",
      created: "2026-07-03",
      goal: "x",
    };
    const c = { goal: "DIFFERENT", tasks: [{ name: "t1", deps: [] }] };
    checkT("key reorder + ts/UUID churn hash identically", canonicalSeedHash(a) === canonicalSeedHash(b));
    checkT("material change hashes differently", canonicalSeedHash(a) !== canonicalSeedHash(c));
    checkT(
      "volatile strings stripped inside arrays",
      canonicalSeedHash({ xs: ["keep", "2026-07-02T00:00:00Z"] }) === canonicalSeedHash({ xs: ["keep"] }),
    );
    checkT(
      "non-volatile strings kept",
      canonicalSeedHash({ v: "seed-sf006-dedup" }) !== canonicalSeedHash({ v: "other" }),
    );
  }

  // ─── 2. ledger core ──────────────────────────────────────────────────────
  section("2. ledger core");
  {
    const path = join(sandbox, "ledger-core.jsonl");
    appendRow({ ticket_id: "T1", identifier: "ZOU-1", execution_id: "e1", stage: "decision", ts: hoursAgo(4), flags: SHADOW }, path);
    appendRow({ ticket_id: "T1", identifier: "ZOU-1", execution_id: "e1", stage: "seed", seed_hash: "H1", ts: hoursAgo(3), flags: SHADOW }, path);
    appendRow({ ticket_id: "T2", identifier: "ZOU-2", execution_id: "e2", stage: "pr", pr_number: 7, branch_name: "factory/zou-2", ts: hoursAgo(2), flags: SHADOW }, path);
    appendFileSync(path, '{"torn row without closing'); // simulated crash mid-append
    const idx = deriveIndex(path);
    checkT("all parseable rows indexed", idx.rows.length === 3);
    checkT("torn trailing line skipped without crash", idx.torn_lines === 1);
    checkT("latest-row-wins per execution", idx.byExecution.get(executionKey("T1", "e1"))?.stage === "seed");
    checkT("latest state per ticket", idx.latestByTicket.get("T1")?.stage === "seed" && idx.latestByTicket.get("T2")?.pr_number === 7);
    checkT("seed-hash bucket populated", (idx.bySeedHash.get("H1") ?? []).length === 1);
    let threw = false;
    try {
      appendRow({ ticket_id: "T1", identifier: "ZOU-1", execution_id: "e1", stage: "bogus" as never }, path);
    } catch {
      threw = true;
    }
    checkT("invalid stage fails loud", threw);
  }
  {
    const path = join(sandbox, "ledger-cli.jsonl");
    const env = { ...process.env, SF006_LEDGER_PATH: path };
    const run = (args: string[]) =>
      spawnSync("bun", [join(SCRIPT_DIR, "intake-ledger.ts"), ...args], { encoding: "utf-8", env });
    const a1 = run(["append", "--ticket", "T9", "--identifier", "ZOU-9", "--execution", "e9", "--stage", "decision"]);
    const a2 = run(["append", "--ticket", "T9", "--identifier", "ZOU-9", "--execution", "e9", "--stage", "pr", "--pr", "42", "--branch", "factory/zou-9"]);
    checkT("CLI append exits 0", a1.status === 0 && a2.status === 0);
    const lookup = run(["lookup", "--ticket", "ZOU-9"]);
    checkT("CLI lookup by identifier returns latest", lookup.status === 0 && lookup.stdout.includes("stage=pr") && lookup.stdout.includes("pr#42"));
    const history = run(["history", "--ticket", "T9"]);
    checkT("CLI history returns all rows in order", history.status === 0 && history.stdout.trim().split("\n").length === 2);
    const index = run(["index"]);
    checkT("CLI index summarizes", index.status === 0 && index.stdout.includes("2 rows"));
    const missing = run(["lookup", "--ticket", "NOPE"]);
    checkT("CLI lookup miss fails loud (exit 1)", missing.status === 1);
    const usage = run(["frobnicate"]);
    checkT("CLI unknown command exits 2", usage.status === 2);
  }

  // ─── 3. exact layer + resume ─────────────────────────────────────────────
  section("3. exact layer + resume");
  {
    const path = join(sandbox, "ledger-exact.jsonl");
    appendRow({ ticket_id: "A", identifier: "ZOU-10", execution_id: "eA", stage: "pr", pr_number: 100, ts: hoursAgo(5), flags: SHADOW }, path);
    appendRow({ ticket_id: "B", identifier: "ZOU-11", execution_id: "eB", stage: "seed", seed_hash: "HB", ts: hoursAgo(2), flags: SHADOW }, path);
    const idx = deriveIndex(path);
    const tA = { ticket_id: "A", identifier: "ZOU-10" };

    const openShadow = await decideDedup(tA, idx, probeOf({ "pr:100": "open" }), NOW, SHADOW);
    checkT("open PR → skip_duplicate (exact)", openShadow.decision === "skip_duplicate" && openShadow.layer === "exact");
    checkT("shadow never acts", openShadow.acted === false);
    const openEnforce = await decideDedup(tA, idx, probeOf({ "pr:100": "open" }), NOW, ENFORCE);
    checkT("enforce acts on skip", openEnforce.acted === true && openEnforce.matched_execution_id === "eA");

    const merged = await decideDedup(tA, idx, probeOf({ "pr:100": "merged" }), NOW, ENFORCE);
    checkT("merged PR → proceed (re-run legitimate)", merged.decision === "proceed");
    const closed = await decideDedup(tA, idx, probeOf({ "pr:100": "closed" }), NOW, ENFORCE);
    checkT("closed PR → proceed", closed.decision === "proceed");

    const errored = await decideDedup(tA, idx, probeOf({ "pr:100": "error" }), NOW, ENFORCE);
    checkT("probe error → park (fail-closed)", errored.decision === "park_verify_failed" && errored.acted === true);
    const unknown = await decideDedup(tA, idx, probeOf({ "pr:100": "unknown" }), NOW, ENFORCE);
    checkT("probe unknown → park (fail-closed)", unknown.decision === "park_verify_failed");
    const thrown = await decideDedup(tA, idx, (async () => { throw new Error("probe down"); }) as ProbeRunner, NOW, ENFORCE);
    checkT("probe throw → park, never crash", thrown.decision === "park_verify_failed");

    const resume = await decideDedup({ ticket_id: "B", identifier: "ZOU-11" }, idx, probeOf({}), NOW, ENFORCE);
    checkT(
      "mid-pipeline checkpoint → resume_from_checkpoint",
      resume.decision === "resume_from_checkpoint" && resume.checkpoint_stage === "seed" && resume.matched_execution_id === "eB",
    );
    checkT("resume target after seed = execute", resumeTarget("seed") === "execute");
    checkT("resume target after pr = complete", resumeTarget("pr") === "complete");
    checkT("no probes consulted for pure resume", resume.probes.length === 0);

    const blockedPath = join(sandbox, "ledger-evidence-blocked.jsonl");
    appendRow({ ticket_id: "C", identifier: "ZOU-13", execution_id: "eC", stage: "evidence-blocked", pr_number: 101, branch_name: "factory/zou-13", ts: hoursAgo(1), flags: ENFORCE }, blockedPath);
    const evidenceRetry = await decideDedup(
      { ticket_id: "C", identifier: "ZOU-13" }, deriveIndex(blockedPath), probeOf({ "pr:101": "open" }), NOW, ENFORCE,
    );
    checkT(
      "open PR with blocked evidence resumes post-flight instead of duplicating or skipping",
      evidenceRetry.decision === "resume_from_checkpoint" && evidenceRetry.checkpoint_stage === "evidence-blocked" && resumeTarget("evidence-blocked") === "post-flight",
    );
  }
  {
    // PR claim shadowed by later mid-pipeline rows (fresh shadow re-run) must still be found
    const path = join(sandbox, "ledger-shadowed.jsonl");
    appendRow({ ticket_id: "A", identifier: "ZOU-12", execution_id: "e1", stage: "pr", pr_number: 200, ts: hoursAgo(48), flags: SHADOW }, path);
    appendRow({ ticket_id: "A", identifier: "ZOU-12", execution_id: "e2", stage: "decision", ts: hoursAgo(1), flags: SHADOW }, path);
    const idx = deriveIndex(path);
    const d = await decideDedup({ ticket_id: "A", identifier: "ZOU-12" }, idx, probeOf({ "pr:200": "open" }), NOW, ENFORCE);
    checkT("older open-PR claim found behind newer checkpoint rows", d.decision === "skip_duplicate" && d.matched_execution_id === "e1");
    const dMerged = await decideDedup({ ticket_id: "A", identifier: "ZOU-12" }, idx, probeOf({ "pr:200": "merged" }), NOW, ENFORCE);
    checkT("merged claim + newer mid-pipeline row → resume that execution", dMerged.decision === "resume_from_checkpoint" && dMerged.matched_execution_id === "e2");
  }

  // ─── 4. fuzzy layer ──────────────────────────────────────────────────────
  section("4. fuzzy layer (72h cooldown)");
  {
    const mk = (name: string, ageH: number) => {
      const path = join(sandbox, `ledger-fuzzy-${name}.jsonl`);
      appendRow({ ticket_id: "OLD", identifier: "ZOU-20", execution_id: "eOld", stage: "seed", seed_hash: "HF", ts: hoursAgo(ageH), flags: SHADOW }, path);
      return deriveIndex(path);
    };
    const incoming = { ticket_id: "NEW", identifier: "ZOU-21", seed_hash: "HF" };

    const at71 = await decideDedup(incoming, mk("71", 71), probeOf({ "issue:OLD": "open" }), NOW, ENFORCE);
    checkT("identical hash at 71h → skip (fuzzy)", at71.decision === "skip_duplicate" && at71.layer === "fuzzy");
    const at73 = await decideDedup(incoming, mk("73", 73), probeOf({ "issue:OLD": "open" }), NOW, ENFORCE);
    checkT("identical hash at 73h → proceed (cooldown expired)", at73.decision === "proceed");
    checkT("cooldown constant is 72h", FUZZY_COOLDOWN_MS === 72 * 3_600_000);

    const closedIssue = await decideDedup(incoming, mk("closed", 2), probeOf({ "issue:OLD": "closed" }), NOW, ENFORCE);
    checkT("match with closed issue → proceed", closedIssue.decision === "proceed");
    const errIssue = await decideDedup(incoming, mk("err", 2), probeOf({ "issue:OLD": "error" }), NOW, ENFORCE);
    checkT("match with unverifiable issue → park (fail-closed)", errIssue.decision === "park_verify_failed" && errIssue.layer === "fuzzy");

    const idxSelf = mk("self", 2);
    const self = await decideDedup({ ticket_id: "OLD", identifier: "ZOU-20", seed_hash: "HF" }, idxSelf, probeOf({}), NOW, ENFORCE);
    checkT("own rows never fuzzy-match (same ticket)", self.decision !== "skip_duplicate" || self.layer !== "fuzzy");
  }
  {
    // fuzzy match that already has a PR
    const mkPr = (name: string) => {
      const path = join(sandbox, `ledger-fuzzypr-${name}.jsonl`);
      appendRow({ ticket_id: "OLD", identifier: "ZOU-22", execution_id: "eOld", stage: "pr", seed_hash: "HP", pr_number: 300, ts: hoursAgo(3), flags: SHADOW }, path);
      return deriveIndex(path);
    };
    const incoming = { ticket_id: "NEW", identifier: "ZOU-23", seed_hash: "HP" };
    const open = await decideDedup(incoming, mkPr("open"), probeOf({ "pr:300": "open" }), NOW, ENFORCE);
    checkT("fuzzy match with open PR → skip", open.decision === "skip_duplicate" && open.layer === "fuzzy");
    const merged = await decideDedup(incoming, mkPr("merged"), probeOf({ "pr:300": "merged" }), NOW, ENFORCE);
    checkT("fuzzy match with merged PR → skip (work already landed)", merged.decision === "skip_duplicate");
    const closed = await decideDedup(incoming, mkPr("closed"), probeOf({ "pr:300": "closed" }), NOW, ENFORCE);
    checkT("fuzzy match with abandoned PR → proceed", closed.decision === "proceed");
    const err = await decideDedup(incoming, mkPr("err"), probeOf({ "pr:300": "error" }), NOW, ENFORCE);
    checkT("fuzzy match unverifiable PR → park", err.decision === "park_verify_failed");
  }
  {
    // incoming hash discovered from the ticket's own prior ledger rows
    const path = join(sandbox, "ledger-ownhash.jsonl");
    appendRow({ ticket_id: "OTHER", identifier: "ZOU-24", execution_id: "eO", stage: "seed", seed_hash: "HO", ts: hoursAgo(4), flags: SHADOW }, path);
    appendRow({ ticket_id: "ME", identifier: "ZOU-25", execution_id: "eM", stage: "pr", pr_number: 400, seed_hash: "HO", ts: hoursAgo(3), flags: SHADOW }, path);
    const idx = deriveIndex(path);
    const d = await decideDedup({ ticket_id: "ME", identifier: "ZOU-25" }, idx, probeOf({ "pr:400": "merged", "issue:OTHER": "open" }), NOW, ENFORCE);
    checkT("own prior seed_hash used when caller supplies none", d.decision === "skip_duplicate" && d.layer === "fuzzy");
  }

  // ─── 5. decision log + snapshot ──────────────────────────────────────────
  section("5. decision log + sf006Snapshot");
  {
    process.env.SF006_LEDGER_PATH = join(sandbox, "snap", "ledger.jsonl");
    process.env.SF006_DEDUP = "1";
    delete process.env.SF006_ENFORCE;
    appendRow({ ticket_id: "S1", identifier: "ZOU-30", execution_id: "eS", stage: "seed", seed_hash: "HS", ts: hoursAgo(1), flags: SHADOW });
    const mkDecision = (decision: DedupDecision["decision"], acted: boolean): DedupDecision => ({
      decision,
      layer: decision === "proceed" ? "none" : "exact",
      reason: "selftest",
      acted,
      probes: [],
    });
    logDecision("S1", "ZOU-30", mkDecision("proceed", false));
    logDecision("S1", "ZOU-30", mkDecision("skip_duplicate", false));
    logDecision("S1", "ZOU-30", mkDecision("resume_from_checkpoint", false));
    logDecision("S1", "ZOU-30", mkDecision("park_verify_failed", true));
    const decisions = readDecisions();
    checkT("decision log round-trips", decisions.length === 4 && decisions[3].decision === "park_verify_failed");
    const snap = sf006Snapshot();
    checkT("snapshot ledger depth", snap.ledger_rows === 1 && snap.ledger_tickets === 1);
    checkT(
      "snapshot decisions by type",
      snap.decisions_by_type.proceed === 1 && snap.decisions_by_type.skip_duplicate === 1 &&
        snap.decisions_by_type.resume_from_checkpoint === 1 && snap.decisions_by_type.park_verify_failed === 1,
    );
    checkT("snapshot splits shadow vs enforced", snap.shadow_would.would_skip === 1 && snap.shadow_would.would_resume === 1 && snap.enforced.parked === 1);
    checkT("snapshot flags reflect env", snap.dedup_enabled === true && snap.enforce_enabled === false);
  }

  // ─── 6. flags-off identity ───────────────────────────────────────────────
  section("6. flags-off identity (both flags off = byte-identical)");
  {
    const offLedger = join(sandbox, "off-ledger.jsonl");
    const ticketsPath = join(sandbox, "tickets.json");
    writeFileSync(
      ticketsPath,
      JSON.stringify([
        {
          linear_id: "dddd1111-2222-3333-4444-555566667777",
          identifier: "ZOU-991",
          title: "SF006 selftest identity ticket",
          description: "**archetype:** feature\n**target_repo:** Projects/zouroboros-software-factory\n\n## Acceptance Criteria\n- selftest only",
          url: "https://linear.app/x",
          state: "factory-ready",
          labels: [],
          created_at: "2026-07-02T10:00:00Z",
          updated_at: "2026-07-02T10:00:00Z",
        },
      ]),
    );
    const env = { ...process.env, FACTORY_STATE_DIR: sandbox, SF006_LEDGER_PATH: offLedger, SF006_DEDUP: "0", SF002_CLASSIFY: "0", SF005_SLO: "0" };
    delete (env as Record<string, string | undefined>).SF006_ENFORCE;

    const d1 = spawnSync("bun", [join(SCRIPT_DIR, "dispatcher.ts"), "--tickets", ticketsPath, "--dry-run"], { encoding: "utf-8", env });
    const d2 = spawnSync("bun", [join(SCRIPT_DIR, "dispatcher.ts"), "--tickets", ticketsPath, "--dry-run"], { encoding: "utf-8", env });
    checkT("dispatcher off-runs exit 0", d1.status === 0 && d2.status === 0);
    checkT("dispatcher off-runs byte-identical", d1.stdout === d2.stdout && d1.stderr === d2.stderr);
    checkT("dispatcher off output carries no dedup field", !d1.stdout.includes('"dedup"'));

    const dispatchPath = join(sandbox, "dispatch.json");
    writeFileSync(dispatchPath, d1.stdout);
    const norm = (s: string) => s
      .replace(/exec-[0-9a-f]{8}/g, "exec-X")
      .replace(/"(started_at|completed_at|state_updated_at|recorded_at)": "[^"]*"/g, '"$1": "T"');
    const e1 = spawnSync("bun", [join(SCRIPT_DIR, "swarm-exec.ts"), "--dispatch", dispatchPath, "--dry-run"], { encoding: "utf-8", env });
    const e2 = spawnSync("bun", [join(SCRIPT_DIR, "swarm-exec.ts"), "--dispatch", dispatchPath, "--dry-run"], { encoding: "utf-8", env });
    checkT("swarm-exec off-runs exit 0", e1.status === 0 && e2.status === 0);
    checkT("swarm-exec off-runs identical (modulo random ids/ts)", norm(e1.stdout) === norm(e2.stdout) && norm(e1.stderr) === norm(e2.stderr));
    checkT("no [sf006] output when flags off", !`${e1.stdout}${e1.stderr}${d1.stderr}`.includes("[sf006]"));
    checkT("flags off create no ledger or decision log", !existsSync(offLedger) && !existsSync(join(sandbox, "dedup-decisions.jsonl")));
  }
  {
    // shadow run against the same sandbox: ledger rows appear, routing unchanged
    const shadowLedger = join(sandbox, "shadow", "ledger.jsonl");
    const ticketsPath = join(sandbox, "tickets.json");
    const env = { ...process.env, FACTORY_STATE_DIR: sandbox, SF006_LEDGER_PATH: shadowLedger, SF002_CLASSIFY: "0", SF005_SLO: "0" };
    delete (env as Record<string, string | undefined>).SF006_DEDUP;
    delete (env as Record<string, string | undefined>).SF006_ENFORCE;
    const d = spawnSync("bun", [join(SCRIPT_DIR, "dispatcher.ts"), "--tickets", ticketsPath, "--dry-run"], { encoding: "utf-8", env });
    const dispatchPath = join(sandbox, "dispatch-shadow.json");
    writeFileSync(dispatchPath, d.stdout);
    const e = spawnSync("bun", [join(SCRIPT_DIR, "swarm-exec.ts"), "--dispatch", dispatchPath, "--dry-run"], { encoding: "utf-8", env });
    checkT("shadow runs exit 0", d.status === 0 && e.status === 0);
    checkT("shadow dispatcher attaches dedup decision", d.stdout.includes('"dedup"') && d.stdout.includes('"proceed"'));
    const rows = existsSync(shadowLedger) ? readFileSync(shadowLedger, "utf-8").trim().split("\n") : [];
    checkT("shadow swarm-exec appends decision checkpoint", rows.length === 1 && rows[0].includes('"stage":"decision"'));
    const d3 = spawnSync("bun", [join(SCRIPT_DIR, "dispatcher.ts"), "--tickets", ticketsPath, "--dry-run"], { encoding: "utf-8", env });
    checkT("shadow re-run logs would-resume and still routes", d3.status === 0 && d3.stderr.includes("would-resume") && d3.stdout.includes('"decision": "DIRECT"'));
  }

  // ─── 7. wiring guards ────────────────────────────────────────────────────
  section("7. wiring guards");
  {
    const dispatcherSrc = readFileSync(join(SCRIPT_DIR, "dispatcher.ts"), "utf-8");
    checkT("dispatcher gates dedup on currentFlags().dedup", dispatcherSrc.includes("sf006.dedup"));
    checkT("dispatcher enforce skip/park is terminal (continue)", dispatcherSrc.includes("continue; // terminal no-op"));
    checkT("dispatcher posts Linear comment on enforce skip/park", dispatcherSrc.includes("postDedupComment(ticket.linear_id, dedup)"));
    checkT("dispatcher enforce rethrows on broken gate (fail-loud)", dispatcherSrc.includes("if (flags.enforce) throw err;"));

    const swarmSrc = readFileSync(join(SCRIPT_DIR, "swarm-exec.ts"), "utf-8");
    checkT("swarm-exec checkpoint gated on SF006_DEDUP", swarmSrc.includes('if (process.env.SF006_DEDUP === "0") return;'));
    checkT("swarm-exec resume reuses matched execution id", swarmSrc.includes("resume?.matched_execution_id ??"));
    checkT("swarm-exec resume skips re-appending earlier checkpoints", swarmSrc.indexOf("earlier checkpoints not re-appended") > 0);
    checkT("swarm-exec checkpoints only proven implementation completion", swarmSrc.includes('sf006Checkpoint(exec, "execute")') && !swarmSrc.includes('sf006Checkpoint(exec, "post-flight")'));
    checkT("swarm-exec appends pr checkpoint when PR known", swarmSrc.includes('if (exec.pr_number !== null) sf006Checkpoint(exec, "pr")'));

    const gateSrc = readFileSync(join(SCRIPT_DIR, "dedup-gate.ts"), "utf-8");
    checkT("core has no live probe calls (execSync only in realProbe boundary)", gateSrc.indexOf("execSync(") > gateSrc.indexOf("// ─── Real probes"));

    // consensus cg-1783001607502-2yhosx regression locks
    checkT("both Linear fetches carry an abort timeout", (gateSrc.match(/AbortSignal\.timeout\(15_000\)/g) ?? []).length === 2);
    checkT("PR probe rejects non-numeric refs strictly", gateSrc.includes('if (!/^\\d+$/.test(ref)) return "error";'));
    checkT("Linear comment collapses whitespace in ledger-sourced values", gateSrc.includes("oneLine(d.reason)") && gateSrc.includes("oneLine(d.matched_execution_id)"));
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`SF-006 dedup self-test: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  if (savedLedgerPath === undefined) delete process.env.SF006_LEDGER_PATH;
  else process.env.SF006_LEDGER_PATH = savedLedgerPath;
  if (savedDedup === undefined) delete process.env.SF006_DEDUP;
  else process.env.SF006_DEDUP = savedDedup;
  if (savedEnforce === undefined) delete process.env.SF006_ENFORCE;
  else process.env.SF006_ENFORCE = savedEnforce;
  rmSync(sandbox, { recursive: true, force: true });
}
