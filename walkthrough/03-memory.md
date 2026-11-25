# Walkthrough 03 — Memory

## Initialize the database

```bash
cd ~/workspace/muse-zouroboros/packages/memory-system
bash scripts/install.sh
```

This creates `~/.zo/memory/shared-facts.db` and runs the migration chain
(idempotent; rollback scripts ship alongside each migration).

**Prove it:**

```bash
M=scripts/memory.ts
bun $M stats
bun $M store --actor claude-code --persona shared --entity "workshop" --key "smoke" \
  --value "Memory is alive" --decay session
bun $M hybrid "memory alive" --actor claude-code
```

Fact reads/writes accept `--actor <identity>` (your persona/seat). When
omitted, the call operates on the `shared` pool. The stored persona defaults
to the actor; `--persona shared` makes the fact deliberately cross-harness.

You should see the fact you just stored come back in the hybrid results. If
`OPENAI_API_KEY` isn't set, you'll see a note that it's running FTS5-only —
that's fine, keyword search works. (If you expected full mode, see
`docs/api-keys.md` — Troubleshooting.)

## Wire the MCP servers into your client

The workshop ships two stdio MCP servers, and every client should get both:

| Server | Command (paths the installer creates) | Env |
|---|---|---|
| `zouroboros-memory` | `bun ~/workspace/muse-zouroboros/packages/memory-system/scripts/mcp-server.ts` | `ZOUROBOROS_MEMORY_DB=~/.zo/memory/shared-facts.db` |
| `zouroboros-swarm` | `bun ~/workspace/muse-zouroboros/packages/swarm-orchestrator/scripts/mcp-server.ts` | `ZOUROBOROS_MEMORY_DB`, `SWARM_EXECUTOR_REGISTRY`, `SWARM_WORKSPACE` |

Each client has its own config format, and most do not expand `~` or
`$HOME` inside MCP config, so don't hand-adapt a snippet. Print the exact
block for your client, with this machine's absolute paths filled in:

```bash
cd ~/workspace/muse-zouroboros
bash scripts/connect-config.sh --list      # claude-code codex gemini opencode hermes kimi pi claude-desktop cursor vscode
bash scripts/connect-config.sh codex       # prints the block and says which file it goes in
```

Paste it where it says, then load the concierge playbook in that client's
own instructions form (the same output tells you how). The per-client
details, the first check to run in each, and what has and has not been
tested are in [docs/connect.md](../docs/connect.md). Web clients (ChatGPT,
Claude.ai, Muse) cannot run a local command; they use the opt-in remote
mode in `packages/workshop-remote` instead, also covered there.

**Actor scoping:** `memory_store` and `memory_search` accept an optional
`actor` argument naming the calling harness/persona; when omitted, the call
operates on the `shared` pool. Tell each harness to pass its identity, e.g.:

```json
{ "name": "memory_store", "arguments": { "actor": "codex", "entity": "workshop", "value": "wired up", "persona": "shared" } }
```

**Prove it:** in that client, ask it to store a fact through the MCP tools
(`memory_store` with its own `actor`, `persona: "shared"`), then in a
*different* client (or a fresh session), search for it (`memory_search` with
that client's `actor`). Cross-client recall on day one is the whole point
— if it works now, the substrate is real. Then check the audit trail:
`sqlite3 ~/.zo/memory/shared-facts.db "SELECT actor, action, scope FROM memory_audit ORDER BY id DESC LIMIT 5"`.

## Set your model routing (optional)

Defaults are `openai:gpt-4o-mini` for generation workloads and
`openai:text-embedding-3-small` for embeddings. To override per workload,
add to `~/.config/zouroboros/model.env`:

```bash
ZO_MODEL_GATE=openai:gpt-4o-mini
ZO_MODEL_HYDE=openai:gpt-4o-mini
ZO_MODEL_EMBEDDING=openai:text-embedding-3-small
# ZO_MODEL_BRIEFING=anthropic:claude-haiku-4-5   # needs ANTHROPIC_API_KEY
```

## Start capturing

For the first week, store deliberately: decisions you make, preferences you
state, procedures that worked. Use `--decay` honestly — `permanent` for
decisions, `session` for scratch. The auto-capture pipeline
(`scripts/auto-capture.ts`) can extract facts from transcripts, but start
manual so you learn what good facts look like before automating.

**Muse seam (do this now):** give Muse one-way read access — the CLI
(`bun scripts/memory.ts hybrid "..."`) or the same MCP server. Personal
memory stays in Muse; work memory stays here. No sync. When Muse needs build
context ("what did we decide about the router?"), it asks the workshop,
not you.

## Prove it

- [ ] `bun scripts/memory.ts stats` shows your stored facts
- [ ] A fact stored via MCP in one harness is searchable from another
- [ ] You know where `model.env` lives and what the defaults are

Next: [04 — Swarm](04-swarm.md).
