---
name: zo-swarm-orchestrator
description: Multi-agent orchestrator with token optimization, adaptive composite routing, qualified dynamic model selection, and persistent memory. Routes DAG tasks across Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, and Pi through bridge and ACP transports.
metadata:
  created: 2026-02-08
  updated: 2026-09-23
  version: 5.1.1
---
# Swarm Orchestrator Skill v5.1.1

A reusable skill that enables **any persona** to spawn parallel agent teams, delegate tasks across specialized personas, and synthesize results into coherent output.

**Current routing model:** Tasks execute through bridge, ACP, or native transports selected from the single seven-executor runtime registry. Capability, health, complexity, measured execution history, procedural learning, temporal performance, budget, and role signals are combined when applicable. Model resolution uses the qualified dynamic catalog, then a last-known-good catalog, then a static floor. Auto-creates memory episodes after every swarm run.

---

## ⚡ Quick Start

```bash
# PRIMARY: Bun TS orchestrator (adaptive 6/8-signal routing, stagnation detection, etc.)
bun Skills/zo-swarm-orchestrator/scripts/orchestrate-v5.ts tasks.json

# FALLBACK: Python orchestrator (lightweight, reliable, basic features)
python3 Skills/zo-swarm-orchestrator/scripts/orchestrate.py tasks.json

# Long campaigns (>5 tasks) — hybrid runner (progress streaming + handoff)
bun Skills/zo-swarm-orchestrator/scripts/swarm-hybrid-runner.ts tasks.json --notify sms

# Cascade mode: use --no-cascade to skip downstream tasks when a root fails
bun Skills/zo-swarm-orchestrator/scripts/orchestrate-v5.ts tasks.json --no-cascade

# Status + health checks
bun Skills/zo-swarm-orchestrator/scripts/orchestrate-v5.ts status <swarm-id>
bun Skills/zo-swarm-orchestrator/scripts/orchestrate-v5.ts doctor
```

---

## MCP Server

The swarm orchestrator can be accessed via MCP (Model Context Protocol) for integration with AI assistants.

### Available Tools

| Tool | Description |
|------|-------------|
| `swarm_execute` | Execute a swarm campaign with multiple parallel tasks |
| `swarm_status` | Check status of a running or completed swarm |
| `swarm_results` | Retrieve detailed results from a completed swarm |
| `swarm_benchmark` | Run a benchmark comparing memory strategies |
| `swarm_list` | List recent swarm campaign runs |

### Usage

**Stdio transport** (for Claude Desktop):
```bash
bun /home/workspace/Skills/zo-swarm-orchestrator/scripts/mcp-server.ts
```

**HTTP transport** (for network access):
```bash
# Start the server
bun /home/workspace/Skills/zo-swarm-orchestrator/scripts/mcp-server-http.ts

# Or run as a Zo service (recommended)
# Service URL: https://zo-swarm-mcp-marlandoj.zocomputer.io
```

### Example: swarm_execute

```json
{
  "tasks": [
    {
      "task": "Analyze the performance of the database query",
      "priority": "high",
      "timeoutSeconds": 300
    },
    {
      "task": "Review the API endpoint for security issues",
      "priority": "medium"
    }
  ],
  "campaignName": "security-audit",
  "waitForCompletion": true
}
```

---

## Long-Running Swarms (>15 min)

### The Problem

Zo's chat interface times out after ~15 minutes of inactivity. For large campaigns (>10 tasks), the swarm continues running in the background, but the chat window loses connection and never sees the final output.

### The Solution: Hybrid Runner

Use `swarm-hybrid-runner.ts` for campaigns that may exceed 15 minutes:

```bash
# Hybrid mode with progress streaming + graceful handoff
bun scripts/swarm-hybrid-runner.ts campaign.json --notify sms

# Or with email notification
bun scripts/swarm-hybrid-runner.ts campaign.json --notify email
```

**What happens:**
1. ✅ **First 13 minutes**: Streams progress updates to chat every 10 seconds
2. ⏰ **At 13 minutes**: Gracefully hands off to background mode
3. 📱 **When complete**: Sends SMS/email notification with results path
4. 💾 **Always**: Saves full results to `~/.swarm/results/<swarm-id>.json`

### Check Status Anytime

```bash
# Check progress on a running or completed swarm
bun scripts/orchestrate-v5.ts status <swarm-id>

# Example output:
# 🔍 Swarm Status: swarm_1710284123456
# Status: 🏃 running
# PID: 12345
# Started: 3/12/2026, 2:05:00 PM
# Progress: 8/20 tasks (40%)
# Elapsed: 18m 34s
# Last update: 30s ago
# 📄 Results: ~/.swarm/results/swarm_1710284123456.json
```

### Recommended Workflow

| Campaign Size | Recommended Approach | Rationale |
|---------------|---------------------|-----------|
| 1-5 tasks | Direct orchestrator | Completes in <10 min, no timeout risk |
| 6-10 tasks | Direct with `--notify email` | May approach timeout, get notified when done |
| 10+ tasks | **Hybrid runner** | Will exceed timeout, need graceful handoff |
| 20+ tasks | **Hybrid runner + batch** | Consider breaking into multiple smaller campaigns |

### Background Mode (Manual)

For running swarms completely in the background from the start:

```bash
# Start in background with notification
nohup bun scripts/orchestrate-v5.ts campaign.json \
  --notify sms \
  > /tmp/swarm.log 2>&1 &

# Check status
bun scripts/orchestrate-v5.ts status <swarm-id>

# View live logs
tail -f /tmp/swarm.log
```

### Notification Options

```bash
# SMS notification (default for hybrid runner)
--notify sms

# Email notification
--notify email

# No notification (results file only)
# (omit --notify flag)
```

**When notifications are sent:**
- ✅ Swarm completes successfully
- ❌ Swarm fails (preflight or runtime errors)
- Both cases include: duration, success/failure summary, results file path

---

## RAG Integration

The orchestrator automatically enriches task prompts with relevant SDK documentation from the Agentic RAG system. This gives agents instant access to best practices and code patterns across the entire Zouroboros ecosystem.

### How It Works

1. **Task Analysis**: When a task contains keywords like "agent", "API", "database", "workflow", etc., the RAG system queries the knowledge base
2. **Semantic Search**: Uses Ollama (nomic-embed-text) for local embeddings, Qdrant for vector search — zero API costs
3. **Context Injection**: Top 3 most relevant SDK patterns are injected into the prompt before the task description

### Covered SDKs (19 Total)

| Category | SDKs |
|----------|------|
| **AI/Agent Frameworks** | claude-sdk, langchain, openai-agents, crewai, adk, llamaindex, pydantic-ai, autogen, dspy, instructor, langgraph, semantic-kernel |
| **Zouroboros Stack** | hono, mcp-sdk, qdrant, bun, drizzle-orm |
| **Business** | stripe, airtable |

### Example Enriched Prompt

```
## Relevant SDK Patterns from Zouroboros Knowledge Base

### Pattern 1: crewai — core-concepts/crew
**Relevance:** 68.2% | **Use Case:** Role-based agent teams for project workflows

```python
from crewai import Crew, Process

crew = Crew(
    agents=[researcher, writer],
    tasks=[research_task, write_task],
    process=Process.hierarchical,
    manager_agent=manager
)
```

### Pattern 2: openai-agents — handoffs
**Relevance:** 64.5% | **Use Case:** Lightweight multi-agent with handoffs

...

## Your Task

Build a multi-agent workflow for content creation...
```

### Verification

Check logs for RAG enrichment activity:
```
📚 [task-001] RAG enriched: 3 patterns (1247ms)
```

If no patterns are found, the task proceeds normally — RAG is additive, not required.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `QDRANT_URL` | (required) | Qdrant Cloud endpoint |
| `QDRANT_API_KEY` | (optional) | Qdrant API key |
| `OLLAMA_URL` | `http://localhost:11434/api/embeddings` | Ollama endpoint |

### Disabling RAG

RAG is automatic and non-blocking. To disable, set `RAG_ENABLED=false` (future release) or simply ensure QDRANT_URL is unset.

---

## Version Status

| Version | Status | Key Innovation |
|---------|--------|----------------|
| **v5 current** | ✅ **Current** | Seven executors, adaptive composite routing, qualified dynamic model catalog, bridge/ACP/native transports, cascade mitigation, memory context injection, hierarchical telemetry |

---

## Architecture: Registry-Driven Execution

Tasks execute through the transport declared by each executor registry entry: bridge scripts or ACP adapters. Shared MCP configuration supplies authenticated Zo tools and memory services to ACP executors.

```
EARLIER ARCHITECTURE           CURRENT ARCHITECTURE
───────────────────           ────────────────────
3 execution paths              1 execution path (local bridges)
  - Local executor               - Local executor only
  - Anthropic Direct API
  - Zo API fallback
Dual concurrency channels      Single concurrency channel
  - maxConcurrency (API)          - concurrency (local)
  - localConcurrency (local)
API credentials required       No API credentials needed
```

All tasks must have a matching local executor in the registry. The preflight check validates this before execution starts.

---

## Token-Optimized Hierarchical Memory

Building on persistent memory, the orchestrator uses intelligent memory strategies that automatically manage token budgets to prevent context window exhaustion.

### The Problem It Solves

From February 2026 production failures:
- **Context window exhaustion**: 5 agents × 256k tokens = system failure
- **Unbounded memory growth**: Sequential memory grows forever
- **No token budgeting**: No visibility into prompt token usage

### What It Adds

| Feature | Implementation | Benefit |
|---------|----------------|---------|
| **Token cleaning** | HTML stripping, deduplication, normalization | ~10-15% token reduction |
| **Hierarchical memory** | Working memory + long-term memory retrieval | Bounded context, relevant history |
| **Sliding window** | Fixed-size recent context window | Predictable token usage |
| **Token budgets** | Configurable max tokens per context | Never exceed context limits |
| **Strategy selection** | Choose memory strategy per task | Optimize for cost vs. context |

---

## Composite Routing

The orchestrator scores each executor on the available signals to pick the best agent for each task:

| Signal | Weight | What it measures |
|--------|--------|------------------|
| **Capability** | configurable | Task keyword matching against executor expertise |
| **Health** | configurable | Circuit breaker state, recent error rate |
| **Complexity fit** | configurable | Simple tasks → fast executors, deep analysis → thorough ones |
| **History** | configurable | Historical success rate for similar tasks |
| **Procedure** | 0.10 | Learned workflow preference from procedural memory (±0.05) |
| **Temporal** | 0.05 | Recent episodic performance bonus/penalty (±0.025) |

Role affinity is authoritative when the bound executor is healthy. Budget and role signals are included when supplied. Model candidates come from the daily intelligence feed, but only models with successful bridge probes and canaries become qualified catalog routes. Light and mid candidates observe output-price ceilings of $2/M and $15/M; stale catalogs fall back to the last-known-good catalog and then the registry static floor.

```
composite = (w.capability × capScore)
          + (w.health × healthScore)
          + (w.complexityFit × complexityScore)
          + (w.history × historyScore)
          + (0.10 × (procedureScore - 0.5))
          + (0.05 × (temporalScore - 0.5))
```

The routing improves with use — after a few runs, tasks flow to whichever executor handles them best.

### Routing presets

| Preset | Best for |
|--------|----------|
| `balanced` (default) | Equal consideration of all signals |
| `fast` | Speed-optimized, prefer simple executors |
| `reliable` | Maximize uptime, penalize unhealthy executors |
| `explore` | Favor executors with proven track records |

```bash
bun orchestrate-v5.ts tasks.json --routing-strategy reliable
```

---

## Auto-Episodes & Cognitive Profiles

### Auto-Episodes

Every swarm run automatically creates an episode in the zo-memory-system with:
- Outcome (success/partial/failure)
- Duration and task count
- Executor list and per-task results
- Entity tags for querying

Query past runs:
```bash
bun ~/Skills/zo-memory-system/scripts/memory.ts episodes --entity "swarm.commerce-a" --since "7 days ago"
```

### Cognitive Profiles

Executor history is extended with:
- **Recent episode IDs** — last 10 episodes for "why did this happen?" queries
- **Failure patterns** — auto-classified: timeout, mutation_failed, file_not_found, permission_denied
- **Entity affinities** — per-entity success rates as exponential moving averages

These feed back into the composite router for smarter task assignment.

---

## Memory Strategies

### Comparison

| Strategy | Token Efficiency | Context Quality | Best For |
|----------|------------------|-----------------|----------|
| `none` | ⭐⭐⭐⭐⭐ | ⭐☆☆☆☆ | Independent tasks, cost-sensitive |
| `sliding` | ⭐⭐⭐⭐☆ | ⭐⭐⭐☆☆ | Recent context matters |
| `hierarchical` | ⭐⭐⭐⭐☆ | ⭐⭐⭐⭐⭐ | Complex multi-step workflows |
| `sequential` | ⭐☆☆☆☆ | ⭐⭐⭐⭐⭐ | Debugging, small swarms only |

### Benchmark Results

```
Strategy       Avg Prompt    Memory    Token
               Tokens        Items     Savings
───────────────────────────────────────────────
none           26            0         -93%
sliding        356           3         -8%
hierarchical   416           4         -8%
sequential     386           5         0%
```

---

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `--swarm-id <id>` | Unique swarm identifier | auto-generated |
| `--strategy <type>` | Memory strategy | hierarchical |
| `--max-tokens <n>` | Token budget for context | 8000 |
| `--concurrency <n>` | Max parallel local executors | 4 |
| `--timeout <seconds>` | Per-task timeout | 300 |
| `--dag-mode <mode>` | `streaming` or `waves` | streaming |
| `--routing-strategy <s>` | `fast`, `reliable`, `balanced`, `explore` | balanced |
| `--no-memory` | Disable all memory | false |
| `--notify <channel>` | Send completion notification: sms or email | none (file always written) |

---

## Task File Format

```json
[
  {
    "id": "task-1",
    "persona": "frontend-developer",
    "task": "Analyze UI/UX for accessibility issues",
    "priority": "high",
    "memoryStrategy": "hierarchical",
    "outputToMemory": true,
    "memoryMetadata": {
      "category": "ui-analysis",
      "priority": "high",
      "tags": ["accessibility", "responsive"]
    }
  }
]
```

---

## Files Reference

| File | Purpose |
|------|---------|
| `orchestrate-v5.ts` | Main orchestrator with adaptive composite routing |
| `scripts/model-catalog.ts` | Build, inspect, resolve, and qualify dynamic model routes |
| `src/routing/model-catalog.ts` | Catalog ranking, qualification fallback, and atomic publication |
| `token-optimizer.ts` | Token cleaning + hierarchical memory |
| `swarm-memory.ts` | SQLite persistence + inter-agent messaging |
| `swarm-config.ts` | Configuration management CLI |
| `benchmark.ts` | Memory strategy benchmarking |
| `test-orchestrator.ts` | Test suite |
| `performance-test.ts` | Baseline vs enhanced performance test |
| `inter-agent-comms.ts` | Inter-agent communication system |

---

## Executors

The orchestrator discovers seven executors through the single runtime `executor-registry.json` and uses each entry's declared transport, capabilities, model router, MCP policy, and fallback chain.

| Executor | Transport | Primary use |
|----------|-----------|-------------|
| `claude-code` | ACP | Complex implementation, architecture, review |
| `hermes` | Native ACP | Research, external tools, autonomous investigation |
| `gemini` | Native ACP | Large-context, multimodal, UI analysis |
| `codex` | ACP | Fast repository implementation and refactoring |
| `opencode` | Native ACP | Vendor-neutral and provider-pinned coding |
| `kimi` | Native ACP bridge | Long-context coding and Moonshot-family review |
| `pi` | One-shot bridge with MCP adapter | Fast focused implementation and isolated comparisons |

See [`docs/executors/capability-matrix.md`](docs/executors/capability-matrix.md) for tool access, hierarchical delegation boundaries, model routes, SDK corpus coverage, selection priority, and fallback behavior.

---

## Utilities

```bash
# Benchmark all memory strategies
bun benchmark.ts

# Test orchestrator
bun test-orchestrator.ts

# Memory management
bun swarm-memory.ts stats
bun swarm-memory.ts list-sessions
bun swarm-memory.ts cleanup 30
```

---

## Configuration

You can configure the orchestrator using **either** a config file **or** environment variables.

### Option 1: Config File (Recommended)

Create `config.json` in the skill root:

```json
{
  "localConcurrency": 4,
  "timeoutSeconds": 300,
  "maxRetries": 3,
  "memory": {
    "enable": true,
    "workingMemorySize": 2,
    "longTermMemorySize": 3,
    "enableDeduplication": true,
    "enableHTMLStripping": true,
    "maxTokens": 8000
  }
}
```

**Priority:** CLI flags > Config file > Environment variables > Defaults

### Option 2: Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_WORKSPACE` | Root for deployment resources | `/home/workspace` |
| `SWARM_LOCAL_CONCURRENCY` | Max parallel local executors | 4 |
| `SWARM_TIMEOUT_SECONDS` | Per-task timeout | 300 |
| `SWARM_MAX_RETRIES` | Retry attempts | 3 |
| `SWARM_IDENTITY_DIR` | Persona identity files directory | `$SWARM_WORKSPACE/IDENTITY` |
| `SWARM_SOUL_FILE` | Path to constitution file | `$SWARM_WORKSPACE/SOUL.md` |
| `SWARM_PERSONA_MEMORY_DIR` | Persona-specific memory files | `$SWARM_WORKSPACE/.zo/memory/personas` |
| `SWARM_MEMORY_SCRIPT` | Memory search script path | `$SWARM_WORKSPACE/Skills/zo-memory-system/scripts/memory.ts` |
| `SWARM_EXECUTOR_REGISTRY` | Optional executor registry override | `/home/workspace/packages/swarm/dist/executor/registry/executor-registry.json` |

---

## Roadmap

Planned optimizations from production profiling (see README.md for full details):

| Phase | Optimizations | Expected Savings |
|-------|--------------|------------------|
| **Phase 1** — Quick Wins | O3: Pre-warm cache TTL, O4: Prompt format constraints, O6: Circuit breaker tuning | 5-13% |
| **Phase 2** — Execution Engine | O2: DAG streaming improvements, O1: Request batching | +13-30% |
| **Phase 3** — Refinements | O5: Early filtering, O7: Output deduplication, O8: Concurrent caching | +2-5% |

---

## References

- Prompt-Refiner: https://github.com/JacobHuang91/prompt-refiner
- Agent-Memory-Playground: https://github.com/AIAnytime/Agent-Memory-Playground
