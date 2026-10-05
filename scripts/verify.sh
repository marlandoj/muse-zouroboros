#!/usr/bin/env bash
# verify.sh — post-install smoke checks for the Zouroboros workshop.
# Green across the board = the workshop is real. Reports red/green per
# system with the exact command to dig deeper.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.config/zouroboros/workshop.env" ] && source "$HOME/.config/zouroboros/workshop.env"
[ -f "$HOME/.config/zouroboros/apis.env" ] && source "$HOME/.config/zouroboros/apis.env"

GREEN=0; RED=0
ok()   { printf '  \033[0;32m✔\033[0m %s\n' "$1"; GREEN=$((GREEN+1)); }
bad()  { printf '  \033[0;31m✘\033[0m %s\n' "$1"; RED=$((RED+1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head "memory"
if [ -f "${ZO_MEMORY_DB:-$HOME/.zo/memory/shared-facts.db}" ]; then
  ok "database exists: $ZO_MEMORY_DB"
  if (cd "$REPO/packages/zo-memory-system" && timeout 30 bun scripts/memory.ts stats >/dev/null 2>&1); then
    ok "memory CLI round-trip works"
  else bad "memory CLI failed — run: cd packages/zo-memory-system && bun scripts/memory.ts stats"; fi
else bad "no database — run walkthrough step 03"; fi

head "swarm executors"
if (cd "$REPO/packages/zo-swarm-executors" && timeout 120 bun scripts/doctor.ts 2>/dev/null | grep -qiE 'healthy|ok'); then
  ok "executor doctor reports healthy executors"
else bad "no healthy executors — run: cd packages/zo-swarm-executors && bun scripts/doctor.ts"; fi

head "swarm orchestrator"
if (cd "$REPO/packages/zo-swarm-orchestrator" && timeout 60 bun scripts/orchestrate-v5.ts doctor >/dev/null 2>&1); then
  ok "orchestrator doctor passes"
else bad "orchestrator doctor failed — run: cd packages/zo-swarm-orchestrator && bun scripts/orchestrate-v5.ts doctor"; fi

head "hooks (shadow)"
for h in wayfinder verity sift; do
  if [ -d "$REPO/packages/$h" ]; then ok "$h package present"; else bad "$h package missing"; fi
done
[ -f "$HOME/.wayfinder/suggestions.jsonl" ] && ok "wayfinder has logged suggestions" || bad "wayfinder not yet active — walkthrough step 05"

head "factory"
if (cd "$REPO/factory/lane" && timeout 120 bun scripts/factory-mvp.ts smoke >/dev/null 2>&1); then
  ok "factory MVP smoke green"
else bad "factory smoke failed — run: cd factory/lane && bun scripts/factory-mvp.ts smoke"; fi

head "keys"
[ -n "${OPENAI_API_KEY:-}" ] && ok "OPENAI_API_KEY set (full memory mode)" || bad "OPENAI_API_KEY not set — memory runs FTS5-only"

printf '\n\033[1mResult: %d green, %d red\033[0m\n' "$GREEN" "$RED"
[ "$RED" -eq 0 ]
