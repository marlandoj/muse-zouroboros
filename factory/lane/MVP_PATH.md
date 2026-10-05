# The Minimum Viable Factory Path (FR-10)

The smallest complete factory: **one queue, one worker, one worktree, one gate.**
This is the default setup. Everything else — pool concurrency, fleet campaigns,
auto-merge — is opt-in and OFF until an operator explicitly enables it.

```
enqueue ─▶ supervised lease ─▶ isolated worktree ─▶ implement ─▶ review gate ─▶ harvest
  (queue)     (worker)            (worktree)                       (gate)      (evidence)
```

## Quickstart

```bash
cd /path/to/zouroboros/Projects/zouroboros-software-factory

# Prove the whole path works on this machine (hermetic, deterministic, ~5s):
bun scripts/factory-mvp.ts smoke

# Or run it step by step against durable state:
bun scripts/factory-mvp.ts init     # scaffold isolated state + bounded example repo
bun scripts/factory-mvp.ts run      # run the example through the full lifecycle
bun scripts/factory-mvp.ts status   # read-only snapshot: queue, leases, checkpoints
```

The bounded example project is a two-file TypeScript module created under the
MVP state directory. The task is "make `bun src/verify.ts` exit 0", verified
deterministically inside the isolated worktree. `run` exits non-zero if any leg
of the path fails; `smoke` runs the same path in a throwaway directory and
prints 10 PASS/FAIL evidence checks. There are **zero model calls** and zero
writes outside the MVP state directory.

## What each leg is

| Leg | Module | What the MVP uses |
|---|---|---|
| Queue | `scripts/pool-queue.ts` | One single-task campaign (`enqueueDirect`), cost ceiling, idempotent by campaign id |
| Worker | `scripts/pool-worker.ts` + `scripts/worker-supervisor.ts` | One assignment with a durable worker identity, an exclusive renewable lease, heartbeat sentinel, and checkpoint trail |
| Worktree | `scripts/coding-cascade.ts` | One detached git worktree per assignment, created from a pinned base commit, proven clean before use |
| Gate | `scripts/factory-review-gate.ts` | Deterministic review (`git diff --check`) in enforce mode; consensus review only when policy/risk demands it |
| Harvest | `scripts/pool-manager.ts` | Result sentinel → outcome, lease release, campaign completion; supervisor reconcile runs first |

The worktree is removed **only after** the result checkpoint is durable and the
lease is released — the same evidence-before-cleanup contract production uses
(FR-04).

## Credential scoping

- **The MVP path itself needs no credentials.** Dispatch is mock (no `/zo/ask`),
  the gate is deterministic, and all state is local files.
- **Zouroboros System (de-Zo, 2026-10-03): Zo Computer no longer exists.** Real
  dispatch is local-harness only (Claude Code / Codex / OpenCode via
  `harness-router`): enable a harness lane with `SF_MULTI_HARNESS=1` +
  `SF_MULTI_HARNESS_ENFORCE=1` (or the expertise-router enforce flags). The
  legacy Zo transport (`api.zo.computer/zo/ask`, gated in `pool-worker.ts` and
  `swarm-exec.ts` behind `SF_EXEC_ZO_ASK_FALLBACK=1`) is disabled by default;
  leave that flag unset. Zo-only extras (prespec, persona orchestration,
  signal triage, ship-ready grading, Hetzner/Modal overflow) and the deprecated
  MoA lineup are not used in this system.
- Legacy note (superseded): real Zo dispatch historically required exactly one
  credential, `ZO_CLIENT_IDENTITY_TOKEN`. It is not provisioned in the
  Zouroboros System.
- **Never copy the shared `.env` into a worktree or a worker prompt.** Workers
  receive scoped credentials via their own environment only (FR-04 contract).
- Linear (`LINEAR_API_KEY`) is a conveyor-intake concern; the MVP path never
  reads it. Secrets are sourced per shell and are never echoed or committed.

## Rollback

- MVP state is entirely file-backed under one directory (default `state/mvp/`).
  Full rollback is: `rm -rf state/mvp` then `git -C <example-repo> worktree prune`
  (the smoke command does its own cleanup automatically).
- The MVP path never flips a production flag, so there is nothing to roll back
  in production configuration.
- Production rollback surfaces (for when you graduate past the MVP):
  `scripts/runtime-config.ts rollback` (versioned flag state, FR-02),
  `scripts/auto-rollback.ts` (merge rollback), and the dead-letter +
  orphan-worktree cleanup in `scripts/worker-supervisor.ts` (FR-04).

## Operator authority

- The MVP path runs entirely in mock/deterministic mode and holds **no**
  authority: it cannot approve, merge, push, or contact Linear/GitHub.
- Everything that changes shared state stays operator-only, exactly as in
  production: enforcement flags (`SF002_*`, `SF010_AUTOMERGE`, `SF011_ENFORCE`),
  auto-merge activation, approval ledger decisions, and hold releases.
- Scaling past one worker (`SF003_POOL=1`), fleet campaigns (`SF008_FLEET=1`),
  multi-harness routing (`SF_MULTI_HARNESS*`), and expertise routing
  (`SF_EXPERTISE_ROUTER*`) are each explicit opt-ins; the MVP neither enables
  nor references them.

## Observable outcomes

- `bun scripts/factory-mvp.ts status` — queue, campaign states, worker count,
  active leases, checkpoint count, dead letters for the MVP state dir.
- `run` emits a JSON evidence record: campaign state, lease lifecycle,
  worktree created/cleaned, review verdict, checkpoint stages, dead letters,
  verification exit code, and an explicit `failures[]` list.
- Evidence artifacts on disk (all under the MVP state dir):
  `pool/campaigns.json`, `pool/queue.json`, `pool/assignments/*.json`,
  `pool/results/*.json`, `pool/supervisor/{workers,leases,checkpoints,dead-letters}.json*`,
  `pool/reviews/*`.
- The full production observability surface is FR-09:
  `bun scripts/factory-observatory.ts report` (line, gates, outcome metrics,
  alerts) — read-only, safe to run any time.

## Graduating from the MVP

1. Real dispatch: enable a local harness lane (`SF_MULTI_HARNESS=1` +
   `SF_MULTI_HARNESS_ENFORCE=1`) and drop `--mock` semantics. Zo `/zo/ask`
   dispatch stays disabled (`SF_EXEC_ZO_ASK_FALLBACK` unset).
2. Concurrency: `SF003_POOL=1` with `pool-manager.ts reconcile` (operator-only).
3. Evidence-gated auto-merge: FR-07 canary, `SF010_AUTOMERGE` stays 0 until the
   operator flips it.
