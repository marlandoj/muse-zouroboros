#!/usr/bin/env bun
/**
 * Gate escalation valve — cheap-first generation, gate-validated, escalate on fail.
 *
 * WHY: Anthropic's billing change meters Claude Code + ACP (Zo chat) calls at API
 * rates for ALL Anthropic models (Opus/Sonnet/Haiku). The cheapest way to protect
 * subscription headroom is to call Anthropic LESS OFTEN, not just cheaper. This valve
 * rations metered Anthropic calls: a cheap non-Anthropic generator answers first, the
 * consensus panel votes on whether that answer is sufficient, and we only escalate to
 * Opus when the panel says the cheap answer is inadequate.
 *
 * Flow:
 *   1. CHEAP   — generate an answer with the Chinese MoA (GLM-5.2 / Kimi-K2.7-Code / DeepSeek-V4),
 *                or a single OpenRouter model. No Anthropic call.
 *   2. GATE    — the consensus panel reviews (task + candidate answer) in "sufficiency"
 *                mode (ground-truth-free) and votes sufficient / insufficient.
 *   3. ESCALATE— majority-sufficient → return cheap answer (escalated=false, $0 Anthropic).
 *                majority-insufficient → call Opus via /zo/ask, return that (escalated=true).
 *
 * The sufficiency mode lives in consensus-gate.ts; the panel is getActiveModels()
 * (quarantine-aware, same machinery as the validate gate). This file only adds the
 * generation + routing around that gate — it is additive and live-wires nothing.
 *
 * Usage:
 *   bun escalation-valve.ts "your task prompt"
 *   bun escalation-valve.ts --cheap single:z-ai/glm-5.2 "prompt"
 *   bun escalation-valve.ts --escalate claude-opus-4-7 --criteria "factual accuracy" "prompt"
 *   bun escalation-valve.ts --json "prompt"
 *
 * Importable: `import { runValve } from "./escalation-valve.ts"`
 */

import { callVendorWithFallback } from "./consensus-gate.ts";
import { getActiveModels } from "./quarantine.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ZO_ASK_API = "https://api.zo.computer/zo/ask";

// ─── Fusion blind-spot / coverage-gap extraction (OpenRouter Fusion pattern) ──
// The aggregator is repurposed as a FUSION JUDGE: before synthesizing, it emits a
// structured analysis (agreements, differences, partial coverage, unique insights,
// covered dimensions, and BLIND SPOTS / coverage gaps). The synthesis then explicitly
// fills every blind spot. coverageRate = covered/(covered+blindSpots) — a real,
// comparable sufficiency signal the consensus panel can vote against.

export interface FusionAnalysis {
  agreements: string[];
  differences: string[];
  partialCoverage: string[];
  uniqueInsights: { model: string; insight: string }[];
  covered: string[];
  blindSpots: string[];
}

// ─── cheap generation (OpenRouter / MoA) ──────────────────────────────────────
// Self-contained so the consensus-gate skill carries no cross-project dependency.
// Mirrors the reasoning-model contract proven in the MoA-Fable eval: max_tokens>=4096,
// content→reasoning fallback, ONE retry on empty/error, scored failure (never silent drop).

export interface MoaConfig {
  proposers: string[];
  aggregator: string;
  maxTokens: number;
  temperature: number;
  fusionMode: boolean; // Fusion blind-spot + coverage-gap extraction (default true)
}

export const DEFAULT_MOA: MoaConfig = {
  proposers: ["z-ai/glm-5.2", "moonshotai/kimi-k2.6", "deepseek/deepseek-v4-pro"],
  aggregator: "z-ai/glm-5.2",
  maxTokens: 4096,
  temperature: 0.1,
  fusionMode: true,
};

export interface GenResult {
  model: string;
  ok: boolean;
  text: string;
  source: "content" | "reasoning" | "none";
  latencyMs: number;
  error?: string;
  fusionAnalysis?: FusionAnalysis; // populated when fusionMode and parse succeeds
  coverageRate?: number; // 0..1 — covered/(covered+blindSpots); null when undetermined
  finalAnswer?: string; // extracted <final_answer> when fusion mode; == text when naive
  drafts?: GenResult[]; // per-proposer round-1 drafts (set by moaGenerate; reused by escalate-into-panel)
}

async function openRouterCall(
  model: string,
  prompt: string,
  cfg: Pick<MoaConfig, "maxTokens" | "temperature"> = { maxTokens: 4096, temperature: 0.1 },
): Promise<GenResult> {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  if (!key) return { model, ok: false, text: "", source: "none", latencyMs: 0, error: "OPENROUTER_API_KEY not set" };
  const t0 = Date.now();
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: cfg.temperature,
          max_tokens: cfg.maxTokens,
        }),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
        continue;
      }
      const data = (await res.json()) as any;
      const msg = data?.choices?.[0]?.message ?? {};
      const content = (msg.content ?? "").toString().trim();
      const reasoning = (msg.reasoning ?? msg.reasoning_content ?? "").toString().trim();
      const text = content || reasoning;
      if (text) {
        return { model, ok: true, text, source: content ? "content" : "reasoning", latencyMs: Date.now() - t0 };
      }
      lastErr = "empty content and reasoning";
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
  }
  return { model, ok: false, text: "", source: "none", latencyMs: Date.now() - t0, error: lastErr };
}

/** Naive aggregator prompt (used when fusionMode is false — preserves benchmark parity). */
function buildAggregatorPrompt(task: string, drafts: GenResult[]): string {
  const block = drafts
    .map((d, i) =>
      d.ok
        ? `[Response ${i + 1} — ${d.model}]\n${d.text}`
        : `[Response ${i + 1} — ${d.model}] (no usable answer — failed)`,
    )
    .join("\n\n");
  return `You have been provided with a set of responses from several AI models to the task below. Synthesize them into a single, high-quality answer. Critically evaluate the responses — they may be incomplete, partially correct, or contradictory. Do not merely copy; produce the most accurate, complete answer to the original task, following its formatting instructions exactly.

=== MODEL RESPONSES ===
${block}

=== ORIGINAL TASK (answer this) ===
${task}`;
}

/**
 * Fusion aggregator prompt (OpenRouter Fusion pattern). The aggregator acts as a
 * FUSION JUDGE: emit a structured analysis FIRST (agreements, differences, partial
 * coverage, unique insights, covered dimensions, BLIND SPOTS / coverage gaps), THEN
 * synthesize a final answer that explicitly fills every blind spot. Single call —
 * cost-neutral vs the naive aggregator.
 */
function buildFusionAggregatorPrompt(task: string, drafts: GenResult[]): string {
  const block = drafts
    .map((d, i) =>
      d.ok
        ? `[Response ${i + 1} — ${d.model}]\n${d.text}`
        : `[Response ${i + 1} — ${d.model}] (no usable answer — failed)`,
    )
    .join("\n\n");
  return `You are a FUSION JUDGE. A panel of AI models each answered the task below independently. Your job has TWO parts.

PART 1 — STRUCTURED ANALYSIS (emit first, as JSON). Read every response critically and identify:
- "agreements": points where multiple models converge (consensus).
- "differences": points where models disagree or contradict each other.
- "partialCoverage": topics the task requires that some models addressed only partially.
- "uniqueInsights": contributions made by EXACTLY ONE model that no other mentioned (attribute by model name).
- "covered": the distinct dimensions / sub-questions of the task the panel COLLECTIVELY addressed.
- "blindSpots": dimensions / sub-questions the task requires that NO model addressed (the coverage gaps).

Emit this as a single JSON object wrapped in <fusion_analysis> ... </fusion_analysis> tags, BEFORE your final answer. Schema:
{"agreements":[...],"differences":[...],"partialCoverage":[...],"uniqueInsights":[{"model":"...","insight":"..."}],"covered":[...],"blindSpots":[...]}

PART 2 — SYNTHESIS (emit after the analysis). Produce the single best answer to the original task. You MUST:
- reconcile the differences,
- incorporate the unique insights,
- and explicitly FILL every blind spot using your own knowledge.
Do not merely copy any single response. Follow the task's formatting instructions exactly.

Emit your final answer wrapped in <final_answer> ... </final_answer> tags.

=== MODEL RESPONSES ===
${block}

=== ORIGINAL TASK (answer this) ===
${task}`;
}

/**
 * Parse the Fusion JUDGE output. Extracts the <fusion_analysis> JSON block and the
 * <final_answer> block. Graceful degradation: if tags are missing, treats the whole
 * text as the final answer with an empty analysis (fusion still "ran", just unparsed).
 * Never throws.
 */
export function parseFusionAnalysis(raw: string): { analysis: FusionAnalysis | undefined; finalAnswer: string; coverageRate: number | undefined } {
  const analysisMatch = raw.match(/<fusion_analysis>\s*([\s\S]*?)\s*<\/fusion_analysis>/i);
  const finalMatch = raw.match(/<final_answer>\s*([\s\S]*?)\s*<\/final_answer>/i);
  const finalAnswer = finalMatch ? finalMatch[1].trim() : raw.trim();
  if (!analysisMatch) {
    return { analysis: undefined, finalAnswer, coverageRate: undefined };
  }
  let analysis: FusionAnalysis | undefined;
  try {
    const parsed = JSON.parse(analysisMatch[1].trim());
    analysis = {
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements.map(String) : [],
      differences: Array.isArray(parsed.differences) ? parsed.differences.map(String) : [],
      partialCoverage: Array.isArray(parsed.partialCoverage) ? parsed.partialCoverage.map(String) : [],
      uniqueInsights: Array.isArray(parsed.uniqueInsights)
        ? parsed.uniqueInsights.map((u: any) => ({ model: String(u?.model ?? "unknown"), insight: String(u?.insight ?? "") }))
        : [],
      covered: Array.isArray(parsed.covered) ? parsed.covered.map(String) : [],
      blindSpots: Array.isArray(parsed.blindSpots) ? parsed.blindSpots.map(String) : [],
    };
  } catch {
    return { analysis: undefined, finalAnswer, coverageRate: undefined };
  }
  const covered = analysis.covered.length;
  const blind = analysis.blindSpots.length;
  const coverageRate = covered + blind > 0 ? Number((covered / (covered + blind)).toFixed(3)) : undefined;
  return { analysis, finalAnswer, coverageRate };
}

export async function moaGenerate(task: string, cfg: MoaConfig = DEFAULT_MOA): Promise<GenResult> {
  const drafts = await Promise.all(cfg.proposers.map((m) => openRouterCall(m, task, cfg)));
  if (!drafts.some((d) => d.ok)) {
    return { model: "moa", ok: false, text: "", source: "none", latencyMs: 0, error: "all proposers failed" };
  }
  const aggPrompt = cfg.fusionMode
    ? buildFusionAggregatorPrompt(task, drafts)
    : buildAggregatorPrompt(task, drafts);
  const agg = await openRouterCall(cfg.aggregator, aggPrompt, cfg);
  if (!cfg.fusionMode) {
    return { ...agg, model: `moa(${cfg.aggregator})`, drafts };
  }
  // Fusion mode: parse structured analysis + final answer out of the aggregator output.
  const { analysis, finalAnswer, coverageRate } = parseFusionAnalysis(agg.text);
  return {
    ...agg,
    model: `moa-fusion(${cfg.aggregator})`,
    text: finalAnswer, // downstream consumers (gate, CLI) see the clean final answer
    finalAnswer,
    fusionAnalysis: analysis,
    coverageRate,
    drafts, // round-1 proposer drafts retained for escalate-into-panel
  };
}

// ─── escalation target (Anthropic via /zo/ask) ────────────────────────────────

async function escalateZo(task: string, modelName: string): Promise<GenResult> {
  const token = process.env.ZO_TOKEN || process.env.ZO_CLIENT_IDENTITY_TOKEN || "";
  if (!token) return { model: modelName, ok: false, text: "", source: "none", latencyMs: 0, error: "no ZO token" };
  const t0 = Date.now();
  try {
    const resp = await fetch(ZO_ASK_API, {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: JSON.stringify({ input: task, model_name: modelName }),
    });
    if (!resp.ok) {
      return { model: modelName, ok: false, text: "", source: "none", latencyMs: Date.now() - t0, error: `HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as any;
    const text = (data?.output ?? data?.choices?.[0]?.message?.content ?? "").toString().trim();
    return text
      ? { model: modelName, ok: true, text, source: "content", latencyMs: Date.now() - t0 }
      : { model: modelName, ok: false, text: "", source: "none", latencyMs: Date.now() - t0, error: "empty output" };
  } catch (e: any) {
    return { model: modelName, ok: false, text: "", source: "none", latencyMs: Date.now() - t0, error: e?.message ?? String(e) };
  }
}

/**
 * Experiment C — escalate-into-panel. On gate-FAIL, instead of discarding the cheap
 * drafts for a solo Opus answer, Opus JOINS the panel as a 4th proposer and the fusion
 * judge re-synthesizes the blend. Equal Anthropic cost (one Opus generation either way).
 *
 * The round-2 aggregator is the CHEAP model by default, so Opus is paid once (its draft),
 * not for synthesis. Set `escalateAggregator` to a "claude*" model to run the round-2
 * synthesis itself on Opus (the dilution-mitigation knob — doubles Opus cost on FAILs).
 *
 * Graceful: if the Opus draft fails, the panel re-fuses the cheap drafts alone (still
 * better than returning nothing).
 */
export async function escalateIntoPanel(
  task: string,
  cheapDrafts: GenResult[],
  escalateModel: string,
  cfg: MoaConfig = DEFAULT_MOA,
  escalateAggregator?: string,
): Promise<{ answer: GenResult; opus: GenResult }> {
  const opus = await escalateZo(task, escalateModel); // the one Anthropic call
  const panel = opus.ok ? [...cheapDrafts, opus] : cheapDrafts;
  const aggPrompt = buildFusionAggregatorPrompt(task, panel);
  const useOpusJudge = !!escalateAggregator && escalateAggregator.startsWith("claude");
  const agg = useOpusJudge
    ? await escalateZo(aggPrompt, escalateAggregator!)
    : await openRouterCall(escalateAggregator ?? cfg.aggregator, aggPrompt, cfg);
  const judge = useOpusJudge ? escalateAggregator! : escalateAggregator ?? cfg.aggregator;
  const { analysis, finalAnswer, coverageRate } = parseFusionAnalysis(agg.text);
  return {
    answer: {
      ...agg,
      model: `escalate-panel(${judge}+${escalateModel})`,
      text: finalAnswer,
      finalAnswer,
      fusionAnalysis: analysis,
      coverageRate,
      drafts: panel,
    },
    opus,
  };
}

// ─── sufficiency gate ─────────────────────────────────────────────────────────

export interface PanelVerdict {
  model: string;
  sufficient: boolean;
  confidence: number;
  issues: string[];
  substitutedFrom?: string;
}

export interface SufficiencyResult {
  sufficient: boolean;
  passCount: number;
  failCount: number;
  verdicts: PanelVerdict[];
}

/** Build the (task + candidate answer) payload the panel reviews. */
function sufficiencyPayload(task: string, answer: string): string {
  return `### TASK\n${task}\n\n### CANDIDATE ANSWER (from a cheaper model)\n${answer}`;
}

/**
 * Coverage-aware sufficiency payload. When the Fusion judge extracted blind spots /
 * coverage gaps, they are surfaced to the panel so it can vote on whether the gaps
 * actually matter for sufficiency. A high blind-spot count makes the panel more likely
 * to vote insufficient → escalation — closing the Fusion→gate→escalation loop.
 */
function sufficiencyPayloadFusion(task: string, answer: string, fa: FusionAnalysis | undefined, coverageRate: number | undefined): string {
  const base = sufficiencyPayload(task, answer);
  if (!fa) return base;
  const blind = fa.blindSpots.length ? fa.blindSpots.map((b) => `- ${b}`).join("\n") : "(none detected)";
  const partial = fa.partialCoverage.length ? fa.partialCoverage.map((p) => `- ${p}`).join("\n") : "(none detected)";
  const rate = coverageRate !== undefined ? `${(coverageRate * 100).toFixed(1)}%` : "unknown";
  return `${base}

### FUSION COVERAGE ANALYSIS (from the aggregator judge)
- Coverage rate: ${rate} (${fa.covered.length} dimensions covered, ${fa.blindSpots.length} blind spots)
- Blind spots / coverage gaps (dimensions NO proposer addressed):
${blind}
- Partially covered:
${partial}

When voting, weigh whether the candidate answer above has FILLED these blind spots. If material gaps remain unfilled, vote insufficient.`;
}

/**
 * Ground-truth-free sufficiency vote. Each active model judges whether the candidate
 * answer is good enough to ship. Majority "sufficient" → no escalation. Ties (possible
 * only with an even panel) resolve to NOT sufficient — escalate, favoring quality.
 */
export async function reviewSufficiency(
  task: string,
  answer: string,
  criteria: string,
  models: string[] = getActiveModels(),
  fusion?: { analysis: FusionAnalysis | undefined; coverageRate: number | undefined },
): Promise<SufficiencyResult> {
  const payload = fusion
    ? sufficiencyPayloadFusion(task, answer, fusion.analysis, fusion.coverageRate)
    : sufficiencyPayload(task, answer);
  const raw = await Promise.all(
    models.map((m) => callVendorWithFallback(m, payload, criteria, "sufficiency")),
  );
  const verdicts: PanelVerdict[] = raw.map((v) => ({
    model: v.model,
    sufficient: Boolean(v.pass),
    confidence: v.confidence,
    issues: v.issues ?? [],
    substitutedFrom: (v as any).substitutedFrom,
  }));
  const passCount = verdicts.filter((v) => v.sufficient).length;
  const failCount = verdicts.length - passCount;
  return { sufficient: passCount > failCount, passCount, failCount, verdicts };
}

// ─── the valve ────────────────────────────────────────────────────────────────

export type CheapSpec = { kind: "moa"; cfg: MoaConfig } | { kind: "single"; model: string };

export interface ValveOptions {
  cheap?: CheapSpec;
  escalateModel?: string; // /zo/ask model_name (Anthropic), e.g. "claude-opus-4-8"
  criteria?: string;
  models?: string[]; // sufficiency panel override
  forceEscalate?: boolean; // testing: skip cheap+gate, go straight to escalate
  escalateMode?: "solo" | "panel"; // Experiment C — "panel": Opus joins the MoA panel on gate-FAIL (default "solo")
  escalateAggregator?: string; // round-2 fusion judge override (e.g. "claude-opus-4-8" Opus-as-judge knob)
}

export interface ValveResult {
  task: string;
  escalated: boolean;
  answer: string;
  cheap: GenResult;
  sufficiency?: SufficiencyResult;
  escalation?: GenResult;
  reason: string;
}

const DEFAULT_CRITERIA =
  "factual accuracy, completeness, and faithfully following the task's explicit output/format instructions";

export async function runValve(task: string, opts: ValveOptions = {}): Promise<ValveResult> {
  const escalateModel = opts.escalateModel ?? "claude-opus-4-8";
  const criteria = opts.criteria ?? DEFAULT_CRITERIA;

  if (opts.forceEscalate) {
    const esc = await escalateZo(task, escalateModel);
    return {
      task, escalated: true, answer: esc.text,
      cheap: { model: "(skipped)", ok: false, text: "", source: "none", latencyMs: 0 },
      escalation: esc, reason: "forceEscalate",
    };
  }

  // 1. CHEAP
  const cheap =
    !opts.cheap || opts.cheap.kind === "moa"
      ? await moaGenerate(task, opts.cheap?.kind === "moa" ? opts.cheap.cfg : DEFAULT_MOA)
      : await openRouterCall(opts.cheap.model, task, DEFAULT_MOA);

  // Cheap generation itself failed → nothing to gate; escalate.
  if (!cheap.ok || !cheap.text) {
    const esc = await escalateZo(task, escalateModel);
    return {
      task, escalated: true, answer: esc.text, cheap, escalation: esc,
      reason: `cheap generation failed (${cheap.error ?? "empty"}) — escalated`,
    };
  }

  // 2. GATE
  const fusion = cheap.fusionAnalysis !== undefined
    ? { analysis: cheap.fusionAnalysis, coverageRate: cheap.coverageRate }
    : undefined;
  const sufficiency = await reviewSufficiency(task, cheap.text, criteria, opts.models, fusion);

  // 3. ROUTE
  if (sufficiency.sufficient) {
    return {
      task, escalated: false, answer: cheap.text, cheap, sufficiency,
      reason: `gate PASS ${sufficiency.passCount}/${sufficiency.verdicts.length} sufficient — cheap answer shipped, no Anthropic call`,
    };
  }

  // Experiment C — escalate-into-panel: Opus joins the panel as a 4th proposer and the
  // fusion judge re-synthesizes, instead of a solo Opus answer that discards the drafts.
  // Equal Anthropic cost (one Opus call either way). Falls back to solo if drafts absent.
  if (opts.escalateMode === "panel" && cheap.drafts?.length) {
    const moaCfg = opts.cheap?.kind === "moa" ? opts.cheap.cfg : DEFAULT_MOA;
    const { answer, opus } = await escalateIntoPanel(task, cheap.drafts, escalateModel, moaCfg, opts.escalateAggregator);
    return {
      task,
      escalated: true,
      answer: answer.ok && answer.text ? answer.text : opus.ok ? opus.text : cheap.text,
      cheap,
      sufficiency,
      escalation: opus, // the single Anthropic call — keeps cost-ledger/telemetry equal to solo
      reason: opus.ok
        ? `gate FAIL ${sufficiency.failCount}/${sufficiency.verdicts.length} insufficient — escalated INTO panel (round-2 fusion w/ ${escalateModel})`
        : `gate FAIL but Opus draft errored (${opus.error}) — re-fused cheap drafts only`,
    };
  }

  const esc = await escalateZo(task, escalateModel);
  return {
    task,
    escalated: true,
    answer: esc.ok ? esc.text : cheap.text, // if escalate also fails, fall back to cheap rather than nothing
    cheap,
    sufficiency,
    escalation: esc,
    reason: esc.ok
      ? `gate FAIL ${sufficiency.failCount}/${sufficiency.verdicts.length} insufficient — escalated to ${escalateModel}`
      : `gate FAIL but escalation errored (${esc.error}) — returned cheap answer`,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opts: ValveOptions = {};
  const positional: string[] = [];
  let asJson = false;
  let showFusion = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cheap") {
      const spec = argv[++i];
      if (spec === "moa") opts.cheap = { kind: "moa", cfg: { ...DEFAULT_MOA } };
      else if (spec.startsWith("single:")) opts.cheap = { kind: "single", model: spec.slice("single:".length) };
      else opts.cheap = { kind: "single", model: spec };
    } else if (a === "--escalate") opts.escalateModel = argv[++i];
    else if (a === "--escalate-mode") {
      const m = argv[++i];
      opts.escalateMode = m === "panel" ? "panel" : "solo";
    } else if (a === "--escalate-aggregator") opts.escalateAggregator = argv[++i];
    else if (a === "--criteria") opts.criteria = argv[++i];
    else if (a === "--models") opts.models = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--force-escalate") opts.forceEscalate = true;
    else if (a === "--no-fusion") {
      // A/B: disable Fusion blind-spot extraction (naive aggregator, benchmark parity)
      const base = opts.cheap?.kind === "moa" ? opts.cheap.cfg : DEFAULT_MOA;
      opts.cheap = { kind: "moa", cfg: { ...base, fusionMode: false } };
    } else if (a === "--show-fusion") {
      showFusion = true;
    } else if (a === "--json") asJson = true;
    else positional.push(a);
  }
  const task = positional.join(" ");
  if (!task) {
    console.error('Usage: bun escalation-valve.ts [--cheap moa|single:<slug>] [--no-fusion] [--show-fusion] [--escalate <model>] [--escalate-mode solo|panel] [--escalate-aggregator <model>] [--criteria "..."] [--json] "task"');
    process.exit(1);
  }

  const t0 = Date.now();
  const result = await runValve(task, opts);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`\n── CHEAP (${result.cheap.model}) ${result.cheap.ok ? "OK" : "FAIL"} ${result.cheap.latencyMs}ms ──`);
    if (result.cheap.fusionAnalysis) {
      const fa = result.cheap.fusionAnalysis;
      const rate = result.cheap.coverageRate !== undefined ? `${(result.cheap.coverageRate * 100).toFixed(1)}%` : "n/a";
      console.error(`── FUSION: coverage=${rate} | covered=${fa.covered.length} blindSpots=${fa.blindSpots.length} diffs=${fa.differences.length} unique=${fa.uniqueInsights.length} ──`);
      if (showFusion) {
        if (fa.blindSpots.length) console.error("   blind spots:\n" + fa.blindSpots.map((b) => `     - ${b}`).join("\n"));
        if (fa.differences.length) console.error("   differences:\n" + fa.differences.map((d) => `     - ${d}`).join("\n"));
      }
    }
    if (result.sufficiency) {
      console.error(
        `── GATE: ${result.sufficiency.passCount}/${result.sufficiency.verdicts.length} sufficient → ` +
          `${result.sufficiency.sufficient ? "PASS (ship cheap)" : "FAIL (escalate)"} ──`,
      );
      for (const v of result.sufficiency.verdicts) {
        console.error(
          `   ${v.sufficient ? "✅" : "❌"} ${v.model}${v.substitutedFrom ? ` (via ${v.substitutedFrom})` : ""} ` +
            `conf=${v.confidence}${v.issues.length ? ` — ${v.issues.slice(0, 2).join("; ").slice(0, 160)}` : ""}`,
        );
      }
    }
    if (result.escalation) {
      console.error(`── ESCALATE (${result.escalation.model}) ${result.escalation.ok ? "OK" : "FAIL"} ${result.escalation.latencyMs}ms ──`);
    }
    console.error(`── ${result.escalated ? "ESCALATED" : "NOT escalated"}: ${result.reason} | wall=${Date.now() - t0}ms ──\n`);
    console.log(result.answer);
  }
}
