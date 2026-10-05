/**
 * RAG Enrichment Module for Swarm Orchestrator
 *
 * Enriches task prompts with relevant documentation from one or more
 * Qdrant collections. Default whitelist covers the full local 1536d
 * corpus: `zouroboros-research` (RAPTOR L1+L2 papers),
 * `zouroboros-code` (workspace code), `shared-memory-facts` (memory),
 * `commerce-a-knowledge` (vertical business knowledge), and `code-docs`
 * (SDK docs). Override via `options.collections` or `RAG_COLLECTIONS`
 * env (comma-separated).
 *
 * Embeds with OpenAI `text-embedding-3-small` (1536d). All five
 * collections were unified to 1536d by the 2026-05-03 re-index after
 * the embedding default migration.
 */
import { readFileSync } from 'fs';
import { emitRAGTelemetry, matchedKeywords } from './telemetry.js';
import {
  isCandidateShadowEnabled,
  runRagShadowComparison,
  type CandidateShadowOptions,
} from './shadow-comparator.js';

// Self-heal: source zouroboros.env if OPENAI_API_KEY is missing (supports out-of-process callers)
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || '/etc/zouroboros/zouroboros.env', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^(?:export\s+)?(\w+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["\u0027]|["\u0027]$/g, "");
    }
  } catch { /* secrets file absent — caller must inject key */ }
}

export interface RAGResult {
  content: string;
  sdk: string;
  source: string;
  score: number;
  collection: string;
}

export interface RAGEnrichmentOptions {
  topK?: number;
  minScore?: number;
  sdks?: string[];
  includeCode?: boolean;
  collections?: string[];
  candidateShadow?: CandidateShadowOptions;
}

// VPS migration: pruned 'zouroboros-research' and 'commerce-a-knowledge'
// (no indexers or corpora on host); re-add if those corpora are rebuilt.
const DEFAULT_COLLECTIONS = [
  'zouroboros-code',
  'shared-memory-facts',
  'code-docs',
];

const RAG_TRIGGER_KEYWORDS = [
  'agent', 'llm', 'model', 'embedding', 'vector', 'rag', 'memory',
  'api', 'route', 'middleware', 'validation', 'schema',
  'database', 'orm', 'query', 'migration',
  'payment', 'stripe', 'subscription',
  'workflow', 'orchestration', 'handoff', 'tool',
  'streaming', 'async', 'concurrent',
];

export function shouldEnrichWithRAG(taskText: string): boolean {
  const lowerText = taskText.toLowerCase();
  return RAG_TRIGGER_KEYWORDS.some(kw => lowerText.includes(kw));
}

export function resolveCollections(options: RAGEnrichmentOptions = {}): string[] {
  if (options.collections && options.collections.length > 0) {
    return options.collections;
  }
  const envList = process.env.RAG_COLLECTIONS;
  if (envList) {
    const parsed = envList.split(',').map(s => s.trim()).filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_COLLECTIONS;
}

async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!response.ok) throw new Error(`OpenAI embedding failed: ${response.status}`);
  const data = await response.json() as { data?: Array<{ embedding: number[] }> };
  const vec = data.data?.[0]?.embedding;
  if (!vec || vec.length === 0) throw new Error('OpenAI returned empty embedding vector');
  return vec;
}

const DEFAULT_QDRANT_URL = 'http://100.69.35.3:6333';

async function searchQdrantCollection(
  collection: string,
  embedding: number[],
  options: RAGEnrichmentOptions,
): Promise<RAGResult[]> {
  const qdrantUrl = process.env.QDRANT_URL || DEFAULT_QDRANT_URL;
  const qdrantKey = process.env.QDRANT_API_KEY;

  const topK = options.topK ?? 3;
  const minScore = options.minScore ?? 0.5;

  const response = await fetch(`${qdrantUrl}/collections/${collection}/points/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': qdrantKey || '',
    },
    body: JSON.stringify({ vector: embedding, limit: topK, with_payload: true }),
  });
  if (!response.ok) throw new Error(`Qdrant search failed (${collection}): ${response.status}`);

  const data = await response.json() as {
    result: Array<{
      id: string;
      score: number;
      payload: Record<string, unknown>;
    }>;
  };

  return data.result
    .filter(point => point.score >= minScore)
    .map(point => {
      const p = point.payload || {};
      const content = typeof p.content === 'string' ? p.content : '';
      const sdk = typeof p.sdk === 'string' ? p.sdk : collection;
      const source = typeof p.source === 'string'
        ? p.source
        : (typeof p.source_path === 'string' ? String(p.source_path) : `${collection}#${point.id}`);
      return { content, sdk, source, score: point.score, collection };
    })
    .filter(r => r.content.length > 0);
}

interface MultiSearchOutput {
  merged: RAGResult[];
  perCollectionHits: Record<string, number>;
  perCollectionTopScore: Record<string, number>;
  perCollectionErrors: Record<string, string>;
}

export interface IncumbentRAGRetrieval {
  results: RAGResult[];
  rankingIds: string[];
  perCollectionHits: Record<string, number>;
  perCollectionTopScore: Record<string, number>;
  perCollectionErrors: Record<string, string>;
  embedLatencyMs: number;
  searchLatencyMs: number;
}

export async function retrieveIncumbentRAG(
  taskText: string,
  options: RAGEnrichmentOptions = {},
): Promise<IncumbentRAGRetrieval> {
  const collections = resolveCollections(options);
  const embedStart = Date.now();
  const embedding = await getEmbedding(taskText);
  const embedLatencyMs = Date.now() - embedStart;
  const searchStart = Date.now();
  const searched = await searchQdrantMulti(collections, embedding, options);
  const searchLatencyMs = Date.now() - searchStart;
  return {
    results: searched.merged,
    rankingIds: searched.merged.map((result) => result.source),
    perCollectionHits: searched.perCollectionHits,
    perCollectionTopScore: searched.perCollectionTopScore,
    perCollectionErrors: searched.perCollectionErrors,
    embedLatencyMs,
    searchLatencyMs,
  };
}

async function searchQdrantMulti(
  collections: string[],
  embedding: number[],
  options: RAGEnrichmentOptions,
): Promise<MultiSearchOutput> {
  if (!embedding || embedding.length === 0) {
    return { merged: [], perCollectionHits: {}, perCollectionTopScore: {}, perCollectionErrors: { _empty: 'Empty embedding vector — skipping Qdrant' } };
  }
  const settled = await Promise.allSettled(
    collections.map(c => searchQdrantCollection(c, embedding, options)),
  );

  const perCollectionHits: Record<string, number> = {};
  const perCollectionTopScore: Record<string, number> = {};
  const perCollectionErrors: Record<string, string> = {};
  const all: RAGResult[] = [];

  settled.forEach((s, i) => {
    const c = collections[i];
    if (s.status === 'fulfilled') {
      perCollectionHits[c] = s.value.length;
      perCollectionTopScore[c] = s.value[0]?.score ?? 0;
      all.push(...s.value);
    } else {
      perCollectionHits[c] = 0;
      perCollectionTopScore[c] = 0;
      perCollectionErrors[c] = String(s.reason);
    }
  });

  const topK = options.topK ?? 3;
  const merged = all.sort((a, b) => b.score - a.score).slice(0, topK);

  return { merged, perCollectionHits, perCollectionTopScore, perCollectionErrors };
}

function getZouroborosContext(sdk: string): string {
  const contexts: Record<string, string> = {
    'claude-sdk': 'Anthropic Claude API for complex reasoning and agent responses',
    'langchain': 'Workflow composition and chain orchestration',
    'openai-agents': 'Lightweight multi-agent with handoffs and tools',
    'crewai': 'Role-based agent teams for project workflows',
    'adk': 'Google ADK with built-in tool integrations',
    'llamaindex': 'Advanced RAG with document indexing and retrieval',
    'pydantic-ai': 'Type-safe structured outputs with validation',
    'autogen': 'Conversational agents with code execution',
    'dspy': 'Prompt optimization and programmatic LLM control',
    'instructor': 'Structured outputs with retry logic',
    'langgraph': 'State machine-based agent workflows',
    'semantic-kernel': 'Microsoft AI SDK for enterprise integration',
    'hono': 'Fast, lightweight web framework for Zo Space APIs',
    'mcp-sdk': 'Model Context Protocol for AI tool integration',
    'qdrant': 'Vector database for embeddings and semantic search',
    'bun': 'Fast JavaScript/TypeScript runtime',
    'drizzle-orm': 'Type-safe SQL-like ORM for database operations',
    'stripe': 'Payment processing and subscription management',
    'airtable': 'Database and CRM integration',
    'zouroboros-research': 'Peer-reviewed research papers (RAPTOR L1+L2 hierarchy)',
    'zouroboros-code': 'Workspace code patterns indexed from Skills/, packages/, and Projects/',
    'shared-memory-facts': 'Long-term facts captured by the shared zo-memory pipeline',
    'commerce-a-knowledge': 'Commerce vertical business knowledge (brand, SKUs, ops)',
    'code-docs': 'SDK and library documentation (Hono, Bun, Drizzle, Stripe, etc.)',
  };
  return contexts[sdk] || 'Knowledge base';
}

function formatRAGContext(results: RAGResult[]): string {
  if (results.length === 0) return '';

  const sections = results.map((r, i) => {
    const context = getZouroborosContext(r.sdk);
    const isTypescript = r.sdk.startsWith('bun') || r.sdk === 'hono' || r.sdk === 'drizzle-orm';
    const isResearch = r.collection === 'zouroboros-research';
    const lang = isResearch ? 'text' : (isTypescript ? 'typescript' : 'python');
    return `### Pattern ${i + 1}: ${r.sdk} — ${r.source.replace('.md', '')}
**Relevance:** ${(r.score * 100).toFixed(1)}% | **Use Case:** ${context}

\`\`\`${lang}
${r.content.slice(0, 800)}${r.content.length > 800 ? '...' : ''}
\`\`\``;
  });

  return `## Relevant Knowledge from Zouroboros Knowledge Base

The following patterns may be helpful for this task. Use them as reference for implementation:

${sections.join('\n\n')}

---
`;
}

export async function enrichTaskWithRAG(
  taskText: string,
  options: RAGEnrichmentOptions = {},
): Promise<{ context: string; latencyMs: number; patterns: number; error?: string }> {
  const startTime = Date.now();
  const triggered = shouldEnrichWithRAG(taskText);
  const triggerKeywords = matchedKeywords(taskText, RAG_TRIGGER_KEYWORDS);
  const taskTextHead = taskText.slice(0, 120);
  const collections = resolveCollections(options);

  if (!triggered) {
    void emitRAGTelemetry({
      taskTextHead,
      triggered: false,
      triggerKeywords,
      collectionsQueried: collections,
      totalLatencyMs: 0,
    });
    return { context: '', latencyMs: 0, patterns: 0 };
  }

  if (isCandidateShadowEnabled(options.candidateShadow)) {
    void runRagShadowComparison(taskText, options.candidateShadow).catch(() => undefined);
  }

  let embedLatencyMs = 0;
  let searchLatencyMs = 0;
  try {
    const incumbent = await retrieveIncumbentRAG(taskText, options);
    const {
      results: merged,
      perCollectionHits,
      perCollectionTopScore,
      perCollectionErrors,
    } = incumbent;
    embedLatencyMs = incumbent.embedLatencyMs;
    searchLatencyMs = incumbent.searchLatencyMs;

    const topScore = merged[0]?.score ?? 0;
    const hits = merged.length;
    const totalLatencyMs = Date.now() - startTime;
    const errored = Object.keys(perCollectionErrors).length === collections.length;
    const errorMsg = Object.keys(perCollectionErrors).length > 0
      ? Object.entries(perCollectionErrors).map(([c, e]) => `${c}: ${e}`).join('; ')
      : undefined;

    void emitRAGTelemetry({
      taskTextHead,
      triggered: true,
      triggerKeywords,
      collectionsQueried: collections,
      perCollectionTopScore,
      perCollectionHits,
      mergedTopK: hits,
      topScore,
      patterns: hits,
      embedLatencyMs,
      searchLatencyMs,
      totalLatencyMs,
      errored,
      errorMsg,
    });

    if (hits === 0) {
      return { context: '', latencyMs: totalLatencyMs, patterns: 0, error: errorMsg };
    }

    const context = formatRAGContext(merged);
    return { context, latencyMs: totalLatencyMs, patterns: hits, error: errorMsg };
  } catch (error) {
    const totalLatencyMs = Date.now() - startTime;
    void emitRAGTelemetry({
      taskTextHead,
      triggered: true,
      triggerKeywords,
      collectionsQueried: collections,
      embedLatencyMs,
      searchLatencyMs,
      totalLatencyMs,
      errored: true,
      errorMsg: String(error),
    });
    console.log(`  [RAG] Enrichment failed (non-blocking): ${error}`);
    return { context: '', latencyMs: totalLatencyMs, patterns: 0, error: String(error) };
  }
}

export async function prefetchRAGForTasks(
  tasks: Array<{ id: string; task: string }>,
  options: RAGEnrichmentOptions = {},
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const concurrency = 3;
  const queue = [...tasks];

  async function processBatch() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (shouldEnrichWithRAG(item.task)) {
        const { context } = await enrichTaskWithRAG(item.task, options);
        if (context) results.set(item.id, context);
      }
    }
  }

  await Promise.all(Array(concurrency).fill(null).map(processBatch));
  return results;
}
