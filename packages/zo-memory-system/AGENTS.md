# AGENTS.md — zo-memory-system

## Recent session lessons (2026-03-18)

- Concern addressed: personas were not reliably recalling facts, session narrative, and open loops from a few days ago.
- Product decision: continuation recall should work automatically for **all personas** when a message looks like continuation work, with **silent injection** and **no visible UX changes**.
- Recall window decision: default **14 days**.
- Retrieval decision: use **blended retrieval** across facts, episodes, and first-class open loops rather than separate silos.
- Precision/recall decision: bias toward **missing less relevant context less often**; false negatives are worse than mild false positives.
- Architecture constraints: **no new always-on service**, **SQLite/local-first**, graceful fallback when optional local model steps are unavailable.
- Implementation lesson: open loops need to be **first-class stored objects** to support reliable unresolved-task recall.
- Implementation lesson: continuation detection needs a **heuristic-first path** for speed/reliability, with model-assisted memory lookup as a fallback rather than the only gate.
- Implementation lesson: fallback capture must still preserve open loops even when extraction models are unavailable.
- Quality lesson: imported/archive facts can dominate retrieval unless continuation ranking emphasizes **recency**, **lexical overlap**, and excludes noisy historical sources.
- Verification lesson: a local regression harness with fixed scenarios is essential; the session produced `assets/continuation-eval-fixture-set.json` and `scripts/eval-continuation.ts`.
- Acceptance target set in this session: **85%** success on 14-day continuation scenarios; current local fixture run achieved **100% (10/10)**.

## Files added/updated in this session

- `scripts/continuation.ts`
- `scripts/eval-continuation.ts`
- `assets/continuation-eval-fixture-set.json`
- continuation-related updates across `scripts/memory.ts`, `scripts/memory-gate.ts`, `scripts/auto-capture.ts`, `scripts/conversation-capture.ts`, `scripts/test-capture.ts`, `scripts/schema.sql`, `scripts/migrate-v3.sql`, `scripts/rollback-v3.sql`, `README.md`, `SKILL.md`, and `scripts/install.sh`

## Recommended future work

- Add scheduled regression runs for continuation eval.
- Improve ranking calibration with real conversation transcripts from the prior 14 days.
- Consider a dedicated summary compaction pass for recent episodes so continuation context stays concise under heavy usage.
