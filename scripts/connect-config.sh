#!/usr/bin/env bash
# connect-config.sh — print the exact MCP wiring for one client, with this
# install's real absolute paths filled in. Prints only; writes nothing.
#
# Usage:
#   bash ~/workspace/muse-zouroboros/scripts/connect-config.sh <client>
#   bash ~/workspace/muse-zouroboros/scripts/connect-config.sh --list
#
# Clients: claude-code codex gemini opencode hermes kimi pi
#          claude-desktop cursor vscode
#
# Every config wires BOTH stdio servers:
#   zouroboros-memory  bun <repo>/packages/memory-system/scripts/mcp-server.ts
#   zouroboros-swarm   bun <repo>/packages/swarm-orchestrator/scripts/mcp-server.ts
# and names the concierge playbook <repo>/docs/concierge.md in that client's
# own instructions form. `bun` is written as an absolute path because GUI
# clients (Claude Desktop, Cursor, VS Code) do not see ~/.bun/bin on PATH.
# Paths are absolute because most clients do not expand $HOME or ~ inside
# MCP config. See CONNECT-GUIDE.md for where each block goes.
set -euo pipefail

REPO="${ZO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUN="${ZO_BUN:-$(command -v bun 2>/dev/null || true)}"
[ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; }
[ -n "$BUN" ] || { echo "connect-config: bun not found (looked on PATH and ~/.bun/bin)" >&2; exit 1; }
DB="${ZOUROBOROS_MEMORY_DB:-$HOME/.zo/memory/shared-facts.db}"
REG="$REPO/packages/swarm-executors/registry/executor-registry.json"
MEM_SRV="$REPO/packages/memory-system/scripts/mcp-server.ts"
SWARM_SRV="$REPO/packages/swarm-orchestrator/scripts/mcp-server.ts"
PLAYBOOK="$REPO/docs/concierge.md"

for f in "$MEM_SRV" "$SWARM_SRV" "$PLAYBOOK"; do
  [ -f "$f" ] || { echo "connect-config: missing $f — is $REPO a Zouroboros checkout?" >&2; exit 1; }
done
[ -f "$DB" ] || echo "connect-config: note — $DB does not exist yet; run walkthrough step 03 (bash packages/memory-system/scripts/install.sh) first" >&2

command -v jq >/dev/null 2>&1 || { echo "connect-config: jq is required (the installer preflight checks for it)" >&2; exit 1; }

# q STR -- a double-quoted string safe for TOML and YAML basic strings.
q() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

# The two servers as a JSON mcpServers object (stdio: command/args/env).
mcp_servers_json() {
  jq -n --arg bun "$BUN" --arg mem "$MEM_SRV" --arg swarm "$SWARM_SRV" \
        --arg db "$DB" --arg reg "$REG" --arg ws "$REPO" '{
    "zouroboros-memory": { command: $bun, args: [$mem], env: { ZOUROBOROS_MEMORY_DB: $db } },
    "zouroboros-swarm":  { command: $bun, args: [$swarm],
                           env: { ZOUROBOROS_MEMORY_DB: $db, SWARM_EXECUTOR_REGISTRY: $reg, SWARM_WORKSPACE: $ws } }
  }'
}

client="${1:-}"
case "$client" in
  --list|"")
    echo "clients: claude-code codex gemini opencode hermes kimi pi claude-desktop cursor vscode"
    [ -n "$client" ] || exit 2
    ;;

  claude-code)
    cat <<EOF
# Claude Code — run these two commands (user scope = every project):
claude mcp add-json --scope user zouroboros-memory '$(mcp_servers_json | jq -c '."zouroboros-memory"')'
claude mcp add-json --scope user zouroboros-swarm '$(mcp_servers_json | jq -c '."zouroboros-swarm"')'

# Concierge playbook — add this import line to ~/.claude/CLAUDE.md:
@$PLAYBOOK
EOF
    ;;

  codex)
    cat <<EOF
# Codex CLI — append to ~/.codex/config.toml
[mcp_servers.zouroboros-memory]
command = $(q "$BUN")
args = [$(q "$MEM_SRV")]

[mcp_servers.zouroboros-memory.env]
ZOUROBOROS_MEMORY_DB = $(q "$DB")

[mcp_servers.zouroboros-swarm]
command = $(q "$BUN")
args = [$(q "$SWARM_SRV")]

[mcp_servers.zouroboros-swarm.env]
ZOUROBOROS_MEMORY_DB = $(q "$DB")
SWARM_EXECUTOR_REGISTRY = $(q "$REG")
SWARM_WORKSPACE = $(q "$REPO")

# Concierge playbook — Codex reads ~/.codex/AGENTS.md (no import syntax):
#   no AGENTS.md yet:  ln -s $(q "$PLAYBOOK") ~/.codex/AGENTS.md
#   already have one:  cat $(q "$PLAYBOOK") >> ~/.codex/AGENTS.md
EOF
    ;;

  gemini)
    echo "// Gemini CLI — merge into ~/.gemini/settings.json"
    mcp_servers_json | jq '{ mcpServers: . }'
    cat <<EOF

# Concierge playbook — Gemini CLI reads ~/.gemini/GEMINI.md. Its @import
# refuses files outside ~/.gemini ("Path traversal attempt"), so link or copy:
#   no GEMINI.md yet:  ln -s $(q "$PLAYBOOK") ~/.gemini/GEMINI.md
#   already have one:  cat $(q "$PLAYBOOK") >> ~/.gemini/GEMINI.md
# Gemini also disables every MCP server in an untrusted folder: answer "trust"
# at its folder-trust prompt for the directory you work in.
EOF
    ;;

  opencode)
    echo "// OpenCode — merge into ~/.config/opencode/opencode.json"
    mcp_servers_json | jq --arg pb "$PLAYBOOK" '{
      "$schema": "https://opencode.ai/config.json",
      mcp: (with_entries(.value = { type: "local", command: ([.value.command] + .value.args), environment: .value.env, enabled: true })),
      instructions: [$pb]
    }'
    ;;

  hermes)
    cat <<EOF
# Hermes Agent — merge into ~/.hermes/config.yaml (or <profile>/config.yaml)
mcp_servers:
  zouroboros-memory:
    command: $(q "$BUN")
    args: [$(q "$MEM_SRV")]
    env:
      ZOUROBOROS_MEMORY_DB: $(q "$DB")
  zouroboros-swarm:
    command: $(q "$BUN")
    args: [$(q "$SWARM_SRV")]
    env:
      ZOUROBOROS_MEMORY_DB: $(q "$DB")
      SWARM_EXECUTOR_REGISTRY: $(q "$REG")
      SWARM_WORKSPACE: $(q "$REPO")

# Concierge playbook — Hermes's cross-project instructions form is a skill
# (AGENTS.md is read from the start directory only). Install it as one:
#   mkdir -p ~/.hermes/skills/zouroboros-concierge
#   { printf -- '---\nname: zouroboros-concierge\ndescription: Use when the user asks to set up, install, verify or operate the Zouroboros workshop. Onboarding playbook.\n---\n\n'; cat $(q "$PLAYBOOK"); } > ~/.hermes/skills/zouroboros-concierge/SKILL.md
# (with a profile, use <profile dir>/skills/ instead of ~/.hermes/skills/)
EOF
    ;;

  kimi)
    echo "// Kimi Code — merge into ~/.kimi-code/mcp.json (or \$KIMI_CODE_HOME/mcp.json)"
    mcp_servers_json | jq '{ mcpServers: . }'
    cat <<EOF

# Concierge playbook — Kimi Code reads ~/.kimi-code/AGENTS.md (no import syntax):
#   no AGENTS.md yet:  ln -s $(q "$PLAYBOOK") ~/.kimi-code/AGENTS.md
#   already have one:  cat $(q "$PLAYBOOK") >> ~/.kimi-code/AGENTS.md
EOF
    ;;

  pi)
    echo "// Pi — merge into ~/.pi/agent/mcp.json"
    mcp_servers_json | jq '{ mcpServers: (with_entries(.value += { exposure: "direct" })) }'
    cat <<EOF

# Concierge playbook — Pi reads ~/.pi/agent/AGENTS.md (no import syntax):
#   no AGENTS.md yet:  ln -s $(q "$PLAYBOOK") ~/.pi/agent/AGENTS.md
#   already have one:  cat $(q "$PLAYBOOK") >> ~/.pi/agent/AGENTS.md
EOF
    ;;

  claude-desktop)
    cat <<EOF
// Claude Desktop — merge into claude_desktop_config.json:
//   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
//   Windows: %APPDATA%\\Claude\\claude_desktop_config.json
// then fully quit and reopen Claude Desktop.
EOF
    mcp_servers_json | jq '{ mcpServers: . }'
    echo
    echo "# Concierge playbook — Claude Desktop has no instructions file: paste the"
    echo "# contents of $PLAYBOOK into a Project's instructions."
    ;;

  cursor)
    echo "// Cursor — merge into ~/.cursor/mcp.json (all projects) or <project>/.cursor/mcp.json"
    mcp_servers_json | jq '{ mcpServers: . }'
    cat <<EOF

# Concierge playbook — a Cursor project rule that always applies:
#   mkdir -p <project>/.cursor/rules
#   { printf -- '---\ndescription: Zouroboros concierge playbook\nalwaysApply: true\n---\n\n'; cat $(q "$PLAYBOOK"); } > <project>/.cursor/rules/zouroboros-concierge.mdc
EOF
    ;;

  vscode)
    echo "// VS Code (Copilot agent mode) — 'MCP: Open User Configuration' (user mcp.json) or <project>/.vscode/mcp.json"
    mcp_servers_json | jq '{ servers: (with_entries(.value = ({ type: "stdio" } + .value))) }'
    cat <<EOF

# Concierge playbook — copy it to <project>/.github/copilot-instructions.md:
#   cp $(q "$PLAYBOOK") <project>/.github/copilot-instructions.md
EOF
    ;;

  *)
    echo "connect-config: unknown client '$client'" >&2
    echo "clients: claude-code codex gemini opencode hermes kimi pi claude-desktop cursor vscode" >&2
    exit 2
    ;;
esac
