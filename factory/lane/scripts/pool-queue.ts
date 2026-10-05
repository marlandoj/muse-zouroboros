#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-003 T1 — Pool queue + campaign registry.
 *
 * File-backed logical pool state under state/pool/:
 *   campaigns.json — campaign registry (Record<campaign_id, Campaign>)
 *   queue.json     — work queue (WorkItem[]), items are (campaign_id, task_id) DAG tasks
 *
 * Pure library + CLI. No daemons, no processes — the pool is state, not workers.
 * Reads never create state files (flags-off byte-identical guarantee lives here:
 * nothing under state/pool/ exists until something is enqueued).
 *
 * CLI:
 *   bun pool-queue.ts enqueue --seed <path> --ticket-id <id> --identifier <ZOU-x> [--campaign <id>] [--ceiling <usd>] [--depends-on <c1,c2>]
 *   bun pool-queue.ts enqueue --direct --ticket-id <id> --identifier <ZOU-x> --name <title> [--description <d>] [--ceiling <usd>] [--depends-on <c1,c2>]
 *   bun pool-queue.ts list [--json]
 *   bun pool-queue.ts status [<campaign_id>]
 *   bun pool-queue.ts park <campaign_id> <task_id> --reason <text>
 *   bun pool-queue.ts release <campaign_id> <task_id>
 *   bun pool-queue.ts selftest
 *
 * Exit codes: 0 ok · 1 error · 2 usage/validation.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ExecutionPolicy } from "./model-policy";
import type { CascadeValidationCommand } from "./coding-cascade";
import { parseHoldoutScenarios, type HoldoutScenario } from "./factory-holdouts";
import {
  verifySeedAdmission,
  type ProjectDelegationPaths,
} from "../../../Skills/zouroboros-governance/scripts/project-delegation-receipt";

declare const Bun: { YAML: { parse(text: string): unknown } };

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkItemState = "ready" | "in-flight" | "done" | "failed" | "parked";
export type CampaignState = "active" | "complete" | "failed" | "parked";

// ─── Persona association contract (ZOU-1282 T4) ───────────────────────────────
//
// The Software Template Library owns the association registry and its canonical
// hash lineage (T1); the compiler projects the *resolved* fleet into the seed
// (T2). This module is the factory-side contract: it validates that projection
// and carries it, unresolved, across seed → campaign → work item → restart →
// execution record. It never resolves a persona identity, never reads the
// registry, and never touches model or harness routing.
//
// Absent-field parity is load-bearing: a seed with no `persona_association` and
// no task `persona_assignments` produces byte-identical Campaign/WorkItem JSON.

export type PersonaPhase = "advise" | "implement" | "review";

const PERSONA_PHASES: readonly PersonaPhase[] = ["advise", "implement", "review"];

/** Mutable identity/routing keys that must never be frozen into a seed association. */
const PERSONA_FORBIDDEN_ROLE_KEYS = [
  "id",
  "uuid",
  "persona_id",
  "personaId",
  "model",
  "model_name",
  "harness",
  "executor",
];

const PERSONA_SELECTOR_DIMENSIONS = new Set(["engine", "platform"]);
const EXACT_TEMPLATE_REFERENCE = /^[^@\s]+@\d+\.\d+\.\d+$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const LOWER_SHA256 = /^[a-f0-9]{64}$/;

export interface SeedPersonaFleetRole {
  role_id: string;
  /** Exact persona name resolved against the live directory at dispatch (never a UUID). */
  persona_name: string;
  required: boolean;
  phases: PersonaPhase[];
  required_scopes: string[];
  invocation_cap: number;
}

export interface SeedPersonaOmittedRole {
  role_id: string;
  reason: string;
}

export interface SeedPersonaAssociation {
  template_reference: string;
  version: string;
  sha256: string;
  declared_capabilities: string[];
  selector_values: Record<string, string>;
  fleet: SeedPersonaFleetRole[];
  omitted_roles: SeedPersonaOmittedRole[];
  /**
   * Canonical digest of the declared projection above, computed locally. The
   * declared `sha256` is the registry's lineage stamp and cannot be recomputed
   * here (the seed carries the resolved subset, not the registry entry), so a
   * body edit that leaves `sha256` untouched would otherwise pass unnoticed.
   * This fingerprint makes that edit visible as hash drift at re-enqueue.
   */
  content_fingerprint: string;
}

export interface TaskPersonaAssignment {
  role_id: string;
  authority: PersonaPhase;
  owned_paths: string[];
}

/** Compact lineage stamped onto execution records — no resolved identities. */
export interface PersonaAssociationLineage {
  template_reference: string;
  version: string;
  sha256: string;
  content_fingerprint: string;
  declared_capabilities: string[];
  fleet_role_ids: string[];
  required_role_ids: string[];
  omitted_role_ids: string[];
  implement_role_ids: string[];
}

/** Deterministic key-sorted JSON — matches the association registry's algorithm. */
function canonicalPersonaJson(value: unknown): string {
  if (value === undefined) throw new Error("canonical persona JSON does not permit undefined");
  if (Array.isArray(value)) return `[${value.map(canonicalPersonaJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPersonaJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

export function personaAssociationFingerprint(
  association: Omit<SeedPersonaAssociation, "content_fingerprint">,
): string {
  return createHash("sha256").update(canonicalPersonaJson(association)).digest("hex");
}

function personaFail(source: string, message: string): never {
  throw new Error(`persona association contract: ${message}: ${source}`);
}

function personaStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) return null;
  return value.map((entry) => (entry as string).trim());
}

/** Path containment on normalized POSIX segments — never a bare substring match. */
function personaPathContains(parent: string, child: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const parentNorm = norm(parent);
  const childNorm = norm(child);
  return childNorm === parentNorm || childNorm.startsWith(`${parentNorm}/`);
}

/**
 * Validate the seed's top-level `persona_association` projection.
 * Returns null when the seed declares none (legacy / DIRECT / hand-authored).
 */
export function parsePersonaAssociation(raw: unknown, source: string): SeedPersonaAssociation | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) personaFail(source, "persona_association must be a mapping");
  const doc = raw as Record<string, unknown>;

  const templateReference = typeof doc.template_reference === "string" ? doc.template_reference.trim() : "";
  if (!EXACT_TEMPLATE_REFERENCE.test(templateReference)) {
    personaFail(source, `template_reference must be exact "<id>@<x.y.z>" (got "${String(doc.template_reference)}")`);
  }
  const version = typeof doc.version === "string" ? doc.version.trim() : "";
  if (!EXACT_SEMVER.test(version)) personaFail(source, `association version must be an exact semantic version (got "${String(doc.version)}")`);
  const sha256 = typeof doc.sha256 === "string" ? doc.sha256.trim() : "";
  if (!LOWER_SHA256.test(sha256)) personaFail(source, "association sha256 must be a lowercase 64-character SHA-256");

  const capabilities = personaStringArray(doc.declared_capabilities ?? []);
  if (!capabilities) personaFail(source, "declared_capabilities must be an array of non-empty strings");
  if (new Set(capabilities).size !== capabilities.length) personaFail(source, "declared_capabilities contains duplicates");

  const selectorRaw = doc.selector_values ?? {};
  if (typeof selectorRaw !== "object" || selectorRaw === null || Array.isArray(selectorRaw)) {
    personaFail(source, "selector_values must be a mapping");
  }
  const selectorValues: Record<string, string> = {};
  for (const [dimension, value] of Object.entries(selectorRaw as Record<string, unknown>)) {
    if (!PERSONA_SELECTOR_DIMENSIONS.has(dimension)) personaFail(source, `unknown selector dimension "${dimension}"`);
    if (typeof value !== "string" || value.trim().length === 0) personaFail(source, `selector_values.${dimension} must be a non-empty string`);
    selectorValues[dimension] = value.trim();
  }

  const fleetRaw = doc.fleet ?? [];
  if (!Array.isArray(fleetRaw)) personaFail(source, "fleet must be an array");
  const fleet: SeedPersonaFleetRole[] = [];
  const seenRoles = new Set<string>();
  const seenNames = new Set<string>();
  for (const [index, entry] of (fleetRaw as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) personaFail(source, `fleet[${index}] must be a mapping`);
    const role = entry as Record<string, unknown>;
    const roleId = typeof role.role_id === "string" ? role.role_id.trim() : "";
    if (!roleId) personaFail(source, `fleet[${index}] requires role_id`);
    if (seenRoles.has(roleId)) personaFail(source, `duplicate fleet role "${roleId}"`);
    seenRoles.add(roleId);
    for (const forbidden of PERSONA_FORBIDDEN_ROLE_KEYS) {
      if (role[forbidden] !== undefined) personaFail(source, `fleet role "${roleId}" must not embed mutable "${forbidden}"`);
    }
    const personaName = typeof role.persona_name === "string" ? role.persona_name.trim() : "";
    if (!personaName) personaFail(source, `fleet role "${roleId}" requires an exact persona_name`);
    if (/[?*[\]]/.test(personaName)) personaFail(source, `fleet role "${roleId}" persona_name must be exact, not a pattern`);
    if (seenNames.has(personaName)) personaFail(source, `fleet persona_name "${personaName}" is ambiguous (selected by more than one role)`);
    seenNames.add(personaName);
    if (typeof role.required !== "boolean") personaFail(source, `fleet role "${roleId}" required must be a boolean`);
    const phases = personaStringArray(role.phases);
    if (!phases || phases.length === 0) personaFail(source, `fleet role "${roleId}" requires at least one phase`);
    for (const phase of phases) {
      if (!PERSONA_PHASES.includes(phase as PersonaPhase)) personaFail(source, `fleet role "${roleId}" has unknown phase "${phase}"`);
    }
    if (new Set(phases).size !== phases.length) personaFail(source, `fleet role "${roleId}" has duplicate phases`);
    const requiredScopes = personaStringArray(role.required_scopes);
    if (!requiredScopes || requiredScopes.length === 0) personaFail(source, `fleet role "${roleId}" requires at least one required scope`);
    const cap = role.invocation_cap;
    if (!Number.isInteger(cap) || Number(cap) < 1) personaFail(source, `fleet role "${roleId}" invocation_cap must be a positive integer`);
    fleet.push({
      role_id: roleId,
      persona_name: personaName,
      required: role.required as boolean,
      phases: phases as PersonaPhase[],
      required_scopes: requiredScopes,
      invocation_cap: Number(cap),
    });
  }

  const omittedRaw = doc.omitted_roles ?? [];
  if (!Array.isArray(omittedRaw)) personaFail(source, "omitted_roles must be an array");
  const omitted: SeedPersonaOmittedRole[] = [];
  const seenOmitted = new Set<string>();
  for (const [index, entry] of (omittedRaw as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) personaFail(source, `omitted_roles[${index}] must be a mapping`);
    const role = entry as Record<string, unknown>;
    const roleId = typeof role.role_id === "string" ? role.role_id.trim() : "";
    const reason = typeof role.reason === "string" ? role.reason.trim() : "";
    if (!roleId) personaFail(source, `omitted_roles[${index}] requires role_id`);
    // An optional omission without a retained reason is indistinguishable from a
    // silent drop — fail loud rather than lose the audit trail.
    if (!reason) personaFail(source, `omitted role "${roleId}" requires a retained reason`);
    if (seenRoles.has(roleId)) personaFail(source, `role "${roleId}" cannot be both selected and omitted`);
    if (seenOmitted.has(roleId)) personaFail(source, `duplicate omitted role "${roleId}"`);
    seenOmitted.add(roleId);
    omitted.push({ role_id: roleId, reason });
  }

  const declared: Omit<SeedPersonaAssociation, "content_fingerprint"> = {
    template_reference: templateReference,
    version,
    sha256,
    declared_capabilities: capabilities,
    selector_values: selectorValues,
    fleet,
    omitted_roles: omitted,
  };
  return { ...declared, content_fingerprint: personaAssociationFingerprint(declared) };
}

/**
 * Validate a task's `persona_assignments` against the association and the task's
 * own owned files. Rejects unknown roles, authority escalation beyond the
 * association's permitted phases, empty implement paths, and implement paths
 * that escape the task's owned files.
 */
export function parseTaskPersonaAssignments(
  raw: unknown,
  taskId: string,
  ownedFiles: string[] | undefined,
  association: SeedPersonaAssociation | null,
  source: string,
): TaskPersonaAssignment[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  // Task-level assignments without top-level lineage are a contract disagreement:
  // there is nothing to validate the selector or its permitted phases against.
  if (!association) personaFail(source, `task ${taskId} declares persona_assignments without a top-level persona_association`);
  if (!Array.isArray(raw)) personaFail(source, `task ${taskId} persona_assignments must be an array`);
  const permitted = new Map(association.fleet.map((role) => [role.role_id, new Set(role.phases)]));
  const omitted = new Set(association.omitted_roles.map((role) => role.role_id));
  const assignments: TaskPersonaAssignment[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (raw as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) personaFail(source, `task ${taskId} persona_assignments[${index}] must be a mapping`);
    const value = entry as Record<string, unknown>;
    const roleId = typeof value.role_id === "string" ? value.role_id.trim() : "";
    if (!roleId) personaFail(source, `task ${taskId} persona_assignments[${index}] requires role_id`);
    if (seen.has(roleId)) personaFail(source, `task ${taskId} assigns role "${roleId}" more than once`);
    seen.add(roleId);
    const rolePhases = permitted.get(roleId);
    if (!rolePhases) {
      personaFail(
        source,
        omitted.has(roleId)
          ? `task ${taskId} assigns omitted role "${roleId}"`
          : `task ${taskId} assigns unknown role "${roleId}" (not present in the exact association)`,
      );
    }
    const authority = typeof value.authority === "string" ? value.authority.trim() : "";
    if (!PERSONA_PHASES.includes(authority as PersonaPhase)) {
      personaFail(source, `task ${taskId} role "${roleId}" has invalid authority "${String(value.authority)}"`);
    }
    if (!rolePhases.has(authority as PersonaPhase)) {
      personaFail(source, `task ${taskId} role "${roleId}" authority "${authority}" escalates beyond association phases [${[...rolePhases].join(", ")}]`);
    }
    const ownedPaths = personaStringArray(value.owned_paths ?? []);
    if (!ownedPaths) personaFail(source, `task ${taskId} role "${roleId}" owned_paths must be an array of non-empty strings`);
    if (authority === "implement") {
      if (ownedPaths.length === 0) personaFail(source, `task ${taskId} role "${roleId}" implement authority requires non-empty owned paths`);
      if (!ownedFiles || ownedFiles.length === 0) personaFail(source, `task ${taskId} role "${roleId}" implement authority requires the task to declare owned files`);
    }
    for (const candidate of ownedPaths) {
      if (!(ownedFiles ?? []).some((taskPath) => personaPathContains(taskPath, candidate))) {
        personaFail(source, `task ${taskId} role "${roleId}" owned path "${candidate}" is outside the task's owned files`);
      }
    }
    assignments.push({ role_id: roleId, authority: authority as PersonaPhase, owned_paths: ownedPaths });
  }
  return assignments;
}

/** Compact, identity-free lineage for execution and evidence records. */
export function personaAssociationLineage(association: SeedPersonaAssociation): PersonaAssociationLineage {
  return {
    template_reference: association.template_reference,
    version: association.version,
    sha256: association.sha256,
    content_fingerprint: association.content_fingerprint,
    declared_capabilities: [...association.declared_capabilities],
    fleet_role_ids: association.fleet.map((role) => role.role_id),
    required_role_ids: association.fleet.filter((role) => role.required).map((role) => role.role_id),
    omitted_role_ids: association.omitted_roles.map((role) => role.role_id),
    implement_role_ids: association.fleet.filter((role) => role.phases.includes("implement")).map((role) => role.role_id),
  };
}

/** Stable comparison key for drift detection across enqueue/restart boundaries. */
export function personaLineageKey(association: SeedPersonaAssociation | null | undefined): string {
  if (!association) return "none";
  return [association.template_reference, association.version, association.sha256, association.content_fingerprint].join("|");
}

/**
 * Re-check task assignments against the association at the enqueue boundary.
 * parseSeedContractDocument already cross-validates a seed, but enqueue also
 * accepts programmatically built tasks (recovery, retry, tests), where the two
 * halves could disagree. Fail closed on that disagreement rather than trusting
 * whichever half arrived last.
 */
export function assertTaskAssignmentsMatchAssociation(
  tasks: SeedTask[],
  association: SeedPersonaAssociation | null,
  source: string,
): void {
  for (const task of tasks) {
    if (task.persona_assignments === undefined) continue;
    parseTaskPersonaAssignments(task.persona_assignments, task.id, task.files, association, source);
  }
}

export interface Campaign {
  campaign_id: string;
  ticket_id: string;
  identifier: string;
  seed_path: string | null; // null for DIRECT single-item campaigns
  tasks: string[]; // task_ids in seed order
  cost_ceiling_usd: number;
  cost_spent_usd: number;
  state: CampaignState;
  created_at: string;
  /** Exact parent pipeline execution for asynchronous completion evidence. */
  execution_id?: string;
  execution_policy?: ExecutionPolicy | null;
  risk_tier?: string | null;
  target_repository?: string | null;
  base_commit?: string | null;
  validation_commands?: CascadeValidationCommand[];
  /**
   * FR-05 (ZOU-1114): campaign-level DAG. Every listed upstream campaign must
   * already exist at enqueue time (typos fail loud, cross-campaign cycles are
   * impossible by construction) and must reach state "complete" before any
   * task of this campaign becomes dispatchable. A failed/parked upstream
   * blocks the downstream campaign — fail closed, never fail open.
   */
  depends_on_campaigns?: string[];
  /**
   * ZOU-1282: versioned persona-association lineage carried verbatim from the
   * seed. Absent for DIRECT, hand-authored, and legacy campaigns.
   */
  persona_association?: SeedPersonaAssociation;
  delegation_admission?: ProjectDelegationAdmissionReference;
  delegation_remote_action?: ProjectDelegationPaths;
}

export interface WorkItem {
  campaign_id: string;
  task_id: string;
  name: string;
  description: string;
  deps: string[];
  state: WorkItemState;
  attempts: number;
  park_reason: string | null;
  created_at: string;
  updated_at: string;
  /**
   * ZOU-1282: both fields appear together or not at all. `owned_files` is the
   * task's declared file set, retained only when persona assignments exist so
   * a downstream implement assignment can be re-checked against it after a
   * restart without re-reading the seed.
   */
  persona_assignments?: TaskPersonaAssignment[];
  owned_files?: string[];
}

export interface SeedTask {
  id: string;
  name: string;
  description: string;
  deps: string[];
  files?: string[];
  persona_assignments?: TaskPersonaAssignment[];
}

export interface SeedContract {
  tasks: SeedTask[];
  persona_association: SeedPersonaAssociation | null;
  holdout_scenarios: HoldoutScenario[];
  delegation: ProjectDelegationPaths | null;
  delegation_remote_action: ProjectDelegationPaths | null;
}

export interface ProjectDelegationAdmissionReference {
  receipt_sha256: string;
  seed_sha256: string;
  action_payload_sha256: string;
  evidence_sha256: string;
  mandate_sha256: string;
  risk_lane: "L1_local_reversible";
}

export function projectDelegationExecutionFields(
  contract: Pick<SeedContract, "delegation" | "delegation_remote_action">,
  admission: ProjectDelegationAdmissionReference | null,
): {
  project_delegation?: { paths: ProjectDelegationPaths; l1_admission: ProjectDelegationAdmissionReference };
  project_delegation_remote_action?: ProjectDelegationPaths;
} {
  if (!contract.delegation && !contract.delegation_remote_action && !admission) return {};
  if (!contract.delegation || !contract.delegation_remote_action || !admission) {
    throw new Error("delegated execution requires complete L1 admission and L2 remote-action metadata");
  }
  return {
    project_delegation: { paths: contract.delegation, l1_admission: admission },
    project_delegation_remote_action: contract.delegation_remote_action,
  };
}

export function verifyDelegatedSeedAdmission(input: {
  delegation: ProjectDelegationPaths | null;
  seedPath: string;
  ticket: string;
  expectedRepository: string;
  keyPath: string;
  auditLogPath: string;
}): ProjectDelegationAdmissionReference | null {
  if (!input.delegation) return null;
  const result = verifySeedAdmission({
    paths: input.delegation,
    seed_path: input.seedPath,
    expected_ticket: input.ticket,
    expected_repository: input.expectedRepository,
    key_path: input.keyPath,
    audit_log_path: input.auditLogPath,
  });
  if (!result.passed || !result.receipt_sha256 || !result.seed_sha256 || !result.action_payload_sha256
    || !result.evidence_sha256 || !result.mandate_sha256) {
    throw new Error(`delegated seed admission blocked: ${result.reason}`);
  }
  return {
    receipt_sha256: result.receipt_sha256,
    seed_sha256: result.seed_sha256,
    action_payload_sha256: result.action_payload_sha256,
    evidence_sha256: result.evidence_sha256,
    mandate_sha256: result.mandate_sha256,
    risk_lane: "L1_local_reversible",
  };
}

export function parseCascadeValidationCommands(value: unknown, source: string): CascadeValidationCommand[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`coding cascade validation commands are missing: ${source}`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`validation command[${index}] must be an object: ${source}`);
    }
    const raw = entry as Record<string, unknown>;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    const args = raw.args;
    const timeout = raw.timeout_ms;
    if (!label || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error(`validation command[${index}] requires label, command, and string[] args: ${source}`);
    }
    if (timeout !== undefined && (!Number.isInteger(timeout) || Number(timeout) <= 0)) {
      throw new Error(`validation command[${index}] timeout_ms must be a positive integer: ${source}`);
    }
    return {
      label,
      command,
      args: [...args] as string[],
      ...(timeout !== undefined ? { timeout_ms: Number(timeout) } : {}),
    };
  });
}

export function parseSeedValidationCommands(seedPath: string): CascadeValidationCommand[] {
  if (!existsSync(seedPath)) throw new Error(`seed not found: ${seedPath}`);
  const doc = Bun.YAML.parse(readFileSync(seedPath, "utf8")) as { validation_commands?: unknown };
  return parseCascadeValidationCommands(doc?.validation_commands, seedPath);
}

export interface EnqueueResult {
  campaign: Campaign;
  items: WorkItem[];
  already_existed: boolean;
}

// ─── Config / paths ───────────────────────────────────────────────────────────

export const DEFAULT_COST_CEILING_USD = 5.0;

export function defaultCostCeiling(): number {
  const raw = process.env.SF003_CAMPAIGN_COST_CEILING;
  if (!raw) return DEFAULT_COST_CEILING_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`SF003_CAMPAIGN_COST_CEILING invalid: "${raw}" (need positive number)`);
  }
  return n;
}

/** Overridable so the self-test harness (T6) runs against a throwaway dir. */
export function poolStateDir(): string {
  return resolveFactoryStateOverride(process.env.SF003_POOL_STATE_DIR, "pool");
}

function campaignsPath(): string {
  return join(poolStateDir(), "campaigns.json");
}

function queuePath(): string {
  return join(poolStateDir(), "queue.json");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

/** Atomic JSON write: tmp file + rename, never a torn read for the conveyor. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function loadCampaigns(): Record<string, Campaign> {
  if (!existsSync(campaignsPath())) return {};
  return JSON.parse(readFileSync(campaignsPath(), "utf8")) as Record<string, Campaign>;
}

export function loadQueue(): WorkItem[] {
  if (!existsSync(queuePath())) return [];
  return JSON.parse(readFileSync(queuePath(), "utf8")) as WorkItem[];
}

export function saveCampaigns(c: Record<string, Campaign>): void {
  writeJsonAtomic(campaignsPath(), c);
}

export function saveQueue(q: WorkItem[]): void {
  writeJsonAtomic(queuePath(), q);
}

const POOL_LOCK_STALE_MS = 5 * 60_000;

export function withPoolMutationLock<T>(fn: () => T): T {
  const lockPath = join(poolStateDir(), ".mutation.lock");
  mkdirSync(poolStateDir(), { recursive: true });
  if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > POOL_LOCK_STALE_MS) {
    unlinkSync(lockPath);
  }
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    throw new Error(`pool mutation lock is held: ${lockPath}`);
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

// ─── Seed ingestion ───────────────────────────────────────────────────────────

/**
 * Parse and validate a seed document's task DAG together with its optional
 * persona-association contract. One parse, one cross-validation pass: task
 * assignments are only meaningful against the top-level association, and the
 * association is only meaningful against the tasks that reference it.
 */
function parseProjectDelegationPaths(value: unknown, source: string): ProjectDelegationPaths | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`seed delegation must be a complete object: ${source}`);
  }
  const record = value as Record<string, unknown>;
  const keys = ["mandate_path", "activation_receipt_path", "receipt_path", "action_payload_path", "evidence_path"] as const;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key as typeof keys[number]));
  if (unknown.length > 0) throw new Error(`seed delegation contains unknown fields: ${unknown.join(", ")}: ${source}`);
  const missing = keys.filter((key) => typeof record[key] !== "string" || !(record[key] as string).trim());
  if (missing.length > 0) throw new Error(`seed delegation is incomplete; missing ${missing.join(", ")}: ${source}`);
  return Object.fromEntries(keys.map((key) => [key, (record[key] as string).trim()])) as unknown as ProjectDelegationPaths;
}

export function parseSeedContractDocument(doc: unknown, source: string): SeedContract {
  const root = (doc ?? {}) as {
    tasks?: unknown;
    persona_association?: unknown;
    holdout_scenarios?: unknown;
    delegation?: unknown;
    delegation_remote_action?: unknown;
  };
  const raw = root.tasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`seed has no tasks block: ${source}`);
  }
  const personaAssociation = parsePersonaAssociation(root.persona_association, source);
  const tasks: SeedTask[] = raw.map((t: any, i: number) => {
    if (!t || typeof t.id !== "string" || t.id.length === 0) {
      throw new Error(`seed task[${i}] missing id: ${source}`);
    }
    if (typeof t.name !== "string" || t.name.length === 0) {
      throw new Error(`seed task ${t.id} missing name: ${source}`);
    }
    const deps = t.deps ?? [];
    if (!Array.isArray(deps) || deps.some((d: unknown) => typeof d !== "string")) {
      throw new Error(`seed task ${t.id} has malformed deps: ${source}`);
    }
    // `files` is best-effort for legacy seeds (never validated before) but strict
    // as soon as persona assignments depend on it for path containment.
    const files = t.files === undefined ? undefined : personaStringArray(t.files) ?? undefined;
    if (t.persona_assignments !== undefined && t.files !== undefined && files === undefined) {
      personaFail(source, `task ${t.id} declares persona_assignments but files is not an array of non-empty strings`);
    }
    const assignments = parseTaskPersonaAssignments(t.persona_assignments, t.id, files, personaAssociation, source);
    return {
      id: t.id,
      name: t.name,
      description: String(t.description ?? ""),
      deps,
      ...(files !== undefined ? { files } : {}),
      ...(assignments !== undefined ? { persona_assignments: assignments } : {}),
    };
  });
  validateDag(tasks);
  const delegation = parseProjectDelegationPaths(root.delegation, source);
  const delegationRemoteAction = parseProjectDelegationPaths(root.delegation_remote_action, source);
  if ((delegation === null) !== (delegationRemoteAction === null)) {
    throw new Error(`delegated seed requires complete L1 and L2 delegation blocks: ${source}`);
  }
  return {
    tasks,
    persona_association: personaAssociation,
    holdout_scenarios: parseHoldoutScenarios(root.holdout_scenarios, source),
    delegation,
    delegation_remote_action: delegationRemoteAction,
  };
}

function readSeedDocument(seedPath: string): unknown {
  if (!existsSync(seedPath)) throw new Error(`seed not found: ${seedPath}`);
  return Bun.YAML.parse(readFileSync(seedPath, "utf8"));
}

export function parseSeedContract(seedPath: string): SeedContract {
  return parseSeedContractDocument(readSeedDocument(seedPath), seedPath);
}

export function parseSeedTasks(seedPath: string): SeedTask[] {
  return parseSeedContract(seedPath).tasks;
}

export function parseSeedPersonaAssociation(seedPath: string): SeedPersonaAssociation | null {
  return parseSeedContract(seedPath).persona_association;
}

/**
 * Non-throwing lineage read for diagnostic surfaces (pre-spec plans, status
 * output). Mirrors readSeedSourceHash: a torn or invalid seed degrades to null
 * rather than crashing a read path. Enforcement lives in parseSeedContract.
 */
export function readSeedPersonaLineage(seedPath: string): PersonaAssociationLineage | null {
  try {
    const association = parseSeedPersonaAssociation(seedPath);
    return association ? personaAssociationLineage(association) : null;
  } catch {
    return null;
  }
}

export function parseSeedTasksYaml(seedYaml: string, seedPath = "<inline seed>"): SeedTask[] {
  return parseSeedContractDocument(Bun.YAML.parse(seedYaml), seedPath).tasks;
}

/**
 * Read the top-level `source_hash` stamp a speculative pre-spec (ZOU-437) writes
 * into a cached seed. Returns null when the file is absent, unparseable, or has no
 * stamp (a hand-authored seed) — callers treat null as "unstamped, trust as-is".
 * Never throws: the consume-guard must degrade to the legacy trust path, not crash
 * the pull, on a torn/odd seed file.
 */
export function readSeedSourceHash(seedPath: string): string | null {
  if (!existsSync(seedPath)) return null;
  try {
    const doc = Bun.YAML.parse(readFileSync(seedPath, "utf8")) as { source_hash?: unknown };
    return typeof doc?.source_hash === "string" && doc.source_hash.length > 0 ? doc.source_hash : null;
  } catch {
    return null;
  }
}

/** Fail loud on unknown deps or cycles — a bad DAG would deadlock the ready set silently. */
export function validateDag(tasks: SeedTask[]): void {
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new Error("duplicate task ids in DAG");
  for (const t of tasks) {
    for (const d of t.deps) {
      if (!ids.has(d)) throw new Error(`task ${t.id} depends on unknown task ${d}`);
      if (d === t.id) throw new Error(`task ${t.id} depends on itself`);
    }
  }
  // Kahn's algorithm — leftovers mean a cycle.
  const indeg = new Map<string, number>(tasks.map((t) => [t.id, t.deps.length]));
  const queue = tasks.filter((t) => t.deps.length === 0).map((t) => t.id);
  let seen = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen++;
    for (const t of tasks) {
      if (t.deps.includes(id)) {
        const left = indeg.get(t.id)! - 1;
        indeg.set(t.id, left);
        if (left === 0) queue.push(t.id);
      }
    }
  }
  if (seen !== tasks.length) throw new Error("cycle detected in task DAG");
}

// ─── Enqueue ──────────────────────────────────────────────────────────────────

export function enqueueCampaign(opts: {
  campaign_id: string;
  ticket_id: string;
  identifier: string;
  seed_path: string | null;
  tasks: SeedTask[];
  execution_id?: string;
  cost_ceiling_usd?: number;
  execution_policy?: ExecutionPolicy | null;
  risk_tier?: string | null;
  target_repository?: string | null;
  base_commit?: string | null;
  validation_commands?: CascadeValidationCommand[];
  depends_on_campaigns?: string[];
  persona_association?: SeedPersonaAssociation | null;
  delegation_admission?: ProjectDelegationAdmissionReference | null;
  delegation_remote_action?: ProjectDelegationPaths | null;
}): EnqueueResult {
  const campaigns = loadCampaigns();
  const requestedDeps = [...new Set(opts.depends_on_campaigns ?? [])].sort();
  const requestedPersona = opts.persona_association ?? null;
  assertTaskAssignmentsMatchAssociation(opts.tasks, requestedPersona, `campaign ${opts.campaign_id}`);
  const existing = campaigns[opts.campaign_id];
  if (existing) {
    const existingKey = personaLineageKey(existing.persona_association);
    const requestedKey = personaLineageKey(requestedPersona);
    if (existingKey !== requestedKey) {
      throw new Error(
        `campaign ${opts.campaign_id} already exists with a different persona association lineage — hash drift (recorded ${existingKey}, requested ${requestedKey})`,
      );
    }
    if (JSON.stringify(existing.execution_policy ?? null) !== JSON.stringify(opts.execution_policy ?? null)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with a different execution policy`);
    }
    if ((existing.execution_id ?? null) !== (opts.execution_id ?? null)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with a different parent execution`);
    }
    if ((existing.target_repository ?? null) !== (opts.target_repository ?? null)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with a different target repository`);
    }
    if ((existing.base_commit ?? null) !== (opts.base_commit ?? null)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with a different base commit`);
    }
    if (JSON.stringify(existing.validation_commands ?? []) !== JSON.stringify(opts.validation_commands ?? [])) {
      throw new Error(`campaign ${opts.campaign_id} already exists with different validation commands`);
    }
    if (JSON.stringify(existing.delegation_admission ?? null) !== JSON.stringify(opts.delegation_admission ?? null)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with a different project delegation admission`);
    }
    if (JSON.stringify(existing.delegation_remote_action ?? null) !== JSON.stringify(opts.delegation_remote_action ?? null)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with a different delegated remote action`);
    }
    const existingDeps = [...(existing.depends_on_campaigns ?? [])].sort();
    if (JSON.stringify(existingDeps) !== JSON.stringify(requestedDeps)) {
      throw new Error(`campaign ${opts.campaign_id} already exists with different campaign dependencies`);
    }
    // Idempotent by campaign_id — re-enqueue changes no state.
    const items = loadQueue().filter((i) => i.campaign_id === opts.campaign_id);
    return { campaign: existing, items, already_existed: true };
  }
  for (const dep of requestedDeps) {
    if (dep === opts.campaign_id) throw new Error(`campaign ${opts.campaign_id} cannot depend on itself`);
    if (!campaigns[dep]) {
      throw new Error(`campaign ${opts.campaign_id} depends on unknown campaign ${dep} — enqueue upstream campaigns first`);
    }
  }
  validateDag(opts.tasks);
  const ts = now();
  const campaign: Campaign = {
    campaign_id: opts.campaign_id,
    ticket_id: opts.ticket_id,
    identifier: opts.identifier,
    seed_path: opts.seed_path,
    tasks: opts.tasks.map((t) => t.id),
    cost_ceiling_usd: opts.cost_ceiling_usd ?? defaultCostCeiling(),
    cost_spent_usd: 0,
    state: "active",
    created_at: ts,
    ...(opts.execution_id !== undefined ? { execution_id: opts.execution_id } : {}),
    execution_policy: opts.execution_policy ?? null,
    risk_tier: opts.risk_tier ?? null,
    ...(opts.target_repository !== undefined ? { target_repository: opts.target_repository } : {}),
    ...(opts.base_commit !== undefined ? { base_commit: opts.base_commit } : {}),
    ...(opts.validation_commands !== undefined ? { validation_commands: opts.validation_commands } : {}),
    ...(requestedDeps.length > 0 ? { depends_on_campaigns: requestedDeps } : {}),
    ...(requestedPersona ? { persona_association: requestedPersona } : {}),
    ...(opts.delegation_admission ? { delegation_admission: opts.delegation_admission } : {}),
    ...(opts.delegation_remote_action ? { delegation_remote_action: opts.delegation_remote_action } : {}),
  };
  const items: WorkItem[] = opts.tasks.map((t) => ({
    campaign_id: opts.campaign_id,
    task_id: t.id,
    name: t.name,
    description: t.description,
    deps: t.deps,
    state: "ready",
    attempts: 0,
    park_reason: null,
    created_at: ts,
    updated_at: ts,
    // Absent-field parity: a task with no persona assignment serializes exactly
    // as it did before ZOU-1282 — neither key appears.
    ...(t.persona_assignments !== undefined
      ? { persona_assignments: t.persona_assignments, owned_files: t.files ?? [] }
      : {}),
  }));
  campaigns[opts.campaign_id] = campaign;
  saveCampaigns(campaigns);
  saveQueue([...loadQueue(), ...items]);
  return { campaign, items, already_existed: false };
}

/** DIRECT tickets enter as single-item campaigns. */
export function enqueueDirect(opts: {
  campaign_id: string;
  ticket_id: string;
  identifier: string;
  name: string;
  description: string;
  cost_ceiling_usd?: number;
  execution_policy?: ExecutionPolicy | null;
  risk_tier?: string | null;
  target_repository?: string | null;
  base_commit?: string | null;
  validation_commands?: CascadeValidationCommand[];
  depends_on_campaigns?: string[];
}): EnqueueResult {
  return enqueueCampaign({
    campaign_id: opts.campaign_id,
    ticket_id: opts.ticket_id,
    identifier: opts.identifier,
    seed_path: null,
    tasks: [{ id: "DIRECT", name: opts.name, description: opts.description, deps: [] }],
    cost_ceiling_usd: opts.cost_ceiling_usd,
    execution_policy: opts.execution_policy,
    risk_tier: opts.risk_tier,
    target_repository: opts.target_repository,
    base_commit: opts.base_commit,
    validation_commands: opts.validation_commands,
    depends_on_campaigns: opts.depends_on_campaigns,
  });
}

// ─── Ready set / transitions ──────────────────────────────────────────────────

/**
 * FR-05: a campaign is upstream-blocked until every campaign it depends on is
 * "complete". Missing upstream records and failed/parked upstreams both block
 * (fail closed). Returns the blocking upstream ids, empty when dispatchable.
 */
export function upstreamBlockers(c: Campaign, campaigns: Record<string, Campaign>): string[] {
  return (c.depends_on_campaigns ?? []).filter((dep) => campaigns[dep]?.state !== "complete");
}

/**
 * A task is ready-to-dispatch only when all its task deps are done, its
 * campaign is dispatchable, and no upstream campaign blocks it (FR-05).
 *
 * Ordering is the starvation control: the returned set is sorted oldest
 * campaign first (created_at, then campaign_id), then seed task order within
 * a campaign. Dispatch consumes this order, so under any max-dispatch
 * throttle the longest-waiting work always drains first — later arrivals
 * cannot starve an older ready item.
 */
export function readySet(items?: WorkItem[], campaigns?: Record<string, Campaign>): WorkItem[] {
  const all = items ?? loadQueue();
  const regs = campaigns ?? loadCampaigns();
  const doneByCampaign = new Map<string, Set<string>>();
  for (const i of all) {
    if (i.state === "done") {
      if (!doneByCampaign.has(i.campaign_id)) doneByCampaign.set(i.campaign_id, new Set());
      doneByCampaign.get(i.campaign_id)!.add(i.task_id);
    }
  }
  const eligible = all.filter((i) => {
    if (i.state !== "ready") return false;
    const c = regs[i.campaign_id];
    if (!c || (c.state !== "active" && c.state !== "parked")) return false;
    if (upstreamBlockers(c, regs).length > 0) return false;
    const done = doneByCampaign.get(i.campaign_id) ?? new Set();
    return i.deps.every((d) => done.has(d));
  });
  return eligible.sort((a, b) => {
    const ca = regs[a.campaign_id];
    const cb = regs[b.campaign_id];
    if (a.campaign_id !== b.campaign_id) {
      const byAge = (ca?.created_at ?? "").localeCompare(cb?.created_at ?? "");
      if (byAge !== 0) return byAge;
      return a.campaign_id.localeCompare(b.campaign_id);
    }
    const order = ca?.tasks ?? [];
    return order.indexOf(a.task_id) - order.indexOf(b.task_id);
  });
}

/** FR-05 visibility: ready items whose campaign is waiting on upstream campaigns. */
export function upstreamBlockedItems(
  items?: WorkItem[],
  campaigns?: Record<string, Campaign>,
): Array<{ item: WorkItem; waiting_on: string[] }> {
  const all = items ?? loadQueue();
  const regs = campaigns ?? loadCampaigns();
  const out: Array<{ item: WorkItem; waiting_on: string[] }> = [];
  for (const i of all) {
    if (i.state !== "ready") continue;
    const c = regs[i.campaign_id];
    if (!c) continue;
    const waiting = upstreamBlockers(c, regs);
    if (waiting.length > 0) out.push({ item: i, waiting_on: waiting });
  }
  return out;
}

export function inFlight(items?: WorkItem[]): WorkItem[] {
  return (items ?? loadQueue()).filter((i) => i.state === "in-flight");
}

export function ceilingExceeded(c: Campaign): boolean {
  return c.cost_spent_usd >= c.cost_ceiling_usd;
}

/** Campaign state is a pure function of its items (recomputable, never drifts). */
export function rollupCampaignState(items: WorkItem[]): CampaignState {
  if (items.length > 0 && items.every((i) => i.state === "done")) return "complete";
  if (items.some((i) => i.state === "failed")) return "failed";
  const anyParked = items.some((i) => i.state === "parked");
  const anyMoving = items.some((i) => i.state === "in-flight" || i.state === "ready");
  if (anyParked && !anyMoving) return "parked";
  return "active";
}

export function markItem(
  campaign_id: string,
  task_id: string,
  state: WorkItemState,
  opts: { park_reason?: string; increment_attempt?: boolean } = {}
): WorkItem {
  const q = loadQueue();
  const item = q.find((i) => i.campaign_id === campaign_id && i.task_id === task_id);
  if (!item) throw new Error(`no work item (${campaign_id}, ${task_id})`);
  item.state = state;
  item.updated_at = now();
  item.park_reason = state === "parked" ? (opts.park_reason ?? "unspecified") : null;
  if (opts.increment_attempt) item.attempts += 1;
  saveQueue(q);
  refreshCampaignState(campaign_id, q);
  return item;
}

export function refreshCampaignState(campaign_id: string, items?: WorkItem[]): Campaign {
  const campaigns = loadCampaigns();
  const c = campaigns[campaign_id];
  if (!c) throw new Error(`no campaign ${campaign_id}`);
  const mine = (items ?? loadQueue()).filter((i) => i.campaign_id === campaign_id);
  const next = rollupCampaignState(mine);
  if (next !== c.state) {
    c.state = next;
    saveCampaigns(campaigns);
  }
  return c;
}

/** Cost is spent by the manager (T3) at dispatch/harvest time. */
export function addCost(campaign_id: string, usd: number): Campaign {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`addCost: invalid amount ${usd}`);
  const campaigns = loadCampaigns();
  const c = campaigns[campaign_id];
  if (!c) throw new Error(`no campaign ${campaign_id}`);
  c.cost_spent_usd = Math.round((c.cost_spent_usd + usd) * 10000) / 10000;
  saveCampaigns(campaigns);
  return c;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usage(msg?: string): never {
  if (msg) console.error(`ERROR: ${msg}\n`);
  console.error(`Usage:
  pool-queue.ts enqueue --seed <path> --ticket-id <id> --identifier <ZOU-x> [--campaign <id>] [--ceiling <usd>] [--depends-on <c1,c2>]
  pool-queue.ts enqueue --direct --ticket-id <id> --identifier <ZOU-x> --name <title> [--description <d>] [--ceiling <usd>] [--depends-on <c1,c2>]
  pool-queue.ts list [--json]
  pool-queue.ts status [<campaign_id>]
  pool-queue.ts park <campaign_id> <task_id> --reason <text>
  pool-queue.ts release <campaign_id> <task_id>
  pool-queue.ts selftest

Env:
  SF003_CAMPAIGN_COST_CEILING   default per-campaign ceiling in USD (default ${DEFAULT_COST_CEILING_USD})
  SF003_POOL_STATE_DIR          state dir override (self-test harness only)`);
  process.exit(2);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${flag} requires a value`);
  return v;
}

function parseCeiling(args: string[]): number | undefined {
  const raw = flagValue(args, "--ceiling");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) usage(`--ceiling must be a positive number, got "${raw}"`);
  return n;
}

function cmdEnqueue(args: string[]): void {
  const ticketId = flagValue(args, "--ticket-id");
  const identifier = flagValue(args, "--identifier");
  if (!ticketId || !identifier) usage("enqueue requires --ticket-id and --identifier");
  const ceiling = parseCeiling(args);
  const dependsRaw = flagValue(args, "--depends-on");
  const dependsOn = dependsRaw ? dependsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  let result: EnqueueResult;
  if (args.includes("--direct")) {
    const name = flagValue(args, "--name");
    if (!name) usage("--direct enqueue requires --name");
    result = enqueueDirect({
      campaign_id: flagValue(args, "--campaign") ?? identifier,
      ticket_id: ticketId,
      identifier,
      name,
      description: flagValue(args, "--description") ?? "",
      cost_ceiling_usd: ceiling,
      depends_on_campaigns: dependsOn,
    });
  } else {
    const seedPath = flagValue(args, "--seed");
    if (!seedPath) usage("enqueue requires --seed <path> (or --direct)");
    const contract = parseSeedContract(seedPath);
    result = enqueueCampaign({
      campaign_id: flagValue(args, "--campaign") ?? identifier,
      ticket_id: ticketId,
      identifier,
      seed_path: seedPath,
      tasks: contract.tasks,
      persona_association: contract.persona_association,
      cost_ceiling_usd: ceiling,
      depends_on_campaigns: dependsOn,
    });
  }
  const c = result.campaign;
  const chain = (c.depends_on_campaigns ?? []).length > 0 ? `, depends on [${c.depends_on_campaigns!.join(",")}]` : "";
  console.log(
    result.already_existed
      ? `[pool-queue] campaign ${c.campaign_id} already enqueued (${result.items.length} items) — no-op`
      : `[pool-queue] enqueued campaign ${c.campaign_id}: ${result.items.length} items, ceiling $${c.cost_ceiling_usd.toFixed(2)}${chain}`
  );
}

function cmdList(args: string[]): void {
  const campaigns = loadCampaigns();
  const items = loadQueue();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ campaigns, items }, null, 2));
    return;
  }
  const ids = Object.keys(campaigns);
  if (ids.length === 0) {
    console.log("[pool-queue] queue empty (no campaigns)");
    return;
  }
  for (const id of ids) {
    const c = campaigns[id];
    const mine = items.filter((i) => i.campaign_id === id);
    const counts: Record<string, number> = {};
    for (const i of mine) counts[i.state] = (counts[i.state] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
    console.log(
      `${c.state.padEnd(8)} ${id} (${c.identifier}) — ${mine.length} items [${summary}] — $${c.cost_spent_usd.toFixed(2)}/$${c.cost_ceiling_usd.toFixed(2)}`
    );
  }
}

function cmdStatus(args: string[]): void {
  const campaigns = loadCampaigns();
  const items = loadQueue();
  const filter = args.find((a) => !a.startsWith("--"));
  if (filter && !campaigns[filter]) usage(`unknown campaign: ${filter}`);
  const scope = filter ? items.filter((i) => i.campaign_id === filter) : items;
  const ready = readySet(scope, campaigns);
  console.log(`queue depth: ${scope.filter((i) => i.state === "ready").length} ready (${ready.length} dispatchable) | ${scope.filter((i) => i.state === "in-flight").length} in-flight | ${scope.filter((i) => i.state === "done").length} done | ${scope.filter((i) => i.state === "failed").length} failed | ${scope.filter((i) => i.state === "parked").length} parked`);
  const blocked = new Map(upstreamBlockedItems(scope, campaigns).map((b) => [`${b.item.campaign_id}/${b.item.task_id}`, b.waiting_on]));
  for (const i of scope) {
    const deps = i.deps.length > 0 ? ` deps=[${i.deps.join(",")}]` : "";
    const park = i.park_reason ? ` (${i.park_reason})` : "";
    const upstream = blocked.get(`${i.campaign_id}/${i.task_id}`);
    const wait = upstream ? ` [blocked-upstream: ${upstream.join(",")}]` : "";
    console.log(`  ${i.state.padEnd(9)} ${i.campaign_id}/${i.task_id} — ${i.name}${deps} attempts=${i.attempts}${park}${wait}`);
  }
}

function cmdPark(args: string[]): void {
  const [campaignId, taskId] = args.filter((a) => !a.startsWith("--") && a !== flagValue(args, "--reason"));
  const reason = flagValue(args, "--reason");
  if (!campaignId || !taskId || !reason) usage("park requires <campaign_id> <task_id> --reason <text>");
  const item = markItem(campaignId, taskId, "parked", { park_reason: `operator: ${reason}` });
  console.log(`[pool-queue] parked ${campaignId}/${taskId}: ${item.park_reason}`);
}

function cmdRelease(args: string[]): void {
  const [campaignId, taskId] = args;
  if (!campaignId || !taskId) usage("release requires <campaign_id> <task_id>");
  const q = loadQueue();
  const item = q.find((i) => i.campaign_id === campaignId && i.task_id === taskId);
  if (!item) usage(`no work item (${campaignId}, ${taskId})`);
  if (item.state !== "parked") usage(`item (${campaignId}, ${taskId}) is ${item.state}, not parked`);
  markItem(campaignId, taskId, "ready");
  console.log(`[pool-queue] released ${campaignId}/${taskId} → ready`);
}

// ─── Self-test ────────────────────────────────────────────────────────────────

function cmdSelftest(): void {
  const dir = join("/tmp", `pool-queue-selftest-${Date.now()}`);
  const savedDir = process.env.SF003_POOL_STATE_DIR;
  const savedCeiling = process.env.SF003_CAMPAIGN_COST_CEILING;
  process.env.SF003_POOL_STATE_DIR = dir;
  delete process.env.SF003_CAMPAIGN_COST_CEILING;
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean) => {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      console.error(`  ✗ ${name}`);
    }
  };
  try {
    const seedPath = join(dir, "fixture-seed.yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      seedPath,
      [
        "tasks:",
        "  - id: A",
        "    name: task A",
        "    description: first",
        "    deps: []",
        "  - id: B",
        "    name: task B",
        "    deps: [\"A\"]",
        "  - id: C",
        "    name: task C",
        "    deps: [\"A\"]",
        "  - id: D",
        "    name: task D",
        "    deps: [\"B\", \"C\"]",
      ].join("\n")
    );

    const tasks = parseSeedTasks(seedPath);
    check("seed parse: 4 tasks", tasks.length === 4 && tasks[1].deps[0] === "A");

    const r1 = enqueueCampaign({ campaign_id: "camp-1", ticket_id: "t1", identifier: "ZOU-T1", seed_path: seedPath, tasks });
    check("enqueue creates campaign + 4 ready items", !r1.already_existed && r1.items.length === 4 && r1.items.every((i) => i.state === "ready"));
    check("default ceiling $5.00", r1.campaign.cost_ceiling_usd === 5.0);

    const r2 = enqueueCampaign({ campaign_id: "camp-1", ticket_id: "t1", identifier: "ZOU-T1", seed_path: seedPath, tasks });
    check("re-enqueue idempotent (no-op)", r2.already_existed && loadQueue().length === 4);

    check("ready set = only A (deps gate B/C/D)", readySet().length === 1 && readySet()[0].task_id === "A");

    markItem("camp-1", "A", "in-flight", { increment_attempt: true });
    check("in-flight tracked, ready set empty", inFlight().length === 1 && readySet().length === 0);

    markItem("camp-1", "A", "done");
    const ready2 = readySet().map((i) => i.task_id).sort();
    check("A done unlocks B+C, not D", ready2.join(",") === "B,C");

    markItem("camp-1", "B", "parked", { park_reason: "capacity overflow" });
    check("parked item carries reason, excluded from ready", loadQueue().find((i) => i.task_id === "B")!.park_reason === "capacity overflow" && readySet().length === 1);

    markItem("camp-1", "B", "ready");
    check("release parked → ready clears reason", loadQueue().find((i) => i.task_id === "B")!.park_reason === null && readySet().length === 2);

    for (const t of ["B", "C", "D"]) markItem("camp-1", t, "done");
    check("all done → campaign complete", loadCampaigns()["camp-1"].state === "complete");

    const d1 = enqueueDirect({ campaign_id: "ZOU-D1", ticket_id: "t2", identifier: "ZOU-D1", name: "direct thing", description: "x", cost_ceiling_usd: 2 });
    check("DIRECT = single-item campaign, seed_path null", d1.items.length === 1 && d1.campaign.seed_path === null && d1.items[0].task_id === "DIRECT");

    addCost("ZOU-D1", 1.5);
    check("cost below ceiling not exceeded", !ceilingExceeded(loadCampaigns()["ZOU-D1"]));
    addCost("ZOU-D1", 0.5);
    check("cost at ceiling → exceeded", ceilingExceeded(loadCampaigns()["ZOU-D1"]));

    markItem("ZOU-D1", "DIRECT", "failed", { increment_attempt: true });
    check("failed item → campaign failed", loadCampaigns()["ZOU-D1"].state === "failed");

    let threw = false;
    try {
      validateDag([
        { id: "X", name: "x", description: "", deps: ["Y"] },
        { id: "Y", name: "y", description: "", deps: ["X"] },
      ]);
    } catch {
      threw = true;
    }
    check("cycle detection throws", threw);

    threw = false;
    try {
      validateDag([{ id: "X", name: "x", description: "", deps: ["NOPE"] }]);
    } catch {
      threw = true;
    }
    check("unknown dep throws", threw);

    check("state files exist under override dir", existsSync(join(dir, "campaigns.json")) && existsSync(join(dir, "queue.json")));

    // ZOU-1282 — persona association contract.
    const legacyItem = loadQueue().find((i) => i.campaign_id === "camp-1" && i.task_id === "A")!;
    check(
      "legacy seed work item carries no persona keys (absent-field parity)",
      !("persona_assignments" in legacyItem) && !("owned_files" in legacyItem) && !("persona_association" in loadCampaigns()["camp-1"]),
    );
    check("legacy seed parses to a null association", parseSeedContract(seedPath).persona_association === null);

    const personaSeed = join(dir, "persona-seed.yaml");
    const personaSeedBody = (sha: string, authority: string, ownedPath: string): string =>
      [
        "persona_association:",
        '  template_reference: "game@1.0.0"',
        '  version: "1.0.0"',
        `  sha256: "${sha}"`,
        "  declared_capabilities:",
        "    - realtime-3d",
        "  selector_values:",
        "    engine: unity",
        "  fleet:",
        '    - role_id: "game-designer"',
        '      persona_name: "GameDev · Game Designer"',
        "      required: true",
        "      phases: [advise, review]",
        "      required_scopes: [files:read]",
        "      invocation_cap: 2",
        '    - role_id: "technical-artist"',
        '      persona_name: "GameDev · Technical Artist"',
        "      required: false",
        "      phases: [advise, implement, review]",
        "      required_scopes: [files:read, files:write]",
        "      invocation_cap: 1",
        "  omitted_roles:",
        '    - role_id: "level-designer"',
        '      reason: "capability-mismatch"',
        "tasks:",
        "  - id: P1",
        "    name: persona task",
        "    deps: []",
        "    files:",
        "      - src/render/",
        "      - src/audio/mixer.ts",
        "    persona_assignments:",
        '      - role_id: "technical-artist"',
        `        authority: "${authority}"`,
        "        owned_paths:",
        `          - ${ownedPath}`,
      ].join("\n");
    const shaA = "a".repeat(64);
    writeFileSync(personaSeed, personaSeedBody(shaA, "implement", "src/render/shader.ts"));

    const personaContract = parseSeedContract(personaSeed);
    check(
      "association parses with fleet, omissions, and a local fingerprint",
      personaContract.persona_association !== null &&
        personaContract.persona_association.fleet.length === 2 &&
        personaContract.persona_association.omitted_roles[0].role_id === "level-designer" &&
        /^[a-f0-9]{64}$/.test(personaContract.persona_association.content_fingerprint),
    );
    check(
      "implement assignment is contained by the task's owned files",
      personaContract.tasks[0].persona_assignments?.[0].authority === "implement" &&
        personaContract.tasks[0].persona_assignments?.[0].owned_paths[0] === "src/render/shader.ts",
    );

    const pr = enqueueCampaign({
      campaign_id: "camp-persona",
      ticket_id: "t3",
      identifier: "ZOU-1282",
      seed_path: personaSeed,
      tasks: personaContract.tasks,
      persona_association: personaContract.persona_association,
    });
    check("campaign records the association lineage", pr.campaign.persona_association?.sha256 === shaA);
    check(
      "work item carries assignments plus owned files",
      pr.items[0].persona_assignments?.length === 1 && pr.items[0].owned_files?.length === 2,
    );

    // Restart parity: state reloaded from disk must be identical.
    const reloaded = loadCampaigns()["camp-persona"];
    const reloadedItem = loadQueue().find((i) => i.campaign_id === "camp-persona")!;
    check(
      "restart reload preserves the contract byte-for-byte",
      JSON.stringify(reloaded.persona_association) === JSON.stringify(personaContract.persona_association) &&
        JSON.stringify(reloadedItem.persona_assignments) === JSON.stringify(personaContract.tasks[0].persona_assignments),
    );
    check(
      "re-enqueue with identical lineage is idempotent",
      enqueueCampaign({
        campaign_id: "camp-persona",
        ticket_id: "t3",
        identifier: "ZOU-1282",
        seed_path: personaSeed,
        tasks: parseSeedContract(personaSeed).tasks,
        persona_association: parseSeedContract(personaSeed).persona_association,
      }).already_existed,
    );

    const rejects = (name: string, body: string, opts: { enqueue?: boolean } = {}): void => {
      const p = join(dir, `reject-${name.replace(/[^a-z0-9]+/gi, "-")}.yaml`);
      writeFileSync(p, body);
      let threwLocal = false;
      try {
        const c = parseSeedContract(p);
        if (opts.enqueue) {
          enqueueCampaign({
            campaign_id: "camp-persona",
            ticket_id: "t3",
            identifier: "ZOU-1282",
            seed_path: p,
            tasks: c.tasks,
            persona_association: c.persona_association,
          });
        }
      } catch {
        threwLocal = true;
      }
      check(name, threwLocal);
    };

    rejects("unknown role rejected", personaSeedBody(shaA, "implement", "src/render/shader.ts").replace('"technical-artist"\n        authority', '"nonexistent-role"\n        authority'));
    rejects("authority escalation beyond association phases rejected", personaSeedBody(shaA, "implement", "src/render/shader.ts").replace('role_id: "technical-artist"\n        authority: "implement"', 'role_id: "game-designer"\n        authority: "implement"'));
    rejects("implement path outside owned files rejected", personaSeedBody(shaA, "implement", "src/network/socket.ts"));
    rejects("implement authority with empty owned paths rejected", personaSeedBody(shaA, "implement", "src/render/shader.ts").replace(/        owned_paths:\n          - .*\n?/, "        owned_paths: []\n"));
    rejects("task assignments without top-level association rejected", personaSeedBody(shaA, "advise", "src/render/shader.ts").replace(/^persona_association:[\s\S]*?(?=^tasks:)/m, ""));
    rejects("floating template version rejected", personaSeedBody(shaA, "advise", "src/render/shader.ts").replace('"game@1.0.0"', '"game@^1.0"'));
    rejects("embedded mutable persona uuid rejected", personaSeedBody(shaA, "advise", "src/render/shader.ts").replace('      required: false', '      persona_id: "9fa5bf37"\n      required: false'));
    rejects("omitted role without a reason rejected", personaSeedBody(shaA, "advise", "src/render/shader.ts").replace('      reason: "capability-mismatch"', '      reason: ""'));
    rejects("edited fleet body under an unchanged sha256 rejected as drift", personaSeedBody(shaA, "advise", "src/render/shader.ts").replace("invocation_cap: 2", "invocation_cap: 9"), { enqueue: true });
    rejects("changed association sha256 rejected as drift", personaSeedBody("b".repeat(64), "advise", "src/render/shader.ts"), { enqueue: true });

    const directPersona = enqueueDirect({ campaign_id: "ZOU-D2", ticket_id: "t4", identifier: "ZOU-D2", name: "direct", description: "x" });
    check(
      "DIRECT campaign gains no persona fields",
      !("persona_association" in directPersona.campaign) && !("persona_assignments" in directPersona.items[0]) && !("owned_files" in directPersona.items[0]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env.SF003_POOL_STATE_DIR;
    else process.env.SF003_POOL_STATE_DIR = savedDir;
    if (savedCeiling !== undefined) process.env.SF003_CAMPAIGN_COST_CEILING = savedCeiling;
  }
  console.log(`[pool-queue] self-test: ${pass}/${pass + fail} pass`);
  process.exit(fail === 0 ? 0 : 1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "enqueue":
        cmdEnqueue(args);
        break;
      case "list":
        cmdList(args);
        break;
      case "status":
        cmdStatus(args);
        break;
      case "park":
        cmdPark(args);
        break;
      case "release":
        cmdRelease(args);
        break;
      case "selftest":
        cmdSelftest();
        break;
      default:
        usage(cmd ? `unknown command: ${cmd}` : undefined);
    }
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}
