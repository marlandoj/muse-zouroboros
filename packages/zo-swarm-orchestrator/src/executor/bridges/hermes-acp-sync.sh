#!/usr/bin/env bash
set -euo pipefail
# Follow the native harness manager's current interpreter without editing vendor files.
#
# Hermes installs come in two launcher shapes:
#   1. Source/venv installs: the `hermes` entry is a Python script whose
#      shebang names the venv interpreter directly.
#   2. Standalone installs: `hermes` is a chain of shell launchers ending in
#      `python3 -I -c '... sys.path.insert(0, "<agent-dir>") ...'`. There the
#      interpreter and agent dir are recovered from the final launcher and the
#      agent dir is put on PYTHONPATH for the adapter process.
HERMES_ENTRY="$(readlink -f "$(command -v hermes)")"
PYTHON=""
AGENT_PATH=""
ENTRY="$HERMES_ENTRY"
for _ in 1 2 3 4; do
  IFS= read -r SHEBANG < "$ENTRY" || break
  CANDIDATE="${SHEBANG#\#!}"
  if [[ "$CANDIDATE" == /* && "$CANDIDATE" == *python* && -x "$CANDIDATE" ]]; then
    PYTHON="$CANDIDATE"
    break
  fi
  if grep -q "sys.path.insert" "$ENTRY" 2>/dev/null; then
    PYTHON="$(grep -oE '/[^"'"'"' ]*/bin/python3?' "$ENTRY" | head -n 1 || true)"
    # The launcher shell-escapes its quotes ('"'"'), so pull the first absolute
    # path out of the sys.path.insert(...) call rather than matching quotes.
    SEG="$(grep -oE 'sys\.path\.insert\(0,[^)]*\)' "$ENTRY" | head -n 1 || true)"
    AGENT_PATH="$(printf '%s' "$SEG" | grep -oE '/[A-Za-z0-9_./+-]+' | head -n 1 || true)"
    [[ -n "$PYTHON" ]] && break
  fi
  NEXT="$(grep -oE 'exec[[:space:]]+/[^"'"'"' ]+' "$ENTRY" | head -n 1 | awk '{print $2}' || true)"
  [[ -n "$NEXT" && -f "$NEXT" ]] || break
  ENTRY="$NEXT"
done
if [[ -z "$PYTHON" || "$PYTHON" != /* || "$PYTHON" != *python* || ! -x "$PYTHON" ]]; then
  echo 'Cannot resolve the managed Hermes Python interpreter' >&2
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "$AGENT_PATH" ]]; then
  export PYTHONPATH="$AGENT_PATH${PYTHONPATH:+:$PYTHONPATH}"
fi
exec "$PYTHON" "$SCRIPT_DIR/hermes-acp-sync.py" "$@"
