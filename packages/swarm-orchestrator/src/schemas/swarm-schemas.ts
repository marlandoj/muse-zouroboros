/**
 * P2-1: Cross-boundary JSON schema validation.
 *
 * Pure-TypeScript guard functions that validate every cross-boundary JSON
 * parse site in the swarm pipeline. Replaces naked JSON.parse() with strict
 * checking: required fields, correct types, no unknown keys (strict mode),
 * enum validation, and array-length caps.
 *
 * The parse sites are:
 *   - orchestrator → seed/trajectory payloads
 *   - executor bridge → executor results
 *   - executor transport → delegation reports
 *   - consensus-gate → consensus verdicts
 *   - api/server → incoming swarm campaign JSON
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type ValidationError = { field: string; issue: string };

function fail(field: string, issue: string): never {
  throw new SchemaValidationError(field, issue);
}

export class SchemaValidationError extends Error {
  constructor(
    public field: string,
    public issue: string,
  ) {
    super(`Schema validation: ${field}: ${issue}`);
    this.name = "SchemaValidationError";
  }
}

function mustBeString(val: unknown, field: string): string {
  if (typeof val !== "string") fail(field, "expected string");
  return val as string;
}

function mustBeNumber(val: unknown, field: string): number {
  if (typeof val !== "number" || Number.isNaN(val)) fail(field, "expected number");
  return val as number;
}

function mustBeBoolean(val: unknown, field: string): boolean {
  if (typeof val !== "boolean") fail(field, "expected boolean");
  return val as boolean;
}

function mustBeArray(val: unknown, field: string, maxLen?: number): unknown[] {
  if (!Array.isArray(val)) fail(field, "expected array");
  if (maxLen !== undefined && val.length > maxLen) {
    fail(field, `array length ${val.length} exceeds maximum ${maxLen}`);
  }
  return val as unknown[];
}

function mustBeObject(val: unknown, field: string): Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    fail(field, "expected object");
  }
  return val as Record<string, unknown>;
}

function rejectExtras(obj: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail(`${label}.${key}`, "unknown field — strict validation rejects extra keys");
    }
  }
}

// ---------------------------------------------------------------------------
// Priority queue / complexity / enums
// ---------------------------------------------------------------------------

const VALID_PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const VALID_COMPLEXITY = new Set(["trivial", "simple", "moderate", "complex"]);
const VALID_EXECUTOR_TYPES = new Set(["local", "remote"]);
const VALID_DAG_MODES = new Set(["streaming", "waves"]);
const VALID_TRANSPORT = new Set(["bridge", "acp"]);
const VALID_DECAY_CLASSES = new Set(["permanent", "stable", "active", "session", "checkpoint"]);
const VALID_CATEGORIES = new Set(["preference", "fact", "decision", "convention", "other", "reference", "project"]);
const VALID_STATUS = new Set(["pending", "running", "completed", "failed"]);
const VALID_CONSENSUS_STATUS = new Set(["validating", "passed", "rejected", "escalate"]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export function validateTask(raw: unknown): Task {
  const o = mustBeObject(raw, "Task");
  rejectExtras(o, new Set([
    "id", "persona", "task", "priority", "executor", "agencyPersona", "role",
    "dependsOn", "memoryStrategy", "timeoutSeconds", "expectedMutations", "model",
    "delegation", "outputToMemory", "ragContext", "memoryMetadata",
    "fallbackExecutors", "inputs", "specialists", "specialistMode",
  ]), "Task");

  const id = mustBeString(o.id, "Task.id");
  const persona = mustBeString(o.persona, "Task.persona");
  const task = mustBeString(o.task, "Task.task");
  const priority = mustBeString(o.priority, "Task.priority");
  if (!VALID_PRIORITIES.has(priority)) fail("Task.priority", `invalid value "${priority}"`);

  const result: Task = { id, persona, task, priority: priority as PriorityQueue };

  if (o.executor !== undefined) result.executor = mustBeString(o.executor, "Task.executor");
  if (o.dependsOn !== undefined) {
    const deps = mustBeArray(o.dependsOn, "Task.dependsOn", 20);
    for (let i = 0; i < deps.length; i++) mustBeString(deps[i], `Task.dependsOn[${i}]`);
    result.dependsOn = deps as string[];
  }
  if (o.timeoutSeconds !== undefined) {
    const t = mustBeNumber(o.timeoutSeconds, "Task.timeoutSeconds");
    if (t < 1 || t > 3600) fail("Task.timeoutSeconds", "must be 1-3600");
    result.timeoutSeconds = t;
  }
  if (o.expectedMutations !== undefined) {
    const ems = mustBeArray(o.expectedMutations, "Task.expectedMutations", 50);
    result.expectedMutations = ems.map((em, i) => {
      const eo = mustBeObject(em, `Task.expectedMutations[${i}]`);
      return {
        file: mustBeString(eo.file, `Task.expectedMutations[${i}].file`),
        contains: mustBeString(eo.contains, `Task.expectedMutations[${i}].contains`),
      };
    });
  }
  if (o.specialistMode !== undefined) {
    const mode = mustBeString(o.specialistMode, "Task.specialistMode");
    if (!new Set(["off", "shadow", "enforce"]).has(mode)) {
      fail("Task.specialistMode", `invalid value "${mode}"`);
    }
    result.specialistMode = mode as Task["specialistMode"];
  }
  if (o.specialists !== undefined) {
    const specialists = mustBeArray(o.specialists, "Task.specialists", 8);
    result.specialists = specialists.map((rawSpecialist, index) => {
      const specialist = mustBeObject(rawSpecialist, `Task.specialists[${index}]`);
      rejectExtras(specialist, new Set([
        "roleId", "personaName", "required", "phases", "requiredScopes", "invocationCap",
      ]), `Task.specialists[${index}]`);
      const phases = mustBeArray(specialist.phases, `Task.specialists[${index}].phases`, 2)
        .map((phase, phaseIndex) => {
          const value = mustBeString(phase, `Task.specialists[${index}].phases[${phaseIndex}]`);
          if (value !== "advise" && value !== "implement" && value !== "review") {
            fail(`Task.specialists[${index}].phases[${phaseIndex}]`, `invalid value "${value}"`);
          }
          return value as "advise" | "implement" | "review";
        });
      const requiredScopes = specialist.requiredScopes === undefined
        ? undefined
        : mustBeArray(specialist.requiredScopes, `Task.specialists[${index}].requiredScopes`, 8)
          .map((scope, scopeIndex) => mustBeString(scope, `Task.specialists[${index}].requiredScopes[${scopeIndex}]`));
      const invocationCap = specialist.invocationCap === undefined
        ? undefined
        : mustBeNumber(specialist.invocationCap, `Task.specialists[${index}].invocationCap`);
      if (invocationCap !== undefined && (!Number.isInteger(invocationCap) || invocationCap < 1 || invocationCap > 8)) {
        fail(`Task.specialists[${index}].invocationCap`, "must be an integer from 1 to 8");
      }
      return {
        roleId: mustBeString(specialist.roleId, `Task.specialists[${index}].roleId`),
        personaName: mustBeString(specialist.personaName, `Task.specialists[${index}].personaName`),
        required: mustBeBoolean(specialist.required, `Task.specialists[${index}].required`),
        phases,
        ...(requiredScopes ? { requiredScopes } : {}),
        ...(invocationCap === undefined ? {} : { invocationCap }),
      };
    });
  }

  return result;
}

export function validateTaskResult(raw: unknown): TaskResult {
  const o = mustBeObject(raw, "TaskResult");
  rejectExtras(o, new Set([
    "task", "success", "output", "error", "durationMs", "retries",
    "tokensUsed", "inputTokens", "outputTokens", "costUsd", "artifacts",
    "childRecords", "delegated", "modelUsed", "modelProvenance", "effectiveExecutor",
    "fallbacksAttempted", "specialistEvidence", "specialistCostUsd",
  ]), "TaskResult");

  const success = mustBeBoolean(o.success, "TaskResult.success");
  const durationMs = mustBeNumber(o.durationMs, "TaskResult.durationMs");
  const retries = mustBeNumber(o.retries, "TaskResult.retries");

  const result: TaskResult = {
    task: validateTask(o.task),
    success,
    durationMs,
    retries,
  };

  if (o.modelUsed !== undefined) result.modelUsed = mustBeString(o.modelUsed, "TaskResult.modelUsed");
  if (o.modelProvenance !== undefined) {
    const provenance = mustBeObject(o.modelProvenance, "TaskResult.modelProvenance");
    const allowed = new Set(["harness", "requestedProvider", "requestedModel", "resolvedModel", "modelFamily", "servingProvider", "endpointClass", "credentialEnvironment", "selectionEvidence"]);
    rejectExtras(provenance, allowed, "TaskResult.modelProvenance");
    for (const [key, value] of Object.entries(provenance)) mustBeString(value, `TaskResult.modelProvenance.${key}`);
    if (provenance.selectionEvidence !== undefined && !new Set(["provider-response", "cli-argument", "session-config", "environment"]).has(provenance.selectionEvidence as string)) fail("TaskResult.modelProvenance.selectionEvidence", "invalid evidence kind");
    mustBeString(provenance.harness, "TaskResult.modelProvenance.harness");
    result.modelProvenance = provenance as unknown as NonNullable<TaskResult['modelProvenance']>;
  }
  if (o.output !== undefined) result.output = mustBeString(o.output, "TaskResult.output");
  if (o.error !== undefined) result.error = mustBeString(o.error, "TaskResult.error");
  if (o.specialistCostUsd !== undefined) {
    const cost = mustBeNumber(o.specialistCostUsd, "TaskResult.specialistCostUsd");
    if (cost < 0) fail("TaskResult.specialistCostUsd", "must be non-negative");
    result.specialistCostUsd = cost;
  }
  if (o.specialistEvidence !== undefined) {
    const entries = mustBeArray(o.specialistEvidence, "TaskResult.specialistEvidence", 16);
    result.specialistEvidence = entries.map((entry, index) => {
      const evidence = mustBeObject(entry, `TaskResult.specialistEvidence[${index}]`);
      const status = mustBeString(evidence.status, `TaskResult.specialistEvidence[${index}].status`);
      if (!new Set(["invoked", "would_invoke", "omitted", "blocked"]).has(status)) {
        fail(`TaskResult.specialistEvidence[${index}].status`, `invalid value "${status}"`);
      }
      return evidence as unknown as NonNullable<TaskResult["specialistEvidence"]>[number];
    });
  }

  return result;
}

export function validateCampaign(raw: unknown): SwarmCampaign {
  const o = mustBeObject(raw, "SwarmCampaign");
  rejectExtras(o, new Set([
    "id", "name", "tasks", "config", "createdAt", "status",
  ]), "SwarmCampaign");

  const id = mustBeString(o.id, "SwarmCampaign.id");
  const name = mustBeString(o.name, "SwarmCampaign.name");
  const status = mustBeString(o.status, "SwarmCampaign.status");
  if (!VALID_STATUS.has(status)) fail("SwarmCampaign.status", `invalid value "${status}"`);

  const tasksRaw = mustBeArray(o.tasks, "SwarmCampaign.tasks", 100);

  return {
    id,
    name,
    tasks: tasksRaw.map((t, i) => validateTask(t)),
    config: o.config !== undefined
      ? mustBeObject(o.config, "SwarmCampaign.config") as Partial<SwarmConfig>
      : {},
    createdAt: mustBeNumber(o.createdAt, "SwarmCampaign.createdAt"),
    status,
  };
}

export function validateConsensusVerdict(raw: unknown): ConsensusVerdict {
  const o = mustBeObject(raw, "ConsensusVerdict");
  rejectExtras(o, new Set([
    "id", "timestamp", "label", "code", "criteria", "verdicts",
    "consensus", "status", "dissent_summary", "governance_verdict_id",
  ]), "ConsensusVerdict");

  const id = mustBeString(o.id, "ConsensusVerdict.id");
  const label = mustBeString(o.label, "ConsensusVerdict.label");
  const status = mustBeString(o.status, "ConsensusVerdict.status");
  if (!VALID_CONSENSUS_STATUS.has(status)) fail("ConsensusVerdict.status", `invalid value "${status}"`);

  return raw as ConsensusVerdict;
}

// ---------------------------------------------------------------------------
// Convenience: validate + return (throw on failure)
// ---------------------------------------------------------------------------

export function parseTask(json: string): Task { return validateTask(JSON.parse(json)); }
export function parseTaskResult(json: string): TaskResult { return validateTaskResult(JSON.parse(json)); }
export function parseCampaign(json: string): SwarmCampaign { return validateCampaign(JSON.parse(json)); }
export function parseConsensusVerdict(json: string): ConsensusVerdict { return validateConsensusVerdict(JSON.parse(json)); }

// ---------------------------------------------------------------------------
// Type imports
// ---------------------------------------------------------------------------

import type { Task, TaskResult, SwarmConfig, PriorityQueue } from '../types.js';

interface SwarmCampaign {
  id: string;
  name: string;
  tasks: Task[];
  config: Partial<SwarmConfig>;
  createdAt: number;
  status: string;
}

interface ConsensusVerdict {
  id: string;
  timestamp: string;
  label: string;
  code: string;
  criteria: string;
  verdicts: unknown[];
  consensus: Record<string, unknown>;
  status: string;
  dissent_summary?: unknown;
  governance_verdict_id?: string;
}
