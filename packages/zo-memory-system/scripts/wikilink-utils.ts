#!/usr/bin/env bun
/**
 * wikilink-utils.ts — Shared wikilink extraction and resolution for the Zouroboros memory system
 *
 * Extracts [[entity]] and [[entity|display]] from text, resolves targets to
 * existing fact IDs or vault_file IDs, and creates stub facts for forward references.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";

export interface ParsedWikilink {
  raw: string;
  entity: string;
  display: string | null;
}

export interface ResolvedWikilink extends ParsedWikilink {
  targetId: string;
  isStub: boolean;
}

// --- Exclusion Filter ---
// Entity-like pattern: category.subject format (e.g., project.ffb, system.memory)
export const ENTITY_LIKE_PATTERN = /\b([a-z][a-z0-9_-]+\.(?:[a-z][a-z0-9_-]+))\b/g;

// File extensions to exclude from wikilink wrapping
const EXCLUDED_EXTENSIONS = new Set([
  ".ts", ".js", ".json", ".yaml", ".yml", ".py", ".sh", ".css", ".html",
  ".sql", ".toml", ".lock", ".env", ".log", ".csv", ".txt", ".md",
  ".tsx", ".jsx", ".mjs", ".cjs", ".xml", ".svg", ".png", ".jpg",
]);

// URL TLDs to exclude
const URL_TLDS = [".com", ".org", ".net", ".io", ".dev", ".app", ".co", ".ai"];

// Version string pattern: v1.0, v2.3.1, etc.
const VERSION_RE = /^v\d+\.\d+/i;

// Common abbreviations with periods
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc.", "vs.", "a.m", "p.m", "u.s", "no."]);

export function shouldExcludeFromWrapping(candidate: string): boolean {
  const lower = candidate.toLowerCase();

  // File extension check
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = lower.slice(dotIdx);
    if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  }

  // URL TLD check
  for (const tld of URL_TLDS) {
    if (lower.includes(tld)) return true;
  }

  // Version string check
  if (VERSION_RE.test(candidate)) return true;

  // Abbreviation check
  if (ABBREVIATIONS.has(lower)) return true;

  // Numeric-heavy: more digits than letters (likely a version or ID)
  const digits = (candidate.match(/\d/g) || []).length;
  const letters = (candidate.match(/[a-z]/gi) || []).length;
  if (digits > letters && digits > 2) return true;

  return false;
}

// --- Auto-Correction ---
export interface WikilinkAutoCorrection {
  original_value: string;
  corrected_value: string;
  corrections_made: Array<{ entity: string; position: number }>;
  confidence_tier: "known" | "pattern";
}

export function autoCorrectWikilinks(
  value: string,
  db?: Database | null,
  selfEntity?: string
): WikilinkAutoCorrection | null {
  // Find existing wikilinks to avoid double-wrapping
  const existingWikilinks = extractWikilinks(value);
  const wikilinkedEntities = new Set(existingWikilinks.map(w => w.entity.toLowerCase()));

  // Build set of known entities from DB for high-confidence tier
  const knownEntities = new Set<string>();
  if (db) {
    try {
      const rows = db.prepare(
        "SELECT DISTINCT entity FROM facts WHERE value != '' AND key != 'stub' LIMIT 5000"
      ).all() as Array<{ entity: string }>;
      for (const row of rows) knownEntities.add(row.entity.toLowerCase());
    } catch { /* DB may not be available */ }
  }

  const corrections: Array<{ entity: string; position: number; tier: "known" | "pattern" }> = [];

  ENTITY_LIKE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENTITY_LIKE_PATTERN.exec(value)) !== null) {
    const candidate = match[1];
    const lower = candidate.toLowerCase();

    // Skip self-references
    if (selfEntity && lower === selfEntity.toLowerCase()) continue;

    // Skip already-wikilinked
    if (wikilinkedEntities.has(lower)) continue;

    // Skip excluded patterns
    if (shouldExcludeFromWrapping(candidate)) continue;

    // Check if inside existing [[...]] brackets
    const before = value.slice(0, match.index);
    const openBrackets = (before.match(/\[\[/g) || []).length;
    const closeBrackets = (before.match(/\]\]/g) || []).length;
    if (openBrackets > closeBrackets) continue; // inside wikilink already

    // Determine confidence tier
    if (knownEntities.has(lower)) {
      corrections.push({ entity: candidate, position: match.index, tier: "known" });
    } else {
      // Pattern tier: only wrap if it matches canonical category.subject format
      // Already guaranteed by ENTITY_LIKE_PATTERN regex
      corrections.push({ entity: candidate, position: match.index, tier: "pattern" });
    }
  }

  if (corrections.length === 0) return null;

  // Apply corrections in reverse order to preserve positions
  let corrected = value;
  for (const corr of corrections.sort((a, b) => b.position - a.position)) {
    corrected =
      corrected.slice(0, corr.position) +
      `[[${corr.entity}]]` +
      corrected.slice(corr.position + corr.entity.length);
  }

  return {
    original_value: value,
    corrected_value: corrected,
    corrections_made: corrections.map(c => ({ entity: c.entity, position: c.position })),
    confidence_tier: corrections.some(c => c.tier === "known") ? "known" : "pattern",
  };
}

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function extractWikilinks(text: string): ParsedWikilink[] {
  const results: ParsedWikilink[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const entity = m[1].trim();
    if (seen.has(entity)) continue;
    seen.add(entity);
    results.push({
      raw: m[0],
      entity,
      display: m[2]?.trim() || null,
    });
  }

  return results;
}

export function resolveWikilinkTargets(
  db: Database,
  wikilinks: ParsedWikilink[],
  options: { sourcePersona: string; sourceId: string }
): ResolvedWikilink[] {
  const resolved: ResolvedWikilink[] = [];

  const findFact = db.prepare(
    "SELECT id FROM facts WHERE entity = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1"
  );
  const findVaultFile = db.prepare(
    "SELECT id FROM vault_files WHERE title = ? COLLATE NOCASE LIMIT 1"
  );
  const nowSec = Math.floor(Date.now() / 1000);

  for (const wl of wikilinks) {
    // 1. Try matching an existing fact by entity name
    const factRow = findFact.get(wl.entity, nowSec) as { id: string } | null;
    if (factRow) {
      resolved.push({ ...wl, targetId: factRow.id, isStub: false });
      continue;
    }

    // 2. Try matching a vault_file by title
    try {
      const vaultRow = findVaultFile.get(wl.entity) as { id: string } | null;
      if (vaultRow) {
        resolved.push({ ...wl, targetId: vaultRow.id, isStub: false });
        continue;
      }
    } catch {
      // vault_files table may not exist yet
    }

    // 3. Forward reference — create stub fact
    const stubId = randomUUID();
    const now = Date.now();
    const nowSecLocal = Math.floor(now / 1000);

    db.prepare(`
      INSERT INTO facts (id, persona, entity, key, value, text, category, decay_class,
                         importance, source, created_at, expires_at, last_accessed, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stubId,
      options.sourcePersona,
      wl.entity,
      "stub",
      "",
      `${wl.entity} (forward reference)`,
      "reference",
      "stable",
      0.5,
      `wikilink-stub:${options.sourceId}`,
      now,
      null, // stable = 90 days, but stubs are permanent placeholders
      nowSecLocal,
      0.3,
      JSON.stringify({ stub: true, created_by: options.sourceId })
    );

    resolved.push({ ...wl, targetId: stubId, isStub: true });
  }

  return resolved;
}

export function resolveWikilinksInText(
  db: Database,
  text: string
): Array<{ entity: string; factId: string; value: string }> {
  const wikilinks = extractWikilinks(text);
  if (wikilinks.length === 0) return [];

  const findFact = db.prepare(
    "SELECT id, value FROM facts WHERE entity = ? AND value != '' AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1"
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const results: Array<{ entity: string; factId: string; value: string }> = [];

  for (const wl of wikilinks) {
    const row = findFact.get(wl.entity, nowSec) as { id: string; value: string } | null;
    if (row && row.value) {
      results.push({ entity: wl.entity, factId: row.id, value: row.value });
    }
  }

  return results;
}
