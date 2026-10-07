import { describe, expect, test } from "bun:test";
import {
  selectMisverdictCandidates,
  type VerdictLogLine,
  type VerdictDbRecord,
  type CalibrationCase,
} from "./reconcile-core";

/** Build a log line + matching db record pair for a fixture. */
function pair(
  id: string,
  status: string,
  verdict: Partial<VerdictLogLine["verdict"]>,
  code: string,
  criteria = "must be correct",
  ts = "2026-06-30T10:00:00.000Z",
  mergeReason?: string,
): { line: VerdictLogLine; db: VerdictDbRecord } {
  return {
    line: {
      consensus_id: id,
      timestamp: ts,
      label: id,
      status,
      ...(mergeReason ? { merge_adjust_reason: mergeReason } : {}),
      verdict: { pass: false, confidence: 1, models: {}, ...verdict },
    },
    db: { id, code, criteria, status, timestamp: ts, label: id },
  };
}

describe("selectMisverdictCandidates", () => {
  test("empty inputs -> []", () => {
    expect(selectMisverdictCandidates([], [], [])).toEqual([]);
  });

  test("clean unanimous high-confidence verdict produces no candidate", () => {
    const { line, db } = pair(
      "c1",
      "passed",
      { pass: true, confidence: 1, models: { a: { pass: true }, b: { pass: true } } },
      "const x = 1;",
    );
    expect(selectMisverdictCandidates([line], [db], [])).toEqual([]);
  });

  test("log line with no matching db record is dropped (no recoverable code)", () => {
    const { line } = pair("c2", "split", {}, "ignored");
    expect(selectMisverdictCandidates([line], [], [])).toEqual([]);
  });

  test("candidate whose code matches an existing seed case is deduped out", () => {
    const code = "let n: number = 'oops';";
    const { line, db } = pair("c3", "split", {}, code);
    const existing: CalibrationCase[] = [{ id: "seed-1", code: "let n: number = 'oops';" }];
    expect(selectMisverdictCandidates([line], [db], existing)).toEqual([]);
  });

  test("dedup is whitespace-insensitive", () => {
    const { line, db } = pair("c3b", "split", {}, "  let n: number  =  'oops';  ");
    const existing: CalibrationCase[] = [{ id: "seed-1", code: "let n: number = 'oops';" }];
    expect(selectMisverdictCandidates([line], [db], existing)).toEqual([]);
  });

  test("two log lines with the same code collapse to one (best rank kept)", () => {
    const code = "let n: number = 'oops';";
    const split = pair("dup-split", "split", {}, code, "c", "2026-06-30T09:00:00.000Z");
    const esc = pair(
      "dup-esc",
      "escalate",
      { pass: null, models: { a: { pass: true }, b: { pass: false } } },
      code,
      "c",
      "2026-06-30T11:00:00.000Z",
    );
    const out = selectMisverdictCandidates([split.line, esc.line], [split.db, esc.db], []);
    expect(out).toHaveLength(1);
    expect(out[0].signal_class).toBe("escalate");
    expect(out[0].source_consensus_id).toBe("dup-esc");
  });

  test("ranking: escalate > split > low_confidence", () => {
    const esc = pair(
      "e",
      "escalate",
      { pass: null, models: { a: { pass: true }, b: { pass: false } } },
      "code_escalate();",
    );
    const split = pair("s", "split", {}, "code_split();");
    const low = pair("l", "passed", { pass: true, confidence: 0.4, models: { a: { pass: true } } }, "code_low();");
    const out = selectMisverdictCandidates(
      [low.line, split.line, esc.line],
      [low.db, split.db, esc.db],
      [],
    );
    expect(out.map((c) => c.signal_class)).toEqual(["escalate", "split", "low_confidence"]);
  });

  test("dissent class fires when not split/escalate but dissenting_models present", () => {
    const { line, db } = pair(
      "d",
      "rejected",
      { pass: false, confidence: 0.95, dissenting_models: ["non-llm/arbiter-v1"], models: { a: { pass: false } } },
      "code_dissent();",
    );
    const out = selectMisverdictCandidates([line], [db], []);
    expect(out).toHaveLength(1);
    expect(out[0].signal_class).toBe("dissent");
    expect(out[0].dissenting_models).toEqual(["non-llm/arbiter-v1"]);
  });

  test("merge_adjust class recognized from top-level reason", () => {
    const { line, db } = pair(
      "m",
      "rejected",
      { pass: false, confidence: 0.9, models: { a: { pass: false } } },
      "code_merge();",
      "c",
      "2026-06-30T10:00:00.000Z",
      "deterministic-first-hard-fail",
    );
    const out = selectMisverdictCandidates([line], [db], []);
    expect(out).toHaveLength(1);
    expect(out[0].signal_class).toBe("merge_adjust");
    expect(out[0].merge_adjust_reason).toBe("deterministic-first-hard-fail");
  });

  test("topN is respected", () => {
    const pairs = Array.from({ length: 20 }, (_, i) =>
      pair(`s${i}`, "split", {}, `code_${i}();`),
    );
    const out = selectMisverdictCandidates(
      pairs.map((p) => p.line),
      pairs.map((p) => p.db),
      [],
      { topN: 5 },
    );
    expect(out).toHaveLength(5);
  });

  test("category diversity cap promotes a lower-ranked non-security candidate", () => {
    // 4 security splits ranked ABOVE 1 performance split (more panel disagreement).
    // Without a cap, topN=2 would be 2 security; with perCategoryCap=1 the cap
    // forces the performance candidate into the 2nd slot over a 2nd security.
    const sec = (i: number) =>
      pair(
        `sec${i}`,
        "split",
        { models: { a: { pass: true }, b: { pass: true }, c: { pass: false } } }, // disagree 2/3
        `eval(userInput_${i});`,
        "reject eval injection",
      );
    const perf = pair(
      "perf",
      "split",
      { models: { a: { pass: true }, b: { pass: false } } }, // disagree 1/2 -> lower rank
      "for_n_plus_1_query();",
      "avoid N+1 query performance issue",
    );
    const ps = [sec(1), sec(2), sec(3), sec(4), perf];
    const out = selectMisverdictCandidates(
      ps.map((p) => p.line),
      ps.map((p) => p.db),
      [],
      { topN: 2, perCategoryCap: 1 },
    );
    const cats = out.map((c) => c.derived_category);
    expect(out).toHaveLength(2);
    expect(cats).toContain("performance");
    expect(cats.filter((c) => c === "security")).toHaveLength(1);
  });

  test("diversity cap is light: still fills topN when only one category exists", () => {
    const ps = Array.from({ length: 5 }, (_, i) =>
      pair(`sec${i}`, "split", {}, `eval(x_${i});`, "reject eval injection"),
    );
    const out = selectMisverdictCandidates(
      ps.map((p) => p.line),
      ps.map((p) => p.db),
      [],
      { topN: 4, perCategoryCap: 1 },
    );
    expect(out).toHaveLength(4); // cap relaxed in second pass
    expect(out.every((c) => c.derived_category === "security")).toBe(true);
  });

  test("escalate disagreement_fraction reflects within-panel split", () => {
    const { line, db } = pair(
      "esc",
      "escalate",
      { pass: null, models: { a: { pass: true }, b: { pass: true }, c: { pass: false }, d: { pass: false } } },
      "code();",
    );
    const out = selectMisverdictCandidates([line], [db], []);
    expect(out[0].disagreement_fraction).toBe(0.5); // min(2,2)/4
  });

  test("output is deterministic across input ordering", () => {
    const a = pair("a", "escalate", { pass: null, models: { x: { pass: true }, y: { pass: false } } }, "ca();");
    const b = pair("b", "split", {}, "cb();");
    const c = pair("c", "passed", { pass: true, confidence: 0.3, models: { x: { pass: true } } }, "cc();");
    const fwd = selectMisverdictCandidates([a.line, b.line, c.line], [a.db, b.db, c.db], []);
    const rev = selectMisverdictCandidates([c.line, b.line, a.line], [c.db, b.db, a.db], []);
    expect(fwd.map((x) => x.source_consensus_id)).toEqual(rev.map((x) => x.source_consensus_id));
  });
});
