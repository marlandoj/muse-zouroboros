#!/usr/bin/env bash
# Verity hook: feeds every harness event to Canny so its ledger fills, logs any verdict,
# and applies it only in live mode. Shadow mode (the default) always answers {}.
# Jev is disabled in both modes: no key, dead endpoint.
# VERITY-ADOPTED 2026-09-29: two constitutional amendments over upstream. (1) fail closed when a
# live gate cannot answer. (2) the verdict ledger keeps provenance only, never source or command
# text. Both are local edits; an upstream re-pull silently drops them.
#
# Constitution amendments applied at adoption (2026-09-29):
#   Article IX  - enforcement fails closed. A missing, disabled, crashed or unreadable
#                 analyzer may not silently pass a finish or a governed tool call.
#   Article VI  - the verdict ledger records decisions, not text. File contents, shell
#                 commands and their output are reduced to a length before being written.
# Usage: verity-hook.sh [claude|codex|kimi|gemini]   (default claude)
set -u
HARNESS="${1:-claude}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANNY_DIR="${CANNY_DIR:-/home/workspace/Integrations/canny}"
CANNY_CLI="${CANNY_CLI:-$CANNY_DIR/dist/cli.js}"
VERITY_HOME="${VERITY_HOME:-$HOME/.verity}"
VERITY_LOG="${VERITY_LOG:-$VERITY_HOME/verdicts.jsonl}"
input=$(cat)
answer='{}'

# The posture is read before the engine is called, because the degraded paths must know
# whether they are allowed to pass quietly. Shadow mode is fail-open by design: the gate
# only observes there, so an absent engine changes nothing an operator can see.
cfg="$VERITY_HOME/config.json"
[ -f "$cfg" ] || cfg=/dev/null
mode=$(jq -r --arg h "$HARNESS" '.harness[$h].mode // .mode // "shadow"' "$cfg" 2>/dev/null)
checks=$(jq -r --arg h "$HARNESS" '(.harness[$h].checks // .checks // ["all"]) | join(",")' "$cfg" 2>/dev/null)
mode="${VERITY_MODE:-${mode:-shadow}}"
checks="${VERITY_CHECKS:-${checks:-all}}"

event_name() { printf '%s' "$1" | jq -r '.hook_event_name // ""' 2>/dev/null; }

# One refusal, shaped for whichever harness asked, rendered by the adapter that already
# produces each harness's own decision format. Governance events (Stop) carry the refusal;
# everything else is governed tool use, which is denied. Advisory events are logged loudly
# but never turned into a hard stop, so a degraded ledger cannot also block work that has
# nothing left to refuse.
fail_closed() {
  reason="$1"
  case "$(event_name "$input")" in
    Stop|AfterAgent)
      synthetic=$(jq -nc --arg r "$reason" '{decision:"block", reason:$r, systemMessage:$r}' 2>/dev/null) ;;
    *)
      synthetic=$(jq -nc --arg r "$reason" '{systemMessage:$r,
        hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:"deny",
        permissionDecisionReason:$r}}' 2>/dev/null) ;;
  esac
  case "$HARNESS" in
    kimi|gemini)
      printf '%s' "$synthetic" | jq -nc --argjson e "${input:-{\}}" '{event:$e, verdict:.}' 2>/dev/null \
        | timeout 5 node "$DIR/adapter.mjs" --out "$HARNESS" 2>/dev/null ;;
    *) printf '%s' "$synthetic" ;;
  esac
}

# A gate that is down must be visible in the same ledger the operator reads, not only in
# the behavior of a coding session.
alarm() {
  mkdir -p -m 700 "$(dirname "$VERITY_LOG")" 2>/dev/null
  umask 077
  jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg h "$HARNESS" --arg m "$mode" --arg r "$1" \
    '{ts:$ts, harness:$h, mode:$m, kind:"gate_unavailable", applied:true, reason:$r}' \
    >> "$VERITY_LOG" 2>/dev/null
}

refuse() {
  candidate=$(fail_closed "$1: the Verity gate cannot vouch for this session. Restore the analyzer, or run scripts/verity.sh mode off to stand the gate down.")
  if printf '%s' "$candidate" | jq -e . >/dev/null 2>&1; then
    answer="$candidate"
  fi
  alarm "$1"
}

if [ ! -f "$CANNY_CLI" ] || [ "${VERITY_DISABLE:-0}" = "1" ]; then
  # Only enforcing mode has to answer for the gate. Shadow mode still returns {} either way,
  # so an absent analyzer there is invisible to the operator and changes nothing.
  if [ "$mode" = live ]; then
    if [ "${VERITY_DISABLE:-0}" = "1" ]; then
      refuse "the Verity gate is disabled (VERITY_DISABLE=1) while configured to enforce"
    else
      refuse "the Verity gate is configured to enforce but its analyzer is missing"
    fi
  fi
else
  start=$(date +%s%3N)
  case "$HARNESS" in
    kimi|gemini)
      event=$(printf '%s' "$input" | timeout 5 node "$DIR/adapter.mjs" "$HARNESS" 2>/dev/null)
      agent=claude ;;
    codex) event="$input"; agent=codex ;;
    *) event="$input"; agent=claude ;;
  esac
  out=$(printf '%s' "${event:-{\}}" | env -u TYPESAFE_API_KEY CANNY_JEV_URL=http://127.0.0.1:9/disabled \
    timeout 8 node "$CANNY_CLI" hook --agent "$agent" 2>/dev/null)
  ms=$(( $(date +%s%3N) - start ))

  # An engine that died, timed out, or answered with something unreadable is not a clean
  # bill of health. Treating silence as approval is how a gate becomes decorative.
  if [ -z "${out:-}" ] || ! printf '%s' "$out" | jq -e . >/dev/null 2>&1; then
    if [ "$mode" = live ]; then
      refuse "the Verity gate could not read a verdict from its analyzer"
    fi
    out=""
  fi

  kind=$(printf '%s' "${out:-}" | jq -r '
    if .decision == "block" then "done"
    elif .hookSpecificOutput.permissionDecision == "deny" then "deny"
    elif .hookSpecificOutput.permissionDecision == "ask" then "ask"
    elif .hookSpecificOutput.updatedInput != null then "rewrite"
    elif .hookSpecificOutput.additionalContext != null then "note"
    elif .systemMessage != null then "warn"
    else "none" end' 2>/dev/null)
  kind="${kind:-none}"

  applied=false
  if [ "$mode" = live ] && [ "$kind" != none ] && [[ ",$checks," == *",all,"* || ",$checks," == *",$kind,"* ]]; then
    case "$HARNESS" in
      kimi|gemini)
        translated=$(jq -nc --argjson e "${input:-{\}}" --argjson v "$out" '{event: $e, verdict: $v}' 2>/dev/null \
          | timeout 5 node "$DIR/adapter.mjs" --out "$HARNESS" 2>/dev/null) ;;
      *) translated="$out" ;;
    esac
    if [ -n "${translated:-}" ] && [ "$translated" != '{}' ] && printf '%s' "$translated" | jq -e . >/dev/null 2>&1; then
      answer="$translated"; applied=true
    fi
  fi

  # Constitution Article VI: provenance records what was decided and against which file,
  # never the text that was written. A ledger that copies the work is a second copy of the
  # work, which on this host also means a second copy of confidential material.
  if [ -n "${out:-}" ]; then
    mkdir -p -m 700 "$(dirname "$VERITY_LOG")" 2>/dev/null
    umask 077
    printf '%s' "${event:-{\}}" | jq -c --arg out "${out:-}" --argjson ms "$ms" --arg h "$HARNESS" \
      --arg mode "$mode" --arg kind "$kind" --argjson applied "$applied" '{
        ts: (now | todate), ms: $ms, harness: $h, mode: $mode, kind: $kind, applied: $applied,
        event: .hook_event_name, session: .session_id, cwd: .cwd, tool: .tool_name,
        target: (.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // null),
        bytes: ((.tool_input.content // .tool_input.new_string // .tool_input.command // "") | tostring | length),
        verdict: (($out | fromjson?) // null)
      }' >> "$VERITY_LOG" 2>/dev/null
  fi
fi
printf '%s' "$answer"
