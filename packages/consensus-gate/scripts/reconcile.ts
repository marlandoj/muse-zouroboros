/**
 * Dataset reconciliation CLI for the consensus-gate judge (P1-7, zou-reconcile-p1-7).
 *
 * Two modes, both ADVISORY and ADDITIVE:
 *
 *   reconcile.ts            (read)  surface disagreement-signal candidates from the
 *                                   prod verdict stream -> reconcile-candidates.md
 *                                   (human annotation sheet) + .json sidecar with
 *                                   BLANK human fields. Labels NOTHING automatically.
 *
 *   reconcile.ts --apply            route each human-LABELED sidecar item into its
 *                                   selected train or holdout cohort (idempotent by
 *                                   source_consensus_id). NEVER mutates the calibration
 *                                   set in test-cases.json.
 *
 * The pure ranking/dedup/cap logic lives in reconcile-core.ts (tested). This file
 * is only IO + formatting. consensus-gate.ts is READ-ONLY for this whole item.
 */
import {
  selectMisverdictCandidates,
  type VerdictLogLine,
  type VerdictDbRecord,
  type CalibrationCase,
  type MisverdictCandidate,
} from "./reconcile-core";
import { sha256 } from "./dataset-governance";

const DATA_DIR = `${import.meta.dir}/../data/calibration`;
const TEST_CASES = `${DATA_DIR}/test-cases.json`;
const OUT_MD = `${DATA_DIR}/reconcile-candidates.md`;
const OUT_JSON = `${DATA_DIR}/reconcile-candidates.json`;
const HOLDOUT = `${DATA_DIR}/reconciled-holdout.json`;
const TRAIN = `${DATA_DIR}/reconciled-train.json`;

/** Stable cosmetic id from a consensus_id (e.g. cg-1782..-y4ywue -> rec-y4ywue). */
function holdoutId(consensusId: string): string {
  const tail = consensusId.split("-").pop() || consensusId;
  return `rec-${tail}`;
}

interface SidecarCandidate extends MisverdictCandidate {
  human_expected_pass: boolean | null;
  human_category: string;
  human_difficulty: string;
  human_notes: string;
  decision: "" | "include" | "skip";
  human_cohort: "train" | "holdout";
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 11)}…` : id;
}

function truncate(s: string, n: number): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function renderMarkdown(
  candidates: MisverdictCandidate[],
  meta: { logLines: number; dbRecords: number; existingCases: number; topN: number },
): string {
  const lines: string[] = [];
  lines.push("# Consensus-Gate Reconciliation — Human Annotation Sheet");
  lines.push("");
  lines.push(
    "**Purpose:** these are PROD gate verdicts surfaced by *disagreement signal* " +
      "(escalate / split / dissent / merge-adjust / low-confidence) — i.e. the cases " +
      "the panel was *least sure* about. There is **no prod ground truth**, so none of " +
      "these are labeled. Your job: decide the correct verdict for the ones worth keeping.",
  );
  lines.push("");
  lines.push(
    `**Source:** ${meta.logLines} log lines, ${meta.dbRecords} db records, ` +
      `deduped against ${meta.existingCases} existing seed cases → top ${candidates.length} candidates.`,
  );
  lines.push("");
  lines.push("**How to respond:** edit the sidecar `reconcile-candidates.json` — for each");
  lines.push("candidate set `human_expected_pass` (`true`=gate should PASS, `false`=gate");
  lines.push("should FAIL) and `decision` (`include` to add to a governed cohort, `skip` to");
  lines.push("drop). Set `human_cohort` to `train` only when the label may shape a rubric;");
  lines.push("leave it `holdout` for evaluation-only cases. Optionally fill category/difficulty/notes.");
  lines.push("Then run `bun reconcile.ts --apply`.");
  lines.push("");
  lines.push(
    "> The held-out set is **never an optimizer target** (anti-Goodhart). It is used " +
      "only to validate proposed rubric rewrites — not to tune them.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("| # | id | label | signal | gate | conf | disagree | category | criteria |");
  lines.push("|---|----|-------|--------|------|------|----------|----------|----------|");
  candidates.forEach((c, i) => {
    const gate = c.gate_pass === null ? "—" : c.gate_pass ? "PASS" : "FAIL";
    const conf = c.gate_confidence === null ? "—" : c.gate_confidence.toFixed(2);
    lines.push(
      `| ${i + 1} | \`${shortId(c.source_consensus_id)}\` | ${truncate(c.label, 28)} | ` +
        `${c.signal_class} | ${gate} | ${conf} | ${c.disagreement_fraction} | ` +
        `${c.derived_category} | ${truncate(c.criteria, 36)} |`,
    );
  });
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Code under review (per candidate)");
  lines.push("");
  candidates.forEach((c, i) => {
    lines.push(`### ${i + 1}. \`${c.source_consensus_id}\` — ${c.label || "(no label)"}`);
    lines.push("");
    lines.push(
      `- signal: **${c.signal_class}** · gate verdict: ` +
        `**${c.gate_pass === null ? "escalated" : c.gate_pass ? "PASS" : "FAIL"}** ` +
        `(conf ${c.gate_confidence ?? "—"}) · panel disagreement ${c.disagreement_fraction}`,
    );
    if (c.dissenting_models.length) lines.push(`- dissenting: ${c.dissenting_models.join(", ")}`);
    if (c.merge_adjust_reason) lines.push(`- merge-adjust: ${c.merge_adjust_reason}`);
    lines.push(`- criteria: ${truncate(c.criteria, 200)}`);
    lines.push("");
    lines.push("```");
    lines.push(c.code.length > 2000 ? `${c.code.slice(0, 2000)}\n… (truncated)` : c.code);
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}

async function readJson<T>(fs: typeof import("node:fs"), path: string, fallback: T): Promise<T> {
  if (!fs.existsSync(path)) return fallback;
  return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

if (import.meta.main) {
  const fs = await import("node:fs");
  const argv = process.argv.slice(2);
  const has = (n: string) => argv.includes(n);
  const arg = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const HOME = process.env.HOME || "";
  const LOG = process.env.CONSENSUS_LOG || `${HOME}/.zouroboros/consensus-gate.log`;
  const DB = process.env.CONSENSUS_DB || `${HOME}/.zouroboros/consensus-gate.json`;

  if (has("--apply")) {
    // ── T3: fold the human-labeled sidecar into the held-out set ──────────────
    if (!fs.existsSync(OUT_JSON)) {
      console.error(`✗ no annotation sidecar at ${OUT_JSON} — run \`reconcile.ts\` (read) first.`);
      process.exit(1);
    }
    const sidecar = JSON.parse(fs.readFileSync(OUT_JSON, "utf8")) as {
      candidates: SidecarCandidate[];
    };
    const labeled = (sidecar.candidates || []).filter(
      (c) => c.decision === "include" && typeof c.human_expected_pass === "boolean",
    );
    if (labeled.length === 0) {
      console.error(
        "✗ no candidates marked decision='include' with a boolean human_expected_pass. " +
          "Annotate the sidecar first. (Nothing written — test-cases.json untouched.)",
      );
      process.exit(1);
    }

    const now = new Date().toISOString();
    const annotator = arg("--by") || process.env.RECONCILE_ANNOTATOR || process.env.USER || "operator";
    const bumpPatch = (version: string): string => {
      const [major = "1", minor = "0", patch = "0"] = version.split(".");
      return `${major}.${minor}.${Number(patch) + 1}`;
    };
    const applyCohort = async (cohort: "train" | "holdout", path: string) => {
      const selected = labeled.filter((candidate) => (candidate.human_cohort || "holdout") === cohort);
      if (selected.length === 0) return { cohort, total: 0, added: 0, updated: 0 };
      const doc = await readJson(fs, path, {
        name: `consensus-gate-reconciled-${cohort}-v1`, version: "1.0.0",
        created: now, updated: now, human_verified: true,
        provenance: cohort === "holdout"
          ? "Reconciled human labels. HELD-OUT — evaluation only, never an optimizer target."
          : "Reconciled human labels approved for rubric training.",
        cases: [] as Record<string, unknown>[],
      });
      const byKey = new Map<string, Record<string, unknown>>();
      for (const item of doc.cases) byKey.set(String(item.source_consensus_id), item);
      let added = 0;
      let updated = 0;
      for (const candidate of selected) {
        const key = candidate.source_consensus_id;
        const record = {
          id: holdoutId(key), source_consensus_id: key, label: candidate.label,
          code: candidate.code, criteria: candidate.criteria,
          expected_pass: candidate.human_expected_pass,
          category: candidate.human_category || candidate.derived_category,
          difficulty: candidate.human_difficulty || "unknown", notes: candidate.human_notes || "",
          gate_pass: candidate.gate_pass, signal_class: candidate.signal_class,
          annotated_by: annotator, annotated_at: now, cohort,
          source_trace_sha256: sha256({ source_consensus_id: key }),
          annotation_sha256: sha256({
            source_consensus_id: key, expected_pass: candidate.human_expected_pass,
            annotated_by: annotator, annotated_at: now,
          }),
          holdout: cohort === "holdout",
        };
        if (byKey.has(key)) updated++; else added++;
        byKey.set(key, record);
      }
      if (cohort === "holdout" && fs.existsSync(path)) {
        const snapshot = `${DATA_DIR}/reconciled-holdout.v${doc.version}.${sha256(doc.cases).slice(0, 12)}.json`;
        if (!fs.existsSync(snapshot)) fs.writeFileSync(snapshot, `${JSON.stringify(doc, null, 2)}\n`);
      }
      doc.cases = [...byKey.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      doc.updated = now;
      doc.version = bumpPatch(doc.version);
      fs.writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
      return { cohort, total: doc.cases.length, added, updated };
    };
    const results = await Promise.all([
      applyCohort("train", TRAIN),
      applyCohort("holdout", HOLDOUT),
    ]);
    console.log(`✓ reconciled cohorts updated; test-cases.json untouched.\n${JSON.stringify(results, null, 2)}`);
    process.exit(0);
  }

  // ── T2: read mode — surface candidates for annotation ───────────────────────
  if (!fs.existsSync(LOG)) {
    console.error(`✗ no verdict log at ${LOG}`);
    process.exit(1);
  }
  const verdictLog: VerdictLogLine[] = fs
    .readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as VerdictLogLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is VerdictLogLine => x !== null);

  const dbRecords = await readJson<VerdictDbRecord[]>(fs, DB, []);
  const testCasesDoc = await readJson<{ cases?: CalibrationCase[] }>(fs, TEST_CASES, {});
  const existingCases = testCasesDoc.cases || [];

  const topN = Number(arg("--top") ?? 12);
  const lowConfThreshold = Number(arg("--low-conf") ?? 0.6);
  const candidates = selectMisverdictCandidates(verdictLog, dbRecords, existingCases, {
    topN,
    lowConfThreshold,
  });

  if (has("--json")) {
    console.log(JSON.stringify(candidates, null, 2));
    process.exit(0);
  }

  const meta = {
    logLines: verdictLog.length,
    dbRecords: dbRecords.length,
    existingCases: existingCases.length,
    topN,
  };
  const sidecar = {
    generated: new Date().toISOString(),
    source: { log: LOG, db: DB, ...meta },
    opts: { topN, lowConfThreshold, perCategoryCap: Math.max(1, Math.ceil(topN / 3)) },
    instructions:
      "For each candidate set human_expected_pass (true|false) and decision ('include'|'skip'), " +
      "select human_cohort ('train'|'holdout'), then run `reconcile.ts --apply`. " +
      "test-cases.json is never modified.",
    candidates: candidates.map(
      (c): SidecarCandidate => ({
        ...c,
        human_expected_pass: null,
        human_category: "",
        human_difficulty: "",
        human_notes: "",
        decision: "",
        human_cohort: "holdout",
      }),
    ),
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(sidecar, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, renderMarkdown(candidates, meta));
  console.log(
    `✓ ${candidates.length} candidates surfaced from ${meta.logLines} log lines ` +
      `(${meta.dbRecords} db records, deduped vs ${meta.existingCases} seed cases).\n` +
      `  annotation sheet : ${OUT_MD}\n` +
      `  sidecar (edit me): ${OUT_JSON}\n` +
      `  then: bun reconcile.ts --apply`,
  );
}
