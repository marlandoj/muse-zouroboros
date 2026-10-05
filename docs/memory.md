# zo-memory: the shared substrate

## What it is

One SQLite database plus an optional vector index that every agent harness on
your machine — Claude Code, Codex, OpenCode, Hermes, and Muse itself — reads
and writes through a single MCP server. Facts learned in one harness are
searchable from all the others. It is the workshop's long-term memory; Muse's
own curated personal memory stays separate and unsynced by design (personal
facts about *you* vs. working facts about *the work*).

Capabilities: episodic memory ("what happened", with outcomes and temporal
queries like "last week"), procedural memory (versioned workflow patterns
with success/facts tracking), a typed knowledge graph (relations, BFS path
finding, gap analysis, DOT export), auto-capture (fact extraction from work
sessions), contradiction detection with supersession links, first-class open
loops (unfinished tasks as queryable records), continuation recall (the last
14 days blended into context when a message looks like a continuation), and a
5-tier decay system (permanent → stable → active → session → checkpoint).

## How retrieval works

`hybrid` = BM25 (FTS5) + vector cosine similarity, fused with RRF, then
graph-boosted (linked facts promote each other). Optional HyDE expansion
rewrites vague queries into hypothetical answers before embedding — worth
~3.5s for a large recall gain on fuzzy queries. A memory gate (model-routed
classifier) decides per message whether retrieval is even needed; 40–60% of
messages are filtered as not needing memory, costing zero extra tokens.

## Setup

Prerequisites: Bun, and `OPENAI_API_KEY` for embeddings + default generation.
Without the key the system runs **FTS5-only**: keyword search, storage,
episodes, and the graph work fully; embeddings, HyDE, and the gate warn and
fall back.

```bash
cd packages/zo-memory-system
bash scripts/install.sh        # creates ~/.zo/memory, runs migrations
```

This creates `~/.zo/memory/shared-facts.db` and applies the migration chain
(idempotent, with rollback scripts). Verify:

```bash
M=scripts/memory.ts
bun $M stats
bun $M store --persona shared --entity "demo" --key "smoke" \
  --value "Memory is alive" --decay session
bun $M hybrid "memory alive"
```

## Wiring the MCP server

Each harness gets the same stdio server. Add to the harness's MCP config
(Claude Code `~/.claude.json`, Codex `~/.codex/config.toml`, opencode
`~/.config/opencode/opencode.json`, Hermes equivalent):

```json
{
  "mcpServers": {
    "zo-memory": {
      "command": "bun",
      "args": ["<repo>/packages/zo-memory-system/scripts/mcp-server.ts"],
      "env": { "ZO_MEMORY_DB": "~/.zo/memory/shared-facts.db" }
    }
  }
}
```

(Use the exact config shape your harness expects; the server itself is just
`bun scripts/mcp-server.ts` on stdio.) Tools exposed: `memory_search`,
`memory_store`, `memory_episodes`, `memory_procedures`, `cognitive_profile`.

For Muse itself, this is the **memory read seam**: point Muse at the CLI or
the MCP server for build context. One-way read is the recommended starting
posture — Muse reads work facts; it doesn't write personal facts into the
shared DB.

## Model routing

All generation goes through `scripts/model-client.ts`. Defaults are
`openai:gpt-4o-mini` for gate/HyDE/extraction/summarization/briefing/capture
and `openai:text-embedding-3-small` for embeddings. Override per workload:

```bash
export ZO_MODEL_GATE="anthropic:claude-haiku-4-5"   # needs ANTHROPIC_API_KEY
export ZO_MODEL_EMBEDDING="openai:text-embedding-3-large"
```

or put them in `~/.config/zouroboros/model.env` (shell-style `KEY=value`,
no `export` needed). `modelHealthCheck()` validates provider connectivity at
startup.

## Operating notes

- **Personas:** `--persona shared` for cross-harness facts;
  `--persona <harness>` for harness-specific ones. Persona briefing files live
  in `~/.zo/memory/personas/`.
- **Decay:** choose honestly. `permanent` is for decisions and preferences;
  `session`/`checkpoint` for scratch. The decay job promotes/demotes on
  access patterns.
- **Auto-capture:** the post-session capture pipeline extracts facts from
  transcripts. Review what it stores for the first week — tune the gate
  threshold if it's noisy or silent.
- **Health:** `bun scripts/memory.ts stats` shows fact counts, index state,
  and provider availability.
- **Logs:** model calls are appended to
  `~/.zo/memory/model-call-log.jsonl` (JSONL, non-blocking, best-effort).

## What this package changed from upstream

The Anthropic provider was re-pointed from the dead Zo Computer proxy
(`api.zo.computer/zo/ask` + `ZO_CLIENT_IDENTITY_TOKEN`) to the direct
Anthropic Messages API (`ANTHROPIC_API_KEY`). Machine paths were made
home-relative. Nothing else functional changed — see `docs/de-zo-notes.md`.
