import {
  createHttpCandidateRetrievalDependencies,
  retrieveCandidate,
  type CandidateRetrievalDependencies,
  type CandidateRetrievalStatus,
} from 'zouroboros-rag';
import { emitRAGTelemetry } from './telemetry.js';

export type CandidateInputClassification = 'public' | 'private' | 'unknown';

export interface CandidateShadowEvidence {
  enabled: boolean;
  attempted: boolean;
  classification: CandidateInputClassification;
  collection?: string;
  status: CandidateRetrievalStatus | 'disabled' | 'not_public' | 'misconfigured';
  candidateRankingIds: string[];
  candidateHitCount: number;
  candidateLatencyMs: number;
  candidateBudgetMs: number;
  resultConsumed: false;
  cleanupComplete: boolean;
  error?: string;
}

export interface CandidateShadowOptions {
  enabled?: boolean;
  classification?: CandidateInputClassification;
  collection?: string;
  budgetMs?: number;
  topK?: number;
  minScore?: number;
  dependencies?: CandidateRetrievalDependencies;
  onEvidence?: (evidence: CandidateShadowEvidence) => void | Promise<void>;
}

function envEnabled(): boolean {
  return process.env.MODAL_RAG_SHADOW_ENABLED === '1';
}

export function isCandidateShadowEnabled(options?: CandidateShadowOptions): boolean {
  return options?.enabled ?? envEnabled();
}

async function recordEvidence(
  evidence: CandidateShadowEvidence,
  options: CandidateShadowOptions,
): Promise<CandidateShadowEvidence> {
  await Promise.allSettled([
    emitRAGTelemetry({
      candidateShadowEnabled: evidence.enabled,
      candidateShadowAttempted: evidence.attempted,
      candidateInputClassification: evidence.classification,
      candidateCollection: evidence.collection,
      candidateStatus: evidence.status,
      candidateLatencyMs: evidence.candidateLatencyMs,
      candidateBudgetMs: evidence.candidateBudgetMs,
      candidateHits: evidence.candidateHitCount,
      candidateResultConsumed: evidence.resultConsumed,
      candidateCleanupComplete: evidence.cleanupComplete,
      candidateError: evidence.error,
    }),
    Promise.resolve(options.onEvidence?.(evidence)),
  ]);
  return evidence;
}

export async function runRagShadowComparison(
  taskText: string,
  options: CandidateShadowOptions = {},
): Promise<CandidateShadowEvidence> {
  const enabled = isCandidateShadowEnabled(options);
  const classification = options.classification ?? 'unknown';
  const budgetMs = options.budgetMs ?? 750;
  if (!enabled) {
    return {
      enabled: false,
      attempted: false,
      classification,
      collection: options.collection,
      status: 'disabled',
      candidateRankingIds: [],
      candidateHitCount: 0,
      candidateLatencyMs: 0,
      candidateBudgetMs: budgetMs,
      resultConsumed: false,
      cleanupComplete: false,
    };
  }
  if (classification !== 'public') {
    return recordEvidence({
      enabled: true,
      attempted: false,
      classification,
      collection: options.collection,
      status: 'not_public',
      candidateRankingIds: [],
      candidateHitCount: 0,
      candidateLatencyMs: 0,
      candidateBudgetMs: budgetMs,
      resultConsumed: false,
      cleanupComplete: false,
      error: 'Candidate shadow requires an explicit public classification',
    }, options);
  }
  const collection = options.collection ?? process.env.MODAL_RAG_CANDIDATE_COLLECTION;
  if (!collection) {
    return recordEvidence({
      enabled: true,
      attempted: false,
      classification,
      status: 'misconfigured',
      candidateRankingIds: [],
      candidateHitCount: 0,
      candidateLatencyMs: 0,
      candidateBudgetMs: budgetMs,
      resultConsumed: false,
      cleanupComplete: false,
      error: 'MODAL_RAG_CANDIDATE_COLLECTION is not configured',
    }, options);
  }

  const candidate = await retrieveCandidate({
    query: taskText,
    classification: 'public',
    collection,
    budgetMs,
    topK: options.topK,
    minScore: options.minScore,
  }, options.dependencies ?? createHttpCandidateRetrievalDependencies());

  return recordEvidence({
    enabled: true,
    attempted: true,
    classification,
    collection,
    status: candidate.status,
    candidateRankingIds: candidate.hits.map((hit) => hit.source),
    candidateHitCount: candidate.hits.length,
    candidateLatencyMs: candidate.latencyMs,
    candidateBudgetMs: candidate.budgetMs,
    resultConsumed: false,
    cleanupComplete: candidate.cleanupComplete,
    error: candidate.error,
  }, options);
}
