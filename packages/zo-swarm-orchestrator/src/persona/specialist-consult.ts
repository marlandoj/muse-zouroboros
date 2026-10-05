import { createHash } from "node:crypto";
import {
  createZoMcpListPersonasCaller,
  resolvePersonas,
  type ResolvedPersona,
} from "./directory.js";

export type SpecialistConsultMode = "off" | "shadow" | "enforce";
export type SpecialistConsultPhase = "advise" | "review";
export type SpecialistRolePhase = SpecialistConsultPhase | "implement";
export type SpecialistConsultStatus = "invoked" | "would_invoke" | "omitted" | "blocked";

export interface SpecialistAssignment {
  roleId: string;
  personaName: string;
  required: boolean;
  phases: SpecialistRolePhase[];
  requiredScopes?: string[];
  invocationCap?: number;
}

export interface SpecialistInvocationRequest {
  input: string;
  modelName: string;
  personaId: string;
  timeoutMs: number;
}

export interface SpecialistInvocationResponse {
  output: string;
  modelName: string;
  costUsd: number | null;
}

export interface SpecialistModelIdentity {
  modelName: string;
  vendor: string;
}

export interface SpecialistReviewerPolicy {
  candidates: SpecialistModelIdentity[];
  requireDistinctModel?: boolean;
  requireVendorDiversity?: boolean;
}

export interface SpecialistReviewerSelection extends SpecialistModelIdentity {
  implementerModelName: string;
  implementerVendor: string;
  distinctModel: boolean;
  vendorDiverse: boolean;
}

export interface SpecialistConsultEvidence {
  roleId: string;
  phase: SpecialistConsultPhase;
  required: boolean;
  personaName: string;
  personaId: string | null;
  status: SpecialistConsultStatus;
  modelName: string | null;
  promptSha256: string | null;
  outputSha256: string | null;
  output: string | null;
  costUsd: number | null;
  verdict: "pass" | "fail" | null;
  summary: string | null;
  modelVendor: string | null;
  implementerModelName: string | null;
  implementerVendor: string | null;
  distinctModel: boolean | null;
  vendorDiverse: boolean | null;
  reason: string | null;
}

export interface SpecialistConsultResult {
  ok: boolean;
  mode: SpecialistConsultMode;
  phase: SpecialistConsultPhase;
  directorySnapshotHash: string | null;
  evidence: SpecialistConsultEvidence[];
  totalCostUsd: number;
  blockedReason: string | null;
}

export interface ConsultSpecialistsOptions {
  mode: SpecialistConsultMode;
  phase: SpecialistConsultPhase;
  taskId: string;
  task: string;
  implementationOutput?: string;
  assignments: SpecialistAssignment[];
  modelName?: string;
  implementerModelName?: string;
  implementerVendor?: string;
  reviewerPolicy?: SpecialistReviewerPolicy;
  timeoutMs?: number;
  listPersonas?: () => Promise<unknown>;
  invokePersona?: (request: SpecialistInvocationRequest) => Promise<SpecialistInvocationResponse>;
}

const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_SPECIALISTS_PER_PHASE = 8;

export const DEFAULT_SPECIALIST_REVIEWER_MODELS: SpecialistModelIdentity[] = [
  { modelName: "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51", vendor: "openai" },
  { modelName: "byok:463350ac-4a49-4ceb-8653-042ecffa513f", vendor: "moonshot" },
  { modelName: "byok:0a635de6-5e45-4a8a-8e73-f1d25f31fd96", vendor: "anthropic" },
];

export const SPECIALIST_REVIEWER_MODELS_ENV = "FACTORY_SPECIALIST_REVIEWER_MODELS";

/**
 * Resolve the reviewer candidate pool, preferring an operator-supplied override so a
 * rotated or deleted BYOK config is a configuration change rather than a code change.
 * Format: comma-separated `model[:vendor]` entries; the vendor half is optional and
 * falls back to KNOWN_MODEL_VENDORS / the name heuristic. Malformed or empty overrides
 * fall back to the compiled defaults rather than yielding an empty pool.
 */
export function resolveSpecialistReviewerCandidates(
  env: Record<string, string | undefined> = process.env,
): SpecialistModelIdentity[] {
  const raw = env[SPECIALIST_REVIEWER_MODELS_ENV];
  if (!raw || !raw.trim()) return DEFAULT_SPECIALIST_REVIEWER_MODELS;
  const parsed: SpecialistModelIdentity[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.lastIndexOf(":");
    const looksVendored = sep > trimmed.indexOf(":") && sep > 0;
    const modelName = looksVendored ? trimmed.slice(0, sep).trim() : trimmed;
    const vendor = looksVendored ? trimmed.slice(sep + 1).trim() : undefined;
    if (!modelName) continue;
    const resolved = resolveModelVendor(modelName, vendor);
    if (!resolved) continue;
    parsed.push({ modelName, vendor: resolved });
  }
  return parsed.length ? parsed : DEFAULT_SPECIALIST_REVIEWER_MODELS;
}

const KNOWN_MODEL_VENDORS = new Map<string, string>([
  ["byok:461d8d6f-9616-4391-960e-3caea2a27829", "anthropic"],
  ["byok:63a73cf2-224a-4641-8dcb-c3313270d08a", "anthropic"],
  ["byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0", "anthropic"],
  ["byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e", "anthropic"],
  ["byok:2d297290-05e1-4f64-848c-0356e74f7187", "openai"],
  ["byok:fcb940f0-9ff7-42b2-9f04-ca8460a314a5", "openai"],
  ["byok:47466410-d8ac-4c24-ab32-b5be5c2be6cd", "openai"],
  ["byok:905b6491-3b7f-4ed6-864c-a9817603cb0f", "openai"],
  ["byok:bc8717e3-e94f-416e-81d5-ab9d80962766", "openai"],
  ["byok:ef1faca8-a70d-46d3-88d3-b78f96635885", "openai"],
  ["byok:0a635de6-5e45-4a8a-8e73-f1d25f31fd96", "anthropic"],
  ["byok:7c082f03-a53a-4978-8a67-e0bb06c25d51", "openai"],
  ["byok:463350ac-4a49-4ceb-8653-042ecffa513f", "moonshot"],
  ["byok:73ae74c2-26d1-561e-91af-2cf47a33f4dd", "moonshot"],
  ["byok:76aef0ac-9f7e-50fc-9f13-c8332a118662", "moonshot"],
  ["byok:d1f6a676-f46f-5f70-8991-baeec4df3bc6", "moonshot"],
  ["byok:bb3d131d-749f-423b-a285-9f9efd103926", "z-ai"],
]);

export function resolveModelVendor(modelName: string, explicitVendor?: string): string | null {
  const explicit = explicitVendor?.trim().toLowerCase();
  if (explicit) return explicit;
  const known = KNOWN_MODEL_VENDORS.get(modelName.trim());
  if (known) return known;
  const lower = modelName.toLowerCase();
  if (/anthropic|claude/.test(lower)) return "anthropic";
  if (/openai|gpt|codex/.test(lower)) return "openai";
  if (/moonshot|kimi/.test(lower)) return "moonshot";
  if (/z-ai|zai|glm/.test(lower)) return "z-ai";
  if (/google|gemini/.test(lower)) return "google";
  if (/deepseek/.test(lower)) return "deepseek";
  return null;
}

export function selectIndependentReviewerModel(input: {
  implementerModelName: string;
  implementerVendor?: string;
  policy?: SpecialistReviewerPolicy;
}): SpecialistReviewerSelection {
  const implementerModelName = input.implementerModelName.trim();
  if (!implementerModelName) throw new Error("implementer model is required for specialist review enforcement");
  const policy = input.policy ?? { candidates: resolveSpecialistReviewerCandidates() };
  const requireDistinctModel = policy.requireDistinctModel ?? true;
  const requireVendorDiversity = policy.requireVendorDiversity ?? true;
  const implementerVendor = resolveModelVendor(implementerModelName, input.implementerVendor);
  if (requireVendorDiversity && !implementerVendor) {
    throw new Error(`implementer vendor is unresolved for ${implementerModelName}`);
  }
  for (const candidate of policy.candidates) {
    const modelName = candidate.modelName.trim();
    const vendor = resolveModelVendor(modelName, candidate.vendor);
    if (!modelName || !vendor) continue;
    const distinctModel = modelName !== implementerModelName;
    const vendorDiverse = implementerVendor ? vendor !== implementerVendor : false;
    if (requireDistinctModel && !distinctModel) continue;
    if (requireVendorDiversity && !vendorDiverse) continue;
    return {
      modelName,
      vendor,
      implementerModelName,
      implementerVendor: implementerVendor ?? "unknown",
      distinctModel,
      vendorDiverse,
    };
  }
  throw new Error(
    `no specialist reviewer model satisfies distinct-model=${requireDistinctModel} vendor-diversity=${requireVendorDiversity} for ${implementerModelName}`,
  );
}

export function parseSpecialistReviewVerdict(output: string): { verdict: "pass" | "fail"; summary: string } {
  const text = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("specialist review JSON is invalid");
  }
  if (parsed.verdict !== "pass" && parsed.verdict !== "fail") {
    throw new Error("specialist review verdict must be pass|fail");
  }
  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("specialist review summary is required");
  }
  return { verdict: parsed.verdict, summary: parsed.summary.trim() };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finiteCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function responseOutput(payload: Record<string, unknown>): string {
  const output = payload.output ?? payload.result ?? payload.message;
  if (typeof output === "string" && output.trim()) return output.trim();
  if (output && typeof output === "object") return JSON.stringify(output);
  throw new Error("specialist /zo/ask response has no non-empty output");
}

export function resolveSpecialistConsultMode(
  value = process.env.SWARM_PERSONA_ROUTING_MODE ?? "off",
): SpecialistConsultMode {
  if (value !== "off" && value !== "shadow" && value !== "enforce") {
    throw new Error(`SWARM_PERSONA_ROUTING_MODE must be off|shadow|enforce, got ${value}`);
  }
  return value;
}

export function resolveZoAskAuthorization(
  env: Record<string, string | undefined> = process.env,
): string {
  const identityToken = env.ZO_CLIENT_IDENTITY_TOKEN?.trim();
  if (identityToken) return identityToken;
  const apiKey = env.ZO_API_KEY?.trim();
  if (apiKey) return `Bearer ${apiKey}`;
  throw new Error("ZO_CLIENT_IDENTITY_TOKEN or ZO_API_KEY not set");
}

export async function invokeZoSpecialist(
  request: SpecialistInvocationRequest,
): Promise<SpecialistInvocationResponse> {
  const authorization = resolveZoAskAuthorization();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(ZO_ASK_URL, {
      method: "POST",
      headers: {
        authorization,
        connection: "close",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: request.input,
        model_name: request.modelName,
        persona_id: request.personaId,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`/zo/ask returned ${response.status}: ${await response.text()}`);
    const payload = await response.json() as Record<string, unknown>;
    const usage = payload.usage && typeof payload.usage === "object"
      ? payload.usage as Record<string, unknown>
      : {};
    return {
      output: responseOutput(payload),
      modelName: typeof payload.model_name === "string" ? payload.model_name : request.modelName,
      costUsd: finiteCost(payload.cost_usd) ?? finiteCost(usage.cost_usd),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(
  options: Pick<ConsultSpecialistsOptions, "taskId" | "task" | "phase" | "implementationOutput">,
  persona: ResolvedPersona,
): string {
  if (options.phase === "advise") {
    return [
      `You are the ${persona.name} specialist advising task ${options.taskId}.`,
      "Give concrete implementation guidance, edge cases, and verification criteria.",
      "Do not mutate files or external systems. The primary executor retains implementation authority.",
      "",
      options.task,
    ].join("\n");
  }
  return [
    `You are the ${persona.name} specialist reviewing task ${options.taskId}.`,
    "Review the implementation result for material defects, missing requirements, and verification gaps.",
    "Do not mutate files or external systems.",
    'Return strict JSON only: {"verdict":"pass"|"fail","summary":"..."}.',
    "Use fail when any material defect, missing requirement, or verification gap remains.",
    "",
    `Task:\n${options.task}`,
    "",
    `Implementation result:\n${options.implementationOutput ?? ""}`,
  ].join("\n");
}

function baseEvidence(
  assignment: SpecialistAssignment,
  phase: SpecialistConsultPhase,
  status: SpecialistConsultStatus,
  reason: string | null,
): SpecialistConsultEvidence {
  return {
    roleId: assignment.roleId,
    phase,
    required: assignment.required,
    personaName: assignment.personaName,
    personaId: null,
    status,
    modelName: null,
    promptSha256: null,
    outputSha256: null,
    output: null,
    costUsd: null,
    verdict: null,
    summary: null,
    modelVendor: null,
    implementerModelName: null,
    implementerVendor: null,
    distinctModel: null,
    vendorDiverse: null,
    reason,
  };
}

function reviewerSelection(options: ConsultSpecialistsOptions): SpecialistReviewerSelection {
  return selectIndependentReviewerModel({
    implementerModelName: options.implementerModelName ?? "",
    implementerVendor: options.implementerVendor,
    policy: options.reviewerPolicy,
  });
}

function actualReviewerIdentity(
  responseModelName: string,
  selected: SpecialistReviewerSelection,
): Pick<SpecialistReviewerSelection, "modelName" | "vendor" | "distinctModel" | "vendorDiverse"> {
  const modelName = responseModelName.trim();
  const vendor = resolveModelVendor(modelName, modelName === selected.modelName ? selected.vendor : undefined);
  if (!vendor) throw new Error(`served specialist reviewer vendor is unresolved for ${modelName}`);
  return {
    modelName,
    vendor,
    distinctModel: modelName !== selected.implementerModelName,
    vendorDiverse: vendor !== selected.implementerVendor,
  };
}

export async function consultSpecialists(
  options: ConsultSpecialistsOptions,
): Promise<SpecialistConsultResult> {
  const assignments = options.assignments.filter((assignment) => assignment.phases.includes(options.phase));
  if (assignments.length > MAX_SPECIALISTS_PER_PHASE) {
    throw new Error(`specialist assignment count ${assignments.length} exceeds cap ${MAX_SPECIALISTS_PER_PHASE}`);
  }
  for (const assignment of assignments) {
    if (assignment.invocationCap !== undefined && assignment.invocationCap < 1) {
      throw new Error(`specialist ${assignment.roleId} has invalid invocation cap ${assignment.invocationCap}`);
    }
  }
  if (options.mode === "off" || assignments.length === 0) {
    return {
      ok: true,
      mode: options.mode,
      phase: options.phase,
      directorySnapshotHash: null,
      evidence: [],
      totalCostUsd: 0,
      blockedReason: null,
    };
  }

  const resolution = await resolvePersonas({
    mode: options.mode,
    roles: assignments.map((assignment) => ({
      role_id: assignment.roleId,
      selector: assignment.personaName,
      required: assignment.required,
      required_scopes: (assignment.requiredScopes ?? ["files:read"]).filter((scope) => scope !== "files:write"),
    })),
    listPersonas: options.listPersonas ?? createZoMcpListPersonasCaller(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const byRole = new Map(assignments.map((assignment) => [assignment.roleId, assignment]));
  const evidence: SpecialistConsultEvidence[] = [];

  for (const omitted of resolution.omitted) {
    const assignment = byRole.get(omitted.role_id);
    if (assignment) evidence.push(baseEvidence(assignment, options.phase, "omitted", omitted.reason));
  }
  for (const failure of resolution.failures) {
    const assignment = byRole.get(failure.role_id);
    if (assignment) evidence.push(baseEvidence(assignment, options.phase, "blocked", failure.message));
  }
  if (!resolution.ok) {
    const blockedReason = resolution.failures.map((failure) => failure.message).join("; ");
    return {
      ok: false,
      mode: options.mode,
      phase: options.phase,
      directorySnapshotHash: resolution.snapshot?.snapshot_hash ?? null,
      evidence,
      totalCostUsd: 0,
      blockedReason,
    };
  }

  let selectedReviewer: SpecialistReviewerSelection | null = null;
  let reviewerSelectionFailure: string | null = null;
  if (options.phase === "review") {
    try {
      selectedReviewer = reviewerSelection(options);
    } catch (error) {
      reviewerSelectionFailure = error instanceof Error ? error.message : String(error);
    }
  }

  if (options.mode === "shadow") {
    for (const persona of resolution.resolved) {
      const assignment = byRole.get(persona.role_id)!;
      if (reviewerSelectionFailure) {
        evidence.push(baseEvidence(
          assignment,
          options.phase,
          assignment.required ? "blocked" : "omitted",
          reviewerSelectionFailure,
        ));
        continue;
      }
      evidence.push({
        ...baseEvidence(assignment, options.phase, "would_invoke", null),
        personaId: persona.persona_id,
        modelName: selectedReviewer?.modelName ?? options.modelName ?? persona.model,
        modelVendor: selectedReviewer?.vendor ?? resolveModelVendor(options.modelName ?? persona.model ?? ""),
        implementerModelName: selectedReviewer?.implementerModelName ?? null,
        implementerVendor: selectedReviewer?.implementerVendor ?? null,
        distinctModel: selectedReviewer?.distinctModel ?? null,
        vendorDiverse: selectedReviewer?.vendorDiverse ?? null,
      });
    }
    return {
      ok: true,
      mode: options.mode,
      phase: options.phase,
      directorySnapshotHash: resolution.snapshot?.snapshot_hash ?? null,
      evidence,
      totalCostUsd: 0,
      blockedReason: null,
    };
  }

  const invoke = options.invokePersona ?? invokeZoSpecialist;
  let totalCostUsd = 0;
  let blockedReason: string | null = null;
  for (const persona of resolution.resolved) {
    const assignment = byRole.get(persona.role_id)!;
    if (reviewerSelectionFailure) {
      evidence.push(baseEvidence(
        assignment,
        options.phase,
        assignment.required ? "blocked" : "omitted",
        reviewerSelectionFailure,
      ));
      if (assignment.required) {
        blockedReason = blockedReason ? `${blockedReason}; ${reviewerSelectionFailure}` : reviewerSelectionFailure;
      }
      continue;
    }
    const modelName = selectedReviewer?.modelName ?? options.modelName ?? persona.model;
    if (!modelName) {
      const reason = `No explicit or persona-default model is available for ${persona.name}`;
      evidence.push(baseEvidence(assignment, options.phase, assignment.required ? "blocked" : "omitted", reason));
      if (assignment.required) blockedReason = blockedReason ? `${blockedReason}; ${reason}` : reason;
      continue;
    }
    const prompt = buildPrompt(options, persona);
    try {
      const response = await invoke({
        input: prompt,
        modelName,
        personaId: persona.persona_id,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const costUsd = response.costUsd ?? 0;
      totalCostUsd += costUsd;
      const base = {
        ...baseEvidence(assignment, options.phase, "invoked", null),
        personaId: persona.persona_id,
        modelName: response.modelName,
        promptSha256: sha256(prompt),
        outputSha256: sha256(response.output),
        output: response.output,
        costUsd: response.costUsd,
      } satisfies SpecialistConsultEvidence;
      if (options.phase === "review" && selectedReviewer) {
        try {
          const actual = actualReviewerIdentity(response.modelName, selectedReviewer);
          const requireDistinctModel = options.reviewerPolicy?.requireDistinctModel ?? true;
          const requireVendorDiversity = options.reviewerPolicy?.requireVendorDiversity ?? true;
          const parsed = parseSpecialistReviewVerdict(response.output);
          const reason = !actual.distinctModel && requireDistinctModel
            ? `served specialist reviewer model ${actual.modelName} matches implementer model`
            : !actual.vendorDiverse && requireVendorDiversity
              ? `served specialist reviewer vendor ${actual.vendor} matches implementer vendor`
              : parsed.verdict === "fail" ? parsed.summary : null;
          evidence.push({
            ...base,
            verdict: parsed.verdict,
            summary: parsed.summary,
            modelVendor: actual.vendor,
            implementerModelName: selectedReviewer.implementerModelName,
            implementerVendor: selectedReviewer.implementerVendor,
            distinctModel: actual.distinctModel,
            vendorDiverse: actual.vendorDiverse,
            reason,
          });
          if (assignment.required && reason) {
            blockedReason = blockedReason ? `${blockedReason}; ${reason}` : reason;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          evidence.push({
            ...base,
            modelVendor: selectedReviewer.vendor,
            implementerModelName: selectedReviewer.implementerModelName,
            implementerVendor: selectedReviewer.implementerVendor,
            distinctModel: selectedReviewer.distinctModel,
            vendorDiverse: selectedReviewer.vendorDiverse,
            reason,
          });
          if (assignment.required) blockedReason = blockedReason ? `${blockedReason}; ${reason}` : reason;
        }
      } else {
        evidence.push({
          ...base,
          modelVendor: resolveModelVendor(response.modelName),
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      evidence.push(baseEvidence(assignment, options.phase, assignment.required ? "blocked" : "omitted", reason));
      if (assignment.required) blockedReason = blockedReason ? `${blockedReason}; ${reason}` : reason;
    }
  }
  return {
    ok: blockedReason === null,
    mode: options.mode,
    phase: options.phase,
    directorySnapshotHash: resolution.snapshot?.snapshot_hash ?? null,
    evidence,
    totalCostUsd,
    blockedReason,
  };
}

export function renderSpecialistOutputs(result: SpecialistConsultResult): string {
  return result.evidence
    .filter((entry) => entry.status === "invoked" && entry.output)
    .map((entry) => `### ${entry.personaName} (${entry.phase})\n${entry.output}`)
    .join("\n\n");
}
