export {
  shouldEnrichWithRAG,
  enrichTaskWithRAG,
  prefetchRAGForTasks,
  retrieveIncumbentRAG,
  resolveCollections,
  type IncumbentRAGRetrieval,
  type RAGResult,
  type RAGEnrichmentOptions,
} from './enrichment.js';

export {
  detectDomain,
  fetchDomainContext,
  enrichTasksWithDomainContext,
} from './domain-context.js';

export {
  emitRAGTelemetry,
  matchedKeywords,
  type RAGTelemetryRecord,
} from './telemetry.js';

export {
  isCandidateShadowEnabled,
  runRagShadowComparison,
  type CandidateInputClassification,
  type CandidateShadowEvidence,
  type CandidateShadowOptions,
} from './shadow-comparator.js';
