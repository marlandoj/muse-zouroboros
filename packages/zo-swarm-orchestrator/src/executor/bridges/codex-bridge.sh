#!/usr/bin/env bash
# Codex CLI bridge script — invokes Codex CLI in one-shot mode
# Returns only the response text, suitable for scripted/orchestrator invocation
#
# Usage:
#   ./codex-bridge.sh "Your prompt here"
#   ./codex-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   CODEX_MODEL   — override model (e.g., o3)
#   CODEX_TIMEOUT — timeout in seconds (default: 300)

set -euo pipefail

# Shared de-Zo defaults + harness binary resolver.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bridge-env.sh"

PROMPT="${1:?Usage: codex-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-$WORKSPACE_DEFAULT}"

# Pin codex to the operator profile: campaign sessions run with a HOME that
# may have no auth.json; codex honors CODEX_HOME ahead of $HOME/.codex.
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

# Load shared secrets (OPENAI_API_KEY, QDRANT_URL, QDRANT_API_KEY, ...) so MCP
# servers spawned by codex inherit them. File is 0640 root:zouroboros; never printed.
if [ -r /etc/zouroboros/zouroboros.env ]; then
  set -a
  . /etc/zouroboros/zouroboros.env
  set +a
fi


# Load secrets for MCP servers
if [ -f "$HOME/.zo_secrets" ]; then
  source "$HOME/.zo_secrets"
fi

# Priority: SWARM_RESOLVED_MODEL > CODEX_MODEL > CLI default
RAW_MODEL="${SWARM_RESOLVED_MODEL:-${CODEX_MODEL:-}}"
TIER="${SWARM_TIER:-}"

# --- Per-tier timeout resolution ---
if [ -n "${CODEX_TIMEOUT:-}" ]; then
  TIMEOUT="$CODEX_TIMEOUT"
else
  case "${TIER:-}" in
    trivial|swarm-light)          TIMEOUT=120 ;;
    simple|moderate|swarm-mid)    TIMEOUT=300 ;;
    complex|swarm-heavy)          TIMEOUT=600 ;;
    *)                            TIMEOUT=300 ;;
  esac
fi

# Tier aliases are resolved from the qualified catalog and then use the static floor.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/model-catalog-resolve.sh"

case "$RAW_MODEL" in
  swarm-light|light|trivial|simple)    CODEX_MODEL="$(catalog_model codex light gpt-6-luna)" ;;
  swarm-mid|mid|moderate)        CODEX_MODEL="$(catalog_model codex mid gpt-6-sol)" ;;
  swarm-heavy|heavy|complex)    CODEX_MODEL="$(catalog_model codex heavy gpt-6-astra)" ;;
  swarm-failover|failover) CODEX_MODEL="$(catalog_model codex light gpt-6-luna)" ;;
  swarm-*)              CODEX_MODEL="$(catalog_model codex light gpt-6-luna)" ;;
  *)              CODEX_MODEL="$RAW_MODEL" ;;
esac

# Resolve codex binary — explicit CODEX_BIN, then local install paths, then PATH.
# (The npm-installed codex in ~/workspace/.local/bin must win over any stale
# system copy: it is the one with MCP support.)
if ! CODEX_BIN="$(resolve_harness_bin CODEX_BIN codex)"; then
  echo "ERROR: codex binary not found (checked CODEX_BIN, ~/workspace/.local/bin, ~/.local/bin, PATH)" >&2
  exit 1
fi

cd "$WORKDIR"

# --- Spec 2: Capture start time for duration metrics ---
START_TIME=$(date +%s%N)

# Log stderr for debugging; stdout is the response
STDERR_LOG="/tmp/codex-bridge-stderr-$$.log"
OUT_FILE="/tmp/codex-bridge-out-$$.log"

EXTRA_ARGS=""
if [ -n "${CODEX_MODEL:-}" ]; then
  EXTRA_ARGS="--model $CODEX_MODEL"
fi

# Run codex non-interactively
# --dangerously-bypass-approvals-and-sandbox enables execution of shell commands without asking
# --output-last-message ensures we can just read the final response from the file
timeout "$TIMEOUT" "$CODEX_BIN" exec --dangerously-bypass-approvals-and-sandbox --color never $EXTRA_ARGS --output-last-message "$OUT_FILE" "$PROMPT" </dev/null 2>"$STDERR_LOG" >/dev/null
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  if [ -f "$OUT_FILE" ]; then
    cat "$OUT_FILE"
  fi
else
  echo "BRIDGE_ERROR: exit=$EXIT_CODE tier=${TIER:-unknown} timeout=${TIMEOUT}s model=${CODEX_MODEL:-default} stderr=$(head -5 "$STDERR_LOG" 2>/dev/null)" >&2
fi

# --- Structured Result Output (Spec 2) ---
RESULT_FILE="${RESULT_PATH:-result.json}"
RESULT_TMP="${RESULT_FILE}.tmp"
TASK_ID="${SWARM_TASK_ID:-unknown}"
EXECUTOR_ID="codex"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESOLVED_MODEL="${CODEX_MODEL:-default}"

if [ -n "$START_TIME" ]; then
  END_TIME=$(date +%s%N)
  DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))
else
  DURATION_MS=0
fi

STDERR_OUTPUT=$(head -c 2000 "$STDERR_LOG" 2>/dev/null || true)

if [ $EXIT_CODE -eq 0 ]; then
  cat > "$RESULT_TMP" <<RESULT_EOF
{
  "status": "success",
  "output": $(cat "$OUT_FILE" 2>/dev/null | head -c 102400 | jq -Rs .),
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
else
  cat > "$RESULT_TMP" <<RESULT_EOF
{
  "status": "failure",
  "output": "",
  "error": {
    "category": "unknown",
    "message": $(echo "$STDERR_OUTPUT" | jq -Rs .),
    "retryable": true
  },
  "executorId": "$EXECUTOR_ID",
  "taskId": "$TASK_ID",
  "timestamp": "$TIMESTAMP"
}
RESULT_EOF
  mv "$RESULT_TMP" "$RESULT_FILE"
fi

rm -f "$STDERR_LOG" "$OUT_FILE"
exit $EXIT_CODE
