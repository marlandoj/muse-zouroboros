# Security model

## The trust boundary

The workshop runs on your VM with your credentials. There is exactly one
rule that keeps this safe to operate:

> **Status and work requests cross the bridge. Credentials never do.**

Muse may ask the workshop "are the executors healthy?" and "build this
ticket". It must never receive, transmit, or log an API key, OAuth token, or
platform secret on the workshop's behalf — and neither may any package in
this repo.

## How secrets are held

- **Root-only files, loaded by the services that need them.** The convention:
  API keys live in `~/.config/zouroboros/*.env` (mode `0600`), sourced by
  the process profile that launches the service. They are never pasted into
  chat, never committed, never echoed into logs.
- **Per-workload keys.** `OPENAI_API_KEY` (memory embeddings + generation),
  `ANTHROPIC_API_KEY` (optional Anthropic generation route),
  `OPENROUTER_API_KEY` / provider keys (Pi/OpenCode routes) — each consumed
  only by the component that needs it.
- **Harness auth stays in the harness.** Claude Code's subscription, Codex's
  device OAuth, Kimi's login — those live in the CLIs' own credential stores.
  The bridges invoke the CLIs; they don't reimplement their auth.

## What the code guarantees

- **Verity's Canny engine runs model-free.** The optional model path is
  disabled at install: API key stripped, endpoint pointed at a dead port. No
  prompt or file text leaves the host through verity, by construction.
- **Wayfinder logs hashes, not text.** `~/.wayfinder/suggestions.jsonl`
  records prompt SHA-256 and the ranked pick — never the prompt.
- **Sift protects failures and instructions.** Pruning proposals only cover
  repeated, byte-identical, successful tool output; the original is stored
  and verified before any reference replaces it.
- **The decision ledger is local.** Swarm routing rows are hash-chained
  append-only on your disk — auditable without a third party.
- **Hooks fail open.** A crashing hook answers `{}`; the agent proceeds. The
  workshop never blocks your work because its own tooling broke.

## What the factory guarantees

- **Fail closed on authority.** Tickets naming an executor other than the
  workshop are rejected mechanically. Unknown costs, missing evidence, and
  ambiguous states resolve to rejection — never permissive defaults.
- **Linear is a signal surface.** Issues, labels, comments, state changes.
  Linear never executes code.
- **Run receipts.** Every build leaves an auditable receipt (contract,
  seed, eval, gap audit, PR link). If you can't explain a merge from its
  receipt, the lane is misconfigured.

## Your responsibilities

1. **Keep `~/.config/zouroboros/` at `0600`.** The bootstrap script sets
   this; don't loosen it.
2. **Review shadow logs before going live.** Wayfinder, verity, and sift
   each show you exactly what enforcement would do. A week of logs you
   agree with is the entry ticket to live mode.
3. **Read the first five factory post-flights.** Know what "done" means
   before you trust it at volume.
4. **Don't pipe the workshop through a public tunnel without auth.**
   If you expose any workshop UI publicly, put authentication in front of
   it. An operator console with no login is an open door by definition.
5. **Rotate keys you ever paste into chat.** Chat history can't be
   scrubbed. If a secret touches a transcript, treat it as disclosed.

## What was scrubbed for publication

This repo was audited before release: no API keys, OAuth tokens, platform
secrets, personal emails, or machine-specific paths remain. Test fixtures
use `<redacted>` placeholders. The full list of functional changes made
during vendoring is in `docs/de-zo-notes.md` — audit it yourself; that's
why it exists.
