#!/usr/bin/env bun
/**
 * PCG-004: Plan/sufficiency adapter for the consensus gate.
 *
 * Accepts YAML, JSON, and Markdown plan inputs and routes them through the
 * existing model panel in sufficiency mode — bypassing the arbiter (and
 * therefore any Bun/TSX syntax checks) that runs for code-review mode.
 *
 * Key invariant: provider failures (outage, timeout, malformed, empty) must
 * NEVER count as substantive rejections. They are separately typed and excluded
 * from the consensus calculation so a flaky provider cannot veto a valid plan.
 */

import * as crypto from "crypto";
import { getActiveModels } from "./quarantine";
import { normalizeLineupRole, type LineupRoleInput } from "./lineup-roles";

// ---------------------------------------------------------------------------
// Finding types — each category is separately typed
// ---------------------------------------------------------------------------

/**
 * Distinct categories for what a model returned.
 *
 * - substantive_rejection  Model reviewed the plan and found material issues.
 * - provider_outage        HTTP-level failure: 4xx/5xx, auth error, connection refused.
 * - timeout                Request was aborted or timed out before a response arrived.
 * - malformed_response     Response body is not parseable or missing the `pass` field.
 * - empty_output           Provider returned an empty response body.
 * - abstention             Model declined to evaluate the plan.
 * - out_of_scope           Model stated the plan falls outside its evaluation domain.
 */
export type PlanFindingType =
  | "substantive_rejection"
  | "provider_outage"
  | "timeout"
  | "malformed_response"
  | "empty_output"
  | "abstention"
  | "out_of_scope";

export interface PlanFinding {
  type: PlanFindingType;
  model: string;
  claim?: string;
  evidence?: string;
  severity?: "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// Raw verdict shape (structural match for consensus-gate's unexported Verdict)
// ---------------------------------------------------------------------------

interface RawVerdictLike {
  model: string;
  pass: boolean;
  issues: string[];
  dissent_claims?: Array<{
    claim: string;
    evidence?: string;
    severity?: "high" | "medium" | "low";
  }>;
  confidence: number;
  latencyMs: number;
  servingProvider?: string;
  servingModel?: string;
  usage?: { provider: string; inputTokens: number; outputTokens: number };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injectable vendor caller type — matches callVendorWithFallback's signature
 * narrowed to the "sufficiency" mode so the adapter always stays in plan-review
 * mode and never triggers code-review or judge prompts.
 */
export type PlanVendorCaller = (
  role: LineupRoleInput,
  plan: string,
  criteria: string,
  mode: "sufficiency",
) => Promise<RawVerdictLike>;

export interface PlanVerdictDetail {
  model: string;
  pass: boolean;
  /** null when the model passed without any notable failure pattern */
  findingType: PlanFindingType | null;
  issues: string[];
  confidence: number;
  latencyMs: number;
  servingProvider?: string;
}

export interface PlanConsensusResult {
  id: string;
  timestamp: string;
  label: string;
  inputFormat: "json" | "yaml" | "markdown" | "text";
  criteria: string;
  /** Overall gate decision (only substantive verdicts counted) */
  status: "passed" | "rejected" | "escalate";
  /** Structured findings — only substantive_rejection entries appear here */
  findings: PlanFinding[];
  verdicts: PlanVerdictDetail[];
  consensus: {
    pass: boolean | null;
    unanimous: boolean;
    confidence: number;
  };
}

export interface PlanReviewRequestLike {
  artifact: Record<string, unknown>;
  artifact_sha256: string;
  revision: number;
  gate_run_id: string;
}

export interface PlanReviewResultLike {
  verdicts: Array<{
    model: string;
    pass: boolean | null;
    confidence: number;
    finding_type:
      | "none"
      | "substantive"
      | "provider_failure"
      | "abstention"
      | "out_of_scope"
      | "malformed_output";
    claims: Array<{
      claim: string;
      evidence?: string;
      severity: "blocker" | "high" | "medium" | "low" | "info" | null;
      finding_type_actual?:
        | "substantive"
        | "provider_failure"
        | "abstention"
        | "out_of_scope"
        | "malformed_output";
    }>;
  }>;
  provider_health: Record<string, "healthy" | "degraded" | "unreachable" | "unknown">;
  call_accounting: {
    calls_made: number;
    calls_remaining: number;
    estimated_cost_usd: number;
    max_calls: number;
    max_cost_usd: number;
  };
  decision: "passed" | "rejected" | "escalate" | "unavailable";
}

export type PlanInputFormat = "json" | "yaml" | "markdown" | "text" | "auto";

export interface PlanConsensusOptions {
  label?: string;
  criteria?: string;
  /** Override the default panel (reads CONSENSUS_MODELS / quarantine when absent) */
  models?: LineupRoleInput[];
  inputFormat?: PlanInputFormat;
  /**
   * Injectable vendor caller for tests.
   * When absent, callVendorWithFallback is loaded via dynamic import so that
   * consensus-gate.ts's top-level parseArgs does not fire at module-load time.
   */
  _vendorCaller?: PlanVendorCaller;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the format of a plan string without executing it.
 * Returns "json" | "yaml" | "markdown" | "text".
 */
export function detectPlanFormat(input: string): "json" | "yaml" | "markdown" | "text" {
  const trimmed = input.trim();

  // JSON: starts with { or [ and parses cleanly
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && isValidJson(trimmed)) {
    return "json";
  }

  // Markdown: has ATX headers, triple-backtick fences, or horizontal rules
  if (
    /^#{1,6}\s+\S/m.test(trimmed) ||
    /^```/m.test(trimmed) ||
    /^---\s*$/m.test(trimmed)
  ) {
    return "markdown";
  }

  // YAML: key: value pairs at start of lines (not URL-like)
  if (
    /^[a-zA-Z_][a-zA-Z0-9_\-]*\s*:/m.test(trimmed) &&
    !/^https?:\/\//i.test(trimmed)
  ) {
    return "yaml";
  }

  return "text";
}

/**
 * Normalize plan content to a canonical safe string for model review.
 * NEVER executes, evaluates, or syntax-checks the content as code.
 */
export function normalizePlanContent(
  input: string,
  format: "json" | "yaml" | "markdown" | "text",
): string {
  if (format === "json") {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  // YAML, Markdown, and plain text pass through unchanged — they are safe strings
  return input;
}

// ---------------------------------------------------------------------------
// Finding-type classification
// ---------------------------------------------------------------------------

const PROVIDER_FAILURE_PREFIXES = ["API error:", "Call failed:"];

const TIMEOUT_PATTERNS = [
  /\babort(?:ed)?\b/i,
  /\btimeout\b/i,
  /\btimed\s+out\b/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
];

const ABSTENTION_PATTERNS = [
  /cannot\s+(?:review|assess|evaluate)/i,
  /unable\s+to\s+(?:review|assess|evaluate)/i,
  /i\s+(?:am\s+)?(?:unable\s+to|cannot)\s+(?:review|assess|evaluate|provide)/i,
  /not\s+able\s+to\s+(?:review|evaluate)/i,
  /i\s+must\s+(?:decline|refuse)/i,
];

const OUT_OF_SCOPE_PATTERNS = [
  /out.of.scope/i,
  /outside\s+(?:my|the)\s+scope/i,
  /not\s+within\s+(?:my|the)\s+scope/i,
  /beyond\s+(?:my|the)\s+scope/i,
  /outside\s+(?:my|the)\s+domain/i,
];

/**
 * Classify raw verdict issues into a PlanFindingType.
 *
 * Provider failures are checked first and have highest precedence — they MUST
 * NEVER return "substantive_rejection" regardless of the pass field value.
 * Returns null when the model passed with no notable issue pattern.
 */
export function classifyVerdictIssues(
  issues: string[],
  pass: boolean,
  claimsText?: string[],
): PlanFindingType | null {
  // Provider failure patterns — highest precedence
  const hasProviderFailure = issues.some((i) =>
    PROVIDER_FAILURE_PREFIXES.some((prefix) => i.startsWith(prefix)),
  );
  if (hasProviderFailure) {
    const isTimeout = issues.some((i) => TIMEOUT_PATTERNS.some((rx) => rx.test(i)));
    return isTimeout ? "timeout" : "provider_outage";
  }

  if (issues.some((i) => i === "Empty response from vendor")) return "empty_output";
  if (issues.some((i) => i.startsWith("Unparseable verdict"))) return "malformed_response";

  // Abstention and out-of-scope — detected in both issues and claims text
  const allText = [...issues, ...(claimsText ?? [])];
  if (allText.some((t) => ABSTENTION_PATTERNS.some((rx) => rx.test(t)))) return "abstention";
  if (allText.some((t) => OUT_OF_SCOPE_PATTERNS.some((rx) => rx.test(t)))) return "out_of_scope";

  // If the model passed with no concerning pattern, no finding type
  if (pass) return null;

  // Default: substantive rejection (model reviewed the plan and found issues)
  return "substantive_rejection";
}

/**
 * Returns true for infrastructure-level provider failures that must be excluded
 * from the substantive consensus calculation and must never produce findings.
 */
export function isProviderFailure(ft: PlanFindingType | null): boolean {
  return (
    ft === "provider_outage" ||
    ft === "timeout" ||
    ft === "malformed_response" ||
    ft === "empty_output"
  );
}

// ---------------------------------------------------------------------------
// Consensus aggregation
// ---------------------------------------------------------------------------

/**
 * A verdict counts as substantive only when the model actually reviewed the
 * plan and returned a real pass/fail signal. Provider failures, malformed
 * responses, abstentions, and out-of-scope objections are excluded so they
 * cannot swing the consensus in either direction.
 */
function isSubstantiveVerdict(ft: PlanFindingType | null): boolean {
  return ft === null || ft === "substantive_rejection";
}

function aggregatePlanConsensus(verdicts: PlanVerdictDetail[]): {
  pass: boolean | null;
  status: "passed" | "rejected" | "escalate";
  unanimous: boolean;
  confidence: number;
} {
  const substantive = verdicts.filter((v) => isSubstantiveVerdict(v.findingType));

  if (substantive.length === 0) {
    // All models had non-substantive results — cannot determine consensus
    return { pass: null, status: "escalate", unanimous: false, confidence: 0 };
  }

  const passCount = substantive.filter((v) => v.pass).length;
  const failCount = substantive.length - passCount;
  const unanimous =
    passCount === substantive.length || failCount === substantive.length;
  const confidence =
    substantive.reduce((s, v) => s + v.confidence, 0) / substantive.length;

  if (passCount === substantive.length) {
    return { pass: true, status: "passed", unanimous, confidence };
  }
  if (failCount === substantive.length) {
    return { pass: false, status: "rejected", unanimous, confidence };
  }
  // Supermajority: N-1 pass → pass, 1-N fail → reject
  if (passCount >= substantive.length - 1) {
    return { pass: true, status: "passed", unanimous: false, confidence };
  }
  if (failCount >= substantive.length - 1) {
    return { pass: false, status: "rejected", unanimous: false, confidence };
  }
  return { pass: null, status: "escalate", unanimous: false, confidence };
}

// ---------------------------------------------------------------------------
// PlanConsensus class
// ---------------------------------------------------------------------------

/**
 * Plan/sufficiency consensus gate adapter.
 *
 * Accepts implementation plans in YAML, JSON, or Markdown format and routes
 * them through the shared model panel in "sufficiency" mode. Provider failures
 * are isolated into their own finding types and never counted as substantive
 * rejections so that a flaky provider cannot veto a valid plan.
 *
 * @example
 * ```ts
 * const gate = new PlanConsensus({ label: "auth-plan-v2" });
 * const result = await gate.evaluate(yamlPlanString);
 * if (result.status === "rejected") console.error(result.findings);
 * ```
 */
export class PlanConsensus {
  private readonly label: string;
  private readonly criteria: string;
  private readonly models: LineupRoleInput[] | null;
  private readonly inputFormat: PlanInputFormat;
  private readonly _caller: PlanVendorCaller | null;

  constructor(opts: PlanConsensusOptions = {}) {
    this.label = opts.label ?? "plan-review";
    this.criteria = opts.criteria ?? "correctness,completeness,consistency";
    this.models = opts.models ?? null;
    this.inputFormat = opts.inputFormat ?? "auto";
    this._caller = opts._vendorCaller ?? null;
  }

  /**
   * Resolves the vendor caller.
   * When a caller is injected (tests), it is returned directly.
   * In production, callVendorWithFallback is loaded via dynamic import so that
   * consensus-gate.ts's top-level parseArgs does not execute at module-load time.
   */
  private async resolveCaller(): Promise<PlanVendorCaller> {
    if (this._caller) return this._caller;
    // Deferred dynamic import — avoids side-effect from top-level parseArgs
    const { callVendorWithFallback } = await import("./consensus-gate");
    const caller: PlanVendorCaller = (role, plan, criteria, mode) =>
      callVendorWithFallback(role, plan, criteria, mode);
    return caller;
  }

  /**
   * Evaluate a plan expressed in YAML, JSON, or Markdown.
   *
   * The input is never passed to Bun or TSX for syntax checking — it is
   * forwarded to each model as plain text in a sufficiency-mode prompt.
   */
  async evaluate(input: string): Promise<PlanConsensusResult> {
    const id = `pcg-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const timestamp = new Date().toISOString();

    // Step 1: Detect format and normalize — no execution, no syntax checks
    const detectedFormat: "json" | "yaml" | "markdown" | "text" =
      this.inputFormat === "auto"
        ? detectPlanFormat(input)
        : (this.inputFormat as "json" | "yaml" | "markdown" | "text");
    const planText = normalizePlanContent(input, detectedFormat);

    // Step 2: Resolve model panel
    const roles: LineupRoleInput[] = this.models ?? getActiveModels();

    // Step 3: Fan out to each model in sufficiency mode
    // Using "sufficiency" mode bypasses the diversity-arbiter (which runs
    // Bun/TSX syntax checks) so YAML/JSON/Markdown content is never treated as code.
    const caller = await this.resolveCaller();
    const rawVerdicts = await Promise.all(
      roles.map((role) => caller(role, planText, this.criteria, "sufficiency")),
    );

    // Step 4: Classify each raw verdict into a finding type
    const verdicts: PlanVerdictDetail[] = rawVerdicts.map((v) => {
      const claimsText = v.dissent_claims?.map((c) => c.claim) ?? [];
      const findingType = classifyVerdictIssues(v.issues, v.pass, claimsText);
      return {
        model: v.model,
        pass: v.pass,
        findingType,
        issues: [...v.issues],
        confidence: v.confidence,
        latencyMs: v.latencyMs,
        servingProvider: v.servingProvider ?? v.usage?.provider,
      };
    });

    // Step 5: Aggregate consensus (provider failures and non-substantive results excluded)
    const { pass, status, unanimous, confidence } =
      aggregatePlanConsensus(verdicts);

    // Step 6: Build structured findings — only substantive rejections appear here
    const findings: PlanFinding[] = [];
    for (let i = 0; i < verdicts.length; i++) {
      const v = verdicts[i];
      if (v.findingType !== "substantive_rejection") continue;
      const raw = rawVerdicts[i];
      if (raw.dissent_claims?.length) {
        for (const c of raw.dissent_claims) {
          findings.push({
            type: "substantive_rejection",
            model: v.model,
            claim: c.claim,
            evidence: c.evidence,
            severity: c.severity,
          });
        }
      } else {
        for (const issue of v.issues) {
          findings.push({
            type: "substantive_rejection",
            model: v.model,
            claim: issue,
          });
        }
      }
    }

    return {
      id,
      timestamp,
      label: this.label,
      inputFormat: detectedFormat,
      criteria: this.criteria,
      status,
      findings,
      verdicts,
      consensus: { pass, unanimous, confidence },
    };
  }
}

function coreFindingType(
  findingType: PlanFindingType | null,
): PlanReviewResultLike["verdicts"][number]["finding_type"] {
  if (findingType === null) return "none";
  if (findingType === "substantive_rejection") return "substantive";
  if (findingType === "abstention" || findingType === "out_of_scope") return findingType;
  if (findingType === "malformed_response") return "malformed_output";
  return "provider_failure";
}

function providerStatus(
  findingType: PlanFindingType | null,
): "healthy" | "degraded" | "unreachable" | "unknown" {
  if (findingType === "provider_outage") return "unreachable";
  if (isProviderFailure(findingType)) return "degraded";
  if (findingType === "malformed_response") return "degraded";
  return "healthy";
}

export function toPlanReviewResult(
  result: PlanConsensusResult,
  limits: { maxCalls?: number; maxCostUsd?: number; estimatedCostUsd?: number } = {},
): PlanReviewResultLike {
  const maxCalls = limits.maxCalls ?? 12;
  const maxCostUsd = limits.maxCostUsd ?? 2;
  const estimatedCostUsd = limits.estimatedCostUsd ?? 0;
  const provider_health: PlanReviewResultLike["provider_health"] = {};

  const verdicts = result.verdicts.map((verdict) => {
    const finding_type = coreFindingType(verdict.findingType);
    provider_health[verdict.model] = providerStatus(verdict.findingType);
    const modelFindings = result.findings.filter((finding) => finding.model === verdict.model);
    const claims = (modelFindings.length > 0
      ? modelFindings.map((finding) => ({
          claim: finding.claim ?? "Plan review finding",
          evidence: finding.evidence,
          severity: finding.severity ?? null,
          finding_type_actual: "substantive" as const,
        }))
      : verdict.issues.map((issue) => ({
          claim: issue,
          severity: null,
          finding_type_actual: finding_type === "none" ? undefined : finding_type,
        })));
    const substantive = finding_type === "none" || finding_type === "substantive";
    return {
      model: verdict.model,
      pass: substantive ? verdict.pass : null,
      confidence: verdict.confidence,
      finding_type,
      claims,
    };
  });

  const allInfrastructure = verdicts.length > 0 && verdicts.every(
    (verdict) => verdict.finding_type === "provider_failure" || verdict.finding_type === "malformed_output",
  );
  return {
    verdicts,
    provider_health,
    call_accounting: {
      calls_made: verdicts.length,
      calls_remaining: Math.max(0, maxCalls - verdicts.length),
      estimated_cost_usd: estimatedCostUsd,
      max_calls: maxCalls,
      max_cost_usd: maxCostUsd,
    },
    decision: allInfrastructure ? "unavailable" : result.status,
  };
}

async function runProviderCommand(): Promise<void> {
  const raw = await Bun.stdin.text();
  const request = JSON.parse(raw) as PlanReviewRequestLike;
  if (!request.artifact || !request.artifact_sha256 || !request.gate_run_id) {
    throw new Error("Invalid PlanReviewRequest input");
  }
  const gate = new PlanConsensus({
    label: request.gate_run_id,
    inputFormat: "json",
  });
  const result = await gate.evaluate(JSON.stringify(request.artifact));
  process.stdout.write(`${JSON.stringify(toPlanReviewResult(result))}\n`);
}

if (import.meta.main) {
  runProviderCommand().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
