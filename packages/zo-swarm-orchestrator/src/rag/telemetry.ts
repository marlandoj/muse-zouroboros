/**
 * RAG Telemetry Sink
 *
 * Emits per-enrichment-call JSONL records to /dev/shm/rag-telemetry.jsonl.
 * Non-blocking, fire-and-forget. Failures are swallowed.
 *
 * Each record captures: trigger match, collections queried, per-collection
 * top score, merged topK, latency breakdown, pattern count.
 *
 * Consumed by the /api/rag-telemetry zo.space route and the
 * /dashboard/rag-telemetry page.
 */
import { appendFile } from 'fs/promises';

export interface RAGTelemetryRecord {
  ts: string;
  taskId?: string;
  taskTextHead: string;
  triggered: boolean;
  triggerKeywords: string[];
  collectionsQueried: string[];
  perCollectionTopScore: Record<string, number>;
  perCollectionHits: Record<string, number>;
  mergedTopK: number;
  topScore: number;
  patterns: number;
  embedLatencyMs: number;
  searchLatencyMs: number;
  totalLatencyMs: number;
  errored: boolean;
  errorMsg?: string;
  runId?: string;
  condition?: string;
}

const TELEMETRY_PATH = process.env.RAG_TELEMETRY_PATH || '/dev/shm/rag-telemetry.jsonl';
const TELEMETRY_DISABLED = process.env.RAG_TELEMETRY_DISABLED === '1';

export async function emitRAGTelemetry(record: Partial<RAGTelemetryRecord>): Promise<void> {
  if (TELEMETRY_DISABLED) return;
  const full: RAGTelemetryRecord = {
    ts: new Date().toISOString(),
    taskTextHead: '',
    triggered: false,
    triggerKeywords: [],
    collectionsQueried: [],
    perCollectionTopScore: {},
    perCollectionHits: {},
    mergedTopK: 0,
    topScore: 0,
    patterns: 0,
    embedLatencyMs: 0,
    searchLatencyMs: 0,
    totalLatencyMs: 0,
    errored: false,
    runId: process.env.RAG_RUN_ID,
    condition: process.env.RAG_CONDITION,
    ...record,
  };
  try {
    await appendFile(TELEMETRY_PATH, JSON.stringify(full) + '\n', 'utf8');
  } catch {
    // swallow — telemetry must never break the enrichment path
  }
}

export function matchedKeywords(taskText: string, keywords: string[]): string[] {
  const lower = taskText.toLowerCase();
  return keywords.filter(kw => lower.includes(kw));
}
