import { describe, expect, it } from "bun:test";
import {
  verifyTrace,
  extractClaimedPaths,
  renderTraceVerifyReport,
  type FsProbe,
  type TraceVerifyReport,
} from "../verification/trace-verify.js";
import type { TaskResult } from "../types.js";

/** Deterministic in-memory probe: a path "exists" iff it's a key; read returns its value or null. */
function makeProbe(files: Record<string, string>): FsProbe {
  return {
    exists: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p: string) =>
      Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null,
  };
}

/** Build a TaskResult with sensible defaults; override per-fixture. */
function result(partial: Partial<TaskResult> & { id: string; success: boolean }): TaskResult {
  const { id, success, ...rest } = partial;
  return {
    task: { id, persona: "p", task: "t", priority: "medium", expectedMutations: rest.task?.expectedMutations },
    success,
    output: rest.output ?? "did the thing",
    durationMs: 1,
    retries: 0,
    ...rest,
  } as TaskResult;
}

describe("verifyTrace — four check classes", () => {
  it("honest-success: mutation present, artifact non-empty, prose path real → 0 violations, passed", () => {
    const r = result({
      id: "honest",
      success: true,
      task: { id: "honest", persona: "p", task: "t", priority: "medium", expectedMutations: [{ file: "/a.ts", contains: "FOO" }] } as any,
      artifacts: ["/b.json"],
      output: "Done. wrote /a.ts and saved /b.json",
    });
    const probe = makeProbe({ "/a.ts": "export const x = 'FOO';", "/b.json": "{}" });
    const rep = verifyTrace([r], probe);
    expect(rep.violations).toHaveLength(0);
    expect(rep.passed).toBe(true);
    expect(rep.checkedResults).toBe(1);
    expect(rep.totalResults).toBe(1);
  });

  it("LYING-success: expectedMutation file missing → critical, not passed", () => {
    const r = result({
      id: "liar",
      success: true,
      task: { id: "liar", persona: "p", task: "t", priority: "medium", expectedMutations: [{ file: "/missing.ts", contains: "X" }] } as any,
    });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.critical).toBe(1);
    expect(rep.passed).toBe(false);
    expect(rep.violations[0].category).toBe("expected-mutation");
    expect(rep.violations[0].actual).toContain("missing");
  });

  it("LYING-success: expectedMutation file present but substring absent → critical", () => {
    const r = result({
      id: "partial",
      success: true,
      task: { id: "partial", persona: "p", task: "t", priority: "medium", expectedMutations: [{ file: "/a.ts", contains: "NEEDED" }] } as any,
    });
    const rep = verifyTrace([r], makeProbe({ "/a.ts": "something else entirely" }));
    expect(rep.summary.critical).toBe(1);
    expect(rep.passed).toBe(false);
    expect(rep.violations[0].actual).toContain("substring");
  });

  it("missing-artifact: claimed artifact absent → critical", () => {
    const r = result({ id: "art", success: true, artifacts: ["/gone.png"] });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.critical).toBe(1);
    expect(rep.violations[0].category).toBe("artifact");
  });

  it("empty-artifact: artifact exists but empty → critical", () => {
    const r = result({ id: "empty", success: true, artifacts: ["/blank.txt"] });
    const rep = verifyTrace([r], makeProbe({ "/blank.txt": "   \n  " }));
    expect(rep.summary.critical).toBe(1);
    expect(rep.violations[0].actual).toContain("empty");
  });

  it("child-record artifacts are checked too", () => {
    const r = result({
      id: "child",
      success: true,
      childRecords: [{ childId: "c1", parentTaskId: "child", executorId: "e", status: "success", artifacts: ["/child-out.json"] }],
    });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.critical).toBe(1);
    expect(rep.violations[0].category).toBe("artifact");
  });

  it("prose-claim of nonexistent file → info only, never critical, still passed", () => {
    const r = result({
      id: "prose",
      success: true,
      output: "All set — I created /home/workspace/ghost.md for you.",
    });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.info).toBe(1);
    expect(rep.summary.critical).toBe(0);
    expect(rep.passed).toBe(true);
    expect(rep.violations[0].category).toBe("prose-claim");
  });

  it("prose scan can be disabled via opts", () => {
    const r = result({ id: "prose2", success: true, output: "wrote /home/workspace/ghost.md" });
    const rep = verifyTrace([r], makeProbe({}), { proseScan: false });
    expect(rep.violations).toHaveLength(0);
  });

  it("consistency: success=true with error populated → warning", () => {
    const r = result({ id: "incon", success: true, error: "actually it broke", output: "ok" });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.warning).toBe(1);
    expect(rep.summary.critical).toBe(0);
    expect(rep.passed).toBe(true);
    expect(rep.violations[0].category).toBe("consistency");
  });

  it("consistency: success=true with empty output → warning", () => {
    const r = result({ id: "blank", success: true, output: "   " });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.warning).toBe(1);
    expect(rep.violations[0].actual).toContain("empty");
  });

  it("no-claims task: nothing to verify → 0 violations but counted as checked", () => {
    const r = result({ id: "noop", success: true, output: "analysis only, nothing written" });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.violations).toHaveLength(0);
    expect(rep.checkedResults).toBe(1);
  });

  it("declared FAILURE is skipped — a failure cannot be a lie", () => {
    const r = result({
      id: "failed",
      success: false,
      task: { id: "failed", persona: "p", task: "t", priority: "medium", expectedMutations: [{ file: "/missing.ts", contains: "X" }] } as any,
      error: "timed out",
    });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.violations).toHaveLength(0);
    expect(rep.checkedResults).toBe(0);
    expect(rep.totalResults).toBe(1);
  });
});

describe("verifyTrace — severity roll-up + summary", () => {
  it("passed iff zero critical (warnings/info do not fail)", () => {
    const warnOnly = result({ id: "w", success: true, error: "x", output: "ok" });
    const infoOnly = result({ id: "i", success: true, output: "created /nope/x.md" });
    const rep = verifyTrace([warnOnly, infoOnly], makeProbe({}));
    expect(rep.summary.critical).toBe(0);
    expect(rep.passed).toBe(true);
  });

  it("a single critical flips passed to false across a mixed batch", () => {
    const ok = result({ id: "ok", success: true, output: "fine" });
    const bad = result({ id: "bad", success: true, artifacts: ["/missing"] });
    const rep = verifyTrace([ok, bad], makeProbe({}));
    expect(rep.passed).toBe(false);
    expect(rep.summary.critical).toBe(1);
  });

  it("byCategory tallies each class", () => {
    const r = result({
      id: "multi",
      success: true,
      task: { id: "multi", persona: "p", task: "t", priority: "medium", expectedMutations: [{ file: "/m", contains: "Z" }] } as any,
      artifacts: ["/a"],
      error: "warn",
      output: "wrote /prose/x.md",
    });
    const rep = verifyTrace([r], makeProbe({}));
    expect(rep.summary.byCategory["expected-mutation"]).toBe(1);
    expect(rep.summary.byCategory["artifact"]).toBe(1);
    expect(rep.summary.byCategory["consistency"]).toBe(1);
    expect(rep.summary.byCategory["prose-claim"]).toBe(1);
  });
});

describe("extractClaimedPaths — conservative, absolute-only", () => {
  it("extracts absolute paths after write/create verbs", () => {
    expect(extractClaimedPaths("wrote /home/workspace/a.md and created /tmp/b.json")).toEqual([
      "/home/workspace/a.md",
      "/tmp/b.json",
    ]);
  });

  it("ignores relative paths and verbless paths", () => {
    expect(extractClaimedPaths("created foo/bar.txt")).toEqual([]);
    expect(extractClaimedPaths("the file /etc/passwd is here")).toEqual([]);
  });

  it("ignores verbs with no path within the window", () => {
    expect(extractClaimedPaths("created a comprehensive plan for the migration")).toEqual([]);
  });

  it("strips trailing punctuation", () => {
    expect(extractClaimedPaths("saved to /x/y.txt.")).toEqual(["/x/y.txt"]);
  });
});

describe("renderTraceVerifyReport", () => {
  it("renders PASS with no violations", () => {
    const rep: TraceVerifyReport = verifyTrace([result({ id: "ok", success: true, output: "fine" })], makeProbe({}));
    const out = renderTraceVerifyReport(rep);
    expect(out).toContain("✅ PASS");
    expect(out).toContain("No trace-verify violations");
  });

  it("renders FAIL with a per-task violation block", () => {
    const rep = verifyTrace([result({ id: "bad", success: true, artifacts: ["/missing"] })], makeProbe({}));
    const out = renderTraceVerifyReport(rep);
    expect(out).toContain("❌ FAIL");
    expect(out).toContain('Task "bad"');
    expect(out).toContain("remediation".length > 0 ? "→" : "→");
  });
});
