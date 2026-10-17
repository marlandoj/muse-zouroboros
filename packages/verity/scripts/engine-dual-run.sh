#!/usr/bin/env bash
# engine-dual-run.sh — shadow-compare the old (Canny) and new (Verity) engines
# over the same event stream, diffing verdicts per event.
#
# Usage: engine-dual-run.sh [--events FILE] [--agent AGENT]
#          [--old-home DIR] [--new-home DIR] [--old-cli PATH] [--new-cli PATH]
#
# Input lines are capture records '{"agent":..., "event":{...}}' as written by
# VERITY_EVENT_CAPTURE, or bare event objects (then --agent applies, default
# claude). Each event is fed to both engines in order, from empty homes unless
# --old-home/--new-home point at existing ones.
#
# Homes are kept separate on purpose: the new engine gets an explicit
# VERITY_ENGINE_HOME so its CANNY_HOME fallback can never collide with the
# old engine's home.
#
# Exit 0 iff every verdict matches; otherwise each divergence is printed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVENTS=""
AGENT="claude"
OLD_HOME=""; NEW_HOME=""
OLD_CLI="${CANNY_DIR:-/home/workspace/Integrations/canny}/dist/cli.js"
NEW_CLI="$ROOT/engine/cli.js"
while [ $# -gt 0 ]; do
  case "$1" in
    --events) EVENTS="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --old-home) OLD_HOME="$2"; shift 2 ;;
    --new-home) NEW_HOME="$2"; shift 2 ;;
    --old-cli) OLD_CLI="$2"; shift 2 ;;
    --new-cli) NEW_CLI="$2"; shift 2 ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
[ -n "$OLD_HOME" ] || OLD_HOME="$T/old"
[ -n "$NEW_HOME" ] || NEW_HOME="$T/new"
mkdir -p "$OLD_HOME" "$NEW_HOME"

run_old() { # stdin: event JSON; $1: agent
  env -u TYPESAFE_API_KEY CANNY_JEV_URL=http://127.0.0.1:9/disabled \
    CANNY_HOME="$OLD_HOME" timeout 10 node "$OLD_CLI" hook --agent "$1" 2>/dev/null
}
run_new() { # stdin: event JSON; $1: agent
  env -u TYPESAFE_API_KEY -u CANNY_HOME VERITY_ENGINE_HOME="$NEW_HOME" \
    timeout 10 node "$NEW_CLI" hook --agent "$1" 2>/dev/null
}

src="${EVENTS:-/dev/stdin}"
n=0; bad=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  n=$((n+1))
  a="$(printf '%s' "$line" | jq -r '.agent // empty' 2>/dev/null)"
  [ -n "$a" ] || a="$AGENT"
  ev="$(printf '%s' "$line" | jq -c 'if has("event") then .event else . end' 2>/dev/null)"
  [ -n "$ev" ] || { echo "line $n: not JSON, skipped" >&2; continue; }
  vo="$(printf '%s' "$ev" | run_old "$a" | jq -S -c . 2>/dev/null)"
  vn="$(printf '%s' "$ev" | run_new "$a" | jq -S -c . 2>/dev/null)"
  if [ "${vo:-null}" != "${vn:-null}" ]; then
    bad=$((bad+1))
    echo "DIVERGE event $n (agent $a):"
    echo "  event: $(printf '%s' "$ev" | head -c 200)"
    echo "  old:   ${vo:-<no verdict>}"
    echo "  new:   ${vn:-<no verdict>}"
  fi
done < "$src"

echo "dual-run: $n events, $bad divergences"
[ "$bad" = 0 ]
