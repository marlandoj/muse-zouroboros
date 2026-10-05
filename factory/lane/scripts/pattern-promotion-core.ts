#!/usr/bin/env bun
/**
 * ZOU-438 T1 — Self-evolving pipeline: pattern-promotion CORE (pure, no I/O).
 *
 * Closes the loop on the spec template itself. The template is a hardcoded prompt
 * (prespec-runner.ts buildPrespecPrompt, lines 229-257). This core mines the specs
 * that actually WON — seed-<id>.yaml whose evaluations/<id>.verdict.json is
 * verdict=="pass" — for recurring structure the template does NOT yet mandate, and
 * PROPOSES promoting it. It never edits the template; the runner writes a .proposed
 * artifact and an operator promotes (SF-002 agreement-ledger / SF-006 shadow discipline).
 *
 * Two sharp edges this core is built around:
 *
 *  (1) The winning signal is verdict.json, NOT the approval-ledger. The approval-ledger's
 *      operator_verdict keys on a ticket namespace (ZOU-414..464) that is nearly disjoint
 *      from the committed seed files (mostly sf00N + zou-437), so joining it would score an
 *      empty corpus. verdict=="pass" ∩ seed-<id>.yaml is the join that has data.
 *
 *  (2) The seed corpus is bi-schema. Legacy hand-authored seeds use goal/constraints/
 *      exit_conditions/string-ACs/task.file; the newer template-generated seed uses
 *      context/archetype/object-ACs/task.files. A literal-key detector reads 8% where the
 *      true semantic frequency is 100%. Every detector here is SEMANTIC (a structural check
 *      plus a lowercased-JSON-blob prose scan) so both schemas score the same feature.
 *
 * Pure + deterministic: no fs, no network, no clock. The runner owns all I/O.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A seed whose verdict.json is verdict=="pass". `raw` is the parsed top-level YAML mapping. */
export interface WinningSeed {
  id: string;
  rework: boolean;
  raw: Record<string, unknown>;
}

export interface FeatureDetector {
  key: string;
  label: string;
  /** The concrete line the runner would propose adding to the spec template. */
  templateLine: string;
  detect: (raw: Record<string, unknown>) => boolean;
}

export interface PromotionProposal {
  feature: string;
  label: string;
  frequency: number;
  count: number;
  total: number;
  supporting_seeds: string[];
  suggested_template_line: string;
}

export interface UnderusedMandate {
  feature: string;
  label: string;
  frequency: number;
  count: number;
  total: number;
}

export interface PromotionResult {
  corpus_size: number;
  cold_start: boolean;
  min_seeds: number;
  min_frequency: number;
  proposals: PromotionProposal[];
  already_mandated: string[];
  underused_mandates: UnderusedMandate[];
}

export interface PromotionOpts {
  minSeeds?: number;
  minFrequency?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const PROMOTION_MIN_SEEDS = 5;
export const PROMOTION_MIN_FREQUENCY = 0.6;

/**
 * Feature keys the current spec template ALREADY mandates. Derived by hand from
 * buildPrespecPrompt's field list (prespec-runner.ts:245-246):
 *   "...context, tasks[] (each id/package/files/change/deps), acceptance_criteria[],
 *    dag, out_of_scope."
 * A feature in this set is never proposed (it is already required); if winners
 * under-adhere to it, it surfaces as an underused_mandate instead.
 */
export const TEMPLATE_MANDATED: ReadonlySet<string> = new Set([
  "context_rationale",
  "per_task_deps",
  "wave_dag",
  "out_of_scope",
]);

// ─── Detector helpers ──────────────────────────────────────────────────────────

/** Lowercased JSON of the whole seed — the schema-tolerant prose surface. */
function blobOf(raw: Record<string, unknown>): string {
  return JSON.stringify(raw).toLowerCase();
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── Detector catalog (semantic, schema-tolerant) ──────────────────────────────

/**
 * Fixed v1 catalog. Each detector spans both seed schemas: it checks structure
 * where the two schemas agree (tasks[].deps, dag) and falls back to a blob prose
 * scan where they diverge (an AC may be a string in schema-A or an object in
 * schema-B; a flag may live in context.flags or in a constraint sentence).
 */
export const FEATURE_DETECTORS: readonly FeatureDetector[] = [
  {
    key: "per_task_deps",
    label: "every task declares an explicit deps[] (DAG-explicit)",
    templateLine: "Every task MUST declare an explicit deps[] (empty when it has no predecessor).",
    detect: (raw) => {
      const tasks = asArray(raw.tasks);
      return tasks.length > 0 && tasks.every((t) => isRecord(t) && Array.isArray(t.deps));
    },
  },
  {
    key: "wave_dag",
    label: "a wave/dag execution order is declared",
    templateLine: "Declare a dag mapping waves (wave_1..wave_n) of task ids to fix execution order.",
    detect: (raw) => raw.dag != null,
  },
  {
    key: "context_rationale",
    label: "the spec carries a rationale block (context / goal / constraints — the why)",
    templateLine: "Include a context/rationale block (problem, load-bearing facts, decisions-with-reasons).",
    detect: (raw) =>
      raw.context != null ||
      raw.goal != null ||
      raw.constraints != null ||
      /rationale|load.bearing|decision/.test(blobOf(raw)),
  },
  {
    key: "out_of_scope",
    label: "an explicit out-of-scope / non-goals list",
    templateLine: "List out_of_scope items (what this ticket deliberately does NOT do).",
    detect: (raw) => raw.out_of_scope != null || /out.of.scope|non-goal/.test(blobOf(raw)),
  },
  {
    key: "tsc_clean",
    label: "an acceptance criterion requiring a clean `tsc --noEmit`",
    templateLine: "Add an acceptance criterion: `bunx tsc --noEmit` exits 0 with zero new errors.",
    detect: (raw) => /tsc --noemit/.test(blobOf(raw)),
  },
  {
    key: "selftest_green",
    label: "an acceptance criterion requiring a green selftest",
    templateLine: "Add an acceptance criterion: a hermetic <feature>-selftest passes (exit 0).",
    detect: (raw) => /selftest/.test(blobOf(raw)),
  },
  {
    key: "flag_gating",
    label: "a default-OFF flag with an enforce/shadow companion (advisory-first)",
    templateLine:
      "Gate new behavior behind a default-OFF flag with an enforce/shadow companion (advisory-first).",
    detect: (raw) => {
      const b = blobOf(raw);
      if (isRecord(raw.context) && isRecord((raw.context as Record<string, unknown>).flags)) return true;
      return /_enforce|shadow|default (on|off)|opt-in/.test(b);
    },
  },
  {
    key: "byte_identical_off",
    label: "an assertion that behavior is byte-identical / a no-op when the flag is off",
    templateLine:
      "Add an acceptance criterion: with the flag off, behavior is byte-identical (a true no-op).",
    detect: (raw) => /byte-identical|no-op|both off|flags off|both flags off|default off/.test(blobOf(raw)),
  },
  {
    key: "injected_test_deps",
    label: "injected/injectable side-effects for hermetic testing (no live calls in core)",
    templateLine:
      "Design pure cores with injected side-effects (probe/clock/fetch) so the selftest runs hermetically.",
    detect: (raw) => /inject(ed|able)|no live calls|hermetic|sandbox/.test(blobOf(raw)),
  },
] as const;

// ─── Extraction + frequency (pure) ─────────────────────────────────────────────

/** The set of feature keys present in one seed. */
export function extractFeatures(raw: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const d of FEATURE_DETECTORS) {
    if (d.detect(raw)) out.add(d.key);
  }
  return out;
}

export interface FeatureFrequency {
  count: number;
  total: number;
  frequency: number;
  seeds: string[];
}

/** Per-feature count + supporting seed ids across the winning corpus. */
export function computeFrequencies(seeds: WinningSeed[]): Map<string, FeatureFrequency> {
  const total = seeds.length;
  const freq = new Map<string, FeatureFrequency>();
  for (const d of FEATURE_DETECTORS) {
    freq.set(d.key, { count: 0, total, frequency: 0, seeds: [] });
  }
  for (const seed of seeds) {
    const present = extractFeatures(seed.raw);
    for (const key of present) {
      const f = freq.get(key);
      if (!f) continue;
      f.count += 1;
      f.seeds.push(seed.id);
    }
  }
  for (const f of freq.values()) {
    f.frequency = total > 0 ? Number((f.count / total).toFixed(3)) : 0;
  }
  return freq;
}

// ─── Proposal (pure) ────────────────────────────────────────────────────────────

const detectorByKey = new Map(FEATURE_DETECTORS.map((d) => [d.key, d]));

/**
 * Propose promoting high-frequency winning-seed features the template does not yet
 * mandate. A proposal requires: corpus ≥ minSeeds (else cold_start, nothing proposed),
 * feature frequency ≥ minFrequency, and the feature ∉ TEMPLATE_MANDATED. Mandated
 * features adhered-to by < minFrequency of winners are reported as underused_mandates
 * (informational — never auto-demoted).
 */
export function proposePromotions(seeds: WinningSeed[], opts: PromotionOpts = {}): PromotionResult {
  const minSeeds = opts.minSeeds ?? PROMOTION_MIN_SEEDS;
  const minFrequency = opts.minFrequency ?? PROMOTION_MIN_FREQUENCY;
  const freq = computeFrequencies(seeds);
  const coldStart = seeds.length < minSeeds;

  const proposals: PromotionProposal[] = [];
  const alreadyMandated: string[] = [];
  const underusedMandates: UnderusedMandate[] = [];

  for (const d of FEATURE_DETECTORS) {
    const f = freq.get(d.key)!;
    const mandated = TEMPLATE_MANDATED.has(d.key);
    if (mandated) {
      alreadyMandated.push(d.key);
      if (f.frequency < minFrequency) {
        underusedMandates.push({
          feature: d.key,
          label: d.label,
          frequency: f.frequency,
          count: f.count,
          total: f.total,
        });
      }
      continue;
    }
    if (!coldStart && f.frequency >= minFrequency) {
      proposals.push({
        feature: d.key,
        label: d.label,
        frequency: f.frequency,
        count: f.count,
        total: f.total,
        supporting_seeds: [...f.seeds].sort(),
        suggested_template_line: d.templateLine,
      });
    }
  }

  // Highest-conviction proposals first.
  proposals.sort((a, b) => b.frequency - a.frequency || a.feature.localeCompare(b.feature));

  return {
    corpus_size: seeds.length,
    cold_start: coldStart,
    min_seeds: minSeeds,
    min_frequency: minFrequency,
    proposals,
    already_mandated: alreadyMandated,
    underused_mandates: underusedMandates,
  };
}

/** Stable hash of the proposed feature set + corpus size — the ledger idempotency key. */
export function proposalHash(result: PromotionResult): string {
  const keys = result.proposals.map((p) => p.feature).sort();
  const canonical = JSON.stringify({ corpus: result.corpus_size, cold: result.cold_start, keys });
  return sha256(canonical);
}

function sha256(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex");
}

// ─── Rendering (pure) ───────────────────────────────────────────────────────────

export function formatProposals(result: PromotionResult): string {
  const lines: string[] = [];
  lines.push(
    `pattern-promotion: ${result.corpus_size} winning seed(s)` +
      (result.cold_start ? ` — COLD START (< ${result.min_seeds}, proposing nothing)` : ""),
  );
  lines.push(`  min-frequency=${result.min_frequency} · min-seeds=${result.min_seeds}`);
  if (result.proposals.length === 0) {
    lines.push("  no promotion candidates (all high-frequency features already mandated).");
  } else {
    lines.push(`  ${result.proposals.length} promotion candidate(s):`);
    for (const p of result.proposals) {
      lines.push(
        `  - [${(p.frequency * 100).toFixed(0)}% ${p.count}/${p.total}] ${p.feature} — ${p.label}`,
      );
      lines.push(`      propose → ${p.suggested_template_line}`);
      lines.push(`      seen in: ${p.supporting_seeds.join(", ")}`);
    }
  }
  if (result.underused_mandates.length > 0) {
    lines.push(`  underused template mandates (informational):`);
    for (const u of result.underused_mandates) {
      lines.push(`  - [${(u.frequency * 100).toFixed(0)}% ${u.count}/${u.total}] ${u.feature} — ${u.label}`);
    }
  }
  return lines.join("\n");
}
