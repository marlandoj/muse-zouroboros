# PROGRESS — Drop stale Ollama references

status: complete
watchdog: off
started: 2026-09-29
completed: 2026-09-29
scope: `marlandoj/zouroboros-memory-system` @ `main` (21eee06)
branch: `fix/drop-stale-ollama-references`

## Objective

`main` advertised Ollama `nomic-embed-text` as the default embedding backend in
README, SKILL, and the reference docs, and in code comments / CLI help. That has
been false for some time: `scripts/model-client.ts` resolves embeddings to
`openai:text-embedding-3-small` and its `Provider` type is
`"openai" | "anthropic"` — Ollama is not a routable provider at all.

## Findings

- [x] Docs were stale, not the runtime. `model-client.ts` never referenced Ollama.
- [x] Two legacy benchmark scripts still made real Ollama HTTP calls:
      `benchmark-v2-v3.ts`, `embedding-benchmark.ts`.
- [x] `test-wikilink-enforcement.ts` uses `tool.ollama` as a synthetic wikilink
      fixture entity — a test string, not a provider claim. Left as-is.

## Changes

- [x] `README.md` — default routing, prerequisites, model table, env config (7)
- [x] `SKILL.md` — frontmatter, feature list, model table, exit codes, config (16)
- [x] `references/model-config.md` — supported providers, `OLLAMA_URL` (3)
- [x] `references/supermemory-concepts.md` — local-vs-hosted framing (2)
- [x] `BACKLOG.md` — MEM-101/102/104/202 descriptions, MEM-204 (5)
- [x] `BENCHMARK_REPORT.md` — mark the run's embedding model as superseded (1)
- [x] `SIDE_BY_SIDE_COMPARISON.md` — feature matrix + latency row (3)
- [x] `scripts/benchmark-v2-v3.ts` — ported the embed lane to `model-client`'s
      `embeddings()`; `--skip-ollama` kept as a legacy alias for
      `--skip-embeddings` (18)
- [x] `scripts/embedding-benchmark.ts` — hard retirement guard behind
      `ZO_ALLOW_RETIRED_EMBED_BENCH=1` (6)
- [x] Stale labels in `fact-extractor.ts`, `memory.ts`, `session-briefing.ts`,
      `test-capture.ts`, `package.json` (6)

## Verification

- [x] `tsc --noEmit` — 0 errors
- [x] `test-tarjan` 20/20, `test-wikilink-enforcement` 47/47, `test-capture`
      32/32, `test-graph` 22/22, `graph-gate.test.ts` 10/10
- [x] `embedding-benchmark.ts` exits 1 with the retirement message
- [x] `benchmark-v2-v3.ts` live: `Embeddings: ✓ (1536d via openai/text-embedding-3-small)`

## Notes

The remaining 30 `ollama` hits are intentional: retirement notices, the guarded
retired script, v2.0.0–v4.0.0 changelog rows (an accurate record of what
shipped), and the wikilink test fixture.

Four cleanup commits already existed on the local branch
`feat/graph-primary-briefing-model` (`b303629`, `44b09fe`, `ef2aa11`, `8580ab8`)
and were never merged to `main`. They were **not** cherry-picked: `b303629` also
adds `trace.ts` / `mimir-academy-rag.ts` imports and an `expires_at` FTS filter,
and conflicts with `main`'s `inlineFtsCandidates` refactor. Those functional
changes are out of scope here and remain unmerged.
