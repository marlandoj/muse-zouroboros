#!/usr/bin/env bun

import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "util";
import {
  buildPool,
  loadPersistedLineup,
  pickLineup,
  type Candidate,
  type LineupProfile,
} from "./lineup-picker";
import { resolveModelIdentity } from "./model-identity";

export const ZOUROBENCH_ROSTER_SCHEMA_VERSION = 1;
// The ZouroBench roster source is not vendored; override with --output.
// The targets file ships in this package (data/).
export const DEFAULT_ZOUROBENCH_ROSTER_PATH =
  "/home/workspace/packages/bench/data/zourobench/lineup-model-roster.json";
export const DEFAULT_ZOUROBENCH_TARGETS_PATH = path.join(
  path.dirname(import.meta.dir),
  "data",
  "zourobench-lineup-targets.json"
);

export type RosterRole = "proposer" | "aggregator" | "coder";
export type RosterSource = "active-lineup" | "persisted-lineup" | "promotion-target";

export interface RosterAssignment {
  id: string;
  profile: LineupProfile;
  role: RosterRole;
  source: RosterSource;
}

export interface ZourobenchRosterModel {
  canonicalModel: string;
  family: string;
  benchmarkRoute: string;
  routes: string[];
  providers: string[];
  profiles: LineupProfile[];
  roles: RosterRole[];
  sources: RosterSource[];
  priority: number;
  lifecycleStatus: string;
  routeHealth: string;
  benchmarkEligible: boolean;
  benchmarkRunnable: boolean;
  benchmarkStatus: "qualified" | "missing" | "unsupported-role" | "held-route";
  benchmarkEvidence: Candidate["benchmarkEvidence"] | null;
}

export interface ZourobenchLineupRoster {
  schemaVersion: 1;
  generatedAt: string;
  policy: "active-and-promotion-candidates-v1";
  benchmarkPolicy: {
    minimumReplicates: 5;
    maxAgeDays: number;
    supportedRoles: ["proposer", "aggregator"];
    unsupportedRoles: ["coder"];
  };
  catalogSnapshot: Array<{ provider: string; count: number }>;
  models: ZourobenchRosterModel[];
  unresolvedTargets: string[];
  summary: {
    models: number;
    qualified: number;
    queued: number;
    unsupportedRoleOnly: number;
    heldRoute: number;
    unresolvedTargets: number;
  };
}

const PROFILES: LineupProfile[] = ["flagship", "fast", "coder", "open-weights", "judge"];
const SOURCE_PRIORITY: Record<RosterSource, number> = {
  "active-lineup": 0,
  "persisted-lineup": 1,
  "promotion-target": 2,
};
const PROVIDER_PRIORITY: Record<string, number> = {
  "zo-byok": 0,
  synthetic: 1,
  opencode: 2,
  openrouter: 3,
  kimi: 4,
};

function roleFor(profile: LineupProfile, aggregator: boolean): RosterRole {
  if (aggregator || profile === "judge") return "aggregator";
  return profile === "coder" ? "coder" : "proposer";
}

function candidateForId(candidates: Candidate[], id: string): Candidate | null {
  const exact = candidates.find((candidate) => candidate.id === id);
  if (exact) return exact;
  const resolvedId = resolveModelIdentity(id).resolvedId;
  const resolved = candidates.find((candidate) => candidate.id === resolvedId);
  if (resolved) return resolved;
  const identity = resolveModelIdentity(id);
  return candidates.find((candidate) => candidate.canonicalModel === identity.model) ?? null;
}

function targetProfiles(candidate: Candidate): LineupProfile[] {
  const profiles: LineupProfile[] = [];
  if (candidate.tier === "flagship") profiles.push("flagship", "judge");
  if (candidate.tier === "fast") profiles.push("fast");
  if (candidate.tier === "coder") profiles.push("coder");
  if (candidate.openWeights === true && candidate.tier === "flagship") profiles.push("open-weights");
  return profiles;
}

export function collectRosterAssignments(
  candidates: Candidate[],
  promotionTargets: string[],
): { assignments: RosterAssignment[]; unresolvedTargets: string[] } {
  const assignments: RosterAssignment[] = [];
  const unresolvedTargets: string[] = [];

  for (const profile of PROFILES) {
    const active = pickLineup(candidates, {
      proposerCount: 3,
      pinProposers: [],
      pinAggregator: null,
      profile,
      mode: "production",
    });
    if (active.productionValid) {
      for (const id of active.proposers) {
        assignments.push({ id, profile, role: roleFor(profile, false), source: "active-lineup" });
      }
      if (active.aggregator) {
        assignments.push({ id: active.aggregator, profile, role: roleFor(profile, true), source: "active-lineup" });
      }
    }

    const persisted = loadPersistedLineup(profile);
    if (persisted) {
      for (const id of persisted.lineup.proposers) {
        assignments.push({ id, profile, role: roleFor(profile, false), source: "persisted-lineup" });
      }
      if (persisted.lineup.aggregator) {
        assignments.push({
          id: persisted.lineup.aggregator,
          profile,
          role: roleFor(profile, true),
          source: "persisted-lineup",
        });
      }
    }
  }

  for (const id of [...new Set(promotionTargets)].sort()) {
    const candidate = candidateForId(candidates, id);
    if (!candidate) {
      unresolvedTargets.push(id);
      continue;
    }
    for (const profile of targetProfiles(candidate)) {
      assignments.push({
        id: candidate.id,
        profile,
        role: profile === "coder" ? "coder" : "proposer",
        source: "promotion-target",
      });
      assignments.push({
        id: candidate.id,
        profile,
        role: "aggregator",
        source: "promotion-target",
      });
    }
  }

  return { assignments, unresolvedTargets };
}

export function buildZourobenchLineupRoster(input: {
  candidates: Candidate[];
  assignments: RosterAssignment[];
  unresolvedTargets?: string[];
  catalogSnapshot?: Array<{ provider: string; count: number }>;
  generatedAt?: string;
  maxAgeDays?: number;
}): ZourobenchLineupRoster {
  const grouped = new Map<string, {
    candidates: Candidate[];
    assignments: RosterAssignment[];
  }>();

  for (const assignment of input.assignments) {
    const candidate = candidateForId(input.candidates, assignment.id);
    if (!candidate) continue;
    const group = grouped.get(candidate.canonicalModel) ?? { candidates: [], assignments: [] };
    if (!group.candidates.some((item) => item.id === candidate.id)) group.candidates.push(candidate);
    group.assignments.push({ ...assignment, id: candidate.id });
    grouped.set(candidate.canonicalModel, group);
  }

  const models = [...grouped.entries()].map(([canonicalModel, group]) => {
    const sourcePriorityByRoute = new Map<string, number>();
    for (const assignment of group.assignments) {
      const priority = SOURCE_PRIORITY[assignment.source];
      sourcePriorityByRoute.set(
        assignment.id,
        Math.min(priority, sourcePriorityByRoute.get(assignment.id) ?? Number.POSITIVE_INFINITY),
      );
    }
    const orderedCandidates = [...group.candidates].sort((a, b) =>
      (sourcePriorityByRoute.get(a.id) ?? 9) - (sourcePriorityByRoute.get(b.id) ?? 9)
      || Number(b.routeHealth === "healthy") - Number(a.routeHealth === "healthy")
      || (PROVIDER_PRIORITY[a.provider] ?? 9) - (PROVIDER_PRIORITY[b.provider] ?? 9)
      || a.totalCost - b.totalCost
      || a.id.localeCompare(b.id)
    );
    const benchmarkCandidate = orderedCandidates[0]!;
    const roles = [...new Set(group.assignments.map((assignment) => assignment.role))].sort() as RosterRole[];
    const profiles = [...new Set(group.assignments.map((assignment) => assignment.profile))].sort() as LineupProfile[];
    const sources = [...new Set(group.assignments.map((assignment) => assignment.source))]
      .sort((a, b) => SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b]);
    const supportedRoles = roles.filter((role) => role !== "coder");
    const benchmarkEligible = supportedRoles.length > 0;
    const benchmarkRunnable = benchmarkEligible && benchmarkCandidate.routeHealth === "healthy";
    const benchmarkEvidence = benchmarkCandidate.benchmarkEvidence ?? null;
    const benchmarkStatus = !benchmarkEligible
      ? "unsupported-role"
      : benchmarkEvidence
        ? "qualified"
        : benchmarkRunnable
          ? "missing"
          : "held-route";
    return {
      canonicalModel,
      family: benchmarkCandidate.family,
      benchmarkRoute: benchmarkCandidate.id,
      routes: orderedCandidates.map((candidate) => candidate.id),
      providers: [...new Set(orderedCandidates.map((candidate) => candidate.provider))],
      profiles,
      roles,
      sources,
      priority: Math.min(...sources.map((source) => SOURCE_PRIORITY[source])),
      lifecycleStatus: benchmarkCandidate.lifecycleStatus ?? "unknown",
      routeHealth: benchmarkCandidate.routeHealth ?? "unknown",
      benchmarkEligible,
      benchmarkRunnable,
      benchmarkStatus,
      benchmarkEvidence,
    } satisfies ZourobenchRosterModel;
  }).sort((a, b) =>
    a.priority - b.priority
    || Number(a.benchmarkStatus === "qualified") - Number(b.benchmarkStatus === "qualified")
    || a.canonicalModel.localeCompare(b.canonicalModel)
  );

  const unresolvedTargets = [...new Set(input.unresolvedTargets ?? [])].sort();
  return {
    schemaVersion: ZOUROBENCH_ROSTER_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    policy: "active-and-promotion-candidates-v1",
    benchmarkPolicy: {
      minimumReplicates: 5,
      maxAgeDays: input.maxAgeDays ?? 30,
      supportedRoles: ["proposer", "aggregator"],
      unsupportedRoles: ["coder"],
    },
    catalogSnapshot: input.catalogSnapshot ?? [],
    models,
    unresolvedTargets,
    summary: {
      models: models.length,
      qualified: models.filter((model) => model.benchmarkStatus === "qualified").length,
      queued: models.filter((model) => model.benchmarkStatus === "missing").length,
      unsupportedRoleOnly: models.filter((model) => model.benchmarkStatus === "unsupported-role").length,
      heldRoute: models.filter((model) => model.benchmarkStatus === "held-route").length,
      unresolvedTargets: unresolvedTargets.length,
    },
  };
}

function parseTargets(values: string[] | undefined): string[] {
  if (!values?.length && !process.env.SHADOW_PROMOTION_TARGETS && fs.existsSync(DEFAULT_ZOUROBENCH_TARGETS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(DEFAULT_ZOUROBENCH_TARGETS_PATH, "utf-8")) as { targets?: unknown };
    if (!Array.isArray(parsed.targets) || !parsed.targets.every((target) => typeof target === "string")) {
      throw new Error("invalid ZouroBench lineup target manifest");
    }
    return parsed.targets;
  }
  const raw = values?.length ? values : [process.env.SHADOW_PROMOTION_TARGETS ?? ""];
  return raw.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      output: { type: "string", default: DEFAULT_ZOUROBENCH_ROSTER_PATH },
      target: { type: "string", multiple: true },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`ZouroBench lineup roster\n\nUsage:\n  bun scripts/zourobench-lineup-roster.ts --write --json\n  bun scripts/zourobench-lineup-roster.ts --target <model-id> --target <model-id>\n\nSHADOW_PROMOTION_TARGETS is used when --target is omitted; the governed target manifest is the final fallback.`);
    return;
  }
  const { candidates, snapshot, benchmarkSnapshot } = buildPool();
  const { assignments, unresolvedTargets } = collectRosterAssignments(candidates, parseTargets(values.target));
  const roster = buildZourobenchLineupRoster({
    candidates,
    assignments,
    unresolvedTargets,
    catalogSnapshot: snapshot,
    maxAgeDays: benchmarkSnapshot.maxAgeDays,
  });
  if (values.write) {
    fs.mkdirSync(path.dirname(values.output!), { recursive: true });
    fs.writeFileSync(values.output!, `${JSON.stringify(roster, null, 2)}\n`);
  }
  if (values.json) console.log(JSON.stringify(roster, null, 2));
  else console.log(`ZouroBench roster: ${roster.summary.models} model(s), ${roster.summary.qualified} qualified, ${roster.summary.queued} queued, ${roster.summary.unsupportedRoleOnly} role-held, ${roster.summary.heldRoute} route-held, ${roster.summary.unresolvedTargets} unresolved target(s)`);
}

if (import.meta.main) main();
