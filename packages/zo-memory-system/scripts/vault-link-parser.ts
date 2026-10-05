#!/usr/bin/env bun
/**
 * vault-link-parser.ts — T2 Zo Vault link parser
 *
 * Extracts 6 link formats from markdown content:
 *   1. [[wikilinks]]
 *   2. [markdown](links.md)  (relative only)
 *   3. `file 'path'`  mentions
 *   4. bare path references (Notes/foo.md)
 *   5. YAML frontmatter references
 *   6. #tags
 *
 * Usage:
 *   bun vault-link-parser.ts <file.md>
 *   bun vault-link-parser.ts --test
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface LinkReference {
  type: 'wikilink' | 'markdown_link' | 'file_mention' | 'bare_path' | 'frontmatter_ref' | 'tag';
  target: string;
  line: number;
  context: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Truncate a string to maxLen chars, trimming whitespace. */
function truncContext(s: string, maxLen = 100): string {
  const trimmed = s.trim();
  return trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Build a Set<number> of line numbers that fall inside regions we must skip:
 *   - fenced code blocks (``` ... ```)
 *   - HTML comments (<!-- ... -->)
 *
 * We also return per-line masks for inline code spans so individual matches
 * can be checked against character offsets.
 */
interface ExclusionInfo {
  excludedLines: Set<number>;
  inlineCodeRanges: Map<number, Array<[number, number]>>; // line -> [start, end] pairs
}

function buildExclusions(lines: string[]): ExclusionInfo {
  const excludedLines = new Set<number>();
  const inlineCodeRanges = new Map<number, Array<[number, number]>>();

  let inFencedBlock = false;
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block toggle (``` or ~~~)
    if (!inHtmlComment && /^[ \t]*(`{3,}|~{3,})/.test(line)) {
      if (!inFencedBlock) {
        inFencedBlock = true;
        excludedLines.add(i);
        continue;
      } else {
        inFencedBlock = false;
        excludedLines.add(i);
        continue;
      }
    }

    if (inFencedBlock) {
      excludedLines.add(i);
      continue;
    }

    // HTML comment handling (may span multiple lines)
    if (inHtmlComment) {
      excludedLines.add(i);
      if (line.includes('-->')) {
        inHtmlComment = false;
      }
      continue;
    }

    if (line.includes('<!--')) {
      if (line.includes('-->')) {
        // Single-line comment — mark the line excluded
        excludedLines.add(i);
      } else {
        inHtmlComment = true;
        excludedLines.add(i);
      }
      continue;
    }

    // Inline code ranges on this line
    const ranges: Array<[number, number]> = [];
    const inlineRe = /`[^`]+`/g;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(line)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
    if (ranges.length > 0) {
      inlineCodeRanges.set(i, ranges);
    }
  }

  return { excludedLines, inlineCodeRanges };
}

/** Check if a character offset on a given line falls inside an inline code span. */
function isInsideInlineCode(
  lineIdx: number,
  charOffset: number,
  inlineCodeRanges: Map<number, Array<[number, number]>>,
): boolean {
  const ranges = inlineCodeRanges.get(lineIdx);
  if (!ranges) return false;
  for (const [start, end] of ranges) {
    if (charOffset >= start && charOffset < end) return true;
  }
  return false;
}

// ── Frontmatter parser ─────────────────────────────────────────────────

const FRONTMATTER_REF_KEYS = new Set([
  'personas', 'depends', 'references', 'related', 'skills',
  'imports', 'sources', 'links', 'requires', 'see_also',
]);

function parseFrontmatter(lines: string[]): LinkReference[] {
  const refs: LinkReference[] = [];
  if (lines.length === 0 || lines[0].trim() !== '---') return refs;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return refs;

  let currentKey = '';
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    // Top-level key
    const keyMatch = line.match(/^(\w[\w_-]*):\s*(.*)/);
    if (keyMatch) {
      currentKey = keyMatch[1].toLowerCase();
      const value = keyMatch[2].trim();
      if (FRONTMATTER_REF_KEYS.has(currentKey) && value && value !== '|' && value !== '>') {
        // Inline value — could be a path or comma-separated list
        for (const part of value.replace(/^\[|\]$/g, '').split(/,\s*/)) {
          const clean = part.trim().replace(/^['"]|['"]$/g, '');
          if (clean) {
            refs.push({
              type: 'frontmatter_ref',
              target: clean,
              line: i + 1,
              context: truncContext(line),
            });
          }
        }
      }
      continue;
    }

    // Array item under a ref key
    if (FRONTMATTER_REF_KEYS.has(currentKey)) {
      const itemMatch = line.match(/^\s+-\s+(.*)/);
      if (itemMatch) {
        const val = itemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (val) {
          refs.push({
            type: 'frontmatter_ref',
            target: val,
            line: i + 1,
            context: truncContext(line),
          });
        }
      }
    }
  }

  return refs;
}

// ── Main parser ────────────────────────────────────────────────────────

export function parseLinks(content: string, filePath: string): LinkReference[] {
  const results: LinkReference[] = [];
  const lines = content.split('\n');
  const { excludedLines, inlineCodeRanges } = buildExclusions(lines);

  // 5. Frontmatter (operates on raw lines, not subject to code-block exclusion
  //    since frontmatter is always at the very top before any code blocks)
  results.push(...parseFrontmatter(lines));

  // Patterns for line-by-line scanning
  const patterns: Array<{
    type: LinkReference['type'];
    re: RegExp;
    extract: (m: RegExpExecArray) => string | null;
  }> = [
    // 1. Wikilinks
    {
      type: 'wikilink',
      re: /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g,
      extract: (m) => m[1].trim(),
    },
    // 2. Markdown links (relative .md only)
    {
      type: 'markdown_link',
      re: /\[([^\]]*)\]\((?!https?:\/\/)([^)]+\.md)\)/g,
      extract: (m) => m[2].trim(),
    },
    // 3. File mentions (`file 'path'`)
    {
      type: 'file_mention',
      re: /`file\s+'([^']+)'`/g,
      extract: (m) => m[1].trim(),
    },
    // 4. Bare path references
    {
      type: 'bare_path',
      re: /(?:^|[\s(,])(([\w.-]+\/)+[\w.-]+\.(?:md|txt|ts|yaml|yml|json|py|sh|sql|css|js|jsx|tsx))/gm,
      extract: (m) => m[1].trim(),
    },
    // 6. Tags
    {
      type: 'tag',
      re: /(?:^|\s)#([\w][\w-]*)/gm,
      extract: (m) => {
        const tag = m[1];
        // Exclude hex colors (#fff, #000000, etc.)
        if (/^[0-9a-fA-F]{3,8}$/.test(tag)) return null;
        return tag;
      },
    },
  ];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (excludedLines.has(lineIdx)) continue;

    const line = lines[lineIdx];

    for (const pat of patterns) {
      pat.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.re.exec(line)) !== null) {
        // Skip if this match is inside inline code (except file_mention which IS inline code)
        if (pat.type !== 'file_mention' && isInsideInlineCode(lineIdx, m.index, inlineCodeRanges)) {
          continue;
        }

        const target = pat.extract(m);
        if (!target) continue;

        // For bare_path, skip if it was already captured as a markdown link or file mention on same line
        if (pat.type === 'bare_path') {
          const isDuplicate = results.some(
            (r) =>
              r.line === lineIdx + 1 &&
              (r.type === 'markdown_link' || r.type === 'file_mention') &&
              r.target === target,
          );
          if (isDuplicate) continue;
        }

        results.push({
          type: pat.type,
          target,
          line: lineIdx + 1,
          context: truncContext(line),
        });
      }
    }
  }

  return results;
}

// ── CLI ────────────────────────────────────────────────────────────────

const TEST_CONTENT = `---
title: Test Document
personas:
  - backend-architect
  - frontend-developer
depends: [Skills/alpaca-trading-skill/SKILL.md, Notes/planning.md]
related: SOUL.md
---

# Test Document

This links to [[Some Note]] and [[path/to/note]] and [[note|display text]].

Check [this doc](./relative/path.md) and [another](Notes/deep/file.md).
But not [external](https://example.com/foo.md).

Reference \`file 'IDENTITY/backend-architect.md'\` and \`file 'SOUL.md'\`.

See also Notes/FFB_Canon/FFB_SKU_CANON.md and Skills/alpaca-trading-skill/SKILL.md in the tree.

Tags: #vault-system #memory-v2 #todo-later

Not a tag in code: \`#not-a-tag\`
Not a hex color: #ff00aa #fff

\`\`\`bash
# This is a comment, not a tag
echo "[[not a link]]"
See Notes/not/a/path.md
\`\`\`

<!-- [[hidden link]] #hidden-tag -->

Back to normal: [[visible link]] #real-tag
`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    console.log('=== Running built-in test ===\n');
    const refs = parseLinks(TEST_CONTENT, 'test.md');
    console.log(JSON.stringify(refs, null, 2));
    console.log(`\nTotal: ${refs.length} references found`);

    // Summarize by type
    const counts: Record<string, number> = {};
    for (const r of refs) {
      counts[r.type] = (counts[r.type] || 0) + 1;
    }
    console.log('\nBy type:');
    for (const [type, count] of Object.entries(counts).sort()) {
      console.log(`  ${type}: ${count}`);
    }
    return;
  }

  if (args.length === 0) {
    console.log('Usage: bun vault-link-parser.ts <file.md> | --test');
    process.exit(1);
  }

  const filePath = args[0];
  const content = await Bun.file(filePath).text();
  const refs = parseLinks(content, filePath);
  console.log(JSON.stringify(refs, null, 2));
  console.log(`\nTotal: ${refs.length} references found`);
}

// Run CLI when executed directly (not when imported)
const isMain = import.meta.url === Bun.main || process.argv[1]?.endsWith('vault-link-parser.ts');
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
