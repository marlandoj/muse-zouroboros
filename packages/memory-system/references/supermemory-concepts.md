# Supermemory Concepts — Design Notes

Adapted concepts from [Supermemory](https://supermemory.ai), the #1 ranked memory API on LongMemEval/LoCoMo/ConvoMem benchmarks.

## Core Insight

> "Memory only works when it's automatic."

Before auto-capture, all 73 facts in our database were manually stored via CLI. Conversations, swarm outputs, and agent sessions produced valuable context that evaporated between sessions. Auto-capture fixes this.

## What We Took

### Auto-Capture (Enhancement 4)
Supermemory's key feature is extracting facts from every AI turn automatically. We adapted this as a **post-conversation** pipeline rather than per-turn.

**Why post-conversation instead of per-turn:**
- Full conversation context gives better extraction quality
- 1 hosted model call per conversation vs. N calls per turn
- Natural batch for contradiction detection
- Swarm runs produce a single transcript to capture once

### Contradiction Detection
Supermemory detects when new information conflicts with stored facts and handles the supersession. We replicate this: same entity+key with different value creates a `supersedes` link and halves the old fact's confidence (soft deprecation, not deletion).

### Source Tracking
Every auto-captured fact is tagged with `source: "auto-capture:{label}"` for audit. The `capture_log` table records each extraction run with hash-based dedup prevention.

## What We Didn't Take

- **Cloud API**: Supermemory is a hosted service. We also call hosted providers.
- **Per-turn extraction**: Too much overhead for our use case. Post-conversation is better.
- **Automatic forgetting**: Supermemory auto-deletes contradicted facts. We soft-deprecate (confidence *= 0.5) + create `supersedes` links, preserving history.
- **Embedding-based dedup**: Supermemory uses cosine similarity > 0.9 for semantic dedup. We use exact hash matching for now (simpler, no false positives). Could add semantic dedup later.

## Quality Safeguards

- Confidence threshold (0.6 minimum)
- Value length minimum (10 chars)
- Max 20 facts per capture
- Transcript hash prevents re-processing
- Dry-run mode for testing extraction quality
- Source tagging for audit trail
