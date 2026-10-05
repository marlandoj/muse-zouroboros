#!/usr/bin/env bun
/**
 * SF-008 T2 — Fleet compiler CLI.
 *
 * Compiles a FleetSpec into ONE SF-003 pool campaign: one dep-free WorkItem
 * per valid repo (task_id = repo slug), description = materialized contract +
 * PR-only constraint. Pure CALLER of pool-queue's exported APIs — pool modules
 * stay byte-untouched. Idempotent by campaign_id (re-compile enqueues 0 dupes,
 * writes 0 duplicate ledger rows). Parked repos re-enter ONLY via
 * --retry-parked. Per-repo gate score is advisory audit: scorer failure stamps
 * "unscored", never blocks compile. Real dispatch stays behind the pool lane
 * (SF003_POOL=1, mode=act) — fleet never bypasses pool flags.
 *
 * CLI (flag-gated, SF008_FLEET=1):
 *   bun fleet-campaign.ts compile --spec <yaml> [--dry] [--retry-parked]
 */

import { execFileSync } from "node:child_process";
import {
  appendAudit,
  appendPark,
  type FleetPark,
  type FleetSpec,
  fleetEnabled,
  fleetParksPath,
  type MaterializedRepo,
  parseFleetSpec,
  planFleet,
  readJsonlTolerant,
  realRepoProbe,
  type RepoItemAudit,
  type RepoProbe,
  repoSlug,
} from "./fleet-spec.ts";
import {
  enqueueCampaign,
  loadCampaigns,
  loadQueue,
  saveCampaigns,
  saveQueue,
  type SeedTask,
  type WorkItem,
} from "./pool-queue.ts";

// ─── Gate scorer (injected; real = SPAWN swarm-decision-gate, never import) ──

export interface GateScore {
  decision: string;
  score: number | null;
}

export type GateScorer = (summary: string) => GateScore;

const GATE_SCRIPT = "/home/workspace/Skills/tier-resolver/scripts/swarm-decision-gate.ts";
const UNSCORED: GateScore = { decision: "unscored", score: null };

/**
 * swarm-decision-gate.ts runs main() at import — spawn --json, parse stdout.
 * execFileSync + argument array: no shell, so spec-authored summaries can never
 * inject commands, and stderr noise can't collide with the stdout JSON.
 */
export const realGateScorer: GateScorer = (summary) => {
  let stdout = "";
  try {
    stdout = execFileSync("bun", [GATE_SCRIPT, "--json", summary], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    stdout = String(e?.stdout ?? "").trim(); // non-zero exit still carries JSON (DIRECT=2, SUGGEST=3)
  }
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) return UNSCORED;
  try {
    const parsed = JSON.parse(stdout.slice(jsonStart)) as { decision?: unknown; score?: unknown };
    const decision = typeof parsed.decision === "string" && parsed.decision.trim() !== "" ? parsed.decision : "unscored";
    const score = Number(parsed.score);
    return { decision, score: Number.isFinite(score) ? score : null };
  } catch {
    return UNSCORED;
  }
};

/** Advisory: a throwing scorer must never block compile. */
function scoreSafe(scorer: GateScorer, summary: string): GateScore {
  try {
    const s = scorer(summary);
    if (!s || typeof s.decision !== "string") return UNSCORED;
    return { decision: s.decision, score: typeof s.score === "number" && Number.isFinite(s.score) ? s.score : null };
  } catch {
    return UNSCORED;
  }
}

// ─── Compile core (writes only when !dry) ─────────────────────────────────────

export function fleetCampaignId(spec: FleetSpec): string {
  return `fleet-${spec.fleet_id}`;
}

export interface CompileDeps {
  probe: RepoProbe;
  scorer: GateScorer;
  now: () => string;
  dry: boolean;
  retryParked: boolean;
  parksPath?: string;
  auditPath?: string;
}

export interface CompileOutcome {
  campaign_id: string;
  already_existed: boolean;
  /** Slugs newly enqueued this run (empty on idempotent no-op / dry). */
  enqueued: string[];
  /** Parks appended this run (planned-but-unwritten when dry). */
  parks: FleetPark[];
  audits: RepoItemAudit[];
  warnings: string[];
  dry: boolean;
}

function toSeedTask(m: MaterializedRepo): SeedTask {
  return { id: m.slug, name: m.title, description: m.description, deps: [] };
}

function toWorkItem(m: MaterializedRepo, campaignId: string, ts: string): WorkItem {
  return {
    campaign_id: campaignId,
    task_id: m.slug,
    name: m.title,
    description: m.description,
    deps: [],
    state: "ready",
    attempts: 0,
    park_reason: null,
    created_at: ts,
    updated_at: ts,
  };
}

function auditRow(spec: FleetSpec, m: MaterializedRepo, gate: GateScore, ts: string): RepoItemAudit {
  return {
    fleet_id: spec.fleet_id,
    repo: m.repo,
    task_id: m.slug,
    gate_decision: gate.decision,
    gate_score: gate.score,
    contract_ok: true,
    ts,
  };
}

export function compileFleet(spec: FleetSpec, specPath: string, deps: CompileDeps): CompileOutcome {
  const ts = deps.now();
  const campaignId = fleetCampaignId(spec);
  const outcome: CompileOutcome = {
    campaign_id: campaignId,
    already_existed: false,
    enqueued: [],
    parks: [],
    audits: [],
    warnings: [],
    dry: deps.dry,
  };

  const existing = loadCampaigns()[campaignId];

  if (!existing) {
    // First compile: plan every repo, enqueue the valid set as ONE campaign.
    const plan = planFleet(spec, deps.probe, ts);
    outcome.parks = plan.parks;
    if (deps.dry) {
      outcome.enqueued = plan.ready.map((m) => m.slug);
      return outcome;
    }
    for (const park of plan.parks) appendPark(park, deps.parksPath);
    if (plan.ready.length === 0) {
      outcome.warnings.push("0 repos ready — campaign not created (all parked)");
      return outcome;
    }
    for (const m of plan.ready) {
      const gate = scoreSafe(deps.scorer, `${m.title}\n${m.description.slice(0, 500)}`);
      outcome.audits.push(auditRow(spec, m, gate, ts));
    }
    const result = enqueueCampaign({
      campaign_id: campaignId,
      ticket_id: spec.fleet_id,
      identifier: `FLEET-${spec.fleet_id}`,
      seed_path: specPath,
      tasks: plan.ready.map(toSeedTask),
      cost_ceiling_usd: spec.cost_ceiling_usd,
    });
    outcome.already_existed = result.already_existed;
    if (!result.already_existed) {
      outcome.enqueued = plan.ready.map((m) => m.slug);
      for (const a of outcome.audits) appendAudit(a, deps.auditPath);
    } else {
      outcome.audits = [];
    }
    return outcome;
  }

  // Re-compile: idempotent no-op unless --retry-parked re-enters parked repos.
  outcome.already_existed = true;
  if (!deps.retryParked) return outcome;

  const items = loadQueue().filter((i) => i.campaign_id === campaignId);
  const enqueuedSlugs = new Set(items.map((i) => i.task_id));
  const { rows: parkRows } = readJsonlTolerant<FleetPark>(deps.parksPath ?? fleetParksPath());
  const parkedRepos = new Set(parkRows.filter((p) => p.fleet_id === spec.fleet_id).map((p) => p.repo));

  const reEnter: MaterializedRepo[] = [];
  for (const repo of spec.target_repos) {
    if (enqueuedSlugs.has(repoSlug(repo))) continue; // done/in-flight/ready — never touched
    if (!parkedRepos.has(repo)) {
      outcome.warnings.push(`${repo}: not enqueued and no park row — spec changed after compile? ignored (parks are the only re-entry path)`);
      continue;
    }
    const rePlan = planFleet({ ...spec, target_repos: [repo] }, deps.probe, ts);
    if (rePlan.parks.length > 0) {
      outcome.parks.push(...rePlan.parks);
      continue; // still invalid — fresh park row records the re-attempt
    }
    reEnter.push(rePlan.ready[0]);
  }

  if (deps.dry) {
    outcome.enqueued = reEnter.map((m) => m.slug);
    return outcome;
  }
  for (const park of outcome.parks) appendPark(park, deps.parksPath);
  if (reEnter.length === 0) return outcome;

  const ts2 = deps.now();
  const queue = loadQueue();
  const campaigns = loadCampaigns();
  const campaign = campaigns[campaignId];
  for (const m of reEnter) {
    const gate = scoreSafe(deps.scorer, `${m.title}\n${m.description.slice(0, 500)}`);
    queue.push(toWorkItem(m, campaignId, ts2));
    campaign.tasks.push(m.slug);
    const a = auditRow(spec, m, gate, ts2);
    outcome.audits.push(a);
    appendAudit(a, deps.auditPath);
  }
  if (campaign.state === "parked" || campaign.state === "complete") campaign.state = "active";
  saveQueue(queue);
  saveCampaigns(campaigns);
  outcome.enqueued = reEnter.map((m) => m.slug);
  return outcome;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (!fleetEnabled()) {
    // Exit before ANY read/write when the flag is off (byte-identity AC).
    process.exit(0);
  }
  const args = process.argv.slice(2);
  const specIdx = args.indexOf("--spec");
  if (args[0] !== "compile" || specIdx < 0 || specIdx + 1 >= args.length) {
    console.error("usage: fleet-campaign.ts compile --spec <yaml> [--dry] [--retry-parked]   (requires SF008_FLEET=1)");
    process.exit(2);
  }
  try {
    const specPath = args[specIdx + 1];
    const spec = parseFleetSpec(specPath);
    const dry = args.includes("--dry");
    const outcome = compileFleet(spec, specPath, {
      probe: realRepoProbe,
      // --dry must write nothing AND spawn nothing.
      scorer: dry ? () => UNSCORED : realGateScorer,
      now: () => new Date().toISOString(),
      dry,
      retryParked: args.includes("--retry-parked"),
    });
    const mode = outcome.dry ? "[dry] " : "";
    if (outcome.already_existed && outcome.enqueued.length === 0 && outcome.parks.length === 0) {
      console.log(`${mode}fleet ${spec.fleet_id}: campaign ${outcome.campaign_id} already compiled — no-op (use --retry-parked to re-enter parked repos)`);
    } else {
      console.log(`${mode}fleet ${spec.fleet_id} → campaign ${outcome.campaign_id}: ${outcome.enqueued.length} enqueued, ${outcome.parks.length} parked`);
    }
    for (const slug of outcome.enqueued) {
      const a = outcome.audits.find((x) => x.task_id === slug);
      const gate = a ? `gate=${a.gate_decision}${a.gate_score !== null ? ` ${a.gate_score.toFixed(2)}` : ""}` : "gate=skipped (--dry)";
      console.log(`  ENQUEUE ${slug} (${gate})`);
    }
    for (const p of outcome.parks) console.log(`  PARK ${p.repo}: ${p.reason} (${p.detail})`);
    for (const w of outcome.warnings) console.log(`  WARN ${w}`);
    process.exit(0);
  } catch (err: any) {
    console.error(`FATAL: ${err?.message ?? err}`);
    process.exit(1);
  }
}
