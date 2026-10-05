#!/usr/bin/env bun
/**
 * SF-P4 — Expertise-aware executor router for the SF-003 coder pool.
 *
 * ZOU-436 made real coder HARNESSES (Claude Code, Codex, Gemini — all ACP,
 * `code-generation` expertise) dispatchable and rotates them for a code task.
 * But the executor registry also carries NON-coder executors — chiefly Hermes
 * (transport=bridge, expertise = web-research / audit / review / investigate /
 * summarize / security, and NO code-generation). A research/audit leg wastes a
 * coder and a code leg would be BROKEN on Hermes.
 *
 * This module is the pure classification + expertise-ranking seam that lets
 * pool-worker.ts route each leg to the right *kind* of executor:
 *   - a CODE leg  ⇒ defer to the ZOU-436 coder chain (selected=null, defer=true)
 *   - a RESEARCH leg ⇒ resolve a research-capable executor (Hermes ≻ Gemini)
 *
 * SAFETY INVARIANT D2 (the whole point): a code leg must NEVER route to a
 * non-coder. classifyLeg therefore returns "research" ONLY when a strong-research
 * signal is present AND zero strong-code signal is present. Every ambiguous or
 * empty leg falls to "code" — the conservative direction, since a coder can do a
 * research leg (degraded) but Hermes cannot compile code. selectExecutorByExpertise
 * also degrades a research leg to the coder chain when no research executor is
 * healthy: a routing decision can never fail a task.
 *
 * Pure by construction: selectExecutorByExpertise takes INJECTED profiles + an
 * injected healthProbe, so the selftest runs fully hermetic (no fs / no binaries /
 * no network / no spend). loadExecutorProfiles is the only real-fs seam.
 */

import { readFileSync } from "node:fs";
import type { HealthProbe, HealthResult } from "./harness-router";

export type LegKind = "code" | "research";

/**
 * Strong CODE signals. Presence of ANY forces kind="code" (invariant D2). Kept
 * deliberately greedy toward code — a false "code" only means a coder handles a
 * research-ish leg (fine); a false "research" would break a code leg on Hermes.
 * Trailing spaces on ambiguous stems ("class ", "import ") avoid matching
 * "classification" / "important".
 */
export const STRONG_CODE: ReadonlyArray<string> = [
  "implement", "refactor", "fix", "patch", "compile", "debug", "lint",
  "function", "class ", "method", "endpoint", "migration", "schema",
  "module", "import ", "dependency", "unit test", "write test", "edit file",
  "pull request", "commit", "typescript", "rewrite", "wire", "bug",
  "regression", "stack trace",
];

/**
 * Strong RESEARCH signals — non-coding investigative / analytical work that a
 * research executor (Hermes) is built for. Specific stems ("review the",
 * "analyze the") avoid stealing "code review" from the coders.
 */
export const STRONG_RESEARCH: ReadonlyArray<string> = [
  "research", "investigate", "audit", "review the", "summarize", "summarise",
  "compare", "evaluate", "assess", "web search", "gather", "survey",
  "look up", "find out", "report on", "synthesize", "synthesis",
  "vulnerability", "literature", "analyze the", "analyse the",
];

/** Expertise tags (as they appear in executor-registry.json) that satisfy a code leg. */
export const CODE_EXPERTISE: ReadonlyArray<string> = ["code-generation"];

/** Expertise tags that satisfy a research leg. Scoring these ranks Hermes ≻ Gemini. */
export const RESEARCH_EXPERTISE: ReadonlyArray<string> = [
  "web-research", "audit", "review", "investigate", "summarize",
  "research", "analysis", "evaluate", "data-analysis", "security",
];

export interface Classification {
  kind: LegKind;
  strongCodeHits: string[];
  strongResearchHits: string[];
  rationale: string;
}

/**
 * Deterministic lexical classification of one leg's text (task name + description).
 * Pure — no I/O, no LLM. Invariant D2 is enforced here: research requires a
 * research hit AND zero code hits; everything else is code.
 */
export function classifyLeg(text: string): Classification {
  const hay = (text ?? "").toLowerCase();
  const strongCodeHits = STRONG_CODE.filter((k) => hay.includes(k));
  const strongResearchHits = STRONG_RESEARCH.filter((k) => hay.includes(k));
  const isResearch = strongResearchHits.length >= 1 && strongCodeHits.length === 0;
  const kind: LegKind = isResearch ? "research" : "code";
  const rationale = isResearch
    ? `research: matched [${strongResearchHits.join(", ")}] with no code signal`
    : strongCodeHits.length > 0
      ? `code: matched code signal [${strongCodeHits.join(", ")}]${strongResearchHits.length > 0 ? ` (research signal [${strongResearchHits.join(", ")}] present but code wins — invariant D2)` : ""}`
      : `code: no strong signal — default to coder (safe)`;
  return { kind, strongCodeHits, strongResearchHits, rationale };
}

export interface ExecutorProfile {
  id: string;
  transport: string;
  expertise: string[];
}

/**
 * Real-fs seam: read executor-registry.json into id/transport/expertise triples.
 * The registryPath is INJECTED by the caller (pool-worker passes the RCE-safe,
 * repo-relative swarmRegistryPath() from harness-router) — never env-derived here.
 * A malformed / missing registry yields [] so routing degrades to the coder chain
 * rather than throwing.
 */
export function loadExecutorProfiles(registryPath: string): ExecutorProfile[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf8")) as {
      executors?: Array<{ id?: string; transport?: string; expertise?: string[] }>;
    };
    return (raw.executors ?? [])
      .filter((e) => typeof e.id === "string")
      .map((e) => ({
        id: e.id as string,
        transport: typeof e.transport === "string" ? e.transport : "",
        expertise: Array.isArray(e.expertise) ? e.expertise.filter((x) => typeof x === "string") : [],
      }));
  } catch (e) {
    // Degrade to [] (never throw ⇒ routing falls back to the coder chain) but SURFACE
    // it: a missing / malformed registry at the fixed repo path is a real defect that a
    // silent [] would mask (consensus-mined, GLM + Kimi).
    console.warn(`[expertise-router] executor registry unreadable at ${registryPath}: ${e instanceof Error ? e.message : String(e)} — routing degrades to the coder chain`);
    return [];
  }
}

export interface RankedExecutor {
  profile: ExecutorProfile;
  score: number;
}

/**
 * Rank executors for a leg kind by how many of their expertise tags satisfy it.
 * Only executors with score>0 are eligible. Ties break on registry order (stable
 * sort), which for a code leg preserves the ZOU-436 chain order. Pure.
 */
export function rankExecutorsForKind(kind: LegKind, profiles: ExecutorProfile[]): RankedExecutor[] {
  const wanted = kind === "code" ? CODE_EXPERTISE : RESEARCH_EXPERTISE;
  const wset = new Set(wanted);
  return profiles
    .map((profile) => ({ profile, score: profile.expertise.filter((e) => wset.has(e)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score); // Array.prototype.sort is stable (ES2019+) ⇒ equal scores keep registry order
}

export interface ExecutorCandidate {
  id: string;
  score: number;
  healthy: boolean;
  message: string;
  reason: "selected" | "unhealthy" | "not-probed";
}

export interface ExpertiseDecision {
  kind: LegKind;
  classification: Classification;
  /** Executor id to dispatch through, or null ⇒ defer to the ZOU-436 coder chain. */
  selected: string | null;
  deferToCoderChain: boolean;
  candidates: ExecutorCandidate[];
  rationale: string;
}

export interface ExpertiseArgs {
  text: string;
  profiles: ExecutorProfile[];
  healthProbe: HealthProbe;
}

/**
 * The routing decision. A CODE leg short-circuits to the coder chain with no
 * probe (selected=null, defer=true) — ZOU-436 owns coder selection. A RESEARCH
 * leg walks research-capable executors best-first and returns the first HEALTHY
 * one; if none is healthy it degrades to the coder chain (defer=true) so the task
 * still runs. Never throws: a probe that rejects is treated as unhealthy.
 */
export async function selectExecutorByExpertise(args: ExpertiseArgs): Promise<ExpertiseDecision> {
  const classification = classifyLeg(args.text);

  if (classification.kind === "code") {
    return {
      kind: "code",
      classification,
      selected: null,
      deferToCoderChain: true,
      candidates: [],
      rationale: "code leg → defer to ZOU-436 coder chain (a coder must own code)",
    };
  }

  const ranked = rankExecutorsForKind("research", args.profiles);
  const candidates: ExecutorCandidate[] = [];

  for (const { profile, score } of ranked) {
    let health: HealthResult;
    try {
      health = await args.healthProbe(profile.id);
    } catch (e) {
      health = { healthy: false, message: `probe threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (health.healthy) {
      candidates.push({ id: profile.id, score, healthy: true, message: health.message, reason: "selected" });
      return {
        kind: "research",
        classification,
        selected: profile.id,
        deferToCoderChain: false,
        candidates,
        rationale: `research leg → ${profile.id} (research score ${score}, healthy)`,
      };
    }
    candidates.push({ id: profile.id, score, healthy: false, message: health.message, reason: "unhealthy" });
  }

  return {
    kind: "research",
    classification,
    selected: null,
    deferToCoderChain: true,
    candidates,
    rationale:
      ranked.length === 0
        ? "research leg → no research-capable executor in registry; degrade to coder chain"
        : "research leg → all research executors unhealthy; degrade to coder chain",
  };
}
