import { describe, expect, test } from "bun:test";
import { HANDOFF_OBLIGATIONS, evaluateHandoff, formatHandoff, type HandoffEvidence } from "./handoff-contract";

const NOW = "2026-07-26T18:00:00.000Z";

/** The ZouroBench Results Explorer handoff, as it actually ended up. */
const ZBRE: HandoffEvidence = {
  deployment_commit: "7bc6f66c",
  service_health: { ok: true, detail: "status ok; 22 valid runs, 17 baselines" },
  production_smoke: { ok: true, detail: "17/17 boundary checks" },
  operator_runbook: "Projects/zourobench-2026/docs/explorer-runbook.md",
  dashboard: "private Zouroboros dashboard",
  access_mode: "private",
  named_consumer: "Zouroboros dashboard Operations view",
};

function statusOf(evidence: HandoffEvidence, obligation: string) {
  return evaluateHandoff("ZBRE", evidence, NOW).results.find((item) => item.obligation === obligation)!;
}

describe("handoff contract (FH-14)", () => {
  test("the completed ZBRE handoff satisfies every obligation", () => {
    const verdict = evaluateHandoff("ZBRE", ZBRE, NOW);
    expect(verdict.ok).toBe(true);
    expect(verdict.satisfied).toBe(HANDOFF_OBLIGATIONS.length);
    expect(verdict.blocking_summary).toBeNull();
  });

  test("an empty handoff proves nothing rather than passing quietly", () => {
    const verdict = evaluateHandoff("ZBRE", {}, NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.satisfied).toBe(0);
    expect(verdict.results.every((item) => item.status === "unproven")).toBe(true);
  });

  test("a merged PR alone does not complete a handoff", () => {
    // The failure mode this closes: the last PR merges and the conveyor calls
    // the project done.
    const verdict = evaluateHandoff("ZBRE", { deployment_commit: "7bc6f66c" }, NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.blocking_summary).toContain("6 of 7");
  });

  test("an unprobed service is unproven, not healthy — a deploy exit code is not health", () => {
    expect(statusOf({ ...ZBRE, service_health: null }, "service_health")).toMatchObject({
      status: "unproven",
    });
  });

  test("a failing probe is distinguished from a missing one", () => {
    expect(statusOf({ ...ZBRE, service_health: { ok: false, detail: "502" } }, "service_health").status)
      .toBe("failed");
  });

  test("catches the ZOU-415 mistake — everything passes but nothing consumes it", () => {
    // The Hetzner box passed echo, sandbox, docker, 69/69 selftest and 17/17
    // smoke, was fully wired into .mcp.json, and was culled the same day.
    const verdict = evaluateHandoff("annex", { ...ZBRE, named_consumer: null }, NOW);
    expect(verdict.ok).toBe(false);
    expect(statusOf({ ...ZBRE, named_consumer: null }, "named_consumer").detail)
      .toContain("provisioning may be premature");
  });

  test("rejects availability language dressed up as a consumer", () => {
    for (const claim of ["available for use", "ready for consumers", "anyone on the team", "TBD", "n/a"]) {
      expect(statusOf({ ...ZBRE, named_consumer: claim }, "named_consumer").status).toBe("failed");
    }
  });

  test("accepts a concretely named consumer", () => {
    expect(statusOf({ ...ZBRE, named_consumer: "svc_IV57FTzyaWY explorer Operations view" }, "named_consumer").status)
      .toBe("satisfied");
  });

  test("validates the deployment commit is a sha, not prose", () => {
    expect(statusOf({ ...ZBRE, deployment_commit: "latest main" }, "deployment_commit").status).toBe("failed");
    expect(statusOf({ ...ZBRE, deployment_commit: "7bc6f66c" }, "deployment_commit").status).toBe("satisfied");
  });

  test("requires a recognized access mode rather than an assumed one", () => {
    expect(statusOf({ ...ZBRE, access_mode: null }, "access_mode").status).toBe("unproven");
    expect(statusOf({ ...ZBRE, access_mode: "sort of private" }, "access_mode").status).toBe("failed");
    for (const mode of ["public", "private", "internal", "PRIVATE"]) {
      expect(statusOf({ ...ZBRE, access_mode: mode }, "access_mode").status).toBe("satisfied");
    }
  });

  test("a missing runbook blocks — nobody knows how to recover it", () => {
    expect(statusOf({ ...ZBRE, operator_runbook: "  " }, "operator_runbook")).toMatchObject({
      status: "unproven",
    });
  });

  test("an undiscoverable deployment blocks", () => {
    expect(statusOf({ ...ZBRE, dashboard: null }, "dashboard").status).toBe("unproven");
  });

  test("the report names each unmet obligation for an operator", () => {
    const text = formatHandoff(evaluateHandoff("ZBRE", { ...ZBRE, named_consumer: null, dashboard: null }, NOW));
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("named_consumer");
    expect(text).toContain("dashboard");
    expect(text).toContain("5/7");
  });
});
