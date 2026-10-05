/**
 * Multi-collection RAG retrieval (Q2 #3 Cycle 1.A).
 *
 * Pure unit tests — all OpenAI/Qdrant calls mocked via fetch monkey-patch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  enrichTaskWithRAG,
  resolveCollections,
  shouldEnrichWithRAG,
} from '../rag/enrichment.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

interface MockedCall {
  url: string;
  method?: string;
  body?: unknown;
}

function installMockFetch(handlers: Record<string, (req: { url: string; init?: RequestInit }) => unknown>): MockedCall[] {
  const calls: MockedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    let body: unknown;
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method: init?.method, body });
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        const result = handler({ url, init });
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.QDRANT_URL = 'http://qdrant.test';
  process.env.QDRANT_API_KEY = 'test-qdrant-key';
  process.env.RAG_TELEMETRY_DISABLED = '1';
  delete process.env.RAG_COLLECTIONS;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveCollections', () => {
  test('default is the pruned local 1536d corpus (VPS migration)', () => {
    delete process.env.RAG_COLLECTIONS;
    expect(resolveCollections()).toEqual([
      'zouroboros-code',
      'shared-memory-facts',
      'code-docs',
    ]);
  });

  test('options.collections overrides env and default', () => {
    process.env.RAG_COLLECTIONS = 'env-coll';
    expect(resolveCollections({ collections: ['opt-a', 'opt-b'] })).toEqual(['opt-a', 'opt-b']);
  });

  test('env RAG_COLLECTIONS parses comma-separated list', () => {
    process.env.RAG_COLLECTIONS = 'a, b ,c';
    expect(resolveCollections()).toEqual(['a', 'b', 'c']);
  });

  test('empty options.collections falls through to env', () => {
    process.env.RAG_COLLECTIONS = 'envcoll';
    expect(resolveCollections({ collections: [] })).toEqual(['envcoll']);
  });

  test('empty env string falls through to default', () => {
    process.env.RAG_COLLECTIONS = '';
    expect(resolveCollections()).toEqual([
      'zouroboros-code',
      'shared-memory-facts',
      'code-docs',
    ]);
  });
});

describe('shouldEnrichWithRAG', () => {
  test('matches trigger keyword', () => {
    expect(shouldEnrichWithRAG('Build an agent for X')).toBe(true);
  });
  test('rejects non-trigger text', () => {
    expect(shouldEnrichWithRAG('paint the fence beige')).toBe(false);
  });
});

describe('enrichTaskWithRAG — multi-collection', () => {
  test('queries each collection in the list', async () => {
    const calls = installMockFetch({
      'api.openai.com': () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
      '/collections/research/points/search': () => ({
        result: [{ id: 'r1', score: 0.9, payload: { content: 'research-A', source: 'paper.pdf' } }],
      }),
      '/collections/codes/points/search': () => ({
        result: [{ id: 'c1', score: 0.85, payload: { content: 'code-A', sdk: 'bun', source: 'doc.md' } }],
      }),
    });

    const result = await enrichTaskWithRAG('build an agent', {
      collections: ['research', 'codes'],
      topK: 2,
    });

    expect(result.patterns).toBeGreaterThan(0);
    expect(result.context).toContain('research-A');
    expect(result.context).toContain('code-A');

    const searchCalls = calls.filter(c => c.url.includes('/points/search'));
    expect(searchCalls.length).toBe(2);
    const urls = searchCalls.map(c => c.url);
    expect(urls.some(u => u.includes('/collections/research/'))).toBe(true);
    expect(urls.some(u => u.includes('/collections/codes/'))).toBe(true);
  });

  test('merges results across collections sorted by score and respects topK', async () => {
    installMockFetch({
      'api.openai.com': () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
      '/collections/A/points/search': () => ({
        result: [
          { id: 'a1', score: 0.6, payload: { content: 'A-low', source: 's' } },
          { id: 'a2', score: 0.95, payload: { content: 'A-high', source: 's' } },
        ],
      }),
      '/collections/B/points/search': () => ({
        result: [
          { id: 'b1', score: 0.8, payload: { content: 'B-mid', source: 's' } },
        ],
      }),
    });

    const result = await enrichTaskWithRAG('agent workflow', {
      collections: ['A', 'B'],
      topK: 2,
    });

    expect(result.patterns).toBe(2);
    const aHighIdx = result.context.indexOf('A-high');
    const bMidIdx = result.context.indexOf('B-mid');
    const aLowIdx = result.context.indexOf('A-low');
    expect(aHighIdx).toBeGreaterThan(-1);
    expect(bMidIdx).toBeGreaterThan(-1);
    expect(aLowIdx).toBe(-1);
    expect(aHighIdx).toBeLessThan(bMidIdx);
  });

  test('a single collection 4xx does not abort other collections', async () => {
    let openaiCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.openai.com')) {
        openaiCount++;
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), { status: 200 });
      }
      if (url.includes('/collections/broken/points/search')) {
        return new Response(JSON.stringify({ status: { error: 'dim mismatch' } }), { status: 400 });
      }
      if (url.includes('/collections/healthy/points/search')) {
        return new Response(JSON.stringify({
          result: [{ id: 'h1', score: 0.9, payload: { content: 'healthy-hit', source: 'h' } }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const result = await enrichTaskWithRAG('agent retrieval', {
      collections: ['broken', 'healthy'],
      topK: 3,
    });

    expect(openaiCount).toBe(1);
    expect(result.patterns).toBe(1);
    expect(result.context).toContain('healthy-hit');
    expect(result.error).toContain('Qdrant search failed');
  });

  test('all-collection failure returns empty context, not throw', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.openai.com')) {
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), { status: 200 });
      }
      return new Response('{}', { status: 400 });
    }) as typeof fetch;

    const result = await enrichTaskWithRAG('agent workflow', {
      collections: ['code-docs', 'shared-memory-facts'],
      topK: 3,
    });
    expect(result.patterns).toBe(0);
    expect(result.context).toBe('');
    expect(result.error).toContain('Qdrant search failed');
  });

  test('non-trigger task short-circuits before any fetch', async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const result = await enrichTaskWithRAG('paint the fence beige');
    expect(result.patterns).toBe(0);
    expect(fetchCount).toBe(0);
  });

  test('research-shape payload (no sdk field) renders source path correctly', async () => {
    installMockFetch({
      'api.openai.com': () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
      '/collections/zouroboros-research/points/search': () => ({
        result: [{
          id: 'r1', score: 0.88,
          payload: {
            content: 'paper text on RAG',
            source: 'metagpt-hong-2023.pdf',
            chunk_index: 5,
          },
        }],
      }),
    });

    const result = await enrichTaskWithRAG('rag agent design', {
      collections: ['zouroboros-research'],
      topK: 1,
    });
    expect(result.patterns).toBe(1);
    expect(result.context).toContain('metagpt-hong-2023');
    expect(result.context).toContain('paper text on RAG');
  });
});
