# Walkthrough 00 — Quickstart: your first half hour

This is the short track. If you want the full operator path — every system,
every check, every manual — that's
[00-overview.md](00-overview.md), and it's an afternoon. This page gets you
to your first three wins in about half an hour, most of it installing one
thing.

The whole bet of this track: **you barely touch the workshop directly.**
You install it once, then you operate it the way you operate everything
else — by talking to Muse.

## What you need going in

Two things, and the second one is the one that matters:

1. **A machine with the basics.** Bun, Node 22+, Python 3.11+, git, jq.
   `bootstrap.sh` checks all of these and tells you exactly what's missing.
2. **One AI coding subscription, with its CLI installed and logged in.**
   Claude Code, Codex CLI, Gemini CLI, OpenCode, Kimi, or Pi — whichever you
   already pay for. The workshop is a dispatcher: it drives the subscriptions
   you already have, spreads work across them, and keeps the receipts. It
   cannot drive what isn't installed, and the factory — the part that builds
   things for you — stays parked until at least one executor is healthy.
   That's not a bug, it's the design: no phantom builders.

That's it. No API keys required to start (memory runs keyword-only without
them, and the walkthrough shows you where keys go when you want the full
mode).

## Step 1 — Install (2 minutes)

```bash
git clone https://github.com/marlandoj/muse-zouroboros.git
cd muse-zouroboros
bash scripts/bootstrap.sh
```

This creates the directories, writes your `workshop.env` (pointed at
*this* clone, wherever you put it), and installs package dependencies.
It's idempotent — safe to re-run.

## Step 2 — Prove it's alive (1 minute)

```bash
bash scripts/verify.sh
```

You'll see a green/red board, one section per system. On a fresh install,
expect red — here's how to read it:

| Red | What it means |
|---|---|
| `no database` (memory) | Walkthrough step 03 — two minutes, covered in Step 3 below |
| `no healthy executors` (swarm) | No coding CLI installed/logged in yet — the one real prerequisite, covered in Step 4 |
| `OPENAI_API_KEY not set` (keys) | Optional. Everything works keyword-only without it |
| `factory smoke failed` | **This one should be green.** If it's red, stop — something about the machine is wrong, and the smoke output says what |

Green factory on a fresh clone is the whole point of the packaging work:
it proves the lane works from wherever you installed it, with zero model
calls and zero configuration.

## Step 3 — First win: one memory everywhere (5 minutes)

The most Muse-like magic in the system: teach something to one AI tool,
and every other tool knows it.

```bash
cd packages/zo-memory-system
bash scripts/install.sh
```

That creates your memory database. Now prove it:

```bash
bun scripts/memory.ts store --persona shared --entity "workshop" \
  --key "first-win" --value "The quickstart worked" --decay session
bun scripts/memory.ts search "quickstart"
```

The fact you just stored comes back. That database is now the shared well
for every harness you wire up. The cross-harness part — Claude Code stores
a fact, Codex recalls it — needs the `zo-memory` MCP server added to each
harness's config; that's [walkthrough 03](03-memory.md), about ten
minutes, and it's the single highest-leverage step in the whole system.

## Step 4 — Second win: "build this" from chat (10 minutes)

This is the win the factory exists for, and it has exactly one
prerequisite: **a healthy executor.** Check yours:

```bash
cd ../zo-swarm-executors
bun scripts/doctor.ts
```

If every executor shows red on its health check, install and log into one
CLI you pay for, then re-run the doctor. One green executor is enough to
start — the swarm routes around the rest.

Now the actual win, and notice you don't touch the factory directly:

> **You, in chat:** "File a factory ticket: write a tiny CLI that tells me
> whether my workshop is healthy, with a test."
>
> **Muse** drafts the ticket contract — what to build, what "done" means,
> what it may cost. **You** approve it. Muse files it. The swarm builds it
> across your executors, the lane tests and reviews the result, and Muse
> hands you the pull request.

That loop — describe, approve, receive a verified PR — is the product.
Everything else in this repo is machinery underneath it. When you want to
write tickets yourself, the 5-field contract and the operator's manual are
in [walkthrough 06](06-factory.md).

## Step 5 — Health at a glance (ongoing)

From here on, "is the workshop healthy?" is a chat question, not a chore.
Muse answers it by running `examples/workshop-status.sh` — one command,
every system, graceful degradation instead of stack traces. Point Muse at
that script once and you'll never run `verify.sh` by hand again.

## Where to go next

- [00-overview.md](00-overview.md) — the full operator walkthrough, in
  order. Do it when you want to *run* the workshop, not just use it.
- [05-hooks.md](05-hooks.md) — the three prompt-time guardians. They start
  in shadow mode (watch and report, never enforce) and they're worth
  installing early: the reports teach you what "done" looks like.
- [06-factory.md](06-factory.md) — the ticket contract, the operator's
  manual, the approval gate. Read before trusting the lane with real work.

## Honest notes

- The quickstart deliberately skips the hooks and the review panel. They
  matter, but they're day-two systems — install them after your first
  ticket lands, when you have something worth guarding.
- Without an API key, memory is keyword-only. It's still useful on day one;
  the semantic layer is an upgrade, not a requirement.
- If you only ever use Muse for conversation and scheduling, you don't need
  any of this yet. The workshop earns its keep the first time you say
  "build this."
