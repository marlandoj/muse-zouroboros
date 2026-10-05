# Package inventory

Every package in this repo is a vendored snapshot — copied from a working
deployment, with machine-specific paths and dead platform references removed.
`docs/de-zo-notes.md` lists every functional change made during vendoring.

Conventions: `/home/workspace` paths in these packages refer to the Muse VM
workspace root (a platform convention, portable across Muse VMs). `$HOME`
in JSON configs means the installing user's home; `scripts/bootstrap.sh`
expands it.

## `packages/zo-memory-system` — shared memory substrate

Hybrid SQLite + vector persona memory. Episodic memory with temporal queries,
graph-boosted hybrid search, BFS path finding, knowledge-gap analysis,
auto-capture pipeline, contradiction detection with supersession, 5-tier
adaptive decay, and per-workload model routing.

- **Entry points:** `bun scripts/memory.ts` (CLI: `store`, `search`,
  `hybrid`, `episodes`, `open-loops`, `stats`), MCP server `zo-memory`
  (stdio) exposing `memory_search`, `memory_store`, `memory_episodes`,
  `memory_procedures`, `cognitive_profile`.
- **Storage:** SQLite at `~/.zo/memory/shared-facts.db` (FTS5 always;
  vector index when embeddings are available).
- **Models:** embeddings via OpenAI `text-embedding-3-small`; generation
  workloads (gate, HyDE, capture, briefing, summarization) route through
  `scripts/model-client.ts` and default to `openai:gpt-4o-mini`. Per-workload
  overrides via `ZO_MODEL_<WORKLOAD>` env vars or
  `~/.config/zouroboros/model.env`. Anthropic generation uses the direct
  Messages API with `ANTHROPIC_API_KEY`.
- **Graceful path:** no `OPENAI_API_KEY` → FTS5-only mode. Keyword search,
  fact storage, episodes, and the graph all work; embeddings, HyDE, and the
  memory gate warn and fall back.
- **Maturity:** production in the reference deployment. Full guide:
  `docs/memory.md`.

## `packages/zo-swarm-orchestrator` — multi-model DAG execution

Task orchestration across local harness executors: DAG definition, 6-signal
composite routing, circuit-breaker health checks, fallback chains, budget
governor, hash-chained decision ledger, systemd/cgroup sandboxing, and a
57-role specialist roster with persona consult.

- **Entry points:** `bun scripts/orchestrate-v5.ts` (`doctor`, `status`),
  `bun scripts/tier-resolve.ts`, MCP servers (`mcp`, `mcp-http`).
- **Tests:** `bun test src/__tests__/ src/cli/ scripts/__tests__/`
  (reference deployment: 528 pass / 15 pre-existing environmental failures).
- **Config:** `src/executor/registry/executor-registry.json` — which
  executors exist, their bridges, health checks, and timeouts.
- **Maturity:** production. The 2-task DAG smoke test passes with mutation
  verification. Full guide: `docs/swarm.md`.

## `packages/zo-swarm-executors` — the executor layer

Bridges, health checks, and registry metadata for the CLIs the orchestrator
can dispatch to: Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, Pi,
Cursor. Bridge protocol is one shell script per executor:
`bash <bridge> "<prompt>" [workdir]` → clean text on stdout.

- **Entry points:** `bun scripts/doctor.ts` (health),
  `bun scripts/test-harness.ts` (live prompt through each bridge),
  `bun scripts/register.ts list|validate`.
- **Registry:** `registry/executor-registry.json`; point the orchestrator at
  it with `SWARM_EXECUTOR_REGISTRY`.
- **Maturity:** production. Any subset of executors works; the router skips
  what's missing. Full guide: `docs/swarm.md`.

## `packages/wayfinder` — prompt-time skill suggester

Suggests which installed skill fits the user's prompt, in every CLI harness
on the host. Local BM25 + FlashRank ranking, no network, never blocks the
prompt. Shadow mode logs the would-be pick; live mode appends one suggestion
line to the model's context.

- **Entry points:** `bash scripts/install.sh` (idempotent, backs up
  configs), `bash scripts/wayfinder.sh mode live|shadow|off`,
  `bash scripts/wayfinder.sh report`.
- **Maturity:** production in shadow; live is a per-harness decision after
  reading the report. Full guide: `docs/hooks.md`.

## `packages/verity` — the "done" gate

Refuses a coding agent's finish when code changed with no passing test, build,
lint, or type-check since. Catches secrets written to files, deleted/skipped
tests, and piped test commands that hide failures. Engine is
[Canny](https://github.com/qkal/Canny) (MIT © 2026 Kal) — **not vendored**;
the installer clones it at pinned commit `f2c5e53` (v0.3.0).

- **Entry points:** installer + `scripts/verity-hook.sh <harness>`,
  shadow/live switch scoped per harness and per check.
- **Supports:** Claude Code, Codex CLI, Kimi Code, Gemini CLI. (OpenCode, Pi,
  Hermes have no finish-refusing hook.)
- **Maturity:** production in shadow; live is opt-in per check. Full guide:
  `docs/hooks.md`.

## `packages/sift` — context pruner

Conservatively shortens repeated coding-agent tool output. Protects
instructions, failures, unknown tools, and ambiguous cases; stores and
verifies originals before inserting recovery references in live mode.

- **Entry points:** installer, shadow report, live request pruning where the
  harness exposes a supported interface (OpenCode, Pi, Hermes; partial
  elsewhere — see `docs/hooks.md` for the honest per-harness table).
- **Maturity:** production in shadow; live pruning is harness-dependent.
  Full guide: `docs/hooks.md`.

## `factory/lane` — the software-factory conveyor

Linear `factory-ready` tickets → 5-field contract (fail-closed validation) →
seed YAML → swarm execution → post-flight eval + gap audit → verified PR →
Linear writeback. Includes `OPERATORS_MANUAL.md` (the full operator guide),
`MVP_PATH.md` (the minimum viable factory: one queue, one worker, one
worktree, one gate), seed examples, contracts, and the lane scripts.

- **Entry point:** `bun scripts/factory-mvp.ts smoke` — deterministic
  zero-model-calls proof the lane works.
- **Maturity:** production for the conveyor path (label-driven pull). The
  Linear-native event loops are built but deliberately disabled. Full guide:
  `docs/factory.md`.

## Consensus panel — the reviewers

Not a separate package: the panel's code ships inside `factory/lane`
(`factory-diversity-review`, `factory-review-gate`, and the consensus
scripts), because that's where it runs — reviewing finished tickets before
they become pull requests. It gets its own guide because it deserves one:
`docs/consensus-panel.md` covers the personas, shadow vs. enforce modes,
the `FACTORY_REVIEW_GATE_MODE` switch, what enforcement does and doesn't
authorize, and the qualification checklist for flipping it. The retired
model-quorum gate was deliberately excluded.

## What's deliberately not here

- **The Command Center web UI** (Terminal/Chat/Swarm Campaign/Console). It's
  an operator convenience, not part of the workshop core; the
  `examples/workshop-status.sh` read bridge covers the "is it healthy?"
  need without a web service. Wire up your own dashboard if you want one.
- **Scheduled self-improvement loops** (introspect → prescribe → evolve).
  They exist upstream but are operationally heavy; get the five systems
  above stable first.
- **Hetzner/Modal overflow executors and MoA consensus.** Retired upstream
  as mitigations for a flaky platform era — not needed on a Muse VM.
