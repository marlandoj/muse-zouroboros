#!/usr/bin/env bun
// lineup-picker.ts — ZOU-411
// Tier-aware proposer/aggregator lineup picker for the MoA consensus gate.
// Replaces the hardcoded trio in quarantine.getActiveModels() with a dynamic,
// catalog-driven selection that auto-adapts as providers surface new models.
//
// Selection policy (deterministic for a given catalog snapshot):
//   1. Build a unified candidate pool from the cached synthetic (hf:) + opencode (oc:) catalogs.
//   2. Filter to eligible models per profile (default flagship tier), non-quarantined, non-provisional.
//   3. Vendor diversity: proposer slots are filled greedily so no two proposers share a family.
//   4. Cost ordering: cheapest eligible candidate wins a slot.
//   5. Family preference: tied candidates use capability-aware label ordering, then label and id.
//   6. Aggregator: cheapest flagship whose family differs from all proposers (broadest ensemble).
//   7. Pin/override: --pin-proposer / --pin-aggregator force specific gate-prefixed ids.
//
// Output: a stable `lineup` object { proposers[], aggregator } the gate + #gate renderer consume.
// Usage:
//   bun lineup-picker.ts                       # print lineup (human-readable)
//   bun lineup-picker.ts --json                # machine-readable JSON
//   bun lineup-picker.ts --proposers 4         # N proposer slots (default 3)
//   bun lineup-picker.ts --profile fast        # compatibility preset: flagship | open-weights | fast | coder | judge
//   bun lineup-picker.ts --role coding --weights open-only
//   bun lineup-picker.ts --pin-proposer oc:glm-5.2 --pin-proposer hf:moonshotai/Kimi-K2.7-Code
//   bun lineup-picker.ts --pin-aggregator oc:claude-opus-4-8
//   bun lineup-picker.ts --validate            # exit 1 if lineup invalid (no vendor diversity / missing)
//
// Env: optionally LINEUP_PIN_PROPOSERS="id1,id2", LINEUP_PIN_AGGREGATOR="id",
// LINEUP_PROFILE=<legacy-preset>, LINEUP_ROLE_PROFILE=<role>, LINEUP_WEIGHT_POLICY=<policy> (CLI wins)

import { parseArgs } from "util";
import * as fs from "fs";
import { loadCachedCatalog as loadSynthetic, classifyOpenWeights, type ClassifiedModel, type LifecycleStatus, type OpenWeightsEvidence, type RouteHealth, type Tier } from "./catalog";
import { loadCachedCatalog as loadOpencode } from "./catalog-opencode";
import { loadCachedCatalog as loadOpenrouter } from "./catalog-openrouter";
import { loadCachedCatalog as loadByok, byokLabels } from "./catalog-byok";
import { loadCachedCatalog as loadKimi } from "./catalog-kimi";
import {
  canonicalModelFamily,
  displayModelName,
  resolveModelIdentity,
} from "./model-identity";
import { parseLineupRoleConfig, type LineupRole, type LineupRoleConfig } from "./lineup-roles";
import {
  LEGACY_PROFILE_PRESETS,
  ROLE_PROFILES,
  capabilityTierFor,
  isModelRoleProfile,
  isWeightPolicy,
  legacyProfileForSelection,
  modelRoleFitFor,
  resolveLineupSelection,
  weightPolicyBlockers,
  type CapabilityTier,
  type LegacyLineupProfile,
  type LineupSelection,
  type ModelRoleProfile,
  type WeightPolicy,
} from "./lineup-taxonomy";
import { loadCandidates, type ProvisionalRecord } from "./provisional-candidates";
import { loadRouteHealth, type RouteHealthRecord } from "./provider-resilience";
import {
  loadZourobenchEvidence,
  type BenchmarkEvidenceSummary,
  type BenchmarkLineupRole,
  type ModelBenchmarkEvidence,
} from "./zourobench-lineup-evidence";

// Provider precedence for lineup slots. Subscription BYOK models and Synthetic
// share rank 0; usage-billed providers follow. Non-subscription BYOK entries do
// not inherit the subscription boost merely because they use the same transport.
const PROVIDER_RANK: Record<string, number> = { synthetic: 0, opencode: 1, openrouter: 1, kimi: 2 };
const providerRank = (c: Candidate): number =>
  c.provider === "zo-byok" ? (c.subscription ? 0 : 2) : (PROVIDER_RANK[c.provider] ?? 2);

const QUARANTINE_PATH = `${process.env.HOME}/.zouroboros/consensus-gate.json`;
const PROVISIONAL_PATH = `${process.env.HOME}/.zouroboros/provisional-candidates.json`;
const LINEUP_PATH = `${process.env.HOME}/.zouroboros/lineup.json`;

// --- Tiered lineup profiles (ZOU-576) ---------------------------------------
// Each profile is the same picker algorithm with a different eligibility
// filter; vendor diversity, subscription-first cost sort, aggregator selection
// and pin paths are shared. "Budget" is intentionally NOT a profile: the sort
// already prefers $0-marginal subscription/flat-rate providers (PR #271).

export type LineupProfile = LegacyLineupProfile;

interface ProfileSpec {
  eligible: (c: Candidate) => boolean;
  description: string;
}

export const PROFILES: Record<LineupProfile, ProfileSpec> = {
  flagship: {
    eligible: (c) => ROLE_PROFILES["deep-reasoning"].sourceTiers.includes(c.tier),
    description: "legacy alias for deep-reasoning + any weights",
  },
  // Open flagship-tier panel. A family-only filter would let the cost-asc sort
  // fill every slot with tiny fast-tier models — converging on `fast` and
  // defeating the profile's purpose (vendor-independent quality panel).
  "open-weights": {
    eligible: (c) => openWeightsBlockers(c, "production").length === 0,
    description: "vendor-independent, auditable — open flagship models",
  },
  fast: {
    eligible: (c) => ROLE_PROFILES.fast.sourceTiers.includes(c.tier),
    description: "fast role + efficient tier + any weights",
  },
  coder: {
    eligible: (c) => ROLE_PROFILES.coding.sourceTiers.includes(c.tier),
    description: "legacy alias for coding + any weights",
  },
  judge: {
    eligible: (c) => ROLE_PROFILES.judge.sourceTiers.includes(c.tier),
    description: "judge role + frontier tier + any weights",
  },
};

export function isLineupProfile(v: string): v is LineupProfile {
  return Object.prototype.hasOwnProperty.call(PROFILES, v);
}

/** Persisted-lineup path for a profile: flagship keeps the legacy singleton. */
export function lineupPathFor(profile: LineupProfile = "flagship"): string {
  return profile === "flagship" ? LINEUP_PATH : `${process.env.HOME}/.zouroboros/lineup.${profile}.json`;
}

export function lineupPathForSelection(roleProfile: ModelRoleProfile, weightPolicy: WeightPolicy = "any"): string {
  const legacyProfile = legacyProfileForSelection(roleProfile, weightPolicy);
  if (legacyProfile) return lineupPathFor(legacyProfile);
  const weightSuffix = weightPolicy === "open-only" ? "open" : "closed";
  return `${process.env.HOME}/.zouroboros/lineup.${roleProfile}.${weightSuffix}.json`;
}

/** Model metadata for frontend rendering (ZOU-412/ZOU-413). */
export interface ModelMeta {
  id: string;
  name: string;       // human-readable: "GLM-5.2", "Kimi K2.7"
  family: string;     // glm, kimi, claude, gemini, deepseek, ...
  tier: Tier;
  provider: string;   // synthetic | opencode | openrouter | zo-byok
  role: "proposer" | "aggregator";
  openWeights?: boolean | null;
  openWeightsEvidence?: OpenWeightsEvidence;
  lifecycleStatus?: LifecycleStatus;
  routeHealth?: RouteHealth;
  benchmarkEvidence?: ModelBenchmarkEvidence;
  roleFit?: ModelRoleProfile[];
  capabilityTier?: CapabilityTier;
}

export interface PersistedLineup {
  valid: boolean;
  lineup: Lineup;
  members: ModelMeta[];   // enriched metadata for the #gate renderer
  persistedAt: string;
  profile: LineupProfile;
  roleProfile?: ModelRoleProfile;
  capabilityTier?: CapabilityTier;
  weightPolicy?: WeightPolicy;
}

/** Load the last-good persisted lineup (ZOU-413 cache). Returns null if absent. */
export function loadPersistedLineup(profile: LineupProfile = "flagship"): PersistedLineup | null {
  const path = lineupPathFor(profile);
  if (!fs.existsSync(path)) return null;
  try {
    const persisted = JSON.parse(fs.readFileSync(path, "utf-8")) as PersistedLineup;
    const selection = resolveLineupSelection(profile);
    return {
      ...persisted,
      profile: persisted.profile ?? profile,
      roleProfile: persisted.roleProfile ?? selection.roleProfile,
      capabilityTier: persisted.capabilityTier ?? selection.capabilityTier,
      weightPolicy: persisted.weightPolicy ?? selection.weightPolicy,
    };
  } catch {
    return null;
  }
}

export function loadPersistedRoleLineup(
  roleProfile: ModelRoleProfile,
  weightPolicy: WeightPolicy = "any",
): PersistedLineup | null {
  const artifactPath = lineupPathForSelection(roleProfile, weightPolicy);
  if (!fs.existsSync(artifactPath)) return null;
  try {
    const persisted = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as PersistedLineup;
    const legacyProfile = legacyProfileForSelection(roleProfile, weightPolicy) ?? persisted.profile;
    return {
      ...persisted,
      profile: legacyProfile,
      roleProfile: persisted.roleProfile ?? roleProfile,
      capabilityTier: persisted.capabilityTier ?? resolveLineupSelection(legacyProfile, roleProfile, weightPolicy).capabilityTier,
      weightPolicy: persisted.weightPolicy ?? weightPolicy,
    };
  } catch {
    return null;
  }
}

export function migrateLegacyFlagshipArtifact(
  resolvePath: (profile: LineupProfile) => string = lineupPathFor,
): boolean {
  const path = resolvePath("flagship");
  if (!fs.existsSync(path)) return false;

  let record: Record<string, unknown>;
  try {
    record = JSON.parse(fs.readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (
    record.profile !== undefined ||
    record.valid !== true ||
    !record.lineup ||
    typeof record.lineup !== "object" ||
    !Array.isArray(record.members)
  ) {
    return false;
  }

  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({
      ...record,
      profile: "flagship",
      roleProfile: "deep-reasoning",
      capabilityTier: "frontier",
      weightPolicy: "any",
    }, null, 2));
    fs.renameSync(temporaryPath, path);
    return true;
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
    return false;
  }
}

/** Human-readable display name from a gate-prefixed id. */
export function displayName(id: string): string {
  return displayModelName({ id, label: byokLabels().get(id) });
}

const CLAUDE_LABEL_ORDER = ["fable", "sonnet", "opus", "haiku"] as const;

function modelVersion(label: string): number[] | null {
  const match = label.toLowerCase().match(/\bgpt[\s-]+(\d+(?:\.\d+)*)/);
  return match ? match[1].split(".").map(Number) : null;
}

function kimiVersion(label: string): number[] | null {
  const match = label.toLowerCase().match(/\bkimi[\s-]+k?(\d+(?:\.\d+)*)/);
  return match ? match[1].split(".").map(Number) : null;
}

function compareVersionsDesc(a: number[], b: number[]): number {
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i++) {
    const delta = (b[i] ?? 0) - (a[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

export function compareFamilyLabels(family: string, aLabel: string, bLabel: string): number {
  const normalizedFamily = family.toLowerCase();
  const a = aLabel.toLowerCase();
  const b = bLabel.toLowerCase();

  if (normalizedFamily === "claude") {
    const rank = (label: string) => {
      const index = CLAUDE_LABEL_ORDER.findIndex((variant) => label.includes(variant));
      return index === -1 ? CLAUDE_LABEL_ORDER.length : index;
    };
    const delta = rank(a) - rank(b);
    if (delta) return delta;
  }

  if (normalizedFamily === "gpt") {
    const aVersion = modelVersion(a);
    const bVersion = modelVersion(b);
    if (aVersion && bVersion) {
      const delta = compareVersionsDesc(aVersion, bVersion);
      if (delta) return delta;
    } else if (aVersion || bVersion) {
      return aVersion ? -1 : 1;
    }

    const solDelta = Number(/\bsol\b/.test(b)) - Number(/\bsol\b/.test(a));
    if (solDelta) return solDelta;
  }

  if (normalizedFamily === "kimi") {
    const aVersion = kimiVersion(a);
    const bVersion = kimiVersion(b);
    if (aVersion && bVersion) {
      const delta = compareVersionsDesc(aVersion, bVersion);
      if (delta) return delta;
    } else if (aVersion || bVersion) {
      return aVersion ? -1 : 1;
    }
  }

  return aLabel.localeCompare(bLabel, undefined, { numeric: true, sensitivity: "base" });
}

/** Persist the lineup to disk as last-good cache (ZOU-413). Only writes when valid. */
function persistLineup(valid: boolean, lineup: Lineup, candidates: Candidate[], profile: LineupProfile = "flagship"): void {
  if (!valid) return; // never overwrite last-good with an invalid lineup (feat(consensus-gate): add OpenRouter lineup routing)
  const selection = resolveLineupSelection(profile, lineup.roleProfile, lineup.weightPolicy);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const members: ModelMeta[] = [
    ...lineup.proposers.map((id) => {
      const c = byId.get(id);
      return {
        id, name: displayName(id), family: c?.family ?? canonicalModelFamily(id), tier: c?.tier ?? "flagship",
        provider: c?.provider ?? "synthetic", role: "proposer" as const,
        openWeights: c?.openWeights ?? null, openWeightsEvidence: c?.openWeightsEvidence ?? "unknown",
        lifecycleStatus: c?.lifecycleStatus ?? "unknown", routeHealth: c?.routeHealth ?? "unknown",
        benchmarkEvidence: c?.benchmarkEvidence,
        roleFit: c?.roleFit ?? modelRoleFitFor(c?.tier ?? "flagship"),
        capabilityTier: c?.capabilityTier ?? capabilityTierFor(c?.tier ?? "flagship", c?.lifecycleStatus),
      };
    }),
  ];
  if (lineup.aggregator) {
    const c = byId.get(lineup.aggregator);
    members.push({
      id: lineup.aggregator, name: displayName(lineup.aggregator), family: c?.family ?? canonicalModelFamily(lineup.aggregator),
      tier: c?.tier ?? "flagship", provider: c?.provider ?? "synthetic", role: "aggregator" as const,
      openWeights: c?.openWeights ?? null, openWeightsEvidence: c?.openWeightsEvidence ?? "unknown",
      lifecycleStatus: c?.lifecycleStatus ?? "unknown", routeHealth: c?.routeHealth ?? "unknown",
      benchmarkEvidence: c?.benchmarkEvidence,
      roleFit: c?.roleFit ?? modelRoleFitFor(c?.tier ?? "flagship"),
      capabilityTier: c?.capabilityTier ?? capabilityTierFor(c?.tier ?? "flagship", c?.lifecycleStatus),
    });
  }
  const record: PersistedLineup = {
    valid,
    lineup,
    members,
    persistedAt: new Date().toISOString(),
    profile,
    roleProfile: selection.roleProfile,
    capabilityTier: selection.capabilityTier,
    weightPolicy: selection.weightPolicy,
  };
  const path = lineupPathForSelection(selection.roleProfile, selection.weightPolicy);
  try {
    fs.mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(record, null, 2));
  } catch { /* non-fatal — stdout still has the lineup */ }
}

export function shouldPersistLineup(valid: boolean, lineup: Lineup): boolean {
  return valid && !lineup.pinned && lineup.readiness !== "rehearsal" && lineup.productionValid !== false;
}

export interface Candidate {
  id: string;          // gate-prefixed id (hf:..., oc:...)
  label: string;       // human-readable catalog label used for family preference
  family: string;      // vendor family (glm, kimi, claude, gemini, ...)
  canonicalModel: string;
  tier: Tier;          // flagship | fast | coder
  provider: string;    // synthetic | opencode
  promptCost: number;
  completionCost: number;
  totalCost: number;   // prompt + completion per 1k tokens
  subscription: boolean;
  openWeights?: boolean | null;
  openWeightsEvidence?: OpenWeightsEvidence;
  lifecycleStatus?: LifecycleStatus;
  routeHealth?: RouteHealth;
  benchmarkEvidence?: ModelBenchmarkEvidence;
  roleFit?: ModelRoleProfile[];
  capabilityTier?: CapabilityTier;
}

export interface Lineup {
  proposers: string[];
  aggregator: string;
  generatedAt: string;
  catalogSnapshot: { provider: string; count: number }[];
  pinned: boolean;
  note?: string;
  readiness?: ReadinessMode;
  productionValid?: boolean;
  blockers?: string[];
  benchmarkSnapshot?: BenchmarkEvidenceSummary;
  roleProfile?: ModelRoleProfile;
  capabilityTier?: Exclude<CapabilityTier, "experimental">;
  weightPolicy?: WeightPolicy;
  sourceTiers?: readonly Tier[];
}

export type ReadinessMode = "production" | "rehearsal";

export function openWeightProvenanceBlockers(candidate: Candidate): string[] {
  const blockers: string[] = [];
  if (candidate.openWeights !== true) {
    blockers.push(candidate.openWeights === false
      ? `${candidate.id}: catalog metadata marks weights closed`
      : `${candidate.id}: open-weight provenance is unknown`);
  } else if (!candidate.openWeightsEvidence || candidate.openWeightsEvidence === "unknown") {
    blockers.push(`${candidate.id}: open-weight provenance is missing`);
  }
  return blockers;
}

export function operationalReadinessBlockers(
  candidate: Candidate,
  mode: ReadinessMode = "production",
): string[] {
  const blockers: string[] = [];
  const allowedLifecycle = mode === "rehearsal" ? ["promoted", "cold-start-passed"] : ["promoted"];
  const lifecycle = candidate.lifecycleStatus ?? "unknown";
  if (!allowedLifecycle.includes(lifecycle)) {
    blockers.push(`${candidate.id}: lifecycle=${lifecycle}, allowed=${allowedLifecycle.join("|")}`);
  }
  if (candidate.routeHealth !== "healthy") blockers.push(`${candidate.id}: route health=${candidate.routeHealth ?? "unknown"}`);
  return blockers;
}

export function openWeightsBlockers(
  candidate: Candidate,
  mode: ReadinessMode = "production",
  requiredTier: Tier | null = null,
): string[] {
  const blockers = [
    ...openWeightProvenanceBlockers(candidate),
    ...operationalReadinessBlockers(candidate, mode),
  ];
  if (requiredTier && candidate.tier !== requiredTier) blockers.push(`${candidate.id}: tier=${candidate.tier}, ${requiredTier} required`);
  return blockers;
}

function idAliases(id: string, model?: ClassifiedModel): Set<string> {
  const aliases = new Set([id, id.replace(/^or:/, "")]);
  if (model?.id) aliases.add(model.id);
  if (model?.hugging_face_id) aliases.add(`hf:${model.hugging_face_id}`);
  return aliases;
}

function lifecycleFor(id: string, model: ClassifiedModel, records: ProvisionalRecord[]): LifecycleStatus {
  const aliases = idAliases(id, model);
  return records.find((record) => aliases.has(record.id))?.status ?? "unknown";
}

function routeHealthFor(id: string, model: ClassifiedModel, records: Record<string, RouteHealthRecord>): RouteHealth {
  for (const alias of idAliases(id, model)) {
    const reviewHealth = records[`${alias}::review`];
    if (reviewHealth) return reviewHealth.ok ? "healthy" : "failing";
    const transportHealth = records[alias];
    if (transportHealth) return transportHealth.ok ? "healthy" : "failing";
  }
  return "unknown";
}

function quarantinedSet(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(QUARANTINE_PATH, "utf-8"));
    return new Set((raw.quarantined ?? []).map((q: any) => q.model));
  } catch {
    return new Set();
  }
}

export function blockedCandidateIds(raw: unknown): Set<string> {
  const records = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { candidates?: unknown[] }).candidates)
      ? (raw as { candidates: unknown[] }).candidates
      : [];
  const blocked = new Set<string>();
  for (const record of records
      .filter((record): record is { id: string; status?: string; provisional?: boolean } =>
        Boolean(record) && typeof record === "object" && typeof (record as { id?: unknown }).id === "string"
      )
      .filter((record) => record.status ? record.status !== "promoted" : record.provisional === true)
  ) {
    blocked.add(record.id);
    if (!/^(byok:|hf:|syn:|oc:|or:|xai:|kimi:)/.test(record.id) && record.id.includes("/")) {
      blocked.add(`or:${record.id}`);
    }
  }
  return blocked;
}

function provisionalSet(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(PROVISIONAL_PATH, "utf-8"));
    return blockedCandidateIds(raw);
  } catch {
    return new Set();
  }
}

function blockedSet(selection: LineupSelection, mode: ReadinessMode): Set<string> {
  const blocked = new Set(quarantinedSet());
  const records = loadCandidates().filter((record) =>
    !(selection.weightPolicy === "open-only" && mode === "rehearsal" && record.status === "cold-start-passed")
  );
  for (const id of blockedCandidateIds(records)) blocked.add(id);
  return blocked;
}

export function toCandidate(
  m: ClassifiedModel,
  provider: string,
  lifecycleRecords: ProvisionalRecord[] = loadCandidates(),
  healthRecords: Record<string, RouteHealthRecord> = loadRouteHealth(),
): Candidate {
  const totalCost = (m.promptCost ?? 0) + (m.completionCost ?? 0);
  const subscription = provider === "zo-byok" && (m as ClassifiedModel & { subscription?: boolean }).subscription === true;
  const id = provider === "openrouter" && !m.id.startsWith("or:") ? `or:${m.id}` : m.id;
  const label = (m as ClassifiedModel & { label?: string }).label ?? displayName(id);
  const identity = resolveModelIdentity({ id, label, family: m.family });
  const openness = classifyOpenWeights(m);
  const observedRouteHealth = routeHealthFor(id, m, healthRecords);
  const lifecycleStatus = m.lifecycleStatus ?? lifecycleFor(id, m, lifecycleRecords);
  return {
    id, label, family: identity.family, canonicalModel: identity.model, tier: m.tier, provider,
    promptCost: m.promptCost, completionCost: m.completionCost, totalCost, subscription,
    ...openness,
    lifecycleStatus,
    routeHealth: observedRouteHealth !== "unknown" ? observedRouteHealth : m.routeHealth ?? "unknown",
    roleFit: modelRoleFitFor(m.tier),
    capabilityTier: capabilityTierFor(m.tier, lifecycleStatus),
  };
}

export function buildPool(): {
  candidates: Candidate[];
  snapshot: { provider: string; count: number }[];
  benchmarkSnapshot: BenchmarkEvidenceSummary;
} {
  const out: Candidate[] = [];
  const snapshot: { provider: string; count: number }[] = [];
  for (const [provider, loader] of [["zo-byok", loadByok], ["synthetic", loadSynthetic], ["opencode", loadOpencode], ["openrouter", loadOpenrouter], ["kimi", loadKimi]] as const) {
    const cache = loader();
    if (cache) {
      snapshot.push({ provider, count: cache.models.length });
      out.push(...cache.models.map((m) => toCandidate(m, provider)));
    } else {
      snapshot.push({ provider, count: 0 });
      if (provider === "openrouter") console.warn("OpenRouter lineup cache missing or stale; continuing with the other lineup sources");
    }
  }
  const benchmark = loadZourobenchEvidence();
  const candidates = out.map((candidate) => ({
    ...candidate,
    benchmarkEvidence: benchmark.byCanonicalModel.get(candidate.canonicalModel),
  }));
  return { candidates, snapshot, benchmarkSnapshot: benchmark.summary };
}

function benchmarkRoleScore(candidate: Candidate, role: BenchmarkLineupRole): number | null {
  return candidate.benchmarkEvidence?.roles[role]?.selectionFloor ?? null;
}

// Deterministic sort: publishable role evidence first, conservative role score
// descending, then the existing provider/cost/family policy. Unknown benchmark
// evidence remains eligible but cannot outrank comparable measured evidence.
export function sortCandidates(c: Candidate[], role: BenchmarkLineupRole = "proposer"): Candidate[] {
  return [...c].sort(
    (a, b) => {
      const aBenchmark = benchmarkRoleScore(a, role);
      const bBenchmark = benchmarkRoleScore(b, role);
      return Number(bBenchmark !== null) - Number(aBenchmark !== null) ||
      (bBenchmark ?? 0) - (aBenchmark ?? 0) ||
      providerRank(a) - providerRank(b) ||
      a.totalCost - b.totalCost ||
      a.family.localeCompare(b.family) ||
      compareFamilyLabels(a.family, a.label, b.label) ||
      a.id.localeCompare(b.id);
    }
  );
}

export function sortCandidatesForSelection(
  candidates: Candidate[],
  sourceTiers: readonly Tier[],
  role: BenchmarkLineupRole = "proposer",
): Candidate[] {
  const tierRank = new Map(sourceTiers.map((tier, index) => [tier, index]));
  return sortCandidates(candidates, role).sort(
    (a, b) => (tierRank.get(a.tier) ?? Number.MAX_SAFE_INTEGER) -
      (tierRank.get(b.tier) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function pickLineup(
  pool: Candidate[],
  opts: {
    proposerCount: number;
    pinProposers: string[];
    pinAggregator: string | null;
    profile?: LineupProfile;
    roleProfile?: ModelRoleProfile;
    weightPolicy?: WeightPolicy;
    mode?: ReadinessMode;
  },
): Lineup {
  const profile = opts.profile ?? "flagship";
  const mode = opts.mode ?? "production";
  const selection = resolveLineupSelection(profile, opts.roleProfile, opts.weightPolicy);
  const blocked = blockedSet(selection, mode);
  const eligiblePool = pool.filter((c) => {
    const roleEligible = selection.sourceTiers.includes(c.tier);
    const weightEligible = selection.weightPolicy === "open-only"
      ? openWeightsBlockers(c, mode, null).length === 0
      : weightPolicyBlockers(c, selection.weightPolicy).length === 0;
    const healthEligible = mode === "rehearsal" || c.routeHealth === "healthy";
    return roleEligible && weightEligible && healthEligible && !blocked.has(c.id);
  });
  const proposerRole: BenchmarkLineupRole = selection.rankingRole;
  const eligible = sortCandidatesForSelection(eligiblePool, selection.sourceTiers, proposerRole);
  const aggregatorEligible = sortCandidatesForSelection(eligiblePool, selection.sourceTiers, "aggregator");
  const familiesUsed = new Set<string>();
  const candidatesById = new Map(eligible.map((candidate) => [candidate.id, candidate]));
  const resolvePin = (id: string): string => {
    const resolved = resolveModelIdentity(id).resolvedId;
    return candidatesById.has(resolved) ? resolved : id;
  };

  // --- Pin path (manual override) ---
  if (opts.pinProposers.length || opts.pinAggregator) {
    const proposers = opts.pinProposers.length ? opts.pinProposers.map(resolvePin) : eligible.slice(0, opts.proposerCount).map((c) => c.id);
    for (const id of proposers) {
      const candidate = candidatesById.get(id);
      if (candidate) familiesUsed.add(candidate.family);
    }
    let aggregator = opts.pinAggregator ? resolvePin(opts.pinAggregator) : null;
    if (!aggregator && eligible.length) {
      aggregator = aggregatorEligible.find((c) => !proposers.includes(c.id) && !familiesUsed.has(c.family))?.id
        ?? aggregatorEligible.find((c) => !proposers.includes(c.id))?.id ?? null;
    }
    return {
      proposers, aggregator: aggregator ?? "", generatedAt: new Date().toISOString(),
      catalogSnapshot: [], pinned: true,
      note: opts.pinProposers.length ? "pinned proposers" : "pinned aggregator",
      readiness: mode,
      productionValid: mode === "production",
      roleProfile: selection.roleProfile,
      capabilityTier: selection.capabilityTier,
      weightPolicy: selection.weightPolicy,
      sourceTiers: selection.sourceTiers,
    };
  }

  // --- Dynamic selection ---
  const proposers: string[] = [];
  for (const c of eligible) {
    if (proposers.length >= opts.proposerCount) break;
    if (familiesUsed.has(c.family)) continue; // vendor diversity
    proposers.push(c.id);
    familiesUsed.add(c.family);
  }

  // Aggregator: cheapest eligible model from a family NOT already used by proposers (broadest ensemble)
  const aggregator = aggregatorEligible.find((c) => !proposers.includes(c.id) && !familiesUsed.has(c.family))?.id ?? "";
  const blockers: string[] = [];
  const availableFamilies = new Set(eligible.map((candidate) => candidate.family));
  if (proposers.length < opts.proposerCount) {
    blockers.push(`${selection.roleProfile}/${selection.weightPolicy} pool has ${proposers.length} distinct proposer families; need ${opts.proposerCount}`);
  }
  if (!aggregator) {
    blockers.push(`${selection.roleProfile}/${selection.weightPolicy} pool needs one additional family for a distinct aggregator; available families=${availableFamilies.size}`);
  }

  return {
    proposers, aggregator, generatedAt: new Date().toISOString(),
    catalogSnapshot: [], pinned: false,
    readiness: mode,
    productionValid: mode === "production" && blockers.length === 0,
    blockers,
    roleProfile: selection.roleProfile,
    capabilityTier: selection.capabilityTier,
    weightPolicy: selection.weightPolicy,
    sourceTiers: selection.sourceTiers,
  };
}

export function validateLineup(
  lineup: Lineup,
  candidates: Candidate[],
  proposerCount: number,
  blocked: Set<string> = new Set([...quarantinedSet(), ...provisionalSet()]),
): { valid: boolean; errors: string[]; families: Set<string> } {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const errors: string[] = [];
  const members = [...lineup.proposers, lineup.aggregator].filter(Boolean);
  for (const id of members) {
    const candidate = byId.get(id);
    if (!candidate) errors.push(`unknown lineup id: ${id}`);
    else if (blocked.has(id)) errors.push(`ineligible lineup id: ${id}`);
    else if (candidate.routeHealth !== "healthy") errors.push(`unhealthy lineup id: ${id} (${candidate.routeHealth})`);
  }
  const families = new Set(lineup.proposers.map((id) => byId.get(id)?.family).filter((value): value is string => Boolean(value)));
  const targetCount = lineup.pinned ? lineup.proposers.length : proposerCount;
  if (lineup.proposers.length !== targetCount) errors.push(`expected ${targetCount} proposers, got ${lineup.proposers.length}`);
  if (families.size !== lineup.proposers.length) errors.push("proposer families must be canonical and distinct");
  if (!lineup.aggregator) errors.push("aggregator is required");
  if (lineup.proposers.includes(lineup.aggregator)) errors.push("aggregator must be distinct from proposers");
  const aggregator = byId.get(lineup.aggregator);
  if (aggregator && families.has(aggregator.family)) errors.push("aggregator family must be distinct from proposer families");
  return { valid: errors.length === 0, errors, families };
}

export function validatePersistedLineup(
  profile: LineupProfile,
  persisted: PersistedLineup,
  candidates: Candidate[],
  blocked: Set<string> = new Set([...quarantinedSet(), ...provisionalSet()]),
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const expectedSelection = resolveLineupSelection(profile);
  if (persisted.valid !== true) errors.push("artifact is not marked valid");
  if (persisted.profile !== profile) {
    errors.push(`artifact profile mismatch: expected ${profile}, got ${String(persisted.profile)}`);
  }

  const lineup = persisted.lineup;
  if (!lineup || !Array.isArray(lineup.proposers) || typeof lineup.aggregator !== "string") {
    errors.push("artifact lineup is malformed");
    return { valid: false, errors };
  }

  if (profile === "open-weights") {
    if (lineup.readiness === "rehearsal") {
      errors.push("rehearsal artifact cannot be production-valid");
    }
    if (lineup.productionValid === false) {
      errors.push("artifact productionValid=false");
    }
  }

  if (persisted.roleProfile && persisted.roleProfile !== expectedSelection.roleProfile) {
    errors.push(`artifact role mismatch: expected ${expectedSelection.roleProfile}, got ${persisted.roleProfile}`);
  }
  if (persisted.weightPolicy && persisted.weightPolicy !== expectedSelection.weightPolicy) {
    errors.push(`artifact weight policy mismatch: expected ${expectedSelection.weightPolicy}, got ${persisted.weightPolicy}`);
  }

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of [...lineup.proposers, lineup.aggregator].filter(Boolean)) {
    const candidate = byId.get(id);
    if (candidate && profile === "open-weights") {
      errors.push(...openWeightsBlockers(candidate, "production").map((blocker) => `persisted lineup member blocked: ${blocker}`));
    } else if (candidate && !expectedSelection.sourceTiers.includes(candidate.tier)) {
      errors.push(`profile-ineligible lineup id: ${id}`);
    } else if (candidate) {
      errors.push(...weightPolicyBlockers(candidate, expectedSelection.weightPolicy)
        .map((blocker) => `persisted lineup member blocked: ${blocker}`));
    }
  }

  errors.push(...validateLineup(lineup, candidates, 3, blocked).errors);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validatePersistedRoleLineup(
  roleProfile: ModelRoleProfile,
  weightPolicy: WeightPolicy,
  persisted: PersistedLineup,
  candidates: Candidate[],
  blocked: Set<string> = new Set([...quarantinedSet(), ...provisionalSet()]),
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const selection = resolveLineupSelection(persisted.profile, roleProfile, weightPolicy);
  if (persisted.valid !== true) errors.push("artifact is not marked valid");
  if (persisted.roleProfile && persisted.roleProfile !== roleProfile) {
    errors.push(`artifact role mismatch: expected ${roleProfile}, got ${persisted.roleProfile}`);
  }
  if (persisted.weightPolicy && persisted.weightPolicy !== weightPolicy) {
    errors.push(`artifact weight policy mismatch: expected ${weightPolicy}, got ${persisted.weightPolicy}`);
  }
  const lineup = persisted.lineup;
  if (!lineup || !Array.isArray(lineup.proposers) || typeof lineup.aggregator !== "string") {
    return { valid: false, errors: [...errors, "artifact lineup is malformed"] };
  }
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of [...lineup.proposers, lineup.aggregator].filter(Boolean)) {
    const candidate = byId.get(id);
    if (!candidate) continue;
    if (!selection.sourceTiers.includes(candidate.tier)) errors.push(`role-ineligible lineup id: ${id}`);
    errors.push(...weightPolicyBlockers(candidate, weightPolicy)
      .map((blocker) => `persisted lineup member blocked: ${blocker}`));
  }
  errors.push(...validateLineup(lineup, candidates, 3, blocked).errors);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function buildLineupRole(
  primary: string,
  candidates: Candidate[],
  blocked: Set<string> = new Set([...quarantinedSet(), ...provisionalSet()]),
): LineupRole {
  const resolvedPrimary = resolveModelIdentity(primary).resolvedId;
  const primaryCandidate = candidates.find((candidate) => candidate.id === resolvedPrimary);
  if (!primaryCandidate) return { primary, fallbacks: [] };
  const seenProviders = new Set([primaryCandidate.provider]);
  const fallbacks = sortCandidates(candidates)
    .filter((candidate) =>
      candidate.id !== resolvedPrimary &&
      !blocked.has(candidate.id) &&
      candidate.routeHealth === "healthy" &&
      candidate.canonicalModel === primaryCandidate.canonicalModel &&
      candidate.family === primaryCandidate.family
    )
    .filter((candidate) => {
      if (seenProviders.has(candidate.provider)) return false;
      seenProviders.add(candidate.provider);
      return true;
    })
    .map((candidate) => candidate.id);
  return { primary, fallbacks };
}

export function buildRoleConfig(lineup: Lineup, candidates: Candidate[]): LineupRoleConfig {
  return {
    proposers: lineup.proposers.map((primary) => buildLineupRole(primary, candidates)),
    aggregator: buildLineupRole(lineup.aggregator, candidates),
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      proposers: { type: "string", default: "3" },
      profile: { type: "string" },
      role: { type: "string" },
      weights: { type: "string" },
      mode: { type: "string", default: "production" },
      rehearsal: { type: "boolean", default: false },
      "pin-proposer": { type: "string", multiple: true },
      "pin-aggregator": { type: "string" },
      validate: { type: "boolean", default: false },
      "with-fallbacks": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  // Profile resolution: CLI --profile wins over LINEUP_PROFILE env; default flagship (ZOU-576)
  const rawProfile = (typeof values.profile === "string" ? values.profile : process.env.LINEUP_PROFILE) ?? "flagship";
  if (!isLineupProfile(rawProfile)) {
    console.error(`❌ Unknown profile "${rawProfile}". Valid profiles: ${Object.keys(PROFILES).join(", ")}`);
    process.exit(1);
  }
  const profile: LineupProfile = rawProfile;
  const explicitRole = typeof values.role === "string" || typeof process.env.LINEUP_ROLE_PROFILE === "string";
  const rawRole = (typeof values.role === "string" ? values.role : process.env.LINEUP_ROLE_PROFILE)
    ?? LEGACY_PROFILE_PRESETS[profile].roleProfile;
  if (!isModelRoleProfile(rawRole)) {
    console.error(`❌ Unknown role "${rawRole}". Valid roles: ${Object.keys(ROLE_PROFILES).join(", ")}`);
    process.exit(1);
  }
  const roleProfile: ModelRoleProfile = rawRole;
  const explicitWeightPolicy = typeof values.weights === "string" || typeof process.env.LINEUP_WEIGHT_POLICY === "string";
  const rawWeightPolicy = (typeof values.weights === "string" ? values.weights : process.env.LINEUP_WEIGHT_POLICY)
    ?? LEGACY_PROFILE_PRESETS[profile].weightPolicy;
  if (!isWeightPolicy(rawWeightPolicy)) {
    console.error(`❌ Unknown weight policy "${rawWeightPolicy}". Valid policies: any, open-only, closed-only`);
    process.exit(1);
  }
  const weightPolicy: WeightPolicy = rawWeightPolicy;
  const rawMode = values.rehearsal === true ? "rehearsal" : values.mode;
  if (rawMode !== "production" && rawMode !== "rehearsal") {
    console.error(`❌ Unknown readiness mode "${String(rawMode)}". Valid modes: production, rehearsal`);
    process.exit(1);
  }
  const mode: ReadinessMode = rawMode;
  migrateLegacyFlagshipArtifact();

  const proposerCount = parseInt(typeof values.proposers === "string" ? values.proposers : "3", 10);
  const envRoleConfig = process.env.LINEUP_ROLE_CHAINS ? parseLineupRoleConfig(process.env.LINEUP_ROLE_CHAINS) : null;
  const pinProposers = [
    ...((values["pin-proposer"] as string[] | undefined) ?? []),
    ...(process.env.LINEUP_PIN_PROPOSERS ? process.env.LINEUP_PIN_PROPOSERS.split(",").map((s) => s.trim()).filter(Boolean) : []),
    ...(!process.env.LINEUP_PIN_PROPOSERS && envRoleConfig ? envRoleConfig.proposers.map((role) => typeof role === "string" ? role : role.primary) : []),
  ];
  const parsedPinAggregator = values["pin-aggregator"];
  const pinAggregator = typeof parsedPinAggregator === "string"
    ? parsedPinAggregator
    : process.env.LINEUP_PIN_AGGREGATOR
      ?? (envRoleConfig ? (typeof envRoleConfig.aggregator === "string" ? envRoleConfig.aggregator : envRoleConfig.aggregator.primary) : null);

  const { candidates, snapshot, benchmarkSnapshot } = buildPool();
  const lineup = pickLineup(candidates, {
    proposerCount,
    pinProposers,
    pinAggregator,
    profile,
    roleProfile: explicitRole ? roleProfile : undefined,
    weightPolicy: explicitWeightPolicy ? weightPolicy : undefined,
    mode,
  });
  lineup.catalogSnapshot = snapshot;
  lineup.benchmarkSnapshot = benchmarkSnapshot;

  // Validate: vendor diversity + non-empty + distinct aggregator
  const validation = validateLineup(lineup, candidates, proposerCount);
  const valid = mode === "production" && validation.valid && lineup.productionValid !== false;
  const families = validation.families;

  if (values.validate && !valid) {
    const blockers = [...validation.errors, ...(lineup.blockers ?? [])];
    console.error(`❌ Invalid lineup [profile=${profile}, mode=${mode}]: ${blockers.join("; ")}; got ${lineup.proposers.length} proposers (${[...families].join(",")}), aggregator=${lineup.aggregator}`);
    process.exit(1);
  }

  // Persist last-good lineup to disk (ZOU-413 cache for #gate renderer + API route;
  // non-flagship profiles write lineup.<profile>.json, never the flagship singleton)
  const persisted = values["dry-run"] !== true && shouldPersistLineup(valid, lineup);
  if (persisted) persistLineup(valid, lineup, candidates, profile);

  if (values.json) {
    console.log(JSON.stringify({
      valid,
      profile,
      roleProfile,
      capabilityTier: lineup.capabilityTier,
      weightPolicy,
      readiness: mode,
      productionValid: valid,
      blockers: lineup.blockers ?? [],
      benchmarkEvidence: benchmarkSnapshot,
      persisted,
      lineup,
      ...(values["with-fallbacks"] ? { roleChains: envRoleConfig ?? buildRoleConfig(lineup, candidates) } : {}),
    }, null, 2));
  } else {
    console.log("MoA Lineup (ZOU-411)");
    console.log("===================");
    console.log(`Generated: ${lineup.generatedAt}`);
    console.log(`Role: ${roleProfile} — ${ROLE_PROFILES[roleProfile].description}`);
    console.log(`Capability tier: ${lineup.capabilityTier}`);
    console.log(`Weight policy: ${weightPolicy}`);
    if (profile !== "flagship" || roleProfile !== "deep-reasoning" || weightPolicy !== "any") {
      console.log(`Compatibility preset: ${profile} — ${PROFILES[profile].description}`);
    }
    console.log(`Readiness: ${mode}${mode === "rehearsal" ? " (non-production)" : ""}`);
    console.log(`Pinned: ${lineup.pinned}${lineup.note ? ` (${lineup.note})` : ""}`);
    console.log(`Persisted: ${persisted}`);
    console.log(`Catalog snapshot: ${snapshot.map((s) => `${s.provider}=${s.count}`).join(", ")}`);
    console.log(`ZouroBench evidence: ${benchmarkSnapshot.qualifiedModels} qualified model(s), ${benchmarkSnapshot.underpoweredCohorts} underpowered cohort(s), ranking-role=${ROLE_PROFILES[roleProfile].rankingRole}`);
    console.log("");
    console.log(`Proposers (${lineup.proposers.length}):`);
    for (const p of lineup.proposers) console.log(`  • ${p}`);
    console.log(`Aggregator: ${lineup.aggregator || "(none)"}`);
    if (lineup.blockers?.length) console.log(`Blockers: ${lineup.blockers.join("; ")}`);
    console.log(`\n${valid ? "✅ valid" : "⚠️ invalid"} — vendor diversity ${families.size === lineup.proposers.length ? "enforced" : "VIOLATED"}`);
  }
  process.exit(0);
}

if (import.meta.main) main();
