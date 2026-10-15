#!/usr/bin/env bash
# session-observer-cron.sh — report-only scheduled session observation.
#
# Posture: REPORT-ONLY, human disposes. This script runs the plane-native
# session observer for one actor and prints a human-readable report of what
# was created/refined/faded/skipped. It does NOT auto-apply anything beyond
# writing candidate observations (no promotion, no MCP exposure), and a human
# reviews the report before any of it is treated as authoritative.
#
# Required env:
#   ZOUROBOROS_MEMORY_DB  — the memory DB to observe (fail-closed: never guess)
#   OBSERVE_ACTOR         — actor identity to observe (fail-closed)
# Optional env:
#   ZOUROBOROS_MEMORY_DB_KEY_FILE — file holding the OpenAI key (default
#                                   ~/.config/zo-memory/env); sourced, never logged
#   OBSERVE_SINCE_FILE    — state file holding the last-run timestamp; the
#                           script only observes episodes closed since then
#                           (default: <dbdir>/.session-observer-since)
#   OBSERVE_MAX_SESSIONS, OBSERVE_MAX_COST_USD, ZO_OBSERVATION_MODEL — observer tuning
#
# Suggested cron (nightly, report-only):
#   0 3 * * * ZOUROBOROS_MEMORY_DB=/path/to/memory.db OBSERVE_ACTOR=marlando \
#       /path/to/session-observer-cron.sh >> /var/log/session-observer.log 2>&1
set -euo pipefail

: "${ZOUROBOROS_MEMORY_DB:?ZOUROBOROS_MEMORY_DB must be set (fail-closed)}"
: "${OBSERVE_ACTOR:?OBSERVE_ACTOR must be set (fail-closed)}"

KEY_FILE="${ZOUROBOROS_MEMORY_DB_KEY_FILE:-$HOME/.config/zo-memory/env}"
if [[ -f "$KEY_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$KEY_FILE"   # provides OPENAI_API_KEY; never echoed
fi

DB_DIR="$(dirname "$ZOUROBOROS_MEMORY_DB")"
SINCE_FILE="${OBSERVE_SINCE_FILE:-$DB_DIR/.session-observer-since}"
SINCE=0
if [[ -f "$SINCE_FILE" ]]; then
  SINCE="$(cat "$SINCE_FILE")"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# hooks/ lives under packages/zo-memory-system/scripts/ in the vendored layout
OBSERVER="$SCRIPT_DIR/../session-observer.ts"

echo "=== session-observer cron run $(date -u +%FT%TZ) actor=${OBSERVE_ACTOR} since=${SINCE} ==="

# 1. Fade observations whose evidence is entirely forgotten (accountable forgetting)
bun "$OBSERVER" fade --actor "$OBSERVE_ACTOR"

# 2. Observe new/changed sessions (report-only: prints the report, human disposes)
bun "$OBSERVER" run \
  --actor "$OBSERVE_ACTOR" \
  --since "$SINCE"

# 3. Advance the watermark only on success
date +%s > "$SINCE_FILE"
echo "=== end run; watermark advanced to $(cat "$SINCE_FILE") ==="
