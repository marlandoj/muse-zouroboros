#!/usr/bin/env bun
/**
 * mimir-synthesize.ts — Karpathy 2nd Brain layer for Mimir persona
 *
 * Three capabilities layered on top of Zouroboros retrieval:
 *   1. Librarian synthesis — LLM reads retrieved facts + question → narrative answer
 *   2. Feedback loop — extracts new facts from Q&A, stores back to mimir.db
 *   3. Auto-backlinks — links new facts to existing entities via fact_links
 *
 * Only invoked when persona === "mimir". Other personas are unaffected.
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { generate as mcGenerate, embeddings as mcEmbeddings } from "./model-client";

const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";

const MIN_RELEVANCE_SCORE = 0.35;

// ── Synthesis cache (avoids repeated LLM calls for identical Q+facts) ──────
// Key: sha256(question + filtered_facts)
// TTL: 15 minutes — long enough to deduplicate rapid repeated queries,
// short enough that newly-stored facts flow through within one session.

const SYNTHESIS_CACHE_TTL_MS = 15 * 60 * 1000;
const SYNTHESIS_CACHE_MAX = 500;
const synthesisCache = new Map<string, { answer: string; ts: number }>();
let synthesisCacheHits = 0;
let synthesisCacheMisses = 0;

function synthesisCacheKey(question: string, filtered: string): string {
  return createHash("sha256")
    .update(question.trim().toLowerCase())
    .update("\x00")
    .update(filtered)
    .digest("hex");
}

function synthesisCacheGet(key: string): string | null {
  const entry = synthesisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SYNTHESIS_CACHE_TTL_MS) {
    synthesisCache.delete(key);
    return null;
  }
  return entry.answer;
}

function synthesisCacheSet(key: string, answer: string): void {
  if (synthesisCache.size >= SYNTHESIS_CACHE_MAX) {
    // Evict oldest 10% when full (simple FIFO; Map preserves insertion order)
    const toEvict = Math.ceil(SYNTHESIS_CACHE_MAX * 0.1);
    let i = 0;
    for (const k of synthesisCache.keys()) {
      if (i++ >= toEvict) break;
      synthesisCache.delete(k);
    }
  }
  synthesisCache.set(key, { answer, ts: Date.now() });
}

export function getSynthesisCacheStats(): { size: number; hits: number; misses: number } {
  return { size: synthesisCache.size, hits: synthesisCacheHits, misses: synthesisCacheMisses };
}

/**
 * Parse retrieval scores from raw gate output and filter low-relevance facts.
 * Format: "[decay] entity.key = value\n    score: 0.XXX | sources: ..."
 * Returns filtered context string with only facts above threshold,
 * or empty string if nothing survives.
 */
function filterByRelevance(retrievedFacts: string): { filtered: string; avgScore: number; factCount: number } {
  const blocks = retrievedFacts.split(/\n\n(?=\[)/);
  const kept: string[] = [];
  const scores: number[] = [];

  for (const block of blocks) {
    const scoreMatch = block.match(/score:\s*([\d.]+)/);
    if (!scoreMatch) {
      // Non-fact blocks (headers, search info) — keep as-is
      if (block.includes("[Memory Context") || block.includes("Searching:") || block.includes("Found ")) {
        kept.push(block);
      }
      continue;
    }
    const score = parseFloat(scoreMatch[1]);
    scores.push(score);
    if (score >= MIN_RELEVANCE_SCORE) {
      kept.push(block);
    }
  }

  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const factCount = scores.filter(s => s >= MIN_RELEVANCE_SCORE).length;

  return { filtered: kept.join("\n\n"), avgScore, factCount };
}

// ── 1. Librarian Synthesis ─────────────────────────────────────────────────

export async function synthesizeAnswer(
  question: string,
  retrievedFacts: string,
  _dbPath: string,
): Promise<string> {
  if (!retrievedFacts || retrievedFacts.trim().length < 10) {
    return "The well holds no record of that, though it may lie in waters I have not yet searched.";
  }

  // Pre-filter: remove low-relevance facts before LLM sees them
  const { filtered, avgScore, factCount } = filterByRelevance(retrievedFacts);
  if (factCount === 0 || avgScore < MIN_RELEVANCE_SCORE) {
    console.log(`[mimir-synthesize] Skipping synthesis: avgScore=${avgScore.toFixed(3)}, factCount=${factCount} (threshold=${MIN_RELEVANCE_SCORE})`);
    return "";
  }

  // Cache check — identical question + identical retrieved facts returns the prior synthesis
  const cacheKey = synthesisCacheKey(question, filtered);
  const cached = synthesisCacheGet(cacheKey);
  if (cached !== null) {
    synthesisCacheHits++;
    return cached;
  }
  synthesisCacheMisses++;

  const prompt = `You are Mimir, Keeper of the Well of Wisdom — an ancient, serene Norse goddess of memory. Given these memory facts and a question, synthesize a clear, authoritative answer.

Rules:
- CRITICAL: First check if ANY of the retrieved facts are actually relevant to the question. If NONE of the facts relate to the question topic, respond with EXACTLY: NO_RELEVANT_FACTS
- Cite which facts support your answer by referencing entity names or key details
- If the facts are insufficient for a complete answer, say so honestly
- Speak with quiet authority — measured, thoughtful, never hurried
- Do not fabricate information beyond what the facts contain
- Do not stretch tangential facts to answer unrelated questions

Facts from the Well:
${filtered}

Question: ${question}

Answer as Mimir would (or NO_RELEVANT_FACTS if nothing relates to the question):`;

  try {
    const result = await mcGenerate({
      prompt,
      workload: "briefing",
      temperature: 0.4,
      maxTokens: 400,
    });
    const answer = result.content.trim();
    // LLM determined none of the retrieved facts are relevant
    if (answer === "NO_RELEVANT_FACTS" || answer.startsWith("NO_RELEVANT_FACTS")) {
      synthesisCacheSet(cacheKey, "");
      return "";
    }
    synthesisCacheSet(cacheKey, answer);
    return answer;
  } catch (err) {
    console.error(`[mimir-synthesize] Synthesis failed: ${err}`);
    return `[Synthesis unavailable] Raw facts:\n${retrievedFacts.slice(0, 500)}`;
  }
}

// ── 2. Feedback Loop ───────────────────────────────────────────────────────

interface FeedbackFact {
  entity: string;
  key: string;
  value: string;
  category: string;
  decay_class: string;
}

async function extractFeedbackFacts(
  question: string,
  answer: string,
): Promise<FeedbackFact[]> {
  const prompt = `Given this question and answer exchange, extract any NEW knowledge that should be remembered for future queries. Only extract facts that represent durable knowledge — not the question itself or ephemeral details.

Return ONLY a JSON array (no other text):
[{"entity": "topic_name", "key": "specific_aspect", "value": "the knowledge", "category": "fact", "decay_class": "stable"}]

Valid categories: preference, fact, decision, convention, reference, project
Valid decay_class: permanent, stable, active

Return an empty array [] if nothing new was learned.

Question: ${question}
Answer: ${answer}`;

  try {
    const result = await mcGenerate({
      prompt,
      workload: "extraction",
      temperature: 0.1,
      maxTokens: 500,
    });
    const raw = result.content.trim();
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f: any) => f.entity && f.key && f.value && f.value.length >= 10
    );
  } catch (err) {
    console.error(`[mimir-synthesize] Feedback extraction failed: ${err}`);
    return [];
  }
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await mcEmbeddings(text, EMBEDDING_MODEL);
    return result.embedding;
  } catch {
    return null;
  }
}

function isDuplicate(db: Database, entity: string, key: string, value: string): boolean {
  const existing = db.prepare(
    "SELECT id, value FROM facts WHERE entity = ? AND key = ? LIMIT 5"
  ).all(entity, key) as { id: string; value: string }[];

  for (const row of existing) {
    if (row.value === value) return true;
    const overlap = value.split(" ").filter(w => row.value.includes(w)).length;
    const ratio = overlap / Math.max(value.split(" ").length, 1);
    if (ratio > 0.8) return true;
  }
  return false;
}

export async function generateFeedbackFacts(
  question: string,
  synthesizedAnswer: string,
  dbPath: string,
): Promise<string[]> {
  const facts = await extractFeedbackFacts(question, synthesizedAnswer);
  if (facts.length === 0) return [];

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  const storedIds: string[] = [];

  try {
    const insertFact = db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, confidence)
      VALUES (?, 'mimir', ?, ?, ?, ?, ?, ?, 0.9, ?, ?, 0.85)
    `);

    const insertEmbed = db.prepare(`
      INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)
    `);

    for (const fact of facts) {
      if (isDuplicate(db, fact.entity, fact.key, fact.value)) continue;

      const id = randomUUID();
      const text = `${fact.entity}.${fact.key}: ${fact.value}`;
      const now = Math.floor(Date.now() / 1000);

      insertFact.run(
        id, fact.entity, fact.key, fact.value, text,
        fact.category || "fact", fact.decay_class || "stable",
        `mimir:feedback/${question.slice(0, 40)}`, now
      );
      storedIds.push(id);

      const embedding = await getEmbedding(text);
      if (embedding) {
        const buf = new Float32Array(embedding);
        insertEmbed.run(id, Buffer.from(buf.buffer), EMBEDDING_MODEL);
      }
    }

    // Auto-link after storing
    if (storedIds.length > 0) {
      await autoLink(storedIds, dbPath, db);
    }
  } catch (err) {
    console.error(`[mimir-synthesize] Feedback storage failed: ${err}`);
  } finally {
    db.close();
  }

  return storedIds;
}

// ── 3. Auto-Backlinks ──────────────────────────────────────────────────────

export async function autoLink(
  newFactIds: string[],
  _dbPath: string,
  db?: Database,
): Promise<number> {
  const ownDb = !db;
  if (!db) {
    db = new Database(_dbPath);
    db.exec("PRAGMA journal_mode = WAL");
  }

  let linksCreated = 0;

  try {
    const getFact = db.prepare("SELECT id, entity, key, value FROM facts WHERE id = ?");
    const findRelated = db.prepare(`
      SELECT id, entity, key FROM facts
      WHERE entity = ? AND id != ? AND id NOT IN (${newFactIds.map(() => "?").join(",")})
      LIMIT 5
    `);
    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight)
      VALUES (?, ?, ?, ?)
    `);

    for (const factId of newFactIds) {
      const fact = getFact.get(factId) as { id: string; entity: string; key: string; value: string } | null;
      if (!fact) continue;

      const related = findRelated.all(fact.entity, factId, ...newFactIds) as { id: string; entity: string; key: string }[];

      for (const rel of related) {
        const relation = fact.key === rel.key ? "same_aspect" : "same_entity";
        const weight = relation === "same_aspect" ? 1.0 : 0.7;
        const result = insertLink.run(factId, rel.id, relation, weight);
        if (result.changes > 0) linksCreated++;
        // Bidirectional
        const result2 = insertLink.run(rel.id, factId, relation, weight);
        if (result2.changes > 0) linksCreated++;
      }
    }
  } catch (err) {
    console.error(`[mimir-synthesize] Auto-link failed: ${err}`);
  } finally {
    if (ownDb && db) db.close();
  }

  return linksCreated;
}
