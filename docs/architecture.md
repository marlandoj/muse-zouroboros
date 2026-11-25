# Architecture: the front door and the workshop

## The problem this solves

Your AI client — the assistant you chat with every day — is good at being a
personal agent, but it is usually one model family doing everything inline:
it writes your code, remembers your preferences, keeps track of your
schedule, and talks to your apps. That coherence is its strength — and its
ceiling. Some jobs want a different shape:

- **Breadth of models.** You already pay for Claude Max, ChatGPT, and API
  credits. One model family can't arbitrage across them; a dispatcher can.
- **Verification.** A chat agent says "done" when it feels done. A factory says
  "done" when tests pass, the mutation check holds, and the ledger agrees.
- **Shared knowledge across tools.** Your Claude Code, Codex, and OpenCode
  sessions each start from zero unless something remembers across them.
- **Prompt-time discipline.** Suggesting the right skill, refusing a premature
  "done", pruning repeated output — these are hook jobs, not chat jobs.

Zouroboros is the layer that does those jobs. It is not a second assistant.

## The rule

> If it's about **you** — conversation, relationships, schedule, notifications,
> approvals, personal memory — it lives in **your AI client**.
>
> If it's about **building** — multi-model execution, verified delivery,
> harness knowledge, code review — it lives in **Zouroboros**.
>
> **Your client calls into the workshop; the workshop reports back to your client.**

Every future decision about where a feature goes gets filtered through that
rule. It is the whole architecture in three lines.

## The five systems

Zouroboros is not one program. It is five working systems plus the seams
between them:

### 1. Swarm orchestrator (`packages/swarm-orchestrator`)

Multi-model DAG execution. You describe tasks and dependencies; the
orchestrator routes each task to the best healthy executor, with circuit
breakers, fallback chains, and a budget governor.

Entry point: `bun scripts/orchestrate-v5.ts` (`doctor`, `status` subcommands
for health and state). Also exposes an MCP server (`mcp` / `mcp-http` scripts)
so your AI client itself can dispatch and inspect runs.

### 2. Local executors (`packages/swarm-executors`)

The other end of the orchestrator: bridge scripts and a registry describing
the AI CLIs installed on the machine — Claude Code, Codex, OpenCode, Hermes,
Gemini, Kimi, and Pi. The contract is tiny:

```bash
bash <bridge> "<prompt>" [workdir]
# stdout = clean text response, stderr = diagnostics
# exit 0 = success, anything else = failure
```

`bun scripts/doctor.ts` checks executor health; the orchestrator's router
skips whatever is missing or broken. You don't need all seven — any subset
works, and the fallback chain degrades to whatever is healthy.

### 3. Memory system (`packages/memory-system`)

One shared knowledge substrate for every harness. Hybrid SQLite + vector
store: episodic memory ("what happened"), procedural memory (versioned
workflow patterns), a typed knowledge graph, auto-capture from work sessions,
contradiction detection with supersession, and a 5-tier decay system.

Every harness — and the AI client you chat with — talks to the same database
through one MCP server (the memory MCP server, stdio). Facts learned in a
Codex session are searchable from Claude Code. Retrieval is BM25 + vector +
graph with RRF fusion; without an embeddings key it falls back to FTS5
keyword search and keeps working.

### 4. Software factory (`factory/lane`)

The conveyor: Linear issues labeled `factory-ready` → a 5-field ticket
contract (validated fail-closed) → seed YAML → swarm execution → post-flight
evaluation and gap audit → verified pull request → Linear writeback.

The minimum viable path is one queue, one worker, one worktree, one gate —
provable end-to-end with zero model calls (`bun scripts/factory-mvp.ts
smoke`). Pool, fleet, and auto-merge stay opt-in. See `factory/lane/OPERATORS_MANUAL.md`.

### 5. Prompt-time hooks (`packages/wayfinder`, `packages/verity`, `packages/sift`)

Small programs that run on harness events (prompt submitted, tool used,
agent finishing) across Claude Code, Codex, Kimi, Gemini, OpenCode, Pi, and
Hermes:

- **wayfinder** — suggests which installed skill fits the current prompt
  (local BM25 + FlashRank ranking, no network).
- **verity** — the "done" gate. Records every edit and every check; refuses
  the agent's finish when code changed with no passing test/build/lint/typecheck
  since. Also catches secrets written to files, deleted tests, and piped
  commands that hide failures.
- **sift** — shortens repeated tool output to save context, keeping
  recoverable evidence and never touching failures, instructions, or
  ambiguous cases.

All three install in **shadow mode**: they log what they *would* have done
and change nothing. You read the reports, then flip individual harnesses or
checks to live. A hook that crashes answers `{}` — the agent never notices.

## The seams (how your AI client talks to the workshop)

Your client connects to the workshop's two MCP servers: local clients over
stdio, web clients over the opt-in OAuth remote endpoint
(`packages/workshop-remote`). Per-client steps, and what has been tested
for each, are in [connect.md](connect.md). Three bridges, in order of
adoption:

1. **Read bridge.** A small script any client with a shell on the install
   machine can run anytime: swarm health, factory queue state, recent
   verdicts, harness versions. Workshop status starts appearing in briefings
   without anyone asking. See `examples/workshop-status.sh`. Clients
   without a shell (desktop and web clients) cannot run it yet: no MCP tool
   wraps it.
2. **Memory read.** Your client reads the shared-facts DB through the memory
   MCP server for build context ("what did the factory decide about X?").
   One-way read is the recommended posture, by convention: the server is
   read-write. Your client's personal memory stays in your client; work
   memory stays in Zouroboros. No sync — the boundary is deliberate.
3. **Dispatch bridge.** "Build X" becomes a factory ticket instead of an
   inline coding session: your client drafts the 5-field contract, the
   ticket is filed as a Linear issue labelled `factory-ready`, and the
   verified pipeline (multi-model build, mutation testing, PR) takes it from
   there. No Community MCP tool files the ticket: your client files it only
   if it has Linear access of its own, otherwise you file it. Swarm runs
   (`swarm_execute`) need no ticket. Sketches and one-offs stay inline in
   chat.

## The overlap map (what not to duplicate)

| Capability | A typical AI client | Zouroboros's version | Verdict |
|---|---|---|---|
| Memory | Curated personal memory: who you are, preferences, commitments | Shared-facts working memory: build facts, procedures, episodes | Complementary. Personal vs. work. Don't sync them. |
| Delegation | Subagents, one model family, full context inheritance | Executors, many model families, health-routed fallback | Route by need: coherence vs. breadth/cost. |
| Scheduling | Reminders, scheduled tasks or automations, where your client offers them | Watchdog-style supervision of its own services | Your client (or your own scheduler) owns the schedule. Factory runs are jobs, not a platform. |
| Building | Inline code, artifacts, single-agent | Factory lane: contract → build → verify → PR | Factory wins for anything with acceptance criteria. |
| Review | — | Persona-based consensus panel (shadow verdicts) | Workshop-only. Don't rebuild in chat. |

## Guardrails

- **Credentials never cross the bridge.** The read/dispatch seams carry
  status and work requests, never API keys, tokens, or OAuth grants. Keys live
  in owner-only files (mode 600, owned by the installing user) on the
  machine, loaded by the services that need them.
- **Don't rebuild your AI client inside Zouroboros.** No second scheduler, no
  second notifications, no second personal memory. Every duplicate is
  maintenance paid twice.
- **Don't rebuild Zouroboros inside your AI client.** The workshop keeps its
  unfair advantages: your paid subscriptions and the verify gate.
- **Cost routing, explicitly.** Heavy token work (builds, reviews, sweeps)
  goes to the workshop on subscriptions you already pay for. Chat usage stays
  for orchestration, conversation, and connectors.
- **Shadow before live, everywhere.** Hooks, gates, and review verdicts earn
  enforcement by demonstrating judgment in shadow mode first.

## Visual reference

`docs/assets/fusion-diagram.svg` is an older vector diagram of this
architecture (front door, workshop, dispatch and read-status bridges,
rollout phases), and `docs/assets/fusion-diagram.png` is an older, separate
drawing — not a render of the SVG. Both predate this edition's
client-neutral framing and are due for a redraw. Read them as history, not
as a component list: their workshop column shows operator-side components
(a console and an action ledger) that are not part of this repository.

## Where the code lives

`docs/packages.md` inventories every vendored package: what it is, where it
came from, its entry points, and its current maturity. `docs/de-zo-notes.md`
documents exactly what was removed or rewritten during the de-Zo port so you
can audit the diff yourself.
