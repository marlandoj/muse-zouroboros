#!/usr/bin/env bash
set -euo pipefail

PROMPT="${1:?Usage: pi-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-${HOME}/workspace}"
TIMEOUT="${PI_TIMEOUT:-600}"
MODEL="${SWARM_RESOLVED_MODEL:-${PI_MODEL:-openrouter/moonshotai/kimi-k3}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
MCP_BOOTSTRAP="$SCRIPT_DIR/pi-mcp-bootstrap.ts"

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi not found" >&2
  exit 1
fi

case "$MODEL" in
  byok:*|swarm-*|trivial|simple|moderate|complex|light|mid|heavy|failover)
    source "$SCRIPT_DIR/model-catalog-resolve.sh"
    MODEL="$(catalog_model pi "$MODEL" openrouter/moonshotai/kimi-k3)"
    ;;
esac

cd "$WORKDIR"
export PI_TELEMETRY="${PI_TELEMETRY:-0}"
export PI_SKIP_VERSION_CHECK="${PI_SKIP_VERSION_CHECK:-1}"
# NOTE: a legacy Zo Computer identity export (ZO_CLIENT_IDENTITY_TOKEN) was
# removed here during the de-Zo port. Pi routes through OpenRouter (see
# envVars in registry/executor-registry.json) and needs no platform token.

OUTPUT_FILE="$(mktemp)"
MCP_CONFIG="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE" "$MCP_CONFIG"' EXIT

bun "$MCP_BOOTSTRAP" config "$WORKDIR" "$MCP_CONFIG"
PROMPT="$(printf '%s' "$PROMPT" | bun "$MCP_BOOTSTRAP" prompt)"

MCP_EXTENSION="${PI_MCP_EXTENSION_PATH:-$WORKSPACE_ROOT/node_modules/pi-mcp-adapter/index.ts}"
if [[ ! -f "$MCP_EXTENSION" ]]; then
  MCP_EXTENSION="$WORKSPACE_ROOT/packages/swarm/node_modules/pi-mcp-adapter/index.ts"
fi
if [[ ! -f "$MCP_EXTENSION" ]]; then
  echo "ERROR: pi-mcp-adapter is not installed" >&2
  exit 1
fi

if timeout --signal=TERM --kill-after=10s "$TIMEOUT" \
  pi --mode json --print --no-session --model "$MODEL" \
  --extension "$MCP_EXTENSION" --mcp-config "$MCP_CONFIG" "$PROMPT" \
  >"$OUTPUT_FILE" 2>&1; then
  python3 "$SCRIPT_DIR/bridge-receipt.py" pi "$OUTPUT_FILE" "$MODEL"
else
  status=$?
  cat "$OUTPUT_FILE" >&2
  exit "$status"
fi
