# Walkthrough 06 — Factory

## Prove the lane before trusting it

```bash
cd ~/workspace/muse-zouroboros/factory/lane
bun scripts/factory-mvp.ts smoke
```

Deterministic, zero model calls, zero production state: one queue, one
worker, one worktree, one gate. If smoke is red, stop — its output tells
you which machine assumption is wrong. Do not label a real ticket until
smoke is green.

## Read the operator's manual

`factory/lane/OPERATORS_MANUAL.md` — the full guide: ticket lifecycle, label
semantics, the puller's reaping rules, contract validation, seed authoring,
the approval gate, rollback, run receipts. And `MVP_PATH.md` for the
minimum-viable shape. This is the one component where reading the manual
*before* operating is non-optional: the lane fails closed, and you should
know what that feels like before it does it to your ticket.

## Understand the contract

The 5-field ticket contract is the whole game. Look at
`factory/lane/contracts/` for the schema and
`factory/lane/seed-sf001-conveyor.yaml` for a complete example seed: repo,
base commit, tasks, acceptance criteria, budget. A well-formed contract
builds; a vague one gets rejected to `needs-triage` — that's the lane
working as designed, not a malfunction.

## File your first real ticket

Pick something small and real — a utility script, a docs migration, a
refactor with tests. Write the contract carefully (this is where your
judgment lives; the lane validates shape, not wisdom), label it
`factory-ready` in your Linear Intake project, and watch the cycle:

pull → contract validation → seed → swarm build → post-flight eval +
gap audit → PR → Linear writeback.

**Read the first five post-flights end to end.** They teach you what the
lane considers "done" — which is the entire trust proposition.

## The client seam

From here on, the intended pattern: you describe the work in chat, your AI
client drafts the 5-field contract, you approve it, and the ticket is filed
as a Linear issue labelled `factory-ready`. The lane builds and verifies;
the PR comes back to you. Be clear about who files it: **no Community MCP
tool files a factory ticket.** Your client can file it only if it has
Linear access of its own (a Linear connector or Linear MCP) plus the
contract schema and the repo + base commit for the seed; otherwise your
client drafts the contract and you file the issue in Linear yourself. A
seed YAML is the build spec the ticket carries (or one you run by hand per
the operator's manual §3) — there is no watched drop folder to file into.
See [docs/connect.md — the seams](../docs/connect.md#what-the-connections-cannot-do-the-seams).
Sketches and one-offs stay in chat — the factory is for work with
acceptance criteria.

## Meet the review panel

Every ticket that finishes building goes before the consensus panel before
it can become a pull request: a Zouroboros Engineer, a Testing Reality
Checker, plus an AI Engineer and/or Security Engineer when the ticket
calls for them. It runs in **shadow mode** — verdicts recorded, nothing
blocked, you make the calls.

```bash
bash ../scripts/panel-report.sh   # verdicts so far, from the walkthrough folder
```

Read the verdicts on your first tickets, especially the would-have-held
ones. The full guide — what each persona watches for, what enforce mode
does and doesn't do, and the checklist for when enforcement is responsible
— is in `docs/consensus-panel.md`. Don't set `FACTORY_REVIEW_GATE_MODE`
until you've read it.

## Prove it

- [ ] `factory-mvp.ts smoke` green
- [ ] You've read `OPERATORS_MANUAL.md` and `MVP_PATH.md`
- [ ] One real ticket went label → verified PR, and you read its post-flight
- [ ] You can explain what `needs-triage` means and why it's correct

Next: [07 — Verify and operate](07-verify-and-operate.md).
