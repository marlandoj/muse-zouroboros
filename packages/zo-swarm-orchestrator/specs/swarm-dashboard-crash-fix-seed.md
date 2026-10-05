# Seed Spec: Fix swarm-dashboard crash on missing `summary` field

> **Historical note (added 2026-09-15):** The `omnirouteStats` field below belonged to the dashboard as of 2026-03-29. OmniRoute was removed on 2026-04-01.

## Metadata
- **id**: seed-swarm-dashboard-crash-fix-001
- **created**: 2026-03-29
- **author**: spec-first-interview (Front-end Developer persona)
- **root cause confirmed**: `/root/.swarm/results/test-e2e-1.json` has no `summary` field; frontend `runs.reduce((s, r) => s + r.summary.total, 0)` crashes with `Cannot read properties of undefined (reading 'total')`

---

## Goal
Fix the swarm-dashboard React page at `/swarm-dashboard` so it renders without crashing when swarm run result files contain incomplete or malformed data (missing `summary`, missing `config`, missing `results`, etc.).

---

## Constraints
- Must not change zo.space API — API is correct and returning valid data
- Must be a frontend-only fix in the React page component
- Must not alter visual appearance or behavior when data is complete
- Must handle all missing-field patterns found in existing result files

---

## Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC1 | Dashboard renders without crash when `runs` array contains items with `summary: undefined` |
| AC2 | Dashboard renders without crash when `runs` contains items with `config: undefined` (both `concurrency` and `maxConcurrency` variants) |
| AC3 | Dashboard renders without crash when `runs` contains items with `results: undefined` |
| AC4 | Incomplete runs are visually distinguishable in the Recent Runs table (e.g., show `–` or `N/A` instead of crashing) |
| AC5 | Partial run expansion (clicking a row with missing `summary`) shows an empty/missing-state task table gracefully |
| AC6 | All existing safe-navigator patterns (`es || {}`, `safeRA || {}`, etc.) are preserved |
| AC7 | No visual regression on complete runs (all 8 tabs functional with identical layout) |

---

## Ontology

### Core Domain Objects

| Entity | Fields | Notes |
|--------|--------|-------|
| `SwarmRun` | `swarmId`, `sessionId`, `summary`, `results`, `config`, `timestamp` | `summary` may be `undefined` in partial/corrupt results |
| `SwarmRunSummary` | `total`, `successful`, `failed`, `totalDurationMs`, `totalTokensEstimated` | All optional in partial runs |
| `SwarmRunConfig` | `concurrency`, `maxConcurrency`, `timeoutSeconds`, `maxRetries`, `enableMemory`, `maxContextTokens` | Both `concurrency` and `maxConcurrency` variants exist |
| `SwarmRunResult` | `taskId`, `persona`, `executor`, `priority`, `success`, `durationMs`, `retries`, `tokensUsed`, `error` | `results` may be `undefined` |
| `DashboardData` | `runs`, `memory`, `swarmSessions`, `executorStats`, `personaStats`, `modelUsage`, `totalRetries`, `omnirouteStats`, `routingAnalytics`, `tokenBreakdown`, `executorLatencyPercentiles`, `retryAnalytics`, `personaMappingQuality`, `eventAudit`, `runTimeline` | All top-level fields already safely-navigated |

### Safety Pattern Vocabulary

| Pattern | Example |
|---------|---------|
| `x ?? fallback` | Nullish coalescing for primitives |
| `x || defaultObj` | Or pattern for objects/arrays |
| `x?.property` | Optional chaining for deep access |
| `(Array.isArray(x) ? x : []).reduce(...)` | Guard before reduce |
| `(d.summary?.total ?? 0)` | Optional chaining + nullish coalescing combo |

---

## Evaluation Principles

| # | Principle | Weight | Description |
|---|----------|--------|-------------|
| EP1 | **Correctness** | 0.50 | All guard patterns prevent crash; no unhandled `undefined` access |
| EP2 | **Minimal surface change** | 0.25 | Only add null-checks; preserve all existing code and layout |
| EP3 | **Defensive by design** | 0.25 | Apply same pattern consistently across all run field accesses, not just `summary.total` |

---

## Exit Conditions

| # | Exit Condition | Criteria |
|---|---------------|----------|
| EC1 | AC1–AC7 all pass | `tape` / manual test with partial run data |
| EC2 | TypeScript compiles cleanly | `tsc --noEmit` exits 0 |
| EC3 | Dashboard loads in browser | No React error boundary triggered; all 8 tabs render |
| EC4 | Zero regressions on complete data | All existing stat cards, charts, and tables display identical values |

---

## Implementation Notes (Front-end Developer Answers)

**Q1 — What exactly is undefined at crash time?**
`r.summary` is `undefined` when iterating `runs.reduce((s, r) => s + r.summary.total, 0)`. At minimum we need `runs` array guard before reduce, and `r.summary?.total ?? 0` inside reduce.

**Q2 — Are there other deep-nested field accesses that could crash similarly?**
Yes. The Recent Runs table accesses `r.summary.total`, `r.summary.totalDurationMs`, `r.summary.totalTokensEstimated`, `r.summary.successful`, `r.summary.failed`. The runTimeline maps `r.config?.concurrency` (or `r.config?.maxConcurrency`). The executorStats loop accesses `r.executor`, `r.persona`, `r.durationMs`, `r.tokensUsed`, `r.retries`. All need optional chaining.

**Q3 — Should incomplete runs be filtered out or rendered with missing data?**
Render with missing data (N/A markers) — filtering would silently drop data and be confusing. Use `r.summary?.total ?? "–"` style throughout.

**Q4 — Should the API be hardened too, or just the frontend?**
Frontend only. The API is already correct. The bug is in the display layer. API hardening would be a separate task.

**Q5 — What about the `selectedRun` expansion when `results` is undefined?**
Guard: `{selectedRun.results ?? []}.map(...)` so it renders an empty table rather than crashing.

**Q6 — Should the safe-navigator aliases (`safeES`, `safeRA`, etc.) be extended to cover runs?**
Yes — add a `safeRuns = Array.isArray(rawRuns) ? rawRuns : []` alias and rename the local `runs` to use it. Then add a helper: `runTotal(r) => r.summary?.total ?? 0`.

---

## Fix Location
- Route: `/swarm-dashboard` (page route in zo.space)
- File: via `get_space_route` → edit via `update_space_route`
- No workspace file exists for this; changes are submitted directly to the space API

## Verification Steps
1. Create a test result file: `/root/.swarm/results/test-partial.json` with `{}` (empty object — no summary, no results)
2. Reload `/swarm-dashboard` — should render without crash
3. Click the partial run row — task table should show empty state
4. `curl https://marlandoj.zo.space/api/swarm-stats?token=...` — verify 200
5. Manual: compare stat cards on a complete run vs before-fix run — values identical
