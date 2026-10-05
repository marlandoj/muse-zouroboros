import { describe, expect, test } from "bun:test";
import { openDraftPr, type PrRunner } from "./draft-pr";
import { planDraftPr, type DraftPrPlan } from "./ship-ready-core";

function plan(over: Partial<DraftPrPlan> = {}): DraftPrPlan {
  const base = planDraftPr({
    identifier: "ZOU-901",
    execution_id: "exec-aaaa1111",
    branch_name: "factory/zou-901",
    completed_at: "2026-07-13T00:00:00.000Z",
    age_minutes: 90,
  });
  return { ...base, ...over };
}

/** In-memory runner that records every create call so duplicates are visible. */
function fakeRunner(seed: Record<string, { number: number; url: string }> = {}) {
  const open = new Map(Object.entries(seed));
  const creates: string[] = [];
  const runner: PrRunner = {
    async findByBranch(branch) {
      return open.get(branch) ?? null;
    },
    async createDraft(p) {
      creates.push(p.branch);
      const rec = { number: 500 + creates.length, url: `https://github.com/x/y/pull/${500 + creates.length}` };
      open.set(p.branch, rec);
      return rec;
    },
  };
  return { runner, creates, open };
}

describe("openDraftPr", () => {
  test("creates a draft PR when none exists", async () => {
    const { runner, creates } = fakeRunner();
    const res = await openDraftPr(plan(), runner);
    expect(res.created).toBe(true);
    expect(res.number).toBeGreaterThan(0);
    expect(creates).toEqual(["factory/zou-901"]);
  });

  test("is idempotent — reuses an existing open PR, never a duplicate (AC#4)", async () => {
    const { runner, creates } = fakeRunner({ "factory/zou-901": { number: 42, url: "u" } });
    const res = await openDraftPr(plan(), runner);
    expect(res.created).toBe(false);
    expect(res.number).toBe(42);
    expect(creates).toEqual([]);
  });

  test("three replays create exactly one PR", async () => {
    const { runner, creates } = fakeRunner();
    await openDraftPr(plan(), runner);
    await openDraftPr(plan(), runner);
    await openDraftPr(plan(), runner);
    expect(creates).toHaveLength(1);
  });

  test("refuses a plan with auto_merge flipped on (human-gated merge)", async () => {
    const { runner } = fakeRunner();
    await expect(openDraftPr(plan({ auto_merge: true as unknown as false }), runner)).rejects.toThrow(/auto_merge must be false/);
  });

  test("refuses a non-draft plan", async () => {
    const { runner } = fakeRunner();
    await expect(openDraftPr(plan({ draft: false as unknown as true }), runner)).rejects.toThrow(/draft-only/);
  });
});
