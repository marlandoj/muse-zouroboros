import { afterEach, describe, expect, test } from 'bun:test';
import {
  MODAL_RAG_CANDIDATE_MODEL,
  buildRagQualificationBatch,
  candidateVectorSha256,
  sha256CandidateContent,
  type CandidateRetrievalDependencies,
} from 'zouroboros-rag';
import {
  QUALIFICATION_STRATA,
  REQUIRED_FAILURE_SCENARIOS,
  evaluateModalRagQualification,
  createVerifiedQueryEvidenceDependencies,
  runDeterministicFailureMatrix,
  type HeldOutQualificationQuery,
} from '../../scripts/eval-modal-rag-qualification.js';
import { enrichTaskWithRAG } from '../rag/enrichment.js';
import {
  PRODUCTION_SHADOW_CALLS,
  PRODUCTION_SHADOW_CANDIDATE_BUDGET_MS,
  PRODUCTION_SHADOW_CONCURRENCY,
  PRODUCTION_SHADOW_MAX_DURATION_MS,
  createProductionShadowPlan,
  parseProductionShadowOptions,
} from '../../scripts/eval-modal-rag-production-shadow.js';

const originalFetch = globalThis.fetch;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const CANDIDATE_COLLECTION = 'zouroboros-modal-minilm-v1-abc123abc123';

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

function queries(count = 200): HeldOutQualificationQuery[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `query-${index}`,
    text: `qualification query ${index}`,
    expectedDocumentId: `doc-${index}`,
    classification: 'public',
    stratum: QUALIFICATION_STRATA[index % QUALIFICATION_STRATA.length]!,
  }));
}

function candidateDependencies(): CandidateRetrievalDependencies {
  return {
    embed: async ({ query, querySha256 }) => {
      const index = Number(query.match(/(\d+)$/)?.[1] ?? 0);
      const vector = new Array(MODAL_RAG_CANDIDATE_MODEL.dimensions).fill(0);
      vector[0] = index;
      return {
        schemaVersion: 1,
        classification: 'public',
        callbackId: `callback-${index}`,
        querySha256,
        itemCount: 1,
        model: MODAL_RAG_CANDIDATE_MODEL,
        dimensions: MODAL_RAG_CANDIDATE_MODEL.dimensions,
        vector,
        vectorSha256: candidateVectorSha256(vector),
        cleanup: { complete: true },
      };
    },
    search: async ({ vector }) => ({
      result: [{
        id: `chunk-${vector[0]}`,
        score: 0.99,
        payload: { chunk_id: `chunk-${vector[0]}`, source: `doc-${vector[0]}`, classification: 'public' },
      }],
    }),
  };
}

function verifiedQueryEvidence() {
  const items = queries().map((query) => ({
    id: query.id,
    text: query.text,
    contentSha256: sha256CandidateContent(query.text),
  }));
  return Array.from({ length: 13 }, (_, jobIndex) => {
    const offset = jobIndex % items.length;
    const batch = buildRagQualificationBatch(
      'a'.repeat(64),
      [...items.slice(offset), ...items.slice(0, offset)],
    );
    const artifactItems = batch.items.map((item) => {
      const index = Number(item.id.match(/(\d+)$/)?.[1] ?? 0);
      const bytes = Buffer.alloc(MODAL_RAG_CANDIDATE_MODEL.dimensions * Float32Array.BYTES_PER_ELEMENT);
      bytes.writeFloatLE(index, 0);
      return {
        id: item.id,
        dimensions: MODAL_RAG_CANDIDATE_MODEL.dimensions,
        vectorBase64: bytes.toString('base64'),
        sha256: sha256CandidateContent(bytes),
      };
    });
    return {
      batch,
      artifact: {
        schemaVersion: 1 as const,
        classification: 'public' as const,
        batchId: batch.batchId,
        batchSha256: batch.batchSha256,
        corpusManifestSha256: batch.corpusManifestSha256,
        model: MODAL_RAG_CANDIDATE_MODEL,
        device: 'cuda' as const,
        deviceName: 'fixture T4',
        itemCount: artifactItems.length,
        vectorSetSha256: sha256CandidateContent(artifactItems.map((item) => `${item.id}\0${item.sha256}`).join('\0')),
        durationMs: 1,
        items: artifactItems,
      },
      terminalState: 'succeeded' as const,
      cleanupComplete: true as const,
    };
  });
}

describe('Modal RAG production qualification', () => {
  test('bounds the production-caller shadow run without provider or Qdrant mutation', () => {
    const plan = createProductionShadowPlan(CANDIDATE_COLLECTION);
    expect(plan.calls).toBe(PRODUCTION_SHADOW_CALLS);
    expect(plan.concurrency).toBe(PRODUCTION_SHADOW_CONCURRENCY);
    expect(plan.candidateBudgetMs).toBe(PRODUCTION_SHADOW_CANDIDATE_BUDGET_MS);
    expect(plan.maximumDurationMs).toBe(PRODUCTION_SHADOW_MAX_DURATION_MS);
    expect(plan.candidateResultServed).toBe(false);
    expect(plan.modalDispatchAttempted).toBe(false);
    expect(plan.qdrantMutationAttempted).toBe(false);
    expect(plan.persistentActivationFlagSet).toBe(false);
    const options = parseProductionShadowOptions([
      '--manifest', 'manifest.json',
      '--queries', 'queries.json',
      '--query-evidence', 'query-evidence.json',
      '--collection', CANDIDATE_COLLECTION,
      '--output', 'shadow.json',
      '--dry-run',
    ], '/qualification');
    expect(options.dryRun).toBe(true);
    expect(options.collection).toBe(CANDIDATE_COLLECTION);
  });

  test('reuses exactly reproducible Q06 query evidence without another provider dispatch', async () => {
    let searches = 0;
    const dependencies = createVerifiedQueryEvidenceDependencies(verifiedQueryEvidence(), async () => {
      searches += 1;
      return { result: [] };
    });
    const query = queries()[17]!;
    const querySha256 = sha256CandidateContent(query.text);
    const artifact = await dependencies.embed({
      query: query.text,
      querySha256,
      classification: 'public',
      model: MODAL_RAG_CANDIDATE_MODEL,
      signal: new AbortController().signal,
    }) as { querySha256: string; vector: number[] };
    expect(artifact.querySha256).toBe(querySha256);
    expect(artifact.vector[0]).toBe(17);
    expect(searches).toBe(0);
    expect(() => createVerifiedQueryEvidenceDependencies(verifiedQueryEvidence().slice(0, 12), dependencies.search)).toThrow('exactly 13 jobs');
  });

  test('evaluates at least 200 public held-out queries through the shadow candidate path', async () => {
    const records = queries();
    const report = await evaluateModalRagQualification(records, {
      collection: CANDIDATE_COLLECTION,
      candidate: candidateDependencies(),
      retrieveIncumbent: async (query) => [query.expectedDocumentId],
      concurrency: 8,
    });
    expect(report.queryCount).toBe(200);
    expect(Object.values(report.strata).every((count) => count > 0)).toBe(true);
    expect(report.incumbent.top1Accuracy).toBe(1);
    expect(report.candidate.top1Accuracy).toBe(1);
    expect(report.candidate.recallAt5).toBe(1);
    expect(report.candidateFailures).toBe(0);
    expect(report.candidateResultsConsumed).toBe(0);
    expect(report.gates.pass).toBe(true);
  });

  test('rejects an undersized or non-public held-out set before retrieval', async () => {
    let calls = 0;
    await expect(evaluateModalRagQualification(queries(199), {
      collection: CANDIDATE_COLLECTION,
      candidate: candidateDependencies(),
      retrieveIncumbent: async () => { calls += 1; return []; },
    })).rejects.toThrow('at least 200');
    expect(calls).toBe(0);

    const records = queries();
    (records[0] as unknown as { classification: string }).classification = 'private';
    await expect(evaluateModalRagQualification(records, {
      collection: CANDIDATE_COLLECTION,
      candidate: candidateDependencies(),
    })).rejects.toThrow('not classified public');
  });

  test('computes incumbent and candidate gates independently', async () => {
    const report = await evaluateModalRagQualification(queries(), {
      collection: CANDIDATE_COLLECTION,
      candidate: {
        ...candidateDependencies(),
        search: async () => ({
          result: [{ id: 'wrong', score: 1, payload: { chunk_id: 'wrong', source: 'wrong-document', classification: 'public' } }],
        }),
      },
      retrieveIncumbent: async (query) => [query.expectedDocumentId],
    });
    expect(report.incumbent.top1Accuracy).toBe(1);
    expect(report.candidate.top1Accuracy).toBe(0);
    expect(report.gates.minimumCandidateTop1).toBe(false);
    expect(report.gates.maximumTop1Regression).toBe(false);
    expect(report.gates.pass).toBe(false);
  });

  test('passes the complete deterministic failure matrix with zero external mutations', async () => {
    const rows = await runDeterministicFailureMatrix();
    expect(rows.map((row) => row.scenario)).toEqual(REQUIRED_FAILURE_SCENARIOS);
    expect(rows.every((row) => row.passed)).toBe(true);
    expect(rows.every((row) => row.providerDispatches === 0)).toBe(true);
    expect(rows.every((row) => row.qdrantMutations === 0)).toBe(true);
  });

  test('production enrichment returns incumbent context without waiting for or consuming shadow results', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.openai.com')) {
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        result: [{ id: 'incumbent', score: 0.95, payload: { content: 'incumbent-only-content', source: 'incumbent-doc' } }],
      }), { status: 200 });
    }) as typeof fetch;

    let evidenceResolve: ((value: unknown) => void) | undefined;
    const evidence = new Promise((resolve) => { evidenceResolve = resolve; });
    const outcome = await Promise.race([
      enrichTaskWithRAG('public rag query', {
        collections: ['incumbent'],
        candidateShadow: {
          enabled: true,
          classification: 'public',
          collection: CANDIDATE_COLLECTION,
          budgetMs: 100,
          dependencies: {
            embed: async () => new Promise(() => {}),
            search: async () => ({ result: [] }),
          },
          onEvidence: (value) => { evidenceResolve?.(value); },
        },
      }),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 40)),
    ]);
    expect(outcome).not.toBe('blocked');
    expect(outcome).toEqual(expect.objectContaining({ patterns: 1 }));
    expect((outcome as { context: string }).context).toContain('incumbent-only-content');
    expect((outcome as { context: string }).context).not.toContain('candidate');
    const shadow = await evidence as { status: string; resultConsumed: boolean };
    expect(shadow.status).toBe('timeout');
    expect(shadow.resultConsumed).toBe(false);
  });
});
