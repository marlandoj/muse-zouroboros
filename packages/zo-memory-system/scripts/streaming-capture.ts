#!/usr/bin/env bun
/**
 * streaming-capture.ts — Real-Time Incremental Fact Extraction (Phase 4.3)
 *
 * Buffers text from swarm task outputs and conversation turns, then runs
 * lightweight extraction via the configured capture workload at threshold. Facts are stored
 * with provisional flag and 0.7x search ranking weight until batch
 * reconciliation promotes or supersedes them.
 *
 * Usage:
 *   import { captureStreaming, reconcileProvisional } from "./streaming-capture.ts";
 *   await captureStreaming(output, { runId, taskId, category });
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { autoCorrectWikilinks } from "./wikilink-utils";
import { generate as mcGenerate, embeddings as mcEmbeddings } from "./model-client";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";

// Buffer thresholds per seed spec
const TOKEN_THRESHOLD = 2000;
const TURN_THRESHOLD = 3;
const EXTRACTION_TIMEOUT_MS = 10_000;
const CONFIDENCE_FLOOR = 0.8;

// In-memory buffers keyed by runId
const buffers = new Map<string, StreamingCaptureBuffer>();

interface StreamingCaptureBuffer {
  runId: string;
  chunks: string[];
  tokenEstimate: number;
  turnCount: number;
  lastFlush: number;
}

interface CaptureContext {
  runId: string;
  taskId?: string;
  category?: string;
}

interface ProvisionalFact {
  entity: string;
  key: string;
  value: string;
  confidence: number;
}

/**
 * Estimate token count (rough: 1 token ~ 4 chars)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * SHA-256 content hash for dedup
 */
function contentHash(entity: string, key: string, value: string): string {
  return createHash("sha256").update(`${entity}:${key}:${value}`).digest("hex").slice(0, 16);
}

/**
 * Main entry point: buffer text and extract when thresholds are met.
 * Fully async and non-blocking.
 */
export async function captureStreaming(
  text: string,
  context: CaptureContext,
): Promise<number> {
  if (!text || text.length < 50) return 0;

  let buffer = buffers.get(context.runId);
  if (!buffer) {
    buffer = {
      runId: context.runId,
      chunks: [],
      tokenEstimate: 0,
      turnCount: 0,
      lastFlush: Date.now(),
    };
    buffers.set(context.runId, buffer);
  }

  buffer.chunks.push(text);
  buffer.tokenEstimate += estimateTokens(text);
  buffer.turnCount++;

  // Check thresholds
  if (buffer.tokenEstimate >= TOKEN_THRESHOLD || buffer.turnCount >= TURN_THRESHOLD) {
    const combined = buffer.chunks.join("\n\n---\n\n");
    // Reset buffer
    buffer.chunks = [];
    buffer.tokenEstimate = 0;
    buffer.turnCount = 0;
    buffer.lastFlush = Date.now();

    return await extractAndStore(combined, context);
  }

  return 0;
}

/**
 * Force flush any remaining buffered text for a run (call at run end).
 */
export async function flushBuffer(runId: string, context: CaptureContext): Promise<number> {
  const buffer = buffers.get(runId);
  if (!buffer || buffer.chunks.length === 0) return 0;

  const combined = buffer.chunks.join("\n\n---\n\n");
  buffers.delete(runId);

  return await extractAndStore(combined, context);
}

/**
 * Extract facts via lightweight LLM and store with provisional flag.
 */
async function extractAndStore(text: string, context: CaptureContext): Promise<number> {
  const prompt = `Extract factual statements from this text. Return JSON array of objects with "entity", "key", "value", "confidence" (0.0-1.0) fields.

Rules:
- entity: the subject (project name, tool, person, concept)
- key: the attribute or relationship type
- value: the factual content
- confidence: how certain the fact is (skip below 0.8)
- Only extract concrete, specific facts — skip opinions and vague statements
- Maximum 5 facts per extraction

Text:
${text.slice(0, 3000)}

Respond with ONLY a JSON array:`;

  let facts: ProvisionalFact[] = [];
  try {
    const result = await Promise.race([
      mcGenerate({
        prompt,
        workload: "capture",
        temperature: 0.1,
        maxTokens: 512,
        json: true,
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("extraction timeout")), EXTRACTION_TIMEOUT_MS)
      ),
    ]);

    const jsonMatch = result.content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ProvisionalFact[];
      facts = parsed.filter(f =>
        f.entity && f.key && f.value &&
        typeof f.confidence === "number" && f.confidence >= CONFIDENCE_FLOOR
      );
    }
  } catch {
    return 0;
  }

  if (facts.length === 0) return 0;

  // Store with provisional flag
  const db = new Database(DB_PATH);
  let stored = 0;

  for (const fact of facts) {
    const hash = contentHash(fact.entity, fact.key, fact.value);

    // Dedup check
    const existing = db.prepare(
      "SELECT id FROM facts WHERE entity = ? AND key = ? AND content_hash = ?"
    ).get(fact.entity, fact.key, hash);
    if (existing) continue;

    // Auto-correct wikilinks
    const corrected = autoCorrectWikilinks(fact.value, db);
    const storeValue = corrected?.corrected_value ?? fact.value;

    const id = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    const metadata = JSON.stringify({
      provisional: true,
      source_run_id: context.runId,
      task_id: context.taskId,
      category: context.category,
      confidence: fact.confidence,
      captured_at: nowSec,
    });

    try {
      db.prepare(`
        INSERT INTO facts (id, entity, key, value, source, confidence, content_hash, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, fact.entity, fact.key, storeValue, `streaming:${context.runId}`, fact.confidence, hash, metadata, nowSec);
      stored++;
    } catch {
      // Likely unique constraint or missing column — skip
    }
  }

  if (stored > 0) {
    console.log(`  [streaming-capture] Stored ${stored} provisional facts from ${context.runId}`);
  }

  db.close();
  return stored;
}

/**
 * Batch reconciliation: promote or supersede provisional facts.
 * Called at end of a run by auto-capture.ts or manually.
 *
 * Logic: For each provisional fact, check if a non-provisional fact with same
 * entity+key exists. If yes and values match -> promote (remove provisional flag).
 * If yes and values differ -> supersede (delete provisional).
 * If no match -> keep provisional (will be promoted on next batch capture).
 */
export function reconcileProvisional(runId: string): { promoted: number; superseded: number; kept: number } {
  const db = new Database(DB_PATH);
  let promoted = 0, superseded = 0, kept = 0;

  try {
    const provisionalFacts = db.prepare(`
      SELECT id, entity, key, value FROM facts
      WHERE json_extract(metadata, '$.provisional') = 1
      AND json_extract(metadata, '$.source_run_id') = ?
    `).all(runId) as Array<{ id: string; entity: string; key: string; value: string }>;

    for (const pf of provisionalFacts) {
      const authoritative = db.prepare(`
        SELECT id, value FROM facts
        WHERE entity = ? AND key = ?
        AND (json_extract(metadata, '$.provisional') IS NULL OR json_extract(metadata, '$.provisional') = 0)
        ORDER BY created_at DESC LIMIT 1
      `).get(pf.entity, pf.key) as { id: string; value: string } | null;

      if (authoritative) {
        if (authoritative.value === pf.value) {
          // Promote: remove provisional flag
          db.prepare(`
            UPDATE facts SET metadata = json_set(metadata, '$.provisional', 0) WHERE id = ?
          `).run(pf.id);
          promoted++;
        } else {
          // Supersede: authoritative wins, delete provisional
          db.prepare("DELETE FROM facts WHERE id = ?").run(pf.id);
          superseded++;
        }
      } else {
        kept++;
      }
    }
  } catch {
    // Tables may not have json_extract support or metadata column
  }

  db.close();
  return { promoted, superseded, kept };
}

/**
 * Get streaming quality ratio for monitoring.
 */
export function getStreamingQualityRatio(runId?: string): number {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const whereClause = runId
      ? `AND json_extract(metadata, '$.source_run_id') = '${runId}'`
      : "";

    const total = (db.prepare(`
      SELECT COUNT(*) as cnt FROM facts
      WHERE json_extract(metadata, '$.source_run_id') IS NOT NULL ${whereClause}
    `).get() as { cnt: number })?.cnt || 0;

    const promoted = (db.prepare(`
      SELECT COUNT(*) as cnt FROM facts
      WHERE json_extract(metadata, '$.source_run_id') IS NOT NULL
      AND (json_extract(metadata, '$.provisional') IS NULL OR json_extract(metadata, '$.provisional') = 0)
      ${whereClause}
    `).get() as { cnt: number })?.cnt || 0;

    db.close();
    return total > 0 ? promoted / total : 0;
  } catch {
    db.close();
    return 0;
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "reconcile" && args[1]) {
    const result = reconcileProvisional(args[1]);
    console.log(`Reconciliation for ${args[1]}:`, result);
  } else if (args[0] === "quality") {
    const ratio = getStreamingQualityRatio(args[1]);
    console.log(`Streaming quality ratio: ${ratio.toFixed(2)}`);
  } else {
    console.log("Usage:");
    console.log("  bun streaming-capture.ts reconcile <run_id>  — Reconcile provisional facts");
    console.log("  bun streaming-capture.ts quality [run_id]    — Show streaming quality ratio");
  }
}
