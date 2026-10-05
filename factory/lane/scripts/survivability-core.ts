#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T1 (SF-012) — Survivability Core: fate ledger + scoring
 *
 * Post-merge fate of agent PRs. Append-only JSONL at
 * state/survivability-ledger.jsonl; re-probes append superseding rows and
 * reads resolve last-row-per-pr_ref (approval-ledger precedent). Scoring is
 * pure and honesty-gated: NO survival rate renders below min_sample per
 * bucket — a bucket under threshold reports insufficient_data, never a
 * number. The factory has zero merged PRs today, so every surface must be
 * able to say "n=0" without inventing data.
 *
 * Config: survivability-config.json (slo-config precedent) — committed,
 * fail-loud on invalid, absent file ⇒ built-in defaults identical to the
 * shipped JSON.
 *
 * Usage:
 *   bun survivability-core.ts show [--json]   (SF012_SURVIVAL=1 only)
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

export const FATES = ["survived", "reverted", "hotfixed"] as const;
export type Fate = (typeof FATES)[number];
export const OBSERVATION_WINDOWS_HOURS = [24, 168, 336] as const;
export type ObservationWindowHours = (typeof OBSERVATION_WINDOWS_HOURS)[number];

export interface FateRecord {
  pr_ref: string; // PR number as string, stable join key
  /**
   * owner/repo slug the PR belongs to. null on legacy rows written before
   * repo qualification (ZOU-1117) — those probed bare PR numbers against the
   * meta-repo's gh context and are excluded from scoring as unreliable.
   */
  repository?: string | null;
  ticket_id: string;
  archetype: string; // coarse line or "unknown"
  merged_at: string; // ISO-8601
  fate: Fate;
  time_to_first_hotfix_hours: number | null;
  churn_commits_14d: number | null;
  probed_at: string; // ISO-8601
  /** Exact retrospective cutoff used for classification. Absent only on legacy rows. */
  observation_window_hours?: ObservationWindowHours;
}

export interface SurvivabilityConfig {
  revert_window_days: number;
  churn_window_days: number;
  min_sample: number;
  lambda_max: number;
}

export interface LoadedSurvivabilityConfig {
  config: SurvivabilityConfig;
  source: "file" | "defaults";
  /** sha256 prefix (16 hex) — drift witness, not a security primitive. */
  hash: string;
}

export interface SurvivalBucket {
  n: number;
  survived: number;
  reverted: number;
  hotfixed: number;
  /** null whenever insufficient_data — a rate below min_sample never renders. */
  survival_rate: number | null;
  insufficient_data: boolean;
}

export interface SurvivabilityReport {
  /** Final 14-day outcome. Kept as the headline bucket for existing consumers. */
  global: SurvivalBucket;
  by_archetype: Record<string, SurvivalBucket>;
  by_window: Record<ObservationWindowHours, SurvivalBucket>;
  distinct_prs: number;
  torn_lines: number;
  min_sample: number;
  /** Legacy rows without repo qualification — never scored (pre-ZOU-1117 probes hit the wrong gh repo context). */
  excluded_unqualified: number;
  /** Qualified legacy/current-time rows without an exact milestone cutoff. */
  excluded_unwindowed: number;
}

// ─── Flags / paths ────────────────────────────────────────────────────────────

export function sf012Flags(): { survival: boolean; feedback: boolean } {
  return {
    survival: process.env.SF012_SURVIVAL === "1",
    feedback: process.env.SF012_FEEDBACK === "1",
  };
}

export const CANONICAL_SF012_PROJECT_DIR = "/home/workspace/Projects/zouroboros-software-factory";

export function resolveSf012ProjectDir(
  localProjectDir = join(import.meta.dir, ".."),
  override = process.env.SF012_PROJECT_DIR,
): string {
  if (override) return override;
  return localProjectDir.includes("/.runtime/factory-conveyor")
    ? CANONICAL_SF012_PROJECT_DIR
    : localProjectDir;
}

const PROJECT_DIR = resolveSf012ProjectDir();

export function survivabilityConfigPath(): string {
  return process.env.SF012_CONFIG_PATH || join(PROJECT_DIR, "survivability-config.json");
}

export function fateLedgerPath(): string {
  return resolveFactoryStateOverride(process.env.SF012_LEDGER_PATH, "survivability-ledger.jsonl");
}

// ─── Config (fail-loud, defaults identical to shipped JSON) ───────────────────

export const DEFAULT_SURVIVABILITY_CONFIG: SurvivabilityConfig = {
  revert_window_days: 14,
  churn_window_days: 14,
  min_sample: 5,
  lambda_max: 0.5,
};

const CONFIG_KEYS = ["revert_window_days", "churn_window_days", "min_sample", "lambda_max"];

export function validateSurvivabilityConfig(raw: unknown, path: string): SurvivabilityConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: config root must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  // Strict shape: an unknown key is likely a typo of an honesty knob —
  // silently ignoring it would loosen min-sample discipline (line-config precedent).
  for (const k of Object.keys(obj)) {
    if (!CONFIG_KEYS.includes(k)) {
      throw new Error(`${path}: unknown field '${k}' (valid: ${CONFIG_KEYS.join(", ")})`);
    }
  }
  for (const k of CONFIG_KEYS) {
    if (!(k in obj)) throw new Error(`${path}: missing field '${k}'`);
    if (typeof obj[k] !== "number" || !Number.isFinite(obj[k])) {
      throw new Error(`${path}: ${k} must be a finite number`);
    }
  }
  const c = obj as unknown as SurvivabilityConfig;
  if (!Number.isInteger(c.revert_window_days) || c.revert_window_days < 1) {
    throw new Error(`${path}: revert_window_days must be an integer >= 1`);
  }
  if (!Number.isInteger(c.churn_window_days) || c.churn_window_days < 1) {
    throw new Error(`${path}: churn_window_days must be an integer >= 1`);
  }
  if (!Number.isInteger(c.min_sample) || c.min_sample < 1) {
    throw new Error(`${path}: min_sample must be an integer >= 1`);
  }
  if (c.lambda_max < 0 || c.lambda_max > 1) {
    throw new Error(`${path}: lambda_max must be within [0, 1]`);
  }
  return c;
}

function configHash(config: SurvivabilityConfig): string {
  const canonical = JSON.stringify(Object.fromEntries(CONFIG_KEYS.map((k) => [k, config[k as keyof SurvivabilityConfig]])));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Absent file ⇒ defaults; present-but-invalid ⇒ THROW (fail-loud). */
export function loadSurvivabilityConfig(path = survivabilityConfigPath()): LoadedSurvivabilityConfig {
  if (!existsSync(path)) {
    return { config: DEFAULT_SURVIVABILITY_CONFIG, source: "defaults", hash: configHash(DEFAULT_SURVIVABILITY_CONFIG) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${path}: unparseable survivability config — ${err instanceof Error ? err.message : err}`);
  }
  const config = validateSurvivabilityConfig(raw, path);
  return { config, source: "file", hash: configHash(config) };
}

// ─── Ledger read (torn-tolerant, last-row-per-pr_ref) ────────────────────────

export interface FateLedger {
  records: FateRecord[]; // all parseable rows, file order
  torn_lines: number;
}

function isValidFateRecord(r: unknown): r is FateRecord {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.pr_ref === "string" &&
    o.pr_ref !== "" &&
    (o.repository === undefined || o.repository === null || (typeof o.repository === "string" && o.repository !== "")) &&
    typeof o.ticket_id === "string" &&
    typeof o.archetype === "string" &&
    typeof o.merged_at === "string" &&
    (FATES as readonly string[]).includes(o.fate as string) &&
    (o.time_to_first_hotfix_hours === null || typeof o.time_to_first_hotfix_hours === "number") &&
    (o.churn_commits_14d === null || typeof o.churn_commits_14d === "number") &&
    typeof o.probed_at === "string" &&
    (o.observation_window_hours === undefined ||
      (OBSERVATION_WINDOWS_HOURS as readonly number[]).includes(o.observation_window_hours as number))
  );
}

export function readFateLedger(path = fateLedgerPath()): FateLedger {
  const out: FateLedger = { records: [], torn_lines: 0 };
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (isValidFateRecord(rec)) out.records.push(rec);
      else out.torn_lines++;
    } catch {
      out.torn_lines++;
    }
  }
  return out;
}

/** Repo-qualified join key. Legacy rows without repository get their own key space. */
export function fateKey(r: Pick<FateRecord, "pr_ref" | "repository">): string {
  return `${r.repository ?? "unqualified"}#${r.pr_ref}`;
}

/** Superseding-append semantics: the LAST row per (repository, pr_ref) is current. */
export function latestFates(records: FateRecord[]): Map<string, FateRecord> {
  const latest = new Map<string, FateRecord>();
  for (const r of records) latest.set(fateKey(r), r);
  return latest;
}

export function fateObservationKey(
  r: Pick<FateRecord, "pr_ref" | "repository" | "observation_window_hours">,
): string {
  return `${fateKey(r)}@${r.observation_window_hours ?? "legacy"}`;
}

export function latestFateObservations(records: FateRecord[]): Map<string, FateRecord> {
  const latest = new Map<string, FateRecord>();
  for (const r of records) latest.set(fateObservationKey(r), r);
  return latest;
}

// ─── Scoring (pure, min-sample honesty) ───────────────────────────────────────

function emptyBucket(): SurvivalBucket {
  return { n: 0, survived: 0, reverted: 0, hotfixed: 0, survival_rate: null, insufficient_data: true };
}

function finalizeBucket(b: SurvivalBucket, minSample: number): void {
  b.insufficient_data = b.n < minSample;
  b.survival_rate = b.insufficient_data ? null : Math.round((b.survived / b.n) * 10000) / 10000;
}

export function computeSurvivability(
  records: FateRecord[],
  config: SurvivabilityConfig = DEFAULT_SURVIVABILITY_CONFIG,
  tornLines = 0,
): SurvivabilityReport {
  const current = latestFateObservations(records);
  const global = emptyBucket();
  const by_archetype: Record<string, SurvivalBucket> = {};
  const by_window = Object.fromEntries(
    OBSERVATION_WINDOWS_HOURS.map((hours) => [hours, emptyBucket()]),
  ) as Record<ObservationWindowHours, SurvivalBucket>;
  let excludedUnqualified = 0;
  let excludedUnwindowed = 0;
  for (const rec of current.values()) {
    if (rec.repository === undefined || rec.repository === null) {
      excludedUnqualified++;
      continue;
    }
    if (rec.observation_window_hours === undefined) {
      excludedUnwindowed++;
      continue;
    }
    const windowBucket = by_window[rec.observation_window_hours];
    windowBucket.n++;
    windowBucket[rec.fate]++;
    if (rec.observation_window_hours !== 336) continue;
    const slice = (by_archetype[rec.archetype] ??= emptyBucket());
    for (const b of [global, slice]) {
      b.n++;
      b[rec.fate]++;
    }
  }
  finalizeBucket(global, config.min_sample);
  for (const b of Object.values(by_window)) finalizeBucket(b, config.min_sample);
  for (const b of Object.values(by_archetype)) finalizeBucket(b, config.min_sample);
  return {
    global,
    by_archetype,
    by_window,
    distinct_prs: global.n,
    torn_lines: tornLines,
    min_sample: config.min_sample,
    excluded_unqualified: excludedUnqualified,
    excluded_unwindowed: excludedUnwindowed,
  };
}

// ─── Reputation blend (T3 — pure, cold-start safe, advisory-only v1) ──────────

export interface BlendedReputation {
  lambda: number;
  agreement_rate: number | null;
  agreement_resolved: number;
  survival_rate: number | null;
  survivability_n: number;
  /** true when min-sample forced lambda to 0 — blended === agreement-only. */
  cold_start: boolean;
  /** null when there is no agreement baseline to blend into. */
  blended: number | null;
}

/**
 * Extends the trace_id λ-ramp precedent to survivability: λ is HARD 0 below
 * min_sample (blended is then exactly the agreement-only rate — zero
 * regression while the factory has no merge history), then ramps linearly
 * with sample count to lambda_max at 2×min_sample. NEVER mutates the
 * approval ledger — pure over already-computed stats.
 */
export function blendReputation(
  agreement: { rate: number | null; resolved: number },
  survivability: SurvivalBucket,
  config: SurvivabilityConfig = DEFAULT_SURVIVABILITY_CONFIG,
): BlendedReputation {
  const n = survivability.n;
  const coldStart = n < config.min_sample;
  const lambda = coldStart
    ? 0
    : Math.round(config.lambda_max * Math.min(1, n / (2 * config.min_sample)) * 10000) / 10000;
  let blended: number | null = null;
  if (agreement.rate !== null) {
    blended =
      lambda === 0 || survivability.survival_rate === null
        ? agreement.rate
        : Math.round(((1 - lambda) * agreement.rate + lambda * survivability.survival_rate) * 10000) / 10000;
  }
  return {
    lambda,
    agreement_rate: agreement.rate,
    agreement_resolved: agreement.resolved,
    survival_rate: survivability.survival_rate,
    survivability_n: n,
    cold_start: coldStart,
    blended,
  };
}

export function renderBlend(b: BlendedReputation): string {
  const fmt = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  return (
    `[sf012] reputation blend (advisory): agreement-only=${fmt(b.agreement_rate)} (${b.agreement_resolved} resolved) ` +
    `survivability=${fmt(b.survival_rate)} (n=${b.survivability_n}) λ=${b.lambda}${b.cold_start ? " [cold-start: λ=0, below min-sample]" : ""} ` +
    `→ blended=${fmt(b.blended)}${b.blended !== null && b.agreement_rate !== null && b.blended === b.agreement_rate ? " (= agreement-only)" : ""}`
  );
}

// ─── Rendering (honest empty states) ─────────────────────────────────────────

export function renderBucket(name: string, b: SurvivalBucket): string {
  const rate = b.insufficient_data
    ? `insufficient data (n=${b.n} < min_sample)`
    : `${((b.survival_rate ?? 0) * 100).toFixed(1)}%`;
  return `${name.padEnd(12)} n=${b.n} survived=${b.survived} reverted=${b.reverted} hotfixed=${b.hotfixed} rate=${rate}`;
}

export function renderSurvivability(report: SurvivabilityReport): string {
  const lines: string[] = [];
  lines.push(`Survivability (min_sample=${report.min_sample}, distinct PRs=${report.distinct_prs}${report.torn_lines ? `, torn=${report.torn_lines}` : ""})`);
  lines.push(`  ${renderBucket("global", report.global)}`);
  for (const hours of OBSERVATION_WINDOWS_HOURS) {
    lines.push(`  ${renderBucket(hours === 24 ? "24h" : `${hours / 24}d`, report.by_window[hours])}`);
  }
  for (const key of Object.keys(report.by_archetype).sort()) {
    lines.push(`  ${renderBucket(key, report.by_archetype[key])}`);
  }
  if (report.distinct_prs === 0) {
    lines.push("  (no merged agent PRs probed yet — trailing quality unmeasurable, by design no synthetic data)");
  }
  return lines.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "show" && cmd !== "blend") {
    console.error(
      "usage: survivability-core.ts show [--json]    (requires SF012_SURVIVAL=1)\n" +
        "       survivability-core.ts blend [--json]   (requires SF012_FEEDBACK=1 — advisory log only)",
    );
    process.exit(2);
  }
  if (cmd === "show") {
    // Flag gate BEFORE any read/write (SF-008/SF-009 precedent).
    if (!sf012Flags().survival) process.exit(0);
    const loaded = loadSurvivabilityConfig();
    const ledger = readFateLedger();
    const report = computeSurvivability(ledger.records, loaded.config, ledger.torn_lines);
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ config: loaded, report }, null, 2));
    } else {
      console.log(`config source=${loaded.source} hash=${loaded.hash}`);
      console.log(renderSurvivability(report));
    }
    process.exit(0);
  }
  // blend: advisory-only v1 — compares blended vs agreement-only reputation.
  // Reads the approval ledger via its pure stats; NEVER writes anything.
  if (!sf012Flags().feedback) process.exit(0);
  const { agreementStats } = await import("./approval-ledger");
  const stats = agreementStats();
  const loaded = loadSurvivabilityConfig();
  const ledger = readFateLedger();
  const report = computeSurvivability(ledger.records, loaded.config, ledger.torn_lines);
  const blend = blendReputation({ rate: stats.rate, resolved: stats.resolved }, report.global, loaded.config);
  if (rest.includes("--json")) console.log(JSON.stringify(blend, null, 2));
  else console.log(renderBlend(blend));
  process.exit(0);
}
