#!/usr/bin/env bash
# Wayfinder control CLI.
#   wayfinder.sh mode shadow|live [--harness H]   switch mode (host-wide, or one harness)
#   wayfinder.sh status                           show mode per harness, kill switch, log size
#   wayfinder.sh report                           summarize suggestions overall and per harness
#   wayfinder.sh suggest "<task>"                 rank skills for a task, print JSON
#   wayfinder.sh off | on                         kill switch
set -euo pipefail
state="${WAYFINDER_HOME:-$HOME/.wayfinder}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESSES="claude codex kimi gemini opencode pi hermes"
umask 077
mkdir -p "$state" && chmod 700 "$state"

mode_of() {
  local m="shadow"
  [ -f "$state/mode" ] && m="$(tr -d '[:space:]' < "$state/mode")"
  [ -f "$state/mode.$1" ] && m="$(tr -d '[:space:]' < "$state/mode.$1")"
  printf '%s' "$m"
}

case "${1:-status}" in
  mode)
    new="${2:-}"
    [ "$new" = "shadow" ] || [ "$new" = "live" ] || { echo "usage: wayfinder.sh mode shadow|live [--harness H]" >&2; exit 2; }
    if [ "${3:-}" = "--harness" ]; then
      h="${4:-}"
      case " $HARNESSES " in *" $h "*) ;; *) echo "unknown harness: $h (one of: $HARNESSES)" >&2; exit 2 ;; esac
      printf '%s\n' "$new" > "$state/mode.$h"
      echo "$h: $new"
    else
      printf '%s\n' "$new" > "$state/mode"
      rm -f "$state"/mode.*
      echo "all harnesses: $new"
    fi
    ;;
  status)
    for h in $HARNESSES; do printf '%-9s %s\n' "$h" "$(mode_of "$h")"; done
    [ -e "$state/disabled" ] && echo "kill switch: ON (nothing runs)" || echo "kill switch: off"
    [ -f "$state/suggestions.jsonl" ] && echo "log entries: $(wc -l < "$state/suggestions.jsonl")" || echo "log entries: 0"
    ;;
  report) python3 "$here/../engine/run.py" report ;;
  suggest) shift; python3 "$here/../engine/run.py" suggest "$*" ;;
  off) touch "$state/disabled"; echo "Wayfinder disabled" ;;
  on) rm -f "$state/disabled"; echo "Wayfinder enabled" ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
