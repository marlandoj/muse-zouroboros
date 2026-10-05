# Wikilink Best Practices for Zouroboros Memory System

**Version:** 1.0  
**Date:** March 25, 2026  
**Applies to:** `Skills/zo-memory-system/`, vault integration, cross-system compatibility

---

## Overview

Wikilinks (`[[entity]]`) are first-class citizens in the Zouroboros memory system. They create queryable connections between facts, enable graph-boosted search, and provide context for continuation recall.

This guide standardizes wikilink syntax across the Zo ecosystem, ensuring compatibility between:
- Zouroboros memory system
- Zo Space `/vault` dashboard
- Future Ori-Mnemos integration
- Obsidian vault exports

---

## Syntax Standards

### Basic Wikilink

```markdown
[[entity]]
```

Links to the entity namespace. All facts with this entity are implicitly connected.

### Wikilink with Display Text

```markdown
[[entity|Display Text]]
```

Shows "Display Text" but links to "entity". Used when you want human-readable text with machine-parseable entity reference.

**Example:**
```markdown
The [[project.ffb|FFB Website Project]] is our top priority.
```

Renders as: "The FFB Website Project is our top priority."
Links to: entity `project.ffb`

### Entity.Key Wikilink

```markdown
[[entity.key]]
```

Links to a specific fact by entity + key combination.

**Example:**
```markdown
See [[project.ffb.hosting]] for the hosting decision.
```

### Typed Relations (Advanced)

```markdown
[[entity|relation:depends_on]]
```

Creates a typed edge in the knowledge graph. Used explicitly in `graph.ts link` commands.

**Supported relation types:**
| Relation | Meaning | Example |
|----------|---------|---------|
| `related` | General association (default) | `[[project.ffb]]` |
| `depends_on` | Hard dependency | `depends_on: [[project.ffb.api]]` |
| `supersedes` | Replaces/contradicts | `supersedes: [[decision.v1]]` |
| `co-captured` | Extracted together | (auto-added by auto-capture) |

---

## Entity Naming Conventions

### Hierarchical Namespacing

Use dot-notation for hierarchical organization:

```
project.{name}       # Projects
system.{component}   # System components  
user.{attribute}     # User preferences/facts
decision.{topic}     # Key decisions
executor.{name}      # Agent/persona executors
feature.{name}       # Feature flags/work
```

### Examples

| Entity | Meaning |
|--------|---------|
| `project.ffb` | Fauna & Flora Botanicals project |
| `project.ffb.website` | FFB website subproject |
| `system.zo.memory` | Zo memory system component |
| `user.preference.theme` | User theme preference |
| `decision.hosting` | Hosting provider decision |
| `executor.claude-code` | Claude Code executor history |

### Key Naming

Use snake_case for keys within entities:

```
project.ffb.website.status
project.ffb.website.launch_date
```

---

## Usage Patterns

### In Fact Values

When storing facts, include wikilinks to related entities:

```bash
bun scripts/memory.ts store \
  --entity "decision.hosting" \
  --key "rationale" \
  --value "Chose [[system.zo]] over [[provider.aws]] due to simpler ops"
```

This automatically:
1. Creates graph links between `decision.hosting` and `system.zo`
2. Creates graph links between `decision.hosting` and `provider.aws`
3. Enables graph-boosted search for either entity

### In Open Loops

Reference related entities in open loop summaries:

```bash
bun scripts/memory.ts open-loops \
  --title "Fix [[system.zo.memory]] gate latency" \
  --summary "Investigate why [[model.qwen2.5]] takes 4s for HyDE expansion"
```

### In Episode Summaries

Tag episodes with entities for temporal queries:

```typescript
createEpisodeRecord(db, {
  summary: "Implemented [[feature.tarjan]] for open loop protection",
  entities: ["feature.tarjan", "system.zo.memory"],
  outcome: "success",
  happenedAt: Date.now()
});
```

---

## Cross-System Compatibility

### Obsidian Export/Import

Zouroboros wikilinks are Obsidian-compatible:

| Zouroboros | Obsidian | Notes |
|------------|----------|-------|
| `[[entity]]` | `[[entity]]` | Direct match |
| `[[entity\|display]]` | `[[entity\|display]]` | Direct match |
| `[[entity.key]]` | `[[entity.key]]` | Works as plain text |

**Importing Obsidian vaults:**
```bash
bun scripts/memory.ts import --source obsidian --path ~/Vault
```

**Exporting for Obsidian:**
Facts are stored as markdown files with wikilinks preserved.

### Ori-Mnemos Future Integration

Planned unified syntax:

| System | Current | Unified (Future) |
|--------|---------|------------------|
| Ori-Mnemos | `[[Note Name]]` | `[[entity\|Note Name]]` |
| Zouroboros | `[[entity]]` | `[[entity]]` (unchanged) |
| Unified | — | `[[entity.key\|Display]]` |

---

## Anti-Patterns

### ❌ Don't: Use spaces in entities

```markdown
<!-- BAD -->
[[FFB Project]]

<!-- GOOD -->
[[project.ffb|FFB Project]]
```

### ❌ Don't: Create orphan entities

```markdown
<!-- BAD - links to non-existent entity -->
[[old.project]]  <!-- Never stored a fact for this -->

<!-- GOOD - only link to entities with facts -->
[[project.ffb]]  <!-- Has stored facts -->
```

### ❌ Don't: Over-link

```markdown
<!-- BAD - excessive links dilute signal -->
The [[system.zo]] [[memory]] [[system]] uses [[sqlite]] for [[storage]]

<!-- GOOD - meaningful connections -->
The [[system.zo.memory]] uses SQLite for graph storage
```

### ❌ Don't: Link to transient identifiers

```markdown
<!-- BAD - ephemeral ID -->
[[session-2026-03-25-abc123]]

<!-- GOOD - semantic entity -->
[[session.deploy-issue]]
```

---

## Graph Quality Guidelines

### Target Metrics

| Metric | Target | Tool |
|--------|--------|------|
| Linked facts | >30% of total | `bun scripts/graph.ts knowledge-gaps` |
| Orphan facts | <20% of total | `bun scripts/graph.ts knowledge-gaps` |
| Articulation points | <10% of linked | `bun scripts/tarjan.ts analyze` |
| Connected components | <5 | `bun scripts/graph.ts knowledge-gaps` |

### Maintenance Commands

```bash
# Analyze knowledge gaps
bun scripts/graph.ts knowledge-gaps

# Find articulation points
bun scripts/tarjan.ts analyze

# Find connections between entities
bun scripts/graph.ts find-connections --from "project.ffb" --to "system.zo"

# Auto-link related facts (heuristic)
bun scripts/memory.ts consolidate
```

---

## Migration Guide

### From Plain Text

1. Identify key entities in your facts
2. Add wikilinks incrementally:
   ```bash
   # Before
   --value "FFB website needs Shopify integration"
   
   # After
   --value "[[project.ffb]] website needs [[platform.shopify]] integration"
   ```

3. Run graph analysis to validate:
   ```bash
   bun scripts/graph.ts knowledge-gaps
   ```

### From Obsidian

1. Import vault:
   ```bash
   bun scripts/memory.ts import --source obsidian --path ~/Vault
   ```

2. Review imported entities:
   ```bash
   bun scripts/memory.ts lookup --entity "project.ffb"
   ```

3. Normalize entity names:
   ```bash
   # Manually or via script - convert "FFB Project" to "project.ffb"
   ```

---

## Tools Reference

| Tool | Purpose |
|------|---------|
| `graph.ts link` | Create explicit typed links |
| `graph.ts show` | View links for entity |
| `graph.ts find-connections` | BFS path finding |
| `graph.ts knowledge-gaps` | Orphan/dead-end analysis |
| `tarjan.ts analyze` | Articulation point detection |
| `memory.ts hybrid` | Graph-boosted search |
| `vault-link-parser.ts` | Parse wikilinks from text |

---

## Examples by Use Case

### Project Management

```markdown
[[project.ffb]] depends on [[supplier.organic-botanicals]]
[[decision.hosting]] chose [[provider.zo]] over [[provider.aws]]
[[milestone.ffb-launch]] blocked by [[issue.compliance-review]]
```

### Decision Tracking

```markdown
[[decision.database]]: Chose [[db.sqlite]] for [[criteria.simplicity]]
[[decision.framework]]: Chose [[framework.react]] over [[framework.vue]]
```

### Incident Response

```markdown
[[incident.2026-03-25]]: [[system.zo.memory]] gate timeout
[[incident.2026-03-25.cause]]: [[model.qwen2.5]] cold start
[[incident.2026-03-25.resolution]]: Increased [[config.keep_alive]]
```

### Agent/Persona Context

```markdown
[[executor.claude-code]] prefers [[style.terse]] responses
[[persona.alaric]] handles [[domain.system-ops]]
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-25 | Initial Phase 1 documentation |

---

## Related Documentation

- `SKILL.md` — Full memory system documentation
- `references/graphthulhu-concepts.md` — Graph theory design notes
- `scripts/vault-link-parser.ts` — Wikilink parsing implementation
