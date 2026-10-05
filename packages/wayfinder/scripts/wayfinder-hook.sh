#!/usr/bin/env bash
# Prompt-submit hook for every supported harness: wayfinder-hook.sh <harness>
# Reads the harness's raw prompt event on stdin.
#   shadow (default): ranks in a detached process, logs, and prints the harness no-op at once.
#   live: ranks synchronously (bounded by WAYFINDER_TIMEOUT) and prints the context injection.
# Never blocks a prompt: any failure or timeout prints the no-op.
umask 077
harness="${1:-claude}"
state="${WAYFINDER_HOME:-$HOME/.wayfinder}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="${WAYFINDER_ENGINE:-$here/../engine/run.py}"

noop() {
  case "$harness" in
    kimi|opencode|pi|hermes) printf '' ;;
    *) printf '{}' ;;
  esac
}

if [ "${WAYFINDER:-1}" = "0" ] || [ -e "$state/disabled" ]; then
  noop; exit 0
fi
mkdir -p "$state" && chmod 700 "$state"

mode="shadow"
for f in "$state/mode" "$state/mode.$harness"; do
  [ -f "$f" ] && mode="$(tr -d '[:space:]' < "$f")"
done
[ -n "$WAYFINDER_MODE" ] && mode="$WAYFINDER_MODE"

payload="$(head -c 200000)"

if [ "$mode" = "live" ]; then
  out="$(printf '%s' "$payload" | timeout "${WAYFINDER_TIMEOUT:-4}" python3 "$engine" live --harness "$harness" 2>>"$state/errors.log")"
  if [ $? -eq 0 ] && [ -n "$out" ]; then
    printf '%s' "$out"
  else
    noop
  fi
  exit 0
fi

( printf '%s' "$payload" | nohup timeout "${WAYFINDER_SHADOW_TIMEOUT:-15}" python3 "$engine" log --harness "$harness" >/dev/null 2>>"$state/errors.log" & ) >/dev/null 2>&1
noop
exit 0
