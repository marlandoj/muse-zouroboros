# Walkthrough 07 — Verify and operate

## Run the full check

```bash
cd ~/workspace/zouroboros-for-muse
bash scripts/verify.sh
```

This probes every system — memory store/search round-trip, executor doctor,
orchestrator status, hook shadow logs present, factory smoke — and reports
red/green per system with the exact command to dig deeper. Green across the
board is your "workshop is real" certificate. Save the output; it's your
baseline for "did something break?" later.

## Install the read bridge

`examples/workshop-status.sh` is a small script Muse can run anytime: swarm
health, factory queue state, recent hook verdicts, harness versions, memory
fact count. Each section degrades independently — a downed factory doesn't
break the memory check.

Point Muse at it. From now on, "is the workshop healthy?" is a question
Muse answers by running a script, not by asking you.

## Make the shadow → live decisions

You now have a week (or more) of evidence. For each hook, decide per
harness and per check:

- **wayfinder:** flip `live` where the suggestion report agrees with your
  judgment. It's one appended line of context — low blast radius.
- **verity:** start live with one check (tests) on one harness. Expand
  only when the verdicts keep being right.
- **sift:** enable live pruning only where the harness exposes a supported
  interface *and* the shadow evidence shows clean protects.

The rule doesn't change: enforcement is earned. If a hook's shadow log
ever stops making sense, flip it back to shadow and investigate — that's
not failure, that's the system working.

## Day-two operations

- **Weekly:** skim the hook reports (5 min). Skim new memory facts for
  noise (5 min). Check the swarm ledger for surprising routes (5 min).
- **Monthly:** review factory post-flights in aggregate — is "done"
  drifting? Re-run `verify.sh` and diff against your baseline.
- **On harness updates:** a CLI update can break a bridge. `doctor` catches
  it before a real task does — run it after every CLI upgrade.
- **On VM replacement:** re-run `bootstrap.sh` (idempotent), re-run
  `verify.sh`, re-install hooks. Your database and registry edits persist
  in `$HOME`; the rest is reproducible.
- **Costs:** the factory is your heaviest token spend by design. Set
  per-run budgets in seeds, and route deliberately: subscriptions you
  already pay for do the heavy work; chat stays for orchestration.

## The boundary, written down

Keep this where you'll see it:

- **Muse:** you, your relationships, your schedule, notifications,
  approvals, personal memory.
- **Workshop:** building, multi-model execution, verified delivery,
  harness knowledge, code review.
- **The bridge carries status and work requests. Never credentials.**

When a new need appears, filter it through that boundary before building
anything. Most "should the workshop do X?" questions answer themselves.

## You're done — and started

The workshop is installed, verified, and observed. It gets better from
here: every fact stored, every ledger row, every shadow verdict is training
data for your judgment about what to automate next. That's the actual
product — not the scripts, but the calibrated trust you build running them.
