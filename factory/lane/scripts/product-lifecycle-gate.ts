import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  readFactoryStateMutationCycleId,
  recordFactoryStateAtomicReplacement,
} from "./factory-state-mutation-evidence";
import { sourceHash } from "./intake-ledger";
import { resolveExecutionRepository } from "./execution-repository";
import { parseContractFields } from "./risk-classifier";

export type ProductGateMode = "off" | "shadow" | "enforce";
export type ProductApplicability = "required" | "not_applicable";
export type ProductPreflightDecision = "off" | "pass" | "hold" | "not_applicable";
export type ProductLaunchDecision = ProductPreflightDecision;
export type ProductionReadyVerdict =
  | "launch-ready"
  | "launch-with-monitoring"
  | "private-beta-only"
  | "do-not-launch";

export interface ProductGateTicket {
  linear_id: string;
  identifier: string;
  title: string;
  description: string;
  labels?: string[];
}

export interface ProductContextEvidence {
  repo_path: string | null;
  path: string | null;
  source: "explicit" | "root" | "agents-context" | "docs" | "none";
  sha256: string | null;
  valid: boolean;
  reason: string;
  ticket_source_hash: string;
}

export interface ProductPreflightResult {
  phase: "pre_dispatch";
  mode: ProductGateMode;
  applicability: ProductApplicability;
  decision: ProductPreflightDecision;
  acted: boolean;
  reason_code: string;
  archetype: string;
  evidence: ProductContextEvidence;
  comment_posted: boolean;
  evaluated_at: string;
}

export interface ProductLaunchResult {
  phase: "post_verification";
  mode: ProductGateMode;
  applicability: ProductApplicability;
  decision: ProductLaunchDecision;
  acted: boolean;
  reason_code: string;
  verdict: ProductionReadyVerdict | null;
  report_path: string | null;
  report_sha256: string | null;
  context_sha256: string | null;
  audit_exit_code: number | null;
  audit_error: string | null;
  evaluated_at: string;
}

export interface ProductGateState {
  schema_version: 1;
  ticket_id: string;
  identifier: string;
  preflight: ProductPreflightResult;
  launch?: ProductLaunchResult;
  updated_at: string;
}

export interface AuditRunResult {
  status: number | null;
  error?: string;
  stderr?: string;
}

export interface ProductGateDeps {
  now: () => Date;
  resolveRepo: (targetRepo: string | undefined) => string;
  exists: (path: string) => boolean;
  read: (path: string) => string;
  writeState: (ticket: ProductGateTicket, preflight: ProductPreflightResult, launch?: ProductLaunchResult) => void;
  postHoldComment: (ticket: ProductGateTicket, result: ProductPreflightResult) => Promise<boolean>;
  runAudit: (repoPath: string, outDir: string) => AuditRunResult;
  stateDir: string;
}

const FACTORY_ROOT = join(import.meta.dir, "..");
const DEFAULT_STATE_DIR = factoryStatePath("product-gate");
const AUDIT_SCRIPT = "/home/workspace/Skills/production-ready/scripts/audit.ts";
const EXEMPT_ARCHETYPES = new Set([
  "bugfix",
  "bug",
  "fix",
  "refactor",
  "migration",
  "dependency",
  "dependencies",
  "docs",
  "documentation",
  "test",
  "tests",
  "ops",
  "infra",
  "infrastructure",
  "security",
]);
const VALID_VERDICTS = new Set<ProductionReadyVerdict>([
  "launch-ready",
  "launch-with-monitoring",
  "private-beta-only",
  "do-not-launch",
]);
const PASSING_VERDICTS = new Set<ProductionReadyVerdict>([
  "launch-ready",
  "launch-with-monitoring",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function scalarField(description: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const frontmatter = description.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatter) {
    const match = frontmatter[1].match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"));
    if (match?.[1]) return match[1].trim().replace(/^['"]|['"]$/g, "");
  }
  const headerName = name.replace(/_/g, "[ _-]");
  const header = description.match(new RegExp(`^##\\s+${headerName}\\s*$\\r?\\n([\\s\\S]*?)(?=^##\\s|$)`, "im"));
  if (header?.[1]) return header[1].trim().split(/\r?\n/)[0]?.trim() || null;
  const bold = description.match(new RegExp(`\\*\\*${headerName}:\\*\\*\\s*(.+)$`, "im"));
  return bold?.[1]?.trim() || null;
}

function normalizedDirective(value: string | null): ProductApplicability | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["required", "yes", "true", "discovery_required"].includes(normalized)) return "required";
  if (["not_applicable", "n/a", "na", "no", "false", "exempt"].includes(normalized)) return "not_applicable";
  return null;
}

export function productGateMode(env: Record<string, string | undefined> = process.env): ProductGateMode {
  if (env.FACTORY_PRODUCT_GATE_ENFORCE === "1") return "enforce";
  if (env.FACTORY_PRODUCT_GATE === "1") return "shadow";
  return "off";
}

export function classifyProductApplicability(ticket: ProductGateTicket): {
  applicability: ProductApplicability;
  archetype: string;
  reason: string;
} {
  const labels = new Set((ticket.labels ?? []).map((label) => label.trim().toLowerCase()));
  const labelRequired = labels.has("product-discovery-required");
  const labelExempt = labels.has("product-discovery-not-applicable") || labels.has("product-discovery-na");
  if (labelRequired && labelExempt) {
    return { applicability: "required", archetype: "conflict", reason: "conflicting product-discovery labels" };
  }
  if (labelRequired) return { applicability: "required", archetype: "explicit", reason: "required by label" };
  if (labelExempt) return { applicability: "not_applicable", archetype: "explicit", reason: "exempt by label" };

  const directive = normalizedDirective(scalarField(ticket.description || "", "product_discovery"));
  if (directive) return { applicability: directive, archetype: "explicit", reason: "explicit ticket directive" };

  const fields = parseContractFields(ticket.description || "");
  const archetype = (fields.archetype || "unknown").trim().toLowerCase().replace(/[\s_-]+/g, "-");
  if (EXEMPT_ARCHETYPES.has(archetype)) {
    return { applicability: "not_applicable", archetype, reason: `exempt archetype: ${archetype}` };
  }
  return { applicability: "required", archetype, reason: `product context required for archetype: ${archetype}` };
}

function contextCandidates(repoPath: string, explicitPath: string | null): Array<{
  path: string;
  source: ProductContextEvidence["source"];
}> {
  const candidates: Array<{ path: string; source: ProductContextEvidence["source"] }> = [];
  if (explicitPath) {
    if (isAbsolute(explicitPath)) throw new Error("product_context must be repository-relative");
    const absolute = resolve(repoPath, explicitPath);
    const child = relative(repoPath, absolute);
    if (child.startsWith("..") || isAbsolute(child)) throw new Error("product_context escapes target repository");
    candidates.push({ path: absolute, source: "explicit" });
  }
  for (const name of ["PRODUCT.md", "Product.md", "product.md"]) {
    candidates.push({ path: join(repoPath, name), source: "root" });
    candidates.push({ path: join(repoPath, ".agents", "context", name), source: "agents-context" });
    candidates.push({ path: join(repoPath, "docs", name), source: "docs" });
  }
  return candidates;
}

export function inspectProductContext(
  ticket: ProductGateTicket,
  repoPath: string,
  deps: Pick<ProductGateDeps, "exists" | "read">,
): ProductContextEvidence {
  const ticketHash = sourceHash(ticket.title, ticket.description || "");
  let candidates: ReturnType<typeof contextCandidates>;
  try {
    candidates = contextCandidates(repoPath, scalarField(ticket.description || "", "product_context"));
  } catch (error) {
    return {
      repo_path: repoPath,
      path: null,
      source: "none",
      sha256: null,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
      ticket_source_hash: ticketHash,
    };
  }

  const found = candidates.find((candidate) => deps.exists(candidate.path));
  if (!found) {
    return {
      repo_path: repoPath,
      path: null,
      source: "none",
      sha256: null,
      valid: false,
      reason: "PRODUCT.md not found",
      ticket_source_hash: ticketHash,
    };
  }

  let content: string;
  try {
    content = deps.read(found.path);
  } catch (error) {
    return {
      repo_path: repoPath,
      path: relative(repoPath, found.path),
      source: found.source,
      sha256: null,
      valid: false,
      reason: `PRODUCT.md unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ticket_source_hash: ticketHash,
    };
  }

  const trimmed = content.trim();
  const placeholder = /\[TODO\]/i.test(trimmed);
  const valid = trimmed.length >= 200 && !placeholder;
  return {
    repo_path: repoPath,
    path: relative(repoPath, found.path),
    source: found.source,
    sha256: sha256(content),
    valid,
    reason: valid
      ? "PRODUCT.md is present and non-placeholder"
      : placeholder
        ? "PRODUCT.md contains [TODO]"
        : `PRODUCT.md is too short (${trimmed.length} chars; minimum 200)`,
    ticket_source_hash: ticketHash,
  };
}

function offEvidence(ticket: ProductGateTicket): ProductContextEvidence {
  return {
    repo_path: null,
    path: null,
    source: "none",
    sha256: null,
    valid: false,
    reason: "product lifecycle gate is disabled",
    ticket_source_hash: sourceHash(ticket.title, ticket.description || ""),
  };
}

function defaultRunAudit(repoPath: string, outDir: string): AuditRunResult {
  const result = spawnSync(
    "bun",
    productionReadyAuditArgs(repoPath, outDir),
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 15 * 60 * 1000 },
  );
  return {
    status: result.status,
    error: result.error?.message,
    stderr: result.stderr?.trim(),
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function defaultWriteState(
  stateDir: string,
  ticket: ProductGateTicket,
  preflight: ProductPreflightResult,
  launch?: ProductLaunchResult,
): void {
  const path = join(stateDir, `${safeId(ticket.identifier)}.json`);
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Partial<ProductGateState> : {};
  const state: ProductGateState = {
    schema_version: 1,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    preflight,
    ...(launch ? { launch } : current.launch ? { launch: current.launch } : {}),
    updated_at: (launch?.evaluated_at ?? preflight.evaluated_at),
  };
  if (existsSync(path)) {
    const stateRoot = dirname(stateDir);
    const laneLogPath = join(stateRoot, "lane-utilization.jsonl");
    const currentCyclePath = `${laneLogPath}.current-cycle`;
    const beforePayload = readFileSync(path, "utf8");
    const afterPayload = `${JSON.stringify(state, null, 2)}\n`;
    const evidence = recordFactoryStateAtomicReplacement({
      stateDir: stateRoot,
      producerId: "product-lifecycle-gate",
      requestedCycleId: readFactoryStateMutationCycleId(currentCyclePath),
      sentinelPath: currentCyclePath,
      laneLogPath,
      targetPath: relative(stateRoot, path),
      targetSchema: "product-gate/v1",
      beforePayload,
      afterPayload,
      recordedAt: state.updated_at,
    });
    if (evidence.would_reject && evidence.mode === "shadow") {
      console.error(`product-lifecycle-gate: mutation evidence would reject (${evidence.reason})`);
    }
  }
  atomicWriteJson(path, state);
}

async function defaultPostHoldComment(ticket: ProductGateTicket, result: ProductPreflightResult): Promise<boolean> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return false;
  const body = [
    "**Factory product gate held this ticket.**",
    "",
    `Reason: ${result.evidence.reason}`,
    "",
    "Run the Impeccable `teach` workflow for the target repository, complete its operator interview, and commit the resulting `PRODUCT.md`. Then re-apply `factory-ready`.",
    "",
    `Evidence: mode=${result.mode}, archetype=${result.archetype}, ticket_source_hash=${result.evidence.ticket_source_hash}`,
  ].join("\n");
  const response = await fetch(process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "mutation ProductGateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
      variables: { input: { issueId: ticket.linear_id, body } },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return false;
  const payload = await response.json() as { data?: { commentCreate?: { success?: boolean } } };
  return payload.data?.commentCreate?.success === true;
}

function dependencies(overrides: Partial<ProductGateDeps> = {}): ProductGateDeps {
  const stateDir = overrides.stateDir ?? process.env.FACTORY_PRODUCT_GATE_STATE_DIR ?? DEFAULT_STATE_DIR;
  return {
    now: overrides.now ?? (() => new Date()),
    resolveRepo: overrides.resolveRepo ?? ((targetRepo) => resolveExecutionRepository(targetRepo)),
    exists: overrides.exists ?? existsSync,
    read: overrides.read ?? ((path) => readFileSync(path, "utf8")),
    writeState: overrides.writeState ?? ((ticket, preflight, launch) => defaultWriteState(stateDir, ticket, preflight, launch)),
    postHoldComment: overrides.postHoldComment ?? defaultPostHoldComment,
    runAudit: overrides.runAudit ?? defaultRunAudit,
    stateDir,
  };
}

function alreadyCommented(
  ticket: ProductGateTicket,
  result: ProductPreflightResult,
  deps: ProductGateDeps,
): boolean {
  const path = productGateStatePath(ticket.identifier, deps.stateDir);
  if (!deps.exists(path)) return false;
  try {
    const previous = JSON.parse(deps.read(path)) as Partial<ProductGateState>;
    return previous.ticket_id === ticket.linear_id
      && previous.preflight?.decision === "hold"
      && previous.preflight.comment_posted === true
      && previous.preflight.reason_code === result.reason_code
      && previous.preflight.evidence?.ticket_source_hash === result.evidence.ticket_source_hash;
  } catch {
    return false;
  }
}

export async function runProductPreflight(
  ticket: ProductGateTicket,
  options: {
    env?: Record<string, string | undefined>;
    deps?: Partial<ProductGateDeps>;
    persist?: boolean;
    mutate?: boolean;
  } = {},
): Promise<ProductPreflightResult> {
  const deps = dependencies(options.deps);
  const mode = productGateMode(options.env);
  const classification = classifyProductApplicability(ticket);
  const evaluatedAt = deps.now().toISOString();

  if (mode === "off") {
    return {
      phase: "pre_dispatch",
      mode,
      applicability: classification.applicability,
      decision: "off",
      acted: false,
      reason_code: "gate_off",
      archetype: classification.archetype,
      evidence: offEvidence(ticket),
      comment_posted: false,
      evaluated_at: evaluatedAt,
    };
  }

  if (classification.applicability === "not_applicable") {
    const result: ProductPreflightResult = {
      phase: "pre_dispatch",
      mode,
      applicability: "not_applicable",
      decision: "not_applicable",
      acted: false,
      reason_code: "not_applicable",
      archetype: classification.archetype,
      evidence: {
        ...offEvidence(ticket),
        reason: classification.reason,
      },
      comment_posted: false,
      evaluated_at: evaluatedAt,
    };
    if (options.persist !== false) deps.writeState(ticket, result);
    return result;
  }

  let evidence: ProductContextEvidence;
  try {
    const targetRepo = parseContractFields(ticket.description || "").target_repo;
    const repoPath = deps.resolveRepo(targetRepo);
    evidence = inspectProductContext(ticket, repoPath, deps);
  } catch (error) {
    evidence = {
      ...offEvidence(ticket),
      reason: `target repository unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const decision: ProductPreflightDecision = evidence.valid ? "pass" : "hold";
  const result: ProductPreflightResult = {
    phase: "pre_dispatch",
    mode,
    applicability: "required",
    decision,
    acted: mode === "enforce" && decision === "hold",
    reason_code: evidence.valid ? "context_valid" : "context_missing_or_invalid",
    archetype: classification.archetype,
    evidence,
    comment_posted: false,
    evaluated_at: evaluatedAt,
  };

  if (result.acted && options.mutate !== false) {
    if (alreadyCommented(ticket, result, deps)) {
      result.comment_posted = true;
    } else {
      try {
        result.comment_posted = await deps.postHoldComment(ticket, result);
      } catch {
        result.comment_posted = false;
      }
    }
  }
  if (options.persist !== false) deps.writeState(ticket, result);
  return result;
}

function launchResult(
  preflight: ProductPreflightResult,
  values: Partial<ProductLaunchResult> & Pick<ProductLaunchResult, "decision" | "reason_code">,
  now: string,
): ProductLaunchResult {
  return {
    phase: "post_verification",
    mode: preflight.mode,
    applicability: preflight.applicability,
    decision: values.decision,
    acted: preflight.mode === "enforce" && values.decision === "hold",
    reason_code: values.reason_code,
    verdict: values.verdict ?? null,
    report_path: values.report_path ?? null,
    report_sha256: values.report_sha256 ?? null,
    context_sha256: values.context_sha256 ?? preflight.evidence.sha256,
    audit_exit_code: values.audit_exit_code ?? null,
    audit_error: values.audit_error ?? null,
    evaluated_at: now,
  };
}

export function runProductLaunchGate(
  ticket: ProductGateTicket,
  preflight: ProductPreflightResult,
  executionId: string,
  options: { deps?: Partial<ProductGateDeps>; persist?: boolean } = {},
): ProductLaunchResult {
  const deps = dependencies(options.deps);
  const evaluatedAt = deps.now().toISOString();
  let result: ProductLaunchResult;

  if (preflight.mode === "off") {
    result = launchResult(preflight, { decision: "off", reason_code: "gate_off" }, evaluatedAt);
  } else if (preflight.applicability === "not_applicable") {
    result = launchResult(preflight, { decision: "not_applicable", reason_code: "not_applicable" }, evaluatedAt);
  } else if (!preflight.evidence.repo_path || !preflight.evidence.sha256) {
    result = launchResult(preflight, {
      decision: "hold",
      reason_code: "preflight_evidence_missing",
      audit_error: "preflight product context evidence is incomplete",
    }, evaluatedAt);
  } else {
    const current = inspectProductContext(ticket, preflight.evidence.repo_path, deps);
    if (!current.valid || current.sha256 !== preflight.evidence.sha256) {
      result = launchResult(preflight, {
        decision: "hold",
        reason_code: "context_hash_drift",
        context_sha256: current.sha256,
        audit_error: current.valid ? "PRODUCT.md changed after dispatch" : current.reason,
      }, evaluatedAt);
    } else {
      const outDir = join(deps.stateDir, "audits", safeId(executionId));
      mkdirSync(outDir, { recursive: true });
      const audit = deps.runAudit(preflight.evidence.repo_path, outDir);
      const verdictPath = join(outDir, "verdict.json");
      if (audit.error || audit.status === null || audit.status === 10 || !deps.exists(verdictPath)) {
        result = launchResult(preflight, {
          decision: "hold",
          reason_code: "audit_error",
          audit_exit_code: audit.status,
          audit_error: audit.error || audit.stderr || "production-ready verdict.json missing",
        }, evaluatedAt);
      } else {
        try {
          const reportSource = deps.read(verdictPath);
          const parsed = JSON.parse(reportSource) as { verdict?: unknown };
          const verdict = typeof parsed.verdict === "string" && VALID_VERDICTS.has(parsed.verdict as ProductionReadyVerdict)
            ? parsed.verdict as ProductionReadyVerdict
            : null;
          if (!verdict) throw new Error("production-ready verdict is missing or invalid");
          result = launchResult(preflight, {
            decision: PASSING_VERDICTS.has(verdict) ? "pass" : "hold",
            reason_code: PASSING_VERDICTS.has(verdict) ? "audit_pass" : "audit_blocked",
            verdict,
            report_path: verdictPath,
            report_sha256: sha256(reportSource),
            audit_exit_code: audit.status,
          }, evaluatedAt);
        } catch (error) {
          result = launchResult(preflight, {
            decision: "hold",
            reason_code: "audit_report_invalid",
            report_path: verdictPath,
            audit_exit_code: audit.status,
            audit_error: error instanceof Error ? error.message : String(error),
          }, evaluatedAt);
        }
      }
    }
  }

  if (options.persist !== false) deps.writeState(ticket, preflight, result);
  return result;
}

export function productGateArtifact(result: ProductLaunchResult | undefined): string[] {
  return result?.report_path ? [result.report_path] : [];
}

export function productLaunchFailureResult(
  preflight: ProductPreflightResult,
  error: unknown,
  evaluatedAt = new Date().toISOString(),
): ProductLaunchResult {
  return launchResult(preflight, {
    decision: "hold",
    reason_code: "gate_runtime_error",
    audit_error: error instanceof Error ? error.message : String(error),
  }, evaluatedAt);
}

export function productGateSummary(result: ProductPreflightResult | ProductLaunchResult): string {
  const subject = result.phase === "pre_dispatch" ? "product context" : "production readiness";
  return `${subject}: ${result.decision} (${result.reason_code}, mode=${result.mode}, acted=${result.acted})`;
}

export function productGateAuditScript(): string {
  return AUDIT_SCRIPT;
}

export function productionReadyAuditArgs(repoPath: string, outDir: string): string[] {
  return [AUDIT_SCRIPT, "--repo", repoPath, "--out", outDir, "--format", "json"];
}

export function productGateStatePath(identifier: string, stateDir = DEFAULT_STATE_DIR): string {
  return join(stateDir, `${safeId(identifier)}.json`);
}

export function productGateReportName(path: string | null): string | null {
  return path ? basename(path) : null;
}
