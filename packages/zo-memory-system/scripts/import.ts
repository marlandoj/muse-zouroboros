#!/usr/bin/env bun
/**
 * zo-memory-system Import Pipeline v1.0
 *
 * Import facts from external sources into the memory system.
 *
 * Supported sources:
 *   chatgpt  — ChatGPT JSON export (conversations format)
 *   obsidian — Obsidian vault (markdown files with frontmatter)
 *   markdown — Generic markdown files
 *
 * Usage:
 *   bun import.ts --source chatgpt --path ~/export.json
 *   bun import.ts --source obsidian --path ~/Vault --dry-run
 *   bun import.ts --source markdown --path ~/notes/file.md
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import { embeddings as mcEmbeddings } from "./model-client";

// --- Config ---
const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const EMBEDDING_MODEL = process.env.ZO_EMBEDDING_MODEL || "text-embedding-3-small";

// --- Types ---
interface ImportedFact {
  entity: string;
  key: string | null;
  value: string;
  text: string;
  category: string;
  source: string;
}

interface ImportResult {
  source: string;
  factsFound: number;
  factsStored: number;
  factsSkipped: number;
  errors: string[];
}

// --- Embedding helper ---
async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const result = await mcEmbeddings(text.slice(0, 8000), EMBEDDING_MODEL);
    return result.embedding || null;
  } catch {
    return null;
  }
}

// --- Store fact ---
async function storeFact(db: Database, fact: ImportedFact): Promise<boolean> {
  try {
    const id = randomUUID();
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const expiresAt = nowSec + 90 * 86400; // stable decay = 90 days

    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                         importance, source, created_at, expires_at, last_accessed, confidence)
      VALUES (?, 'shared', ?, ?, ?, ?, ?, 'stable', 1.0, ?, ?, ?, ?, 1.0)
    `).run(id, fact.entity, fact.key, fact.value, fact.text, fact.category, fact.source, now, expiresAt, nowSec);

    // Generate embedding
    const embedding = await getEmbedding(fact.text);
    if (embedding) {
      db.prepare("INSERT INTO fact_embeddings (fact_id, embedding, model) VALUES (?, ?, ?)")
        .run(id, Buffer.from(new Float32Array(embedding).buffer), EMBEDDING_MODEL);
    }

    return true;
  } catch (e) {
    return false;
  }
}

// --- Check for duplicate ---
function isDuplicate(db: Database, entity: string, key: string | null, value: string): boolean {
  const row = key
    ? db.prepare("SELECT id FROM facts WHERE entity = ? AND key = ? AND value = ?").get(entity, key, value)
    : db.prepare("SELECT id FROM facts WHERE entity = ? AND value = ?").get(entity, value);
  return !!row;
}

// ==========================================================================
// IMPORTERS
// ==========================================================================

/** Import from ChatGPT JSON export (conversations format) */
function parseChatGPTExport(filePath: string): ImportedFact[] {
  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  const facts: ImportedFact[] = [];

  // Handle array of conversations
  const conversations = Array.isArray(data) ? data : [data];

  for (const convo of conversations) {
    const title = convo.title || "untitled";
    const mapping = convo.mapping || {};

    // Extract assistant messages
    for (const [, node] of Object.entries(mapping) as [string, any][]) {
      if (!node?.message) continue;
      const msg = node.message;
      if (msg.author?.role !== "assistant") continue;

      const content = msg.content?.parts?.join("\n") || "";
      if (content.length < 50) continue; // skip short responses

      // Extract key decisions/facts from assistant responses
      const lines = content.split("\n").filter((l: string) => l.trim().length > 20);

      // Take meaningful lines (headers, key points, conclusions)
      const keyLines = lines.filter((l: string) =>
        l.startsWith("##") || l.startsWith("- ") || l.startsWith("* ") ||
        l.includes(":") || /^\d+\./.test(l.trim())
      ).slice(0, 5);

      if (keyLines.length > 0) {
        facts.push({
          entity: `chatgpt.${title.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40)}`,
          key: "summary",
          value: keyLines.join("; ").slice(0, 500),
          text: `ChatGPT conversation "${title}": ${keyLines.join("; ").slice(0, 300)}`,
          category: "reference",
          source: `chatgpt:${basename(filePath)}`,
        });
      }
    }
  }

  return facts;
}

/** Import from Obsidian vault (markdown files with YAML frontmatter) */
function parseObsidianVault(dirPath: string): ImportedFact[] {
  const facts: ImportedFact[] = [];

  function walkDir(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (!entry.startsWith(".")) walkDir(fullPath);
        continue;
      }

      if (extname(entry) !== ".md") continue;

      const content = readFileSync(fullPath, "utf-8");
      const name = basename(entry, ".md");

      // Parse YAML frontmatter
      let frontmatter: Record<string, unknown> = {};
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        // Simple YAML parser for key: value pairs
        for (const line of fmMatch[1].split("\n")) {
          const kv = line.match(/^(\w+):\s*(.+)$/);
          if (kv) frontmatter[kv[1]] = kv[2].trim();
        }
      }

      // Get body content (after frontmatter)
      const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
      if (body.length < 30) return; // skip nearly empty files

      // Extract entity from path or frontmatter
      const entity = (frontmatter.entity as string) ||
        `obsidian.${name.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40)}`;
      const category = (frontmatter.category as string) || "reference";

      // Extract key sections (headings and their first paragraph)
      const sections = body.split(/^##\s+/m).filter(s => s.trim().length > 20);

      if (sections.length > 1) {
        // Multiple sections — create a fact per section
        for (const section of sections.slice(0, 8)) {
          const lines = section.split("\n");
          const heading = lines[0]?.trim() || "untitled";
          const sectionBody = lines.slice(1).join(" ").trim().slice(0, 400);
          if (sectionBody.length < 20) continue;

          facts.push({
            entity,
            key: heading.replace(/[^a-zA-Z0-9\s-]/g, "").slice(0, 60),
            value: sectionBody.slice(0, 300),
            text: `${name} — ${heading}: ${sectionBody}`,
            category,
            source: `obsidian:${fullPath}`,
          });
        }
      } else {
        // Single document — one fact
        facts.push({
          entity,
          key: null,
          value: body.slice(0, 500),
          text: `${name}: ${body.slice(0, 400)}`,
          category,
          source: `obsidian:${fullPath}`,
        });
      }
    }
  }

  walkDir(dirPath);
  return facts;
}

/** Import from generic markdown file */
function parseMarkdownFile(filePath: string): ImportedFact[] {
  const content = readFileSync(filePath, "utf-8");
  const name = basename(filePath, ".md");
  const facts: ImportedFact[] = [];

  const entity = `markdown.${name.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 40)}`;

  // Split by headings
  const sections = content.split(/^##?\s+/m).filter(s => s.trim().length > 20);

  if (sections.length > 1) {
    for (const section of sections.slice(0, 10)) {
      const lines = section.split("\n");
      const heading = lines[0]?.trim() || "untitled";
      const body = lines.slice(1).join(" ").trim().slice(0, 400);
      if (body.length < 20) continue;

      facts.push({
        entity,
        key: heading.replace(/[^a-zA-Z0-9\s-]/g, "").slice(0, 60),
        value: body.slice(0, 300),
        text: `${name} — ${heading}: ${body}`,
        category: "reference",
        source: `markdown:${filePath}`,
      });
    }
  } else {
    // Whole document as one fact
    facts.push({
      entity,
      key: null,
      value: content.slice(0, 500),
      text: `${name}: ${content.slice(0, 400)}`,
      category: "reference",
      source: `markdown:${filePath}`,
    });
  }

  return facts;
}

// ==========================================================================
// MAIN
// ==========================================================================

async function main() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") {
      boolFlags.add("dry-run");
    } else if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] || "";
      i++;
    }
  }

  const source = flags.source;
  const path = flags.path;
  const dryRun = boolFlags.has("dry-run");

  if (!source || !path) {
    console.error("Usage: bun import.ts --source <chatgpt|obsidian|markdown> --path <file|dir> [--dry-run]");
    process.exit(1);
  }

  if (!existsSync(path)) {
    console.error(`Path not found: ${path}`);
    process.exit(1);
  }

  console.log(`Importing from ${source}: ${path}${dryRun ? " (dry run)" : ""}\n`);

  // Parse source
  let facts: ImportedFact[];
  switch (source) {
    case "chatgpt":
      facts = parseChatGPTExport(path);
      break;
    case "obsidian":
      facts = parseObsidianVault(path);
      break;
    case "markdown":
      facts = parseMarkdownFile(path);
      break;
    default:
      console.error(`Unknown source: ${source}. Supported: chatgpt, obsidian, markdown`);
      process.exit(1);
  }

  console.log(`Parsed ${facts.length} facts from ${source}.\n`);

  if (facts.length === 0) {
    console.log("No facts to import.");
    return;
  }

  const result: ImportResult = {
    source,
    factsFound: facts.length,
    factsStored: 0,
    factsSkipped: 0,
    errors: [],
  };

  if (dryRun) {
    console.log("=== DRY RUN — Preview ===\n");
    for (const fact of facts.slice(0, 20)) {
      console.log(`  ${fact.entity}.${fact.key || "_"} = ${fact.value.slice(0, 80)}`);
      console.log(`    category: ${fact.category} | source: ${fact.source}`);
      console.log();
    }
    if (facts.length > 20) {
      console.log(`  ... and ${facts.length - 20} more\n`);
    }
    console.log(`Total: ${facts.length} facts would be imported.`);
    return;
  }

  // Store facts
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");

  for (const fact of facts) {
    // Check for duplicates
    if (isDuplicate(db, fact.entity, fact.key, fact.value)) {
      result.factsSkipped++;
      continue;
    }

    const stored = await storeFact(db, fact);
    if (stored) {
      result.factsStored++;
      process.stdout.write(`  Stored: ${fact.entity}.${fact.key || "_"} (${result.factsStored}/${result.factsFound})\r`);
    } else {
      result.errors.push(`Failed to store: ${fact.entity}.${fact.key || "_"}`);
    }
  }

  db.close();

  console.log(`\n\n=== Import Complete ===`);
  console.log(`  Source: ${result.source}`);
  console.log(`  Found: ${result.factsFound}`);
  console.log(`  Stored: ${result.factsStored}`);
  console.log(`  Skipped (duplicates): ${result.factsSkipped}`);
  if (result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`    - ${err}`);
    }
  }
}

main().catch(console.error);
