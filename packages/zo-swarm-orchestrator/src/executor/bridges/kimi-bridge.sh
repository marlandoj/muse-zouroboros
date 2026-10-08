#!/usr/bin/env bash
set -euo pipefail

# Shared de-Zo defaults + harness binary resolver.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bridge-env.sh"

if ! KIMI_BIN="$(resolve_harness_bin KIMI_BIN kimi)"; then
  echo "ERROR: kimi not found (checked KIMI_BIN, ~/workspace/.local/bin, ~/.local/bin, PATH)" >&2
  exit 1
fi

# Provider credentials must already be inherited from the caller (CC uses
# cc.env). The later zouroboros.env load supplies shared MCP secrets only;
# it is not the source of Kimi/OpenRouter credentials. Do not source cc.env here.
if [[ -z "${KIMI_MODEL_API_KEY:-}" ]]; then
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    export KIMI_MODEL_API_KEY="$OPENROUTER_API_KEY"
    export KIMI_MODEL_BASE_URL="${KIMI_MODEL_BASE_URL:-https://openrouter.ai/api/v1}"
  elif [[ -n "${KIMI_API_KEY:-}" ]]; then
    export KIMI_MODEL_API_KEY="$KIMI_API_KEY"
  fi
fi
if [[ -n "${SWARM_RESOLVED_MODEL:-}" ]]; then
  # VPS Kimi aliases select registered providers. Never send a local alias as a vendor model id.
  case "$SWARM_RESOLVED_MODEL" in
    kimi-k3|synthetic/kimi-k3) export KIMI_MODEL_NAME="hf:moonshotai/Kimi-K3" ;;
    *) export KIMI_MODEL_NAME="$SWARM_RESOLVED_MODEL" ;;
  esac
else
  export KIMI_MODEL_NAME="${KIMI_MODEL_NAME:-moonshotai/kimi-k3}"
fi
export KIMI_DISABLE_TELEMETRY="${KIMI_DISABLE_TELEMETRY:-1}"

# Load shared secrets (OPENAI_API_KEY, QDRANT_URL, QDRANT_API_KEY, ...) so MCP
# servers spawned by kimi inherit them. File is 0640 root:zouroboros; never printed.
if [ -r /etc/zouroboros/zouroboros.env ]; then
  set -a
  . /etc/zouroboros/zouroboros.env
  set +a
fi

if [[ "${1:-}" == "--acp" ]]; then
  exec "$KIMI_BIN" acp
fi

PROMPT="${1:?Usage: kimi-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-$WORKSPACE_DEFAULT}"
TIMEOUT="${KIMI_TIMEOUT:-600}"

cd "$WORKDIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELECTED_MODEL="${SWARM_RESOLVED_MODEL:-}"
case "$SELECTED_MODEL" in synthetic/kimi-k3) SELECTED_MODEL=kimi-k3 ;; esac
MODEL_ARGS=()
if [[ -n "$SELECTED_MODEL" ]]; then MODEL_ARGS=(--model "$SELECTED_MODEL"); fi
OUTPUT_FILE="$(mktemp)"
trap 'rm -f "$OUTPUT_FILE"' EXIT
if timeout --signal=TERM --kill-after=10s "$TIMEOUT" \
  "$KIMI_BIN" "${MODEL_ARGS[@]}" --prompt "$PROMPT" >"$OUTPUT_FILE"; then
  if [[ -n "$SELECTED_MODEL" ]]; then
    python3 "$SCRIPT_DIR/bridge-receipt.py" kimi "$OUTPUT_FILE" "$SELECTED_MODEL"
  else
    # A default chosen inside the CLI is unknown to this bridge; do not invent metadata.
    cat "$OUTPUT_FILE"
  fi
else
  status=$?
  cat "$OUTPUT_FILE" >&2
  exit "$status"
fi
