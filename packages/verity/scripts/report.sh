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
# Phase 2: verdicts by surface (hook lines predate the field and count as "hook"), and for the
# CLI surface (verity run / gate / prepush) the per-event counts, the K5 measure (the share of
# wrapper verdicts that are unverifiable) and the gate's own overhead with the check excluded.
jq -s -r '
  def pct($a; $b): if $b == 0 then 0 else (100 * $a / $b | floor) end;
  def p50: sort | if length == 0 then null else .[length/2|floor] end;
  "by surface:",
  (group_by(.surface // "hook")[] | "  \(.[0].surface // "hook"): \(length) verdicts, \(map(select(.applied)) | length) applied"),
  (map(select(.surface == "cli")) | select(length > 0) |
    "cli events: \(group_by(.event) | map("\(.[0].event) \(length)") | join(", "))",
    (map(select(.event == "run")) | select(length > 0) |
      "cli run unverifiable (K5): \(map(select(.verdict.decision == "unverifiable")) | length)/\(length) (\(pct(map(select(.verdict.decision == "unverifiable")) | length; length))%), truncated \(map(select(.verdict.truncated == true)) | length), shared \(map(select(.attribution == "shared")) | length)"),
    "cli overhead ms p50/max, check excluded: \(map(.ms) | p50) / \(map(.ms) | max)")
' "$LOG"
echo
# The engine logs crashes under its own home (engine/home.js resolveHome): VERITY_ENGINE_HOME,
# else ~/.verity/engine. verity-hook.sh passes VERITY_ENGINE_HOME through unchanged.
echo "hook crashes: $(cat "${VERITY_ENGINE_HOME:-$HOME/.verity/engine}/errors.log" 2>/dev/null | wc -l)"
