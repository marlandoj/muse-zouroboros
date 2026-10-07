import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeConsensusProfile,
  runProfileEscalation,
  type ProfileConsensusResult,
  type ValveProfile,
} from "./profile-escalation-valve";
import { evaluatePromotionContent } from "./profile-escalation-promotion";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function result(
  status: "passed" | "rejected" | "escalate" = "passed",
  confidence = 0.95,
  unanimous = true,
  highSeverity = false,
): ProfileConsensusResult {
  return {
    id: `cg-${status}`,
    gate_run_id: `gate-${status}`,
    status,
    consensus: { confidence, unanimous },
    verdicts: highSeverity
      ? [{ pass: false, confidence: 0.95, issues: ["critical"], dissent_claims: [{ claim: "critical", severity: "high" }] }]
      : [{ pass: true, confidence: 0.95, issues: [] }],
  };
}

function harness(responses: Partial<Record<ValveProfile, unknown>>) {
  const calls: ValveProfile[] = [];
  const dir = mkdtempSync(join(tmpdir(), "profile-valve-"));
  tempDirs.push(dir);
  return {
    calls,
    ledgerPath: join(dir, "ledger.jsonl"),
    executeProfile: async (profile: ValveProfile) => {
      calls.push(profile);
      const response = responses[profile];
      if (response instanceof Error) throw response;
      if (typeof response !== "object" || response === null) return response;
      const panel = [`${profile}-model`];
      const candidate = response as ProfileConsensusResult;
      return {
        ...response,
        lineup_profile: profile,
        lineup_source: "persisted-profile",
        panel,
        panel_fingerprint: createHash("sha256").update(JSON.stringify(panel)).digest("hex"),
        verdicts: candidate.verdicts?.map((verdict, index) => ({
          ...verdict,
          model: index === 0 ? panel[0] : verdict.model,
        })),
      };
    },
  };
}

const baseInput = {
  code: "const safe = true;",
  criteria: "correctness",
  label: "test",
  mode: "shadow" as const,
  minConfidence: 0.8,
};

describe("runProfileEscalation", () => {
  test("shadow runs Fast then Flagship and returns Flagship", async () => {
    const h = harness({ fast: result(), flagship: result("rejected") });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile, runId: () => "pv-1" },
    );
    expect(h.calls).toEqual(["fast", "flagship"]);
    expect(output.decision?.status).toBe("rejected");
    expect(output.decisionSource).toBe("flagship");
    expect(output.trigger).toBe("forced_shadow");
    expect(output.escalated).toBe(false);
  });

  test("enforce returns clean Fast only with a valid promotion", async () => {
    const h = harness({ fast: result() });
    const enforceLedgerPath = h.ledgerPath.replace("ledger.jsonl", "enforce.jsonl");
    const output = await runProfileEscalation(
      { ...baseInput, mode: "enforce", ledgerPath: h.ledgerPath, enforceLedgerPath },
      {
        executeProfile: h.executeProfile,
        verifyPromotion: () => ({ eligible: true, blockers: [] }),
      },
    );
    expect(h.calls).toEqual(["fast"]);
    expect(output.decisionSource).toBe("fast");
    expect(output.trigger).toBe("none");
    expect(() => readFileSync(h.ledgerPath, "utf8")).toThrow();
    expect(JSON.parse(readFileSync(enforceLedgerPath, "utf8")).effective_mode).toBe("enforce");
  });

  test("invalid promotion downgrades enforce to shadow", async () => {
    const h = harness({ fast: result(), flagship: result() });
    const output = await runProfileEscalation(
      { ...baseInput, mode: "enforce", ledgerPath: h.ledgerPath },
      {
        executeProfile: h.executeProfile,
        verifyPromotion: () => ({ eligible: false, blockers: ["sample floor"] }),
      },
    );
    expect(output.effectiveMode).toBe("shadow");
    expect(output.decisionSource).toBe("flagship");
    expect(output.promotionBlockers).toEqual(["sample floor"]);
  });

  test("dissent, split, and low confidence escalate enforce runs", async () => {
    for (const [fastResult, trigger] of [
      [result("passed", 0.95, false), "dissent"],
      [result("escalate", 0.95, false), "split"],
      [result("passed", 0.5, true), "low_confidence"],
    ] as const) {
      const h = harness({ fast: fastResult, flagship: result() });
      const output = await runProfileEscalation(
        { ...baseInput, mode: "enforce", ledgerPath: h.ledgerPath },
        { executeProfile: h.executeProfile, verifyPromotion: () => ({ eligible: true, blockers: [] }) },
      );
      expect(output.trigger).toBe(trigger);
      expect(output.decisionSource).toBe("flagship");
    }
  });

  test("Fast failure fails toward Flagship", async () => {
    const h = harness({ fast: new Error("fast unavailable"), flagship: result() });
    const output = await runProfileEscalation(
      { ...baseInput, mode: "enforce", ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile, verifyPromotion: () => ({ eligible: true, blockers: [] }) },
    );
    expect(output.trigger).toBe("panel_failure");
    expect(output.fast.ok).toBe(false);
    expect(output.decisionSource).toBe("flagship");
  });

  test("Flagship failure never falls back to Fast", async () => {
    const h = harness({ fast: result("passed", 0.5), flagship: new Error("flagship unavailable") });
    const output = await runProfileEscalation(
      { ...baseInput, mode: "enforce", ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile, verifyPromotion: () => ({ eligible: true, blockers: [] }) },
    );
    expect(output.decisionSource).toBe("flagship");
    expect(output.decision).toBeNull();
    expect(output.flagship?.ok).toBe(false);
  });

  test("records a severe miss and both cost join identifiers", async () => {
    const h = harness({ fast: result(), flagship: result("rejected", 0.95, true, true) });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile, runId: () => "pv-ledger", now: () => new Date("2026-07-11T00:00:00Z") },
    );
    expect(output.severeMiss).toBe(true);
    const row = JSON.parse(readFileSync(h.ledgerPath, "utf8"));
    expect(row.fast).toMatchObject({ consensus_id: "cg-passed", gate_run_id: "gate-passed" });
    expect(row.flagship).toMatchObject({ consensus_id: "cg-rejected", gate_run_id: "gate-rejected" });
    expect(row.severe_miss).toBe(true);
    expect(row.input_sha256).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(baseInput.code);
  });

  test("treats a different Fast high-severity claim as a Flagship miss", async () => {
    const fast = result("rejected", 0.95, true, true);
    fast.verdicts![0].dissent_claims![0].claim = "different issue";
    const h = harness({ fast, flagship: result("rejected", 0.95, true, true) });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile },
    );
    expect(output.severeMiss).toBe(true);
  });

  test("classifies an all-error Fast panel as panel failure", async () => {
    const failedPanel = result();
    failedPanel.verdicts = [
      { model: "fast-model", pass: false, confidence: 0, issues: ["API error: 503"] },
      { model: "non-llm/arbiter-v1", pass: true, confidence: 1, issues: [] },
    ];
    const h = harness({ fast: failedPanel, flagship: result() });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile },
    );
    expect(output.trigger).toBe("panel_failure");
    expect(output.decisionSource).toBe("flagship");
    const promotion = evaluatePromotionContent(readFileSync(h.ledgerPath, "utf8"), { minSamples: 1 });
    expect(promotion.observed.comparable_samples).toBe(0);
    expect(promotion.eligible).toBe(false);
  });

  test("malformed Fast output escalates rather than becoming authoritative", async () => {
    const h = harness({ fast: { status: "passed" }, flagship: result() });
    const output = await runProfileEscalation(
      { ...baseInput, mode: "enforce", ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile, verifyPromotion: () => ({ eligible: true, blockers: [] }) },
    );
    expect(output.trigger).toBe("malformed");
    expect(output.decisionSource).toBe("flagship");
  });

  test("validates min confidence before spending a profile call", async () => {
    const h = harness({ fast: result(), flagship: result() });
    await expect(runProfileEscalation(
      { ...baseInput, minConfidence: Number.NaN, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile },
    )).rejects.toThrow("minConfidence");
    expect(h.calls).toEqual([]);
  });

  test("a malformed Flagship result never returns Fast", async () => {
    const h = harness({ fast: result(), flagship: { status: "passed" } });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile },
    );
    expect(output.decisionSource).toBe("flagship");
    expect(output.decision).toBeNull();
    expect(output.flagship?.failureTrigger).toBe("malformed");
  });

  test("a shaped but invalid Flagship consensus envelope never returns Fast", async () => {
    const malformed = result() as ProfileConsensusResult;
    malformed.status = "garbage" as ProfileConsensusResult["status"];
    const h = harness({ fast: result(), flagship: malformed });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: h.ledgerPath },
      { executeProfile: h.executeProfile },
    );
    expect(output.decision).toBeNull();
    expect(output.flagship?.failureTrigger).toBe("malformed");
  });

  test("an audit write failure is surfaced without discarding Flagship", async () => {
    const h = harness({ fast: result(), flagship: result() });
    const output = await runProfileEscalation(
      { ...baseInput, ledgerPath: "/dev/null/ledger.jsonl" },
      { executeProfile: h.executeProfile },
    );
    expect(output.decisionSource).toBe("flagship");
    expect(output.decision?.status).toBe("passed");
    expect(output.auditError).toContain("audit write failed");
  });

  test("default executor isolates the requested profile in each child process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-executor-"));
    tempDirs.push(dir);
    const gatePath = join(dir, "fake-gate.ts");
    writeFileSync(gatePath, `
      import { createHash } from "node:crypto";
      const profile = process.env.GATE_LINEUP_PROFILE;
      const panel = [profile + "-model"];
      const result = {
        id: "cg-" + profile,
        gate_run_id: "gate-" + profile,
        lineup_profile: profile,
        lineup_source: process.env.FAKE_BAD_PROOF ? "legacy" : "persisted-profile",
        panel,
        panel_fingerprint: createHash("sha256").update(JSON.stringify(panel)).digest("hex"),
        inherited_override: process.env.CONSENSUS_MODELS,
        status: "passed",
        consensus: { unanimous: true, confidence: 0.95 },
        verdicts: [{ model: panel[0], pass: true, confidence: 0.95, issues: [] }]
      };
      console.log("__CG_JSON__" + JSON.stringify(result));
    `);
    const input = { ...baseInput, gatePath };
    const originalOverride = process.env.CONSENSUS_MODELS;
    process.env.CONSENSUS_MODELS = "override-model";
    try {
      const fast = await executeConsensusProfile("fast", input);
      const flagship = await executeConsensusProfile("flagship", input);
      expect(fast.id).toBe("cg-fast");
      expect(flagship.id).toBe("cg-flagship");
      expect((fast as ProfileConsensusResult & { inherited_override?: string }).inherited_override).toBeUndefined();
      expect(process.env.GATE_LINEUP_PROFILE).toBeUndefined();
    } finally {
      if (originalOverride === undefined) delete process.env.CONSENSUS_MODELS;
      else process.env.CONSENSUS_MODELS = originalOverride;
    }
  });

  test("default executor rejects missing persisted-profile proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-proof-"));
    tempDirs.push(dir);
    const gatePath = join(dir, "fake-gate.ts");
    writeFileSync(gatePath, `
      console.log("__CG_JSON__" + JSON.stringify({
        id: "cg-fast", gate_run_id: "gate-fast", lineup_profile: "fast",
        lineup_source: "legacy", panel: ["legacy"], panel_fingerprint: "wrong",
        status: "passed", consensus: { unanimous: true, confidence: 0.95 },
        verdicts: [{ pass: true, confidence: 0.95, issues: [] }]
      }));
    `);
    await expect(executeConsensusProfile("fast", { ...baseInput, gatePath })).rejects.toThrow("persisted-profile proof");
  });
});
