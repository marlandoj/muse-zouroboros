#!/usr/bin/env bun
/**
 * SF-008 T3 — Fleet rollup (derive-on-read, no self-report).
 *
 * FleetRollup is a pure function of on-disk pool state (campaigns, queue,
 * assignments + result sentinels) and the fleet ledgers (parks, audit). No
 * fleet-side status file exists to drift.
 *
 * Honesty notes:
 * - prs_opened counts DISTINCT repos whose result-sentinel summary CLAIMS a PR
 *   (pattern match) — the sentinel contract is free text, claims are unverified.
 * - passed_postflight = items the pool harvested to done (success sentinel);
 *   there is no separate per-item post-flight verifier in v1.
 *
 * CLI (flag-gated, SF008_FLEET=1; reads only, never creates files):
 *   bun fleet-status.ts [--fleet <fleet_id>] [--json]
 */

import {
  type FleetPark,
  fleetAuditPath,
  fleetEnabled,
  fleetParksPath,
  readJsonlTolerant,
  type RepoItemAudit,
  repoSlug,
} from "./fleet-spec.ts";
import { type Campaign, loadCampaigns, loadQueue, type WorkItem } from "./pool-queue.ts";
import { type Assignment, loadAssignments, readResult } from "./pool-worker.ts";

// ─── Rollup core (pure) ───────────────────────────────────────────────────────

export const PR_CLAIM_PATTERN = /(pull request|merge request|\/pull\/\d+|\bPR\s*#\d+|opened a PR\b|patch artifact)/i;

/** Joined (task_id → result summary/outcome) view of the sentinel files. */
export interface TaskResult {
  task_id: string;
  outcome: string;
  summary: string;
}

export interface FleetRollup {
  fleet_id: string;
  campaign_id: string;
  repos_total: number;
  enqueued: number;
  in_flight: number;
  done: number;
  failed: number;
  parked_pool: number;
  parked_compile: number;
  prs_opened: number;
  passed_postflight: number;
  parks_by_reason: Record<string, number>;
}

export function rollupFleet(
  fleetId: string,
  campaigns: Record<string, Campaign>,
  queue: WorkItem[],
  results: TaskResult[],
  parks: FleetPark[]
): FleetRollup {
  const campaignId = `fleet-${fleetId}`;
  const items = queue.filter((i) => i.campaign_id === campaignId);
  const enqueuedSlugs = new Set(items.map((i) => i.task_id));

  const myParks = parks.filter((p) => p.fleet_id === fleetId);
  const parksByReason: Record<string, number> = {};
  const compileParkedRepos = new Set<string>();
  for (const p of myParks) {
    parksByReason[p.reason] = (parksByReason[p.reason] ?? 0) + 1;
    compileParkedRepos.add(p.repo);
  }
  // A repo that parked then re-entered via --retry-parked is enqueued, not
  // parked: park rows carry repo PATHS, items carry SLUGS — join via repoSlug.
  const stillParked = [...compileParkedRepos].filter((repo) => !enqueuedSlugs.has(repoSlug(repo)));

  const prTasks = new Set<string>();
  const passedTasks = new Set<string>();
  for (const r of results) {
    if (!enqueuedSlugs.has(r.task_id)) continue;
    if (PR_CLAIM_PATTERN.test(r.summary)) prTasks.add(r.task_id);
  }
  for (const i of items) if (i.state === "done") passedTasks.add(i.task_id);

  return {
    fleet_id: fleetId,
    campaign_id: campaigns[campaignId] ? campaignId : `${campaignId} (not compiled)`,
    repos_total: items.length + stillParked.length,
    enqueued: items.length,
    in_flight: items.filter((i) => i.state === "in-flight").length,
    done: items.filter((i) => i.state === "done").length,
    failed: items.filter((i) => i.state === "failed").length,
    parked_pool: items.filter((i) => i.state === "parked").length,
    parked_compile: stillParked.length,
    prs_opened: prTasks.size,
    passed_postflight: passedTasks.size,
    parks_by_reason: parksByReason,
  };
}

// ─── Disk readers (never create files) ────────────────────────────────────────

/**
 * Result sentinels joined to (campaign_id, task_id) via their assignments.
 * Callers iterating multiple fleets pass a hoisted loadAssignments() to avoid
 * re-scanning the assignments dir once per fleet.
 */
export function readFleetResults(campaignId: string, assignments: Assignment[] = loadAssignments()): TaskResult[] {
  const out: TaskResult[] = [];
  for (const a of assignments) {
    if (a.campaign_id !== campaignId) continue;
    try {
      const r = readResult(a);
      if (r) out.push({ task_id: a.task_id, outcome: r.outcome, summary: String(r.summary ?? "") });
    } catch {
      // torn/corrupt sentinel — skip; the pool manager owns retries
    }
  }
  return out;
}

/** Every fleet_id visible on disk: compiled campaigns ∪ park-ledger rows. */
export function discoverFleetIds(campaigns: Record<string, Campaign>, parks: FleetPark[]): string[] {
  const ids = new Set<string>();
  for (const c of Object.values(campaigns)) {
    if (c.campaign_id === `fleet-${c.ticket_id}`) ids.add(c.ticket_id);
  }
  for (const p of parks) ids.add(p.fleet_id);
  return [...ids].sort();
}

export function fleetStatusAll(fleetFilter?: string): { rollups: FleetRollup[]; torn_park_lines: number } {
  const campaigns = loadCampaigns();
  const queue = loadQueue();
  const assignments = loadAssignments();
  const { rows: parks, torn_lines } = readJsonlTolerant<FleetPark>(fleetParksPath());
  const ids = discoverFleetIds(campaigns, parks).filter((id) => !fleetFilter || id === fleetFilter);
  const rollups = ids.map((id) => rollupFleet(id, campaigns, queue, readFleetResults(`fleet-${id}`, assignments), parks));
  return { rollups, torn_park_lines: torn_lines };
}

// ─── SF-008 snapshot for shadow-validate (T4 — never throws) ─────────────────

export interface SF008Snapshot {
  fleet_enabled: boolean;
  fleets: FleetRollup[];
  park_rows: number;
  parks_by_reason: Record<string, number>;
  audit_rows: number;
  torn_park_lines: number;
  torn_audit_lines: number;
  /** Corrupt-file notes — reported, never thrown. */
  invalid: string[];
}

export function sf008Snapshot(): SF008Snapshot {
  const snap: SF008Snapshot = {
    fleet_enabled: fleetEnabled(),
    fleets: [],
    park_rows: 0,
    parks_by_reason: {},
    audit_rows: 0,
    torn_park_lines: 0,
    torn_audit_lines: 0,
    invalid: [],
  };
  let campaigns: Record<string, Campaign> = {};
  let queue: WorkItem[] = [];
  let parks: FleetPark[] = [];
  try {
    campaigns = loadCampaigns();
  } catch (e: any) {
    snap.invalid.push(`pool campaigns.json INVALID: ${e?.message ?? e}`);
  }
  try {
    queue = loadQueue();
  } catch (e: any) {
    snap.invalid.push(`pool queue.json INVALID: ${e?.message ?? e}`);
  }
  try {
    const r = readJsonlTolerant<FleetPark>(fleetParksPath());
    parks = r.rows;
    snap.torn_park_lines = r.torn_lines;
  } catch (e: any) {
    snap.invalid.push(`fleet-parks.jsonl INVALID: ${e?.message ?? e}`);
  }
  try {
    const a = readJsonlTolerant<RepoItemAudit>(fleetAuditPath());
    snap.audit_rows = a.rows.length;
    snap.torn_audit_lines = a.torn_lines;
  } catch (e: any) {
    snap.invalid.push(`fleet-audit.jsonl INVALID: ${e?.message ?? e}`);
  }
  snap.park_rows = parks.length;
  for (const p of parks) {
    const reason = String(p?.reason ?? "unknown");
    snap.parks_by_reason[reason] = (snap.parks_by_reason[reason] ?? 0) + 1;
  }
  let assignments: Assignment[] = [];
  try {
    assignments = loadAssignments();
  } catch (e: any) {
    snap.invalid.push(`pool assignments INVALID: ${e?.message ?? e}`);
  }
  for (const id of discoverFleetIds(campaigns, parks)) {
    try {
      snap.fleets.push(rollupFleet(id, campaigns, queue, readFleetResults(`fleet-${id}`, assignments), parks));
    } catch (e: any) {
      snap.invalid.push(`fleet ${id} rollup INVALID: ${e?.message ?? e}`);
    }
  }
  return snap;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

export const ROLLUP_CAVEAT =
  "caveat: 'PRs claimed' = unverified sentinel-text pattern matches; 'passed' = pool-harvested done (no per-item post-flight verifier in v1, so passed === done by construction).";

export function renderRollupTable(rollups: FleetRollup[]): string {
  if (rollups.length === 0) return "no fleets on disk (no fleet-* campaigns, no park rows)";
  const lines = [
    "| fleet | repos | enq | in-flight | done | failed | parked(pool) | parked(compile) | PRs claimed | passed |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rollups) {
    lines.push(
      `| ${r.fleet_id} | ${r.repos_total} | ${r.enqueued} | ${r.in_flight} | ${r.done} | ${r.failed} | ${r.parked_pool} | ${r.parked_compile} | ${r.prs_opened} | ${r.passed_postflight} |`
    );
  }
  lines.push("", ROLLUP_CAVEAT);
  const reasons = rollups
    .filter((r) => Object.keys(r.parks_by_reason).length > 0)
    .map((r) => `  ${r.fleet_id}: ${Object.entries(r.parks_by_reason).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (reasons.length > 0) lines.push("", "park rows by reason (ledger, cumulative):", ...reasons);
  return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (!fleetEnabled()) {
    // Exit before ANY read when the flag is off (byte-identity AC).
    process.exit(0);
  }
  const args = process.argv.slice(2);
  const fleetIdx = args.indexOf("--fleet");
  const fleetFilter = fleetIdx >= 0 ? args[fleetIdx + 1] : undefined;
  if (fleetIdx >= 0 && (fleetFilter === undefined || fleetFilter.startsWith("--"))) {
    console.error("usage: fleet-status.ts [--fleet <fleet_id>] [--json]   (requires SF008_FLEET=1)");
    process.exit(2);
  }
  try {
    const { rollups, torn_park_lines } = fleetStatusAll(fleetFilter);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ rollups, torn_park_lines }, null, 2));
    } else {
      console.log(renderRollupTable(rollups));
      if (torn_park_lines > 0) console.log(`\nWARN: ${torn_park_lines} torn line(s) in ${fleetParksPath()}`);
    }
    process.exit(0);
  } catch (err: any) {
    console.error(`FATAL: ${err?.message ?? err}`);
    process.exit(1);
  }
}

// fleetAuditPath/RepoItemAudit re-exported for the shadow-validate snapshot (T4).
export { fleetAuditPath };
export type { RepoItemAudit };
