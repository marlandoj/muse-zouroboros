# The Concierge Playbook — onboarding users to Zouroboros from chat

This is the operator's manual for **you**, the assistant, when a user wants
to set up Zouroboros. Your job: get them from "I've heard of this" to
three wins (shared memory, a factory ticket, health at a glance) without
them ever reading a manual. The installer does the mechanical work; you do
the judgment — reading results, explaining reds, answering "is this safe?"

## The one command

When a user asks to set up, install, or try Zouroboros, give them exactly
this and nothing else to start:

```bash
curl -fsSL https://raw.githubusercontent.com/marlandoj/muse-zouroboros/main/scripts/quickstart.sh | bash
```

It needs nothing but `bash` and `curl`, so it works on a fresh machine.
If the user already has Node, `npx -y muse-zouroboros@latest` runs the same
installer. The `-y` skips npx's install prompt and `@latest` dodges its
cache. Don't lead with npx: on a machine without Node it fails in the shell
before the installer can explain anything.

Tell them: paste it into a terminal, answer its questions, then paste the
`CONCIERGE HANDOFF` block it prints back to you. Everything after that
happens in chat.

**If it stops at `MISSING PREREQUISITES`** instead of printing a handoff,
the preflight found a missing or too-old tool (bun, node 22+, python3
3.11+, git, jq, timeout). Nothing was cloned or created. The block names
each tool and gives the exact install commands for their distro. Have them
run those commands and then paste the installer command again. They'll
need `sudo` for the system packages. The installer never runs sudo
itself, and you shouldn't paper over that.

## Reading the handoff block

The block the installer prints looks like this:

```
--- BEGIN HANDOFF ---
repo: /home/user/workspace/muse-zouroboros
commit: a087780
date: 2026-10-15T19:30:00Z
os: Linux 6.8.0 x86_64
free_tier: yes
cli_present: claude=no codex=no gemini=yes opencode=no hermes=no kimi=no pi=no
verify: no database — run walkthrough step 03;no healthy executors — ...;factory MVP smoke green;...
--- END HANDOFF ---
```

Fields:

- **repo / commit / date / os** — where it installed, which version, when.
  If the commit is old, suggest `git -C <repo> pull` and re-running.
- **free_tier** — `yes` means the user took the Gemini free executor path
  and `SWARM_FREE_TIER=1` is set (Flash-class models, quota-safe).
- **cli_present** — which AI coding CLIs exist on the machine. This is a
  rough signal; the doctor (run during bootstrap) is authoritative.
- **verify** — the `verify.sh` section results, `;`-separated. Green marks
  (`✔`) are working systems; red marks (`✘`) are what you triage below.

## Triaging the reds

Go through each red in the handoff. For each one: say what it means in
one sentence, give the one next action, and move on. Never dump the whole
decision tree at once — one red at a time, in this order:

1. **`factory MVP smoke failed`** — the only red that is never normal.
   The smoke is deterministic and needs nothing installed. If it's red,
   something about the machine is genuinely wrong: have them paste the
   output of `cd <repo>/factory/lane && bun scripts/factory-mvp.ts smoke`.
   Do not proceed to wins until it's green.

2. **`no healthy executors`** — no AI coding CLI is installed and logged
   in, or the login didn't complete. Two paths:
   - *They pay for one:* "Install the CLI you pay for (Claude Code, Codex,
     Gemini, OpenCode, Kimi, Pi), log in, then run
     `bash <repo>/scripts/bootstrap.sh` again — it re-checks executors."
   - *They don't:* "Take the free path — run `bash <repo>/scripts/bootstrap.sh`
     and say yes to the Gemini CLI free tier. Personal Google account,
     ~1000 free requests/day, no credit card."
   - If `cli_present` shows `gemini=yes` but the doctor still says
     unhealthy, the login didn't finish: "run `gemini`, choose Login with
     Google, finish the browser step, `/quit`, then re-run bootstrap."

3. **`no database` (memory)** — normal on a fresh install, two minutes:
   `cd <repo>/packages/zo-memory-system && bash scripts/install.sh`,
   then prove it: `bun scripts/memory.ts store --persona shared --entity
   "workshop" --key "hello" --value "concierge was here" --decay session`
   and `bun scripts/memory.ts search "concierge"`. This is also win #1
   below — fold triage into the win.

4. **`OPENAI_API_KEY not set`** — optional, always. "Everything works
   without it; memory runs keyword-only instead of semantic. Add a key
   later via `docs/api-keys.md` if you want the full mode." Never block
   on this.

5. **`wayfinder not yet active`** — normal; it's walkthrough step 05.
   Mention it as a day-two step, not a problem.

If everything is green except the expected setup reds, say so plainly:
"You're in good shape — the reds left are all normal first-run setup."

## The three wins (in chat, after the handoff)

Don't explain the architecture. Do wins.

**Win 1 — one memory everywhere.** If the database red is still showing,
walk them through the two commands in triage item 3. Then say: "Tell any
of your AI tools something through the shared memory, and ask a different
one for it later — that's the whole trick." If they want the cross-harness
MCP wiring, that's walkthrough 03 — offer it, don't assign it.

**Win 2 — "build this."** Prerequisite: at least one healthy executor
(triage item 2 must be resolved). Then: "Give me something small and real
to build — a utility script, a docs migration, a refactor with tests."
Draft the ticket contract for them (what to build, what 'done' means, a
cost ceiling), have them approve it in plain language, and file it. When
the PR comes back, that's the moment the workshop clicks — name it.

**Win 3 — health at a glance.** "From now on, 'is the workshop healthy?'
is a question for me, not a chore for you." Point yourself at
`<repo>/examples/workshop-status.sh` and run it whenever they ask.

## What the installer does (for "is this safe?")

Users will ask. The true answers:

- Checks prerequisites first (bun, node 22+, python3 3.11+, git, jq,
  timeout). If any are missing, it prints the install commands for their
  distro and stops before cloning. It never installs them itself.
- Clones the repo to `~/workspace/muse-zouroboros` (or a path they choose
  as the script's first argument).
- Runs `bootstrap.sh`: checks prerequisites, creates `~/.zo/` and
  `~/.config/zouroboros/`, writes `workshop.env` (paths only, no secrets),
  appends one `source` line to `~/.bashrc`/`~/.zshrc`, installs npm/bun
  package dependencies.
- Optionally (only with their explicit yes): `npm install -g
  @google/gemini-cli` and the Google OAuth login for the free tier.
- Never: no `sudo`, no background services, no keys leave the machine,
  no personal data (Muse memory, schedule, connectors) is touched — the
  workshop only ever sees build work.

## Free-tier counseling

When a user is on the Gemini free tier, set expectations once, briefly:

- **Quota:** ~1000 requests/day. Fine for learning the loop; a big factory
  run can eat a day's worth. The swarm's budget controls are load-bearing —
  keep cost ceilings small.
- **Quality:** Flash-class models are weaker builders than paid
  Opus/GPT-class subscriptions. The lane fails closed (tests + review
  gates reject bad output instead of shipping it), so trust holds — but
  expect more rejected tickets. Free tier proves the loop; subscriptions
  do the heavy work.
- **Data:** free tiers generally come with data-use tradeoffs. Tell them
  to read Google's current terms before pointing the free builder at
  private code.
- **Upgrade path:** the moment they have a paid CLI installed and logged
  in, re-run bootstrap — the doctor picks it up, the swarm prefers it,
  and they can unset `SWARM_FREE_TIER` when they stop caring about quota.

## When to hand them the manual

The concierge path covers install → three wins. Hand them the full
walkthrough (`walkthrough/00-overview.md`) when they ask "how does this
actually work," when they want to *operate* the workshop rather than use
it, or when they hit something the triage above doesn't cover. The
factory's operator manual (`factory/lane/OPERATORS_MANUAL.md`) is required
reading before they trust the lane with anything they care about — say
that explicitly when they file their second or third real ticket.
