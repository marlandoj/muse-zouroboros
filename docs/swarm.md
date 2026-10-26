# Swarm: multi-model dispatch

## What it is

The orchestrator (`packages/zo-swarm-orchestrator`) takes a task DAG and runs
it across the AI CLIs installed on your machine (`packages/zo-swarm-executors`
describes them). Each task is routed to the best *healthy* executor by a
6-signal composite router (capability match, cost, latency history, procedure
memory, temporal signals, load), with circuit breakers, fallback chains, a
budget governor. Executors run as the user who starts the orchestrator, with
that user's privileges, credentials and environment; there is no OS sandbox
by default. Read the executor trust model in `SECURITY.md` before you point
the swarm at anything sensitive.

Why: you already pay for several model subscriptions (Claude Max, ChatGPT,
API credits). The swarm arbitrages across them — heavy reasoning where it's
cheap, fast iteration where it's fast — instead of burning one model family
for everything.

## The executor contract

Each executor is one bridge script:

```bash
bash <bridge> "<prompt>" [workdir]
# stdout = clean text response
# stderr = diagnostics
# exit 0 = success, non-zero = failure
```

`registry/executor-registry.json` declares the seven supported harnesses
(Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, Pi): their
bridges, health-check commands, timeouts, and env docs. You do **not** need
all seven — install and authenticate whichever CLIs you use, and the router
skips the rest.

Check health:

```bash
cd packages/zo-swarm-executors
bun scripts/doctor.ts          # health of every registered executor
bun scripts/test-harness.ts    # sends a live prompt through each bridge
bun scripts/register.ts list   # what the registry sees
```

Point the orchestrator at the registry:

```bash
export SWARM_EXECUTOR_REGISTRY="$PWD/registry/executor-registry.json"
```

## Running work

```bash
cd packages/zo-swarm-orchestrator
bun scripts/orchestrate-v5.ts doctor   # executor health via the orchestrator
bun scripts/orchestrate-v5.ts status   # queue / run state
```

DAGs are defined in TypeScript (see `specs/` and `examples/` for shapes);
`orchestrate-v5.ts` executes them with dependency ordering, per-task
timeouts, retries with fallback executors, and mutation verification hooks.
Re-run `status` to audit why task X went to executor Y.

Other useful scripts: `tier-resolve.ts` (which model tier a task qualifies
for), `dep-graph.ts` (visualize the DAG), `swarm-bench.ts` (benchmark an
executor mix), `generate-harness-matrix.ts` (executor capability matrix).

## The MCP seam (Muse dispatches)

`bun scripts/mcp-server.ts` (stdio) or `mcp-server-http.ts` exposes the
orchestrator to MCP clients — including Muse. This is the **dispatch bridge**:
Muse stays in chat; the heavy multi-model run happens in the workshop and
Muse reads back the ledger and results. Wire it into Muse like any MCP
server and let Muse file runs instead of doing large builds inline.

## Failure behavior (read this before trusting it)

- **No healthy executors** → the run fails loudly with the health report.
  This is the only hard failure; everything else degrades.
- **Executor fails mid-task** → circuit breaker trips, task retries on the
  next fallback in the chain.
- **Budget exceeded** → the governor stops dispatching new tasks; running
  tasks finish.
- **Hook/bridge crashes** → stderr diagnostics, non-zero exit, task marked
  failed with the evidence attached.

## Known issues

- **A model named on a task can be overridden.** The model router in this
  release is frozen, and its fallback logic can replace the model a task
  asks for. If the routed executor does not accept that model (for example
  after a reroute to a different executor), the router substitutes the
  executor's static fallback or default model and records only a fallback
  reason. Tier aliases (light/mid/heavy) resolve through pins and the
  catalog, not to a fixed model. Set models explicitly: pin `executor` on the
  task, name a concrete model id that executor accepts rather than an alias,
  set `modelPins` in the executor registry for the tiers you rely on, and
  check `modelUsed` in the results file.
- **Pi needs an MCP config, or its probe fails on a clean install.** The Pi
  bridge builds its MCP configuration from a `.mcp.json` in the task
  workspace (or a parent directory), or from the file named by
  `PI_MCP_CONFIG_PATH`. With neither, the Pi health probe fails and Pi is
  reported unhealthy. Create a `.mcp.json` in the workspace
  (`{"mcpServers": {}}` is enough) or set `PI_MCP_CONFIG_PATH` to an
  absolute path.

## Operating notes

- **Start with `doctor`.** If an executor is red there, it's red everywhere —
  fix auth/CLI state before debugging the orchestrator.
- **Pin what matters.** Bridge scripts resolve the newest installed CLI
  binaries; if a harness update breaks a bridge, the registry's health check
  catches it before a real task does.
- **Read the ledger.** `status` output is the audit trail. When a run
  surprises you, the ledger tells you which signal routed it.
- **Budgets are per-run.** Set them from the cost of the subscriptions
  you're arbitraging, not from vibes.

## What this package changed from upstream

Machine paths in the registry (`/home/hatch/...`) became `$HOME`-relative
(`scripts/bootstrap.sh` expands them at install). A legacy
`ZO_CLIENT_IDENTITY_TOKEN` export was removed from the Pi bridge. Optional
Zo MCP/persona-directory hooks remain in the code but are inert without
credentials — see `docs/de-zo-notes.md` for the full list and removal
pointers.
