#!/usr/bin/env bash
# bootstrap.sh — Zouroboros for Muse: core installer.
# Idempotent. Safe to re-run. Never touches your memory DB or API keys.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZCFG="$HOME/.config/zouroboros"
ZMEM="$HOME/.zo/memory"

pass() { printf '  \033[0;32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[0;31m✘\033[0m %s\n' "$1"; MISSING=1; }
info() { printf '%s\n' "$1"; }

MISSING=0
info "1/5 — Checking prerequisites"
command -v bun >/dev/null && pass "bun $(bun --version)" || fail "bun not found"
if command -v node >/dev/null; then
  NODEV=$(node --version | sed 's/v//;s/\..*//')
  [ "$NODEV" -ge 22 ] && pass "node $(node --version)" || fail "node < 22"
else fail "node not found"; fi
if command -v python3 >/dev/null; then
  PYV=$(python3 -c 'import sys; print(sys.version_info[1])')
  [ "$(python3 -c 'import sys; print(sys.version_info[0])')" -eq 3 ] && [ "$PYV" -ge 11 ] \
    && pass "python3 $(python3 --version 2>&1)" || fail "python3 < 3.11"
else fail "python3 not found"; fi
for c in git jq timeout; do command -v $c >/dev/null && pass "$c" || fail "$c not found"; done
[ "$MISSING" -eq 1 ] && { info "Fix the missing prerequisites, then re-run."; exit 1; }

info "2/5 — Creating directories (owner-only)"
mkdir -p "$ZMEM" "$ZCFG" "$HOME/.wayfinder" "$HOME/.cache/wayfinder"
chmod 700 "$ZMEM" "$ZCFG" "$HOME/.wayfinder"
pass "$ZMEM, $ZCFG"

info "3/5 — Expanding \$HOME in the orchestrator registry"
REG="$REPO/packages/zo-swarm-orchestrator/src/executor/registry/executor-registry.json"
if grep -q '\$HOME' "$REG"; then
  sed -i "s|\$HOME|$HOME|g" "$REG"
  pass "registry paths expanded to $HOME"
else
  pass "registry already expanded (your edits preserved)"
fi

info "4/5 — Writing workshop.env and wiring shell profile"
cat > "$ZCFG/workshop.env" <<EOF
# Zouroboros workshop paths — written by bootstrap.sh, safe to re-run.
export ZO_MEMORY_DB="\$HOME/.zo/memory/shared-facts.db"
export SWARM_EXECUTOR_REGISTRY="\$HOME/workspace/zouroboros-for-muse/packages/zo-swarm-executors/registry/executor-registry.json"
export SWARM_WORKSPACE="\$HOME/workspace/zouroboros-for-muse"
EOF
chmod 600 "$ZCFG/workshop.env"
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  grep -q 'zouroboros/workshop.env' "$rc" || echo 'source ~/.config/zouroboros/workshop.env' >> "$rc"
done
pass "workshop.env written; sourced from shell profile"

info "5/5 — Installing package dependencies"
(cd "$REPO/packages/zo-memory-system" && bun install --silent 2>/dev/null) && pass "zo-memory deps" || info "  (zo-memory bun install skipped)"
(cd "$REPO/packages/zo-swarm-orchestrator" && bun install --silent 2>/dev/null) && pass "orchestrator deps" || info "  (orchestrator bun install skipped)"
(cd "$REPO/packages/zo-swarm-executors" && bun install --silent 2>/dev/null) && pass "executors deps" || true
if [ -f "$REPO/packages/wayfinder/requirements.txt" ]; then
  python3 -m pip install --user -q -r "$REPO/packages/wayfinder/requirements.txt" 2>/dev/null && pass "wayfinder python deps" || info "  (wayfinder pip install skipped — run manually)"
fi

info ""
info "Done. Still manual (by design — they deserve your attention):"
info "  - Put OPENAI_API_KEY in $ZCFG/apis.env (mode 600)"
info "  - Walkthrough step 03: init memory DB + wire the MCP server"
info "  - Walkthrough step 05: install hooks (shadow mode)"
info "Next: walkthrough/02-core-install.md checklist, then 03-memory.md."
