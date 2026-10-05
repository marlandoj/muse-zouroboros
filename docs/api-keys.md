# API keys: what you need, where to get them, where they live

You don't need many keys. Most people need exactly one to start, and a
second only if they want a particular route. This page covers which keys
exist, what each one unlocks, how to obtain them, where to store them, how
to tell they're working, what they cost, and what to do when something
goes wrong.

## Which keys exist

| Key | Required? | Unlocks |
|---|---|---|
| `OPENAI_API_KEY` | Yes, for full mode | Memory embeddings (what gives the memory its understanding of meaning) and the default generation workloads: the relevance gate, query expansion, fact extraction, and briefings. Without it, memory still works in keyword-only mode. |
| `ANTHROPIC_API_KEY` | No | An alternate route for the memory's generation workloads, calling Anthropic's API directly. Only set this if you prefer Anthropic models for those jobs. |
| `OPENROUTER_API_KEY` | Only if you use the Pi executor | The Pi agent's default model route. If Pi isn't one of your executors, skip it. |
| `KIMI_API_KEY` | Rarely | Only if you explicitly route Pi through Kimi's own API instead of OpenRouter. Most people never need this. |

Note what isn't on this list: your AI coding tools (Claude Code, Codex,
OpenCode, and the rest) each have their own sign-in — subscription login,
device code, OAuth — handled inside those tools. You don't put those
credentials here; the workshop just calls the tools, and the tools handle
their own authentication.

## Getting your keys

### OpenAI (the one most people need)

1. Go to platform.openai.com and sign in (or create an account).
2. Open the **API keys** section and choose **Create new secret key**.
3. Give it a name you'll recognize, like `zouroboros-memory`.
4. **Copy the key immediately.** It's shown once and never again — if you
   lose it, you'll create a new one.
5. Set up billing. API usage is pay-as-you-go; add a payment method and,
   if you like, a monthly spending limit so there are no surprises.

### Anthropic (optional)

1. Go to console.anthropic.com and sign in.
2. Open **API keys** and create one the same way: name it, copy it once,
   set up billing.

### OpenRouter (only for the Pi executor)

1. Go to openrouter.ai and sign in.
2. Open the **Keys** section, create a key, copy it once.
3. Add credits to your OpenRouter balance — it draws down as you use it.

## Where keys live

All keys go in one private file: `~/.config/zouroboros/apis.env`. That file
must be readable only by you (mode 600) — the walkthrough's step 01 creates
it that way. Your shell loads it at login, so every component sees the keys
without them ever appearing in a chat transcript, a repo, or a log.

```bash
# ~/.config/zouroboros/apis.env — owner-only (chmod 600)
export OPENAI_API_KEY="paste-your-key-here"
# export ANTHROPIC_API_KEY="paste-your-key-here"   # optional
# export OPENROUTER_API_KEY="paste-your-key-here"  # only for Pi
```

After editing the file, open a new shell (or source it) so the change
takes effect. Never paste a key into chat — chat history can't be
scrubbed.

## How to tell it's working

The memory system tells you itself. When you check its status, it reports
whether it's running in full mode (embeddings on) or keyword-only mode:

- **Full mode** means your `OPENAI_API_KEY` is set and valid. Semantic
  search, query expansion, and the relevance gate are all live.
- **Keyword-only (FTS5) mode** means no key was found. Everything still
  works — storage, keyword search, episodes, the knowledge graph — but
  meaning-based search is off.

The `scripts/verify.sh` script in this repo also checks for the key and
tells you which mode to expect. If you set the key and still see
keyword-only mode, see Troubleshooting below.

Per-workload model choices (which model does the gate, which does
summaries) live in `~/.config/zouroboros/model.env` and are documented in
`docs/memory.md`. You don't need to touch them to get started.

## What it costs

Honest numbers, roughly: memory embeddings and the small generation
models cost fractions of a cent per call — a busy month of memory use is
typically pocket change. The real spending in this system is the factory
and the swarm doing build work, and that's governed by per-run budgets you
set in the ticket, running on subscriptions you already pay for. Set a
spending limit in your OpenAI billing dashboard on day one and you'll
never be surprised.

## Rotating a key

If a key ever touches a chat transcript, a ticket, a log, or anywhere it
shouldn't be, treat it as disclosed:

1. Go to the provider's dashboard and **revoke/delete** the old key first.
2. Create a new key.
3. Replace it in `~/.config/zouroboros/apis.env`.
4. Open a new shell and re-run the verification step above.

Revoke first, then replace — a disclosed key stays dangerous until it's
dead at the provider.

## Troubleshooting

**"Invalid API key" / authentication errors.** The key in `apis.env`
doesn't match what the provider expects. Common causes: an extra space or
quote pasted in, the key was revoked, or you're looking at the wrong
project's dashboard. Re-copy it carefully.

**Quota / billing errors.** The key is valid but there's no money behind
it — add a payment method or credits at the provider, and check for a
spending limit you may have hit.

**Key is set but memory still reports keyword-only mode.** The shell that
runs the memory system hasn't picked up the new file. Open a fresh shell
(or source `apis.env`) and check again. Also confirm the variable name is
spelled exactly `OPENAI_API_KEY`.

**A tool asks for a key you don't have.** You probably don't need it.
Re-check the table at the top: most keys are for routes you aren't using.
The workshop skips whatever isn't configured and tells you so.
