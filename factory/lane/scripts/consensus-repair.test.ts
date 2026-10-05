import { describe, expect, test } from "bun:test";
import type { FactoryConsensusRecord, GateVerdict } from "./factory-consensus";
import {
  classifyClaims,
  planRepair,
  repairTask,
  runRepairLoop,
  type ClaimCheck,
  type ConsensusRetry,
  type RepairExecutor,
} from "./consensus-repair";

function record(overrides: Partial<FactoryConsensusRecord> = {}): FactoryConsensusRecord {
  return {
    status: "rejected",
    gate_status: "rejected",
    gate_id: "cg-test",
    trace_id: "factory:exec-89dbc53a",
    lineup: null,
    serving_providers: ["synthetic", "xai"],
    chain_attempts: [],
    dissent: null,
    reason_code: "quality_rejected",
    reason: "consensus rejected the implementation on quality grounds",
    attempts: [],
    ...overrides,
  };
}

function verdict(model: string, pass: boolean, issues: string[]): GateVerdict {
  return { model, pass, issues, confidence: 0.8 };
}

/** The real ZOU-913 rejection. */
const QUADRATIC = "the category comparison path is quadratic in the number of categories";

const okExecutor: RepairExecutor = async () => ({ ok: true, summary: "applied fix", addressed: [] });
const okChecks: ClaimCheck = async () => ({ ok: true, summary: "212 checks passed" });

describe("claim classification (FH-04)", () => {
  test("an agreed, specific claim is actionable", () => {
    const claims = classifyClaims([verdict("a", false, [QUADRATIC]), verdict("b", false, [QUADRATIC])]);
    expect(claims).toHaveLength(1);
    expect(claims[0].disposition).toBe("actionable");
    expect(claims[0].raised_by).toEqual(["a", "b"]);
  });

  test("a claim raised by one seat while others passed goes to adjudication", () => {
    const claims = classifyClaims([verdict("a", false, [QUADRATIC]), verdict("b", true, [])]);
    expect(claims[0].disposition).toBe("adjudicate");
    expect(claims[0].rationale).toContain("reviewers disagree");
  });

  test("a claim too vague to check goes to adjudication", () => {
    const claims = classifyClaims([verdict("a", false, ["bad"]), verdict("b", false, ["bad"])]);
    expect(claims[0].disposition).toBe("adjudicate");
    expect(claims[0].rationale).toContain("too vague");
  });

  test("the same claim from several seats is deduplicated by identity", () => {
    const claims = classifyClaims([
      verdict("a", false, [QUADRATIC]),
      verdict("b", false, [QUADRATIC.toUpperCase()]),
      verdict("c", false, [QUADRATIC]),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0].raised_by).toEqual(["a", "b", "c"]);
  });

  test("deterministic non-LLM verdicts do not raise claims", () => {
    expect(classifyClaims([verdict("non-llm/tsc", false, ["type error"])])).toEqual([]);
  });
});

describe("repair planning (FH-04)", () => {
  test("plans a repair for an agreed quality rejection", () => {
    const plan = planRepair(record(), [verdict("a", false, [QUADRATIC]), verdict("b", false, [QUADRATIC])]);
    expect(plan.repairable).toBe(true);
    expect(plan.actionable).toHaveLength(1);
    expect(repairTask(plan, { identifier: "ZOU-913", branch: "factory/zou-913" })).toContain(QUADRATIC);
  });

  test("refuses to repair code when the panel was unavailable", () => {
    const plan = planRepair(record({ status: "needs-review", reason_code: "vendor_unavailable", reason: "no responsive quorum" }));
    expect(plan.repairable).toBe(false);
    expect(plan.reason).toContain("routing problem");
    expect(plan.failure_class).toBe("provider_unavailable");
  });

  test("refuses to repair code for a configuration defect", () => {
    const plan = planRepair(record({
      status: "needs-review",
      reason_code: "gate_error",
      reason: "LINEUP_ROLE_CHAINS must be valid JSON",
    }));
    expect(plan.repairable).toBe(false);
    expect(plan.reason).toContain("repair the policy, not the code");
  });

  test("sends a split verdict to adjudication, never to the executor", () => {
    const plan = planRepair(record({ status: "needs-review", reason_code: "quality_split" }));
    expect(plan.repairable).toBe(false);
    expect(plan.failure_class).toBe("quality_split");
  });

  test("a passing record plans nothing", () => {
    expect(planRepair(record({ status: "passed", reason_code: null, reason: null })).repairable).toBe(false);
  });
});

describe("repair loop (FH-04)", () => {
  const verdicts = [verdict("a", false, [QUADRATIC]), verdict("b", false, [QUADRATIC])];

  test("reproduces the ZOU-913 recovery without a human", async () => {
    const result = await runRepairLoop(record(), verdicts, {
      identifier: "ZOU-913",
      executor: okExecutor,
      checks: okChecks,
      retryConsensus: async () => record({ status: "passed", reason_code: null, reason: null }),
    });
    expect(result.outcome).toBe("repaired");
    expect(result.attempts).toHaveLength(1);
    expect(result.escalation).toBeNull();
  });

  test("honours the attempt budget instead of looping", async () => {
    let retries = 0;
    const result = await runRepairLoop(record(), verdicts, {
      identifier: "ZOU-913",
      budget: 2,
      executor: okExecutor,
      checks: okChecks,
      retryConsensus: async () => { retries++; return record(); },
    });
    expect(retries).toBe(2);
    expect(result.outcome).toBe("escalate");
    expect(result.reason).toContain("budget of 2");
  });

  test("does not spend a consensus panel when claim checks fail", async () => {
    let retries = 0;
    const result = await runRepairLoop(record(), verdicts, {
      identifier: "ZOU-913",
      budget: 1,
      executor: okExecutor,
      checks: async () => ({ ok: false, summary: "3 checks failed" }),
      retryConsensus: async () => { retries++; return record({ status: "passed" }); },
    });
    expect(retries).toBe(0);
    expect(result.outcome).toBe("escalate");
    expect(result.attempts[0].consensus_status).toBe("not-run");
  });

  test("stops repairing when the panel dies mid-loop", async () => {
    // After ZOU-913's real repair, two retries failed on reviewer aborts.
    // Continuing to repair would have been damage, not recovery.
    let executions = 0;
    const result = await runRepairLoop(record(), verdicts, {
      identifier: "ZOU-913",
      budget: 3,
      executor: async (...args) => { executions++; return okExecutor(...args); },
      checks: okChecks,
      retryConsensus: async () => record({
        status: "needs-review", reason_code: "vendor_unavailable", reason: "no responsive quorum",
      }),
    });
    expect(executions).toBe(1);
    expect(result.outcome).toBe("escalate");
    expect(result.reason).toContain("not a quality rejection");
    expect(result.escalation?.decision_requested).toContain("without a consensus verdict");
  });

  test("an executor failure consumes an attempt but does not run checks", async () => {
    let checks = 0;
    const result = await runRepairLoop(record(), verdicts, {
      identifier: "ZOU-913",
      budget: 2,
      executor: async () => ({ ok: false, summary: "", addressed: [], error: "harness exited 1" }),
      checks: async () => { checks++; return { ok: true, summary: "" }; },
      retryConsensus: async () => record({ status: "passed" }),
    });
    expect(checks).toBe(0);
    expect(result.outcome).toBe("escalate");
    expect(result.attempts).toHaveLength(2);
  });

  test("escalation carries everything the acceptance criteria require", async () => {
    const result = await runRepairLoop(record(), verdicts, {
      identifier: "ZOU-913",
      budget: 1,
      executor: okExecutor,
      checks: okChecks,
      retryConsensus: async () => record(),
    });
    const packet = result.escalation!;
    expect(packet.identifier).toBe("ZOU-913");
    expect(packet.failure_class).toBe("quality_rejection");
    expect(packet.attempts).toHaveLength(1);
    expect(packet.route_telemetry.serving_providers).toEqual(["synthetic", "xai"]);
    expect(packet.remediation_attempted[0]).toContain("attempt 1");
    expect(packet.unresolved_claims.length).toBeGreaterThan(0);
    // Exactly one question — an escalation that asks two is two escalations.
    expect(packet.decision_requested.split("?").filter(Boolean)).toHaveLength(1);
  });

  test("an unavailable panel escalates immediately without invoking the executor", async () => {
    let executions = 0;
    const result = await runRepairLoop(
      record({ status: "needs-review", reason_code: "vendor_unavailable", reason: "no responsive quorum" }),
      [],
      {
        identifier: "ZOU-911",
        executor: async (...args) => { executions++; return okExecutor(...args); },
        checks: okChecks,
        retryConsensus: async () => record({ status: "passed" }),
      },
    );
    expect(executions).toBe(0);
    expect(result.outcome).toBe("not_repairable");
    expect(result.escalation?.decision_requested).toContain("without a consensus verdict");
  });

  test("a disputed-only rejection escalates for adjudication", async () => {
    const result = await runRepairLoop(
      record(),
      [verdict("a", false, [QUADRATIC]), verdict("b", true, [])],
      { identifier: "ZOU-913", executor: okExecutor, checks: okChecks, retryConsensus: async () => record() },
    );
    expect(result.outcome).toBe("escalate");
    expect(result.escalation?.unresolved_claims[0].disposition).toBe("adjudicate");
  });
});
