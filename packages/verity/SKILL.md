---
name: verity
description: Verity is a cross-harness done-gate with a clean-room engine. It records every edit and check in Claude Code, Codex CLI, Kimi Code and Gemini CLI, and refuses a "done" claim when code changed with no passing test, build, lint or type-check since; it also guards against secrets in written files, deleted tests and piped test commands. Defaults to shadow mode (log only); `scripts/verity.sh mode live` enforces, scoped per harness and per check. Use to review verdicts, switch shadow/live, decide promotion, or disable it.
compatibility: Created for Zo Computer
metadata:
  author: marlandoj.zo.computer
---

# Verity

**Repo:** `marlandoj/verity` (this directory is its checkout; renamed from `canny-shadow` on 2026-09-23). As of the 2026-10-24 Stage 1 check the repo clones anonymously, i.e. it is **not** private; whether it should be is an open operator decision. The canonical copy for the VPS swarm is `packages/verity` in the workshop repo (`/opt/zouroboros/workshop/repo`); never re-pull from upstream, the VERITY-ADOPTED amendments in `scripts/verity-hook.sh` would be lost.
**Engine:** Verity's clean-room engine in `engine/` (Node ESM, no dependencies).
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
Failure handling (VERITY-ADOPTED amendment, 2026-09-29): **shadow** answers `{}` on every failure path; **live** fails closed when the hook cannot run the engine or gets no usable verdict. Known gap (Stage 1 finding #5, deferred to interactive hardening): the engine itself still answers `{}` on malformed input, and the hook accepts that as a verdict, so that one path is open in live mode on all four harnesses.

## Swarm gate (orchestrator-run)

The interactive hooks above gate a *session*. The swarm path is gated differently: `scripts/orchestrate-v5.ts` runs `engine/cli.js snapshot` before a task's first attempt and `engine/cli.js verify` after a declared success, diffing the workspace (committed, staged, unstaged and untracked work) and running the trusted check itself. No harness hook is involved, so it covers Hermes, Pi and OpenCode too. See `README.md` → "Swarm gate" and `packages/zo-swarm-orchestrator/docs/verity-swarm-gate.md`.

## Supervising wrapper (hybrid Phase 2, shadow)

`engine/cli.js run -- <harness command>` supervises a whole session from outside the harness. It snapshots the workspace (a shadow git dir under `$VERITY_HOME/shadow-git/` for a non-git directory, pruned when the run completes), spawns the child with inherited stdio, verifies on exit with the swarm gate's machinery, writes `$VERITY_HOME/runs/<run-id>/feedback.md`, and records the verdict (`surface: "cli"`) in `~/.verity/verdicts.jsonl`. `engine/cli.js gate` is the read-only checkpoint against the active run's base, and it takes **no** allowance, waiver or check flag (usage error 64; K7). Checks and allowances come from the trusted `.verity.json` only. The session's git sees a Verity-owned `core.hooksPath` through `GIT_CONFIG_COUNT/KEY/VALUE`. Its hooks chain to the repo's own hooks (husky and the rest), with the repo hook's exit status, and its `pre-push` records secrets, test deletion and skip markers over the outgoing range. A layout it cannot chain is recorded as `chain: "unverifiable:<reason>"`. `--no-verify`, `git -c core.hooksPath=…` and the like are deliberate bypass, out of the threat model.

**This phase ships shadow-only:** the wrapper records and reports and never blocks; relaunch stays inert. Exit codes: verify and gate `0/1/2/64/70`; run in shadow = the child's code; run in live = the gate's code (a passing workspace is 0 whatever the child exited, and the child's code is recorded); INT or TERM to the wrapper = verify, record, no relaunch, `128+n`. A resolved `live` applies to `run` only with `run.promoted: true` in the Verity config. That is the Phase 3 switch, which this phase does not set; do not set it without that ruling. Relaunch presets (verified against the installed `--help`): claude, codex, kimi, opencode, pi, hermes. Gemini has none. `install.sh --print-aliases` prints suggested aliases and edits nothing. Unverifiable rate for wrapper verdicts (K5): `report.sh` → `cli run unverifiable (K5)`. Details: `README.md` → "Supervising wrapper".

## Mode

This file does not know the deployment's posture; read it with `verity.sh status` (or `node engine/cli.js mode --harness NAME` for one harness as JSON) before relying on it. Switching to live, or back, is an operator decision; do not do it on your own.

How the mode for a harness is resolved, on every hook call, highest first:

1. Environment: `VERITY_MODE` and `VERITY_CHECKS` (when non-empty) override the config for that process. `VERITY_DISABLE=1` turns the engine off in that process; in live mode the hook then fails closed instead of passing quietly.
2. Per-harness override: `.harness.<claude|codex|kimi|gemini>.mode` / `.checks` (set with `--harness`; `status` marks it `[override]`).
3. Global default: `.mode` / `.checks`.
4. Built-in default: `shadow`, checks `all` (also used when the config is absent or unreadable).

`checks` scopes live mode to verdict kinds (`done,deny,ask,rewrite,note,warn` or `all`); kinds outside it are logged but not applied.

```bash
bash Skills/verity/scripts/verity.sh status
bash Skills/verity/scripts/verity.sh mode live [--harness NAME] [--checks done,deny,ask,rewrite,note,warn]
bash Skills/verity/scripts/verity.sh mode shadow [--harness NAME]
bash Skills/verity/scripts/verity.sh reset [--harness NAME]
VERITY_MODE=shadow|live  VERITY_CHECKS=...  VERITY_DISABLE=1      # per-process overrides
```

Config: `$VERITY_HOME/config.json` (default `~/.verity/config.json`), read on every hook call (no restart needed). The hook, `verity.sh` and the orchestrator's gates report all resolve it through `engine/cli.js mode`.

## Files

| Path | Holds |
|---|---|
| `~/.verity/engine/sessions/*.jsonl` | Verity's ledger. Command lines can contain secrets (owner-only dir) |
| `~/.verity/verdicts.jsonl` | Every non-empty verdict with harness, mode, kind, `applied`, latency (history migrated from `~/.canny/shadow.jsonl`) |
| `~/.verity/engine/errors.log` | Engine crashes |

## Commands

```bash
bash Skills/verity/scripts/install.sh --project /home/workspace   # wire hooks (idempotent, backs up, migrates canny-shadow entries)
bash Skills/verity/test/run.sh                                  # hermetic tests (46)
bash Skills/verity/scripts/report.sh                            # verdicts, applied count, latency, by surface, K5, crashes
node Skills/verity/engine/cli.js run -- claude                   # Phase 2: supervise a session (shadow)
node Skills/verity/engine/cli.js gate                            # Phase 2: checkpoint against the active run's base
node Integrations/canny/dist/cli.js status                        # latest session ledger
```

## Promotion criteria (review 2026-10-07)

1. `done` blocks: sample each against its session. False positive when verification was something Verity doesn't
   count (`bun Skills/x/scripts/y.test.ts`, curl smoke tests); add those as `verify` regexes in a trusted
   `.verity.json` first.
2. `deny`: every one must be a real secret or test deletion. Promote first: `verity.sh mode live --checks deny`.
3. p50 under 250 ms per tool call, zero crashes.
4. Then add `done`.
