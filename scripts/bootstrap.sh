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
# >>> prerequisite preflight — the same block lives in scripts/quickstart.sh
# and scripts/bootstrap.sh (quickstart runs before the repo exists, so it
# cannot source a shared file). Change both copies together.
#
# Looks on PATH first, then in the per-user bin dirs that installers use but
# non-interactive shells (ssh, cron, curl | bash) never put on PATH — the
# bun.sh installer, for one, only edits your interactive shell profile. A
# tool found off PATH goes on PATH for this run only. Installs nothing, runs
# no sudo, makes no network calls: on a miss it prints the exact commands
# for a human to run. Callers define pf_ok MSG, pf_bad MSG and PF_RERUN.
PF_DIRS=("$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/bin")
PF_LOOKED="PATH, ~/.bun/bin, ~/.local/bin, ~/bin"

# pf_version TOOL PATH -- print the version a versioned runtime reports
# (stdin closed: under curl | bash, stdin is the script itself).
pf_version() {
  case "$1" in
    python3) "$2" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' </dev/null 2>/dev/null || true ;;
    bun|node) { "$2" --version </dev/null 2>/dev/null || true; } | head -n 1 ;;
  esac
}
pf_any() { return 0; }
pf_node_ok() {
  local v; v="$(pf_version node "$1")"; v="${v#v}"; v="${v%%.*}"
  case "$v" in ''|*[!0-9]*) return 1 ;; esac
  [ "$v" -ge 22 ]
}
pf_py_ok() {
  local v maj min; v="$(pf_version python3 "$1")"; maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  case "$maj$min" in ''|*[!0-9]*) return 1 ;; esac
  [ "$maj" -gt 3 ] || { [ "$maj" -eq 3 ] && [ "$min" -ge 11 ]; }
}

# pf_locate TOOL OKFN -- set PF_PATH to the first candidate (PATH, then
# PF_DIRS) that OKFN accepts and make sure it is the one PATH resolves. If
# candidates exist but none is new enough, PF_PATH is the first and
# PF_TOO_OLD=1. Returns 1 when the tool is nowhere.
pf_locate() {
  local t="$1" okfn="$2" onpath c d
  local cands=()
  PF_PATH="" PF_TOO_OLD=0 PF_OFF=0
  onpath="$(command -v "$t" 2>/dev/null || true)"
  [ -n "$onpath" ] && cands+=("$onpath")
  for d in "${PF_DIRS[@]}"; do
    if [ -f "$d/$t" ] && [ -x "$d/$t" ] && [ "$d/$t" != "$onpath" ]; then cands+=("$d/$t"); fi
  done
  [ "${#cands[@]}" -gt 0 ] || return 1
  for c in "${cands[@]}"; do
    if "$okfn" "$c"; then PF_PATH="$c"; break; fi
  done
  if [ -z "$PF_PATH" ]; then PF_PATH="${cands[0]}"; PF_TOO_OLD=1; return 0; fi
  if [ "$PF_PATH" != "$onpath" ]; then
    PATH="$(dirname "$PF_PATH"):$PATH"; export PATH; hash -r
    PF_OFF=1
  fi
  return 0
}

# pf_check TOOL OKFN WANT -- report one tool through pf_ok / pf_bad.
pf_check() {
  local t="$1" okfn="$2" want="$3" label="$1" v
  [ "$t" = timeout ] && label="timeout (GNU coreutils)"
  [ "$t" = unzip ] && label="unzip (the bun installer needs it)"
  if ! pf_locate "$t" "$okfn"; then
    pf_bad "$label not found (looked on $PF_LOOKED)"; pf_need "$t" missing; return 0
  fi
  v="$(pf_version "$t" "$PF_PATH")"
  if [ "$PF_TOO_OLD" = 1 ]; then
    pf_bad "$label ${v:-(unknown version)} at $PF_PATH is too old — need $want"; pf_need "$t" old "$v"; return 0
  fi
  if [ "$PF_OFF" = 1 ]; then
    pf_ok "$label${v:+ $v} — found at $PF_PATH (not on your PATH; added for this run)"
  else
    pf_ok "$label${v:+ $v}"
  fi
}
pf_need() {
  PF_MISSING="$PF_MISSING $1"
  case "$1" in
    bun) PF_NEED_BUN=1 ;;
    node) PF_NEED_NODE=1 ;;
    python3) if [ "$2" = old ]; then PF_OLD_PY="$3"; else PF_NEED_SYS=1; fi ;;
    *) PF_NEED_SYS=1 ;;
  esac
}

# pf_check_all -- check every prerequisite; returns 1 if any is missing/too old.
pf_check_all() {
  PF_MISSING="" PF_NEED_BUN=0 PF_NEED_NODE=0 PF_NEED_SYS=0 PF_OLD_PY=""
  pf_check bun pf_any ""
  # unzip is not a runtime prerequisite: only the bun.sh installer needs it,
  # so it is checked (and reported) only when that installer will be printed.
  [ "$PF_NEED_BUN" = 1 ] && pf_check unzip pf_any ""
  pf_check node pf_node_ok "22 or higher"
  pf_check python3 pf_py_ok "3.11 or higher"
  pf_check git pf_any ""
  pf_check jq pf_any ""
  pf_check timeout pf_any ""
  [ -z "$PF_MISSING" ]
}

# pf_family -- distro family from os-release ID / ID_LIKE (read, not sourced).
# ZO_OS_RELEASE overrides the file path (tests only).
pf_family() {
  local f="${ZO_OS_RELEASE:-/etc/os-release}" id="" like="" w
  if [ -r "$f" ]; then
    id="$(sed -n 's/^ID=//p' "$f" | tr -d '"'\' | head -n 1)"
    like="$(sed -n 's/^ID_LIKE=//p' "$f" | tr -d '"'\' | head -n 1)"
  fi
  PF_DISTRO="${id:-unknown}" PF_FAMILY=generic
  for w in $id $like; do
    case "$w" in
      debian|ubuntu) PF_FAMILY=debian; return 0 ;;
      fedora|rhel|centos) PF_FAMILY=fedora; return 0 ;;
      arch) PF_FAMILY=arch; return 0 ;;
    esac
  done
  return 0
}

# pf_print_fixes -- ONE block: what is missing and the exact commands that
# install it on this distro family. Printed only; never executed here.
pf_print_fixes() {
  local fam
  pf_family
  case "$PF_FAMILY" in
    debian) fam="Debian/Ubuntu family" ;;
    fedora) fam="Fedora/RHEL family" ;;
    arch) fam="Arch family" ;;
    *) fam="unrecognised family — generic instructions" ;;
  esac
  printf '\n================================================================\n'
  printf 'MISSING PREREQUISITES:%s\n' "$PF_MISSING"
  printf 'Detected OS: %s (%s)\n' "$PF_DISTRO" "$fam"
  printf '%s\n' "This installer never installs prerequisites and never runs sudo." \
    "Run the commands below yourself (already root? drop the \"sudo\")," \
    "then re-run: $PF_RERUN" \
    "================================================================"
  if [ "$PF_NEED_SYS" = 1 ]; then
    printf '\n# git, python3, jq, timeout (coreutils), unzip — one line covers them all;\n'
    printf '# ones you already have are left as they are\n'
    case "$PF_FAMILY" in
      debian) printf '%s\n' 'sudo apt-get update && sudo apt-get install -y git python3 jq coreutils unzip' ;;
      fedora) printf '%s\n' 'sudo dnf install -y git python3 jq coreutils unzip' ;;
      arch) printf '%s\n' 'sudo pacman -Syu --needed git python jq coreutils unzip' ;;
      *) printf '%s\n' '# packages: git, python3 (3.11 or newer), jq, coreutils (provides timeout), unzip' \
           '# upstream: https://git-scm.com/downloads  https://www.python.org/downloads/' \
           '#           https://jqlang.github.io/jq/download/  https://www.gnu.org/software/coreutils/' ;;
    esac
  fi
  if [ "$PF_NEED_NODE" = 1 ]; then
    printf '\n# Node.js 22 or newer\n'
    case "$PF_FAMILY" in
      debian) printf '%s\n' 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -' \
                'sudo apt-get install -y nodejs' ;;
      fedora) printf '%s\n' 'curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -' \
                'sudo dnf install -y nodejs' ;;
      arch) printf '%s\n' 'sudo pacman -Syu --needed nodejs npm' ;;
      *) printf '%s\n' '# package: nodejs 22 or newer (plus npm) from your OS package manager if it' \
           '# ships 22+, otherwise the official builds: https://nodejs.org/en/download' ;;
    esac
    printf '%s\n' 'node --version   # must report v22 or higher'
  fi
  if [ "$PF_NEED_BUN" = 1 ]; then
    printf '\n# bun — official installer, every distro, no sudo needed\n'
    printf '# needs unzip (from the system-tools step above)\n'
    printf '%s\n' 'curl -fsSL https://bun.sh/install | bash' \
      'export PATH="$HOME/.bun/bin:$PATH"   # this shell; or just open a new shell'
  fi
  if [ -n "$PF_OLD_PY" ]; then
    printf '\n# python3 here is %s; the workshop needs 3.11 or newer.\n' "$PF_OLD_PY"
    case "$PF_FAMILY" in
      debian) printf '%s\n' '# Debian 12+ and Ubuntu 23.04+ ship 3.11+ as python3. On Ubuntu 22.04:' \
                'sudo apt-get update && sudo apt-get install -y python3.11' \
                'mkdir -p ~/.local/bin && ln -sf /usr/bin/python3.11 ~/.local/bin/python3   # the installer looks here' ;;
      fedora) printf '%s\n' 'sudo dnf install -y python3.11' \
                'mkdir -p ~/.local/bin && ln -sf /usr/bin/python3.11 ~/.local/bin/python3   # the installer looks here' ;;
      arch) printf '%s\n' 'sudo pacman -Syu --needed python' ;;
      *) printf '%s\n' '# install Python 3.11 or newer (OS packages, or https://www.python.org/downloads/),' \
           '# then make python3 resolve to it, e.g.: ln -sf "$(command -v python3.11)" ~/.local/bin/python3' ;;
    esac
    printf '%s\n' 'python3 --version   # must report 3.11 or higher'
  fi
  printf '================================================================\n'
}
# <<< prerequisite preflight

info "1/5 — Checking prerequisites (bun, node 22+, python3 3.11+, git, jq, timeout)"
pf_ok() { pass "$1"; }
pf_bad() { fail "$1"; }
PF_RERUN="bash scripts/bootstrap.sh"
pf_check_all || true
if [ "$MISSING" -eq 1 ]; then
  pf_print_fixes
  info "Fix the missing prerequisites, then re-run."
  status "result: failed (prerequisites)"
  exit 1
fi

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
