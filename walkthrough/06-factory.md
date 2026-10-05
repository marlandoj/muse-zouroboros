# Walkthrough 06 — Factory

## Prove the lane before trusting it

```bash
cd ~/workspace/zouroboros-for-muse/factory/lane
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

## The Muse seam

From here on, the intended pattern: you describe the work in chat, Muse
drafts the 5-field contract, you approve it, Muse files the ticket. The lane
builds and verifies; Muse surfaces the PR. What Muse needs: Linear access,
the contract schema, and the repo + base commit for the seed. Sketches and
one-offs stay in chat — the factory is for work with acceptance criteria.

## Prove it

- [ ] `factory-mvp.ts smoke` green
- [ ] You've read `OPERATORS_MANUAL.md` and `MVP_PATH.md`
- [ ] One real ticket went label → verified PR, and you read its post-flight
- [ ] You can explain what `needs-triage` means and why it's correct

Next: [07 — Verify and operate](07-verify-and-operate.md).
