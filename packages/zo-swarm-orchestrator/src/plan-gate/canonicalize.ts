/**
 * Plan Consensus Gate – deterministic canonicalization and SHA-256 hashing.
 *
 * Semantically equivalent plan inputs in YAML, JSON, or Markdown produce
 * identical canonical strings and identical hashes (AC-01).
 *
 * Algorithm:
 *   1. Parse to a plain JS object (format-agnostic).
 *   2. Trim all string values.
 *   3. Deep-sort all object keys alphabetically.
 *   4. Serialize to JSON (no extra spaces).
 *   5. Hash with SHA-256 → lowercase hex.
 */

import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { PlanArtifact } from './types.js';

export type CanonicalizeFormat = 'yaml' | 'json' | 'markdown';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

function trimStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(trimStrings);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = trimStrings(v);
    }
    return out;
  }
  return value;
}

/**
 * Extract YAML frontmatter from a Markdown string (content between the first
 * pair of `---` fence lines).  Returns null when no frontmatter is present.
 */
function extractMarkdownFrontmatter(md: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an artifact string in the given format to a plain object.
 * YAML and JSON representations of the same data produce structurally
 * identical objects before canonicalization.
 */
export function parsePlanArtifactInput(
  input: string,
  format: CanonicalizeFormat
): Record<string, unknown> {
  switch (format) {
    case 'json':
      return JSON.parse(input) as Record<string, unknown>;
    case 'yaml':
      return parseYaml(input) as Record<string, unknown>;
    case 'markdown': {
      const fm = extractMarkdownFrontmatter(input);
      if (fm !== null) {
        return parseYaml(fm) as Record<string, unknown>;
      }
      return { content: input.trim() };
    }
  }
}

/**
 * Produce a deterministic canonical JSON string from a PlanArtifact.
 * Key ordering and string whitespace are normalized so semantically
 * equivalent objects always produce the same string.
 */
export function canonicalizePlanArtifact(artifact: PlanArtifact): string {
  const trimmed = trimStrings(artifact);
  const sorted = sortKeys(trimmed);
  return JSON.stringify(sorted);
}

/**
 * Compute the SHA-256 hash of the canonicalized plan artifact.
 * Returns a lowercase 64-character hex string.
 */
export function hashPlanArtifact(artifact: PlanArtifact): string {
  const canonical = canonicalizePlanArtifact(artifact);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Parse a string in any supported format and return its canonical JSON string.
 * Semantically equivalent inputs in YAML and JSON produce the same output.
 */
export function canonicalizePlanInput(
  input: string,
  format: CanonicalizeFormat
): string {
  const parsed = parsePlanArtifactInput(input, format) as PlanArtifact;
  return canonicalizePlanArtifact(parsed);
}

/**
 * Parse a string in any supported format and return its SHA-256 hash.
 * Semantically equivalent inputs hash identically regardless of format.
 */
export function hashPlanInput(
  input: string,
  format: CanonicalizeFormat
): string {
  const parsed = parsePlanArtifactInput(input, format) as PlanArtifact;
  return hashPlanArtifact(parsed);
}
