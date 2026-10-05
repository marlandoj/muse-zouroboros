---
title: Wayfinder — ACP / Software Factory integration
status: in_progress
watchdog: active
started: 2026-09-28
---

# Phase 3 — Wayfinder in the Software Factory (shadow)

Goal: rank the operator's real skill catalog (`/home/workspace/Skills` + `~/.agents/skills`, 84
skills) against every task the Zouroboros factory dispatches over ACP, log the would-be skill,
and never alter the prompt. Shadow only. Learn from outcome labels, not from live injection.

## Scope

Two repos, one contract. The engine is the source of truth for ranking; the transport is a
caller. Neither embeds the other's logic.

| Repo | Path | Change |
| --- | --- | --- |
| Wayfinder | `/home/workspace/Projects/wayfinder` | `factory` harness + `outcome` command |
| Swarm (live) | `/home/workspace/zouroboros/packages/swarm` | shadow spawn + outcome label in `acp-transport.ts` |

## Why `factory` is a new harness, not a reuse of `claude`

The factory reaches Claude Code through `claude-agent-acp`. Reusing the `claude` harness label
would mix operator-driven prompts with factory-dispatched ones in `suggestions.jsonl`, so no
pick-rate or accuracy number could be attributed to a caller. A distinct harness gets its own
report row, its own mode file (`~/.wayfinder/mode.factory`) and its own live-injection format.

## Design constraints

- **Zero prompt latency.** `buildAcpPrompt` is awaited inline in the Phase 3 ACP prompt call.
  Shadow must not consume its budget. Fire-and-forget detached child, `stdio: 'ignore'`,
  `detached: true`, `unref()`.
- **Never touch the ACP stdio.** The adapter runs on `['ignore', 'pipe', 'pipe']`. A background
  child that inherits those descriptors can interleave into the JSON-RPC stream and corrupt the
  session. Detach fully or not at all.
- **Fail open, unconditionally.** Every error path returns the task text unchanged.
- **Not inside the adapter sandbox.** The shadow child is spawned by the transport before the
  contained adapter spawn, so it is not subject to bwrap/cgroup teardown.

## Tasks

- [x] Confirm live target: `bun /home/workspace/zouroboros/packages/swarm/src/api/server.ts` (pid 502)
- [x] Confirm `buildAcpPrompt` is the single prompt seam in the live tree
- [x] Confirm `claude-code` executor has no `mcpConfig`; 4 other executors do
- [ ] Add `factory` to `engine/adapters.py` HARNESSES
- [ ] Add `run.py outcome` + `outcomes.jsonl`
- [ ] Add `buildWayfinderShadow` to `acp-transport.ts`
- [ ] Add `wayfinder` to `ACPMcpConfig` and `ACPTransportConfig`
- [ ] Label outcome from observed tool calls
- [ ] Tests for both repos
- [ ] Registry config for the factory executors
- [ ] Restart service and verify a real factory prompt logs a shadow row
- [ ] Measure factory pick rate over a day of real traffic before proposing live

## Invariants to preserve

- `buildAcpPrompt` memory-gate behavior and its 1500 ms budget: untouched.
- `report` output shape: unchanged. Outcomes go to a separate file precisely so the existing
  `suggestions.jsonl` parser keeps counting prompts, not outcomes.
- Existing per-harness modes: untouched. `mode.factory` defaults to shadow.

## Status

Evidence gathering done. No code written yet.

BLOCKED: nothing. Next: engine-side `factory` harness and `outcome` command.
