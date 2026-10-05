# Wayfinder → Software Factory wiring, shadow mode

Date: 2026-09-29 · Host: marlandoj · Mode: **shadow** (no prompt is ever injected)

## What is wired

| Piece | Value |
|---|---|
| Repo | `marlandoj/wayfinder` @ `c65183c` (local clone `Projects/wayfinder`) |
| Engine | `local:bm25+ms-marco-MiniLM-L-12-v2/fusion-v1` |
| Catalog roots | `/home/workspace/Skills:/root/.agents/skills` → **84 skills** |
| Hook | `Projects/zouroboros-software-factory/.claude/settings.json` → `UserPromptSubmit` |
| Hook command | `WAYFINDER_SKILLS_ROOTS=… bash Projects/wayfinder/scripts/wayfinder-hook.sh claude` |
| Timeout | 6 s |
| State | `/root/.wayfinder/` (mode file, `suggestions.jsonl`, `errors.log`, `backups/`) |
| Discoverability | `Skills/wayfinder` → symlink to `Projects/wayfinder` |

Scope is the factory **project only**. `/home/workspace/.claude/settings.json` has no
`UserPromptSubmit` hook, so every automation-bridge job (workdir `/home/workspace`) invokes
Wayfinder zero times. Verified by grep across live harness config, not by inference.

## On the name

`jev-skill-advisor` did not call Jev. Its decision engine was already local
BM25 + FlashRank, and the comment at `engine/local_rank.py:14` pins
`ENGINE = 'local:bm25+…'` as equal to `jev-skill-advisor decision.LOCAL_ENGINE`.
The "jev" in the old name was a leftover label, not a code path. `engine/` contains no
network call, no `requests`/`urllib` import, and no TypeSafe reference. Wayfinder is the
same engine with a name that matches what it does.

All live `jev-skill-advisor` references on this host are now historical: dated session
transcripts, `/dev/shm` log lines, and a `session_store.db` row. No harness config points
at it. The pre-Wayfinder `skill-suggest-shadow-hook.sh` entry that `install.sh` migrates
is already gone from the factory's `settings.json`.

## Measured on the real catalog

`scripts/shadow-report.py` replays 12 author-labeled cases through the production
`local_rank.rank` + `choose` path.

**8/12 top-1 hits (66.7%), 1 abstention.**

```
HIT  REST endpoint on the factory swarm API + 32-case suite → compile-build-spec
MISS run the swarm for this seed yaml and manage the waves   → visual-verifier
SKIP execute this wave in parallel across the worker pool     → (abstained)
HIT  premarket movers, rank by gap percent                   → jhf-daily-top5
HIT  new avatar portrait for the persona                     → heygen-avatar
HIT  audit governance policy, post-flight evidence report    → zouroboros-governance
HIT  interrupted mid-run, recover checkpoint, finish contract → automation-resilience
MISS search workspace memory for prior decisions             → rag-freshness
HIT  which tier is this and what model should answer          → tier-resolver
HIT  screenshot the site, check layout against UX rules      → ux-laws
MISS churn is high, diagnose before changing code            → host-resilience-probe
HIT  product launch video with voiceover and captions        → academy-video-pipeline
```

## The finding that matters for promotion

Every miss is a **Zo-internal skill**. Hits are `heygen-avatar`, `tier-resolver`,
`automation-resilience`, `jhf-daily-top5`, `ux-laws` — skills whose descriptions use
language a general-purpose MS MARCO model has seen. Misses are `zo-swarm-orchestrator`,
`zo-memory-system`, `ponytail-audit` — skills whose vocabulary is factory jargon
(*seed yaml, wave, worker pool, churn*).

Cross-encoder score distribution over the labeled set (240 scored passages):

```
p50 1.3e-05 · p90 0.000203 · p99 0.831847 · max 0.977539
above cross_floor 0.0004 → 20 / 240
```

The floor was tuned on the 2026-09-23 diagnostic against a different catalog. On this
one it sits in a near-empty band: most correct answers score either far above it
(0.5–0.98) or far below (1e-05). `zo-swarm-orchestrator` scores `4.4e-05` on
"run the swarm for this seed yaml" — 10× under the floor — while the wrong
`visual-verifier` scores `0.002586`, 6× over it. Lowering the floor does not fix this;
the ranking order itself is wrong on factory vocabulary.

This was not a truncation bug. `passage()` caps descriptions at 500 chars, but every
failing description is shorter than that and present in full.

## Recommendation: keep it in shadow

Injection cost is real and the accuracy is not yet sufficient for the factory's own
skills — the exact case it was wired for. Shadow mode costs one detached rank per
factory prompt and injects nothing.

Two things would justify promoting to live:

1. A labeled set weighted toward `zo-swarm-*`, `zo-memory-system`, and
   `zo-ask-governor`, with the re-ranked `zo-*` descriptions reaching top-1.
2. Option A above: add the *category aliases* a factory operator actually says
   (`swarm`, `seed`, `wave`, `worker pool`, `closure`, `eval`, `gates`) to the
   `zo-*` SKILL.md descriptions, then re-run `python3 scripts/shadow-report.py`.
   This is a one-line-per-skill documentation change and needs no re-tuning.

Switch with `bash scripts/wayfinder.sh mode live`. Roll back to
`bash scripts/wayfinder.sh mode shadow`, or `off` for the kill switch. No config file
is rewritten by a mode switch, so rollback is a one-word write.

## Regression

`bash test/run.sh` → **66 passed, 0 failed** after adding `scripts/shadow-report.py`.
