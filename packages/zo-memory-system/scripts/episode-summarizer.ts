#!/usr/bin/env bun
import { generate as llmGenerate } from "./model-client";
/**
 * episode-summarizer.ts — Recursive Episode Summarization for Long Conversations
 * MEM-002: Recursive Episode Summarization
 *
 * When episode count exceeds threshold, oldest messages are summarized into
 * compressed episode records — preserving gist without token explosion.
 *
 * Usage:
 *   bun episode-summarizer.ts summarize --episodeIds <id1,id2,...> --outputTokens 800
 *   bun episode-summarizer.ts should-summarize --epCount 25 --threshold 20
 *   bun episode-summarizer.ts list-summaries
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EPISODE_WINDOW = 14 * 24 * 3600; // 14 days in seconds

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CompressedEpisode {
  id: string;
  summary: string;
  compressedFrom: string[];   // episode IDs that were compressed
  compressionRatio: number;    // tokens_saved / tokens_original
  originalTokenEstimate: number;
  compressedTokenEstimate: number;
  keyDecisions: string[];
  keyOutcomes: string[];
  createdAt: number;
}

export interface SummarizationResult {
  compressedEpisode: CompressedEpisode;
  originalCount: number;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
}

export interface EpisodeForCompression {
  id: string;
  summary: string;
  outcome: string;
  happenedAt: number;
  durationMs?: number;
  entities: string[];
  metadata?: Record<string, unknown>;
}

// ─── Database ─────────────────────────────────────────────────────────────────

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS compressed_episodes (
      id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      compressed_from TEXT NOT NULL,
      key_decisions TEXT NOT NULL DEFAULT '[]',
      key_outcomes TEXT NOT NULL DEFAULT '[]',
      original_token_estimate INTEGER NOT NULL DEFAULT 0,
      compressed_token_estimate INTEGER NOT NULL DEFAULT 0,
      compression_ratio REAL NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compressed_episodes_created ON compressed_episodes(created_at);
  `);
  return db;
}

// ─── Model-routed summarization ───────────────────────────────────────────────

async function generateSummary(episodes: EpisodeForCompression[]): Promise<{ summary: string; keyDecisions: string[]; keyOutcomes: string[] }> {
  const prompt = `You are compressing a sequence of conversation episodes into a single summary.

EPISODES TO COMPRESS (oldest first):
${episodes.map((e, i) => `[${i + 1}] (${e.outcome}) ${e.summary}`).join("\n")}

Generate a concise summary that preserves:
1. The overall arc and flow
2. Key decisions made and their rationale
3. Final outcomes
4. Any unresolved threads

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "summary": "2-3 sentence narrative of the full sequence",
  "keyDecisions": ["decision 1", "decision 2"],
  "keyOutcomes": ["outcome 1", "outcome 2"]
}`;

  const result = await llmGenerate({
    prompt,
    workload: "summarization",
    temperature: 0.3,
    maxTokens: 400,
  });
  const raw = result.content;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Failed to parse summary JSON: ${raw.slice(0, 200)}`);

  return JSON.parse(jsonMatch[0]);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── Core summarization logic ─────────────────────────────────────────────────

export async function compressEpisodes(
  episodeIds: string[],
  db?: Database
): Promise<SummarizationResult> {
  const _db = db || getDb();

  // Load episodes
  const episodes: EpisodeForCompression[] = [];
  for (const id of episodeIds) {
    const row = _db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) continue;
    const entities = (_db.prepare("SELECT entity FROM episode_entities WHERE episode_id = ?").all(id) as Array<{ entity: string }>).map(e => e.entity);
    episodes.push({
      id: row.id as string,
      summary: row.summary as string,
      outcome: row.outcome as string,
      happenedAt: row.happened_at as number,
      durationMs: row.duration_ms as number | undefined,
      entities,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    });
  }

  if (episodes.length === 0) throw new Error("No valid episodes found for compression");

  // Sort oldest first
  episodes.sort((a, b) => a.happenedAt - b.happenedAt);

  // Generate compressed summary via the configured summarization model
  const { summary, keyDecisions, keyOutcomes } = await generateSummary(episodes);

  // Compute compression stats
  const originalTokens = episodes.reduce((sum, e) => sum + estimateTokens(e.summary), 0);
  const compressedTokens = estimateTokens(summary);
  const compressionRatio = originalTokens > 0 ? Math.max(0, 1 - (compressedTokens / originalTokens)) : 0;

  // Store compressed episode
  const compressedId = `cmpe-${randomUUID().slice(0, 8)}`;
  const nowSec = Math.floor(Date.now() / 1000);

  _db.prepare(`
    INSERT INTO compressed_episodes
      (id, summary, compressed_from, key_decisions, key_outcomes, original_token_estimate, compressed_token_estimate, compression_ratio, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    compressedId,
    summary,
    JSON.stringify(episodeIds),
    JSON.stringify(keyDecisions),
    JSON.stringify(keyOutcomes),
    originalTokens,
    compressedTokens,
    compressionRatio,
    nowSec
  );

  const compressedEpisode: CompressedEpisode = {
    id: compressedId,
    summary,
    compressedFrom: episodeIds,
    compressionRatio,
    originalTokenEstimate: originalTokens,
    compressedTokenEstimate: compressedTokens,
    keyDecisions,
    keyOutcomes,
    createdAt: nowSec,
  };

  return {
    compressedEpisode,
    originalCount: episodes.length,
    originalTokens,
    compressedTokens,
    compressionRatio,
  };
}

export function getCompressedEpisode(compressedId: string, db?: Database): CompressedEpisode | null {
  const _db = db || getDb();
  const row = _db.prepare("SELECT * FROM compressed_episodes WHERE id = ?").get(compressedId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    summary: row.summary as string,
    compressedFrom: JSON.parse(row.compressed_from as string),
    compressionRatio: row.compression_ratio as number,
    originalTokenEstimate: row.original_token_estimate as number,
    compressedTokenEstimate: row.compressed_token_estimate as number,
    keyDecisions: JSON.parse(row.key_decisions as string),
    keyOutcomes: JSON.parse(row.key_outcomes as string),
    createdAt: row.created_at as number,
  };
}

export function listCompressedEpisodes(limit = 20, db?: Database): CompressedEpisode[] {
  const _db = db || getDb();
  const rows = _db.prepare("SELECT * FROM compressed_episodes ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row.id as string,
    summary: row.summary as string,
    compressedFrom: JSON.parse(row.compressed_from as string),
    compressionRatio: row.compression_ratio as number,
    originalTokenEstimate: row.original_token_estimate as number,
    compressedTokenEstimate: row.compressed_token_estimate as number,
    keyDecisions: JSON.parse(row.key_decisions as string),
    keyOutcomes: JSON.parse(row.key_outcomes as string),
    createdAt: row.created_at as number,
  }));
}

// ─── Threshold check ─────────────────────────────────────────────────────────

export interface ShouldSummarizeResult {
  shouldCompress: boolean;
  reason: string;
  oldestEpisodes?: string[];
  oldestTimestamp?: number;
}

export function shouldSummarize(count: number, threshold: number = 20, db?: Database): ShouldSummarizeResult {
  if (count <= threshold) {
    return { shouldCompress: false, reason: `Episode count ${count} is below threshold ${threshold}` };
  }

  const _db = db || getDb();
  const cutoff = Math.floor(Date.now() / 1000) - EPISODE_WINDOW;
  const oldEps = _db.prepare(
    "SELECT id, happened_at FROM episodes WHERE happened_at < ? ORDER BY happened_at ASC LIMIT ?"
  ).all(cutoff, Math.min(count - threshold + 1, 50)) as Array<{ id: string; happened_at: number }>;

  if (oldEps.length === 0) {
    return { shouldCompress: false, reason: "No episodes older than 14 days to compress" };
  }

  return {
    shouldCompress: true,
    reason: `${oldEps.length} episodes exceed window threshold`,
    oldestEpisodes: oldEps.map(e => e.id),
    oldestTimestamp: oldEps[0]?.happened_at,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`Episode Summarizer CLI - v1.0

Commands:
  should-summarize --count <n> --threshold <n>
  summarize --episodeIds <id1,id2,...> --outputTokens <n>
  list-summaries
  show-summary <compressedId>
`);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "should-summarize": {
      let count = 0, threshold = 20;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--count" || args[i] === "-c") count = parseInt(args[i + 1] || "0");
        if (args[i] === "--threshold" || args[i] === "-t") threshold = parseInt(args[i + 1] || "20");
      }
      const result = shouldSummarize(count, threshold);
      console.log(`Should compress: ${result.shouldCompress}`);
      console.log(`Reason: ${result.reason}`);
      if (result.oldestEpisodes?.length) console.log(`Episode candidates: ${result.oldestEpisodes.length}`);
      break;
    }

    case "summarize": {
      let episodeIds: string[] = [];
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--episodeIds" || args[i] === "-e") {
          episodeIds = (args[i + 1] || "").split(",").map(s => s.trim()).filter(Boolean);
        }
      }
      if (episodeIds.length === 0) { console.error("No episode IDs provided"); process.exit(1); }
      console.log(`Compressing ${episodeIds.length} episodes...`);
      const result = await compressEpisodes(episodeIds);
      console.log(`\nCompressed Episode: ${result.compressedEpisode.id}`);
      console.log(`Summary: ${result.compressedEpisode.summary}`);
      console.log(`Decisions: ${result.compressedEpisode.keyDecisions.join(", ") || "(none)"}`);
      console.log(`Outcomes: ${result.compressedEpisode.keyOutcomes.join(", ") || "(none)"}`);
      console.log(`Compression: ${result.originalTokens}t -> ${result.compressedTokens}t (${Math.round(result.compressionRatio * 100)}% saved)`);
      break;
    }

    case "list-summaries": {
      const summaries = listCompressedEpisodes();
      if (summaries.length === 0) { console.log("No compressed episodes."); break; }
      console.log(`Compressed Episodes (${summaries.length})\n`);
      for (const s of summaries) {
        console.log(`[${s.id}] ${s.compressionRatio.toFixed(1)}% saved | ${s.compressedFrom.length} -> 1 episodes`);
        console.log(`  ${s.summary.slice(0, 120)}${s.summary.length > 120 ? "..." : ""}`);
        if (s.keyDecisions.length > 0) console.log(`  Decisions: ${s.keyDecisions.slice(0, 3).join(" | ")}`);
        if (s.keyOutcomes.length > 0) console.log(`  Outcomes: ${s.keyOutcomes.slice(0, 3).join(" | ")}`);
        console.log();
      }
      break;
    }

    case "show-summary": {
      const id = args[1];
      if (!id) { console.error("Provide a compressed episode ID"); process.exit(1); }
      const s = getCompressedEpisode(id);
      if (!s) { console.error(`Compressed episode not found: ${id}`); process.exit(1); }
      console.log(`Compressed Episode: ${s.id}`);
      console.log(`Created: ${new Date(s.createdAt * 1000).toISOString()}`);
      console.log(`Compression: ${s.originalTokenEstimate}t -> ${s.compressedTokenEstimate}t (${Math.round(s.compressionRatio * 100)}% saved)`);
      console.log(`\nSummary:\n${s.summary}`);
      if (s.keyDecisions.length > 0) console.log(`\nKey Decisions: ${s.keyDecisions.join(", ")}`);
      if (s.keyOutcomes.length > 0) console.log(`Key Outcomes: ${s.keyOutcomes.join(", ")}`);
      console.log(`\nCompressed from ${s.compressedFrom.length} episodes: ${s.compressedFrom.join(", ")}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

if (import.meta.main) main();
