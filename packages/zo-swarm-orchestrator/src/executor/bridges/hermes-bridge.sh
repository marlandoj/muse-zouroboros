#!/usr/bin/env bash
# Hermes bridge script — invokes Hermes CLI in true one-shot mode
# Returns only the final response text and fails if no final response is produced
#
# Usage:
#   ./hermes-bridge.sh "Your prompt here"
#   ./hermes-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   HERMES_PROJECT_DIR — path to hermes-agent project (default: updater-selected checkout, otherwise $HOME/workspace/repos/hermes-agent)
#   HERMES_VENV        — path to venv activate script (default: $HERMES_PROJECT_DIR/.venv/bin/activate)
#   HERMES_BIN         — Hermes launcher (default: resolved from the activated venv)
#   HERMES_TIMEOUT     — timeout in seconds (default: 300)

set -euo pipefail

# Shared de-Zo defaults + harness binary resolver.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bridge-env.sh"

PROMPT="${1:?Usage: hermes-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-$WORKSPACE_DEFAULT}"
# Follow the updater-selected checkout before activating a venv. Explicit
# HERMES_PROJECT_DIR/HERMES_VENV overrides retain their existing behavior.
DEFAULT_PROJECT_DIR="${HERMES_PROJECT_DIR:-$HOME/workspace/repos/hermes-agent}"
SELECTED_HERMES="$(readlink -f "$HOME/.local/bin/hermes" 2>/dev/null || true)"
case "$SELECTED_HERMES" in
  "$HOME"/.local/share/harness-updater/releases/hermes/*/.venv/bin/hermes)
    DEFAULT_PROJECT_DIR="${SELECTED_HERMES%/.venv/bin/hermes}" ;;
esac
PROJECT_DIR="${HERMES_PROJECT_DIR:-$DEFAULT_PROJECT_DIR}"
VENV_ACTIVATE="${HERMES_VENV:-$PROJECT_DIR/.venv/bin/activate}"

# Priority: SWARM_RESOLVED_MODEL > LLM_MODEL
RAW_MODEL="${SWARM_RESOLVED_MODEL:-${LLM_MODEL:-}}"
TIER="${SWARM_TIER:-}"

# --- Per-tier timeout resolution ---
if [ -n "${HERMES_TIMEOUT:-}" ]; then
  TIMEOUT="$HERMES_TIMEOUT"
else
  case "${TIER:-}" in
    trivial|swarm-light)          TIMEOUT=120 ;;
    simple|moderate|swarm-mid)    TIMEOUT=300 ;;
    complex|swarm-heavy)          TIMEOUT=600 ;;
    *)                            TIMEOUT=300 ;;
  esac
fi

export LLM_MODEL="${RAW_MODEL:-}"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "ERROR: Hermes project dir not found: $PROJECT_DIR" >&2
  exit 1
fi

if [ ! -f "$VENV_ACTIVATE" ]; then
  echo "ERROR: Hermes venv not found: $VENV_ACTIVATE" >&2
  exit 1
fi

cd "$PROJECT_DIR"
source "$VENV_ACTIVATE"

# Load shared secrets (OPENAI_API_KEY, QDRANT_URL, QDRANT_API_KEY, ...) so MCP
# servers spawned by hermes inherit them. File is 0640 root:zouroboros; never printed.
# Pin hermes to the operator profile: get_hermes_home() honors HERMES_HOME env
# ahead of the HOME default (hermes_constants.py:71,118). Default to the
# operator's local config where the MCP servers are wired.
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

if [ -r /etc/zouroboros/zouroboros.env ]; then
  set -a
  . /etc/zouroboros/zouroboros.env
  set +a
fi

HERMES_BIN="${HERMES_BIN:-$(command -v hermes || true)}"
if [ -z "$HERMES_BIN" ] || [ ! -x "$HERMES_BIN" ]; then
  echo "ERROR: Hermes launcher not found after activating: $VENV_ACTIVATE" >&2
  exit 1
fi

normalize_provider() {
  case "$1" in
    synthetic-new|custom:synthetic-new) printf '%s' "kimi-coding" ;;
    *) printf '%s' "$1" ;;
  esac
}

PRIMARY_PROVIDER="${SWARM_PROVIDER:-${HERMES_PROVIDER:-}}"
PRIMARY_PROVIDER="$(normalize_provider "$PRIMARY_PROVIDER")"

# --- Spec 2: Capture start time for duration metrics ---
START_TIME=$(date +%s%N)

STDERR_LOG="/tmp/hermes-bridge-stderr-$$.log"
OUTPUT_FILE="/tmp/hermes-bridge-output-$$.txt"

# Build provider fallback chain: primary → SWARM_FALLBACK_PROVIDERS
FALLBACK_PROVIDERS="${SWARM_FALLBACK_PROVIDERS:-}"
PROVIDER_LIST=("$PRIMARY_PROVIDER")
if [ -n "$FALLBACK_PROVIDERS" ]; then
  IFS=',' read -ra FB <<< "$FALLBACK_PROVIDERS"
  for p in "${FB[@]}"; do
    p_trim="$(echo "$p" | xargs)"
    p_trim="$(normalize_provider "$p_trim")"
    if [ -n "$p_trim" ] && [ "$p_trim" != "$PRIMARY_PROVIDER" ]; then
      PROVIDER_LIST+=("$p_trim")
    fi
  done
fi

EXIT_CODE=1
PROVIDER_ARGS=()
for ATTEMPT_PROVIDER in "${PROVIDER_LIST[@]}"; do
  PROVIDER_ARGS=()
  if [ -n "$ATTEMPT_PROVIDER" ]; then
    PROVIDER_ARGS+=(--provider "$ATTEMPT_PROVIDER")
  fi
  if [ -n "${SWARM_RESOLVED_MODEL:-}" ]; then
    # Resolve provider-appropriate model name
    RESOLVED_MODEL="$SWARM_RESOLVED_MODEL"
    case "$ATTEMPT_PROVIDER" in
      xai)                   RESOLVED_MODEL="grok-3" ;;
      kimi-coding)           RESOLVED_MODEL="kimi-k3" ;;
      anthropic|"")
        # Anthropic provider: translate swarm tier labels to real model IDs.
        case "$RESOLVED_MODEL" in
          swarm-light|light|trivial|simple)   RESOLVED_MODEL="claude-haiku-4-5-20251001" ;;
          swarm-mid|mid|moderate)             RESOLVED_MODEL="claude-opus-5" ;;
          swarm-heavy|heavy|complex)          RESOLVED_MODEL="claude-fable-5-1" ;;
          swarm-failover|failover)            RESOLVED_MODEL="claude-haiku-4-5-20251001" ;;
        esac
        # Anthropic models are served ONLY by the anthropic subscription provider
        # (cost policy) -- never let hermes re-route them (e.g. opencode-zen).
        case "$RESOLVED_MODEL" in
          claude-*) [ -n "$ATTEMPT_PROVIDER" ] || PROVIDER_ARGS+=(--provider anthropic) ;;
        esac
        ;;
      deepseek)
        # deepseek-chat/deepseek-reasoner retired 2026-07-24; V4 API only serves
        # deepseek-v4-flash / deepseek-v4-pro. Pick by tier: pro for heavier work.
        case "${TIER:-}" in
          moderate|complex|swarm-mid|swarm-heavy) RESOLVED_MODEL="deepseek-v4-pro" ;;
          *)                                      RESOLVED_MODEL="deepseek-v4-flash" ;;
        esac
        ;;
      openrouter)
        case "${TIER:-}" in
          moderate|complex|swarm-mid|swarm-heavy) RESOLVED_MODEL="deepseek/deepseek-v4-pro" ;;
          *)                                      RESOLVED_MODEL="deepseek/deepseek-v4-flash" ;;
        esac
        ;;
    esac
    PROVIDER_ARGS+=(--model "$RESOLVED_MODEL")
  fi

  :> "$STDERR_LOG"
  :> "$OUTPUT_FILE"
  if timeout "$TIMEOUT" "$HERMES_BIN" "${PROVIDER_ARGS[@]}" -z "$PROMPT" > "$OUTPUT_FILE" 2>"$STDERR_LOG"; then
    EXIT_CODE=0
  else
    EXIT_CODE=$?
  fi

  # Check if output contains a retryable provider error
  COMBINED_ERRORS="$(cat "$STDERR_LOG" 2>/dev/null; cat "$OUTPUT_FILE" 2>/dev/null || true)"
  if echo "$COMBINED_ERRORS" | grep -qiE "(API call failed|Unknown provider|authentication|unauthorized|invalid.*api.key|credit.*exhaust|insufficient.*quota|rate.?limit|Authentication fails|No usable credentials)"; then
    echo "BRIDGE_WARN: Provider ${ATTEMPT_PROVIDER:-configured default} failed, trying next..." >&2
    EXIT_CODE=1
    continue
  fi

  break
done

# Helper: write failure result.json
_write_failure_result() {
  local _EXIT=$1
  local _STDERR_MSG="$2"
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
  cat > "$_RESULT_TMP" <<RESULT_EOF
{
  "status": "failure",
  "output": "",
  "error": {
    "category": "unknown",
    "message": $(echo "$_STDERR_MSG" | head -c 2000 | jq -Rs .),
    "retryable": true
  },
  "metrics": {
    "durationMs": $_DURATION_MS,
    "model": $(echo "${LLM_MODEL:-default}" | jq -Rs .)
  },
  "executorId": "hermes",
  "taskId": "$_TASK_ID",
  "timestamp": "$_TIMESTAMP"
}
RESULT_EOF
  mv "$_RESULT_TMP" "$_RESULT_FILE"
}

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "BRIDGE_ERROR: exit=$EXIT_CODE tier=${TIER:-unknown} timeout=${TIMEOUT}s model=${LLM_MODEL:-default} stderr=$(head -5 "$STDERR_LOG" 2>/dev/null)" >&2
  _write_failure_result "$EXIT_CODE" "$(head -5 "$STDERR_LOG" 2>/dev/null)"
  rm -f "$STDERR_LOG" "$OUTPUT_FILE"
  exit $EXIT_CODE
fi

if [ ! -s "$OUTPUT_FILE" ]; then
  echo "BRIDGE_ERROR: Hermes exited successfully without a final response" >&2
  _write_failure_result 1 "Hermes exited successfully without a final response"
  rm -f "$STDERR_LOG" "$OUTPUT_FILE"
  exit 1
fi

cat "$OUTPUT_FILE"

# --- Structured Result Output (Spec 2) ---
RESULT_FILE="${RESULT_PATH:-result.json}"
RESULT_TMP="${RESULT_FILE}.tmp"
TASK_ID="${SWARM_TASK_ID:-unknown}"
EXECUTOR_ID="hermes"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESOLVED_MODEL="${LLM_MODEL:-default}"

if [ -n "$START_TIME" ]; then
  END_TIME=$(date +%s%N)
  DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))
else
  DURATION_MS=0
fi

STDERR_OUTPUT=$(head -c 2000 "$STDERR_LOG" 2>/dev/null || true)

cat > "$RESULT_TMP" <<RESULT_EOF
{
  "status": "success",
  "output": $(cat "$OUTPUT_FILE" 2>/dev/null | head -c 102400 | jq -Rs .),
  "metrics": {
    "durationMs": $DURATION_MS,
    "model": $(echo "$RESOLVED_MODEL" | jq -Rs .)
  },
  "executorId": "$EXECUTOR_ID",
  "taskId": "$TASK_ID",
  "timestamp": "$TIMESTAMP"
}
RESULT_EOF
mv "$RESULT_TMP" "$RESULT_FILE"

rm -f "$STDERR_LOG" "$OUTPUT_FILE"
exit 0
