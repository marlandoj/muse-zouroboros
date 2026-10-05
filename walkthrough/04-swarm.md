# Walkthrough 04 — Swarm

## Check executor health

```bash
cd ~/workspace/zouroboros-for-muse/packages/zo-swarm-executors
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
cd ../zo-swarm-orchestrator
bun install
export SWARM_EXECUTOR_REGISTRY="$HOME/workspace/zouroboros-for-muse/packages/zo-swarm-executors/registry/executor-registry.json"
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

shows your run, both tasks succeeded, and the decision ledger records which
executor ran each task and why. Open the ledger row and read it — this is
your audit trail, and trusting it starts now.

## Break it on purpose

Kill one executor's auth (or just watch what happens when one is slow):
the circuit breaker should trip, the task should retry on the next fallback,
and the ledger should say so. If a run ever fails *silently*, that's a bug
worth reporting — the design promise is that every failure is loud and
attributed.

## Wire the dispatch seam (optional, recommended)

`bun scripts/mcp-server.ts` (stdio) exposes the orchestrator as an MCP
server. Add it to Muse's MCP config like you did for `zo-memory` in step
03. This is the **dispatch bridge**: from here on, "run this across the
workshop" is something Muse can do without you leaving chat.

## Prove it

- [ ] `doctor` (both sides) green for 2+ executors
- [ ] A 2-task DAG ran end to end; `status` shows the ledger rows
- [ ] You've seen a fallback happen (or simulated one) and the ledger
      explains it
- [ ] You know where the ledger lives and how to read it

Next: [05 — Hooks](05-hooks.md).
