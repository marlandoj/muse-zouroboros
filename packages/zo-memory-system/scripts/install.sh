#!/bin/bash
# Install zo-memory-system skill into workspace
# Usage: ./install.sh

set -e

echo "════════════════════════════════════════════════════════════"
echo "  Zo Memory System v3.x - Installation"
echo "════════════════════════════════════════════════════════════"
echo

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_DIR="/home/workspace"
MEMORY_DIR="$WORKSPACE_DIR/.zo/memory"

# Check for OpenAI key
echo "🔍 Checking model provider configuration..."
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "  ⚠️  OPENAI_API_KEY not set. OpenAI-backed gate/extraction/embedding calls will fail."
  echo "  Add it in Zo Secrets or the service env_vars before enabling the memory services."
else
  echo "  ✓ OPENAI_API_KEY detected"
fi

echo
echo "📁 Setting up directories..."
mkdir -p "$MEMORY_DIR"/{personas,checkpoints,scripts}

echo "📋 Installing scripts..."
cp "$SKILL_DIR/scripts/memory.ts" "$MEMORY_DIR/scripts/"
cp "$SKILL_DIR/scripts/continuation.ts" "$MEMORY_DIR/scripts/"
cp "$SKILL_DIR/scripts/schema.sql" "$MEMORY_DIR/scripts/"
cp "$SKILL_DIR/scripts/migrate-v3.sql" "$MEMORY_DIR/scripts/"
cp "$SKILL_DIR/scripts/rollback-v3.sql" "$MEMORY_DIR/scripts/"
cp "$SKILL_DIR/scripts/add-persona.sh" "$MEMORY_DIR/scripts/"
cp "$SKILL_DIR/scripts/demo.ts" "$MEMORY_DIR/scripts/"
chmod +x "$MEMORY_DIR/scripts/add-persona.sh"

echo "📚 Installing examples..."
for file in "$SKILL_DIR/assets/examples"/*.md; do
  if [ -f "$file" ]; then
    cp "$file" "$MEMORY_DIR/personas/"
    echo "  ✓ $(basename "$file")"
  fi
done

echo "⚙️  Initializing database..."
cd "$WORKSPACE_DIR"
if [ ! -f "$MEMORY_DIR/shared-facts.db" ]; then
  bun "$MEMORY_DIR/scripts/memory.ts" init 2>/dev/null || echo "  Database will be created on first use"
fi

echo "📝 Creating workspace AGENTS.md..."
if [ ! -f "$WORKSPACE_DIR/AGENTS.md" ]; then
  cat > "$WORKSPACE_DIR/AGENTS.md" << 'EOF'
# Zo Computer Workspace Memory

## Memory System Reference

This workspace uses a **hybrid SQLite + Vector memory system** (v2.1) for persona continuity.

### Quick Commands

```bash
# Store a fact
bun .zo/memory/scripts/memory.ts store \
  --entity "user" --key "preference" --value "value" --decay permanent

# Hybrid search (semantic + exact)
bun .zo/memory/scripts/memory.ts hybrid "query"

# Fast exact search
bun .zo/memory/scripts/memory.ts search "query" --no-hyde

# View stats
bun .zo/memory/scripts/memory.ts stats
```

### Decay Tiers

| Tier | TTL | Use Case |
|------|-----|----------|
| `permanent` | Never | Core user facts, preferences |
| `stable` | 90 days | Preferences, recurring decisions |
| `active` | 14 days | Current projects, tasks |
| `session` | 24 hours | Temporary context |
| `checkpoint` | 4 hours | Task state snapshots |

### Persona Memory Files

Critical facts for each persona are stored in:
- `file '.zo/memory/personas/[persona-name].md'`

These are lean (20-30 facts) and always loaded with the persona.

### Shared Memory Database

All other facts go into SQLite at `file '.zo/memory/shared-facts.db'`:
- Cross-persona facts use `--persona shared`
- Persona-specific facts use `--persona [name]`
EOF
  echo "  ✓ Created AGENTS.md"
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "  ✅ Installation Complete"
echo "════════════════════════════════════════════════════════════"
echo
echo "Quick start:"
echo "  bun .zo/memory/scripts/memory.ts stats"
echo "  bun .zo/memory/scripts/memory.ts hybrid \"your query\""
echo
echo "Documentation:"
echo "  file 'Skills/zo-memory-system/SKILL.md'"
echo
