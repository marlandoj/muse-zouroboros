import { describe, expect, test } from "bun:test";
import type { RiskVerdict } from "./risk-classifier";
import {
  agreementStats,
  classifyLinearIssueOutcome,
  computeCalibration,
  harvestLinearOutcomes,
  reconcileCalibrationExclusion,
  reconcileSupersededLinearRejection,
  selectHarvestOutcome,
  type LedgerEntry,
  type LinearHarvestOutcome,
} from "./approval-ledger";

const observedAt = "2026-08-28T13:51:56.000Z";

function riskVerdict(): RiskVerdict {
  return {
    verdict_id: "rv-zou-1539",
    execution_id: "exec-zou-1539",
    ticket_id: "53a5b30b-27ea-47dd-b17a-53e8cf76d6aa",
    identifier: "ZOU-1539",
    tier: "low",
    score: 0.1,
    reasons: ["fixture"],
    inputs: {
      archetype: "docs",
      target_repo: "zouroboros",
      repro: "fixture",
      acceptance_criteria: "fixture",
      gate_decision: "DIRECT",
      files_touched_estimate: 1,
      schema_contact: false,
      secret_contact: false,
      infra_contact: false,
      reversibility: "easy",
      seed_eval_score: null,
    },
    classified_at: "2026-08-28T12:03:00.000Z",
    mode: "shadow",
    acted: false,
  };
}

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    verdict: riskVerdict(),
    operator_verdict: "rejected",
    harvested_at: "2026-08-28T13:31:08.000Z",
    harvest_source: "linear",
    agreement: false,
    calibration_exclusion: null,
    flags: {
      SF002_CLASSIFY: true,
      SF002_ENFORCE: false,
      SF002_AUTO_PROMOTE: false,
    },
    appended_at: "2026-08-28T13:31:08.000Z",
    ...overrides,
  };
}

function supersededOutcome(): LinearHarvestOutcome {
  const outcome = classifyLinearIssueOutcome(
    {
      id: "53a5b30b-27ea-47dd-b17a-53e8cf76d6aa",
      identifier: "ZOU-1539",
      state: { type: "duplicate" },
      relations: {
        nodes: [
          {
            type: "duplicate",
            relatedIssue: {
              id: "8cad78eb-ae5b-49de-9f60-0629a14adfa3",
              identifier: "ZOU-1548",
            },
          },
        ],
      },
    },
    observedAt,
  );
  if (!outcome) throw new Error("expected a Linear outcome");
  return outcome;
}

describe("Linear outcome classification", () => {
  test("completed work is approved", () => {
    expect(classifyLinearIssueOutcome({ state: { type: "completed" } }, observedAt)).toEqual({
      operator_verdict: "approved",
      calibration_exclusion: null,
    });
  });

  test("cancellation without duplicate lineage remains rejected", () => {
    expect(classifyLinearIssueOutcome({ state: { type: "canceled" }, relations: { nodes: [] } }, observedAt)).toEqual({
      operator_verdict: "rejected",
      calibration_exclusion: null,
    });
  });

  test("native duplicate lineage is excluded with successor provenance", () => {
    expect(supersededOutcome()).toEqual({
      operator_verdict: "pending",
      calibration_exclusion: {
        reason: "superseded",
        source: "linear_duplicate_relation",
        related_issue_id: "8cad78eb-ae5b-49de-9f60-0629a14adfa3",
        related_issue_identifier: "ZOU-1548",
        observed_at: observedAt,
      },
    });
  });

  test("canceled state with explicit duplicate lineage is also excluded", () => {
    const outcome = classifyLinearIssueOutcome(
      {
        state: { type: "canceled" },
        relations: {
          nodes: [{ type: "duplicate", relatedIssue: { id: "successor-id", identifier: "ZOU-2000" } }],
        },
      },
      observedAt,
    );
    expect(outcome?.calibration_exclusion?.related_issue_identifier).toBe("ZOU-2000");
  });

  test("duplicate state without a verifiable outgoing relation fails closed as rejected", () => {
    expect(classifyLinearIssueOutcome({ state: { type: "duplicate" }, relations: { nodes: [] } }, observedAt)).toEqual({
      operator_verdict: "rejected",
      calibration_exclusion: null,
    });
  });

  test("nonterminal work remains pending", () => {
    expect(classifyLinearIssueOutcome({ state: { type: "backlog" } }, observedAt)).toEqual({
      operator_verdict: "pending",
      calibration_exclusion: null,
    });
  });
});

describe("harvest precedence and reconciliation", () => {
  test("a missing Linear issue cannot poison valid outcomes in the same batch", async () => {
    const calls: string[][] = [];
    const fetcher = async (_input: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as { variables: Record<string, string> };
      const ids = Object.values(body.variables);
      calls.push(ids);
      if (ids.includes("missing-ticket")) {
        return Response.json({
          data: null,
          errors: [{ message: "Entity not found: Issue", path: ["issue0"] }],
        });
      }
      return Response.json({
        data: Object.fromEntries(
          ids.map((id, index) => [
            `issue${index}`,
            {
              id,
              identifier: id === "approved-ticket" ? "ZOU-2001" : "ZOU-2002",
              state: { type: id === "approved-ticket" ? "completed" : "canceled" },
              relations: { nodes: [] },
            },
          ]),
        ),
      });
    };

    const outcomes = await harvestLinearOutcomes(
      ["approved-ticket", "missing-ticket", "rejected-ticket"],
      { apiKey: "test-key", fetcher },
    );

    expect(outcomes.get("approved-ticket")?.operator_verdict).toBe("approved");
    expect(outcomes.get("rejected-ticket")?.operator_verdict).toBe("rejected");
    expect(outcomes.has("missing-ticket")).toBe(false);
    expect(calls).toEqual([
      ["approved-ticket", "missing-ticket", "rejected-ticket"],
      ["approved-ticket", "missing-ticket"],
      ["approved-ticket"],
      ["missing-ticket"],
      ["rejected-ticket"],
    ]);
  });

  test("a non-missing GraphQL failure does not fan out the batch", async () => {
    const calls: string[][] = [];
    const fetcher = async (_input: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as { variables: Record<string, string> };
      calls.push(Object.values(body.variables));
      return Response.json({
        data: null,
        errors: [{ message: "Rate limit exceeded" }],
      });
    };

    const outcomes = await harvestLinearOutcomes(
      ["ticket-one", "ticket-two"],
      { apiKey: "test-key", fetcher },
    );

    expect(outcomes.size).toBe(0);
    expect(calls).toEqual([["ticket-one", "ticket-two"]]);
  });

  test("closed PR rejection takes precedence over Linear supersession", () => {
    expect(selectHarvestOutcome("rejected", supersededOutcome())).toEqual({
      operator_verdict: "rejected",
      calibration_exclusion: null,
      harvest_source: "pr",
    });
  });

  test("Linear supersession is selected only when PR evidence is nonterminal", () => {
    expect(selectHarvestOutcome("pending", supersededOutcome())).toEqual({
      ...supersededOutcome(),
      harvest_source: "linear",
    });
  });

  test("resolved Linear rejection receives an append-only correction object", () => {
    const original = ledgerEntry();
    const corrected = reconcileSupersededLinearRejection(original, supersededOutcome());
    expect(corrected).not.toBe(original);
    expect(original.operator_verdict).toBe("rejected");
    expect(corrected?.verdict.verdict_id).toBe(original.verdict.verdict_id);
    expect(corrected?.operator_verdict).toBe("pending");
    expect(corrected?.agreement).toBeNull();
    expect(corrected?.calibration_exclusion?.related_issue_identifier).toBe("ZOU-1548");
  });

  test("PR-sourced and genuine Linear rejections are not reconciled", () => {
    expect(
      reconcileSupersededLinearRejection(ledgerEntry({ harvest_source: "pr" }), supersededOutcome()),
    ).toBeNull();
    expect(
      reconcileSupersededLinearRejection(ledgerEntry(), {
        operator_verdict: "rejected",
        calibration_exclusion: null,
      }),
    ).toBeNull();
  });

  test("an unchanged exclusion is idempotent", () => {
    const excluded = reconcileSupersededLinearRejection(ledgerEntry(), supersededOutcome());
    if (!excluded) throw new Error("expected exclusion");
    expect(reconcileCalibrationExclusion(excluded, "pending", supersededOutcome())).toBeNull();
  });

  test("removing duplicate lineage appends a restored rejection", () => {
    const excluded = reconcileSupersededLinearRejection(ledgerEntry(), supersededOutcome());
    if (!excluded) throw new Error("expected exclusion");
    const restored = reconcileCalibrationExclusion(excluded, "pending", {
      operator_verdict: "rejected",
      calibration_exclusion: null,
    });
    expect(restored?.operator_verdict).toBe("rejected");
    expect(restored?.agreement).toBe(false);
    expect(restored?.calibration_exclusion).toBeNull();
  });

  test("a later closed PR restores rejection with PR precedence", () => {
    const excluded = reconcileSupersededLinearRejection(ledgerEntry(), supersededOutcome());
    if (!excluded) throw new Error("expected exclusion");
    const restored = reconcileCalibrationExclusion(excluded, "rejected", supersededOutcome());
    expect(restored?.operator_verdict).toBe("rejected");
    expect(restored?.harvest_source).toBe("pr");
    expect(restored?.calibration_exclusion).toBeNull();
  });
});

describe("calibration exclusion", () => {
  test("genuine low-tier rejection remains a false approval", () => {
    const matrix = computeCalibration(new Map([["rv-zou-1539", ledgerEntry()]]));
    expect(matrix.false_approval).toBe(1);
    expect(matrix.false_approval_rate).toBe(1);
  });

  test("supersession correction is excluded from pending and calibration denominators", () => {
    const corrected = reconcileSupersededLinearRejection(ledgerEntry(), supersededOutcome());
    if (!corrected) throw new Error("expected correction");
    const entries = new Map([[corrected.verdict.verdict_id, corrected]]);
    const matrix = computeCalibration(entries);
    const stats = agreementStats(entries);
    expect(matrix.resolved_rows).toBe(0);
    expect(matrix.deduped_decisions).toBe(0);
    expect(matrix.false_approval).toBe(0);
    expect(stats.excluded).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.resolved).toBe(0);
  });
});
