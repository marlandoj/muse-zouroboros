import { describe, expect, test } from "bun:test";
import {
  computeTelemetry,
  cycleTimeMinutes,
  firstPass,
  retryCount,
  summarizeTelemetry,
  survivabilitySchedule,
  type ExecutionTelemetry,
  type TelemetryJoins,
  type TelemetryRecord,
} from "./execution-telemetry";

const NOW = "2026-07-13T00:00:00.000Z";

function rec(over: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    execution_id: "exec-aaaa1111",
    identifier: "ZOU-901",
    ticket_id: "issue-1",
    state: "merged",
    started_at: "2026-07-01T00:00:00.000Z",
    completed_at: "2026-07-01T02:30:00.000Z",
    ...over,
  } as TelemetryRecord;
}

describe("cycleTimeMinutes", () => {
  test("started → completed in minutes", () => {
    expect(cycleTimeMinutes(rec())).toBe(150);
  });
  test("in-flight (no completed_at) is unknown, not zero", () => {
    expect(cycleTimeMinutes(rec({ completed_at: null }))).toBeNull();
  });
  test("negative interval (clock skew) is rejected", () => {
    expect(cycleTimeMinutes(rec({ completed_at: "2026-06-30T00:00:00.000Z" }))).toBeNull();
  });
});

describe("retryCount", () => {
  test("counts failover attempts beyond the first", () => {
    expect(retryCount(rec({ failover_trail: "fable5→sol→glm" }))).toBe(2);
    expect(retryCount(rec({ failover_trail: "fable5" }))).toBe(0);
    expect(retryCount(rec({ failover_trail: "a->b" }))).toBe(1);
  });
  test("absent trail is unknown, not zero", () => {
    expect(retryCount(rec())).toBeNull();
    expect(retryCount(rec({ failover_trail: "  " }))).toBeNull();
  });
});

describe("firstPass", () => {
  test("pass without rework is first-pass", () => {
    expect(firstPass({ verdict: "pass", rework: false })).toBe(true);
  });
  test("pass with rework is not first-pass", () => {
    expect(firstPass({ verdict: "pass", rework: true })).toBe(false);
  });
  test("fail is not first-pass", () => {
    expect(firstPass({ verdict: "fail", rework: false })).toBe(false);
  });
  test("unmeasured is unknown, not false", () => {
    expect(firstPass(null)).toBeNull();
    expect(firstPass(undefined)).toBeNull();
  });
});

describe("computeTelemetry — honest nulls (charter mandate)", () => {
  test("a measured merged exec with no cost/intervention names every unknown", () => {
    const t = computeTelemetry(rec(), { verdict: { verdict: "pass", rework: false } }, NOW);
    expect(t.cycle_time_minutes).toBe(150);
    expect(t.first_pass).toBe(true);
    expect(t.rework).toBe(false);
    expect(t.retry_count).toBeNull();
    expect(t.model_cost_usd).toBeNull();
    expect(t.operator_intervention_minutes).toBeNull();
    // Every null field is auditable as unknown — never a silent zero.
    expect(t.unknowns.sort()).toEqual([
      "model_cost_usd",
      "operator_intervention_minutes",
      "retry_count",
    ]);
  });

  test("supplied joins clear the corresponding unknowns", () => {
    const joins: TelemetryJoins = {
      verdict: { verdict: "pass", rework: true },
      model_cost_usd: 0.42,
      operator_intervention_minutes: 12,
    };
    const t = computeTelemetry(rec({ failover_trail: "a→b" }), joins, NOW);
    expect(t.model_cost_usd).toBe(0.42);
    expect(t.operator_intervention_minutes).toBe(12);
    expect(t.retry_count).toBe(1);
    expect(t.first_pass).toBe(false);
    expect(t.rework).toBe(true);
    expect(t.unknowns).toEqual([]);
  });

  test("a negative cost is rejected as unknown, never trusted", () => {
    const t = computeTelemetry(rec(), { model_cost_usd: -1 }, NOW);
    expect(t.model_cost_usd).toBeNull();
    expect(t.unknowns).toContain("model_cost_usd");
  });

  test("a non-finite intervention is rejected as unknown (same guard as cost)", () => {
    const t = computeTelemetry(rec(), { operator_intervention_minutes: Number.POSITIVE_INFINITY }, NOW);
    expect(t.operator_intervention_minutes).toBeNull();
    expect(t.unknowns).toContain("operator_intervention_minutes");
  });
});

describe("computeTelemetry — survivability (AC#7)", () => {
  test("merged exec schedules 7/30-day checks; the 7-day is overdue at NOW", () => {
    const t = computeTelemetry(rec(), { verdict: { verdict: "pass", rework: false } }, NOW);
    expect(t.survivability.status).toBe("pending");
    expect(t.survivability.reason).toBeNull();
    expect(t.survivability.checks.map((c) => c.window_days)).toEqual([7, 30]);
    const seven = t.survivability.checks.find((c) => c.window_days === 7)!;
    const thirty = t.survivability.checks.find((c) => c.window_days === 30)!;
    // merged 2026-07-01T02:30 ⇒ 7d due 07-08 (past NOW), 30d due 07-31 (future).
    expect(seven.overdue).toBe(true);
    expect(thirty.overdue).toBe(false);
  });

  test("unmerged exec is not_applicable with a terminal reason, no checks", () => {
    const t = computeTelemetry(
      rec({ state: "failed", error: "harness timeout", completed_at: null }),
      {},
      NOW,
    );
    expect(t.survivability.status).toBe("not_applicable");
    expect(t.survivability.reason).toBe("harness timeout");
    expect(t.survivability.checks).toHaveLength(0);
  });
});

describe("survivabilitySchedule", () => {
  test("splits due / upcoming / not_applicable across executions", () => {
    const merged = computeTelemetry(rec(), { verdict: { verdict: "pass", rework: false } }, NOW);
    const failed = computeTelemetry(
      rec({ execution_id: "exec-bbbb2222", identifier: "ZOU-902", state: "failed", completed_at: null }),
      {},
      NOW,
    );
    const sched = survivabilitySchedule([merged, failed], NOW);

    expect(sched.due).toHaveLength(1);
    expect(sched.due[0]).toMatchObject({ execution_id: "exec-aaaa1111", window_days: 7, overdue: true });
    expect(sched.upcoming).toHaveLength(1);
    expect(sched.upcoming[0]).toMatchObject({ window_days: 30, overdue: false });
    expect(sched.not_applicable).toEqual([
      { execution_id: "exec-bbbb2222", identifier: "ZOU-902", reason: "failed_not_merged" },
    ]);
  });

  test("resolved (passed/failed) checks carry no outstanding work", () => {
    const t: ExecutionTelemetry = {
      ...computeTelemetry(rec(), {}, NOW),
      survivability: {
        status: "passed",
        reason: null,
        checks: [
          { window_days: 7, due_at: "2026-07-08T02:30:00.000Z", status: "passed", overdue: false },
          { window_days: 30, due_at: "2026-07-31T02:30:00.000Z", status: "passed", overdue: false },
        ],
      },
    };
    const sched = survivabilitySchedule([t], NOW);
    expect(sched.due).toHaveLength(0);
    expect(sched.upcoming).toHaveLength(0);
    expect(sched.not_applicable).toHaveLength(0);
  });
});

describe("summarizeTelemetry — yield/cost/intervention rollup", () => {
  test("rates and totals are null when nothing is measured/known (never fabricated zero)", () => {
    const unmeasured = computeTelemetry(rec({ state: "failed", completed_at: null }), {}, NOW);
    const s = summarizeTelemetry([unmeasured]);
    expect(s.total).toBe(1);
    expect(s.measured).toBe(0);
    expect(s.first_pass_rate).toBeNull();
    expect(s.cost_total_usd).toBeNull();
    expect(s.intervention_total_minutes).toBeNull();
    expect(s.cost_unknown).toBe(1);
    expect(s.intervention_unknown).toBe(1);
  });

  test("aggregates known signals and counts overdue survivability", () => {
    const a = computeTelemetry(rec(), { verdict: { verdict: "pass", rework: false }, model_cost_usd: 0.1 }, NOW);
    const b = computeTelemetry(
      rec({ execution_id: "exec-cccc3333", identifier: "ZOU-903" }),
      { verdict: { verdict: "fail", rework: true }, model_cost_usd: 0.25, operator_intervention_minutes: 8 },
      NOW,
    );
    const s = summarizeTelemetry([a, b]);
    expect(s.measured).toBe(2);
    expect(s.first_pass_count).toBe(1);
    expect(s.first_pass_rate).toBe(0.5);
    expect(s.rework_count).toBe(1);
    expect(s.cost_known).toBe(2);
    expect(s.cost_total_usd).toBe(0.35);
    expect(s.intervention_known).toBe(1);
    expect(s.intervention_total_minutes).toBe(8);
    // both merged execs have a 7-day check overdue at NOW.
    expect(s.survivability_overdue).toBe(2);
  });
});
