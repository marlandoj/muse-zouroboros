import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunTestFailureDetail, hermeticSmokeProbeEnv, spawnFailureDetail } from "./smoke-diagnostics";

describe("Bun smoke diagnostics", () => {
  test("keeps the actionable filesystem error instead of the timing summary", () => {
    const detail = bunTestFailureDetail(1, "bun test v1.2.21", [
      "ENOENT: no such file or directory, open '/tmp/audit.jsonl'",
      "(fail) factory plan gate > records shadow evidence",
      "Ran 5 tests across 1 file. [44.00ms]",
    ].join("\n"));
    expect(detail).toContain("ENOENT");
    expect(detail).not.toContain("Ran 5 tests");
  });

  test("reports the failed assertion from stdout over an informational stderr line", () => {
    const out = [
      "  \u2713 persisting breach = SILENT (no re-notify)",
      "  \u2717 review clears the blocker with one recovery notification \u2014 SILENT",
      "  \u2717 metric recovery emits its own status-change notification \u2014 MILESTONE",
      "SLO self-test: 82/84 passed",
    ].join("\n");
    const err = "factory-slo: mutation evidence would reject (cycle_id requires exactly one unmatched open row; found opens=1, outcomes=1)";
    const detail = bunTestFailureDetail(1, out, err);
    expect(detail).toContain("review clears the blocker");
    expect(detail).not.toContain("mutation evidence would reject");
  });

  test("keeps module resolution failures", () => {
    const detail = bunTestFailureDetail(1, "", [
      "error: Cannot find module 'zouroboros-workflow/plan-gate'",
      "(fail) shadow mode appends an auditable record",
      "Ran 6 tests across 1 file. [100.00ms]",
    ].join("\n"));
    expect(detail).toContain("Cannot find module");
  });

  test("falls back to the failed test name", () => {
    const detail = bunTestFailureDetail(1, "", [
      "(fail) factory plan gate > rejects invalid evidence",
      "Ran 1 test across 1 file. [10.00ms]",
    ].join("\n"));
    expect(detail).toBe("(fail) factory plan gate > rejects invalid evidence");
  });

  test("never reports a passing selftest check as the failure reason", () => {
    const detail = bunTestFailureDetail(1, [
      "[9] cascade recovery",
      "  ✅ timeout → stale + retry + redispatch same cycle",
      "  ✅ attempt 2 fails over to rung 2",
      "[pool-worker] MOCK dispatch asg-c-stall-T1-a2 (Haiku 4.5, attempt 2) — no /zo/ask call",
      "  ❌ recovered stage re-dispatches exactly once",
    ].join("\n"), "");
    expect(detail).toBe("❌ recovered stage re-dispatches exactly once");
    expect(detail).not.toContain("✅");
  });

  test("keeps a real actionable error ahead of the failing check line", () => {
    const detail = bunTestFailureDetail(1, [
      "  ✅ timeout → stale + retry + redispatch same cycle",
      "  ❌ recovered stage re-dispatches exactly once",
    ].join("\n"), "error: ENOSPC: no space left on device");
    expect(detail).toContain("ENOSPC");
    expect(detail).not.toContain("✅");
  });

  test("reports the exit code when the runner emitted nothing", () => {
    expect(bunTestFailureDetail(1, "", "")).toBe("exit 1");
  });

  test("prioritizes a subprocess timeout over captured stdout", () => {
    const error = Object.assign(new Error("spawnSync bun ETIMEDOUT"), { code: "ETIMEDOUT" });
    const detail = bunTestFailureDetail(1, [
      "[pool-worker] MOCK dispatch asg-c-stall-T1-a1",
      "last misleading child line",
    ].join("\n"), "", { error, signal: "SIGTERM", timeoutMs: 60_000 });
    expect(detail).toBe("subprocess timed out after 60000 ms; signal SIGTERM");
    expect(detail).not.toContain("misleading child line");
  });

  test("reports a non-timeout spawn error", () => {
    const error = Object.assign(new Error("spawnSync missing-bun ENOENT"), { code: "ENOENT" });
    expect(spawnFailureDetail({ error })).toBe(
      "subprocess spawn error ENOENT: spawnSync missing-bun ENOENT",
    );
  });

  test("reports termination signals when no spawn error is present", () => {
    expect(spawnFailureDetail({ signal: "SIGKILL" })).toBe("subprocess terminated by signal SIGKILL");
  });

  test("isolates hermetic child probes from the production state namespace", () => {
    const env = hermeticSmokeProbeEnv("/tmp/factory-smoke-state", {
      FACTORY_STATE_DIR: "/home/workspace/.runtime/factory-state/v1",
      FACTORY_STATE_MODE: "production",
      FACTORY_CODING_CASCADE: "enforce",
      PATH: "/root/.bun/bin:/usr/bin",
    });
    expect(env.FACTORY_STATE_DIR).toBe("/tmp/factory-smoke-state");
    expect(env.FACTORY_STATE_MODE).toBe("test");
    expect(env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT).toBe("1");
    expect(env.FACTORY_CODING_CASCADE).toBe("off");
    expect(env.PATH).toBe("/root/.bun/bin:/usr/bin");
  });

  test("strips the runtime-config flag namespace the conveyor exports", () => {
    const env = hermeticSmokeProbeEnv("/tmp/factory-smoke-state", {
      FACTORY_PERSONA_ROUTING_MODE: "shadow",
      FACTORY_REVIEW_GATE_MODE: "enforce",
      SF003_POOL_MODE: "act",
      SF_PRESPEC: "1",
      PLAN_GATE_MODE: "shadow",
      OUTCOME_EVIDENCE_MODE: "shadow",
      ZOUROBOROS_PLAN_GATE_MODULE: "/some/module.ts",
      SF999_FUTURE_FLAG: "1",
      HOME: "/root",
    });
    for (const leaked of [
      "FACTORY_PERSONA_ROUTING_MODE",
      "FACTORY_REVIEW_GATE_MODE",
      "SF003_POOL_MODE",
      "SF_PRESPEC",
      "PLAN_GATE_MODE",
      "OUTCOME_EVIDENCE_MODE",
      "ZOUROBOROS_PLAN_GATE_MODULE",
      "SF999_FUTURE_FLAG",
    ]) {
      expect(env[leaked]).toBeUndefined();
    }
    expect(env.HOME).toBe("/root");
  });
});

describe("conveyor smoke gate failure attribution", () => {
  // These two probes run assertion-style self-tests that print results to stdout.
  // Reporting stderr's last line surfaced an informational message from a *passing*
  // check as the abort reason, sending an operator after a fixture bug that did not
  // exist. They must route through the shared extractor, which prefers real failures.
  const src = readFileSync(join(import.meta.dir, "conveyor-smoke-test.ts"), "utf-8");

  for (const probe of ["SLO mutation evidence selftest", "lane mutation evidence selftest"]) {
    test(`${probe} reports via the shared detail extractor`, () => {
      const line = src.split("\n").find((l) => l.includes(probe));
      expect(line).toBeDefined();
      expect(line).toContain("detail");
      expect(line).not.toContain("slice(-1)");
    });
  }
});
