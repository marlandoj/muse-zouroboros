#!/usr/bin/env bash
# Fixture bridge for upstream-fence-orchestrator.test.ts.
# $1 = prompt, $2 = workspace. Saves the exact prompt as $2/prompts/<mark>.txt,
# prints $2/out/<mark> as the task output when present, and fails on purpose
# (after printing) when $2/fail/<mark> exists. A task's own TASKMARK is the
# LAST one in its prompt, because "## Your Task" comes last.
set -uo pipefail
if [ "${SWARM_PROBE:-}" = "1" ]; then echo SWARM_PROBE_OK; exit 0; fi
mark="$(printf '%s' "$1" | grep -o 'TASKMARK=[A-Z]' | tail -1 | cut -d= -f2)"
mkdir -p "$2/prompts"
printf '%s' "$1" > "$2/prompts/$mark.txt"
if [ -f "$2/out/$mark" ]; then cat "$2/out/$mark"; else echo "done $mark"; fi
if [ -f "$2/fail/$mark" ]; then echo "error: deliberate fixture failure" >&2; exit 1; fi
exit 0
