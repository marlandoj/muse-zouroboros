#!/usr/bin/env bash
# Phase 0: replay the golden corpus through a target engine CLI and diff.
# Usage: bash test/engine-parity.sh <engine-cli> [fixture-name...]
#   <engine-cli> is invoked as: node <engine-cli> hook --agent <agent>
#   with stdin = one event JSON. Home dir comes from $PARITY_HOME_VAR
#   (default VERITY_ENGINE_HOME; use CANNY_HOME to re-verify Canny itself).
# Compares verdicts, ledger, and argv outputs. Exit 0 iff all match.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_CLI="$1"; shift || true
HOME_VAR="${PARITY_HOME_VAR:-VERITY_ENGINE_HOME}"
FIXDIR="$ROOT/test/fixtures/engine"

norm() { sed -E 's/"ts":[0-9]+/"ts":0/g'; }

pass=0; fail=0
run_fixture() {
  local name="$1"
  local dir="$FIXDIR/$name"
  local agent; agent="$(cat "$dir/agent")"
  local T; T="$(mktemp -d)"; trap 'rm -rf "$T"' RETURN
  local home="$T/home"; mkdir -p "$home"
  export SETUP_ENGINE_CLI="$ENGINE_CLI" SETUP_HOME_VAR="$HOME_VAR"
  if [ -x "$dir/setup.sh" ]; then "$dir/setup.sh" "$T"; fi
  local got_v="$T/verdicts.jsonl" got_l="$T/ledger.jsonl"
  : > "$got_v"
  while IFS= read -r event || [ -n "$event" ]; do
    [ -z "$event" ] && continue
    event="${event//%%T%%/$T}"
    printf '%s' "$event" \
      | env -u TYPESAFE_API_KEY CANNY_JEV_URL=http://127.0.0.1:9/disabled \
        "$HOME_VAR"="$home" timeout 10 node "$ENGINE_CLI" hook --agent "$agent" \
      >> "$got_v" 2>/dev/null
    printf '\n' >> "$got_v"
  done < "$dir/events.jsonl"
  : > "$got_l"
  for f in "$home"/sessions/*.jsonl; do
    [ -f "$f" ] || continue
    norm < "$f" | sed -e "s#$T#TDIR#g" >> "$got_l"
  done
  local ok=1
  diff -u "$dir/expected.jsonl" "$got_v" > "$T/v.diff" || ok=0
  diff -u "$dir/expected-ledger.jsonl" "$got_l" > "$T/l.diff" || ok=0
  local got_s="$T/status.txt" got_ss="$T/sessions.txt" got_r="$T/replay.txt" got_e="$T/errors.txt"
  (
    cd /
    local sess; sess="$(ls "$home"/sessions/*.jsonl 2>/dev/null | head -n 1)"
    env -u TYPESAFE_API_KEY "$HOME_VAR"="$home" timeout 10 node "$ENGINE_CLI" status 2>&1 \
      | norm | sed -E -e "s#$home#HOME#g" -e "s#$T#TDIR#g" -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#TS#g' -e 's#node "[^"]*cli\.js"#node "CLI"#g' > "$got_s"
    env -u TYPESAFE_API_KEY "$HOME_VAR"="$home" timeout 10 node "$ENGINE_CLI" sessions 2>&1 \
      | norm | sed -E -e "s#$home#HOME#g" -e "s#$T#TDIR#g" -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#TS#g' -e 's#node "[^"]*cli\.js"#node "CLI"#g' > "$got_ss"
    if [ -f "$home/errors.log" ]; then
      sed -E -e 's#[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z#TS#g' "$home/errors.log" > "$got_e"
    else
      : > "$got_e"
    fi
    if [ -n "$sess" ]; then
      env -u TYPESAFE_API_KEY "$HOME_VAR"="$home" timeout 10 node "$ENGINE_CLI" replay "$(basename "$sess")" 2>&1 \
        | norm | sed -E -e "s#$home#HOME#g" -e "s#$T#TDIR#g" > "$got_r"
    else
      : > "$got_r"
    fi
  )
  diff -u "$dir/expected-status.txt" "$got_s" > "$T/s.diff" || ok=0
  diff -u "$dir/expected-sessions.txt" "$got_ss" > "$T/ss.diff" || ok=0
  diff -u "$dir/expected-replay.txt" "$got_r" > "$T/r.diff" || ok=0
  diff -u "$dir/expected-errors.txt" "$got_e" > "$T/e.diff" || ok=0
  if [ "$ok" = 1 ]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL $name"; sed 's/^/  /' "$T/v.diff" "$T/l.diff" "$T/s.diff" "$T/ss.diff" "$T/r.diff" "$T/e.diff" | head -n 40; fi
}

if [ "$#" -gt 0 ]; then
  for n in "$@"; do run_fixture "$n"; done
else
  for d in "$FIXDIR"/*/; do run_fixture "$(basename "$d")"; done
fi
echo "parity: $pass passed, $fail failed"
[ "$fail" = 0 ]
