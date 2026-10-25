# Verity Engine — provenance

This directory is a **clean-room reimplementation** of the done-gate engine
Verity previously obtained by cloning `qkal/Canny` at install time.

- **No code is shared** with that implementation. Every module here was
  written from the behavioral specification in `test/fixtures/engine`
  (43 black-box fixture suites: hook-event sequences in, verdicts and
  ledger lines out) plus the architecture notes in
  `~/workspace/goals/verity-done-gate-live-on-codex/files/ai-engineer-design-review.md`.
- The prior implementation's sources were **never read** during this work;
  it was executed only as a black box to record the fixtures and to
  validate the rewrite via differential fuzzing (4,329 events, 0 divergences).
- Before delivery, `engine/` is diffed against the prior `dist/` for
  accidental textual similarity; structural similarity (same CLI contract,
  same ledger format) is expected and intended.
- Post-cutover, the engine carries Verity branding throughout: verdict
  messages use the `Verity:` prefix, and the project config file is
  `.verity.json` (the legacy `.canny.json` name is still honored for
  existing trusted projects, as is the `~/.canny` home for migration).
- Design rule preserved: *facts go to code, judgments go to a model, only
  facts can block.* There is no model on the verdict path — the disabled
  judge of the old engine is absent here by design, not by omission.
- The two constitutional amendments hold: the gate fails closed in live
  mode when the engine cannot answer (see `scripts/verity-hook.sh`), and
  ledgers keep provenance only — paths, commands, and outcomes, never
  file contents.
- **Verity×Swarm Stage 2 (2026-10-25).** `swarm.js` adds the
  orchestrator-run gate (`cli.js snapshot` / `cli.js verify`): the ledger is
  the workspace's git diff between a pre-task base and the post-task state,
  the trusted check runs as a child of the caller, and the verdict is
  `verity.swarm.verdict/1` (paths, labels, fingerprints, command, exit codes,
  hashes — never contents, output or credential text). It reuses
  `isCodeFile`, `looksLikeTestFile` (now exported; `isTestPath` alone misses
  `test_x.py`, `x_test.go`, `*_spec.rb`), `findSecrets`, `repoHasTestFiles`,
  `isVerify` and `rules.decideStop`. Two engine fixes from the Stage 1
  review landed with it, both in `checks.js`: (#3) a trusted `.verity.json`
  pattern no longer short-circuits the masking analysis — it must prefix a
  command segment of the last `;` segment, so `bun test | tail`,
  `bun test; echo ok` and `echo bun test` are not checks once `bun test` is
  trusted; (#4) the hardcoded-credential check tests every
  credential-shaped assignment, not only the first, so a benign
  `password = "changeme"` can no longer hide a real token behind it. Tests:
  `test/swarm-verify.sh`. Not changed here: the interactive hook path's
  Codex `apply_patch` blindness (#1), shell-edit blindness (#2) and the
  malformed-input `{}` answer (#5), all deferred with a documented plan.

- **FP fixes (2026-10-25).** Driven by the adjudication of every
  block-class verdict on record (12 verdicts: 9 true catches, 2 false
  positives, 1 indeterminate; FP rate 16.7% against the <10% promotion
  bar). Both fixes are in `checks.js`: a headless Godot test-runner
  invocation now counts as a check for the done-gate (the script path
  must signal a test run; the masking analysis is unchanged), and
  `detectSecret` treats content as seeded test data when every matched
  credential value carries an explicit fake-data marker
  (`SEED_MARKER_RE`) — any unmarked value still denies, and the `.env`
  branch is unchanged.
