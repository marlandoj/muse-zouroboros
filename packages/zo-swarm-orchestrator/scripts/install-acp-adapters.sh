#!/usr/bin/env bash
# install-acp-adapters.sh — Install ACP adapter binaries for Zouroboros swarm executors
#
# Required adapters:
#   claude-agent-acp  @zed-industries/claude-agent-acp  — ACP adapter for Claude Code
#   codex-acp         @zed-industries/codex-acp         — ACP adapter for Codex CLI
#   gemini --acp      @google/gemini-cli                — Gemini CLI with built-in ACP mode
#
# Usage:
#   ./install-acp-adapters.sh           # install all adapters
#   ./install-acp-adapters.sh --check   # verify adapters are installed (exit 0 = ok, 1 = missing)
#   ./install-acp-adapters.sh --update  # update all adapters to latest versions

set -euo pipefail

CHECK_ONLY=false
UPDATE=false

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=true ;;
    --update) UPDATE=true ;;
    -h|--help)
      echo "Usage: $0 [--check|--update]"
      echo ""
      echo "  (no args)  Install all ACP adapters (skips already-installed)"
      echo "  --check    Verify all adapters are installed (non-destructive)"
      echo "  --update   Update all adapters to latest npm versions"
      exit 0
      ;;
  esac
done

# Adapters: name | npm_package | min_version | binary | check_args
declare -a ADAPTERS=(
  "claude-agent-acp|@zed-industries/claude-agent-acp|0.23.0|claude-agent-acp|--help"
  "codex-acp|@zed-industries/codex-acp|0.16.0|codex-acp|--help"
  "gemini-cli|@google/gemini-cli|0.45.2|gemini|--version"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_ok()   { echo -e "${GREEN}✓${NC} $*"; }
log_warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
log_err()  { echo -e "${RED}✗${NC} $*"; }
log_info() { echo -e "${BLUE}→${NC} $*"; }

MISSING=()

echo ""
echo "Zouroboros ACP Adapter Installer"
echo "================================="
echo ""

for entry in "${ADAPTERS[@]}"; do
  IFS='|' read -r name pkg min_version binary check_args <<< "$entry"

  if command -v "$binary" &>/dev/null; then
    if $CHECK_ONLY; then
      log_ok "$name ($binary) — installed"
    elif $UPDATE; then
      log_info "Updating $name ($pkg)..."
      npm install -g "$pkg" --quiet
      log_ok "$name updated"
    else
      log_ok "$name ($binary) — already installed, skipping"
    fi
  else
    MISSING+=("$name")
    if $CHECK_ONLY; then
      log_err "$name ($binary) — NOT FOUND (install with: npm install -g $pkg)"
    else
      log_info "Installing $name ($pkg >= $min_version)..."
      npm install -g "$pkg" --quiet
      if command -v "$binary" &>/dev/null; then
        log_ok "$name installed successfully"
      else
        log_err "$name installed but binary '$binary' not found in PATH"
        log_warn "  Try: export PATH=\$PATH:\$(npm prefix -g)/bin"
      fi
    fi
  fi
done

echo ""

if $CHECK_ONLY; then
  if [ ${#MISSING[@]} -eq 0 ]; then
    echo -e "${GREEN}All ACP adapters are installed.${NC}"
    exit 0
  else
    echo -e "${RED}Missing adapters: ${MISSING[*]}${NC}"
    echo ""
    echo "Run without --check to install them:"
    echo "  $(dirname "$0")/install-acp-adapters.sh"
    exit 1
  fi
fi

echo "Verifying ACP mode support..."
echo ""

# Verify gemini supports --acp flag
if command -v gemini &>/dev/null; then
  if gemini --help 2>&1 | grep -q "\-\-acp"; then
    log_ok "gemini --acp flag confirmed"
  else
    log_warn "gemini is installed but --acp flag not detected (version may be too old)"
    log_warn "  Upgrade with: npm install -g @google/gemini-cli"
  fi
fi

echo ""
echo -e "${GREEN}Done.${NC} Run the swarm doctor to validate:"
echo "  bun packages/swarm/src/executor/doctor.ts"
