import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PersonaOrchestrationRecord } from "./persona-orchestrator";

export const FACTORY_EVIDENCE_VERSION = 1 as const;
export type EvidenceMode = "advisory" | "blocking";
export type EvidenceCheckStatus = "pass" | "fail" | "not_run";
export type PersonaParticipation = PersonaOrchestrationRecord | PersonaOrchestrationRecord[];

export interface AgentIdentity {
  model: string;
  provider: string;
}

export interface EvidenceCheck {
  status: EvidenceCheckStatus;
  evidence: string[];
  hashes: Record<string, string>;
}

export interface FactoryEvidenceManifest {
  schema_version: typeof FACTORY_EVIDENCE_VERSION;
  ticket: string;
  execution_id: string;
  commit_digest?: string;
  seed_hash: string | null;
  author: AgentIdentity;
  executor: AgentIdentity;
  reviewers: AgentIdentity[];
  review_evidence: EvidenceCheck;
  tests: string[];
  test_evidence: EvidenceCheck;
  artifacts: string[];
  trace_verification: EvidenceCheck;
  feature_contract: EvidenceCheck;
  supply_chain: EvidenceCheck & { attestation_hash: string | null };
  verdict: "pass" | "fail" | "pending";
  rollout_mode: EvidenceMode;
  override: { by: string; reason: string; at: string } | null;
  generated_at: string;
  content_hash: string;
  persona_participation?: PersonaParticipation;
}

type UnsignedManifest = Omit<FactoryEvidenceManifest, "content_hash">;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceHash(manifest: UnsignedManifest): string {
  return `sha256:${createHash("sha256").update(canonical(manifest)).digest("hex")}`;
}

export function identityKey(identity: AgentIdentity): string {
  return `${identity.provider.trim().toLowerCase()}:${identity.model.trim().toLowerCase()}`;
}

export function ticketAuthor(ticket: { description?: string }, fallback: AgentIdentity): AgentIdentity {
  const description = ticket.description ?? "";
  const model = description.match(/\*\*Author Model:\*\*\s*(.+)$/im)?.[1]?.trim();
  const provider = description.match(/\*\*Author Provider:\*\*\s*(.+)$/im)?.[1]?.trim();
  return { model: model || fallback.model, provider: provider || fallback.provider };
}

export function parseReviewerCandidates(value: string | undefined): AgentIdentity[] {
  if (!value) return [];
  return value.split(",").map((entry) => {
    const [provider, ...model] = entry.trim().split(":");
    return { provider: provider?.trim() || "unknown", model: model.join(":").trim() || "unknown" };
  }).filter((identity) => identity.provider !== "unknown" && identity.model !== "unknown");
}

export function independentReviewers(author: AgentIdentity, candidates: AgentIdentity[]): AgentIdentity[] {
  const authorKey = identityKey(author);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = identityKey(candidate);
    if (key === authorKey || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rolloutMode(ticket: { labels?: string[]; description?: string }): EvidenceMode {
  const forced = process.env.SF_EVIDENCE_MODE;
  if (forced === "blocking" || forced === "advisory") return forced;
  const labels = new Set((ticket.labels ?? []).map((label) => label.toLowerCase()));
  if (labels.has("evidence-v1") || /##\s+Evidence Contract\s*\n\s*v1\b/i.test(ticket.description ?? "")) {
    return "blocking";
  }
  return "advisory";
}

export function createEvidenceManifest(input: UnsignedManifest): FactoryEvidenceManifest {
  const normalized: UnsignedManifest = {
    ...input,
    reviewers: independentReviewers(input.author, input.reviewers),
    tests: [...new Set(input.tests)].sort(),
    artifacts: [...new Set(input.artifacts)].sort(),
  };
  return { ...normalized, content_hash: evidenceHash(normalized) };
}

export function personaParticipationRecords(value: PersonaParticipation | undefined): PersonaOrchestrationRecord[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function validateEvidenceManifest(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["manifest must be an object"];
  const manifest = raw as FactoryEvidenceManifest;
  if (manifest.schema_version !== FACTORY_EVIDENCE_VERSION) errors.push("schema_version must be 1");
  for (const key of ["ticket", "execution_id", "generated_at", "content_hash"] as const) {
    if (typeof manifest[key] !== "string" || manifest[key].trim() === "") errors.push(`${key} is required`);
  }
  if (manifest.commit_digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(manifest.commit_digest)) {
    errors.push("commit_digest must be sha256:<64 lowercase hex>");
  }
  if (!manifest.author || !manifest.executor) errors.push("author and executor identities are required");
  if (!Array.isArray(manifest.reviewers)) errors.push("reviewers must be an array");
  else if (manifest.reviewers.some((reviewer) => identityKey(reviewer) === identityKey(manifest.author))) {
    errors.push("author cannot review their own work");
  }
  if (!manifest.test_evidence || !manifest.trace_verification || !manifest.feature_contract || !manifest.supply_chain) {
    errors.push("test, trace, feature-contract, and supply-chain checks are required");
  }
  if (!manifest.review_evidence) errors.push("review evidence is required");
  const personaRecords = personaParticipationRecords(manifest.persona_participation);
  if (manifest.persona_participation && personaRecords.length === 0) errors.push("persona_participation must not be empty");
  const personaKeys = new Set<string>();
  for (const record of personaRecords) {
    errors.push(...validatePersonaParticipation(record));
    const key = `${record.campaign_id}/${record.task_id}`;
    if (personaKeys.has(key)) errors.push(`duplicate persona participation record: ${key}`);
    personaKeys.add(key);
  }
  for (const [name, check] of [
    ["review_evidence", manifest.review_evidence],
    ["test_evidence", manifest.test_evidence],
    ["trace_verification", manifest.trace_verification],
    ["feature_contract", manifest.feature_contract],
    ["supply_chain", manifest.supply_chain],
  ] as const) {
    if (!check) continue;
    if (!Array.isArray(check.evidence) || !check.hashes || typeof check.hashes !== "object") errors.push(`${name} evidence/hashes invalid`);
    else if (check.evidence.some((path) => !check.hashes[path])) errors.push(`${name} missing artifact hash`);
  }
  const { content_hash: _hash, ...unsigned } = manifest;
  if (manifest.content_hash !== evidenceHash(unsigned)) errors.push("content_hash mismatch");
  return errors;
}

function validSha256(value: string | null): boolean {
  return value !== null && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function validatePersonaParticipation(record: PersonaOrchestrationRecord): string[] {
  const errors: string[] = [];
  if (record.version !== 1) errors.push("persona_participation.version must be 1");
  if (typeof record.campaign_id !== "string" || record.campaign_id.trim() === "") errors.push("persona_participation.campaign_id is required");
  if (typeof record.task_id !== "string" || record.task_id.trim() === "") errors.push("persona_participation.task_id is required");
  if (!(["off", "shadow", "enforce"] as string[]).includes(record.mode)) errors.push("persona_participation.mode is invalid");
  if (!/^\d+\.\d+\.\d+$/.test(record.association?.version ?? "")) errors.push("persona association version is invalid");
  if (!/^[a-f0-9]{64}$/.test(record.association?.sha256 ?? "")) errors.push("persona association sha256 is invalid");
  if (record.directory.snapshot_hash !== null && !/^[a-f0-9]{64}$/.test(record.directory.snapshot_hash)) {
    errors.push("persona directory snapshot hash is invalid");
  }
  if (!Array.isArray(record.invocations)) return [...errors, "persona invocations must be an array"];
  for (const invocation of record.invocations) {
    const prefix = `persona ${invocation.role_id}/${invocation.phase}`;
    if (invocation.status === "invoked") {
      if (!invocation.persona_id || !invocation.persona_name) errors.push(`${prefix} invoked without resolved identity`);
      if (!invocation.requested_at || !invocation.completed_at) errors.push(`${prefix} invoked without timestamps`);
      if (!invocation.model_name || !invocation.resolved_model_name || invocation.harness !== "zo-ask") errors.push(`${prefix} invoked without separate model/harness dimensions`);
      if (!invocation.result_ref || !validSha256(invocation.result_sha256)) errors.push(`${prefix} invoked without result reference/hash`);
      if (invocation.phase !== "implement" && (!invocation.artifact_ref || !validSha256(invocation.artifact_sha256))) {
        errors.push(`${prefix} invoked without retained artifact/hash`);
      }
    }
    if (invocation.status === "would_invoke" && record.mode !== "shadow") errors.push(`${prefix} would_invoke outside shadow mode`);
    if (["would_invoke", "omitted", "not_invoked"].includes(invocation.status) && invocation.cost_usd !== null) {
      errors.push(`${prefix} has cost without a real call`);
    }
    if (invocation.phase === "review" && invocation.status === "invoked" && invocation.verdict === null) {
      errors.push(`${prefix} invoked without verdict`);
    }
    if (record.mode === "enforce" && invocation.phase === "review" && invocation.status === "invoked") {
      if (!invocation.model_vendor || !invocation.implementer_model_name || !invocation.implementer_vendor) {
        errors.push(`${prefix} invoked without reviewer/implementer model identity`);
      }
      if (invocation.distinct_model !== true) errors.push(`${prefix} did not use a distinct model`);
      if (invocation.vendor_diverse !== true) errors.push(`${prefix} did not use a vendor-diverse model`);
    }
  }
  return errors;
}

function personaPromotionBlockers(record: PersonaOrchestrationRecord): string[] {
  if (record.mode !== "enforce") return [];
  const errors = validatePersonaParticipation(record);
  if (record.blocked_reason) errors.push(`persona orchestration blocked: ${record.blocked_reason}`);
  for (const invocation of record.invocations) {
    if (invocation.required && invocation.status !== "invoked") {
      errors.push(`required persona ${invocation.role_id}/${invocation.phase} was not invoked`);
    }
    if (invocation.required && invocation.phase === "review" && invocation.verdict !== "pass") {
      errors.push(`required persona review ${invocation.role_id} did not pass`);
    }
    if (invocation.required && invocation.phase === "review" && invocation.distinct_model !== true) {
      errors.push(`required persona review ${invocation.role_id} did not use a distinct model`);
    }
    if (invocation.required && invocation.phase === "review" && invocation.vendor_diverse !== true) {
      errors.push(`required persona review ${invocation.role_id} did not use a vendor-diverse model`);
    }
    if (invocation.status === "invoked" && invocation.artifact_ref) {
      if (!existsSync(invocation.artifact_ref)) {
        errors.push(`persona artifact missing: ${invocation.artifact_ref}`);
      } else {
        const actual = sha256File(invocation.artifact_ref);
        if (invocation.artifact_sha256 !== actual) errors.push(`persona artifact hash mismatch: ${invocation.artifact_ref}`);
      }
    }
  }
  return errors;
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function promotionBlockers(manifest: FactoryEvidenceManifest): string[] {
  const errors: string[] = [];
  if (manifest.rollout_mode === "blocking" && manifest.override === null) {
    for (const record of personaParticipationRecords(manifest.persona_participation)) {
      errors.push(...personaPromotionBlockers(record));
    }
    if (manifest.verdict !== "pass") errors.push("manifest verdict must pass");
    for (const [name, check] of [
      ["review_evidence", manifest.review_evidence],
      ["test_evidence", manifest.test_evidence],
      ["trace_verification", manifest.trace_verification],
      ["feature_contract", manifest.feature_contract],
      ["supply_chain", manifest.supply_chain],
    ] as const) {
      if (check?.status !== "pass") errors.push(`${name} must pass in blocking mode`);
    }
    if ((manifest.reviewers?.length ?? 0) === 0) errors.push("blocking mode requires an independent reviewer");
    for (const [name, check] of [
      ["review_evidence", manifest.review_evidence],
      ["test_evidence", manifest.test_evidence],
      ["trace_verification", manifest.trace_verification],
      ["feature_contract", manifest.feature_contract],
      ["supply_chain", manifest.supply_chain],
    ] as const) {
      for (const path of check.evidence) {
        if (!existsSync(path)) { errors.push(`${name} artifact missing: ${path}`); continue; }
        const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
        if (check.hashes[path] !== actual) errors.push(`${name} artifact hash mismatch: ${path}`);
      }
    }
    for (const path of manifest.review_evidence.evidence) {
      try {
        const review = JSON.parse(readFileSync(path, "utf8")) as {
          execution_id?: string; verdict?: string; author?: AgentIdentity; reviewer?: AgentIdentity;
        };
        if (review.execution_id !== manifest.execution_id) errors.push(`review artifact execution mismatch: ${path}`);
        if (review.verdict !== "pass") errors.push(`review artifact must pass: ${path}`);
        if (!review.author || identityKey(review.author) !== identityKey(manifest.author)) errors.push(`review artifact author mismatch: ${path}`);
        if (!review.reviewer || !manifest.reviewers.some((candidate) => identityKey(candidate) === identityKey(review.reviewer!))) {
          errors.push(`review artifact reviewer mismatch: ${path}`);
        }
      } catch { errors.push(`review artifact is not valid JSON: ${path}`); }
    }
    for (const [name, check] of [
      ["test_evidence", manifest.test_evidence],
      ["trace_verification", manifest.trace_verification],
      ["feature_contract", manifest.feature_contract],
    ] as const) {
      for (const path of check.evidence) {
        try {
          const artifact = JSON.parse(readFileSync(path, "utf8")) as {
            execution_id?: string; status?: string; verdict?: string;
          };
          if (artifact.execution_id !== manifest.execution_id) errors.push(`${name} artifact execution mismatch: ${path}`);
          if (artifact.status !== "pass" && artifact.verdict !== "pass") errors.push(`${name} artifact must pass: ${path}`);
        } catch { errors.push(`${name} artifact is not valid JSON: ${path}`); }
      }
    }
  }
  return errors;
}

export function evidencePath(executionId: string, dir = factoryStatePath("evidence")): string {
  const safe = executionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return join(dir, `${safe}.evidence.json`);
}

export function writeEvidenceManifest(manifest: FactoryEvidenceManifest, dir?: string): string {
  const errors = validateEvidenceManifest(manifest);
  if (errors.length) throw new Error(`invalid factory evidence manifest: ${errors.join("; ")}`);
  const base = dir ?? factoryStatePath("evidence");
  const safe = manifest.execution_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const path = join(base, `${safe}.${manifest.content_hash.slice(7, 19)}.evidence.json`);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readEvidenceManifest(path);
    if (existing.content_hash === manifest.content_hash) return path;
    throw new Error(`refusing to replace write-once evidence manifest: ${path}`);
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return path;
}

export function readEvidenceManifest(path: string): FactoryEvidenceManifest {
  if (!existsSync(path)) throw new Error(`evidence manifest not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateEvidenceManifest(parsed);
  if (errors.length) throw new Error(`invalid factory evidence manifest: ${errors.join("; ")}`);
  return parsed as FactoryEvidenceManifest;
}
