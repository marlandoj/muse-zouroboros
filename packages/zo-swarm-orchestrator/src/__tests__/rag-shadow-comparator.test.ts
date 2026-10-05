import { afterEach, describe, expect, test } from 'bun:test';
import {
  MODAL_RAG_CANDIDATE_MODEL,
  candidateVectorSha256,
  type CandidateRetrievalDependencies,
} from 'zouroboros-rag';
import { runRagShadowComparison } from '../rag/shadow-comparator.js';

const originalFlag = process.env.MODAL_RAG_SHADOW_ENABLED;
const CANDIDATE_COLLECTION = 'zouroboros-modal-minilm-v1-abc123abc123';

afterEach(() => {
  if (originalFlag === undefined) delete process.env.MODAL_RAG_SHADOW_ENABLED;
  else process.env.MODAL_RAG_SHADOW_ENABLED = originalFlag;
});

function dependencies(counter: { embed: number; search: number }): CandidateRetrievalDependencies {
  return {
    embed: async ({ querySha256 }) => {
      counter.embed += 1;
      const vector = new Array(MODAL_RAG_CANDIDATE_MODEL.dimensions).fill(0.5);
      return {
        schemaVersion: 1,
        classification: 'public',
        callbackId: `callback-${counter.embed}`,
        querySha256,
        itemCount: 1,
        model: MODAL_RAG_CANDIDATE_MODEL,
        dimensions: MODAL_RAG_CANDIDATE_MODEL.dimensions,
        vector,
        vectorSha256: candidateVectorSha256(vector),
        cleanup: { complete: true },
      };
    },
    search: async () => {
      counter.search += 1;
      return {
        result: [
          { id: 'c1', score: 0.94, payload: { chunk_id: 'chunk-1', source: 'candidate-doc', classification: 'public' } },
        ],
      };
    },
  };
}

describe('Modal RAG shadow comparator', () => {
  test('is default-off and performs no candidate work', async () => {
    delete process.env.MODAL_RAG_SHADOW_ENABLED;
    const counter = { embed: 0, search: 0 };
    const evidence = await runRagShadowComparison('public rag query', {
      classification: 'public',
      collection: CANDIDATE_COLLECTION,
      dependencies: dependencies(counter),
    });
    expect(evidence.status).toBe('disabled');
    expect(evidence.resultConsumed).toBe(false);
    expect(counter).toEqual({ embed: 0, search: 0 });
  });

  test('requires explicit public classification even when enabled', async () => {
    const counter = { embed: 0, search: 0 };
    let observed: unknown;
    const evidence = await runRagShadowComparison('private memory query', {
      enabled: true,
      classification: 'private',
      collection: CANDIDATE_COLLECTION,
      dependencies: dependencies(counter),
      onEvidence: (value) => { observed = value; },
    });
    expect(evidence.status).toBe('not_public');
    expect(evidence.attempted).toBe(false);
    expect(evidence.resultConsumed).toBe(false);
    expect(counter).toEqual({ embed: 0, search: 0 });
    expect(observed).toEqual(evidence);
  });

  test('records candidate ranking as non-consumed evidence', async () => {
    const counter = { embed: 0, search: 0 };
    const evidence = await runRagShadowComparison('public rag query', {
      enabled: true,
      classification: 'public',
      collection: CANDIDATE_COLLECTION,
      dependencies: dependencies(counter),
    });
    expect(evidence.status).toBe('ok');
    expect(evidence.candidateRankingIds).toEqual(['candidate-doc']);
    expect(evidence.resultConsumed).toBe(false);
    expect(evidence.cleanupComplete).toBe(true);
    expect(counter).toEqual({ embed: 1, search: 1 });
  });

  test('fails candidate evidence closed without throwing into the incumbent path', async () => {
    const counter = { embed: 0, search: 0 };
    const deps = dependencies(counter);
    deps.embed = async () => { counter.embed += 1; throw new Error('transport failed'); };
    const evidence = await runRagShadowComparison('public rag query', {
      enabled: true,
      classification: 'public',
      collection: CANDIDATE_COLLECTION,
      dependencies: deps,
    });
    expect(evidence.status).toBe('failed');
    expect(evidence.candidateRankingIds).toEqual([]);
    expect(evidence.resultConsumed).toBe(false);
    expect(evidence.error).toContain('transport failed');
  });
});
