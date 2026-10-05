#!/usr/bin/env bun
/**
 * seed-mimir-corpus.ts — Bootstrap Mimir's fact corpus from:
 *   1. Claude Code memory files (architectural decisions, conventions, project status)
 *   2. Zouroboros monorepo git log (project milestones, features, fixes)
 *
 * Deduplicates against existing facts. Generates embeddings. Runs autoLink().
 *
 * Usage: ZO_MEMORY_DB=/home/workspace/.zo/memory/mimir.db bun seed-mimir-corpus.ts
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { generate as mcGenerate, embeddings as mcEmbeddings } from "./model-client";
import { autoLink } from "./mimir-synthesize";

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/mimir.db";
const MEMORY_DIR = "/root/.claude/projects/-home-workspace/memory";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RawFact {
  entity: string;
  key: string;
  value: string;
  category: string;
  decay_class: string;
  source: string;
}

function isDuplicate(db: Database, entity: string, key: string, value: string): boolean {
  const existing = db.prepare(
    "SELECT value FROM facts WHERE entity = ? AND key = ? LIMIT 10"
  ).all(entity, key) as { value: string }[];
  for (const row of existing) {
    if (row.value === value) return true;
    const words = value.toLowerCase().split(/\s+/);
    const overlap = words.filter(w => row.value.toLowerCase().includes(w)).length;
    if (overlap / Math.max(words.length, 1) > 0.7) return true;
  }
  return false;
}

async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await mcEmbeddings(text, EMBEDDING_MODEL);
    return result.embedding;
  } catch {
    return null;
  }
}

// ── 1. Extract facts from memory files ───────────────────────────────────────

function extractMemoryFacts(): RawFact[] {
  const facts: RawFact[] = [];
  if (!existsSync(MEMORY_DIR)) {
    console.error(`[seed] Memory dir not found: ${MEMORY_DIR}`);
    return facts;
  }

  const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md");

  for (const file of files) {
    const content = readFileSync(`${MEMORY_DIR}/${file}`, "utf-8");

    // Parse frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;

    const fm = fmMatch[1];
    const body = fmMatch[2].trim();

    const nameMatch = fm.match(/name:\s*(.+)/);
    const typeMatch = fm.match(/type:\s*(.+)/);
    if (!nameMatch) continue;

    const memName = nameMatch[1].trim();
    const memType = typeMatch?.[1]?.trim() || "project";

    // Derive entity from filename
    const entity = file.replace(/\.md$/, "").replace(/^(project_|feedback_|reference_|user_)/, "");

    // Category mapping
    const categoryMap: Record<string, string> = {
      project: "project",
      feedback: "convention",
      reference: "reference",
      user: "preference",
    };
    const category = categoryMap[memType] || "fact";
    const decay_class = memType === "feedback" ? "permanent" : "stable";

    // Extract the full summary as a top-level fact
    const summaryLines = body.split("\n").filter(l => l.trim() && !l.startsWith("#")).slice(0, 3);
    if (summaryLines.length > 0) {
      facts.push({
        entity,
        key: "summary",
        value: summaryLines.join(" ").trim().slice(0, 500),
        category,
        decay_class,
        source: `mimir:bootstrap/memory/${file}`,
      });
    }

    // Extract bullet points as individual facts
    const bullets = body.match(/^[-*]\s+(.+)/gm);
    if (bullets) {
      for (const bullet of bullets) {
        const text = bullet.replace(/^[-*]\s+/, "").trim();
        if (text.length < 15) continue;

        const colonMatch = text.match(/^([^:]+):\s+(.+)/);
        let key: string, value: string;
        if (colonMatch && colonMatch[1].length < 50) {
          key = colonMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
          value = colonMatch[2];
        } else {
          key = text.split(/\s+/).slice(0, 3).join("_").toLowerCase().replace(/[^a-z0-9_]/g, "");
          value = text;
        }

        if (value.length >= 15) {
          facts.push({
            entity,
            key,
            value: value.slice(0, 500),
            category,
            decay_class,
            source: `mimir:bootstrap/memory/${file}`,
          });
        }
      }
    }

    // Extract h2/h3 sections as topic facts
    const sections = body.match(/^#{2,3}\s+(.+)\n([\s\S]*?)(?=\n#{2,3}\s|\n*$)/gm);
    if (sections) {
      for (const section of sections) {
        const headerMatch = section.match(/^#{2,3}\s+(.+)\n([\s\S]*)/);
        if (!headerMatch) continue;
        const sectionKey = headerMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
        const sectionBody = headerMatch[2].trim();
        if (sectionBody.length >= 20) {
          facts.push({
            entity,
            key: sectionKey,
            value: sectionBody.split("\n").filter(l => l.trim()).slice(0, 4).join(" ").slice(0, 500),
            category,
            decay_class,
            source: `mimir:bootstrap/memory/${file}`,
          });
        }
      }
    }
  }

  return facts;
}

// ── 2. Extract facts from git history ────────────────────────────────────────

function extractGitFacts(): RawFact[] {
  const facts: RawFact[] = [];

  try {
    const log = execSync(
      'git log --oneline --no-merges -100 2>/dev/null',
      { cwd: "/home/workspace/zouroboros", encoding: "utf-8" }
    );
    const lines = log.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
      if (!match) continue;
      const [, hash, msg] = match;

      if (/^experiment \d+/i.test(msg)) continue;
      if (/^autoloop:/i.test(msg)) continue;

      const conventionalMatch = msg.match(/^(feat|fix|docs|chore|ci|test)\(([^)]+)\):\s+(.+)/);
      let entity: string, key: string, value: string;

      if (conventionalMatch) {
        const [, type, scope, description] = conventionalMatch;
        entity = `zouroboros_${scope.replace(/[^a-z0-9]/g, "_")}`;
        key = `${type}_${hash.slice(0, 7)}`;
        value = `${description} (${type}, commit ${hash.slice(0, 7)})`;
      } else {
        entity = "zouroboros";
        key = `commit_${hash.slice(0, 7)}`;
        value = msg;
      }

      if (value.length >= 15) {
        facts.push({
          entity,
          key,
          value: value.slice(0, 500),
          category: "project",
          decay_class: "stable",
          source: `mimir:bootstrap/git/${hash.slice(0, 7)}`,
        });
      }
    }
  } catch (err) {
    console.error(`[seed] Git log failed: ${err}`);
  }

  return facts;
}

// ── 3. Store facts ───────────────────────────────────────────────────────────

async function storeFacts(facts: RawFact[]): Promise<string[]> {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");

  const insertFact = db.prepare(`
    INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, confidence)
    VALUES (?, 'mimir', ?, ?, ?, ?, ?, ?, 0.85, ?, ?, 0.90)
  `);
  const insertEmbed = db.prepare(`
    INSERT OR REPLACE INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)
  `);

  const storedIds: string[] = [];
  let skipped = 0;

  for (const fact of facts) {
    if (isDuplicate(db, fact.entity, fact.key, fact.value)) {
      skipped++;
      continue;
    }

    const id = randomUUID();
    const text = `${fact.entity}.${fact.key}: ${fact.value}`;
    const now = Math.floor(Date.now() / 1000);

    try {
      insertFact.run(
        id, fact.entity, fact.key, fact.value, text,
        fact.category, fact.decay_class,
        fact.source, now
      );
      storedIds.push(id);

      const embedding = await getEmbedding(text);
      if (embedding) {
        const buf = new Float32Array(embedding);
        insertEmbed.run(id, Buffer.from(buf.buffer), EMBEDDING_MODEL);
      }

      if (storedIds.length % 10 === 0) {
        console.log(`[seed] Stored ${storedIds.length} facts (${skipped} skipped)...`);
      }
    } catch (err) {
      console.error(`[seed] Failed to store ${fact.entity}.${fact.key}: ${err}`);
    }
  }

  // Auto-link all new facts in batches
  if (storedIds.length > 0) {
    console.log(`[seed] Running autoLink on ${storedIds.length} facts...`);
    const batchSize = 20;
    let totalLinks = 0;
    for (let i = 0; i < storedIds.length; i += batchSize) {
      const batch = storedIds.slice(i, i + batchSize);
      const links = await autoLink(batch, DB_PATH, db);
      totalLinks += links;
    }
    console.log(`[seed] Created ${totalLinks} backlinks`);
  }

  db.close();
  return storedIds;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[seed] Seeding Mimir corpus from memory files + git history`);
  console.log(`[seed] Target DB: ${DB_PATH}`);

  const memoryFacts = extractMemoryFacts();
  console.log(`[seed] Extracted ${memoryFacts.length} facts from memory files`);

  const gitFacts = extractGitFacts();
  console.log(`[seed] Extracted ${gitFacts.length} facts from git history`);

  const allFacts = [...memoryFacts, ...gitFacts];
  console.log(`[seed] Total candidates: ${allFacts.length}`);

  const storedIds = await storeFacts(allFacts);
  console.log(`\n[seed] DONE — ${storedIds.length} new facts stored in mimir.db`);

  const db = new Database(DB_PATH);
  const count = db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number };
  const embedCount = db.prepare("SELECT COUNT(*) as c FROM fact_embeddings").get() as { c: number };
  const linkCount = db.prepare("SELECT COUNT(*) as c FROM fact_links").get() as { c: number };
  console.log(`[seed] Total facts: ${count.c}, embeddings: ${embedCount.c}, links: ${linkCount.c}`);
  db.close();
}

main().catch(err => {
  console.error(`[seed] Fatal: ${err}`);
  process.exit(1);
});
