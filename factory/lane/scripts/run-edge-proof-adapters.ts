import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./run-receipt-contract";
import {
  createGitHubEdgeProofAdapter,
  createWorkspaceEdgeProofAdapter,
  type EdgeProofAdapter,
  type EdgeProbeRequest,
  type EdgeProbeResponse,
} from "./run-edge-proof";
import { readRows, type LaneRow } from "./lane-utilization";

export const WORKSPACE_EDGE_ADAPTER_VERSION = "workspace-artifact/v1";
export const GITHUB_EDGE_ADAPTER_VERSION = "github-readback/v1";

const SAFE_COMPONENT = /^[A-Za-z0-9._-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ReadCommandRunner = (program: string, args: readonly string[], timeoutMs: number) => CommandResult;

export interface WorkspaceEdgeAdapterOptions {
  stateDir?: string;
  laneLedgerPath?: string;
  now?: () => string;
}

export interface GitHubEdgeAdapterOptions {
  stateDir?: string;
  now?: () => string;
  command?: ReadCommandRunner;
}

interface ExecutionRecord {
  execution_id?: string;
  ticket_id?: string;
  identifier?: string;
  repo_path?: string;
  state?: string;
  status?: string;
  stage?: string;
  completed_at?: string | null;
  base_commit?: string;
  [key: string]: unknown;
}

interface ShippingReceipt {
  execution_id?: string;
  status?: string;
  attempt_count?: number;
  outcome?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  repo_path?: string | null;
  updated_at?: string;
  completed_at?: string | null;
  [key: string]: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashValue(value: unknown): string {
  return sha256(canonicalize(value));
}

function response(
  request: Readonly<EdgeProbeRequest>,
  now: string,
  patch: Pick<EdgeProbeResponse, "status" | "acknowledgementTier" | "observedStateHash" | "sourceRevision" | "providerEventId" | "payloadHash" | "reasonCode">,
): EdgeProbeResponse {
  return {
    operationId: request.operationId,
    actorHash: request.actorHash,
    targetHash: request.targetHash,
    observedAt: now,
    ...patch,
  };
}

function missing(request: Readonly<EdgeProbeRequest>, now: string, reasonCode: string): EdgeProbeResponse {
  return response(request, now, {
    status: "retryable",
    acknowledgementTier: "none",
    observedStateHash: null,
    sourceRevision: null,
    providerEventId: null,
    payloadHash: null,
    reasonCode,
  });
}

function unavailable(request: Readonly<EdgeProbeRequest>, now: string, reasonCode: string): EdgeProbeResponse {
  return response(request, now, {
    status: "unavailable",
    acknowledgementTier: "none",
    observedStateHash: null,
    sourceRevision: null,
    providerEventId: null,
    payloadHash: null,
    reasonCode,
  });
}

function confirmed(
  request: Readonly<EdgeProbeRequest>,
  now: string,
  state: unknown,
  sourceRevision: string,
  providerEventId: string,
  tier: "durable_confirmed" | "user_visible_confirmed",
): EdgeProbeResponse {
  const stateHash = hashValue(state);
  if (stateHash !== request.expectedStateHash) return unavailable(request, now, "edge_state_mismatch");
  return response(request, now, {
    status: "confirmed",
    acknowledgementTier: tier,
    observedStateHash: stateHash,
    sourceRevision,
    providerEventId,
    payloadHash: hashValue(state),
    reasonCode: null,
  });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function executionPath(stateDir: string, executionId: string): string {
  if (!SAFE_COMPONENT.test(executionId) || !executionId.startsWith("exec-")) throw new Error("execution target is invalid");
  return join(stateDir, `exec-${executionId}.json`);
}

function shippingPath(stateDir: string, executionId: string): string {
  if (!SAFE_COMPONENT.test(executionId) || !executionId.startsWith("exec-")) throw new Error("shipping target is invalid");
  return join(stateDir, `shipping-request-${executionId}.json`);
}

function terminalExecution(record: ExecutionRecord): boolean {
  const state = String(record.state ?? record.status ?? record.stage ?? "");
  return Boolean(record.completed_at) || !["", "executing", "pool_enqueued", "queued", "running"].includes(state);
}

function durableAtOrAfter(value: unknown, lowerBound: string): boolean {
  if (typeof value !== "string") return false;
  const observed = Date.parse(value);
  const minimum = Date.parse(lowerBound);
  return Number.isFinite(observed) && Number.isFinite(minimum) && observed >= minimum;
}

function resolveLaneTarget(request: Readonly<EdgeProbeRequest>, rows: readonly LaneRow[], now: string): EdgeProbeResponse {
  const parts = request.targetRef.split(":");
  if (parts.length !== 3 || parts[0] !== "lane" || parts[2] !== "outcome" || !SAFE_COMPONENT.test(parts[1])) {
    return unavailable(request, now, "workspace_target_invalid");
  }
  const row = [...rows].reverse().find((entry) => entry.cycle_id === parts[1] && entry.phase === "outcome");
  if (!row) return missing(request, now, "lane_outcome_missing");
  if (!durableAtOrAfter(row.ts, request.planCreatedAt)) return unavailable(request, now, "workspace_record_historical");
  const state = { cycle_id: row.cycle_id, phase: row.phase };
  const rowHash = hashValue(row);
  return confirmed(request, now, state, `lane-row:${rowHash}`, `lane:${rowHash}`, "durable_confirmed");
}

function resolveFactoryTarget(
  request: Readonly<EdgeProbeRequest>,
  rows: readonly LaneRow[],
  stateDir: string,
  now: string,
): EdgeProbeResponse {
  const parts = request.targetRef.split(":");
  if (parts.length !== 3 || parts[0] !== "factory" || !UUID.test(parts[1]) || !SAFE_COMPONENT.test(parts[2])) {
    return unavailable(request, now, "workspace_target_invalid");
  }
  const [, ticketId, cycleId] = parts;
  const outcome = [...rows].reverse().find((row) => row.cycle_id === cycleId && row.phase === "outcome" && row.ticket_id === ticketId);
  if (!outcome?.execution_id) return missing(request, now, "factory_outcome_missing");
  const execution = readJson<ExecutionRecord>(executionPath(stateDir, outcome.execution_id));
  if (!execution || execution.ticket_id !== ticketId || !terminalExecution(execution)) return missing(request, now, "factory_execution_missing");
  if (!durableAtOrAfter(outcome.ts, request.planCreatedAt) || !durableAtOrAfter(execution.completed_at, request.planCreatedAt)) {
    return unavailable(request, now, "workspace_record_historical");
  }
  const state = { cycle_id: cycleId, ticket_id: ticketId, terminal: true };
  const sourceHash = hashValue({ outcome, execution });
  const sourceRevision = typeof execution.base_commit === "string" && /^[0-9a-f]{40}$/.test(execution.base_commit)
    ? `git:${execution.base_commit}`
    : `factory-state:${sourceHash}`;
  return confirmed(request, now, state, sourceRevision, `execution:${outcome.execution_id}`, "durable_confirmed");
}

function resolveExecutionTarget(request: Readonly<EdgeProbeRequest>, stateDir: string, now: string): EdgeProbeResponse {
  const parts = request.targetRef.split(":");
  if (parts.length !== 2 || parts[0] !== "execution") return unavailable(request, now, "workspace_target_invalid");
  const execution = readJson<ExecutionRecord>(executionPath(stateDir, parts[1]));
  if (!execution) return missing(request, now, "execution_record_missing");
  if (!durableAtOrAfter(execution.completed_at, request.planCreatedAt)) return unavailable(request, now, "workspace_record_historical");
  const state = { execution_id: parts[1], terminal: terminalExecution(execution) };
  const sourceHash = hashValue(execution);
  return confirmed(request, now, state, `execution-record:${sourceHash}`, `execution:${parts[1]}`, "durable_confirmed");
}

function resolveShippingTarget(request: Readonly<EdgeProbeRequest>, stateDir: string, now: string): EdgeProbeResponse {
  const parts = request.targetRef.split(":");
  if (parts.length !== 4 || parts[0] !== "shipping" || parts[2] !== "attempt" || !/^\d+$/.test(parts[3])) {
    return unavailable(request, now, "workspace_target_invalid");
  }
  const receipt = readJson<ShippingReceipt>(shippingPath(stateDir, parts[1]));
  const attempt = Number(parts[3]);
  if (!receipt || receipt.attempt_count !== attempt) return missing(request, now, "shipping_receipt_missing");
  if (!durableAtOrAfter(receipt.completed_at ?? receipt.updated_at, request.planCreatedAt)) return unavailable(request, now, "workspace_record_historical");
  const state = { execution_id: parts[1], status: receipt.status, attempt_count: attempt, outcome: receipt.outcome ?? null };
  const sourceHash = hashValue(receipt);
  return confirmed(request, now, state, `shipping-receipt:${sourceHash}`, `shipping:${parts[1]}:${attempt}`, "durable_confirmed");
}

export function createProductionWorkspaceEdgeAdapter(options: WorkspaceEdgeAdapterOptions = {}): EdgeProofAdapter {
  const stateDir = options.stateDir ?? factoryStateRoot();
  const laneLedgerPath = options.laneLedgerPath;
  const now = options.now ?? (() => new Date().toISOString());
  return createWorkspaceEdgeProofAdapter(WORKSPACE_EDGE_ADAPTER_VERSION, {
    read(request) {
      try {
        if (request.targetRef.startsWith("lane:")) return resolveLaneTarget(request, readRows(laneLedgerPath).rows, now());
        if (request.targetRef.startsWith("factory:")) return resolveFactoryTarget(request, readRows(laneLedgerPath).rows, stateDir, now());
        if (request.targetRef.startsWith("execution:")) return resolveExecutionTarget(request, stateDir, now());
        if (request.targetRef.startsWith("shipping:")) return resolveShippingTarget(request, stateDir, now());
        return unavailable(request, now(), "workspace_target_invalid");
      } catch {
        return unavailable(request, now(), "workspace_read_unavailable");
      }
    },
  });
}

function defaultReadCommand(program: string, args: readonly string[], timeoutMs: number): CommandResult {
  const result = spawnSync(program, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runBoundedGitHubGet(runner: ReadCommandRunner, endpoint: string, timeoutMs: number): CommandResult {
  if (!/^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*$/.test(endpoint)) throw new Error("GitHub read endpoint is invalid");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("GitHub read timeout is invalid");
  return runner("gh", ["api", "--method", "GET", endpoint], timeoutMs);
}

function githubIdentity(receipt: ShippingReceipt): { owner: string; repo: string; prNumber: number } | null {
  if (!receipt.pr_url || !receipt.pr_number) return null;
  let url: URL;
  try {
    url = new URL(receipt.pr_url);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length !== 4 || parts[2] !== "pull" || Number(parts[3]) !== receipt.pr_number) return null;
  if (!SAFE_COMPONENT.test(parts[0]) || !SAFE_COMPONENT.test(parts[1])) return null;
  return { owner: parts[0], repo: parts[1], prNumber: receipt.pr_number };
}

export function createProductionGitHubEdgeAdapter(options: GitHubEdgeAdapterOptions = {}): EdgeProofAdapter {
  const stateDir = options.stateDir ?? factoryStateRoot();
  const now = options.now ?? (() => new Date().toISOString());
  const command = options.command ?? defaultReadCommand;
  return createGitHubEdgeProofAdapter(GITHUB_EDGE_ADAPTER_VERSION, {
    read(request) {
      try {
        const parts = request.targetRef.split(":");
        if (parts.length !== 3 || parts[0] !== "github" || !/^[0-9a-f]{64}$/.test(parts[1])) return unavailable(request, now(), "github_target_invalid");
        const executionId = parts[2];
        const execution = readJson<ExecutionRecord>(executionPath(stateDir, executionId));
        const receipt = readJson<ShippingReceipt>(shippingPath(stateDir, executionId));
        if (!execution || !receipt || receipt.execution_id !== executionId) return missing(request, now(), "github_receipt_missing");
        if (!durableAtOrAfter(receipt.completed_at ?? receipt.updated_at, request.planCreatedAt)) return unavailable(request, now(), "github_receipt_historical");
        const repositoryIdentity = execution.repo_path ?? receipt.repo_path ?? execution.identifier;
        if (!repositoryIdentity || sha256(repositoryIdentity) !== parts[1]) return unavailable(request, now(), "github_repository_mismatch");
        const identity = githubIdentity(receipt);
        if (!identity) return missing(request, now(), "github_pull_identity_missing");
        const result = runBoundedGitHubGet(command, `repos/${identity.owner}/${identity.repo}/pulls/${identity.prNumber}`, request.timeoutMs);
        if (result.status !== 0) return missing(request, now(), "github_read_unavailable");
        if (Buffer.byteLength(result.stdout, "utf8") > 64 * 1024) return unavailable(request, now(), "github_response_too_large");
        const payload = JSON.parse(result.stdout) as Record<string, unknown>;
        if (payload.number !== identity.prNumber || typeof payload.state !== "string") return unavailable(request, now(), "github_response_invalid");
        const head = payload.head as { sha?: unknown } | undefined;
        const headSha = typeof head?.sha === "string" && /^[0-9a-f]{40}$/.test(head.sha) ? head.sha : null;
        if (!headSha) return unavailable(request, now(), "github_source_revision_missing");
        const normalized = {
          repository_hash: parts[1],
          execution_id: executionId,
          user_visible: true,
        };
        const sourceHash = hashValue({ number: payload.number, state: payload.state, merged: payload.merged === true, head_sha: headSha });
        return confirmed(
          request,
          now(),
          normalized,
          `github-head:${headSha}`,
          `github-pr:${identity.prNumber}:${sourceHash.slice(0, 16)}`,
          "user_visible_confirmed",
        );
      } catch {
        return unavailable(request, now(), "github_read_unavailable");
      }
    },
  });
}
