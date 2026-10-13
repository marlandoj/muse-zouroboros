/**
 * Replicate-distribution reporting for ZouroBench (P1-5).
 *
 * Pure functions only — no fs, no network, no import side effects. Given N≥1
 * run records, computes a 4-tuple distribution that replaces the single
 * best-of/mean headline number:
 *
 *   Solid    — % of question_ids correct in EVERY one of the N runs
 *   Average  — mean overall_accuracy across runs
 *   Best-of  — max overall_accuracy
 *   Ceiling  — % of question_ids correct in AT LEAST ONE run
 *
 * The Solid→Ceiling spread is the reliability headline: a wide spread means
 * the benchmark passes flakily and a single "best-of" number is cherry-picked.
 * Results need paired seeds and N≥5 by default before they are publishable.
 */

export const DEFAULT_MIN_REPLICATES = 5;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 2_000;

export interface ReplicateRunInput {
  scores?: { overall_accuracy?: number };
  replicate?: {
    seed?: string | number;
    cohort_id?: string;
    timeout_ms?: number;
    minimum_n?: number;
  };
  seed?: string | number;
  timeout_ms?: number;
  questions?: Array<{
    question_id?: string;
    correct?: boolean;
    truncated?: boolean;
    timed_out?: boolean;
    answer_ms?: number;
  }>;
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  confidence: 0.95;
  method: "deterministic-bootstrap";
  iterations: number;
}

export interface SeedPairing {
  paired: boolean;
  seeds: string[];
  reason?: string;
}

export interface PerQuestionReliability {
  question_id: string;
  /** Number of runs (of n) in which this question was present AND correct. */
  correctCount: number;
  n: number;
  /** Correct in ALL n runs. */
  solid: boolean;
  /** Correct in at least one run. */
  ceiling: boolean;
}

export interface ReplicateDistribution {
  n: number;
  minimumN: number;
  status: "publishable" | "underpowered";
  statusReasons: string[];
  pairing: SeedPairing;
  avgAccuracy: number;
  avgAccuracyCi?: ConfidenceInterval;
  bestOf: number;
  worst: number;
  /** Undefined when per-question data is not present in every run. */
  solidPct?: number;
  ceilingPct?: number;
  /** ceilingPct − solidPct, in percentage points. Undefined when not computable. */
  spread?: number;
  truncatedCount: number;
  timedOutCount: number;
  questionCount: number;
  truncatedRate: number;
  timedOutRate: number;
  perQuestion: PerQuestionReliability[];
}

export interface ReplicateDistributionOptions {
  minimumN?: number;
  bootstrapIterations?: number;
  bootstrapSeed?: string | number;
}

export interface PairedComparison {
  paired: boolean;
  n: number;
  seeds: string[];
  meanDelta: number | null;
  meanDeltaCi?: ConfidenceInterval;
  reason?: string;
}

export interface TimeoutSweepInput {
  timeoutMs: number;
  passed: number;
  attempts: number;
}

export interface TimeoutSweepPoint extends TimeoutSweepInput {
  passRate: number;
}

export interface TimeoutCalibration {
  status: "calibrated" | "insufficient_data";
  selectedTimeoutMs: number | null;
  kneeTimeoutMs: number | null;
  plateauTolerance: number;
  points: TimeoutSweepPoint[];
  reason?: string;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

function seedKey(run: ReplicateRunInput): string | undefined {
  const seed = run.replicate?.seed ?? run.seed;
  return seed == null ? undefined : String(seed);
}

function hashSeed(seed: string | number): number {
  const text = String(seed);
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function deterministicBootstrapMeanCi(
  values: number[],
  opts: { iterations?: number; seed?: string | number } = {},
): ConfidenceInterval | undefined {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return undefined;
  const iterations = Math.max(100, Math.floor(opts.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS));
  const random = mulberry32(hashSeed(opts.seed ?? "zouroboros-replicate-bootstrap-v1"));
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let i = 0; i < finite.length; i++) {
      sum += finite[Math.floor(random() * finite.length)]!;
    }
    means.push(sum / finite.length);
  }
  means.sort((a, b) => a - b);
  return {
    lower: round1(percentile(means, 0.025)),
    upper: round1(percentile(means, 0.975)),
    confidence: 0.95,
    method: "deterministic-bootstrap",
    iterations,
  };
}

/** Overall accuracy for a run: the stored value, else derived from questions. */
function runAccuracy(run: ReplicateRunInput): number | undefined {
  const direct = run.scores?.overall_accuracy;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const qs = run.questions;
  if (qs && qs.length > 0) {
    const correct = qs.filter((q) => q.correct === true).length;
    return round1((correct / qs.length) * 100);
  }
  return undefined;
}

export function computeReplicateDistribution(
  runs: ReplicateRunInput[],
  opts: ReplicateDistributionOptions = {},
): ReplicateDistribution {
  const n = runs.length;
  const minimumN = Math.max(1, Math.floor(opts.minimumN ?? DEFAULT_MIN_REPLICATES));

  const accuracies = runs
    .map(runAccuracy)
    .filter((a): a is number => a != null);
  const avgAccuracy = accuracies.length > 0
    ? round1(accuracies.reduce((a, b) => a + b, 0) / accuracies.length)
    : 0;
  const bestOf = accuracies.length > 0 ? Math.max(...accuracies) : 0;
  const worst = accuracies.length > 0 ? Math.min(...accuracies) : 0;
  const avgAccuracyCi = deterministicBootstrapMeanCi(accuracies, {
    iterations: opts.bootstrapIterations,
    seed: opts.bootstrapSeed,
  });

  const seeds = runs.map(seedKey).filter((seed): seed is string => seed !== undefined);
  const uniqueSeeds = new Set(seeds);
  let pairing: SeedPairing;
  if (seeds.length !== n) {
    pairing = { paired: false, seeds, reason: `${n - seeds.length} run(s) missing replicate seed` };
  } else if (uniqueSeeds.size !== seeds.length) {
    pairing = { paired: false, seeds, reason: "replicate seeds must be unique within a cohort" };
  } else {
    pairing = { paired: n > 0, seeds };
  }

  let truncatedCount = 0;
  let timedOutCount = 0;
  let questionCount = 0;
  for (const run of runs) {
    for (const q of run.questions ?? []) {
      questionCount++;
      if (q.truncated === true) truncatedCount++;
      if (q.timed_out === true) timedOutCount++;
    }
  }

  const statusReasons: string[] = [];
  if (n < minimumN) statusReasons.push(`N=${n} is below minimum N=${minimumN}`);
  if (accuracies.length < minimumN) {
    statusReasons.push(`only ${accuracies.length} run(s) contain a finite accuracy`);
  }
  if (!pairing.paired) statusReasons.push(pairing.reason ?? "replicate seeds are not pairable");
  const status = statusReasons.length === 0 ? "publishable" : "underpowered";

  // Per-question reliability requires question data in EVERY run — otherwise
  // "correct in all n runs" cannot be answered honestly.
  const allHaveQuestions =
    n > 0 && runs.every((r) => Array.isArray(r.questions) && r.questions.length > 0);

  let solidPct: number | undefined;
  let ceilingPct: number | undefined;
  let spread: number | undefined;
  const perQuestion: PerQuestionReliability[] = [];

  if (allHaveQuestions) {
    const qids = new Set<string>();
    for (const run of runs) {
      for (const q of run.questions!) {
        if (q.question_id) qids.add(q.question_id);
      }
    }

    const lookups = runs.map((run) => {
      const m = new Map<string, boolean>();
      for (const q of run.questions!) {
        if (q.question_id) m.set(q.question_id, q.correct === true);
      }
      return m;
    });

    let solidCount = 0;
    let ceilingCount = 0;
    for (const qid of qids) {
      let correctCount = 0;
      for (const lu of lookups) {
        if (lu.get(qid) === true) correctCount++;
      }
      const solid = correctCount === n;
      const ceiling = correctCount >= 1;
      if (solid) solidCount++;
      if (ceiling) ceilingCount++;
      perQuestion.push({ question_id: qid, correctCount, n, solid, ceiling });
    }
    perQuestion.sort((a, b) => a.question_id.localeCompare(b.question_id));

    const denom = qids.size;
    if (denom > 0) {
      solidPct = round1((solidCount / denom) * 100);
      ceilingPct = round1((ceilingCount / denom) * 100);
      spread = round1(ceilingPct - solidPct);
    }
  }

  return {
    n,
    minimumN,
    status,
    statusReasons,
    pairing,
    avgAccuracy,
    avgAccuracyCi,
    bestOf,
    worst,
    solidPct,
    ceilingPct,
    spread,
    truncatedCount,
    timedOutCount,
    questionCount,
    truncatedRate: questionCount > 0 ? round4(truncatedCount / questionCount) : 0,
    timedOutRate: questionCount > 0 ? round4(timedOutCount / questionCount) : 0,
    perQuestion,
  };
}

export function comparePairedReplicates(
  baseline: ReplicateRunInput[],
  candidate: ReplicateRunInput[],
  opts: { bootstrapIterations?: number; bootstrapSeed?: string | number } = {},
): PairedComparison {
  const baselineBySeed = new Map<string, number>();
  const candidateBySeed = new Map<string, number>();
  for (const run of baseline) {
    const seed = seedKey(run);
    const accuracy = runAccuracy(run);
    if (seed !== undefined && accuracy !== undefined && !baselineBySeed.has(seed)) baselineBySeed.set(seed, accuracy);
  }
  for (const run of candidate) {
    const seed = seedKey(run);
    const accuracy = runAccuracy(run);
    if (seed !== undefined && accuracy !== undefined && !candidateBySeed.has(seed)) candidateBySeed.set(seed, accuracy);
  }
  const baselineSeeds = [...baselineBySeed.keys()].sort();
  const candidateSeeds = [...candidateBySeed.keys()].sort();
  if (
    baselineSeeds.length !== baseline.length ||
    candidateSeeds.length !== candidate.length ||
    baselineSeeds.length !== candidateSeeds.length ||
    baselineSeeds.some((seed, index) => seed !== candidateSeeds[index])
  ) {
    return {
      paired: false,
      n: 0,
      seeds: [],
      meanDelta: null,
      reason: "baseline and candidate must contain the same unique, non-missing replicate seeds",
    };
  }
  const deltas = baselineSeeds.map((seed) => candidateBySeed.get(seed)! - baselineBySeed.get(seed)!);
  const meanDelta = deltas.length > 0 ? round1(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  return {
    paired: deltas.length > 0,
    n: deltas.length,
    seeds: baselineSeeds,
    meanDelta,
    meanDeltaCi: deterministicBootstrapMeanCi(deltas, {
      iterations: opts.bootstrapIterations,
      seed: opts.bootstrapSeed ?? "zouroboros-paired-delta-bootstrap-v1",
    }),
    ...(deltas.length === 0 ? { reason: "no paired runs" } : {}),
  };
}

export function calibrateTimeoutSweep(
  inputs: TimeoutSweepInput[],
  opts: { plateauTolerance?: number; minimumAttempts?: number } = {},
): TimeoutCalibration {
  const plateauTolerance = opts.plateauTolerance ?? 0.01;
  const minimumAttempts = Math.max(1, Math.floor(opts.minimumAttempts ?? 1));
  const byTimeout = new Map<number, { passed: number; attempts: number }>();
  for (const input of inputs) {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.attempts <= 0) continue;
    const timeoutMs = Math.round(input.timeoutMs);
    const current = byTimeout.get(timeoutMs) ?? { passed: 0, attempts: 0 };
    current.passed += Math.max(0, Math.min(input.attempts, input.passed));
    current.attempts += input.attempts;
    byTimeout.set(timeoutMs, current);
  }
  const points = [...byTimeout.entries()]
    .filter(([, value]) => value.attempts >= minimumAttempts)
    .sort(([a], [b]) => a - b)
    .map(([timeoutMs, value]) => ({
      timeoutMs,
      passed: value.passed,
      attempts: value.attempts,
      passRate: round4(value.passed / value.attempts),
    }));
  if (points.length < 2) {
    return {
      status: "insufficient_data",
      selectedTimeoutMs: null,
      kneeTimeoutMs: null,
      plateauTolerance,
      points,
      reason: "timeout calibration requires at least two timeout levels",
    };
  }
  const maxPassRate = Math.max(...points.map((point) => point.passRate));
  const target = maxPassRate - plateauTolerance;
  const knee = points.find(
    (point, index) => point.passRate >= target && points.slice(index).every((later) => later.passRate >= target),
  ) ?? points[points.length - 1]!;
  return {
    status: "calibrated",
    kneeTimeoutMs: knee.timeoutMs,
    selectedTimeoutMs: knee.timeoutMs,
    plateauTolerance,
    points,
  };
}
