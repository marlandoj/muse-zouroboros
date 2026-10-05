#!/usr/bin/env bun
/**
 * T1 (SF-002) — Risk Classifier Core
 *
 * Pure deterministic classifier: no LLM, no network. Scores every
 * PipelineExecution at dispatch time (DIRECT and SWARM alike) into
 * tier low|medium|high with an auditable score + reasons + input snapshot.
 *
 * Usage:
 *   bun risk-classifier.ts classify --ticket <json-file|-> --decision DIRECT [--seed-score 0.9]
 *   bun risk-classifier.ts self-test
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
// Runtime-safe: approval-ledger imports only types from this module, so no cycle.
import { calibrationGate, computeCalibration } from "./approval-ledger";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskTier = "low" | "medium" | "high";
export type GateDecision = "DIRECT" | "SWARM" | "FORCE_SWARM" | "SUGGEST" | "ERROR";

export interface ClassifierInputs {
  archetype: string;
  target_repo: string;
  repro: string;
  acceptance_criteria: string;
  gate_decision: GateDecision;
  files_touched_estimate: number;
  schema_contact: boolean;
  secret_contact: boolean;
  infra_contact: boolean;
  reversibility: "easy" | "hard";
  seed_eval_score: number | null;
}

export interface RiskVerdict {
  verdict_id: string;
  execution_id: string;
  ticket_id: string;
  identifier: string;
  tier: RiskTier;
  score: number;
  reasons: string[];
  inputs: ClassifierInputs;
  classified_at: string;
  mode: "shadow" | "enforce";
  acted: boolean;
}

export interface TicketLike {
  linear_id: string;
  identifier: string;
  title: string;
  description: string;
}

// ─── Surface detection (path/keyword rules, deterministic) ───────────────────

const SCHEMA_RE =
  /\bmigrations?\b|\bschema\b|alter\s+table|drop\s+table|\bDDL\b|database\s+(change|migration)|\.sql\b/i;
const SECRET_RE =
  /\.env\b|\bsecrets?\b|\bcredentials?\b|api[\s_-]?key|token\s+rotation|\bpasswords?\b|\.zo_secrets/i;
const INFRA_RE =
  /dockerfile|docker-compose|\.github\/workflows|terraform|kubernetes|\bk8s\b|\binfra\/|nginx|supervisord|\bdeploy(ment)?\s+(pipeline|config|script)/i;
const IRREVERSIBLE_RE =
  /delete\s+(data|records|rows)|\bdrop\b|irreversible|force[\s-]?push|purge|truncate/i;
const FILE_PATH_RE =
  /[\w@./-]+\.(ts|tsx|js|jsx|py|md|json|yaml|yml|sql|sh|toml|css|html)\b/g;

/**
 * Canonical archetype vocabulary (ZOU-1196). Every surface speaks through this:
 * the ticket-contract enum (fix, infra, docs, …), the auto-merge allowlist
 * (doc_fix, dependency_bump, lint_codemod, test_addition), and freehand ticket
 * values. Raw values arrive with markdown formatting (`feature`) — un-canonical
 * lookups silently fell through to the 0.4 unknown default and made allowlist
 * work structurally unable to tier low.
 */
const ARCHETYPE_ALIASES: Record<string, string> = {
  fix: "bugfix",
  hotfix: "bugfix",
  doc: "docs",
  doc_fix: "docs",
  documentation: "docs",
  deps: "dependency",
  dependency_bump: "dependency",
  feat: "feature",
  lint: "lint_codemod",
  codemod: "lint_codemod",
  test: "test_addition",
  tests: "test_addition",
};

export function canonicalizeArchetype(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .replace(/[`*"'|]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "unknown";
  return ARCHETYPE_ALIASES[cleaned] ?? cleaned;
}

/** Canonical archetypes the evidence-gated auto-lane exists to merge (mirrors archetype-allowlist BUILTIN_ARCHETYPES). */
export const AUTO_LANE_ARCHETYPES: ReadonlySet<string> = new Set(["docs", "dependency", "lint_codemod", "test_addition"]);

/**
 * Auto-lane eligibility of the WORK itself (not the score): allowlist archetype
 * with no risky surface contact. Used by the calibration matrix — an approved
 * hold is a FALSE hold only when the held work was eligible to auto-proceed.
 */
export function autoLaneEligibleInputs(inputs: Pick<ClassifierInputs, "archetype" | "schema_contact" | "secret_contact" | "infra_contact" | "reversibility">): boolean {
  return (
    AUTO_LANE_ARCHETYPES.has(canonicalizeArchetype(inputs.archetype)) &&
    !inputs.schema_contact &&
    !inputs.secret_contact &&
    !inputs.infra_contact &&
    inputs.reversibility === "easy"
  );
}

// Deliberate per-archetype risk bases (unknown stays 0.4 — fail-closed).
// infra is explicitly ≥ the medium boundary: CI/deploy/config work must never
// auto-proceed on archetype alone. tierFor thresholds are unchanged.
const ARCHETYPE_BASE: Record<string, number> = {
  dependency: 0.05,
  docs: 0.05,
  lint_codemod: 0.05,
  test_addition: 0.1,
  audit: 0.1,
  seo: 0.15,
  bugfix: 0.15,
  scaffold: 0.2,
  feature: 0.3,
  refactor: 0.35,
  integration: 0.35,
  remediation: 0.35,
  infra: 0.45,
  migration: 0.7,
};

const DEFAULT_FILES_BY_ARCHETYPE: Record<string, number> = {
  dependency: 3,
  docs: 1,
  lint_codemod: 4,
  test_addition: 2,
  audit: 1,
  seo: 2,
  bugfix: 2,
  scaffold: 4,
  feature: 5,
  refactor: 8,
  integration: 6,
  remediation: 6,
  infra: 4,
  migration: 6,
};

/**
 * Parse contract fields from a ticket description. Supports both contract
 * shapes the intake produces: `## Header` sections and `**field:** value`
 * inline-bold lines (inline-bold wins when both are present).
 */
export function parseContractFields(description: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Lookahead must be next-header-or-end-of-string; `\s*$` with /m would stop
  // the lazy group at the first line-end and truncate multi-line sections.
  const sectionRe = /^##\s+([\w /-]+?)[^\S\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/gm;
  let sm: RegExpExecArray | null;
  while ((sm = sectionRe.exec(description)) !== null) {
    const key = sm[1].trim().toLowerCase().replace(/[\s/-]+/g, "_");
    const val = sm[2].trim();
    if (val) fields[key] = val;
  }
  for (const line of description.split("\n")) {
    const m = line.match(/^\*\*(\w[\w\s/]*?):\*\*\s*(.*)$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/[\s/]/g, "_");
      const val = m[2].trim();
      if (val) fields[key] = val;
    }
  }
  return fields;
}

export function estimateFilesTouched(text: string, archetype: string): number {
  const paths = new Set((text.match(FILE_PATH_RE) ?? []).map((p) => p.toLowerCase()));
  if (paths.size > 0) return paths.size;
  return DEFAULT_FILES_BY_ARCHETYPE[archetype] ?? 5;
}

export function buildInputs(
  fields: { archetype?: string; target_repo?: string; repro?: string; acceptance_criteria?: string },
  ticketText: string,
  gateDecision: GateDecision,
  seedEvalScore: number | null = null
): ClassifierInputs {
  const archetype = canonicalizeArchetype(fields.archetype);
  const text = `${ticketText}\n${fields.repro ?? ""}\n${fields.acceptance_criteria ?? ""}`;
  const schema = SCHEMA_RE.test(text) || archetype === "migration";
  const secret = SECRET_RE.test(text);
  const infra = INFRA_RE.test(text);
  return {
    archetype,
    target_repo: (fields.target_repo ?? "").trim(),
    repro: (fields.repro ?? "").trim(),
    acceptance_criteria: (fields.acceptance_criteria ?? "").trim(),
    gate_decision: gateDecision,
    files_touched_estimate: estimateFilesTouched(text, archetype),
    schema_contact: schema,
    secret_contact: secret,
    infra_contact: infra,
    reversibility: schema || secret || infra || IRREVERSIBLE_RE.test(text) ? "hard" : "easy",
    seed_eval_score: seedEvalScore,
  };
}

// ─── Scoring (pure) ───────────────────────────────────────────────────────────

export function scoreRisk(inputs: ClassifierInputs): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  // Canonicalize here too (not only in buildInputs): stored historical inputs
  // carry raw values like '`feature`' and are re-scored by the calibration matrix.
  const archetype = canonicalizeArchetype(inputs.archetype);
  let score = ARCHETYPE_BASE[archetype] ?? 0.4;
  reasons.push(`archetype '${archetype}' base ${score.toFixed(2)}`);

  if (inputs.schema_contact) {
    score += 0.25;
    reasons.push("schema/migration contact +0.25");
  }
  if (inputs.secret_contact) {
    score += 0.3;
    reasons.push("secret/credential contact +0.30");
  }
  if (inputs.infra_contact) {
    score += 0.2;
    reasons.push("infra/CI contact +0.20");
  }

  const f = inputs.files_touched_estimate;
  const fBump = f <= 2 ? 0 : f <= 5 ? 0.05 : f <= 10 ? 0.1 : 0.2;
  if (fBump > 0) reasons.push(`files-touched est ${f} +${fBump.toFixed(2)}`);
  score += fBump;

  if (inputs.gate_decision === "SWARM" || inputs.gate_decision === "FORCE_SWARM") {
    score += 0.1;
    reasons.push(`gate ${inputs.gate_decision} (multi-task scope) +0.10`);
  } else if (inputs.gate_decision === "SUGGEST") {
    score += 0.05;
    reasons.push("gate SUGGEST +0.05");
  }

  if (inputs.reversibility === "hard") {
    score += 0.1;
    reasons.push("hard reversibility +0.10");
  }

  if (inputs.seed_eval_score !== null) {
    const credit = Math.min(Math.max(inputs.seed_eval_score, 0), 1) * 0.1;
    score -= credit;
    reasons.push(`seed-eval score ${inputs.seed_eval_score} -${credit.toFixed(2)}`);
  }

  // Secret/credential contact must never auto-proceed: floor at the high-tier boundary.
  if (inputs.secret_contact && score < 0.65) {
    score = 0.65;
    reasons.push("secret contact floors score at 0.65 (high tier)");
  }

  score = Math.min(Math.max(score, 0), 1);
  return { score: Number(score.toFixed(3)), reasons };
}

export function tierFor(score: number): RiskTier {
  if (score < 0.35) return "low";
  if (score < 0.65) return "medium";
  return "high";
}

export function classifyRisk(
  ticket: TicketLike,
  inputs: ClassifierInputs,
  executionId: string,
  mode: "shadow" | "enforce"
): RiskVerdict {
  const { score, reasons } = scoreRisk(inputs);
  return {
    verdict_id: `rv-${randomUUID()}`,
    execution_id: executionId,
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    tier: tierFor(score),
    score,
    reasons,
    inputs,
    classified_at: new Date().toISOString(),
    mode,
    acted: false,
  };
}

export function currentMode(): "shadow" | "enforce" {
  return process.env.SF002_ENFORCE === "1" ? "enforce" : "shadow";
}

// ─── Auto-promote lane (SF002_AUTO_PROMOTE, hard blast-radius ceiling) ────────
//
// The lane only ever widens MEDIUM-tier holds: low always auto-proceeds and
// high always holds (AC5). Pure — caller checks the env flag and supplies the
// resolved-decision count from the ledger (≥20 baseline is enforced here, in
// code, not just in the report).

export const AUTO_PROMOTE_MAX_FILES = 10;
export const AUTO_PROMOTE_MIN_BASELINE = 20;

export interface AutoPromoteDecision {
  eligible: boolean;
  reasons: string[];
}

/**
 * ZOU-435 learned auto-approval: an optional per-archetype earned-credit baseline
 * (from reputation-core) that REPLACES the flat global ≥20-decision baseline. When
 * omitted, behavior is byte-identical to the legacy flat gate. The blast-radius
 * ceiling (medium-only, ≤10 files, no schema/secret/infra) is enforced regardless.
 */
export interface ReputationBaselineLike {
  eligible: boolean;
  source: string;
  reasons: string[];
}

/**
 * ZOU-1110: calibration gate summary consumed by autoPromoteEligible. When the
 * caller does not inject one, the real deduped ledger calibration is loaded and
 * any load failure fails closed. Count-only eligibility is no longer possible.
 */
export interface CalibrationGateLike {
  eligible: boolean;
  reasons: string[];
}

function loadLiveCalibration(): CalibrationGateLike {
  try {
    const gate = calibrationGate(computeCalibration());
    return { eligible: gate.eligible, reasons: gate.reasons };
  } catch (err) {
    return { eligible: false, reasons: [`calibration unavailable (${String(err)}) — fail closed`] };
  }
}

export function autoPromoteEligible(
  verdict: RiskVerdict,
  resolvedDecisions: number,
  reputationBaseline?: ReputationBaselineLike,
  calibration?: CalibrationGateLike
): AutoPromoteDecision {
  const reasons: string[] = [];
  if (verdict.tier !== "medium") {
    reasons.push(`tier '${verdict.tier}' — lane applies to medium only`);
  }
  // Baseline sufficiency: earned per-archetype reputation (ZOU-435) when supplied,
  // else the legacy flat global decision count.
  if (reputationBaseline) {
    if (!reputationBaseline.eligible) {
      reasons.push(`reputation baseline unmet — ${reputationBaseline.reasons[0] ?? "insufficient earned credit"}`);
    }
  } else if (resolvedDecisions < AUTO_PROMOTE_MIN_BASELINE) {
    reasons.push(`baseline ${resolvedDecisions}/${AUTO_PROMOTE_MIN_BASELINE} decisions — auto-lane blocked`);
  }
  // ZOU-1110: calibration must pass regardless of which baseline path applied.
  // Count (or earned reputation) proves volume; calibration proves the classifier
  // and operator actually agree on allow/hold behavior.
  const calib = calibration ?? loadLiveCalibration();
  if (!calib.eligible) {
    reasons.push(`calibration gate failed — ${calib.reasons[0] ?? "calibration unproven"}`);
  }
  if (verdict.inputs.files_touched_estimate > AUTO_PROMOTE_MAX_FILES) {
    reasons.push(`files-touched ${verdict.inputs.files_touched_estimate} > ceiling ${AUTO_PROMOTE_MAX_FILES}`);
  }
  if (verdict.inputs.schema_contact) reasons.push("forbidden surface: schema/migration");
  if (verdict.inputs.secret_contact) reasons.push("forbidden surface: secret/credential");
  if (verdict.inputs.infra_contact) reasons.push("forbidden surface: infra/CI");
  if (reasons.length > 0) return { eligible: false, reasons };
  return {
    eligible: true,
    reasons: [
      reputationBaseline
        ? `medium tier within blast-radius ceiling, reputation baseline earned (${reputationBaseline.reasons[0] ?? ""})`
        : "medium tier within blast-radius ceiling, baseline met",
    ],
  };
}

// ─── Self-test fixtures ───────────────────────────────────────────────────────

function selfTest(): number {
  const cases: Array<{ name: string; fields: Record<string, string>; text: string; gate: GateDecision; seed: number | null; expect: RiskTier }> = [
    {
      name: "docs fix → low",
      fields: { archetype: "docs", target_repo: "zouroboros", repro: "README typo", acceptance_criteria: "typo fixed" },
      text: "Fix typo in README.md",
      gate: "DIRECT",
      seed: null,
      expect: "low",
    },
    {
      name: "dependency bump → low",
      fields: { archetype: "dependency", target_repo: "zouroboros", repro: "package.json", acceptance_criteria: "bump hono to 4.x, tests pass" },
      text: "Bump hono in package.json",
      gate: "DIRECT",
      seed: null,
      expect: "low",
    },
    {
      name: "feature w/ swarm scope → medium",
      fields: { archetype: "feature", target_repo: "zouroboros", repro: "packages/swarm/src", acceptance_criteria: "webhook retry with backoff; dead-letter log; tests" },
      text: "Add webhook retry system across a.ts b.ts c.ts d.ts",
      gate: "SWARM",
      seed: 0.9,
      expect: "medium",
    },
    {
      name: "migration touching schema → high",
      fields: { archetype: "migration", target_repo: "acme", repro: "db/migrations", acceptance_criteria: "ALTER TABLE positions add column; backfill" },
      text: "Schema migration: alter table positions",
      gate: "SWARM",
      seed: null,
      expect: "high",
    },
    {
      name: "secret rotation → high",
      fields: { archetype: "bugfix", target_repo: "zouroboros", repro: ".env handling", acceptance_criteria: "rotate api key, update .zo_secrets" },
      text: "Fix credential leak: rotate API key in .env",
      gate: "DIRECT",
      seed: null,
      expect: "high",
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const inputs = buildInputs(c.fields, c.text, c.gate, c.seed);
    const { score } = scoreRisk(inputs);
    const tier = tierFor(score);
    const ok = tier === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${c.name}: score=${score} tier=${tier} (expected ${c.expect})`);
  }

  // Contract parse: multi-line sections captured fully (regression: lazy+\s*$ truncation)
  const parsed = parseContractFields("## Acceptance Criteria\n- one\n- two\n\n## Target Repo\nzouroboros");
  const parseOk = parsed.acceptance_criteria === "- one\n- two" && parsed.target_repo === "zouroboros";
  if (!parseOk) failed++;
  console.log(`${parseOk ? "✓" : "✗"} contract parse: multi-line section captured fully`);

  // Determinism check: same inputs → same score
  const inputs = buildInputs(cases[2].fields, cases[2].text, cases[2].gate, cases[2].seed);
  const a = scoreRisk(inputs).score;
  const b = scoreRisk(inputs).score;
  const det = a === b;
  if (!det) failed++;
  console.log(`${det ? "✓" : "✗"} determinism: ${a} === ${b}`);

  // Auto-promote lane checks (pure)
  const mediumVerdict = classifyRisk(
    { linear_id: "t", identifier: "T", title: cases[2].name, description: "" },
    inputs,
    "self-test",
    "shadow"
  );
  const eligibleRep: ReputationBaselineLike = { eligible: true, source: "reputation", reasons: ["earned: 10/10 @ 1.0"] };
  const coldRep: ReputationBaselineLike = { eligible: false, source: "reputation", reasons: ["cold-start: 3/8"] };
  const cleanCalib: CalibrationGateLike = { eligible: true, reasons: [] };
  const failedCalib: CalibrationGateLike = { eligible: false, reasons: ["false-hold rate 96.0% > 10%"] };
  const apCases: Array<{ name: string; verdict: RiskVerdict; resolved: number; rep?: ReputationBaselineLike; calib?: CalibrationGateLike; expect: boolean }> = [
    { name: "medium + baseline met + within ceiling → eligible", verdict: mediumVerdict, resolved: 25, calib: cleanCalib, expect: true },
    { name: "medium + baseline 5/20 → blocked", verdict: mediumVerdict, resolved: 5, calib: cleanCalib, expect: false },
    // ZOU-1110: count alone can never grant eligibility when calibration fails.
    { name: "baseline 25 but calibration failed → blocked", verdict: mediumVerdict, resolved: 25, calib: failedCalib, expect: false },
    { name: "reputation earned but calibration failed → blocked", verdict: mediumVerdict, resolved: 0, rep: eligibleRep, calib: failedCalib, expect: false },
    {
      name: "high tier → blocked",
      verdict: { ...mediumVerdict, tier: "high" as RiskTier },
      resolved: 25,
      calib: cleanCalib,
      expect: false,
    },
    {
      name: "forbidden surface (secret) → blocked",
      verdict: { ...mediumVerdict, inputs: { ...mediumVerdict.inputs, secret_contact: true } },
      resolved: 25,
      calib: cleanCalib,
      expect: false,
    },
    {
      name: "files over ceiling → blocked",
      verdict: { ...mediumVerdict, inputs: { ...mediumVerdict.inputs, files_touched_estimate: 14 } },
      resolved: 25,
      calib: cleanCalib,
      expect: false,
    },
    // ZOU-435: reputation baseline replaces the flat global count when supplied.
    { name: "reputation earned + flat baseline 0 → eligible (widens)", verdict: mediumVerdict, resolved: 0, rep: eligibleRep, calib: cleanCalib, expect: true },
    { name: "reputation cold-start + flat baseline 99 → blocked (narrows)", verdict: mediumVerdict, resolved: 99, rep: coldRep, calib: cleanCalib, expect: false },
    {
      name: "reputation earned but forbidden surface → still blocked (ceiling wins)",
      verdict: { ...mediumVerdict, inputs: { ...mediumVerdict.inputs, schema_contact: true } },
      resolved: 0,
      rep: eligibleRep,
      calib: cleanCalib,
      expect: false,
    },
  ];
  for (const c of apCases) {
    const d = autoPromoteEligible(c.verdict, c.resolved, c.rep, c.calib);
    const ok = d.eligible === c.expect;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} auto-promote: ${c.name} (${d.reasons[0]})`);
  }

  const totalChecks = cases.length + 2 + apCases.length;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${totalChecks - failed}/${totalChecks} checks`);
  return failed === 0 ? 0 : 1;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = Bun.argv[2];
  const { values } = parseArgs({
    args: Bun.argv.slice(3),
    options: {
      ticket: { type: "string" },
      decision: { type: "string" },
      "seed-score": { type: "string" },
      fields: { type: "string" },
    },
    strict: false,
  });

  if (cmd === "self-test") {
    process.exit(selfTest());
  }

  if (cmd === "classify") {
    if (!values.ticket || !values.decision) {
      console.error("Usage: risk-classifier.ts classify --ticket <json|-> --decision DIRECT [--seed-score 0.9] [--fields <json>]");
      process.exit(2);
    }
    const parseJson = <T,>(text: string, what: string): T => {
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        console.error(`FATAL: invalid JSON for ${what} — ${e instanceof Error ? e.message : e}`);
        process.exit(2);
      }
    };
    const raw =
      values.ticket === "-"
        ? await Bun.stdin.text()
        : readFileSync(values.ticket as string, "utf-8");
    const ticket = parseJson<TicketLike & { description?: string }>(raw, "--ticket");
    const fields = values.fields
      ? parseJson<Record<string, string>>(values.fields as string, "--fields")
      : {};
    const VALID_DECISIONS: readonly GateDecision[] = ["DIRECT", "SWARM", "FORCE_SWARM", "SUGGEST", "ERROR"];
    const decision = values.decision as GateDecision;
    if (!VALID_DECISIONS.includes(decision)) {
      console.error(`FATAL: --decision must be one of ${VALID_DECISIONS.join("|")} (got "${values.decision}")`);
      process.exit(2);
    }
    let seedScore: number | null = null;
    if (values["seed-score"]) {
      seedScore = Number(values["seed-score"]);
      if (!Number.isFinite(seedScore) || seedScore < 0 || seedScore > 1) {
        console.error(`FATAL: --seed-score must be a number in [0,1] (got "${values["seed-score"]}")`);
        process.exit(2);
      }
    }
    const inputs = buildInputs(fields, `${ticket.title}\n${ticket.description ?? ""}`, decision, seedScore);
    const verdict = classifyRisk(ticket, inputs, `cli-${randomUUID().slice(0, 8)}`, currentMode());
    console.log(JSON.stringify(verdict, null, 2));
    process.exit(0);
  }

  console.error("Commands: classify | self-test");
  process.exit(2);
}

if (import.meta.main) main();
