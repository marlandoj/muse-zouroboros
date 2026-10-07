#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { resolveModelIdentity } from "./model-identity";

export interface CodingBenchmarkScore {
  mean: number;
  selectionFloor: number;
  standardDeviation: number;
}

export interface CodingBenchmarkEvidence {
  benchmark: "ZouroBench-Code";
  canonicalModel: string;
  family: string;
  cohortId: string;
  executor: string;
  folds: number;
  tasks: number;
  observedAt: string;
  contextFingerprint: string;
  sourceModelIds: string[];
  coder: CodingBenchmarkScore;
  shadowOnly: true;
}

export interface CodingEvidenceIndex {
  byCanonicalModel: Map<string, CodingBenchmarkEvidence>;
  summary: {
    policy: "shadow-five-fold-v1";
    shadowOnly: true;
    reachableFromProductionRanking: false;
    activeContextFingerprint: string | null;
    scannedFiles: number;
    parsedRuns: number;
    deduplicatedRuns: number;
    fixtureArtifacts: number;
    qualifiedCohorts: number;
    qualifiedModels: number;
    underpoweredCohorts: number;
    staleCohorts: number;
    incomparableCohorts: number;
    maxAgeDays: number;
  };
}

interface ParsedCodingRun {
  runId: string;
  modelId: string;
  canonicalModel: string;
  family: string;
  cohortId: string;
  executor: string;
  fold: number;
  foldSeed: number;
  observedAt: string;
  contextFingerprint: string;
  taskIds: string[];
  categories: string[];
  overall: number;
}

interface QualifiedCodingCohort {
  canonicalModel: string;
  family: string;
  cohortId: string;
  executor: string;
  observedAt: string;
  contextFingerprint: string;
  sourceModelIds: string[];
  coder: CodingBenchmarkScore;
}

// The ZouroBench harness is not vendored in the public package, so these
// monorepo defaults resolve to nothing; missing roots simply yield no
// evidence. Point ZOUROBENCH_CODE_EVIDENCE_PATHS at real run data to use this.
const DEFAULT_ROOTS = [
  "/home/workspace/packages/bench/data/runs/zourobench-code",
  "/home/workspace/packages/bench/data/staging/zourobench-code",
];
const CATEGORIES = ["bug-fix", "feature", "integration", "refactor", "test-creation"];
const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contextFingerprint(provenance: Record<string, unknown>): string | null {
  const harness = stringValue(provenance.harness_version);
  const corpus = stringValue(provenance.corpus_version);
  const manifest = stringValue(provenance.manifest_sha256);
  if (!harness || !corpus || !manifest) return null;
  return createHash("sha256").update(JSON.stringify({ harness, corpus, manifest, sandbox: "bubblewrap" })).digest("hex");
}

function parseRun(raw: unknown): ParsedCodingRun | "fixture" | null {
  if (!raw || typeof raw !== "object") return null;
  const artifact = raw as Record<string, any>;
  if (artifact.schema_version !== 1 || artifact.run?.benchmark !== "ZouroBench-Code" || artifact.run?.shadow_only !== true) return null;
  if (artifact.execution?.sandbox === "fixture") return "fixture";
  if (artifact.execution?.sandbox !== "bubblewrap") return null;
  const runId = stringValue(artifact.run?.run_id);
  const modelId = stringValue(artifact.execution?.model);
  const executor = stringValue(artifact.execution?.executor);
  const cohortId = stringValue(artifact.cohort?.cohort_id);
  const fold = numberValue(artifact.cohort?.fold_index);
  const foldSeed = numberValue(artifact.cohort?.fold_seed);
  const minimumFolds = numberValue(artifact.cohort?.minimum_folds);
  const observedAt = stringValue(artifact.run?.timestamp);
  const overall = numberValue(artifact.scores?.overall);
  const fingerprint = contextFingerprint(artifact.provenance ?? {});
  const tasks = Array.isArray(artifact.tasks) ? artifact.tasks : [];
  if (
    !runId || !modelId || !executor || !cohortId || fold === null || foldSeed === null ||
    minimumFolds !== 5 || !observedAt || overall === null || !fingerprint ||
    !Number.isInteger(fold) || fold < 1 || fold > 5 || overall < 0 || overall > 100 || tasks.length !== 4
  ) return null;
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return null;
  const taskIds = tasks.map((task: Record<string, unknown>) => stringValue(task.taskId));
  const categories = tasks.map((task: Record<string, unknown>) => stringValue(task.category));
  const taskScores = tasks.map((task: Record<string, any>) => numberValue(task.scores?.overall));
  const executorSucceeded = tasks.every((task: Record<string, unknown>) => task.executorSuccess === true);
  if (
    taskIds.some((id: string | null) => !id) || new Set(taskIds).size !== 4 ||
    categories.some((category: string | null) => !category || !CATEGORIES.includes(category)) ||
    taskScores.some((score: number | null) => score === null || score < 0 || score > 100) ||
    !executorSucceeded || artifact.totals?.tasks !== 4 || artifact.totals?.passed + artifact.totals?.failed !== 4
  ) return null;
  const recomputed = taskScores.reduce((sum: number, score: number | null) => sum + (score ?? 0), 0) / 4;
  if (Math.abs(recomputed - overall) > 0.0001) return null;
  const identity = resolveModelIdentity(modelId);
  return {
    runId,
    modelId,
    canonicalModel: identity.model,
    family: identity.family,
    cohortId,
    executor,
    fold,
    foldSeed,
    observedAt: new Date(timestamp).toISOString(),
    contextFingerprint: fingerprint,
    taskIds: taskIds as string[],
    categories: categories as string[],
    overall,
  };
}

function listArtifacts(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /^ZouroBench-Code-.*\.json$/.test(entry.name)) files.push(absolute);
    }
  }
  return files.sort();
}

function summarize(values: number[]): CodingBenchmarkScore {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  return {
    mean: Number(mean.toFixed(4)),
    selectionFloor: Number(Math.max(0, mean - 1.96 * standardDeviation / Math.sqrt(values.length)).toFixed(4)),
    standardDeviation: Number(standardDeviation.toFixed(4)),
  };
}

function qualify(runs: ParsedCodingRun[], nowMs: number, maxAgeDays: number): {
  cohorts: QualifiedCodingCohort[];
  underpowered: number;
  stale: number;
} {
  const groups = new Map<string, ParsedCodingRun[]>();
  for (const run of runs) {
    const key = `${run.canonicalModel}\u0000${run.cohortId}\u0000${run.executor}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const cohorts: QualifiedCodingCohort[] = [];
  let underpowered = 0;
  let stale = 0;
  for (const group of groups.values()) {
    const folds = new Set(group.map((run) => run.fold));
    const seeds = new Set(group.map((run) => run.foldSeed));
    const tasks = new Set(group.flatMap((run) => run.taskIds));
    const contexts = new Set(group.map((run) => run.contextFingerprint));
    const categoryCounts = new Map(CATEGORIES.map((category) => [category, 0]));
    for (const category of group.flatMap((run) => run.categories)) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    const complete = group.length === 5 && folds.size === 5 && seeds.size === 5 && tasks.size === 20
      && contexts.size === 1 && [...categoryCounts.values()].every((count) => count === 4);
    if (!complete) {
      underpowered++;
      continue;
    }
    const observedAt = group.map((run) => run.observedAt).sort().at(-1)!;
    if (nowMs - Date.parse(observedAt) > maxAgeDays * DAY_MS) {
      stale++;
      continue;
    }
    cohorts.push({
      canonicalModel: group[0]!.canonicalModel,
      family: group[0]!.family,
      cohortId: group[0]!.cohortId,
      executor: group[0]!.executor,
      observedAt,
      contextFingerprint: group[0]!.contextFingerprint,
      sourceModelIds: [...new Set(group.map((run) => run.modelId))].sort(),
      coder: summarize(group.map((run) => run.overall)),
    });
  }
  return { cohorts, underpowered, stale };
}

function selectContext(cohorts: QualifiedCodingCohort[]): string | null {
  const contexts = new Map<string, QualifiedCodingCohort[]>();
  for (const cohort of cohorts) contexts.set(cohort.contextFingerprint, [...(contexts.get(cohort.contextFingerprint) ?? []), cohort]);
  return [...contexts.entries()].sort((a, b) => {
    const modelDelta = new Set(b[1].map((item) => item.canonicalModel)).size - new Set(a[1].map((item) => item.canonicalModel)).size;
    if (modelDelta) return modelDelta;
    return Math.max(...b[1].map((item) => Date.parse(item.observedAt))) - Math.max(...a[1].map((item) => Date.parse(item.observedAt)));
  })[0]?.[0] ?? null;
}

export function loadZourobenchCodeEvidence(options: { roots?: string[]; now?: Date; maxAgeDays?: number } = {}): CodingEvidenceIndex {
  const roots = options.roots ?? (process.env.ZOUROBENCH_CODE_EVIDENCE_PATHS
    ? process.env.ZOUROBENCH_CODE_EVIDENCE_PATHS.split(path.delimiter).filter(Boolean)
    : DEFAULT_ROOTS);
  const configuredAge = options.maxAgeDays ?? Number(process.env.ZOUROBENCH_CODE_EVIDENCE_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS);
  const maxAgeDays = Number.isFinite(configuredAge) && configuredAge > 0 ? configuredAge : DEFAULT_MAX_AGE_DAYS;
  const files = [...new Set(roots.flatMap(listArtifacts))];
  const byRunId = new Map<string, ParsedCodingRun>();
  let parsedRuns = 0;
  let fixtureArtifacts = 0;
  for (const file of files) {
    try {
      const parsed = parseRun(JSON.parse(fs.readFileSync(file, "utf8")));
      if (parsed === "fixture") {
        fixtureArtifacts++;
      } else if (parsed) {
        parsedRuns++;
        byRunId.set(parsed.runId, parsed);
      }
    } catch {}
  }
  const qualified = qualify([...byRunId.values()], (options.now ?? new Date()).getTime(), maxAgeDays);
  const activeContextFingerprint = selectContext(qualified.cohorts);
  const comparable = qualified.cohorts.filter((cohort) => cohort.contextFingerprint === activeContextFingerprint);
  const byCanonicalModel = new Map<string, CodingBenchmarkEvidence>();
  for (const cohort of comparable.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))) {
    if (byCanonicalModel.has(cohort.canonicalModel)) continue;
    byCanonicalModel.set(cohort.canonicalModel, {
      benchmark: "ZouroBench-Code",
      canonicalModel: cohort.canonicalModel,
      family: cohort.family,
      cohortId: cohort.cohortId,
      executor: cohort.executor,
      folds: 5,
      tasks: 20,
      observedAt: cohort.observedAt,
      contextFingerprint: cohort.contextFingerprint,
      sourceModelIds: cohort.sourceModelIds,
      coder: cohort.coder,
      shadowOnly: true,
    });
  }
  return {
    byCanonicalModel,
    summary: {
      policy: "shadow-five-fold-v1",
      shadowOnly: true,
      reachableFromProductionRanking: false,
      activeContextFingerprint,
      scannedFiles: files.length,
      parsedRuns,
      deduplicatedRuns: byRunId.size,
      fixtureArtifacts,
      qualifiedCohorts: comparable.length,
      qualifiedModels: byCanonicalModel.size,
      underpoweredCohorts: qualified.underpowered,
      staleCohorts: qualified.stale,
      incomparableCohorts: qualified.cohorts.length - comparable.length,
      maxAgeDays,
    },
  };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      root: { type: "string", multiple: true },
      "max-age-days": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const maxAgeDays = values["max-age-days"] === undefined ? undefined : Number(values["max-age-days"]);
  if (maxAgeDays !== undefined && (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0)) throw new Error("--max-age-days must be positive");
  const evidence = loadZourobenchCodeEvidence({ roots: values.root, maxAgeDays });
  const output = { summary: evidence.summary, models: [...evidence.byCanonicalModel.values()] };
  console.log(values.json ? JSON.stringify(output, null, 2) : output);
}

if (import.meta.main) main();
