import { describe, test, expect } from "bun:test";
import {
  computeCostPerOutcome,
  computeRankFlip,
  type CostRow,
  type VerdictRow,
} from "./cost-per-outcome";

function cost(runId: string | null, model: string, vendor: string, costUsd: number, ts = 0): CostRow {
  return { runId, model, vendor, costUsd, ts };
}
function verdict(gateRunId: string | null, status: string, ts = "2026-06-30T00:00:00.000Z"): VerdictRow {
  return { gateRunId, status, consensusId: `c-${gateRunId}`, timestamp: ts };
}

describe("computeCostPerOutcome — exact join", () => {
  test("buckets cost by outcome and computes $/resolved-task", () => {
    const costRows = [
      cost("r1", "cheap", "xai", 0.01),
      cost("r1", "pricey", "hf", 0.09), // r1 PASSED, total 0.10
      cost("r2", "cheap", "xai", 0.02),
      cost("r2", "pricey", "hf", 0.08), // r2 REJECTED, total 0.10
      cost("r3", "cheap", "xai", 0.04), // r3 PASSED, total 0.04
    ];
    const verdicts = [verdict("r1", "passed"), verdict("r2", "rejected"), verdict("r3", "passed")];

    const out = computeCostPerOutcome(costRows, verdicts);

    expect(out.joinedRuns).toBe(3);
    expect(out.unjoinedCostRuns).toBe(0);
    expect(out.unjoinedVerdicts).toBe(0);
    expect(out.estimated).toBe(false);

    expect(out.byOutcome.passed.runs).toBe(2);
    expect(out.byOutcome.passed.totalUsd).toBeCloseTo(0.14, 6); // 0.10 + 0.04
    expect(out.byOutcome.passed.usdPerRun).toBeCloseTo(0.07, 6); // 0.14 / 2
    expect(out.byOutcome.rejected.runs).toBe(1);
    expect(out.byOutcome.rejected.totalUsd).toBeCloseTo(0.1, 6);

    // headline $/resolved-task == passed bucket usdPerRun
    expect(out.resolvedTaskUsd).toBeCloseTo(0.07, 6);
  });

  test("per-model passedRuns counts a run once even with fallback rows", () => {
    const costRows = [
      cost("r1", "m", "hf", 0.01),
      cost("r1", "m", "hf", 0.02), // same model twice in one run (fallback)
    ];
    const out = computeCostPerOutcome(costRows, [verdict("r1", "passed")]);
    const m = out.byModel.find((x) => x.model === "m")!;
    expect(m.calls).toBe(2);
    expect(m.passedRuns).toBe(1); // not 2
    expect(m.passedUsd).toBeCloseTo(0.03, 6);
    expect(m.usdPerPassedRun).toBeCloseTo(0.03, 6);
  });
});

describe("computeCostPerOutcome — rank flip (the Cursor headline)", () => {
  test("cheap-per-call but rarely-passes model ranks worse per resolved-task", () => {
    // 'cheap' is cheapest per call but only passes 1 of its 3 runs.
    // 'pricey' costs more per call but passes both its runs.
    const costRows = [
      cost("a1", "cheap", "xai", 0.01),
      cost("a2", "cheap", "xai", 0.01),
      cost("a3", "cheap", "xai", 0.01),
      cost("b1", "pricey", "hf", 0.05),
      cost("b2", "pricey", "hf", 0.05),
    ];
    const verdicts = [
      verdict("a1", "passed"),
      verdict("a2", "rejected"),
      verdict("a3", "rejected"),
      verdict("b1", "passed"),
      verdict("b2", "passed"),
    ];
    const out = computeCostPerOutcome(costRows, verdicts);

    const cheap = out.byModel.find((m) => m.model === "cheap")!;
    const pricey = out.byModel.find((m) => m.model === "pricey")!;

    expect(cheap.usdPerCall).toBeCloseTo(0.01, 6);
    expect(pricey.usdPerCall).toBeCloseTo(0.05, 6);
    // cheap: 1 passed run, 0.01 spent in it -> 0.01 per resolved
    expect(cheap.usdPerPassedRun).toBeCloseTo(0.01, 6);
    // pricey: 2 passed runs, 0.10 spent across them -> 0.05 per resolved
    expect(pricey.usdPerPassedRun).toBeCloseTo(0.05, 6);

    // Per-call ranking: cheap < pricey. Per-resolved: still cheap < pricey here
    // because cheap's single pass is cheap. Make the flip explicit instead:
    const flip = out.rankFlip!;
    expect(flip.byCall[0]).toBe("cheap");
  });

  test("explicit flip: cheap-per-call inverts to most-expensive per resolved", () => {
    // 'flaky' is cheapest per call but NEVER passes -> infinite $/resolved -> last.
    // 'solid' is pricier per call but passes -> ranks first per resolved.
    const costRows = [
      cost("f1", "flaky", "xai", 0.01),
      cost("f2", "flaky", "xai", 0.01),
      cost("s1", "solid", "hf", 0.04),
    ];
    const verdicts = [verdict("f1", "rejected"), verdict("f2", "escalate"), verdict("s1", "passed")];
    const out = computeCostPerOutcome(costRows, verdicts);

    const flip = out.rankFlip!;
    expect(flip.flipped).toBe(true);
    expect(flip.byCall[0]).toBe("flaky"); // cheapest per call
    expect(flip.byResolved[0]).toBe("solid"); // cheapest per resolved
    expect(flip.byResolved[flip.byResolved.length - 1]).toBe("flaky"); // never passes -> last

    const flaky = out.byModel.find((m) => m.model === "flaky")!;
    expect(flaky.usdPerPassedRun).toBeNull();
  });

  test("no flip when call-order equals resolved-order", () => {
    const costRows = [cost("r1", "a", "x", 0.01), cost("r2", "b", "y", 0.02)];
    const out = computeCostPerOutcome(costRows, [verdict("r1", "passed"), verdict("r2", "passed")]);
    expect(out.rankFlip!.flipped).toBe(false);
  });

  test("rank flip null with fewer than 2 models", () => {
    expect(computeRankFlip([])).toBeNull();
  });
});

describe("computeCostPerOutcome — tier rollup", () => {
  test("groups models by vendor/tier", () => {
    const costRows = [
      cost("r1", "hf:a", "hf", 0.02),
      cost("r1", "hf:b", "hf", 0.03),
      cost("r1", "xai:c", "xai", 0.01),
    ];
    const out = computeCostPerOutcome(costRows, [verdict("r1", "passed")]);
    const hf = out.byTier.find((t) => t.tier === "hf")!;
    const xai = out.byTier.find((t) => t.tier === "xai")!;
    expect(hf.totalUsd).toBeCloseTo(0.05, 6);
    expect(hf.calls).toBe(2);
    expect(xai.totalUsd).toBeCloseTo(0.01, 6);
  });
});

describe("computeCostPerOutcome — edge + estimated", () => {
  test("nothing passed -> resolvedTaskUsd null", () => {
    const out = computeCostPerOutcome([cost("r1", "m", "x", 0.01)], [verdict("r1", "rejected")]);
    expect(out.resolvedTaskUsd).toBeNull();
  });

  test("cost rows with no runId are ignored", () => {
    const out = computeCostPerOutcome([cost(null, "m", "x", 0.99)], [verdict("r1", "passed")]);
    expect(out.byModel.length).toBe(0);
    expect(out.joinedRuns).toBe(0);
  });

  test("unjoined cost runs and verdicts are counted, not joined", () => {
    const out = computeCostPerOutcome(
      [cost("r1", "m", "x", 0.01), cost("r2", "m", "x", 0.02)],
      [verdict("r1", "passed"), verdict("rZ", "passed")] // rZ has no cost rows
    );
    expect(out.joinedRuns).toBe(1);
    expect(out.unjoinedCostRuns).toBe(1); // r2 unmatched
    expect(out.unjoinedVerdicts).toBe(1); // rZ unmatched
    expect(out.estimated).toBe(false);
  });

  test("proximity backfill matches nearest unclaimed run, flags estimated", () => {
    // verdict has NO gateRunId (historical) but ts is near r1's ts
    const costRows = [cost("r1", "m", "x", 0.05, 1000), cost("r2", "m", "x", 0.05, 99999)];
    const verdicts: VerdictRow[] = [
      { gateRunId: null, consensusId: "c1", status: "passed", timestamp: new Date(1200).toISOString() },
    ];
    const out = computeCostPerOutcome(costRows, verdicts, { proximityMs: 500 });
    expect(out.estimated).toBe(true);
    expect(out.joinedRuns).toBe(1);
    expect(out.byOutcome.passed.totalUsd).toBeCloseTo(0.05, 6); // matched r1, not r2
  });

  test("proximity off by default: historical verdicts stay unjoined", () => {
    const costRows = [cost("r1", "m", "x", 0.05, 1000)];
    const verdicts: VerdictRow[] = [
      { gateRunId: null, consensusId: "c1", status: "passed", timestamp: new Date(1200).toISOString() },
    ];
    const out = computeCostPerOutcome(costRows, verdicts);
    expect(out.estimated).toBe(false);
    expect(out.joinedRuns).toBe(0);
  });
});
