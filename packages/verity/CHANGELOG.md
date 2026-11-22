# Verity Changelog

## Unreleased

### Fix B: Gate Hygiene (Pre-flight contamination stop + verdict attribution)

- Pre-flight contamination check (`preflight` in `engine/swarm.js` and `engine/cli.js`):
  - Scans loose workspace files and untracked repository files before executor attempt spawn for secret-shaped strings using `findSecrets`.
  - Stops contaminated workspaces with zero executor tokens burned.
- Verdict attribution:
  - Added `inDiff: boolean` to all findings in `diffRules` and loose file scans.
  - Added `allOutsideDiff` and `verdictClass` computation to classify all-outside-diff findings as `contamination` rather than candidate `verify_failed`.
- Hermetic test suite:
  - Added complete hermetic test suite in `packages/verity/test/swarm-verify.sh` covering 85 tests including pre-flight contamination stops, verdict attribution, and all gauntlet rules.
