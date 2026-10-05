#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * ZBT-A — Conveyor lane utilization instrumentation.
 *
 * The conveyor offers 48 ticks/day and ships far fewer PRs than that. Every
 * non-dispatching exit path is deliberately silent (empty queue, rejected
 * contract, dedup skip, cap reached), so the idle majority of ticks leaves no
 * trace anywhere: state/factory-log.jsonl only ever records executions. Without
 * a per-tick outcome row there is no evidence for WHY a tick produced nothing,
 * and raising the in-flight cap would be guesswork.
 *
 * Two-phase by design. `begin` opens the tick, `record` closes it with a
 * categorized reason. A tick that opened and never recorded is reported as
 * `unresolved` rather than silently vanishing — distinguishing "the tick ran and
 * correctly found nothing" from "the tick died or never ran" is the whole point
 * of the measurement, and a single-phase recorder cannot tell them apart.
 *
 * Write-only and fail-soft: `begin` and `record` ALWAYS exit 0. A missing
 * directory, unwritable file, or unknown reason is logged to stderr and never
 * propagated, because this instrumentation must not be able to abort a
 * production conveyor cycle. Unknown reasons are preserved verbatim in `detail`
 * under reason `unknown` so bad wiring shows up in the histogram instead of
 * being discarded.
 *
 * Cycle identity is carried by the recorder, not by the caller's shell. The
 * conveyor agent issues each step as a separate shell invocation, so an exported
 * `$LANE_CYCLE` would not survive from step 0 to step 5 and every tick would
 * report as `unresolved`. `begin` therefore mints the id, persists it to a
 * sentinel file, and prints it; `record` reads the sentinel when `--cycle` is
 * omitted. Nothing has to cross a process boundary in an env var.
 *
 * CLI:
 *   bun lane-utilization.ts begin  [--cycle <id>]
 *   bun lane-utilization.ts record --reason <category> [--cycle <id>]
 *     [--ticket <uuid>] [--identifier <ZOU-nnn>] [--execution <id>] [--detail <text>]
 *   bun lane-utilization.ts report [--since <Nd|Nh|ISO>] [--json]
 *   bun lane-utilization.ts selftest
 *
 * Exit codes: begin/record always 0 · report 0 ok, 1 error · selftest 0 pass, 1 fail · 2 usage.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { basename } from "node:path";
import {
  FACTORY_STATE_MUTATION_EVIDENCE_ROOT,
  factoryStateMutationEvidenceMode,
  recordFactoryStateAtomicReplacement,
} from "./factory-state-mutation-evidence";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Terminal outcomes of a conveyor tick. Order is report order.
 */
export const LANE_REASONS = [
  "dispatched",
  "empty_queue",
  "contract_rejected",
  "dedup_skip",
  "cap_reached",
  "open_execution_guard",
  "execution_failed",
  "preflight_abort",
  "superseded",
] as const;
export type LaneReason = (typeof LANE_REASONS)[number];

/** Reasons that mean the lane did productive work this tick. */
const PRODUCTIVE: ReadonlySet<string> = new Set<string>(["dispatched"]);

export type LanePhase = "open" | "outcome";

export interface LaneRow {
  schema: 1;
  cycle_id: string;
  phase: LanePhase;
  /** null on `open` rows; a LaneReason or "unknown" on `outcome` rows. */
  reason: LaneReason | "unknown" | null;
  ticket_id: string | null;
  identifier: string | null;
  execution_id: string | null;
  detail: string | null;
  ts: string;
}

export interface LaneReport {
  since: string | null;
  until: string;
  window_hours: number | null;
  ticks_opened: number;
  ticks_resolved: number;
  unresolved: number;
  dispatched: number;
  dispatch_rate: number;
  ticks_per_day: number | null;
  histogram: Record<string, number>;
  torn_lines: number;
  /** cycle_ids that opened without a matching outcome row. */
  unresolved_cycles: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function lanePath(): string {
  return (
    resolveFactoryStateOverride(process.env.LANE_UTILIZATION_PATH, "lane-utilization.jsonl")
  );
}

/**
 * Sentinel holding the current cycle id. Derived from the ledger path so an
 * overridden ledger (tests, replays) never contends with the live sentinel.
 */
export function sentinelPath(path: string = lanePath()): string {
  return `${path}.current-cycle`;
}

export function mintCycleId(now: Date = new Date()): string {
  return `${Math.floor(now.getTime() / 1000)}-${process.pid}`;
}

/** Persist the active cycle id. Never throws — failure degrades to no sentinel. */
export function writeSentinel(cycleId: string, path: string = lanePath()): boolean {
  try {
    const sentinel = sentinelPath(path);
    const dir = dirname(sentinel);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sentinel, `${cycleId}\n`);
    return true;
  } catch (err) {
    console.error(
      `lane-utilization: sentinel write failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export function readSentinel(path: string = lanePath()): string | null {
  try {
    const sentinel = sentinelPath(path);
    if (!existsSync(sentinel)) return null;
    const value = readFileSync(sentinel, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function isLaneReason(value: string): value is LaneReason {
  return (LANE_REASONS as readonly string[]).includes(value);
}

// ─── Write path (fail-soft) ───────────────────────────────────────────────────

/**
 * Append one row. Returns true on success, false on any failure — never throws.
 * Callers on the conveyor's hot path must be able to ignore the result.
 */
export function appendRow(row: LaneRow, path: string = lanePath()): boolean {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`lane-utilization: write failed (non-fatal) — ${detail}`);
    return false;
  }
}

export function buildRow(input: {
  cycle_id: string;
  phase: LanePhase;
  reason?: string | null;
  ticket_id?: string | null;
  identifier?: string | null;
  execution_id?: string | null;
  detail?: string | null;
}): LaneRow {
  let reason: LaneReason | "unknown" | null = null;
  let detail = input.detail ?? null;

  if (input.phase === "outcome") {
    const raw = input.reason ?? "";
    if (isLaneReason(raw)) {
      reason = raw;
    } else {
      reason = "unknown";
      // Preserve the bad input rather than dropping the tick: a mis-wired exit
      // point must be visible in the histogram, not silently absent.
      detail = detail ? `reason="${raw}" · ${detail}` : `reason="${raw}"`;
      console.error(
        `lane-utilization: unknown reason "${raw}" recorded as "unknown" ` +
          `(expected one of: ${LANE_REASONS.join(", ")})`,
      );
    }
  }

  return {
    schema: 1,
    cycle_id: input.cycle_id,
    phase: input.phase,
    reason,
    ticket_id: input.ticket_id ?? null,
    identifier: input.identifier ?? null,
    execution_id: input.execution_id ?? null,
    detail,
    ts: new Date().toISOString(),
  };
}

// ─── Read path ────────────────────────────────────────────────────────────────

export interface LaneScan {
  rows: LaneRow[];
  torn_lines: number;
}

export function readRows(path: string = lanePath()): LaneScan {
  if (!existsSync(path)) return { rows: [], torn_lines: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rows: LaneRow[] = [];
  let torn = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LaneRow;
      if (typeof parsed?.cycle_id !== "string" || typeof parsed?.ts !== "string") {
        torn += 1;
        continue;
      }
      rows.push(parsed);
    } catch {
      torn += 1;
    }
  }
  return { rows, torn_lines: torn };
}

export const STALE_OPEN_AFTER_MS = 10 * 60 * 1000;

/**
 * Close unresolved cycles that predate a newer begin by more than ten minutes.
 * Appends are intentionally fail-soft; a later real outcome remains authoritative
 * because reports use the latest outcome for each cycle.
 */
export function reapStaleOpens(
  path: string = lanePath(),
  now: Date = new Date(),
  staleAfterMs: number = STALE_OPEN_AFTER_MS,
): LaneRow[] {
  try {
    const { rows } = readRows(path);
    const opened = new Map<string, LaneRow>();
    const resolved = new Set<string>();

    for (const row of rows) {
      if (row.phase === "open") opened.set(row.cycle_id, row);
      if (row.phase === "outcome") resolved.add(row.cycle_id);
    }

    const cutoff = now.getTime() - staleAfterMs;
    const reaped: LaneRow[] = [];
    for (const [cycleId, open] of opened) {
      if (resolved.has(cycleId)) continue;
      const openedAt = Date.parse(open.ts);
      if (!Number.isFinite(openedAt) || openedAt > cutoff) continue;

      const row: LaneRow = {
        ...buildRow({
          cycle_id: cycleId,
          phase: "outcome",
          reason: "superseded",
          detail: `unresolved open from ${open.ts} superseded by a newer begin`,
        }),
        ts: now.toISOString(),
      };
      if (appendRow(row, path)) reaped.push(row);
    }
    return reaped;
  } catch (err) {
    console.error(
      `lane-utilization: stale-open reap failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Resolve `--since` as an ISO instant, or an `Nd`/`Nh` offset from now. */
export function resolveSince(spec: string | undefined, now: Date = new Date()): Date | null {
  if (!spec) return null;
  const offset = /^(\d+)([dh])$/.exec(spec.trim());
  if (offset) {
    const n = Number.parseInt(offset[1], 10);
    const ms = offset[2] === "d" ? n * 86_400_000 : n * 3_600_000;
    return new Date(now.getTime() - ms);
  }
  const parsed = new Date(spec);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`--since must be an ISO instant or an Nd/Nh offset (got "${spec}")`);
  }
  return parsed;
}

export function buildReport(
  scan: LaneScan,
  since: Date | null,
  now: Date = new Date(),
): LaneReport {
  const inWindow = scan.rows.filter((r) => {
    if (!since) return true;
    const t = new Date(r.ts).getTime();
    return !Number.isNaN(t) && t >= since.getTime();
  });

  const opened = new Set<string>();
  // Latest outcome wins per cycle, so a retried record cannot double-count.
  const outcomes = new Map<string, string>();
  for (const row of inWindow) {
    if (row.phase === "open") opened.add(row.cycle_id);
    else if (row.phase === "outcome" && row.reason) outcomes.set(row.cycle_id, row.reason);
  }

  const histogram: Record<string, number> = {};
  for (const reason of LANE_REASONS) histogram[reason] = 0;
  for (const reason of outcomes.values()) {
    histogram[reason] = (histogram[reason] ?? 0) + 1;
  }

  // An outcome without a matching open is still a real tick — count it as opened
  // so a partially-wired conveyor does not report a negative resolution rate.
  for (const cycle of outcomes.keys()) opened.add(cycle);

  const unresolvedCycles = [...opened].filter((c) => !outcomes.has(c)).sort();
  const ticksOpened = opened.size;
  const ticksResolved = outcomes.size;
  const dispatched = [...outcomes.values()].filter((r) => PRODUCTIVE.has(r)).length;

  const windowHours = since ? (now.getTime() - since.getTime()) / 3_600_000 : null;

  return {
    since: since ? since.toISOString() : null,
    until: now.toISOString(),
    window_hours: windowHours !== null ? Number(windowHours.toFixed(2)) : null,
    ticks_opened: ticksOpened,
    ticks_resolved: ticksResolved,
    unresolved: unresolvedCycles.length,
    dispatched,
    dispatch_rate: ticksOpened > 0 ? Number((dispatched / ticksOpened).toFixed(4)) : 0,
    ticks_per_day:
      windowHours && windowHours > 0
        ? Number(((ticksOpened / windowHours) * 24).toFixed(2))
        : null,
    histogram,
    torn_lines: scan.torn_lines,
    unresolved_cycles: unresolvedCycles,
  };
}

function renderReport(report: LaneReport): string {
  const lines: string[] = [];
  const window = report.since
    ? `${report.since} → ${report.until} (${report.window_hours}h)`
    : `all rows → ${report.until}`;
  lines.push(`lane utilization · ${window}`);
  lines.push(
    `  ticks: ${report.ticks_opened} opened · ${report.ticks_resolved} resolved · ` +
      `${report.unresolved} unresolved`,
  );
  if (report.ticks_per_day !== null) lines.push(`  ticks/day: ${report.ticks_per_day}`);
  lines.push(
    `  dispatched: ${report.dispatched} (${(report.dispatch_rate * 100).toFixed(1)}% of ticks)`,
  );
  lines.push("  reasons:");
  const entries = Object.entries(report.histogram).sort((a, b) => b[1] - a[1]);
  const width = Math.max(...entries.map(([k]) => k.length));
  for (const [reason, count] of entries) {
    const pct = report.ticks_resolved > 0 ? (count / report.ticks_resolved) * 100 : 0;
    lines.push(`    ${reason.padEnd(width)}  ${String(count).padStart(5)}  ${pct.toFixed(1)}%`);
  }
  if (report.torn_lines > 0) lines.push(`  torn lines skipped: ${report.torn_lines}`);
  if (report.unresolved > 0) {
    const shown = report.unresolved_cycles.slice(0, 10).join(", ");
    const more = report.unresolved > 10 ? ` (+${report.unresolved - 10} more)` : "";
    lines.push(`  unresolved cycles: ${shown}${more}`);
  }
  return lines.join("\n");
}

// ─── Selftest ─────────────────────────────────────────────────────────────────

function selftest(): number {
  const tmp = join("/tmp", `lane-util-selftest-${process.pid}.jsonl`);
  rmSync(tmp, { force: true });
  let failures = 0;
  const check = (name: string, ok: boolean, extra = ""): void => {
    if (ok) {
      console.log(`  ok   ${name}`);
    } else {
      failures += 1;
      console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
    }
  };

  try {
    // 1. All categories round-trip, one tick each.
    LANE_REASONS.forEach((reason, i) => {
      const cycle = `t${i}`;
      appendRow(buildRow({ cycle_id: cycle, phase: "open" }), tmp);
      appendRow(buildRow({ cycle_id: cycle, phase: "outcome", reason }), tmp);
    });
    const full = buildReport(readRows(tmp), null);
    check("all categories recorded once", LANE_REASONS.every((r) => full.histogram[r] === 1),
      JSON.stringify(full.histogram));
    check("ticks_opened counts every category", full.ticks_opened === LANE_REASONS.length,
      `got ${full.ticks_opened}`);
    check("unresolved is zero when all ticks close", full.unresolved === 0, `got ${full.unresolved}`);
    check("dispatch_rate reflects one dispatched outcome",
      full.dispatch_rate === Number((1 / LANE_REASONS.length).toFixed(4)), `got ${full.dispatch_rate}`);

    // 2. An opened-but-never-closed tick surfaces as unresolved, not as absent.
    appendRow(buildRow({ cycle_id: "orphan", phase: "open" }), tmp);
    const withOrphan = buildReport(readRows(tmp), null);
    check("orphan open reported unresolved", withOrphan.unresolved === 1,
      `got ${withOrphan.unresolved}`);
    check("orphan named in unresolved_cycles",
      withOrphan.unresolved_cycles.includes("orphan"));
    check("orphan counted in ticks_opened", withOrphan.ticks_opened === LANE_REASONS.length + 1);

    // 3. A newer begin reaps only stale unresolved opens.
    const reaperTmp = `${tmp}.reaper`;
    rmSync(reaperTmp, { force: true });
    const stale = buildRow({ cycle_id: "stale", phase: "open" });
    stale.ts = "2026-08-18T00:00:00.000Z";
    const fresh = buildRow({ cycle_id: "fresh", phase: "open" });
    fresh.ts = "2026-08-18T00:15:00.001Z";
    const resolved = buildRow({ cycle_id: "resolved", phase: "open" });
    resolved.ts = "2026-08-18T00:00:00.000Z";
    appendRow(stale, reaperTmp);
    appendRow(fresh, reaperTmp);
    appendRow(resolved, reaperTmp);
    appendRow(buildRow({ cycle_id: "resolved", phase: "outcome", reason: "empty_queue" }), reaperTmp);
    const reaped = reapStaleOpens(reaperTmp, new Date("2026-08-18T00:20:00.000Z"));
    check("reaper closes only stale unresolved opens",
      reaped.length === 1 && reaped[0]?.cycle_id === "stale", JSON.stringify(reaped));
    const afterReap = buildReport(readRows(reaperTmp), null);
    check("reaped open is reported as superseded", afterReap.histogram.superseded === 1,
      JSON.stringify(afterReap.histogram));
    check("fresh open remains unresolved", afterReap.unresolved_cycles.includes("fresh"),
      JSON.stringify(afterReap.unresolved_cycles));
    appendRow(buildRow({ cycle_id: "stale", phase: "outcome", reason: "dispatched" }), reaperTmp);
    const afterLateOutcome = buildReport(readRows(reaperTmp), null);
    check("later real outcome supersedes mechanical terminal",
      afterLateOutcome.histogram.superseded === 0 && afterLateOutcome.histogram.dispatched === 1,
      JSON.stringify(afterLateOutcome.histogram));
    rmSync(reaperTmp, { force: true });

    // 4. An unknown reason is preserved, never dropped.
    appendRow(buildRow({ cycle_id: "bad", phase: "open" }), tmp);
    appendRow(buildRow({ cycle_id: "bad", phase: "outcome", reason: "not_a_category" }), tmp);
    const withBad = buildReport(readRows(tmp), null);
    check("unknown reason bucketed as unknown", withBad.histogram["unknown"] === 1,
      JSON.stringify(withBad.histogram));
    const badRow = readRows(tmp).rows.find((r) => r.cycle_id === "bad" && r.phase === "outcome");
    check("unknown reason preserves raw value in detail",
      Boolean(badRow?.detail?.includes("not_a_category")), badRow?.detail ?? "(no detail)");

    // 4. Latest outcome wins — a re-recorded tick cannot double-count.
    appendRow(buildRow({ cycle_id: "t1", phase: "outcome", reason: "dispatched" }), tmp);
    const rerecorded = buildReport(readRows(tmp), null);
    check("re-recorded tick does not double-count",
      rerecorded.ticks_resolved === LANE_REASONS.length + 1, `got ${rerecorded.ticks_resolved}`);
    check("re-record overwrites prior reason", rerecorded.histogram["dispatched"] === 2,
      `got ${rerecorded.histogram["dispatched"]}`);

    // 5. Torn trailing line is skipped, not fatal.
    appendFileSync(tmp, '{"cycle_id":"torn","pha');
    const torn = buildReport(readRows(tmp), null);
    check("torn line skipped and counted", torn.torn_lines === 1, `got ${torn.torn_lines}`);

    // 6. An outcome with no open still counts as a tick (no negative rates).
    const tmp2 = `${tmp}.2`;
    rmSync(tmp2, { force: true });
    appendRow(buildRow({ cycle_id: "lone", phase: "outcome", reason: "empty_queue" }), tmp2);
    const lone = buildReport(readRows(tmp2), null);
    check("outcome without open counts as one tick",
      lone.ticks_opened === 1 && lone.unresolved === 0,
      `opened=${lone.ticks_opened} unresolved=${lone.unresolved}`);
    rmSync(tmp2, { force: true });

    // 7. Write failure is non-fatal and reported.
    const wrote = appendRow(buildRow({ cycle_id: "x", phase: "open" }), "/proc/nonexistent/x.jsonl");
    check("unwritable path returns false without throwing", wrote === false);

    // 8. --since window filtering.
    const since = resolveSince("1h");
    check("Nh offset resolves to the past", since !== null && since.getTime() < Date.now());
    check("Nd offset resolves to the past", (resolveSince("7d") as Date).getTime() < Date.now());
    const future = buildReport(readRows(tmp), new Date(Date.now() + 60_000));
    check("future --since yields an empty window", future.ticks_opened === 0,
      `got ${future.ticks_opened}`);

    // 9. Missing file reads clean.
    const missing = buildReport(readRows(`${tmp}.absent`), null);
    check("missing ledger reads as empty", missing.ticks_opened === 0 && missing.torn_lines === 0);

    // 10. Cycle identity survives a process boundary via the sentinel. This is
    // the defect the env-var design would have had: the conveyor runs each step
    // in its own shell, so every tick would have reported unresolved.
    const tmp3 = `${tmp}.3`;
    rmSync(tmp3, { force: true });
    rmSync(sentinelPath(tmp3), { force: true });
    check("no sentinel before begin", readSentinel(tmp3) === null);
    const minted = mintCycleId();
    writeSentinel(minted, tmp3);
    appendRow(buildRow({ cycle_id: minted, phase: "open" }), tmp3);
    const recovered = readSentinel(tmp3);
    check("sentinel round-trips the cycle id", recovered === minted, `got ${recovered}`);
    appendRow(buildRow({ cycle_id: recovered!, phase: "outcome", reason: "dispatched" }), tmp3);
    const sentinelReport = buildReport(readRows(tmp3), null);
    check("sentinel-recovered tick resolves (not unresolved)",
      sentinelReport.unresolved === 0 && sentinelReport.dispatched === 1,
      `unresolved=${sentinelReport.unresolved} dispatched=${sentinelReport.dispatched}`);
    check("sentinel path is derived from the ledger path",
      sentinelPath(tmp3) === `${tmp3}.current-cycle`, sentinelPath(tmp3));
    check("minted ids are unique per second+pid", /^\d+-\d+$/.test(minted), minted);
    rmSync(tmp3, { force: true });
    rmSync(sentinelPath(tmp3), { force: true });

    const evidenceState = `${tmp}.evidence-state`;
    const evidenceLane = join(evidenceState, "lane-utilization.jsonl");
    mkdirSync(evidenceState, { recursive: true });
    const evidenceEnv = {
      ...process.env,
      FACTORY_STATE_DIR: evidenceState,
      FACTORY_STATE_MODE: "test",
      FACTORY_STATE_MUTATION_EVIDENCE: "shadow",
      LANE_UTILIZATION_PATH: evidenceLane,
    };
    const firstBegin = spawnSync(process.execPath, [import.meta.path, "begin", "--cycle", "cycle-evidence-1"], {
      env: evidenceEnv,
      encoding: "utf8",
    });
    const secondBegin = spawnSync(process.execPath, [import.meta.path, "begin", "--cycle", "cycle-evidence-2"], {
      env: evidenceEnv,
      encoding: "utf8",
    });
    const evidenceRoot = join(evidenceState, FACTORY_STATE_MUTATION_EVIDENCE_ROOT);
    const receiptNames = existsSync(evidenceRoot) ? readdirSync(evidenceRoot).filter((name) => name.endsWith(".json")) : [];
    const receipt = receiptNames.length === 1
      ? JSON.parse(readFileSync(join(evidenceRoot, receiptNames[0]!), "utf8"))
      : null;
    check("shadow lane begin remains successful", firstBegin.status === 0 && secondBegin.status === 0);
    check(
      "second begin emits one minted-cycle-bound sentinel replacement receipt",
      receiptNames.length === 1 &&
        receipt?.scope === "scheduled-cycle" &&
        receipt?.cycle_id === "cycle-evidence-2" &&
        receipt?.producer_id === "lane-utilization" &&
        receipt?.target_schema === "lane-current-cycle/v1",
    );
    rmSync(evidenceState, { recursive: true, force: true });

    const enforceState = `${tmp}.enforce-state`;
    const enforceLane = join(enforceState, "lane-utilization.jsonl");
    mkdirSync(enforceState, { recursive: true });
    const enforceEnv = {
      ...process.env,
      FACTORY_STATE_DIR: enforceState,
      FACTORY_STATE_MODE: "test",
      FACTORY_STATE_MUTATION_EVIDENCE: "enforce",
      LANE_UTILIZATION_PATH: enforceLane,
    };
    const enforceFirst = spawnSync(process.execPath, [import.meta.path, "begin", "--cycle", "cycle-enforce-1"], {
      env: enforceEnv,
      encoding: "utf8",
    });
    writeFileSync(join(enforceState, FACTORY_STATE_MUTATION_EVIDENCE_ROOT), "blocked");
    const enforceSecond = spawnSync(process.execPath, [import.meta.path, "begin", "--cycle", "cycle-enforce-2"], {
      env: enforceEnv,
      encoding: "utf8",
    });
    check("enforce first begin establishes the sentinel", enforceFirst.status === 0 && readSentinel(enforceLane) === "cycle-enforce-1");
    check(
      "enforce evidence failure rejects before sentinel replacement",
      enforceSecond.status !== 0 && readSentinel(enforceLane) === "cycle-enforce-1",
    );
    rmSync(enforceState, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { force: true });
    rmSync(sentinelPath(tmp), { force: true });
  }

  console.log(failures === 0 ? "lane-utilization selftest: PASS" : `lane-utilization selftest: ${failures} FAILURE(S)`);
  return failures === 0 ? 0 : 1;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    [
      "usage:",
      "  lane-utilization.ts begin  [--cycle <id>]        # mints + prints the cycle id",
      "  lane-utilization.ts record --reason <category> [--cycle <id>]",
      "    [--ticket <uuid>] [--identifier <ZOU-nnn>] [--execution <id>] [--detail <text>]",
      "  lane-utilization.ts report [--since <Nd|Nh|ISO>] [--json]",
      "  lane-utilization.ts selftest",
      "",
      `categories: ${LANE_REASONS.join(", ")}`,
    ].join("\n"),
  );
  process.exit(2);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function writeScheduledShadow(row: LaneRow): Promise<void> {
  if (process.env.FACTORY_RECEIPT_SHADOW_MODE !== "shadow") return;
  try {
    const shadow: typeof import("./run-receipt-shadow") = await import("./run-receipt-shadow");
    const automationId = process.env.FACTORY_RECEIPT_SHADOW_AUTOMATION_ID;
    if (!automationId) return;
    const idempotencyKey = `automation:${automationId}:${row.cycle_id}`;
    const observedEffect = {
      adapterKind: "workspace-lane-ledger",
      sideEffectKind: "ledger_append" as const,
      target: `lane:${row.cycle_id}:${row.phase}`,
      input: {
        cycle_id: row.cycle_id,
        phase: row.phase,
        reason: row.reason,
        ticket_id: row.ticket_id,
        identifier: row.identifier,
        execution_id: row.execution_id,
      },
      authorityScope: "observe:workspace",
      source: {
        writer: "factory-conveyor-scheduled" as const,
        eventId: `lane:${row.cycle_id}:${row.phase}`,
      },
      evidence: { row_ts: row.ts, phase: row.phase, durable: true },
    };
    if (row.phase === "open") {
      const deadline = new Date(Date.parse(row.ts) + 300_000).toISOString();
      shadow.beginShadowRun({
        producerId: "factory-conveyor-scheduled",
        runClass: "scheduled_agent",
        idempotencyKey,
        intent: { automation_id: automationId, cycle_id: row.cycle_id },
        triggerIdentity: automationId,
        authority: shadow.shadowAuthority(),
        observedEffect,
        edge: {
          targetId: `lane:${row.cycle_id}:outcome`,
          expectedState: { cycle_id: row.cycle_id, phase: "outcome" },
          createdAt: row.ts,
          deadline,
        },
      });
      return;
    }
    const superseded = row.reason === "superseded";
    shadow.completeShadowRun({
      producerId: "factory-conveyor-scheduled",
      runClass: "scheduled_agent",
      idempotencyKey,
      authority: shadow.shadowAuthority(),
      attemptStatus: superseded ? "cancelled" : "success",
      observedEffect,
      terminalOutcome: superseded ? "cancelled" : "success",
      reasonCode: `lane_${row.reason ?? "unknown"}`,
      artifacts: [{
        kind: "ledger_entry",
        ref: `lane:${row.cycle_id}:outcome`,
        hash: null,
        description: "Durable conveyor lane outcome row",
      }],
    });
  } catch {
    return;
  }
}

async function writeConveyorParity(cycleId: string): Promise<void> {
  if (process.env.FACTORY_CONVEYOR_RUNNER_MODE !== "parity_shadow") return;
  try {
    const observer: typeof import("./factory-conveyor-observer") = await import("./factory-conveyor-observer");
    observer.observeConveyorParityCycle(cycleId);
  } catch (err) {
    console.error(`lane-utilization: conveyor parity observer skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    // begin/record are on the conveyor's hot path: they must never abort a
    // cycle, so every failure mode below exits 0 after logging to stderr.
    case "begin": {
      // Mint-and-persist so later steps need no env var: the conveyor runs each
      // step in its own shell and an exported id would not survive.
      const cycle = flagValue(args, "--cycle") ?? mintCycleId();
      const ledgerPath = lanePath();
      const reaped = reapStaleOpens(ledgerPath);
      for (const row of reaped) await writeScheduledShadow(row);
      const currentSentinelPath = sentinelPath(ledgerPath);
      const beforeSentinel = existsSync(currentSentinelPath) ? readFileSync(currentSentinelPath, "utf8") : null;
      const mutationMode = factoryStateMutationEvidenceMode();
      if (mutationMode === "enforce" && beforeSentinel !== null && beforeSentinel !== `${cycle}\n`) {
        const row = buildRow({ cycle_id: cycle, phase: "open" });
        if (!appendRow(row, ledgerPath)) throw new Error("lane open row could not become durable before sentinel replacement");
        const evidence = recordFactoryStateAtomicReplacement({
          mode: mutationMode,
          stateDir: dirname(ledgerPath),
          producerId: "lane-utilization",
          requestedCycleId: cycle,
          sentinelPath: currentSentinelPath,
          laneLogPath: ledgerPath,
          pendingSentinelReplacement: { beforePayload: beforeSentinel, afterPayload: `${cycle}\n` },
          targetPath: basename(currentSentinelPath),
          targetSchema: "lane-current-cycle/v1",
          beforePayload: beforeSentinel,
          afterPayload: `${cycle}\n`,
        });
        if (!evidence.receipt_path) throw new Error("lane sentinel replacement receipt did not become durable");
        if (!writeSentinel(cycle, ledgerPath)) throw new Error("lane sentinel replacement failed after receipt prepare");
        await writeScheduledShadow(row);
        console.log(cycle);
        process.exit(0);
      }
      const sentinelWritten = writeSentinel(cycle, ledgerPath);
      const row = buildRow({ cycle_id: cycle, phase: "open" });
      const rowWritten = appendRow(row, ledgerPath);
      if (rowWritten) await writeScheduledShadow(row);
      if (sentinelWritten && rowWritten && beforeSentinel !== null && beforeSentinel !== `${cycle}\n`) {
        const result = recordFactoryStateAtomicReplacement({
          stateDir: dirname(ledgerPath),
          producerId: "lane-utilization",
          requestedCycleId: cycle,
          sentinelPath: currentSentinelPath,
          laneLogPath: ledgerPath,
          targetPath: basename(currentSentinelPath),
          targetSchema: "lane-current-cycle/v1",
          beforePayload: beforeSentinel,
          afterPayload: `${cycle}\n`,
        });
        if (result.would_reject) console.error(`lane-utilization: mutation evidence would reject (${result.reason})`);
      }
      // FR-02 (ZOU-1111): record the effective runtime configuration for this
      // conveyor tick. recordTick never throws and appendix failures are
      // swallowed inside it — begin's never-abort contract is preserved.
      try {
        const { recordTick } = require("./runtime-config") as typeof import("./runtime-config");
        recordTick(`lane-utilization begin ${cycle}`);
      } catch (err) {
        console.error(`lane-utilization: config tick record skipped (${err instanceof Error ? err.message : String(err)})`);
      }
      console.log(cycle);
      process.exit(0);
    }
    case "record": {
      const explicit = flagValue(args, "--cycle");
      let cycle = explicit ?? readSentinel();
      if (!cycle) {
        // No sentinel means begin never ran (or its write failed). Record under a
        // synthetic id rather than dropping the tick — an orphan outcome still
        // counts as a tick and is visible in the report.
        cycle = `no-sentinel-${mintCycleId()}`;
        console.error(
          `lane-utilization: no --cycle and no sentinel at ${sentinelPath()} — recording as "${cycle}"`,
        );
      }
      const row = buildRow({
          cycle_id: cycle,
          phase: "outcome",
          reason: flagValue(args, "--reason") ?? "",
          ticket_id: flagValue(args, "--ticket") ?? null,
          identifier: flagValue(args, "--identifier") ?? null,
          execution_id: flagValue(args, "--execution") ?? null,
          detail: flagValue(args, "--detail") ?? null,
        });
      if (appendRow(row)) {
        await writeScheduledShadow(row);
        await writeConveyorParity(cycle);
      }
      // FR-03 (ZOU-1112): reconcile shadow-state.safe_executions to the
      // evidence-derived qualifying count at every cycle end. syncQualifyingCount
      // never throws — record's never-abort contract is preserved.
      try {
        const { syncQualifyingCount } = require("./l4-qualification") as typeof import("./l4-qualification");
        syncQualifyingCount();
      } catch (err) {
        console.error(`lane-utilization: qualification sync skipped (${err instanceof Error ? err.message : String(err)})`);
      }
      try {
        const { observePersonaShadowQualification } = require("./persona-shadow-qualification") as typeof import("./persona-shadow-qualification");
        observePersonaShadowQualification({ source: `lane-utilization record ${cycle}` });
      } catch (err) {
        console.error(`lane-utilization: persona shadow qualification skipped (${err instanceof Error ? err.message : String(err)})`);
      }
      process.exit(0);
    }
    case "report": {
      const report = buildReport(readRows(), resolveSince(flagValue(args, "--since")));
      console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report));
      break;
    }
    case "selftest":
      process.exit(selftest());
    default:
      usage();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`lane-utilization: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
