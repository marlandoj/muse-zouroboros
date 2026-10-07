/**
 * Dataset reconciliation core for the consensus-gate judge (P1-7, zou-reconcile-p1-7).
 *
 * AIEWF §7 ("annotate -> map -> versioned-rubric-rewrite"): close the loop between
 * the gate's PROD verdict stream and its calibration set so the judge can be
 * re-calibrated from REAL disagreements. There is no prod ground truth (gate
 * verdicts carry no human labels), so a "mis-verdict" can only be SURFACED as a
 * candidate by disagreement signal — never auto-detected. Ranking is by
 * disagreement INFORMATION (escalate > split/dissent > merge-adjust >
 * low-confidence), then deduped against the existing seed and capped for category
 * diversity (the seed is security-heavy).
 *
 * This module is PURE: it takes already-parsed log lines + db records + existing
 * calibration cases (loaded elsewhere) and returns ranked candidates. No fs / db /
 * network, no import side effects. The CLI that reads ~/.zouroboros/*.{log,json}
 * lives in reconcile.ts, NOT here.
 *
 * ADVISORY ONLY — it surfaces candidates for HUMAN annotation. It never labels a
 * prod trace and never touches the live judge prompt.
 */

/** One JSONL line from ~/.zouroboros/consensus-gate.log. */
export interface VerdictLogLine {
  consensus_id: string;
  timestamp: string;
  label?: string;
  status: string; // split | passed | rejected | escalate
  merge_adjust_reason?: string | null;
  verdict: {
    pass: boolean | null;
    confidence?: number;
    /** model id -> per-model verdict (NOTE: object, not array) */
    models?: Record<string, { pass?: boolean | null; issues?: string[] }>;
    dissenting_models?: string[] | null;
    merge_adjust_reason?: string | null;
  };
}

/** One record from ~/.zouroboros/consensus-gate.json (the recoverable-code source). */
export interface VerdictDbRecord {
  id: string;
  timestamp?: string;
  label?: string;
  code: string;
  criteria: string;
  status?: string;
}

/** One human-verified case from data/calibration/test-cases.json (dedup source). */
export interface CalibrationCase {
  id?: string;
  code: string;
  [k: string]: unknown;
}

export type SignalClass =
  | "escalate"
  | "split"
  | "dissent"
  | "merge_adjust"
  | "low_confidence";

/** Ordinal rank of each signal class (higher = more informative). */
const SIGNAL_RANK: Record<SignalClass, number> = {
  escalate: 5,
  split: 4,
  dissent: 3,
  merge_adjust: 2,
  low_confidence: 1,
};

export interface MisverdictCandidate {
  source_consensus_id: string;
  timestamp: string;
  label: string;
  code: string;
  criteria: string;
  signal_class: SignalClass;
  gate_pass: boolean | null;
  gate_confidence: number | null;
  disagreement_fraction: number;
  dissenting_models: string[];
  merge_adjust_reason: string | null;
  /** per-model pass map (advisory display) */
  models_pass: Record<string, boolean | null>;
  /** coarse heuristic bucket used only for the diversity cap — NOT a human label */
  derived_category: string;
  /** numeric rank (class rank * 1000 + disagreement) — transparency only */
  rank_score: number;
}

export interface ReconcileOpts {
  /** max candidates returned (default 12) */
  topN?: number;
  /** confidence below which a clean verdict still counts as a weak signal (default 0.6) */
  lowConfThreshold?: number;
  /** max candidates of any one derived_category in the FIRST diversity pass
   *  (default ceil(topN/3)); leftover slots are then filled ignoring the cap */
  perCategoryCap?: number;
}

/** Ordered category buckets — first match wins. Security first (seed is security-heavy). */
const CATEGORY_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  [
    "security",
    /\b(eval|injection|inject|xss|sql|exec|arbitrary code|command|secret|password|token|credential|unsafe|sanitiz|untrusted|traversal|deserializ)\b/i,
  ],
  ["type", /\b(type mismatch|not assignable|typeerror|type error|wrong type|implicit any)\b/i],
  ["performance", /\b(o\(n|n\+1|n \+ 1|performance|latency|inefficient|quadratic|memory leak)\b/i],
  [
    "correctness",
    /\b(off-by-one|off by one|null|undefined|incorrect|wrong|edge case|race|deadlock|overflow|boundary)\b/i,
  ],
];

/** Normalize code for dedup: trim + collapse internal whitespace per line, drop
 *  blank lines, \n-join. Whitespace-insensitive so reformatted duplicates collapse. */
function normalizeCode(code: string): string {
  return code
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l.length > 0)
    .join("\n");
}

/** Derive a coarse category from issue text + criteria (advisory; for diversity cap only). */
function deriveCategory(issueText: string): string {
  for (const [name, re] of CATEGORY_PATTERNS) {
    if (re.test(issueText)) return name;
  }
  return "other";
}

/** Fraction of scoring models whose pass disagrees with the final verdict (0..1).
 *  For escalate (final pass === null), use within-panel split: min(pass,fail)/total. */
function disagreementFraction(
  models: Record<string, { pass?: boolean | null }> | undefined,
  finalPass: boolean | null,
): number {
  if (!models) return 0;
  const votes = Object.values(models).map((m) => m.pass);
  const total = votes.length;
  if (total === 0) return 0;
  if (finalPass === null) {
    const passCount = votes.filter((v) => v === true).length;
    const failCount = votes.filter((v) => v === false).length;
    return Math.min(passCount, failCount) / total;
  }
  const disagree = votes.filter((v) => v !== null && v !== undefined && v !== finalPass).length;
  return disagree / total;
}

/** Classify the disagreement signal of a log line; null = no signal (not a candidate). */
function classifySignal(
  line: VerdictLogLine,
  lowConfThreshold: number,
): SignalClass | null {
  const v = line.verdict || ({} as VerdictLogLine["verdict"]);
  const dissenting = v.dissenting_models || [];
  const mergeReason = line.merge_adjust_reason || v.merge_adjust_reason || null;
  if (line.status === "escalate" || v.pass === null) return "escalate";
  if (line.status === "split") return "split";
  if (dissenting.length > 0) return "dissent";
  if (mergeReason) return "merge_adjust";
  if (typeof v.confidence === "number" && v.confidence < lowConfThreshold) return "low_confidence";
  return null;
}

/**
 * Surface mis-verdict CANDIDATES from the prod verdict stream for human annotation.
 *
 * Pipeline: classify signal -> join db for recoverable code -> dedup vs existing
 * seed + within candidates (by normalized code) -> rank (class, then disagreement,
 * then recency) -> top-N with a light per-category diversity cap.
 */
export function selectMisverdictCandidates(
  verdictLog: VerdictLogLine[],
  dbRecords: VerdictDbRecord[],
  existingCases: CalibrationCase[],
  opts: ReconcileOpts = {},
): MisverdictCandidate[] {
  const topN = opts.topN ?? 12;
  const lowConfThreshold = opts.lowConfThreshold ?? 0.6;
  const perCategoryCap = opts.perCategoryCap ?? Math.max(1, Math.ceil(topN / 3));

  const dbById = new Map<string, VerdictDbRecord>();
  for (const r of dbRecords) if (r && r.id) dbById.set(r.id, r);

  const existingCodes = new Set<string>();
  for (const c of existingCases) if (c && typeof c.code === "string") existingCodes.add(normalizeCode(c.code));

  // 1) classify + join + build candidates, deduped within the stream by code (keep best rank)
  const byCode = new Map<string, MisverdictCandidate>();
  for (const line of verdictLog) {
    if (!line || !line.consensus_id) continue;
    const signal = classifySignal(line, lowConfThreshold);
    if (!signal) continue;
    const db = dbById.get(line.consensus_id);
    if (!db || typeof db.code !== "string" || db.code.length === 0) continue; // no recoverable code

    const norm = normalizeCode(db.code);
    if (existingCodes.has(norm)) continue; // already in human-verified seed

    const v = line.verdict || ({} as VerdictLogLine["verdict"]);
    const issueText = [
      db.criteria || "",
      ...Object.values(v.models || {}).flatMap((m) => m.issues || []),
    ].join(" • ");
    const disagreement = disagreementFraction(v.models, v.pass);
    const rank_score = SIGNAL_RANK[signal] * 1000 + Math.round(disagreement * 100);

    const candidate: MisverdictCandidate = {
      source_consensus_id: line.consensus_id,
      timestamp: line.timestamp || db.timestamp || "",
      label: line.label || db.label || "",
      code: db.code,
      criteria: db.criteria || "",
      signal_class: signal,
      gate_pass: v.pass ?? null,
      gate_confidence: typeof v.confidence === "number" ? v.confidence : null,
      disagreement_fraction: Number(disagreement.toFixed(3)),
      dissenting_models: v.dissenting_models || [],
      merge_adjust_reason: line.merge_adjust_reason || v.merge_adjust_reason || null,
      models_pass: Object.fromEntries(
        Object.entries(v.models || {}).map(([m, val]) => [m, val.pass ?? null]),
      ),
      derived_category: deriveCategory(issueText),
      rank_score,
    };

    const prior = byCode.get(norm);
    if (!prior || candidate.rank_score > prior.rank_score) byCode.set(norm, candidate);
  }

  // 2) deterministic rank: rank_score desc, then newest timestamp, then id asc
  const ranked = [...byCode.values()].sort((a, b) => {
    if (b.rank_score !== a.rank_score) return b.rank_score - a.rank_score;
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
    return a.source_consensus_id < b.source_consensus_id ? -1 : 1;
  });

  // 3) top-N with a light diversity cap: first pass respects the per-category cap,
  //    a second pass fills any remaining slots ignoring the cap (so we still return N).
  const selected: MisverdictCandidate[] = [];
  const catCount = new Map<string, number>();
  const deferred: MisverdictCandidate[] = [];
  for (const c of ranked) {
    if (selected.length >= topN) break;
    const used = catCount.get(c.derived_category) || 0;
    if (used < perCategoryCap) {
      selected.push(c);
      catCount.set(c.derived_category, used + 1);
    } else {
      deferred.push(c);
    }
  }
  for (const c of deferred) {
    if (selected.length >= topN) break;
    selected.push(c);
  }
  return selected;
}
