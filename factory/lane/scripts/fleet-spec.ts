#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-008 T1 — Fleet spec core.
 *
 * A FleetSpec is one operator intent fanned across an explicit repo set.
 * This module is the pure layer: parse/validate the spec (fail-loud),
 * validate target repos via an INJECTED RepoProbe, materialize the per-repo
 * acceptance contract ({repo}/{repo_path} placeholders) and gate it through
 * validateTicket() — an invalid repo or contract parks THAT repo only (AC3,
 * partial-failure tolerant). Callers (fleet-campaign.ts) append parks/audit.
 *
 * CLI (validation only, writes nothing):
 *   bun fleet-spec.ts validate --spec <yaml>
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type IntakeTicket, validateTicket } from "./ticket-contract.ts";

// ─── Flags ────────────────────────────────────────────────────────────────────

/** SF008_FLEET default OFF — fleet is an execution surface (SF-003 precedent). */
export function fleetEnabled(): boolean {
  return process.env.SF008_FLEET === "1";
}

// ─── Paths (env-injectable for the sandboxed selftest) ────────────────────────

export function fleetParksPath(): string {
  return resolveFactoryStateOverride(process.env.SF008_PARKS_PATH, "fleet-parks.jsonl");
}

export function fleetAuditPath(): string {
  return resolveFactoryStateOverride(process.env.SF008_AUDIT_PATH, "fleet-audit.jsonl");
}

// ─── Spec ─────────────────────────────────────────────────────────────────────

export interface FleetSpec {
  fleet_id: string;
  intent: string;
  target_repos: string[];
  contract_template: string;
  cost_ceiling_usd?: number;
}

/** Fail-loud spec parser — a malformed committed spec must never half-compile. */
export function parseFleetSpec(path: string): FleetSpec {
  if (!existsSync(path)) throw new Error(`fleet spec not found: ${path}`);
  const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") throw new Error(`fleet spec is not a YAML object: ${path}`);

  const fleetId = doc.fleet_id;
  if (typeof fleetId !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(fleetId)) {
    throw new Error(`fleet_id must match [a-z0-9][a-z0-9-]{2,63}: ${String(fleetId)}`);
  }
  const intent = doc.intent;
  if (typeof intent !== "string" || intent.trim().length < 8) {
    throw new Error(`intent missing or too short in ${path}`);
  }
  const repos = doc.target_repos;
  if (!Array.isArray(repos) || repos.length === 0 || repos.some((r) => typeof r !== "string" || r.trim() === "")) {
    throw new Error(`target_repos must be a non-empty string array in ${path}`);
  }
  const uniq = new Set(repos as string[]);
  if (uniq.size !== repos.length) throw new Error(`target_repos contains duplicates in ${path}`);
  const template = doc.contract_template;
  if (typeof template !== "string" || template.trim() === "") {
    throw new Error(`contract_template missing in ${path}`);
  }
  let ceiling: number | undefined;
  if (doc.cost_ceiling_usd !== undefined) {
    ceiling = Number(doc.cost_ceiling_usd);
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      throw new Error(`cost_ceiling_usd must be a positive number in ${path}`);
    }
  }
  return {
    fleet_id: fleetId,
    intent: intent.trim(),
    target_repos: (repos as string[]).map((r) => r.trim()),
    contract_template: template,
    cost_ceiling_usd: ceiling,
  };
}

// ─── Repo validation ──────────────────────────────────────────────────────────

export interface RepoProbeResult {
  exists: boolean;
  is_git_repo: boolean;
}

/** Injected in tests; real probe is a plain fs check. */
export type RepoProbe = (repoPath: string) => RepoProbeResult;

export const realRepoProbe: RepoProbe = (repoPath) => ({
  exists: existsSync(repoPath),
  is_git_repo: existsSync(join(repoPath, ".git")),
});

const WORKSPACE_ROOT = "/home/workspace";

/** Collision-free within the estate: relative path, sanitized. */
export function repoSlug(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  if (trimmed === WORKSPACE_ROOT) return "workspace-root";
  const rel = trimmed.startsWith(`${WORKSPACE_ROOT}/`) ? trimmed.slice(WORKSPACE_ROOT.length + 1) : trimmed;
  return rel.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed-repo";
}

// ─── Parks + audit (append-only JSONL, derive-on-read) ───────────────────────

export type FleetParkReason = "park_repo_invalid" | "park_contract_invalid";

export interface FleetPark {
  fleet_id: string;
  repo: string;
  reason: FleetParkReason;
  detail: string;
  ts: string;
}

export interface RepoItemAudit {
  fleet_id: string;
  repo: string;
  task_id: string;
  gate_decision: string; // gate CLI decision, or "unscored" on scorer failure
  gate_score: number | null;
  contract_ok: boolean;
  ts: string;
}

function appendRow(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function appendPark(park: FleetPark, path = fleetParksPath()): void {
  appendRow(path, park);
}

export function appendAudit(audit: RepoItemAudit, path = fleetAuditPath()): void {
  appendRow(path, audit);
}

/** Torn-trailing-line tolerant JSONL reader (factory convention). */
export function readJsonlTolerant<T>(path: string): { rows: T[]; torn_lines: number } {
  if (!existsSync(path)) return { rows: [], torn_lines: 0 };
  const rows: T[] = [];
  let torn = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      torn++;
    }
  }
  return { rows, torn_lines: torn };
}

// ─── Contract materialization ─────────────────────────────────────────────────

export const PR_ONLY_CONSTRAINT =
  "OUTPUT CONSTRAINT: deliver all changes as a branch + open PR (or a patch artifact when no remote exists). NEVER push directly to main/master. Never force-push.";

export interface MaterializedRepo {
  repo: string;
  slug: string;
  title: string;
  /** Materialized contract + PR-only constraint — becomes the WorkItem description. */
  description: string;
  /** Empty = contract valid. */
  contract_missing: string[];
}

export function materializeContract(spec: FleetSpec, repo: string, ts: string): MaterializedRepo {
  const slug = repoSlug(repo);
  const title = `${spec.intent.slice(0, 100)} — ${slug}`;
  const contract = spec.contract_template.replaceAll("{repo}", slug).replaceAll("{repo_path}", repo);
  const description = `${contract.trimEnd()}\n\n${PR_ONLY_CONSTRAINT}`;
  const probe: IntakeTicket = {
    linear_id: "",
    identifier: "",
    title,
    description,
    url: "",
    state: "",
    labels: [],
    created_at: ts,
    updated_at: ts,
  };
  return { repo, slug, title, description, contract_missing: validateTicket(probe) };
}

// ─── Per-repo compile plan (pure — no I/O, parks returned not written) ───────

export interface CompilePlan {
  /** Repos that materialized cleanly, in spec order. */
  ready: MaterializedRepo[];
  parks: FleetPark[];
}

export function planFleet(spec: FleetSpec, probe: RepoProbe, ts: string): CompilePlan {
  const ready: MaterializedRepo[] = [];
  const parks: FleetPark[] = [];
  for (const repo of spec.target_repos) {
    let probed: RepoProbeResult;
    try {
      probed = probe(repo);
    } catch (err) {
      probed = { exists: false, is_git_repo: false };
      void err;
    }
    if (!probed.exists || !probed.is_git_repo) {
      parks.push({
        fleet_id: spec.fleet_id,
        repo,
        reason: "park_repo_invalid",
        detail: !probed.exists ? "path does not exist" : "not a git repository",
        ts,
      });
      continue;
    }
    const mat = materializeContract(spec, repo, ts);
    if (mat.contract_missing.length > 0) {
      parks.push({
        fleet_id: spec.fleet_id,
        repo,
        reason: "park_contract_invalid",
        detail: `missing contract fields: ${mat.contract_missing.join(", ")}`,
        ts,
      });
      continue;
    }
    ready.push(mat);
  }
  return { ready, parks };
}

// ─── CLI (validate only — writes nothing) ─────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!fleetEnabled()) {
    // Exit before ANY read/write when the flag is off (byte-identity AC).
    process.exit(0);
  }
  const cmd = args[0];
  const specIdx = args.indexOf("--spec");
  if (cmd !== "validate" || specIdx < 0 || specIdx + 1 >= args.length) {
    console.error("usage: fleet-spec.ts validate --spec <yaml>   (requires SF008_FLEET=1)");
    process.exit(2);
  }
  const spec = parseFleetSpec(args[specIdx + 1]);
  const plan = planFleet(spec, realRepoProbe, new Date().toISOString());
  console.log(`fleet ${spec.fleet_id}: ${spec.target_repos.length} repos → ${plan.ready.length} ready, ${plan.parks.length} parked`);
  for (const p of plan.parks) console.log(`  PARK ${p.repo}: ${p.reason} (${p.detail})`);
  process.exit(0);
}
