import type { LifecycleStatus, Tier } from "./catalog";

export type ModelRoleProfile = "deep-reasoning" | "coding" | "fast" | "judge";
export type CapabilityTier = "frontier" | "strong" | "efficient" | "experimental";
export type WeightPolicy = "any" | "open-only" | "closed-only";
export type LegacyLineupProfile = "flagship" | "open-weights" | "fast" | "coder" | "judge";
export type RankingRole = "proposer" | "aggregator" | "coder";

export interface RoleProfileSpec {
  role: ModelRoleProfile;
  capabilityTier: Exclude<CapabilityTier, "experimental">;
  sourceTiers: readonly Tier[];
  rankingRole: RankingRole;
  description: string;
}

export interface LineupSelection {
  roleProfile: ModelRoleProfile;
  capabilityTier: Exclude<CapabilityTier, "experimental">;
  weightPolicy: WeightPolicy;
  rankingRole: RankingRole;
  sourceTiers: readonly Tier[];
  description: string;
}

export const ROLE_PROFILES: Record<ModelRoleProfile, RoleProfileSpec> = {
  "deep-reasoning": {
    role: "deep-reasoning",
    capabilityTier: "frontier",
    sourceTiers: ["flagship"],
    rankingRole: "proposer",
    description: "architecture, difficult reasoning, and high-complexity synthesis",
  },
  coding: {
    role: "coding",
    capabilityTier: "strong",
    sourceTiers: ["coder"],
    rankingRole: "coder",
    description: "implementation, refactoring, tests, and code repair",
  },
  fast: {
    role: "fast",
    capabilityTier: "efficient",
    sourceTiers: ["fast"],
    rankingRole: "proposer",
    description: "routine, latency-sensitive, and low-cost work",
  },
  judge: {
    role: "judge",
    capabilityTier: "frontier",
    sourceTiers: ["flagship"],
    rankingRole: "aggregator",
    description: "structured review, objection quality, and adjudication",
  },
};

export const LEGACY_PROFILE_PRESETS: Record<LegacyLineupProfile, {
  roleProfile: ModelRoleProfile;
  weightPolicy: WeightPolicy;
  sourceTiers?: readonly Tier[];
}> = {
  flagship: { roleProfile: "deep-reasoning", weightPolicy: "any" },
  "open-weights": {
    roleProfile: "deep-reasoning",
    weightPolicy: "open-only",
    sourceTiers: ["flagship", "coder", "fast"],
  },
  fast: { roleProfile: "fast", weightPolicy: "any" },
  coder: { roleProfile: "coding", weightPolicy: "any" },
  judge: { roleProfile: "judge", weightPolicy: "any" },
};

export function isModelRoleProfile(value: string): value is ModelRoleProfile {
  return Object.prototype.hasOwnProperty.call(ROLE_PROFILES, value);
}

export function isWeightPolicy(value: string): value is WeightPolicy {
  return value === "any" || value === "open-only" || value === "closed-only";
}

export function resolveLineupSelection(
  profile: LegacyLineupProfile = "flagship",
  roleProfile?: ModelRoleProfile,
  weightPolicy?: WeightPolicy,
): LineupSelection {
  const preset = LEGACY_PROFILE_PRESETS[profile];
  const role = roleProfile ?? preset.roleProfile;
  const spec = ROLE_PROFILES[role];
  return {
    roleProfile: role,
    capabilityTier: spec.capabilityTier,
    weightPolicy: weightPolicy ?? preset.weightPolicy,
    rankingRole: spec.rankingRole,
    sourceTiers: roleProfile ? spec.sourceTiers : preset.sourceTiers ?? spec.sourceTiers,
    description: spec.description,
  };
}

export function modelRoleFitFor(tier: Tier): ModelRoleProfile[] {
  if (tier === "coder") return ["coding"];
  if (tier === "fast") return ["fast"];
  return ["deep-reasoning", "judge"];
}

export function capabilityTierFor(tier: Tier, lifecycleStatus: LifecycleStatus = "unknown"): CapabilityTier {
  if (lifecycleStatus !== "promoted" && lifecycleStatus !== "unknown") return "experimental";
  if (tier === "fast") return "efficient";
  if (tier === "coder") return "strong";
  return "frontier";
}

export function weightPolicyBlockers(
  candidate: { id: string; openWeights?: boolean | null },
  policy: WeightPolicy,
): string[] {
  if (policy === "any") return [];
  if (policy === "open-only") {
    if (candidate.openWeights === true) return [];
    return [candidate.openWeights === false
      ? `${candidate.id}: weight policy requires open weights but catalog metadata marks weights closed`
      : `${candidate.id}: weight policy requires open weights but provenance is unknown`];
  }
  if (candidate.openWeights === false) return [];
  return [candidate.openWeights === true
    ? `${candidate.id}: weight policy requires closed weights but catalog metadata marks weights open`
    : `${candidate.id}: weight policy requires closed weights but provenance is unknown`];
}

export function legacyProfileForSelection(roleProfile: ModelRoleProfile, weightPolicy: WeightPolicy): LegacyLineupProfile | null {
  if (roleProfile === "deep-reasoning" && weightPolicy === "any") return "flagship";
  if (roleProfile === "deep-reasoning" && weightPolicy === "open-only") return "open-weights";
  if (roleProfile === "coding" && weightPolicy === "any") return "coder";
  if (roleProfile === "fast" && weightPolicy === "any") return "fast";
  if (roleProfile === "judge" && weightPolicy === "any") return "judge";
  return null;
}
