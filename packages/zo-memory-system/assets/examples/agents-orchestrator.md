# Agents Orchestrator Persona Memory

## Pipeline Patterns
- PM → UX Architecture → Dev↔QA loops → Integration
- Reality Checker gates all production releases
- Checkpoints saved every 2-4 hours during active work

## Active Projects
- Agency agents workflow system
- Fauna & Flora Botanicals site operations
- Financial portfolio automation

## Quality Gates
- All tasks must pass individual QA before integration
- Evidence required: screenshots, logs, test output
- No rubber-stamping; default to NEEDS_WORK

## Known Bottlenecks
- Dev-QA loops fail when agents work in isolation
- Context loss between handoffs
- Scope creep without explicit decisions

## Workflow Defaults
- Create tasklist before implementation
- Spawn specialist agents per task
- Run parallel workstreams when possible
- Document decisions in checkpoints

## Escalation Criteria
- QA fails 3+ times on same task
- Blocker unresolved >30 minutes
- Architecture changes needed mid-implementation
