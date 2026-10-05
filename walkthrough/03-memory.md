# Walkthrough 03 — Memory

## Initialize the database

```bash
cd ~/workspace/zouroboros-for-muse/packages/zo-memory-system
bash scripts/install.sh
```

This creates `~/.zo/memory/shared-facts.db` and runs the migration chain
(idempotent; rollback scripts ship alongside each migration).

**Prove it:**

```bash
M=scripts/memory.ts
bun $M stats
bun $M store --persona shared --entity "workshop" --key "smoke" \
  --value "Memory is alive" --decay session
bun $M hybrid "memory alive"
```

You should see the fact you just stored come back in the hybrid results. If
`OPENAI_API_KEY` isn't set, you'll see a note that it's running FTS5-only —
that's fine, keyword search works.

## Wire the MCP server into one harness

Pick the harness you use most. Add the `zo-memory` stdio server to its MCP
config (adjust the config shape to your harness; the server command is the
same):

- Claude Code: `~/.claude.json`
- Codex CLI: `~/.codex/config.toml`
- OpenCode: `~/.config/opencode/opencode.json`

```json
{
  "mcpServers": {
    "zo-memory": {
      "command": "bun",
      "args": ["$HOME/workspace/zouroboros-for-muse/packages/zo-memory-system/scripts/mcp-server.ts"],
      "env": { "ZO_MEMORY_DB": "$HOME/.zo/memory/shared-facts.db" }
    }
  }
}
```

**Prove it:** in that harness, ask it to store a fact through the MCP tools
(`memory_store`), then in a *different* harness (or a fresh session), search
for it (`memory_search`). Cross-harness recall on day one is the whole point
— if it works now, the substrate is real.

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
