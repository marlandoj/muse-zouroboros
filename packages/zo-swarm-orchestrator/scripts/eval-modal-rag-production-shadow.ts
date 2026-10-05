#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  createHttpCandidateRetrievalDependencies,
  validateCandidateCorpusManifest,
  validateCandidateHeldOutQuerySet,
  type CandidateRetrievalDependencies,
} from 'zouroboros-rag';
import { enrichTaskWithRAG, type RAGEnrichmentOptions } from '../src/rag/enrichment.js';
import type { CandidateShadowEvidence } from '../src/rag/shadow-comparator.js';
import { createVerifiedQueryEvidenceDependencies } from './eval-modal-rag-qualification.js';

export const PRODUCTION_SHADOW_CALLS = 250;
export const PRODUCTION_SHADOW_CONCURRENCY = 4;
export const PRODUCTION_SHADOW_CANDIDATE_BUDGET_MS = 750;
export const PRODUCTION_SHADOW_MAX_DURATION_MS = 30 * 60 * 1000;
export const PRODUCTION_SHADOW_ENABLE_ENV = 'ZOUROBOROS_MODAL_RAG_PRODUCTION_SHADOW_QUALIFICATION';

export interface ProductionShadowOptions {
  manifestPath: string;
  queriesPath: string;
  queryEvidencePath: string;
  collection: string;
  outputPath: string;
  dryRun: boolean;
}

export interface ProductionShadowPlan {
  schemaVersion: 1;
  classification: 'public';
  calls: number;
  concurrency: number;
  candidateBudgetMs: number;
  maximumDurationMs: number;
  collection: string;
  candidateResultServed: false;
  modalDispatchAttempted: false;
  qdrantMutationAttempted: false;
  persistentActivationFlagSet: false;
}

export interface ProductionShadowRow {
  callIndex: number;
  queryId: string;
  classification: 'public';
  incumbent: {
    returned: true;
    latencyMs: number;
    patterns: number;
    contextSha256: string;
  };
  candidate: {
    status: CandidateShadowEvidence['status'];
    latencyMs: number;
    hitCount: number;
    resultConsumed: false;
    cleanupComplete: boolean;
  };
}

export interface ProductionShadowReport {
  schemaVersion: 1;
  result: 'PASS';
  plan: ProductionShadowPlan;
  durationMs: number;
  calls: number;
  candidateSuccessRate: number;
  candidateResultConsumptionCount: number;
  candidateCleanupRate: number;
  incumbentReturnRate: number;
  rows: ProductionShadowRow[];
}

interface ProductionShadowDependencies {
  enrich?: typeof enrichTaskWithRAG;
  search?: CandidateRetrievalDependencies['search'];
  env?: Readonly<Record<string, string | undefined>>;
}

export function parseProductionShadowOptions(args: readonly string[], cwd = process.cwd()): ProductionShadowOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
  }
  const manifest = values.get('--manifest');
  const queries = values.get('--queries');
  const queryEvidence = values.get('--query-evidence');
  const collection = values.get('--collection');
  const output = values.get('--output');
  if (!manifest || !queries || !queryEvidence || !collection || !output) {
    throw new Error('--manifest, --queries, --query-evidence, --collection, and --output are required');
  }
  return {
    manifestPath: resolve(cwd, manifest),
    queriesPath: resolve(cwd, queries),
    queryEvidencePath: resolve(cwd, queryEvidence),
    collection,
    outputPath: resolve(cwd, output),
    dryRun,
  };
}

export function createProductionShadowPlan(collection: string): ProductionShadowPlan {
  if (!/^zouroboros-modal-minilm-v1-[a-f0-9]{12}$/.test(collection)) throw new Error('Candidate collection name is invalid');
  return {
    schemaVersion: 1,
    classification: 'public',
    calls: PRODUCTION_SHADOW_CALLS,
    concurrency: PRODUCTION_SHADOW_CONCURRENCY,
    candidateBudgetMs: PRODUCTION_SHADOW_CANDIDATE_BUDGET_MS,
    maximumDurationMs: PRODUCTION_SHADOW_MAX_DURATION_MS,
    collection,
    candidateResultServed: false,
    modalDispatchAttempted: false,
    qdrantMutationAttempted: false,
    persistentActivationFlagSet: false,
  };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function waitForCandidateEvidence(
  run: (onEvidence: (value: CandidateShadowEvidence) => void) => Promise<{ context: string; latencyMs: number; patterns: number }>,
): Promise<{ incumbent: { context: string; latencyMs: number; patterns: number }; candidate: CandidateShadowEvidence }> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Production shadow evidence callback timed out')), 5_000);
    let incumbent: { context: string; latencyMs: number; patterns: number } | undefined;
    let candidate: CandidateShadowEvidence | undefined;
    const finish = () => {
      if (!incumbent || !candidate) return;
      clearTimeout(timer);
      resolvePromise({ incumbent, candidate });
    };
    run((value) => {
      candidate = value;
      finish();
    }).then((value) => {
      incumbent = value;
      finish();
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(path, 'utf8');
    if (existing !== rendered) throw new Error(`Immutable evidence drift: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rendered, { flag: 'wx' });
  }
}

export async function runProductionShadowQualification(
  options: ProductionShadowOptions,
  dependencies: ProductionShadowDependencies = {},
): Promise<ProductionShadowPlan | ProductionShadowReport> {
  const plan = createProductionShadowPlan(options.collection);
  if (options.dryRun) {
    await writeImmutable(options.outputPath, plan);
    return plan;
  }
  const env = dependencies.env ?? process.env;
  if (env[PRODUCTION_SHADOW_ENABLE_ENV] !== '1') throw new Error('Production shadow qualification is disabled');
  const manifestRaw = JSON.parse(await readFile(options.manifestPath, 'utf8')) as unknown;
  const manifest = validateCandidateCorpusManifest(manifestRaw);
  if (manifest.collection.physicalName !== options.collection) throw new Error('Production shadow collection does not match the corpus manifest');
  const querySet = validateCandidateHeldOutQuerySet(
    JSON.parse(await readFile(options.queriesPath, 'utf8')),
    manifest,
  );
  const live = createHttpCandidateRetrievalDependencies();
  const candidate = createVerifiedQueryEvidenceDependencies(
    JSON.parse(await readFile(options.queryEvidencePath, 'utf8')),
    dependencies.search ?? live.search,
  );
  const enrich = dependencies.enrich ?? enrichTaskWithRAG;
  const calls = Array.from({ length: PRODUCTION_SHADOW_CALLS }, (_, index) => querySet.queries[index % querySet.queries.length]!);
  const startedAt = Date.now();
  const rows = await mapConcurrent(calls, PRODUCTION_SHADOW_CONCURRENCY, async (query, callIndex) => {
    const result = await waitForCandidateEvidence((onEvidence) => enrich(query.text, {
      candidateShadow: {
        enabled: true,
        classification: 'public',
        collection: options.collection,
        budgetMs: PRODUCTION_SHADOW_CANDIDATE_BUDGET_MS,
        topK: 5,
        minScore: 0,
        dependencies: candidate,
        onEvidence,
      },
    } satisfies RAGEnrichmentOptions));
    return {
      callIndex,
      queryId: query.id,
      classification: 'public' as const,
      incumbent: {
        returned: true as const,
        latencyMs: result.incumbent.latencyMs,
        patterns: result.incumbent.patterns,
        contextSha256: createHash('sha256').update(result.incumbent.context).digest('hex'),
      },
      candidate: {
        status: result.candidate.status,
        latencyMs: result.candidate.candidateLatencyMs,
        hitCount: result.candidate.candidateHitCount,
        resultConsumed: result.candidate.resultConsumed,
        cleanupComplete: result.candidate.cleanupComplete,
      },
    } satisfies ProductionShadowRow;
  });
  const durationMs = Date.now() - startedAt;
  const report: ProductionShadowReport = {
    schemaVersion: 1,
    result: 'PASS',
    plan,
    durationMs,
    calls: rows.length,
    candidateSuccessRate: rows.filter((row) => row.candidate.status === 'ok').length / PRODUCTION_SHADOW_CALLS,
    candidateResultConsumptionCount: rows.filter((row) => row.candidate.resultConsumed).length,
    candidateCleanupRate: rows.filter((row) => row.candidate.cleanupComplete).length / PRODUCTION_SHADOW_CALLS,
    incumbentReturnRate: rows.filter((row) => row.incumbent.returned).length / PRODUCTION_SHADOW_CALLS,
    rows,
  };
  if (
    report.calls !== PRODUCTION_SHADOW_CALLS
    || report.durationMs > PRODUCTION_SHADOW_MAX_DURATION_MS
    || report.candidateSuccessRate !== 1
    || report.candidateResultConsumptionCount !== 0
    || report.candidateCleanupRate !== 1
    || report.incumbentReturnRate !== 1
  ) {
    throw new Error('Production shadow qualification gates failed');
  }
  await writeImmutable(options.outputPath, report);
  return report;
}

if (import.meta.main) {
  const options = parseProductionShadowOptions(process.argv.slice(2));
  const result = await runProductionShadowQualification(options);
  console.log(JSON.stringify({ result: options.dryRun ? 'DRY_RUN' : 'PASS', output: options.outputPath, evidence: result }));
}
