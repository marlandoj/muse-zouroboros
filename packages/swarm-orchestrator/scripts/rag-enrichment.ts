/**
 * RAG Enrichment Module — production CLI re-export.
 *
 * Collapsed 2026-05-01 (Q2 #3 Cycle 1.A). The canonical implementation
 * with multi-collection support and telemetry now lives at
 * `../src/rag/enrichment.ts`. This sibling is preserved so existing
 * imports in `scripts/orchestrate-v5.ts` continue to resolve.
 *
 * Prior to collapse this file hardcoded `code-docs` (768d) and silently
 * 400'd in production after the embedding migration to OpenAI 1536d
 * (PR #82, 2026-04-23).
 */

export {
  shouldEnrichWithRAG,
  enrichTaskWithRAG,
  prefetchRAGForTasks,
  resolveCollections,
  type RAGEnrichmentOptions,
} from '../src/rag/index.js';
