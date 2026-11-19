#!/usr/bin/env bun
/**
 * Eval — Q2 #3 Cycle 1.A multi-collection RAG enrichment.
 *
 * Runs N representative swarm task prompts through enrichTaskWithRAG,
 * reports per-collection hit counts, top-score distribution, and the
 * fire-rate at the current minScore default vs. a relaxed threshold.
 *
 * Reads RAG_COLLECTIONS env if set; otherwise defaults to
 * zouroboros-research only (the 1536d-compatible collection).
 */

import { enrichTaskWithRAG, resolveCollections } from '../src/rag/enrichment.js';

process.env.RAG_TELEMETRY_DISABLED = '1';

const TASKS = [
  'Build a multi-agent rag system with handoffs using OpenAI Agents SDK',
  'Design a workflow with langchain that orchestrates retrieval, summarization, and feedback',
  'Implement a structured-output extraction pipeline using pydantic-ai',
  'Add validation middleware to a hono API route',
  'Wire a stripe subscription billing flow with webhook handling',
  'Build a vector memory system that survives across sessions for an agent',
  'Implement async streaming in an agent that uses tool calls',
  'Refactor a database migration to use drizzle-orm',
  'Construct a self-improving agent that critiques its own output',
  'Design a code generation agent with retrieval-augmented prompts',
  'Add memory recall for an agent based on episodic context',
  'Build an LLM evaluation pipeline that scores rag retrieval quality',
  'Design a hierarchical orchestration with role-specific agents',
  'Implement a feedback loop where agent failures inform future retrieval',
  'Build a multi-step planner using langgraph state machines',
];

interface EvalRow {
  task: string;
  patterns05: number;
  topScore: number;
  collections: string[];
  latencyMs: number;
}

async function main() {
  const collections = resolveCollections();
  console.log(`\n[eval] collections: ${collections.join(', ')}`);
  console.log(`[eval] tasks: ${TASKS.length}\n`);

  const rows: EvalRow[] = [];
  let runs = 0;

  for (const task of TASKS) {
    const r = await enrichTaskWithRAG(task, { topK: 3, minScore: 0.0 });
    runs++;
    const topMatch = r.context.match(/Relevance:\*\*\s*([\d.]+)%/);
    const topScore = topMatch ? parseFloat(topMatch[1]) / 100 : 0;
    rows.push({
      task,
      patterns05: r.patterns,
      topScore,
      collections,
      latencyMs: r.latencyMs,
    });
    process.stdout.write(`  [${runs}/${TASKS.length}] patterns=${r.patterns} top=${topScore.toFixed(3)} ${r.latencyMs}ms\n`);
  }

  const fired05 = rows.filter(r => r.topScore >= 0.5).length;
  const fired045 = rows.filter(r => r.topScore >= 0.45).length;
  const fired04 = rows.filter(r => r.topScore >= 0.4).length;
  const fired035 = rows.filter(r => r.topScore >= 0.35).length;
  const avgLatency = rows.reduce((a, b) => a + b.latencyMs, 0) / rows.length;
  const topScoreAvg = rows.reduce((a, b) => a + b.topScore, 0) / rows.length;
  const topScoreMax = Math.max(...rows.map(r => r.topScore));
  const topScoreMin = Math.min(...rows.map(r => r.topScore));

  console.log('\n--- Eval Summary ---');
  console.log(`runs:            ${runs}`);
  console.log(`avg latency:     ${avgLatency.toFixed(0)}ms`);
  console.log(`top-score avg:   ${topScoreAvg.toFixed(3)}`);
  console.log(`top-score range: ${topScoreMin.toFixed(3)} – ${topScoreMax.toFixed(3)}`);
  console.log(`fire-rate @0.50: ${fired05}/${runs} (${((fired05/runs)*100).toFixed(0)}%)`);
  console.log(`fire-rate @0.45: ${fired045}/${runs} (${((fired045/runs)*100).toFixed(0)}%)`);
  console.log(`fire-rate @0.40: ${fired04}/${runs} (${((fired04/runs)*100).toFixed(0)}%)`);
  console.log(`fire-rate @0.35: ${fired035}/${runs} (${((fired035/runs)*100).toFixed(0)}%)`);
  console.log('\nNote: prior to this PR, all production calls returned 0 patterns');
  console.log('due to dim-mismatch 400 against code-docs (768d) with 1536d query.');
}

main().catch(e => { console.error(e); process.exit(1); });
