#!/bin/bash
# Add memory support to a new Zo persona
# Usage: ./add-persona.sh [persona-name] [role-description]

set -e

PERSONA_NAME="${1:-}"
ROLE="${2:-Specialist}"

if [ -z "$PERSONA_NAME" ]; then
    echo "Usage: ./add-persona.sh [persona-name] [role-description]"
    echo "Example: ./add-persona.sh backend-architect 'System design and API architecture'"
    exit 1
fi

MEMORY_DIR="/home/workspace/.zo/memory/personas"
PERSONA_FILE="$MEMORY_DIR/$PERSONA_NAME.md"

# Create directory if needed
mkdir -p "$MEMORY_DIR"

# Check if file already exists
if [ -f "$PERSONA_FILE" ]; then
    echo "⚠️  Memory file already exists: file '.zo/memory/personas/$PERSONA_NAME.md'"
    echo "   Edit the existing file instead."
    exit 0
fi

# Create memory file
cat > "$PERSONA_FILE" << EOF
# ${PERSONA_NAME} Persona Memory

## Critical Context
- Role: ${ROLE}
- Primary responsibility: 
- Working style: 

## Active Projects
- Current: 
- Pending: 
- Blocked: 

## Preferences
- Output format: 
- Tools preferred: 
- Communication style: 
- Escalation trigger: 

## Key Facts
- 

## Decisions Made
- 
EOF

echo "✅ Created: file '.zo/memory/personas/$PERSONA_NAME.md'"
echo ""
echo "Next steps:"
echo "1. Edit the memory file: file '.zo/memory/personas/$PERSONA_NAME.md'"
echo "2. Update persona prompt with memory system instructions"
echo ""
echo "Memory system section to add to persona:"
echo ""
cat << 'INSTRUCTIONS'
**Memory System**

Before responding:
1. Check persona memory: `file '.zo/memory/personas/[persona-name].md'`
2. Search shared memory: `bun .zo/memory/scripts/memory.ts search "[keywords]"`
3. Lookup by entity: `bun .zo/memory/scripts/memory.ts lookup --entity "[type]"`

Store new facts discovered:
```bash
bun .zo/memory/scripts/memory.ts store \
  --persona "[persona-name]" \
  --entity "[entity]" \
  --key "[name]" \
  --value "[value]" \
  --decay [permanent|stable|active|session]
```
INSTRUCTIONS
