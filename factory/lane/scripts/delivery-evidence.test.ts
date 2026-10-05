import { describe, expect, test } from "bun:test";
import type { FlightEvent } from "./flight-recorder";
import { projectLifecycle } from "./lifecycle-projection";
import { deliveredCanonicals, deliveryEvidenceFrom } from "./delivery-evidence";
import { planSerialPromotion, type LinearIssueSnapshot, type SerialPromotionConfig } from "./serial-intake-promoter";

const NOW = "2026-07-26T18:00:00.000Z";

function projection(events: FlightEvent[], records: Array<Record<string, unknown>> = []) {
  return projectLifecycle({ events, records, now: NOW });
}

describe("delivery evidence (FH-11)", () => {
  test("a merged execution proves its twin delivered", () => {
    const evidence = deliveryEvidenceFrom(projection([
      { execution_id: "exec-89dbc53a", identifier: "ZOU-913", kind: "reconcile.execution-merged", ts: "2026-07-24T12:00:00.000Z" },
    ]));
    expect(evidence.ok).toBe(true);
    expect(evidence.byTwin.get("ZOU-913")).toMatchObject({
      execution_id: "exec-89dbc53a",
      state: "merged",
      source: "lifecycle_projection",
    });
  });

  test("an execution short of merge is not delivery evidence", () => {
    const evidence = deliveryEvidenceFrom(projection([
      { execution_id: "exec-x", identifier: "ZOU-999", kind: "exec.pr_ready", ts: "2026-07-24T12:00:00.000Z" },
    ]));
    expect(evidence.byTwin.size).toBe(0);
  });

  test("deployed and accepted also count as delivered", () => {
    for (const kind of ["exec.deployed", "exec.accepted"]) {
      const evidence = deliveryEvidenceFrom(projection([
        { execution_id: "exec-x", identifier: "ZOU-999", kind, ts: "2026-07-24T12:00:00.000Z" },
      ]));
      expect(evidence.byTwin.has("ZOU-999")).toBe(true);
    }
  });

  test("a degraded projection yields NO evidence and an explicit reason", () => {
    // Partial evidence is worse than none: it would let the promoter conclude
    // "not delivered" from missing data and mint the duplicate this closes.
    const evidence = deliveryEvidenceFrom({
      ok: false,
      degraded_reason: "journal unreadable",
      generated_at: NOW,
      executions: [],
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.byTwin.size).toBe(0);
    expect(evidence.degraded_reason).toBe("journal unreadable");
  });

  test("maps twins onto canonical identifiers", () => {
    const evidence = deliveryEvidenceFrom(projection([
      { execution_id: "exec-89dbc53a", identifier: "ZOU-913", kind: "reconcile.execution-merged", ts: "2026-07-24T12:00:00.000Z" },
    ]));
    const delivered = deliveredCanonicals(
      evidence,
      [{ identifier: "ZOU-913" }],
      (twin) => (twin === "ZOU-913" ? "ZOU-836" : null),
    );
    expect(delivered.get("ZOU-836")?.twin_identifier).toBe("ZOU-913");
  });

  test("a twin with no canonical mapping is ignored rather than guessed", () => {
    const evidence = deliveryEvidenceFrom(projection([
      { execution_id: "exec-x", identifier: "ZOU-913", kind: "reconcile.execution-merged", ts: "2026-07-24T12:00:00.000Z" },
    ]));
    expect(deliveredCanonicals(evidence, [{ identifier: "ZOU-913" }], () => null).size).toBe(0);
  });

  test("degraded evidence maps to nothing, so the promoter falls back to Linear", () => {
    const delivered = deliveredCanonicals(
      { ok: false, degraded_reason: "x", byTwin: new Map() },
      [{ identifier: "ZOU-913" }],
      () => "ZOU-836",
    );
    expect(delivered.size).toBe(0);
  });
});

// ─── The ZOU-921 duplicate, end to end ───────────────────────────────────────

const TWIN_BODY = [
  "Promotion mode: serial Intake twin",
  "Canonical issue: ZOU-836",
].join("\n");

function issue(overrides: Partial<LinearIssueSnapshot> & { identifier: string }): LinearIssueSnapshot {
  return {
    id: `id-${overrides.identifier}`,
    title: overrides.identifier,
    description: "",
    priority: 2,
    state_type: "backlog",
    project_id: "proj-canonical",
    label_ids: [],
    comment_bodies: [],
    team_id: "team",
    backlog_state_id: "backlog",
    done_state_id: "done",
    archived_at: null,
    ...overrides,
  };
}

const CONFIG: SerialPromotionConfig = {
  version: 1,
  project_id: "proj-canonical",
  project_name: "ZouroBench Results Explorer",
  intake_project_id: "proj-intake",
  factory_ready_label_id: "label-ready",
  tickets: [
    { identifier: "ZOU-836", stable_key: "ZBRE-008", prerequisites: [] },
    { identifier: "ZOU-837", stable_key: "ZBRE-009", prerequisites: ["ZOU-836"] },
  ],
  retired: false,
};

describe("exactly-once serial promotion (FH-11)", () => {
  const canonical = [
    issue({ identifier: "ZOU-836", state_type: "unstarted" }),
    issue({ identifier: "ZOU-837", state_type: "backlog" }),
  ];
  // ZOU-913 delivered ZBRE-008 via merged PR #393, but Linear was not yet
  // flipped — the exact window that produced ZOU-921.
  const intake = [
    issue({ identifier: "ZOU-913", state_type: "started", project_id: "proj-intake", description: TWIN_BODY }),
  ];

  test("without delivery evidence the promoter still sees ZBRE-008 as incomplete", () => {
    const plan = planSerialPromotion(CONFIG, canonical, intake);
    // The active twin holds the lane, so no duplicate is minted here — but
    // ZOU-836 is NOT recorded as complete, which is the state that let ZOU-921
    // be created once the twin closed.
    expect(plan.canonical_completions).toEqual([]);
  });

  test("with delivery evidence ZBRE-008 is complete and the lane advances", () => {
    const evidence = deliveryEvidenceFrom(projection([
      { execution_id: "exec-89dbc53a", identifier: "ZOU-913", kind: "reconcile.execution-merged", ts: "2026-07-24T12:00:00.000Z" },
    ]));
    const delivered = deliveredCanonicals(evidence, intake, () => "ZOU-836");

    // The twin has since closed; only merge evidence can prove ZBRE-008 landed.
    const closedTwin = [issue({ ...intake[0], state_type: "canceled" })];
    const plan = planSerialPromotion(CONFIG, canonical, closedTwin, delivered);

    expect(plan.canonical_completions.map((entry) => entry.canonical_identifier)).toEqual(["ZOU-836"]);
    expect(plan.canonical_completions[0].twin_identifier).toBe("ZOU-913");
    // The successor is promoted — not a second ZBRE-008 twin.
    expect(plan.promotion?.canonical_identifier).toBe("ZOU-837");
    expect(plan.promotion?.stable_key).toBe("ZBRE-009");
  });

  test("evidence never promotes a ticket whose prerequisites are unmet", () => {
    const delivered = new Map([["ZOU-837", { twin_identifier: "ZOU-999", execution_id: "e", state: "merged" }]]);
    const plan = planSerialPromotion(CONFIG, canonical, [], delivered);
    // ZBRE-009 reads complete from evidence, so the only candidate is ZBRE-008.
    expect(plan.promotion?.canonical_identifier).toBe("ZOU-836");
  });

  test("omitting the argument preserves the previous behaviour exactly", () => {
    expect(JSON.stringify(planSerialPromotion(CONFIG, canonical, [])))
      .toBe(JSON.stringify(planSerialPromotion(CONFIG, canonical, [], new Map())));
  });
});
