#!/usr/bin/env bun
/**
 * vault-persona-loader.ts — T6: Persona Context Loader
 *
 * Two-layer context loading for persona-specific vault files:
 *   Layer 1: Convention-based SQL lookup (personas JSON array match)
 *   Layer 2: 1-hop graph expansion via vault_links for enrichment
 *
 * Usage:
 *   bun vault-persona-loader.ts <persona-slug>        # load context
 *   bun vault-persona-loader.ts --list                # list personas + counts
 *   bun vault-persona-loader.ts --all                 # coverage for all personas
 *   Add --json flag for JSON output instead of table
 */

import { Database } from "bun:sqlite";

const DB_PATH = "/home/workspace/.zo/memory/shared-facts.db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConventionFile {
  path: string;
  title: string;
  tags: string[];
}

interface GraphFile {
  path: string;
  title: string;
  relation: string;
  via: string;
}

interface PersonaContext {
  persona: string;
  domain?: string;
  convention_files: ConventionFile[];
  graph_files: GraphFile[];
  total_files: number;
  load_time_ms: number;
}

interface PersonaSummary {
  persona: string;
  file_count: number;
}

// ---------------------------------------------------------------------------
// Layer 1: Convention-based loading
// ---------------------------------------------------------------------------

function loadConventionFiles(db: Database, persona: string, domain?: string): { files: ConventionFile[]; ids: string[] } {
  // Match files where personas JSON array contains the exact slug,
  // or where personas contains "all" (universal files).
  // Optionally filter by domain.
  const domainClause = domain ? ` AND domain = '${domain}'` : "";
  const rows = db.prepare(`
    SELECT id, file_path, title, tags
    FROM vault_files
    WHERE (personas LIKE ? OR personas LIKE '%"all"%')${domainClause}
    ORDER BY backlink_count DESC, link_count DESC
  `).all(`%"${persona}"%`) as Array<{
    id: string;
    file_path: string;
    title: string | null;
    tags: string;
  }>;

  const files: ConventionFile[] = [];
  const ids: string[] = [];

  for (const row of rows) {
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || "[]"); } catch {}
    files.push({
      path: row.file_path,
      title: row.title ?? row.file_path.split("/").pop() ?? "",
      tags,
    });
    ids.push(row.id);
  }

  return { files, ids };
}

// ---------------------------------------------------------------------------
// Layer 2: Graph-based enrichment (1-hop BFS via vault_links)
// ---------------------------------------------------------------------------

const GRAPH_CAP = 10;
const GRAPH_TIMEOUT_MS = 200;

function loadGraphFiles(
  db: Database,
  seedIds: string[],
  excludeIds: Set<string>,
): GraphFile[] {
  if (seedIds.length === 0) return [];

  const startTime = performance.now();
  const visited = new Set<string>(seedIds);
  for (const id of excludeIds) visited.add(id);

  const results: GraphFile[] = [];

  // Build a map of seed id -> title for "via" labeling
  const seedTitleMap = new Map<string, string>();
  for (const sid of seedIds) {
    const row = db.prepare("SELECT title, file_path FROM vault_files WHERE id = ?").get(sid) as {
      title: string | null;
      file_path: string;
    } | null;
    if (row) {
      seedTitleMap.set(sid, row.title ?? row.file_path.split("/").pop() ?? sid);
    }
  }

  // Query 1-hop neighbors for all seeds in batches to stay fast
  // Process seeds in order of importance (they're already sorted by backlink_count)
  for (const seedId of seedIds) {
    if (performance.now() - startTime > GRAPH_TIMEOUT_MS) break;
    if (results.length >= GRAPH_CAP) break;

    const links = db.prepare(`
      SELECT source_id, target_id, relation, weight
      FROM vault_links
      WHERE (source_id = ? OR target_id = ?)
        AND source_id LIKE 'vf-%' AND target_id LIKE 'vf-%'
      ORDER BY weight DESC
      LIMIT 20
    `).all(seedId, seedId) as Array<{
      source_id: string;
      target_id: string;
      relation: string;
      weight: number;
    }>;

    for (const link of links) {
      if (results.length >= GRAPH_CAP) break;

      const neighborId = link.source_id === seedId ? link.target_id : link.source_id;
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      // Resolve neighbor metadata
      const row = db.prepare("SELECT file_path, title FROM vault_files WHERE id = ?").get(neighborId) as {
        file_path: string;
        title: string | null;
      } | null;
      if (!row) continue;

      results.push({
        path: row.file_path,
        title: row.title ?? row.file_path.split("/").pop() ?? "",
        relation: link.relation,
        via: seedTitleMap.get(seedId) ?? seedId,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main: loadPersonaContext
// ---------------------------------------------------------------------------

export function loadPersonaContext(persona: string, domain?: string): PersonaContext {
  const start = performance.now();
  const db = new Database(DB_PATH, { readonly: true });

  try {
    // Layer 1
    const { files: convention_files, ids } = loadConventionFiles(db, persona, domain);
    const excludeSet = new Set(ids);

    // Layer 2
    const graph_files = loadGraphFiles(db, ids, excludeSet);

    const load_time_ms = Math.round((performance.now() - start) * 100) / 100;

    return {
      persona,
      domain,
      convention_files,
      graph_files,
      total_files: convention_files.length + graph_files.length,
      load_time_ms,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// List all personas with file counts
// ---------------------------------------------------------------------------

function listPersonas(): PersonaSummary[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    // Extract distinct persona slugs from JSON arrays
    const rows = db.prepare(`
      SELECT je.value AS persona, COUNT(DISTINCT vf.id) AS cnt
      FROM vault_files vf, json_each(vf.personas) je
      WHERE je.value <> ''
      GROUP BY je.value
      ORDER BY cnt DESC
    `).all() as Array<{ persona: string; cnt: number }>;
    return rows.map(r => ({ persona: r.persona, file_count: r.cnt }));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatTable(ctx: PersonaContext): string {
  const lines: string[] = [];
  lines.push(`\n=== Persona Context: ${ctx.persona} ===`);
  lines.push(`Load time: ${ctx.load_time_ms}ms | Total files: ${ctx.total_files}`);

  lines.push(`\n--- Convention Files (Layer 1): ${ctx.convention_files.length} ---`);
  lines.push("  " + "Title".padEnd(60) + "Tags");
  lines.push("  " + "-".repeat(60) + " " + "-".repeat(30));
  for (const f of ctx.convention_files.slice(0, 30)) {
    const title = f.title.length > 58 ? f.title.slice(0, 55) + "..." : f.title;
    const tags = f.tags.length > 0 ? f.tags.slice(0, 3).join(", ") : "-";
    lines.push("  " + title.padEnd(60) + tags);
  }
  if (ctx.convention_files.length > 30) {
    lines.push(`  ... and ${ctx.convention_files.length - 30} more`);
  }

  lines.push(`\n--- Graph Files (Layer 2): ${ctx.graph_files.length} ---`);
  if (ctx.graph_files.length > 0) {
    lines.push("  " + "Title".padEnd(45) + "Relation".padEnd(18) + "Via");
    lines.push("  " + "-".repeat(45) + " " + "-".repeat(17) + " " + "-".repeat(30));
    for (const f of ctx.graph_files) {
      const title = f.title.length > 43 ? f.title.slice(0, 40) + "..." : f.title;
      const via = f.via.length > 28 ? f.via.slice(0, 25) + "..." : f.via;
      lines.push("  " + title.padEnd(45) + f.relation.padEnd(18) + via);
    }
  }

  return lines.join("\n");
}

function formatListTable(summaries: PersonaSummary[]): string {
  const lines: string[] = [];
  lines.push("\n=== Vault Personas ===");
  lines.push("  " + "Persona".padEnd(45) + "Files");
  lines.push("  " + "-".repeat(45) + " " + "-".repeat(6));
  let total = 0;
  for (const s of summaries) {
    lines.push("  " + s.persona.padEnd(45) + String(s.file_count).padStart(6));
    total += s.file_count;
  }
  lines.push("  " + "-".repeat(52));
  lines.push("  " + "TOTAL (with overlaps)".padEnd(45) + String(total).padStart(6));
  lines.push(`  ${summaries.length} personas`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes("--json");
  const domainIdx = args.indexOf("--domain");
  const domainArg = domainIdx >= 0 ? args[domainIdx + 1] : undefined;
  const filtered = args.filter((a, i) => a !== "--json" && a !== "--domain" && (domainIdx < 0 || i !== domainIdx + 1));

  if (filtered.length === 0 || filtered.includes("--help") || filtered.includes("-h")) {
    console.log(`Usage:
  bun vault-persona-loader.ts <persona-slug>                Load context for a persona
  bun vault-persona-loader.ts <persona-slug> --domain ffb   Filter by knowledge domain
  bun vault-persona-loader.ts --list                        List all personas with file counts
  bun vault-persona-loader.ts --all                         Show coverage for all personas
  Add --json for JSON output

  Domains: ffb, jhf-trading, zouroboros, personal, infrastructure, shared`);
    process.exit(0);
  }

  if (filtered.includes("--list")) {
    const summaries = listPersonas();
    if (jsonFlag) {
      console.log(JSON.stringify(summaries, null, 2));
    } else {
      console.log(formatListTable(summaries));
    }
  } else if (filtered.includes("--all")) {
    const summaries = listPersonas();
    const allContexts: PersonaContext[] = [];
    for (const s of summaries) {
      if (s.persona === "all") continue;
      allContexts.push(loadPersonaContext(s.persona, domainArg));
    }
    if (jsonFlag) {
      console.log(JSON.stringify(allContexts, null, 2));
    } else {
      for (const ctx of allContexts) {
        console.log(formatTable(ctx));
        console.log();
      }
    }
  } else {
    const persona = filtered[0];
    const ctx = loadPersonaContext(persona, domainArg);
    if (jsonFlag) {
      console.log(JSON.stringify(ctx, null, 2));
    } else {
      console.log(formatTable(ctx));
    }
  }
}
