#!/usr/bin/env bun
/**
 * vault-index.ts — T3 Zo Vault Indexer
 *
 * Crawls workspace .md files, registers them in vault_files,
 * parses links via vault-link-parser, and populates fact_links.
 *
 * Usage:
 *   bun vault-index.ts              # incremental (default)
 *   bun vault-index.ts --full       # full reindex
 *   bun vault-index.ts --dry-run    # preview without writing
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { readdir, stat, readFile } from "fs/promises";
import { join, basename, resolve, relative, dirname } from "path";
import { parseLinks, type LinkReference } from "./vault-link-parser.ts";
import { classifyDomain } from "./domain-classifier.ts";

// ── Config ───────────────────────────────────────────────────────────────

const WORKSPACE = "/home/workspace";
const DB_PATH = process.env.ZO_MEMORY_DB || join(WORKSPACE, ".zo/memory/shared-facts.db");

const EXCLUDE_DIRS = new Set([
  "Backups",
  "Archive",
  "Trash",
  "node_modules",
  "read_webpage",
  "browser_agent",
  ".git",
  "venv",
  "dist-info",
  "site-packages",
]);

/** Extra paths to include even if they'd normally be skipped */
const EXTRA_INCLUDE_GLOBS = [
  join(WORKSPACE, ".zo/memory/personas"),
];

const PERSONA_MAP: Record<string, string[]> = {
  "Projects/ffb/": ["ffb-marketing", "ffb-support", "ffb-ops", "ffb-engineering"],
  "Notes/FFB_Canon/": ["ffb-marketing", "ffb-ops"],
  "Skills/alpaca-trading-skill/": ["financial-advisor", "trading-strategist"],
  "Skills/alphavantage-skill/": ["financial-advisor"],
  "Skills/backtesting-skill/": ["financial-advisor", "trading-strategist"],
  "Projects/jhf-trading-platform/": ["financial-advisor", "trading-strategist"],
  "OmniRoute/": ["agents-orchestrator"],
  "Skills/zo-swarm-orchestrator/": ["agents-orchestrator"],
  "Skills/zo-memory-system/": ["agents-orchestrator"],
  "IDENTITY/": ["all"],
  "Infrastructure/": ["devops-automator", "platform-engineer"],
  "Security/": ["security-auditor"],
  "Prompts/": ["all"],
};

// ── Helpers ──────────────────────────────────────────────────────────────

function filePathToId(filePath: string): string {
  const hash = createHash("sha256").update(filePath).digest("hex");
  return `vf-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function extractTitle(content: string, filePath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return basename(filePath, ".md");
}

function extractTags(content: string): string[] {
  const tags = new Set<string>();
  const re = /(?:^|\s)#([\w][\w-]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tag = m[1];
    if (!/^[0-9a-fA-F]{3,8}$/.test(tag)) {
      tags.add(tag);
    }
  }
  return [...tags];
}

function resolvePersonas(filePath: string): string[] {
  const relPath = relative(WORKSPACE, filePath);
  const personas = new Set<string>();
  for (const [prefix, personaList] of Object.entries(PERSONA_MAP)) {
    if (relPath.startsWith(prefix)) {
      for (const p of personaList) personas.add(p);
    }
  }
  return [...personas];
}

// ── Crawl ────────────────────────────────────────────────────────────────

async function crawlDirectory(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string) {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // skip unreadable dirs
    }

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        // Skip hidden dirs except .zo
        if (entry.name.startsWith(".") && entry.name !== ".zo") continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);

  // Include extra paths
  for (const extraDir of EXTRA_INCLUDE_GLOBS) {
    try {
      const entries = await readdir(extraDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const fullPath = join(extraDir, entry.name);
          if (!results.includes(fullPath)) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // extra dir may not exist
    }
  }

  return results;
}

// ── Schema Migration ─────────────────────────────────────────────────────

function ensureSchema(db: Database) {
  db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_files (
      id            TEXT PRIMARY KEY,
      file_path     TEXT NOT NULL UNIQUE,
      title         TEXT,
      tags          TEXT DEFAULT '[]',
      personas      TEXT DEFAULT '[]',
      last_indexed  INTEGER,
      mtime         INTEGER,
      link_count    INTEGER DEFAULT 0,
      backlink_count INTEGER DEFAULT 0
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_files_path ON vault_files(file_path);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // fact_links already exists with FK constraints to facts(id).
  // We need a separate vault_links table or drop the FK constraint.
  // Since the existing fact_links has REFERENCES facts(id) ON DELETE CASCADE,
  // and vault file IDs (vf-...) aren't in facts, we create a vault_links table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_links (
      source_id   TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      relation    TEXT NOT NULL DEFAULT 'related',
      weight      REAL DEFAULT 1.0,
      created_at  INTEGER DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (source_id, target_id, relation)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_links_source ON vault_links(source_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vault_links_target ON vault_links(target_id);`);
}

// ── Link Resolution ──────────────────────────────────────────────────────

interface ResolvedLink {
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
}

function resolveLinks(
  fileId: string,
  filePath: string,
  links: LinkReference[],
  pathToId: Map<string, string>,
  entityToFactId: Map<string, string>,
): ResolvedLink[] {
  const resolved: ResolvedLink[] = [];
  const seen = new Set<string>();
  const fileDir = dirname(filePath);

  for (const link of links) {
    let targetId: string | undefined;
    let relation = "references";

    if (link.type === "tag") {
      // Tags become tag.{name} entities
      targetId = `tag.${link.target}`;
      relation = "tagged";
    } else {
      // Try to resolve as file path
      const target = link.target;

      // Try multiple resolution strategies
      const candidates: string[] = [];

      // Absolute path from workspace
      candidates.push(join(WORKSPACE, target));
      // Relative to current file
      candidates.push(resolve(fileDir, target));
      // Append .md if missing
      if (!target.endsWith(".md")) {
        candidates.push(join(WORKSPACE, target + ".md"));
        candidates.push(resolve(fileDir, target + ".md"));
      }
      // Wikilink: search by filename
      if (link.type === "wikilink") {
        const wikiTarget = target.replace(/\s+/g, "-");
        // Search all known paths for a matching filename
        for (const [knownPath, knownId] of pathToId) {
          const bn = basename(knownPath, ".md");
          if (bn.toLowerCase() === wikiTarget.toLowerCase() || bn.toLowerCase() === target.toLowerCase()) {
            targetId = knownId;
            break;
          }
        }
      }

      if (!targetId) {
        for (const candidate of candidates) {
          const id = pathToId.get(candidate);
          if (id) {
            targetId = id;
            break;
          }
        }
      }

      // Try matching against facts entity names
      if (!targetId) {
        const factId = entityToFactId.get(target.toLowerCase());
        if (factId) {
          targetId = factId;
          relation = "references_fact";
        }
      }

      // Map link type to relation
      if (targetId && relation === "references") {
        switch (link.type) {
          case "wikilink":
            relation = "wikilink";
            break;
          case "markdown_link":
            relation = "markdown_link";
            break;
          case "frontmatter_ref":
            relation = "depends_on";
            break;
          case "file_mention":
            relation = "mentions";
            break;
          case "bare_path":
            relation = "references";
            break;
        }
      }
    }

    if (!targetId) continue;

    // Deduplicate
    const key = `${fileId}|${targetId}|${relation}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Don't self-link
    if (fileId === targetId) continue;

    resolved.push({
      sourceId: fileId,
      targetId,
      relation,
      weight: 1.0,
    });
  }

  return resolved;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = new Set(process.argv.slice(2));
  const fullMode = args.has("--full");
  const dryRun = args.has("--dry-run");
  const reclassify = args.has("--reclassify");

  const startTime = performance.now();

  // Open database
  const db = new Database(DB_PATH);
  ensureSchema(db);

  // Get last run timestamp for incremental mode
  let lastRunTs = 0;
  if (!fullMode) {
    const row = db.query("SELECT value FROM vault_meta WHERE key = 'last_index_run'").get() as { value: string } | null;
    if (row) lastRunTs = parseInt(row.value, 10) || 0;
  }

  // In full mode, clear vault links
  if (fullMode && !dryRun) {
    db.exec("DELETE FROM vault_links WHERE source_id LIKE 'vf-%' OR target_id LIKE 'vf-%'");
    // Also clear from fact_links if any leaked in
    try {
      db.exec("DELETE FROM fact_links WHERE source_id LIKE 'vf-%' OR target_id LIKE 'vf-%'");
    } catch { /* table may have FK constraints */ }
  }

  // Crawl
  console.log(`[vault-index] Crawling ${WORKSPACE} ...`);
  const allFiles = await crawlDirectory(WORKSPACE);
  console.log(`[vault-index] Found ${allFiles.length} .md files`);

  // Build path→id map for ALL files (needed for link resolution)
  const pathToId = new Map<string, string>();
  for (const fp of allFiles) {
    pathToId.set(fp, filePathToId(fp));
  }

  // Purge stale entries: files in vault_files that no longer exist on disk
  // (or are now under an excluded dir). Catches deletions the indexer
  // previously had no way to observe.
  if (!dryRun) {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS _live_paths (file_path TEXT PRIMARY KEY);");
    db.exec("DELETE FROM _live_paths;");
    const insertLive = db.prepare("INSERT OR IGNORE INTO _live_paths (file_path) VALUES (?)");
    const tx = db.transaction((paths: string[]) => {
      for (const p of paths) insertLive.run(p);
    });
    tx(allFiles);

    const before = (db.query("SELECT COUNT(*) AS n FROM vault_files").get() as { n: number }).n;
    db.exec(`
      DELETE FROM vault_links
       WHERE source_id IN (SELECT id FROM vault_files WHERE file_path NOT IN (SELECT file_path FROM _live_paths))
          OR target_id IN (SELECT id FROM vault_files WHERE file_path NOT IN (SELECT file_path FROM _live_paths));
    `);
    db.exec("DELETE FROM vault_files WHERE file_path NOT IN (SELECT file_path FROM _live_paths);");
    const removed = before - (db.query("SELECT COUNT(*) AS n FROM vault_files").get() as { n: number }).n;
    if (removed > 0) {
      console.log(`[vault-index] Purged ${removed} stale file entries (deleted or newly excluded)`);
    }
  }

  // Load fact entities for cross-referencing
  const entityToFactId = new Map<string, string>();
  try {
    const facts = db.query("SELECT id, entity FROM facts").all() as Array<{ id: string; entity: string }>;
    for (const f of facts) {
      entityToFactId.set(f.entity.toLowerCase(), f.id);
    }
  } catch { /* facts table may not exist */ }

  // Determine which files to process
  let filesToProcess: string[];
  if (fullMode) {
    filesToProcess = allFiles;
  } else {
    // Incremental: only files modified since last run
    filesToProcess = [];
    for (const fp of allFiles) {
      try {
        const st = await stat(fp);
        const mtimeSec = Math.floor(st.mtimeMs / 1000);
        if (mtimeSec > lastRunTs) {
          filesToProcess.push(fp);
        }
      } catch {
        // file may have been deleted between crawl and stat
      }
    }
  }

  console.log(`[vault-index] Files to process: ${filesToProcess.length} (mode: ${fullMode ? "full" : "incremental"})`);

  if (dryRun) {
    console.log("\n[vault-index] DRY RUN — files that would be indexed:");
    for (const fp of filesToProcess.slice(0, 50)) {
      console.log(`  ${relative(WORKSPACE, fp)}`);
    }
    if (filesToProcess.length > 50) {
      console.log(`  ... and ${filesToProcess.length - 50} more`);
    }
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`\n[vault-index] Dry run complete in ${elapsed}s`);
    db.close();
    return;
  }

  // Prepare statements
  const upsertFile = db.prepare(`
    INSERT INTO vault_files (id, file_path, title, tags, personas, last_indexed, mtime, link_count, backlink_count, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      file_path = excluded.file_path,
      title = excluded.title,
      tags = excluded.tags,
      personas = excluded.personas,
      last_indexed = excluded.last_indexed,
      mtime = excluded.mtime,
      domain = excluded.domain
  `);

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO vault_links (source_id, target_id, relation, weight)
    VALUES (?, ?, ?, ?)
  `);

  const nowSec = Math.floor(Date.now() / 1000);
  let filesIndexed = 0;
  let totalLinksCreated = 0;
  let allResolvedLinks: ResolvedLink[] = [];

  // Phase 1: Register all files first (needed for link resolution)
  const registerTx = db.transaction(() => {
    for (const fp of filesToProcess) {
      try {
        const content = require("fs").readFileSync(fp, "utf-8");
        const st = require("fs").statSync(fp);
        const mtimeSec = Math.floor(st.mtimeMs / 1000);
        const id = filePathToId(fp);
        const title = extractTitle(content, fp);
        const tags = extractTags(content);
        const personas = resolvePersonas(fp);

        const domain = classifyDomain(fp);
        upsertFile.run(
          id,
          fp,
          title,
          JSON.stringify(tags),
          JSON.stringify(personas),
          nowSec,
          mtimeSec,
          domain,
        );
        filesIndexed++;
      } catch (err) {
        console.error(`[vault-index] Error registering ${fp}: ${err}`);
      }
    }
  });
  registerTx();

  console.log(`[vault-index] Registered ${filesIndexed} files`);

  // Phase 2: Parse links and resolve
  for (const fp of filesToProcess) {
    try {
      const content = require("fs").readFileSync(fp, "utf-8");
      const id = filePathToId(fp);
      const links = parseLinks(content, fp);
      const resolved = resolveLinks(id, fp, links, pathToId, entityToFactId);
      allResolvedLinks.push(...resolved);
    } catch (err) {
      console.error(`[vault-index] Error parsing links for ${fp}: ${err}`);
    }
  }

  // Phase 3: Insert links in a transaction
  if (fullMode) {
    // In full mode we already cleared; in incremental, clear links for reprocessed files
  } else {
    // Clear existing links for files we're reprocessing
    const clearLinks = db.prepare("DELETE FROM vault_links WHERE source_id = ?");
    const clearTx = db.transaction(() => {
      for (const fp of filesToProcess) {
        clearLinks.run(filePathToId(fp));
      }
    });
    clearTx();
  }

  const linkTx = db.transaction(() => {
    for (const link of allResolvedLinks) {
      insertLink.run(link.sourceId, link.targetId, link.relation, link.weight);
    }
  });
  linkTx();
  totalLinksCreated = allResolvedLinks.length;

  console.log(`[vault-index] Created ${totalLinksCreated} links`);

  // Phase 4: Update link and backlink counts
  db.exec(`
    UPDATE vault_files SET link_count = (
      SELECT COUNT(*) FROM vault_links WHERE source_id = vault_files.id
    );
  `);
  db.exec(`
    UPDATE vault_files SET backlink_count = (
      SELECT COUNT(*) FROM vault_links WHERE target_id = vault_files.id
    );
  `);

  // Reclassify domains on all files if requested
  if (reclassify) {
    const allVaultFiles = db.query("SELECT id, file_path FROM vault_files").all() as { id: string; file_path: string }[];
    const updateDomain = db.prepare("UPDATE vault_files SET domain = ? WHERE id = ?");
    const reclTx = db.transaction(() => {
      for (const row of allVaultFiles) {
        updateDomain.run(classifyDomain(row.file_path), row.id);
      }
    });
    reclTx();
    console.log(`[vault-index] Reclassified domains for ${allVaultFiles.length} files`);
  }

  // Store run timestamp
  db.exec(`
    INSERT INTO vault_meta (key, value) VALUES ('last_index_run', '${nowSec}')
    ON CONFLICT(key) DO UPDATE SET value = '${nowSec}'
  `);

  db.close();

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

  console.log(`\n[vault-index] === Summary ===`);
  console.log(`  Mode:           ${fullMode ? "full" : "incremental"}`);
  console.log(`  Files found:    ${allFiles.length}`);
  console.log(`  Files indexed:  ${filesIndexed}`);
  console.log(`  Links created:  ${totalLinksCreated}`);
  console.log(`  Duration:       ${elapsed}s`);
  console.log(`  Database:       ${DB_PATH}`);
}

main().catch((err) => {
  console.error("[vault-index] Fatal:", err);
  process.exit(1);
});
