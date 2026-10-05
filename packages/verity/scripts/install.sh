#!/usr/bin/env bash
# Installs Canny (pinned) and wires the Verity hook into the chosen harnesses, in shadow mode.
# Every config file is backed up before it is touched. Re-running is idempotent, and any
# pre-rename canny-shadow hook entries are repointed at verity-hook.sh.
#
# Usage: install.sh [--harness claude,codex,kimi,gemini] [--project DIR] [--canny-dir DIR]
#                   [--backup-dir DIR] [--dry-run]
#   --project     directory whose .claude/settings.json and .codex/hooks.json get the hooks
#                 (default: current directory). Kimi and Gemini configs are user-global.
set -euo pipefail

CANNY_REPO="https://github.com/qkal/Canny"
CANNY_PIN="f2c5e53779445d60dc4a09d2dbced2308fccb820"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$DIR/verity-hook.sh"

HARNESSES="claude,codex,kimi,gemini"
PROJECT="$PWD"
CANNY_DIR="${CANNY_DIR:-/home/workspace/Integrations/canny}"
BACKUP_DIR="${BACKUP_DIR:-${VERITY_HOME:-$HOME/.verity}/backups}"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --harness) HARNESSES="$2"; shift 2 ;;
    --project) PROJECT="$(cd "$2" && pwd)"; shift 2 ;;
    --canny-dir) CANNY_DIR="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for bin in node jq git; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "Canny needs Node 22 or newer" >&2; exit 1; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
backup() {
  [ -f "$1" ] || return 0
  local dest="$BACKUP_DIR/$(echo "$1" | tr / _).pre-verity-$STAMP"
  run mkdir -p -m 700 "$BACKUP_DIR"
  run cp -p "$1" "$dest"
  echo "backed up $1 -> $dest"
}

if [ -d "$CANNY_DIR/.git" ]; then
  have="$(git -C "$CANNY_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  [ "$have" = "$CANNY_PIN" ] || echo "warning: $CANNY_DIR is at $have, pin is $CANNY_PIN" >&2
else
  run git clone --quiet "$CANNY_REPO" "$CANNY_DIR"
  run git -C "$CANNY_DIR" checkout --quiet "$CANNY_PIN"
fi
[ "$DRY" = 1 ] || [ -f "$CANNY_DIR/dist/cli.js" ] || { echo "no dist/cli.js in $CANNY_DIR" >&2; exit 1; }

cmd() { local c="bash $HOOK $1"; [ "$CANNY_DIR" = /home/workspace/Integrations/canny ] || c="CANNY_DIR=$CANNY_DIR $c"; echo "$c"; }

# Adds one hook group per event unless a group already calls this wrapper.
merge_json() {
  local file="$1" spec="$2" tmp
  run mkdir -p "$(dirname "$file")"
  tmp="$(mktemp)"
  jq --argjson spec "$spec" '
    .hooks //= {} |
    reduce ($spec | to_entries[]) as $e (.;
      if ((.hooks[$e.key] // []) | tostring | test("verity-hook")) then .
      else .hooks[$e.key] = ((.hooks[$e.key] // []) + [$e.value]) end)' <(if [ -f "$file" ]; then cat "$file"; else echo '{}'; fi) > "$tmp"
  if [ -f "$file" ] && [ "$(jq -S . "$file")" = "$(jq -S . "$tmp")" ]; then rm -f "$tmp"; echo "already wired $file"; return; fi
  if [ "$DRY" = 1 ]; then rm -f "$tmp"; echo "[dry-run] merge into $file: $spec"; return; fi
  backup "$file"
  mv "$tmp" "$file"
  echo "wired $file"
}

group() { # command timeout [matcher]
  jq -nc --arg c "$1" --argjson t "$2" --arg m "${3:-}" \
    '{hooks: [{type: "command", command: $c, timeout: $t}]} + (if $m == "" then {} else {matcher: $m} end)'
}

install_claude() {
  local c; c="$(cmd claude)"
  local edit="Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell"
  merge_json "$PROJECT/.claude/settings.json" "$(jq -nc \
    --argjson s "$(group "$c" 10)" --argjson pre "$(group "$c" 10 "$edit")" \
    --argjson post "$(group "$c" 15 "$edit")" --argjson fail "$(group "$c" 15 "Bash|PowerShell")" \
    --argjson stop "$(group "$c" 15)" \
    '{SessionStart: $s, PreToolUse: $pre, PostToolUse: $post, PostToolUseFailure: $fail, Stop: $stop}')"
}

install_codex() {
  local c; c="$(cmd codex)"
  local g; g() { jq -nc --arg c "$c" --argjson t "$1" --arg m "${2:-}" \
    '{hooks: [{type: "command", command: $c, timeout: $t, statusMessage: "Verity"}]} + (if $m == "" then {} else {matcher: $m} end)'; }
  merge_json "$PROJECT/.codex/hooks.json" "$(jq -nc \
    --argjson s "$(g 10)" --argjson pre "$(g 10 'Bash|apply_patch')" \
    --argjson post "$(g 15 'Bash|apply_patch')" --argjson stop "$(g 15)" \
    '{SessionStart: $s, PreToolUse: $pre, PostToolUse: $post, Stop: $stop}')"
  echo "note: Codex runs new hooks only after you trust them once with /hooks in an interactive session"
}

install_gemini() {
  local c; c="$(cmd gemini)"
  local tools='^(write_file|replace|run_shell_command)$'
  merge_json "$HOME/.gemini/settings.json" "$(jq -nc \
    --argjson s "$(group "$c" 10000)" --argjson pre "$(group "$c" 10000 "$tools")" \
    --argjson post "$(group "$c" 15000 "$tools")" --argjson stop "$(group "$c" 15000)" \
    '{SessionStart: $s, BeforeTool: $pre, AfterTool: $post, AfterAgent: $stop}')"
}

install_kimi() {
  local file="$HOME/.kimi-code/config.toml" c; c="$(cmd kimi)"
  if [ -f "$file" ] && grep -q verity-hook "$file"; then echo "already wired $file"; return; fi
  backup "$file"
  local block
  block="$(printf '\n[[hooks]]\nevent = "%s"\n%scommand = "%s"\ntimeout = %s\n' \
    SessionStart "" "$c" 10 \
    PreToolUse 'matcher = "^(Bash|Write|Edit)$"\n' "$c" 10 \
    PostToolUse 'matcher = "^(Bash|Write|Edit)$"\n' "$c" 15 \
    PostToolUseFailure 'matcher = "^Bash$"\n' "$c" 15 \
    Stop "" "$c" 15)"
  if [ "$DRY" = 1 ]; then echo "[dry-run] append to $file:"; printf '%b\n' "$block"; return; fi
  mkdir -p "$(dirname "$file")"
  printf '%b\n' "$block" >> "$file"
  echo "wired $file"
}

# Repoint entries written before the rename (Skills/canny-shadow/scripts/canny-shadow-hook.sh).
migrate() {
  [ -f "$1" ] && grep -q 'canny-shadow/scripts/canny-shadow-hook\.sh' "$1" || return 0
  backup "$1"
  run sed -i "s#[^\" ]*canny-shadow/scripts/canny-shadow-hook\.sh#$HOOK#g" "$1"
  echo "migrated $1"
}

IFS=, read -ra list <<< "$HARNESSES"
for f in "$PROJECT/.claude/settings.json" "$PROJECT/.codex/hooks.json" "$HOME/.kimi-code/config.toml" "$HOME/.gemini/settings.json"; do
  migrate "$f"
done
for h in "${list[@]}"; do
  case "$h" in
    claude|codex|kimi|gemini) "install_$h" ;;
    *) echo "unsupported harness: $h (supported: claude, codex, kimi, gemini)" >&2; exit 2 ;;
  esac
done
run mkdir -p -m 700 "${CANNY_HOME:-$HOME/.canny}" "${VERITY_HOME:-$HOME/.verity}"
echo "done, in shadow mode. status: bash $DIR/verity.sh status   go live: bash $DIR/verity.sh mode live"
