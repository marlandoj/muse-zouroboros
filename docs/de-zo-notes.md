# De-Zo porting notes

## Background

Zouroboros grew up on Zo Computer, a platform that no longer exists. The
system was supposed to have been ported to run independently; several
leftovers still referenced the dead platform — its API (`api.zo.computer`),
its dispatch endpoint (`/zo/ask`), and its identity token
(`ZO_CLIENT_IDENTITY_TOKEN`). This repo completes that port for the
vendored packages: **nothing here may depend on Zo Computer, at runtime or
at install.**

This document lists every functional change made during vendoring so you can
audit the diff. "Functional" means behavior changed; pure path/portability
fixes are listed separately.

## Functional changes

### 1. `packages/zo-memory-system/scripts/model-client.ts` — Anthropic re-pointed

- **Was:** the `anthropic` provider routed generation through the Zo
  Computer proxy (`POST https://api.zo.computer/zo/ask`, bearer
  `ZO_CLIENT_IDENTITY_TOKEN`, model mapped to `vercel:anthropic/<model>`).
- **Now:** the `anthropic` provider calls the Anthropic Messages API
  directly (`POST https://api.anthropic.com/v1/messages`, `x-api-key:
  ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`), with the same
  per-workload temperature/max-token behavior as the OpenAI path.
- **Health check:** `modelHealthCheck("anthropic")` now pings
  `https://api.anthropic.com/v1/models` instead of the dead `/zo/ask`
  endpoint. Without `ANTHROPIC_API_KEY` it reports unavailable — same
  fail-soft shape as before.
- Verified: `bun build scripts/model-client.ts` compiles clean.

### 2. `packages/zo-swarm-orchestrator/src/executor/bridges/pi-bridge.sh` — token export removed

- **Was:** `export ZO_CLIENT_IDENTITY_TOKEN=${ZO_CLIENT_IDENTITY_TOKEN...}`
  (a self-referencing export — inert, but a dead platform reference).
- **Now:** removed, with an explanatory comment. Pi routes through
  OpenRouter per the registry; it never needed a platform token.

### 3. `packages/zo-swarm-executors/registry/executor-registry.json` — Zo env docs removed

- Removed the `ZO_CLIENT_IDENTITY_TOKEN` / `ZO_MCP_URL` documentation
  entries from the Pi executor's `envVars`. They described credentials for
  a service that no longer exists.

### 4. Already-dead code, intentionally left in place

The following still *mention* Zo but are inert without credentials and were
left untouched to keep the diff reviewable. All fail soft (skip with a log
line) when no Zo credentials are configured — which is now always:

| File | What it does when unconfigured |
|---|---|
| `packages/zo-swarm-orchestrator/src/transport/acp-transport.ts` (Zo MCP server attach) | Skips: "no ZO_CLIENT_IDENTITY_TOKEN, ZO_API_KEY, or ZO_MCP_API_KEY is available" |
| `packages/zo-swarm-orchestrator/src/persona/directory.ts` (Zo persona directory) | Throws a descriptive error only if explicitly invoked; local persona files are the default path |
| `packages/zo-swarm-orchestrator/src/executor/bridges/pi-mcp-bootstrap.ts` | No-op without the (now-removed) registry entries |
| `packages/zo-swarm-orchestrator/scripts/swarm-events/alerts.ts` | Alert sink config; no Zo credentials configured → channel inactive |

If you're forking this repo, these four are the obvious next deletions.
They're documented here instead of removed because each has test coverage
pinning its skip behavior, and silent deletion would be worse than honest
documentation.

## Portability changes (no behavior change)

- `packages/zo-swarm-orchestrator/src/executor/registry/executor-registry.json`:
  `/home/hatch/...` → `$HOME/...` (24 occurrences). `scripts/bootstrap.sh`
  expands `$HOME` to the installing user's home at install time.
- `model-client.ts`: `/home/workspace/.zo/memory/model-call-log.jsonl` →
  `~/.zo/memory/model-call-log.jsonl`; `/home/.z/config/model.env` →
  `~/.config/zouroboros/model.env`.
- `/home/workspace` references elsewhere in the packages are the Muse VM
  workspace-root convention and resolve on any Muse VM — intentionally kept.

## What was NOT vendored (and why)

- **Hetzner/Modal overflow executors, MoA consensus, prespec/signal-triage
  extras.** Retired upstream as mitigations for a flaky platform era; not
  needed on a Muse VM and not part of the workshop core.
- **The Command Center web UI.** Operator convenience, not infrastructure.
  The `examples/workshop-status.sh` read bridge covers health checks without
  a web service to secure.
- **Scheduled self-improvement loops** (introspect → prescribe → evolve).
  Real, but operationally heavy — stabilize the five systems first.
- **Historical factory experiments** (dated remediation dirs, interview
  notes, progress logs, release archives). The lane runtime, contracts,
  configs, operator docs, and representative seeds are vendored; the
  archaeology isn't.

## Verification performed

- `bun build` on the modified `model-client.ts`: clean.
- `bash -n` on the modified `pi-bridge.sh`: clean.
- JSON validity re-checked after every registry edit.
- Repo-wide secret sweep: no API keys, tokens, personal emails, or
  machine-specific home paths remain. Three test files contain
  key-shaped placeholder strings (`sk-…`); all three are security-test
  fixtures (secret-detection and credential-denial tests) with inert
  values — verified by inspection, not real credentials.
- The orchestrator's and factory's test suites are vendored as-is; run
  `bun test` in each package to re-verify on your machine.
