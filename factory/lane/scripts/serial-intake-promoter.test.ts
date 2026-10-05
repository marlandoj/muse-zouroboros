import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalIdentifierFromTwin,
  discoverSerialConfigs,
  planSerialPromotion,
  tickAllSerialLanes,
  validateSerialPromotionConfig,
  type LinearIssueSnapshot,
  type SerialPromotionConfig,
} from "./serial-intake-promoter";

const CONFIG: SerialPromotionConfig = {
  version: 1,
  project_id: "project-canonical",
  project_name: "Example Project",
  intake_project_id: "project-intake",
  factory_ready_label_id: "factory-ready",
  tickets: [
    { identifier: "ZOU-1", stable_key: "EX-001", prerequisites: [] },
    { identifier: "ZOU-2", stable_key: "EX-002", prerequisites: ["ZOU-1"] },
    { identifier: "ZOU-3", stable_key: "EX-003", prerequisites: ["ZOU-1"] },
  ],
  retired: false,
};

function issue(
  identifier: string,
  overrides: Partial<LinearIssueSnapshot> = {},
): LinearIssueSnapshot {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `[${identifier}] title`,
    description: "",
    priority: 2,
    state_type: "backlog",
    project_id: "project-canonical",
    label_ids: [],
    comment_bodies: [],
    team_id: "team",
    backlog_state_id: "state-backlog",
    done_state_id: "state-done",
    archived_at: null,
    ...overrides,
  };
}

function twin(
  identifier: string,
  canonical: string,
  stateType: string,
  labels: string[] = [],
): LinearIssueSnapshot {
  return issue(identifier, {
    description: `Canonical issue: ${canonical}\n\nPromotion mode: serial Intake twin`,
    state_type: stateType,
    project_id: "project-intake",
    label_ids: labels,
  });
}

const canonicals = () => CONFIG.tickets.map((ticket) => issue(ticket.identifier));

describe("validateSerialPromotionConfig", () => {
  test("accepts a topologically ordered manifest", () => {
    expect(validateSerialPromotionConfig(CONFIG)).toEqual(CONFIG);
  });

  test("rejects forward prerequisites", () => {
    const bad = structuredClone(CONFIG);
    bad.tickets[0]!.prerequisites = ["ZOU-2"];
    expect(() => validateSerialPromotionConfig(bad)).toThrow("must appear earlier");
  });

  test("rejects duplicate stable keys", () => {
    const bad = structuredClone(CONFIG);
    bad.tickets[1]!.stable_key = "EX-001";
    expect(() => validateSerialPromotionConfig(bad)).toThrow("duplicate stable key");
  });

  test("defaults retired to false and accepts an explicitly retired lane", () => {
    const { retired: _omitted, ...withoutRetired } = CONFIG;
    expect(validateSerialPromotionConfig(withoutRetired).retired).toBe(false);
    expect(validateSerialPromotionConfig({ ...CONFIG, retired: true }).retired).toBe(true);
  });

  test("rejects a non-boolean retired flag", () => {
    expect(() => validateSerialPromotionConfig({ ...CONFIG, retired: "yes" })).toThrow(
      "config.retired must be a boolean",
    );
  });
});

describe("canonicalIdentifierFromTwin", () => {
  test("requires both the exact canonical line and serial-twin marker", () => {
    expect(canonicalIdentifierFromTwin("Canonical issue: ZOU-10\nPromotion mode: serial Intake twin")).toBe("ZOU-10");
    expect(canonicalIdentifierFromTwin("Canonical issue: ZOU-10")).toBeNull();
    expect(canonicalIdentifierFromTwin("Canonical issue: not-an-id\nPromotion mode: serial Intake twin")).toBeNull();
  });
});

describe("planSerialPromotion", () => {
  test("a completed twin reconciles its canonical and unlocks the next configured ticket", () => {
    const plan = planSerialPromotion(CONFIG, canonicals(), [twin("ZOU-100", "ZOU-1", "completed")]);
    expect(plan.canonical_completions).toEqual([
      {
        canonical_identifier: "ZOU-1",
        canonical_issue_id: "id-ZOU-1",
        twin_identifier: "ZOU-100",
      },
    ]);
    expect(plan.promotion).toMatchObject({
      mode: "create",
      canonical_identifier: "ZOU-2",
      stable_key: "EX-002",
    });
  });

  test("configured order breaks ties between simultaneously unblocked tickets", () => {
    const completed = canonicals();
    completed[0]!.state_type = "completed";
    const plan = planSerialPromotion(CONFIG, completed, []);
    expect(plan.promotion?.canonical_identifier).toBe("ZOU-2");
  });

  test("reuses an existing unlabeled pullable twin instead of creating a duplicate", () => {
    const plan = planSerialPromotion(CONFIG, canonicals(), [twin("ZOU-100", "ZOU-1", "backlog")]);
    expect(plan.promotion).toEqual({
      mode: "label_existing",
      canonical_identifier: "ZOU-1",
      stable_key: "EX-001",
      existing_twin_id: "id-ZOU-100",
      existing_twin_identifier: "ZOU-100",
    });
  });

  test("an existing labeled twin owns the project lane", () => {
    const plan = planSerialPromotion(CONFIG, canonicals(), [
      twin("ZOU-100", "ZOU-1", "backlog", ["factory-ready"]),
    ]);
    expect(plan.promotion).toBeNull();
    expect(plan.reason).toContain("already owns");
  });

  test("a started twin blocks a second project twin", () => {
    const plan = planSerialPromotion(CONFIG, canonicals(), [twin("ZOU-100", "ZOU-1", "started")]);
    expect(plan.promotion).toBeNull();
    expect(plan.reason).toContain("already owns");
  });

  test("an unrelated factory-ready ticket fills the queue at the default cap of 1", () => {
    const ready = issue("ZOU-999", {
      project_id: "project-intake",
      state_type: "backlog",
      label_ids: ["factory-ready"],
    });
    const plan = planSerialPromotion(CONFIG, canonicals(), [ready]);
    expect(plan.promotion).toBeNull();
    expect(plan.reason).toContain("in-flight cap (1)");
    expect(plan.reason).toContain("ZOU-999");
  });

  test("FACTORY_INFLIGHT_CAP=2 admits a promotion beside one occupied queue slot", () => {
    process.env.FACTORY_INFLIGHT_CAP = "2";
    try {
      const ready = issue("ZOU-999", {
        project_id: "project-intake",
        state_type: "backlog",
        label_ids: ["factory-ready"],
      });
      const plan = planSerialPromotion(CONFIG, canonicals(), [ready]);
      expect(plan.promotion).toMatchObject({ mode: "create", canonical_identifier: "ZOU-1" });
    } finally {
      delete process.env.FACTORY_INFLIGHT_CAP;
    }
  });

  test("FACTORY_INFLIGHT_CAP=2 still blocks when two queue slots are occupied", () => {
    process.env.FACTORY_INFLIGHT_CAP = "2";
    try {
      const ready = (id: string) =>
        issue(id, {
          project_id: "project-intake",
          state_type: "backlog",
          label_ids: ["factory-ready"],
        });
      const plan = planSerialPromotion(CONFIG, canonicals(), [ready("ZOU-998"), ready("ZOU-999")]);
      expect(plan.promotion).toBeNull();
      expect(plan.reason).toContain("in-flight cap (2)");
    } finally {
      delete process.env.FACTORY_INFLIGHT_CAP;
    }
  });

  test("multiple active twins fail closed", () => {
    expect(() =>
      planSerialPromotion(CONFIG, canonicals(), [
        twin("ZOU-100", "ZOU-1", "backlog"),
        twin("ZOU-101", "ZOU-2", "backlog"),
      ]),
    ).toThrow("multiple active serial twins");
  });

  test("a missing canonical issue fails closed", () => {
    expect(() => planSerialPromotion(CONFIG, canonicals().slice(0, 2), [])).toThrow(
      "canonical issue missing",
    );
  });

  test("FH-23: an archived completed twin still proves its canonical shipped", () => {
    const archived = twin("ZOU-100", "ZOU-1", "completed");
    archived.archived_at = "2026-07-26T18:00:00.000Z";
    const plan = planSerialPromotion(CONFIG, canonicals(), [archived]);
    expect(plan.canonical_completions).toEqual([
      {
        canonical_identifier: "ZOU-1",
        canonical_issue_id: "id-ZOU-1",
        twin_identifier: "ZOU-100",
      },
    ]);
    // Without the evidence the promoter would re-mint EX-001 — the ZOU-921 duplicate.
    expect(plan.promotion).toMatchObject({ canonical_identifier: "ZOU-2", stable_key: "EX-002" });
  });

  test("FH-23: an archived open twin never owns the lane", () => {
    const archived = twin("ZOU-100", "ZOU-1", "started");
    archived.archived_at = "2026-07-26T18:00:00.000Z";
    const plan = planSerialPromotion(CONFIG, canonicals(), [archived]);
    expect(plan.reason).not.toContain("already owns");
    expect(plan.promotion).toMatchObject({ canonical_identifier: "ZOU-1", stable_key: "EX-001" });
  });

  test("FH-23: an archived factory-ready ticket does not block the queue", () => {
    const ready = issue("ZOU-999", {
      project_id: "project-intake",
      state_type: "backlog",
      label_ids: ["factory-ready"],
      archived_at: "2026-07-26T18:00:00.000Z",
    });
    const plan = planSerialPromotion(CONFIG, canonicals(), [ready]);
    expect(plan.reason).not.toContain("queue already contains");
    expect(plan.promotion).toMatchObject({ canonical_identifier: "ZOU-1" });
  });

  test("FH-23: an archived canonical is skipped without a writeback", () => {
    const list = canonicals();
    list[0]!.archived_at = "2026-07-26T18:00:00.000Z";
    const plan = planSerialPromotion(CONFIG, list, []);
    expect(plan.canonical_completions).toEqual([]);
    expect(plan.promotion).toMatchObject({ canonical_identifier: "ZOU-2" });
  });

  test("a completed project produces no further promotion", () => {
    const completed = canonicals().map((canonical) => ({ ...canonical, state_type: "completed" }));
    const plan = planSerialPromotion(CONFIG, completed, []);
    expect(plan.promotion).toBeNull();
    expect(plan.reason).toBe("serial project complete");
  });
});

describe("multi-lane discovery (tick-all)", () => {
  function laneDir(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "serial-lanes-"));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(body));
    }
    return dir;
  }

  function lane(overrides: Partial<SerialPromotionConfig> = {}): Record<string, unknown> {
    return { ...CONFIG, ...overrides };
  }

  test("discovery returns every json lane in sorted order", () => {
    const dir = laneDir({ "b.json": lane(), "a.json": lane(), "notes.md": {} });
    try {
      expect(discoverSerialConfigs(dir).map((path) => path.split("/").pop())).toEqual(["a.json", "b.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const ticked: string[] = [];
  const ignoredRecord: NonNullable<Parameters<typeof tickAllSerialLanes>[2]> = () => undefined;
  const fakeTick = async (config: SerialPromotionConfig) => {
    ticked.push(config.project_name);
    return {
      ok: true as const,
      mode: "shadow" as const,
      project: config.project_name,
      canonical_completions: [],
      promotion: null,
      reason: "stub",
    };
  };

  beforeEach(() => {
    ticked.length = 0;
  });

  test("a retired lane no longer hides a live one", async () => {
    // The production failure: the conveyor pinned --config at the retired lane
    // and reported ok:true forever while the live lane was never ticked.
    const dir = laneDir({
      "retired.json": lane({ project_name: "Retired", retired: true }),
      "live.json": lane({ project_name: "Live" }),
    });
    try {
      const report = await tickAllSerialLanes(dir, fakeTick, ignoredRecord);
      expect(report.ok).toBe(true);
      expect(report.reachable_lanes).toBe(1);
      expect(ticked).toEqual(["Live"]);
      expect(report.lanes.find((entry) => entry.project === "Retired")?.retired).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lane whose tick throws fails the cycle", async () => {
    const dir = laneDir({ "live.json": lane({ project_name: "Live" }) });
    try {
      const report = await tickAllSerialLanes(dir, async () => {
        throw new Error("linear unreachable");
      }, ignoredRecord);
      expect(report.ok).toBe(false);
      expect(report.reason).toContain("linear unreachable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an all-retired factory stays ok but names the condition", async () => {
    const dir = laneDir({ "one.json": lane({ retired: true }) });
    const events: Array<{ kind: string; detail?: string }> = [];
    try {
      const report = await tickAllSerialLanes(dir, fakeTick, (event) => events.push(event));
      expect(report.ok).toBe(true);
      expect(report.all_retired).toBe(true);
      expect(report.reason).toContain("retired");
      expect(events).toEqual([expect.objectContaining({
        kind: "serial-promotion.no-reachable-lane",
        detail: "1 configured, all retired",
      })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty config directory fails the cycle", async () => {
    const dir = laneDir({});
    try {
      const report = await tickAllSerialLanes(dir, fakeTick, ignoredRecord);
      expect(report.ok).toBe(false);
      expect(report.reason).toContain("no serial promotion configs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unloadable lane fails the cycle instead of being skipped", async () => {
    const dir = laneDir({ "broken.json": { version: 1 }, "retired.json": lane({ retired: true }) });
    try {
      const report = await tickAllSerialLanes(dir, fakeTick, ignoredRecord);
      expect(report.ok).toBe(false);
      expect(report.reason).toContain("broken.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
