/**
 * Versioned rubric-rewrite loop for the consensus-gate judge (P1-7, zou-reconcile-p1-7).
 *
 * AIEWF §7 ("annotate -> map -> versioned-rubric-rewrite"). Closes the loop:
 *   1. SNAPSHOT the inline judge rubric from consensus-gate.ts -> rubric.v{N}.md
 *      (the live gate file is READ-ONLY here; we only copy its text out).
 *   2. MAP the human annotations in reconciled-train.json into a PROPOSED
 *      rubric.v{N+1}.md — additive clauses only, derived deterministically from
 *      the held-out disagreement patterns (or drafted by an LLM with --llm).
 *   3. VALIDATE by driving prompt-ab.py: a real A/B of vN vs v{N+1} over the
 *      calibration cohort AND, SEPARATELY, over the immutable held-out cohort.
 *      Neither evaluation cohort is used to tune the proposal.
 *
 * ADVISORY ONLY. Emits artifacts (rubric.v{N+1}.md + an A/B report). It NEVER
 * edits consensus-gate.ts; an operator must read the report and approve before
 * any rubric change ships. Two human gates total: label the candidates, then
 * approve the proposed rubric.
 */
import {
  buildGovernanceArtifact,
  type CohortManifest,
  type GovernedCase,
} from "./dataset-governance";

const SCRIPTS_DIR = import.meta.dir;
const GATE_TS = `${SCRIPTS_DIR}/consensus-gate.ts`;
const PROMPT_AB = `${SCRIPTS_DIR}/prompt-ab.py`;
const DATA_DIR = `${SCRIPTS_DIR}/../data/calibration`;
const VERSIONS_DIR = `${SCRIPTS_DIR}/../data/prompt-versions`;
const TEST_CASES = `${DATA_DIR}/test-cases.json`;
const HOLDOUT = `${DATA_DIR}/reconciled-holdout.json`;
const TRAIN = `${DATA_DIR}/reconciled-train.json`;
const RECONCILE_SIDECAR = `${DATA_DIR}/reconcile-candidates.json`;
const COHORT_BASELINE = `${DATA_DIR}/cohort-manifests.v1.json`;

const RUBRIC_PREAMBLE =
  "You are a code reviewer. Assess the code below against the given criteria and\n" +
  "return a verdict. Judge by impact on correctness/security, not by how much the\n" +
  "code could be stylistically improved.\n";

/** Pull the SEVERITY RUBRIC + PASS/FAIL RULE body out of the live gate source. */
export function extractRubric(gateSource: string): string {
  const start = gateSource.indexOf("SEVERITY RUBRIC — assign severity by impact");
  if (start < 0) throw new Error("SEVERITY RUBRIC anchor not found in consensus-gate.ts");
  const endAnchor = 'mark it "low" and pass.';
  const endIdx = gateSource.indexOf(endAnchor, start);
  if (endIdx < 0) throw new Error("PASS/FAIL RULE end-anchor not found in consensus-gate.ts");
  const body = gateSource.slice(start, endIdx + endAnchor.length).trim();
  return `${RUBRIC_PREAMBLE}\n${body}\n`;
}

export interface HoldoutCase {
  signal_class?: string;
  gate_pass?: boolean | null;
  expected_pass?: boolean | null;
  category?: string;
}

export interface AnnotationStats {
  total: number;
  overEscalateClean: number; // escalated, human verified PASS (acceptable code)
  overEscalateDefect: number; // escalated, human verified FAIL (real defect)
  dissentNoise: number; // lone dissent, gate verdict matched the human
  dissentMiss: number; // lone dissent, gate verdict WRONG vs human
  byCategory: Record<string, number>;
}

export function summarizeAnnotations(cases: HoldoutCase[]): AnnotationStats {
  const stats: AnnotationStats = {
    total: cases.length,
    overEscalateClean: 0,
    overEscalateDefect: 0,
    dissentNoise: 0,
    dissentMiss: 0,
    byCategory: {},
  };
  for (const c of cases) {
    const cat = c.category || "other";
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
    if (c.signal_class === "escalate") {
      if (c.expected_pass === true) stats.overEscalateClean++;
      else if (c.expected_pass === false) stats.overEscalateDefect++;
    } else if (c.signal_class === "dissent") {
      if (c.gate_pass === c.expected_pass) stats.dissentNoise++;
      else stats.dissentMiss++;
    }
  }
  return stats;
}

/** Deterministically derive ADDITIVE rubric clauses from the held-out patterns. */
export function deriveProposedClauses(stats: AnnotationStats): string[] {
  const clauses: string[] = [];
  if (stats.overEscalateClean > 0) {
    clauses.push(
      "DECISIVENESS ON CLEAN CODE: If every concern you can identify is low-severity, " +
        "return \"pass\": true with a confident verdict. Uncertainty about callers, scale, " +
        "or upstream validation is itself \"low\" per the rubric above — it is NOT a reason " +
        "to hedge, abstain, or lower your confidence. " +
        `(Derived from ${stats.overEscalateClean} held-out case(s) the panel could not ` +
        "agree on, where a human verified the code as acceptable.)",
    );
  }
  if (stats.overEscalateDefect > 0) {
    clauses.push(
      "DECISIVENESS ON CLEAR DEFECTS: When a blocking defect is unambiguous and visible in " +
        "the code itself (a literal type mismatch, a direct injection sink, an obvious crash), " +
        "assign \"high\" severity and return \"pass\": false with high confidence. Do not soften " +
        "a clear defect into an uncertain verdict. " +
        `(Derived from ${stats.overEscalateDefect} held-out case(s) the panel could not agree ` +
        "on, where a human verified the code as a definite defect.)",
    );
  }
  return clauses;
}

function buildProposedRubric(vN: string, clauses: string[], curN: number, nextN: number): string {
  const header =
    `<!-- PROPOSED rubric v${nextN} (from v${curN}) — P1-7 reconciliation. ADVISORY: ` +
    `additive clauses only; operator must approve before editing consensus-gate.ts. -->\n\n`;
  if (clauses.length === 0) {
    return (
      header +
      vN +
      `\n## Proposed addition — P1-7 reconciliation (v${curN} → v${nextN})\n\n` +
      "_No additive clause derived: the held-out set showed no dominant over-escalation " +
      "pattern the per-model rubric can address. Snapshot retained for the record._\n"
    );
  }
  const body = clauses.map((c, i) => `${i + 1}. ${c}`).join("\n\n");
  return (
    header +
    vN +
    `\n## Proposed addition — P1-7 reconciliation (v${curN} → v${nextN})\n\n` +
    "These clauses EXTEND (never replace) the rubric above. They target the per-model\n" +
    "behaviors behind the held-out disagreements:\n\n" +
    body +
    "\n"
  );
}

async function llmDraftClauses(
  vN: string,
  stats: AnnotationStats,
  model: string,
): Promise<string[] | null> {
  const key =
    process.env.SYNTHETIC_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.XAI_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!key) return null;
  const url = process.env.SYNTHETIC_API_KEY
    ? "https://api.synthetic.new/openai/v1/chat/completions"
    : process.env.OPENROUTER_API_KEY
      ? "https://openrouter.ai/api/v1/chat/completions"
      : process.env.XAI_API_KEY
        ? "https://api.x.ai/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions";
  const bodyModel = process.env.XAI_API_KEY && model.startsWith("xai:") ? model.slice(4) : model;
  const prompt =
    "You improve a code-review judge rubric. Below is the CURRENT rubric, then a summary of " +
    "held-out cases where a real consensus panel DISAGREED and a human later supplied the " +
    "correct verdict. Propose 1-3 ADDITIVE clauses (do not rewrite existing text) that would " +
    "make individual reviewers more accurate on these patterns. Return ONLY a JSON array of " +
    `clause strings.\n\n=== CURRENT RUBRIC ===\n${vN}\n\n=== HELD-OUT PATTERNS ===\n` +
    JSON.stringify(stats, null, 2);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: bodyModel, messages: [{ role: "user", content: prompt }], max_tokens: 1024 }),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content || "";
    const m = text.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : text);
    return Array.isArray(arr) ? arr.map(String) : null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const argv = process.argv.slice(2);
  const has = (n: string) => argv.includes(n);
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const useLlm = has("--llm");
  const noAb = has("--no-ab");
  const model = arg("--model") || "hf:zai-org/GLM-5.2";
  const generatedAt = new Date().toISOString();

  if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, { recursive: true });

  // 1) snapshot the live inline rubric
  const gateSource = fs.readFileSync(GATE_TS, "utf8");
  const rubricBody = extractRubric(gateSource);
  const existing = fs
    .readdirSync(VERSIONS_DIR)
    .map((f) => f.match(/^rubric\.v(\d+)\.md$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  let curN: number;
  if (existing.length === 0) {
    curN = 1;
    fs.writeFileSync(`${VERSIONS_DIR}/rubric.v1.md`, rubricBody);
  } else {
    const top = existing[existing.length - 1];
    const topBody = fs.readFileSync(`${VERSIONS_DIR}/rubric.v${top}.md`, "utf8");
    if (topBody.trim() === rubricBody.trim()) {
      curN = top; // no drift since last snapshot
    } else {
      curN = top + 1; // inline rubric drifted -> new snapshot
      fs.writeFileSync(`${VERSIONS_DIR}/rubric.v${curN}.md`, rubricBody);
    }
  }
  const nextN = curN + 1;
  // Proposals use a distinct `.proposed.md` suffix so they never pollute the
  // snapshot version namespace (rubric.v{N}.md) that curN detection scans.
  const vNPath = `${VERSIONS_DIR}/rubric.v${curN}.md`;
  const vNextPath = `${VERSIONS_DIR}/rubric.v${nextN}.proposed.md`;

  // 2) map annotations -> proposed rubric
  const trainingDoc = fs.existsSync(TRAIN)
    ? (JSON.parse(fs.readFileSync(TRAIN, "utf8")) as { cases?: HoldoutCase[] })
    : { cases: [] };
  const stats = summarizeAnnotations(trainingDoc.cases || []);
  let clauses = deriveProposedClauses(stats);
  let draftSource = "deterministic scaffold";
  if (useLlm) {
    const llm = await llmDraftClauses(rubricBody, stats, model);
    if (llm && llm.length) {
      clauses = llm;
      draftSource = `LLM draft (${model})`;
    } else {
      draftSource = "deterministic scaffold (--llm requested but no key / empty draft)";
    }
  }
  const proposed = buildProposedRubric(fs.readFileSync(vNPath, "utf8"), clauses, curN, nextN);
  fs.writeFileSync(vNextPath, proposed);

  // 3) drive prompt-ab.py: calibration A/B + held-out A/B (separately)
  const reportPath = `${VERSIONS_DIR}/rubric-ab-report.v${curN}-to-v${nextN}.md`;
  const runAb = (cases?: string): string => {
    const a = ["test", "--old-file", vNPath, "--new-file", vNextPath, "--model", model];
    if (cases) a.push("--cases", cases);
    const r = spawnSync("python3", [PROMPT_AB, ...a], { encoding: "utf8" });
    return (r.stdout || "") + (r.stderr ? `\n[stderr]\n${r.stderr}` : "");
  };

  let calibOut = "(skipped — --no-ab)";
  let holdoutOut = "(skipped — --no-ab)";
  if (!noAb) {
    calibOut = runAb();
    holdoutOut = fs.existsSync(HOLDOUT) ? runAb(HOLDOUT) : "(no held-out set; run reconcile.ts --apply first)";
  }

  const report =
    `# Rubric Rewrite A/B Report — v${curN} → v${nextN}\n\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Draft source: **${draftSource}**\n` +
    `Model: \`${model}\`\n\n` +
    "> **ADVISORY.** This proposes a rubric successor and measures it. It does NOT edit\n" +
    `> consensus-gate.ts. Approve \`rubric.v${nextN}.md\` before any change ships.\n\n` +
    "## Annotation patterns (training cohort)\n\n" +
    "```json\n" +
    JSON.stringify(stats, null, 2) +
    "\n```\n\n" +
    "## Proposed additive clauses\n\n" +
    (clauses.length ? clauses.map((c, i) => `${i + 1}. ${c}`).join("\n\n") : "_none derived_") +
    "\n\n## A/B on calibration seed (test-cases.json)\n\n" +
    "```\n" +
    calibOut.trim() +
    "\n```\n\n" +
    "## A/B on HELD-OUT set (reconciled-holdout.json) — anti-Goodhart, report-only\n\n" +
    "```\n" +
    holdoutOut.trim() +
    "\n```\n";
  fs.writeFileSync(reportPath, report);

  const readDataset = (path: string): { version?: string; cases?: GovernedCase[] } =>
    fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  const trainDoc = readDataset(TRAIN);
  const calibrationDoc = readDataset(TEST_CASES);
  const governedHoldoutDoc = readDataset(HOLDOUT);
  const sidecarDoc = fs.existsSync(RECONCILE_SIDECAR)
    ? (JSON.parse(fs.readFileSync(RECONCILE_SIDECAR, "utf8")) as {
        candidates?: Array<{ source_consensus_id?: string }>;
      })
    : {};
  const promotionRequestPath = `${VERSIONS_DIR}/rubric.v${nextN}.promotion-request.json`;
  const priorRequest = fs.existsSync(promotionRequestPath)
    ? (JSON.parse(fs.readFileSync(promotionRequestPath, "utf8")) as {
        governance?: { manifests?: Partial<Record<"train" | "calibration" | "holdout", CohortManifest>> };
      })
    : {};
  const checkedBaseline = fs.existsSync(COHORT_BASELINE)
    ? (JSON.parse(fs.readFileSync(COHORT_BASELINE, "utf8")) as {
        manifests?: Partial<Record<"train" | "calibration" | "holdout", CohortManifest>>;
      })
    : {};
  const sourceTraceIds = [
    ...(sidecarDoc.candidates || []),
    ...(trainDoc.cases || []),
    ...(governedHoldoutDoc.cases || []),
  ]
    .map((item) => item.source_consensus_id)
    .filter((id): id is string => typeof id === "string");
  const governance = buildGovernanceArtifact({
    train: trainDoc.cases || [],
    calibration: calibrationDoc.cases || [],
    holdout: governedHoldoutDoc.cases || [],
    versions: {
      train: trainDoc.version || "1.0.0",
      calibration: calibrationDoc.version || "1.0.0",
      holdout: governedHoldoutDoc.version || "1.0.0",
    },
    sourceTraceIds,
    rubricVersion: `${nextN}.0.0-proposed`,
    rubricContent: proposed,
    generatedAt,
    previousManifests: priorRequest.governance?.manifests || checkedBaseline.manifests,
  });
  fs.writeFileSync(
    promotionRequestPath,
    `${JSON.stringify({
      schema_version: "1.0.0",
      status: "awaiting_human_review",
      governance,
      regression_evidence: null,
      human_review: null,
      minimum_evidence: { calibration: 20, holdout: 3, annotation_coverage: 0.8 },
      proposed_rubric_path: vNextPath,
      ab_report_path: reportPath,
    }, null, 2)}\n`,
  );

  console.log(
    `✓ rubric snapshot : ${vNPath}\n` +
      `✓ proposed rubric : ${vNextPath}  (${draftSource}, ${clauses.length} clause(s))\n` +
      `✓ A/B report      : ${reportPath}${noAb ? "  (A/B skipped)" : ""}\n` +
      `✓ promotion request: ${promotionRequestPath}  (manual review required)\n` +
      `  training: ${stats.total} cases — overEscalateClean=${stats.overEscalateClean}, ` +
      `overEscalateDefect=${stats.overEscalateDefect}, dissentNoise=${stats.dissentNoise}\n` +
      "  NEXT: operator reviews the report, then decides whether to fold the proposal into consensus-gate.ts.",
  );
}
