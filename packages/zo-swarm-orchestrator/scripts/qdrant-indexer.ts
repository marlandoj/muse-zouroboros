#!/usr/bin/env bun
/**
 * Qdrant Indexer for Local Self-Hosted RAG
 *
 * Indexes two collections into local Qdrant (100.69.35.3:6333):
 *   1. zouroboros-code   — TypeScript source from zouroboros/packages
 *   2. shared-memory-facts — Shared long-term memory facts
 *
 * The pre-existing `code-docs` collection (SDK docs, 95 points) is left as-is.
 *
 * Run: bun /opt/zouroboros/repo/packages/swarm/scripts/qdrant-indexer.ts [--collection=name]
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, relative, extname, basename } from "node:path";
import { Database } from "bun:sqlite";
import { chunkText } from "zouroboros-rag";

// Self-heal: source zouroboros.env if OPENAI_API_KEY is missing (e.g. scheduled agent
// invoked us under `env -i`). Must run BEFORE importing model-client, which captures
// OPENAI_TOKEN at module load. Mirrors the pattern in packages/swarm/src/rag/enrichment.ts.
if (!process.env.OPENAI_API_KEY && !process.env.ZO_OPENAI_API_KEY) {
  try {
    const raw = readFileSync(process.env.ZO_SECRETS_PATH || "/etc/zouroboros/zouroboros.env", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^(?:export\s+)?(\w+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["\u0027]|["\u0027]$/g, "");
    }
  } catch { /* secrets file absent — caller must inject key */ }
}

const { embeddings: mcEmbeddings } = await import("/home/zouroboros/Skills/zo-memory-system/scripts/model-client.ts");

const QDRANT_URL = (process.env.QDRANT_URL || "http://100.69.35.3:6333").replace(/\/$/, "");
const QDRANT_KEY = process.env.QDRANT_API_KEY || "";
const VECTOR_SIZE = 1536;

const ZOUROBOROS_ROOT = "/opt/zouroboros/repo/packages";
const MEMORY_DB = "/var/lib/zouroboros/memory/shared-facts.db";

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
    console.log(`  collection '${name}' exists, recreating...`);
    await qReq("DELETE", `/collections/${name}`);
  }
  await qReq("PUT", `/collections/${name}`, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    on_disk_payload: true,
  });
  console.log(`  collection '${name}' ready.`);
}

async function embed(text: string): Promise<number[]> {
  const result = await mcEmbeddings(text);
  if (!result.embedding?.length) throw new Error("Embedding generation failed");
  return result.embedding;
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
  console.log("\n[1/2] zouroboros-code");
  await ensureCollection("zouroboros-code");
  const files = walkFiles(ZOUROBOROS_ROOT, new Set([".ts", ".tsx", ".md"]));
  console.log(`  found ${files.length} files`);

  let total = 0;
  let batch: { id: number; vector: number[]; payload: any }[] = [];
  for (const file of files) {
    if (/-backup\.(ts|tsx|md)$/.test(file)) continue;
    let content: string;
    try { content = readFileSync(file, "utf8"); } catch { continue; }
    if (content.length < 80 || content.length > 100_000) continue;
    const rel = relative("/opt/zouroboros/repo", file);
    const pkg = rel.split("/")[2] || "unknown";
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

// ---------- 2. shared-memory-facts ----------
async function indexMemoryFacts() {
  console.log("\n[2/2] shared-memory-facts");
  await ensureCollection("shared-memory-facts");
  const db = new Database(MEMORY_DB, { readonly: true });
  const rows = db.query<any, []>(
    `SELECT id, persona, entity, key, value, text, category, decay_class, importance, source, created_at, confidence
     FROM facts WHERE value IS NOT NULL`
  ).all();
  db.close();
  console.log(`  loaded ${rows.length} facts`);

  let total = 0;
  let batch: { id: number; vector: number[]; payload: any }[] = [];
  for (const f of rows) {
    const composed = [
      f.entity ? `Entity: ${f.entity}` : null,
      f.key ? `Key: ${f.key}` : null,
      f.value ? `Value: ${f.value}` : null,
      f.text && f.text !== f.value ? `Text: ${f.text}` : null,
    ].filter(Boolean).join("\n");
    if (composed.length < 10) continue;
    try {
      const vector = await embed(composed);
      batch.push({
        id: newId(),
        vector,
        payload: {
          collection: "shared-memory-facts",
          fact_id: f.id,
          persona: f.persona,
          entity: f.entity,
          key: f.key,
          value: f.value,
          category: f.category,
          decay_class: f.decay_class,
          importance: f.importance,
          confidence: f.confidence,
          source: f.source,
          content: composed,
        },
      });
      total++;
      if (batch.length >= 32) { await upsert("shared-memory-facts", batch); batch = []; process.stdout.write("."); }
    } catch (e) { console.error(`\n  skip fact ${f.id}: ${(e as Error).message}`); }
  }
  if (batch.length) await upsert("shared-memory-facts", batch);
  console.log(`\n  indexed ${total} facts`);
}

// ---------- reindex sentinel ----------
function writeReindexSentinels(collections: string[]): void {
  const dbPath = process.env.ZOUROBOROS_MEMORY_DB || "/var/lib/zouroboros/memory/shared-facts.db";
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
if (target === "all" || target === "shared-memory-facts") { await indexMemoryFacts(); indexed.push("shared-memory-facts"); }
if (indexed.length > 0) writeReindexSentinels(indexed);
console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s`);
