---
name: zo-memory-system
description: Hybrid SQLite + Vector persona memory system for Zo Computer. Episodic memory with temporal queries, graph-boosted search, BFS path finding, knowledge gap analysis, auto-capture pipeline, and per-workload model routing. Embeddings use hosted OpenAI `text-embedding-3-small`; generation workloads resolve per-workload through `scripts/model-client.ts`.
compatibility: Created for Zo Computer. Requires Bun and `OPENAI_API_KEY` for hosted embeddings and default generation workloads. No local model runtime is installed or required.
metadata:
  author: marlandoj.zo.computer
  updated: 2026-03-29
  version: 4.0.0
---

> **DEPRECATED:** This standalone skill has been migrated into the [Zouroboros monorepo](https://github.com/marlandoj/zouroboros). The canonical location is now `zouroboros/packages/`. This copy is kept for backwards compatibility but will not receive updates.

# Zo Memory System Skill v4.0.0

Give your Zo personas persistent memory with semantic understanding, graph intelligence, and automatic fact capture.

**v4.0 Updates (Q2-Q4 2026):** Context budget awareness (token tracking + proactive checkpointing), recursive episode summarization (model-routed FIFO compression), metrics dashboard (latency/recall/capture/gate stats), iterative multi-hop retrieval (confidence-based BFS with query refinement), cross-persona memory sharing (pools + inheritance hierarchy), conflict resolution (semantic/temporal detection + provenance tracking), enhanced knowledge graph (typed relations, cycle detection, DOT export, co-occurrence inference), embedding model benchmarking (3-model comparison + recall measurement).

**v3.2 Updates:** Procedural memory (versioned workflow patterns with model-routed evolution), cognitive profiles (executor failure patterns + entity affinities), orchestrator integration (6-signal composite routing with procedure + temporal scoring, auto-episode creation after swarm runs)

**v3.1 Updates:** Episodic memory (event-based "what happened" with outcomes), temporal queries (since/until filtering), velocity trends, DB migration system, auto-capture episode hook

**v3.0 Updates:** Graph-boosted hybrid search (graph-boost.ts), BFS path finding & knowledge gap analysis (graph.ts), auto-capture pipeline for conversation-to-fact extraction (auto-capture.ts), co-capture linking, contradiction detection with supersession

---

## What You Get

- **Automatic continuation recall** — Detects continuation-like messages and silently blends relevant context from the last 14 days
- **First-class open loops** — Stores unfinished tasks, unresolved bugs/incidents, pending approvals, and next-step commitments as queryable records
- **Searchable session summaries** — Episodes are indexed for continuation retrieval, not just listed by time
- **Procedural memory** — Versioned workflow patterns with step sequences, success/failure tracking, and model-routed evolution
- **Cognitive profiles** — Extended executor history with episode linkage, failure pattern classification, and entity affinity scores
- **6-signal routing** — Orchestrator composite router enhanced with procedure + temporal scoring for memory-enriched task routing
- **Episodic memory** — Event-based "what happened" records with outcomes, entity tagging, and duration tracking
- **Temporal queries** — Filter episodes by time ("7 days ago", "last week", ISO dates) and outcome
- **Velocity trends** — Track success/failure rates per entity over time (day/week/month granularity)
- **DB migration system** — Safe, idempotent schema migrations with rollback support
- **Hybrid search** — BM25 (FTS5) + vector similarity with RRF fusion
- **Graph-boosted scoring** — Linked facts boost each other in search results
- **Semantic understanding** — Finds facts even with paraphrased queries
- **HyDE expansion** — `openai:gpt-4o-mini` by default via `model-client` (overrideable per workload)
- **BFS path finding** — Find shortest connection between any two entities
- **Knowledge gap analysis** — Identify orphan facts, dead ends, weak links, and clusters
- **Auto-capture** — Extract facts from conversation transcripts automatically
- **Conversation capture** — Scan all workspace artifacts and extract facts from every conversation (not just swarm)
- **Scheduled capture agent** — Daily agent that runs conversation-capture and emails a maintenance report
- **Contradiction detection** — New facts that conflict with existing ones create supersession links
- **5-tier adaptive decay** — Automatic promotion/demotion based on access patterns
- **Hosted embeddings** — text-embedding-3-small (1536-dim) via the OpenAI embeddings API (no local runtime required)
- **Per-persona memory files** — Critical facts always loaded with the persona
- **Shared memory database** — Cross-persona facts with vector index
- **Associative routing** — Graph links between related facts (link/unlink/show commands)
- **Memory consolidation** — Automatic deduplication and merging of related facts
- **Swarm integration** — Token-optimized memory for multi-agent workflows
- **Memory gate** — model-routed relevance filter (memory-gate.ts) that classifies messages before searching; defaults to OpenAI
- **Always-on injection** — Zo rule integration for automatic context injection on every message
- **Gate-filtered savings** — 40-60% of messages filtered as not needing memory (zero extra tokens)
- **Health checks** — provider connectivity and model validation at startup
- **Fetch timeouts** — provider call timeouts prevent indefinite hangs
- **Scheduled maintenance** — Hourly prune/decay automation
- **Checkpoint system** — Save/restore task state
- **Graceful fallback** — Works without embeddings (FTS5 only)

---

## Prerequisites

```bash
# Hosted embeddings and default generation workloads
export OPENAI_API_KEY="your_api_key_here"
```

### Model Selection

| Model | Purpose | Size | Why |
|-------|---------|------|-----|
| `openai:gpt-4o-mini` | Gate, HyDE, capture, briefing, summarization | OpenAI | Current default generation path across memory workloads |
| `openai:text-embedding-3-small` | Vector embeddings (1536-dim) | OpenAI | Hosted embedding path; no local runtime required |

**Override policy:** generation workloads resolve through `scripts/model-client.ts` and can be changed via workload-specific env vars.

---

## Performance

| Mode | Latency | Use Case |
|------|---------|----------|
| **FTS + Vectors only** | ~0.5s | Specific queries with exact keywords |
| **With HyDE** | ~4s | Vague/conceptual queries (e.g., "that thing about data safety") |
| **Graph-boosted** | +~5ms | Adds graph scoring to any search (negligible overhead) |
| **Auto-capture** | ~3-5s | Per-conversation extraction (post-conversation, not per-turn) |

**HyDE Trade-off:** Adds ~3.5s but dramatically improves recall for vague queries (1 result → 6 results in testing).

---

## Quick Start

```bash
# Initialize the database
cd /home/workspace/Skills/zo-memory-system
bun scripts/memory.ts init

# Add memory to a persona
bun scripts/add-persona.sh "my-persona" "Role description"

# Store a fact
bun scripts/memory.ts store \
  --entity "user" \
  --key "preference" \
  --value "value" \
  --decay permanent

# Search with semantic understanding + graph boost
bun scripts/memory.ts hybrid "why did we choose the database"

# Manage knowledge graph
bun scripts/graph.ts link --source <id1> --target <id2> --relation "depends_on"
bun scripts/graph.ts knowledge-gaps

# Auto-capture facts from a conversation
bun scripts/auto-capture.ts --input conversation.md --dry-run
```

---

## Commands

### Store Facts
```bash
bun scripts/memory.ts store \
  --persona shared \
  --entity "user" \
  --key "name" \
  --value "Alice" \
  --decay permanent \
  --category preference
```

### Search Memory

**Continuation Recall (facts + episodes + open loops):**
```bash
bun scripts/memory.ts continuation "where did we leave off on the health dashboard?"
bun scripts/memory.ts open-loops --status open
bun scripts/memory.ts resolve-loop "The dashboard issue is fixed now"
```

**Hybrid Search (semantic + exact + graph boost):**
```bash
bun scripts/memory.ts hybrid "database decision rationale"
bun scripts/memory.ts hybrid "why did we pick SQLite" --no-hyde  # Skip HyDE for speed
```

Hybrid search now includes graph-boosted scoring. When facts are linked via `fact_links`, linked results boost each other. Scoring weights:

| Signal | Weight | Notes |
|--------|--------|-------|
| RRF (FTS + Vector) | 0.60 | Primary signal |
| Graph Boost | 0.15 | Reward associative proximity |
| Freshness | 0.15 | Recency bonus |
| Confidence | 0.10 | Trust signal |

When no graph links exist for any result, original weights (0.70/0.20/0.10) are preserved.

**Fast Exact Search (FTS5 only):**
```bash
bun scripts/memory.ts search "router password"
```

**Lookup by entity:**
```bash
bun scripts/memory.ts lookup --entity "user"
bun scripts/memory.ts lookup --entity "user" --key "name"
```

### Maintenance
```bash
# View statistics (embeddings count, model config, fact counts)
bun scripts/memory.ts stats

# Backfill embeddings for all facts
bun scripts/memory.ts index

# Prune expired facts and orphaned embeddings
bun scripts/memory.ts prune

# Apply adaptive decay (demotes stale, promotes frequently-accessed)
bun scripts/memory.ts decay

# Consolidate duplicate facts (merge same entity+key entries)
bun scripts/memory.ts consolidate
```

---

## Knowledge Graph (graph.ts)

The graph CLI manages associative links between facts and provides graph analysis tools.

### Link Management

```bash
# Create a link between two facts
bun scripts/graph.ts link --source <id1> --target <id2> --relation "depends_on" --weight 0.8

# Remove a link
bun scripts/graph.ts unlink --source <id1> --target <id2>
bun scripts/graph.ts unlink --source <id1> --target <id2> --relation "depends_on"

# Show all links for an entity or fact
bun scripts/graph.ts show --entity "project.ffb-site"
bun scripts/graph.ts show --id <fact-id>
```

### Find Connections (BFS Path Finding)

Find the shortest path between two entities through the knowledge graph:

```bash
bun scripts/graph.ts find-connections --from "project.ffb-site" --to "system.zo"
bun scripts/graph.ts find-connections --from "user" --to "decision.hosting" --max-depth 3
```

Output:
```
Path found (2 hops):

  [project.ffb-site.name] "FFB website redesign project"
    -->depends_on
  [decision.hosting] "Decided to use Zo hosting"
    -->related
  [system.zo.infrastructure] "Zo Computer infrastructure setup"
```

### Knowledge Gaps Analysis

Scan all facts for maintenance opportunities:

```bash
bun scripts/graph.ts knowledge-gaps
```

Output:
```
Knowledge Gap Analysis
======================
Total facts: 73
Linked facts: 14 (19.2%)
Orphan facts: 59 (80.8%)

Dead ends (targets only, never source):
  - [decision.hosting] "Decided to use Zo hosting" (2 inbound, 0 outbound)

Weakly linked (only 1 connection):
  - [project.ffb-api] "FFB API integration" (1 link)

Connected components: 3
  Cluster 1 (8 facts): hub = [project.ffb-site] (5 links)
  Cluster 2 (4 facts): hub = [system.zo-infrastructure] (3 links)
  Cluster 3 (2 facts): hub = [decision.memory-cli] (1 link)

Suggested: 12 orphan facts share entities with linked facts and could be connected.
```

---

## Auto-Capture (auto-capture.ts)

Extract structured facts from conversation transcripts automatically.

### How it works

1. Transcript is sent through `model-client` for structured extraction (default `openai:gpt-4o-mini`)
2. Each candidate fact is quality-filtered (confidence >= 0.6, value >= 10 chars)
3. Dedup check against existing facts (hash-based exact match)
4. Contradiction detection: same entity+key with different value creates a `supersedes` link
5. Passing facts are stored with embeddings and auto-linked as `co-captured`

### Usage

```bash
# Preview extraction (dry-run, no storage)
bun scripts/auto-capture.ts --input conversation.md --dry-run

# Extract and store
bun scripts/auto-capture.ts --input conversation.md --source "chat:2026-03-04"

# Pipe from swarm output
cat swarm-output.md | bun scripts/auto-capture.ts --source "swarm:ffb"

# View capture history
bun scripts/auto-capture.ts stats
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--input <file>` | Transcript file path | stdin |
| `--source <label>` | Source label for audit trail | "cli" |
| `--persona <name>` | Persona to store facts under | "shared" |
| `--dry-run` | Show extraction without storing | false |
| `--model <name>` | Override extraction model | `openai:gpt-4o-mini` |

### Quality Safeguards

- **Confidence threshold**: Facts below 0.6 confidence are discarded
- **Value length minimum**: Facts with values shorter than 10 chars are discarded
- **Max 20 facts** per capture (prevents runaway extraction from long transcripts)
- **Transcript hash** prevents re-processing the same content
- **Dry-run mode** for testing extraction quality before committing
- **Source tagging** for audit trail (`source: "auto-capture:{label}"`)

### Contradiction Handling

When auto-capture finds an existing fact with the same entity+key but a different value:
1. New fact is stored normally
2. A `supersedes` link is created: new_fact → old_fact
3. Old fact's confidence is halved (soft deprecation, not deletion)

### Co-Capture Linking

Facts extracted from the same conversation are automatically linked with `relation: "co-captured"` and `weight: 0.5`. This seeds the knowledge graph with organic connections.

---

## Conversation Capture (conversation-capture.ts)

Extends memory capture beyond swarm tasks to **all conversations**. Scans workspace artifact directories (`/home/.z/workspaces/con_*/`) for reports, analysis outputs, and tool results, then runs them through the auto-capture extraction pipeline.

```bash
# List all capturable artifacts
bun scripts/conversation-capture.ts --list

# Process last 24h (safe default)
bun scripts/conversation-capture.ts

# Only last 24 hours
bun scripts/conversation-capture.ts --since 24h

# Explicit full backlog sweep
bun scripts/conversation-capture.ts --all

# Preview without storing
bun scripts/conversation-capture.ts --dry-run

# Show capture statistics
bun scripts/conversation-capture.ts --stats
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--since <duration>` | Filter by recency: 1h, 24h, 7d, 30d, 1w, 1m | 24h |
| `--all` | Process all uncaptured artifacts across all conversations | false |
| `--dry-run` | Show extraction without storing | false |
| `--list` | List capturable files with status | — |
| `--stats` | Show conversation capture statistics | — |

### Filters

- Skips files < 200 bytes or > 500 KB
- Skips `read_webpage/`, `browser_agent/`, `node_modules/`, `venv/` directories
- Only processes `.md`, `.txt`, `.json` files
- Hash-based dedup via `capture_log` table (never re-processes same content)
- Creates episodes for each capture session
- Bare invocation is intentionally bounded to the last 24 hours; use `--all` only for an explicit backlog sweep

### Scheduled Agent

A daily agent runs at 04:00 AM Phoenix time, executing conversation-capture for the last 24 hours and emailing a maintenance report with fact counts, DB stats, and any errors.

---

## Episodic Memory (v3.1)

Episodic memory captures "what happened" as events with outcomes — complementing facts (what is true) with episodes (what occurred).

### Database Migration

Before using episodic memory, run the migration to add the new tables:

```bash
bun scripts/memory.ts migrate
```

This is idempotent (safe to run multiple times) and preserves all existing data.

### Querying Episodes

```bash
# List all episodes
bun scripts/memory.ts episodes

# Filter by time
bun scripts/memory.ts episodes --since "7 days ago"
bun scripts/memory.ts episodes --since "2026-03-01" --until "2026-03-07"
bun scripts/memory.ts episodes --since "last week"

# Filter by outcome
bun scripts/memory.ts episodes --outcome failure
bun scripts/memory.ts episodes --outcome success --since "30 days ago"

# Filter by entity
bun scripts/memory.ts episodes --entity "executor.claude-code"
bun scripts/memory.ts episodes --entity "project.ffb-site" --since "7 days ago"
```

### Velocity Trends

Track success/failure rates over time for any entity:

```bash
# Weekly trends (default)
bun scripts/memory.ts trends --entity "executor.claude-code"

# Daily granularity
bun scripts/memory.ts trends --entity "project.ffb-site" --granularity day

# Monthly, last 6 months
bun scripts/memory.ts trends --entity "swarm.ffb" --granularity month --since "180 days ago"
```

Output:
```
Velocity trends for "executor.claude-code" (by week):

  Period        Total  OK  Fail  Rate
  ─────────────────────────────────────
  2026-W06          1   1     0  100%
  2026-W09          1   0     0  0%
```

### Time Formats

The temporal query system accepts:
- **Relative:** "7 days ago", "30 minutes ago", "2 weeks ago", "3 months ago"
- **Named:** "today", "yesterday", "last week", "last month", "last year"
- **ISO dates:** "2026-03-01"
- **Unix timestamps:** raw seconds

### Auto-Capture Episode Hook

When auto-capture stores facts from a conversation, it automatically creates an episode recording the capture event. This means every auto-capture run becomes a queryable event in your episodic timeline.

---

## Procedural Memory (v3.2)

Procedural memory captures reusable workflow patterns as versioned step sequences. Procedures track success/failure rates and can self-evolve using the configured generation model when failures accumulate.

### Managing Procedures

```bash
# List all procedures (shows latest version per name)
bun scripts/memory.ts procedures --list

# Show steps for a specific procedure
bun scripts/memory.ts procedures --show "site-review"

# Record feedback after running a procedure
bun scripts/memory.ts procedures --feedback <procedure-id> --success
bun scripts/memory.ts procedures --feedback <procedure-id> --failure

# Force model-routed evolution based on failure episodes
bun scripts/memory.ts procedures --evolve "site-review"
```

### Procedure Evolution

When a procedure accumulates failures, `--evolve` uses the configured generation model (default `openai:gpt-4o-mini`) to analyze linked failure episodes and suggest improved steps. The evolved procedure:
- Gets a new version number (v1 -> v2)
- Links to its parent via `evolved_from`
- Starts with fresh success/failure counts
- May adjust timeouts, add fallback executors, or reorder steps

### Cognitive Profiles

Executor history (`~/.swarm/executor-history.json`) is extended with cognitive fields:
- **`recent_episode_ids`** — Last 10 episode IDs for "why did this happen?" queries
- **`failure_patterns`** — Auto-classified error types (timeout, mutation_failed, file_not_found, permission_denied)
- **`entity_affinities`** — Per-entity success rates as exponential moving averages

These fields are backward compatible — old history files parse correctly without them.

### Orchestrator Integration (v4.5)

The swarm orchestrator (`orchestrate-v4.ts`) now:
1. **Creates episodes** — Every swarm run auto-creates an episode with outcome, duration, executor list, and task tags
2. **6-signal composite routing** — Adds `procedureScore` (from procedure success rates) and `temporalScore` (from recent episodic performance) to the existing 4-signal composite router
3. **Cognitive data on outcomes** — Success/failure calls pass error types and entity affinities to executor history

---

## MCP Server (v3.3.1)

Expose the memory system as MCP tools for Claude Desktop, Cursor, Gemini, Codex, and other MCP-compatible clients.

### Transport Modes

| Mode | Script | Use Case |
|------|--------|----------|
| **HTTP (Streamable HTTP)** | `mcp-server-http.ts` | Network access — hosted service, multi-agent, all personas |
| **Stdio** | `mcp-server.ts` | Direct process spawn — Claude Desktop, single-client |

### HTTP Server (Recommended)

The HTTP MCP server runs as a Zo hosted service with auto-restart and HTTPS.

```bash
# Start locally (for testing)
PORT=48400 bun scripts/mcp-server-http.ts

# Health check
curl http://localhost:48400/health

# MCP endpoint
POST http://localhost:48400/mcp
```

**Hosted service:** `https://zo-memory-mcp-marlandoj.zocomputer.io`
- Service ID: `svc_PXkgBzRdH8M`
- Local port: 48400
- Health: `/health`
- MCP: `/mcp` (Streamable HTTP transport)

**Optional auth:** Set `ZO_MEMORY_MCP_TOKEN` env var to require Bearer token auth.

### Stdio Server

```bash
bun scripts/mcp-server.ts          # Direct
bun scripts/memory.ts mcp          # Via CLI
```

### Available Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid FTS + vector search with RRF fusion |
| `memory_store` | Store a new fact with auto-generated embedding |
| `memory_episodes` | Query episodic memory with temporal/entity filters |
| `memory_procedures` | List or show workflow procedures |
| `cognitive_profile` | Show executor cognitive profile (history, patterns, affinities) |

### Client Configuration

**Claude Code** (`~/.claude.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "zo-memory": {
      "type": "http",
      "url": "http://localhost:48400/mcp"
    }
  }
}
```

**Claude Desktop** (stdio mode, `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "zo-memory": {
      "command": "bun",
      "args": ["/home/workspace/Skills/zo-memory-system/scripts/mcp-server.ts"]
    }
  }
}
```

**Gemini** (`~/.gemini/settings.json`):
```json
{
  "mcpServers": {
    "zo-memory": {
      "url": "http://localhost:48400/mcp",
      "type": "http",
      "trust": true
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.zo-memory]
url = "http://localhost:48400/mcp"
startup_timeout_sec = 10
```

**Swarm bridge:** The Claude Code bridge script (`claude-code-bridge.sh`) pre-approves all `mcp__zo-memory__*` tools via `--allowedTools`.

---

## Import Pipeline (v3.2)

Import facts from external sources into the memory system.

### Supported Sources

| Source | Format | Extracts |
|--------|--------|----------|
| `chatgpt` | JSON export | Conversation summaries, key decisions |
| `obsidian` | Markdown vault | Notes by section, respects frontmatter |
| `markdown` | Any `.md` file | Section-based facts from headings |

### Usage

```bash
# Preview (no changes)
bun scripts/memory.ts import --source markdown --path ~/notes/decisions.md --dry-run

# Import ChatGPT export
bun scripts/memory.ts import --source chatgpt --path ~/chatgpt-export.json

# Import Obsidian vault
bun scripts/memory.ts import --source obsidian --path ~/Vault

# Import single markdown
bun scripts/memory.ts import --source markdown --path ~/notes/architecture.md
```

Features:
- Duplicate detection (skips already-imported facts)
- Auto-generated embeddings for semantic search
- Section-based splitting (one fact per heading)
- Obsidian frontmatter support (`entity`, `category` fields)

---

## Memory Gate (Always-On Context Injection)

The memory gate (`scripts/memory-gate.ts`) uses the configured gate model to classify incoming messages and decide whether memory context should be injected. It now prioritizes likely continuation-style turns first, using blended continuation recall before falling back to the standard memory search path.

### How it works

1. User sends a message
2. Continuation detector checks for likely follow-on work
3. If continuation-like: blended recall searches facts + episodes + open loops from the last 14 days
4. Otherwise the gate model (default `openai:gpt-4o-mini`) classifies whether stored memory is needed
5. If no: message passes through with zero overhead
6. If yes: gate extracts keywords, runs hybrid search, injects results as context

### Usage

```bash
# Direct invocation
bun scripts/memory-gate.ts "what did we decide about FFB pricing?"
# Exit 0 + results printed

bun scripts/memory-gate.ts "hello"
# Exit 2 (no memory needed, no output)

bun scripts/memory-gate.ts "update the supplier scorecard"
# Exit 0 + results printed (or exit 3 if no results found)
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Memory results found and printed |
| 1 | Error (API failure, parse failure) |
| 2 | No memory needed (greeting, general knowledge, self-contained request) |
| 3 | Memory needed but no results found |

### Zo rule integration

Create an always-applied Zo rule that runs the gate on every message:

```
Run: bun /home/workspace/Skills/zo-memory-system/scripts/memory-gate.ts "<message>"
- Exit 0: inject stdout as background context
- Exit 2: skip (no memory needed)
- Exit 3: skip (no results)
```

### Configuration

```bash
export ZO_GATE_MODEL="openai:gpt-4o-mini"  # Default gate model
```

Hosted API models need no `keep_alive` and no cold-start pinger. Local Ollama serving was
removed in 2026: the gate, HyDE, and embeddings all call hosted providers.

### Performance in multi-agent swarms

The gate is what makes this memory system viable for swarm workflows. Without gating, always-on injection consumes 34-120% of an 8K context budget across 11 tasks. With gating, only ~4 of 11 tasks get memory injection, keeping consumption at 2.5-6.9%.

| Metric | With gate | Without gate (always-on) |
|--------|-----------|--------------------------|
| Tasks injected | ~4 of 11 | All 11 |
| Memory tokens per swarm run | 800-2,200 | 12,100-38,500 |
| % of 8K context budget | 2.5-6.9% | 34-120% |

---

## Architecture

```
.zo/memory/
├── shared-facts.db          # SQLite database
│   ├── facts                # Core facts table
│   ├── facts_fts            # FTS5 virtual table
│   ├── fact_embeddings      # Vector embeddings (768d)
│   ├── fact_links           # Associative routing graph
│   ├── capture_log          # Auto-capture history
│   ├── episodes             # Episodic memory (v3.1)
│   ├── episode_entities     # Episode-entity junction (v3.1)
│   ├── procedures           # Procedural memory (v3.1, Phase 2)
│   ├── procedure_episodes   # Procedure-episode junction (v3.1, Phase 2)
│   └── embedding_cache      # Content hash cache
├── personas/
│   ├── [persona-1].md       # Critical facts per persona
│   └── [persona-2].md
├── checkpoints/
│   └── [timestamp].json     # Saved states
└── scripts/
    ├── memory.ts            # Main CLI with episodic memory + graph-boosted search (v3.1)
    ├── memory-gate.ts       # Model-routed relevance gate (v2.3)
    ├── graph.ts             # Knowledge graph CLI (v3.0)
    ├── graph-boost.ts       # Graph scoring module (v3.0)
    ├── auto-capture.ts      # Conversation-to-fact extraction + episode hook (v3.1)
    ├── conversation-capture.ts  # Workspace artifact scanner for all conversations (v3.3)
    ├── migrate-v2.sql       # Schema migration for episodic/procedural memory (v3.1)
    ├── rollback-v2.sql      # Migration rollback script (v3.1)
    ├── add-persona.sh       # Persona setup helper
    ├── schema.sql           # Database schema
    ├── test-graph.ts        # Graph integration tests
    └── test-capture.ts      # Auto-capture integration tests
```

### Search Flow (v3.0 — Graph-Boosted)

```
Query → ┌─────────────────────────────────────┐
        │  Parallel Execution                 │
        │  ├── HyDE Expansion (default: gpt-4o-mini) │
        │  ├── Query Embedding (nomic-embed)  │
        │  └── FTS5 Search (BM25)             │
        └─────────────────────────────────────┘
                        ↓
              RRF Fusion (base scores)
                        ↓
              Graph Boost (fact_links)
                        ↓
              Neighbor Injection (linked facts)
                        ↓
              Ranked Results
```

---

## Configuration

Environment variables (optional):

```bash
export ZO_EMBEDDING_MODEL="openai:text-embedding-3-small"   # Default (1536d)
export ZO_HYDE_MODEL="openai:gpt-4o-mini"       # Default
export ZO_HYDE_DEFAULT="true"                   # Default: use HyDE
export ZO_CAPTURE_MODEL="openai:gpt-4o-mini"    # Default: auto-capture model
export ZO_GATE_MODEL="openai:gpt-4o-mini"       # Default: gate model
export ZO_MEMORY_DB="/path/to/shared-facts.db"  # Default: .zo/memory/
```

---

## Testing

```bash
# Run graph integration tests
bun scripts/test-graph.ts

# Run auto-capture integration tests
bun scripts/test-capture.ts
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 4.0.0 | 2026-03-29 | Context budget awareness (token tracking + proactive checkpointing), recursive episode summarization (Ollama-powered FIFO compression), metrics dashboard (latency/recall/capture/gate stats), iterative multi-hop retrieval (confidence-based BFS with query refinement), cross-persona memory sharing (pools + inheritance hierarchy), conflict resolution (semantic/temporal detection + provenance tracking), enhanced knowledge graph (typed relations, cycle detection, DOT export, co-occurrence inference), embedding model benchmarking (3-model comparison + recall measurement). |
| 3.3.1 | 2026-03-07 | HTTP MCP server (`mcp-server-http.ts`) — Streamable HTTP transport via Bun.serve(), registered as Zo hosted service (`svc_PXkgBzRdH8M`), HTTPS at `zo-memory-mcp-marlandoj.zocomputer.io`, configured in Claude Code / Gemini / Codex / workspace .mcp.json, bridge script updated with zo-memory tool permissions |
| 3.3.0 | 2026-03-07 | Conversation capture (conversation-capture.ts) — scan all workspace artifacts for fact extraction, not just swarm. Scheduled daily agent for automatic capture + maintenance reports. Memory Manager persona with full CLI access. |
| 3.2.0 | 2026-03-07 | Procedural memory (versioned workflow storage, CRUD, feedback, Ollama evolution), cognitive profiles (episode IDs, failure patterns, entity affinities in executor-history.json), orchestrator v4.5 integration (auto-episode on swarm completion, 6-signal composite routing with procedure + temporal scores), MCP server (5 tools: search, store, episodes, procedures, cognitive_profile), import pipeline (ChatGPT, Obsidian, markdown), enhanced CLI (profile, import, mcp commands) |
| 3.1.0 | 2026-03-07 | Episodic memory (episodes table, entity tagging, temporal queries), velocity trends, DB migration system (migrate/rollback), auto-capture episode hook, stats v3 with episode/procedure counts |
| 3.0.0 | 2026-03-04 | Graph-boosted hybrid search (graph-boost.ts), BFS path finding & knowledge gap analysis (graph.ts), auto-capture pipeline (auto-capture.ts), co-capture linking, contradiction detection, scoring redistribution (RRF 0.60 + Graph 0.15 + Freshness 0.15 + Confidence 0.10) |
| 2.3.0 | 2026-03-03 | Memory gate (memory-gate.ts), always-on context injection via Zo rules, 24h model keep-alive, gate-filtered token savings for swarm workflows |
| 2.2.0 | 2026-02-27 | Ollama health check, fetch timeouts, prune/decay/consolidate/link/graph commands, vector pre-filtering, adaptive decay, associative routing, PRAGMA busy_timeout |
| 2.1.0 | 2026-02-22 | Parallelized HyDE/FTS/embedding execution, optimized for qwen2.5:1.5b, performance docs |
| 2.0.0 | 2026-02-19 | Hybrid SQLite + Vector search, HyDE query expansion, semantic retrieval, nomic-embed-text via Ollama |
| 1.1.0 | 2026-02-18 | Added swarm v4 integration documentation |
| 1.0.0 | 2026-02-08 | Initial release - SQLite persona memory, 5-tier decay, FTS5 search |

---

## Related Skills

- `zo-swarm-orchestrator` — Multi-agent orchestration with token optimization

## Design References

- `references/graphthulhu-concepts.md` — Design notes on GraphThulhu adaptations
- `references/supermemory-concepts.md` — Design notes on auto-capture inspiration
- `references/model-config.md` — Per-workload model routing (`model.env`), provider
  secrets, and deployment notes for the `memory-gate` service. Read this before
  changing which model handles gate/briefing/extraction workloads.
