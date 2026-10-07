#!/usr/bin/env bun
/**
 * Persona-keyed consensus panel with harness deployment and availability failover.
 *
 * Why this exists
 * ---------------
 * `consensus-profile.ts` keyed seat identity on the *model* (`family`/`provider`)
 * and required all four model families to be distinct. Two problems:
 *
 *   1. Constitution Art. II: "Caller-supplied persona identifiers, session
 *      identifiers, model-vendor diversity, and caller-supplied consensus flags
 *      are not promotion evidence." Model-vendor diversity is not evidence of
 *      review independence at all — three seats served by the same vendor and
 *      failure domain are one reviewer, not three.
 *   2. It ran seats through `callModel(seat.id)` on the Zo model layer, which
 *      bypasses the harness layer entirely. `packages/zo-swarm-orchestrator` already ships a
 *      full ACP harness registry (executor-registry.json), an `ExecutorClient`,
 *      and a fallback topology in `selector/executor-selector.ts`. None of it was
 *      reachable from here.
 *
 * This module re-keys the panel on *role*: distinct reviewer personas, each
 * deployed onto a harness that is verified present on the host. Harnesses may be
 * shared between personas or held distinct, per operator preference; a persona
 * whose primary harness is unavailable resolves to the next live harness in its
 * chain, and a persona with no live harness in its chain holds the seat.
 *
 * Model identity is retained as *execution metadata* (what the harness runs),
 * never as the diversity axis.
 */
import { createHash } from "crypto";
import { existsSync } from "fs";
import { accessSync, constants } from "fs";
import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "util";

export const PERSONA_PANEL_SCHEMA_VERSION = 2;
// Deliberately distinct from DEFAULT_CONSENSUS_PROFILE_PATH. The legacy profile
// is model-keyed and this panel is persona-keyed; one shared filename lets either
// artifact silently shadow the other and turns every load into a schema wall.
export const DEFAULT_PERSONA_PANEL_PATH = `${process.env.HOME}/.zouroboros/lineup.consensus.panel.json`;

export type PanelSeatRole = "reviewer" | "adjudicator";
export type PanelSeatName = "reviewer-1" | "reviewer-2" | "reviewer-3" | "adjudicator";

/** A harness is an ACP executor that can carry a reviewer persona. */
export interface HarnessAvailability {
  /** Present in the executor registry. */
  registered: boolean;
  /** Underlying CLI resolvable on PATH. */
  executable: boolean;
}

export type AvailabilityMap = Record<string, HarnessAvailability>;

export interface HarnessBinding {
  /** Executor id from executor-registry.json. */
  harness: string;
  /** Ordered failover chain; first element is the primary. */
  chain: string[];
}

export interface PanelSeat {
  seat: PanelSeatName;
  role: PanelSeatRole;
  /** Zo persona UUID — the diversity axis. */
  personaId: string;
  personaName: string;
  /** Review domain this seat is chartered to cover. */
  domain: string;
  binding: HarnessBinding;
  /** Model the harness runs. Execution metadata, not an identity claim. */
  executionModel: string;
  /** Resolved at build time; null means every harness in the chain is absent. */
  resolvedHarness: string | null;
  /** True when resolution moved off the chain's primary. */
  degraded: boolean;
}

export interface PanelPolicy {
  rubricVersion: string;
  automaticPass: "unanimous-reviewers-only";
  unavailableSeat: "hold";
  criticalObjection: "hold";
  splitPassAuthority: "disabled-until-shadow-promotion";
}

export interface PersonaPanelArtifact {
  schemaVersion: number;
  profile: "consensus-persona-panel";
  topology: "three-persona-reviewers-plus-independent-adjudicator";
  diversityAxis: "persona";
  status: "shadow" | "promoted";
  valid: boolean;
  generatedAt: string;
  reviewers: PanelSeat[];
  adjudicator: PanelSeat;
  policy: PanelPolicy;
  harnessAvailability: AvailabilityMap;
  /**
   * Non-fatal conditions that must stay visible on the record. A degradation is
   * not a structural defect: the panel is still the panel, it just is not being
   * served the way it was chartered. See `assessPanelReadiness`.
   */
  degradations: string[];
  panelHash: string;
  retiredModels?: string[];
  retirementNote?: string;
}

/**
 * The panel roster.
 *
 * Distinct personas per reviewer seat carry review independence; harnesses are a
 * deployment choice and may repeat. `AI Engineer` and the two governance roles
 * are deliberately different domains so a single blind spot cannot pass as three
 * agreeing reviewers.
 */
export const PANEL_ROSTER: ReadonlyArray<{
  seat: PanelSeatName;
  role: PanelSeatRole;
  personaId: string;
  personaName: string;
  domain: string;
  binding: HarnessBinding;
  executionModel: string;
}> = [
  {
    seat: "reviewer-1",
    role: "reviewer",
    personaId: "3a3ac067-dab7-428d-9c7e-9d900587b375",
    personaName: "AI Engineer",
    domain: "ai-systems",
    binding: { harness: "claude-code", chain: ["claude-code", "codex", "gemini", "hermes"] },
    executionModel: "byok:dbce4b53-28f2-4a4d-ada2-30326765d57b",
  },
  {
    seat: "reviewer-2",
    role: "reviewer",
    personaId: "b584d4f7-9e88-42cd-921c-1804b1ef4fc0",
    personaName: "Zouroboros Engineer",
    domain: "governance-and-orchestration",
    binding: { harness: "codex", chain: ["codex", "claude-code", "gemini", "hermes"] },
    executionModel: "byok:dbce4b53-28f2-4a4d-ada2-30326765d57b",
  },
  {
    seat: "reviewer-3",
    role: "reviewer",
    personaId: "f0e50f6f-b866-4c9b-8259-309bde699336",
    personaName: "Security Engineer",
    domain: "security-and-adversarial-review",
    binding: { harness: "gemini", chain: ["gemini", "claude-code", "codex", "hermes"] },
    executionModel: "byok:dbce4b53-28f2-4a4d-ada2-30326765d57b",
  },
  {
    seat: "adjudicator",
    role: "adjudicator",
    // Adjudicator is deliberately a distinct persona from all three reviewers so
    // the tie-break is not the same role re-reading its own review.
    personaId: "e53dd88d-cbab-463d-8412-120106fb8e65",
    personaName: "Reality Checker",
    domain: "evidence-certification",
    binding: { harness: "hermes", chain: ["hermes", "claude-code", "gemini", "codex"] },
    executionModel: "byok:dbce4b53-28f2-4a4d-ada2-30326765d57b",
  },
];

const REGISTRY_CANDIDATES = [
  // Sibling package in this repo checkout.
  path.join(import.meta.dir, "..", "..", "zo-swarm-executors", "registry", "executor-registry.json"),
  // Muse VM workspace convention (portable across Muse VMs).
  "/home/workspace/Skills/zo-swarm-executors/registry/executor-registry.json",
];

/** CLI binary each executor id resolves to on PATH. */
const HARNESS_BINARY: Record<string, string> = {
  "claude-code": "claude",
  hermes: "hermes",
  gemini: "gemini",
  codex: "codex",
  opencode: "opencode",
  kimi: "kimi",
  pi: "pi",
};

function isExecutableOnPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      if (!existsSync(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * A harness is available only when it is BOTH registered in the executor registry
 * and its CLI resolves on PATH. A bridge script without its binary is a dead
 * entry — trusting it would route a seat into a guaranteed failure.
 */
export function probeHarnessAvailability(registryPath?: string): AvailabilityMap {
  let registeredIds: Set<string> = new Set();
  const searched = registryPath ? [registryPath] : REGISTRY_CANDIDATES;
  for (const candidate of searched) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        executors?: Array<{ id?: string }>;
      };
      const ids = (parsed.executors ?? [])
        .map((executor) => executor.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) {
        registeredIds = new Set(ids);
        break;
      }
    } catch {
      continue;
    }
  }

  const availability: AvailabilityMap = {};
  for (const harness of Object.keys(HARNESS_BINARY)) {
    availability[harness] = {
      registered: registeredIds.has(harness),
      executable: isExecutableOnPath(HARNESS_BINARY[harness]),
    };
  }
  return availability;
}

export function harnessIsAvailable(harness: string, availability: AvailabilityMap): boolean {
  const entry = availability[harness];
  return Boolean(entry?.registered && entry?.executable);
}

/**
 * First live harness in the seat's chain. Returns null when the whole chain is
 * absent — the seat then holds (policy `unavailableSeat: "hold"`) rather than
 * silently downgrading to a reviewer-less quorum.
 *
 * `degraded` is true for *any* departure from serving on the primary, including
 * a total failure to resolve. A held seat is the most degraded state a seat can
 * be in; reporting it as `degraded: false` is a false all-clear.
 */
export function resolveSeatHarness(
  binding: HarnessBinding,
  availability: AvailabilityMap,
): { harness: string | null; degraded: boolean; reason: string } {
  if (!binding.chain.includes(binding.harness)) {
    return { harness: null, degraded: true, reason: "primary harness missing from its own chain" };
  }
  for (const candidate of binding.chain) {
    if (harnessIsAvailable(candidate, availability)) {
      return {
        harness: candidate,
        degraded: candidate !== binding.harness,
        reason: candidate === binding.harness ? "primary available" : `primary unavailable; failed over to ${candidate}`,
      };
    }
  }
  return { harness: null, degraded: true, reason: "no harness in chain is registered and executable" };
}

export function hashPanel(panel: PersonaPanelArtifact): string {
  const payload = [...panel.reviewers, panel.adjudicator].map((seat) => ({
    seat: seat.seat,
    role: seat.role,
    personaId: seat.personaId,
    domain: seat.domain,
    harness: seat.binding.harness,
    chain: seat.binding.chain,
    resolvedHarness: seat.resolvedHarness,
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const DEFAULT_POLICY: PanelPolicy = {
  rubricVersion: "consensus-persona-panel/1",
  automaticPass: "unanimous-reviewers-only",
  unavailableSeat: "hold",
  criticalObjection: "hold",
  splitPassAuthority: "disabled-until-shadow-promotion",
};

/**
 * Validation is persona-keyed. Model family/provider are deliberately absent from
 * the distinctness check — requiring them would re-introduce the Art. II
 * violation and break any host whose BYOK set is single-vendor.
 */
export function validatePersonaPanel(panel: PersonaPanelArtifact): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (panel.schemaVersion !== PERSONA_PANEL_SCHEMA_VERSION) errors.push("unsupported schemaVersion");
  if (panel.profile !== "consensus-persona-panel") errors.push("profile must be consensus-persona-panel");
  if (panel.diversityAxis !== "persona") errors.push("diversityAxis must be persona");
  if (panel.topology !== "three-persona-reviewers-plus-independent-adjudicator") {
    errors.push("invalid topology");
  }
  if (panel.status !== "shadow" && panel.status !== "promoted") errors.push("status must be shadow or promoted");

  if (!Array.isArray(panel.reviewers) || panel.reviewers.length !== 3) {
    errors.push("exactly three reviewers are required");
  }
  const seats = [...(panel.reviewers ?? []), panel.adjudicator].filter(Boolean);
  const expectedSeats = ["reviewer-1", "reviewer-2", "reviewer-3", "adjudicator"];
  if (seats.length !== 4) errors.push("exactly four seats are required");
  if (seats.map((seat) => seat.seat).join(",") !== expectedSeats.join(",")) errors.push("seat order or names are invalid");
  if (panel.reviewers?.some((seat) => seat.role !== "reviewer")) errors.push("reviewer seats must use reviewer role");
  if (panel.adjudicator?.role !== "adjudicator") errors.push("adjudicator seat must use adjudicator role");

  for (const seat of seats) {
    if (!seat.personaId || !seat.personaName || !seat.domain) {
      errors.push(`${seat.seat} has incomplete persona identity metadata`);
    }
    if (!seat.binding?.harness) errors.push(`${seat.seat} has no harness binding`);
    if (!Array.isArray(seat.binding?.chain) || seat.binding.chain.length === 0) {
      errors.push(`${seat.seat} harness chain must be a non-empty array`);
    }
    if (new Set(seat.binding?.chain ?? []).size !== (seat.binding?.chain ?? []).length) {
      errors.push(`${seat.seat} harness chain contains duplicates`);
    }
  }

  // Reviewer independence is carried by distinct personas and distinct domains.
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(seats.map((seat) => seat.personaId))) errors.push("all four seat personas must be distinct");
  if (!unique(panel.reviewers?.map((seat) => seat.domain) ?? [])) errors.push("reviewer domains must be distinct");

  // Deliberately NOT a validation error: requiring the adjudicator onto a distinct
  // harness re-introduces model/harness identity as a qualification for review
  // independence, which Art. II forbids, and it breaks any single-vendor host.
  // Harness collapse is recorded as a degradation and is visible in the ruling.

  if (panel.panelHash !== hashPanel(panel)) errors.push("panelHash does not match the ordered seats");
  if (panel.policy?.automaticPass !== "unanimous-reviewers-only") errors.push("automaticPass must require unanimous reviewers");
  if (panel.policy?.splitPassAuthority !== "disabled-until-shadow-promotion") errors.push("splitPass authority must remain disabled");
  if (panel.policy?.unavailableSeat !== "hold") errors.push("unavailableSeat must hold");

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function buildPersonaPanel(
  options: { availability?: AvailabilityMap; generatedAt?: string } = {},
): PersonaPanelArtifact {
  const availability = options.availability ?? probeHarnessAvailability();
  const seats = PANEL_ROSTER.map((rosterSeat) => {
    const resolution = resolveSeatHarness(rosterSeat.binding, availability);
    return {
      seat: rosterSeat.seat,
      role: rosterSeat.role,
      personaId: rosterSeat.personaId,
      personaName: rosterSeat.personaName,
      domain: rosterSeat.domain,
      binding: rosterSeat.binding,
      executionModel: rosterSeat.executionModel,
      resolvedHarness: resolution.harness,
      degraded: resolution.degraded,
    } satisfies PanelSeat;
  });

  const panel: PersonaPanelArtifact = {
    degradations: [],
    schemaVersion: PERSONA_PANEL_SCHEMA_VERSION,
    profile: "consensus-persona-panel",
    topology: "three-persona-reviewers-plus-independent-adjudicator",
    diversityAxis: "persona",
    // Art. IX: shadow probes measure without escalating. Promotion requires
    // authenticated governance attestation that does not exist yet.
    status: "shadow",
    valid: true,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    reviewers: seats.slice(0, 3) as [PanelSeat, PanelSeat, PanelSeat],
    adjudicator: seats[3] as PanelSeat,
    policy: { ...DEFAULT_POLICY },
    harnessAvailability: availability,
    panelHash: "",
  };
  panel.panelHash = hashPanel(panel);
  panel.valid = validatePersonaPanel(panel).valid;
  panel.degradations = collectDegradations(panel);
  return panel;
}

export function allSeats(panel: PersonaPanelArtifact): PanelSeat[] {
  return [...(panel.reviewers ?? []), panel.adjudicator].filter(Boolean);
}

/**
 * Non-fatal conditions that do not break the panel but must never be invisible.
 *
 * A seat with no live harness is a *ruling outcome* (policy `unavailableSeat:
 * "hold"`), not a structural defect. Folding it into `validatePersonaPanel`
 * would make a held panel impossible to persist, which destroys the audit
 * record at exactly the moment the audit matters most.
 */
export function collectDegradations(panel: PersonaPanelArtifact): string[] {
  const degradations: string[] = [];
  for (const seat of allSeats(panel)) {
    if (seat.resolvedHarness === null) {
      degradations.push(`${seat.seat} (${seat.personaName}) has no live harness in its chain; seat is held`);
    } else if (seat.degraded) {
      degradations.push(
        `${seat.seat} (${seat.personaName}) failed over from ${seat.binding.harness} to ${seat.resolvedHarness}`,
      );
    }
  }
  const reviewerHarnesses = (panel.reviewers ?? []).map((seat) => seat.resolvedHarness);
  const adjudicatorHarness = panel.adjudicator?.resolvedHarness ?? null;
  if (
    adjudicatorHarness !== null &&
    reviewerHarnesses.length > 0 &&
    reviewerHarnesses.every((harness) => harness === adjudicatorHarness)
  ) {
    degradations.push(
      `adjudicator shares the single harness ${panel.adjudicator.resolvedHarness} with all reviewers; ` +
        `independence rests on persona and domain separation alone`,
    );
  }
  return degradations;
}

export interface PanelReadiness {
  /**
   * The panel is the one we chartered: schema, seat order, persona/domain
   * distinctness, chain integrity, and hash all pass. Independent of harness
   * state — a panel with held seats is still structurally valid, because a hold
   * is a ruling rather than a defect.
   */
  structurallyValid: boolean;
  /** All four seats resolved onto a live harness. */
  ready: boolean;
  decision: "REVIEW" | "HOLD";
  heldSeats: PanelSeatName[];
  degradedSeats: PanelSeatName[];
  degradations: string[];
  reason: string;
}

/**
 * Turn structural validity into a gate ruling.
 *
 * `valid` answers "is this the panel we chartered?"; readiness answers "can this
 * panel actually convene?". Keeping them separate is what lets a hold be recorded
 * and reviewed instead of crashing the run.
 */
export function assessPanelReadiness(panel: PersonaPanelArtifact): PanelReadiness {
  const seats = allSeats(panel);
  const heldSeats = seats.filter((seat) => seat.resolvedHarness === null).map((seat) => seat.seat);
  const degradedSeats = seats.filter((seat) => seat.degraded).map((seat) => seat.seat);
  const structural = validatePersonaPanel(panel);
  const degradations = collectDegradations(panel);
  const ready = structural.valid && heldSeats.length === 0;
  return {
    structurallyValid: structural.valid,
    ready,
    decision: ready ? "REVIEW" : "HOLD",
    heldSeats,
    degradedSeats,
    degradations,
    reason: !structural.valid
      ? `panel failed structural validation: ${structural.errors.join("; ")}`
      : heldSeats.length > 0
        ? `held seats: ${heldSeats.join(", ")} — policy unavailableSeat=hold forbids convening a reduced quorum`
        : "all four seats resolved onto a live harness",
  };
}

export function loadPersonaPanel(panelPath = DEFAULT_PERSONA_PANEL_PATH): PersonaPanelArtifact {
  return JSON.parse(fs.readFileSync(panelPath, "utf8")) as PersonaPanelArtifact;
}

export function persistPersonaPanel(panel: PersonaPanelArtifact, panelPath = DEFAULT_PERSONA_PANEL_PATH): void {
  fs.mkdirSync(path.dirname(panelPath), { recursive: true });
  fs.writeFileSync(panelPath, JSON.stringify(panel, null, 2));
}

/**
 * Diagnose whether each seat would resolve, and why. Used by `plan`/`validate`
 * to surface a dead chain before it silently holds a seat at review time.
 */
export function explainResolution(availability: AvailabilityMap): Array<{
  seat: PanelSeatName;
  personaName: string;
  primary: string;
  resolved: string | null;
  degraded: boolean;
  reason: string;
}> {
  return PANEL_ROSTER.map((rosterSeat) => {
    const resolution = resolveSeatHarness(rosterSeat.binding, availability);
    return {
      seat: rosterSeat.seat,
      personaName: rosterSeat.personaName,
      primary: rosterSeat.binding.harness,
      resolved: resolution.harness,
      degraded: resolution.degraded,
      reason: resolution.reason,
    };
  });
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      output: { type: "string" },
      registry: { type: "string" },
    },
  });

  if (values.help || positionals[0] === "help") {
    console.log(`persona-panel — persona-keyed consensus panel with harness failover

Usage:
  persona-panel.ts plan      [--json] [--registry <path>]     Show harness resolution per seat
  persona-panel.ts build     [--json] [--output <path>]       Build the panel artifact
  persona-panel.ts validate  [--json] [--output <path>]       Validate the artifact on disk

Notes:
  diversity axis is persona, not model (Constitution Art. II). Harness reuse
  between reviewers is permitted; harness absence holds the seat, never
  downgrades the quorum. The artifact stays shadow until an authenticated
  promotion attestation exists (Art. IX).`);
    return;
  }

  const availability = values.registry
    ? probeHarnessAvailability(values.registry)
    : probeHarnessAvailability();

  const command = positionals[0] ?? "plan";

  if (command === "plan") {
    const rows = explainResolution(availability);
    if (values.json) {
      console.log(JSON.stringify({ availability, resolution: rows }, null, 2));
      return;
    }
    console.log("Harness availability (registered AND executable):");
    for (const [harness, entry] of Object.entries(availability)) {
      const ok = harnessIsAvailable(harness, availability);
      console.log(`  ${ok ? "live  " : "dead  "} ${harness.padEnd(12)} registered=${entry.registered} executable=${entry.executable}`);
    }
    console.log("\nSeat resolution:");
    for (const row of rows) {
      console.log(`  ${row.seat.padEnd(12)} ${row.personaName.padEnd(22)} ${row.primary} -> ${row.resolved ?? "HELD"}  ${row.reason}`);
    }
    return;
  }

  if (command === "build") {
    const panel = buildPersonaPanel({ availability });
    if (values.output) {
      persistPersonaPanel(panel, values.output);
      console.log(`wrote ${values.output}`);
    }
    const validation = validatePersonaPanel(panel);
    if (values.json) {
      console.log(JSON.stringify({ panel, validation }, null, 2));
      return;
    }
    for (const seat of [...panel.reviewers, panel.adjudicator]) {
      console.log(`  ${seat.seat.padEnd(12)} ${seat.personaName.padEnd(22)} ${seat.resolvedHarness ?? "HELD"}${seat.degraded ? " (degraded)" : ""}`);
    }
    console.log(`\npanelHash ${panel.panelHash}`);
    console.log(validation.valid ? "valid" : `INVALID: ${validation.errors.join("; ")}`);
    process.exitCode = validation.valid ? 0 : 1;
    return;
  }

  if (command === "validate") {
    const target = values.output ?? DEFAULT_PERSONA_PANEL_PATH;
    if (!existsSync(target)) {
      console.log(`no panel at ${target}`);
      process.exitCode = 1;
      return;
    }
    const panel = loadPersonaPanel(target);
    const validation = validatePersonaPanel(panel);
    if (values.json) {
      console.log(JSON.stringify(validation, null, 2));
    } else {
      console.log(validation.valid ? "valid" : `INVALID: ${validation.errors.join("; ")}`);
    }
    process.exitCode = validation.valid ? 0 : 1;
    return;
  }

  console.error(`unknown command: ${command}`);
  process.exitCode = 2;
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
