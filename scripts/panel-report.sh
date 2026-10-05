#!/usr/bin/env bash
# panel-report.sh — summarize consensus panel verdicts from the factory lane.
# Reads the review result files under the lane's state dir and reports:
# how many reviews ran, in which mode, how many held (or would have held),
# and the per-persona breakdown. Read-only; changes nothing.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LANE="$REPO/factory/lane"

# Find review result files: <state>/pool/reviews/*.json (poolStateDir reviews)
mapfile -t FILES < <(find "$LANE/state" -path '*reviews/*.json' 2>/dev/null | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No panel verdicts found yet."
  echo "Verdicts appear here once factory tickets run through review"
  echo "(shadow mode records them without blocking anything)."
  echo "Looked under: $LANE/state"
  exit 0
fi

python3 - "${FILES[@]}" <<'PYEOF'
import json, sys
from collections import Counter
files = sys.argv[1:]
modes, states, held = Counter(), Counter(), []
persona_votes = Counter()
for f in files:
    try:
        r = json.load(open(f))
    except Exception:
        continue
    modes[r.get("mode", "?")] += 1
    states[r.get("diversity_terminal_state", "?")] += 1
    pr = r.get("persona_reviews") or {}
    for rev in pr.get("reviews", []):
        persona_votes[(rev.get("persona_name", "?"), rev.get("verdict", "?"))] += 1
    if r.get("blocking") and not r.get("pass"):
        held.append((r.get("identifier", "?"), r.get("diversity_terminal_state", "?")))
print(f"Reviews on file: {len(files)}")
print(f"Modes: {dict(modes)}")
print(f"Terminal states: {dict(states)}")
print(f"Held (or would-have-held): {len(held)}")
for ident, st in held[:10]:
    print(f"  - {ident} [{st}]")
if persona_votes:
    print("Persona verdicts:")
    for (name, verdict), n in sorted(persona_votes.items()):
        print(f"  - {name}: {verdict} x{n}")
print()
print("Shadow verdicts are advisory. See docs/consensus-panel.md for")
print("the qualification checklist before setting FACTORY_REVIEW_GATE_MODE=enforce.")
PYEOF
