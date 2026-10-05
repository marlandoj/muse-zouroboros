# Walkthrough 05 — Hooks (shadow mode)

All three hooks install in **shadow mode**: they observe, log what they
*would* have done, and change nothing. Do all three installs now, live your
normal agent life for a week, then read the reports. Enforcement decisions
come in step 07.

## wayfinder

```bash
cd ~/workspace/zouroboros-for-muse/packages/wayfinder
bash scripts/install.sh --dry-run   # review what it would touch
bash scripts/install.sh             # idempotent; backs up configs first
```

Use your harnesses normally for a few days, then:

```bash
bash scripts/wayfinder.sh report
```

Read it per harness. You're looking for: does it suggest skills you'd
actually have wanted? Are there prompts where the top pick is clearly
wrong? The report is also a map of which of your skills are load-bearing.

## verity

```bash
cd ../verity
bash scripts/install.sh
```

This clones the Canny engine at the pinned commit (`f2c5e53`, v0.3.0) —
first install needs network. Canny's model path is disabled at install, so
no prompt or file text leaves your host.

For Codex CLI: approve the new hook once with `/hooks` in an interactive
`codex` session, or it won't fire.

After a few coding sessions:

```bash
bash scripts/verity.sh report   # verdicts it would have returned
```

Count the "would have refused the finish" verdicts. For each one, decide:
was the agent actually done? If verity is right more often than the agent,
it's earning live mode.

## sift

```bash
cd ../sift
python3 scripts/install.py --project ~/workspace --dry-run   # review first
python3 scripts/install.py --project ~/workspace
```

Review the shadow evidence after a week of heavy sessions: what got
fingerprinted, what would have been shortened, and — critically — what was
*protected* (failures, instructions, ambiguous cases should all be there).

## Prove it

- [ ] All three installed without errors; configs backed up
- [ ] `wayfinder.sh report` shows suggestions for real prompts
- [ ] `verity.sh report` shows verdicts for real coding sessions
- [ ] You have opinions about at least one verdict or suggestion
      (that's the point — come back in step 07 with them)

Next: [06 — Factory](06-factory.md).
