#!/usr/bin/env bun
/**
 * T1 (SF-011) — Archetype Classifier Core
 *
 * Pure deterministic classifier: no LLM, no network, no clock. Resolves every
 * ticket to one of 6 coarse assembly lines (the exact ARCHETYPE_BASE vocabulary
 * from risk-classifier.ts) using a declared-field-authoritative policy:
 *
 *   declared canonical > declared alias > keyword inference > unknown
 *
 * A valid declaration ALWAYS wins — inference never overrides it. When the
 * declaration and the inference disagree, the miss is recorded as a signal
 * (SF-012 feedstock), not acted on. SF-010 fine-grained allowlist names
 * (dependency_bump / doc_fix / lint_codemod / test_addition) fold into their
 * coarse line with the fine name PRESERVED, so the SF-010 lane keeps receiving
 * exactly the vocabulary it was baselined on.
 *
 * Usage:
 *   bun archetype-classifier.ts classify --ticket <json-file|-> [--fields <json>]
 *   bun archetype-classifier.ts self-test
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

// ─── Taxonomy ─────────────────────────────────────────────────────────────────

/** Coarse assembly lines — exactly the risk-classifier ARCHETYPE_BASE vocabulary. */
export const LINES = ["bugfix", "feature", "refactor", "migration", "dependency", "docs"] as const;
export type Line = (typeof LINES)[number];

/**
 * SF-010 fine-grained allowlist names → coarse line. test_addition maps to
 * bugfix: corrective quality work on existing code with bugfix-grade blast
 * radius (mapping to feature would contradict SF-010's low-risk baseline).
 */
export const ALIASES: Record<string, Line> = {
  dependency_bump: "dependency",
  doc_fix: "docs",
  lint_codemod: "refactor",
  test_addition: "bugfix",
};

export type ClassificationSource = "declared" | "alias" | "inferred" | "unknown";

export interface ArchetypeClassification {
  /** Coarse assembly line, or "unknown". */
  line: Line | "unknown";
  /** Fine-grained alias name when the declaration used one (SF-010 vocabulary), else null. */
  fine: string | null;
  /** Raw declared field value (trimmed/lowercased), or null when absent. */
  declared: string | null;
  source: ClassificationSource;
  confidence: number;
  /** Human-auditable rule hits, including declared-vs-inferred disagreements. */
  signals: string[];
}

// ─── Inference rules (ordered; first hit wins) ────────────────────────────────
//
// Order is a risk-descending tie-break: migration first so schema-touching
// tickets can never be softened by a later rule, feature last as the broadest
// bucket.

const INFERENCE_RULES: Array<{ line: Line; re: RegExp; label: string }> = [
  {
    line: "migration",
    re: /\bmigrations?\b|\bschema\b|alter\s+table|drop\s+table|\bDDL\b|database\s+(change|migration)|\bbackfill\b/i,
    label: "schema/migration keywords",
  },
  {
    line: "dependency",
    re: /\b(bump|upgrade|update|pin)\b[^\n]{0,40}\b(dependenc|package|version|lockfile)\w*|\bdependenc\w+\b|package\.json|\block(file)?s?\b|\brenovate\b|\bdependabot\b/i,
    label: "dependency/version keywords",
  },
  {
    line: "docs",
    re: /\breadme\b|\bdocs?\b|\bdocumentation\b|\btypo\b|\bchangelog\b|\bcomments?\s+only\b/i,
    label: "docs keywords",
  },
  {
    line: "bugfix",
    re: /\bbug\w*\b|\bfix(es|ed)?\b|\bregression\b|\bcrash\w*\b|\bbroken\b|\bdefect\b|\bhotfix\b|\berror\s+when\b/i,
    label: "bugfix keywords",
  },
  {
    line: "refactor",
    re: /\brefactor\w*\b|\bcleanup\b|\brestructure\b|\brename\b|\bextract\s+(function|method|module)\b|\blint\b|\bcodemod\b|\bdead\s+code\b/i,
    label: "refactor keywords",
  },
  {
    line: "feature",
    re: /\bfeature\b|\badd(s|ed|ing)?\b|\bimplement\w*\b|\bnew\b|\bsupport\s+for\b|\bintroduce\w*\b/i,
    label: "feature keywords",
  },
];

/** Pure keyword inference over ticket text; null when no rule fires. */
export function inferLine(text: string): { line: Line; label: string } | null {
  for (const rule of INFERENCE_RULES) {
    if (rule.re.test(text)) return { line: rule.line, label: rule.label };
  }
  return null;
}

// ─── Classifier (pure) ────────────────────────────────────────────────────────

export function classifyArchetype(
  fields: { archetype?: string },
  ticketText: string,
): ArchetypeClassification {
  const declaredRaw = (fields.archetype ?? "").trim().toLowerCase();
  const declared = declaredRaw === "" ? null : declaredRaw;
  const signals: string[] = [];

  // Inference always computed — a valid declaration wins, but the disagreement
  // signal is SF-012 feedstock either way.
  const inferred = inferLine(ticketText);

  if (declared !== null && (LINES as readonly string[]).includes(declared)) {
    if (inferred && inferred.line !== declared) {
      signals.push(`declared_vs_inferred: declared '${declared}' but ${inferred.label} suggest '${inferred.line}'`);
    }
    signals.push(`declared canonical '${declared}'`);
    return { line: declared as Line, fine: null, declared, source: "declared", confidence: 1.0, signals };
  }

  // Object.hasOwn, not `in`: a plain-object lookup with `in` matches
  // prototype-chain keys (toString/constructor/__proto__), classifying a
  // hostile declaration as an "alias" whose line is a Function (cg-1783026014086).
  if (declared !== null && Object.hasOwn(ALIASES, declared)) {
    const line = ALIASES[declared];
    if (inferred && inferred.line !== line) {
      signals.push(`declared_vs_inferred: alias '${declared}' (→${line}) but ${inferred.label} suggest '${inferred.line}'`);
    }
    signals.push(`alias '${declared}' → '${line}' (fine name preserved)`);
    return { line, fine: declared, declared, source: "alias", confidence: 1.0, signals };
  }

  if (declared !== null) {
    signals.push(`declared '${declared}' not a canonical line or known alias — falling through to inference`);
  }

  if (inferred) {
    signals.push(`inferred '${inferred.line}' via ${inferred.label}`);
    return { line: inferred.line, fine: null, declared, source: "inferred", confidence: 0.6, signals };
  }

  signals.push("no declaration, no inference hit");
  return { line: "unknown", fine: null, declared, source: "unknown", confidence: 0.0, signals };
}

/**
 * The archetype name SF-010's allowlist gate must receive: the fine-grained
 * alias when one was declared (the vocabulary the lane was baselined on),
 * otherwise the coarse line.
 */
export function laneArchetypeName(c: ArchetypeClassification): string {
  return c.fine ?? c.line;
}

/** True when a valid declaration and the keyword inference disagreed (SF-012 feedstock). */
export function hasDisagreement(c: ArchetypeClassification): boolean {
  return c.signals.some((s) => s.startsWith("declared_vs_inferred"));
}

// ─── Self-test ────────────────────────────────────────────────────────────────

function selfTest(): number {
  const cases: Array<{
    name: string;
    fields: { archetype?: string };
    text: string;
    expect: { line: string; source: ClassificationSource; fine: string | null; laneName: string };
    expectDisagreement?: boolean;
  }> = [
    {
      name: "declared canonical wins",
      fields: { archetype: "bugfix" },
      text: "Fix crash in dispatcher",
      expect: { line: "bugfix", source: "declared", fine: null, laneName: "bugfix" },
    },
    {
      name: "declared wins over conflicting signals (disagreement recorded, not acted on)",
      fields: { archetype: "docs" },
      text: "Schema migration: alter table positions and backfill",
      expect: { line: "docs", source: "declared", fine: null, laneName: "docs" },
      expectDisagreement: true,
    },
    {
      name: "alias dependency_bump preserves fine name for the SF-010 lane",
      fields: { archetype: "dependency_bump" },
      text: "Bump hono in package.json",
      expect: { line: "dependency", source: "alias", fine: "dependency_bump", laneName: "dependency_bump" },
    },
    {
      name: "alias doc_fix → docs",
      fields: { archetype: "doc_fix" },
      text: "Fix typo in README",
      expect: { line: "docs", source: "alias", fine: "doc_fix", laneName: "doc_fix" },
    },
    {
      name: "alias lint_codemod → refactor",
      fields: { archetype: "lint_codemod" },
      text: "Apply lint codemod across scripts",
      expect: { line: "refactor", source: "alias", fine: "lint_codemod", laneName: "lint_codemod" },
    },
    {
      name: "alias test_addition → bugfix line",
      fields: { archetype: "test_addition" },
      text: "Add regression tests for the parser",
      expect: { line: "bugfix", source: "alias", fine: "test_addition", laneName: "test_addition" },
    },
    {
      name: "no declaration → inference (migration outranks feature words)",
      fields: {},
      text: "Add new column: alter table users, backfill emails",
      expect: { line: "migration", source: "inferred", fine: null, laneName: "migration" },
    },
    {
      name: "invalid declaration falls through to inference",
      fields: { archetype: "big refactor" },
      text: "Restructure the pool manager, cleanup dead code",
      expect: { line: "refactor", source: "inferred", fine: null, laneName: "refactor" },
    },
    {
      name: "dependency inference",
      fields: {},
      text: "Upgrade the package versions in the lockfile",
      expect: { line: "dependency", source: "inferred", fine: null, laneName: "dependency" },
    },
    {
      name: "empty everything → unknown",
      fields: {},
      text: "zzz qqq",
      expect: { line: "unknown", source: "unknown", fine: null, laneName: "unknown" },
    },
    {
      name: "garbage declaration + no signals → unknown",
      fields: { archetype: "???" },
      text: "qqq zzz",
      expect: { line: "unknown", source: "unknown", fine: null, laneName: "unknown" },
    },
    {
      name: "prototype-chain key 'constructor' never matches the alias table",
      fields: { archetype: "constructor" },
      text: "qqq zzz",
      expect: { line: "unknown", source: "unknown", fine: null, laneName: "unknown" },
    },
    {
      name: "prototype-chain key '__proto__' falls through to inference",
      fields: { archetype: "__proto__" },
      text: "Fix crash in dispatcher",
      expect: { line: "bugfix", source: "inferred", fine: null, laneName: "bugfix" },
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const r = classifyArchetype(c.fields, c.text);
    const laneName = laneArchetypeName(r);
    const disagreement = r.signals.some((s) => s.startsWith("declared_vs_inferred"));
    const ok =
      r.line === c.expect.line &&
      r.source === c.expect.source &&
      r.fine === c.expect.fine &&
      laneName === c.expect.laneName &&
      (c.expectDisagreement === undefined || disagreement === c.expectDisagreement);
    if (!ok) failed++;
    console.log(
      `${ok ? "✓" : "✗"} ${c.name}: line=${r.line} source=${r.source} fine=${r.fine} lane=${laneName}${disagreement ? " [disagreement]" : ""}`,
    );
  }

  // Determinism: same inputs → identical result object
  const a = classifyArchetype({ archetype: "doc_fix" }, "Fix typo");
  const b = classifyArchetype({ archetype: "doc_fix" }, "Fix typo");
  const det = JSON.stringify(a) === JSON.stringify(b);
  if (!det) failed++;
  console.log(`${det ? "✓" : "✗"} determinism: identical results for identical inputs`);

  const total = cases.length + 1;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${total - failed}/${total} checks`);
  return failed === 0 ? 0 : 1;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = Bun.argv[2];
  const { values } = parseArgs({
    args: Bun.argv.slice(3),
    options: { ticket: { type: "string" }, fields: { type: "string" } },
    strict: false,
  });

  if (cmd === "self-test") process.exit(selfTest());

  if (cmd === "classify") {
    if (!values.ticket) {
      console.error("Usage: archetype-classifier.ts classify --ticket <json|-> [--fields <json>]");
      process.exit(2);
    }
    const raw = values.ticket === "-" ? await Bun.stdin.text() : readFileSync(values.ticket as string, "utf-8");
    let ticket: { title?: string; description?: string };
    let fields: { archetype?: string } = {};
    try {
      ticket = JSON.parse(raw);
      if (values.fields) fields = JSON.parse(values.fields as string);
    } catch (e) {
      console.error(`FATAL: invalid JSON — ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    }
    const r = classifyArchetype(fields, `${ticket.title ?? ""}\n${ticket.description ?? ""}`);
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  console.error("Commands: classify | self-test");
  process.exit(2);
}

if (import.meta.main) main();
