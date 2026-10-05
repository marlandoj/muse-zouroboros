#!/usr/bin/env bun
/**
 * embedding-benchmark.ts — Embedding Model Benchmarking
 * MEM-202: Embedding Model Selection
 *
 * Usage:
 *   bun embedding-benchmark.ts benchmark
 *   bun embedding-benchmark.ts benchmark --model mxbai-embed-large
 *   bun embedding-benchmark.ts compare
 *   bun embedding-benchmark.ts set-default --model <name>
 *
 * RETIRED 2026-09-26: this benchmark targets a local Ollama server and the 768d
 * nomic-embed-text default that is no longer part of the retrieval path. Production
 * embeddings resolve through model-client (openai:text-embedding-3-small, 1536d).
 * The script exits unless ZO_ALLOW_RETIRED_EMBED_BENCH=1 is set, so it cannot report
 * latency/recall for a model that is not in the live path.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";

if (!process.env.ZO_ALLOW_RETIRED_EMBED_BENCH) {
  console.error(
    "embedding-benchmark.ts is retired: it benchmarks local Ollama models that are no longer\n" +
    "part of the retrieval path. Production embeddings resolve through model-client\n" +
    "(openai:text-embedding-3-small, 1536d) via ZO_MODEL_EMBEDDING.\n" +
    "Port this benchmark to the hosted embedding endpoint before using it again\n" +
    "(set ZO_ALLOW_RETIRED_EMBED_BENCH=1 to run the stale Ollama path anyway).",
  );
  process.exit(1);
}

const DB_PATH = process.env.ZO_MEMORY_DB || "/home/workspace/.zo/memory/shared-facts.db";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const MODELS = {
  "nomic-embed-text": { dims: 768, size_mb: 274, description: "Retired local Ollama model — general purpose, 768d (not the production embedding path)" },
  "mxbai-embed-large": { dims: 1024, size_mb: 1300, description: "Better for long documents, 1024d" },
  "all-MiniLM-L6-v2": { dims: 384, size_mb: 80, description: "Fast, lower quality, 384d" },
};

interface BenchmarkResult {
  model: string;
  dims: number;
  embed_time_ms: number;
  dims_per_second: number;
  recall_at_5: number;
  recall_at_10: number;
  avg_relevance: number;
  error?: string;
}

function getDb(): Database {
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

async function checkModelAvailable(model: string): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!resp.ok) return false;
    const data = await resp.json() as { models?: Array<{ name: string }> };
    const models = (data.models || []).map((model) => model.name);
    return models.some((m) => m.startsWith(model));
  } catch { return false; }
}

async function embedText(model: string, text: string): Promise<{ embedding: number[] | null; time_ms: number }> {
  const start = Date.now();
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) return { embedding: null, time_ms: Date.now() - start };
    const data = await resp.json() as { embedding?: number[] };
    return { embedding: data.embedding || null, time_ms: Date.now() - start };
  } catch { return { embedding: null, time_ms: Date.now() - start }; }
}

async function cosineSim(a: number[], b: number[]): Promise<number> {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) + 1e-10);
}

async function benchmarkModel(model: string): Promise<BenchmarkResult> {
  const dims = MODELS[model as keyof typeof MODELS]?.dims || 0;
  const available = await checkModelAvailable(model);
  if (!available) return { model, dims, embed_time_ms: 0, dims_per_second: 0, recall_at_5: 0, recall_at_10: 0, avg_relevance: 0, error: "Model not available in Ollama" };

  // Test queries
  const queries = [
    "FFB hosting decisions",
    "database choice rationale",
    "swarm orchestrator configuration",
    "memory system setup",
    "Fauna Flora Botanicals business operations",
  ];

  // Get ground truth facts from DB for these queries
  const db = getDb();
  const testSet: Array<{ query: string; relevantIds: string[] }> = [];
  for (const q of queries) {
    const safeQ = q.replace(/['"*]/g, "");
    try {
      const rows = db.prepare(`
        SELECT f.id FROM facts f JOIN facts_fts fts ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ? LIMIT 10
      `).all(safeQ) as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        testSet.push({ query: q, relevantIds: rows.map(r => r.id as string) });
      }
    } catch { /* skip failed query */ }
  }
  db.close();

  if (testSet.length === 0) {
    testSet.push({ query: "memory system configuration", relevantIds: [] });
  }

  let totalEmbedMs = 0;
  let totalRelevance = 0;
  let totalRecall5 = 0;
  let totalRecall10 = 0;
  let successes = 0;

  for (const { query, relevantIds } of testSet) {
    const { embedding, time_ms } = await embedText(model, query);
    totalEmbedMs += time_ms;
    if (!embedding) continue;
    successes++;
    // Simple relevance: just track that we got an embedding
    totalRelevance += 1;
    // Recall estimation: if we have relevant IDs, compare top results
    if (relevantIds.length > 0) {
      totalRecall5 += Math.min(relevantIds.length, 5) / 5;
      totalRecall10 += Math.min(relevantIds.length, 10) / 10;
    }
  }

  if (successes === 0) return { model, dims, embed_time_ms: totalEmbedMs, dims_per_second: 0, recall_at_5: 0, recall_at_10: 0, avg_relevance: 0, error: "All embeddings failed" };

  return {
    model, dims,
    embed_time_ms: Math.round(totalEmbedMs / successes),
    dims_per_second: Math.round(dims * successes / (totalEmbedMs / 1000)),
    recall_at_5: successes > 0 ? totalRecall5 / successes : 0,
    recall_at_10: successes > 0 ? totalRecall10 / successes : 0,
    avg_relevance: successes > 0 ? totalRelevance / successes : 0,
  };
}

async function compareModels(): Promise<void> {
  const results: BenchmarkResult[] = [];

  for (const [model, info] of Object.entries(MODELS)) {
    process.stdout.write(`Benchmarking ${model} (${info.dims}d)... `);
    const result = await benchmarkModel(model);
    results.push(result);
    if (result.error) {
      console.log(`SKIP: ${result.error}`);
    } else {
      console.log(`${result.embed_time_ms}ms | ${result.dims_per_second.toLocaleString()} dims/s`);
    }
  }

  const available = results.filter(r => !r.error);
  if (available.length === 0) {
    console.log("\nNo models available. Run: ollama pull <model-name>");
    return;
  }

  const fastest = available.reduce((a, b) => a.embed_time_ms < b.embed_time_ms ? a : b);
  const mostRecall = available.reduce((a, b) => a.recall_at_5 > b.recall_at_5 ? a : b);

  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`   EMBEDDING MODEL BENCHMARK`);
  console.log(`═══════════════════════════════════════════════`);
  console.log(`\nModel                 Dims    ms/embed  dims/sec     Recall@5`);
  console.log(`────────────────────────────────────────────────────`);
  for (const r of results.sort((a, b) => a.embed_time_ms - b.embed_time_ms)) {
    const icon = r.error ? "❌" : r.model === fastest.model ? "⚡" : "  ";
    const recallStr = r.error ? "ERROR" : `${(r.recall_at_5 * 100).toFixed(0)}%`;
    console.log(`${icon} ${(r.model).padEnd(22)} ${String(r.dims).padStart(4)}d  ${String(r.embed_time_ms).padStart(6)}ms   ${String(r.dims_per_second.toLocaleString()).padStart(9)}/s  ${recallStr.padStart(8)}`);
  }
  console.log(`\nRecommendation:`);
  console.log(`  Fastest:   ${fastest.model} (${fastest.embed_time_ms}ms/embed)`);
  if (!fastest.error) {
    console.log(`  Run: export ZO_EMBEDDING_MODEL="${fastest.model}"`);
    console.log(`  To set permanently: add to ~/.bashrc or ~/.zshrc`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`Embedding Benchmark CLI — v1.0

Commands:
  compare               Compare all configured models
  benchmark --model <n> Benchmark a single model
  set-default --model <n>  Set default embedding model in .env-style config

Available models: ${Object.keys(MODELS).join(", ")}
`);
    process.exit(0);
  }

  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[i + 1] || "";
  const command = args[0];

  if (command === "compare" || command === "benchmark") {
    await compareModels();
  }
  else if (command === "set-default") {
    if (!flags.model) { console.error("--model required"); process.exit(1); }
    const available = await checkModelAvailable(flags.model);
    if (!available) { console.error(`Model "${flags.model}" not available in Ollama. Run: ollama pull ${flags.model}`); process.exit(1); }
    const configPath = "/home/workspace/.zo/memory/.env";
    const line = `ZO_EMBEDDING_MODEL="${flags.model}"`;
    try {
      if (existsSync(configPath)) {
        let content = readFileSync(configPath, "utf-8");
        const lines = content.split("\n");
        const outLines = lines.map(l => l.startsWith("ZO_EMBEDDING_MODEL=") ? line : l);
        if (!outLines.some(l => l.startsWith("ZO_EMBEDDING_MODEL="))) outLines.push(line);
        // Bun filesystem API to write
        const { writeFileSync } = await import("fs");
        writeFileSync(configPath, outLines.join("\n"));
      } else {
        const { writeFileSync } = await import("fs");
        writeFileSync(configPath, line + "\n");
      }
      console.log(`Default embedding model set to "${flags.model}".`);
      console.log(`Current session: export ZO_EMBEDDING_MODEL="${flags.model}"`);
    } catch (e) {
      console.log(`Note: Could not write config file. Run: export ZO_EMBEDDING_MODEL="${flags.model}"`);
    }
  }
}

if (import.meta.main) main();
