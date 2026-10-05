#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { canonicalize } from "./run-receipt-contract.ts";

export const ACTOR_KINDS = ["user", "tool", "api", "system"] as const;
export type ActorKind = typeof ACTOR_KINDS[number];
export type ActorTerminal = "completed" | "failed" | "cancelled";

export interface ActorSystemContract {
  id: string;
  actorKind: ActorKind;
  interaction: string;
  initialState: string;
  fault: string;
  recovery: string;
  approval: "required_allow" | "required_deny" | "not_applicable";
  expectedTerminal: ActorTerminal;
}

export interface ActorSystemManifest {
  schemaVersion: 1;
  manifestId: string;
  classification: "synthetic_only";
  reviewBinding: string;
  replicateSeeds: number[];
  contracts: ActorSystemContract[];
}

export interface ActorAuthority {
  kind: "approved_manifest" | "admitted_lineage";
  manifestHash: string;
  contractHash: string;
  reviewHash: string;
}

export interface ActorRequest {
  requestId: string;
  approval?: "allow" | "deny";
}

export interface ActorState {
  status: ActorTerminal | "ready";
  version: number;
  attempts: number;
  committed: boolean;
  compensated: boolean;
  resumed: boolean;
  handledRequestIds: string[];
}

export interface ActorResponse {
  requestId: string;
  responseId: string;
  actorKind: ActorKind;
  terminal: ActorTerminal;
  attempts: number;
  delayMs: number;
  committed: boolean;
  compensated: boolean;
  resumed: boolean;
  idempotentReplay: boolean;
  stateVersion: number;
}

export interface ActorTranscriptEntry {
  sequence: number;
  request: ActorRequest;
  response: ActorResponse;
  stateHash: string;
}

export interface ActorTranscript {
  entries: ActorTranscriptEntry[];
  sha256: string;
}

export interface LoadedActorContract {
  manifest: ActorSystemManifest;
  manifestHash: string;
  contract: ActorSystemContract;
  contractHash: string;
}

export interface ActorSystemTwinHandle {
  port: number;
  url: string;
  stop(): void;
  state(): ActorState;
  transcript(): ActorTranscript;
}

const HASH = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = new Set(["schemaVersion", "manifestId", "classification", "reviewBinding", "replicateSeeds", "contracts"]);
const CONTRACT_KEYS = new Set(["id", "actorKind", "interaction", "initialState", "fault", "recovery", "approval", "expectedTerminal"]);
const APPROVALS = new Set(["required_allow", "required_deny", "not_applicable"]);
const TERMINALS = new Set(["completed", "failed", "cancelled"]);
const INTERACTIONS = new Set(["approval", "cancellation", "message", "invoke", "request", "state_change", "recovery"]);
const INITIAL_STATES = new Set(["awaiting_approval", "prepared", "waiting", "accepted_once", "ready", "running", "available", "version_1", "version_conflict", "interrupted"]);
const FAULTS = new Set(["none", "cancel_before_commit", "deterministic_delay", "duplicate_request", "transient_failure", "permanent_failure", "timeout", "cancel_during_run", "rate_limited", "server_error", "malformed_response", "partial_response", "optimistic_conflict", "partial_commit", "approval_bypass_attempt", "restart_during_operation"]);
const RECOVERIES = new Set(["commit_once", "stop_without_commit", "resume_after_delay", "idempotent_replay", "bounded_retry_success", "fail_closed", "bounded_timeout", "compensate_and_stop", "seeded_backoff_success", "reject_response", "detect_and_compensate", "commit_version_2", "reload_then_retry", "compensate_to_baseline", "deny_and_preserve_state", "resume_once_then_cleanup"]);
const REQUEST_KEYS = new Set(["requestId", "approval"]);
const CREDENTIAL_VALUE = /^(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}$/i;
const ACTIVE_PORTS = new Set<number>();

export function activeActorTwinPorts(): number[] {
  return [...ACTIVE_PORTS].sort((a, b) => a - b);
}

export function actorSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function parseContract(value: unknown, index: number): ActorSystemContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`contracts[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !CONTRACT_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`contracts[${index}] has unknown keys: ${unknown.join(", ")}`);
  const actorKind = requireText(raw.actorKind, `contracts[${index}].actorKind`);
  const approval = requireText(raw.approval, `contracts[${index}].approval`);
  const expectedTerminal = requireText(raw.expectedTerminal, `contracts[${index}].expectedTerminal`);
  if (!ACTOR_KINDS.includes(actorKind as ActorKind)) throw new Error(`contracts[${index}].actorKind is unsupported`);
  if (!APPROVALS.has(approval)) throw new Error(`contracts[${index}].approval is unsupported`);
  if (!TERMINALS.has(expectedTerminal)) throw new Error(`contracts[${index}].expectedTerminal is unsupported`);
  for (const [key, values] of [["interaction", INTERACTIONS], ["initialState", INITIAL_STATES], ["fault", FAULTS], ["recovery", RECOVERIES]] as const) {
    if (!values.has(requireText(raw[key], `contracts[${index}].${key}`))) throw new Error(`contracts[${index}].${key} is unsupported`);
  }
  return {
    id: requireText(raw.id, `contracts[${index}].id`),
    actorKind: actorKind as ActorKind,
    interaction: requireText(raw.interaction, `contracts[${index}].interaction`),
    initialState: requireText(raw.initialState, `contracts[${index}].initialState`),
    fault: requireText(raw.fault, `contracts[${index}].fault`),
    recovery: requireText(raw.recovery, `contracts[${index}].recovery`),
    approval: approval as ActorSystemContract["approval"],
    expectedTerminal: expectedTerminal as ActorTerminal,
  };
}

export function parseActorSystemManifest(value: unknown): ActorSystemManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("actor-system manifest must be an object");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !MANIFEST_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`actor-system manifest has unknown keys: ${unknown.join(", ")}`);
  if (raw.schemaVersion !== 1) throw new Error("actor-system manifest schemaVersion must be 1");
  if (raw.classification !== "synthetic_only") throw new Error("actor-system manifest must be synthetic_only");
  if (!Array.isArray(raw.replicateSeeds) || raw.replicateSeeds.length === 0
    || raw.replicateSeeds.some((seed) => !Number.isSafeInteger(seed) || (seed as number) < 0)) {
    throw new Error("actor-system manifest replicateSeeds must be non-negative safe integers");
  }
  if (new Set(raw.replicateSeeds as number[]).size !== raw.replicateSeeds.length) throw new Error("actor-system manifest has duplicate seeds");
  if (!Array.isArray(raw.contracts) || raw.contracts.length === 0) throw new Error("actor-system manifest contracts are required");
  const contracts = raw.contracts.map(parseContract);
  if (new Set(contracts.map((contract) => contract.id)).size !== contracts.length) throw new Error("actor-system manifest has duplicate contract ids");
  return {
    schemaVersion: 1,
    manifestId: requireText(raw.manifestId, "manifestId"),
    classification: "synthetic_only",
    reviewBinding: requireText(raw.reviewBinding, "reviewBinding"),
    replicateSeeds: [...raw.replicateSeeds] as number[],
    contracts,
  };
}

export function loadActorSystemContract(path: string, contractId: string, authority: ActorAuthority): LoadedActorContract {
  if (!existsSync(path)) throw new Error(`actor-system fixture not found: ${path}`);
  if (!HASH.test(authority.manifestHash) || !HASH.test(authority.contractHash) || !HASH.test(authority.reviewHash)) {
    throw new Error("actor-system authority hashes must be lowercase SHA-256");
  }
  if (authority.kind !== "approved_manifest" && authority.kind !== "admitted_lineage") throw new Error("actor-system authority kind is unsupported");
  const bytes = readFileSync(path);
  const manifestHash = createHash("sha256").update(bytes).digest("hex");
  if (manifestHash !== authority.manifestHash) throw new Error("actor-system manifest hash mismatch");
  const manifest = parseActorSystemManifest(JSON.parse(bytes.toString("utf8")));
  const contract = manifest.contracts.find((entry) => entry.id === contractId);
  if (!contract) throw new Error(`actor-system contract is not approved: ${contractId}`);
  const contractHash = actorSha256(contract);
  if (contractHash !== authority.contractHash) throw new Error("actor-system contract hash mismatch");
  return { manifest, manifestHash, contract, contractHash };
}

function seededInt(contract: ActorSystemContract, seed: number, label: string, maximum: number): number {
  const digest = actorSha256({ contract: contract.id, seed, label });
  return Number.parseInt(digest.slice(0, 8), 16) % maximum;
}

function transition(contract: ActorSystemContract, seed: number, request: ActorRequest, state: ActorState): ActorResponse {
  const unknown = Object.keys(request as unknown as Record<string, unknown>).filter((key) => !REQUEST_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`actor request has unknown keys: ${unknown.join(", ")}`);
  if (typeof request.requestId !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(request.requestId) || CREDENTIAL_VALUE.test(request.requestId)) {
    throw new Error("requestId is invalid");
  }
  if (request.approval !== undefined && request.approval !== "allow" && request.approval !== "deny") throw new Error("actor request approval is invalid");
  const prior = state.handledRequestIds.includes(request.requestId);
  const terminal = contract.expectedTerminal;
  const retryFault = new Set(["transient_failure", "rate_limited", "server_error", "optimistic_conflict"]);
  const attempts = retryFault.has(contract.fault) ? 2 : 1;
  const delayMs = contract.fault === "deterministic_delay" || contract.fault === "rate_limited"
    ? 5 + seededInt(contract, seed, "delay", 46)
    : 0;
  if (contract.approval === "required_allow" && request.approval !== "allow") throw new Error("explicit approval allow is required");
  if (contract.fault === "approval_bypass_attempt" && request.approval === "allow") throw new Error("approval bypass is denied");
  const compensated = new Set(["partial_response", "partial_commit", "cancel_during_run"]).has(contract.fault);
  const committed = terminal === "completed" && contract.approval !== "required_deny";
  const resumed = contract.fault === "restart_during_operation";
  if (!prior) {
    state.status = terminal;
    state.attempts = attempts;
    state.committed = committed;
    state.compensated = compensated;
    state.resumed = resumed;
    state.version += committed ? 1 : 0;
    state.handledRequestIds.push(request.requestId);
  }
  return {
    requestId: request.requestId,
    responseId: `actor-${actorSha256({ contract: contract.id, seed, requestId: request.requestId }).slice(0, 24)}`,
    actorKind: contract.actorKind,
    terminal,
    attempts,
    delayMs,
    committed,
    compensated,
    resumed,
    idempotentReplay: prior,
    stateVersion: state.version,
  };
}

export function createActorSystemMachine(loaded: LoadedActorContract, seed: number) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("actor-system seed must be a non-negative safe integer");
  if (!loaded.manifest.replicateSeeds.includes(seed)) throw new Error(`actor-system seed is not registered: ${seed}`);
  const state: ActorState = {
    status: "ready",
    version: 1,
    attempts: 0,
    committed: false,
    compensated: false,
    resumed: false,
    handledRequestIds: [],
  };
  const entries: ActorTranscriptEntry[] = [];
  return {
    handle(request: ActorRequest): ActorResponse {
      const response = transition(loaded.contract, seed, structuredClone(request), state);
      const entry = {
        sequence: entries.length,
        request: structuredClone(request),
        response: structuredClone(response),
        stateHash: actorSha256(state),
      };
      if (!response.idempotentReplay) entries.push(entry);
      return structuredClone(response);
    },
    state: (): ActorState => structuredClone(state),
    transcript: (): ActorTranscript => ({ entries: structuredClone(entries), sha256: actorSha256(entries) }),
  };
}

export function startActorSystemTwin(loaded: LoadedActorContract, seed: number): ActorSystemTwinHandle {
  const machine = createActorSystemMachine(loaded, seed);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
      const body = await request.json().catch(() => null) as ActorRequest | null;
      try {
        if (!body || typeof body !== "object") throw new Error("request body must be an object");
        return Response.json(machine.handle(body));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });
  if (typeof server.port !== "number") {
    server.stop(true);
    throw new Error("actor-system twin failed to bind an ephemeral port");
  }
  ACTIVE_PORTS.add(server.port);
  let stopped = false;
  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}/actor`,
    stop: () => {
      if (stopped) return;
      stopped = true;
      ACTIVE_PORTS.delete(server.port!);
      server.stop(true);
    },
    state: machine.state,
    transcript: machine.transcript,
  };
}
