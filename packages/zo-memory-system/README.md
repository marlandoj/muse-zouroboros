# Zouroboros Memory System

> **Status (2026-04-27):** This repository is the **canonical home for the runtime skill** that powers Zo Computer's memory daemon, gate hook, capture pipeline, knowledge graph, vault, and persona memory files. The [Zouroboros monorepo](https://github.com/marlandoj/zouroboros) `packages/memory/` is the **library** used by npm consumers and bench adapters; it currently lags this skill on graph/community/vault features. A future consolidation pass will reconcile the two — see [issues](https://github.com/marlandoj/zouroboros-memory-system/issues) for status. Until then, file runtime/skill issues here and library/SDK issues against the monorepo.

---

> Give your Zo Computer personas persistent memory with semantic understanding, a knowledge graph, and automatic fact extraction. Generation and embedding workloads both route through hosted providers.
>
> Part of the [Zouroboros](https://github.com/marlandoj) ecosystem — self-improving AI development tools for Zo Computer.

[![Version](https://img.shields.io/badge/version-3.2.0-blue?style=flat-square)](https://github.com/marlandoj/zouroboros-memory-system)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What This Is

This skill gives your AI personas long-term memory that persists across conversations:

- **Hybrid Search** -- Combines keyword matching (BM25) with vector similarity so you find facts even when you phrase things differently
- **Knowledge Graph** -- Link facts together with typed relationships, find connections between entities, and identify gaps in your knowledge base
- **Auto-Capture** -- Feed a conversation transcript in, get structured facts out. No manual entry required
- **Automatic Continuation Recall** -- Silently blends relevant facts, searchable episodes, and open loops from the last 14 days when a message looks like follow-on work
- **First-Class Open Loops** -- Stores unfinished tasks, unresolved bugs/incidents, pending approvals, and next-step commitments as queryable records
- **Searchable Session Summaries** -- Episodes are indexed for continuation retrieval, not just listed by time
- **Episodic Memory** -- Record "what happened" as events with outcomes, entity tagging, and temporal queries ("since last week", "failures in March")
- **Procedural Memory** -- Versioned workflow patterns that track success/failure rates and self-evolve using the configured generation model when failures accumulate
- **MCP Server** -- Expose memory as MCP tools (search, store, episodes, procedures, cognitive profiles) for Claude Desktop, Cursor, and other MCP clients
- **Import Pipeline** -- Import facts from ChatGPT exports, Obsidian vaults, and markdown files with dedup and auto-embedding
- **Memory Gate** -- A routed model workload that decides whether each message needs stored memory, filtering 40-60% of messages and saving tokens
- **5-Tier Adaptive Decay** -- Facts automatically promote or demote based on how often they're accessed
- **Swarm Integration** -- Token-optimized memory for multi-agent workflows via [zouroboros-swarm-orchestrator](https://github.com/marlandoj/zouroboros-swarm-orchestrator), with 6-signal composite routing, auto-episode creation, and cognitive profiles
- **Default Routing** -- Generation workloads default to OpenAI `gpt-4o-mini`; embeddings use hosted OpenAI `text-embedding-3-small`. No local model runtime is required.

---

## Quick Start

There are two ways to use this skill: through the **Zo chat window** (natural language) or the **terminal** (CLI scripts).

### Option 1: Natural Language via Zo Chat

The fastest way. Open your Zo chat window and type:

```
Set up the memory system for my personas.
Use the zo-memory-system skill.
```

Zo will install the database, configure provider routing, and set up local embeddings if desired. You can then say things like:

- *"Remember that our brand voice is concise, confident, and no fluff"*
- *"What did we decide about the database for the FFB project?"*
- *"Store this as a permanent preference: always use Bun over Node for new scripts"*
- *"Search my memory for anything about supplier pricing"*
- *"Show me how the FFB website is connected to our hosting decision"*
- *"Run a knowledge gap analysis on my stored facts"*
- *"Extract facts from today's conversation and store them"*

Zo handles the CLI commands, search queries, and fact storage automatically.

### Option 2: Terminal (CLI Scripts)

#### Install and initialize

```bash
cd /home/workspace/Skills/zo-memory-system
./scripts/install.sh
bun scripts/memory.ts init
```

#### Store a fact

```bash
bun scripts/memory.ts store \
  --entity "user" \
  --key "brand-voice" \
  --value "Concise, confident, no fluff" \
  --decay permanent
```

#### Search your memory

```bash
# Continuation recall across facts + episodes + open loops
bun scripts/memory.ts continuation "where did we leave off on the dashboard?"
bun scripts/memory.ts open-loops --status open
bun scripts/memory.ts resolve-loop "The dashboard issue is fixed now"

# Semantic + keyword hybrid search (recommended)
bun scripts/memory.ts hybrid "why did we choose SQLite"

# Fast exact keyword search
bun scripts/memory.ts search "router password"
```

#### Add memory support for a persona

```bash
bun scripts/add-persona.sh "ops-manager" "Operations leader"
```

---

## Prerequisites

Routing uses hosted providers. Embeddings are OpenAI `text-embedding-3-small`; generation
workloads resolve through `scripts/model-client.ts` with per-workload env overrides. No
local model runtime is installed or required.

```bash
export OPENAI_API_KEY="your_api_key_here"
```

| Model | Purpose | Size | Required? |
|-------|---------|------|-----------|
| openai:gpt-4o-mini | Gate, HyDE, auto-capture, summaries | API | Yes (default generation path) |
| openai:text-embedding-3-small | Vector embeddings (1536-dim) | API | Yes (default embedding path) |

---

## Key Features Explained

### Hybrid Search

The system runs two searches in parallel and combines the results:

1. **BM25 full-text search** -- Finds exact keyword matches
2. **Vector similarity search** -- Finds semantically similar facts using embeddings

Results are fused using Reciprocal Rank Fusion (RRF). This means "what's the router password?" and "what was that network credential we set up?" both find the same fact.

**HyDE query expansion** rewrites vague queries into hypothetical answers before searching. A query like "that thing about data safety" gets expanded, turning 1-result searches into 6-result searches. Adds about 3.5s of latency.

### Knowledge Graph

Facts can be linked with typed, weighted relationships:

```bash
# Link two facts
bun scripts/graph.ts link --source <id1> --target <id2> --relation "depends_on"

# Find the shortest path between two entities
bun scripts/graph.ts find-connections --from "project.ffb-site" --to "decision.hosting"

# Scan for orphaned facts, dead ends, and weak links
bun scripts/graph.ts knowledge-gaps
```

Or via Zo chat:

```
Link the FFB website fact to our hosting decision with a "depends_on" relationship.
How is the FFB website connected to our infrastructure setup?
Run a knowledge gap analysis.
```

### Auto-Capture

Extract structured facts from conversation transcripts:

```bash
# Preview what would be extracted (dry run)
bun scripts/auto-capture.ts --input conversation.md --dry-run

# Extract and store facts
bun scripts/auto-capture.ts --input conversation.md --source "chat:2026-03-04"
```

Or via Zo chat:

```
Extract facts from today's conversation and store them in memory.
```

Quality safeguards: confidence threshold (0.6), minimum value length (10 chars), max 20 facts per capture, deduplication, and contradiction detection with supersession links.

### Memory Gate

The memory gate uses the configured gate model to classify each incoming message: does it need stored memory? It now checks for continuation-like turns first, using blended recall across facts, episodes, and open loops before falling back to the standard hybrid search path.

```bash
bun scripts/memory-gate.ts "what did we decide about pricing?"  # Exit 0: results found
bun scripts/memory-gate.ts "where did we leave off on the dashboard?"  # Exit 0: continuation recall or fallback search
bun scripts/memory-gate.ts "hello"                               # Exit 2: no memory needed
```

**Exit codes:** 0 = results found, 1 = error, 2 = no memory needed, 3 = memory needed but nothing found

In a real swarm with 11 tasks, the gate keeps memory token usage at 2.5-6.9% of the context budget vs. 34-120% without it.

### Continuation Recall Evaluation

A fixture-backed evaluator now measures 14-day continuation recall quality against a labeled scenario set.

```bash
bun scripts/eval-continuation.ts
```

Artifacts:
- `assets/continuation-eval-fixture-set.json` — labeled facts, episodes, open loops, and expected retrieval cases
- `scripts/eval-continuation.ts` — loads the fixture DB, runs continuation detection/retrieval, and checks the success-rate threshold

Current target: **85%** minimum pass rate.

### Episodic Memory

Record events with outcomes and query them by time, entity, or result:

```bash
# List recent episodes
bun scripts/memory.ts episodes --since "7 days ago"

# Filter by outcome
bun scripts/memory.ts episodes --outcome failure --since "30 days ago"

# Filter by entity
bun scripts/memory.ts episodes --entity "executor.claude-code" --since "7 days ago"

# Track success/failure trends over time
bun scripts/memory.ts trends --entity "executor.claude-code" --granularity week
```

Or via Zo chat:

```
What swarm failures happened this week?
Show me the success rate trend for Claude Code over the last month.
```

Accepts relative times ("7 days ago", "last week"), ISO dates, and Unix timestamps.

### Procedural Memory

Capture reusable workflow patterns as versioned step sequences:

```bash
# List all procedures
bun scripts/memory.ts procedures --list

# Show steps for a specific procedure
bun scripts/memory.ts procedures --show "site-review"

# Record success/failure feedback
bun scripts/memory.ts procedures --feedback <id> --success
bun scripts/memory.ts procedures --feedback <id> --failure

# Evolve a procedure using the configured generation model
bun scripts/memory.ts procedures --evolve "site-review"
```

When a procedure accumulates failures, `--evolve` uses the configured generation model (default `openai:gpt-4o-mini`) to analyze linked failure episodes and create a new version with adjusted steps, timeouts, or fallback executors.

### MCP Server

Expose the memory system as MCP tools for external clients:

```bash
bun scripts/mcp-server.ts          # Start directly
bun scripts/memory.ts mcp          # Start via CLI
```

**Available tools:** `memory_search`, `memory_store`, `memory_episodes`, `memory_procedures`, `cognitive_profile`

Add to Claude Desktop or `.claude.json`:

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

### Import Pipeline

Import facts from external sources:

```bash
# Preview (no changes)
bun scripts/memory.ts import --source markdown --path ~/notes/decisions.md --dry-run

# Import ChatGPT export
bun scripts/memory.ts import --source chatgpt --path ~/chatgpt-export.json

# Import Obsidian vault
bun scripts/memory.ts import --source obsidian --path ~/Vault

# Import single markdown file
bun scripts/memory.ts import --source markdown --path ~/notes/architecture.md
```

Supported sources: ChatGPT JSON exports, Obsidian markdown vaults (with frontmatter), and standalone markdown files. All imports include dedup detection and auto-generated embeddings.

---

## Performance

| Mode | Latency | Use Case |
|------|---------|----------|
| FTS + Vectors only | ~0.5s | Specific queries with exact keywords |
| With HyDE expansion | ~4s | Vague or conceptual queries |
| Graph-boosted search | +~5ms | Negligible overhead on top of any search |
| Auto-capture | ~3-5s | Per-conversation extraction |
| Memory gate (warm) | ~5-7s | Per-message classification |
| Episode queries | ~10ms | Temporal filtering and trends |
| Procedure evolution | ~5-10s | Model-routed step analysis |

---

## Implementation Examples

### Example 1: Store brand preferences (Zo chat)

```
Remember these preferences for all my personas:
- Brand voice: concise, confident, no fluff
- Always use Bun over Node for new scripts
- Default timezone: America/Phoenix
```

### Example 2: Research memory (terminal)

```bash
# Store a project decision
bun scripts/memory.ts store \
  --entity "decision.database" \
  --key "choice" \
  --value "Chose SQLite over Postgres for memory storage. Reason: zero config, embedded, fast for single-user." \
  --decay stable

# Later, find it with a vague query
bun scripts/memory.ts hybrid "why did we pick the database"
```

### Example 3: Knowledge graph exploration (Zo chat)

```
How is my FFB website project connected to the hosting decisions we made?
Show me all facts about the FFB project.
What knowledge gaps exist in my stored facts?
```

### Example 4: Auto-capture after a swarm run

```
Extract facts from the swarm output at /home/workspace/Reports/ffb-review.md
and store them in memory under the "ffb-project" persona.
```

---

## Repository Structure

```
zouroboros-memory-system/
├── SKILL.md                  # Full documentation (v3.2)
├── README.md                 # This file
├── scripts/
│   ├── memory.ts             # Main CLI (hybrid search, store, episodes, procedures, import, mcp)
│   ├── memory-gate.ts        # Model-routed relevance gate
│   ├── mcp-server.ts         # MCP server (5 tools, stdio transport)
│   ├── import.ts             # Import pipeline (ChatGPT, Obsidian, markdown)
│   ├── auto-capture.ts       # Conversation-to-fact extraction
│   ├── graph.ts              # Knowledge graph CLI (link, find-connections, gaps)
│   ├── graph-boost.ts        # Graph scoring module
│   ├── migrate-v2.sql        # Schema migration for episodic/procedural tables
│   ├── rollback-v2.sql       # Migration rollback script
│   ├── add-persona.sh        # Persona setup helper
│   ├── install.sh            # Install to workspace
│   ├── schema.sql            # Database schema
│   └── package.json          # Dependencies
└── assets/
    └── examples/             # Example persona memory files
```

---

## Configuration

Environment variables (all optional, sensible defaults):

```bash
export ZO_EMBEDDING_MODEL="openai:text-embedding-3-small"   # Default (1536d)
export ZO_HYDE_MODEL="openai:gpt-4o-mini"
export ZO_GATE_MODEL="openai:gpt-4o-mini"
export ZO_CAPTURE_MODEL="openai:gpt-4o-mini"
export ZO_MEMORY_DB="/path/to/shared-facts.db"
```

---

## Related Skills

- [zouroboros-persona-creator](https://github.com/marlandoj/zouroboros-persona-creator) -- Create personas that use this memory system
- [zouroboros-swarm-orchestrator](https://github.com/marlandoj/zouroboros-swarm-orchestrator) -- Multi-agent coordination with token-optimized memory
- [zouroboros-swarm-executors](https://github.com/marlandoj/zouroboros-swarm-executors) -- Local executor bridges that share memory

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-improvement`)
3. Commit your changes
4. Push to the branch (`git push origin feature/my-improvement`)
5. Open a Pull Request

---

## License

MIT License -- Use freely, commercially or personally.
