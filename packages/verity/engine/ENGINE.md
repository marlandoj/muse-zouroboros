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
