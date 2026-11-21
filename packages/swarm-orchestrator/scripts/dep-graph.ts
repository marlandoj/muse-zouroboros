#!/usr/bin/env bun

import { readdirSync, statSync } from "fs";
import { resolve, relative, dirname, extname, join } from "path";

// ============================================================================
// TYPES
// ============================================================================

export interface DepGraphResult {
  root: string;
  files: string[];
  edges: Array<{ from: string; to: string }>;
  criticalPath: Array<{ file: string; dependentCount: number }>;
  impactRadius: Record<string, string[]>;
  cycles: string[][];
  orphans: string[];
}

export interface DepGraphOptions {
  path: string;
  extensions?: string[];
  impactFile?: string;
  impactFiles?: string[];
  json?: boolean;
  summary?: boolean;
}

// ============================================================================
// IMPORT PARSING (regex, no AST dependency)
// ============================================================================

const TS_IMPORT_RE = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const PY_IMPORT_RE = /(?:from\s+(\S+)\s+import|^import\s+(\S+))/gm;

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__pycache__", ".next", "coverage", ".turbo", "build"]);
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
const JS_TO_TS: Record<string, string> = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts" };

function parseImports(filePath: string, content: string, rootDir: string): string[] {
  const ext = extname(filePath);
  const isPython = ext === ".py";
  const regex = isPython ? PY_IMPORT_RE : TS_IMPORT_RE;
  const imports: string[] = [];

  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1] || match[2] || match[3];
    if (!raw) continue;

    if (isPython) {
      const pyPath = raw.replace(/\./g, "/") + ".py";
      const abs = resolve(rootDir, pyPath);
      try { statSync(abs); imports.push(relative(rootDir, abs)); } catch {}
      continue;
    }

    if (!raw.startsWith(".") && !raw.startsWith("/")) continue;
    const base = resolve(dirname(filePath), raw);

    // Direct file match
    try { if (statSync(base).isFile()) { imports.push(relative(rootDir, base)); continue; } } catch {}

    // TS convention: import './foo.js' → resolve to './foo.ts'
    const baseExt = extname(base);
    if (JS_TO_TS[baseExt]) {
      const tsEquiv = base.slice(0, -baseExt.length) + JS_TO_TS[baseExt];
      try { if (statSync(tsEquiv).isFile()) { imports.push(relative(rootDir, tsEquiv)); continue; } } catch {}
    }

    // Extension probing
    let resolved = false;
    for (const probe of RESOLVE_EXTS) {
      const candidate = base + probe;
      try { statSync(candidate); imports.push(relative(rootDir, candidate)); resolved = true; break; } catch {}
    }
    if (!resolved) { /* external package */ }
  }
  return imports;
}

// ============================================================================
// DIRECTORY WALKER
// ============================================================================

function walkDir(dir: string, extensions: Set<string>, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walkDir(full, extensions, results);
      else if (st.isFile() && extensions.has(extname(full))) results.push(full);
    } catch {}
  }
  return results;
}

// ============================================================================
// GRAPH OPERATIONS (adjacency lists + BFS/DFS, no library)
// ============================================================================

type AdjList = Map<string, Set<string>>;

function bfsReach(start: string, adj: AdjList): string[] {
  const visited = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
  }
  visited.delete(start);
  return [...visited];
}

function detectCycles(adj: AdjList): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const k of adj.keys()) color.set(k, WHITE);
  const cycles: string[][] = [];

  function dfs(node: string, stack: string[]) {
    color.set(node, GRAY);
    stack.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        const idx = stack.indexOf(neighbor);
        if (idx !== -1) cycles.push(stack.slice(idx));
      } else if (color.get(neighbor) === WHITE) {
        dfs(neighbor, stack);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) dfs(node, []);
  }
  return cycles;
}

// ============================================================================
// MAIN BUILD FUNCTION (exported for programmatic use)
// ============================================================================

export async function buildDepGraph(options: DepGraphOptions): Promise<DepGraphResult> {
  const rootDir = resolve(options.path);
  const extensions = options.extensions ?? [".ts", ".tsx", ".js", ".jsx", ".py"];

  const extSet = new Set(extensions);
  const absFiles = walkDir(rootDir, extSet);
  const files = absFiles.map(f => relative(rootDir, f));
  const fileSet = new Set(files);
  const adj: AdjList = new Map();
  const rev: AdjList = new Map();

  for (const f of files) { adj.set(f, new Set()); rev.set(f, new Set()); }

  for (const absPath of absFiles) {
    const rel = relative(rootDir, absPath);
    let content: string;
    try { content = await Bun.file(absPath).text(); } catch { continue; }
    const deps = parseImports(absPath, content, rootDir);
    for (const dep of deps) {
      if (fileSet.has(dep) && dep !== rel) {
        adj.get(rel)!.add(dep);
        rev.get(dep)!.add(rel);
      }
    }
  }

  const edges: DepGraphResult["edges"] = [];
  for (const [from, tos] of adj) for (const to of tos) edges.push({ from, to });

  const criticalPath = files
    .map(f => ({ file: f, dependentCount: bfsReach(f, rev).length }))
    .filter(e => e.dependentCount > 0)
    .sort((a, b) => b.dependentCount - a.dependentCount)
    .slice(0, 15);

  const impactRadius: Record<string, string[]> = {};
  if (options.impactFile) {
    const rel = relative(rootDir, resolve(rootDir, options.impactFile));
    if (fileSet.has(rel)) impactRadius[rel] = bfsReach(rel, rev);
  } else if (options.impactFiles) {
    for (const f of options.impactFiles) {
      const rel = relative(rootDir, resolve(rootDir, f));
      if (fileSet.has(rel)) impactRadius[rel] = bfsReach(rel, rev);
    }
  } else {
    for (const f of criticalPath.slice(0, 10)) {
      impactRadius[f.file] = bfsReach(f.file, rev);
    }
  }

  const cycles = detectCycles(adj);

  const orphans = files.filter(f => (adj.get(f)?.size ?? 0) === 0 && (rev.get(f)?.size ?? 0) === 0);

  return { root: rootDir, files, edges, criticalPath, impactRadius, cycles, orphans };
}

// ============================================================================
// CLI
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const idx = (flag: string) => args.indexOf(flag);

  const pathIdx = idx("--path");
  const path = pathIdx !== -1 ? args[pathIdx + 1] : args.find(a => !a.startsWith("--"));
  if (!path) { console.error("Usage: dep-graph.ts --path <dir> [--json] [--summary] [--impact <file>]"); process.exit(1); }

  const impactIdx = idx("--impact");
  const options: DepGraphOptions = {
    path,
    json: args.includes("--json") || !args.includes("--summary"),
    summary: args.includes("--summary"),
    impactFile: impactIdx !== -1 ? args[impactIdx + 1] : undefined,
  };

  const result = await buildDepGraph(options);

  if (options.summary) {
    console.log(`\nDependency Graph: ${result.root}`);
    console.log(`  Files: ${result.files.length}  Edges: ${result.edges.length}  Cycles: ${result.cycles.length}  Orphans: ${result.orphans.length}`);
    if (result.criticalPath.length > 0) {
      console.log(`\n  Critical files (most dependents):`);
      for (const { file, dependentCount } of result.criticalPath.slice(0, 10)) {
        console.log(`    ${dependentCount.toString().padStart(3)} deps  ${file}`);
      }
    }
    if (result.cycles.length > 0) {
      console.log(`\n  ⚠ Cycles detected:`);
      for (const cycle of result.cycles.slice(0, 5)) console.log(`    ${cycle.join(" → ")} → ${cycle[0]}`);
    }
    if (result.orphans.length > 0 && result.orphans.length <= 10) {
      console.log(`\n  Orphans (no imports, not imported):`);
      for (const o of result.orphans) console.log(`    ${o}`);
    }
    console.log();
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  }
}
