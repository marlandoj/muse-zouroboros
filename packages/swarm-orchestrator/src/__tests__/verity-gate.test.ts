/**
 * Verity×Swarm 2b — unit tests for the gate's pure pieces: mode resolution
 * (env > campaign > policy > shadow; shared-workspace downgrade), the trusted
 * check spec, the operator policy file, the attempt summary (provenance
 * only with Fix B verdict attribution), and preflight contamination checks.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadOperatorPolicy,
  locateVerityCli,
  parseVerityMode,
  resolveVerifySpec,
  resolveVerityMode,
  summarizeVerdict,
  verifyFeedbackBlock,
  workspaceSelfOutputs,
  type OperatorPolicy,
} from "../verification/verity-gate.js";

const absentPolicy: OperatorPolicy = {
  path: "/nonexistent/verity-swarm.json",
  exists: false,
  rootOwned: false,
  mode: null,
  enabled: true,
  requireCheck: null,
  checkTimeoutS: null,
  raw: null,
  error: null,
};
const policyWith = (p: Partial<OperatorPolicy>): OperatorPolicy => ({
  ...absentPolicy,
  exists: true,
  rootOwned: true,
  ...p,
});

describe("mode resolution (Q5)", () => {
  test("default is shadow when nothing is configured", () => {
    expect(resolveVerityMode({ env: {}, policy: absentPolicy })).toMatchObject({
      mode: "shadow",
      source: "default",
      override: null,
    });
  });
  test("operator policy mode applies; its kill switch (enabled:false) turns the gate off", () => {
    expect(resolveVerityMode({ env: {}, policy: policyWith({ mode: "live" }) })).toMatchObject({
      mode: "live",
      source: "policy",
    });
    expect(resolveVerityMode({ env: {}, policy: policyWith({ mode: "live", enabled: false }) })).toMatchObject({
      mode: "off",
      source: "policy_kill_switch",
    });
  });
  test("the dispatcher's campaign override beats the policy; SWARM_VERITY env beats everything", () => {
    expect(
      resolveVerityMode({ env: {}, policy: policyWith({ mode: "live" }), campaignOverride: "shadow" })
    ).toMatchObject({ mode: "shadow", source: "campaign", override: "shadow", policyMode: "live" });
    expect(
      resolveVerityMode({ env: { SWARM_VERITY: "off" }, policy: policyWith({ mode: "live" }), campaignOverride: "live" })
    ).toMatchObject({ mode: "off", source: "env", override: "live" });
    expect(resolveVerityMode({ env: { SWARM_VERITY: "bogus" }, policy: absentPolicy })).toMatchObject({
      mode: "shadow",
      source: "default",
    });
  });
  test("live is downgraded to shadow for a shared-workspace concurrent campaign (recorded)", () => {
    expect(
      resolveVerityMode({ env: { SWARM_VERITY: "live" }, policy: absentPolicy, concurrency: 2 })
    ).toMatchObject({ mode: "shadow", source: "env", requestedMode: "live", downgraded: "shared_workspace" });
    expect(
      resolveVerityMode({ env: { SWARM_VERITY: "live" }, policy: absentPolicy, concurrency: 1 })
    ).toMatchObject({ mode: "live" });
    expect(resolveVerityMode({ env: { SWARM_VERITY: "shadow" }, policy: absentPolicy, concurrency: 4 }).downgraded).toBeUndefined();
  });
  test("parseVerityMode accepts the documented spellings only", () => {
    expect(["off", "shadow", "live", "0", "false", "enforce", "on", "LIVE", "nope", ""].map(parseVerityMode)).toEqual([
      "off",
      "shadow",
      "live",
      "off",
      "off",
      "live",
      "live",
      "live",
      null,
      null,
    ]);
  });
});

describe("operator policy file", () => {
  test("absent file → defaults; a readable file yields mode, kill switch, requireCheck and the check timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-policy-"));
    expect(loadOperatorPolicy(join(dir, "none.json"))).toMatchObject({
      exists: false,
      mode: null,
      enabled: true,
      requireCheck: null,
    });
    const p = join(dir, "verity-swarm.json");
    writeFileSync(
      p,
      JSON.stringify({
        mode: "live",
        enabled: true,
        requireCheck: false,
        checkTimeoutS: 120,
        repos: { "github.com/o/r": { check: "bun test" } },
      })
    );
    const pol = loadOperatorPolicy(p);
    expect(pol).toMatchObject({ exists: true, mode: "live", enabled: true, requireCheck: false, checkTimeoutS: 120 });
    expect(pol.rootOwned).toBe(process.getuid?.() === 0);
    writeFileSync(p, "not json");
    expect(loadOperatorPolicy(p).error).toBeTruthy();
  });
  test("the CLI location is the canonical workshop copy under the orchestrator home unless SWARM_VERITY_CLI overrides it", () => {
    expect(locateVerityCli("/opt/zouroboros/workshop/repo", {})).toBe(
      "/opt/zouroboros/workshop/repo/packages/verity/engine/cli.js"
    );
    expect(locateVerityCli("/x", { SWARM_VERITY_CLI: "/elsewhere/cli.js" })).toBe("/elsewhere/cli.js");
  });
});

describe("trusted check spec (task.verify)", () => {
  test("string command, object spec, and the explicit waiver", () => {
    expect(resolveVerifySpec("bun test")).toEqual({ kind: "command", spec: { command: "bun test" } });
    expect(resolveVerifySpec(" none ")).toEqual({ kind: "waived" });
    expect(
      resolveVerifySpec({
        command: "npm test",
        cwd: "repo",
        timeoutS: 300,
        allowTestDeletion: true,
        allowCheckEdits: false,
      })
    ).toEqual({
      kind: "command",
      spec: { command: "npm test", cwd: "repo", timeoutS: 300, allowTestDeletion: true },
    });
    expect(resolveVerifySpec({ command: "none" })).toEqual({ kind: "waived" });
    expect(resolveVerifySpec({ waived: true })).toEqual({ kind: "waived" });
    expect([
      resolveVerifySpec(undefined),
      resolveVerifySpec(null),
      resolveVerifySpec(""),
      resolveVerifySpec({}),
      resolveVerifySpec(42),
    ]).toEqual([null, null, null, null, null]);
  });
});

describe("provenance-only summaries and prompt feedback", () => {
  test("summarizeVerdict keeps rules, paths, labels and the check record; never fingerprints' values, output or contents", () => {
    const v = {
      decision: "fail",
      exitCode: 1,
      changes: { code: ["src/a.ts", "src/b.ts"] },
      findings: [
        { rule: "secret", path: "src/cfg.ts", label: "a GitHub token", fingerprint: "abcdefabcdefabcd" },
        { rule: "no_passing_check", detail: "exit 1" },
      ],
      check: {
        command: "bun test",
        source: "task",
        exitCode: 1,
        durationMs: 1234,
        timedOut: false,
        outputSha256: "x".repeat(64),
        outputBytes: 99,
        hollow: false,
      },
      message: "Verity: ...",
    };
    const s = summarizeVerdict(v, "live", true, 2000);
    expect(s).toEqual({
      decision: "fail",
      applied: true,
      mode: "live",
      exitCode: 1,
      codeChanged: 2,
      findings: [{ rule: "secret", path: "src/cfg.ts", label: "a GitHub token" }, { rule: "no_passing_check" }],
      check: { command: "bun test", source: "task", exitCode: 1, durationMs: 1234, timedOut: false, hollow: false },
      durationMs: 2000,
    });
    expect(JSON.stringify(s)).not.toContain("fingerprint");
    expect(summarizeVerdict({ decision: "weird" }, "shadow", false, 1).decision).toBe("error");

    // Verdict attribution: all findings outside diff summarize as contamination
    const contamVerdict = {
      decision: "fail",
      allOutsideDiff: true,
      verdictClass: "contamination",
      findings: [{ rule: "secret", path: "scratch/debris.txt", label: "a token", inDiff: false }],
    };
    const cs = summarizeVerdict(contamVerdict, "live", true, 100);
    expect(cs.allOutsideDiff).toBe(true);
    expect(cs.verdictClass).toBe("contamination");
    expect(cs.findings[0].inDiff).toBe(false);
  });
  test("the feedback block names resume vs reroute and carries the Verity message", () => {
    const resume = verifyFeedbackBlock("Verity: src/a.ts changed, but no check has passed.", 1, "codex", true);
    expect(resume).toContain("<verity-gate-feedback>");
    expect(resume).toContain("RESUME of attempt 1 on the same executor (codex)");
    expect(resume).toContain("Verity: src/a.ts changed");
    const reroute = verifyFeedbackBlock("Verity: x", 2, "codex", false);
    expect(reroute).toContain("Attempt 2 (codex) declared success but its workspace did not pass");
    expect(reroute).not.toContain("RESUME");
  });
  test("workspaceSelfOutputs keeps only paths under the workspace", () => {
    expect(workspaceSelfOutputs(["/ws/run.log", "/elsewhere/orch.log", "/ws", "/wsx/run.log"], "/ws")).toEqual([
      "/ws/run.log",
      "/ws",
    ]);
  });
});
