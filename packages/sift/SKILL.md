---
name: sift
description: Inspect and conservatively prune repeated tool output in coding-agent histories, with private recovery archives and explicit per-harness support. Use for Sift setup, compaction analysis, shadow reports, mode changes and archive recovery.
metadata:
  author: marlandoj.zo.computer
---

Read [README.md](README.md) for installation and the support matrix. Use `python3 scripts/sift.py status` before changing modes.

- `analyze --format <harness> --input /absolute/history.json` proposes changes without archiving or changing history.
- `export --format <harness> --input /absolute/history.json --output /absolute/new-history.json` creates a separate pruned copy and private recovery objects. Never replace a harness database or active transcript with the export.
- `recover <sha256>` verifies and writes original output to stdout. Recovery output may contain private data; send it only to the intended local file or authorized consumer.
- Shadow is the default. Only OpenCode, Pi and Hermes support Sift live request pruning in this release. Codex, Claude, Kimi and Gemini have observer hooks; do not claim their histories were shortened.
- `review` invokes a caller-selected executable only on explicit request. Its output is advisory; it cannot remove context. Keep ambiguous material verbatim.
- Original messages, tool arguments, failures, unmatched tool results and recent messages remain protected. Model context after live pruning contains recovery references; it is not a claim that shortened output remains verbatim in context.
- Use `off` for immediate rollback. Config backups preserve pre-install files; do not restore whole configs over unrelated later changes.
