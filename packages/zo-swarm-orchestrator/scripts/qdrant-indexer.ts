#!/usr/bin/env bun
/**
 * Qdrant Indexer for Local Self-Hosted RAG
 *
 * Indexes the zouroboros-code collection into local Qdrant
 * (TypeScript source from the monorepo packages).
 *
 * Retired 2026-10-13: the shared-memory-facts target (read-side vector copy
 * of the SQLite facts DB) was removed — redundant with SQLite hybrid search.
 *
 * QUARANTINE NOTICE (2026-10-13): this script used to DELETE and recreate
 * the target collection on every run, and hardcoded Zo-host absolute paths.
 * It is now safe by default:
 *   - existing collections are REUSED (upsert), never dropped;
 *   - pass --force-recreate to opt into the destructive rebuild;
 *   - repo root, memory DB, and Qdrant URL are env-overridable.
 *
 * The pre-existing `code-docs` collection (SDK docs) is left as-is.
 *
 * Run: bun packages/zo-swarm-orchestrator/scripts/qdrant-indexer.ts [--collection=name] [--force-recreate]
 * Env: QDRANT_URL (default http://127.0.0.1:6333), QDRANT_API_KEY,
 *      ZOUROBOROS_REPO (default: monorepo root), ZOUROBOROS_MEMORY_DB,
 *      OPENAI_API_KEY / ZO_OPENAI_API_KEY, OPENAI_BASE_URL
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, extname, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

// chunkText — vendored from the Zouroboros monorepo (packages/rag/src/ingestion.ts).
// The npm-published zouroboros-rag does not export it, and the monorepo's own
// index.ts doesn't re-export it either, so the original `from "zouroboros-rag"`
// import could never resolve. Semantics and defaults preserved verbatim.
const RAG_CHUNK_CHARS = 1500;
const RAG_CHUNK_OVERLAP = 200;
function chunkText(text: string, chars = RAG_CHUNK_CHARS, overlap = RAG_CHUNK_OVERLAP): string[] {
  if (!Number.isInteger(chars) || chars < 1) throw new Error('Chunk size must be a positive integer');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chars) {
    throw new Error('Chunk overlap must be a non-negative integer smaller than the chunk size');
  }
  if (text.length <= chars) return [text];
  const advance = chars - overlap;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += advance) {
    chunks.push(text.slice(index, index + chars));
  }
  return chunks;
}

// Self-heal: source zouroboros.env if OPENAI_API_KEY is missing (e.g. scheduled agent
// invoked us under `env -i`). Mirrors the pattern in packages/zo-swarm-orchestrator/src/rag/enrichment.ts.
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/etc/zouroboros/zouroboros.env", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^(?:export\s+)?(\w+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["\u0027]|["\u0027]$/g, "");
    }
  } catch { /* secrets file absent — caller must inject key */ }
}

const QDRANT_URL = (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const VECTOR_SIZE = 1536;
const FORCE_RECREATE = process.argv.includes("--force-recreate");

// Repo root defaults to the monorepo checkout this script lives in.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ZOUROBOROS_ROOT = process.env.ZOUROBOROS_REPO || resolve(SCRIPT_DIR, "../../..", "packages");
const MEMORY_DB = process.env.ZOUROBOROS_MEMORY_DB || process.env.ZO_MEMORY_DB || "/var/lib/zouroboros/memory/shared-facts.db";

function qHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (QDRANT_KEY) h["api-key"] = QDRANT_KEY;
  return h;
}
async function qReq(method: string, path: string, body?: any) {
  const r = await fetch(`${QDRANT_URL}${path}`, {
    method,
    headers: qHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Qdrant ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function ensureCollection(name: string) {
  const exists = await fetch(`${QDRANT_URL}/collections/${name}`, { headers: qHeaders() });
  if (exists.ok) {
    if (!FORCE_RECREATE) {
      console.log(`  collection '${name}' exists, reusing (pass --force-recreate to rebuild).`);
      return;
    }
    console.log(`  collection '${name}' exists, --force-recreate: dropping...`);
    await qReq("DELETE", `/collections/${name}`);
  }
  await qReq("PUT", `/collections/${name}`, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    on_disk_payload: true,
  });
  console.log(`  collection '${name}' ready.`);
}

async function embed(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.ZO_OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
  const r = await fetch(`${baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status}`);
  const data = (await r.json()) as { data?: Array<{ embedding: number[] }> };
  const vec = data.data?.[0]?.embedding;
  if (!vec?.length) throw new Error("Embedding generation failed");
  return vec;
}

let nextId = 1;
function newId(): number { return nextId++; }

function sanitize(s: string): string {
  // Strip control chars, BOM, and lone UTF-16 surrogates that break strict JSON parsers.
  let out = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFEFF]/g, "");
  out = out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "");
  out = out.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  return out;
}
function sanitizePoint(p: { id: number; vector: number[]; payload: any }) {
  const payload = { ...p.payload };
  for (const k of Object.keys(payload)) if (typeof payload[k] === "string") payload[k] = sanitize(payload[k]);
  return { ...p, payload };
}
async function upsert(collection: string, points: { id: number; vector: number[]; payload: any }[]) {
  if (points.length === 0) return;
  const cleaned = points.map(sanitizePoint);
  try {
    await qReq("PUT", `/collections/${collection}/points?wait=true`, { points: cleaned });
  } catch (e) {
    // Fallback: send one-by-one so a single bad chunk doesn't kill the batch.
    let kept = 0;
    for (const p of cleaned) {
      try { await qReq("PUT", `/collections/${collection}/points?wait=true`, { points: [p] }); kept++; }
      catch (err) { console.error(`\n  drop ${collection} id=${p.id} src=${p.payload.source || p.payload.fact_id}: ${(err as Error).message.slice(0, 120)}`); }
    }
    if (kept < cleaned.length) process.stdout.write(`(${kept}/${cleaned.length})`);
  }
}

function walkFiles(root: string, exts: Set<string>, skip: Set<string> = new Set(["node_modules", "dist", "build", ".git", "__tests__", "coverage"])): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (exts.has(extname(name).toLowerCase())) out.push(p);
    }
  }
  walk(root);
  return out;
}

// ---------- 1. zouroboros-code ----------
async function indexZouroborosCode() {
  console.log("\nzouroboros-code");
  if (!existsSync(ZOUROBOROS_ROOT)) {
    throw new Error(`Code root not found: ${ZOUROBOROS_ROOT} (set ZOUROBOROS_REPO to override)`);
  }
  await ensureCollection("zouroboros-code");
  const files = walkFiles(ZOUROBOROS_ROOT, new Set([".ts", ".tsx", ".md"]));
  console.log(`  found ${files.length} files under ${ZOUROBOROS_ROOT}`);

  let total = 0;
  let batch: { id: number; vector: number[]; payload: any }[] = [];
  for (const file of files) {
    if (/-backup\.(ts|tsx|md)$/.test(file)) continue;
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    if (content.length < 80 || content.length > 100_000) continue;
    const rel = relative(resolve(ZOUROBOROS_ROOT, ".."), file);
    const pkg = rel.split("/")[1] || "unknown";
    const chunks = chunkText(content);
    for (let i = 0; i < chunks.length; i++) {
      try {
        const vector = await embed(chunks[i]);
        batch.push({
          id: newId(),
          vector,
          payload: {
            collection: "zouroboros-code",
            source: rel,
            package: pkg,
            chunk_index: i,
            chunk_total: chunks.length,
            content: chunks[i],
            type: extname(file).slice(1),
          },
        });
        total++;
        if (batch.length >= 32) { await upsert("zouroboros-code", batch); batch = []; process.stdout.write("."); }
      } catch (e) { console.error(`\n  skip ${rel}#${i}: ${(e as Error).message}`); }
    }
  }
  if (batch.length) await upsert("zouroboros-code", batch);
  console.log(`\n  indexed ${total} chunks`);
}

// ---------- reindex sentinel ----------
function writeReindexSentinels(collections: string[]): void {
  const dbPath = MEMORY_DB;
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS rag_reindex_log (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL,
    indexed_at INTEGER DEFAULT (strftime('%s','now'))
  ); CREATE INDEX IF NOT EXISTS idx_rag_reindex_col ON rag_reindex_log(collection, indexed_at DESC);`);
  const stmt = db.prepare(`INSERT INTO rag_reindex_log(id, collection, indexed_at) VALUES(?, ?, strftime('%s','now'))`);
  for (const col of collections) stmt.run(randomUUID(), col);
  db.close();
  console.log(`[sentinel] reindex logged: ${collections.join(', ')}`);
}

// ---------- main ----------
const arg = process.argv.find(a => a.startsWith("--collection="));
const target = arg ? arg.split("=")[1] : "all";

console.log(`Qdrant indexer → ${QDRANT_URL}  (target: ${target})`);
const start = Date.now();
const indexed: string[] = [];
if (target === "all" || target === "zouroboros-code") { await indexZouroborosCode(); indexed.push("zouroboros-code"); }
if (indexed.length > 0) writeReindexSentinels(indexed);
console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s`);
