#!/usr/bin/env bun
/**
 * SF-009 T2 — Deterministic Linear digital twin (contract mock).
 *
 * Serves the THREE GraphQL shapes the factory actually sends (grounded against
 * live call sites, not the full Linear schema):
 *   issues-filter   linear-puller.ts FactoryReadyTickets($projectId,$labelId)
 *   issue-state     approval-ledger.ts:137 / dedup-gate.ts:395  issue(id){state{type}}
 *   issueUpdate     linear-puller.ts ReapFactoryReady($id,$labelIds){success}
 *   commentCreate   dedup-gate.ts:445 / ticket-contract.ts:176  commentCreate(input){success}
 *
 * Determinism contract: fixture is read-only; variable fields (comment ids)
 * come from a mulberry32 PRNG seeded by the scenario seed; mutation state
 * (comments) is per-run in-memory only. Same seed + same request sequence ⇒
 * byte-identical transcript ⇒ identical sha256. The contract is scoped to
 * SEQUENTIAL request sequences (the runner's blocking step loop guarantees
 * this per step); a step that fires concurrent requests owns its own ordering.
 * v1 not-found choice: issue_state returns data.issue=null (our one real
 * consumer, approval-ledger, treats null and a GraphQL error identically).
 *
 * Pure layer: handleGraphql(). startTwin() is the only I/O — an in-process
 * Bun.serve bound to 127.0.0.1:0 (ephemeral port, loopback only, no daemon).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// ─── Fixture ──────────────────────────────────────────────────────────────────

export interface TwinIssueState {
  id: string;
  name: string;
  type: string;
}

export interface TwinLabel {
  id: string;
  name: string;
}

export interface TwinIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  project_id: string;
  state: TwinIssueState;
  labels: TwinLabel[];
  team: { id: string; name: string; key: string };
}

export interface LinearTwinFixture {
  fixture_id: string;
  kind: "linear";
  issues: TwinIssue[];
}

/** Fail-loud fixture loader — a bad committed fixture must never half-serve. */
export function loadTwinFixture(path: string): LinearTwinFixture {
  if (!existsSync(path)) throw new Error(`twin fixture not found: ${path}`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`twin fixture is not valid JSON: ${path} (${String(err)})`);
  }
  const f = doc as Record<string, unknown> | null;
  if (!f || typeof f !== "object") throw new Error(`twin fixture is not a JSON object: ${path}`);
  if (f.kind !== "linear") throw new Error(`twin fixture kind must be "linear": ${String(f.kind)}`);
  if (typeof f.fixture_id !== "string" || f.fixture_id.trim() === "") {
    throw new Error(`twin fixture_id missing in ${path}`);
  }
  if (!Array.isArray(f.issues) || f.issues.length === 0) {
    throw new Error(`twin fixture issues must be a non-empty array in ${path}`);
  }
  for (const [i, raw] of (f.issues as unknown[]).entries()) {
    const iss = raw as Record<string, unknown> | null;
    const label = `issues[${i}]`;
    if (!iss || typeof iss !== "object") throw new Error(`${label} must be an object in ${path}`);
    for (const k of ["id", "identifier", "title", "description", "project_id"]) {
      if (typeof iss[k] !== "string" || (iss[k] as string).trim() === "") {
        throw new Error(`${label}.${k} must be a non-empty string in ${path}`);
      }
    }
    if (!Number.isInteger(iss.priority) || (iss.priority as number) < 0 || (iss.priority as number) > 4) {
      throw new Error(`${label}.priority must be an integer 0-4 in ${path}`);
    }
    const st = iss.state as Record<string, unknown> | null;
    if (!st || typeof st.id !== "string" || typeof st.name !== "string" || typeof st.type !== "string") {
      throw new Error(`${label}.state must have id/name/type strings in ${path}`);
    }
    if (!Array.isArray(iss.labels) || (iss.labels as unknown[]).some((l) => {
      const lb = l as Record<string, unknown> | null;
      return !lb || typeof lb.id !== "string" || typeof lb.name !== "string";
    })) {
      throw new Error(`${label}.labels must be an array of {id,name} in ${path}`);
    }
    const tm = iss.team as Record<string, unknown> | null;
    if (!tm || typeof tm.id !== "string" || typeof tm.name !== "string" || typeof tm.key !== "string") {
      throw new Error(`${label}.team must have id/name/key strings in ${path}`);
    }
  }
  const ids = new Set((f.issues as TwinIssue[]).map((i) => i.id));
  if (ids.size !== (f.issues as unknown[]).length) throw new Error(`twin fixture has duplicate issue ids in ${path}`);
  return f as unknown as LinearTwinFixture;
}

// ─── PRNG (mulberry32 — deterministic variable fields) ───────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Per-run state (in-memory only — isolation is the point) ─────────────────

export interface TwinComment {
  id: string;
  issue_id: string;
  body: string;
}

export interface TwinState {
  rng: () => number;
  comments: TwinComment[];
}

export function newTwinState(seed: number): TwinState {
  return { rng: mulberry32(seed), comments: [] };
}

// ─── Pure GraphQL handler ─────────────────────────────────────────────────────

export type TwinOp = "issues_filter" | "issue_state" | "issue_update" | "comment_create" | "unsupported";

export interface GraphqlBody {
  query?: unknown;
  variables?: Record<string, unknown>;
}

/** Contract detection, not a GraphQL parser — the twin serves known shapes only. */
export function classifyOp(query: string): TwinOp {
  if (/\bcommentCreate\s*\(/.test(query)) return "comment_create";
  if (/\bissueUpdate\s*\(/.test(query)) return "issue_update";
  if (/\bissues\s*\(/.test(query)) return "issues_filter";
  if (/\bissue\s*\(/.test(query)) return "issue_state";
  return "unsupported";
}

function gqlError(message: string): unknown {
  return { errors: [{ message: `twin: ${message}` }] };
}

export function handleGraphql(
  fixture: LinearTwinFixture,
  state: TwinState,
  seed: number,
  body: GraphqlBody | null,
): { op: TwinOp; response: unknown } {
  if (!body || typeof body.query !== "string" || body.query.trim() === "") {
    return { op: "unsupported", response: gqlError("request body must be {query, variables?}") };
  }
  const op = classifyOp(body.query);
  const vars = body.variables ?? {};

  if (op === "issues_filter") {
    const projectId = vars.projectId;
    const labelId = vars.labelId;
    if (typeof projectId !== "string" || typeof labelId !== "string") {
      return { op, response: gqlError("issues-filter requires string variables projectId and labelId") };
    }
    const nodes = fixture.issues
      .filter((i) => i.project_id === projectId && i.labels.some((l) => l.id === labelId))
      // structuredClone: responses must never alias fixture objects — a consumer
      // mutating a response would otherwise corrupt the read-only fixture.
      .map((i) => structuredClone({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        description: i.description,
        priority: i.priority,
        state: i.state,
        labels: { nodes: i.labels },
        team: i.team,
      }));
    return { op, response: { data: { issues: { nodes } } } };
  }

  if (op === "issue_state") {
    const id = vars.id;
    if (typeof id !== "string" || id.trim() === "") {
      return { op, response: gqlError("issue-state requires string variable id") };
    }
    const issue = fixture.issues.find((i) => i.id === id);
    if (!issue) return { op, response: { data: { issue: null } } };
    return { op, response: structuredClone({ data: { issue: { id: issue.id, state: issue.state } } }) };
  }

  if (op === "issue_update") {
    const id = vars.id;
    const labelIds = vars.labelIds;
    if (typeof id !== "string" || id.trim() === "") {
      return { op, response: gqlError("issueUpdate requires string variable id") };
    }
    if (!Array.isArray(labelIds) || labelIds.some((l) => typeof l !== "string")) {
      return { op, response: gqlError("issueUpdate requires input.labelIds as a string array") };
    }
    const issue = fixture.issues.find((i) => i.id === id);
    if (!issue) return { op, response: gqlError(`issueUpdate: unknown issue id ${id}`) };
    return { op, response: { data: { issueUpdate: { success: true } } } };
  }

  if (op === "comment_create") {
    const input = vars.input as Record<string, unknown> | undefined;
    const issueId = input?.issueId;
    const commentBody = input?.body;
    if (typeof issueId !== "string" || typeof commentBody !== "string") {
      return { op, response: gqlError("commentCreate requires input.issueId and input.body strings") };
    }
    // Contract fidelity: real Linear rejects empty comment bodies.
    if (commentBody.trim() === "") {
      return { op, response: gqlError("commentCreate: input.body must be non-empty") };
    }
    const issue = fixture.issues.find((i) => i.id === issueId);
    if (!issue) return { op, response: gqlError(`commentCreate: unknown issue id ${issueId}`) };
    // Variable field: PRNG-derived, seed-scoped ⇒ deterministic per (seed, sequence).
    const hex = Math.floor(state.rng() * 0x100000000).toString(16).padStart(8, "0");
    const comment: TwinComment = { id: `twin-${seed}-comment-${hex}`, issue_id: issueId, body: commentBody };
    state.comments.push(comment);
    return { op, response: { data: { commentCreate: { success: true, comment: { id: comment.id, body: comment.body } } } } };
  }

  return { op, response: gqlError("unsupported operation (v1 serves issues-filter, issue-state, issueUpdate, commentCreate)") };
}

// ─── Transcript (deterministic — no timestamps by design) ────────────────────

export interface TranscriptEntry {
  seq: number;
  op: TwinOp;
  variables: unknown;
  response: unknown;
}

export function transcriptSha256(entries: TranscriptEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

// ─── Server wrapper (loopback-only, ephemeral port, no daemon) ────────────────

export interface TwinTranscript {
  entries: TranscriptEntry[];
  sha256: string;
}

export interface TwinHandle {
  port: number;
  url: string;
  stop(): void;
  transcript(): TwinTranscript;
}

export function startTwin(fixture: LinearTwinFixture, seed: number): TwinHandle {
  const state = newTwinState(seed);
  const entries: TranscriptEntry[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (req.method !== "POST") {
        return Response.json(gqlError("POST only"), { status: 405 });
      }
      const body = (await req.json().catch(() => null)) as GraphqlBody | null;
      const { op, response } = handleGraphql(fixture, state, seed, body);
      // Clone at record time — a recorded entry must never change retroactively.
      entries.push(structuredClone({ seq: entries.length, op, variables: body?.variables ?? null, response }));
      return Response.json(response);
    },
  });
  const port = server.port;
  if (typeof port !== "number") {
    server.stop(true);
    throw new Error("Linear twin failed to bind an ephemeral port");
  }
  return {
    port,
    url: `http://127.0.0.1:${port}/graphql`,
    stop: () => server.stop(true),
    // Deep copy — callers can never mutate the recorded transcript through the return value.
    transcript: () => ({ entries: structuredClone(entries), sha256: transcriptSha256(entries) }),
  };
}
