# Versioned Prompt Experiments

Run immutable paired experiments through the existing prompt A/B entry point:

```bash
python3 packages/consensus-gate/scripts/prompt-ab.py experiment validate --manifest manifest.json
python3 packages/consensus-gate/scripts/prompt-ab.py experiment replay --manifest manifest.json
python3 packages/consensus-gate/scripts/prompt-ab.py experiment run --manifest manifest.json --resume
```

Manifests support `persona` and `skill` subjects, two or more prompt variants,
a frozen dataset version, paired hash ordering, an explicit single evaluator,
tools-disabled offline or model adapters, hard case/call/cost/wall budgets, and
declared minimum sample/delta thresholds. Each run writes append-only raw case
evidence plus atomic state. Results never promote a winner; promotion remains a
separate operator-approved action.
