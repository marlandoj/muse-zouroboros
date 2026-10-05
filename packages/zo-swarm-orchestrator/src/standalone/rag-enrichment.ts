/**
 * RAG Enrichment Module for Swarm Orchestrator
 * 
 * Automatically enriches task prompts with relevant SDK documentation
 * from the Agentic RAG system (19 indexed SDKs, 95 documents).
 * 
 * Uses OpenAI embeddings plus Qdrant for vector search.
 * 
 * Integration: Called from buildOptimizedPrompt() in orchestrate-v5.ts
 */

import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

// Self-heal: source .zo_secrets if OPENAI_API_KEY is missing
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || '/root/.zo_secrets', 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^export\s+(\w+)="?([^"]*)"?$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch { /* secrets file absent — caller must inject key */ }
}

interface RAGResult {
  content: string;
  sdk: string;
  source: string;
  score: number;
}

interface RAGEnrichmentOptions {
  topK?: number;
  minScore?: number;
  sdks?: string[]; // Filter to specific SDKs
  includeCode?: boolean;
}

// SDKs relevant to Zouroboros ecosystem
const ZOUROBOROS_SDKS = [
  'claude-sdk',
  'langchain',
  'openai-agents',
  'crewai',
  'adk',
  'llamaindex',
  'pydantic-ai',
  'autogen',
  'dspy',
  'instructor',
  'langgraph',
  'semantic-kernel',
  'hono',
  'mcp-sdk',
  'qdrant',
  'bun',
  'drizzle-orm',
  'stripe',
  'airtable',
];

// Keywords that trigger RAG lookup
const RAG_TRIGGER_KEYWORDS = [
  'agent', 'llm', 'model', 'embedding', 'vector', 'rag', 'memory',
  'api', 'route', 'middleware', 'validation', 'schema',
  'database', 'orm', 'query', 'migration',
  'payment', 'stripe', 'subscription',
  'workflow', 'orchestration', 'handoff', 'tool',
  'streaming', 'async', 'concurrent',
];

/**
 * Check if a task would benefit from RAG enrichment
 */
export function shouldEnrichWithRAG(taskText: string): boolean {
  const lowerText = taskText.toLowerCase();
  return RAG_TRIGGER_KEYWORDS.some(kw => lowerText.includes(kw));
}

/**
 * Get embedding from OpenAI
 */
async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
  
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`OpenAI embedding failed: ${response.status}`);
  }
  
  const data = await response.json() as { data?: Array<{ embedding: number[] }> };
  const vec = data.data?.[0]?.embedding;
  if (!vec || vec.length === 0) throw new Error('OpenAI returned empty embedding vector');
  return vec;
}

/**
 * Search Qdrant for relevant SDK documentation
 */
async function searchQdrant(
  embedding: number[],
  options: RAGEnrichmentOptions = {}
): Promise<RAGResult[]> {
  if (!embedding || embedding.length === 0) return [];
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantKey = process.env.QDRANT_API_KEY;
  
  if (!qdrantUrl) {
    throw new Error('QDRANT_URL not configured');
  }
  
  const topK = options.topK || 3;
  const minScore = options.minScore || 0.5;
  
  const response = await fetch(`${qdrantUrl}/collections/code-docs/points/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': qdrantKey || '',
    },
    body: JSON.stringify({
      vector: embedding,
      limit: topK,
      with_payload: true,
    }),
  });
  
  if (!response.ok) {
    throw new Error(`Qdrant search failed: ${response.status}`);
  }
  
  const data = await response.json() as {
    result: Array<{
      id: string;
      score: number;
      payload: { content: string; sdk: string; source: string };
    }>;
  };
  
  return data.result
    .filter(point => point.score >= minScore)
    .map(point => ({
      content: point.payload.content,
      sdk: point.payload.sdk,
      source: point.payload.source,
      score: point.score,
    }));
}

/**
 * Map SDK to Zouroboros context description
 */
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
  };
  return contexts[sdk] || 'SDK documentation';
}

/**
 * Format RAG results for prompt injection
 */
function formatRAGContext(results: RAGResult[]): string {
  if (results.length === 0) return '';
  
  const sections = results.map((r, i) => {
    const context = getZouroborosContext(r.sdk);
    return `### Pattern ${i + 1}: ${r.sdk} — ${r.source.replace('.md', '')}
**Relevance:** ${(r.score * 100).toFixed(1)}% | **Use Case:** ${context}

\`\`\`${r.sdk.startsWith('bun') || r.sdk === 'hono' || r.sdk === 'drizzle-orm' ? 'typescript' : 'python'}
${r.content.slice(0, 800)}${r.content.length > 800 ? '...' : ''}
\`\`\``;
  });
  
  return `## Relevant SDK Patterns from Zouroboros Knowledge Base

The following patterns may be helpful for this task. Use them as reference for implementation:

${sections.join('\n\n')}

---
`;
}

/**
 * Main enrichment function — call this from buildOptimizedPrompt()
 */
export async function enrichTaskWithRAG(
  taskText: string,
  options: RAGEnrichmentOptions = {}
): Promise<{ context: string; latencyMs: number; patterns: number }> {
  const startTime = Date.now();
  
  // Skip if task doesn't need enrichment
  if (!shouldEnrichWithRAG(taskText)) {
    return { context: '', latencyMs: 0, patterns: 0 };
  }
  
  try {
    // Generate embedding for task
    const embedding = await getEmbedding(taskText);
    
    // Search Qdrant
    const results = await searchQdrant(embedding, {
      topK: options.topK || 3,
      minScore: options.minScore || 0.5,
      ...options,
    });
    
    if (results.length === 0) {
      return { context: '', latencyMs: Date.now() - startTime, patterns: 0 };
    }
    
    // Format for prompt
    const context = formatRAGContext(results);
    
    return {
      context,
      latencyMs: Date.now() - startTime,
      patterns: results.length,
    };
  } catch (error) {
    // Fail silently — RAG enrichment is additive, not required
    console.log(`  [RAG] Enrichment failed (non-blocking): ${error}`);
    return { context: '', latencyMs: Date.now() - startTime, patterns: 0 };
  }
}

/**
 * Batch enrichment for multiple tasks (used in preflight)
 */
export async function prefetchRAGForTasks(
  tasks: Array<{ id: string; task: string }>
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  
  // Process in parallel with concurrency limit
  const concurrency = 3;
  const queue = [...tasks];
  
  async function processBatch() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (shouldEnrichWithRAG(item.task)) {
        const { context } = await enrichTaskWithRAG(item.task);
        if (context) {
          results.set(item.id, context);
        }
      }
    }
  }
  
  // Run batches in parallel
  await Promise.all(Array(concurrency).fill(null).map(processBatch));
  
  return results;
}

// CLI test mode
if (import.meta.main) {
  const testTask = process.argv[2] || 'Build a multi-agent workflow with handoffs using OpenAI Agents SDK';
  
  console.log('Testing RAG enrichment...\n');
  console.log(`Task: ${testTask}\n`);
  
  const { context, latencyMs, patterns } = await enrichTaskWithRAG(testTask, { topK: 3 });
  
  if (patterns > 0) {
    console.log(`✅ Found ${patterns} relevant patterns in ${latencyMs}ms\n`);
    console.log(context);
  } else {
    console.log('⚠️ No relevant patterns found');
  }
}
