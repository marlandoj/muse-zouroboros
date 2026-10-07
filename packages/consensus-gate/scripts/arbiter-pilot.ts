#!/usr/bin/env bun
/**
 * R3 Diversity Arbiter Pilot — replay-on-historical-diffs.
 *
 * ZOU-46: pilot the non-LLM 4th rung against the existing corpus of consensus-
 * gate verdicts. Measures the "overfit signal" — the rate at which 3
 * correlated LLMs collapse to a unanimous PASS that the mechanical arbiter
 * would have rejected.
 *
 * Read-only: does not mutate the gate's history. Writes a JSON report + a
 * markdown summary into Skills/consensus-gate/evaluations/.
 */
import * as fs from "fs";
import * as path from "path";
import { runArbiter } from "./diversity-arbiter";

const dbPath = `${process.env.HOME}/.zouroboros/consensus-gate.json`;

interface StoredVerdict {
  model: string;
  pass: boolean;
  confidence: number;
}

interface StoredEntry {
  id: string;
  timestamp: string;
  label: string;
  code: string;
  criteria: string;
  status: "passed" | "rejected" | "split" | "validating";
  verdicts: StoredVerdict[];
  consensus: { unanimous: boolean; pass: boolean | null; confidence: number };
}

interface ReplayRow {
  id: string;
  timestamp: string;
  label: string;
  criteria: string;
  code_len: number;
  input_format: "tsx" | "diff" | "yaml" | "python" | "json" | "other";
  llm_consensus_status: string;
  llm_unanimous: boolean;
  llm_pass: boolean | null;
  arbiter_applicable: boolean;
  arbiter_pass: boolean;
  arbiter_confidence: number;
  arbiter_high_severity: boolean;
  arbiter_findings: number;
  arbiter_claim_types: string[];
  is_syntax_only_fail: boolean;
  flip_kind: "none" | "would-block-unanimous-pass" | "confirms-rejection" | "dissents-from-split" | "skipped";
}

function classifyArbiterRelevance(criteria: string): boolean {
  return /correct|security|safety|type/i.test(criteria);
}

function sniffFormat(code: string): ReplayRow["input_format"] {
  const head = code.slice(0, 400);
  if (/^===\s*DIFF|^diff --git\b|^---\s+a\/|^\+\+\+\s+b\//m.test(head)) return "diff";
  if (/^=== SEED YAML|^[a-z_]+:\s*["']?[\w-]/m.test(head) && !/\bfunction\b|\bconst\b|\bimport\b/.test(head.slice(0, 200))) return "yaml";
  if (/^(def |from \w+ import|import os\b|print\()/m.test(head)) return "python";
  if (/^\s*\{[\s\S]*"[\w_]+"\s*:/.test(head) && !/\bfunction\b|\bconst\b|=>/.test(head.slice(0, 200))) return "json";
  if (/\b(function|const|let|var|class|import|export)\b/.test(head)) return "tsx";
  return "other";
}

function classifyClaimType(claim: string): string {
  if (/^Syntax error/i.test(claim)) return "syntax";
  if (/eval\(\)/i.test(claim)) return "eval";
  if (/new Function/i.test(claim)) return "new-function";
  if (/child_process/i.test(claim)) return "child-process";
  if (/credential|api[_-]?key|secret|token|password/i.test(claim)) return "credential";
  if (/ts-(ignore|nocheck)/i.test(claim)) return "ts-ignore";
  if (/as any/i.test(claim)) return "as-any";
  if (/missing await/i.test(claim)) return "missing-await";
  return "other";
}

async function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`No consensus-gate history at ${dbPath}`);
    process.exit(1);
  }

  const entries: StoredEntry[] = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  console.log(`Loaded ${entries.length} historical verdicts`);

  const rows: ReplayRow[] = [];
  let analyzed = 0;
  let skipped_no_code = 0;

  for (const e of entries) {
    if (!e.code || e.code.length === 0) {
      skipped_no_code++;
      continue;
    }
    const applicable = classifyArbiterRelevance(e.criteria);
    const verdict = await runArbiter(e.code, e.criteria);
    const highSev = verdict.dissent_claims.some((c) => c.severity === "high");
    const claimTypes = verdict.dissent_claims.map((c) => classifyClaimType(c.claim));
    const isSyntaxOnlyFail =
      !verdict.pass &&
      verdict.dissent_claims.length > 0 &&
      verdict.dissent_claims.every((c) => /^Syntax error/i.test(c.claim));
    const inputFormat = sniffFormat(e.code);

    // Reconstruct unanimous-PASS / split / rejected from stored data
    const passCount = e.verdicts.filter((v) => v.pass).length;
    const totalCount = e.verdicts.length;
    const unanimous = passCount === totalCount || passCount === 0;
    const llmPass = passCount === totalCount;

    let flip: ReplayRow["flip_kind"] = "none";
    if (!applicable) {
      flip = "skipped";
    } else if (unanimous && llmPass && !verdict.pass) {
      flip = "would-block-unanimous-pass";
    } else if (e.status === "rejected" && !verdict.pass) {
      flip = "confirms-rejection";
    } else if (e.status === "split" && !verdict.pass) {
      flip = "dissents-from-split";
    }

    rows.push({
      id: e.id,
      timestamp: e.timestamp,
      label: e.label,
      criteria: e.criteria,
      code_len: e.code.length,
      input_format: inputFormat,
      llm_consensus_status: e.status,
      llm_unanimous: unanimous,
      llm_pass: unanimous ? llmPass : null,
      arbiter_applicable: applicable,
      arbiter_pass: verdict.pass,
      arbiter_confidence: verdict.confidence,
      arbiter_high_severity: highSev,
      arbiter_findings: verdict.dissent_claims.length,
      arbiter_claim_types: claimTypes,
      is_syntax_only_fail: isSyntaxOnlyFail,
      flip_kind: flip,
    });
    analyzed++;
  }

  // --- aggregate metrics --------------------------------------------------
  const applicable = rows.filter((r) => r.arbiter_applicable);
  const nApplicable = applicable.length;

  const unanimousPass = applicable.filter((r) => r.llm_unanimous && r.llm_pass === true);
  const flipsFromUnanimousPass = unanimousPass.filter((r) => !r.arbiter_pass);
  const flipsWithHighSev = unanimousPass.filter((r) => !r.arbiter_pass && r.arbiter_high_severity);
  // True-positive overfit signal: high-severity flips EXCLUDING input-format
  // false positives (syntax errors from feeding non-TSX into the TS parser).
  const flipsTruePositive = unanimousPass.filter(
    (r) => !r.arbiter_pass && r.arbiter_high_severity && !r.is_syntax_only_fail
  );
  const flipsInputFormatFP = unanimousPass.filter(
    (r) => !r.arbiter_pass && r.is_syntax_only_fail && r.input_format !== "tsx"
  );

  const rejected = applicable.filter((r) => r.llm_consensus_status === "rejected");
  const arbiterConfirmsRejection = rejected.filter((r) => !r.arbiter_pass);

  const split = applicable.filter((r) => r.llm_consensus_status === "split");
  const arbiterDissentsOnSplit = split.filter((r) => !r.arbiter_pass);

  const overfitSignal =
    unanimousPass.length > 0 ? flipsTruePositive.length / unanimousPass.length : 0;
  const overfitSignalRawHighSev =
    unanimousPass.length > 0 ? flipsWithHighSev.length / unanimousPass.length : 0;
  const overfitSignalAny =
    unanimousPass.length > 0 ? flipsFromUnanimousPass.length / unanimousPass.length : 0;
  const inputFormatFPRate =
    unanimousPass.length > 0 ? flipsInputFormatFP.length / unanimousPass.length : 0;
  const rejectionConfirmRate =
    rejected.length > 0 ? arbiterConfirmsRejection.length / rejected.length : 0;

  const summary = {
    pilot_id: `arbiter-pilot-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    timestamp: new Date().toISOString(),
    corpus_size: entries.length,
    analyzed,
    skipped_no_code,
    arbiter_applicable: nApplicable,
    arbiter_skipped_by_criteria: rows.length - nApplicable,
    unanimous_pass_count: unanimousPass.length,
    rejected_count: rejected.length,
    split_count: split.length,
    overfit_signal_true_positive: {
      definition: "fraction of unanimous-LLM-PASS verdicts where arbiter would FAIL with a high-severity finding that is NOT an input-format false positive (i.e., real eval/child_process/credential/etc., not a syntax error from feeding non-TSX into the TS parser)",
      value: overfitSignal,
      numerator: flipsTruePositive.length,
      denominator: unanimousPass.length,
    },
    overfit_signal_raw_high_severity: {
      definition: "fraction of unanimous-LLM-PASS verdicts where arbiter would FAIL with any high-severity finding (includes input-format false positives)",
      value: overfitSignalRawHighSev,
      numerator: flipsWithHighSev.length,
      denominator: unanimousPass.length,
    },
    input_format_false_positive_rate: {
      definition: "fraction of unanimous-LLM-PASS verdicts where arbiter would falsely fail because the input is non-TSX (diff format, YAML, Python, JSON) and the syntax check fires inappropriately",
      value: inputFormatFPRate,
      numerator: flipsInputFormatFP.length,
      denominator: unanimousPass.length,
    },
    overfit_signal_any_severity: {
      definition: "fraction of unanimous-LLM-PASS verdicts where arbiter would FAIL on any severity",
      value: overfitSignalAny,
      numerator: flipsFromUnanimousPass.length,
      denominator: unanimousPass.length,
    },
    rejection_confirm_rate: {
      definition: "fraction of LLM-rejected verdicts where arbiter also fails (sanity-check the arbiter isn't biased to PASS)",
      value: rejectionConfirmRate,
      numerator: arbiterConfirmsRejection.length,
      denominator: rejected.length,
    },
    split_dissent_count: arbiterDissentsOnSplit.length,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(__dirname, "..", "evaluations");
  fs.mkdirSync(outDir, { recursive: true });

  const reportPath = path.join(outDir, `arbiter-pilot-${ts}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary, rows }, null, 2));

  const flipSamples = flipsFromUnanimousPass.slice(0, 10).map((r) => ({
    id: r.id,
    label: r.label,
    criteria: r.criteria,
    code_len: r.code_len,
    input_format: r.input_format,
    arbiter_findings: r.arbiter_findings,
    claim_types: r.arbiter_claim_types,
    high_severity: r.arbiter_high_severity,
    is_syntax_only_fail: r.is_syntax_only_fail,
  }));

  const inputFormatHistogram = applicable.reduce((acc, r) => {
    acc[r.input_format] = (acc[r.input_format] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const tier = overfitSignal > 0.05
    ? "**TIER 1**: default-on recommended."
    : overfitSignal > 0.01
      ? "**TIER 2**: opt-in, surface in reports."
      : "**TIER 3**: backstop only; expand rules or fix input-format detection before defaulting on.";

  const md = `# R3 Diversity Arbiter Pilot — ${ts}

**Hypothesis (paper §6.1, R3):** three correlated frontier LLMs collapse to
shallow diversity. A mechanical non-LLM arbiter adds orthogonal signal —
specifically, catching cases where unanimous LLM PASS verdicts contain code
that fails mechanical correctness/security checks.

**Pilot design:** replay-on-historical-diffs. Run the arbiter against the
existing corpus of ${entries.length} consensus-gate verdicts and measure flip
behavior. No fresh LLM calls; deterministic; $0 cost.

## Corpus

| Metric | Value |
|---|---|
| Total stored verdicts | ${entries.length} |
| Analyzed (have code) | ${analyzed} |
| Skipped (empty code) | ${skipped_no_code} |
| Arbiter-applicable (code-like criteria) | ${nApplicable} |
| Skipped by criteria (non-code) | ${rows.length - nApplicable} |

## LLM consensus distribution (applicable subset)

| Outcome | Count |
|---|---|
| Unanimous PASS | ${unanimousPass.length} |
| Rejected | ${rejected.length} |
| Split | ${split.length} |

## Input-format mix (applicable subset)

| Format | Count |
|---|---|
${Object.entries(inputFormatHistogram).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join("\n")}

The corpus is heterogeneous — it includes raw diffs (\`=== DIFF ===\` /
\`diff --git\`), YAML seed specifications, Python snippets, JSON, and TSX
source. The arbiter's syntax check assumes TSX input.

## Overfit signal

**Primary metric — TRUE-positive high-severity flips:**
**${(overfitSignal * 100).toFixed(1)}%** (${flipsTruePositive.length}/${unanimousPass.length})

This is the LLM-collapse rate the arbiter catches with *real* mechanical
findings (eval, child_process exec, hard-coded credentials, missing await).
Input-format false positives are excluded.

**Raw metric — all high-severity flips:**
${(overfitSignalRawHighSev * 100).toFixed(1)}% (${flipsWithHighSev.length}/${unanimousPass.length})

Includes false positives from feeding non-TSX inputs into the TS parser.

**Input-format false-positive rate:**
${(inputFormatFPRate * 100).toFixed(1)}% (${flipsInputFormatFP.length}/${unanimousPass.length})

Verdicts where the arbiter would have failed *only* because the syntax check
choked on a diff header / YAML / Python — not because the code is actually
broken. These are noise, not signal.

**Any-severity flips:** ${(overfitSignalAny * 100).toFixed(1)}% (${flipsFromUnanimousPass.length}/${unanimousPass.length})

## Sanity checks

**Rejection confirm rate:** ${(rejectionConfirmRate * 100).toFixed(1)}% (${arbiterConfirmsRejection.length}/${rejected.length})
The arbiter should agree with LLMs *some* of the time on rejected verdicts.
If this is 0%, the arbiter is orthogonal-uselessly-noisy; if it is 100%, it
is redundant with the LLMs.

**Splits where arbiter dissents (failed):** ${arbiterDissentsOnSplit.length}/${split.length}

## Interpretation

- **True-positive flip rate > 5%** → arbiter is providing real orthogonal
  signal. Worth defaulting \`--arbiter\` on in autoloop and code-review gates.
- **5% ≥ rate > 1%** → arbiter is occasionally useful. Keep it opt-in; surface
  in dissent reports.
- **Rate ≤ 1%** → arbiter is currently redundant with LLMs on this corpus.
  Either expand the rule library or leave as a backstop.

Measured TRUE-positive rate: **${(overfitSignal * 100).toFixed(2)}%** → ${tier}

**Blocker before any default-on:** input-format false-positive rate is
**${(inputFormatFPRate * 100).toFixed(1)}%** (${flipsInputFormatFP.length}/${unanimousPass.length} unanimous-PASS verdicts would be incorrectly blocked). This
must be fixed first via input-format detection (sniff for diff headers, YAML,
Python; skip the TSX syntax check when the input is not TSX).

## Sample of flipped verdicts (unanimous-PASS → arbiter-FAIL)

${flipSamples.length === 0 ? "_(no flips found in this corpus)_" : flipSamples.map((s) => `- \`${s.id}\` (${s.label}): input=\`${s.input_format}\`, ${s.arbiter_findings} finding(s) [${s.claim_types.join(",")}]${s.is_syntax_only_fail ? " — **input-format FP**" : ""}${s.high_severity && !s.is_syntax_only_fail ? ", high-severity TRUE catch" : ""}`).join("\n")}

## Caveats

1. Replay design only measures LLM-collapse on a backward-looking corpus. It
   does not capture *future* code the arbiter would catch.
2. The corpus skews toward debugging/research verdicts (zourobench-judge,
   smoke-tests). A production autoloop campaign's distribution may differ.
3. Arbiter rules are mechanical and narrow. False positives are bounded
   (severity-gated); false negatives are unbounded (it only catches what its
   regexes know about).
4. \`as any\` and \`@ts-ignore\` patterns are intentionally low-severity and
   do not flip the verdict (severity=low → arbiter \`pass\`). The flip metric
   counts only medium/high findings.
5. Small denominator (${unanimousPass.length} unanimous-PASS in applicable
   subset). Confidence intervals on the flip rate are wide; a richer corpus
   would tighten them.

## Artifact

Full row-level data: \`${path.basename(reportPath)}\`

## Next steps

**Prerequisite for any default-on rollout** — fix input-format detection in
\`diversity-arbiter.ts\`:
\`\`\`ts
// before runArbiter: skip syntax check when input is not TSX
function looksLikeTsx(code: string): boolean {
  const head = code.slice(0, 400);
  if (/^===|^diff --git|^---\\s+a\\//m.test(head)) return false;
  if (/^[a-z_]+:\\s/m.test(head) && !/\\b(function|const|=>)\\b/.test(head.slice(0,200))) return false;
  if (/^(def |from \\w+ import|import os)/m.test(head)) return false;
  return /\\b(function|const|let|var|class|import|export)\\b/.test(head);
}
\`\`\`

- If TRUE-positive rate stays > 5% after the fix: PR to default \`--arbiter\`
  on in \`consensus-gate.ts\` and add an opt-out flag.
- If TRUE-positive rate stays 1–5%: leave opt-in, add the would-have-blocked
  flips to the existing weekly dissent email.
- If TRUE-positive rate stays ≤ 1%: expand \`DANGEROUS_PATTERNS\` (suggest:
  prototype pollution, hardcoded JWT secrets, SQL string concatenation,
  missing CSRF on Hono POST routes) and re-pilot.
`;

  const mdPath = path.join(outDir, `arbiter-pilot-${ts}.md`);
  fs.writeFileSync(mdPath, md);

  console.log(`\nPilot complete:`);
  console.log(`  Analyzed: ${analyzed} (${nApplicable} arbiter-applicable)`);
  console.log(`  Unanimous PASS: ${unanimousPass.length}`);
  console.log(`  TRUE-positive high-sev flips: ${flipsTruePositive.length} (${(overfitSignal * 100).toFixed(2)}%)`);
  console.log(`  Raw high-severity flips: ${flipsWithHighSev.length} (${(overfitSignalRawHighSev * 100).toFixed(2)}%)`);
  console.log(`  Input-format FPs: ${flipsInputFormatFP.length} (${(inputFormatFPRate * 100).toFixed(2)}%)`);
  console.log(`  Any-severity flips: ${flipsFromUnanimousPass.length} (${(overfitSignalAny * 100).toFixed(2)}%)`);
  console.log(`  Rejection confirm rate: ${(rejectionConfirmRate * 100).toFixed(1)}%`);
  console.log(`\n  Report: ${mdPath}`);
  console.log(`  JSON:   ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
