#!/usr/bin/env bash
# workshop-status.sh — read bridge example: one-command snapshot of the
# Zouroboros workshop for Muse.
#
# Sections: memory, swarm executors, orchestrator, factory, hooks. Every
# section degrades gracefully — a missing source prints "unavailable"
# instead of failing the script.
#
# Usage: workshop-status.sh [--json]
#   Default prints the human-readable brief; --json prints a machine object.
#
# Point Muse at this script. "Is the workshop healthy?" becomes a script
# run, not a question for you.

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.config/zouroboros/workshop.env" ] && source "$HOME/.config/zouroboros/workshop.env"
[ -f "$HOME/.config/zouroboros/apis.env" ] && source "$HOME/.config/zouroboros/apis.env"

mode="text"
[ "${1:-}" = "--json" ] && mode="json"

sec_memory() {
  echo "== memory =="
  db="${ZO_MEMORY_DB:-$HOME/.zo/memory/shared-facts.db}"
  if [ ! -f "$db" ]; then echo "  unavailable (no database — walkthrough step 03)"; return 0; fi
  out=$(cd "$REPO/packages/zo-memory-system" && timeout 30 bun scripts/memory.ts stats 2>/dev/null) \
    || { echo "  unavailable (cli failed)"; return 0; }
  echo "$out" | head -8 | sed 's/^/  /'
  if [ -n "${OPENAI_API_KEY:-}" ]; then echo "  mode: full (embeddings on)"; else echo "  mode: FTS5-only (no OPENAI_API_KEY)"; fi
}

sec_executors() {
  echo "== swarm executors =="
  out=$(cd "$REPO/packages/zo-swarm-executors" && timeout 120 bun scripts/doctor.ts 2>/dev/null) \
    || { echo "  unavailable (doctor failed)"; return 0; }
  echo "$out" | grep -iE 'healthy|unhealthy|ok|fail|✔|✘' | head -12 | sed 's/^/  /'
  [ -z "$(echo "$out" | grep -iE 'healthy|✔' | head -1)" ] && echo "  (no healthy executors reported)"
}

sec_orchestrator() {
  echo "== orchestrator =="
  out=$(cd "$REPO/packages/zo-swarm-orchestrator" && timeout 60 bun scripts/orchestrate-v5.ts status 2>/dev/null) \
    || { echo "  unavailable (status failed)"; return 0; }
  echo "$out" | head -10 | sed 's/^/  /'
}

sec_factory() {
  echo "== factory =="
  lane="$REPO/factory/lane"
  ready=$(find "$lane/state" -name '*.json' 2>/dev/null | wc -l)
  echo "  lane state files: $ready (see factory/lane/OPERATORS_MANUAL.md for states)"
  echo "  run: cd factory/lane && bun scripts/factory-mvp.ts smoke"
}

sec_hooks() {
  echo "== hooks =="
  for h in wayfinder verity sift; do
    if [ -d "$REPO/packages/$h" ]; then echo "  $h: installed"; else echo "  $h: missing"; fi
  done
  [ -f "$HOME/.wayfinder/suggestions.jsonl" ] \
    && echo "  wayfinder log: $(wc -l < "$HOME/.wayfinder/suggestions.jsonl") suggestions" \
    || echo "  wayfinder log: none yet"
}

if [ "$mode" = "json" ]; then
  python3 - "$REPO" <<'PYEOF'
import json, subprocess, sys, os
repo = sys.argv[1]
def run(cmd, cwd, timeout=30):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return {"ok": r.returncode == 0, "out": (r.stdout or "")[:2000]}
    except Exception as e:
        return {"ok": False, "out": f"unavailable: {e}"}
home = os.path.expanduser("~")
db = os.environ.get("ZO_MEMORY_DB", os.path.join(home, ".zo/memory/shared-facts.db"))
print(json.dumps({
    "memory": {"db_exists": os.path.isfile(db),
               "fts5_only": not bool(os.environ.get("OPENAI_API_KEY"))},
    "executors": run(["bun", "scripts/doctor.ts"], os.path.join(repo, "packages/zo-swarm-executors"), 120)["ok"],
    "orchestrator": run(["bun", "scripts/orchestrate-v5.ts", "status"], os.path.join(repo, "packages/zo-swarm-orchestrator"), 60)["ok"],
    "hooks": {h: os.path.isdir(os.path.join(repo, "packages", h)) for h in ["wayfinder", "verity", "sift"]},
}, indent=2))
PYEOF
  exit 0
fi

sec_memory
sec_executors
sec_orchestrator
sec_factory
sec_hooks
