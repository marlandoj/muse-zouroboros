# Swarm Orchestrator Changelog

## Unreleased

- Timeout and stall rework mitigation (Fix A):
  - Added structured partial-progress Salvage Record capture (`src/executor/salvage-record.ts`) on timeout or stall errors.
  - Added executor-visible Budget Signal maintenance (`src/executor/budget-signal.ts` and `src/budget/budget-signal.ts`) maintaining `BUDGET.json` and `.swarm/budget.json` with milestone updates at 50%, 70%, and 90% of attempt budget.
  - Added per-attempt timeout policy and resume prompt formatting with salvage record inclusion (`src/executor/attempt-policy.ts`).
  - Integrated budget signal monitoring and salvage capture in DAG execution (`src/dag/executor.ts`) and script runtime (`scripts/orchestrate-v5.ts`).
  - Added test suite in `src/__tests__/salvage-budget-signal.test.ts`.
- Verity Gate integration and gate hygiene (Fix B):
  - Added `VerityGate` client (`src/verification/verity-gate.ts`) supporting pre-flight contamination checks, base snapshots, and verification with verdict attribution (`inDiff`, `allOutsideDiff`, `verdictClass: "contamination"`).
  - Added unit test suite in `src/__tests__/verity-gate.test.ts`.
- Reliability and registry hardening (residue from t_b95b0538):
  - Added installed package fallback in `src/registry/loader.ts`.
  - Added `"zourobench-t3"` capability profile and catalog fallback filtering in `src/selector/executor-selector.ts`.
  - Handled symlink check exception for `/home/workspace` in `src/transport/factory-path-profile.ts`.
  - Hardened dep-graph file probing and test timeout in `scripts/dep-graph.ts` and `scripts/__tests__/dep-graph.test.ts`.

- Portable host roots (`src/host-roots.ts`, ported from hermes-zouroboros): workspace/state/logs/runtime/factory/model-routing paths now resolve from `ZOUROBOROS_*` env vars (legacy `ZO_*` honored), then XDG, then home fallbacks — no more hard-coded `/home/workspace` or `/var/lib/zouroboros` in the central resolvers. **Migration note:** hosts that relied on the old implicit defaults without setting env vars now resolve to XDG (`~/.local/state/zouroboros`). Set `ZOUROBOROS_STATE_DIR=/var/lib/zouroboros` and `ZOUROBOROS_WORKSPACE=/home/workspace` to keep the legacy layout. Resolved roots are logged at orchestrator startup.
- Decision gate: added the four #850 intent patterns (`use a/the swarm`, `launch/start/kick off/spin up a swarm`, `swarm campaign`, `as/via a swarm`).

## 5.1.1

### Patch Changes

- 62f9b9d: Harden `zouroboros-swarm` for standalone npm consumption (Packaging M5, ZOU-476). The npm build was a stale pre-packaging artifact that assumed the monorepo layout and a fixed `/home/workspace` host root. This republish applies the M1–M4 hardening:

  - Path-decouple: `/home/workspace` runtime defaults across the shipped surface (CLI, DAG executor, DB schema, executor/transport/registry/verification/harness modules) replaced with `getWorkspaceRoot()` from `zouroboros-core` (honours `ZOUROBOROS_WORKSPACE`/`ZO_WORKSPACE`, falls back to cwd). Package-specific overrides (`SWARM_WORKSPACE`, `ZOUROBOROS_WORKSPACE_ROOT`, `SWARM_DB_PATH`) are preserved as higher-precedence prefixes.

  No public API changes; internal-only.

- Updated dependencies [9adc906]
  - zouroboros-selfheal@2.1.1

## 5.1.0

### Minor Changes

- Zouroboros v2.1.0 — coordinated release of enhancements and fixes since v2.0.0.

  - selfheal: consensus-gate reputation/quarantine + banned-model doctor, curiosity chronicle proposal feed, Snake Pit adversarial red-team layer, endogenous curiosity explorer, gated periodic distillation pipeline.
  - memory: live retrieval/store telemetry wiring (memory_retrievals / memory_stores), graph-connectivity and decay refinements.
  - swarm: ACP transport, T3 runner, RAG enrichment, hierarchical delegation.
  - rag: orphan-chunk sweeper and retired-path guards.

  `zouroboros-memory` baseline reconciled to 4.0.0 to match the published registry version before this minor bump (→ 4.1.0).

### Patch Changes

- Updated dependencies
  - zouroboros-core@2.1.0
  - zouroboros-selfheal@2.1.0

## Current

### Registered GameDev specialist fleet

- registered all 22 live GameDev personas with stable swarm slugs and exact-name Zo selectors
- kept specialist persona identity independent from model, harness, and executor routing
- made the monorepo persona registry authoritative with the deprecated skill registry retained only as a compatibility fallback
- added a fail-closed Software Factory preflight for assigned GameDev personas that are absent from the swarm registry
- added deterministic registry, runtime-path, template-selector, and live-directory parity coverage

### Nine-executor routing and model dispatch

- registered Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, Pi, Cursor, and Mimir in one capability matrix
- wired task, role, and complexity-tier model resolution into production DAG dispatch for streaming and wave modes
- added Kimi, Pi, Cursor, OpenCode, and Mimir legacy routing tags, complexity affinities, and resilient fallback chains
- documented the boundary between DAG delegation and executor SDK agent/session primitives
- attributed budget and cost-ledger usage to the executor-resolved model instead of falling back to a hardcoded `sonnet` when a transport reports no `modelUsed`

### Harness discipline for long-running agents (roadmap §10)

- added an immutable, hash-guarded **feature-list** spec (`src/harness/feature-list.ts`): a durable JSON campaign spec kept outside the context window, with a content hash so any silent overwrite/drift is detectable; write-once create, integrity verify, and a pure `reconcileProgress` (declared features → landed vs missing against results)
- added a per-session **smoke test** (`src/harness/smoke-test.ts`): a fast deterministic harness-sanity probe over four checks — feature-list integrity [critical], durable-log readable+non-empty [warning], ≥1 transport [critical], enforce-flag coherence [warning]; `passed = no critical`
- wired both into `orchestrator.run()` (smoke at run start) and `postFlightEval()` (reconcile), all advisory-first and byte-identical when flags are off:
  - `SWARM_HARNESS_SMOKE` (default ON, advisory) — runs the smoke test, reports, never blocks
  - `SWARM_HARNESS_SMOKE_ENFORCE` (default OFF) — a critical smoke finding aborts the run before execution
  - `SWARM_FEATURE_LIST` (path) — enables loading the spec for the smoke integrity check and the post-flight reconcile (absent ⇒ graceful no-op)
- pure cores with injected probes (real durable-log probe reads swarm.db read-only, summing the canonical run/event tables); 34 net-new tests

### Hierarchical orchestration telemetry

- persisted delegated child telemetry into task results, NDJSON logs, episode metadata, and executor history
- fed delegation telemetry back into routing so delegation-friendly executors are preferred for eligible tasks
- added deterministic validation fixtures for Hermes delegation, conditional Claude delegation, blocked mutation delegation, and auto-routed hierarchical work

### Operator observability

- added richer `status <swarm-id>` output with delegated parent count, child count, artifact count, reroutes, and effective executors
- added `history [limit]` to inspect delegation-aware executor history directly from `executor-history.db`

### Documentation cleanup

- aligned package docs with the current v5 runtime and CLI surface
- removed obsolete legacy-era documents and examples that referenced deprecated orchestrator generations

## Runtime notes

- `scripts/orchestrate-v5.ts` is the current TypeScript orchestrator entrypoint
- `scripts/swarm-hybrid-runner.ts` remains the long-running handoff wrapper
- Python support remains available through `orchestrate.py` where documented
