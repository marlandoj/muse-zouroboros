import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioRunRecord } from "./scenario-run.ts";
import type { CohortSummary } from "./scenario-cohort.ts";

const manifest = join(import.meta.dir, "..", "scenarios", "fixtures", "actor-system-cohort.json");
const manifestHash = "3c3d63114c567d0b700cb948468ad7b56a37634b1c734f01a4d1e0739a38655e";
const approvalHash = "17ee050d38d4791fceabefbdac1b39704339be5c54efdcab06b448fb24ee0b48";
const commit = "61e029112d8d28d8a2b3fb6253c36fac1efef2be";
let root = "";

beforeEach(() => root = mkdtempSync(join(tmpdir(), "zou-1058-c4-")));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(name: string, verifier: "0" | "1") {
  const stateRoot = join(root, name);
  const runs = join(root, `${name}-runs.jsonl`);
  const summary = join(root, `${name}-summary.json`);
  const result = spawnSync("bun", [
    join(import.meta.dir, "scenario-cohort.ts"), "run",
    "--manifest", manifest,
    "--manifest-sha256", manifestHash,
    "--approval-sha256", approvalHash,
    "--root", stateRoot,
    "--runs", runs,
    "--commit", commit,
    "--summary", summary,
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      SF009_SCENARIOS: "1",
      SF009_ACTOR_TWINS: "1",
      SF009_TRAJECTORY_VERIFIER: verifier,
    },
  });
  return { result, runs, summary, stateRoot };
}

function actorRecords(path: string): ScenarioRunRecord[] {
  return readFileSync(path, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as ScenarioRunRecord)
    .filter((record) => record.twin === "actor-system");
}

describe("ZOU-1058 exact sandboxed trajectory cohort", () => {
  test("60 fresh workers produce canonical reports with >=54 complete reproductions and zero boundary violations", () => {
    const { result, runs, summary, stateRoot } = run("verified", "1");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(readFileSync(summary, "utf8")) as CohortSummary;
    expect(report.expectedRuns).toBe(60);
    expect(report.completedRuns).toBe(60);
    expect(report.canonicalReports).toBe(60);
    expect(report.completeReproductions).toBeGreaterThanOrEqual(54);
    expect(report.validReceipts).toBe(60);
    expect(report.verifierCleanupChecks).toBe(60);
    expect(report.boundaryViolations).toBe(0);
    expect(report.answerRecoveryViolations).toBe(0);
    expect(report.contaminationDetections).toBe(0);
    const records = actorRecords(runs);
    expect(records).toHaveLength(60);
    expect(records.every((record) => record.verdict === "passed" && record.trajectory_disposition === "PASS")).toBe(true);
    expect(records.every((record) => Object.keys(record).filter((key) => key.startsWith("trajectory_")).length === 5)).toBe(true);
    expect(existsSync(join(stateRoot, "specs"))).toBe(false);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("sf009-verifier-") || name.startsWith("sf009-actor-"))).toEqual([]);
  }, 30_000);

  test("disabling verifier restores the incumbent grader and omits every trajectory consumer field", () => {
    const { result, runs, summary } = run("rollback", "0");
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(summary, "utf8")) as CohortSummary;
    expect(report.completedRuns).toBe(60);
    expect(report.canonicalReports).toBe(0);
    expect(report.completeReproductions).toBe(0);
    expect(report.baselineRestored).toBe(true);
    expect(report.linearBaselinePassed).toBe(true);
    const records = actorRecords(runs);
    expect(records.every((record) => record.verdict === "passed")).toBe(true);
    expect(records.every((record) => !Object.keys(record).some((key) => key.startsWith("trajectory_")))).toBe(true);
    expect(new Set(records.map((record) => record.run_receipt_hash)).size).toBe(60);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("sf009-verifier-"))).toEqual([]);
  }, 30_000);
});
