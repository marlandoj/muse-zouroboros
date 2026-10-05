import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBenchmarkSloIntake,
  tickBenchmarkSloIntake,
} from "./benchmark-slo-intake";

const sandboxes: string[] = [];

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "benchmark-slo-intake-"));
  sandboxes.push(path);
  return path;
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeRun(
  directory: string,
  name: string,
  opts: {
    timestamp: string;
    cohort: string;
    seed: string;
    timeoutMs: number;
    accuracy: number;
    timedOut?: boolean;
    truncated?: boolean;
  },
): void {
  writeFileSync(join(directory, name), JSON.stringify({
    benchmark: "ZouroBench",
    timestamp: opts.timestamp,
    dataset: "fixture.json",
    total_questions: 2,
    scores: { overall_accuracy: opts.accuracy },
    latency: { avg_retrieval_ms: 1, avg_answer_ms: 2, p95_retrieval_ms: 1 },
    replicate: {
      seed: opts.seed,
      cohort_id: opts.cohort,
      timeout_ms: opts.timeoutMs,
      minimum_n: 5,
    },
    questions: [
      { question_id: "q1", correct: true },
      {
        question_id: "q2",
        correct: !opts.timedOut,
        timed_out: opts.timedOut || undefined,
        truncated: opts.truncated || undefined,
      },
    ],
  }));
}

describe("benchmark SLO intake", () => {
  test("consumes real run files and selects latest publishable cohort", () => {
    const directory = sandbox();
    for (let index = 1; index <= 5; index++) {
      writeRun(directory, `old-${index}.json`, {
        timestamp: `2026-07-10T00:00:0${index}.000Z`,
        cohort: "old",
        seed: String(index),
        timeoutMs: 10_000,
        accuracy: 80,
        timedOut: index === 1,
      });
      writeRun(directory, `new-${index}.json`, {
        timestamp: `2026-07-11T00:00:0${index}.000Z`,
        cohort: "new",
        seed: String(index),
        timeoutMs: 20_000,
        accuracy: 90,
        truncated: index === 1,
      });
    }
    writeFileSync(join(directory, "foreign.json"), JSON.stringify({ kind: "compression" }));
    writeFileSync(join(directory, "broken.json"), "{");

    const report = loadBenchmarkSloIntake(directory, "2026-07-11T01:00:00.000Z");
    expect(report.files_scanned).toBe(12);
    expect(report.files_consumed).toBe(10);
    expect(report.ignored_files).toEqual(["foreign.json"]);
    expect(report.invalid_files).toHaveLength(1);
    const intake = report.benchmarks[0]!;
    expect(intake.cohort_id).toBe("new");
    expect(intake.source_files).toHaveLength(5);
    expect(intake.distribution.status).toBe("publishable");
    expect(intake.distribution.n).toBe(5);
    expect(intake.reliability_spread_points).toBe(0);
    expect(intake.truncation_rate).toBe(0.1);
    expect(intake.timeout_rate).toBe(0);
    expect(intake.timeout_calibration_source).toBe("configured-sweep");
    expect(intake.timeout_calibration.status).toBe("calibrated");
    expect(intake.timeout_calibration.selectedTimeoutMs).toBe(20_000);
  });

  test("legacy files remain mechanically underpowered without paired seed metadata", () => {
    const directory = sandbox();
    for (let index = 1; index <= 5; index++) {
      writeFileSync(join(directory, `legacy-${index}.json`), JSON.stringify({
        benchmark: "ZouroBench",
        timestamp: `2026-07-01T00:00:0${index}.000Z`,
        scores: { overall_accuracy: 90 },
        questions: [{ question_id: "q1", correct: true }],
      }));
    }
    const intake = loadBenchmarkSloIntake(directory).benchmarks[0]!;
    expect(intake.distribution.n).toBe(5);
    expect(intake.distribution.status).toBe("underpowered");
    expect(intake.distribution.pairing.paired).toBe(false);
  });

  test("tick persists the schema-versioned intake artifact", () => {
    const directory = sandbox();
    const statePath = join(directory, "state", "benchmark-slo-intake.json");
    for (let index = 1; index <= 5; index++) {
      writeRun(directory, `run-${index}.json`, {
        timestamp: `2026-07-11T00:00:0${index}.000Z`,
        cohort: "tick",
        seed: String(index),
        timeoutMs: 20_000,
        accuracy: 95,
      });
    }
    const report = tickBenchmarkSloIntake(
      { runsDir: directory, statePath },
      "2026-07-11T01:00:00.000Z",
    );
    const persisted = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(persisted).toEqual(report);
    expect(persisted.schema_version).toBe(1);
    expect(persisted.benchmarks[0].distribution.status).toBe("publishable");
  });

  test("replays recorded answer durations when explicit timeout levels are absent", () => {
    const directory = sandbox();
    for (let index = 1; index <= 5; index++) {
      writeFileSync(join(directory, `duration-${index}.json`), JSON.stringify({
        benchmark: "ZouroBench",
        timestamp: `2026-07-11T00:00:0${index}.000Z`,
        scores: { overall_accuracy: 90 },
        replicate: { seed: String(index), cohort_id: "durations", minimum_n: 5, timeout_ms: 0 },
        questions: [
          { question_id: "q1", correct: true, answer_ms: index * 500 },
          { question_id: "q2", correct: true, answer_ms: index * 1_000 },
        ],
      }));
    }
    const intake = loadBenchmarkSloIntake(directory).benchmarks[0]!;
    expect(intake.timeout_calibration_source).toBe("duration-replay");
    expect(intake.timeout_calibration.status).toBe("calibrated");
    expect(intake.timeout_calibration.selectedTimeoutMs).toBe(5_000);
  });
});
