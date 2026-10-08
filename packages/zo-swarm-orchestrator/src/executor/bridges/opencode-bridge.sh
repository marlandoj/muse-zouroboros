#!/usr/bin/env bash
set -euo pipefail

# Shared de-Zo defaults + harness binary resolver.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/bridge-env.sh"

if ! OPENCODE_BIN="$(resolve_harness_bin OPENCODE_BIN opencode)"; then
  echo "ERROR: opencode not found (checked OPENCODE_BIN, ~/workspace/.local/bin, ~/.local/bin, PATH)" >&2
  exit 1
fi

# Credentials come from the environment (e.g. OPENAI_API_KEY / GEMINI_API_KEY
# inherited from the CC service env) or opencode's own auth store.
export OPENCODE_DISABLE_TELEMETRY="${OPENCODE_DISABLE_TELEMETRY:-1}"

if [[ "${1:-}" == "--acp" ]]; then
  exec "$OPENCODE_BIN" acp
fi

PROMPT="${1:?Usage: opencode-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-$WORKSPACE_DEFAULT}"
TIMEOUT="${OPENCODE_TIMEOUT:-600}"

cd "$WORKDIR"
MODEL_ARGS=()
if [[ -n "${SWARM_RESOLVED_MODEL:-}" ]]; then MODEL_ARGS=(-m "$SWARM_RESOLVED_MODEL"); fi
timeout --signal=TERM --kill-after=10s "$TIMEOUT" \
  "$OPENCODE_BIN" run "${MODEL_ARGS[@]}" "$PROMPT"
