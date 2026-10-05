# Memory System Deletion Mechanisms

## Overview

The zo-memory system now has three deletion commands available via the CLI (`bun memory.ts`). All deletions cascade automatically — removing a fact also removes its embeddings, links, and ACT-R activation rows via `ON DELETE CASCADE` foreign keys in the SQLite schema.

## Commands

### 1. `delete --id <fact_id>`
Surgical removal of a single fact by UUID.

```bash
bun memory.ts delete --id "abc-123-def"
```

- Checks the fact exists first; exits 1 with error if not found
- Enables `PRAGMA foreign_keys = ON` before delete to ensure cascade
- Cascades to: `fact_embeddings`, `fact_links`, `actr_activation`

### 2. `prune --expired`
Garbage-collects all facts past their `expires_at` timestamp.

```bash
bun memory.ts prune --expired
bun memory.ts prune --expired --dry-run    # preview only
```

- Selects facts where `expires_at IS NOT NULL AND expires_at < now()`
- Dry-run mode shows up to 10 IDs that would be deleted without removing anything
- Decay classes and their TTLs: `permanent` (never), `stable` (90d), `active` (14d), `session` (1d), `checkpoint` (4h)

### 3. `prune --below-activation <threshold>`
Clears facts with ACT-R activation score below a given threshold.

```bash
bun memory.ts prune --below-activation -3.0
bun memory.ts prune --below-activation -3.0 --dry-run
```

- JOINs `facts` with `actr_activation` on `fact_id`
- Gracefully handles missing `actr_activation` table (exits with message, no crash)
- Both prune modes can be combined in a single call:
  ```bash
  bun memory.ts prune --expired --below-activation -3.0
  ```

## Eval Results (2026-04-11)

| Test | Result |
|---|---|
| Store → delete → verify gone | PASS |
| Double-delete (same ID) | PASS — exits 1 with "Fact not found" |
| Delete with no `--id` | PASS — exits 1 with error message |
| Cascade: embeddings removed on delete | PASS — 1 → 0 rows |
| Prune expired (dry-run) | PASS — identified 69 expired facts |
| Prune expired (live) | PASS — 355 → 286 facts |
| Prune below-activation (dry-run) | PASS — no facts below -5.0 threshold |
| Prune with bad threshold | PASS — exits 1 with error |

## Gap Audit (2026-04-11)

### 1. Reachability
- **CLI**: All three commands are wired in the switch block and documented in `--help`. Fully reachable via `bun memory.ts delete|prune`.
- **MCP Server**: GAP IDENTIFIED. `zouroboros/packages/memory/src/mcp-server.ts` imports `deleteFact` and `cleanupExpiredFacts` from `facts.ts` (lines 11, 407, 426) but **never registers them as MCP tools**. They are dead imports. The MCP path (used by Claude Code MCP tools like `mcp__zo-memory-stdio__memory_store`) has no delete capability.
- **Persona memory shim** (`.zo/memory/scripts/memory.ts`): 26-line forwarder to the v3 CLI — no delete/prune of its own, but the v3 CLI it forwards to now has them.

### 2. Data Prerequisites
- `ON DELETE CASCADE` is defined on `fact_embeddings`, `fact_links`, and `actr_activation` foreign keys — verified working.
- `PRAGMA foreign_keys = ON` is explicitly set before every delete (SQLite defaults to OFF).
- `actr_activation` table existence is checked before below-activation prune (graceful fallback).

### 3. Cross-Boundary State
- No cross-process concerns — all operations are single-process SQLite transactions.
- DB file size does not shrink after delete (SQLite behavior). `VACUUM` would reclaim space but is not automatically run. Acceptable for now.

### 4. Eval-Production Parity
- CLI commands operate on the same `shared-facts.db` used by the memory gate daemon and MCP server — same DB, same schema, same data.
- The MCP server gap (no delete/prune tools exposed) means production callers through MCP cannot delete. This is a known gap, not a parity issue — the CLI is the production interface for deletion today.

## Gap Fix: MCP Tools Wired (2026-04-11)

The identified reachability gap has been closed. Two new MCP tools added to `zouroboros/packages/memory/src/mcp-server.ts`:

| MCP Tool | What it does |
|---|---|
| `memory_delete` | Deletes a fact by UUID via `deleteFact()`. Returns `{ deleted: true, id }` or throws if not found. |
| `memory_prune` | Calls `cleanupExpiredFacts()` to garbage-collect expired facts. Supports `dry_run: true` to preview (returns `{ would_delete, ids }`). |

**Verification:**
- `tsc --noEmit`: clean (0 errors)
- `bun test packages/memory`: 75 pass, 0 fail
- Import fixed: `getDatabase` added to database.js import for dry-run query
- Previously dead imports (`deleteFact`, `cleanupExpiredFacts`) are now fully wired

**Reachability after fix:**
- CLI: `bun memory.ts delete|prune` — operational
- MCP: `memory_delete`, `memory_prune` — operational
- MCP server restart required to pick up changes

## Post-Fix Three-Stage Eval (2026-04-11)

### Stage 1: Mechanical Checks
| Check | Result |
|---|---|
| `tsc --noEmit` (monorepo) | PASS — 0 errors |
| `bun test packages/memory` | PASS — 75 tests, 0 failures |
| HTTP server runtime (`/health`) | PASS — status ok, 7 tools, DB connected |
| CLI parse (`bun --parse memory.ts`) | PASS |

### Stage 2: Functional Verification (9 tests)
| Test | Result |
|---|---|
| Store → delete → verify gone | PASS |
| Embeddings cascade (1 → 0) | PASS |
| Double-delete exits 1 | PASS |
| Delete with no `--id` exits 1 | PASS |
| Prune expired dry-run | PASS |
| Prune with bad threshold exits 1 | PASS |
| HTTP server lists `memory_delete` | PASS |
| HTTP server lists `memory_prune` | PASS |
| Monorepo MCP has both handlers | PASS |

### Stage 3: Gap Audit (4 checks)
| Check | Status |
|---|---|
| **Reachability** | PASS — CLI (3 commands), HTTP MCP (2 tools), Monorepo MCP (2 tools) all wired |
| **Data Prerequisites** | PASS — `ON DELETE CASCADE` on 3 FK tables, `PRAGMA foreign_keys = ON` in all code paths (4× CLI, 2× HTTP), ACT-R table exists |
| **Cross-Boundary State** | PASS — CLI and HTTP server use same `shared-facts.db` path, WAL mode enables concurrent readers |
| **Eval-Production Parity** | PASS — CLI `deleteFact`/`pruneExpired` logic matches HTTP `toolMemoryDelete`/`toolMemoryPrune` (same query, same FK pragma, same cascade) |

### Final E2E Confirmation
Store → Search (1 result) → Delete → Search (0 results) → Cascade verify (0 embeddings) → Prune dry-run: **ALL PASS**

## Architecture Note

There are two parallel implementations of `deleteFact`:
1. **CLI** (`Skills/zo-memory-system/scripts/memory.ts:1215`): Uses `better-sqlite3` via `initDb()`, operates on `shared-facts.db`
2. **Monorepo** (`zouroboros/packages/memory/src/facts.ts:407`): Uses `bun:sqlite` via `getDatabase()`, also invalidates graph cache

Both do the same thing but through different DB drivers. The monorepo version also has `cleanupExpiredFacts()` which is equivalent to the CLI's `pruneExpired()`. The monorepo version is now wired as MCP tools (`memory_delete`, `memory_prune`) as of 2026-04-11.
