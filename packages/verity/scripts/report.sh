#!/usr/bin/env bash
# Summarize Verity's verdicts: what Canny decided, and whether live mode applied it.
set -u
LOG="${VERITY_LOG:-${VERITY_HOME:-$HOME/.verity}/verdicts.jsonl}"
[ -s "$LOG" ] || { echo "no verdicts recorded yet ($LOG)"; exit 0; }
jq -s -r '
  def kind: if .kind then .kind
    elif .event == "Stop" and .verdict.decision == "block" then "done"
    elif .verdict.hookSpecificOutput.permissionDecision == "deny" then "deny"
    elif .verdict.hookSpecificOutput.permissionDecision == "ask" then "ask"
    elif .verdict.hookSpecificOutput.updatedInput != null then "rewrite"
    elif .verdict.hookSpecificOutput.additionalContext != null then "note"
    elif .verdict.systemMessage != null then "warn"
    else "other" end;
  (group_by(.harness // "claude")[] | "\(.[0].harness // "claude"): \(length) verdicts, \(map(select(.applied)) | length) applied, p50 \(map(.ms) | sort | .[length/2|floor]) ms"),
  "verdicts: \(length)  sessions: \(map(.session) | unique | length)  since: \(.[0].ts)",
  "latency ms p50/max: \(map(.ms) | sort | .[length/2|floor]) / \(map(.ms) | max)",
  "",
  (group_by(kind)[] | "\(.[0] | kind): \(length)"),
  "",
  "latest 10:",
  (.[-10:][] | "\(.ts) \(if .applied then "LIVE  " else "shadow" end) \(.harness // "claude") \(.event) \(.tool // "-") \(kind): \((.verdict.reason // .verdict.hookSpecificOutput.permissionDecisionReason // .verdict.hookSpecificOutput.additionalContext // .verdict.systemMessage // "") | tostring | .[0:140])")
' "$LOG"
echo
echo "hook crashes: $(cat "${CANNY_HOME:-$HOME/.canny}/errors.log" 2>/dev/null | wc -l)"
