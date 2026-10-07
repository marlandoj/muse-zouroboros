/**
 * Reviewer-independence helpers for the consensus gate (P0-2, zou-cg-p0-2).
 *
 * Pure, importable, no network, no import side effects. Three capabilities,
 * all flag-gated and backward-compatible at the call site:
 *
 *   1. Author exclusion — reviewer-model ≠ author-model. The model that
 *      GENERATED an artifact is removed from its own review panel (Qodo: a
 *      model corrects EXTERNAL errors ~3× more than its own).
 *   2. Deterministic-first trusted block — a HARD arbiter fail (its existing
 *      high-confidence syntax / dangerous-pattern fail) rejects regardless of
 *      LLM votes. Arbiter PASS is non-forcing (LLM panel still governs).
 *   3. Recall-biased final gate — a would-be PASS that hides a high-confidence,
 *      high-severity lone dissent is flipped to ESCALATE (not hard-reject), so a
 *      real bug a single reviewer flagged is not silently outvoted.
 *
 * The arbiter model id is imported from diversity-arbiter (a pure const export;
 * its CLI block is guarded by import.meta.main and does not run on import).
 */
import { ARBITER_MODEL_ID } from "./diversity-arbiter";

// ---------------------------------------------------------------------------
// Config flag / number readers (mirror p0-1-gate.ts p0FlagOn style)
// ---------------------------------------------------------------------------

export function cgFlagOn(name: string, defaultOn = true): boolean {
  const v = process.env[name];
  if (v == null || v === "") return defaultOn;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

export function cgNum(name: string, defaultVal: number): number {
  const v = process.env[name];
  if (v == null || v === "") return defaultVal;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : defaultVal;
}

// ---------------------------------------------------------------------------
// Author exclusion
// ---------------------------------------------------------------------------

// Provider scheme prefixes that front a model id (hf:org/model, xai:grok, …).
// Stripped during normalization so author match survives provider remapping.
const PROVIDER_PREFIXES = new Set([
  "hf", "oc", "xai", "openrouter", "or", "moa", "zo", "anthropic", "openai",
  "google", "deepseek", "together", "fireworks", "groq", "synthetic", "minimax", "kimi",
]);

/** Canonical label for comparison: lowercased, provider-scheme stripped. */
export function normalizeModelId(m: string): string {
  if (!m) return "";
  let s = m.trim().toLowerCase();
  const colon = s.indexOf(":");
  if (colon > 0 && PROVIDER_PREFIXES.has(s.slice(0, colon))) {
    s = s.slice(colon + 1);
  }
  return s;
}

function basename(m: string): string {
  const n = normalizeModelId(m);
  const slash = n.lastIndexOf("/");
  return slash >= 0 ? n.slice(slash + 1) : n;
}

/**
 * True when two ids denote the same model. Matches on the normalized full id
 * (handles scheme remapping) OR on the model basename (handles a bare
 * `GLM-5.2` referring to the same model as `hf:zai-org/GLM-5.2`).
 */
export function sameModel(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (normalizeModelId(a) === normalizeModelId(b)) return true;
  return basename(a) === basename(b);
}

/** Remove the author model (and its provider-mapped aliases) from the panel. */
export function excludeAuthor(panel: string[], author?: string): string[] {
  if (!author) return [...panel];
  return panel.filter((m) => !sameModel(m, author));
}

/** Undersized-panel check. ok=false carries a stable escalation reason. */
export function panelGuard(
  panel: string[],
  min: number,
): { ok: boolean; reason?: string } {
  if (panel.length < min) {
    return { ok: false, reason: "author-exclusion-undersized-panel" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Deterministic-first + recall-bias predicates and merge adjustment
// ---------------------------------------------------------------------------

export interface VerdictLike {
  model: string;
  pass: boolean;
  confidence: number;
  dissent_claims?: { claim: string; evidence?: string; severity?: "high" | "medium" | "low" }[];
}

/**
 * Trusted deterministic block: the arbiter HARD-failed — it rejected AND raised
 * at least one high-severity claim (its syntax / dangerous-pattern fail). This
 * is the predicate the deterministic-first layer treats as decisive.
 */
export function arbiterHardFail(verdicts: VerdictLike[]): boolean {
  return verdicts.some(
    (v) =>
      v.model === ARBITER_MODEL_ID &&
      v.pass === false &&
      (v.dissent_claims ?? []).some((c) => c.severity === "high"),
  );
}

/**
 * A fuzzy-layer (non-arbiter) reviewer dissented with high confidence AND a
 * high-severity issue. This is the dissent the recall-biased gate refuses to
 * silently outvote.
 */
export function hasQualifyingDissent(verdicts: VerdictLike[], minConf: number): boolean {
  return verdicts.some(
    (v) =>
      v.model !== ARBITER_MODEL_ID &&
      v.pass === false &&
      v.confidence >= minConf &&
      (v.dissent_claims ?? []).some((c) => c.severity === "high"),
  );
}

export interface TrustRecallOpts {
  deterministicFirst: boolean;
  recallBias: boolean;
  recallConf: number;
}

export interface MergeOutcome {
  pass: boolean | null;
  status: "passed" | "rejected" | "escalate";
  reason?: string;
}

/**
 * Apply the trusted-deterministic block and recall bias on top of a base merge
 * outcome. Used uniformly by both computeConsensus and weightedAggregate paths.
 * Precedence: deterministic block (reject) > recall escalate > base unchanged.
 */
export function applyTrustAndRecall(
  verdicts: VerdictLike[],
  base: { pass: boolean | null; status: "passed" | "rejected" | "escalate" },
  opts: TrustRecallOpts,
): MergeOutcome {
  if (opts.deterministicFirst && arbiterHardFail(verdicts)) {
    return { pass: false, status: "rejected", reason: "deterministic-first-hard-fail" };
  }
  if (
    opts.recallBias &&
    base.status === "passed" &&
    hasQualifyingDissent(verdicts, opts.recallConf)
  ) {
    return { pass: null, status: "escalate", reason: "recall-bias-high-sev-dissent" };
  }
  return { pass: base.pass, status: base.status };
}
