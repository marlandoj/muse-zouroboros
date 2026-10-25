#!/usr/bin/env bash
# Hybrid Phase 1 (kill criterion K2): count event-versus-diff disagreements over
# the engine's verdict store — every Stop verdict line in the session ledgers
# that carries a diffDecision. Read-only; prints one JSON object.
#
#   bash scripts/diff-disagreements.sh [engine-home]   (default $VERITY_ENGINE_HOME, else ~/.verity/engine)
#
# The event verdict "agrees" when it allowed and the diff passed, or it did not
# allow (block / warn) and the diff failed. Unverifiable diff verdicts are
# counted apart, never as agreement or disagreement. Corrupt ledger lines are
# skipped, as the engine skips them.
set -u
HOME_DIR="${1:-${VERITY_ENGINE_HOME:-$HOME/.verity/engine}}"
shopt -s nullglob
files=("$HOME_DIR"/sessions/*.jsonl)
cat "${files[@]}" /dev/null | jq -cRn '
  [inputs | fromjson? | select(.type == "verdict" and .phase == "stop" and .diffDecision != null)
   | {event: .decision, diff: .diffDecision.decision, reason: .diffDecision.reason}] as $v
  | ($v | map(select(.diff != "unverifiable"))) as $j
  | {
      stops: ($v | length),
      unverifiable: ($v | map(select(.diff == "unverifiable")) | length),
      agree: ($j | map(select((.event == "allow") == (.diff == "pass"))) | length),
      disagree: ($j | map(select((.event == "allow") != (.diff == "pass"))) | length),
      pairs: ($v | group_by([.event, .diff, .reason]) | map({event: .[0].event, diff: .[0].diff, reason: .[0].reason, n: length}))
    }'
