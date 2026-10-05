#!/usr/bin/env bun

import { readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { recordFlight } from "./flight-recorder";
import { inflightCap } from "./inflight-cap";
import { collectDeliveryEvidence, deliveredCanonicals } from "./delivery-evidence";

const API = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
const PULLABLE_STATES = new Set(["backlog", "unstarted"]);
const CLOSED_STATES = new Set(["completed", "canceled"]);
const TWIN_MARKER = "Promotion mode: serial Intake twin";
const COMMENT_MARKER = "factory-serial-promotion";

export interface SerialPromotionTicket {
  identifier: string;
  stable_key: string;
  prerequisites: string[];
}

export interface SerialPromotionConfig {
  version: 1;
  project_id: string;
  project_name: string;
  intake_project_id: string;
  factory_ready_label_id: string;
  tickets: SerialPromotionTicket[];
  /**
   * A shipped lane whose canonicals may since have been archived. Retired
   * configs are kept for the historical record but never tick, so a finished
   * project cannot fail the run with `canonical issue missing`.
   */
  retired: boolean;
}

export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  state_type: string;
  project_id: string | null;
  label_ids: string[];
  comment_bodies: string[];
  team_id: string;
  backlog_state_id: string | null;
  done_state_id: string | null;
  /** ISO timestamp of Linear archival; null while the issue is live. */
  archived_at: string | null;
}

export interface CanonicalCompletion {
  canonical_identifier: string;
  canonical_issue_id: string;
  twin_identifier: string;
}

export interface PromotionAction {
  mode: "create" | "label_existing";
  canonical_identifier: string;
  stable_key: string;
  existing_twin_id: string | null;
  existing_twin_identifier: string | null;
}

export interface SerialPromotionPlan {
  canonical_completions: CanonicalCompletion[];
  promotion: PromotionAction | null;
  reason: string;
}

export interface LaneTickOutcome {
  config_path: string;
  project: string;
  retired: boolean;
  report: TickReport | null;
  error: string | null;
}

export interface TickAllReport {
  ok: boolean;
  mode: "shadow" | "enforce";
  configs_found: number;
  reachable_lanes: number;
  all_retired: boolean;
  lanes: LaneTickOutcome[];
  reason: string;
}

export interface TickReport {
  ok: true;
  mode: "shadow" | "enforce";
  project: string;
  canonical_completions: string[];
  promotion: {
    mode: "create" | "label_existing";
    canonical_identifier: string;
    twin_identifier: string;
  } | null;
  reason: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

export function validateSerialPromotionConfig(value: unknown): SerialPromotionConfig {
  if (!value || typeof value !== "object") throw new Error("config must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error("config.version must be 1");
  if (raw.retired !== undefined && typeof raw.retired !== "boolean") {
    throw new Error("config.retired must be a boolean when present");
  }
  const ticketsRaw = raw.tickets;
  if (!Array.isArray(ticketsRaw) || ticketsRaw.length === 0) {
    throw new Error("config.tickets must be a non-empty array");
  }

  const seenIdentifiers = new Set<string>();
  const seenStableKeys = new Set<string>();
  const tickets = ticketsRaw.map((entry, index): SerialPromotionTicket => {
    if (!entry || typeof entry !== "object") throw new Error(`tickets[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    const identifier = requireString(row.identifier, `tickets[${index}].identifier`);
    const stableKey = requireString(row.stable_key, `tickets[${index}].stable_key`);
    if (!Array.isArray(row.prerequisites) || row.prerequisites.some((item) => typeof item !== "string")) {
      throw new Error(`tickets[${index}].prerequisites must be a string array`);
    }
    if (seenIdentifiers.has(identifier)) throw new Error(`duplicate ticket identifier: ${identifier}`);
    if (seenStableKeys.has(stableKey)) throw new Error(`duplicate stable key: ${stableKey}`);
    for (const prerequisite of row.prerequisites as string[]) {
      if (!seenIdentifiers.has(prerequisite)) {
        throw new Error(`${identifier} prerequisite ${prerequisite} must appear earlier in config order`);
      }
    }
    seenIdentifiers.add(identifier);
    seenStableKeys.add(stableKey);
    return { identifier, stable_key: stableKey, prerequisites: [...(row.prerequisites as string[])] };
  });

  return {
    version: 1,
    project_id: requireString(raw.project_id, "config.project_id"),
    project_name: requireString(raw.project_name, "config.project_name"),
    intake_project_id: requireString(raw.intake_project_id, "config.intake_project_id"),
    factory_ready_label_id: requireString(raw.factory_ready_label_id, "config.factory_ready_label_id"),
    tickets,
    retired: raw.retired === true,
  };
}

/**
 * Every `*.json` lane in `dir`, sorted, as absolute paths.
 *
 * Lane enumeration lives here rather than in the conveyor instruction because
 * the instruction pinned a single `--config` path. When ZBRE-012 shipped and
 * that lane was retired, step 0b became a permanent no-op: a retired config
 * returns `ok:true`, so the conveyor saw a healthy promotion step every cycle
 * while the live OpenFlight lane — which it had never been told about — was
 * unreachable. Two canonicals sat in Backlog behind delivered twins.
 */
export function discoverSerialConfigs(dir: string): string[] {
  if (!isAbsolute(dir)) throw new Error(`config directory must be absolute: ${dir}`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new Error(`could not read serial promotion config directory ${dir}: ${String(error)}`);
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

export function loadSerialPromotionConfig(path: string): SerialPromotionConfig {
  if (!isAbsolute(path)) throw new Error(`config path must be absolute: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read serial promotion config ${path}: ${String(error)}`);
  }
  return validateSerialPromotionConfig(value);
}

export function canonicalIdentifierFromTwin(description: string): string | null {
  if (!description.includes(TWIN_MARKER)) return null;
  const match = description.match(/^Canonical issue:\s*(ZOU-\d+)\s*$/m);
  return match?.[1] ?? null;
}

function completedTwinByCanonical(
  config: SerialPromotionConfig,
  intakeIssues: LinearIssueSnapshot[],
): Map<string, LinearIssueSnapshot> {
  const allowed = new Set(config.tickets.map((ticket) => ticket.identifier));
  const completed = new Map<string, LinearIssueSnapshot>();
  for (const issue of intakeIssues) {
    if (issue.state_type !== "completed") continue;
    const canonical = canonicalIdentifierFromTwin(issue.description);
    if (canonical && allowed.has(canonical)) completed.set(canonical, issue);
  }
  return completed;
}

function activeProjectTwins(
  config: SerialPromotionConfig,
  intakeIssues: LinearIssueSnapshot[],
): Array<{ issue: LinearIssueSnapshot; canonical: string }> {
  const allowed = new Set(config.tickets.map((ticket) => ticket.identifier));
  const active: Array<{ issue: LinearIssueSnapshot; canonical: string }> = [];
  for (const issue of intakeIssues) {
    // An archived twin is out of the lane whatever state it was archived in;
    // counting one as active would stall the project forever (FH-23).
    if (issue.archived_at) continue;
    if (CLOSED_STATES.has(issue.state_type)) continue;
    const canonical = canonicalIdentifierFromTwin(issue.description);
    if (canonical && allowed.has(canonical)) active.push({ issue, canonical });
  }
  return active;
}

/**
 * FH-11 — Linear state is not the only proof a stable key was delivered.
 *
 * ZBRE-008 shipped through merged PR #393 under twin ZOU-913, but the canonical
 * ticket had not yet been flipped to Done, so the completion test below read it
 * as incomplete and the promoter minted ZOU-921 for the same stable key. The
 * duplicate had no legitimate diff.
 *
 * Callers pass delivery evidence derived from the FH-05 lifecycle projection
 * (see `delivery-evidence.ts`). A canonical identifier proven merged is treated
 * as complete regardless of Linear, which closes the window between "the work
 * landed" and "someone recorded that the work landed".
 *
 * Omitting the argument preserves the previous behaviour exactly, so existing
 * callers and tests are unaffected.
 */
export function planSerialPromotion(
  config: SerialPromotionConfig,
  canonicalIssues: LinearIssueSnapshot[],
  intakeIssues: LinearIssueSnapshot[],
  deliveryEvidence?: ReadonlyMap<string, { twin_identifier: string; execution_id: string; state: string }>,
): SerialPromotionPlan {
  const canonicalByIdentifier = new Map(canonicalIssues.map((issue) => [issue.identifier, issue]));
  for (const ticket of config.tickets) {
    const issue = canonicalByIdentifier.get(ticket.identifier);
    if (!issue) throw new Error(`canonical issue missing from Linear project: ${ticket.identifier}`);
    if (issue.project_id !== config.project_id) {
      throw new Error(`${ticket.identifier} belongs to unexpected project ${issue.project_id ?? "none"}`);
    }
  }

  const completedTwins = completedTwinByCanonical(config, intakeIssues);
  const effectiveCompleted = new Set<string>();
  const canonicalCompletions: CanonicalCompletion[] = [];
  for (const ticket of config.tickets) {
    const canonical = canonicalByIdentifier.get(ticket.identifier)!;
    const completedTwin = completedTwins.get(ticket.identifier);
    const delivered = deliveryEvidence?.get(ticket.identifier) ?? null;
    if (canonical.state_type === "completed" || canonical.archived_at || completedTwin || delivered) {
      effectiveCompleted.add(ticket.identifier);
    }
    // An archived canonical is retired from the lane: skip it rather than
    // stalling the project, and never write state back to an archived issue.
    if (canonical.archived_at) continue;
    if (canonical.state_type !== "completed" && (completedTwin || delivered)) {
      // Merge evidence reconciles the canonical ticket just as a completed twin
      // does — otherwise the promoter would skip the ticket forever without
      // ever recording why.
      canonicalCompletions.push({
        canonical_identifier: ticket.identifier,
        canonical_issue_id: canonical.id,
        twin_identifier: completedTwin?.identifier ?? delivered!.twin_identifier,
      });
    }
  }

  const activeTwins = activeProjectTwins(config, intakeIssues);
  if (activeTwins.length > 1) {
    throw new Error(`multiple active serial twins: ${activeTwins.map((entry) => entry.issue.identifier).join(", ")}`);
  }

  const readyQueue = intakeIssues.filter(
    (issue) =>
      !issue.archived_at &&
      PULLABLE_STATES.has(issue.state_type) &&
      issue.label_ids.includes(config.factory_ready_label_id),
  );
  const active = activeTwins[0];
  if (active) {
    const ticket = config.tickets.find((entry) => entry.identifier === active.canonical)!;
    if (
      PULLABLE_STATES.has(active.issue.state_type) &&
      !active.issue.label_ids.includes(config.factory_ready_label_id) &&
      readyQueue.length < inflightCap()
    ) {
      return {
        canonical_completions: canonicalCompletions,
        promotion: {
          mode: "label_existing",
          canonical_identifier: active.canonical,
          stable_key: ticket.stable_key,
          existing_twin_id: active.issue.id,
          existing_twin_identifier: active.issue.identifier,
        },
        reason: `existing twin ${active.issue.identifier} is dependency-ready and unlabeled`,
      };
    }
    return {
      canonical_completions: canonicalCompletions,
      promotion: null,
      reason: `active serial twin ${active.issue.identifier} already owns the project lane`,
    };
  }

  if (readyQueue.length >= inflightCap()) {
    return {
      canonical_completions: canonicalCompletions,
      promotion: null,
      reason: `factory-ready queue at in-flight cap (${inflightCap()}): ${readyQueue.map((issue) => issue.identifier).join(", ")}`,
    };
  }

  const candidate = config.tickets.find(
    (ticket) =>
      !effectiveCompleted.has(ticket.identifier) &&
      ticket.prerequisites.every((prerequisite) => effectiveCompleted.has(prerequisite)),
  );
  if (!candidate) {
    const allComplete = config.tickets.every((ticket) => effectiveCompleted.has(ticket.identifier));
    return {
      canonical_completions: canonicalCompletions,
      promotion: null,
      reason: allComplete ? "serial project complete" : "no dependency-ready canonical issue",
    };
  }

  return {
    canonical_completions: canonicalCompletions,
    promotion: {
      mode: "create",
      canonical_identifier: candidate.identifier,
      stable_key: candidate.stable_key,
      existing_twin_id: null,
      existing_twin_identifier: null,
    },
    reason: `${candidate.identifier} is the first dependency-ready issue in configured order`,
  };
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");
  const response = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as { data?: T; errors?: unknown[] } | null;
  if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
  if (body?.errors?.length) throw new Error(`Linear GraphQL: ${JSON.stringify(body.errors).slice(0, 500)}`);
  if (!body?.data) throw new Error("Linear GraphQL returned no data");
  return body.data;
}

function toSnapshot(node: any): LinearIssueSnapshot {
  const states = node.team?.states?.nodes ?? [];
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title ?? "",
    description: node.description ?? "",
    priority: typeof node.priority === "number" ? node.priority : 0,
    state_type: node.state?.type ?? "unknown",
    project_id: node.project?.id ?? null,
    label_ids: (node.labels?.nodes ?? []).map((label: any) => String(label.id)),
    comment_bodies: (node.comments?.nodes ?? []).map((comment: any) => String(comment.body ?? "")),
    team_id: node.team?.id ?? "",
    backlog_state_id: states.find((state: any) => state.type === "backlog")?.id ?? null,
    done_state_id: states.find((state: any) => state.type === "completed")?.id ?? null,
    archived_at: typeof node.archivedAt === "string" ? node.archivedAt : null,
  };
}

/**
 * FH-23 — completion evidence must survive Linear archival.
 *
 * Linear excludes archived issues from `issues(...)` unless `includeArchived` is
 * set. Archiving a completed Intake twin therefore erased the only proof that
 * its canonical ticket had shipped, and the next tick minted a duplicate twin
 * for the same stable key — the ZOU-921 failure mode, reachable by ordinary
 * backlog hygiene rather than by any factory bug.
 *
 * Archived issues are now fetched, but they only ever contribute completion
 * evidence: `activeProjectTwins` and the ready queue both exclude them, so an
 * archived issue can never occupy the lane or be treated as pullable work.
 */
const ISSUES_QUERY = `
  query SerialPromotionIssues($projectId: ID!) {
    issues(first: 250, filter: { project: { id: { eq: $projectId } } }, includeArchived: true) {
      nodes {
        id identifier title description priority archivedAt
        state { id name type }
        project { id name }
        labels { nodes { id name } }
        comments { nodes { body } }
        team { id states { nodes { id name type } } }
      }
    }
  }
`;

async function fetchProjectIssues(projectId: string): Promise<LinearIssueSnapshot[]> {
  const data = await gql<{ issues: { nodes: any[] } }>(ISSUES_QUERY, { projectId });
  return (data.issues?.nodes ?? []).map(toSnapshot);
}

async function updateIssueState(issueId: string, stateId: string): Promise<void> {
  const data = await gql<{ issueUpdate: { success: boolean } }>(
    `mutation($id:String!,$stateId:String!){issueUpdate(id:$id,input:{stateId:$stateId}){success}}`,
    { id: issueId, stateId },
  );
  if (data.issueUpdate?.success !== true) throw new Error(`issueUpdate state failed for ${issueId}`);
}

async function updateIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
  const data = await gql<{ issueUpdate: { success: boolean } }>(
    `mutation($id:String!,$labelIds:[String!]!){issueUpdate(id:$id,input:{labelIds:$labelIds}){success}}`,
    { id: issueId, labelIds },
  );
  if (data.issueUpdate?.success !== true) throw new Error(`issueUpdate labels failed for ${issueId}`);
}

async function createComment(issueId: string, body: string): Promise<void> {
  const data = await gql<{ commentCreate: { success: boolean } }>(
    `mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}`,
    { input: { issueId, body } },
  );
  if (data.commentCreate?.success !== true) throw new Error(`commentCreate failed for ${issueId}`);
}

async function createTwin(
  config: SerialPromotionConfig,
  canonical: LinearIssueSnapshot,
  stableKey: string,
): Promise<{ id: string; identifier: string }> {
  if (!canonical.team_id) throw new Error(`${canonical.identifier} has no team id`);
  if (!canonical.backlog_state_id) throw new Error(`${canonical.identifier} team has no backlog state`);
  const description = [
    `Canonical issue: ${canonical.identifier}`,
    `Canonical project: ${config.project_name}`,
    `Stable key: ${stableKey}`,
    "Promotion status: automatically promoted after dependencies completed",
    "",
    TWIN_MARKER,
    "",
    canonical.description,
  ].join("\n");
  const data = await gql<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string } };
  }>(
    `mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier}}}`,
    {
      input: {
        teamId: canonical.team_id,
        projectId: config.intake_project_id,
        stateId: canonical.backlog_state_id,
        labelIds: [config.factory_ready_label_id],
        priority: canonical.priority,
        title: `[Factory Intake][${stableKey}] ${canonical.title.replace(/^\[[^\]]+\]\s*/, "")}`,
        description,
      },
    },
  );
  if (data.issueCreate?.success !== true || !data.issueCreate.issue) {
    throw new Error(`issueCreate failed for ${canonical.identifier}`);
  }
  return data.issueCreate.issue;
}

function hasComment(issue: LinearIssueSnapshot, marker: string): boolean {
  return issue.comment_bodies.some((body) => body.includes(marker));
}

function enforceMode(): boolean {
  return process.env.FACTORY_SERIAL_PROMOTION === "enforce";
}

export async function tickSerialPromotion(config: SerialPromotionConfig): Promise<TickReport> {
  if (config.retired) {
    return {
      ok: true,
      mode: enforceMode() ? "enforce" : "shadow",
      project: config.project_name,
      canonical_completions: [],
      promotion: null,
      reason: "serial promotion config is retired",
    };
  }
  const [canonicalIssues, intakeIssues] = await Promise.all([
    fetchProjectIssues(config.project_id),
    fetchProjectIssues(config.intake_project_id),
  ]);
  // FH-11 — consult merge evidence before deciding anything is incomplete.
  // A degraded projection yields an empty map, so the promoter falls back to
  // the previous Linear-only behaviour rather than promoting on bad data.
  const evidence = collectDeliveryEvidence();
  const delivered = deliveredCanonicals(
    evidence,
    intakeIssues,
    (twin) => canonicalIdentifierFromTwin(
      intakeIssues.find((issue) => issue.identifier === twin)?.description ?? "",
    ),
  );
  if (!evidence.ok) {
    recordFlight({
      execution_id: `serial-${config.project_name}`,
      identifier: config.project_name,
      kind: "serial-promotion.evidence-degraded",
      detail: evidence.degraded_reason ?? "delivery evidence unavailable",
    });
  }
  const plan = planSerialPromotion(config, canonicalIssues, intakeIssues, delivered);
  const mode = enforceMode() ? "enforce" : "shadow";
  if (mode === "shadow") {
    return {
      ok: true,
      mode,
      project: config.project_name,
      canonical_completions: plan.canonical_completions.map((entry) => entry.canonical_identifier),
      promotion: plan.promotion
        ? {
            mode: plan.promotion.mode,
            canonical_identifier: plan.promotion.canonical_identifier,
            twin_identifier: plan.promotion.existing_twin_identifier ?? "would-create",
          }
        : null,
      reason: plan.reason,
    };
  }

  const canonicalByIdentifier = new Map(canonicalIssues.map((issue) => [issue.identifier, issue]));
  for (const completion of plan.canonical_completions) {
    const canonical = canonicalByIdentifier.get(completion.canonical_identifier)!;
    if (!canonical.done_state_id) throw new Error(`${canonical.identifier} team has no Done state`);
    await updateIssueState(canonical.id, canonical.done_state_id);
    const marker = `<!-- ${COMMENT_MARKER}:complete:${completion.twin_identifier} -->`;
    if (!hasComment(canonical, marker)) {
      await createComment(
        canonical.id,
        `${marker}\nCompleted by factory Intake twin ${completion.twin_identifier}.`,
      );
    }
    recordFlight({
      execution_id: `serial-${completion.twin_identifier}`,
      identifier: completion.canonical_identifier,
      kind: "serial-promotion.canonical-complete",
      detail: `completed by ${completion.twin_identifier}`,
    });
  }

  let promoted: TickReport["promotion"] = null;
  if (plan.promotion) {
    const canonical = canonicalByIdentifier.get(plan.promotion.canonical_identifier)!;
    let twin: { id: string; identifier: string };
    if (plan.promotion.mode === "create") {
      twin = await createTwin(config, canonical, plan.promotion.stable_key);
    } else {
      const existing = intakeIssues.find((issue) => issue.id === plan.promotion!.existing_twin_id);
      if (!existing) throw new Error(`existing twin disappeared: ${plan.promotion.existing_twin_id}`);
      await updateIssueLabels(
        existing.id,
        [...new Set([...existing.label_ids, config.factory_ready_label_id])],
      );
      twin = { id: existing.id, identifier: existing.identifier };
    }

    const marker = `<!-- ${COMMENT_MARKER}:promote:${twin.identifier} -->`;
    if (!hasComment(canonical, marker)) {
      await createComment(
        canonical.id,
        `${marker}\nPromoted as Intake twin ${twin.identifier} with \`factory-ready\`.`,
      );
    }
    recordFlight({
      execution_id: `serial-${twin.identifier}`,
      identifier: twin.identifier,
      kind: "serial-promotion.promoted",
      detail: `${canonical.identifier} -> ${twin.identifier}`,
    });
    promoted = {
      mode: plan.promotion.mode,
      canonical_identifier: canonical.identifier,
      twin_identifier: twin.identifier,
    };
  }

  return {
    ok: true,
    mode,
    project: config.project_name,
    canonical_completions: plan.canonical_completions.map((entry) => entry.canonical_identifier),
    promotion: promoted,
    reason: plan.reason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tick every non-retired lane in `dir`.
 *
 * Lanes are ticked in path order and each one refetches Intake, so a promotion
 * by an earlier lane is already visible as an occupied factory-ready queue to
 * the next — the single-twin invariant holds across lanes without a shared
 * cursor.
 *
 * `ok:false` aborts the conveyor cycle, so it is reserved for states an
 * operator must fix: an unreadable directory, a lane that fails to load, or a
 * lane whose tick throws. "Every lane retired" is a legitimate idle factory,
 * not a fault — it stays `ok:true` but records a flight event each pass, so
 * the condition is visible in flight-status and telemetry instead of being
 * inferred from the absence of promotions.
 */
export async function tickAllSerialLanes(
  dir: string,
  tick: (config: SerialPromotionConfig) => Promise<TickReport> = tickSerialPromotion,
  record: (event: Parameters<typeof recordFlight>[0]) => unknown = recordFlight,
): Promise<TickAllReport> {
  const mode = enforceMode() ? "enforce" : "shadow";
  const paths = discoverSerialConfigs(dir);
  const lanes: LaneTickOutcome[] = [];
  let reachable = 0;

  for (const path of paths) {
    let config: SerialPromotionConfig;
    try {
      config = loadSerialPromotionConfig(path);
    } catch (error) {
      lanes.push({
        config_path: path,
        project: basename(path),
        retired: false,
        report: null,
        error: errorMessage(error),
      });
      continue;
    }
    if (config.retired) {
      lanes.push({
        config_path: path,
        project: config.project_name,
        retired: true,
        report: null,
        error: null,
      });
      continue;
    }
    reachable += 1;
    try {
      lanes.push({
        config_path: path,
        project: config.project_name,
        retired: false,
        report: await tick(config),
        error: null,
      });
    } catch (error) {
      lanes.push({
        config_path: path,
        project: config.project_name,
        retired: false,
        report: null,
        error: errorMessage(error),
      });
    }
  }

  const failed = lanes.filter((lane) => lane.error !== null);
  const allRetired = paths.length > 0 && reachable === 0;
  if (allRetired) {
    record({
      execution_id: "serial-lanes",
      identifier: "serial-lanes",
      kind: "serial-promotion.no-reachable-lane",
      detail: `${paths.length} configured, all retired`,
    });
  }

  let ok = true;
  let reason: string;
  if (paths.length === 0) {
    ok = false;
    reason = `no serial promotion configs found in ${dir}`;
  } else if (failed.length > 0) {
    ok = false;
    reason = `lane failure: ${failed.map((lane) => `${lane.project}: ${lane.error}`).join("; ")}`;
  } else if (allRetired) {
    reason = `all ${paths.length} configured lanes are retired`;
  } else {
    reason = `ticked ${reachable} of ${paths.length} lanes`;
  }

  return {
    ok,
    mode,
    configs_found: paths.length,
    reachable_lanes: reachable,
    all_retired: allRetired,
    lanes,
    reason,
  };
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "config-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  const configPath = values.config;
  const configDir = values["config-dir"];
  const usage =
    "usage: serial-intake-promoter.ts <validate|tick> --config <absolute-path>\n" +
    "       serial-intake-promoter.ts tick-all --config-dir <absolute-path>";
  if (
    values.help ||
    !["validate", "tick", "tick-all"].includes(command ?? "") ||
    (command === "tick-all" ? !configDir : !configPath)
  ) {
    console.error(usage);
    process.exit(values.help ? 0 : 2);
  }
  try {
    if (command === "tick-all") {
      const report = await tickAllSerialLanes(configDir!);
      console.log(JSON.stringify(report));
      if (!report.ok) process.exit(1);
    } else {
      const config = loadSerialPromotionConfig(configPath!);
      if (command === "validate") {
        console.log(JSON.stringify({ ok: true, project: config.project_name, tickets: config.tickets.length }));
      } else {
        console.log(JSON.stringify(await tickSerialPromotion(config)));
      }
    }
  } catch (error) {
    console.error(`serial-intake-promoter: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
