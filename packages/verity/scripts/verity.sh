#!/usr/bin/env bash
# Verity control: switch between shadow and live, scope by harness and check, and report.
#
# Usage:
#   verity.sh status
#   verity.sh mode shadow|live [--harness claude|codex|kimi|gemini] [--checks all|done,deny,ask,rewrite,note,warn]
#   verity.sh reset [--harness NAME]      drop a per-harness override (or everything) back to shadow
#   verity.sh report
#
# Checks: done = refuse a finish with no passing check, deny = block a tool call (secrets, test
# deletion), ask = ask before a tool call, rewrite = add pipefail to piped test commands,
# note = add context for the agent, warn = show a warning.
# Precedence: VERITY_MODE / VERITY_CHECKS env > per-harness config > global config > shadow
# (resolved by engine/cli.js mode, the same resolver the hook uses).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERITY_HOME="${VERITY_HOME:-$HOME/.verity}"
CFG="$VERITY_HOME/config.json"
KINDS="all done deny ask rewrite note warn"

usage() { sed -n 2,14p "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
load() { [ -f "$CFG" ] && cat "$CFG" || echo '{"mode":"shadow","checks":["all"]}'; }
save() { mkdir -p -m 700 "$VERITY_HOME"; local t; t="$(mktemp "$VERITY_HOME/.cfg.XXXX")"; cat > "$t"; mv "$t" "$CFG"; }

# The configured posture per harness comes from the same resolver the hook uses (engine/cli.js mode).
posture() { VERITY_HOME="$VERITY_HOME" node "$DIR/../engine/cli.js" mode --harness "$1"; }

status() {
  local h r
  for h in claude codex kimi gemini; do
    r="$(posture "$h")"
    if [ "$h" = claude ]; then
      jq -r '"global: \(.global.mode) (checks: \(.global.checks | join(",")))",
        (select(.config.state == "invalid" or .config.state == "unreadable" or .config.state == "empty")
          | "config: \(.config.path) is \(.config.state); the hook reads it as shadow (checks: all)")' <<<"$r"
    fi
    jq -r '"  \(.harness): \(.configured.mode) (checks: \(.configured.checks | join(",")))" +
      (if .override then "  [override]" else "" end)' <<<"$r"
  done
  [ -n "${VERITY_MODE:-}" ] && echo "env VERITY_MODE=$VERITY_MODE overrides the config in this shell"
  [ -n "${VERITY_CHECKS:-}" ] && echo "env VERITY_CHECKS=$VERITY_CHECKS overrides the config in this shell"
  [ "${VERITY_DISABLE:-0}" = 1 ] && echo "env VERITY_DISABLE=1: Verity is off in this shell"
  return 0
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  status) status ;;
  report) exec bash "$DIR/report.sh" ;;
  mode)
    m="${1:-}"; shift || true
    [ "$m" = shadow ] || [ "$m" = live ] || usage 2
    harness=""; checks=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --harness) harness="$2"; shift 2 ;;
        --checks) checks="$2"; shift 2 ;;
        *) usage 2 ;;
      esac
    done
    case "$harness" in ""|claude|codex|kimi|gemini) ;; *) echo "unknown harness: $harness" >&2; exit 2 ;; esac
    if [ -n "$checks" ]; then
      IFS=, read -ra list <<< "$checks"
      for k in "${list[@]}"; do [[ " $KINDS " == *" $k "* ]] || { echo "unknown check: $k (one of: $KINDS)" >&2; exit 2; }; done
    fi
    load | jq --arg m "$m" --arg h "$harness" --arg c "$checks" '
      ($c | if . == "" then null else split(",") end) as $cl |
      if $h == "" then .mode = $m | (if $cl then .checks = $cl else . end)
      else .harness[$h].mode = $m | (if $cl then .harness[$h].checks = $cl else . end) end' | save
    if [ "$m" = live ]; then
      echo "LIVE: verdicts are now applied${harness:+ for $harness}. Kimi and Gemini hooks are user-global."
      echo "Back to shadow at any time: bash $0 mode shadow${harness:+ --harness $harness}"
    fi
    status ;;
  reset)
    if [ "${1:-}" = --harness ] && [ -n "${2:-}" ]; then
      load | jq --arg h "$2" 'del(.harness[$h])' | save
    else
      echo '{"mode":"shadow","checks":["all"]}' | save
    fi
    status ;;
  -h|--help|help) usage ;;
  *) usage 2 ;;
esac
