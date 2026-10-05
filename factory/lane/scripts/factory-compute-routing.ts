import { createHash } from "node:crypto";
import {
  DEFAULT_ROUTING_POLICY,
  routeExecution,
  type DataClassification,
  type RoutingDecision,
  type RoutingPolicy,
} from "../../../packages/core/src/compute";
import type { FactoryGateDecision, ExecutionLaneDecision } from "./execution-lane";

export type FactoryComputeRouterMode = "off" | "shadow" | "enforce";

export interface FactoryComputeRoutingRecord {
  schema_version: 1;
  mode: FactoryComputeRouterMode;
  policy_version: string;
  gate_decision: FactoryGateDecision;
  incumbent_lane: ExecutionLaneDecision["lane"];
  node_kind: "agent" | "compute" | "verification";
  workload_class: string;
  classification: DataClassification;
  proposed: RoutingDecision;
  no_dispatch: true;
}

interface FactoryTicketLike {
  identifier?: string;
  title?: string;
  description?: string;
}

const PUBLIC_TERMS = /\b(?:public fixture|public corpus|open[- ]source|documentation|docs-only)\b/i;
const SENSITIVE_TERMS = /\b(?:secret|credential|token|password|private key|phi|pii|patient|medical record)\b/i;
const MUTATION_TERMS = /\b(?:commit|merge|push|deploy|publish|linear|github|canonical memory|memory write|production write)\b/i;
const NON_IDEMPOTENT_TERMS = /\b(?:commit|merge|push|deploy|publish|provision|delete|send|email|charge|payment)\b/i;
const MODAL_TERMS = /\b(?:modal|gpu|cuda|embedding|batch|fan[- ]?out|map[- ]reduce|shards?|deterministic(?: public)? fixture|public fixture|render)\b/i;
const VERIFICATION_TERMS = /\b(?:test|verify|verification|benchmark|build|lint|render|evaluation)\b/i;
const COMPUTE_TERMS = /\b(?:compute|embedding|batch|fan[- ]?out|map[- ]?reduce|gpu|cuda|shards?)\b/i;

export function factoryComputeRouterMode(
  env: Record<string, string | undefined> = process.env,
): FactoryComputeRouterMode {
  const value = env.FACTORY_COMPUTE_ROUTER?.trim().toLowerCase();
  if (!value || value === "0" || value === "off") return "off";
  if (value === "shadow") return "shadow";
  if (value === "enforce") return "enforce";
  throw new Error("FACTORY_COMPUTE_ROUTER must be off, shadow, or enforce");
}

function classify(text: string): DataClassification {
  if (SENSITIVE_TERMS.test(text)) return "sensitive";
  if (PUBLIC_TERMS.test(text)) return "public";
  return "internal";
}

function nodeKind(text: string): FactoryComputeRoutingRecord["node_kind"] {
  if (MUTATION_TERMS.test(text)) return "agent";
  if (VERIFICATION_TERMS.test(text)) return "verification";
  if (COMPUTE_TERMS.test(text)) return "compute";
  return "agent";
}

function workloadClass(text: string, kind: FactoryComputeRoutingRecord["node_kind"]): string {
  if (/\bembedding\b/i.test(text)) return "embedding-batch";
  if (/\b(?:gpu|cuda)\b/i.test(text)) return "gpu-compute";
  if (/\b(?:render|video)\b/i.test(text)) return "media-render";
  if (/\b(?:test|verify|verification|benchmark|evaluation)\b/i.test(text)) return "deterministic-verification";
  if (/\b(?:batch|fan[- ]?out|shards?)\b/i.test(text)) return "bounded-fanout";
  return kind === "agent" ? "agent-session" : "bounded-compute";
}

function parseWorkloads(value: string | undefined): Record<string, boolean> {
  if (!value) return {};
  return Object.fromEntries(value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => [entry, true]));
}

function parseCap(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap < 0) throw new Error("Factory compute cost caps must be finite numbers >= 0");
  return cap;
}

export function factoryComputeRoutingPolicy(
  env: Record<string, string | undefined> = process.env,
): RoutingPolicy {
  const mode = factoryComputeRouterMode(env);
  const environment = env.FACTORY_COMPUTE_ENVIRONMENT?.trim() || "default";
  return {
    ...DEFAULT_ROUTING_POLICY,
    policyVersion: env.FACTORY_COMPUTE_POLICY_VERSION?.trim() || "factory-compute-v1",
    enabled: mode !== "off",
    mode: mode === "enforce" ? "enforce" : "shadow",
    environment,
    environmentEnabled: { [environment]: env.FACTORY_COMPUTE_ENVIRONMENT_ENABLED === "1" },
    providerEnabled: {
      local: env.FACTORY_COMPUTE_LOCAL === "1",
      modal: env.FACTORY_COMPUTE_MODAL === "1",
      hetzner: env.FACTORY_COMPUTE_HETZNER === "1",
    },
    workloadClassEnabled: parseWorkloads(env.FACTORY_COMPUTE_WORKLOADS),
    allowSensitiveRemote: false,
    maxCostUsdByProvider: {
      local: parseCap(env.FACTORY_COMPUTE_LOCAL_MAX_USD),
      modal: parseCap(env.FACTORY_COMPUTE_MODAL_MAX_USD),
      hetzner: parseCap(env.FACTORY_COMPUTE_HETZNER_MAX_USD),
    },
  };
}

function stableCallbackId(ticket: FactoryTicketLike, text: string): string {
  return `factory-shadow-${createHash("sha256").update(`${ticket.identifier ?? "unknown"}\n${text}`).digest("hex").slice(0, 20)}`;
}

export function shadowFactoryComputeDecision(
  ticket: FactoryTicketLike,
  gateDecision: FactoryGateDecision,
  incumbentLane: ExecutionLaneDecision["lane"],
  env: Record<string, string | undefined> = process.env,
): FactoryComputeRoutingRecord | undefined {
  const mode = factoryComputeRouterMode(env);
  if (mode === "off") return undefined;
  const text = `${ticket.title ?? ""}\n${ticket.description ?? ""}`;
  const kind = nodeKind(text);
  const workload = workloadClass(text, kind);
  const classification = classify(text);
  const provider = incumbentLane === "hetzner" ? "hetzner" : MODAL_TERMS.test(text) ? "modal" : "local";
  const policy = factoryComputeRoutingPolicy(env);
  const proposed = routeExecution({
    nodeKind: kind,
    workloadClass: workload,
    environment: policy.environment,
    provider,
    approvalId: env.FACTORY_COMPUTE_APPROVAL_ID,
    classification,
    costEstimateUsd: env.FACTORY_COMPUTE_ESTIMATE_USD === undefined
      ? undefined
      : parseCap(env.FACTORY_COMPUTE_ESTIMATE_USD),
    callbackId: stableCallbackId(ticket, text),
    cleanupRequired: true,
    idempotent: !NON_IDEMPOTENT_TERMS.test(text),
    canonicalWrites: MUTATION_TERMS.test(text),
    externalMutations: MUTATION_TERMS.test(text),
  }, policy);
  return {
    schema_version: 1,
    mode,
    policy_version: policy.policyVersion,
    gate_decision: gateDecision,
    incumbent_lane: incumbentLane,
    node_kind: kind,
    workload_class: workload,
    classification,
    proposed,
    no_dispatch: true,
  };
}
