#!/usr/bin/env bash
# Gemini CLI bridge script — invokes Gemini CLI in one-shot (headless) mode
# If the gemini-daemon is running, routes through it for ~10x faster startup.
# Falls back to direct CLI invocation otherwise.
#
# Usage:
#   ./gemini-bridge.sh "Your prompt here"
#   ./gemini-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   GEMINI_MODEL       — override model (concrete Gemini model; tier labels warn and use the default)
#   GEMINI_TIMEOUT     — timeout in seconds (default: 300)
#   GEMINI_NO_DAEMON   — set to '1' to skip daemon and use direct CLI

set -euo pipefail

# Headless spawns are non-interactive: trust the workspace so the CLI
# does not refuse to run without an interactive trust prompt.
export GEMINI_CLI_TRUST_WORKSPACE="${GEMINI_CLI_TRUST_WORKSPACE:-true}"

PROMPT="${1:?Usage: gemini-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-${HOME}/workspace}"
DEFAULT_MODEL="gemini-3.8-flash"

# Priority: SWARM_RESOLVED_MODEL > GEMINI_MODEL > default
_SWARM_MODEL="${SWARM_RESOLVED_MODEL:-}"
_GEMINI_MODEL="${GEMINI_MODEL:-}"
TIER="${SWARM_TIER:-}"

# --- Per-tier timeout resolution ---
if [ -n "${GEMINI_TIMEOUT:-}" ]; then
  TIMEOUT="$GEMINI_TIMEOUT"
else
  case "${TIER:-}" in
    trivial|swarm-light)          TIMEOUT=120 ;;
    simple|moderate|swarm-mid)    TIMEOUT=300 ;;
    complex|swarm-heavy)          TIMEOUT=600 ;;
    *)                            TIMEOUT=300 ;;
  esac
fi

# Resolve model: accept only Gemini-native names (gemini-* or gc/*).
# Tier aliases are resolved from the qualified catalog and then use the static floor.

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/model-catalog-resolve.sh"

case "$_SWARM_MODEL" in
  swarm-light|light|trivial|simple)    MODEL="$(catalog_model gemini light gemini-3.8-flash)" ;;
  swarm-mid|mid|moderate)        MODEL="$(catalog_model gemini mid gemini-3.1-pro-preview)" ;;
  swarm-heavy|heavy|complex)    MODEL="$(catalog_model gemini heavy gemini-3.1-pro-preview)" ;;
  swarm-failover|failover) MODEL="$(catalog_model gemini light gemini-3.8-flash)" ;;
  swarm-*)              MODEL="$(catalog_model gemini light gemini-3.8-flash)" ;;
  gemini*|gc/*|models/*) MODEL="${_SWARM_MODEL#gc/}" ;;
  "")
    case "$_GEMINI_MODEL" in
      swarm-light|light|trivial|simple)    MODEL="$(catalog_model gemini light gemini-3.8-flash)" ;;
      swarm-mid|mid|moderate)        MODEL="$(catalog_model gemini mid gemini-3.1-pro-preview)" ;;
      swarm-heavy|heavy|complex)    MODEL="$(catalog_model gemini heavy gemini-3.1-pro-preview)" ;;
      swarm-failover|failover|swarm-*) MODEL="$(catalog_model gemini light gemini-3.8-flash)" ;;
      gemini*|gc/*|models/*) MODEL="${_GEMINI_MODEL#gc/}" ;;
      "")             MODEL="$DEFAULT_MODEL" ;;
      *)
        echo "BRIDGE_WARN: ignoring non-Gemini model '$_GEMINI_MODEL', using default '$DEFAULT_MODEL'" >&2
        MODEL="$DEFAULT_MODEL"
        ;;
    esac
    ;;
  *)
    echo "BRIDGE_WARN: ignoring non-Gemini model '$_SWARM_MODEL', using default '$DEFAULT_MODEL'" >&2
    MODEL="$DEFAULT_MODEL"
    ;;
esac

# --- Spec 2: Capture start time for duration metrics ---
START_TIME=$(date +%s%N)

# --- Spec 2: Helper to write result.json ---
_write_result() {
  local _STATUS="$1"
  local _OUTPUT="$2"
  local _ERROR_MSG="${3:-}"
  local _RESULT_FILE="${RESULT_PATH:-result.json}"
  local _RESULT_TMP="${_RESULT_FILE}.tmp"
  local _TASK_ID="${SWARM_TASK_ID:-unknown}"
  local _TIMESTAMP
  _TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local _DURATION_MS=0
  if [ -n "${START_TIME:-}" ]; then
    local _END_TIME
    _END_TIME=$(date +%s%N)
    _DURATION_MS=$(( (_END_TIME - START_TIME) / 1000000 ))
  fi

  if [ "$_STATUS" = "success" ]; then
    cat > "$_RESULT_TMP" <<RESULT_EOF
{
  "status": "success",
  "output": $(echo "$_OUTPUT" | head -c 102400 | jq -Rs .),
  "metrics": {
    "durationMs": $_DURATION_MS,
    "model": $(echo "$MODEL" | jq -Rs .)
  },
  "executorId": "gemini",
  "taskId": "$_TASK_ID",
  "timestamp": "$_TIMESTAMP"
}
RESULT_EOF
  else
    cat > "$_RESULT_TMP" <<RESULT_EOF
{
  "status": "failure",
  "output": "",
  "error": {
    "category": "unknown",
    "message": $(echo "$_ERROR_MSG" | head -c 2000 | jq -Rs .),
    "retryable": true
  },
  "metrics": {
    "durationMs": $_DURATION_MS,
    "model": $(echo "$MODEL" | jq -Rs .)
  },
  "executorId": "gemini",
  "taskId": "$_TASK_ID",
  "timestamp": "$_TIMESTAMP"
}
RESULT_EOF
  fi
  mv "$_RESULT_TMP" "$_RESULT_FILE"
}

DAEMON_SOCKET="/tmp/gemini-daemon.sock"

# --- Daemon path: ~1-2s per call instead of ~12s ---
if [ "${GEMINI_NO_DAEMON:-}" != "1" ] && [ -S "$DAEMON_SOCKET" ]; then
  RESPONSE=$(curl -s --unix-socket "$DAEMON_SOCKET" \
    -X POST http://localhost/prompt \
    -H 'Content-Type: application/json' \
    --max-time "$TIMEOUT" \
    -d "$(jq -n --arg p "$PROMPT" --arg m "$MODEL" --arg w "$WORKDIR" \
         '{prompt: $p, model: $m, workdir: $w}')" 2>/dev/null) || true

  if [ -n "$RESPONSE" ]; then
    ERROR=$(echo "$RESPONSE" | jq -r '.error // empty' 2>/dev/null)
    if [ -z "$ERROR" ]; then
      DAEMON_OUTPUT=$(echo "$RESPONSE" | jq -r '.output // empty' 2>/dev/null)
      echo "$DAEMON_OUTPUT"
      _write_result "success" "$DAEMON_OUTPUT"
      exit 0
    fi
    echo "BRIDGE_WARN: daemon returned error: $ERROR, falling back to direct CLI" >&2
  fi
fi

# --- Direct CLI fallback ---
GEMINI_BIN=""
if command -v gemini &>/dev/null; then
  GEMINI_BIN="gemini"
elif [ -x "/usr/bin/gemini" ]; then
  GEMINI_BIN="/usr/bin/gemini"
elif [ -x "/usr/local/bin/gemini" ]; then
  GEMINI_BIN="/usr/local/bin/gemini"
elif [ -x "$HOME/.local/bin/gemini" ]; then
  GEMINI_BIN="$HOME/.local/bin/gemini"
else
  echo "ERROR: gemini binary not found. Install with: npm install -g @google/gemini-cli" >&2
  exit 1
fi

cd "$WORKDIR"
STDERR_LOG="/tmp/gemini-bridge-stderr-$$.log"

CLI_OUTPUT_FILE="/tmp/gemini-bridge-output-$$.txt"
EXIT_CODE=0
timeout "$TIMEOUT" "$GEMINI_BIN" -p "$PROMPT" -m "$MODEL" --yolo --output-format text --sandbox=false 2>"$STDERR_LOG" > "$CLI_OUTPUT_FILE" || EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "BRIDGE_ERROR: direct CLI failed (exit=$EXIT_CODE)" >&2
  CLI_STDERR=$(cat "$STDERR_LOG" 2>/dev/null | head -5)
  echo "BRIDGE_ERROR: CLI stderr: $CLI_STDERR" >&2
  rm -f "$STDERR_LOG"
  _write_result "failure" "" "direct CLI failed (exit=$EXIT_CODE): $CLI_STDERR"
  rm -f "$CLI_OUTPUT_FILE"
  exit $EXIT_CODE
fi

# Direct CLI succeeded
cat "$CLI_OUTPUT_FILE"
_write_result "success" "$(cat "$CLI_OUTPUT_FILE" 2>/dev/null)"
rm -f "$STDERR_LOG" "$CLI_OUTPUT_FILE"
exit 0
