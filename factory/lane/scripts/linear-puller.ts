#!/usr/bin/env bun
/**
 * T1 — Linear Puller
 *
 * Queries the Intake Linear project for tickets carrying the 'factory-ready' label,
 * then does two things every pull:
 *   1. REAP — strips the 'factory-ready' label from any labeled ticket that has left
 *      the pullable set (state.type ∉ {backlog, unstarted}); i.e. anything the factory
 *      has already started, moved to review, completed, or cancelled. This keeps the
 *      label meaning "ready and waiting" and stops a moved ticket (e.g. an In-Review
 *      one) from being re-pulled forever. Fail-soft: a reap failure warns on stderr
 *      but never aborts the pull.
 *   2. SELECT — returns ONLY the single highest-priority pullable ticket (Linear
 *      priority urgent-first; created_at ascending breaks ties). The conveyor pulls
 *      one top-priority item per cycle, not the whole ready queue.
 *
 * Fail-loud on the fetch itself; empty queue is valid.
 *
 * Usage:
 *   bun linear-puller.ts                      # Reap + pull, print JSON queue (≤1 ticket)
 *   bun linear-puller.ts --dry-run            # Print query without executing (no reap)
 *   bun linear-puller.ts --help
 */

import { parseArgs } from "node:util";
import { pullLimit } from "./inflight-cap";

// ─── Constants ───────────────────────────────────────────────────────────────

const API = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
export const INTAKE_PROJECT_ID = "b621d7a1-bb3d-4df9-ae11-3034789e204c";
export const FACTORY_READY_LABEL = "f4a73851-6c6b-4a19-b397-c2bd62eeb694";

/**
 * Linear workflow state types that count as "in the backlog, waiting to be pulled".
 * A factory-ready ticket in any OTHER type (started → In Progress/In Review,
 * completed → Done, canceled, triage, duplicate) is no longer pullable and gets
 * its label reaped.
 */
export const PULLABLE_STATE_TYPES: ReadonlySet<string> = new Set(["backlog", "unstarted"]);

export function isPullable(stateType: string | undefined): boolean {
  return PULLABLE_STATE_TYPES.has(stateType ?? "");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntakeTicket {
  linear_id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  /** Linear workflow state.type (backlog | unstarted | started | completed | canceled | …). */
  state_type: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  /** Linear priority: 1=Urgent … 4=Low, 0=None. Optional — absent on old queues. */
  priority?: number;
}

// ─── GraphQL helper ──────────────────────────────────────────────────────────

const READ_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TRANSIENT_ERROR_CODES = new Set([
  "ConnectionRefused",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);
const TRANSIENT_FETCH_MESSAGES = [
  /^fetch failed$/i,
  /^failed to fetch$/i,
  /^networkerror when attempting to fetch resource\.?$/i,
  /^unable to connect\. is the computer able to access the url\?$/i,
  /^the socket connection was closed unexpectedly\./i,
];

type LinearPullFailureKind = "missing_credentials" | "transport" | "http" | "invalid_json" | "graphql";

export class LinearPullError extends Error {
  constructor(
    message: string,
    readonly kind: LinearPullFailureKind,
    readonly exitCode: 1 | 2,
    readonly retryable: boolean,
    readonly details?: { status?: number; body?: string; errors?: unknown[] },
  ) {
    super(message);
    this.name = "LinearPullError";
  }
}

export interface ReadOnlyQueryDependencies {
  apiKey?: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
  onRetry?: (message: string) => void;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (direct) return direct;
  const cause = "cause" in error ? error.cause : undefined;
  return cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
}

function errorMessages(error: object): string[] {
  const messages: string[] = [];
  if ("message" in error && typeof error.message === "string") messages.push(error.message);
  const cause = "cause" in error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") messages.push(cause.message);
  return messages;
}

export function isTransientLinearTransportError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = errorCode(error);
  if (code) return TRANSIENT_ERROR_CODES.has(code);
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  return errorMessages(error).some((message) => TRANSIENT_FETCH_MESSAGES.some((pattern) => pattern.test(message)));
}

function retryDelay(retryAfter: string | null, now: () => number): number {
  if (!retryAfter) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), MAX_RETRY_DELAY_MS);
  }
  const date = Date.parse(retryAfter);
  if (Number.isNaN(date)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(Math.max(0, date - now()), MAX_RETRY_DELAY_MS);
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function signalFor(timeoutMs: number): AbortSignal | undefined {
  return timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
}

export async function executeReadOnlyGraphql<T = unknown>(
  query: string,
  vars?: Record<string, unknown>,
  dependencies: ReadOnlyQueryDependencies = {},
): Promise<T> {
  const key = dependencies.apiKey ?? process.env.LINEAR_API_KEY;
  if (!key) {
    throw new LinearPullError("LINEAR_API_KEY not set", "missing_credentials", 2, false);
  }

  const fetchFn = dependencies.fetchFn ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
  const now = dependencies.now ?? Date.now;
  const onRetry = dependencies.onRetry ?? ((message: string) => console.error(`[pull] WARN ${message}`));
  const timeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchFn(dependencies.apiUrl ?? API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: key },
        body: JSON.stringify({ query, variables: vars }),
        signal: signalFor(timeoutMs),
      });
    } catch (error) {
      const retryable = isTransientLinearTransportError(error);
      if (retryable && attempt < READ_ATTEMPTS) {
        onRetry(`Linear read transport failure; retrying once in ${DEFAULT_RETRY_DELAY_MS}ms`);
        await sleep(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw new LinearPullError(`Linear API transport failure: ${String(error)}`, "transport", 1, retryable);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      const retryable = isTransientLinearTransportError(error);
      if (retryable && attempt < READ_ATTEMPTS) {
        onRetry(`Linear read body transport failure; retrying once in ${DEFAULT_RETRY_DELAY_MS}ms`);
        await sleep(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw new LinearPullError(`Linear API response body failure: ${String(error)}`, "transport", 1, retryable);
    }

    if (!response.ok) {
      const retryable = isTransientStatus(response.status);
      if (retryable && attempt < READ_ATTEMPTS) {
        const delay = retryDelay(response.headers.get("retry-after"), now);
        onRetry(`Linear read HTTP ${response.status}; retrying once in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new LinearPullError(`Linear API returned ${response.status}: ${body}`, "http", 1, retryable, {
        status: response.status,
        body,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(body);
      if (!json || typeof json !== "object" || Array.isArray(json)) throw new SyntaxError("expected a GraphQL response object");
    } catch (error) {
      if (attempt < READ_ATTEMPTS) {
        onRetry(`Linear read returned malformed JSON; retrying once in ${DEFAULT_RETRY_DELAY_MS}ms`);
        await sleep(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw new LinearPullError(`Linear API returned malformed JSON: ${String(error)}`, "invalid_json", 1, true, { body });
    }

    const result = json as { data?: T; errors?: unknown[] };
    if (result.errors?.length) {
      throw new LinearPullError("Linear GraphQL application error", "graphql", 1, false, { errors: result.errors });
    }
    return result.data as T;
  }

  throw new LinearPullError("Linear read attempt ceiling reached", "transport", 1, true);
}

async function gql<T = unknown>(query: string, vars?: Record<string, unknown>): Promise<T> {
  try {
    return await executeReadOnlyGraphql<T>(query, vars);
  } catch (error) {
    if (!(error instanceof LinearPullError)) throw error;
    if (error.kind === "missing_credentials") console.error("FATAL: LINEAR_API_KEY not set");
    else if (error.kind === "graphql") console.error("GQL ERR:", JSON.stringify(error.details?.errors ?? [], null, 2));
    else console.error(`FATAL: ${error.message}`);
    process.exit(error.exitCode);
  }
}

// ─── Puller ──────────────────────────────────────────────────────────────────

const ISSUES_QUERY = `
  query FactoryReadyTickets($projectId: ID!, $labelId: ID!) {
    issues(filter: { project: { id: { eq: $projectId } }, labels: { id: { eq: $labelId } } }) {
      nodes {
        id
        identifier
        title
        description
        url
        priority
        createdAt
        updatedAt
        state { id name type }
        labels { nodes { id name } }
        team { id name key }
      }
    }
  }
`;

const REMOVE_LABEL_MUTATION = `
  mutation ReapFactoryReady($id: String!, $labelIds: [String!]!) {
    issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
  }
`;

/**
 * Strip the factory-ready label from one ticket by replacing its label set with
 * everything EXCEPT factory-ready. Fail-soft: warns on stderr and returns false so
 * a single reap failure (permissions, transient API) never aborts the pull.
 */
async function removeFactoryReadyLabel(issueId: string, keepLabelIds: string[]): Promise<boolean> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return false;
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query: REMOVE_LABEL_MUTATION, variables: { id: issueId, labelIds: keepLabelIds } }),
    });
    if (!r.ok) {
      console.error(`[reap] WARN issueUpdate ${issueId} HTTP ${r.status}`);
      return false;
    }
    const j = (await r.json()) as any;
    if (j.errors?.length) {
      console.error(`[reap] WARN issueUpdate ${issueId}: ${JSON.stringify(j.errors)}`);
      return false;
    }
    return j.data?.issueUpdate?.success === true;
  } catch (err) {
    console.error(`[reap] WARN issueUpdate ${issueId} threw: ${String(err)}`);
    return false;
  }
}

export async function pullTickets(): Promise<IntakeTicket[]> {
  const data = await gql<{ issues: { nodes: any[] } }>(ISSUES_QUERY, {
    projectId: INTAKE_PROJECT_ID,
    labelId: FACTORY_READY_LABEL,
  });

  const nodes = data.issues?.nodes ?? [];
  if (nodes.length === 0) {
    console.error("No factory-ready tickets in Intake project. Queue empty.");
    return [];
  }

  // ── REAP: any labeled ticket that has left the pullable set (started/review/
  // done/cancelled) should not keep the factory-ready label. Strip it so it is
  // never re-pulled and the label keeps meaning "ready and waiting".
  const reaped: string[] = [];
  for (const n of nodes) {
    if (isPullable(n.state?.type)) continue;
    const keep = (n.labels?.nodes ?? [])
      .map((l: any) => l.id)
      .filter((id: string) => id !== FACTORY_READY_LABEL);
    const ok = await removeFactoryReadyLabel(n.id, keep);
    if (ok) reaped.push(`${n.identifier} (${n.state?.name ?? "?"})`);
    else console.error(`[reap] could not strip factory-ready from ${n.identifier}`);
  }
  if (reaped.length) {
    console.error(`[reap] removed factory-ready from ${reaped.length} non-pullable ticket(s): ${reaped.join(", ")}`);
  }

  const pullable = nodes
    .filter((n: any) => isPullable(n.state?.type))
    .map((n: any): IntakeTicket => ({
      linear_id: n.id,
      identifier: n.identifier,
      title: n.title ?? "",
      description: n.description ?? "",
      url: n.url ?? "",
      state: n.state?.name ?? "",
      state_type: n.state?.type ?? "",
      labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
      created_at: n.createdAt ?? "",
      updated_at: n.updatedAt ?? "",
      priority: typeof n.priority === "number" ? n.priority : 0,
    }));

  const limit = pullLimit();
  if (limit === 0) {
    console.error("In-flight cap reached (FACTORY_INFLIGHT_CAP). Queue withheld this cycle.");
    return [];
  }
  return pickHighestPriority(pullable, limit);
}

/**
 * SF-007 expedited lane = ORDERING ONLY: urgent-first (Linear 1=Urgent…4=Low,
 * 0=None sorts last), created_at ascending breaks ties (FIFO fairness). Selection
 * then takes the top `limit` tickets (default 1 — the conveyor's per-cycle batch;
 * inflight-cap.ts pullLimit() clamps to headroom under FACTORY_INFLIGHT_CAP).
 * Every pulled ticket still crosses the decision gate + SF-002 classifier —
 * expedite never bypasses a gate.
 */
export function pickHighestPriority(tickets: IntakeTicket[], limit = 1): IntakeTicket[] {
  const sorted = [...tickets].sort((a: IntakeTicket, b: IntakeTicket) => {
    const byPriority = normalizePriority(a.priority) - normalizePriority(b.priority);
    if (byPriority !== 0) return byPriority;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
  return sorted.slice(0, Math.max(0, limit));
}

/** Linear priority 0 (None) sorts after Low. */
export function normalizePriority(p: number | undefined): number {
  return p === undefined || p === 0 ? 5 : p;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

// Guarded so the module is importable (e.g. by prespec-runner, which reuses
// isPullable/normalizePriority) WITHOUT triggering a live Linear pull + reap.
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
linear-puller — Reap + pull factory-ready tickets from the Intake Linear project

Each run: (1) strips the factory-ready label from any labeled ticket no longer in
the backlog/Todo set (started/review/done/cancelled), then (2) returns ONLY the
single highest-priority pullable ticket (urgent-first, created_at breaks ties).

USAGE:
  bun linear-puller.ts                # Reap, then print JSON queue (≤1 ticket) to stdout
  bun linear-puller.ts --dry-run      # Print the GraphQL query without executing (no reap)

ENV:
  LINEAR_API_KEY                      # Linear personal API key (required)

OUTPUT:
  JSON array with the single highest-priority IntakeTicket, or [] if none are pullable.
  Reap actions log to stderr. Exits 1 on fetch error, 2 on missing LINEAR_API_KEY.
`);
    process.exit(0);
  }

  if (values["dry-run"]) {
    console.log("Query:", ISSUES_QUERY.trim());
    console.log("Variables:", { projectId: INTAKE_PROJECT_ID, labelId: FACTORY_READY_LABEL });
    process.exit(0);
  }

  const tickets = await pullTickets();
  // Compact single-line JSON: the conveyor redirects stdout to a file and its
  // prompt documents this shape; keeping it one line also survives any `| tail -1`.
  console.log(JSON.stringify(tickets));
}
