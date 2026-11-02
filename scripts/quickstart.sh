#!/usr/bin/env bash
# quickstart.sh — the one-command Zouroboros installer, built for chat.
#
# Usage (paste into a terminal):
#   curl -fsSL https://raw.githubusercontent.com/marlandoj/muse-zouroboros/main/scripts/quickstart.sh | bash
#
# Needs only bash and curl to start. (`npx -y muse-zouroboros@latest` runs
# this same script, but npx itself needs Node already installed.)
#
# What it does:
#   0. Preflight, before touching git or disk: checks bun, node 22+,
#      python3 3.11+, git, jq and timeout (GNU coreutils) — plus unzip when
#      bun is missing, since the bun installer needs it. It looks on PATH,
#      then in ~/.bun/bin, ~/.local/bin and ~/bin (non-interactive shells
#      often lack those on PATH) and uses what it finds there for this run.
#      If anything is missing or too old it prints ONE block naming each
#      tool with the exact install commands for your distro, then stops —
#      no directory created, nothing cloned. It installs none of them.
#   1. Clones (or updates) the repo to ~/workspace/muse-zouroboros
#   2. Runs scripts/bootstrap.sh (interactive — it will ask you questions)
#   3. Runs scripts/verify.sh
#   4. Prints a CONCIERGE HANDOFF block — paste the whole block to Muse,
#      and Muse walks you through whatever is red.
#
# What it never does: no sudo, no installing prerequisites (it prints the
# commands; you run them), no keys leave your machine, no background
# services. The only network installs are npm/bun packages, and the optional
# Gemini CLI free tier (only if you say yes).
set -uo pipefail

REPO_URL="https://github.com/marlandoj/muse-zouroboros.git"
TARGET="${1:-$HOME/workspace/muse-zouroboros}"

say() { printf '%s\n' "$1"; }

say "== Zouroboros quickstart =="
say ""

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

# 0. Preflight — before any git work, so a miss leaves nothing behind.
say "-- checking prerequisites (this installs nothing)"
pf_ok() { say "  ✔ $1"; }
pf_bad() { say "  ✘ $1"; }
PF_RERUN="the same quickstart command (curl or npx)"
if ! pf_check_all; then
  pf_print_fixes
  exit 1
fi
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
STATUS_FILE="$(mktemp "${TMPDIR:-/tmp}/zo-bootstrap.XXXXXX")"
trap 'rm -f "$STATUS_FILE"' EXIT
ZO_BOOTSTRAP_STATUS="$STATUS_FILE" bash "$TARGET/scripts/bootstrap.sh"
BOOTSTRAP_RC=$?
say ""
if [ "$BOOTSTRAP_RC" -eq 0 ]; then
  BOOTSTRAP="ok"
else
  BOOTSTRAP="FAILED (exit $BOOTSTRAP_RC)"
fi
# Prerequisites/warnings bootstrap reported, one line each, for the handoff.
BOOTSTRAP_NOTES="$(grep -E '^(missing|warn):' "$STATUS_FILE" 2>/dev/null | tr '\n' ';' || true)"

# 3. Verify (pointless without a completed bootstrap)
if [ "$BOOTSTRAP_RC" -eq 0 ]; then
  say "-- verifying"
  VERIFY_OUT="$(bash "$TARGET/scripts/verify.sh" 2>&1 || true)"
  printf '%s\n' "$VERIFY_OUT"
else
  VERIFY_OUT=""
fi
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
[ "$BOOTSTRAP_RC" -eq 0 ] || SUMMARY="skipped (bootstrap failed)"

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
bootstrap: $BOOTSTRAP
bootstrap_notes: ${BOOTSTRAP_NOTES:-none}
free_tier: $FREE_TIER
cli_present:$CLIS
verify: $SUMMARY
--- END HANDOFF ---
================================================================
EOF

if [ "$BOOTSTRAP_RC" -ne 0 ]; then
  cat <<EOF

What just happened: the workshop is NOT installed — bootstrap stopped
(exit $BOOTSTRAP_RC). Fix what it marked ✘ above (for a missing
prerequisite it prints the exact install commands), and re-run this
installer. Paste the handoff to Muse if you want help with the fix.
EOF
  exit "$BOOTSTRAP_RC"
fi

cat <<EOF

What just happened: the workshop is installed. Paste the handoff to
Muse — Muse reads what's green and red, and guides you through your
first three wins (shared memory, a factory ticket, health at a glance).
Full manual, if you ever want it: $TARGET/walkthrough/00-quickstart.md
EOF
