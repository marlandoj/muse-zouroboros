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

---

## `packages/consensus-gate` — vendored 2026-10-07

Copied from the monorepo's `Skills/consensus-gate` (working tree, including
the "Ask Marlando" escalation-message fix) and de-Zo ported. The skill is
retired upstream; it ships here for audit history and explicitly authorized
operator experiments, not as a merge gate.

### Functional changes

1. `scripts/reconcile.ts` — default reconciliation annotator was the
   hardcoded personal name `"marlandoj"`; now `RECONCILE_ANNOTATOR` env,
   else `$USER`, else `"operator"`.
2. OpenRouter `HTTP-Referer` headers (`scripts/consensus-gate.ts`,
   `scripts/moa-runtime.ts`, `scripts/prompt-ab.py`) pointed at the private
   upstream repo (`github.com/marlandoj/zouroboros`); now
   `github.com/marlandoj/muse-zouroboros`.
3. `scripts/consensus-lineup.ts` — import adapted per the repo's standing
   rule: `../../../packages/swarm/...` →
   `../../../packages/zo-swarm-orchestrator/...` (the target,
   `src/routing/shared-catalog.ts`, is vendored here). Same adaptation
   applied to two code comments referencing the monorepo layout.
4. `scripts/tier-resolver-sync.ts` — tier-resolver is not vendored, so the
   old fallback would have `mkdir -p`'d junk into
   `/home/workspace/Skills/tier-resolver/data`. It now fails fast with a
   clear error unless `TIER_RESOLVER_DATA_DIR` is set.

### Inert Zo paths, intentionally left in place

Every Zo route below is credential-gated (`ZO_CLIENT_IDENTITY_TOKEN` /
`ZO_TOKEN` env reads) and fails soft without credentials — which is now
always. Left untouched to keep the diff reviewable, per the precedent in
"Already-dead code" above.

| File | What it does when unconfigured |
|---|---|
| `scripts/catalog-byok.ts` (`probeAlive`, `ZO_ASK_URL`) | Returns `{alive: false, detail: "no ZO token in env"}` — no request sent |
| `scripts/cold-start-probe.ts` (`providerForModel`, `byok:` route) | Labels the route `zo-byok`; callers fail soft (see below) |
| `scripts/consensus-gate.ts` (`zo-byok` direct route, `zo-proxy` label, cost card) | `zo-byok` seats resolve only when a Zo token exists; cost card notes `/zo/ask` unmetered |
| `scripts/escalation-valve.ts` (`escalateZo`, `ZO_ASK_API`) | Returns `{ok: false, error: "no ZO token"}` — escalation falls through to other targets |
| `scripts/moa-runtime.ts` (`providerForMoaModel`, `ZO_ASK_URL`) | `byok:` models route to `zo-byok` only with a token; otherwise the call fails soft |
| `scripts/provider-routing.ts` (`zo-byok` branch) | Branch taken only when `credentials.zo` is present |
| `scripts/provider-smoke-probe.ts` (Zo key checklist) | Reports `ZO_CLIENT_IDENTITY_TOKEN or ZO_TOKEN` as missing and exits 1 — honest reporting, not a call |

### Portability changes (no behavior change)

- `scripts/noise-watch.ts`: gate CLI path now `join(import.meta.dir,
  "consensus-gate.ts")` instead of the hardcoded monorepo path.
- `scripts/consensus-gate.ts`: dropped the dead
  `/home/workspace/Skills/zouroboros-governance/...` fallback; governance
  escalation was already guarded by `existsSync` and warns clearly when the
  (unvendored) governance script is absent.
- `scripts/seat-health-probe.ts`: capability prober resolved against the
  repo checkout (`factory/lane/scripts/consensus-capability.ts`, which is
  vendored); the existing "capability prober missing at …" error names the
  path if absent.
- `scripts/persona-panel.ts`: executor-registry candidates now try the
  sibling package (`packages/zo-swarm-executors/...`) first, keeping the
  `/home/workspace` VM convention as fallback.
- `scripts/zourobench-lineup-roster.ts`: targets file resolved
  package-relative (`data/zourobench-lineup-targets.json`, which ships);
  the ZouroBench roster source path is commented as unvendored
  (override with `--output`).
- `scripts/zourobench-code-evidence.ts`,
  `scripts/zourobench-lineup-evidence.ts`: monorepo bench-data defaults
  commented as unvendored; missing roots already yield empty evidence, and
  `ZOUROBENCH_CODE_EVIDENCE_PATHS` / `ZOUROBENCH_EVIDENCE_PATHS` env
  overrides work unchanged.
- `scripts/judge-calibration.py`, `scripts/prompt-ab.py`: paths resolved
  relative to the script file instead of `/home/workspace/Skills/...`.
- Docs (`SKILL.md`, `INTEGRATION.md`): skill-location references rewritten
  to `packages/consensus-gate`; `/root/.zo_secrets` launch lines replaced
  with operator-managed env vars (see `docs/api-keys.md`).
- `~/.swarm/swarm.db`-style state paths (`/home/workspace/.swarm/...`)
  intentionally kept per the VM-convention rule.

### Verification performed

- `bun build` on all 10 touched `.ts` scripts: clean.
- `python3 -m py_compile` on both touched `.py` scripts: clean.
- `bun test scripts/`: **337 pass / 6 fail / 1 error** (343 across 39
  files). All failures are in test files with monorepo-layout assumptions,
  vendored as-is per the suite policy above — not fixed:
  - `four-source-validation.test.ts` (3): spawns subprocesses at
    `Skills/consensus-gate/scripts/...`, which doesn't exist in this repo
    layout.
  - `trace-credit.integration.test.ts` (1): same `Skills/...` assumption
    plus `packages/swarm/...` (passes in the monorepo).
  - `trace-credit.test.ts` (1 error): imports
    `../../../packages/swarm/src/standalone/trace-outcome` (test-only;
    the target is vendored at `packages/zo-swarm-orchestrator`).
  - `persona-panel.test.ts` / `live host expectations` (1): expects
    claude-code live on the host — environmental, also fails in the
    monorepo.
- Secret sweep: no API keys, tokens, personal emails, or `/home/hatch`
  paths. `marlandoj.zo.computer` remains only in `SKILL.md` frontmatter
  (same as the other vendored packages) and `marlandoj` only as fixture
  provenance in `data/calibration/*`.
