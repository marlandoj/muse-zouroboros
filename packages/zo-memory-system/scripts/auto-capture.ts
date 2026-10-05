#!/usr/bin/env bun
/**
 * auto-capture.ts — Conversation-to-Fact Extraction Pipeline
 *
 * Post-conversation hook that extracts structured facts from transcripts
 * and stores them automatically with embeddings, decay classification,
 * and contradiction detection.
 *
 * Usage:
 *   bun auto-capture.ts --input conversation.md --dry-run
 *   bun auto-capture.ts --input conversation.md --source "chat:2026-03-04"
 *   cat output.md | bun auto-capture.ts --source "swarm:ffb"
 *   bun auto-capture.ts stats
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import {
  createEpisodeRecord,
  ensureContinuationSchema,
  extractOpenLoopsFromText,
  resolveMatchingOpenLoops,
  upsertOpenLoop,
} from "./continuation";
import { extractWikilinks, resolveWikilinkTargets, autoCorrectWikilinks, shouldExcludeFromWrapping, ENTITY_LIKE_PATTERN } from "./wikilink-utils";
import { generate as mcGenerate, embeddings as mcEmbeddings, modelHealthCheck, resolveConfiguredModel } from "./model-client";

// --- Configuration ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";
const CAPTURE_MODEL = process.env.ZO_CAPTURE_MODEL || "openai:gpt-4o-mini";
const CAPTURE_FALLBACK_MODEL = process.env.ZO_CAPTURE_FALLBACK_MODEL || process.env.ZO_MODEL_CAPTURE || "openai:gpt-4o-mini";
const MAX_FACTS_PER_CAPTURE = 20;
const MIN_CONFIDENCE = 0.6;
const MIN_VALUE_LENGTH = 10;

type DecayClass = "permanent" | "stable" | "active" | "session" | "checkpoint";
type Category = "preference" | "fact" | "decision" | "convention" | "other" | "reference" | "project";

const TTL_DEFAULTS: Record<string, number | null> = {
  permanent: null,
  stable: 90 * 24 * 3600,
  active: 14 * 24 * 3600,
  session: 24 * 3600,
  checkpoint: 4 * 3600,
};

interface CapturedFact {
  entity: string;
  key: string;
  value: string;
  category: Category;
  decay_class: DecayClass;
  confidence: number;
  source_quote: string;
}

interface CaptureResult {
  stored: CapturedFact[];
  skipped: Array<{ fact: CapturedFact; reason: string }>;
  contradictions: number;
  links_created: number;
  duration_ms: number;
}

// --- Database Setup ---
function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  // Ensure capture_log table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS capture_log (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      transcript_hash TEXT NOT NULL,
      facts_extracted INTEGER,
      facts_skipped INTEGER,
      contradictions INTEGER,
      model TEXT,
      duration_ms INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE TABLE IF NOT EXISTS fact_links (
      source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      weight REAL DEFAULT 1.0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
    CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);
    CREATE TABLE IF NOT EXISTS fact_embeddings (
      fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT '${EMBEDDING_MODEL}',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);
  ensureContinuationSchema(db);
  return db;
}

// --- Model Integration (via model-client) ---

async function checkModelAvailable(_model: string): Promise<boolean> {
  try {
    const { provider } = resolveConfiguredModel("capture", _model);
    const result = await modelHealthCheck(provider);
    return result.available;
  } catch {
    return false;
  }
}

async function extractFacts(transcript: string, _model: string): Promise<CapturedFact[]> {
  const prompt = `You are a fact extractor. Given a conversation transcript, extract structured facts.

Rules:
- Extract ONLY concrete, reusable facts (preferences, decisions, project details, technical choices, contacts)
- Do NOT extract: greetings, questions, transient discussion, opinions about weather, small talk
- Each fact must be independently useful without the conversation context
- Assign decay_class: "permanent" for user preferences/identity, "stable" for project decisions, "active" for current tasks/sprints, "session" for today-only context
- Assign confidence: 1.0 for explicit statements, 0.8 for strong implications, 0.6 for inferences
- Include source_quote: the exact text from the transcript that supports this fact
- entity format: "category.subject" (e.g., "project.ffb-site", "user", "decision.hosting", "system.model-routing")
- WIKILINKS: Annotate entity references in the "value" field using [[entity]] syntax. This creates graph edges in the knowledge base. Use [[category.subject]] for known entities and [[new.entity]] for new ones. Example: "Switched [[project.ffb]] hosting from Vercel to [[service.aws-s3]]"

Output ONLY a valid JSON array of objects with these fields: entity, key, value, category, decay_class, confidence, source_quote
If nothing worth extracting, return [].

Transcript:
---
${transcript.slice(0, 6000)}
---`;

  try {
    const result = await mcGenerate({
      prompt,
      workload: "extraction",
      temperature: 0.1,
      maxTokens: 2000,
      json: true,
    });

    const text = result.content.trim();
    let jsonStr = text;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((f: any) => f.entity && f.value && f.key)
      .map((f: any) => ({
        entity: String(f.entity),
        key: String(f.key),
        value: String(f.value),
        category: validateCategory(f.category),
        decay_class: validateDecay(f.decay_class),
        confidence: Math.min(1.0, Math.max(0, Number(f.confidence) || 0.7)),
        source_quote: String(f.source_quote || ""),
      }))
      .slice(0, MAX_FACTS_PER_CAPTURE);
  } catch (err) {
    console.error(`Extraction failed: ${err}`);
    return [];
  }
}

function validateCategory(c: string): Category {
  const valid: Category[] = ["preference", "fact", "decision", "convention", "other", "reference", "project"];
  return valid.includes(c as Category) ? (c as Category) : "fact";
}

function validateDecay(d: string): DecayClass {
  const valid: DecayClass[] = ["permanent", "stable", "active", "session", "checkpoint"];
  return valid.includes(d as DecayClass) ? (d as DecayClass) : "stable";
}

// --- Embedding (via model-client) ---

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await mcEmbeddings(text.slice(0, 8000));
    return result.embedding.length > 0 ? result.embedding : null;
  } catch {
    return null;
  }
}

// --- Dedup & Contradiction Detection ---

function checkExisting(db: Database, entity: string, key: string, value: string): { isDuplicate: boolean; contradicts: string | null } {
  const existing = db.prepare(
    "SELECT id, value FROM facts WHERE entity = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).all(entity, key, Math.floor(Date.now() / 1000)) as any[];

  if (existing.length === 0) return { isDuplicate: false, contradicts: null };

  // Exact match = duplicate
  for (const row of existing) {
    if (row.value === value) return { isDuplicate: true, contradicts: null };
  }

  // Different value for same entity+key = contradiction
  return { isDuplicate: false, contradicts: existing[0].id };
}

// --- Wikilink Validation Post-Pass ---

function validateWikilinks(facts: CapturedFact[], db: Database): CapturedFact[] {
  // Build entity set from the batch for cross-fact detection
  const batchEntities = new Set(facts.map(f => f.entity.toLowerCase()));

  return facts.map(fact => {
    let value = fact.value;

    // 1. Auto-correct using shared wikilink-utils (checks DB for known entities)
    const correction = autoCorrectWikilinks(value, db, fact.entity);
    if (correction) {
      value = correction.corrected_value;
    }

    // 2. Cross-fact entity detection: if entity of fact A appears bare in fact B's value, wrap it
    ENTITY_LIKE_PATTERN.lastIndex = 0;
    const existingLinks = extractWikilinks(value);
    const linkedSet = new Set(existingLinks.map(w => w.entity.toLowerCase()));

    for (const otherEntity of batchEntities) {
      if (otherEntity === fact.entity.toLowerCase()) continue;
      if (linkedSet.has(otherEntity)) continue;
      if (shouldExcludeFromWrapping(otherEntity)) continue;

      // Check if this entity appears as a bare word in the value
      const bareRe = new RegExp(`\\b${otherEntity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      if (bareRe.test(value)) {
        // Make sure it's not already inside [[ ]]
        value = value.replace(bareRe, (match, offset) => {
          const before = value.slice(0, offset);
          const openBrackets = (before.match(/\[\[/g) || []).length;
          const closeBrackets = (before.match(/\]\]/g) || []).length;
          if (openBrackets > closeBrackets) return match; // inside wikilink
          return `[[${match}]]`;
        });
      }
    }

    if (value !== fact.value) {
      return { ...fact, value };
    }
    return fact;
  });
}

// --- Core Pipeline ---

async function runCapture(
  transcript: string,
  options: { source: string; persona: string; dryRun: boolean }
): Promise<CaptureResult> {
  const startTime = Date.now();
  const db = getDb();

  // Check for re-processing
  const hash = createHash("sha256").update(transcript).digest("hex");
  const existing = db.prepare("SELECT id FROM capture_log WHERE transcript_hash = ?").get(hash);
  if (existing) {
    console.log("This transcript has already been processed. Skipping.");
    db.close();
    return { stored: [], skipped: [], contradictions: 0, links_created: 0, duration_ms: 0 };
  }

  let model = CAPTURE_MODEL;
  let heuristicOnly = false;
  let candidates: CapturedFact[] = [];

  const primaryAvailable = await checkModelAvailable(model);
  if (!primaryAvailable) {
    console.log(`${model} not available, trying fallback: ${CAPTURE_FALLBACK_MODEL}`);
    model = CAPTURE_FALLBACK_MODEL;
    const fallbackAvailable = await checkModelAvailable(model);
    if (!fallbackAvailable) {
      console.warn("No extraction model available. Continuing with heuristic open-loop capture only.");
      heuristicOnly = true;
      model = "heuristic-only";
    }
  }

  if (!heuristicOnly) {
    console.log(`Extracting facts with ${model}...`);
    candidates = await extractFacts(transcript, model);
    if (candidates.length === 0) {
      console.log("No facts extracted from transcript. Continuing with heuristic open-loop capture.");
      heuristicOnly = true;
    }
  }

  // Wikilink validation post-pass: wrap bare entities in extracted facts before store
  candidates = validateWikilinks(candidates, db);

  const stored: CapturedFact[] = [];
  const skipped: Array<{ fact: CapturedFact; reason: string }> = [];
  let contradictions = 0;
  let linksCreated = 0;
  let openLoopsStored = 0;
  let openLoopsResolved = 0;
  const storedIds: string[] = [];

  for (const fact of candidates) {
    // Quality filters
    if (fact.confidence < MIN_CONFIDENCE) {
      skipped.push({ fact, reason: `confidence ${fact.confidence} below threshold ${MIN_CONFIDENCE}` });
      continue;
    }
    if (fact.value.length < MIN_VALUE_LENGTH) {
      skipped.push({ fact, reason: `value too short (${fact.value.length} chars)` });
      continue;
    }

    // Dedup & contradiction check
    const { isDuplicate, contradicts } = checkExisting(db, fact.entity, fact.key, fact.value);
    if (isDuplicate) {
      skipped.push({ fact, reason: "duplicate of existing fact" });
      continue;
    }

    if (options.dryRun) {
      if (contradicts) {
        console.log(`  ⚠ [${fact.entity}].${fact.key} = "${fact.value.slice(0, 60)}"`);
        console.log(`    SUPERSEDES existing fact ${contradicts}`);
        contradictions++;
      } else {
        console.log(`  ✓ [${fact.entity}].${fact.key} = "${fact.value.slice(0, 60)}"`);
      }
      console.log(`    category: ${fact.category} | decay: ${fact.decay_class} | confidence: ${fact.confidence}`);
      if (fact.source_quote) console.log(`    quote: "${fact.source_quote.slice(0, 80)}"`);
      console.log();
      stored.push(fact);
      continue;
    }

    // Store fact
    const id = randomUUID();
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const expiresAt = TTL_DEFAULTS[fact.decay_class] ? nowSec + TTL_DEFAULTS[fact.decay_class]! : null;
    const text = `${fact.entity} ${fact.key}: ${fact.value}`;

    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                         importance, source, created_at, expires_at, last_accessed, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, options.persona, fact.entity, fact.key, fact.value, text,
      fact.category, fact.decay_class, 1.0, `auto-capture:${options.source}`,
      now, expiresAt, nowSec, fact.confidence,
      JSON.stringify({ source_quote: fact.source_quote })
    );

    // Generate embedding
    const embedding = await getEmbedding(text);
    if (embedding) {
      db.prepare("INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
        .run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
    }

    // Handle contradiction
    if (contradicts) {
      db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'supersedes', 1.0)")
        .run(id, contradicts);
      db.prepare("UPDATE facts SET confidence = confidence * 0.5 WHERE id = ?").run(contradicts);
      contradictions++;
    }

    // Parse wikilinks from value and create graph edges
    const wikilinks = extractWikilinks(fact.value);
    if (wikilinks.length > 0) {
      const resolved = resolveWikilinkTargets(db, wikilinks, {
        sourcePersona: options.persona,
        sourceId: id,
      });
      for (const link of resolved) {
        db.prepare(
          "INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'wikilink', 1.0)"
        ).run(id, link.targetId);
        linksCreated++;
      }
    }

    storedIds.push(id);
    stored.push(fact);
  }

  // Auto-link co-captured facts
  if (!options.dryRun && storedIds.length > 1) {
    for (let i = 0; i < storedIds.length; i++) {
      for (let j = i + 1; j < storedIds.length; j++) {
        db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'co-captured', 0.5)")
          .run(storedIds[i], storedIds[j]);
        linksCreated++;
      }
    }
  }

  const extractedLoops = extractOpenLoopsFromText(transcript, options.source);
  if (!options.dryRun && extractedLoops.length > 0) {
    openLoopsResolved += resolveMatchingOpenLoops(db, transcript);
    for (const loop of extractedLoops) {
      if (loop.status === "resolved") continue;
      upsertOpenLoop(db, {
        ...loop,
        persona: options.persona,
      });
      openLoopsStored++;
    }
  }

  if (!options.dryRun) {
    db.prepare(`
      INSERT INTO capture_log (id, source, transcript_hash, facts_extracted, facts_skipped, contradictions, model, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), options.source, hash, stored.length, skipped.length, contradictions, model, Date.now() - startTime);

    if (stored.length > 0 || openLoopsStored > 0 || openLoopsResolved > 0) {
      const hasEpisodesTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'"
      ).get();

      if (hasEpisodesTable) {
        const captureEntities = [...new Set(stored.map(f => f.entity))];
        const outcome = contradictions > 0 ? "resolved" as const : "success" as const;

        createEpisodeRecord(db, {
          summary: `Auto-capture from ${options.source}: ${stored.length} facts stored, ${skipped.length} skipped, ${contradictions} contradictions, ${openLoopsStored} open loops, ${openLoopsResolved} resolved`,
          outcome,
          happenedAt: Math.floor(Date.now() / 1000),
          durationMs: Date.now() - startTime,
          entities: [...captureEntities, `capture.${options.source.replace(/[^a-zA-Z0-9.-]/g, "-")}`],
          metadata: {
            source: options.source,
            factsStored: stored.length,
            factsSkipped: skipped.length,
            contradictions,
            openLoopsStored,
            openLoopsResolved,
            model,
            heuristicOnly,
            entities: captureEntities,
          },
        });
      }
    }
  }

  db.close();
  return { stored, skipped, contradictions, links_created: linksCreated, duration_ms: Date.now() - startTime };
}

// --- Stats ---

function showStats(): void {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as cnt FROM capture_log").get() as { cnt: number };
  const totalFacts = db.prepare("SELECT COALESCE(SUM(facts_extracted), 0) as cnt FROM capture_log").get() as { cnt: number };
  const totalSkipped = db.prepare("SELECT COALESCE(SUM(facts_skipped), 0) as cnt FROM capture_log").get() as { cnt: number };
  const totalContradictions = db.prepare("SELECT COALESCE(SUM(contradictions), 0) as cnt FROM capture_log").get() as { cnt: number };

  console.log("Auto-Capture Statistics");
  console.log("=======================");
  console.log(`Total captures: ${total.cnt}`);
  console.log(`Facts extracted: ${totalFacts.cnt}`);
  console.log(`Facts skipped: ${totalSkipped.cnt}`);
  console.log(`Contradictions detected: ${totalContradictions.cnt}`);

  if (total.cnt > 0) {
    const recent = db.prepare(
      "SELECT source, facts_extracted, facts_skipped, contradictions, model, duration_ms, created_at FROM capture_log ORDER BY created_at DESC LIMIT 5"
    ).all() as any[];

    console.log("\nRecent captures:");
    for (const r of recent) {
      const date = new Date(r.created_at * 1000).toISOString().slice(0, 16);
      console.log(`  ${date} | ${r.source} | ${r.facts_extracted} facts | ${r.model} | ${r.duration_ms}ms`);
    }
  }

  db.close();
}

// --- CLI ---

function printUsage() {
  console.log(`
zo-memory-system auto-capture — Conversation-to-Fact Extraction

Usage:
  bun auto-capture.ts [options]
  bun auto-capture.ts stats

Options:
  --input <file>       Transcript file path (or read from stdin)
  --source <label>     Source label (e.g., "chat:2026-03-04", "swarm:ffb")
  --persona <name>     Persona to store facts under (default: "shared")
  --dry-run            Show extracted facts without storing
  --model <name>       Override extraction model (default: openai:gpt-4o-mini)

Examples:
  bun auto-capture.ts --input conversation.md --dry-run
  bun auto-capture.ts --input conversation.md --source "chat:daily"
  cat swarm-output.md | bun auto-capture.ts --source "swarm:ffb"
  bun auto-capture.ts stats
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printUsage();
    process.exit(0);
  }

  if (args[0] === "stats") {
    showStats();
    process.exit(0);
  }

  // Parse flags
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (args[i] === "--dry-run") {
        flags["dry-run"] = "true";
      } else {
        flags[args[i].slice(2)] = args[i + 1] || "";
        i++;
      }
    }
  }

  // Override model if specified
  if (flags.model) {
    (globalThis as any).__captureModel = flags.model;
  }

  // Read transcript
  let transcript: string;
  if (flags.input) {
    if (!existsSync(flags.input)) {
      console.error(`File not found: ${flags.input}`);
      process.exit(1);
    }
    transcript = readFileSync(flags.input, "utf-8");
  } else {
    // Read from stdin
    const chunks: string[] = [];
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    transcript = chunks.join("");
  }

  if (!transcript.trim()) {
    console.error("Empty transcript. Nothing to capture.");
    process.exit(1);
  }

  const source = flags.source || "cli";
  const persona = flags.persona || "shared";
  const dryRun = flags["dry-run"] === "true";

  console.log("Auto-Capture Analysis");
  console.log("=====================");
  console.log(`Source: ${source}`);
  console.log(`Transcript: ~${Math.round(transcript.length / 4)} tokens`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no storage)" : "LIVE (will store facts)"}`);
  console.log();

  const result = await runCapture(transcript, { source, persona, dryRun });

  if (!dryRun) {
    console.log(`\nResults:`);
    console.log(`  Facts stored: ${result.stored.length}`);
    console.log(`  Facts skipped: ${result.skipped.length}`);
    console.log(`  Contradictions: ${result.contradictions}`);
    console.log(`  Co-capture links: ${result.links_created}`);
    console.log(`  Duration: ${result.duration_ms}ms`);

    for (const s of result.skipped) {
      console.log(`  ✗ SKIPPED: [${s.fact.entity}].${s.fact.key} — ${s.reason}`);
    }
  } else {
    if (result.skipped.length > 0) {
      console.log("Skipped:");
      for (const s of result.skipped) {
        console.log(`  ✗ [${s.fact.entity}].${s.fact.key} — ${s.reason}`);
      }
    }
    console.log(`\nTotal: ${result.stored.length} would be stored, ${result.skipped.length} would be skipped`);
    if (result.stored.length > 1) {
      console.log(`Auto-links: ${result.stored.length * (result.stored.length - 1) / 2} co-captured links would be created`);
    }
  }
}

main().catch(console.error);
