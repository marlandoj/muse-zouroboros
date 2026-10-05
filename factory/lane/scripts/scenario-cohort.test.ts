import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioRunRecord } from "./scenario-run.ts";
import type { CohortSummary } from "./scenario-cohort.ts";

const manifest = join(import.meta.dir, "..", "scenarios", "fixtures", "actor-system-cohort.json");
const manifestHash = "3c3d63114c567d0b700cb948468ad7b56a37634b1c734f01a4d1e0739a38655e";
const seedHash = "32de64da25af84759eb75e8dff5567eb4f30edb23fe239346c228a3ea93a10d6";
const commit = "ee859d76e3645cd7536678abb4b1870736e52701";
let root = "";

beforeEach(() => root = mkdtempSync(join(tmpdir(), "zou-1057-c4-")));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cli(extraEnv: Record<string, string> = {}) {
  const runs = join(root, "runs.jsonl");
  const summary = join(root, "summary.json");
  const result = spawnSync("bun", [
    join(import.meta.dir, "scenario-cohort.ts"), "run",
    "--manifest", manifest,
    "--manifest-sha256", manifestHash,
    "--approval-sha256", seedHash,
    "--root", root,
    "--runs", runs,
    "--commit", commit,
    "--summary", summary,
  ], { encoding: "utf8", env: { ...process.env, ...extraEnv } });
  return { result, runs, summary };
}

describe("exact approved actor-system cohort", () => {
  test("runs 20 contracts x 3 seeds through incumbent runner with complete cleanup", () => {
    const { result, runs, summary } = cli({ SF009_SCENARIOS: "1", SF009_ACTOR_TWINS: "1", SF009_TRAJECTORY_VERIFIER: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(readFileSync(summary, "utf8")) as CohortSummary;
    expect(report).toEqual(expect.objectContaining({
      manifestHash,
      contracts: 20,
      seeds: 3,
      expectedRuns: 60,
      completedRuns: 60,
      expectedTerminals: 60,
      validReceipts: 60,
      cleanupChecks: 60,
      networkChecks: 60,
      secretStrippingChecks: 60,
      canonicalReports: 60,
      completeReproductions: 60,
      verifierCleanupChecks: 60,
      boundaryViolations: 0,
      answerRecoveryViolations: 0,
      contaminationDetections: 0,
      baselineRestored: true,
      linearBaselinePassed: true,
    }));
    const records = readFileSync(runs, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ScenarioRunRecord);
    expect(records.filter((record) => record.twin === "actor-system")).toHaveLength(60);
    expect(records.filter((record) => record.twin === "linear")).toHaveLength(1);
    expect(new Set(records.filter((record) => record.twin === "actor-system").map((record) => record.run_receipt_hash)).size).toBe(60);
    expect(existsSync(join(root, "specs"))).toBe(false);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("sf009-") && name.includes("actor-"))).toEqual([]);
  }, 30_000);

  test("flags off exit before manifest reads or writes", () => {
    const missingRoot = join(root, "missing-root");
    const result = spawnSync("bun", [
      join(import.meta.dir, "scenario-cohort.ts"), "run",
      "--manifest", join(root, "missing.json"),
      "--root", missingRoot,
      "--runs", join(missingRoot, "runs.jsonl"),
    ], {
      encoding: "utf8",
      env: { ...process.env, SF009_SCENARIOS: "0", SF009_ACTOR_TWINS: "0", SF009_TRAJECTORY_VERIFIER: "0" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(missingRoot)).toBe(false);
  });

  test("manifest drift fails before state mutation", () => {
    const drift = spawnSync("bun", [
      join(import.meta.dir, "scenario-cohort.ts"), "run",
      "--manifest", manifest,
      "--manifest-sha256", "0".repeat(64),
      "--approval-sha256", seedHash,
      "--root", join(root, "drift"),
      "--runs", join(root, "drift-runs.jsonl"),
      "--commit", commit,
    ], { encoding: "utf8", env: { ...process.env, SF009_SCENARIOS: "1", SF009_ACTOR_TWINS: "1", SF009_TRAJECTORY_VERIFIER: "1" } });
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain("manifest hash mismatch");
    expect(existsSync(join(root, "drift"))).toBe(false);
  }, 30_000);
});
