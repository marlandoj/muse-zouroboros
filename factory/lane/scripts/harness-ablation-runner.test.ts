import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateShadowAblation } from "./harness-ablation-runner";

describe("harness ablation runner", () => {
  it("runs only in shadow, records rollback, and never changes policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-ablation-"));
    try {
      const ledger = join(dir, "ledger.jsonl");
      const sample = (cost: number, latency: number) => ({ quality: 1, cost_usd: cost, latency_ms: latency, rework: false });
      const record = evaluateShadowAblation({
        assumption_id: "executor-health-probe-before-dispatch",
        baseline: Array(5).fill(0).map(() => sample(1, 100)),
        ablation: Array(5).fill(0).map(() => sample(0.5, 80)),
        now: "2026-07-11T00:00:00Z",
        ledger_path: ledger,
      });
      expect(record.decision).toBe("remove");
      expect(record.mode).toBe("shadow");
      expect(record.production_policy_changed).toBe(false);
      expect(record.rollback).toContain("restore assumption");
      expect(JSON.parse(readFileSync(ledger, "utf8").trim()).assumption_id).toBe(record.assumption_id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses forbidden security assumptions", () => {
    expect(() => evaluateShadowAblation({
      assumption_id: "strict-supply-chain-preflight", baseline: [], ablation: [], ledger_path: "/tmp/never-write.jsonl",
    })).toThrow("not eligible");
  });

  it("rejects invalid minimum samples and sample ranges", () => {
    expect(() => evaluateShadowAblation({
      assumption_id: "executor-health-probe-before-dispatch", baseline: [], ablation: [], min_samples: 0,
    })).toThrow("positive integer");
  });
});
