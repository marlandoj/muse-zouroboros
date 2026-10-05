#!/usr/bin/env bun
/**
 * conversation-capture.ts — Workspace Artifact Memory Capture
 *
 * Scans conversation workspace directories for artifact files (reports,
 * analysis outputs, tool results) and runs them through the auto-capture
 * pipeline to extract and store facts in the memory system.
 *
 * This extends memory capture beyond swarm tasks to ALL conversations.
 *
 * Usage:
 *   bun conversation-capture.ts                    # Process last 24h (safe default)
 *   bun conversation-capture.ts --since 24h        # Only last 24 hours
 *   bun conversation-capture.ts --since 7d         # Only last 7 days
 *   bun conversation-capture.ts --all              # Process all uncaptured artifacts
 *   bun conversation-capture.ts --dry-run           # Preview without storing
 *   bun conversation-capture.ts --stats             # Show capture statistics
 *   bun conversation-capture.ts --list              # List capturable files
 */

import { Database } from "bun:sqlite";
import { randomUUID, createHash } from "crypto";
import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { join, extname, basename, relative } from "path";
import {
  createEpisodeRecord,
  ensureContinuationSchema,
  extractOpenLoopsFromText,
  resolveMatchingOpenLoops,
  upsertOpenLoop,
} from "./continuation";
import { generate as mcGenerate, embeddings as mcEmbeddings, modelHealthCheck, resolveConfiguredModel } from "./model-client";

// --- Configuration ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";
const CAPTURE_MODEL = process.env.ZO_CAPTURE_MODEL || "openai:gpt-4o-mini";
const CAPTURE_FALLBACK_MODEL = process.env.ZO_CAPTURE_FALLBACK_MODEL || process.env.ZO_MODEL_CAPTURE || "openai:gpt-4o-mini";
const WORKSPACES_DIR = "/home/.z/workspaces";

const MAX_FACTS_PER_CAPTURE = 20;
const MIN_CONFIDENCE = 0.6;
const MIN_VALUE_LENGTH = 10;
const MIN_FILE_SIZE = 200;
const MAX_FILE_SIZE = 500_000;
const MAX_TRANSCRIPT_TOKENS = 6000;

const SKIP_DIRS = new Set([
  "read_webpage", "browser_agent", "node_modules", ".git",
  "venv", "lib64", "dist-info", "site-packages",
  "jhf_backup_extract", "email_attachment", "openclaw_files_prototype",
]);
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".json"]);
const SKIP_FILES = new Set([
  "package.json", "tsconfig.json", "bun.lockb", "bun.lock",
  ".gitignore", ".prettierrc", "components.json",
]);

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

interface ArtifactFile {
  path: string;
  conversationId: string;
  size: number;
  mtime: Date;
}

// --- Database ---
function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
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
      capture_mode TEXT DEFAULT 'batch',
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
      model TEXT DEFAULT 'text-embedding-3-small',
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
  `);
  // Safe migration: only run if capture_mode column doesn't exist yet
  const colCheck = db.prepare("PRAGMA table_info(capture_log)").all() as any[];
  const hasCaptureMode = colCheck.some((c: any) => c.name === "capture_mode");
  if (!hasCaptureMode) {
    db.exec("ALTER TABLE capture_log ADD COLUMN capture_mode TEXT DEFAULT 'batch'");
  }
  ensureContinuationSchema(db);
  return db;
}

function isAlreadyCaptured(db: Database, hash: string, captureMode: string = "batch"): boolean {
  // Batch path: skip only if already batch-captured. Inline-captured content
  // is allowed to pass through (different capture surface — raw text vs. artifacts).
  if (captureMode === "batch") {
    return !!db.prepare("SELECT id FROM capture_log WHERE transcript_hash = ? AND capture_mode = 'batch'").get(hash);
  }
  return !!db.prepare("SELECT id FROM capture_log WHERE transcript_hash = ?").get(hash);
}

// --- File Discovery ---

function parseSince(since: string): Date {
  const now = Date.now();
  const match = since.match(/^(\d+)(h|d|w|m)$/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    const ms: Record<string, number> = { h: 3600_000, d: 86400_000, w: 604800_000, m: 2592000_000 };
    return new Date(now - num * ms[unit]);
  }
  const d = new Date(since);
  if (!isNaN(d.getTime())) return d;
  return new Date(now - 86400_000);
}

function discoverArtifacts(sinceDate?: Date): ArtifactFile[] {
  const artifacts: ArtifactFile[] = [];
  if (!existsSync(WORKSPACES_DIR)) return artifacts;

  const conDirs = readdirSync(WORKSPACES_DIR).filter(d => d.startsWith("con_"));

  for (const conDir of conDirs) {
    const conPath = join(WORKSPACES_DIR, conDir);
    const conId = conDir.replace("con_", "");

    try {
      const conStat = statSync(conPath);
      if (sinceDate && conStat.mtime < sinceDate) continue;
    } catch {
      continue;
    }

    scanDirectory(conPath, conId, artifacts, sinceDate);
  }

  artifacts.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return artifacts;
}

function scanDirectory(dir: string, conId: string, artifacts: ArtifactFile[], sinceDate?: Date): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      scanDirectory(fullPath, conId, artifacts, sinceDate);
      continue;
    }

    if (!stat.isFile()) continue;
    const ext = extname(entry).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    if (SKIP_FILES.has(entry)) continue;
    if (stat.size < MIN_FILE_SIZE || stat.size > MAX_FILE_SIZE) continue;
    if (sinceDate && stat.mtime < sinceDate) continue;

    artifacts.push({ path: fullPath, conversationId: conId, size: stat.size, mtime: stat.mtime });
  }
}

// --- Model Integration (via model-client) ---

async function checkModelAvailable(_model: string): Promise<boolean> {
  try {
    const { provider } = resolveConfiguredModel("capture", _model);
    const result = await modelHealthCheck(provider);
    return result.available;
  } catch { return false; }
}

async function extractFacts(transcript: string, model: string): Promise<CapturedFact[]> {
  const prompt = `You are a fact extractor. Given a document or conversation artifact, extract structured facts.

Rules:
- Extract ONLY concrete, reusable facts (preferences, decisions, project details, technical choices, contacts, findings, recommendations)
- Do NOT extract: greetings, questions, transient discussion, small talk, generic advice
- Each fact must be independently useful without the original document context
- Assign decay_class: "permanent" for user preferences/identity, "stable" for project decisions/findings, "active" for current tasks/sprints, "session" for today-only context
- Assign confidence: 1.0 for explicit statements, 0.8 for strong implications, 0.6 for inferences
- Include source_quote: the exact text that supports this fact
- entity format: "category.subject" (e.g., "project.ffb-site", "user", "decision.hosting", "finding.performance")

Output ONLY a valid JSON array of objects with these fields: entity, key, value, category, decay_class, confidence, source_quote
If nothing worth extracting, return [].

Document:
---
${transcript.slice(0, MAX_TRANSCRIPT_TOKENS)}
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
    console.error(`  Extraction failed: ${err}`);
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
  } catch { return null; }
}

// --- Dedup & Contradiction Detection ---

function checkExisting(db: Database, entity: string, key: string, value: string): { isDuplicate: boolean; contradicts: string | null } {
  const existing = db.prepare(
    "SELECT id, value FROM facts WHERE entity = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).all(entity, key, Math.floor(Date.now() / 1000)) as any[];

  if (existing.length === 0) return { isDuplicate: false, contradicts: null };
  for (const row of existing) {
    if (row.value === value) return { isDuplicate: true, contradicts: null };
  }
  return { isDuplicate: false, contradicts: existing[0].id };
}

// --- Store Facts ---

async function storeFacts(
  db: Database, facts: CapturedFact[], source: string, dryRun: boolean
): Promise<{ stored: number; skipped: number; contradictions: number; links: number }> {
  let stored = 0, skipped = 0, contradictions = 0, links = 0;
  const storedIds: string[] = [];

  for (const fact of facts) {
    if (fact.confidence < MIN_CONFIDENCE) { skipped++; continue; }
    if (fact.value.length < MIN_VALUE_LENGTH) { skipped++; continue; }

    const { isDuplicate, contradicts } = checkExisting(db, fact.entity, fact.key, fact.value);
    if (isDuplicate) { skipped++; continue; }

    if (dryRun) {
      const tag = contradicts ? "\u26a0" : "\u2713";
      console.log(`  ${tag} [${fact.entity}].${fact.key} = "${fact.value.slice(0, 60)}"`);
      console.log(`    category: ${fact.category} | decay: ${fact.decay_class} | confidence: ${fact.confidence}`);
      if (contradicts) console.log(`    SUPERSEDES existing fact ${contradicts}`);
      stored++;
      if (contradicts) contradictions++;
      continue;
    }

    const id = randomUUID();
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const expiresAt = TTL_DEFAULTS[fact.decay_class] ? nowSec + TTL_DEFAULTS[fact.decay_class]! : null;
    const text = `${fact.entity} ${fact.key}: ${fact.value}`;

    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                         importance, source, created_at, expires_at, last_accessed, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "shared", fact.entity, fact.key, fact.value, text,
      fact.category, fact.decay_class, 1.0, `conversation-capture:${source}`,
      now, expiresAt, nowSec, fact.confidence,
      JSON.stringify({ source_quote: fact.source_quote }));

    const embedding = await getEmbedding(text);
    if (embedding) {
      db.prepare("INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
        .run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
    }

    if (contradicts) {
      db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'supersedes', 1.0)")
        .run(id, contradicts);
      db.prepare("UPDATE facts SET confidence = confidence * 0.5 WHERE id = ?").run(contradicts);
      contradictions++;
    }

    storedIds.push(id);
    stored++;
  }

  if (!dryRun && storedIds.length > 1) {
    for (let i = 0; i < storedIds.length; i++) {
      for (let j = i + 1; j < storedIds.length; j++) {
        db.prepare("INSERT OR IGNORE INTO fact_links (source_id, target_id, relation, weight) VALUES (?, ?, 'co-captured', 0.5)")
          .run(storedIds[i], storedIds[j]);
        links++;
      }
    }
  }

  return { stored, skipped, contradictions, links };
}

// --- Episode Creation ---

function createEpisode(db: Database, source: string, stored: number, skipped: number, contradictions: number, durationMs: number, entities: string[]): void {
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes'").get();
  if (!hasTable) return;

  const outcome = contradictions > 0 ? "resolved" : "success";

  createEpisodeRecord(db, {
    summary: `Conversation capture: ${stored} facts stored, ${skipped} skipped, ${contradictions} contradictions`,
    outcome,
    happenedAt: Math.floor(Date.now() / 1000),
    durationMs,
    entities: [...entities, "capture.conversation"],
    metadata: { source, stored, skipped, contradictions, entities },
  });
}

// --- Main Pipeline ---

async function processArtifacts(artifacts: ArtifactFile[], dryRun: boolean): Promise<void> {
  const db = getDb();

  let model = CAPTURE_MODEL;
  let heuristicOnly = false;
  if (!(await checkModelAvailable(model))) {
    console.log(`${model} not available, trying fallback: ${CAPTURE_FALLBACK_MODEL}`);
    model = CAPTURE_FALLBACK_MODEL;
    if (!(await checkModelAvailable(model))) {
      console.warn("No extraction model available. Continuing with heuristic open-loop capture only.");
      heuristicOnly = true;
      model = "heuristic-only";
    }
  }

  let totalStored = 0, totalSkipped = 0, totalContradictions = 0, totalLinks = 0;
  let filesProcessed = 0, filesSkippedDedup = 0;
  let totalOpenLoopsStored = 0, totalOpenLoopsResolved = 0;
  const allEntities: string[] = [];
  const startTime = Date.now();

  for (const artifact of artifacts) {
    let content: string;
    try { content = readFileSync(artifact.path, "utf-8"); } catch { continue; }

    if (artifact.path.endsWith(".json")) {
      try { const parsed = JSON.parse(content); content = JSON.stringify(parsed, null, 2); }
      catch { continue; }
    }

    const hash = createHash("sha256").update(content).digest("hex");
    if (isAlreadyCaptured(db, hash)) { filesSkippedDedup++; continue; }

    const relPath = relative(WORKSPACES_DIR, artifact.path);
    const source = `conversation:${artifact.conversationId}/${basename(artifact.path)}`;

    console.log(`\n--- ${relPath} (${(artifact.size / 1024).toFixed(1)} KB) ---`);

    const facts = heuristicOnly ? [] : await extractFacts(content, model);

    if (facts.length === 0) {
      console.log(heuristicOnly ? "  Heuristic-only mode: skipping fact extraction." : "  No extractable facts. Using heuristic open-loop capture only.");
      if (!dryRun) {
        totalOpenLoopsResolved += resolveMatchingOpenLoops(db, content);
        const loops = extractOpenLoopsFromText(content, source);
        for (const loop of loops) {
          if (loop.status === "resolved") continue;
          upsertOpenLoop(db, loop);
          totalOpenLoopsStored++;
        }
        db.prepare(`INSERT INTO capture_log (id, source, transcript_hash, facts_extracted, facts_skipped, contradictions, model, capture_mode, duration_ms)
          VALUES (?, ?, ?, 0, 0, 0, ?, 'batch', ?)`).run(randomUUID(), source, hash, model, 0);
      }
      filesProcessed++;
      continue;
    }

    const result = await storeFacts(db, facts, source, dryRun);
    totalStored += result.stored;
    totalSkipped += result.skipped;
    totalContradictions += result.contradictions;
    totalLinks += result.links;
    filesProcessed++;

    allEntities.push(...[...new Set(facts.map(f => f.entity))]);

    if (!dryRun) {
      totalOpenLoopsResolved += resolveMatchingOpenLoops(db, content);
      const loops = extractOpenLoopsFromText(content, source);
      for (const loop of loops) {
        if (loop.status === "resolved") continue;
        upsertOpenLoop(db, loop);
        totalOpenLoopsStored++;
      }
    }

    if (!dryRun) {
      db.prepare(`INSERT INTO capture_log (id, source, transcript_hash, facts_extracted, facts_skipped, contradictions, model, capture_mode, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'batch', ?)`).run(randomUUID(), source, hash, result.stored, result.skipped, result.contradictions, model, 0);
    }

    console.log(`  -> ${result.stored} stored, ${result.skipped} skipped, ${result.contradictions} contradictions`);
  }

  const durationMs = Date.now() - startTime;

  if (!dryRun && (totalStored > 0 || totalOpenLoopsStored > 0 || totalOpenLoopsResolved > 0)) {
    createEpisode(db, "conversation-capture", totalStored, totalSkipped, totalContradictions, durationMs, [...new Set(allEntities)]);
  }

  db.close();

  console.log("\n========================================");
  console.log(`Conversation Capture ${dryRun ? "(DRY RUN)" : "Complete"}`);
  console.log("========================================");
  console.log(`Files processed: ${filesProcessed}`);
  console.log(`Files skipped (already captured): ${filesSkippedDedup}`);
  console.log(`Facts ${dryRun ? "would be " : ""}stored: ${totalStored}`);
  console.log(`Facts skipped: ${totalSkipped}`);
  console.log(`Contradictions: ${totalContradictions}`);
  console.log(`Co-capture links: ${totalLinks}`);
  console.log(`Open loops stored: ${totalOpenLoopsStored}`);
  console.log(`Open loops resolved: ${totalOpenLoopsResolved}`);
  console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
}

// --- Stats ---

function showStats(): void {
  const db = getDb();

  const totalCaptures = db.prepare(
    "SELECT COUNT(*) as cnt FROM capture_log WHERE source LIKE 'conversation-capture:%' OR source LIKE 'conversation:%'"
  ).get() as { cnt: number };
  const totalFacts = db.prepare(
    "SELECT COALESCE(SUM(facts_extracted), 0) as cnt FROM capture_log WHERE source LIKE 'conversation-capture:%' OR source LIKE 'conversation:%'"
  ).get() as { cnt: number };
  const totalAll = db.prepare("SELECT COUNT(*) as cnt FROM capture_log").get() as { cnt: number };
  const totalAllFacts = db.prepare("SELECT COALESCE(SUM(facts_extracted), 0) as cnt FROM capture_log").get() as { cnt: number };

  console.log("Conversation Capture Statistics");
  console.log("===============================");
  console.log(`Conversation captures: ${totalCaptures.cnt} (of ${totalAll.cnt} total captures)`);
  console.log(`Conversation facts extracted: ${totalFacts.cnt} (of ${totalAllFacts.cnt} total)`);

  const recent = db.prepare(`
    SELECT source, facts_extracted, facts_skipped, contradictions, model, created_at
    FROM capture_log WHERE source LIKE 'conversation-capture:%' OR source LIKE 'conversation:%'
    ORDER BY created_at DESC LIMIT 10
  `).all() as any[];

  if (recent.length > 0) {
    console.log("\nRecent conversation captures:");
    for (const r of recent) {
      const date = new Date(r.created_at * 1000).toISOString().slice(0, 16);
      console.log(`  ${date} | ${r.source.slice(0, 50)} | ${r.facts_extracted} facts | ${r.model}`);
    }
  }
  db.close();
}

// --- List ---

function listArtifacts(sinceDate?: Date): void {
  const db = getDb();
  const artifacts = discoverArtifacts(sinceDate);

  let capturable = 0, alreadyCaptured = 0;

  console.log("Capturable Workspace Artifacts");
  console.log("==============================");
  if (sinceDate) console.log(`Since: ${sinceDate.toISOString()}`);
  console.log();

  for (const a of artifacts) {
    const content = readFileSync(a.path, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");
    const captured = isAlreadyCaptured(db, hash);
    const tag = captured ? "\u2713" : "\u25cb";
    const relPath = relative(WORKSPACES_DIR, a.path);
    console.log(`  ${tag} ${relPath} (${(a.size / 1024).toFixed(1)} KB, ${a.mtime.toISOString().slice(0, 10)})`);
    if (captured) alreadyCaptured++; else capturable++;
  }

  console.log(`\nTotal: ${artifacts.length} files, ${capturable} new, ${alreadyCaptured} already captured`);
  db.close();
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args[0] === "help") {
    console.log(`
conversation-capture — Workspace Artifact Memory Capture

Usage:
  bun conversation-capture.ts                    # Process last 24h (safe default)
  bun conversation-capture.ts --since 24h        # Only last 24 hours
  bun conversation-capture.ts --since 7d         # Only last 7 days
  bun conversation-capture.ts --all              # Process all uncaptured artifacts
  bun conversation-capture.ts --dry-run          # Preview without storing
  bun conversation-capture.ts --stats            # Show capture statistics
  bun conversation-capture.ts --list             # List capturable files

Options:
  --since <duration>   Filter by recency: 1h, 24h, 7d, 30d, 1w, 1m
  --all                Process all uncaptured artifacts across all conversations
  --dry-run            Show extracted facts without storing
  --stats              Show capture statistics
  --list               List capturable artifact files
`);
    process.exit(0);
  }

  if (args.includes("--stats") || args[0] === "stats") {
    showStats();
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const captureAll = args.includes("--all");
  let sinceDate: Date | undefined;
  const sinceIdx = args.indexOf("--since");
  if (sinceIdx >= 0 && args[sinceIdx + 1]) sinceDate = parseSince(args[sinceIdx + 1]);

  if (captureAll && sinceDate) {
    console.error("Use either --all or --since <duration>, not both.");
    process.exit(1);
  }

  if (!captureAll && !sinceDate) {
    sinceDate = parseSince("24h");
  }

  if (args.includes("--list") || args[0] === "list") {
    listArtifacts(sinceDate);
    process.exit(0);
  }

  const artifacts = discoverArtifacts(sinceDate);

  const db = getDb();
  const newArtifacts = artifacts.filter(a => {
    try {
      const content = readFileSync(a.path, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex");
      return !isAlreadyCaptured(db, hash);
    } catch { return false; }
  });
  db.close();

  if (newArtifacts.length === 0) {
    console.log("No new artifacts to capture.");
    if (sinceDate) console.log(`(Filtered to files since ${sinceDate.toISOString()})`);
    console.log(`Total artifacts: ${artifacts.length}, all already captured.`);
    process.exit(0);
  }

  console.log(`Found ${newArtifacts.length} new artifacts to capture${captureAll ? " (full backlog sweep)" : sinceDate ? ` (since ${sinceDate.toISOString().slice(0, 10)})` : ""}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  await processArtifacts(newArtifacts, dryRun);
}

main().catch(console.error);
