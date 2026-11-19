#!/usr/bin/env bun
/**
 * vault.ts — Unified Vault CLI (T7)
 *
 * Subcommands:
 *   index [--full] [--dry-run]         Re-index vault files
 *   query backlinks <target>           Show what links TO a file/entity
 *   query neighbors <target> [--depth] Graph walk from a node (BFS)
 *   query orphans                      Files with zero links
 *   query path <source> <target>       Shortest path between two nodes
 *   stats                              Vault health statistics
 *   persona <slug>                     Load a persona context
 *
 * Global flags: --json, --help
 */

import { Database } from "bun:sqlite";
import { resolve, dirname, basename } from "path";
import { spawnSync } from "child_process";

// ── constants ──────────────────────────────────────────────────────
const DB_PATH = "/home/workspace/.zo/memory/shared-facts.db";
const WORKSPACE = "/home/workspace";
const SCRIPTS_DIR = dirname(new URL(import.meta.url).pathname);

// Archive directories excluded from orphan metric — standalone deliverables by design
const ARCHIVE_DIRS = [
  "Audits", "Articles", "BrandDesignPack", "Documents", "FFBSourceFiles",
  "FFB_Photos", "FFB_Canon", "Images", "Audio", "IDENTITY", "Fauna&Flora",
  "Infrastructure", "Backups", "Archive", "Trash",
];

// SQL fragment: exclude archive dirs from vault_files queries
const ARCHIVE_EXCLUSION = ARCHIVE_DIRS
  .map(d => `file_path NOT LIKE '%/${d}/%'`)
  .join(" AND ");

// ── arg parsing ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
  full: args.includes("--full"),
  dryRun: args.includes("--dry-run"),
  depth: 1,
};

// extract --depth N
const depthIdx = args.indexOf("--depth");
if (depthIdx !== -1 && args[depthIdx + 1]) {
  flags.depth = parseInt(args[depthIdx + 1], 10) || 1;
}

// strip flags from positional args
const positional = args.filter(
  (a) => !a.startsWith("--") && !a.startsWith("-h")
);
// also remove the number after --depth
const cleanPositional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--depth") { i++; continue; }
  if (args[i].startsWith("--") || args[i] === "-h") continue;
  cleanPositional.push(args[i]);
}

const sub = cleanPositional[0] ?? "";
const sub2 = cleanPositional[1] ?? "";

// ── helpers ────────────────────────────────────────────────────────
function openDb(): Database {
  return new Database(DB_PATH, { readonly: true });
}

function out(data: unknown) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  }
}

function table(rows: Record<string, unknown>[], columns?: string[]) {
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]);
  // compute widths
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))
  );
  const sep = widths.map((w) => "-".repeat(w)).join(" | ");
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(" | ");
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    console.log(cols.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join(" | "));
  }
}

function shortPath(p: string): string {
  if (p.startsWith(WORKSPACE + "/")) return p.slice(WORKSPACE.length + 1);
  return p;
}

/**
 * Resolve a user-supplied target (file path fragment, basename, or entity name)
 * to a vault_files id. Returns { id, file_path } or null.
 */
function resolveTarget(db: Database, target: string): { id: string; file_path: string } | null {
  // try exact file_path match (absolute)
  let abs = target.startsWith("/") ? target : resolve(WORKSPACE, target);
  let row = db.query("SELECT id, file_path FROM vault_files WHERE file_path = ?").get(abs) as any;
  if (row) return row;

  // try suffix match (basename or partial path)
  const rows = db
    .query("SELECT id, file_path FROM vault_files WHERE file_path LIKE ? ORDER BY length(file_path) ASC")
    .all(`%/${target}`) as any[];
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) {
    // prefer workspace-root match
    const root = rows.find((r: any) => r.file_path === `${WORKSPACE}/${target}`);
    if (root) return root;
    return rows[0]; // first (shortest path)
  }

  // try as a tag or entity id directly
  const linkRow = db
    .query("SELECT DISTINCT target_id as id FROM vault_links WHERE target_id = ? UNION SELECT DISTINCT source_id as id FROM vault_links WHERE source_id = ?")
    .get(target, target) as any;
  if (linkRow) return { id: linkRow.id, file_path: target };

  return null;
}

function filePathForId(db: Database, id: string): string {
  const row = db.query("SELECT file_path FROM vault_files WHERE id = ?").get(id) as any;
  return row ? shortPath(row.file_path) : id;
}

// ── subcommand: help ───────────────────────────────────────────────
function showHelp() {
  console.log(`
Zo Vault CLI — unified vault operations

USAGE
  bun vault.ts <command> [options]

COMMANDS
  index [--full] [--dry-run]          Re-index vault files
  query backlinks <target>            Show what links TO a file or entity
  query neighbors <target> [--depth N] BFS graph walk (default depth 1)
  query orphans                       Files with zero links
  query path <source> <target>        Shortest path between two nodes (max 5)
  stats                               Vault health statistics
  persona <slug>                      Load a persona context

GLOBAL FLAGS
  --json    Machine-readable JSON output
  --help    Show this help

EXAMPLES
  bun vault.ts stats
  bun vault.ts query backlinks AGENTS.md
  bun vault.ts query neighbors SOUL.md --depth 2
  bun vault.ts query orphans
  bun vault.ts query path AGENTS.md SOUL.md
  bun vault.ts stats --json
`.trim());
}

// ── subcommand: index ──────────────────────────────────────────────
function cmdIndex() {
  if (flags.help) {
    console.log("Usage: bun vault.ts index [--full] [--dry-run]");
    return;
  }
  const indexScript = resolve(SCRIPTS_DIR, "vault-index.ts");
  const spawnArgs = ["bun", indexScript];
  if (flags.full) spawnArgs.push("--full");
  if (flags.dryRun) spawnArgs.push("--dry-run");
  console.log(`Delegating: ${spawnArgs.join(" ")}`);
  const result = spawnSync(spawnArgs[0], spawnArgs.slice(1), {
    stdio: "inherit",
    cwd: WORKSPACE,
  });
  process.exit(result.status ?? 1);
}

// ── subcommand: query backlinks ────────────────────────────────────
function cmdBacklinks() {
  const target = cleanPositional[2];
  if (!target || flags.help) {
    console.log("Usage: bun vault.ts query backlinks <target>");
    return;
  }
  const db = openDb();
  const resolved = resolveTarget(db, target);
  if (!resolved) {
    console.error(`Target not found: ${target}`);
    db.close();
    process.exit(1);
  }

  const rows = db
    .query(
      `SELECT vl.source_id, vl.relation, vl.weight
       FROM vault_links vl
       WHERE vl.target_id = ?
       ORDER BY vl.weight DESC`
    )
    .all(resolved.id) as any[];

  const display = rows.map((r: any) => ({
    source: filePathForId(db, r.source_id),
    relation: r.relation,
    weight: r.weight,
  }));

  if (!flags.json) {
    console.log(`Backlinks to: ${shortPath(resolved.file_path)} (${rows.length} total)\n`);
  }
  table(display);
  db.close();
}

// ── subcommand: query neighbors ────────────────────────────────────
function cmdNeighbors() {
  const target = cleanPositional[2];
  if (!target || flags.help) {
    console.log("Usage: bun vault.ts query neighbors <target> [--depth N]");
    return;
  }
  const db = openDb();
  const resolved = resolveTarget(db, target);
  if (!resolved) {
    console.error(`Target not found: ${target}`);
    db.close();
    process.exit(1);
  }

  const maxDepth = flags.depth;
  // BFS
  const visited = new Map<string, { depth: number; relation: string; weight: number }>();
  visited.set(resolved.id, { depth: 0, relation: "(origin)", weight: 0 });
  let frontier = [resolved.id];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      // outgoing
      const outgoing = db
        .query("SELECT target_id, relation, weight FROM vault_links WHERE source_id = ?")
        .all(nodeId) as any[];
      // incoming
      const incoming = db
        .query("SELECT source_id, relation, weight FROM vault_links WHERE target_id = ?")
        .all(nodeId) as any[];

      for (const row of outgoing) {
        if (!visited.has(row.target_id)) {
          visited.set(row.target_id, { depth: d, relation: row.relation, weight: row.weight });
          nextFrontier.push(row.target_id);
        }
      }
      for (const row of incoming) {
        if (!visited.has(row.source_id)) {
          visited.set(row.source_id, { depth: d, relation: row.relation, weight: row.weight });
          nextFrontier.push(row.source_id);
        }
      }
    }
    frontier = nextFrontier;
  }

  // Remove origin
  visited.delete(resolved.id);

  const display = Array.from(visited.entries()).map(([id, info]) => ({
    node: filePathForId(db, id),
    relation: info.relation,
    depth: info.depth,
    weight: info.weight,
  }));
  display.sort((a, b) => a.depth - b.depth || b.weight - a.weight);

  if (!flags.json) {
    console.log(`Neighbors of: ${shortPath(resolved.file_path)} (depth ${maxDepth}, ${display.length} nodes)\n`);
  }
  table(display);
  db.close();
}

// ── subcommand: query orphans ──────────────────────────────────────
function cmdOrphans() {
  if (flags.help) {
    console.log("Usage: bun vault.ts query orphans");
    return;
  }
  const db = openDb();
  const rows = db
    .query(
      `SELECT id, file_path, title FROM vault_files
       WHERE id NOT IN (SELECT source_id FROM vault_links)
         AND id NOT IN (SELECT target_id FROM vault_links)
         AND ${ARCHIVE_EXCLUSION}
       ORDER BY file_path`
    )
    .all() as any[];

  const display = rows.map((r: any) => ({
    path: shortPath(r.file_path),
    title: r.title ?? "",
  }));

  if (flags.json) {
    console.log(JSON.stringify({ count: display.length, orphans: display }, null, 2));
  } else {
    console.log(`Orphan files: ${display.length}\n`);
    // show first 20 in table view
    table(display.slice(0, 20));
    if (display.length > 20) {
      console.log(`\n... and ${display.length - 20} more (use --json for full list)`);
    }
  }
  db.close();
}

// ── subcommand: query path ─────────────────────────────────────────
function cmdPath() {
  const sourceName = cleanPositional[2];
  const targetName = cleanPositional[3];
  if (!sourceName || !targetName || flags.help) {
    console.log("Usage: bun vault.ts query path <source> <target>");
    return;
  }
  const db = openDb();
  const src = resolveTarget(db, sourceName);
  const tgt = resolveTarget(db, targetName);
  if (!src) { console.error(`Source not found: ${sourceName}`); db.close(); process.exit(1); }
  if (!tgt) { console.error(`Target not found: ${targetName}`); db.close(); process.exit(1); }

  // BFS shortest path
  const MAX_DEPTH = 5;
  const parent = new Map<string, { from: string; relation: string }>();
  parent.set(src.id, { from: "", relation: "" });
  let frontier = [src.id];
  let found = false;

  for (let d = 0; d < MAX_DEPTH && !found; d++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const outgoing = db
        .query("SELECT target_id, relation FROM vault_links WHERE source_id = ?")
        .all(nodeId) as any[];
      const incoming = db
        .query("SELECT source_id, relation FROM vault_links WHERE target_id = ?")
        .all(nodeId) as any[];

      for (const row of outgoing) {
        if (!parent.has(row.target_id)) {
          parent.set(row.target_id, { from: nodeId, relation: row.relation });
          next.push(row.target_id);
          if (row.target_id === tgt.id) { found = true; break; }
        }
      }
      if (found) break;
      for (const row of incoming) {
        if (!parent.has(row.source_id)) {
          parent.set(row.source_id, { from: nodeId, relation: `~${row.relation}` });
          next.push(row.source_id);
          if (row.source_id === tgt.id) { found = true; break; }
        }
      }
      if (found) break;
    }
    frontier = next;
  }

  if (!found) {
    const msg = `No path found between ${shortPath(src.file_path)} and ${shortPath(tgt.file_path)} within ${MAX_DEPTH} hops`;
    if (flags.json) {
      console.log(JSON.stringify({ error: msg, path: null }, null, 2));
    } else {
      console.log(msg);
    }
    db.close();
    return;
  }

  // reconstruct path
  const chain: { node: string; relation: string }[] = [];
  let cur = tgt.id;
  while (cur !== src.id) {
    const p = parent.get(cur)!;
    chain.unshift({ node: filePathForId(db, cur), relation: p.relation });
    cur = p.from;
  }
  chain.unshift({ node: filePathForId(db, src.id), relation: "(start)" });

  if (flags.json) {
    console.log(JSON.stringify({ hops: chain.length - 1, path: chain }, null, 2));
  } else {
    console.log(`Path (${chain.length - 1} hops):\n`);
    for (let i = 0; i < chain.length; i++) {
      if (i === 0) {
        process.stdout.write(`  ${chain[i].node}`);
      } else {
        process.stdout.write(` --(${chain[i].relation})--> ${chain[i].node}`);
      }
    }
    console.log();
  }
  db.close();
}

// ── subcommand: stats ──────────────────────────────────────────────
function cmdStats() {
  if (flags.help) {
    console.log("Usage: bun vault.ts stats");
    return;
  }
  const db = openDb();

  const totalFiles = (db.query("SELECT count(*) as c FROM vault_files").get() as any).c;
  const totalLinks = (db.query("SELECT count(*) as c FROM vault_links").get() as any).c;

  // links by relation
  const linksByRelation = db
    .query("SELECT relation, count(*) as count FROM vault_links GROUP BY relation ORDER BY count DESC")
    .all() as any[];

  // graph density
  const density = totalFiles > 1 ? (totalLinks / (totalFiles * (totalFiles - 1))) * 100 : 0;

  // orphans (archive dirs excluded — standalone deliverables by design)
  const orphanCount = (db.query(
    `SELECT count(*) as c FROM vault_files
     WHERE id NOT IN (SELECT source_id FROM vault_links)
       AND id NOT IN (SELECT target_id FROM vault_links)
       AND ${ARCHIVE_EXCLUSION}`
  ).get() as any).c;

  // persona coverage
  const personaCoverage = db
    .query(
      `SELECT json_each.value as persona, count(*) as count
       FROM vault_files, json_each(vault_files.personas)
       WHERE vault_files.personas != '[]'
       GROUP BY json_each.value
       ORDER BY count DESC`
    )
    .all() as any[];

  // stale files
  const staleCount = (db.query(
    "SELECT count(*) as c FROM vault_files WHERE mtime > last_indexed"
  ).get() as any).c;

  // last index run
  const lastRunRow = db.query("SELECT value FROM vault_meta WHERE key = 'last_index_run'").get() as any;
  const lastRun = lastRunRow ? new Date(parseInt(lastRunRow.value) * 1000).toISOString() : "never";

  const durationRow = db.query("SELECT value FROM vault_meta WHERE key = 'last_index_duration_ms'").get() as any;
  const duration = durationRow ? `${durationRow.value}ms` : "unknown";

  // top 10 most connected
  const top10 = db
    .query(
      `SELECT file_path, title, link_count, backlink_count,
              (link_count + backlink_count) as total
       FROM vault_files
       ORDER BY total DESC
       LIMIT 10`
    )
    .all() as any[];

  if (flags.json) {
    console.log(JSON.stringify({
      total_files: totalFiles,
      total_links: totalLinks,
      links_by_relation: linksByRelation,
      graph_density_pct: +density.toFixed(4),
      orphan_count: orphanCount,
      orphan_pct: +((orphanCount / totalFiles) * 100).toFixed(1),
      persona_coverage: personaCoverage,
      stale_files: staleCount,
      last_index_run: lastRun,
      last_index_duration: duration,
      top_connected: top10.map((r: any) => ({
        path: shortPath(r.file_path),
        title: r.title,
        links: r.link_count,
        backlinks: r.backlink_count,
        total: r.total,
      })),
    }, null, 2));
    db.close();
    return;
  }

  console.log("=== Vault Statistics ===\n");
  console.log(`Files indexed:     ${totalFiles}`);
  console.log(`Total links:       ${totalLinks}`);
  console.log(`Graph density:     ${density.toFixed(4)}%`);
  console.log(`Orphan files:      ${orphanCount} (${((orphanCount / totalFiles) * 100).toFixed(1)}%)`);
  console.log(`Stale files:       ${staleCount}`);
  console.log(`Last index run:    ${lastRun}`);
  console.log(`Index duration:    ${duration}`);

  console.log("\n--- Links by Relation ---");
  table(linksByRelation);

  if (personaCoverage.length > 0) {
    console.log("\n--- Persona Coverage ---");
    table(personaCoverage);
  } else {
    console.log("\nPersona coverage:  (no persona tags assigned)");
  }

  console.log("\n--- Top 10 Most Connected ---");
  table(
    top10.map((r: any) => ({
      path: shortPath(r.file_path),
      links: r.link_count,
      backlinks: r.backlink_count,
      total: r.total,
    }))
  );

  db.close();
}

// ── subcommand: persona ────────────────────────────────────────────
function cmdPersona() {
  const slug = cleanPositional[1];
  if (!slug || flags.help) {
    console.log("Usage: bun vault.ts persona <slug>");
    return;
  }
  const loaderScript = resolve(SCRIPTS_DIR, "vault-persona-loader.ts");
  const spawnArgs = ["bun", loaderScript, slug];
  if (flags.json) spawnArgs.push("--json");
  console.log(`Delegating: ${spawnArgs.join(" ")}`);
  const result = spawnSync(spawnArgs[0], spawnArgs.slice(1), {
    stdio: "inherit",
    cwd: WORKSPACE,
  });
  process.exit(result.status ?? 1);
}

// ── dispatch ───────────────────────────────────────────────────────
if (flags.help && !sub) {
  showHelp();
} else if (sub === "index") {
  cmdIndex();
} else if (sub === "query") {
  if (sub2 === "backlinks") {
    cmdBacklinks();
  } else if (sub2 === "neighbors") {
    cmdNeighbors();
  } else if (sub2 === "orphans") {
    cmdOrphans();
  } else if (sub2 === "path") {
    cmdPath();
  } else {
    console.error(`Unknown query subcommand: ${sub2 || "(none)"}`);
    console.error("Available: backlinks, neighbors, orphans, path");
    process.exit(1);
  }
} else if (sub === "stats") {
  cmdStats();
} else if (sub === "persona") {
  cmdPersona();
} else {
  if (sub) console.error(`Unknown command: ${sub}\n`);
  showHelp();
  if (sub) process.exit(1);
}
