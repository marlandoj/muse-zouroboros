# Swarm Orchestrator Enhancement Backlog

> Strategic backlog for zo-swarm-orchestrator evolution. Items are prioritized by impact, effort, and alignment with the Zouroboros local-first, learning-oriented philosophy.

---

## Quick Reference

| Priority | Meaning | SLA Target |
|----------|---------|------------|
| **P0-Critical** | Blocks production, fix immediately | 24h |
| **P1-High** | Significant improvement, schedule next sprint | 1-2 weeks |
| **P2-Medium** | Nice-to-have, backlog for capacity | 1-2 months |
| **P3-Low** | Future consideration, monitor triggers | 3+ months |

---

## Active Queue

### P1-High: SWARM-bench Evaluation Harness
**Status**: Proposed → Ready for Spec  
**Effort**: Large (2-3 weeks)  
**Impact**: High — Empirical quality validation, executor benchmarking

**Description**:  
Adapt SWE-bench's Docker-based evaluation harness for swarm task validation. Create ground-truth datasets with acceptance criteria, run tasks in isolated environments, verify outputs against AC, and generate quality reports.

**Core Components**:
- `swarm-bench.ts` — Main harness orchestrator
- Benchmark dataset format (JSON) with AC schema
- Workspace isolation (git worktree or overlayfs)
- AC verification engine (file exists, content match, schema validation)
- Ground truth comparison (semantic similarity)
- Cross-executor leaderboard

**Acceptance Criteria**:
- [ ] Can define benchmark instances with multiple AC types
- [ ] Runs tasks via local executor bridges in isolated workspaces
- [ ] Verifies AC and produces pass/partial/fail scores
- [ ] Compares outputs to ground truth baselines
- [ ] Generates executor-specific performance reports
- [ ] Integrates with existing zo-memory-system for episode tracking

**Success Metrics**:
- Benchmark runs complete without manual intervention
- AC verification accuracy >95%
- Can detect quality regressions between swarm versions
- Executor benchmarking enables data-driven routing improvements

**Dependencies**: None (new capability)  
**Rationale**: Currently, swarm task quality is heuristic-based. SWARM-bench provides empirical validation, enabling A/B testing of routing strategies and task decomposition approaches.

---

### P2-Medium: Agentic RAG SDK Integration (Documentation Retrieval)
**Status**: Proposed → Needs Evaluation  
**Effort**: Medium (1-2 weeks)  
**Impact**: Medium-High — Grounded SDK documentation for agents

**Description**:  
Integrate MattMagg/agentic-rag-sdk as an optional MCP tool for swarm agents. The SDK provides pre-indexed RAG over 13 AI SDK corpora (ADK, OpenAI Agents, LangChain, Claude SDK, CrewAI) with hybrid retrieval + reranking.

**Integration Options**:
| Option | Effort | Pros | Cons |
|--------|--------|------|------|
| A: Full SDK deployment | High | Complete feature set | Requires Voyage AI + Qdrant Cloud |
| B: MCP client only | Low | Use user's existing instance | Depends on external MCP server |
| C: Local fork (CortexDB) | Medium | Local-first, no external deps | Requires porting ingestion pipeline |

**Recommended Path**: Start with Option B (MCP client), validate value, then evaluate Option C for local-first deployment.

**Core Components**:
- MCP client integration in executor bridges
- Optional `rag_search` tool exposure to agents
- Fallback to zo-memory-system for personal knowledge
- Configuration for SDK endpoint + API keys

**Acceptance Criteria**:
- [ ] Agents can query SDK documentation via RAG
- [ ] Searches return relevant, reranked results
- [ ] No degradation in task completion times
- [ ] Graceful fallback when RAG unavailable

**Dependencies**: MCP server from agentic-rag-sdk or user's deployment  
**Rationale**: Agents frequently need accurate SDK documentation. Current approach relies on training data (stale) or web search (unreliable). Grounded RAG improves accuracy for coding tasks.

---

### P2-Medium: AgentKV/CortexDB Evaluation for Memory Backend
**Status**: Proposed → Spike Required  
**Effort**: Medium-Large (2-3 weeks for evaluation + decision)  
**Impact**: High — Potential replacement for SQLite+Ollama stack

**Description**:  
Evaluate AgentKV (Python/C++) and CortexDB (Go) as potential backends for zo-memory-system. Both offer local-first, single-file graph+vector storage with better performance characteristics than current SQLite+FTS5+Ollama stack.

**Evaluation Criteria**:

| Criteria | Current (SQLite+Ollama) | AgentKV | CortexDB |
|----------|------------------------|---------|----------|
| Language | TypeScript/Bun | Python/C++ | Go |
| Storage | SQLite file | Single mmap'd file | SQLite-backed |
| Vector Search | Ollama (external) | HNSW (embedded) | HNSW (embedded) |
| Graph | Custom adjacency table | Property graph edges | Knowledge graph |
| BM25/FTS | FTS5 | No | FTS5 |
| Episodic Memory | Custom schema | No | Yes (hindsight) |
| Procedural Memory | Custom schema | No | Yes |
| Open Loops | Custom schema | No | Unknown |

**Recommended Path**:
1. **Spike (1 week)**: Build minimal TypeScript bindings for CortexDB (Go has good JS interop via WASM or gRPC)
2. **Benchmark (1 week)**: Compare ingestion, search latency, recall@k against current stack
3. **Decision**: Migrate if 2x+ performance improvement or significantly better graph capabilities

**Core Components**:
- `cortexdb-binding.ts` — TypeScript interface
- Feature parity matrix
- Migration script for existing zo-memory databases
- Performance benchmark suite

**Acceptance Criteria**:
- [ ] Functional TypeScript bindings for CortexDB
- [ ] Benchmark suite comparing current vs. CortexDB vs. AgentKV
- [ ] Decision document with migration plan or rejection rationale
- [ ] If accepted: migration path for existing users

**Dependencies**: None (evaluation only)  
**Rationale**: Current SQLite+Ollama stack works but has latency overhead (Ollama round-trip). Embedded vector+graph could reduce search latency from ~4s to <100ms, enabling real-time memory integration.

---

### P2-Medium: Dependency Cascade Mitigation
**Status**: Backlog  
**Effort**: Medium (1 week)  
**Impact**: High — 77.5% of swarm failures are cascade failures

**Description**:  
Current behavior: When a root task fails, all dependent tasks are marked failed (cascade). Data from March 2026 incident: 62 of 80 failures (77.5%) were cascades, not root failures.

**Proposed Solution**: Partial DAG recovery  
- Identify which dependent tasks can proceed with degraded context
- For analysis tasks: continue with partial inputs + warning annotation
- For mutation tasks: require explicit retry or abort
- Add `on_dependency_failure: 'abort' | 'degrade' | 'retry'` field to tasks

**Core Components**:
- Cascade detection in executor
- Degraded execution mode for analysis tasks
- Task-level failure handling policy
- Episodic logging for cascade events

**Acceptance Criteria**:
- [ ] Can configure per-task cascade behavior
- [ ] Analysis tasks can proceed with partial inputs
- [ ] Cascade events logged to memory system
- [ ] Success rate improves by >20% (measured via SWARM-bench)

**Dependencies**: SWARM-bench (for measuring improvement)  
**Rationale**: Single root failures shouldn't kill entire campaigns. This is the highest-impact reliability improvement based on production data.

---

### P1-High: Wire RAG Enrichment into New Package
**Status**: Gap — Built in v5 standalone, NOT ported to packages/swarm
**Effort**: Small-Medium (3-5 days)
**Impact**: High — Tasks get grounded context from memory/RAG before execution

**Description**:
The v5 standalone orchestrator (`orchestrate-v5.ts`) has working RAG enrichment that calls `shouldEnrichWithRAG()` and `enrichTaskWithRAG()` during prompt building. This injects relevant memory context (top-K matches) into task prompts before execution. The new `packages/swarm` orchestrator has NO equivalent — tasks run without any memory grounding.

**What exists in v5** (lines 2233-2241):
- `shouldEnrichWithRAG(basePrompt)` gate
- `enrichTaskWithRAG(basePrompt, { topK: 3 })` → returns `{ context, latencyMs, patterns }`
- Context injected into final prompt before executor dispatch
- Latency + pattern count logged as metrics

**What needs to happen**:
1. Port `rag-enrichment.ts` from `scripts/` into `packages/swarm/src/rag/`
2. Add RAG enrichment hook in `DAGExecutor` or `SwarmOrchestrator.run()` pre-flight
3. Make it opt-in via `SwarmConfig.enableRAG` (default true)
4. Wire metric logging for enrichment latency

**Acceptance Criteria**:
- [ ] RAG enrichment runs before task dispatch (when enabled)
- [ ] Tasks receive grounded context from memory system
- [ ] Enrichment latency logged per task
- [ ] Graceful fallback when RAG/memory unavailable
- [ ] SWARM-bench tasks still pass with enrichment enabled

**Dependencies**: zo-memory-system
**Rationale**: Without RAG enrichment, the new orchestrator is blind to project context. This was a key differentiator of v5.

---

### P1-High: Wire Hierarchical Delegation into New Package
**Status**: Gap — Built in v5 standalone, NOT ported to packages/swarm
**Effort**: Medium (1-2 weeks)
**Impact**: High — Enables parent-child task decomposition

**Description**:
The v5 standalone orchestrator has hierarchical delegation (`evaluateDelegation`, `hasDisjointWriteScopes`, `renderHierarchicalPolicyBlock`, `stripDelegationReport`) that enables tasks to spawn subtasks with write-scope isolation. The new `packages/swarm` orchestrator has NO equivalent.

**What exists in v5**:
- `TaskDelegationConfig`: mode, maxChildren, writeScopes per task
- Preflight validation: `hasDisjointWriteScopes()` + dep-graph conflict detection
- Prompt building: `renderHierarchicalPolicyBlock()` adds delegation constraints
- Result capture: `stripDelegationReport()` extracts child records from output
- Episode creation: parent-child relationships captured in memory episodes

**What needs to happen**:
1. Port `src/hierarchical.ts` into `packages/swarm/src/hierarchical/`
2. Add delegation config to `Task` type
3. Wire preflight validation into `SwarmOrchestrator` constructor or `run()`
4. Wire prompt policy block into transport layer (pre-dispatch)
5. Wire result stripping into post-execution processing
6. Add episode capture for parent-child relationships

**Acceptance Criteria**:
- [ ] Tasks can specify delegation config (mode, maxChildren, writeScopes)
- [ ] Preflight rejects overlapping write scopes across parallel tasks
- [ ] Delegation policy block injected into executor prompts
- [ ] Child task records captured and logged to memory
- [ ] Can be disabled via `SwarmConfig.enableDelegation` (default false)

**Dependencies**: DAGExecutor (already in package)
**Rationale**: Without delegation, complex tasks can't decompose into subtasks. This limits the orchestrator to flat task lists.

---

### P1-High: Seed RoleRegistry with Agency Personas
**Status**: Gap — RoleRegistry exists but is empty
**Effort**: Small (1-2 days)
**Impact**: Medium — Enables role-based routing from 45 agency personas

**Description**:
The `RoleRegistry` is SQLite-backed with full CRUD, but contains zero entries. The workspace has 45 agency personas in `agency-agents-personas.json` (9 domains: design, engineering, marketing, product, project-management, spatial-computing, specialized, support, testing) plus 97 IDENTITY files. None are ingested.

**What needs to happen**:
1. Write a seed script that reads `agency-agents-personas.json`
2. Map each persona to an executor + default model based on domain
3. Populate RoleRegistry via `registry.create()` calls
4. Add a CLI command: `zouroboros-swarm roles seed`
5. Add a CLI command: `zouroboros-swarm roles list`

**Acceptance Criteria**:
- [ ] All 45 agency personas seeded into RoleRegistry
- [ ] Each maps to an appropriate executor (claude-code, gemini, codex, hermes)
- [ ] `zouroboros-swarm roles list` shows all entries
- [ ] Tasks with `role: "backend-architect"` route correctly

**Dependencies**: RoleRegistry (already built)
**Rationale**: The RoleRegistry was built but never populated. Without seed data, role-based routing is dead code.

---

### P2-Medium: Unify selectExecutor with RoutingEngine 6-Signal Scoring
**Status**: Gap — Two routing systems, neither complete
**Effort**: Small (2-3 days)
**Impact**: Medium — Better routing decisions

**Description**:
Currently `selectExecutor()` uses a priority-chain fallthrough (explicit → role → budget → tag heuristic) that short-circuits before the `RoutingEngine`'s 6-signal composite scoring can run. The v5 standalone blended ALL signals into a weighted score for every decision. The new system should do the same.

**What needs to happen**:
1. Replace tag-heuristic fallback in `selectExecutor()` with a call to `RoutingEngine.route()`
2. Feed budget and role signals into the RoutingEngine as additional signals (not short-circuits)
3. Ensure 6-signal weights (capability, health, complexityFit, history, procedure, temporal) all contribute

**Acceptance Criteria**:
- [ ] All 6 signals contribute to every routing decision
- [ ] Budget pressure reduces score for expensive executors (not hard-override)
- [ ] Role affinity boosts score for matching executor (not hard-override)
- [ ] Explicit executorId still takes priority (backward compat)

**Dependencies**: RoutingEngine, selectExecutor (both built)
**Rationale**: Two half-complete routers are worse than one complete one. The v5 composite was better because it blended signals.

---

### P1-High: Automated Verification & Gap Audit
**Status**: ✅ COMPLETE (2026-04-08)
**Effort**: Small (1 day)
**Impact**: High — Replaces manual gap audit with mechanical, CI-runnable checks

**Description**:
Transforms the three manual gap audit questions (reachability, data prerequisites, cross-boundary state) into automated tooling. Also adds a capability manifest and import graph verifier.

**Deliverables**:
- [x] `src/verification/capabilities.ts` — Declarative capability manifest (12 capabilities, 16 wiring edges)
- [x] `src/verification/verify-wiring.ts` — Import graph + reachability checker (export verification, import verification, call site verification, entry-point reachability, orphan detection)
- [x] `src/verification/gap-audit.ts` — Automated 3-question audit (reachability via verify-wiring, data prerequisites via SQLite/registry checks, cross-boundary via file sentinel + env var checks)
- [x] Preflight data checks in `orchestrator.ts` run() — blocks execution if zero transports or all circuit breakers OPEN
- [x] CLI commands: `zouroboros-swarm verify` and `zouroboros-swarm gap-audit` with `--strict` and `--json` flags
- [x] 21 tests (all pass), zero TypeScript errors, 223 total suite tests pass
- [x] HeartbeatScheduler export added to index.ts (was orphaned, caught by verifier)
- [x] Export pattern fix: `export async function` now correctly detected

**Why this matters**: The gap audit loop caught 3 real "built but not wired" failures in prior sessions (trading-a remediation, PKA briefing, RoleRegistry). This automates what was previously a manual 3-question process.

---

## Icebox (P3-Low)

### P3-Low: Heartbeat Token Limit for Bridge Executors
**Status**: Icebox — Monitor triggers  
**Added**: 2026-03-23  
**Effort**: Medium  
**Impact**: Low (no active incidents)

**Description**:  
Add bridge-level watchdog emitting periodic "alive + N tokens" signals to detect hung bridges before timeout and enforce per-task token budgets.

**Trigger to Revive**:
- Swarm tasks exceed 50K tokens per task
- Executor hangs >3 per week
- Provider API budget overruns from undetected runaway output

**Evidence**: Analyzed 62 swarm runs — zero runaway output incidents, only 1 hung task (10x outlier).

**Rationale**: Not justified by current failure patterns. Dependency cascade mitigation (P2) would have greater impact.

---

### P3-Low: Request Caching + Deduplication
**Status**: Icebox  
**Effort**: Small  
**Impact**: Medium (cost reduction)

**Description**:  
Cache identical task requests to avoid redundant execution. Add request queue with deduplication for concurrently submitted similar tasks.

**Trigger to Revive**:
- Observed duplicate task execution patterns
- Cost concerns from redundant API calls

---

### P3-Low: Visual Dashboard for Real-Time Monitoring
**Status**: Icebox  
**Effort**: Large  
**Impact**: Medium (UX improvement)

**Description**:  
Web dashboard showing active swarm runs, task progress, circuit breaker states, and historical success rates.

**Trigger to Revive**:
- Multiple concurrent swarm campaigns become common
- Users request better visibility into execution

---

## Implementation Strategy

### Phase 1: Validation Infrastructure (Weeks 1-3)
**Focus**: Build SWARM-bench harness to enable data-driven decisions

1. **Week 1**: Design benchmark format, build workspace isolation
2. **Week 2**: Implement AC verification engine, ground truth comparison
3. **Week 3**: Create initial benchmark dataset (10-20 instances), validate harness

**Deliverable**: Working SWARM-bench with baseline metrics for current swarm performance

---

### Phase 2: Reliability Improvements (Weeks 4-5)
**Focus**: Address highest-impact failure mode (cascade failures)

1. **Week 4**: Implement partial DAG recovery with degrade/abort/retry policies
2. **Week 5**: Validate improvement via SWARM-bench, tune policies

**Deliverable**: Cascade mitigation reducing failure rate by >20%

---

### Phase 3: Knowledge Infrastructure (Weeks 6-8)
**Focus**: Evaluate and optionally integrate better memory backends

1. **Week 6**: Spike CortexDB TypeScript bindings
2. **Week 7**: Build benchmark comparing current vs. CortexDB vs. AgentKV
3. **Week 8**: Decision + migration plan (if positive)

**Deliverable**: Decision document with benchmarks, migration path if accepted

---

### Phase 4: Agent Capabilities (Weeks 9-10)
**Focus**: Grounded documentation retrieval for coding tasks

1. **Week 9**: Integrate Agentic RAG SDK as MCP client (Option B)
2. **Week 10**: Validate with coding tasks, measure accuracy improvement

**Deliverable**: Optional RAG tool for agents, usage guidelines

---

### Phase 5: Continuous Improvement (Ongoing)
**Focus**: Use SWARM-bench to drive iterative improvements

- Monthly benchmark runs against ground truth dataset
- A/B test routing strategies
- Task difficulty calibration
- Executor performance tracking

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-27 | Prioritize SWARM-bench over heartbeats | No runaway token incidents; cascade failures are bigger problem |
| 2026-03-27 | Defer AgentKV/CortexDB to Phase 3 | Need benchmarks (SWARM-bench) to measure improvement |
| 2026-03-27 | Start Agentic RAG with MCP client only | Lower risk; validate value before committing to local deployment |
| 2026-04-07 | Add P1 items for RAG enrichment, hierarchical delegation, role seeding, router unification | v5→package migration left 4 capabilities as dead code; surfaced during swarm-bench update review |
| 2026-04-08 | Implement automated verification + gap audit | Manual gap audit caught 3 real bugs in prior sessions; now runs as `zouroboros-swarm verify` and `zouroboros-swarm gap-audit` in CI |

---

## Related Resources

- [SKILL.md](SKILL.md) — Full orchestrator documentation
- [AGENTS.md](AGENTS.md) — Agent context and lessons learned
- [COMPOSITE_ROUTER_DESIGN.md](COMPOSITE_ROUTER_DESIGN.md) — 6-signal routing design
- [../zo-memory-system/SKILL.md](../zo-memory-system/SKILL.md) — Memory system documentation

---

*Last updated: 2026-04-07*
