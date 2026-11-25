# Walkthrough 00 — Quickstart: your first half hour

This is the short track. If you want the full operator path — every system,
every check, every manual — that's
[00-overview.md](00-overview.md), and it's an afternoon. This page gets you
to your first three wins in about half an hour, most of it installing one
thing.

The whole bet of this track: **you barely touch the workshop directly.**
The easiest way to do it is to let your own AI assistant run the onboarding
for you — that's the concierge path below. The manual path underneath it
does the same thing by hand.

## The concierge path (recommended)

Two moves: install, then connect your AI client and hand it the result.

**Install.** One command, and it needs nothing but `bash` and `curl`:

```bash
curl -fsSL https://raw.githubusercontent.com/marlandoj/zouroboros-workshop/main/scripts/quickstart.sh | bash
```

(If Node is already installed, `npx -y muse-zouroboros@latest` runs the same
installer. On a fresh machine, use the curl form: npx needs Node first.)

Paste it into a terminal. It checks the prerequisites first (Bun, Node 22+,
Python 3.11+, git, jq, `timeout`, plus `unzip` while Bun still needs
installing). If any are missing, it stops before cloning anything and
prints the exact install commands for your distro, system packages first.
It never installs them itself and never uses `sudo`: run the commands,
then paste the installer command again. When everything is there, the
installer clones the repo, runs the setup
(answering its questions as they come), verifies the install, and prints a
handoff block.

**Connect your AI client.** Follow your client's section of the connect
guide, [docs/connect.md](../docs/connect.md): it wires both workshop MCP
servers into the client and loads the concierge playbook the way that
client loads instructions. Local clients (Codex CLI, Claude Code, Gemini
CLI, OpenCode, Hermes Agent, Kimi Code, Pi, Claude Desktop, Cursor, VS Code)
use a config block that `bash scripts/connect-config.sh <client>` prints for
you. Web clients (Muse, our reference integration, plus ChatGPT and
Claude.ai) connect over the opt-in OAuth remote endpoint; that path is
proven at the protocol level with scripted clients, and the in-app
connector registration is documented but not yet verified in each app.

**Paste the handoff block into that client.** From there, your assistant
reads what's green and red, walks you through anything that needs
attention, and guides you to your first three wins — shared memory, a
factory ticket, health at a glance — in chat. You never open this manual
unless you want to.

How it works behind the curtain: the script does the mechanical work
(clone, install, verify); your assistant does the judgment (triage,
explanations, decisions). The full playbook it follows lives in
[docs/concierge.md](../docs/concierge.md), if you're curious what it's
thinking. Two of the wins need more than the MCP connection: the factory
ticket needs Linear (Step 4), and the health check needs a client that can
run a command on this machine (Step 5).

## The manual path

Prefer to drive? Everything below is what the concierge path does for you.

### What you need going in

Two things, and the second one is the one that matters:

1. **A machine with the basics.** Bun, Node 22+, Python 3.11+, git, jq,
   and `timeout` (GNU coreutils). `bootstrap.sh` checks all of these, and
   for anything missing or too old it prints the exact install commands
   for your distro. It does not install them for you.
2. **One AI builder.** Either a coding subscription you already pay for
   (Claude Code, Codex CLI, Gemini CLI, OpenCode, Kimi, or Pi — CLI
   installed and logged in), **or** the Gemini CLI free tier: a personal
   Google account, about 1000 free requests/day, no credit card. The
   installer offers the free tier when it finds no healthy executor. The
   workshop is a dispatcher: it drives the builders you have, spreads work
   across them, and keeps the receipts. It cannot drive what isn't
   installed, and the factory — the part that builds things for you —
   stays parked until at least one executor is healthy. That's not a bug,
   it's the design: no phantom builders.

That's it. No API keys required to start (memory runs keyword-only without
them, and the walkthrough shows you where keys go when you want the full
mode).

## Step 1 — Install (2 minutes)

```bash
git clone https://github.com/marlandoj/zouroboros-workshop.git
cd zouroboros-workshop
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

The most magical part of the system: teach something to one AI tool,
and every other tool knows it.

```bash
cd packages/memory-system
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
a fact, Codex recalls it — needs the memory MCP server added to each
harness's config; that's [walkthrough 03](03-memory.md) and the
[connect guide](../docs/connect.md), about ten minutes, and it's the single
highest-leverage step in the whole system.

## Step 4 — Second win: "build this" from chat (10 minutes, after setup)

This is the win the factory exists for. Be clear about what it needs,
because a fresh install does not have all of it yet:

1. **At least one healthy executor** (a coding CLI the swarm can drive).
2. **The lane's intake.** The factory takes work as a **Linear issue
   labelled `factory-ready`** in your Linear Intake project; the puller in
   `factory/lane` reads it. That needs a Linear workspace and the lane's
   Linear settings in `factory/lane/line-config.json` — see
   [walkthrough 06](06-factory.md). (A seed YAML is the build spec a ticket
   carries, or one you run by hand per the operator's manual §3; there is
   no watched drop folder to file into.)
3. **A way for your assistant to file the issue.** No Community MCP tool
   files a factory ticket. Your assistant can file it only if it also has
   Linear access — a Linear connector or Linear MCP. Without that, your
   assistant drafts the contract and you file the issue in Linear yourself.

Check the executor first:

```bash
cd ../swarm-executors
bun scripts/doctor.ts
```

If every executor shows red on its health check, install and log into one
CLI you pay for, then re-run the doctor. One green executor is enough to
start — the swarm routes around the rest.

Now the actual win, and notice you don't touch the factory directly:

> **You, in chat:** "File a factory ticket: write a tiny CLI that tells me
> whether my workshop is healthy, with a test."
>
> **Your assistant** drafts the ticket contract — what to build, what
> "done" means, what it may cost. **You** approve it. It files the Linear
> issue (or hands you the text to file). The swarm builds it across your
> executors, the lane tests and reviews the result, and the pull request
> comes back to you.

That loop — describe, approve, receive a verified PR — is the product.
Everything else in this repo is machinery underneath it. When you want to
write tickets yourself, the 5-field contract and the operator's manual are
in [walkthrough 06](06-factory.md).

## Step 5 — Health at a glance (ongoing)

From here on, "is the workshop healthy?" is a chat question, not a chore —
for a client that can run a command on this machine (the terminal agents,
and the agent terminals in Cursor and VS Code). It answers by running
`examples/workshop-status.sh` — one command, every system, graceful
degradation instead of stack traces. Point your assistant at that script
once and you'll never run `verify.sh` by hand again. Desktop and web
clients without a shell cannot run it: no MCP tool wraps it yet.

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
- If you only ever use your AI assistant for conversation and scheduling,
  you don't need any of this yet. The workshop earns its keep the first
  time you say "build this."
