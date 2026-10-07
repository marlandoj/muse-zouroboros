import { getActiveModels } from "./quarantine";
import { readSharedCatalog } from "../../../packages/zo-swarm-orchestrator/src/routing/shared-catalog";
import {
  isLineupProfile,
  loadPersistedLineup,
  loadPersistedRoleLineup,
  type LineupProfile,
  type PersistedLineup,
} from "./lineup-picker";
import {
  LEGACY_PROFILE_PRESETS,
  isModelRoleProfile,
  isWeightPolicy,
  legacyProfileForSelection,
  type ModelRoleProfile,
  type WeightPolicy,
} from "./lineup-taxonomy";

export type ConsensusLineupSource = "explicit" | "persisted-profile" | "legacy";

export interface ResolvedConsensusLineup {
  models: string[];
  source: ConsensusLineupSource;
  profile?: LineupProfile;
  roleProfile?: ModelRoleProfile;
  weightPolicy?: WeightPolicy;
}

type Env = Record<string, string | undefined>;

interface ConsensusLineupDependencies {
  loadPersistedLineup: (profile: LineupProfile) => PersistedLineup | null;
  loadPersistedRoleLineup: (roleProfile: ModelRoleProfile, weightPolicy: WeightPolicy) => PersistedLineup | null;
  getActiveModels: () => string[];
  warn: (message: string) => void;
}

export function resolveConsensusLineup(env: Env = process.env, dependencies?: ConsensusLineupDependencies): ResolvedConsensusLineup {
  if (readSharedCatalog() && process.env.FACTORY_MODEL_REVIEW !== "operator") {
    throw new Error("Model Consensus Gate is retired; use persona-based Diversity of Thought. Legacy experiments require explicit operator authorization.");
  }
  const result = resolveExistingConsensusLineup(env, dependencies);
  return result;
}

const DEFAULT_DEPENDENCIES: ConsensusLineupDependencies = {
  loadPersistedLineup,
  loadPersistedRoleLineup,
  getActiveModels,
  warn: (message) => console.error(message),
};

function resolveExistingConsensusLineup(
  env: Env = process.env,
  dependencies: ConsensusLineupDependencies = DEFAULT_DEPENDENCIES,
): ResolvedConsensusLineup {
  const explicit = env.CONSENSUS_MODELS;
  if (explicit) {
    return {
      models: explicit.split(",").map((model) => model.trim()).filter(Boolean),
      source: "explicit",
    };
  }

  const profile = env.GATE_LINEUP_PROFILE;
  const requestedRole = env.GATE_LINEUP_ROLE;
  const requestedWeightPolicy = env.GATE_LINEUP_WEIGHT_POLICY;
  if (requestedRole || requestedWeightPolicy) {
    if (profile && !isLineupProfile(profile)) {
      dependencies.warn(`GATE_LINEUP_PROFILE="${profile}" is not a known compatibility preset; using the default panel`);
    } else {
      const preset = profile ? LEGACY_PROFILE_PRESETS[profile] : LEGACY_PROFILE_PRESETS.flagship;
      const roleProfile = requestedRole ?? preset.roleProfile;
      const weightPolicy = requestedWeightPolicy ?? preset.weightPolicy;
      if (!isModelRoleProfile(roleProfile) || !isWeightPolicy(weightPolicy)) {
        dependencies.warn(`Invalid role/weight selection (${roleProfile}/${weightPolicy}); using the default panel`);
      } else {
        const persisted = dependencies.loadPersistedRoleLineup(roleProfile, weightPolicy);
        if (persisted?.valid && persisted.lineup.proposers.length) {
          return {
            models: persisted.lineup.proposers,
            source: "persisted-profile",
            profile: legacyProfileForSelection(roleProfile, weightPolicy) ?? undefined,
            roleProfile,
            weightPolicy,
          };
        }
        dependencies.warn(`Role selection ${roleProfile}/${weightPolicy} has no valid persisted lineup; using the default panel`);
      }
    }
  }
  if (profile) {
    if (!isLineupProfile(profile)) {
      dependencies.warn(`GATE_LINEUP_PROFILE="${profile}" is not a known profile; using the default panel`);
    } else {
      const persisted = dependencies.loadPersistedLineup(profile);
      if (persisted?.valid && persisted.lineup.proposers.length) {
        return {
          models: persisted.lineup.proposers,
          source: "persisted-profile",
          profile,
          roleProfile: persisted.roleProfile,
          weightPolicy: persisted.weightPolicy,
        };
      }
      dependencies.warn(`GATE_LINEUP_PROFILE=${profile} has no valid persisted lineup; using the default panel`);
    }
  }

  return { models: dependencies.getActiveModels(), source: "legacy" };
}
