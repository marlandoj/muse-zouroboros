---
name: wayfinder
description: Suggests which installed skill fits the user's prompt, in every CLI agent harness on the host (Claude Code, Codex CLI, Kimi Code, Gemini CLI, OpenCode, Pi, Hermes). Ranks SKILL.md descriptors locally with BM25 + FlashRank, no network. Shadow mode logs the would-be pick; live mode adds one suggestion line to the model's context. Use to install, switch modes, report on, or debug the prompt-time skill suggester.
compatibility: Linux with Python 3.11+, flashrank, jq, bash and GNU timeout; Node 22+ for plugin tests. Works with any shared SKILL.md catalog.
metadata:
  author: marlandoj.zo.computer
---

Wayfinder runs once per user prompt in each wired harness and never blocks the prompt.

- **Engine:** `engine/run.py` (catalog in `engine/catalog.py`, ranking in `engine/local_rank.py`). `jev-skill-advisor` uses the same `local_rank.py` through a symlink.
- **Hook:** `scripts/wayfinder-hook.sh <harness>` for every harness. Harness event shapes and injection formats live in `engine/adapters.py`. OpenCode, Pi and Hermes load small plugins from `plugins/` that call the same hook.
- **Modes:** shadow by default. `bash scripts/wayfinder.sh mode live [--harness H]` switches; `mode shadow` switches back; `off`/`on` is the kill switch. Changes apply on the next prompt.
- **Report:** `bash scripts/wayfinder.sh report` (overall and per harness). Log: `~/.wayfinder/suggestions.jsonl`, prompt SHA-256 only, never text.
- **Install:** `bash scripts/install.sh [--harness ...] [--dry-run]` backs up each config first and is idempotent.
- **Catalog roots:** `WAYFINDER_SKILLS_ROOTS` (colon-separated, first wins on duplicate names); sibling catalog when installed at `Skills/wayfinder`, otherwise `~/.agents/skills`.
- **Model setup:** `python3 scripts/setup_model.py` explicitly downloads the model to `~/.cache/wayfinder` (override with `FLASHRANK_CACHE_DIR`). Prompt hooks never download it.
- **Tests:** `bash test/run.sh` and `python3 test/regression.py` (isolated temp configs, stub engine for hook paths plus cached real ranking).

Read `README.md` for the per-harness table, live-mode formats and rollback.
