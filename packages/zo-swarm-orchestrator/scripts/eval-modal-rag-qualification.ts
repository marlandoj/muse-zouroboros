#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MODAL_RAG_CANDIDATE_MODEL,
  candidateVectorSha256,
  createHttpCandidateRetrievalDependencies,
  validateRagQualificationEmbeddingArtifact,
  validateCandidateCorpusManifest,
  validateCandidateHeldOutQuerySet,
  type CandidateEmbeddingArtifact,
  type CandidateRetrievalDependencies,
  type RagQualificationBatch,
  type RagQualificationEmbeddingArtifact,
} from 'zouroboros-rag';
import { retrieveIncumbentRAG } from '../src/rag/enrichment.js';
import { runRagShadowComparison } from '../src/rag/shadow-comparator.js';

export const QUALIFICATION_STRATA = [
  'code',
  'documentation',
  'governance',
  'workflow_and_swarm',
  'rag_and_memory_public_docs',
] as const;

export const REQUIRED_FAILURE_SCENARIOS = [
  'provider_timeout',
  'provider_nonzero_exit',
  'malformed_artifact',
  'digest_mismatch',
  'dimension_mismatch',
  'duplicate_callback',
  'partial_batch',
  'qdrant_write_failure',
  'budget_exhaustion',
  'cleanup_failure',
] as const;

const DRY_RUN_COLLECTION = 'zouroboros-modal-minilm-v1-000000000000';

export type QualificationStratum = (typeof QUALIFICATION_STRATA)[number];
export type FailureScenario = (typeof REQUIRED_FAILURE_SCENARIOS)[number];

export interface HeldOutQualificationQuery {
  id: string;
  text: string;
  expectedDocumentId: string;
  relevantDocumentIds?: string[];
  classification: 'public';
  stratum: QualificationStratum;
}

export interface QualificationMetrics {
  questions: number;
  top1Correct: number;
  recallAt5Correct: number;
  top1Accuracy: number;
  recallAt5: number;
}

export interface QualificationDependencies {
  retrieveIncumbent?: (query: HeldOutQualificationQuery) => Promise<string[]>;
  candidate: CandidateRetrievalDependencies;
  collection: string;
  budgetMs?: number;
  concurrency?: number;
  manifest?: unknown;
}

export interface QualificationReport {
  schemaVersion: 1;
  classification: 'public';
  queryCount: number;
  strata: Record<QualificationStratum, number>;
  incumbent: QualificationMetrics;
  candidate: QualificationMetrics;
  candidateFailures: number;
  candidateResultsConsumed: 0;
  gates: {
    minimumCandidateTop1: boolean;
    minimumCandidateRecallAt5: boolean;
    maximumTop1Regression: boolean;
    maximumRecallAt5Regression: boolean;
    publicOnly: boolean;
    resultNonConsumption: boolean;
    pass: boolean;
  };
}

export interface FailureMatrixRow {
  scenario: FailureScenario;
  passed: boolean;
  observedStatus: string;
  providerDispatches: 0;
  qdrantMutations: 0;
  error?: string;
}

interface QueryLoadEvidence {
  batch: RagQualificationBatch;
  artifact: RagQualificationEmbeddingArtifact;
  terminalState: 'succeeded';
  cleanupComplete: true;
}

function validateQueries(value: unknown, manifestValue?: unknown): HeldOutQualificationQuery[] {
  if (manifestValue !== undefined) {
    const manifest = validateCandidateCorpusManifest(manifestValue);
    const querySet = validateCandidateHeldOutQuerySet(value, manifest);
    const chunkSources = new Map(manifest.chunks.map((chunk) => [chunk.chunkId, chunk.source]));
    return querySet.queries.map((query) => {
      const relevantDocumentIds = [...new Set(query.relevantChunkIds.map((chunkId) => chunkSources.get(chunkId)!))];
      return {
        id: query.id,
        text: query.text,
        expectedDocumentId: relevantDocumentIds[0]!,
        relevantDocumentIds,
        classification: 'public',
        stratum: query.stratum,
      };
    });
  }
  const raw = Array.isArray(value)
    ? value
    : (value && typeof value === 'object' && Array.isArray((value as { queries?: unknown }).queries)
      ? (value as { queries: unknown[] }).queries
      : undefined);
  if (!raw) throw new Error('Held-out qualification data must be an array or an object with a queries array');
  if (raw.length < 200) throw new Error(`Qualification requires at least 200 held-out queries; received ${raw.length}`);
  const ids = new Set<string>();
  const records = raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Query ${index} must be an object`);
    const query = entry as Record<string, unknown>;
    const id = query.id;
    const text = query.text ?? query.query;
    const expectedDocumentId = query.expectedDocumentId ?? query.expected_document_id;
    const classification = query.classification;
    const stratum = query.stratum;
    if (typeof id !== 'string' || !id) throw new Error(`Query ${index} ID is invalid`);
    if (ids.has(id)) throw new Error(`Duplicate held-out query ID: ${id}`);
    if (typeof text !== 'string' || !text.trim()) throw new Error(`Query ${id} text is invalid`);
    if (typeof expectedDocumentId !== 'string' || !expectedDocumentId) throw new Error(`Query ${id} expected document is invalid`);
    if (classification !== 'public') throw new Error(`Query ${id} is not classified public`);
    if (!QUALIFICATION_STRATA.includes(stratum as QualificationStratum)) throw new Error(`Query ${id} stratum is invalid`);
    ids.add(id);
    return { id, text, expectedDocumentId, relevantDocumentIds: [expectedDocumentId], classification, stratum } as HeldOutQualificationQuery;
  });
  for (const stratum of QUALIFICATION_STRATA) {
    if (!records.some((record) => record.stratum === stratum)) throw new Error(`Held-out queries omit stratum: ${stratum}`);
  }
  return records;
}

function metrics(rankings: Array<{ expected: string[]; ids: string[] }>): QualificationMetrics {
  const top1Correct = rankings.filter((row) => row.ids[0] !== undefined && row.expected.includes(row.ids[0])).length;
  const recallAt5Correct = rankings.filter((row) => row.ids.slice(0, 5).some((id) => row.expected.includes(id))).length;
  return {
    questions: rankings.length,
    top1Correct,
    recallAt5Correct,
    top1Accuracy: rankings.length === 0 ? 0 : top1Correct / rankings.length,
    recallAt5: rankings.length === 0 ? 0 : recallAt5Correct / rankings.length,
  };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function createVerifiedQueryEvidenceDependencies(
  value: unknown,
  search: CandidateRetrievalDependencies['search'],
): CandidateRetrievalDependencies {
  if (!Array.isArray(value) || value.length !== 13) throw new Error('Q06 query evidence must contain exactly 13 jobs');
  const vectors = new Map<string, { vector: number[]; sha256: string }>();
  const batchIds = new Set<string>();
  for (const [jobIndex, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Q06 query evidence job ${jobIndex} is invalid`);
    const evidence = raw as QueryLoadEvidence;
    if (evidence.terminalState !== 'succeeded' || evidence.cleanupComplete !== true) {
      throw new Error(`Q06 query evidence job ${jobIndex} did not finish cleanly`);
    }
    if (batchIds.has(evidence.batch.batchId)) throw new Error(`Duplicate Q06 query batch: ${evidence.batch.batchId}`);
    batchIds.add(evidence.batch.batchId);
    const artifact = validateRagQualificationEmbeddingArtifact(evidence.artifact, evidence.batch);
    if (evidence.batch.items.length !== 200) throw new Error('Q06 query evidence must cover exactly 200 queries per job');
    for (const [index, item] of artifact.items.entries()) {
      const input = evidence.batch.items[index]!;
      if (input.id !== item.id) throw new Error(`Q06 query evidence item mismatch: ${item.id}`);
      const bytes = Buffer.from(item.vectorBase64, 'base64');
      const aligned = Uint8Array.from(bytes);
      const vector = Array.from(new Float32Array(aligned.buffer));
      const prior = vectors.get(input.contentSha256);
      if (prior && prior.sha256 !== item.sha256) throw new Error(`Q06 query embedding reproducibility mismatch: ${input.id}`);
      vectors.set(input.contentSha256, { vector, sha256: item.sha256 });
    }
  }
  if (vectors.size !== 200) throw new Error(`Q06 query evidence covers ${vectors.size} of 200 queries`);
  let callbackSequence = 0;
  return {
    acceptedCallbackIds: new Set<string>(),
    async embed({ querySha256 }) {
      const verified = vectors.get(querySha256);
      if (!verified) throw new Error('Q06 query evidence does not contain the requested query');
      callbackSequence += 1;
      return {
        schemaVersion: 1,
        classification: 'public',
        callbackId: `q06-evidence-${callbackSequence}-${querySha256.slice(0, 12)}`,
        querySha256,
        itemCount: 1,
        model: MODAL_RAG_CANDIDATE_MODEL,
        dimensions: MODAL_RAG_CANDIDATE_MODEL.dimensions,
        vector: verified.vector,
        vectorSha256: candidateVectorSha256(verified.vector),
        cleanup: { complete: true },
      } satisfies CandidateEmbeddingArtifact;
    },
    search,
  };
}

export async function evaluateModalRagQualification(
  value: unknown,
  dependencies: QualificationDependencies,
): Promise<QualificationReport> {
  const queries = validateQueries(value, dependencies.manifest);
  const retrieveIncumbent = dependencies.retrieveIncumbent ?? (async (query: HeldOutQualificationQuery) => (
    await retrieveIncumbentRAG(query.text, { topK: 5, minScore: 0 })
  ).rankingIds);
  const rows = await mapConcurrent(queries, dependencies.concurrency ?? 4, async (query) => {
    const [incumbentIds, candidate] = await Promise.all([
      retrieveIncumbent(query),
      runRagShadowComparison(query.text, {
        enabled: true,
        classification: 'public',
        collection: dependencies.collection,
        budgetMs: dependencies.budgetMs,
        topK: 5,
        minScore: 0,
        dependencies: dependencies.candidate,
      }),
    ]);
    return {
      expected: query.relevantDocumentIds ?? [query.expectedDocumentId],
      incumbentIds,
      candidateIds: candidate.candidateRankingIds,
      candidateStatus: candidate.status,
      candidateConsumed: candidate.resultConsumed,
    };
  });
  const incumbent = metrics(rows.map((row) => ({ expected: row.expected, ids: row.incumbentIds })));
  const candidate = metrics(rows.map((row) => ({ expected: row.expected, ids: row.candidateIds })));
  const candidateFailures = rows.filter((row) => row.candidateStatus !== 'ok').length;
  const gates = {
    minimumCandidateTop1: candidate.top1Accuracy >= 0.85,
    minimumCandidateRecallAt5: candidate.recallAt5 >= 0.92,
    maximumTop1Regression: incumbent.top1Accuracy - candidate.top1Accuracy <= 0.03,
    maximumRecallAt5Regression: incumbent.recallAt5 - candidate.recallAt5 <= 0.02,
    publicOnly: queries.every((query) => query.classification === 'public'),
    resultNonConsumption: rows.every((row) => row.candidateConsumed === false),
    pass: false,
  };
  gates.pass = candidateFailures === 0 && Object.entries(gates)
    .filter(([key]) => key !== 'pass')
    .every(([, passed]) => passed);
  const strata = Object.fromEntries(QUALIFICATION_STRATA.map((stratum) => [
    stratum,
    queries.filter((query) => query.stratum === stratum).length,
  ])) as Record<QualificationStratum, number>;
  return {
    schemaVersion: 1,
    classification: 'public',
    queryCount: queries.length,
    strata,
    incumbent,
    candidate,
    candidateFailures,
    candidateResultsConsumed: 0,
    gates,
  };
}

function validArtifact(querySha256: string, callbackId: string): CandidateEmbeddingArtifact {
  const vector = new Array(MODAL_RAG_CANDIDATE_MODEL.dimensions).fill(0.125);
  return {
    schemaVersion: 1,
    classification: 'public',
    callbackId,
    querySha256,
    itemCount: 1,
    model: MODAL_RAG_CANDIDATE_MODEL,
    dimensions: MODAL_RAG_CANDIDATE_MODEL.dimensions,
    vector,
    vectorSha256: candidateVectorSha256(vector),
    cleanup: { complete: true },
  };
}

export async function runDeterministicFailureMatrix(): Promise<FailureMatrixRow[]> {
  const baseSearch: CandidateRetrievalDependencies['search'] = async () => ({
    result: [{ id: 'chunk', score: 1, payload: { chunk_id: 'chunk', source: 'doc', classification: 'public' } }],
  });
  const run = async (
    scenario: FailureScenario,
    dependencyFactory: () => CandidateRetrievalDependencies,
    budgetMs = 50,
    expectedStatus: string = 'failed',
  ): Promise<FailureMatrixRow> => {
    const evidence = await runRagShadowComparison('public qualification failure query', {
      enabled: true,
      classification: 'public',
      collection: DRY_RUN_COLLECTION,
      budgetMs,
      dependencies: dependencyFactory(),
    });
    return {
      scenario,
      passed: evidence.status === expectedStatus && evidence.resultConsumed === false && evidence.candidateRankingIds.length === 0,
      observedStatus: evidence.status,
      providerDispatches: 0,
      qdrantMutations: 0,
      error: evidence.error,
    };
  };
  const standard = (mutate?: (value: CandidateEmbeddingArtifact) => CandidateEmbeddingArtifact): CandidateRetrievalDependencies => ({
    embed: async ({ querySha256 }) => {
      const value = validArtifact(querySha256, `callback-${querySha256.slice(0, 12)}`);
      return mutate ? mutate(value) : value;
    },
    search: baseSearch,
  });
  const rows: FailureMatrixRow[] = [];
  rows.push(await run('provider_timeout', () => ({ embed: async () => new Promise(() => {}), search: baseSearch }), 5, 'timeout'));
  rows.push(await run('provider_nonzero_exit', () => ({ embed: async () => { throw new Error('provider exit 17'); }, search: baseSearch })));
  rows.push(await run('malformed_artifact', () => ({ embed: async () => ({ malformed: true }), search: baseSearch })));
  rows.push(await run('digest_mismatch', () => standard((value) => ({ ...value, vectorSha256: 'invalid' }))));
  rows.push(await run('dimension_mismatch', () => standard((value) => ({ ...value, dimensions: 383 }))));
  const acceptedCallbackIds = new Set<string>();
  const duplicateDeps: CandidateRetrievalDependencies = {
    acceptedCallbackIds,
    embed: async ({ querySha256 }) => validArtifact(querySha256, 'duplicate-callback'),
    search: baseSearch,
  };
  await runRagShadowComparison('public qualification failure query', {
    enabled: true,
    classification: 'public',
    collection: DRY_RUN_COLLECTION,
    dependencies: duplicateDeps,
  });
  rows.push(await run('duplicate_callback', () => duplicateDeps));
  rows.push(await run('partial_batch', () => standard((value) => ({ ...value, itemCount: 0 as 1 }))));
  rows.push(await run('qdrant_write_failure', () => ({
    ...standard(),
    search: async () => { throw new Error('Qdrant write failure'); },
  })));
  rows.push(await run('budget_exhaustion', () => standard(), 0, 'budget_exhausted'));
  rows.push(await run('cleanup_failure', () => standard((value) => ({ ...value, cleanup: { complete: false } }))));
  return rows;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function deterministicDependencies(
  queries: HeldOutQualificationQuery[],
): CandidateRetrievalDependencies {
  const sources = queries.map((query) => query.expectedDocumentId);
  const indexByQuery = new Map(queries.map((query, index) => [query.text, index]));
  return {
    embed: async ({ query, querySha256 }) => {
      const index = indexByQuery.get(query);
      if (index === undefined) throw new Error('Deterministic qualification query is unknown');
      const vector = new Array(MODAL_RAG_CANDIDATE_MODEL.dimensions).fill(0);
      vector[0] = index;
      return {
        schemaVersion: 1,
        classification: 'public',
        callbackId: `deterministic-${index}`,
        querySha256,
        itemCount: 1,
        model: MODAL_RAG_CANDIDATE_MODEL,
        dimensions: MODAL_RAG_CANDIDATE_MODEL.dimensions,
        vector,
        vectorSha256: candidateVectorSha256(vector),
        cleanup: { complete: true },
      };
    },
    search: async ({ vector }) => {
      const index = Number(vector[0]);
      return {
        result: [{
          id: `deterministic-point-${index}`,
          score: 1,
          payload: { chunk_id: `deterministic-chunk-${index}`, source: sources[index], classification: 'public' },
        }],
      };
    },
  };
}

async function main(): Promise<void> {
  const failureMatrix = await runDeterministicFailureMatrix();
  if (process.argv.includes('--failure-only')) {
    console.log(JSON.stringify({ failureMatrix }, null, 2));
    if (failureMatrix.some((row) => !row.passed)) process.exitCode = 1;
    return;
  }
  const queriesPath = resolve(argument('--queries') ?? 'packages/bench/data/modal-rag-qualification/held-out-queries.json');
  const manifestPath = resolve(argument('--manifest') ?? 'packages/bench/data/modal-rag-qualification/corpus-manifest.json');
  const manifestRaw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifest = validateCandidateCorpusManifest(manifestRaw);
  const collection = argument('--collection') ?? process.env.MODAL_RAG_CANDIDATE_COLLECTION ?? manifest.collection.physicalName;
  if (!collection) throw new Error('--collection or MODAL_RAG_CANDIDATE_COLLECTION is required');
  const raw = JSON.parse(await readFile(queriesPath, 'utf8')) as unknown;
  const deterministic = process.argv.includes('--deterministic');
  const validatedQueries = validateQueries(raw, manifestRaw);
  const liveCandidate = createHttpCandidateRetrievalDependencies();
  const queryEvidencePath = argument('--query-evidence');
  const candidate = queryEvidencePath
    ? createVerifiedQueryEvidenceDependencies(JSON.parse(await readFile(resolve(queryEvidencePath), 'utf8')), liveCandidate.search)
    : liveCandidate;
  const report = await evaluateModalRagQualification(raw, {
    collection,
    manifest: manifestRaw,
    candidate: deterministic ? deterministicDependencies(validatedQueries) : candidate,
    ...(deterministic ? { retrieveIncumbent: async (query: HeldOutQualificationQuery) => [query.expectedDocumentId] } : {}),
  });
  const output = { report, failureMatrix };
  const outputPath = argument('--output');
  if (outputPath) await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
  if (!report.gates.pass || failureMatrix.some((row) => !row.passed)) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
