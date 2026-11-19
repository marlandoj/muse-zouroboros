# GraphThulhu Concepts — Design Notes

Adapted concepts from [GraphThulhu](https://github.com/skridlevsky/graphthulhu), a Go-based knowledge graph MCP server for Logseq/Obsidian.

## What We Took

### 1. Associative Graph Boost (Enhancement 1)
GraphThulhu treats every note as a node with typed, weighted edges. When traversing, linked nodes surface together. We adapted this as a scoring modifier in RRF fusion — linked facts get a boost proportional to their link weight.

Key difference: GraphThulhu is graph-first (no semantic search). We bolt graph signals onto an existing hybrid search pipeline, keeping FTS+vectors as the primary signal.

### 2. BFS Path Finding (Enhancement 2)
GraphThulhu's `find_shortest_path` tool uses BFS over its adjacency list. We replicated this for `find-connections`, building an in-memory adjacency from `fact_links` and doing bidirectional BFS. Max depth 5 (configurable).

### 3. Orphan & Cluster Analysis (Enhancement 3)
GraphThulhu's `find_orphan_pages` and `get_connected_components` tools map directly to our `knowledge-gaps` command. We added dead-end detection (targets that are never sources) and weak-link identification.

## What We Didn't Take

- **Logseq/Obsidian backend**: Different data model (block references, page hierarchies). Our flat SQLite facts table is simpler.
- **37 MCP tools**: Overkill. We only needed 3 algorithms, not a full MCP server.
- **Go runtime**: Additional dependency. Our TypeScript/Bun stack is sufficient.
- **No semantic search**: GraphThulhu has no embeddings, no FTS, no HyDE. Would be a regression.

## Architecture Decision

Graph features operate on the existing `fact_links` table (already in the live DB with 7 rows). No new tables needed for graph intelligence. The `capture_log` table was added for auto-capture (separate concern).
