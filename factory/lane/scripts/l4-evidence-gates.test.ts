import { describe, expect, test } from "bun:test";
import {
  CALIBRATION_MIN_SAMPLE,
  calibrationGate,
  computeAgreement,
  computeCalibration,
  dedupeResolvedByTicketAction,
  type LedgerEntry,
  type OperatorVerdict,
} from "./approval-ledger";
import {
  autoLaneEligibleInputs,
  autoPromoteEligible,
  canonicalizeArchetype,
  type RiskTier,
  type RiskVerdict,
  scoreRisk,
  tierFor,
} from "./risk-classifier";
import { DRY_RUN_MIN_EXECUTIONS, getAdvanceCheck, L4_MIN_QUALIFYING_EXECUTIONS } from "./shadow-state";

let seq = 0;

// Inputs that genuinely score into each tier under the CURRENT classifier —
// the matrix re-scores stored inputs (ZOU-1196), so a fixture's tier must be
// carried by its inputs, not by the stamped tier field.
const TIER_INPUTS: Record<RiskTier, RiskVerdict["inputs"]> = {
  low: {
    archetype: "docs",
    target_repo: "fixture",
    repro: "",
    acceptance_criteria: "",
    gate_decision: "DIRECT",
    files_touched_estimate: 1,
    schema_contact: false,
    secret_contact: false,
    infra_contact: false,
    reversibility: "easy",
    seed_eval_score: null,
  },
  medium: {
    archetype: "feature",
    target_repo: "fixture",
    repro: "",
    acceptance_criteria: "",
    gate_decision: "DIRECT",
    files_touched_estimate: 5,
    schema_contact: false,
    secret_contact: false,
    infra_contact: false,
    reversibility: "easy",
    seed_eval_score: null,
  },
  high: {
    archetype: "migration",
    target_repo: "fixture",
    repro: "",
    acceptance_criteria: "",
    gate_decision: "DIRECT",
    files_touched_estimate: 6,
    schema_contact: true,
    secret_contact: false,
    infra_contact: false,
    reversibility: "hard",
    seed_eval_score: null,
  },
};

function mkVerdict(ticket: string, tier: RiskTier, acted = false, inputs?: RiskVerdict["inputs"]): RiskVerdict {
  seq++;
  return {
    verdict_id: `v-${seq}`,
    execution_id: `e-${seq}`,
    ticket_id: ticket,
    identifier: ticket.toUpperCase(),
    tier,
    score: tier === "low" ? 0.1 : tier === "medium" ? 0.5 : 0.9,
    reasons: ["fixture"],
    inputs: inputs ?? { ...TIER_INPUTS[tier] },
    classified_at: "2026-08-04T00:00:00.000Z",
    mode: acted ? "enforce" : "shadow",
    acted,
  };
}

function mkEntry(
  ticket: string,
  tier: RiskTier,
  operator: OperatorVerdict,
  opts: { acted?: boolean; appendedAt?: string; inputs?: RiskVerdict["inputs"] } = {}
): LedgerEntry {
  const verdict = mkVerdict(ticket, tier, opts.acted ?? false, opts.inputs);
  return {
    verdict,
    operator_verdict: operator,
    harvested_at: operator === "pending" ? null : "2026-08-04T01:00:00.000Z",
    harvest_source: operator === "pending" ? null : "pr",
    agreement: computeAgreement(tier, operator),
    flags: { SF002_CLASSIFY: true, SF002_ENFORCE: false, SF002_AUTO_PROMOTE: false },
    appended_at: opts.appendedAt ?? `2026-08-04T01:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  };
}

function toMap(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>();
  for (const e of entries) map.set(e.verdict.verdict_id, e);
  return map;
}

function shadowState(overrides: {
  phase: "idle" | "dry-run" | "shadow-pr" | "live";
  elapsedHours: number;
  safe: number;
  unsafe?: number;
}) {
  const startedAt = new Date(Date.now() - overrides.elapsedHours * 3600000).toISOString();
  return {
    current_phase: overrides.phase,
    phase_started_at: startedAt,
    dry_run_started_at: null,
    shadow_pr_started_at: null,
    live_started_at: null,
    transitions: [],
    safe_executions: overrides.safe,
    unsafe_auto_executions: overrides.unsafe ?? 0,
  };
}

describe("L4 qualifying-sample gate (ZOU-1110 regression: vacuous shadow pass)", () => {
  test("REGRESSION: 741.2h elapsed with 0 safe executions must NOT advance to live", () => {
    const check = getAdvanceCheck(shadowState({ phase: "shadow-pr", elapsedHours: 741.2, safe: 0 }));
    expect(check.can_advance).toBe(false);
    expect(check.reason).toContain(`qualifying sample 0/${L4_MIN_QUALIFYING_EXECUTIONS}`);
  });

  test("shadow-pr advances only once the qualifying sample is met", () => {
    const short = getAdvanceCheck(shadowState({ phase: "shadow-pr", elapsedHours: 741.2, safe: L4_MIN_QUALIFYING_EXECUTIONS - 1 }));
    expect(short.can_advance).toBe(false);
    const ok = getAdvanceCheck(shadowState({ phase: "shadow-pr", elapsedHours: 741.2, safe: L4_MIN_QUALIFYING_EXECUTIONS }));
    expect(ok.can_advance).toBe(true);
    expect(ok.reason).toContain(`${L4_MIN_QUALIFYING_EXECUTIONS} qualifying safe executions`);
  });

  test("unsafe executions still block regardless of sample", () => {
    const check = getAdvanceCheck(shadowState({ phase: "shadow-pr", elapsedHours: 741.2, safe: 50, unsafe: 1 }));
    expect(check.can_advance).toBe(false);
    expect(check.reason).toContain("unsafe");
  });

  test("dry-run with zero executions cannot advance", () => {
    const check = getAdvanceCheck(shadowState({ phase: "dry-run", elapsedHours: 72, safe: 0 }));
    expect(check.can_advance).toBe(false);
    expect(check.reason).toContain(`qualifying sample 0/${DRY_RUN_MIN_EXECUTIONS}`);
  });
});

describe("approval evidence dedup by ticket + action decision", () => {
  test("repeated re-dispatch of one ticket collapses to one decision, latest row wins", () => {
    const entries = [
      mkEntry("zou-900", "medium", "rejected", { appendedAt: "2026-08-01T00:00:00.000Z" }),
      mkEntry("zou-900", "medium", "rejected", { appendedAt: "2026-08-02T00:00:00.000Z" }),
      mkEntry("zou-900", "medium", "approved", { appendedAt: "2026-08-03T00:00:00.000Z" }),
      mkEntry("zou-900", "medium", "rejected", { appendedAt: "2026-08-02T12:00:00.000Z" }),
      mkEntry("zou-900", "medium", "pending"),
    ];
    const deduped = dedupeResolvedByTicketAction(toMap(entries));
    expect(deduped.size).toBe(1);
    const matrix = computeCalibration(toMap(entries));
    expect(matrix.resolved_rows).toBe(4);
    expect(matrix.deduped_decisions).toBe(1);
    expect(matrix.expected_hold_approvals).toBe(1);
    expect(matrix.false_hold).toBe(0);
    expect(matrix.correct_hold).toBe(0);
  });

  test("the same ticket at different action decisions counts separately", () => {
    const entries = [
      mkEntry("zou-901", "low", "approved"),
      mkEntry("zou-901", "high", "rejected"),
    ];
    expect(dedupeResolvedByTicketAction(toMap(entries)).size).toBe(2);
  });
});

describe("confusion matrix semantics", () => {
  test("acted high-risk hold approvals are expected, never false holds", () => {
    const entries = [mkEntry("zou-902", "high", "approved", { acted: true })];
    const m = computeCalibration(toMap(entries));
    expect(m.expected_hold_approvals).toBe(1);
    expect(m.false_hold).toBe(0);
    expect(computeAgreement("high", "approved")).toBe(true);
  });

  test("only auto-lane-eligible over-holds are false holds; review-lane approvals are expected (ZOU-1196)", () => {
    // Eligible work (docs, benign) pushed to medium by files-touched + SWARM
    // bumps: 0.05 + 0.20 + 0.10 = 0.35 → medium. THIS held-then-approved is the
    // true over-hold signal.
    const overHeldEligible = { ...TIER_INPUTS.low, files_touched_estimate: 12, gate_decision: "SWARM" as const };
    const m = computeCalibration(
      toMap([
        mkEntry("zou-903", "medium", "approved", { inputs: overHeldEligible }),
        mkEntry("zou-904", "low", "rejected"),
        mkEntry("zou-905", "low", "approved"),
        mkEntry("zou-906", "medium", "rejected"),
        mkEntry("zou-908", "medium", "approved"),
      ])
    );
    expect(m.false_hold).toBe(1);
    expect(m.expected_hold_approvals).toBe(1);
    expect(m.false_approval).toBe(1);
    expect(m.correct_allow).toBe(1);
    expect(m.correct_hold).toBe(1);
    expect(m.eligible_work_decisions).toBe(3);
    expect(m.false_hold_rate).toBeCloseTo(1 / 3, 4);
    expect(m.false_approval_rate).toBe(0.5);
  });

  test("stored tiers from older classifier versions are re-scored by the current classifier (ZOU-1196)", () => {
    // Backticked archetype used to miss ARCHETYPE_BASE and default to 0.4
    // (medium). The current classifier canonicalizes: `docs` benign → low.
    const backticked = { ...TIER_INPUTS.low, archetype: "`docs`" };
    const m = computeCalibration(toMap([mkEntry("zou-909", "medium", "approved", { inputs: backticked })]));
    expect(m.retiered_decisions).toBe(1);
    expect(m.low_decisions).toBe(1);
    expect(m.correct_allow).toBe(1);
    expect(m.false_hold).toBe(0);
  });
});

describe("classifier vocabulary (ZOU-1196 regression: unknown-default over-tiering)", () => {
  test("markdown-formatted archetypes canonicalize instead of falling to the 0.4 unknown default", () => {
    expect(canonicalizeArchetype("`feature`")).toBe("feature");
    expect(canonicalizeArchetype("**infra**")).toBe("infra");
    expect(canonicalizeArchetype("  Doc Fix ")).toBe("docs");
    expect(canonicalizeArchetype("")).toBe("unknown");
    expect(canonicalizeArchetype(undefined)).toBe("unknown");
    expect(canonicalizeArchetype("made_up_thing")).toBe("made_up_thing");
  });

  test("contract-enum and allowlist archetypes have deliberate bases", () => {
    const benign = (archetype: string) => ({ ...TIER_INPUTS.low, archetype });
    expect(tierFor(scoreRisk(benign("fix")).score)).toBe("low");
    expect(tierFor(scoreRisk(benign("test_addition")).score)).toBe("low");
    expect(tierFor(scoreRisk(benign("lint_codemod")).score)).toBe("low");
    expect(tierFor(scoreRisk(benign("dependency_bump")).score)).toBe("low");
    expect(tierFor(scoreRisk(benign("audit")).score)).toBe("low");
    expect(tierFor(scoreRisk(benign("infra")).score)).toBe("medium");
    expect(tierFor(scoreRisk(benign("migration")).score)).toBe("high");
  });

  test("auto-lane eligibility requires an allowlist archetype AND benign surfaces", () => {
    expect(autoLaneEligibleInputs(TIER_INPUTS.low)).toBe(true);
    expect(autoLaneEligibleInputs({ ...TIER_INPUTS.low, archetype: "`doc_fix`" })).toBe(true);
    expect(autoLaneEligibleInputs({ ...TIER_INPUTS.low, archetype: "feature" })).toBe(false);
    expect(autoLaneEligibleInputs({ ...TIER_INPUTS.low, secret_contact: true })).toBe(false);
    expect(autoLaneEligibleInputs({ ...TIER_INPUTS.low, infra_contact: true })).toBe(false);
    expect(autoLaneEligibleInputs({ ...TIER_INPUTS.low, reversibility: "hard" })).toBe(false);
  });

  test("secret-contact floor is unaffected by low archetype bases", () => {
    expect(tierFor(scoreRisk({ ...TIER_INPUTS.low, secret_contact: true }).score)).toBe("high");
  });
});

describe("calibration gate (ZOU-1110 regression: 11.6% count-only eligibility)", () => {
  function badLedgerFixture(): Map<string, LedgerEntry> {
    const entries: LedgerEntry[] = [];
    for (let t = 0; t < 10; t++) {
      for (let r = 0; r < 25; r++) entries.push(mkEntry(`zou-mh-${t}`, "medium", "approved"));
    }
    for (let t = 0; t < 2; t++) {
      for (let r = 0; r < 8; r++) entries.push(mkEntry(`zou-hh-${t}`, "high", "approved"));
    }
    entries.push(mkEntry("zou-hh-0", "high", "approved"));
    for (let t = 0; t < 3; t++) {
      for (let r = 0; r < 12; r++) entries.push(mkEntry(`zou-la-${t}`, "low", "approved"));
    }
    return toMap(entries);
  }

  test("REGRESSION: 302 resolved rows at ~11.6% agreement is count-eligible but calibration-BLOCKED", () => {
    const map = badLedgerFixture();
    const m = computeCalibration(map);
    expect(m.resolved_rows).toBeGreaterThanOrEqual(300);
    expect(m.resolved_rows >= 20).toBe(true);
    const gate = calibrationGate(m);
    expect(gate.eligible).toBe(false);
    expect(gate.reasons.join(" ")).toContain("qualifying sample");
  });

  test("count-only eligibility can no longer pass autoPromoteEligible when calibration fails", () => {
    const gate = calibrationGate(computeCalibration(badLedgerFixture()));
    const decision = autoPromoteEligible(mkVerdict("zou-907", "medium"), 302, undefined, gate);
    expect(decision.eligible).toBe(false);
    expect(decision.reasons.join(" ")).toContain("calibration gate failed");
  });

  test("a clean deduped sample at the minimum passes", () => {
    const entries: LedgerEntry[] = [];
    for (let t = 0; t < CALIBRATION_MIN_SAMPLE - 4; t++) entries.push(mkEntry(`zou-ok-${t}`, "low", "approved"));
    for (let t = 0; t < 4; t++) entries.push(mkEntry(`zou-mr-${t}`, "medium", "rejected"));
    const gate = calibrationGate(computeCalibration(toMap(entries)));
    expect(gate.eligible).toBe(true);
    expect(gate.reasons).toEqual([]);
  });

  test("a single false approval blocks even a large clean sample", () => {
    const entries: LedgerEntry[] = [];
    for (let t = 0; t < 30; t++) entries.push(mkEntry(`zou-fa-${t}`, "low", "approved"));
    for (let t = 0; t < 5; t++) entries.push(mkEntry(`zou-fm-${t}`, "medium", "rejected"));
    entries.push(mkEntry("zou-fa-bad", "low", "rejected"));
    const gate = calibrationGate(computeCalibration(toMap(entries)));
    expect(gate.eligible).toBe(false);
    expect(gate.reasons.join(" ")).toContain("false-approval rate");
  });

  test("missing allow or hold evidence fails closed", () => {
    const holdsOnly: LedgerEntry[] = [];
    for (let t = 0; t < 25; t++) holdsOnly.push(mkEntry(`zou-ho-${t}`, "medium", "rejected"));
    const holdGate = calibrationGate(computeCalibration(toMap(holdsOnly)));
    expect(holdGate.eligible).toBe(false);
    expect(holdGate.reasons.join(" ")).toContain("allow calibration unproven");

    const allowsOnly: LedgerEntry[] = [];
    for (let t = 0; t < 25; t++) allowsOnly.push(mkEntry(`zou-ao-${t}`, "low", "approved"));
    const allowGate = calibrationGate(computeCalibration(toMap(allowsOnly)));
    expect(allowGate.eligible).toBe(false);
    expect(allowGate.reasons.join(" ")).toContain("hold behavior unexercised");
  });

  test("an empty ledger is blocked, not vacuously eligible", () => {
    const gate = calibrationGate(computeCalibration(new Map()));
    expect(gate.eligible).toBe(false);
  });
});
