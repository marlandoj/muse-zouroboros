# Factory lane: the conveyor

## What it is

The software factory turns **tickets into verified pull requests** through a
governed, mostly-autonomous pipeline. The live path is the **conveyor**:
you label a Linear issue `factory-ready`, and the lane pulls it, validates a
5-field contract, builds it with the swarm, evaluates the result, and opens
a PR. Linear is the signal surface — it never executes code.

Two invariants never change:

1. **The workshop is the sole execution, verification, rollback, and
   promotion authority.** A ticket naming any other executor is rejected
   mechanically.
2. **Fail closed.** Missing evidence, unknown cost, ambiguous authority, or
   unknown states resolve to rejection or a non-success terminal state —
   never a permissive default.

## The cycle

```
Linear Intake project
  │  (you label a ticket `factory-ready`)
  ▼
linear-puller.ts ──► pulls factory-ready tickets, reaps stale labels
  ▼
ticket-contract.ts ──► validates the 5 required contract fields
  │                     (fail-closed → needs-triage)
  ▼
seed YAML ──► the build spec: repo, base commit, tasks, acceptance criteria
  ▼
swarm execution ──► multi-model build via the orchestrator
  ▼
post-flight eval + gap audit ──► did it meet the contract? what's missing?
  ▼
verified PR ──► Linear writeback (state, links, receipts)
```

The 5-field contract is the whole game: get the contract right and the rest
is mechanics. See `factory/lane/contracts/` for the schema and
`factory/lane/seed-sf001-conveyor.yaml` for a complete example seed.

## Start with the MVP

`factory/lane/MVP_PATH.md` defines the minimum viable factory: one queue,
one worker, one worktree, one gate. Prove it before anything else:

```bash
cd factory/lane
bun scripts/factory-mvp.ts smoke
```

Deterministic, zero model calls, zero production state. If smoke fails, stop
— the lane's assumptions about your machine are wrong, and the smoke output
tells you which. Pool, fleet, and auto-merge are opt-in expansions documented
in `OPERATORS_MANUAL.md`; don't enable them until the MVP is green for a week.

## The operator's manual

`factory/lane/OPERATORS_MANUAL.md` is the complete guide: ticket lifecycle,
label semantics, the puller's reaping rules, contract validation details,
seed authoring, the approval gate, rollback, and the run receipts that make
every build auditable. Read it before labeling your first real ticket.

## Filing from Muse (the dispatch bridge)

The intended Muse integration: instead of a long inline coding session, Muse
drafts the 5-field contract from your request, you approve it, and Muse files
the ticket (Linear issue + `factory-ready` label, or a seed YAML dropped in
the lane's intake). The lane builds, verifies, and reports back; Muse
surfaces the PR. Sketches and one-offs stay in chat — the factory is for
work with acceptance criteria.

What Muse needs for this: Linear access (your connector or the lane's
`line-config.json`), the contract schema from `factory/lane/contracts/`, and
the repo + base commit the seed pins.

## Operating notes

- **Contracts are reviewed by you.** The lane validates shape, not wisdom.
  A well-formed bad idea still builds.
- **Watch the first five runs.** Read the post-flight evals and gap audits
  end to end; they teach you what the lane considers "done".
- **Keep the intake clean.** The puller reaps stale `factory-ready` labels
  on a schedule — don't fight it, fix the ticket.
- **The native Linear event loops exist but are OFF.** They were built,
  merged, tested, and deliberately disabled pending enablement
  preconditions (see OPERATORS_MANUAL §6). Don't enable them casually.
- **Cost.** Factory runs are the heaviest token spend in the workshop by
  design — that's what your subscriptions are for. Set per-run budgets in
  the seed.

## What this package changed from upstream

Vendored as a curated subset: the lane runtime (`scripts/`, `config/`,
`contracts/`, `templates/`), the operator docs, representative seeds, and
the JSON configs. Historical experiment directories, interview notes,
progress logs, and release archives were left behind. The de-Zo lane fixes
(harness-only dispatch, bounded memory-headroom wait, sandbox binary
resolution) are included. See `docs/de-zo-notes.md`.
