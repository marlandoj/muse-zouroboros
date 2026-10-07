# Rubric Rewrite A/B Report — v1 → v2

Generated: 2026-06-30T21:31:24.234Z
Draft source: **deterministic scaffold**
Model: `hf:zai-org/GLM-5.2`

> **ADVISORY.** This proposes a rubric successor and measures it. It does NOT edit
> consensus-gate.ts. Approve `rubric.v2.md` before any change ships.

## Annotation patterns (held-out)

```json
{
  "total": 8,
  "overEscalateClean": 5,
  "overEscalateDefect": 1,
  "dissentNoise": 2,
  "dissentMiss": 0,
  "byCategory": {
    "correctness": 5,
    "type": 1,
    "security": 2
  }
}
```

## Proposed additive clauses

1. DECISIVENESS ON CLEAN CODE: If every concern you can identify is low-severity, return "pass": true with a confident verdict. Uncertainty about callers, scale, or upstream validation is itself "low" per the rubric above — it is NOT a reason to hedge, abstain, or lower your confidence. (Derived from 5 held-out case(s) the panel could not agree on, where a human verified the code as acceptable.)

2. DECISIVENESS ON CLEAR DEFECTS: When a blocking defect is unambiguous and visible in the code itself (a literal type mismatch, a direct injection sink, an obvious crash), assign "high" severity and return "pass": false with high confidence. Do not soften a clear defect into an uncertain verdict. (Derived from 1 held-out case(s) the panel could not agree on, where a human verified the code as a definite defect.)

## A/B on calibration seed (test-cases.json)

```
Running A/B on 28 cases × 2 versions with hf:zai-org/GLM-5.2 ...
  old 1/28 cases  old 2/28 cases  old 3/28 cases  old 4/28 cases  old 5/28 cases  old 6/28 cases  old 7/28 cases  old 8/28 cases  old 9/28 cases  old 10/28 cases  old 11/28 cases  old 12/28 cases  old 13/28 cases  old 14/28 cases  old 15/28 cases  old 16/28 cases  old 17/28 cases  old 18/28 cases  old 19/28 cases  old 20/28 cases  old 21/28 cases  old 22/28 cases  old 23/28 cases  old 24/28 cases  old 25/28 cases  old 26/28 cases  old 27/28 cases  old 28/28 cases
  new 1/28 cases  new 2/28 cases  new 3/28 cases  new 4/28 cases  new 5/28 cases  new 6/28 cases  new 7/28 cases  new 8/28 cases  new 9/28 cases  new 10/28 cases  new 11/28 cases  new 12/28 cases  new 13/28 cases  new 14/28 cases  new 15/28 cases  new 16/28 cases  new 17/28 cases  new 18/28 cases  new 19/28 cases  new 20/28 cases  new 21/28 cases  new 22/28 cases  new 23/28 cases  new 24/28 cases  new 25/28 cases  new 26/28 cases  new 27/28 cases  new 28/28 cases

=== Metrics (vs ground truth) ===
  metric          rubric.v1rubric.v2.proposed        Δ
  accuracy            88.9%    91.3%    +2.4%
  defect_recall       84.2%    87.5%    +3.3%
  clean_pass         100.0%   100.0%    +0.0%
  (call errors — rubric.v1: 1, rubric.v2.proposed: 5)

=== Verdict flips: 7 ===
  cal-004: False -> None (expected False) ✗ away from truth
  cal-006: True -> False (expected False) ✓ toward truth
  cal-007: None -> True (expected False) ~ both wrong
  cal-019: True -> None (expected False) ~ both wrong
  cal-023: False -> None (expected False) ✗ away from truth
  cal-025: False -> None (expected False) ✗ away from truth
  cal-028: True -> None (expected True) ✗ away from truth
```

## A/B on HELD-OUT set (reconciled-holdout.json) — anti-Goodhart, report-only

```
Running A/B on 8 cases × 2 versions with hf:zai-org/GLM-5.2 ...
  old 1/8 cases  old 2/8 cases  old 3/8 cases  old 4/8 cases  old 5/8 cases  old 6/8 cases  old 7/8 cases  old 8/8 cases
  new 1/8 cases  new 2/8 cases  new 3/8 cases  new 4/8 cases  new 5/8 cases  new 6/8 cases  new 7/8 cases  new 8/8 cases

=== Metrics (vs ground truth) ===
  metric          rubric.v1rubric.v2.proposed        Δ
  accuracy           100.0%   100.0%    +0.0%
  defect_recall      100.0%   100.0%    +0.0%
  clean_pass         100.0%   100.0%    +0.0%
  (call errors — rubric.v1: 4, rubric.v2.proposed: 4)

=== Verdict flips: 0 ===
```
