#!/usr/bin/env bash
# Install zo-memory-system for the current user.
# Usage: bash scripts/install.sh
#
# Everything lands under your home directory (override with ZO_MEMORY_DIR /
# ZO_MEMORY_DB). Scripts run in place from this package — nothing is copied
# out of the repo, so the CLI and MCP server always match your checkout.

set -euo pipefail

echo "════════════════════════════════════════════════════════════"
echo "  Zo Memory System v3.x - Installation"
echo "════════════════════════════════════════════════════════════"
echo

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$HOME/.config/zouroboros/workshop.env" ] && source "$HOME/.config/zouroboros/workshop.env"
MEMORY_DIR="${ZO_MEMORY_DIR:-$HOME/.zo/memory}"
export ZO_MEMORY_DB="${ZO_MEMORY_DB:-$MEMORY_DIR/shared-facts.db}"

if ! command -v bun >/dev/null 2>&1; then
  echo "✘ bun not found. Install it (curl -fsSL https://bun.sh/install | bash), open a new shell, and re-run."
  exit 1
fi

# Check for OpenAI key
echo "🔍 Checking model provider configuration..."
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "  ⚠️  OPENAI_API_KEY not set — memory runs FTS5-only (exact search)."
  echo "  For semantic search, put it in ~/.config/zouroboros/apis.env (mode 600)."
else
  echo "  ✓ OPENAI_API_KEY detected"
fi

echo
echo "📁 Setting up $MEMORY_DIR ..."
mkdir -p "$MEMORY_DIR"/{personas,checkpoints}
chmod 700 "$MEMORY_DIR"

echo "📚 Installing example personas..."
for file in "$PKG_DIR/assets/examples"/*.md; do
  [ -f "$file" ] || continue
  if [ -f "$MEMORY_DIR/personas/$(basename "$file")" ]; then
    echo "  = $(basename "$file") (kept existing)"
  else
    cp "$file" "$MEMORY_DIR/personas/"
    echo "  ✓ $(basename "$file")"
  fi
done

echo "⚙️  Initializing database at $ZO_MEMORY_DB ..."
(cd "$PKG_DIR" && bun scripts/memory.ts init >/dev/null)
[ -f "$ZO_MEMORY_DB" ] || { echo "✘ database was not created at $ZO_MEMORY_DB"; exit 1; }
echo "  ✓ database ready"

echo
echo "════════════════════════════════════════════════════════════"
echo "  ✅ Installation Complete"
echo "════════════════════════════════════════════════════════════"
echo
echo "Quick start (from $PKG_DIR):"
echo "  bun scripts/memory.ts stats"
echo "  bun scripts/memory.ts search \"your query\""
echo
echo "Documentation: $PKG_DIR/README.md"
echo
