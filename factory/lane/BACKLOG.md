# Backlog — Zouroboros Software Factory

**Linear project:** [Zouroboros Software Factory](https://linear.app/marlandoj/project/zouroboros-software-factory-bc4048c4-c40f-42b6-8089-6670cf5b0993)
**Consolidated:** 2026-08-02 from Software Factory, Factory Autonomy Hardening, and Factory Throughput Scaling
**Status:** L4 production-certified; active factory backlog

## Consolidation Note

This project absorbs:
- **Software Factory** (SF-001 through SF-012): Core factory machinery, L4 production-certified on 2026-08-10 under bounded operator authority
- **Factory Autonomy Hardening** (ZOU-1075, ZOU-1084, ZOU-925, ZOU-937): Operational excellence
- **Factory Throughput Scaling** (folded): Utilization, isolation, claims, cap management

The L4 readiness program is complete. Remaining work belongs to the continuing Software Factory backlog and must preserve the certified authority boundaries.

## L4 Production Readiness Program

**Linear project:** [Zouroboros Factory L4 Production Readiness](https://linear.app/marlandoj/project/zouroboros-factory-l4-production-readiness-30e46e59417b)

**Local source:** `l4-production-readiness-2026-08-04/PROJECT.md`

**Window:** 2026-08-04 through 2026-08-10

**Status:** Completed; Linear 100%; operator GO for bounded L4 production use

The program owns ZOU-1110 through ZOU-1120. Every issue is Done in Linear. Certification used qualifying samples, calibration, production-path evidence, rollback drills, and an explicit operator decision rather than elapsed-time or count-only claims.

## Core Factory (SF-001 through SF-012)

All 12 SF tickets are built. The authoritative runtime configuration is cross-process, rollback-tested, and bounded by the operator decision recorded in FR-11.

| Ticket | Status | Flag | Activation Gate |
|--------|--------|------|-----------------|
| SF-001 Autonomous Intake | 🟢 L4 certified | 23 qualifying executions; 21 evidence-complete; 0 unsafe | Continue bounded production observation |
| SF-002 Tiered Auto-Approval | 🟢 Calibrated and bounded | 0 false approvals in the qualified cohort | Preserve operator authority for elevated risk |
| SF-003 Coder-Agent Pool | 🟢 Production-proven | Supervised leases, campaign DAG, starvation ordering, and live canary | Keep max dispatch at the certified bound |
| SF-004 Metrics Dashboard | 🟢 Live | Metrics plus read-only Factory Observatory with explicit denominators | Improve outcome coverage before optimizing yield |
| SF-005 SLOs + Alerting | 🟢 L4 certified | Active-runtime SLO/watchdog 74/74; rollback-tested | Continue change-gated monitoring |
| SF-006 Idempotent Intake | 🟢 Production-proven | Dedup, checkpoint resume, and production-path proof | Preserve fail-closed unverifiable-PR behavior |
| SF-007 Multi-Source Signal | 🟢 Live and bounded | Signals enabled; source and dedup evidence retained | Keep autofile authority within current configuration |
| SF-008 Fleet Campaigns | 🟡 Enabled and bounded | Assembly-line canary proven; no blanket multi-repo autonomy claim | Expand only with separate qualification evidence |
| SF-009 Ephemeral Verify + Twins | 🟢 Certified | 24/24 runs, 8 scenarios x 3 | Keep scenario enforcement in the production path |
| SF-010 Evidence-Gated Auto-Merge | 🟡 Canary passed; authority off | SF010_AUTOMERGE=0 after the bounded canary | Requires explicit operator authorization to expand |
| SF-011 Per-Archetype Lines | 🟡 Advisory | Lines on; enforcement off | Continue evidence collection before enforcement |
| SF-012 Code-Survivability | 🟡 Live and advisory | Mature n=5; 80.0%; feedback not promoted | Larger held-out cohort required for routing changes |

## Active Backlog

| Linear | Priority | Title | Current Gate |
|--------|----------|-------|--------------|
| ZOU-1193 | None | [HCP][CP-04] Run live Hetzner canary and production cutover review | Backlog; requires explicit live-canary authority and cutover evidence |
| ZOU-1075 | P0 | Hardware canary runner: typed async device job, preflight, and cleanup contract | Requires real external Zo device-bridge caller |
| ZOU-925 | P4 | ZBT-D: Raise the in-flight cap from 1 to 2, then 3 | Trigger-gated; demoted after utilization evidence |

ZOU-937 and its Intake twin ZOU-1186 completed on 2026-08-10 through merged PR #490
(`df437d063`). The production stale-execution reaper now writes bounded, redacted,
structured Dredge autopsies; focused tests, protected CI, and the five-check gap audit passed.

ZOU-1282 completed on 2026-08-10 through merged PRs #491, #493, and #494. Persona-routing enforcement remains default-off.

ZOU-1084 completed on 2026-08-10 after reconciling merged PR #450, protected CI,
the unchanged shared-state digest, the runtime fast-forward, and the successful D2 rerun.

ZOU-935 and its Intake twin ZOU-1103 were canceled on 2026-08-06. The deterministic scanner contract is retained as deferred optional review-gate work; it is not an active factory prerequisite.

## Factory Content & Adoption

| Linear | Priority | Title | Status |
|--------|----------|-------|--------|
| ZOU-474 | P0 | Change-Quiz Factory Gate: comprehension check before PR creation | Done 2026-08-10; merged PR #495; advisory default, enforcement maturity-gated |
| ZOU-901 | P0 | Produce Zouroboros Software Factory and Linear launch content | Canceled 2026-08-10 |
| ZOU-1092 | P1 | Add factory discovery and candidate export adapter | Done in Software Template Library |
| ZOU-1100 | P1 | Produce Module 7 - Software Factory Promotion and Verification | Done |

## Completed L4 Activation Waves

### Wave 0 - Evidence And Configuration
- [x] ZOU-1110: repair non-vacuous L4 and approval evidence gates
- [x] ZOU-1111: establish authoritative cross-process runtime configuration

### Wave 1 - Qualification Infrastructure
- [x] ZOU-1112: run the 7-day, 20-execution L4 cohort
- [x] ZOU-1113: implement persistent supervised workers
- [x] ZOU-1115: expand digital twins and scenario enforcement (24/24 certified runs; PR #466)

### Wave 2 - Production Canary
- [x] ZOU-1114: prove a governed multi-ticket assembly line
- [x] ZOU-1116: canary low-risk evidence-gated auto-merge

### Wave 3 - Feedback And Adoption
- [x] ZOU-1117: complete survivability validation
- [x] ZOU-1118: add Observatory and outcome metrics
- [x] ZOU-1119: publish the minimum viable factory path

### Wave 4 - Certification
- [x] ZOU-1120: final evaluation, gap audit, rollback drills, and operator go/no-go

## Success Metrics

| Metric | Baseline | Target |
|--------|----------|--------|
| Throughput | 4.93 units/day over 30 days | Improve only without quality regression |
| Measurement coverage | 21 / 23 qualified executions (91.3%) | PASS: ≥90% of qualification cohort |
| First-pass yield | 28.57% (6 / 21 measured) | ≥50% |
| Rework rate | 71.43% (15 / 21 measured) | <50% |
| Survivability | 4 / 5 survived; 1 hotfixed; 80.0% | PASS: ≥5 observed PRs; continue measuring |
| False approvals | 0 in qualification cohort | PASS: 0% in qualification cohort |
| Cost per accepted outcome | $0.0635 across 603 joined outcomes | Baseline established; optimize only with quality guardrails |
| Operator intervention | Routine qualified work avoided prompt-level intervention | PASS within bounded L4 authority |

---

*Consolidated: 2026-08-02 · L4 certification synchronized: 2026-08-10 · Supersedes: Software Factory BACKLOG.md, Factory Autonomy Hardening BACKLOG.md, Factory Throughput Scaling PROJECT.md*
