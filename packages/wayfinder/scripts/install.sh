#!/usr/bin/env bash
# Wires the Wayfinder prompt hook into the chosen harnesses, in shadow mode.
# Every config file is backed up before it is changed; a run that changes nothing writes nothing.
# Entries from the earlier jev-skill-advisor shadow hook are repointed at wayfinder-hook.sh.
#
# Usage: install.sh [--harness claude,codex,kimi,gemini,opencode,pi,hermes] [--project DIR]
#                   [--backup-dir DIR] [--dry-run]
#   --project   directory whose .claude/settings.json and .codex/hooks.json get the hook
#               (default: current directory). The other five harnesses are wired user-wide.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
HOOK="$DIR/wayfinder-hook.sh"
ALL="claude,codex,kimi,gemini,opencode,pi,hermes"

HARNESSES="$ALL"
PROJECT="$PWD"
BACKUP_DIR="${BACKUP_DIR:-${WAYFINDER_HOME:-$HOME/.wayfinder}/backups}"
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --harness) HARNESSES="$2"; shift 2 ;;
    --project) PROJECT="$(cd "$2" && pwd)"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for bin in python3 jq; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 1; }
done
python3 -c 'import flashrank' 2>/dev/null || echo "warning: python3 cannot import flashrank; install it with: pip install flashrank" >&2

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
backup() {
  [ -f "$1" ] || return 0
  local dest="$BACKUP_DIR/$(echo "$1" | tr / _).pre-wayfinder-$STAMP"
  run mkdir -p -m 700 "$BACKUP_DIR"
  run cp -p "$1" "$dest"
  echo "backed up $1 -> $dest"
}

# Adds one hook group per event unless a group already calls wayfinder-hook.
merge_json() {
  local file="$1" spec="$2" tmp
  tmp="$(mktemp)"
  jq --argjson spec "$spec" '
    .hooks //= {} |
    reduce ($spec | to_entries[]) as $e (.;
      if ((.hooks[$e.key] // []) | tostring | test("wayfinder-hook")) then .
      else .hooks[$e.key] = ((.hooks[$e.key] // []) + [$e.value]) end)' <(if [ -f "$file" ]; then cat "$file"; else echo '{}'; fi) > "$tmp"
  if [ -f "$file" ] && [ "$(jq -S . "$file")" = "$(jq -S . "$tmp")" ]; then rm -f "$tmp"; echo "already wired $file"; return; fi
  if [ "$DRY" = 1 ]; then rm -f "$tmp"; echo "[dry-run] merge into $file: $spec"; return; fi
  mkdir -p "$(dirname "$file")"
  backup "$file"
  mv "$tmp" "$file"
  echo "wired $file"
}

group() { # harness timeout [statusMessage]
  local command
  command="$(python3 -c 'import shlex,sys; print(shlex.join(["bash",sys.argv[1],sys.argv[2]]))' "$HOOK" "$1")"
  jq -nc --arg c "$command" --argjson t "$2" --arg s "${3:-}" \
    '{hooks: [({type: "command", command: $c, timeout: $t} + (if $s == "" then {} else {statusMessage: $s} end))]}'
}

link() { # source target
  if [ -L "$2" ] && [ "$(readlink -f "$2")" = "$(readlink -f "$1")" ]; then echo "already wired $2"; return; fi
  if [ -e "$2" ] || [ -L "$2" ]; then echo "refusing to replace existing $2; remove it first" >&2; return 1; fi
  run mkdir -p "$(dirname "$2")"
  run ln -s "$1" "$2"
  echo "wired $2"
}

install_claude() { merge_json "$PROJECT/.claude/settings.json" "$(jq -nc --argjson g "$(group claude 6)" '{UserPromptSubmit: $g}')"; }

install_codex() {
  merge_json "$PROJECT/.codex/hooks.json" "$(jq -nc --argjson g "$(group codex 6 Wayfinder)" '{UserPromptSubmit: $g}')"
  echo "note: Codex runs a new hook only after you trust it once with /hooks in an interactive session"
}

install_gemini() { merge_json "$HOME/.gemini/settings.json" "$(jq -nc --argjson g "$(group gemini 6000)" '{BeforeAgent: $g}')"; }

install_kimi() {
  local file="$HOME/.kimi-code/config.toml"
  if [ -f "$file" ] && grep -q 'wayfinder-hook' "$file"; then echo "already wired $file"; return; fi
  local block
  block="$(python3 -c 'import json,shlex,sys; print("\n[[hooks]]\nevent = \"UserPromptSubmit\"\ncommand = " + json.dumps(shlex.join(["bash",sys.argv[1],"kimi"])) + "\ntimeout = 6")' "$HOOK")"
  if [ "$DRY" = 1 ]; then echo "[dry-run] append to $file:$block"; return; fi
  mkdir -p "$(dirname "$file")"
  backup "$file"
  printf '%s\n' "$block" >> "$file"
  echo "wired $file"
}

install_opencode() { link "$ROOT/plugins/opencode/wayfinder.js" "$HOME/.config/opencode/plugin/wayfinder.js"; }

install_pi() { link "$ROOT/plugins/pi/wayfinder.ts" "$HOME/.pi/agent/extensions/wayfinder.ts"; }

install_hermes() {
  link "$ROOT/plugins/hermes/wayfinder" "$HOME/.hermes/plugins/wayfinder"
  local file="$HOME/.hermes/config.yaml"
  [ -f "$file" ] || { echo "no $file; add 'wayfinder' to plugins.enabled once Hermes has a config" >&2; return 0; }
  local tmp; tmp="$(mktemp)"
  if ! python3 "$DIR/hermes_enable.py" "$file" > "$tmp"; then
    rm -f "$tmp"; echo "could not edit $file; add 'wayfinder' to plugins.enabled by hand" >&2; return 0
  fi
  if cmp -s "$file" "$tmp"; then rm -f "$tmp"; echo "already enabled in $file"; return; fi
  if [ "$DRY" = 1 ]; then rm -f "$tmp"; echo "[dry-run] add wayfinder to plugins.enabled in $file"; return; fi
  backup "$file"
  cat "$tmp" > "$file"; rm -f "$tmp"
  echo "enabled in $file"
}

# Repoint the pre-Wayfinder Claude hook (jev-skill-advisor/hooks/skill-suggest-shadow-hook.sh).
migrate() {
  [ -f "$1" ] && grep -q 'skill-suggest-shadow-hook\.sh' "$1" || return 0
  if [ "$DRY" = 1 ]; then echo "[dry-run] migrate $1"; return; fi
  local tmp; tmp="$(mktemp)"
  python3 -c '
import json,shlex,sys
data=json.load(open(sys.argv[1]))
for group in data.get("hooks",{}).get("UserPromptSubmit",[]):
    for hook in group.get("hooks",[]):
        if "skill-suggest-shadow-hook.sh" in hook.get("command", ""):
            hook["command"]=shlex.join(["bash",sys.argv[2],"claude"])
json.dump(data,sys.stdout,indent=2)
' "$1" "$HOOK" > "$tmp"
  backup "$1"
  mv "$tmp" "$1"
  echo "migrated $1"
}

IFS=, read -ra list <<< "$HARNESSES"
for h in "${list[@]}"; do
  case ",$ALL," in *",$h,"*) ;; *) echo "unsupported harness: $h (supported: $ALL)" >&2; exit 2 ;; esac
done
case ",$HARNESSES," in *,claude,*) migrate "$PROJECT/.claude/settings.json" ;; esac
for h in "${list[@]}"; do
  case ",$ALL," in *",$h,"*) "install_$h" ;; *) echo "unsupported harness: $h (supported: $ALL)" >&2; exit 2 ;; esac
done
run mkdir -p -m 700 "${WAYFINDER_HOME:-$HOME/.wayfinder}"
echo "done; new installations default to shadow, existing modes are preserved. status: bash $DIR/wayfinder.sh status"
