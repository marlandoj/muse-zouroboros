#!/usr/bin/env bash
set -euo pipefail

if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: opencode not found" >&2
  exit 1
fi

# Credentials come from the environment (e.g. OPENAI_API_KEY / GEMINI_API_KEY
# inherited from the CC service env) or opencode's own auth store.
export OPENCODE_DISABLE_TELEMETRY="${OPENCODE_DISABLE_TELEMETRY:-1}"

if [[ "${1:-}" == "--acp" ]]; then
  exec opencode acp
fi

PROMPT="${1:?Usage: opencode-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/opt/zouroboros/repo}"
TIMEOUT="${OPENCODE_TIMEOUT:-600}"

cd "$WORKDIR"
MODEL_ARGS=()
if [[ -n "${SWARM_RESOLVED_MODEL:-}" ]]; then MODEL_ARGS=(-m "$SWARM_RESOLVED_MODEL"); fi
timeout --signal=TERM --kill-after=10s "$TIMEOUT" \
  opencode run "${MODEL_ARGS[@]}" "$PROMPT"
