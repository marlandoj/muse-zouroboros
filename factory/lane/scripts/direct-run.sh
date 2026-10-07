#!/usr/bin/env bash
# direct-run.sh — operator-direct harness run for the factory pool lane (F-004).
#
# The lane's `claude -p` runs are permission-deadlocked as root: every file
# write, npm invocation, and reference read is denied by prompts that cannot
# be answered in non-interactive print mode, and --dangerously-skip-permissions
# is rejected for root. This wrapper runs the proven sanctioned recipe:
#   claude -p --allowedTools "Write Edit Read Bash Glob Grep TodoWrite" < /dev/null
# with the prompt taken from a file and the working directory pinned.
#
# Usage: direct-run.sh <prompt-file> <workdir> [-- <extra claude args>...]
#   prompt-file : path to the lane-generated worker prompt (buildWorkerPrompt)
#   workdir     : the checkout the harness should work in (e.g. a prepared
#                 cascade worktree, or the real checkout for a quick fix)
#
# Exit: the claude exit code. Prints nothing on success except claude's output.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: direct-run.sh <prompt-file> <workdir> [-- <extra claude args>...]" >&2
  exit 2
fi

prompt_file="$1"
workdir="$2"
shift 2
if [[ "${1:-}" == "--" ]]; then shift; fi

[[ -f "$prompt_file" ]] || { echo "direct-run.sh: prompt file not found: $prompt_file" >&2; exit 2; }
[[ -d "$workdir" ]] || { echo "direct-run.sh: workdir not found: $workdir" >&2; exit 2; }
command -v claude >/dev/null 2>&1 || { echo "direct-run.sh: claude CLI not on PATH" >&2; exit 2; }

cd "$workdir"
exec claude -p \
  --allowedTools "Write Edit Read Bash Glob Grep TodoWrite" \
  "$(cat "$prompt_file")" "$@" < /dev/null
