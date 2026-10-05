#!/usr/bin/env bun
/**
 * FH-03 / ZOU-597 — post-merge reconciliation entrypoint (shadow by default).
 *
 * Given a MERGED identifier (the merge is the input event, per AC#4), bring the
 * factory-external world into its terminal state exactly once:
 *   - move the Linear twin to Done,
 *   - strip the factory-ready label,
 *   - post a single deduplicated merge comment,
 *   - record execution-merged / progress / next-promotion audit events.
 *
 * Idempotency (AC#4) comes from `reconcile-core`: every action is gated on the
 * currently-observed world, so 3 replays produce one identical terminal state and
 * no duplicate Linear mutation or comment. Observation is sourced from the live
 * Linear issue (state, labels, comment marker) and the flight journal (which audit
 * events have already fired).
 *
 * Safety posture:
 *   - SHADOW by default: compute the plan, print single-line JSON, record a flight
 *     event — mutate NOTHING. Enforce only when SF_POST_MERGE_RECONCILE=enforce.
 *   - The merge itself is never performed here; merge stays human-gated. This tool
 *     runs strictly AFTER a human-approved merge.
 *   - Linear failures are fail-soft: an unreadable twin defers move-to-Done rather
 *     than acting blindly.
 *
 * Usage:
 *   bun post-merge-reconcile.ts --identifier ZOU-597 [--next ZOU-600] [--pr 312]
 *   SF_POST_MERGE_RECONCILE=enforce bun post-merge-reconcile.ts --identifier ZOU-597
 *   bun post-merge-reconcile.ts --selftest
 */

import { parseArgs } from "node:util";
import { readFlightEvents, recordFlight } from "./flight-recorder";
import {
  applyReconciliation,
  DONE_STATE_TYPE,
  planReconciliation,
  type ReconcileEffects,
  type ReconcileObserved,
} from "./reconcile-core";
import type { ExecutionState } from "./execution-lifecycle";

const API = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
const FACTORY_READY_LABEL = "f4a73851-6c6b-4a19-b397-c2bd62eeb694";
const RECONCILE_COMMENT_MARKER = "[factory-reconcile]";

function log(msg: string): void {
  process.stderr.write(`[reconcile] ${msg}\n`);
}

function isEnforce(): boolean {
  return process.env.SF_POST_MERGE_RECONCILE === "enforce";
}

// ─── Linear (fail-soft: null on any error) ───────────────────────────────────

interface LinearIssueView {
  id: string;
  identifier: string;
  state_type: string;
  label_ids: string[];
  done_state_id: string | null;
  comment_marker_present: boolean;
}

async function linearGql<T = any>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) {
      log(`WARN Linear HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as any;
    if (j.errors?.length) {
      log(`WARN Linear GQL error: ${JSON.stringify(j.errors).slice(0, 200)}`);
      return null;
    }
    return j.data as T;
  } catch (err) {
    log(`WARN Linear fetch threw: ${String(err).slice(0, 200)}`);
    return null;
  }
}

const ISSUE_QUERY = `
  query ReconcileIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      state { id name type }
      labels { nodes { id } }
      team { states { nodes { id name type } } }
      comments { nodes { body } }
    }
  }`;

async function fetchIssue(identifier: string): Promise<LinearIssueView | null> {
  const data = await linearGql<{ issue: any }>(ISSUE_QUERY, { id: identifier });
  const issue = data?.issue;
  if (!issue) return null;
  const doneState = (issue.team?.states?.nodes ?? []).find((s: any) => s.type === DONE_STATE_TYPE);
  const comments: string[] = (issue.comments?.nodes ?? []).map((c: any) => String(c.body ?? ""));
  return {
    id: issue.id,
    identifier: issue.identifier,
    state_type: issue.state?.type ?? "unknown",
    label_ids: (issue.labels?.nodes ?? []).map((l: any) => l.id),
    done_state_id: doneState?.id ?? null,
    comment_marker_present: comments.some((b) => b.includes(RECONCILE_COMMENT_MARKER)),
  };
}

// ─── Observation ─────────────────────────────────────────────────────────────

function flightHas(identifier: string, kind: string): boolean {
  return readFlightEvents({ days: 14 }).some((e) => e.identifier === identifier && e.kind === kind);
}

function observe(
  identifier: string,
  issue: LinearIssueView | null,
  execState: ExecutionState,
  nextReady: string | null,
  nextIssue: LinearIssueView | null,
): ReconcileObserved {
  return {
    identifier,
    issue_id: issue?.id ?? "",
    linear_state_type: issue?.state_type ?? null,
    has_factory_ready_label: issue?.label_ids.includes(FACTORY_READY_LABEL) ?? false,
    // Flight-journal audit events make the exec-side actions idempotent across replays
    // without mutating the exec record (the record is not the merge source of truth).
    execution_state: flightHas(identifier, "reconcile.execution-merged") ? "merged" : execState,
    progress_recorded: flightHas(identifier, "reconcile.progress"),
    merge_comment_present: issue?.comment_marker_present ?? false,
    next_ready_identifier: nextReady,
    next_ready_already_pulled: nextReady
      ? (nextIssue?.label_ids.includes(FACTORY_READY_LABEL) ?? false) || flightHas(nextReady, "reconcile.promote-next")
      : false,
  };
}

// ─── Effects ─────────────────────────────────────────────────────────────────

/** Shadow effects: record intent only, mutate nothing. */
function shadowEffects(execId: string): ReconcileEffects {
  const note = (kind: string, o: ReconcileObserved) =>
    recordFlight({ execution_id: execId, identifier: o.identifier, kind: `reconcile.shadow.${kind}`, detail: "shadow (no mutation)" });
  return {
    async moveLinearDone(o) {
      note("move-linear-done", o);
    },
    async stripFactoryReadyLabel(o) {
      note("strip-label", o);
    },
    async markExecutionMerged(o) {
      note("execution-merged", o);
    },
    async recordProgress(o) {
      note("progress", o);
    },
    async postMergeComment(o) {
      note("comment", o);
    },
    async promoteNextTicket(o) {
      note("promote-next", o);
    },
  };
}

async function requireMutationSuccess<T>(
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  select: (data: T) => boolean,
): Promise<void> {
  const data = await linearGql<T>(query, variables);
  if (!data || !select(data)) {
    throw new Error(`${operation} failed: Linear did not acknowledge success`);
  }
}

/** Enforce effects: real Linear mutations for the four external actions; the rest
 * are durable flight-journal audit records that also drive replay idempotency. */
function enforceEffects(
  execId: string,
  issue: LinearIssueView,
  prNumber: string | null,
  nextIssue: LinearIssueView | null,
): ReconcileEffects {
  const doneStateId = issue.done_state_id;
  return {
    async moveLinearDone(o) {
      if (!doneStateId) {
        log(`WARN cannot resolve Done state for ${o.identifier} — skipping move`);
        return;
      }
      await requireMutationSuccess<{ issueUpdate: { success: boolean } }>(
        `move ${o.identifier} to Done`,
        `mutation($id:String!,$s:String!){ issueUpdate(id:$id,input:{stateId:$s}){ success } }`,
        { id: issue.id, s: doneStateId },
        (data) => data.issueUpdate.success,
      );
      recordFlight({ execution_id: execId, identifier: o.identifier, kind: "reconcile.move-linear-done", detail: "→ Done" });
    },
    async stripFactoryReadyLabel(o) {
      const kept = issue.label_ids.filter((id) => id !== FACTORY_READY_LABEL);
      await requireMutationSuccess<{ issueUpdate: { success: boolean } }>(
        `strip factory-ready from ${o.identifier}`,
        `mutation($id:String!,$l:[String!]!){ issueUpdate(id:$id,input:{labelIds:$l}){ success } }`,
        { id: issue.id, l: kept },
        (data) => data.issueUpdate.success,
      );
      recordFlight({ execution_id: execId, identifier: o.identifier, kind: "reconcile.strip-label", detail: "factory-ready stripped" });
    },
    async markExecutionMerged(o) {
      recordFlight({ execution_id: execId, identifier: o.identifier, kind: "reconcile.execution-merged", detail: prNumber ? `pr#${prNumber}` : "merged" });
    },
    async recordProgress(o) {
      recordFlight({ execution_id: execId, identifier: o.identifier, kind: "reconcile.progress", detail: "progress reconciled" });
    },
    async postMergeComment(o) {
      const body = `${RECONCILE_COMMENT_MARKER} merged and reconciled by the factory${prNumber ? ` (PR #${prNumber})` : ""}.`;
      await requireMutationSuccess<{ commentCreate: { success: boolean } }>(
        `post merge comment on ${o.identifier}`,
        `mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }`,
        { input: { issueId: issue.id, body } },
        (data) => data.commentCreate.success,
      );
      recordFlight({ execution_id: execId, identifier: o.identifier, kind: "reconcile.comment", detail: "merge comment posted" });
    },
    async promoteNextTicket(o) {
      if (!nextIssue || nextIssue.identifier !== o.next_ready_identifier) {
        throw new Error(`cannot promote ${o.next_ready_identifier ?? "unknown"}: Linear issue not found`);
      }
      if (!["backlog", "unstarted"].includes(nextIssue.state_type)) {
        throw new Error(`cannot promote ${nextIssue.identifier}: state type is ${nextIssue.state_type}`);
      }
      const labelIds = [...new Set([...nextIssue.label_ids, FACTORY_READY_LABEL])];
      await requireMutationSuccess<{ issueUpdate: { success: boolean } }>(
        `label ${nextIssue.identifier} factory-ready`,
        `mutation($id:String!,$l:[String!]!){ issueUpdate(id:$id,input:{labelIds:$l}){ success } }`,
        { id: nextIssue.id, l: labelIds },
        (data) => data.issueUpdate.success,
      );
      recordFlight({
        execution_id: execId,
        identifier: nextIssue.identifier,
        kind: "reconcile.promote-next",
        detail: `factory-ready after ${o.identifier}`,
      });
    },
  };
}

// ─── Selftest: 3-replay idempotency against a mutable fake world ──────────────

async function selftest(): Promise<number> {
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean) => {
    if (cond) {
      pass++;
      log(`PASS ${name}`);
    } else {
      fail++;
      log(`FAIL ${name}`);
    }
  };

  const world: ReconcileObserved = {
    identifier: "ZOU-TEST",
    issue_id: "issue-test",
    linear_state_type: "started",
    has_factory_ready_label: true,
    execution_state: "ci_green",
    progress_recorded: false,
    merge_comment_present: false,
    next_ready_identifier: "ZOU-NEXT",
    next_ready_already_pulled: false,
  };
  const calls: Record<string, number> = {};
  const bump = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const effects: ReconcileEffects = {
    async moveLinearDone() {
      bump("move");
      world.linear_state_type = DONE_STATE_TYPE;
    },
    async stripFactoryReadyLabel() {
      bump("strip");
      world.has_factory_ready_label = false;
    },
    async markExecutionMerged() {
      bump("merged");
      world.execution_state = "merged";
    },
    async recordProgress() {
      bump("progress");
      world.progress_recorded = true;
    },
    async postMergeComment() {
      bump("comment");
      world.merge_comment_present = true;
    },
    async promoteNextTicket() {
      bump("promote");
      world.next_ready_already_pulled = true;
    },
  };

  const r1 = await applyReconciliation(world, effects);
  const r2 = await applyReconciliation(world, effects);
  const r3 = await applyReconciliation(world, effects);

  check("first pass applies all six actions", r1.applied.length === 6);
  check("second replay is a no-op", r2.applied.length === 0);
  check("third replay is a no-op", r3.applied.length === 0);
  check("no duplicate Linear/comment/label effects", Object.values(calls).every((n) => n === 1));
  check("one identical terminal fingerprint across replays", new Set([r1.terminal_fingerprint, r2.terminal_fingerprint, r3.terminal_fingerprint]).size === 1);
  check("world reached Done", world.linear_state_type === DONE_STATE_TYPE);
  check("factory-ready label stripped", world.has_factory_ready_label === false);

  log(`selftest: ${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      identifier: { type: "string" },
      next: { type: "string" },
      pr: { type: "string" },
      selftest: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.selftest) {
    process.exit(await selftest());
  }

  const identifier = values.identifier as string | undefined;
  if (!identifier) {
    log("FATAL --identifier <ZOU-###> is required (the merged ticket to reconcile)");
    process.exit(2);
  }
  const nextReady = (values.next as string | undefined) ?? null;
  const prNumber = (values.pr as string | undefined) ?? null;
  const execId = `reconcile-${identifier}`;

  const [issue, nextIssue] = await Promise.all([
    fetchIssue(identifier),
    nextReady ? fetchIssue(nextReady) : Promise.resolve(null),
  ]);
  const observed = observe(identifier, issue, "ci_green", nextReady, nextIssue);
  const plan = planReconciliation(observed);
  const enforce = isEnforce();

  if (enforce && !issue) {
    throw new Error(`cannot reconcile ${identifier}: Linear issue not found`);
  }
  const effects = enforce && issue ? enforceEffects(execId, issue, prNumber, nextIssue) : shadowEffects(execId);
  const result = await applyReconciliation(observed, effects);

  const summary = {
    ok: true,
    mode: enforce ? "enforce" : "shadow",
    identifier,
    linear_ok: issue !== null,
    pending: plan.pending,
    applied: result.applied,
    skipped: result.skipped,
    terminal_fingerprint: result.terminal_fingerprint,
  };
  recordFlight({
    execution_id: execId,
    identifier,
    kind: enforce ? "reconcile.enforced" : "reconcile.shadow",
    detail: `applied=${result.applied.length} pending=${plan.pending.length}`,
    data: { mode: summary.mode, applied: result.applied },
  });
  log(`mode=${summary.mode} linear_ok=${summary.linear_ok} applied=[${result.applied.join(",")}] pending=[${plan.pending.join(",")}]`);
  process.stdout.write(JSON.stringify(summary) + "\n");
}

if (import.meta.main) await main();
