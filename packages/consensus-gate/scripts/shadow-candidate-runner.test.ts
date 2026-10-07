import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  loadShadowRuns,
  loadSourceCases,
  runShadowAdvisory,
  selectFreshCases,
  type ShadowSourceCase,
} from "./shadow-candidate-runner";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-candidate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sourceCase: ShadowSourceCase = {
  id: "cg-source-1",
  timestamp: "2026-07-10T00:00:00.000Z",
  label: "production-case",
  code: "const value = input ?? 0;",
  criteria: "correctness",
  pass: true,
  status: "passed",
};

describe("shadow candidate source selection", () => {
  test("accepts only completed unanimous production cases", () => {
    const dir = tempDir();
    const dbPath = path.join(dir, "consensus.json");
    fs.writeFileSync(dbPath, JSON.stringify([
      { ...sourceCase, consensus: { pass: true, unanimous: true } },
      { ...sourceCase, id: "split", consensus: { pass: true, unanimous: false } },
      { ...sourceCase, id: "shadow", label: "shadow-candidate:test", consensus: { pass: true, unanimous: true } },
    ]));
    expect(loadSourceCases(dbPath).map((row) => row.id)).toEqual(["cg-source-1"]);
  });

  test("never selects a previously evaluated candidate-case pair", () => {
    const seen = new Set(["candidate-a\u0000cg-source-1"]);
    expect(selectFreshCases("candidate-a", [sourceCase], seen, 1)).toEqual([]);
    expect(selectFreshCases("candidate-b", [sourceCase], seen, 1)).toEqual([sourceCase]);
  });
});

describe("shadow advisory runner", () => {
  test("records one independent advisory vote and does not count it twice", async () => {
    const dir = tempDir();
    const ledgerPath = path.join(dir, "runs.jsonl");
    const reputationWrites: unknown[] = [];
    const options = {
      sourceCases: [sourceCase],
      ledgerPath,
      reviewer: async (model: string) => ({
        model,
        pass: true,
        issues: [],
        confidence: 0.9,
        latencyMs: 1,
      }),
      reputationWriter: (...args: unknown[]) => { reputationWrites.push(args); },
      now: () => new Date("2026-07-11T11:00:00.000Z"),
    };

    const first = await runShadowAdvisory([{ id: "candidate-a", route: "oc:candidate-a" }], options as any);
    const second = await runShadowAdvisory([{ id: "candidate-a", route: "oc:candidate-a" }], options as any);

    expect(first[0]).toMatchObject({ attempted: 1, fresh_evidence: 1, agreements: 1, vendor_errors: 0 });
    expect(second[0]).toMatchObject({ attempted: 0, fresh_evidence: 0 });
    expect(reputationWrites).toHaveLength(1);
    expect(fs.readFileSync(ledgerPath, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  test("persists vendor failures without counting fresh evidence", async () => {
    const dir = tempDir();
    const result = await runShadowAdvisory(
      [{ id: "candidate-a", route: "oc:candidate-a" }],
      {
        sourceCases: [sourceCase],
        ledgerPath: path.join(dir, "runs.jsonl"),
        reviewer: async (model: string) => ({
          model,
          pass: false,
          issues: ["API error: 503"],
          confidence: 0,
          latencyMs: 1,
        }),
        reputationWriter: () => undefined,
      } as any,
    );
    expect(result[0]).toMatchObject({ attempted: 1, fresh_evidence: 0, vendor_errors: 1 });
  });
});

test("loadShadowRuns filters by candidate and skips malformed lines", () => {
  const ledger = `/tmp/shadow-ledger-${process.pid}.jsonl`;
  fs.writeFileSync(
    ledger,
    [
      JSON.stringify({ candidate_id: "a", agreed: true, vendor_error: false }),
      "{ not json",
      "",
      JSON.stringify({ candidate_id: "b", agreed: false, vendor_error: true }),
      JSON.stringify({ agreed: true }),
      JSON.stringify({ candidate_id: "a", agreed: false, vendor_error: false }),
    ].join("\n"),
  );
  try {
    expect(loadShadowRuns(undefined, ledger)).toHaveLength(3);
    expect(loadShadowRuns("a", ledger)).toHaveLength(2);
    expect(loadShadowRuns("missing", ledger)).toHaveLength(0);
    expect(loadShadowRuns("a", "/tmp/does-not-exist.jsonl")).toHaveLength(0);
  } finally {
    fs.unlinkSync(ledger);
  }
});
