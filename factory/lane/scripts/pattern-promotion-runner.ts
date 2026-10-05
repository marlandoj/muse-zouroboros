#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * ZOU-438 T2 — Self-evolving pipeline: pattern-promotion RUNNER (CLI + I/O).
 *
 * Loads the winning-seed corpus (seed-<id>.yaml whose evaluations/<id>.verdict.json
 * is verdict=="pass"), asks the pure core for promotion proposals, and — when enabled
 * — writes an operator-review artifact (evaluations/pattern-promotion.proposed.md) plus
 * an append-only audit row (state/pattern-promotion-ledger.jsonl). It NEVER edits the
 * spec template (prespec-runner.ts buildPrespecPrompt). The operator promotes.
 *
 * Default OFF: SF_PATTERN_PROMOTION unset → run() is a no-op (conveyor byte-identical).
 * --dry-run always previews the proposals with zero writes and zero network.
 *
 * Flags:
 *   SF_PATTERN_PROMOTION=1            proposer on (opt-in). Default OFF.
 *   SF_PATTERN_PROMOTION_MIN_SEEDS   min winning corpus to propose. Default 5.
 *   SF_PATTERN_PROMOTION_MIN_FREQ    min winner-frequency for a candidate. Default 0.6.
 *
 * CLI:
 *   bun pattern-promotion-runner.ts [--dry-run] [--json] [--min-seeds n] [--min-freq f] [--seeds-dir p]
 *
 * Exit codes: 0 ok · 1 error.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  formatProposals,
  proposalHash,
  proposePromotions,
  type PromotionResult,
  type WinningSeed,
} from "./pattern-promotion-core";
import { parseVerdict } from "./factory-verdict";

// ─── Paths / flags ────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_SEEDS_DIR = REPO_ROOT;
const EVAL_DIR = join(REPO_ROOT, "evaluations");
const STATE_DIR = factoryStateRoot();
export const PROPOSED_PATH = join(EVAL_DIR, "pattern-promotion.proposed.md");
export const LEDGER_PATH = join(STATE_DIR, "pattern-promotion-ledger.jsonl");

export interface PromotionFlags {
  enabled: boolean;
  minSeeds: number | undefined;
  minFrequency: number | undefined;
}

export function currentPromotionFlags(
  env: Record<string, string | undefined> = process.env,
): PromotionFlags {
  const seeds = Number.parseInt(env.SF_PATTERN_PROMOTION_MIN_SEEDS ?? "", 10);
  const freq = Number.parseFloat(env.SF_PATTERN_PROMOTION_MIN_FREQ ?? "");
  return {
    enabled: env.SF_PATTERN_PROMOTION === "1",
    minSeeds: Number.isFinite(seeds) && seeds > 0 ? seeds : undefined,
    minFrequency: Number.isFinite(freq) && freq > 0 && freq <= 1 ? freq : undefined,
  };
}

// ─── Winning-seed corpus loader ────────────────────────────────────────────────

/**
 * Resolve a seed's verdict file. seed-<id>.yaml → try evaluations/<id>.verdict.json,
 * then progressively-stripped variants (sf006-dedup → sf006; zou-437 → zou-437).
 */
function resolveVerdictPath(evalDir: string, seedId: string): string | null {
  const variants = [seedId, seedId.replace(/-.*$/, ""), seedId.split("-").slice(0, 2).join("-")];
  for (const v of variants) {
    const p = join(evalDir, `${v}.verdict.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read seed-*.yaml with a passing verdict; parse YAML (array doc → first element). */
export function loadWinningSeeds(seedsDir: string, evalDir: string): WinningSeed[] {
  if (!existsSync(seedsDir)) return [];
  const winners: WinningSeed[] = [];
  const files = readdirSync(seedsDir)
    .filter((f) => f.startsWith("seed-") && f.endsWith(".yaml"))
    .sort();
  for (const file of files) {
    const id = file.replace(/^seed-/, "").replace(/\.yaml$/, "");
    const verdictPath = resolveVerdictPath(evalDir, id);
    if (!verdictPath) continue;
    let rework = false;
    try {
      const parsed = parseVerdict(JSON.parse(readFileSync(verdictPath, "utf-8")));
      if (!parsed.ok || parsed.verdict.verdict !== "pass") continue;
      rework = parsed.verdict.rework;
    } catch {
      continue;
    }
    let raw: Record<string, unknown> | null = null;
    try {
      const doc = Bun.YAML.parse(readFileSync(join(seedsDir, file), "utf-8"));
      const top = Array.isArray(doc) ? doc[0] : doc;
      if (top && typeof top === "object") raw = top as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!raw) continue;
    winners.push({ id, rework, raw });
  }
  return winners;
}

// ─── Artifact writers ──────────────────────────────────────────────────────────

function renderProposedMarkdown(result: PromotionResult, nowIso: string): string {
  const lines: string[] = [];
  lines.push(`# Spec-Template Promotion Proposal (ZOU-438 SF-P3)`);
  lines.push("");
  lines.push(`_Generated ${nowIso} · advisory — NOT auto-applied. Operator promotes by editing`);
  lines.push(`prespec-runner.ts buildPrespecPrompt. This file is regenerated each run._`);
  lines.push("");
  lines.push(
    `Winning corpus: **${result.corpus_size}** seed(s) with verdict=pass` +
      (result.cold_start ? ` — **COLD START** (< ${result.min_seeds}); nothing proposed.` : "."),
  );
  lines.push(`Thresholds: min-frequency=${result.min_frequency}, min-seeds=${result.min_seeds}.`);
  lines.push("");

  if (result.proposals.length === 0) {
    lines.push(`## Proposals`);
    lines.push("");
    lines.push(
      result.cold_start
        ? `_None — corpus below the cold-start floor._`
        : `_None — every high-frequency winning feature is already mandated by the template._`,
    );
  } else {
    lines.push(`## Proposed template additions (${result.proposals.length})`);
    lines.push("");
    lines.push(
      `These features recur in winning seeds at ≥ ${(result.min_frequency * 100).toFixed(0)}% but the`,
    );
    lines.push(`current template does not mandate them. Consider adding each line to buildPrespecPrompt:`);
    lines.push("");
    for (const p of result.proposals) {
      lines.push(`### ${p.feature} — ${(p.frequency * 100).toFixed(0)}% (${p.count}/${p.total})`);
      lines.push("");
      lines.push(`- **What:** ${p.label}`);
      lines.push(`- **Propose adding:** ${p.suggested_template_line}`);
      lines.push(`- **Seen in:** ${p.supporting_seeds.join(", ")}`);
      lines.push("");
    }
  }

  if (result.underused_mandates.length > 0) {
    lines.push(`## Underused template mandates (informational)`);
    lines.push("");
    lines.push(`The template already mandates these, but winners adhere below threshold —`);
    lines.push(`review whether the mandate is worth keeping (not auto-changed):`);
    lines.push("");
    for (const u of result.underused_mandates) {
      lines.push(`- **${u.feature}** — ${(u.frequency * 100).toFixed(0)}% (${u.count}/${u.total}): ${u.label}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

/** Latest ledger row's proposal_hash, or null if the ledger is empty/unreadable. */
function latestProposalHash(ledgerPath: string): string | null {
  if (!existsSync(ledgerPath)) return null;
  const lines = readFileSync(ledgerPath, "utf-8").split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  try {
    return (JSON.parse(lines[lines.length - 1]) as { proposal_hash?: string }).proposal_hash ?? null;
  } catch {
    return null;
  }
}

// ─── Runner ────────────────────────────────────────────────────────────────────

export interface RunDeps {
  loadWinningSeeds: () => WinningSeed[];
  writeProposed: (markdown: string) => void;
  appendLedger: (row: unknown) => void;
  latestProposalHash: () => string | null;
  nowMs: number;
}

function defaultDeps(seedsDir: string, evalDir: string): RunDeps {
  return {
    loadWinningSeeds: () => loadWinningSeeds(seedsDir, evalDir),
    writeProposed: (markdown) => {
      if (!existsSync(EVAL_DIR)) mkdirSync(EVAL_DIR, { recursive: true });
      writeFileSync(PROPOSED_PATH, markdown);
    },
    appendLedger: (row) => {
      if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
      appendFileSync(LEDGER_PATH, JSON.stringify(row) + "\n");
    },
    latestProposalHash: () => latestProposalHash(LEDGER_PATH),
    nowMs: Date.now(),
  };
}

export interface RunResult {
  enabled: boolean;
  dry_run: boolean;
  wrote_proposed: boolean;
  appended_ledger: boolean;
  proposal_hash: string;
  result: PromotionResult;
}

export async function run(opts: {
  dryRun: boolean;
  minSeeds?: number;
  minFrequency?: number;
  seedsDir?: string;
  deps?: Partial<RunDeps>;
}): Promise<RunResult> {
  const flags = currentPromotionFlags();
  const seedsDir = opts.seedsDir ?? DEFAULT_SEEDS_DIR;
  const deps = { ...defaultDeps(seedsDir, EVAL_DIR), ...opts.deps };

  const result: PromotionResult = { corpus_size: 0, cold_start: true, min_seeds: 0, min_frequency: 0, proposals: [], already_mandated: [], underused_mandates: [] };
  const out: RunResult = {
    enabled: flags.enabled,
    dry_run: opts.dryRun,
    wrote_proposed: false,
    appended_ledger: false,
    proposal_hash: "",
    result,
  };

  // Default OFF: unset SF_PATTERN_PROMOTION → no-op, no reads, no writes.
  // (--dry-run is diagnostic and MAY run with the flag off to preview.)
  if (!flags.enabled && !opts.dryRun) return out;

  const seeds = deps.loadWinningSeeds();
  const computed = proposePromotions(seeds, {
    minSeeds: opts.minSeeds ?? flags.minSeeds,
    minFrequency: opts.minFrequency ?? flags.minFrequency,
  });
  out.result = computed;
  out.proposal_hash = proposalHash(computed);

  if (opts.dryRun || !flags.enabled) return out;

  // Enabled + live: write the proposal artifact, append an audit row (idempotent on
  // unchanged proposal_hash — no corpus change → no ledger churn).
  const nowIso = new Date(deps.nowMs).toISOString();
  deps.writeProposed(renderProposedMarkdown(computed, nowIso));
  out.wrote_proposed = true;

  if (deps.latestProposalHash() !== out.proposal_hash) {
    deps.appendLedger({
      ran_at: nowIso,
      corpus_size: computed.corpus_size,
      cold_start: computed.cold_start,
      proposed: computed.proposals.map((p) => p.feature),
      proposal_hash: out.proposal_hash,
      min_seeds: computed.min_seeds,
      min_frequency: computed.min_frequency,
    });
    out.appended_ledger = true;
  }
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function renderHuman(r: RunResult): string {
  const lines: string[] = [];
  const mode = r.dry_run ? "DRY-RUN (zero writes)" : r.enabled ? "LIVE" : "DISABLED (no-op)";
  lines.push(`pattern-promotion-runner: ${mode}`);
  if (!r.enabled && !r.dry_run) {
    lines.push("  SF_PATTERN_PROMOTION unset → no-op (spec template + ledger untouched).");
    return lines.join("\n");
  }
  lines.push(formatProposals(r.result));
  if (!r.dry_run && r.enabled) {
    lines.push(`  wrote ${PROPOSED_PATH}`);
    lines.push(r.appended_ledger ? `  appended ledger row (${r.proposal_hash.slice(0, 12)})` : `  ledger unchanged (same proposal_hash) — no row appended`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "min-seeds": { type: "string" },
      "min-freq": { type: "string" },
      "seeds-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(
      "pattern-promotion-runner — propose winning-seed patterns into the spec template (never auto-apply)\n" +
        "  bun pattern-promotion-runner.ts [--dry-run] [--json] [--min-seeds n] [--min-freq f] [--seeds-dir p]",
    );
    return;
  }

  const minSeeds = values["min-seeds"] !== undefined ? Number.parseInt(String(values["min-seeds"]), 10) : undefined;
  const minFrequency = values["min-freq"] !== undefined ? Number.parseFloat(String(values["min-freq"])) : undefined;
  if (minSeeds !== undefined && (!Number.isFinite(minSeeds) || minSeeds <= 0)) {
    throw new Error(`--min-seeds must be a positive integer (got "${values["min-seeds"]}")`);
  }
  if (minFrequency !== undefined && (!Number.isFinite(minFrequency) || minFrequency <= 0 || minFrequency > 1)) {
    throw new Error(`--min-freq must be in (0, 1] (got "${values["min-freq"]}")`);
  }

  const result = await run({
    dryRun: Boolean(values["dry-run"]),
    minSeeds,
    minFrequency,
    seedsDir: values["seeds-dir"] !== undefined ? String(values["seeds-dir"]) : undefined,
  });
  console.log(values.json ? JSON.stringify(result, null, 2) : renderHuman(result));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`pattern-promotion-runner: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
