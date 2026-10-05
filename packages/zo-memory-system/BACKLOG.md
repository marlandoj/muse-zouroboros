# Zo-Memory-System Enhancement Backlog

> Active feature backlog and roadmap for the Zouroboros Memory System. Prioritized by impact, effort, and strategic alignment.

---

## Legend

| Status | Icon | Meaning |
|--------|------|---------|
| Not Started | ⬜ | No work begun |
| In Progress | 🔄 | Active development |
| Blocked | 🚫 | External dependency |
| Done | ✅ | Complete and validated |
| Won't Do | ❌ | Rejected/descoped |

| Priority | Tag | Criteria |
|----------|-----|----------|
| P0 (Critical) | `critical` | Blocks other work, high user impact |
| P1 (High) | `high` | Significant value, moderate effort |
| P2 (Medium) | `medium` | Nice-to-have, or high effort |
| P3 (Low) | `low` | Future consideration |

---

## MemGPT-Inspired Enhancements

Based on research into MemGPT's tiered-memory eviction (core/working/peripheral), these concepts were evaluated for integration into zouroboros-memory-system. See full analysis in research notes.

### ✅ [MEM-001] Context Budget Awareness
**Status:** ✅ Done 2026-03-29
**Priority:** P1 (High)
**Effort:** Medium (2-3 days)
**Tags:** `memgpt-inspired`, `swarm-integration`, `token-optimization`
**Files:** `scripts/context-budget.ts`

**Implemented:**
- `ContextBudget` interface with maxTokens, warning/critical thresholds
- `updateBudget()` — tracks current usage, fires warnings at thresholds
- `planCompression()` — priority-per-token greedy compression
- `createCheckpoint()` / `loadCheckpoint()` / `listCheckpoints()` — JSON file + DB metadata
- `retrievalWithBudget()` — integration function for memory retrieval path
- CLI: `init`, `status`, `track`, `compress`, `checkpoints`, `reset`
- New DB tables: `context_budget_state`, `budget_checkpoints`

---

### ✅ [MEM-002] Recursive Episode Summarization
**Status:** ✅ Done 2026-03-29
**Priority:** P1 (High)
**Effort:** Medium (2-3 days)
**Tags:** `memgpt-inspired`, `continuation`, `compression`
**Files:** `scripts/episode-summarizer.ts`

**Implemented:**
- `compressEpisodes()` — model-client-backed compression of episode sequences
- `generateSummary()` — structured JSON extraction (summary + keyDecisions + keyOutcomes)
- `shouldSummarize()` — threshold check for FIFO eviction trigger
- `getCompressedEpisode()` / `listCompressedEpisodes()` — compressed episode CRUD
- New DB table: `compressed_episodes` with `compressed_from` junction, token estimates
- CLI: `summarize`, `should-summarize`, `list-summaries`, `show-summary`

---

### ✅ [MEM-003] Iterative Multi-Hop Retrieval
**Status:** ✅ Done 2026-03-29
**Priority:** P2 (Medium)
**Effort:** High (4-5 days)
**Tags:** `memgpt-inspired`, `search`, `graph`
**Files:** `scripts/multi-hop.ts`

**Implemented:**
- `multiHopRetrieve()` — iterative BFS retrieval with configurable maxHops and early stopping at 0.75 confidence
- `assessConfidence()` — relevance × entity diversity scoring for early stopping
- `refineQueryForNextHop()` — model-client-backed query refinement between hops
- `semanticSearch()` + `getNeighbors()` — FTS + graph traversal per hop
- `multiHopRetrieve()` returns `{ hopsTaken, confidence, allResults[], summary, reasoning }`
- CLI: `retrieve`, `benchmark` (vs single-shot), `explain`

---

### ❌ [MEM-004] LLM Self-Directed Memory Operations
**Status:** ❌ Won't Do  
**Priority:** P3 (Low)  
**Effort:** High (5-7 days)  
**Tags:** `memgpt-inspired`, `architecture`, `rejected`

**Problem:**  
MemGPT uses function calling to let the LLM decide when to store/retrieve. Your system uses external heuristics.

**Decision:**  
Reject this approach. Reasons:
1. Your swarm uses diverse executors (not all support function calling)
2. External heuristics (memory gate, continuation detection) provide consistent behavior across personas
3. Adds complexity without clear benefit for multi-agent orchestration

**Alternative:**  
Keep current hybrid approach (heuristics + optional explicit memory commands).

---

### ❌ [MEM-005] Binary Working/Archival Split
**Status:** ❌ Won't Do  
**Priority:** P3 (Low)  
**Effort:** Medium (3-4 days)  
**Tags:** `memgpt-inspired`, `architecture`, `rejected`

**Problem:**  
MemGPT uses a binary split: working context (in-prompt) vs archival storage (vector DB).

**Decision:**  
Reject in favor of current 5-tier decay system. Your approach is more nuanced:

| MemGPT | Zouroboros |
|--------|------------|
| Working context | active (14d), session (24h), checkpoint (4h) |
| Archival | stable (90d), permanent (never) |

The 5-tier system provides finer granularity for different use cases (swarm tasks vs user preferences).

---

## Core System Enhancements

### ✅ [MEM-101] Memory System Metrics Dashboard
**Status:** ✅ Done 2026-03-29
**Priority:** P1 (High)
**Effort:** Medium (3-4 days)
**Tags:** `observability`, `dashboard`, `metrics`
**Files:** `scripts/metrics.ts`

**Implemented:**
- `recordSearchOperation()` — latency, result count, hyde_used per operation
- `recordCaptureOperation()` — facts stored/skipped/contradictions per capture
- `recordGateDecision()` — inject/skip/error classification tracking
- `collectMetrics()` — aggregated stats: facts by decay, episode outcomes, open loops, search latency distribution, capture stats, gate accuracy
- `printReport()` — formatted ASCII report with all metrics
- `bun memory.ts metrics` — integrated CLI subcommand
- New DB tables: `memory_metrics` (upsert counters), `search_operations`, `capture_operations`, `gate_operations`
- Live data: 5,387 facts, 104 episodes, 50 open loops, 8 procedures

---

### ✅ [MEM-102] Import Pipeline Enhancements
**Status:** ✅ Done 2026-03-29
**Priority:** P2 (Medium)
**Effort:** Low-Medium (1-2 days)
**Tags:** `import`, `integrations`
**Files:** `scripts/import.ts`

**Implemented:**
- `notion` — parses Notion JSON export (pages + blocks, title extraction, per-block facts)
- `linear` — parses Linear JSON export (issues with identifier, state, priority, assignee)
- `slack` — parses Slack export JSON (messages with user, timestamp, text)
- `csv` — generic CSV importer with auto-column detection (entity/name columns → fact entities)
- All sources: dedup detection, embedding generation, progress output

---

### ✅ [MEM-103] Memory Conflict Resolution
**Status:** ✅ Done 2026-03-29
**Priority:** P2 (Medium)
**Effort:** Medium (2-3 days)
**Tags:** `data-quality`, `resolution`
**Files:** `scripts/conflict-resolver.ts`

**Implemented:**
- `isContradiction()` — numeric, temporal, and model-client-backed semantic contradiction detection
- `detectNewConflict()` — automatic conflict detection during fact storage
- `resolveConflict()` — supersede (soft-delete loser), flag, merge workflows
- `findEntityConflicts()` / `findEntityConflicts()` — query conflicts by fact or entity
- Fact provenance tracking: `trackProvenance()`, `getProvenance()`, `getFactHistory()`
- New DB tables: `fact_conflicts`, `fact_provenance`
- CLI: `detect`, `resolve`, `resolve-all`, `provenance`, `history`, `stats`

---

### ✅ [MEM-104] Cross-Persona Memory Sharing
**Status:** ✅ Done 2026-03-29
**Priority:** P2 (Medium)
**Effort:** Medium (2-3 days)
**Tags:** `multi-persona`, `sharing`
**Files:** `scripts/cross-persona.ts`

**Implemented:**
- `createPool()` / `listPools()` — shared fact pools with per-pool persona membership
- `setInheritance()` — persona inheritance hierarchy with depth tracking
- `getAccessiblePersonas()` — union of direct pool membership + inheritance chain
- `searchCrossPersona()` — cross-persona FTS search with 1.0x bonus for own facts, 0.8x for shared/inherited
- New DB tables: `persona_pools`, `persona_pool_members`, `persona_inheritance`
- CLI: `list-pools`, `create-pool`, `add-to-pool`, `remove-from-pool`, `set-inheritance`, `accessible`, `search`

---

### ✅ [MEM-105] Enhanced Knowledge Graph
**Status:** ✅ Done 2026-03-29
**Priority:** P2 (Medium)
**Effort:** High (4-5 days)
**Tags:** `graph`, `relationships`, `inference`
**Files:** `scripts/graph-traversal.ts`

**Implemented:**
- `getAncestors()` / `getDescendants()` — typed graph traversal (BFS, maxDepth, path reconstruction)
- `detectCycles()` — Tarjan-style DFS cycle detection with deduplication
- `inferRelations()` — co-occurrence-based relation inference from episode_entities
- `exportDot()` — DOT (GraphViz) format export for any entity subgraph or full graph
- `KNOWN_RELATIONS` registry: depends_on, supersedes, caused_by, part_of, implements, blocks, etc. with inverses
- New DB table: `relation_types` (schema registry), `graph_cycles` (cycle log)
- CLI: `ancestors`, `descendants`, `cycles`, `infer`, `export-dot`

---

## Performance & Scale

### ⬜ [MEM-201] Vector Database Migration
**Status:** ⬜ Not Started  
**Priority:** P2 (Medium)  
**Effort:** High (5-7 days)  
**Tags:** `performance`, `architecture`, `scale`

**Description:**  
Current: SQLite + in-memory vector similarity (brute force).  
Proposed: Add LanceDB or pgvector for >10k facts.

**Acceptance Criteria:**
- [ ] LanceDB integration with SQLite fallback
- [ ] Migration path for existing embeddings
- [ ] Benchmark: query latency vs fact count
- [ ] Hybrid search uses HNSW when available

**Blockers:**  
Current scale (~1k facts) doesn't justify complexity. Revisit at 10k+ facts.

---

### ✅ [MEM-202] Embedding Model Selection
**Status:** ✅ Done 2026-03-29
**Priority:** P2 (Medium)
**Effort:** Low (1 day)
**Tags:** `performance`, `embeddings`
**Files:** `scripts/embedding-benchmark.ts`

**Implemented:**
- `benchmarkModel()` — measures embed latency, throughput (dims/s), and recall@5 for any local embedding model (retired: targets Ollama, not the production path)
- `compareModels()` — runs all configured models and ranks by speed/quality
- `MODELS` registry: nomic-embed-text (768d), mxbai-embed-large (1024d), all-MiniLM-L6-v2 (384d)
- `set-default` — writes `ZO_EMBEDDING_MODEL` to `~/.zo/memory/.env` for persistent config
- Ground truth: uses actual DB FTS queries as relevance proxy for benchmarking
- CLI: `compare`, `benchmark --model <name>`, `set-default --model <name>`

---

## Completed Work

### ✅ [MEM-000] v3.2.0 Release
**Status:** ✅ Done  
**Completed:** 2026-03-23

**Features:**
- Continuation recall across facts + episodes + open loops
- Memory gate with continuation detection
- Procedural memory with evolution
- MCP server for external clients
- Episodic memory with temporal queries
- Graph-boosted hybrid search

---

## Decision Log

| Date | Decision | Context |
|------|----------|---------|
| 2026-03-27 | Adopt context budget tracking (MEM-001) | High value for swarm token optimization |
| 2026-03-27 | Adopt recursive summarization (MEM-002) | Improves long conversation handling |
| 2026-03-27 | Reject LLM self-directed operations (MEM-004) | Mismatched with multi-agent architecture |
| 2026-03-27 | Reject binary working/archival split (MEM-005) | 5-tier decay is more expressive |
| 2026-03-27 | Defer vector DB migration (MEM-201) | Current scale sufficient with SQLite |
| 2026-04-07 | Complete model provider migration (MEM-203) | Gate, extraction, summarization, briefing on gpt-4o-mini via model-client.ts; embeddings stay local; ~$0.13/mo cost |
| 2026-04-07 | Defer RAG expansion unification (MEM-204) | Scripts only use embeddings (already local); cleanup, not quality impact |

---

## Roadmap

### ✅ Q2 2026 — COMPLETE (2026-03-29)
1. **✅ MEM-001** Context Budget Awareness
2. **✅ MEM-002** Recursive Episode Summarization
3. **✅ MEM-101** Metrics Dashboard

### ✅ Q3 2026 — COMPLETE (2026-03-29)
4. **✅ MEM-003** Iterative Multi-Hop Retrieval
5. **✅ MEM-102** Import Pipeline Enhancements (Notion, Linear, Slack, CSV)
6. **✅ MEM-103** Memory Conflict Resolution

### ✅ Q4 2026 — COMPLETE (2026-03-29)
7. **✅ MEM-104** Cross-Persona Memory Sharing
8. **✅ MEM-105** Enhanced Knowledge Graph
9. **✅ MEM-202** Embedding Model Evaluation

### ✅ 2026-04-07 — Model Provider Migration
10. **✅ MEM-203** Provider Abstraction + gpt-4o-mini Migration

### Future
- **⬜ MEM-201** Vector Database Migration (when scale requires)
- **⬜ MEM-204** RAG Expansion Script Unification — Migrate 5 scripts in `Projects/zouroboros-rag-expansion/scripts/` from hardcoded provider calls to `model-client.ts` import (currently embeddings-only, low priority)

---

## Contributing

To propose an enhancement:

1. Create a new entry following the format above
2. Set status to "⬜ Not Started"
3. Add to appropriate section
4. Reference any related research or issues

To mark work complete:

1. Update status to "✅ Done"
2. Move to "Completed Work" section
3. Add completion date
4. Link to evaluation report if applicable

---

## References

- **MemGPT Paper**: [arXiv:2310.08560](https://ar5iv.labs.arxiv.org/html/2310.08560)
- **MemGPT Research Notes**: See conversation archive 2026-03-27
- **Current System Docs**: `README.md`, `SKILL.md`
