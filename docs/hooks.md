# Hooks: wayfinder, verity, sift

Three small programs that run on harness events — prompt submitted, tool
used, agent finishing — across your CLI harnesses. They are the workshop's
immune system: cheap, local, and **shadow-first**.

The golden rule for all three: **install in shadow, read the report, then
decide what goes live.** A hook that crashes answers `{}` and the agent never
notices. Enforcement is earned, not defaulted.

## wayfinder — the skill suggester

Runs once per user prompt in each wired harness. Ranks your installed
`SKILL.md` files locally (BM25 + FlashRank, no network) and:

- **shadow** (default): logs the would-be pick to
  `~/.wayfinder/suggestions.jsonl` (prompt SHA-256 only, never text).
- **live**: appends one suggestion line to the model's context.
- **off**: kill switch.

```bash
cd packages/wayfinder
bash scripts/install.sh --dry-run   # see what it would change
bash scripts/install.sh             # idempotent; backs up configs first
bash scripts/wayfinder.sh report    # what it would have suggested, per harness
bash scripts/wayfinder.sh mode live --harness codex   # flip one harness
```

Catalog roots: `WAYFINDER_SKILLS_ROOTS` (colon-separated; first wins on
duplicate names). The ranking model downloads once via
`python3 scripts/setup_model.py` — prompt hooks never download.

Needs: Linux, Python 3.11+, `flashrank`, `jq`, bash, GNU timeout.

## verity — the "done" gate

Coding agents declare victory early. Verity keeps an append-only ledger of
every edit and every check (test/build/lint/typecheck), and when the agent
tries to finish after changing code with no passing check since, it can
**refuse the finish** and say what's missing. It also flags secrets written
into files, deleted or skipped tests, and piped commands (`npm test | tail`)
that hide failures.

The engine is [Canny](https://github.com/qkal/Canny) by Kal (MIT © 2026) —
not vendored; the installer clones it at pinned commit `f2c5e53` (v0.3.0).
Verity adds Kimi/Gemini adapters, the shadow wrapper, per-harness and
per-check live switches, a cross-harness report, and a config-preserving
installer. Canny's optional model is disabled (key stripped, endpoint dead) —
no text leaves the host, by construction.

| Harness | Wiring | Notes |
|---|---|---|
| Claude Code | `.claude/settings.json` hooks | native |
| Codex CLI | `.codex/hooks.json` | approve once via `/hooks` in an interactive session |
| Kimi Code | `~/.kimi-code/config.toml` | via `scripts/adapter.mjs` |
| Gemini CLI | `~/.gemini/settings.json` | via `scripts/adapter.mjs` |

OpenCode, Pi, and Hermes have no hook that can refuse a finish — verity
doesn't support them. That's an honest platform limit, not a bug.

```bash
cd packages/verity
bash scripts/install.sh            # shadow mode; clones Canny pinned
bash scripts/verity.sh status      # current mode per harness
bash scripts/verity.sh report      # verdicts it would have returned
bash scripts/verity.sh mode live --harness claude --checks done
```

Start live with one check (`done`) on one harness. Expand after a week
of shadow logs you agree with. `verity.sh reset --harness claude` drops a
harness back to shadow.

## sift — the context pruner

Repeated tool output eats context windows. Sift fingerprints tool calls and
results, and proposes shortening an older result only when the same tool,
arguments, and exact output recur later — with the original stored,
verified, and recoverable via a reference. It protects instructions,
failures, unknown tools, ambiguous pairs, the first two and latest eight
messages. Changed content never qualifies. No model required.

Honest per-harness table (live request pruning depends on what the harness
exposes):

| Harness | Shadow | Live pruning |
|---|---|---|
| Claude Code | fingerprints; analyze at compaction | not in this release |
| Codex CLI | fingerprints; analyze at compaction | not exposed by its hook |
| Kimi Code | fingerprints + boundary receipts | not exposed by its hook |
| Gemini CLI | fingerprints + boundary receipts | tool history omitted from `BeforeModel` view |
| OpenCode | request analysis | **supported** |
| Pi | request analysis | **supported** |
| Hermes | request analysis | **supported** (Chat Completions + Responses) |

```bash
cd packages/sift
python3 scripts/install.py --project ~/workspace --dry-run   # review first
python3 scripts/install.py --project ~/workspace
python3 scripts/sift.py status    # check state before changing modes
python3 scripts/sift.py report    # shadow evidence
```

## Operating notes

- **One harness at a time.** Install everywhere in shadow; flip live per
  harness after you've read its report.
- **The reports are the product.** Even if you never go live, a week of
  wayfinder suggestions tells you which skills are actually load-bearing,
  and a week of verity verdicts tells you which agents cut corners.
- **Rollback is trivial.** Installers back up the configs they touch;
  `mode off` / uninstall restores them.
- **Keep them boring.** These run on every prompt and every tool call. If a
  hook ever feels slow, check its log first — the 5-second rule applies:
  no hook should add perceptible latency.
