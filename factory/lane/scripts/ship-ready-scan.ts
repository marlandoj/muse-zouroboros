#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * ship-ready-scan.ts — L1 ship-gate alert (factory "limbo" nudge).
 *
 * Problem it solves (factory-limbo-investigation-2026-07-12.md, phenomenon A):
 * a build reaches `state:"implementation_complete"` and then STOPS — it commits its
 * branch locally but never pushes/PRs/merges (SF010_AUTOMERGE=0, executor forbidden
 * to push). The conveyor only emails on FAILURE, so a finished-but-unshipped build
 * produces zero notification and looks "stuck" on the dashboard until a human
 * notices. Phase 14 (ZOU-592) sat in this silent limbo for hours.
 *
 * This is a READ-ONLY housekeeping scan (conveyor step 5b). It NEVER mutates exec
 * records, never ships anything, never changes the safety posture — it only reports
 * which completed builds are still waiting at the manual ship gate so the automation
 * can email the operator "N build(s) ready to ship: <identifiers>".
 *
 * Why a Linear join (and not just `stage=complete && pr_number=null`):
 * `pr_number` stays null on EVERY completed build — shipped or not — because
 * shipping happens out-of-band (manual push/PR/merge) and never writes back to the
 * exec record. So the naive scan false-positives on every historical phase. The
 * reliable "still unshipped" signal is that the twin ticket remains non-terminal
 * in the Intake project. The puller deliberately removes factory-ready when a ticket
 * leaves Backlog, and manual-review recovery moves released tickets to In Progress,
 * so a label-based join would strand verified builds. Shipping reconciles the twin
 * to Done.
 *
 * Fail-safe: if Linear is unreachable we cannot compute the join, so we flag NOTHING
 * (empty set ⇒ no alert) rather than crash the conveyor or spam false positives.
 * `linear_ok:false` is stamped in the summary; the next cycle retries.
 *
 * Machine output: SINGLE-LINE JSON on stdout. All human logs go to stderr, so the
 * conveyor's `… 2>/dev/null | tail -1` pipe reads clean JSON.
 *
 * Usage:
 *   bun ship-ready-scan.ts                    # scan; default min-age = 35 min (~1 cycle)
 *   bun ship-ready-scan.ts --min-age-minutes 60
 *   bun ship-ready-scan.ts --selftest         # self-contained tmpdir checks (no Linear)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isExecutionRecordFileName, normalizeExecutionLifecycle } from "./execution-lifecycle";

const STATE_DIR = factoryStateRoot();
const DEFAULT_MIN_AGE_MINUTES = Number(process.env.SHIP_READY_MIN_MINUTES ?? 35);

// ── Linear (mirrors linear-puller.ts — Intake project).
const API = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
const INTAKE_PROJECT_ID = "b621d7a1-bb3d-4df9-ae11-3034789e204c";
/** Non-terminal Linear workflow state types that can still represent an unshipped build. */
const PULLABLE_STATE_TYPES: ReadonlySet<string> = new Set(["backlog", "unstarted", "started"]);

function log(msg: string): void {
  process.stderr.write(`[ship-ready] ${msg}\n`);
}

interface ExecLike {
  execution_id?: string;
  identifier?: string;
  stage?: string;
  status?: string;
  branch_name?: string | null;
  pr_number?: number | string | null;
  started_at?: string;
  completed_at?: string | null;
  [k: string]: unknown;
}

export interface ShipReadyItem {
  identifier: string;
  execution_id: string;
  branch_name: string | null;
  completed_at: string;
  age_minutes: number;
}

/** Timestamp used to order execs of the same identifier: completed_at, else started_at. */
function recencyMs(e: ExecLike): number {
  const t = Date.parse(e.completed_at ?? e.started_at ?? "");
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Pure decision: which completed builds are sitting in unshipped ship-gate limbo?
 *
 * A build qualifies when ALL hold:
 *   - it is the LATEST exec for its identifier (retries/re-dispatch supersede older ones,
 *     so a fresh `executing` retry correctly cancels an older `complete` from the list),
 *   - canonical state is implementation_complete or verified,
 *   - no pr_number (defensive — a real PR number means it was shipped through the lane),
 *   - completed_at present and older than minAgeMinutes,
 *   - its identifier's twin is still non-terminal in the Linear Intake project.
 */
export function selectShipReady(
  records: ExecLike[],
  opts: { nowMs: number; minAgeMinutes: number; unshippedIdentifiers: Set<string> },
): ShipReadyItem[] {
  // Keep only the most-recent exec per identifier.
  const latest = new Map<string, ExecLike>();
  for (const e of records) {
    const id = e.identifier;
    if (!id) continue;
    const cur = latest.get(id);
    if (!cur || recencyMs(e) >= recencyMs(cur)) latest.set(id, e);
  }

  const items: ShipReadyItem[] = [];
  for (const [identifier, e] of latest) {
    const lifecycle = normalizeExecutionLifecycle(e);
    if (lifecycle.state !== "implementation_complete" && lifecycle.state !== "verified") continue;
    if (e.pr_number) continue;
    if (!e.completed_at) continue;
    if (!opts.unshippedIdentifiers.has(identifier)) continue;
    const completedMs = Date.parse(e.completed_at);
    if (Number.isNaN(completedMs)) continue;
    const ageMinutes = (opts.nowMs - completedMs) / 60000;
    if (ageMinutes <= opts.minAgeMinutes) continue;
    items.push({
      identifier,
      execution_id: e.execution_id ?? "?",
      branch_name: (e.branch_name as string) ?? null,
      completed_at: e.completed_at,
      age_minutes: Math.round(ageMinutes),
    });
  }
  // Oldest limbo first — that is the one most overdue for a ship nudge.
  items.sort((a, b) => b.age_minutes - a.age_minutes);
  return items;
}

/** Read every exec-exec-*.json record from the state dir; skip anything unparseable. */
function scanDir(dir: string): ExecLike[] {
  const files = existsSync(dir) ? readdirSync(dir).filter(isExecutionRecordFileName) : [];
  const out: ExecLike[] = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), "utf8")));
    } catch {
      /* corrupt/torn record ⇒ ignore (fail-safe, never crash the scan) */
    }
  }
  return out;
}

/**
 * Set of twin identifiers still unshipped (Intake + non-terminal) — i.e.
 * genuinely unshipped. Fail-safe: any error ⇒ empty set (flag nothing), and the
 * caller stamps linear_ok:false so the operator can tell a quiet scan from an outage.
 */
async function fetchUnshippedIdentifiers(): Promise<{ ids: Set<string>; ok: boolean }> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    log("WARN LINEAR_API_KEY not set — cannot compute unshipped join; flagging nothing");
    return { ids: new Set(), ok: false };
  }
  const query = `
    query FactoryIntakeTickets($projectId: ID!) {
      issues(first: 250, filter: { project: { id: { eq: $projectId } } }) {
        nodes { identifier state { type } }
      }
    }`;
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables: { projectId: INTAKE_PROJECT_ID } }),
    });
    if (!r.ok) {
      log(`WARN Linear HTTP ${r.status} — flagging nothing this cycle`);
      return { ids: new Set(), ok: false };
    }
    const j = (await r.json()) as any;
    if (j.errors?.length) {
      log(`WARN Linear GQL error — flagging nothing this cycle: ${JSON.stringify(j.errors).slice(0, 200)}`);
      return { ids: new Set(), ok: false };
    }
    const nodes = j.data?.issues?.nodes ?? [];
    const ids = new Set<string>();
    for (const n of nodes) {
      if (PULLABLE_STATE_TYPES.has(n.state?.type)) ids.add(n.identifier);
    }
    return { ids, ok: true };
  } catch (err) {
    log(`WARN Linear fetch threw — flagging nothing this cycle: ${String(err).slice(0, 200)}`);
    return { ids: new Set(), ok: false };
  }
}

function selftest(): number {
  const tmp = join(STATE_DIR, `__shipready_selftest_${Date.now()}`);
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

  // A: complete, unshipped-pullable twin, old ⇒ FLAGGED.
  write("aaaa1111", { execution_id: "exec-aaaa1111", identifier: "ZOU-A", state: "implementation_complete", delivery_target: "accepted", stage: "implementation_complete", pr_number: null, started_at: iso(120), completed_at: iso(90), branch_name: "factory/zou-a" });
  // B: complete, twin already shipped (NOT pullable), old ⇒ NOT flagged (pr_number false-positive guard).
  write("bbbb2222", { execution_id: "exec-bbbb2222", identifier: "ZOU-B", stage: "complete", pr_number: null, started_at: iso(500), completed_at: iso(480) });
  // C: complete, pullable, but FRESH (age < min) ⇒ NOT flagged.
  write("cccc3333", { execution_id: "exec-cccc3333", identifier: "ZOU-C", stage: "complete", pr_number: null, started_at: iso(20), completed_at: iso(10) });
  // D: executing, pullable, old ⇒ NOT flagged (not complete).
  write("dddd4444", { execution_id: "exec-dddd4444", identifier: "ZOU-D", stage: "executing", pr_number: null, started_at: iso(200), completed_at: null });
  // E: complete but already HAS a pr_number, pullable, old ⇒ NOT flagged.
  write("eeee5555", { execution_id: "exec-eeee5555", identifier: "ZOU-E", stage: "complete", pr_number: 4242, started_at: iso(300), completed_at: iso(280) });
  // F: two execs same identifier — old complete THEN newer executing retry ⇒ latest wins ⇒ NOT flagged.
  write("ffff6666", { execution_id: "exec-ffff6666", identifier: "ZOU-F", stage: "complete", pr_number: null, started_at: iso(400), completed_at: iso(380) });
  write("ffff7777", { execution_id: "exec-ffff7777", identifier: "ZOU-F", stage: "executing", pr_number: null, started_at: iso(30), completed_at: null });

  const records = scanDir(tmp);
  // Non-terminal Intake twins per the injected Linear join: A, C, D, E, F are still unshipped; B was shipped (absent).
  const unshippedIdentifiers = new Set(["ZOU-A", "ZOU-C", "ZOU-D", "ZOU-E", "ZOU-F"]);
  const items = selectShipReady(records, { nowMs: Date.now(), minAgeMinutes: 35, unshippedIdentifiers });
  const flagged = new Set(items.map((i) => i.identifier));

  check("complete + unshipped-pullable + old ⇒ flagged", flagged.has("ZOU-A"));
  check("complete + shipped twin (not pullable) ⇒ NOT flagged", !flagged.has("ZOU-B"));
  check("complete + pullable but fresh ⇒ NOT flagged", !flagged.has("ZOU-C"));
  check("executing ⇒ NOT flagged", !flagged.has("ZOU-D"));
  check("complete + already has pr_number ⇒ NOT flagged", !flagged.has("ZOU-E"));
  check("latest exec is a retry (executing) ⇒ NOT flagged", !flagged.has("ZOU-F"));
  check("exactly one build flagged", items.length === 1);
  check("flagged item carries a positive age", (items[0]?.age_minutes ?? 0) > 35);
  check("flagged item carries its branch", items[0]?.branch_name === "factory/zou-a");
  check("started Linear state remains ship-eligible", PULLABLE_STATE_TYPES.has("started"));

  const legacy = selectShipReady([
    { execution_id: "legacy", identifier: "ZOU-LEGACY", stage: "complete", completed_at: iso(90), pr_number: null },
  ], { nowMs: Date.now(), minAgeMinutes: 35, unshippedIdentifiers: new Set(["ZOU-LEGACY"]) });
  check("legacy complete normalizes to implementation_complete", legacy.length === 1);

  // Empty Linear set (outage) ⇒ flag nothing even though A qualifies on-disk.
  const outage = selectShipReady(records, { nowMs: Date.now(), minAgeMinutes: 35, unshippedIdentifiers: new Set() });
  check("empty unshipped set (Linear outage) ⇒ flags nothing", outage.length === 0);

  rmSync(tmp, { recursive: true, force: true });
  log(`selftest: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "min-age-minutes": { type: "string" },
      selftest: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.selftest) {
    process.exit(selftest());
  }

  const minAgeMinutes = values["min-age-minutes"] ? Number(values["min-age-minutes"]) : DEFAULT_MIN_AGE_MINUTES;
  const records = scanDir(STATE_DIR);
  const { ids: unshippedIdentifiers, ok: linearOk } = await fetchUnshippedIdentifiers();
  const items = selectShipReady(records, { nowMs: Date.now(), minAgeMinutes, unshippedIdentifiers });

  const summary = {
    ok: true,
    linear_ok: linearOk,
    min_age_minutes: minAgeMinutes,
    scanned: records.length,
    ship_ready: items.length,
    identifiers: items.map((i) => i.identifier),
    items,
  };
  log(
    `scanned=${records.length} ship_ready=${items.length} linear_ok=${linearOk} (min_age>${minAgeMinutes}m)` +
      (items.length ? ` → ${items.map((i) => `${i.identifier}(${i.age_minutes}m)`).join(", ")}` : ""),
  );
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (import.meta.main) await main();
