#!/bin/bash
# Pre-Swarm Hook — Warm up local executors before swarm execution
# Place this in your swarm workflow to eliminate cold start penalties
#
# Usage:
#   source pre-swarm-hook.sh          # Warm up all executors (starts gemini daemon)
#   source pre-swarm-hook.sh --quick  # Skip if already warm
#   source pre-swarm-hook.sh gemini   # Warm up only Gemini

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUICK_MODE=false
TARGET_EXECUTOR=""

for arg in "$@"; do
  case "$arg" in
    --quick) QUICK_MODE=true ;;
    gemini|claude-code|hermes) TARGET_EXECUTOR="$arg" ;;
    *) echo "Unknown option: $arg"; echo "Usage: pre-swarm-hook.sh [--quick] [gemini|claude-code|hermes]"; exit 1 ;;
  esac
done

echo "[pre-swarm] Warming up local executors..."

warmup_gemini() {
  if command -v bun &>/dev/null && [ -f "$SCRIPT_DIR/gemini-warmup.ts" ]; then
    if [ "$QUICK_MODE" = true ]; then
      if bun "$SCRIPT_DIR/gemini-warmup.ts" --status &>/dev/null; then
        echo "  Gemini: already warm (daemon running)"
        return 0
      fi
    fi
    echo "  Gemini: starting daemon + warm-up..."
    if bun "$SCRIPT_DIR/gemini-warmup.ts" 2>/dev/null; then
      echo "  Gemini: ready (daemon mode)"
    else
      echo "  Gemini: warm-up failed (will retry on first call)"
    fi
  else
    echo "  Gemini: warm-up script not available"
  fi
}

warmup_claude_code() {
  if command -v claude &>/dev/null; then
    echo "  Claude Code: checking..."
    if timeout 5 claude --version &>/dev/null; then
      echo "  Claude Code: ready"
    else
      echo "  Claude Code: not responding"
    fi
  else
    echo "  Claude Code: not installed"
  fi
}

warmup_hermes() {
  local hermes_dir="${HERMES_PROJECT_DIR:-/home/workspace/hermes-agent}"
  if [ -f "$hermes_dir/cli.py" ]; then
    echo "  Hermes: checking..."
    if [ -f "$hermes_dir/.venv/bin/activate" ]; then
      echo "  Hermes: ready"
    else
      echo "  Hermes: venv not found"
    fi
  else
    echo "  Hermes: not installed"
  fi
}

if [ -n "$TARGET_EXECUTOR" ]; then
  case "$TARGET_EXECUTOR" in
    gemini) warmup_gemini ;;
    claude-code) warmup_claude_code ;;
    hermes) warmup_hermes ;;
  esac
else
  warmup_gemini
  warmup_claude_code
  warmup_hermes
fi

echo "[pre-swarm] Warm-up complete"
