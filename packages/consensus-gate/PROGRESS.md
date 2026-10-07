# Consensus Gate — Persona Panel Migration

status: in_progress
watchdog: active

Migrate the consensus panel's diversity axis from **model families** to **role personas**,
with harness-level deployment and availability failover.

Governing law: `/home/workspace/zouroboros/CONSTITUTION.md` (Article II, Article IX).

## Why

Constitution Art. II states plainly: *"Caller-supplied persona identifiers, session
identifiers, **model-vendor diversity**, and caller-supplied consensus flags are not promotion
evidence."* The current validator enforces exactly that — `all four model families must be
distinct` (`scripts/consensus-profile.ts:122`). So the enforced axis is not merely unhelpful,
it is constitutionally void as promotion evidence.

## Evidence-graded gaps

- [x] **G1 — lineup artifact is structurally broken (blocker).**
      `/root/.zouroboros/lineup.consensus.json` holds 1 of 3 reviewer seats.
      `consensus-profile.ts validate` → `exactly three reviewers are required`,
      `exactly four seats are required`, `seat order or names are invalid`,
      `lineupHash does not match the ordered seats`. Nothing is promotable.

- [x] **G2 — diversity axis is model-family, not persona.**
      `consensus-profile.ts:116` requires `seat.family` + `seat.provider`;
      `:122` requires four distinct families; `:160` `pickDistinct` dedupes on family.
      `lineup-roles.ts` is likewise route-keyed (`hf:zai-org/GLM-5.2`).

- [x] **G3 — harness layer bypassed entirely.**
      `grep -c harness scripts/../../packages/swarm/src/persona/specialist-consult.ts` → `0`.
      Reviewer execution is `callModel(seat.id, ...)` straight onto the Zo model layer.
      Meanwhile `packages/swarm` ships a full ACP harness layer: 7 registered executors,
      `ExecutorClient`, and `executor-selector.ts` FALLBACK_ORDER. None of it is used here.

- [x] **G4 — no harness availability probe and no harness failover.**
      Nothing detects an unavailable harness. Live probe on this host:
      AVAILABLE claude, codex, gemini, opencode, kimi, pi, hermes; **MISSING cursor, grok**.
      `executor-selector.ts` COST_RANKING still lists `cursor` as a fallback target — a
      dangling route to a binary that does not exist.

- [x] **G5 — two of the three named role personas do not exist.**
      `AI Engineer` = `3a3ac067-dab7-428d-9c7e-9d900587b375` (live).
      `Zouroboros Engineer` → absent. `Security Engineer` → absent.

- [x] **G6 — stale model-pool asset.**
      `assets/byok-registry.json` `updated: 2026-08-01`, families `claude, glm, gpt, kimi, ling`,
      UUIDs since deleted. Still on disk as an implied pool source.

## Build

- [x] B1 — `scripts/persona-panel.ts`: persona-keyed panel, harness assignment,
      availability probe, fallback resolution.
- [x] B2 — Additive v3 artifact + `validatePersonaPanel()`; v1/v2 paths untouched.
- [x] B3 — Create `Zouroboros Engineer` and `Security Engineer` personas.
- [x] B4 — Rebuild `lineup.consensus.json` through the new builder; `validate` green.
- [x] B5 — Quarantine the stale BYOK registry.
- [x] B6 — Tests: axis, availability, failover, backward compat.

## Constraints held

- **status stays `shadow`.** Art. IX: shadow probes measure without escalating. Promotion is
  a separate act requiring real attestation evidence, which does not exist here. This work
  makes the panel *promotable*; it does not promote it.
- Distinctness moves to `personaId`. `family`/`provider` survive as execution metadata, not
  as the diversity axis — the runtime still needs them for routing.
- v1/v2 artifacts remain loadable and valid under their own rules.

## Verification

- `bun test scripts/persona-panel.test.ts scripts/consensus-profile-v2.test.ts …`
- `bun scripts/consensus-profile.ts validate --json` → `valid: true`
- Harness-failover proven by pinning an unavailable primary and asserting re-route.
- Baseline before changes: **71 pass / 0 fail** across the 4 consensus test files.

---

status: complete
watchdog: off

## Gap-closure pass (2026-10-02)

Nine failures survived the first wiring attempt. Each was a real defect, not a bad test.

- [x] **W1 — wiring was lost, not the module.** The first sandbox shutdown reverted
      `consensus-quality-gate.ts` to its pre-wiring bytes. `git status` proved it: the file
      was unmodified while `persona-panel.ts` sat untracked with no caller. Re-applied and
      committed to a repo so a host restart cannot silently un-wire it again.
- [x] **W2 — `degraded: false` on a held seat.** `resolveSeatHarness` reported a seat that
      resolved to *nothing* as not-degraded. A false all-clear on the exact state that blocks
      the gate. Now `degraded: true` for any departure from the primary, including total
      failure to resolve.
- [x] **W3 — a hold was unrecordable.** `validatePersonaPanel` pushed a structural error for
      every `resolvedHarness === null`, so a held panel could not be persisted — destroying the
      audit record at the moment it matters most. Split into `validatePersonaPanel` (structure:
      is this the panel we chartered?) and `assessPanelReadiness` (convene: can it run?).
      Hold is now a *ruling*, not a *defect*.
- [x] **W4 — harness identity re-entered as a validity rule.** Validation rejected an
      adjudicator resolving to the single harness shared by all reviewers, smuggling execution
      substrate back in as an identity requirement. Demoted to a visible entry in
      `collectDegradations()`: recorded, never fatal.
- [x] **W5 — legacy model-family independence survived a panel.** With a panel present the gate
      still required `configuredFamiliesDistinct`, which fails closed on any single-vendor
      BYOK set — the exact hosts the panel exists for. Independence now switches to panel
      persona/domain distinctness, and `independence.axis` reports which axis ruled.
- [x] **W6 — the panel could not actually run.** `runQualityGate` required a valid model-keyed
      profile, which was unsatisfiable. Added `buildPanelTransportProfile()` + `--panel-only`:
      the panel's own per-seat `executionModel` supplies transport; the legacy profile is not
      consulted.
- [x] **W7 — artifact collision.** The panel had been written to the legacy
  `lineup.consensus.json`, so `loadConsensusProfile` rejected it with a wall of field errors
      that named none of the real problem. Panel moved to `~/.zouroboros/lineup.consensus.panel.json`;
      `loadConsensusProfile` now names the collision explicitly.
- [x] **W8 — test API drift.** `resolveSeatHarness` tests called a `harnessChain` shape that
      no longer exists. Reconciled to `binding: { harness, chain }`.
- [x] **W9 — `structurallyValid` was derived, not computed.** It was
      `readiness.ready || heldSeats.length > 0`, true by construction. Now published from
      `PanelReadiness.structurallyValid`, which is `validatePersonaPanel(panel).valid`.

## Verification

- `bun test` → **348 pass / 0 fail** across 39 files (baseline was 71/0).
- Live: all 7 harnesses probe live; all 4 seats resolve on their primary, zero degradations.
- Live gate run (`--panel-only`): 2 PASS + 1 FAIL → adjudicator → **HOLD**, split-pass
  authority disabled in shadow. `axis: persona`, `panelStatus: shadow`, `autoEligible: false`.
- `tsc` on both touched files: no new error classes (pre-existing TS2307/TS2339/TS2591
  from missing ambient types, unchanged by this work).
