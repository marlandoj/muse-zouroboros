# Agentic Patterns Port — 2026-10-02

Ports the Zouroboros Agentic Design Patterns Enhancement Plan v2.0
(email 2026-10-02, Alaric; reference deployment: standalone VPS) into this
package where the pattern fits. The reference deployment's consensus-gate
persona panel (`Skills/consensus-gate`, `Skills/plan-closeout`) is not part
of this package, so G0/G1-as-panel-work and G5 promotion have no local
target; what is ported is the underlying discipline, in swarm terms.

## Applied

- **G1 (seat dispatch)** — `ExecutorClient.run` accepts `persona`, `model`,
  `seat`, `skipRAG`. Unset = previous behaviour (persona `alaric`, RAG as
  before). Each client is already bound to one harness; persona/model make
  the seat identity explicit instead of a shared hardcoded persona.
- **G2 (one ledger)** — `src/ledger/decision-ledger.ts`: single writer
  `appendDecisionRow` (one O_APPEND line + fsync, throws on failure),
  seat-keyed rows `(traceId, seat, personaId, harness, modelId)` with
  `seatDispatch {enabled, bindings}`, hash-chained for repair lineage.
  `ExecutorClient` writes one row per run when `ledgerPath` /
  `ZOUROBOROS_DECISION_LEDGER` is configured. Unconfigured = no writes.
- **G3 (attribution)** — same module: `summarizeBySeat` is the stored truth;
  `summarizeByModel` is derived on read only; `computeJoinStatus` is
  computed, never a literal; `assertOutcomeCoverage` hard-fails when
  outcome_votes is 0 across all seats; `isLedgerFresh` for rebuild gates.
- **G4 (reflection primitives)** — `buildRepairBrief` (structured findings
  only, 2-cycle cap) and `shouldEscalate` (repeated same-reason HOLDs
  escalate), plus `repairCycles`/`revisedFrom` ledger fields. The
  revise + re-review loop itself needs a panel and is **not** wired here.
- **§7 gap audit** — `runGapAudit` now runs all five checks. Checks 4–5 are
  pure helpers in `src/verification/gap-checks.ts` (eval–production parity,
  dangling duplicate exports). First run here: 6 dangling duplicate exports
  (mostly `standalone/` mirrors), 0 eval-parity gaps among declared call
  sites. `decision-ledger` is registered in the capability manifest with
  `client/executor-client.ts` as its production caller.

## Invariants held

Shadow only (ledger records, never enforces), fail closed (writer throws;
seat identity required), no shared-transport fallback (a seat's harness is
the client's own executor), no platform dependency (node fs/crypto only).

## Verification (this host, 2026-10-02)

- New tests: `decision-ledger.test.ts`, `gap-checks.test.ts` — 11 tests.
- Suite: 528 pass / 15 fail / 4 skip (baseline before port: 517 / 15 / 4;
  the 15 failures are pre-existing environmental issues — missing ACP
  binaries, profile paths, and private submodules in a sparse checkout).
- `tsc --noEmit`: no new error classes (repo-wide node/bun type errors in
  this sandbox are pre-existing, 351 baseline).
