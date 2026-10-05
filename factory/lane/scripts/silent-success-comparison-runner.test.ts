import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticSilentSuccessQualification } from "./silent-success-comparison-cohort.ts";
import {
  finalizeObservation,
  finalizeProtocol,
  parseSummary,
  type SilentSuccessObservation,
  type SilentSuccessProtocol,
} from "./silent-success-comparison-contract.ts";
import { evaluateSilentSuccessComparison } from "./silent-success-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const RUNNER = join(import.meta.dir, "silent-success-comparison-runner.ts");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function phaseD(): { protocol: SilentSuccessProtocol; observations: SilentSuccessObservation[] } {
  const synthetic = buildSyntheticSilentSuccessQualification(FIXTURE);
  const protocol = finalizeProtocol({ ...synthetic.protocol, evidence_class: "phase_d_observation" });
  const observations = synthetic.observations.map((entry) => finalizeObservation({
    ...entry,
    protocol_sha256: protocol.protocol_sha256,
  }));
  return { protocol, observations };
}

describe("silent-success receipt comparison runner", () => {
  test("supports receipt benefit only for complete eligible Phase D evidence", () => {
    const cohort = phaseD();
    const summary = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("RECEIPT_BENEFIT_SUPPORTED");
    expect(summary.complete_pairs).toBe(30);
    expect(summary.observations).toBe(90);
    expect(summary.receipt_comparisons.every((entry) => entry.incident_detection_delta_interval.lower > 0)).toBe(true);
    expect(summary.receipt_comparisons.every((entry) => entry.false_alarm_delta_interval.lower >= 0)).toBe(true);
    expect(summary.arm_metrics.find((entry) => entry.arm === "canonical_receipt")!.canonical_replay_rate).toBe(1);
    expect(parseSummary(summary)).toEqual(summary);
  });

  test("publishes complete null or negative Phase D outcomes", () => {
    const cohort = phaseD();
    const byArmAndPair = new Map(cohort.observations.map((entry) => [`${entry.arm}:${entry.incident_input_sha256}`, entry]));
    cohort.observations = cohort.observations.map((entry) => entry.arm === "canonical_receipt"
      ? finalizeObservation({
          ...entry,
          incident_detected: byArmAndPair.get(`tool_result:${entry.incident_input_sha256}`)!.incident_detected,
        })
      : entry);
    const summary = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.reasons).toContain("one or more preregistered Phase D receipt-benefit gates did not pass");
  });

  test("synthetic qualification is structurally benefit-ineligible", () => {
    const cohort = buildSyntheticSilentSuccessQualification(FIXTURE);
    const summary = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.reasons).toContain("synthetic qualification evidence is ineligible for a Phase D receipt-benefit claim");
  });

  test("requires separate operator review for an otherwise-supported overhead exception", () => {
    const cohort = phaseD();
    cohort.observations = cohort.observations.map((entry) => entry.arm === "canonical_receipt"
      ? finalizeObservation({ ...entry, latency_ms: entry.latency_ms * 1.2, cost_usd: entry.cost_usd * 1.2 })
      : entry);
    const summary = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    expect(summary.disposition).toBe("OPERATOR_REVIEW_REQUIRED");
    expect(summary.reasons).toContain("receipt overhead exceeds the preregistered 1.10 ceiling; no exception is inferred");
  });

  test("holds incomplete pairs, missing evidence, replay gaps, and redaction failures", () => {
    const incomplete = phaseD();
    const incompleteSummary = evaluateSilentSuccessComparison(incomplete.protocol, incomplete.observations.slice(0, 87));
    expect(incompleteSummary.disposition).toBe("HOLD");
    expect(parseSummary(incompleteSummary)).toEqual(incompleteSummary);

    const missingEvidence = phaseD();
    missingEvidence.observations[0] = finalizeObservation({ ...missingEvidence.observations[0]!, citations: [] });
    expect(evaluateSilentSuccessComparison(missingEvidence.protocol, missingEvidence.observations).reasons.some((entry) => entry.includes("lacks permitted"))).toBe(true);

    const replayGap = phaseD();
    const receiptIndex = replayGap.observations.findIndex((entry) => entry.arm === "canonical_receipt");
    replayGap.observations[receiptIndex] = finalizeObservation({ ...replayGap.observations[receiptIndex]!, canonical_replay_verified: false });
    expect(evaluateSilentSuccessComparison(replayGap.protocol, replayGap.observations).reasons.some((entry) => entry.includes("replay is incomplete"))).toBe(true);

    const redactionGap = phaseD();
    redactionGap.observations[0] = finalizeObservation({ ...redactionGap.observations[0]!, redaction_valid: false });
    expect(evaluateSilentSuccessComparison(redactionGap.protocol, redactionGap.observations).reasons.some((entry) => entry.includes("redaction validation failed"))).toBe(true);
  });

  test("holds boundary, contamination, timeout, duplicate, and resource violations", () => {
    const mutations: Array<[keyof SilentSuccessObservation, boolean | number, string]> = [
      ["boundary_valid", false, "boundary validation failed"],
      ["contamination_detected", true, "contamination detected"],
      ["compute_seconds", 61, "per-run timeout exceeded"],
    ];
    for (const [field, value, reason] of mutations) {
      const cohort = phaseD();
      cohort.observations[0] = finalizeObservation({ ...cohort.observations[0]!, [field]: value });
      const summary = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
      expect(summary.disposition).toBe("HOLD");
      expect(summary.reasons.some((entry) => entry.includes(reason))).toBe(true);
    }
    const duplicate = phaseD();
    expect(evaluateSilentSuccessComparison(duplicate.protocol, [...duplicate.observations, duplicate.observations[0]!]).reasons.some((entry) => entry.includes("duplicate observation cell"))).toBe(true);
    const overBudget = phaseD();
    overBudget.observations[0] = finalizeObservation({ ...overBudget.observations[0]!, token_count: 1 });
    expect(evaluateSilentSuccessComparison(overBudget.protocol, overBudget.observations).reasons).toContain("token budget exceeded");
  });

  test("produces byte-identical deterministic intervals and summaries", () => {
    const cohort = phaseD();
    const first = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    const second = evaluateSilentSuccessComparison(cohort.protocol, cohort.observations);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("CLI is silent and read-free unless enabled, then writes one exclusive summary", () => {
    const root = mkdtempSync(join(tmpdir(), "zou-1064-cli-"));
    roots.push(root);
    const off = Bun.spawnSync(["bun", RUNNER, "--protocol", join(root, "missing.json"), "--observations", join(root, "also-missing.json")], {
      env: { ...process.env, SF009_SILENT_SUCCESS_COMPARISON: "0" },
    });
    expect(off.exitCode).toBe(0);
    expect(off.stdout.toString()).toBe("");
    expect(off.stderr.toString()).toBe("");
    const cohort = phaseD();
    const protocolPath = join(root, "protocol.json");
    const observationsPath = join(root, "observations.json");
    const outputPath = join(root, "summary.json");
    writeFileSync(protocolPath, JSON.stringify(cohort.protocol));
    writeFileSync(observationsPath, JSON.stringify(cohort.observations));
    const on = Bun.spawnSync(["bun", RUNNER, "--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath], {
      env: { ...process.env, SF009_SILENT_SUCCESS_COMPARISON: "1" },
    });
    expect(on.exitCode).toBe(0);
    expect(on.stdout.toString()).toBe("");
    expect(JSON.parse(readFileSync(outputPath, "utf8")).disposition).toBe("RECEIPT_BENEFIT_SUPPORTED");
    const repeated = Bun.spawnSync(["bun", RUNNER, "--protocol", protocolPath, "--observations", observationsPath, "--output", outputPath], {
      env: { ...process.env, SF009_SILENT_SUCCESS_COMPARISON: "1" },
    });
    expect(repeated.exitCode).not.toBe(0);
  });
});
