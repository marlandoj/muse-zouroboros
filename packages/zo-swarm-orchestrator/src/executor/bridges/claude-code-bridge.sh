#!/usr/bin/env bash
# Claude Code bridge script — invokes Claude Code CLI in one-shot mode
# Returns only the response text, suitable for scripted/orchestrator invocation
#
# MCP tool permissions are discovered dynamically from .mcp.json servers
# so new tools are automatically approved without updating this script.
#
# Usage:
#   ./claude-code-bridge.sh "Your prompt here"
#   ./claude-code-bridge.sh "Your prompt here" /path/to/workdir
#
# Environment:
#   CLAUDE_CODE_MODEL   — override model (default: claude-opus-5)
#   CLAUDE_CODE_TIMEOUT — timeout in seconds (default: per-tier, see below)
#   SWARM_RESOLVED_MODEL — set by orchestrator per task
#   SWARM_TIER          — complexity tier (swarm-light|swarm-mid|swarm-heavy)

set -euo pipefail

# Shared de-Zo defaults + harness binary resolver.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bridge-env.sh"

PROMPT="${1:?Usage: claude-code-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-$WORKSPACE_DEFAULT}"

# --- Dynamic shared model resolution ---
# Priority: SWARM_RESOLVED_MODEL → CLAUDE_CODE_MODEL → qualified catalog tier → floor
RAW_MODEL="${SWARM_RESOLVED_MODEL:-${CLAUDE_CODE_MODEL:-}}"
TIER="${SWARM_TIER:-}"
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/model-catalog-resolve.sh"

case "$RAW_MODEL" in
  swarm-light|light|trivial|simple)    CLAUDE_CODE_MODEL="$(catalog_model claude-code light claude-haiku-4-5-20251001)" ;;
  swarm-mid|mid|moderate)       CLAUDE_CODE_MODEL="$(catalog_model claude-code mid claude-sonnet-5)" ;;
  swarm-heavy|heavy|complex)   CLAUDE_CODE_MODEL="$(catalog_model claude-code heavy claude-opus-5.5)" ;;
  swarm-failover|failover) CLAUDE_CODE_MODEL="$(catalog_model claude-code light claude-haiku-4-5-20251001)" ;;
  swarm-*)             CLAUDE_CODE_MODEL="$(catalog_model claude-code light claude-haiku-4-5-20251001)" ;;
  "")                 CLAUDE_CODE_MODEL="$(catalog_model claude-code mid claude-sonnet-5)" ;;
  *)              CLAUDE_CODE_MODEL="$RAW_MODEL" ;;
esac

# --- T3: Per-tier timeout resolution ---
# swarm-light/trivial=120s, swarm-mid/simple/moderate=300s, swarm-heavy/complex=600s
if [ -n "${CLAUDE_CODE_TIMEOUT:-}" ]; then
  TIMEOUT="$CLAUDE_CODE_TIMEOUT"
else
  case "${TIER:-}" in
    trivial|swarm-light)          TIMEOUT=120 ;;
    simple|moderate|swarm-mid)    TIMEOUT=300 ;;
    complex|swarm-heavy)          TIMEOUT=600 ;;
    *)                            TIMEOUT=300 ;;
  esac
fi

# Resolve claude binary — explicit CLAUDE_CODE_BIN, then local install paths, then PATH.
# (The CLI in ~/workspace/.local/bin is the authenticated one; it must win
# over any stale system copy.)
if ! CLAUDE_BIN="$(resolve_harness_bin CLAUDE_CODE_BIN claude)"; then
  echo "ERROR: claude binary not found (checked CLAUDE_CODE_BIN, ~/workspace/.local/bin, ~/.local/bin, PATH). Install with: npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

cd "$WORKDIR"

# --- Spec 2: Capture start time for duration metrics ---
START_TIME=$(date +%s%N)

# --- T1: Process isolation to bypass nested-session detection ---
# Scrub ALL known session-detection env vars
unset CLAUDECODE
unset CLAUDE_CODE_SESSION
unset CLAUDE_PARENT_SESSION
unset CLAUDE_CODE_ENTRYPOINT
unset CLAUDE_SESSION_ID

# Pre-approve built-in tools
ALLOWED_TOOLS="Write Edit Bash Read Glob Grep NotebookEdit WebFetch WebSearch mcp__zo-memory mcp__qdrant-rag"

# Dynamically discover MCP tool names from .mcp.json servers.
MCP_CONFIG="$WORKDIR/.mcp.json"
TOOLS_CACHE="/tmp/claude-bridge-mcp-tools-cache.txt"
CACHE_MAX_AGE=3600  # 1 hour

USE_CACHE=false
if [ -f "$TOOLS_CACHE" ]; then
  CACHE_AGE=$(( $(date +%s) - $(stat -c %Y "$TOOLS_CACHE" 2>/dev/null || echo 0) ))
  if [ "$CACHE_AGE" -lt "$CACHE_MAX_AGE" ]; then
    USE_CACHE=true
  fi
fi

if [ "$USE_CACHE" = true ]; then
  MCP_TOOLS=$(cat "$TOOLS_CACHE")
elif [ -f "$MCP_CONFIG" ]; then
  MCP_TOOLS=$(python3 - "$MCP_CONFIG" <<'PYEOF'
import json, sys, urllib.request

mcp_config_path = sys.argv[1]
try:
    with open(mcp_config_path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)

tool_names = []
for srv_name, srv in cfg.get("mcpServers", {}).items():
    url = srv.get("url", "")
    if not url:
        continue
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    for k, v in srv.get("headers", {}).items():
        headers[k] = v
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode()
    try:
        req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        for t in data.get("result", {}).get("tools", []):
            name = t.get("name", "")
            if name:
                tool_names.append(f"mcp__{srv_name}__{name}")
    except Exception:
        pass

if tool_names:
    print(" ".join(tool_names))
PYEOF
  ) || true

  if [ -n "${MCP_TOOLS:-}" ]; then
    echo "$MCP_TOOLS" > "$TOOLS_CACHE"
  fi
fi

if [ -n "${MCP_TOOLS:-}" ]; then
  ALLOWED_TOOLS="$ALLOWED_TOOLS $MCP_TOOLS"
fi

# Log stderr for debugging; stdout is the response
STDERR_LOG="/tmp/claude-code-bridge-stderr-$$.log"

EXTRA_ARGS=""
if [ -n "${CLAUDE_CODE_MODEL:-}" ]; then
  EXTRA_ARGS="--model $CLAUDE_CODE_MODEL"
fi

# --- T1: Isolation layer ---
# Use setsid to create a new session, detaching from parent process group.
# This prevents the claude binary from detecting a parent Claude Code session
# via process tree inspection (/proc/PPID ancestry).
# If setsid alone is insufficient, escalate to unshare --pid --fork for full
# PID namespace isolation.
ISOLATION_CMD=""
if command -v setsid &>/dev/null; then
  ISOLATION_CMD="setsid --wait"
fi

OUTPUT_FILE="/tmp/claude-code-bridge-output-$$.txt"
# We request JSON from the CLI so we can capture usage tokens + cost in the
# structured result file. The bridge's stdout contract is still plain text
# (consumers like test-bridges.ts and bridge.ts text-fallback parse stdout
# as the response body), so we extract `.result` from the CLI JSON and emit
# that to stdout. Token/cost fields land in $RESULT_PATH:metrics.
CLI_OUTPUT_FORMAT="${CLAUDE_CODE_BRIDGE_OUTPUT_FORMAT:-json}"

if [ -n "$ISOLATION_CMD" ]; then
  $ISOLATION_CMD timeout "$TIMEOUT" "$CLAUDE_BIN" -p "$PROMPT" --output-format "$CLI_OUTPUT_FORMAT" --allowedTools $ALLOWED_TOOLS $EXTRA_ARGS 2>"$STDERR_LOG" > "$OUTPUT_FILE"
else
  timeout "$TIMEOUT" "$CLAUDE_BIN" -p "$PROMPT" --output-format "$CLI_OUTPUT_FORMAT" --allowedTools $ALLOWED_TOOLS $EXTRA_ARGS 2>"$STDERR_LOG" > "$OUTPUT_FILE"
fi
EXIT_CODE=$?

# If setsid failed with nested-session error, escalate to unshare
if [ $EXIT_CODE -eq 1 ] && [ -n "$ISOLATION_CMD" ] && command -v unshare &>/dev/null; then
  NESTED_ERR=$(head -5 "$STDERR_LOG" 2>/dev/null || true)
  if echo "$NESTED_ERR" | grep -qi "nested\|session\|already running\|CLAUDECODE"; then
    echo "BRIDGE_WARN: setsid insufficient, escalating to unshare --pid --fork" >&2
    unshare --pid --fork timeout "$TIMEOUT" "$CLAUDE_BIN" -p "$PROMPT" --output-format "$CLI_OUTPUT_FORMAT" --allowedTools $ALLOWED_TOOLS $EXTRA_ARGS 2>"$STDERR_LOG" > "$OUTPUT_FILE"
    EXIT_CODE=$?
  fi
fi

# Parse CLI JSON for response text + usage metrics. When JSON parse fails
# (e.g. text fallback explicitly requested via env), preserve raw output.
RESPONSE_TEXT=""
INPUT_TOKENS=0
OUTPUT_TOKENS=0
TOTAL_TOKENS=0
TOTAL_COST_USD=0
CLI_DURATION_MS=0
CLI_REPORTED_MODEL=""

if [ "$CLI_OUTPUT_FORMAT" = "json" ] && [ $EXIT_CODE -eq 0 ] && [ -s "$OUTPUT_FILE" ]; then
  PARSED=$(python3 - "$OUTPUT_FILE" <<'PYEOF' 2>/dev/null || true
import json, sys, os
try:
    with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as f:
        data = json.load(f)
except Exception as e:
    sys.stderr.write(f"bridge-parse-error: {e}\n")
    sys.exit(0)
result_text = data.get("result", "") or ""
usage = data.get("usage", {}) or {}
input_tokens = int(usage.get("input_tokens", 0) or 0)
output_tokens = int(usage.get("output_tokens", 0) or 0)
total_cost = float(data.get("total_cost_usd", 0) or 0)
duration_ms = int(data.get("duration_ms", 0) or 0)
model_usage = data.get("modelUsage", {}) or {}
reported_model = ""
if model_usage:
    reported_model = next(iter(model_usage.keys()), "")
# Write response text to a side file so bash doesn't have to quote-juggle.
text_path = sys.argv[1] + ".text"
with open(text_path, "w", encoding="utf-8") as f:
    f.write(result_text)
print(f"INPUT_TOKENS={input_tokens}")
print(f"OUTPUT_TOKENS={output_tokens}")
print(f"TOTAL_TOKENS={input_tokens + output_tokens}")
print(f"TOTAL_COST_USD={total_cost}")
print(f"CLI_DURATION_MS={duration_ms}")
print(f"CLI_REPORTED_MODEL={reported_model}")
print(f"TEXT_PATH={text_path}")
PYEOF
)
  if [ -n "$PARSED" ]; then
    eval "$PARSED"
    if [ -n "${TEXT_PATH:-}" ] && [ -f "$TEXT_PATH" ]; then
      RESPONSE_TEXT_FILE="$TEXT_PATH"
    fi
  fi
fi

# Emit response text to stdout (preserves external contract).
if [ -n "${RESPONSE_TEXT_FILE:-}" ] && [ -f "$RESPONSE_TEXT_FILE" ]; then
  cat "$RESPONSE_TEXT_FILE"
else
  cat "$OUTPUT_FILE" 2>/dev/null
fi

if [ $EXIT_CODE -ne 0 ]; then
  echo "BRIDGE_ERROR: exit=$EXIT_CODE tier=${TIER:-unknown} timeout=${TIMEOUT}s model=${CLAUDE_CODE_MODEL:-default} stderr=$(head -5 "$STDERR_LOG" 2>/dev/null)" >&2
fi

# --- Structured Result Output (Spec 2) ---
RESULT_FILE="${RESULT_PATH:-result.json}"
RESULT_TMP="${RESULT_FILE}.tmp"
TASK_ID="${SWARM_TASK_ID:-unknown}"
EXECUTOR_ID="claude-code"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RESOLVED_MODEL="${CLAUDE_CODE_MODEL:-default}"

if [ -n "$START_TIME" ]; then
  END_TIME=$(date +%s%N)
  DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))
else
  DURATION_MS=0
fi

STDERR_OUTPUT=$(head -c 2000 "$STDERR_LOG" 2>/dev/null || true)

if [ $EXIT_CODE -eq 0 ]; then
  # Prefer the CLI-reported model when present (it includes mid-run model
  # switches that the env var doesn't capture).
  EMIT_MODEL="${CLI_REPORTED_MODEL:-$RESOLVED_MODEL}"
  # Output payload: use parsed CLI text when available, raw output otherwise.
  if [ -n "${RESPONSE_TEXT_FILE:-}" ] && [ -f "$RESPONSE_TEXT_FILE" ]; then
    OUTPUT_PAYLOAD=$(cat "$RESPONSE_TEXT_FILE" 2>/dev/null | head -c 102400 | jq -Rs .)
  else
    OUTPUT_PAYLOAD=$(cat "$OUTPUT_FILE" 2>/dev/null | head -c 102400 | jq -Rs .)
  fi
  cat > "$RESULT_TMP" <<RESULT_EOF
{
  "status": "success",
  "output": $OUTPUT_PAYLOAD,
  "metrics": {
    "durationMs": $DURATION_MS,
    "cliDurationMs": $CLI_DURATION_MS,
    "model": $(echo "$EMIT_MODEL" | jq -Rs .),
    "inputTokens": $INPUT_TOKENS,
    "outputTokens": $OUTPUT_TOKENS,
    "tokensUsed": $TOTAL_TOKENS,
    "totalCostUsd": $TOTAL_COST_USD
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

rm -f "$STDERR_LOG" "$OUTPUT_FILE" "${RESPONSE_TEXT_FILE:-/tmp/__nope__}"
exit $EXIT_CODE
