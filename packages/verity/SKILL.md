---
name: verity
description: Verity is a cross-harness done-gate built on Canny (qkal/Canny by Kal, MIT). It records every edit and check in Claude Code, Codex CLI, Kimi Code and Gemini CLI, and refuses a "done" claim when code changed with no passing test, build, lint or type-check since; it also guards against secrets in written files, deleted tests and piped test commands. Defaults to shadow mode (log only); `scripts/verity.sh mode live` enforces, scoped per harness and per check. Use to review verdicts, switch shadow/live, decide promotion, or disable it.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# Verity

**Repo:** private `marlandoj/verity` (this directory is its checkout; renamed from `canny-shadow` on 2026-09-23).
**Engine:** Canny by Kal, `Integrations/canny` pinned at `f2c5e53` (v0.3.0). Credit it in anything public.
**Tracking:** ZOU-1680. Promotion review 2026-10-07.

## Wiring on this host

All entries call `scripts/verity-hook.sh <harness>`. Pre-rename and pre-install copies are in
`Backups/claude-settings/` and `Backups/harness-config/`.

| Harness | Config | Scope | Notes |
|---|---|---|---|
| Claude Code | `/home/workspace/.claude/settings.json` | sessions in /home/workspace | native |
| Codex CLI | `/home/workspace/.codex/hooks.json` | sessions in /home/workspace | native; inert until the operator approves once with `/hooks` in interactive Codex |
| Kimi Code | `/root/.kimi-code/config.toml` `[[hooks]]` | every Kimi session | `adapter.mjs kimi` in, `--out kimi` for live |
| Gemini CLI | `/root/.gemini/settings.json` `hooks` | every Gemini session | `adapter.mjs gemini` in, `--out gemini` for live |

Jev is off in both modes: `TYPESAFE_API_KEY` is unset for the child and `CANNY_JEV_URL` points at a dead port.
Every failure path answers `{}` (fail open).

## Mode

Current mode is **shadow** everywhere. Switching to live is an operator decision; do not do it on your own.

```bash
bash Skills/verity/scripts/verity.sh status
bash Skills/verity/scripts/verity.sh mode live [--harness NAME] [--checks done,deny,ask,rewrite,note,warn]
bash Skills/verity/scripts/verity.sh mode shadow [--harness NAME]
bash Skills/verity/scripts/verity.sh reset [--harness NAME]
VERITY_MODE=shadow|live  VERITY_CHECKS=...  VERITY_DISABLE=1      # per-process overrides
```

Config: `~/.verity/config.json`, read on every hook call (no restart needed).

## Files

| Path | Holds |
|---|---|
| `~/.canny/sessions/*.jsonl` | Canny's ledger. Command lines can contain secrets (owner-only dir) |
| `~/.verity/verdicts.jsonl` | Every non-empty verdict with harness, mode, kind, `applied`, latency (history migrated from `~/.canny/shadow.jsonl`) |
| `~/.canny/errors.log` | Canny crashes |

## Commands

```bash
bash Skills/verity/scripts/install.sh --project /home/workspace   # wire hooks (idempotent, backs up, migrates canny-shadow entries)
bash Skills/verity/test/run.sh                                  # hermetic tests (46)
bash Skills/verity/scripts/report.sh                            # verdicts, applied count, latency, crashes
node Integrations/canny/dist/cli.js status                        # latest session ledger
```

## Promotion criteria (review 2026-10-07)

1. `done` blocks: sample each against its session. False positive when verification was something Canny doesn't
   count (`bun Skills/x/scripts/y.test.ts`, curl smoke tests); add those as `verify` regexes in a trusted
   `.canny.json` first.
2. `deny`: every one must be a real secret or test deletion. Promote first: `verity.sh mode live --checks deny`.
3. p50 under 250 ms per tool call, zero crashes.
4. Then add `done`.
