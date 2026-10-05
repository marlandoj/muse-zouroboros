#!/usr/bin/env bun
/**
 * T4 (SF-005) — SLO Self-Test Harness
 *
 * Fully sandboxed: every fixture lives in a mkdtemp dir (config, factory log,
 * slo state, status md, watchdog state). Real state/, evaluations/, and
 * slo-config.json are never read or written. Sandbox removed in finally.
 *
 * Sections:
 *   1. config validation (fail-loud)
 *   2. evaluation math (boundaries, min-sample guard, windowing, denominators)
 *   3. state transitions (baseline, persistence, review, reset, recovery)
 *   4. lane-block decision matrix
 *   5. check() end-to-end (transitions, md write-on-change, corrupt rebaseline)
 *   6. watchdog integration (real watchdog.ts spawned against the sandbox md)
 *   7. flags-off no-op + wiring guards
 *
 * Exit 0 = all green.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyEvaluations,
  applyReview,
  autoApprovalError,
  certificationLaneBlockDecision,
  check,
  evaluateSlos,
  laneBlockDecision,
  loadSloConfig,
  parseSloConfig,
  readSloStateFile,
  renderStatusMd,
  review,
  SloConfigError,
  windowRecords,
  type SloConfig,
  type SloSources,
  type SloState,
} from "./factory-slo";
import type { FactoryRecord } from "./factory-collect";

const SCRIPT_DIR = import.meta.dir;
// Resolve the watchdog inside this checkout. A hardcoded /home/workspace path made
// the probe read whatever the live workspace happened to hold, so a stale branch
// checkout there failed a release-bound runtime that contained the correct code.
const WATCHDOG = join(SCRIPT_DIR, "..", "..", "..", "Skills", "build-watchdog", "scripts", "watchdog.ts");
if (!existsSync(WATCHDOG)) {
  console.error(`slo-selftest: watchdog not found in this checkout at ${WATCHDOG}`);
  process.exit(1);
}
const NOW = "2026-07-02T12:00:00.000Z";
const IN_WINDOW = "2026-07-02T10:00:00.000Z";
const OUT_OF_WINDOW = "2026-06-01T10:00:00.000Z";

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_CONFIG: SloConfig = {
  version: 1,
  slos: {
    cycle_time: { enabled: true, threshold: 24, min_samples: 3, window_days: 7 },
    yield_floor: { enabled: true, threshold: 0.5, min_samples: 5, window_days: 7 },
    auto_approval_error: { enabled: true, threshold: 0.1, min_samples: 5, window_days: 7 },
  },
};

let seq = 0;
function mkRecord(overrides: Partial<FactoryRecord> = {}): FactoryRecord {
  seq++;
  return {
    execution_id: `exec-t${seq}`,
    kind: "execution",
    ticket_id: `TK-${seq}`,
    identifier: `ZOU-${seq}`,
    gate_decision: "DIRECT",
    shadow_phase: "dry-run",
    status: "complete",
    stages: { decision: IN_WINDOW, seed: null, execute: IN_WINDOW, postflight: IN_WINDOW, pr: null },
    verdict_ref: null,
    measured: true,
    verdict: { verdict: "pass", rework: false },
    cycle_time_hours: null,
    collected_at: NOW,
    ...overrides,
  };
}

function firstPassSet(pass: number, nonFirstPass: number): FactoryRecord[] {
  const out: FactoryRecord[] = [];
  for (let i = 0; i < pass; i++) out.push(mkRecord());
  for (let i = 0; i < nonFirstPass; i++) out.push(mkRecord({ verdict: { verdict: "pass", rework: true } }));
  return out;
}

function writeLog(path: string, records: FactoryRecord[]): void {
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const sandbox = mkdtempSync(join(tmpdir(), "slo-selftest-"));

function mkSources(name: string, config: SloConfig | string = VALID_CONFIG): SloSources {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "slo-config.json");
  writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return {
    configPath,
    logPath: join(dir, "factory-log.jsonl"),
    statePath: join(dir, "slo-state.json"),
    statusMdPath: join(dir, "slo-status.md"),
  };
}

function runWatchdog(sources: SloSources): { notify: boolean; reason: string; complete: boolean } {
  const res = spawnSync("bun", [WATCHDOG, "--progress", sources.statusMdPath, "--label", "SLO-test", "--stall-min", "0"], {
    encoding: "utf-8",
  });
  return JSON.parse(res.stdout);
}

try {
  // ─── 1. Config validation ──────────────────────────────────────────────────
  section("1. config validation (fail-loud)");

  checkT("valid config parses", parseSloConfig(JSON.stringify(VALID_CONFIG)).version === 1);

  const badConfigs: Array<[string, string]> = [
    ["not JSON", "{nope"],
    ["wrong version", JSON.stringify({ ...VALID_CONFIG, version: 2 })],
    ["missing slo key", JSON.stringify({ version: 1, slos: { cycle_time: VALID_CONFIG.slos.cycle_time } })],
    [
      "unknown slo key",
      JSON.stringify({ version: 1, slos: { ...VALID_CONFIG.slos, latency: { enabled: true, threshold: 1, min_samples: 1, window_days: 7 } } }),
    ],
    [
      "yield_floor threshold out of [0,1]",
      JSON.stringify({ version: 1, slos: { ...VALID_CONFIG.slos, yield_floor: { enabled: true, threshold: 1.5, min_samples: 5, window_days: 7 } } }),
    ],
    [
      "min_samples 0",
      JSON.stringify({ version: 1, slos: { ...VALID_CONFIG.slos, cycle_time: { enabled: true, threshold: 24, min_samples: 0, window_days: 7 } } }),
    ],
    [
      "negative window_days",
      JSON.stringify({ version: 1, slos: { ...VALID_CONFIG.slos, cycle_time: { enabled: true, threshold: 24, min_samples: 3, window_days: -1 } } }),
    ],
  ];
  for (const [name, text] of badConfigs) {
    let threw = false;
    try {
      parseSloConfig(text);
    } catch (err) {
      threw = err instanceof SloConfigError;
    }
    checkT(`rejects ${name}`, threw);
  }

  {
    const s = mkSources("cfg-corrupt", "{nope");
    let threw = false;
    try {
      check(s, { now: NOW });
    } catch (err) {
      threw = err instanceof SloConfigError;
    }
    checkT("check() with corrupt config throws before any write", threw && !existsSync(s.statePath) && !existsSync(s.statusMdPath));
  }

  // ─── 2. Evaluation math ────────────────────────────────────────────────────
  section("2. evaluation math");

  {
    // yield exactly at floor: 3 first-pass / 6 measured = 0.5 ≥ 0.5 → ok
    const evals = evaluateSlos(firstPassSet(3, 3), VALID_CONFIG, NOW);
    checkT("yield exactly at floor = ok (≥)", evals.yield_floor?.status === "ok", JSON.stringify(evals.yield_floor));
    // just below: 2/5 = 0.4 → breach
    const evals2 = evaluateSlos(firstPassSet(2, 3), VALID_CONFIG, NOW);
    checkT("yield below floor = breach", evals2.yield_floor?.status === "breach" && evals2.yield_floor.value === 0.4);
  }
  {
    // cycle time boundary: mean exactly 24 → ok; above → breach
    const at = [mkRecord({ cycle_time_hours: 24 }), mkRecord({ cycle_time_hours: 24 }), mkRecord({ cycle_time_hours: 24 })];
    checkT("cycle exactly at threshold = ok (≤)", evaluateSlos(at, VALID_CONFIG, NOW).cycle_time?.status === "ok");
    const over = [mkRecord({ cycle_time_hours: 25 }), mkRecord({ cycle_time_hours: 25 }), mkRecord({ cycle_time_hours: 25 })];
    checkT("cycle above threshold = breach", evaluateSlos(over, VALID_CONFIG, NOW).cycle_time?.status === "breach");
    checkT("cycle 2 samples < min 3 = insufficient_data", evaluateSlos(over.slice(0, 2), VALID_CONFIG, NOW).cycle_time?.status === "insufficient_data");
  }
  {
    // error rate boundary: 1 fail / 10 = 0.1 ≤ 0.1 → ok; 2/10 → breach
    const mk = (fails: number, total: number) => {
      const recs: FactoryRecord[] = [];
      for (let i = 0; i < total; i++) {
        recs.push(mkRecord({ verdict: { verdict: i < fails ? "fail" : "pass", rework: false } }));
      }
      return recs;
    };
    checkT("error exactly at threshold = ok (≤)", evaluateSlos(mk(1, 10), VALID_CONFIG, NOW).auto_approval_error?.status === "ok");
    checkT("error above threshold = breach", evaluateSlos(mk(2, 10), VALID_CONFIG, NOW).auto_approval_error?.status === "breach");
  }
  {
    // min-sample guard: 4 measured ALL FAIL — would be catastrophic, still insufficient
    const recs = [0, 1, 2, 3].map(() => mkRecord({ verdict: { verdict: "fail", rework: true } }));
    const evals = evaluateSlos(recs, VALID_CONFIG, NOW);
    checkT("yield n=4 < min 5 NEVER breaches even at 0% yield", evals.yield_floor?.status === "insufficient_data");
    checkT("error n=4 < min 5 NEVER breaches even at 100% fail", evals.auto_approval_error?.status === "insufficient_data");
  }
  {
    // windowing
    const recs = [
      mkRecord(),
      mkRecord({ stages: { decision: OUT_OF_WINDOW, seed: null, execute: OUT_OF_WINDOW, postflight: OUT_OF_WINDOW, pr: null } }),
      mkRecord({ stages: { decision: "unknown", seed: null, execute: "unknown", postflight: "unknown", pr: null } }),
    ];
    const windowed = windowRecords(recs, 7, NOW);
    checkT("window keeps in-window unit, drops stale unit", windowed.length === 1 && windowed[0].execution_id === recs[0].execution_id);
    checkT("undatable unit (all stamps unknown) excluded from window", !windowed.some((r) => r.execution_id === recs[2].execution_id));
  }
  {
    // error-rate denominators
    const recs = [
      mkRecord({ verdict: { verdict: "fail", rework: false } }), // counts: auto-approved measured fail
      mkRecord({ measured: false, verdict: null }), // unmeasured — excluded both sides
      mkRecord({ status: "held", verdict: { verdict: "fail", rework: false } }), // held — not auto-approved
      mkRecord({ gate_decision: "unknown", verdict: { verdict: "fail", rework: false } }), // not gate-classified
      mkRecord(), // pass
    ];
    const { value, denominator } = autoApprovalError(recs);
    checkT("error denominator = measured auto-approved only (2)", denominator === 2, `got ${denominator}`);
    checkT("error value = 1/2", value === 0.5, `got ${value}`);
  }
  {
    const cfg: SloConfig = { ...VALID_CONFIG, slos: { ...VALID_CONFIG.slos, cycle_time: { ...VALID_CONFIG.slos.cycle_time, enabled: false } } };
    const evals = evaluateSlos(firstPassSet(3, 3), cfg, NOW);
    checkT("disabled slo omitted from evaluations", !("cycle_time" in evals) && evals.yield_floor !== undefined);
  }

  // ─── 3. State transitions ──────────────────────────────────────────────────
  section("3. state transitions");

  {
    const okEvals = evaluateSlos(firstPassSet(4, 2), VALID_CONFIG, NOW); // 4/6 = 0.667 ok
    const breachEvals = evaluateSlos(firstPassSet(2, 4), VALID_CONFIG, NOW); // 2/6 = 0.333 breach

    const base = applyEvaluations(null, okEvals, NOW);
    checkT("baseline emits one transition per enabled slo (from ∅)", base.newTransitions.length === 3 && base.newTransitions.every((t) => t.from === null));

    const same = applyEvaluations(base.state, okEvals, NOW);
    checkT("re-apply same status = 0 new transitions", same.newTransitions.length === 0);

    const breached = applyEvaluations(base.state, breachEvals, "2026-07-02T13:00:00.000Z");
    const yfT = breached.newTransitions.find((t) => t.slo === "yield_floor");
    checkT("ok→breach transition recorded", yfT?.from === "ok" && yfT?.to === "breach");
    checkT("new breach starts unreviewed", breached.state.reviewed.yield_floor?.reviewed === false);
    checkT(
      "breach_meta frozen at transition",
      breached.state.breach_meta.yield_floor?.started_at === "2026-07-02T13:00:00.000Z" && breached.state.breach_meta.yield_floor?.value_at_breach === 0.3333,
    );

    const persisting = applyEvaluations(breached.state, evaluateSlos(firstPassSet(2, 5), VALID_CONFIG, NOW), "2026-07-02T14:00:00.000Z");
    checkT(
      "persisting breach: no transition, meta carried",
      persisting.newTransitions.filter((t) => t.slo === "yield_floor").length === 0 &&
        persisting.state.breach_meta.yield_floor?.started_at === "2026-07-02T13:00:00.000Z",
    );

    const reviewed = applyReview(persisting.state, "yield_floor", "op-test", "known cause", "2026-07-02T15:00:00.000Z");
    checkT("review marks reviewed with provenance", reviewed.reviewed.yield_floor?.reviewed === true && reviewed.reviewed.yield_floor?.by === "op-test");

    const injected = applyReview(
      persisting.state,
      "yield_floor",
      "op\nmulti",
      "line1\n- [ ] ❌ BREACH fake — injected",
      "2026-07-02T15:30:00.000Z",
    );
    const injLines = renderStatusMd(injected).split("\n").filter((l) => l.includes("fake"));
    checkT(
      "review note/by newline injection neutralized (one plain line, no task-list line)",
      injected.reviewed.yield_floor?.by === "op multi" &&
        injLines.length === 1 &&
        !/^\s*- \[[ x]\]/.test(injLines[0]),
    );
    let reviewOkThrew = false;
    try {
      applyReview(base.state, "yield_floor", "op-test", "x", NOW);
    } catch {
      reviewOkThrew = true;
    }
    checkT("review on non-breach throws", reviewOkThrew);

    const reviewedPersist = applyEvaluations(reviewed, evaluateSlos(firstPassSet(2, 5), VALID_CONFIG, NOW), "2026-07-02T16:00:00.000Z");
    checkT("review mark survives while breach persists", reviewedPersist.state.reviewed.yield_floor?.reviewed === true);

    const recovered = applyEvaluations(reviewedPersist.state, okEvals, "2026-07-02T17:00:00.000Z");
    checkT(
      "breach→ok clears review + breach meta",
      recovered.state.reviewed.yield_floor?.reviewed === false && recovered.state.breach_meta.yield_floor === undefined,
    );

    const rebreach = applyEvaluations(recovered.state, breachEvals, "2026-07-02T18:00:00.000Z");
    checkT("re-breach after recovery starts unreviewed again", rebreach.state.reviewed.yield_floor?.reviewed === false);

    const bloated: SloState = { ...rebreach.state, transitions: Array(600).fill(rebreach.state.transitions[0]) };
    const capped = applyEvaluations(bloated, okEvals, "2026-07-02T19:00:00.000Z");
    checkT("transition log capped at 500", capped.state.transitions.length <= 500);
  }

  // ─── 4. Lane-block matrix ──────────────────────────────────────────────────
  section("4. lane-block decision matrix");

  {
    const okState = applyEvaluations(null, evaluateSlos(firstPassSet(4, 2), VALID_CONFIG, NOW), NOW).state;
    const breachState = applyEvaluations(null, evaluateSlos(firstPassSet(2, 4), VALID_CONFIG, NOW), NOW).state;
    const insufficientState = applyEvaluations(null, evaluateSlos(firstPassSet(2, 1), VALID_CONFIG, NOW), NOW).state;
    const reviewedState = applyReview(breachState, "yield_floor", "op", "seen", NOW);
    const disabledCfg: SloConfig = { ...VALID_CONFIG, slos: { ...VALID_CONFIG.slos, yield_floor: { ...VALID_CONFIG.slos.yield_floor, enabled: false } } };
    const noYfState = applyEvaluations(null, evaluateSlos(firstPassSet(2, 4), disabledCfg, NOW), NOW).state;

    checkT("absent state → not blocked", laneBlockDecision(null).blocked === false);
    checkT("corrupt state → blocked (fail-closed)", laneBlockDecision("corrupt").blocked === true);
    checkT("yield ok → not blocked", laneBlockDecision(okState).blocked === false);
    checkT("yield insufficient_data → not blocked", laneBlockDecision(insufficientState).blocked === false);
    checkT("yield breach unreviewed → BLOCKED", laneBlockDecision(breachState).blocked === true);
    checkT("yield breach reviewed → not blocked", laneBlockDecision(reviewedState).blocked === false);
    checkT("yield_floor disabled → not blocked", laneBlockDecision(noYfState).blocked === false);
    checkT("certification absent state → blocked", certificationLaneBlockDecision(null, NOW).blocked === true);
    checkT("certification corrupt state → blocked", certificationLaneBlockDecision("corrupt", NOW).blocked === true);
    checkT("certification insufficient yield → blocked", certificationLaneBlockDecision(insufficientState, NOW).blocked === true);
    checkT("certification reviewed breach → blocked", certificationLaneBlockDecision(reviewedState, NOW).blocked === true);
    checkT("certification disabled yield → blocked", certificationLaneBlockDecision(noYfState, NOW).blocked === true);
    checkT("certification current ok yield → not blocked", certificationLaneBlockDecision(okState, NOW).blocked === false);
    checkT(
      "certification stale state → blocked",
      certificationLaneBlockDecision(okState, "2026-07-04T12:00:00.000Z").blocked === true,
    );

    const s = mkSources("reader");
    checkT("readSloStateFile absent → null", readSloStateFile(s.statePath) === null);
    writeFileSync(s.statePath, "{torn");
    checkT("readSloStateFile invalid JSON → corrupt", readSloStateFile(s.statePath) === "corrupt");
    writeFileSync(s.statePath, JSON.stringify({ version: 9 }));
    checkT("readSloStateFile wrong shape → corrupt", readSloStateFile(s.statePath) === "corrupt");
    const nestedBad = JSON.parse(JSON.stringify(okState));
    nestedBad.evaluations.yield_floor = "garbage";
    writeFileSync(s.statePath, JSON.stringify(nestedBad));
    checkT("readSloStateFile malformed nested evaluation → corrupt (fail-closed, never fail-open)", readSloStateFile(s.statePath) === "corrupt");
    const badMark = JSON.parse(JSON.stringify(okState));
    badMark.reviewed.yield_floor = { reviewed: "yes" };
    writeFileSync(s.statePath, JSON.stringify(badMark));
    checkT("readSloStateFile malformed review mark → corrupt", readSloStateFile(s.statePath) === "corrupt");
    writeFileSync(s.statePath, JSON.stringify(okState));
    const roundtrip = readSloStateFile(s.statePath);
    checkT("readSloStateFile valid roundtrip", roundtrip !== null && roundtrip !== "corrupt" && roundtrip.evaluations.yield_floor?.status === "ok");
  }

  // ─── 5. check() end-to-end ─────────────────────────────────────────────────
  section("5. check() end-to-end in sandbox");

  const e2e = mkSources("e2e");
  {
    writeLog(e2e.logPath, firstPassSet(5, 1)); // 5/6 = 0.833 ok; others insufficient
    const r1 = check(e2e, { now: NOW });
    checkT("first check writes state + md", existsSync(e2e.statePath) && existsSync(e2e.statusMdPath) && r1.md_written);
    checkT("first check: yield ok, lane open", r1.state.evaluations.yield_floor?.status === "ok" && !r1.lane.blocked);
    const mutationRoot = join(dirname(e2e.statePath), "state-mutation-evidence");
    checkT("off mode creates no SLO mutation evidence", !existsSync(mutationRoot));

    const laneLog = join(dirname(e2e.statePath), "lane-utilization.jsonl");
    writeFileSync(`${laneLog}.current-cycle`, "cycle-slo-1\n");
    writeFileSync(laneLog, `${JSON.stringify({ cycle_id: "cycle-slo-1", phase: "open", ts: NOW })}\n`);
    process.env.FACTORY_STATE_MUTATION_EVIDENCE = "shadow";
    const r2 = check(e2e, { now: "2026-07-02T12:30:00.000Z" });
    checkT("unchanged re-check: 0 transitions, md NOT rewritten", r2.newTransitions.length === 0 && r2.md_written === false);
    let mutationReceipts = readdirSync(mutationRoot)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(mutationRoot, name), "utf8")));
    checkT(
      "shadow replacement emits exact scheduled SLO receipt",
      mutationReceipts.length === 1 &&
        mutationReceipts[0].scope === "scheduled-cycle" &&
        mutationReceipts[0].producer_id === "factory-slo" &&
        mutationReceipts[0].target_schema === "slo-state/v1",
    );

    writeLog(e2e.logPath, firstPassSet(2, 4)); // 0.333 breach
    writeFileSync(laneLog, [
      JSON.stringify({ cycle_id: "cycle-slo-1", phase: "open", ts: NOW }),
      JSON.stringify({ cycle_id: "cycle-slo-1", phase: "outcome", ts: "2026-07-02T12:45:00.000Z" }),
      "",
    ].join("\n"));
    const r3 = check(e2e, { now: "2026-07-02T13:00:00.000Z" });
    checkT("breach check: transition + lane BLOCKED + md rewritten", r3.newTransitions.some((t) => t.to === "breach") && r3.lane.blocked && r3.md_written);
    mutationReceipts = readdirSync(mutationRoot)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(mutationRoot, name), "utf8")));
    checkT(
      "closed-cycle SLO writer is separated into background scope",
      mutationReceipts.some((receipt) => receipt.scope === "background" && receipt.binding.reason?.includes("unmatched open row")),
    );
    process.env.FACTORY_STATE_MUTATION_EVIDENCE = "off";
    const breachStatus = readFileSync(e2e.statusMdPath, "utf-8");
    checkT("breach line present with frozen value", breachStatus.includes("❌ BREACH yield_floor — 0.3333"));
    checkT("unreviewed lane breach uses the watchdog's canonical blocker syntax", breachStatus.includes("BLOCKED: yield_floor breach unreviewed"));

    const r4 = check(e2e, { now: "2026-07-02T14:00:00.000Z" });
    checkT("persisting breach: md stable (frozen breach line)", r4.md_written === false && r4.newTransitions.length === 0);

    review(e2e, "yield_floor", "op-e2e", "capacity issue known");
    const postReview = readSloStateFile(e2e.statePath);
    checkT(
      "review persists + lane opens while breach persists",
      postReview !== null && postReview !== "corrupt" && laneBlockDecision(postReview).blocked === false,
    );
    const reviewedStatus = readFileSync(e2e.statusMdPath, "utf-8");
    checkT("review renders plain line and clears the canonical blocker", reviewedStatus.includes("reviewed by op-e2e") && !reviewedStatus.includes("BLOCKED:"));

    writeLog(e2e.logPath, firstPassSet(5, 1));
    const r5 = check(e2e, { now: "2026-07-02T15:00:00.000Z" });
    checkT("recovery: breach→ok transition, lane open", r5.newTransitions.some((t) => t.from === "breach" && t.to === "ok") && !r5.lane.blocked);

    writeFileSync(e2e.statePath, "{corrupt");
    const r6 = check(e2e, { now: "2026-07-02T16:00:00.000Z" });
    checkT("corrupt state rebaselines with warning", r6.warnings.length === 1 && r6.state.evaluations.yield_floor?.status === "ok");
  }

  // ─── 6. Watchdog integration (real watchdog.ts) ────────────────────────────
  section("6. watchdog integration (spawned)");

  const wd = mkSources("watchdog");
  {
    writeLog(wd.logPath, firstPassSet(5, 1));
    check(wd, { now: NOW });
    const v1 = runWatchdog(wd);
    checkT("first run = silent BASELINE", v1.reason === "BASELINE" && v1.notify === false);
    const v2 = runWatchdog(wd);
    checkT("no change = SILENT", v2.reason === "SILENT" && v2.notify === false);

    writeLog(wd.logPath, firstPassSet(2, 4));
    check(wd, { now: "2026-07-02T13:00:00.000Z" });
    const v3 = runWatchdog(wd);
    checkT("new breach = BLOCKER notify:true (exactly once)", v3.reason === "BLOCKER" && v3.notify === true);
    const v4 = runWatchdog(wd);
    checkT("persisting breach = SILENT (no re-notify)", v4.notify === false, v4.reason);

    review(wd, "yield_floor", "op-wd", "acknowledged");
    const v5 = runWatchdog(wd);
    checkT("review clears the blocker with one recovery notification", v5.notify === true && v5.reason === "RECOVERY", v5.reason);

    writeLog(wd.logPath, firstPassSet(5, 1));
    check(wd, { now: "2026-07-02T15:00:00.000Z" });
    const v6 = runWatchdog(wd);
    checkT("metric recovery emits its own status-change notification", v6.notify === true && v6.reason === "SCOPE", v6.reason);
    checkT("standing sentinel prevents COMPLETE on all-ok", v6.complete === false);
    const v7 = runWatchdog(wd);
    checkT("post-recovery steady state = SILENT", v7.notify === false);
  }

  // ─── 7. Flags-off no-op + wiring guards ────────────────────────────────────
  section("7. flags-off + wiring guards");

  {
    const env = { ...process.env };
    delete env.SF005_SLO;
    const projectStateDir = join(SCRIPT_DIR, "..", "state");
    const before = {
      state: existsSync(join(projectStateDir, "slo-state.json")),
      md: existsSync(join(projectStateDir, "slo-status.md")),
    };
    const res = spawnSync("bun", [join(SCRIPT_DIR, "factory-slo.ts"), "tick"], { encoding: "utf-8", env });
    const after = {
      state: existsSync(join(projectStateDir, "slo-state.json")),
      md: existsSync(join(projectStateDir, "slo-status.md")),
    };
    checkT("tick without SF005_SLO exits 0", res.status === 0);
    checkT("tick without flag prints nothing", res.stdout === "" && res.stderr === "");
    checkT("tick without flag creates no slo files", before.state === after.state && before.md === after.md);
  }
  {
    const src = readFileSync(join(SCRIPT_DIR, "swarm-exec.ts"), "utf-8");
    checkT("swarm-exec lane check gated on SF005_SLO", src.includes('process.env.SF005_SLO === "1"'));
    checkT("swarm-exec lane default = not blocked when flag off", src.includes('{ blocked: false, reason: "SF005_SLO off" }'));
    const sloSrc = readFileSync(join(SCRIPT_DIR, "factory-slo.ts"), "utf-8");
    const guardFirst = sloSrc.indexOf('process.env.SF005_SLO !== "1"') < sloSrc.indexOf("check(defaultSloSources())");
    checkT("tick flag guard precedes any I/O in source order", guardFirst);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(50)}`);
  console.log(`SLO self-test: ${passed}/${passed + failed} passed`);
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  process.exit(0);
} finally {
  delete process.env.FACTORY_STATE_MUTATION_EVIDENCE;
  rmSync(sandbox, { recursive: true, force: true });
}
