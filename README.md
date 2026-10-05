# Zouroboros for Muse

**The workshop behind your personal AI.** Zouroboros is agent infrastructure —
multi-model dispatch, a shared memory substrate, a verified software factory,
and prompt-time quality hooks — packaged so any Muse user can install it on
their own Muse VM and let Muse call into it.

The one-line thesis: **Muse is the front door; Zouroboros is the workshop.**
Muse owns the relationship layer — conversation, connectors, scheduling,
personal memory, approvals. Zouroboros owns the building layer — running work
across several model harnesses, remembering what the work taught, verifying
before it ships. Muse calls into the workshop; the workshop reports back.

## What's in this repo

| Path | What it is |
|---|---|
| `packages/zo-memory-system` | Hybrid SQLite + vector memory (episodic, procedural, graph) with an MCP server every harness can share |
| `packages/zo-swarm-orchestrator` | Multi-model DAG task execution with health-routed fallback chains, budget governor, and a hash-chained decision ledger |
| `packages/zo-swarm-executors` | Local executor layer: bridge scripts, health checks, and registry for Claude Code, Codex, OpenCode, Hermes, Gemini, Kimi, Pi, Cursor |
| `packages/wayfinder` | Prompt-time skill suggester (shadow or live) for every harness |
| `packages/verity` | "Done" gate: refuses an agent's finish when tests/builds haven't passed since the last edit (shadow or live) |
| `packages/sift` | Context pruner: shortens repeated tool output with recoverable evidence (shadow or live) |
| `factory/lane` | The software-factory conveyor: Linear `factory-ready` tickets → contract → swarm build → verified PR |
| `docs/` | Implementation documentation: architecture, per-component guides, security model, de-Zo porting notes |
| `walkthrough/` | Step-by-step guide for Muse users, from prerequisites to day-two operations |
| `scripts/` | `bootstrap.sh` (installer) and `verify.sh` (post-install smoke checks) |
| `examples/` | Ready-made bridge scripts, including a workshop status reporter Muse can run |

## Start here

1. Read `docs/architecture.md` (10 minutes) — the mental model everything else hangs on.
2. Follow `walkthrough/` in order — it takes you from a bare Muse VM to a working workshop.
3. Run `scripts/verify.sh` when you're done — it proves each piece is alive.

## Requirements

- A Muse VM (or any Linux host with the same shape: persistent home directory, shell, network)
- Bun (for the memory system and swarm) and Node 22+ / Python 3.11+ (for the hooks)
- One API key to start: `OPENAI_API_KEY` (embeddings + default generation). Everything else is optional and degrades gracefully.
- Agent CLIs you want as executors, installed and authenticated your usual way: Claude Code, Codex CLI, OpenCode, Hermes, Gemini CLI, Kimi, Pi, or Cursor — any subset works; the health router skips what's missing.

## Design principles

- **Local-first.** SQLite, local files, stdio MCP. No platform account, no control plane to phone home to.
- **Graceful degradation everywhere.** No embeddings key? FTS5 keyword search still works. An executor unhealthy? The router fails over. A hook crashes? It answers `{}` and the agent carries on.
- **Shadow before live.** Every hook and every review gate starts in a mode that only observes. You flip to enforcement after reading the evidence.
- **Fail closed where it matters.** The factory rejects tickets with missing contracts, unknown costs, or ambiguous authority — never a permissive default.
- **Your subscriptions, your arbitrage.** Heavy token work runs on the model subscriptions you already pay for; the orchestrator layer stays thin.

## Status

This is a working system extracted from a live deployment, not a demo. The
packages are vendored snapshots with machine-specific paths and dead platform
references removed (see `docs/de-zo-notes.md` for exactly what changed). Some
edges are still rough — the walkthrough marks every known one honestly.

## License

MIT. See `LICENSE`. Verity builds on [Canny](https://github.com/qkal/Canny)
(MIT © 2026 Kal), which its installer clones at a pinned commit rather than
vendoring.
