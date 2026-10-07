#!/usr/bin/env bun
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "util";
import { buildPool, sortCandidates, type Candidate } from "./lineup-picker";
import { DEFAULT_PERSONA_PANEL_PATH } from "./persona-panel";
import {
  ROLE_PROFILES,
  isWeightPolicy,
  weightPolicyBlockers,
  type CapabilityTier,
  type ModelRoleProfile,
  type WeightPolicy,
} from "./lineup-taxonomy";
import { resolveModelIdentity } from "./model-identity";

export const CONSENSUS_PROFILE_SCHEMA_VERSION = 2;
export const DEFAULT_CONSENSUS_PROFILE_PATH = `${process.env.HOME}/.zouroboros/lineup.consensus.json`;

export type ConsensusSeatRole = "reviewer" | "adjudicator";
export type ConsensusSeatName = "reviewer-1" | "reviewer-2" | "reviewer-3" | "adjudicator";

export interface ConsensusSeat {
  seat: ConsensusSeatName;
  role: ConsensusSeatRole;
  id: string;
  name: string;
  family: string;
  provider: string;
  fallbacks: string[];
}

export interface ConsensusPolicy {
  rubricVersion: string;
  automaticPass: "unanimous-reviewers-only";
  unavailableSeat: "hold";
  criticalObjection: "hold";
  splitPassAuthority: "disabled-until-shadow-promotion";
}

export interface ConsensusProfileArtifact {
  schemaVersion: number;
  profile: "consensus";
  roleProfile?: ModelRoleProfile;
  capabilityTier?: CapabilityTier;
  weightPolicy?: WeightPolicy;
  topology: "three-blind-reviewers-plus-independent-adjudicator";
  status: "shadow";
  valid: boolean;
  generatedAt: string;
  catalogSnapshot: { provider: string; count: number }[];
  reviewers: [ConsensusSeat, ConsensusSeat, ConsensusSeat];
  adjudicator: ConsensusSeat;
  policy: ConsensusPolicy;
  lineupHash: string;
}

export interface ConsensusProfileValidation {
  valid: boolean;
  errors: string[];
}

const DEFAULT_POLICY: ConsensusPolicy = {
  rubricVersion: "consensus-quality-v1",
  automaticPass: "unanimous-reviewers-only",
  unavailableSeat: "hold",
  criticalObjection: "hold",
  splitPassAuthority: "disabled-until-shadow-promotion",
};

function seatFromCandidate(candidate: Candidate, seat: ConsensusSeatName, role: ConsensusSeatRole): ConsensusSeat {
  return {
    seat,
    role,
    id: candidate.id,
    name: candidate.label,
    family: candidate.family,
    provider: candidate.provider,
    fallbacks: [],
  };
}

function hashLineup(reviewers: ConsensusSeat[], adjudicator: ConsensusSeat): string {
  const payload = [...reviewers, adjudicator].map((seat) => ({
    seat: seat.seat,
    role: seat.role,
    id: seat.id,
    family: seat.family,
    provider: seat.provider,
    fallbacks: seat.fallbacks,
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function validateConsensusProfile(artifact: ConsensusProfileArtifact): ConsensusProfileValidation {
  const errors: string[] = [];
  if (artifact.schemaVersion !== 1 && artifact.schemaVersion !== CONSENSUS_PROFILE_SCHEMA_VERSION) errors.push("unsupported schemaVersion");
  if (artifact.profile !== "consensus") errors.push("profile must be consensus");
  if (artifact.schemaVersion >= 2) {
    if (artifact.roleProfile !== "judge") errors.push("roleProfile must be judge");
    if (artifact.capabilityTier !== "frontier") errors.push("capabilityTier must be frontier");
    if (!artifact.weightPolicy || !isWeightPolicy(artifact.weightPolicy)) errors.push("weightPolicy is invalid");
  }
  if (artifact.topology !== "three-blind-reviewers-plus-independent-adjudicator") errors.push("invalid topology");
  if (artifact.status !== "shadow") errors.push("consensus profile must remain shadow until promotion");
  if (!Array.isArray(artifact.reviewers) || artifact.reviewers.length !== 3) errors.push("exactly three reviewers are required");

  const seats = [...(artifact.reviewers ?? []), artifact.adjudicator].filter(Boolean);
  const expectedSeats = ["reviewer-1", "reviewer-2", "reviewer-3", "adjudicator"];
  if (seats.length !== 4) errors.push("exactly four seats are required");
  if (seats.map((seat) => seat.seat).join(",") !== expectedSeats.join(",")) errors.push("seat order or names are invalid");
  if (artifact.reviewers?.some((seat) => seat.role !== "reviewer")) errors.push("reviewer seats must use reviewer role");
  if (artifact.adjudicator?.role !== "adjudicator") errors.push("adjudicator seat must use adjudicator role");

  for (const seat of seats) {
    if (!seat.id || !seat.name || !seat.family || !seat.provider) errors.push(`${seat.seat} has incomplete identity metadata`);
    if (!Array.isArray(seat.fallbacks)) errors.push(`${seat.seat} fallbacks must be an array`);
  }

  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(seats.map((seat) => seat.id))) errors.push("all four model ids must be distinct");
  if (!unique(seats.map((seat) => seat.family))) errors.push("all four model families must be distinct");

  const expectedHash = seats.length === 4 ? hashLineup(artifact.reviewers, artifact.adjudicator) : "";
  if (artifact.lineupHash !== expectedHash) errors.push("lineupHash does not match the ordered seats");
  if (artifact.policy?.automaticPass !== "unanimous-reviewers-only") errors.push("automaticPass must require unanimous reviewers");
  if (artifact.policy?.splitPassAuthority !== "disabled-until-shadow-promotion") errors.push("split-pass authority must remain disabled");

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function resolvePinned(candidates: Candidate[], ids: string[]): Candidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return ids.map((id) => {
    const candidate = byId.get(id);
    if (candidate) return candidate;
    if (!id.startsWith("xai:")) throw new Error(`pinned consensus model is unavailable in the catalog: ${id}`);
    const identity = resolveModelIdentity(id);
    if (identity.provider === "unknown" || identity.family === "unknown") throw new Error(`pinned consensus model has unresolved identity: ${id}`);
    return {
      id,
      label: identity.displayName,
      family: identity.family,
      canonicalModel: identity.model,
      tier: "flagship",
      provider: identity.provider,
      promptCost: 0,
      completionCost: 0,
      totalCost: 0,
      subscription: false,
    };
  });
}

function pickDistinct(candidates: Candidate[], count: number, used: Candidate[] = []): Candidate[] {
  const selected = [...used];
  const additions: Candidate[] = [];
  for (const candidate of sortCandidates(candidates, "aggregator")) {
    if (selected.some((seat) => seat.id === candidate.id)) continue;
    if (selected.some((seat) => seat.family === candidate.family)) continue;
    selected.push(candidate);
    additions.push(candidate);
    if (additions.length === count) break;
  }
  return additions;
}

export function buildConsensusProfile(
  candidates: Candidate[],
  options: {
    reviewerIds?: string[];
    adjudicatorId?: string;
    generatedAt?: string;
    catalogSnapshot?: { provider: string; count: number }[];
    weightPolicy?: WeightPolicy;
  } = {},
): ConsensusProfileArtifact {
  const weightPolicy = options.weightPolicy ?? "any";
  const eligible = candidates.filter((candidate) =>
    ROLE_PROFILES.judge.sourceTiers.includes(candidate.tier) &&
    weightPolicyBlockers(candidate, weightPolicy).length === 0
  );
  if (options.reviewerIds && options.reviewerIds.length !== 3) {
    throw new Error(`consensus profile requires exactly three pinned reviewers; received ${options.reviewerIds.length}`);
  }
  const reviewers = options.reviewerIds?.length
    ? resolvePinned(eligible, options.reviewerIds)
    : pickDistinct(eligible, 3);
  if (reviewers.length !== 3) throw new Error(`consensus profile needs three distinct reviewer model families; found ${reviewers.length}`);

  const adjudicator = options.adjudicatorId
    ? resolvePinned(eligible, [options.adjudicatorId])[0]
    : pickDistinct(eligible, 1, reviewers)[0];
  if (!adjudicator) throw new Error("consensus profile needs a fourth distinct adjudicator model family");

  const reviewerSeats = reviewers.map((candidate, index) =>
    seatFromCandidate(candidate, `reviewer-${index + 1}` as ConsensusSeatName, "reviewer")
  ) as [ConsensusSeat, ConsensusSeat, ConsensusSeat];
  const adjudicatorSeat = seatFromCandidate(adjudicator, "adjudicator", "adjudicator");
  const artifact: ConsensusProfileArtifact = {
    schemaVersion: CONSENSUS_PROFILE_SCHEMA_VERSION,
    profile: "consensus",
    roleProfile: "judge",
    capabilityTier: ROLE_PROFILES.judge.capabilityTier,
    weightPolicy,
    topology: "three-blind-reviewers-plus-independent-adjudicator",
    status: "shadow",
    valid: true,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    catalogSnapshot: options.catalogSnapshot ?? [],
    reviewers: reviewerSeats,
    adjudicator: adjudicatorSeat,
    policy: { ...DEFAULT_POLICY },
    lineupHash: hashLineup(reviewerSeats, adjudicatorSeat),
  };
  const validation = validateConsensusProfile(artifact);
  artifact.valid = validation.valid;
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return artifact;
}

export function loadConsensusProfile(profilePath = DEFAULT_CONSENSUS_PROFILE_PATH): ConsensusProfileArtifact {
  const raw: unknown = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  // Name the collision before the schema wall. A wall of field errors tells the
  // operator nothing about which artifact is actually sitting in the file.
  const probe = raw as { profile?: unknown; diversityAxis?: unknown } | null;
  if (probe && (probe.profile === "consensus-persona-panel" || probe.diversityAxis === "persona")) {
    throw new Error(
      `${profilePath} holds a persona-panel artifact, not a model-keyed consensus profile. ` +
        `The persona panel belongs at ${DEFAULT_PERSONA_PANEL_PATH}. ` +
        `To rebuild the legacy profile: bun scripts/consensus-profile.ts pick --reviewers <a,b,c> --adjudicator <d>`,
    );
  }
  const artifact = raw as ConsensusProfileArtifact;
  const validation = validateConsensusProfile(artifact);
  if (!artifact.valid || !validation.valid) {
    throw new Error(`invalid consensus profile: ${validation.errors.join("; ") || "artifact is not marked valid"}`);
  }
  return artifact;
}

export function persistConsensusProfile(artifact: ConsensusProfileArtifact, profilePath = DEFAULT_CONSENSUS_PROFILE_PATH): void {
  const validation = validateConsensusProfile(artifact);
  if (!artifact.valid || !validation.valid) throw new Error(`refusing to persist invalid consensus profile: ${validation.errors.join("; ")}`);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(artifact, null, 2));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      reviewers: { type: "string" },
      adjudicator: { type: "string" },
      output: { type: "string" },
      weights: { type: "string", default: "any" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const command = positionals[0] ?? "show";
  const output = values.output ?? DEFAULT_CONSENSUS_PROFILE_PATH;

  if (values.help) {
    console.log("Usage: bun scripts/consensus-profile.ts pick|show|validate [--reviewers id,id,id] [--adjudicator id] [--weights any|open-only|closed-only] [--output path] [--json]");
    return;
  }
  if (command === "pick") {
    const reviewerIds = values.reviewers?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
    const adjudicatorId = values.adjudicator?.trim() || undefined;
    if (!isWeightPolicy(values.weights)) throw new Error(`unknown weight policy: ${values.weights}`);
    if (reviewerIds.length !== 3 || !adjudicatorId) {
      throw new Error("shadow consensus v1 requires three explicit --reviewers pins and one explicit --adjudicator pin");
    }
    const pool = buildPool();
    const artifact = buildConsensusProfile(pool.candidates, {
      reviewerIds,
      adjudicatorId,
      catalogSnapshot: pool.snapshot,
      weightPolicy: values.weights,
    });
    persistConsensusProfile(artifact, output);
    console.log(JSON.stringify(artifact, null, values.json ? 2 : 0));
    return;
  }
  const artifact = loadConsensusProfile(output);
  if (command === "validate") {
    console.log(JSON.stringify(validateConsensusProfile(artifact), null, 2));
    return;
  }
  if (command === "show") {
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
