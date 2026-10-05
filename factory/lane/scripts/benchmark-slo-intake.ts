#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  calibrateTimeoutSweep,
  computeReplicateDistribution,
  type ReplicateDistribution,
  type ReplicateRunInput,
  type TimeoutCalibration,
  type TimeoutSweepInput,
} from "../../../packages/bench/scripts/replicate-distribution";

interface BenchmarkRunFile extends ReplicateRunInput {
  benchmark: string;
  timestamp: string;
  dataset?: string;
  total_questions?: number;
  latency?: Record<string, unknown>;
  replicate?: ReplicateRunInput["replicate"];
}

export interface BenchmarkReliabilityIntake {
  benchmark: string;
  cohort_id: string | null;
  source_files: string[];
  distribution: ReplicateDistribution;
  reliability_spread_points: number | null;
  truncation_rate: number;
  timeout_rate: number;
  timeout_calibration_source: "configured-sweep" | "duration-replay" | "none";
  timeout_calibration: TimeoutCalibration;
}

export interface BenchmarkSloIntakeReport {
  schema_version: 1;
  run_directory: string;
  generated_at: string;
  files_scanned: number;
  files_consumed: number;
  ignored_files: string[];
  invalid_files: Array<{ file: string; error: string }>;
  benchmarks: BenchmarkReliabilityIntake[];
}

export interface BenchmarkSloPaths {
  runsDir: string;
  statePath: string;
}

const PROJECT_DIR = join(import.meta.dir, "..");

export function defaultBenchmarkSloPaths(): BenchmarkSloPaths {
  return {
    runsDir: join(PROJECT_DIR, "..", "..", "packages", "bench", "data", "runs"),
    statePath: factoryStatePath("benchmark-slo-intake.json"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBenchmarkRun(value: unknown): value is BenchmarkRunFile {
  if (!isRecord(value)) return false;
  if (typeof value.benchmark !== "string" || typeof value.timestamp !== "string") return false;
  if (!isRecord(value.scores)) return false;
  const accuracy = value.scores.overall_accuracy;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy)) return false;
  if (value.questions !== undefined && !Array.isArray(value.questions)) return false;
  return true;
}

function latestCohort(runs: BenchmarkRunFile[]): string | null {
  const latest = runs
    .filter((run) => run.replicate?.cohort_id)
    .slice()
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  return latest?.replicate?.cohort_id ?? null;
}

function timeoutInputs(runs: BenchmarkRunFile[]): {
  source: "configured-sweep" | "duration-replay" | "none";
  inputs: TimeoutSweepInput[];
} {
  const inputs: TimeoutSweepInput[] = [];
  for (const run of runs) {
    const timeoutMs = run.replicate?.timeout_ms ?? run.timeout_ms;
    if (typeof timeoutMs !== "number" || timeoutMs <= 0) continue;
    const questions = run.questions ?? [];
    if (questions.length === 0) continue;
    inputs.push({
      timeoutMs,
      attempts: questions.length,
      passed: questions.filter((question) => question.timed_out !== true).length,
    });
  }
  if (new Set(inputs.map((input) => input.timeoutMs)).size >= 2) {
    return { source: "configured-sweep", inputs };
  }

  const questions = runs.flatMap((run) => run.questions ?? []);
  const censored = questions.some((question) => question.timed_out === true);
  const durations = questions
    .map((question) => question.answer_ms)
    .filter((duration): duration is number => typeof duration === "number" && Number.isFinite(duration) && duration >= 0);
  if (censored || durations.length === 0) return { source: "none", inputs };
  const standardTimeouts = [1_000, 2_000, 5_000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000];
  const maxDuration = Math.max(...durations);
  const ceiling = Math.ceil(maxDuration / 5_000) * 5_000;
  const thresholds = [...new Set([...standardTimeouts, ceiling])].filter((timeout) => timeout > 0).sort((a, b) => a - b);
  return {
    source: "duration-replay",
    inputs: thresholds.map((timeoutMs) => ({
      timeoutMs,
      attempts: durations.length,
      passed: durations.filter((duration) => duration <= timeoutMs).length,
    })),
  };
}

export function computeBenchmarkSloIntake(
  runDirectory: string,
  files: Array<{ file: string; run: BenchmarkRunFile }>,
  invalidFiles: Array<{ file: string; error: string }> = [],
  ignoredFiles: string[] = [],
  nowIso = new Date().toISOString(),
): BenchmarkSloIntakeReport {
  const groups = new Map<string, Array<{ file: string; run: BenchmarkRunFile }>>();
  for (const entry of files) {
    const group = groups.get(entry.run.benchmark) ?? [];
    group.push(entry);
    groups.set(entry.run.benchmark, group);
  }

  const benchmarks: BenchmarkReliabilityIntake[] = [];
  for (const benchmark of [...groups.keys()].sort()) {
    const entries = groups.get(benchmark)!;
    const allRuns = entries.map((entry) => entry.run);
    const cohortId = latestCohort(allRuns);
    const selected = cohortId
      ? entries.filter((entry) => entry.run.replicate?.cohort_id === cohortId)
      : entries;
    const minimumN = selected[0]?.run.replicate?.minimum_n;
    const distribution = computeReplicateDistribution(
      selected.map((entry) => entry.run),
      { minimumN, bootstrapSeed: `${benchmark}:${cohortId ?? "legacy"}` },
    );
    const timeoutSweep = timeoutInputs(allRuns);
    benchmarks.push({
      benchmark,
      cohort_id: cohortId,
      source_files: selected.map((entry) => entry.file).sort(),
      distribution,
      reliability_spread_points: distribution.spread ?? null,
      truncation_rate: distribution.truncatedRate,
      timeout_rate: distribution.timedOutRate,
      timeout_calibration_source: timeoutSweep.source,
      timeout_calibration: calibrateTimeoutSweep(timeoutSweep.inputs),
    });
  }

  return {
    schema_version: 1,
    run_directory: runDirectory,
    generated_at: nowIso,
    files_scanned: files.length + invalidFiles.length + ignoredFiles.length,
    files_consumed: files.length,
    ignored_files: ignoredFiles.slice().sort(),
    invalid_files: invalidFiles.slice().sort((a, b) => a.file.localeCompare(b.file)),
    benchmarks,
  };
}

export function loadBenchmarkSloIntake(
  runDirectory: string,
  nowIso = new Date().toISOString(),
): BenchmarkSloIntakeReport {
  if (!existsSync(runDirectory)) throw new Error(`benchmark run directory not found: ${runDirectory}`);
  const names = readdirSync(runDirectory).filter((name) => name.endsWith(".json")).sort();
  const files: Array<{ file: string; run: BenchmarkRunFile }> = [];
  const invalidFiles: Array<{ file: string; error: string }> = [];
  const ignoredFiles: string[] = [];
  for (const name of names) {
    const path = join(runDirectory, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      invalidFiles.push({ file: name, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!isBenchmarkRun(parsed)) {
      ignoredFiles.push(name);
      continue;
    }
    files.push({ file: name, run: parsed });
  }
  return computeBenchmarkSloIntake(runDirectory, files, invalidFiles, ignoredFiles, nowIso);
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  renameSync(temp, path);
}

export function tickBenchmarkSloIntake(
  paths: BenchmarkSloPaths = defaultBenchmarkSloPaths(),
  nowIso = new Date().toISOString(),
): BenchmarkSloIntakeReport {
  const report = loadBenchmarkSloIntake(paths.runsDir, nowIso);
  writeAtomic(paths.statePath, report);
  return report;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      runs: { type: "string" },
      state: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (command !== "status" && command !== "tick") {
    console.error("usage: benchmark-slo-intake.ts <status|tick> [--runs <dir>] [--state <file>] [--json]");
    process.exit(2);
  }
  try {
    const defaults = defaultBenchmarkSloPaths();
    const paths = {
      runsDir: values.runs ?? defaults.runsDir,
      statePath: values.state ?? defaults.statePath,
    };
    const report = command === "tick"
      ? tickBenchmarkSloIntake(paths)
      : loadBenchmarkSloIntake(paths.runsDir);
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const benchmark of report.benchmarks) {
        const calibration = benchmark.timeout_calibration;
        console.log(
          `${benchmark.benchmark}: ${benchmark.distribution.status} ` +
          `(N=${benchmark.distribution.n}/${benchmark.distribution.minimumN}, ` +
          `spread=${benchmark.reliability_spread_points ?? "n/a"}pt, ` +
          `truncated=${(benchmark.truncation_rate * 100).toFixed(2)}%, ` +
          `timed_out=${(benchmark.timeout_rate * 100).toFixed(2)}%, ` +
          `timeout=${calibration.selectedTimeoutMs ?? "uncalibrated"}, ` +
          `timeout_source=${benchmark.timeout_calibration_source})`,
        );
      }
      console.log(`consumed ${report.files_consumed}/${report.files_scanned} JSON run files`);
      if (command === "tick") console.log(`state: ${paths.statePath}`);
    }
  } catch (error) {
    console.error(`benchmark-slo-intake: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
