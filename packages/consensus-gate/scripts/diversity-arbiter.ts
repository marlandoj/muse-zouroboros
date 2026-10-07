#!/usr/bin/env bun
/**
 * Diversity Arbiter — non-LLM 4th rung for the consensus gate.
 *
 * Motivation (R3, zouroboros-governance-safety): three correlated frontier
 * LLMs collapse to shallow diversity. A non-LLM checker — tsc strict, syntax
 * parse, lexical heuristics — adds genuinely orthogonal signal for code review.
 *
 * Lightweight by design: zero external deps, no network, no shell-out to tsc
 * (which would require a tsconfig and would be slow). Instead:
 *
 *   1) Bun's transpiler is invoked in-process to parse TS/TSX and surface
 *      syntactic errors (a strict subset of what tsc would catch — but covers
 *      the failure modes LLMs miss most often: unterminated strings, missing
 *      brackets, malformed JSX).
 *   2) A small library of mechanical lint rules flag patterns the LLMs are
 *      known to wave through (eval, Function constructor, `// @ts-ignore` of
 *      whole files, `as any` casts in hot paths, missing await on Promise).
 *   3) The result is shaped EXACTLY like a vendor verdict so the consensus
 *      gate can drop it into its existing aggregation pipeline.
 *
 * The arbiter is INVOKED via consensus-gate when --arbiter is passed. It can
 * also be run standalone for debugging.
 *
 * NOTE: The arbiter only opines on code-like criteria. Brand, design, WCAG,
 * prose, and other non-code rubrics self-skip with confidence 0.0 and pass=true
 * to avoid parsing natural language as TSX or polluting the aggregation.
 */
import { parseArgs } from "util";

export const ARBITER_MODEL_ID = "non-llm/arbiter-v1";

export interface ArbiterClaim {
  claim: string;
  evidence?: string;
  severity: "high" | "medium" | "low";
}

export interface ArbiterVerdict {
  model: string;
  pass: boolean;
  issues: string[];
  dissent_claims: ArbiterClaim[];
  confidence: number;
  latencyMs: number;
  arbiter_checks: { name: string; status: "pass" | "fail" | "skip"; detail?: string }[];
}

interface RuleResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
  claims: ArbiterClaim[];
}

function checkSyntax(code: string, unifiedDiff = false): RuleResult {
  if (unifiedDiff) {
    return { name: "syntax", status: "skip", detail: "unified diff: syntax is verified by repository typecheck", claims: [] };
  }
  // Bun's transpiler runs in-process and reports syntax errors via thrown
  // SyntaxError; non-TS files (plain JS) parse without complaint.
  try {
    const transpiler = new Bun.Transpiler({ loader: "tsx" });
    transpiler.transformSync(code);
    return { name: "syntax", status: "pass", claims: [] };
  } catch (err: any) {
    const msg = (err?.message || String(err)).split("\n")[0].slice(0, 240);
    return {
      name: "syntax",
      status: "fail",
      detail: msg,
      claims: [
        {
          claim: `Syntax error: ${msg}`,
          severity: "high",
          evidence: "Bun transpiler refused to parse this file as TSX",
        },
      ],
    };
  }
}

const DANGEROUS_PATTERNS: { rx: RegExp; severity: ArbiterClaim["severity"]; reason: string }[] = [
  { rx: /\beval\s*\(/, severity: "high", reason: "eval() can execute arbitrary code from untrusted strings." },
  { rx: /\bnew\s+Function\s*\(/, severity: "high", reason: "new Function() is dynamic-eval and bypasses static analysis." },
  { rx: /\bchild_process\b[\s\S]{0,80}\bexec\s*\(/, severity: "high", reason: "child_process.exec with unchecked input is shell-injection risk." },
  { rx: /process\.env\.[A-Z_][A-Z0-9_]*\s*\|\|\s*['"][^'"]*?(api[_-]?key|secret|token|password)/i, severity: "medium", reason: "Hard-coded fallback for what looks like a credential." },
  { rx: /\/\/\s*@ts-(ignore|nocheck)\b/, severity: "low", reason: "@ts-ignore/nocheck disables type checks; prefer @ts-expect-error with reason." },
  { rx: /\bas\s+any\b/, severity: "low", reason: "`as any` cast erodes type safety; use a narrower type." },
];

function checkPatterns(code: string): RuleResult {
  const claims: ArbiterClaim[] = [];
  for (const { rx, severity, reason } of DANGEROUS_PATTERNS) {
    const match = code.match(rx);
    if (!match) continue;
    const idx = match.index ?? -1;
    const snippet = idx >= 0 ? code.slice(Math.max(0, idx - 20), idx + match[0].length + 20).replace(/\s+/g, " ").trim() : match[0];
    claims.push({
      claim: reason,
      evidence: snippet.slice(0, 160),
      severity,
    });
  }
  if (claims.length === 0) {
    return { name: "patterns", status: "pass", claims: [] };
  }
  const highest = claims.some((c) => c.severity === "high")
    ? "high"
    : claims.some((c) => c.severity === "medium")
      ? "medium"
      : "low";
  return {
    name: "patterns",
    status: highest === "low" ? "pass" : "fail",
    detail: `${claims.length} mechanical-lint finding(s); highest severity ${highest}`,
    claims,
  };
}

function checkAwaitedPromises(code: string): RuleResult {
  // Heuristic: a `fetch(` or `.then(` followed by a `;` or newline without an
  // `await` keyword on the same statement is suspicious — flag only when not
  // chained via .then/.catch.
  const lines = code.split("\n");
  const claims: ArbiterClaim[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("fetch(")) continue;
    if (/\bawait\b/.test(line)) continue;
    if (/\.then\s*\(/.test(line) || /\.catch\s*\(/.test(line)) continue;
    if (/\breturn\b/.test(line)) continue; // returning the promise is fine
    if (/=\s*fetch\s*\(/.test(line) && !/await/.test(line)) {
      claims.push({
        claim: "fetch() result assigned without await — likely missing await",
        evidence: line.trim().slice(0, 160),
        severity: "medium",
      });
    }
  }
  return {
    name: "awaited-promises",
    status: claims.length === 0 ? "pass" : "fail",
    detail: claims.length === 0 ? undefined : `${claims.length} likely-missing await(s)`,
    claims,
  };
}

export function isArbiterApplicable(criteria: string): boolean {
  const c = criteria.toLowerCase();
  return /correct|security|safety|type|syntax|code/.test(c);
}

function reviewInput(code: string): { code: string; unifiedDiff: boolean } {
  const unifiedDiff = /^diff --git /m.test(code);
  if (!unifiedDiff) return { code, unifiedDiff };
  const added = code.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return { code: added, unifiedDiff };
}

export async function runArbiter(code: string, criteria: string): Promise<ArbiterVerdict> {
  const startMs = Date.now();

  if (!isArbiterApplicable(criteria)) {
    return {
      model: ARBITER_MODEL_ID,
      pass: true,
      issues: [],
      dissent_claims: [],
      confidence: 0.0,
      latencyMs: Date.now() - startMs,
      arbiter_checks: [{ name: "applicability", status: "skip", detail: `criteria '${criteria}' not in arbiter scope` }],
    };
  }

  const input = reviewInput(code);
  const results = [checkSyntax(input.code, input.unifiedDiff), checkPatterns(input.code), checkAwaitedPromises(input.code)];

  const allClaims = results.flatMap((r) => r.claims);
  const anyHighFail = results.some((r) => r.status === "fail" && r.claims.some((c) => c.severity === "high"));
  const anyFail = results.some((r) => r.status === "fail");
  const pass = !anyFail;

  // Confidence is mechanical, not Bayesian: 1.0 when nothing fired; otherwise
  // 0.95 on low/medium-only fail, 0.85 when high-severity fired (the arbiter
  // is most certain it found something wrong when the syntax check fails).
  const confidence = pass ? 1.0 : anyHighFail ? 0.85 : 0.95;

  return {
    model: ARBITER_MODEL_ID,
    pass,
    issues: allClaims.map((c) => c.claim),
    dissent_claims: allClaims,
    confidence,
    latencyMs: Date.now() - startMs,
    arbiter_checks: results.map((r) => ({ name: r.name, status: r.status, detail: r.detail })),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      file: { type: "string" as const },
      code: { type: "string" as const },
      criteria: { type: "string" as const, default: "correctness,security" },
      json: { type: "boolean" as const, default: false },
    },
    allowPositionals: true,
  });

  const code = values.code || (values.file ? require("fs").readFileSync(values.file, "utf-8") : "");
  if (!code) {
    console.error("Error: provide --code or --file");
    process.exit(1);
  }

  const verdict = await runArbiter(code, values.criteria || "correctness,security");

  if (values.json) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log(`\n🔧 Diversity Arbiter (${ARBITER_MODEL_ID}) — criteria: ${values.criteria}\n`);
    for (const c of verdict.arbiter_checks) {
      const icon = c.status === "pass" ? "✅" : c.status === "skip" ? "⏭️" : "⚠️";
      console.log(`  ${icon} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    }
    if (verdict.dissent_claims.length) {
      console.log("\n  Findings:");
      for (const cl of verdict.dissent_claims) {
        console.log(`    - [${cl.severity}] ${cl.claim}`);
        if (cl.evidence) console.log(`        evidence: ${cl.evidence}`);
      }
    }
    console.log(`\n  Verdict: ${verdict.pass ? "PASS" : "FAIL"} (confidence ${verdict.confidence.toFixed(2)}, ${verdict.latencyMs}ms)\n`);
  }
}
