# Walkthrough 00 — Overview

This walkthrough takes you from a bare Muse VM to a working Zouroboros
workshop, in order. Each step ends with a check that proves it worked before
you move on. Total time: an afternoon, most of it waiting on installs.

## The path

| Step | What you do | What you get |
|---|---|---|
| 01 | Prerequisites | A machine that's ready: Bun, Node, Python, CLIs, one API key |
| 02 | Core install | `scripts/bootstrap.sh`: directories, registry paths, key file |
| 03 | Memory | zo-memory storing and retrieving; MCP wired into one harness |
| 04 | Swarm | Executors healthy in `doctor`; a real 2-task DAG run |
| 05 | Hooks | wayfinder, verity, sift installed in shadow; first reports read |
| 06 | Factory | `factory-mvp.ts smoke` green; your first real ticket filed |
| 07 | Verify & operate | `scripts/verify.sh` green; the read bridge; day-two notes |

## How to use this

- **Do the steps in order.** Later steps assume earlier ones (the swarm
  needs the memory MCP config pattern; the factory needs the swarm).
- **Don't skip the checks.** Each "prove it" block is the difference
  between a workshop and a pile of files.
- **Stay in shadow.** Nothing in steps 01–05 grants any component the power
  to block, prune, or merge. Enforcement decisions come in step 07, after
  evidence.
- **Ask Muse for help.** This whole system is designed to be operated
  conversationally — "is the swarm healthy?", "file this as a factory
  ticket". If a step confuses you, paste the error into chat.

## What "done" looks like

At the end you have: one shared memory every harness can use, a dispatcher
that routes work across your model subscriptions with an audit ledger, three
prompt-time hooks observing (not enforcing), and a factory lane that turns
tickets into verified PRs. Muse remains the front door — it reads workshop
status, reads work memory, and files build tickets. The workshop never
touches your personal memory, your schedule, or your connectors.

## If something breaks

Every package keeps its own troubleshooting notes (start with its README).
The honest hierarchy for debugging:

1. `scripts/verify.sh` — tells you which system is red.
2. That system's `doctor`/status command — tells you why.
3. The package README + `docs/` — tells you what it's supposed to do.
4. Chat — paste the failing output and ask.

Begin with [01 — Prerequisites](01-prerequisites.md).
