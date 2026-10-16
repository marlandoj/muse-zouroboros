#!/usr/bin/env bash
# quickstart.sh — the one-command Zouroboros installer, built for chat.
#
# Usage (paste into a terminal):
#   curl -fsSL https://raw.githubusercontent.com/marlandoj/muse-zouroboros/main/scripts/quickstart.sh | bash
#
# What it does:
#   1. Clones (or updates) the repo to ~/workspace/muse-zouroboros
#   2. Runs scripts/bootstrap.sh (interactive — it will ask you questions)
#   3. Runs scripts/verify.sh
#   4. Prints a CONCIERGE HANDOFF block — paste the whole block to Muse,
#      and Muse walks you through whatever is red.
#
# What it never does: no sudo, no keys leave your machine, no background
# services. The only network installs are npm/bun packages, and the optional
# Gemini CLI free tier (only if you say yes).
set -uo pipefail

REPO_URL="https://github.com/marlandoj/muse-zouroboros.git"
TARGET="${1:-$HOME/workspace/muse-zouroboros}"

say() { printf '%s\n' "$1"; }

say "== Zouroboros quickstart =="
say ""

# 1. Clone or update
if [ -d "$TARGET/.git" ]; then
  say "-- using existing checkout at $TARGET"
  git -C "$TARGET" pull --ff-only 2>/dev/null || say "-- (could not fast-forward; continuing with what's there)"
else
  say "-- cloning to $TARGET"
  mkdir -p "$(dirname "$TARGET")"
  git clone --depth 1 "$REPO_URL" "$TARGET" || { say "ERROR: clone failed — check your network and git."; exit 1; }
fi
say ""

# 2. Bootstrap (interactive; prompts read from /dev/tty so piping works)
say "-- running bootstrap (it will ask you a question or two)"
bash "$TARGET/scripts/bootstrap.sh"
say ""

# 3. Verify
say "-- verifying"
VERIFY_OUT="$(bash "$TARGET/scripts/verify.sh" 2>&1 || true)"
printf '%s\n' "$VERIFY_OUT"
say ""

# 4. Concierge handoff block
COMMIT="$(git -C "$TARGET" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OS="$(uname -srm)"

# Executor CLI presence (approximation of doctor health; the doctor ran inside bootstrap)
CLIS=""
for pair in "claude:claude" "codex:codex" "gemini:gemini" "opencode:opencode" "hermes:hermes" "kimi:kimi" "pi:pi"; do
  id="${pair%%:*}"; bin="${pair##*:}"
  if command -v "$bin" >/dev/null 2>&1; then CLIS="$CLIS $id=yes"; else CLIS="$CLIS $id=no"; fi
done

FREE_TIER="no"
[ -f "$HOME/.config/zouroboros/workshop.env" ] && grep -q 'SWARM_FREE_TIER="1"' "$HOME/.config/zouroboros/workshop.env" 2>/dev/null && FREE_TIER="yes"

# Compact verify summary: one line per section with its marks
SUMMARY="$(printf '%s' "$VERIFY_OUT" | grep -E '✔|✘' | sed 's/\x1b\[[0-9;]*m//g' | sed 's/^ *//' | tr '\n' ';' )"

cat <<EOF

================================================================
ZOUROBOROS CONCIERGE HANDOFF — paste everything between the
markers below to Muse, and Muse will walk you through the rest.
================================================================
--- BEGIN HANDOFF ---
repo: $TARGET
commit: $COMMIT
date: $DATE
os: $OS
free_tier: $FREE_TIER
cli_present:$CLIS
verify: $SUMMARY
--- END HANDOFF ---
================================================================

What just happened: the workshop is installed. Paste the handoff to
Muse — Muse reads what's green and red, and guides you through your
first three wins (shared memory, a factory ticket, health at a glance).
Full manual, if you ever want it: $TARGET/walkthrough/00-quickstart.md
EOF
