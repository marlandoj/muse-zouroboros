# Walkthrough 04 — Swarm

## Check executor health

```bash
cd ~/workspace/muse-zouroboros/packages/swarm-executors
bun scripts/doctor.ts
```

You want at least two green. For each red executor, the output tells you
whether it's missing (not installed), unauthenticated (CLI auth needed), or
misconfigured (registry entry wrong). Fix the CLI side first — the
orchestrator can't fix a broken login.

```bash
bun scripts/register.ts list      # what the registry sees
bun scripts/register.ts validate  # registry schema check
```

**Prove it:** `doctor` shows 2+ healthy executors, and you can name which
ones they'll be for real work.

## Let the orchestrator see them

```bash
cd ../swarm-orchestrator
bun install
export SWARM_EXECUTOR_REGISTRY="$HOME/workspace/muse-zouroboros/packages/swarm-executors/registry/executor-registry.json"
bun scripts/orchestrate-v5.ts doctor
```

(This export is already in `~/.config/zouroboros/workshop.env` from step 02 —
the explicit version here is so you see the seam.)

## Run a real 2-task DAG

Don't start with your real work. Run the smallest meaningful DAG: two tasks
where the second depends on the first. The orchestrator ships examples —
adapt one, or define it inline per `specs/` shapes. What matters is that you
watch a full cycle: route → execute → ledger → result.

**Prove it:**

```bash
bun scripts/orchestrate-v5.ts status
```

shows your run, both tasks succeeded, and each result records which
executor ran the task and why. Read the results — this is your audit trail,
and trusting it starts now.

## Break it on purpose

Kill one executor's auth (or just watch what happens when one is slow):
the circuit breaker should trip, the task should retry on the next fallback,
and the ledger should say so. If a run ever fails *silently*, that's a bug
worth reporting — the design promise is that every failure is loud and
attributed.

## Wire the dispatch seam (optional, recommended)

`bun scripts/mcp-server.ts` (stdio) exposes the orchestrator as an MCP
server, `zouroboros-swarm`. If you followed step 03 and the
[connect guide](../docs/connect.md), your client already has it: the guide
wires both servers into every client (`bash scripts/connect-config.sh
<client>` prints the swarm block too). This is the **dispatch bridge**:
from here on, "run this across the workshop" is something your AI client
can do without you leaving chat. Web clients get the swarm tools over
remote mode only if you set `ZO_REMOTE_EXPOSE_SWARM=1`, because
`swarm_execute` starts local coding agents.

## Prove it

- [ ] `doctor` (both sides) green for 2+ executors
- [ ] A 2-task DAG ran end to end; `status` shows the ledger rows
- [ ] You've seen a fallback happen (or simulated one) and the ledger
      explains it
- [ ] You know where the ledger lives and how to read it

Next: [05 — Hooks](05-hooks.md).
