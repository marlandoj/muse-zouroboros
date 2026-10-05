#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { factoryStatePath } from "./factory-state-root";
import { validatePersonaParticipation } from "./factory-evidence";
import {
  loadCampaigns,
  loadQueue,
  poolStateDir,
  type Campaign,
  type WorkItem,
} from "./pool-queue";
import type { Assignment } from "./pool-worker";
import type { PersonaOrchestrationMode, PersonaOrchestrationRecord } from "./persona-orchestrator";

export const PERSONA_SHADOW_REQUIRED_TASKS = 5;
export const PERSONA_SHADOW_REQUIRED_CATEGORIES = 2;
export const PERSONA_SHADOW_REQUIRED_WINDOW_HOURS = 48;

export type PersonaShadowQualificationState = "blocked" | "collecting" | "ready";
export type PersonaShadowQualificationReason =
  | "mode_not_shadow"
  | "no_campaign_traffic"
  | "no_associated_campaigns"
  | "no_eligible_tasks"
  | "no_persona_receipts"
  | "unsafe_shadow_receipts"
  | "qualified_task_threshold_not_met"
  | "template_category_threshold_not_met"
  | "observation_window_not_met";

export interface QualifiedPersonaTask {
  task_key: string;
  campaign_id: string;
  task_id: string;
  assignment_id: string;
  template_reference: string;
  template_category: string;
  receipt_created_at: string;
  receipt_updated_at: string;
  association_sha256: string;
  directory_snapshot_hash: string;
  would_invoke_count: number;
}

export interface PersonaShadowQualificationSnapshot {
  version: 1;
  observed_at: string;
  mode: PersonaOrchestrationMode;
  state: PersonaShadowQualificationState;
  ready_for_enforcement_review: boolean;
  reasons: PersonaShadowQualificationReason[];
  thresholds: {
    required_distinct_tasks: number;
    required_template_categories: number;
    required_window_hours: number;
  };
  traffic: {
    campaigns_total: number;
    associated_campaigns: number;
    eligible_tasks: number;
    persona_receipts: number;
    qualified_distinct_tasks: number;
    qualified_template_categories: string[];
    observation_window_hours: number;
  };
  safety: {
    zero_persona_calls: boolean;
    zero_persona_spend: boolean;
    unsafe_receipt_count: number;
    unsafe_receipts: Array<{ assignment_id: string; task_key: string; errors: string[] }>;
  };
  qualified_tasks: QualifiedPersonaTask[];
}

export interface PersonaShadowQualificationObservation {
  version: 1;
  sequence: number;
  source: string;
  previous_hash: string | null;
  snapshot: PersonaShadowQualificationSnapshot;
  observation_hash: string;
}

export interface PersonaShadowQualificationInput {
  mode: PersonaOrchestrationMode;
  campaigns: Record<string, Campaign>;
  queue: WorkItem[];
  assignments: Assignment[];
  now: string;
}

const LOCK_STALE_MS = 10 * 60_000;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validTime(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function taskKey(campaignId: string, taskId: string): string {
  return `${campaignId}/${taskId}`;
}

function templateCategory(reference: string): string {
  const category = reference.replace(/@[^@]+$/, "").trim();
  return category || reference;
}

function assignmentTime(assignment: Assignment): number {
  const record = assignment.persona_orchestration;
  return (record ? validTime(record.updated_at) ?? validTime(record.created_at) : null)
    ?? (assignment.completed_at ? validTime(assignment.completed_at) : null)
    ?? validTime(assignment.started_at)
    ?? 0;
}

function latestAssignments(assignments: Assignment[]): Map<string, Assignment> {
  const latest = new Map<string, Assignment>();
  for (const assignment of assignments) {
    const key = taskKey(assignment.campaign_id, assignment.task_id);
    const prior = latest.get(key);
    if (!prior || assignment.attempt > prior.attempt || (
      assignment.attempt === prior.attempt && assignmentTime(assignment) >= assignmentTime(prior)
    )) {
      latest.set(key, assignment);
    }
  }
  return latest;
}

function receiptErrors(campaign: Campaign, item: WorkItem, assignment: Assignment): string[] {
  const record = assignment.persona_orchestration;
  if (!record) return ["persona orchestration receipt is missing"];
  const association = campaign.persona_association;
  const errors = validatePersonaParticipation(record);
  if (!association) errors.push("campaign persona association is missing");
  if (record.mode !== "shadow") errors.push(`receipt mode is ${record.mode}, expected shadow`);
  if (record.campaign_id !== campaign.campaign_id || record.task_id !== item.task_id) {
    errors.push("receipt campaign/task identity does not match the eligible task");
  }
  if (association && (
    record.association.template_reference !== association.template_reference
    || record.association.version !== association.version
    || record.association.sha256 !== association.sha256
    || record.association.content_fingerprint !== association.content_fingerprint
  )) errors.push("receipt association lineage does not match the campaign");
  if (record.blocked_reason !== null) errors.push(`receipt is blocked: ${record.blocked_reason}`);
  if (record.directory.snapshot_hash === null) errors.push("persona directory snapshot is missing");
  if (record.invocations.length === 0) errors.push("receipt has no persona invocations");
  if (record.invocations.some((entry) => entry.status !== "would_invoke")) {
    errors.push("every shadow invocation must be would_invoke");
  }
  if (record.invocations.some((entry) => !entry.persona_id || !entry.persona_name)) {
    errors.push("every shadow invocation must resolve a persona identity");
  }
  if (record.total_cost_usd !== 0 || record.invocations.some((entry) => entry.cost_usd !== null)) {
    errors.push("shadow receipt contains persona spend");
  }
  return [...new Set(errors)];
}

export function assessPersonaShadowQualification(input: PersonaShadowQualificationInput): PersonaShadowQualificationSnapshot {
  const nowMs = validTime(input.now);
  if (nowMs === null) throw new Error(`invalid observation timestamp: ${input.now}`);
  const campaigns = Object.values(input.campaigns);
  const associated = campaigns.filter((campaign) => campaign.persona_association !== undefined);
  const associatedIds = new Set(associated.map((campaign) => campaign.campaign_id));
  const eligible = input.queue.filter((item) => associatedIds.has(item.campaign_id) && (item.persona_assignments?.length ?? 0) > 0);
  const campaignById = new Map(associated.map((campaign) => [campaign.campaign_id, campaign]));
  const latest = latestAssignments(input.assignments);
  const unsafe: PersonaShadowQualificationSnapshot["safety"]["unsafe_receipts"] = [];
  const qualified: QualifiedPersonaTask[] = [];
  let receiptCount = 0;

  for (const item of eligible) {
    const key = taskKey(item.campaign_id, item.task_id);
    const assignment = latest.get(key);
    if (!assignment?.persona_orchestration) continue;
    receiptCount += 1;
    const campaign = campaignById.get(item.campaign_id)!;
    const errors = receiptErrors(campaign, item, assignment);
    if (errors.length > 0) {
      unsafe.push({ assignment_id: assignment.assignment_id, task_key: key, errors });
      continue;
    }
    const record = assignment.persona_orchestration;
    qualified.push({
      task_key: key,
      campaign_id: item.campaign_id,
      task_id: item.task_id,
      assignment_id: assignment.assignment_id,
      template_reference: record.association.template_reference,
      template_category: templateCategory(record.association.template_reference),
      receipt_created_at: record.created_at,
      receipt_updated_at: record.updated_at,
      association_sha256: record.association.sha256,
      directory_snapshot_hash: record.directory.snapshot_hash!,
      would_invoke_count: record.invocations.length,
    });
  }

  qualified.sort((left, right) => left.task_key.localeCompare(right.task_key));
  const categories = [...new Set(qualified.map((entry) => entry.template_category))].sort();
  const earliestMs = qualified
    .map((entry) => validTime(entry.receipt_created_at))
    .filter((value): value is number => value !== null)
    .reduce<number | null>((earliest, value) => earliest === null ? value : Math.min(earliest, value), null);
  const observationWindowHours = earliestMs === null ? 0 : Math.max(0, (nowMs - earliestMs) / 3_600_000);
  const personaRecords = input.assignments
    .map((assignment) => assignment.persona_orchestration)
    .filter((record): record is PersonaOrchestrationRecord => record !== undefined && record.mode === "shadow");
  const zeroCalls = personaRecords.every((record) => record.invocations.every((entry) => entry.status !== "invoked"));
  const zeroSpend = personaRecords.every((record) =>
    record.total_cost_usd === 0 && record.invocations.every((entry) => entry.cost_usd === null));

  const reasons: PersonaShadowQualificationReason[] = [];
  if (input.mode !== "shadow") reasons.push("mode_not_shadow");
  if (campaigns.length === 0) reasons.push("no_campaign_traffic");
  else if (associated.length === 0) reasons.push("no_associated_campaigns");
  else if (eligible.length === 0) reasons.push("no_eligible_tasks");
  else if (receiptCount === 0) reasons.push("no_persona_receipts");
  if (unsafe.length > 0 || !zeroCalls || !zeroSpend) reasons.push("unsafe_shadow_receipts");
  if (qualified.length < PERSONA_SHADOW_REQUIRED_TASKS) reasons.push("qualified_task_threshold_not_met");
  if (categories.length < PERSONA_SHADOW_REQUIRED_CATEGORIES) reasons.push("template_category_threshold_not_met");
  if (observationWindowHours < PERSONA_SHADOW_REQUIRED_WINDOW_HOURS) reasons.push("observation_window_not_met");

  const ready = reasons.length === 0;
  const blocked = input.mode !== "shadow" || unsafe.length > 0 || !zeroCalls || !zeroSpend;
  return {
    version: 1,
    observed_at: input.now,
    mode: input.mode,
    state: ready ? "ready" : blocked ? "blocked" : "collecting",
    ready_for_enforcement_review: ready,
    reasons,
    thresholds: {
      required_distinct_tasks: PERSONA_SHADOW_REQUIRED_TASKS,
      required_template_categories: PERSONA_SHADOW_REQUIRED_CATEGORIES,
      required_window_hours: PERSONA_SHADOW_REQUIRED_WINDOW_HOURS,
    },
    traffic: {
      campaigns_total: campaigns.length,
      associated_campaigns: associated.length,
      eligible_tasks: eligible.length,
      persona_receipts: receiptCount,
      qualified_distinct_tasks: qualified.length,
      qualified_template_categories: categories,
      observation_window_hours: Math.round(observationWindowHours * 10) / 10,
    },
    safety: {
      zero_persona_calls: zeroCalls,
      zero_persona_spend: zeroSpend,
      unsafe_receipt_count: unsafe.length,
      unsafe_receipts: unsafe,
    },
    qualified_tasks: qualified,
  };
}

function qualificationDir(): string {
  return factoryStatePath("persona-shadow-qualification");
}

export function personaShadowQualificationLedgerPath(): string {
  return join(qualificationDir(), "observations.jsonl");
}

export function personaShadowQualificationStatusPath(): string {
  return join(qualificationDir(), "status.json");
}

function readAssignments(): Assignment[] {
  const dir = join(poolStateDir(), "assignments");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")) as Assignment);
}

export function readPersonaShadowQualificationLedger(path = personaShadowQualificationLedgerPath()): PersonaShadowQualificationObservation[] {
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line) as PersonaShadowQualificationObservation;
    } catch {
      throw new Error(`persona shadow qualification ledger line ${index + 1} is invalid JSON`);
    }
  });
  let previous: string | null = null;
  for (const [index, row] of rows.entries()) {
    if (row.version !== 1 || row.sequence !== index + 1 || row.previous_hash !== previous) {
      throw new Error(`persona shadow qualification ledger chain is invalid at sequence ${index + 1}`);
    }
    const expected = sha256(canonicalize({ ...row, observation_hash: "" }));
    if (row.observation_hash !== expected) {
      throw new Error(`persona shadow qualification ledger hash is invalid at sequence ${index + 1}`);
    }
    previous = row.observation_hash;
  }
  return rows;
}

export function readPersonaShadowQualificationStatus(
  statusPath = personaShadowQualificationStatusPath(),
  ledgerPath = personaShadowQualificationLedgerPath(),
): PersonaShadowQualificationObservation {
  if (!existsSync(statusPath)) throw new Error(`persona shadow qualification status is unavailable: ${statusPath}`);
  const status = JSON.parse(readFileSync(statusPath, "utf8")) as PersonaShadowQualificationObservation;
  const latest = readPersonaShadowQualificationLedger(ledgerPath).at(-1);
  if (!latest || status.observation_hash !== latest.observation_hash || canonicalize(status) !== canonicalize(latest)) {
    throw new Error("persona shadow qualification status does not match the verified ledger head");
  }
  return status;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export function persistPersonaShadowQualification(
  snapshot: PersonaShadowQualificationSnapshot,
  source: string,
  paths: { ledger?: string; status?: string } = {},
): PersonaShadowQualificationObservation {
  const ledgerPath = paths.ledger ?? personaShadowQualificationLedgerPath();
  const statusPath = paths.status ?? personaShadowQualificationStatusPath();
  const prior = readPersonaShadowQualificationLedger(ledgerPath);
  const draft: PersonaShadowQualificationObservation = {
    version: 1,
    sequence: prior.length + 1,
    source,
    previous_hash: prior.at(-1)?.observation_hash ?? null,
    snapshot,
    observation_hash: "",
  };
  draft.observation_hash = sha256(canonicalize(draft));
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(draft)}\n`, { encoding: "utf8", flush: true });
  writeJsonAtomic(statusPath, draft);
  return draft;
}

export function observePersonaShadowQualification(input: {
  source?: string;
  now?: string;
  mode?: PersonaOrchestrationMode;
  campaigns?: Record<string, Campaign>;
  queue?: WorkItem[];
  assignments?: Assignment[];
} = {}): PersonaShadowQualificationObservation {
  const source = input.source?.trim() || "factory-conveyor";
  const lockPath = join(qualificationDir(), ".observer.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
  let lock: number;
  try {
    lock = openSync(lockPath, "wx");
  } catch {
    throw new Error(`persona shadow qualification observer lock is held: ${lockPath}`);
  }
  try {
    const mode = input.mode ?? (process.env.FACTORY_PERSONA_ROUTING_MODE as PersonaOrchestrationMode | undefined) ?? "off";
    if (!(["off", "shadow", "enforce"] as string[]).includes(mode)) {
      throw new Error(`FACTORY_PERSONA_ROUTING_MODE must be off|shadow|enforce, got ${mode}`);
    }
    const snapshot = assessPersonaShadowQualification({
      mode,
      campaigns: input.campaigns ?? loadCampaigns(),
      queue: input.queue ?? loadQueue(),
      assignments: input.assignments ?? readAssignments(),
      now: input.now ?? new Date().toISOString(),
    });
    return persistPersonaShadowQualification(snapshot, source);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

function usage(): never {
  console.error("Usage: bun persona-shadow-qualification.ts observe [--source NAME] [--json] | status [--json]");
  process.exit(2);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "observe") {
      const observation = observePersonaShadowQualification({ source: valueAfter(args, "--source") });
      console.log(args.includes("--json") ? JSON.stringify(observation) : `${observation.snapshot.state}: ${observation.snapshot.reasons.join(",") || "thresholds_met"}`);
    } else if (command === "status") {
      const status = readPersonaShadowQualificationStatus();
      console.log(args.includes("--json") ? JSON.stringify(status) : `${status.snapshot.state}: ${status.snapshot.reasons.join(",") || "thresholds_met"}`);
    } else usage();
  } catch (error) {
    console.error(`persona-shadow-qualification: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
