#!/bin/bash
# =============================================================================
# Memory Context Injection Helper for CLI Bridges
# =============================================================================
# Queries the Zo memory gate (Mimir) and injects session briefing + relevant
# context into prompts before passing them to external CLI agents.
#
# Usage:
#   source memory-inject.sh
#   MEMORY_CONTEXT=$(inject_memory "codex" "/opt/zouroboros/repo")
# =============================================================================

inject_memory() {
  local PERSONA="${1:-generic}"
  local WORKDIR="${2:-/opt/zouroboros/repo}"
  
  # Track injection status
  local INJECTION_STATUS="fresh"
  local INJECTION_SOURCE="memory_gate"
  
  # 1. Session briefing from memory gate (Mimir layer)
  local SESSION_CTX=""
  SESSION_CTX=$(curl -fsS --connect-timeout 2 --max-time 3 -X POST http://localhost:7820/gate \
    -H 'Content-Type: application/json' \
    -d "{\"message\":\"session context\",\"persona\":\"$PERSONA\"}" 2>/dev/null) || true
  
  # 2. Fallback: deployed memory CLI, bounded so unavailable memory cannot hang a bridge.
  local MEMORY_CLI="${ZO_MEMORY_CLI_PATH:-/home/zouroboros/Skills/zo-memory-system/scripts/memory.ts}"
  if [ -z "$SESSION_CTX" ] || [ "$SESSION_CTX" = "null" ]; then
    if command -v bun &>/dev/null && [ -f "$MEMORY_CLI" ]; then
      SESSION_CTX=$(ZO_MEMORY_DB="${ZO_MEMORY_DB:-/var/lib/zouroboros/memory/shared-facts.db}" timeout 15 bun "$MEMORY_CLI" search "current session context" --limit 5 2>/dev/null) || SESSION_CTX=""
      INJECTION_SOURCE="memory_cli_fallback"
    else
      echo "MEMORY_WARN: gate unavailable and memory CLI missing: $MEMORY_CLI" >&2
    fi
  fi
  
  # 3. Project context: detect active project from cwd
  local PROJECT_CTX=""
  if [ -f "$WORKDIR/AGENTS.md" ]; then
    PROJECT_CTX=$'\n\n[P PROJECT CONTEXT]
'
    PROJECT_CTX+=$(head -50 "$WORKDIR/AGENTS.md" 2>/dev/null) || true
  fi
  
  # 4. Build enriched system context block
  local ENRICHED_CTX=""
  if [ -n "$SESSION_CTX" ] && [ "$SESSION_CTX" != "null" ]; then
    ENRICHED_CTX="[SESSION BRIEFING - Zo Memory Mimir]
$SESSION_CTX"
    INJECTION_STATUS="injected"
  fi
  
  if [ -n "$PROJECT_CTX" ]; then
    ENRICHED_CTX+="$PROJECT_CTX"
  fi
  
  # 5. Return enriched context with metadata header
  if [ -n "$ENRICHED_CTX" ]; then
    echo "$ENRICHED_CTX"
  fi
}

# Quick status check for the memory gate
check_memory_gate() {
  local RESPONSE
  RESPONSE=$(curl -s -m 2 -X POST http://localhost:7820/gate \
    -H 'Content-Type: application/json' \
    -d '{"message":"health check","persona":"bridge"}' 2>&1)
  
  if [ $? -eq 0 ] && [ -n "$RESPONSE" ]; then
    echo "Memory gate: HEALTHY"
    return 0
  else
    echo "Memory gate: UNAVAILABLE (will use fallback)"
    return 1
  fi
}

# If run directly (not sourced), execute injection
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  PERSONA="${1:-generic}"
  WORKDIR="${2:-/opt/zouroboros/repo}"
  inject_memory "$PERSONA" "$WORKDIR"
fi
