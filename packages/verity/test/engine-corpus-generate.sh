#!/usr/bin/env bash
# Phase 0: generate the golden corpus by running fixture event sequences
# through the pinned Canny engine as a BLACK BOX. Never reads Canny source.
# Usage: bash test/engine-corpus-generate.sh [fixture-name...]
# Writes per fixture: expected.jsonl, expected-ledger.jsonl (ts normalized),
#   expected-status.txt, expected-sessions.txt, expected-replay.txt
# Fixture options: agent file, events.jsonl (%%T%% -> temp dir), setup.sh ($1=T,
#   uses $SETUP_ENGINE_CLI / $SETUP_HOME_VAR).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANNY_CLI="${CANNY_CLI:-/home/workspace/Integrations/canny/dist/cli.js}"
FIXDIR="$ROOT/test/fixtures/engine"

norm() { sed -E 's/"ts":[0-9]+/"ts":0/g'; }

run_fixture() {
  local name="$1"
  local dir="$FIXDIR/$name"
  local agent; agent="$(cat "$dir/agent")"
  local T; T="$(mktemp -d)"; trap 'rm -rf "$T"' RETURN
  local home="$T/home"; mkdir -p "$home"
  export SETUP_ENGINE_CLI="$CANNY_CLI" SETUP_HOME_VAR="CANNY_HOME"
  if [ -x "$dir/setup.sh" ]; then "$dir/setup.sh" "$T"; fi
  : > "$dir/expected.jsonl"
  while IFS= read -r event || [ -n "$event" ]; do
    [ -z "$event" ] && continue
    event="${event//%%T%%/$T}"
    printf '%s' "$event" \
      | env -u TYPESAFE_API_KEY CANNY_JEV_URL=http://127.0.0.1:9/disabled \
        CANNY_HOME="$home" timeout 10 node "$CANNY_CLI" hook --agent "$agent" \
      >> "$dir/expected.jsonl" 2>/dev/null
    printf '\n' >> "$dir/expected.jsonl"
  done < "$dir/events.jsonl"
  : > "$dir/expected-ledger.jsonl"
  for f in "$home"/sessions/*.jsonl; do
    [ -f "$f" ] || continue
    norm < "$f" | sed -e "s#$T#TDIR#g" >> "$dir/expected-ledger.jsonl"
  done
  # argv parity captures with controlled cwd for determinism
  (
    cd /
    local sess; sess="$(ls "$home"/sessions/*.jsonl 2>/dev/null | head -n 1)"
    env -u TYPESAFE_API_KEY CANNY_HOME="$home" timeout 10 node "$CANNY_CLI" status 2>&1 \
      | norm | sed -E -e "s#$home#HOME#g" -e "s#$T#TDIR#g" -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#TS#g' > "$dir/expected-status.txt"
    env -u TYPESAFE_API_KEY CANNY_HOME="$home" timeout 10 node "$CANNY_CLI" sessions 2>&1 \
      | norm | sed -E -e "s#$home#HOME#g" -e "s#$T#TDIR#g" -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#TS#g' > "$dir/expected-sessions.txt"
    if [ -f "$home/errors.log" ]; then
      sed -E -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#TS#g' "$home/errors.log" > "$dir/expected-errors.txt"
    else
      : > "$dir/expected-errors.txt"
    fi
    if [ -n "$sess" ]; then
      env -u TYPESAFE_API_KEY CANNY_HOME="$home" timeout 10 node "$CANNY_CLI" replay "$(basename "$sess")" 2>&1 \
        | norm | sed -E -e "s#$home#HOME#g" -e "s#$T#TDIR#g" > "$dir/expected-replay.txt"
    else
      : > "$dir/expected-replay.txt"
    fi
  )
  echo "generated $name"
}

if [ "$#" -gt 0 ]; then
  for n in "$@"; do run_fixture "$n"; done
else
  for d in "$FIXDIR"/*/; do run_fixture "$(basename "$d")"; done
fi
