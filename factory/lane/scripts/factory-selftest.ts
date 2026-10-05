#!/usr/bin/env bun
/**
 * T6 (SF-004) — Factory Metrics Self-Test
 *
 * Fully sandboxed: synthetic exec records, verdict sidecars, seed files,
 * approval ledger and pool state live in a throwaway temp dir injected via
 * CollectorSources (+ SF003_POOL_STATE_DIR for the pool reader). Nothing under
 * the real state/ or evaluations/ is read or written.
 *
 * Proves the SF-004 honesty invariants:
 *   1. collector idempotency — double-collect with no new artifacts appends 0
 *   2. unmeasured-never-passed — no sidecar ⇒ measured=false, excluded from yield
 *   3. yield / rework / gate math with explicit denominators (null on empty)
 *   4. unknown-stage honesty — pre-instrumentation stamps stay "unknown"
 *   5. supersede-on-material-change — late sidecar appends exactly one new row
 *   6. flags-off no-op — `tick` without SF004_METRICS=1 writes nothing
 *
 * Exit 0 = all green.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeVerdict } from "./factory-verdict";
import {
  collect,
  collectOutcomeEvidenceForMode,
  readFactoryLog,
  type CollectorSources,
  type FactoryRecord,
} from "./factory-collect";
import { computeFactoryMetrics, latestActivity } from "./factory-metrics";

// ─── Tiny harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title}`);
}

// ─── Sandbox fixtures ─────────────────────────────────────────────────────────

const NOW = "2026-07-02T12:00:00.000Z";

function makeSandbox(): { sources: CollectorSources; root: string } {
  const root = mkdtempSync(join(tmpdir(), "sf004-selftest-"));
  const stateDir = join(root, "state");
  const evaluationsDir = join(root, "evaluations");
  const poolDir = join(root, "pool");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(evaluationsDir, { recursive: true });
  mkdirSync(poolDir, { recursive: true });
  process.env.SF003_POOL_STATE_DIR = poolDir; // pool reader sandboxed too
  return {
    root,
    sources: {
      stateDir,
      evaluationsDir,
      seedDir: root,
      ledgerPath: join(stateDir, "approval-ledger.jsonl"),
      logPath: join(stateDir, "factory-log.jsonl"),
    },
  };
}

function writeExec(
  stateDir: string,
  overrides: Partial<Record<string, unknown>> & { execution_id: string },
): void {
  const rec = {
    ticket_id: "ZOU-900",
    identifier: overrides.execution_id,
    gate_decision: "DIRECT",
    seed_path: null,
    stage: "done",
    branch_name: null,
    pr_number: null,
    shadow_phase: "live",
    started_at: "2026-07-01T10:00:00.000Z",
    completed_at: "2026-07-01T11:00:00.000Z",
    status: "completed",
    result_summary: null,
    error: null,
    ...overrides,
  };
  writeFileSync(join(stateDir, `exec-${rec.execution_id}.json`), JSON.stringify(rec, null, 2));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const { sources, root } = makeSandbox();
console.log(`SF-004 self-test — sandbox ${root}`);

try {
  // Fixture layout:
  //  exec-a: measured pass, no rework, full stamps incl. ledger decision + PR
  //  exec-b: measured pass + rework
  //  exec-c: measured fail
  //  exec-d: NO sidecar → unmeasured (the run most tempting to inflate)
  //  exec-e: held by the gate (status=held), unmeasured
  //  ticket sidecar tk-legacy: no exec/campaign claims it → ticket-level unit
  //  corrupt sidecar: must land in invalid_sidecars, never measured
  writeExec(sources.stateDir, { execution_id: "exec-a", pr_number: 42 });
  writeExec(sources.stateDir, { execution_id: "exec-b" });
  writeExec(sources.stateDir, { execution_id: "exec-c" });
  writeExec(sources.stateDir, {
    execution_id: "exec-d",
    repo_path: "/repo",
    executor_harness: "codex",
    first_pass_validation: {
      mode: "shadow",
      contract_path: "/state/first-pass-contracts/exec-d-cycle-0.json",
      contract_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ledger_record_id: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      verdict: "pass",
      validator_version: "validator-v1",
      errors: [],
    },
  });
  writeExec(sources.stateDir, { execution_id: "exec-e", gate_decision: "HOLD", status: "held" });

  writeFileSync(
    sources.ledgerPath,
    JSON.stringify({ verdict: { execution_id: "exec-a", classified_at: "2026-07-01T09:00:00.000Z" } }) + "\n" +
    "{torn line — must not abort collection\n",
  );

  const decidedAt = "2026-07-01T15:00:00.000Z";
  writeVerdict("exec-a", { ticket: "ZOU-900", execution_id: "exec-a", verdict: "pass", rework: false, evidence: "synthetic", decided_at: decidedAt }, { dir: sources.evaluationsDir });
  writeVerdict("exec-b", { ticket: "ZOU-900", execution_id: "exec-b", verdict: "pass", rework: true, evidence: "synthetic", decided_at: decidedAt }, { dir: sources.evaluationsDir });
  writeVerdict("exec-c", { ticket: "ZOU-900", execution_id: "exec-c", verdict: "fail", rework: false, evidence: "synthetic", decided_at: decidedAt }, { dir: sources.evaluationsDir });
  writeVerdict("tk-legacy", { ticket: "TK-LEGACY", execution_id: null, verdict: "pass", rework: false, evidence: "synthetic backfill", decided_at: "2026-06-30T08:00:00.000Z" }, { dir: sources.evaluationsDir });
  writeFileSync(join(sources.evaluationsDir, "corrupt.verdict.json"), "{not json");

  // 1 ── first collect
  section("collect #1 (fixtures)");
  const r1 = collect(sources);
  check("appends 6 records (5 exec + 1 ticket)", r1.appended.length === 6, `got ${r1.appended.length}`);
  check("corrupt sidecar reported invalid", r1.invalid_sidecars.length === 1, JSON.stringify(r1.invalid_sidecars));
  check("torn ledger line surfaced as warning, not abort", r1.warnings.some((w) => w.includes("approval-ledger")), JSON.stringify(r1.warnings));
  check("log file created", existsSync(sources.logPath));

  const log1 = readFactoryLog(sources.logPath);
  const rec = (id: string): FactoryRecord => {
    const r = log1.get(id);
    if (!r) throw new Error(`record ${id} missing from log`);
    return r;
  };

  // 2 ── idempotency
  section("collect #2 (idempotency)");
  const sizeBefore = statSync(sources.logPath).size;
  const r2 = collect(sources);
  check("double-collect appends 0", r2.appended.length === 0, `got ${r2.appended.length}`);
  check("double-collect: all rows unchanged", r2.unchanged === 6, `got ${r2.unchanged}`);
  check("log byte-identical after re-collect", statSync(sources.logPath).size === sizeBefore);

  // 3 ── unmeasured never passed
  section("unmeasured-never-passed");
  const d = rec("exec-d");
  check("exec-d (no sidecar) measured=false", d.measured === false && d.verdict === null);
  check("exec-d postflight stage null (not fabricated)", d.stages.postflight === null);
  check("collector links independent shadow evidence without changing canonical verdict",
    d.first_pass_validation?.verdict === "pass"
      && d.first_pass_validation.contract_digest?.startsWith("sha256:")
      && d.first_pass_validation.repository === "/repo"
      && d.first_pass_validation.harness === "codex"
      && d.measured === false);
  check("mode-off execution records preserve absent-field parity", rec("exec-c").first_pass_validation === undefined);
  const a = rec("exec-a");
  check("exec-a measured pass first-pass", a.measured === true && a.verdict?.verdict === "pass" && a.verdict.rework === false);
  check("verdict_ref points at sidecar", typeof a.verdict_ref === "string" && a.verdict_ref!.endsWith("exec-a.verdict.json"));

  // 4 ── stage honesty
  section("unknown-stage honesty");
  check("exec-a decision = ledger classified_at", a.stages.decision === "2026-07-01T09:00:00.000Z");
  check("exec-b decision = unknown (no ledger row)", rec("exec-b").stages.decision === "unknown");
  check("exec-a pr stamped from completed_at", a.stages.pr === "2026-07-01T11:00:00.000Z");
  check("exec-b pr null (no pr_number)", rec("exec-b").stages.pr === null);
  const tk = rec("tk-legacy");
  check("ticket unit execute = unknown (implied, untimed)", tk.stages.execute === "unknown");
  check("ticket unit kind/measured", tk.kind === "ticket" && tk.measured === true);
  check("exec-a cycle time decision→postflight = 6h", a.cycle_time_hours === 6, `got ${a.cycle_time_hours}`);
  check("exec-d cycle time null (no postflight)", d.cycle_time_hours === null);
  check("latestActivity ignores unknown stamps", latestActivity(tk) === "2026-06-30T08:00:00.000Z");

  // 5 ── metrics math
  section("metrics math (explicit denominators)");
  const m = computeFactoryMetrics([...log1.values()], { windowDays: 7, now: NOW });
  check("total_units=6 measured=4 unmeasured=2", m.total_units === 6 && m.measured_count === 4 && m.unmeasured_count === 2);
  check("first_pass_yield = 2/4 = 0.5", m.first_pass_yield === 0.5, `got ${m.first_pass_yield}`);
  check("rework_rate = 1/4 = 0.25", m.rework_rate === 0.25, `got ${m.rework_rate}`);
  check("fail_count = 1", m.fail_count === 1);
  check("gate denominator excludes unknown (5 classified)", m.gate_classified_count === 5, `got ${m.gate_classified_count}`);
  check("gate_rejection_rate = 1/5 = 0.2 (exec-e held)", m.gate_rejection_rate === 0.2, `got ${m.gate_rejection_rate}`);
  check("auto_approval_ratio = 4/5 = 0.8", m.auto_approval_ratio === 0.8, `got ${m.auto_approval_ratio}`);
  // exec-a: decision→postflight 6h; exec-b/c: decision unknown ⇒ falls back to
  // execute→postflight 5h each (documented cycleTime behavior). Mean = 16/3.
  check("mean cycle time = 5.33h over 3 stamped units", m.cycle_time_count === 3 && m.mean_cycle_time_hours === 5.33, `got ${m.mean_cycle_time_hours} over ${m.cycle_time_count}`);
  check("throughput window counts all 6 dated units", m.throughput_window_units === 6 && m.undatable_units === 0);
  check("stage drop-off: decision reached 6, pr reached 1", m.stage_dropoff.decision.reached === 6 && m.stage_dropoff.pr.reached === 1);
  check("drop-off separates unknown-time (decision: 1 stamped, 5 unknown)", m.stage_dropoff.decision.timestamped === 1 && m.stage_dropoff.decision.unknown_time === 5);

  const empty = computeFactoryMetrics([], { windowDays: 7, now: NOW });
  check("empty log: yield null, never 0 or 1", empty.first_pass_yield === null && empty.rework_rate === null && empty.gate_rejection_rate === null);

  // 6 ── supersede on material change (late sidecar for exec-d)
  section("supersede-on-material-change");
  writeVerdict("exec-d", { ticket: "ZOU-900", execution_id: "exec-d", verdict: "pass", rework: true, evidence: "late sidecar", decided_at: "2026-07-01T18:00:00.000Z" }, { dir: sources.evaluationsDir });
  const r3 = collect(sources);
  check("late sidecar appends exactly 1 superseding row", r3.appended.length === 1 && r3.superseded === 1, `appended=${r3.appended.length} superseded=${r3.superseded}`);
  const log2 = readFactoryLog(sources.logPath);
  const d2 = log2.get("exec-d")!;
  check("latest-row-wins: exec-d now measured pass+rework", d2.measured === true && d2.verdict?.rework === true);
  const m2 = computeFactoryMetrics([...log2.values()], { windowDays: 7, now: NOW });
  check("yield denominator moves 4→5; first-pass stays 2 (2/5=0.4)", m2.measured_count === 5 && m2.first_pass_yield === 0.4, `got ${m2.measured_count}, ${m2.first_pass_yield}`);
  const r4 = collect(sources);
  check("collect after supersede idempotent again", r4.appended.length === 0);

  // 6b ── canonical() key-order insensitivity (consensus-mined regression lock):
  //       rewrite every log row with keys reversed at all levels; re-collect
  //       must still append 0 — serialization order is not material change.
  const reorder = (v: unknown): unknown =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, val]) => [k, reorder(val)]))
      : v;
  const rows = readFileSync(sources.logPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  writeFileSync(sources.logPath, rows.map((o) => JSON.stringify(reorder(o))).join("\n") + "\n");
  const r5 = collect(sources);
  check("reordered-key log rows do not churn (canonical sorted)", r5.appended.length === 0, `appended=${r5.appended.length}`);

  // 7 ── durable outcome reconciliation is mode-gated, append-only, and idempotent.
  section("outcome-evidence shadow reconciliation");
  const outcomeLedgerPath = join(sources.stateDir, "outcome-evidence-ledger.jsonl");
  const outcomeSources = {
    stateDir: sources.stateDir,
    evaluationsDir: sources.evaluationsDir,
    ledgerPath: outcomeLedgerPath,
  };
  const off = collectOutcomeEvidenceForMode({ mode: "off", sources: outcomeSources });
  check("outcome mode off is a no-op", off === null && !existsSync(outcomeLedgerPath));
  const shadow1 = collectOutcomeEvidenceForMode({
    mode: "shadow",
    sources: outcomeSources,
    now: NOW,
    instrumentationStartedAt: "2026-07-02T00:00:00.000Z",
  });
  check("shadow mode writes durable terminal rows", shadow1 !== null && shadow1.appended > 0 && shadow1.appended === shadow1.terminal && existsSync(outcomeLedgerPath), `appended=${shadow1?.appended}`);
  const outcomeSize = statSync(outcomeLedgerPath).size;
  const shadow2 = collectOutcomeEvidenceForMode({
    mode: "shadow",
    sources: outcomeSources,
    now: NOW,
    instrumentationStartedAt: "2026-07-02T00:00:00.000Z",
  });
  check("repeated shadow tick is idempotent", shadow2 !== null && shadow2.appended === 0 && shadow2.unchanged === shadow1?.terminal);
  check("idempotent shadow tick is byte-identical", statSync(outcomeLedgerPath).size === outcomeSize);
  writeFileSync(outcomeLedgerPath, readFileSync(outcomeLedgerPath, "utf-8") + "{torn\n");
  const torn = collectOutcomeEvidenceForMode({
    mode: "shadow",
    sources: outcomeSources,
    now: NOW,
    instrumentationStartedAt: "2026-07-02T00:00:00.000Z",
  });
  check("torn outcome ledger blocks further writes", torn !== null && torn.write_blocked && torn.appended === 0);

  // 8 ── flags-off no-op (subprocess, real defaultSources untouched by design:
  //      tick exits before any read/write when the flag is not "1")
  section("flags-off no-op (SF004_METRICS unset)");
  const realLog = join(import.meta.dir, "..", "state", "factory-log.jsonl");
  const realSizeBefore = existsSync(realLog) ? statSync(realLog).size : -1;
  const env = { ...process.env };
  delete env.SF004_METRICS;
  const tick = spawnSync("bun", [join(import.meta.dir, "factory-collect.ts"), "tick"], { env, encoding: "utf-8" });
  check("tick exits 0", tick.status === 0, `status=${tick.status}`);
  check("tick emits nothing", tick.stdout === "" && tick.stderr === "", JSON.stringify({ out: tick.stdout, err: tick.stderr }));
  const realSizeAfter = existsSync(realLog) ? statSync(realLog).size : -1;
  check("real factory-log untouched (byte-identical / still absent)", realSizeAfter === realSizeBefore);
} finally {
  delete process.env.SF003_POOL_STATE_DIR;
  rmSync(root, { recursive: true, force: true });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("SF-004 self-test green ✅");
process.exit(0);
