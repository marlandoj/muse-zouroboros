#!/usr/bin/env bun

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { parseArgs } from "util";
import { resolveModelIdentity } from "./model-identity";

export type BenchmarkLineupRole = "proposer" | "aggregator" | "coder";

export interface RoleBenchmarkScore {
  mean: number;
  selectionFloor: number;
  standardDeviation: number;
}

export interface ModelBenchmarkEvidence {
  benchmark: "ZouroBench";
  canonicalModel: string;
  family: string;
  cohortId: string;
  replicates: number;
  requiredReplicates: number;
  observedAt: string;
  contextFingerprint: string;
  sourceModelIds: string[];
  overall: RoleBenchmarkScore;
  roles: Partial<Record<BenchmarkLineupRole, RoleBenchmarkScore>>;
}

export interface BenchmarkEvidenceSummary {
  policy: "prefer-qualified-v1";
  activeContextFingerprint: string | null;
  scannedFiles: number;
  parsedRuns: number;
  deduplicatedRuns: number;
  qualifiedCohorts: number;
  qualifiedModels: number;
  underpoweredCohorts: number;
  staleCohorts: number;
  incomparableCohorts: number;
  unsupportedRoles: BenchmarkLineupRole[];
  maxAgeDays: number;
}

export interface BenchmarkEvidenceIndex {
  byCanonicalModel: Map<string, ModelBenchmarkEvidence>;
  summary: BenchmarkEvidenceSummary;
}

interface EvidencedValue<T> {
  value?: T | null;
}

interface RunArtifact {
  schema_version?: unknown;
  run?: {
    run_id?: unknown;
    benchmark?: unknown;
    timestamp?: unknown;
  };
  cohort?: {
    cohort_id?: unknown;
    replicate_index?: unknown;
    replicate_seed?: unknown;
    minimum_n?: unknown;
  };
  provenance?: {
    adapter_version?: unknown;
    dataset_sha256?: unknown;
    question_set_sha256?: unknown;
  };
  execution?: {
    answer_model?: unknown;
    judge_model?: EvidencedValue<unknown>;
    embedding_model?: EvidencedValue<unknown>;
    truncation_guard_enabled?: unknown;
    generation_timeout_ms?: EvidencedValue<unknown>;
    max_tokens?: unknown;
  };
  totals?: {
    total_questions?: unknown;
    answered?: unknown;
  };
  scores?: {
    overall_accuracy?: unknown;
    by_category?: Record<string, { accuracy?: unknown }>;
  };
}

interface ParsedRun {
  runId: string;
  modelId: string;
  canonicalModel: string;
  family: string;
  cohortId: string;
  replicateIndex: number;
  replicateSeed: string;
  minimumN: number;
  observedAt: string;
  contextFingerprint: string;
  overall: number;
  proposer: number | null;
  aggregator: number | null;
}

interface QualifiedCohort {
  canonicalModel: string;
  family: string;
  cohortId: string;
  minimumN: number;
  replicates: number;
  observedAt: string;
  contextFingerprint: string;
  sourceModelIds: string[];
  overall: RoleBenchmarkScore;
  roles: Partial<Record<BenchmarkLineupRole, RoleBenchmarkScore>>;
}

// The ZouroBench harness is not vendored in the public package, so these
// monorepo defaults resolve to nothing; missing paths simply yield no
// evidence. Point ZOUROBENCH_EVIDENCE_PATHS at real run data to use this.
const DEFAULT_RESULTS_PATHS = [
  "/home/workspace/packages/bench/data/runs",
  "/home/workspace/packages/bench/data/staging",
];
const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evidencedString(value: EvidencedValue<unknown> | undefined): string | null {
  return nonEmptyString(value?.value);
}

function roleAccuracy(
  categories: Record<string, { accuracy?: unknown }> | undefined,
  names: string[],
): number | null {
  if (!categories) return null;
  const values = names.map((name) => finiteNumber(categories[name]?.accuracy));
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0) / values.length;
}

function benchmarkContextFingerprint(artifact: RunArtifact): string | null {
  const datasetSha = nonEmptyString(artifact.provenance?.dataset_sha256);
  const questionSetSha = nonEmptyString(artifact.provenance?.question_set_sha256);
  const adapterVersion = nonEmptyString(artifact.provenance?.adapter_version);
  const judgeModel = evidencedString(artifact.execution?.judge_model);
  const embeddingModel = evidencedString(artifact.execution?.embedding_model);
  const maxTokens = finiteNumber(artifact.execution?.max_tokens);
  const truncationGuard = artifact.execution?.truncation_guard_enabled;
  if (
    !datasetSha || !questionSetSha || !adapterVersion || !judgeModel || !embeddingModel ||
    maxTokens === null || typeof truncationGuard !== "boolean"
  ) return null;
  return createHash("sha256").update(JSON.stringify({
    datasetSha,
    questionSetSha,
    adapterVersion,
    judgeModel,
    embeddingModel,
    maxTokens,
    truncationGuard,
  })).digest("hex");
}

function parseRunArtifact(raw: unknown): ParsedRun | null {
  if (!raw || typeof raw !== "object") return null;
  const artifact = raw as RunArtifact;
  if (artifact.schema_version !== 2 || artifact.run?.benchmark !== "ZouroBench") return null;
  const runId = nonEmptyString(artifact.run.run_id);
  const observedAt = nonEmptyString(artifact.run.timestamp);
  const modelId = nonEmptyString(artifact.execution?.answer_model);
  const cohortId = nonEmptyString(artifact.cohort?.cohort_id);
  const replicateIndex = finiteNumber(artifact.cohort?.replicate_index);
  const minimumN = finiteNumber(artifact.cohort?.minimum_n);
  const overall = finiteNumber(artifact.scores?.overall_accuracy);
  const contextFingerprint = benchmarkContextFingerprint(artifact);
  const totalQuestions = finiteNumber(artifact.totals?.total_questions);
  const answered = finiteNumber(artifact.totals?.answered);
  if (
    !runId || !observedAt || !modelId || !cohortId || replicateIndex === null ||
    minimumN === null || overall === null || !contextFingerprint ||
    totalQuestions === null || answered === null || totalQuestions <= 0 || answered !== totalQuestions
  ) return null;
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp) || replicateIndex < 1 || minimumN < 1 || overall < 0 || overall > 100) return null;
  const identity = resolveModelIdentity(modelId);
  return {
    runId,
    modelId,
    canonicalModel: identity.model,
    family: identity.family,
    cohortId,
    replicateIndex,
    replicateSeed: String(artifact.cohort?.replicate_seed ?? ""),
    minimumN,
    observedAt: new Date(timestamp).toISOString(),
    contextFingerprint,
    overall,
    proposer: roleAccuracy(artifact.scores?.by_category, [
      "procedural-recall",
      "cross-persona-transfer",
      "swarm-context-propagation",
    ]),
    aggregator: roleAccuracy(artifact.scores?.by_category, [
      "cross-persona-transfer",
      "swarm-context-propagation",
    ]),
  };
}

function listJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /^ZouroBench-.*\.json$/.test(entry.name)) files.push(absolute);
    }
  }
  return files.sort();
}

function summarize(values: number[]): RoleBenchmarkScore {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const selectionFloor = Math.max(0, mean - 1.96 * standardDeviation / Math.sqrt(values.length));
  return {
    mean: Number(mean.toFixed(4)),
    selectionFloor: Number(selectionFloor.toFixed(4)),
    standardDeviation: Number(standardDeviation.toFixed(4)),
  };
}

function qualifyCohorts(runs: ParsedRun[], nowMs: number, maxAgeDays: number): {
  qualified: QualifiedCohort[];
  underpowered: number;
  stale: number;
} {
  const groups = new Map<string, ParsedRun[]>();
  for (const run of runs) {
    const key = `${run.canonicalModel}\u0000${run.cohortId}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const qualified: QualifiedCohort[] = [];
  let underpowered = 0;
  let stale = 0;
  for (const cohortRuns of groups.values()) {
    const minimumN = Math.max(...cohortRuns.map((run) => run.minimumN));
    const uniqueIndexes = new Set(cohortRuns.map((run) => run.replicateIndex));
    const uniqueSeeds = new Set(cohortRuns.map((run) => run.replicateSeed));
    const contexts = new Set(cohortRuns.map((run) => run.contextFingerprint));
    const models = new Set(cohortRuns.map((run) => run.canonicalModel));
    if (
      cohortRuns.length < minimumN || uniqueIndexes.size < minimumN ||
      uniqueSeeds.size < minimumN || contexts.size !== 1 || models.size !== 1
    ) {
      underpowered++;
      continue;
    }
    const observedAt = cohortRuns.map((run) => run.observedAt).sort().at(-1)!;
    if (nowMs - Date.parse(observedAt) > maxAgeDays * DAY_MS) {
      stale++;
      continue;
    }
    const proposerValues = cohortRuns.map((run) => run.proposer);
    const aggregatorValues = cohortRuns.map((run) => run.aggregator);
    const roles: Partial<Record<BenchmarkLineupRole, RoleBenchmarkScore>> = {};
    if (proposerValues.every((value): value is number => value !== null)) roles.proposer = summarize(proposerValues);
    if (aggregatorValues.every((value): value is number => value !== null)) roles.aggregator = summarize(aggregatorValues);
    qualified.push({
      canonicalModel: cohortRuns[0]!.canonicalModel,
      family: cohortRuns[0]!.family,
      cohortId: cohortRuns[0]!.cohortId,
      minimumN,
      replicates: cohortRuns.length,
      observedAt,
      contextFingerprint: cohortRuns[0]!.contextFingerprint,
      sourceModelIds: [...new Set(cohortRuns.map((run) => run.modelId))].sort(),
      overall: summarize(cohortRuns.map((run) => run.overall)),
      roles,
    });
  }
  return { qualified, underpowered, stale };
}

function selectComparableContext(cohorts: QualifiedCohort[]): string | null {
  const groups = new Map<string, QualifiedCohort[]>();
  for (const cohort of cohorts) {
    const group = groups.get(cohort.contextFingerprint) ?? [];
    group.push(cohort);
    groups.set(cohort.contextFingerprint, group);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      const modelDelta = new Set(b[1].map((item) => item.canonicalModel)).size
        - new Set(a[1].map((item) => item.canonicalModel)).size;
      if (modelDelta) return modelDelta;
      const aNewest = Math.max(...a[1].map((item) => Date.parse(item.observedAt)));
      const bNewest = Math.max(...b[1].map((item) => Date.parse(item.observedAt)));
      return bNewest - aNewest || a[0].localeCompare(b[0]);
    })[0]?.[0] ?? null;
}

export function loadZourobenchEvidence(options: {
  roots?: string[];
  now?: Date;
  maxAgeDays?: number;
} = {}): BenchmarkEvidenceIndex {
  const roots = options.roots ?? (process.env.ZOUROBENCH_EVIDENCE_PATHS
    ? process.env.ZOUROBENCH_EVIDENCE_PATHS.split(path.delimiter).filter(Boolean)
    : DEFAULT_RESULTS_PATHS);
  const configuredMaxAgeDays = options.maxAgeDays ?? Number(process.env.ZOUROBENCH_EVIDENCE_MAX_AGE_DAYS || DEFAULT_MAX_AGE_DAYS);
  const maxAgeDays = Number.isFinite(configuredMaxAgeDays) && configuredMaxAgeDays > 0
    ? configuredMaxAgeDays
    : DEFAULT_MAX_AGE_DAYS;
  const nowMs = (options.now ?? new Date()).getTime();
  const files = [...new Set(roots.flatMap(listJsonFiles))];
  const byRunId = new Map<string, ParsedRun>();
  let parsedRuns = 0;
  for (const file of files) {
    try {
      const parsed = parseRunArtifact(JSON.parse(fs.readFileSync(file, "utf-8")));
      if (!parsed) continue;
      parsedRuns++;
      byRunId.set(parsed.runId, parsed);
    } catch {}
  }
  const { qualified, underpowered, stale } = qualifyCohorts([...byRunId.values()], nowMs, maxAgeDays);
  const activeContextFingerprint = selectComparableContext(qualified);
  const comparable = qualified.filter((cohort) => cohort.contextFingerprint === activeContextFingerprint);
  const byCanonicalModel = new Map<string, ModelBenchmarkEvidence>();
  for (const cohort of comparable.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))) {
    if (byCanonicalModel.has(cohort.canonicalModel)) continue;
    byCanonicalModel.set(cohort.canonicalModel, {
      benchmark: "ZouroBench",
      canonicalModel: cohort.canonicalModel,
      family: cohort.family,
      cohortId: cohort.cohortId,
      replicates: cohort.replicates,
      requiredReplicates: cohort.minimumN,
      observedAt: cohort.observedAt,
      contextFingerprint: cohort.contextFingerprint,
      sourceModelIds: cohort.sourceModelIds,
      overall: cohort.overall,
      roles: cohort.roles,
    });
  }
  return {
    byCanonicalModel,
    summary: {
      policy: "prefer-qualified-v1",
      activeContextFingerprint,
      scannedFiles: files.length,
      parsedRuns,
      deduplicatedRuns: byRunId.size,
      qualifiedCohorts: comparable.length,
      qualifiedModels: byCanonicalModel.size,
      underpoweredCohorts: underpowered,
      staleCohorts: stale,
      incomparableCohorts: qualified.length - comparable.length,
      unsupportedRoles: ["coder"],
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
  const maxAgeDays = values["max-age-days"] === undefined
    ? undefined
    : Number(values["max-age-days"]);
  if (maxAgeDays !== undefined && (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0)) {
    throw new Error("--max-age-days must be a positive number");
  }
  const evidence = loadZourobenchEvidence({
    roots: values.root,
    maxAgeDays,
  });
  const output = {
    summary: evidence.summary,
    models: [...evidence.byCanonicalModel.values()].sort((a, b) => a.canonicalModel.localeCompare(b.canonicalModel)),
  };
  console.log(values.json ? JSON.stringify(output, null, 2) : output);
}

if (import.meta.main) main();
