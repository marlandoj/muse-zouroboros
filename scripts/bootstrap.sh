#!/usr/bin/env bash
# bootstrap.sh — Zouroboros for Muse: core installer.
# Idempotent. Safe to re-run. Never touches your memory DB or API keys.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZCFG="$HOME/.config/zouroboros"
ZMEM="$HOME/.zo/memory"

# Optional machine-readable status for callers (quickstart.sh sets this).
STATUS_FILE="${ZO_BOOTSTRAP_STATUS:-/dev/null}"
status() { printf '%s\n' "$1" >> "$STATUS_FILE" 2>/dev/null || true; }

pass() { printf '  \033[0;32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[0;31m✘\033[0m %s\n' "$1"; MISSING=1; status "missing: $1"; }
warn() { printf '  \033[0;31m✘\033[0m %s\n' "$1"; status "warn: $1"; }
info() { printf '%s\n' "$1"; }

MISSING=0
info "1/5 — Checking prerequisites"
command -v bun >/dev/null && pass "bun $(bun --version)" \
  || fail "bun not found — install it: curl -fsSL https://bun.sh/install | bash  (then open a new shell)"
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
[ "$MISSING" -eq 1 ] && { info "Fix the missing prerequisites, then re-run."; status "result: failed (prerequisites)"; exit 1; }

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
export SWARM_EXECUTOR_REGISTRY="$REPO/packages/zo-swarm-executors/registry/executor-registry.json"
export SWARM_WORKSPACE="$REPO"
EOF
chmod 600 "$ZCFG/workshop.env"
# Wire every existing interactive rc file, plus a login profile. If the user
# has none (minimal images, containers), create the one their shell reads —
# never report "sourced" without the line actually being there.
SRC_LINE='[ -f ~/.config/zouroboros/workshop.env ] && . ~/.config/zouroboros/workshop.env'
RCS=()
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do [ -f "$rc" ] && RCS+=("$rc"); done
if [ "${#RCS[@]}" -eq 0 ]; then
  case "$(basename "${SHELL:-bash}")" in zsh) RCS+=("$HOME/.zshrc") ;; *) RCS+=("$HOME/.bashrc") ;; esac
fi
# bash login shells read only the first of these; .profile is the portable one.
LOGIN=""
for p in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  [ -f "$p" ] && { LOGIN="$p"; break; }
done
RCS+=("${LOGIN:-$HOME/.profile}")
WIRED=""
for rc in "${RCS[@]}"; do
  if [ -f "$rc" ] && grep -q 'zouroboros/workshop.env' "$rc"; then
    WIRED="$WIRED ${rc/#"$HOME"/\~}(already)"
  elif printf '\n# Zouroboros workshop paths (added by bootstrap.sh)\n%s\n' "$SRC_LINE" >> "$rc"; then
    WIRED="$WIRED ${rc/#"$HOME"/\~}"
  fi
done
pass "workshop.env written: ${ZCFG/#"$HOME"/\~}/workshop.env"
# Prove it: a brand-new login shell must see ZO_MEMORY_DB.
EXPECT_DB="$HOME/.zo/memory/shared-facts.db"
GOT_DB="$(env -i HOME="$HOME" PATH="$PATH" SHELL="${SHELL:-/bin/bash}" bash -lc 'printf %s "${ZO_MEMORY_DB:-}"' 2>/dev/null || true)"
if [ "$GOT_DB" = "$EXPECT_DB" ]; then
  pass "sourced from:$WIRED — verified in a new shell"
  status "shell_env: ok"
else
  warn "profile wiring added to:$WIRED but a new shell does not see ZO_MEMORY_DB — add this line to your shell profile: $SRC_LINE"
  status "shell_env: unverified"
fi

info "5/5 — Installing package dependencies"
# One workspace install covers packages/* and factory/lane (root package.json).
DEPS_OK=1
if (cd "$REPO" && bun install --silent >/dev/null 2>&1); then
  pass "workspace deps (bun install)"
else
  DEPS_OK=0
  warn "bun install failed — run: cd $REPO && bun install"
fi
# Don't trust the install: prove the memory MCP server answers initialize.
if [ "$DEPS_OK" = "1" ] && MCP_MSG="$(ZO_MEMORY_DB="$EXPECT_DB" timeout 60 bun "$REPO/scripts/mcp-check.mjs" "$REPO/packages/zo-memory-system" bun scripts/mcp-server.ts 2>&1)"; then
  pass "zo-memory MCP server starts ($MCP_MSG)"
  status "memory_mcp: ok"
else
  warn "zo-memory MCP server does not start — run: cd $REPO/packages/zo-memory-system && bun scripts/mcp-server.ts"
  [ -n "${MCP_MSG:-}" ] && printf '%s\n' "$MCP_MSG" | sed 's/^/      /'
  status "memory_mcp: failed"
fi
if [ -f "$REPO/packages/wayfinder/requirements.txt" ]; then
  python3 -m pip install --user -q -r "$REPO/packages/wayfinder/requirements.txt" 2>/dev/null && pass "wayfinder python deps" || info "  (wayfinder pip install skipped — run manually)"
fi

# gemini_bin -- print the gemini CLI path if usable, else nothing.
# Mirrors the bridge's resolution order, plus npm's own global bin dir
# (npm's global prefix isn't always on PATH, e.g. nvm/fnm layouts).
gemini_bin() {
  local p prefix
  p="$(command -v gemini 2>/dev/null || true)"
  if [ -n "$p" ]; then echo "$p"; return 0; fi
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -x "$prefix/bin/gemini" ]; then echo "$prefix/bin/gemini"; return 0; fi
  if [ -x "$HOME/.local/bin/gemini" ]; then echo "$HOME/.local/bin/gemini"; return 0; fi
  return 1
}

# ask PROMPT DEFAULT -- yes/no prompt. DEFAULT is "y" or "n". Reads from
# /dev/tty so it works under `curl | bash`; non-interactive shells take DEFAULT.
ask() {
  local prompt="$1" def="${2:-y}" ans=""
  if [ -r /dev/tty ] && [ -t 2 ]; then
    printf '%s ' "$prompt" > /dev/tty 2>/dev/null || printf '%s ' "$prompt"
    read -r ans < /dev/tty 2>/dev/null || ans=""
  else
    ans="$def"
  fi
  case "${ans:-$def}" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

info "6/6 — Executor check (the builders)"
HEALTHY=0
if (cd "$REPO/packages/zo-swarm-executors" && timeout 120 bun scripts/doctor.ts 2>/dev/null | grep -qE '✓.*health-command'); then
  HEALTHY=1
  pass "at least one executor is healthy"
fi
if [ "$HEALTHY" = "0" ]; then
  info ""
  info "No healthy AI builders found. The workshop drives the AI coding tools"
  info "you already pay for — it can't drive what isn't installed. Two ways"
  info "forward:"
  info "  1) Install and log into one you pay for (Claude Code, Codex, Gemini"
  info "     CLI, OpenCode, Kimi, Pi), then re-run this script."
  info "  2) Take the Gemini CLI free tier: a personal Google account, about"
  info "     1000 free requests/day, no credit card. Enough to feel the whole"
  info "     loop; paid subscriptions do the heavy work."
  info ""
  if ask "Install the Gemini CLI free tier now? [Y/n]" "y"; then
    if [ -n "$(gemini_bin || true)" ]; then
      pass "gemini CLI already installed"
    elif command -v npm >/dev/null 2>&1; then
      info "Installing @google/gemini-cli ..."
      if npm install -g @google/gemini-cli >/dev/null 2>&1 && [ -n "$(gemini_bin || true)" ]; then
        pass "gemini CLI installed"
      else
        info "Install didn't leave a usable 'gemini' binary. Try manually:"
        info "  npm install -g @google/gemini-cli"
      fi
    else
      info "npm not found — install Node.js (with npm), then run: npm install -g @google/gemini-cli"
    fi
    # Make sure the binary is on PATH: npm's global prefix often isn't
    # (nvm/fnm layouts are the exception, not the rule).
    if BIN="$(gemini_bin || true)" && [ -n "$BIN" ]; then
      BINDIR="$(dirname "$BIN")"
      case ":$PATH:" in
        *":$BINDIR:"*) ;;
        *)
          for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
            [ -f "$rc" ] || continue
            grep -qF "$BINDIR" "$rc" 2>/dev/null || echo "export PATH=\"$BINDIR:\$PATH\"" >> "$rc"
          done
          export PATH="$BINDIR:$PATH"
          info "Added $BINDIR to PATH"
          ;;
      esac
    fi
    if [ -n "$(gemini_bin || true)" ]; then
      info ""
      info "Next: run '$(gemini_bin || echo gemini)', choose 'Login with Google', finish the browser"
      info "step, then exit the CLI (/quit). It takes about a minute."
      info ""
      if ask "Have you finished the Gemini login? [y/N]" "n"; then
        if (cd "$REPO/packages/zo-swarm-executors" && timeout 120 bun scripts/doctor.ts 2>/dev/null | grep -qE '✓.*health-command'); then
          pass "gemini executor is healthy"
          if ! grep -q "SWARM_FREE_TIER" "$ZCFG/workshop.env" 2>/dev/null; then
            echo 'export SWARM_FREE_TIER="1"' >> "$ZCFG/workshop.env"
          fi
          pass "free-tier model profile on (Flash-class, quota-safe)"
        else
          info "Doctor still reports no healthy executor. Finish the 'gemini'"
          info "login, then re-run: bash scripts/bootstrap.sh"
        fi
      else
        info "No problem — run 'gemini' and log in whenever, then re-run:"
        info "  bash scripts/bootstrap.sh"
      fi
    fi
  else
    info "Skipped. The factory stays parked until an executor is healthy —"
    info "memory, hooks, and verify.sh all work without one."
  fi
fi

status "result: ok"
info ""
info "Done. Still manual (by design — they deserve your attention):"
info "  - Put OPENAI_API_KEY in $ZCFG/apis.env (mode 600)"
info "  - Walkthrough step 03: init memory DB + wire the MCP server"
info "  - Walkthrough step 05: install hooks (shadow mode)"
info "Next: walkthrough/02-core-install.md checklist, then 03-memory.md."
