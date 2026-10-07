import { describe, expect, test } from "bun:test";
import { isArbiterApplicable, runArbiter } from "./diversity-arbiter";

describe("diversity arbiter unified diff input", () => {
  test("skips whole-file syntax parsing while checking added lines", async () => {
    const diff = [
      "diff --git a/source.ts b/source.ts",
      "--- a/source.ts",
      "+++ b/source.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const verdict = await runArbiter(diff, "correctness,security");
    expect(verdict.pass).toBe(true);
    expect(verdict.arbiter_checks.find((check) => check.name === "syntax")?.status).toBe("skip");
  });
});

describe("diversity arbiter applicability", () => {
  test("skips prose-only design judgments without parsing them as TSX", async () => {
    const prose = "The palette has 31 rendered colors inside its documented theme exception.";
    const verdict = await runArbiter(prose, "brand-compliance,wcag,design-spec");

    expect(verdict.pass).toBe(true);
    expect(verdict.confidence).toBe(0);
    expect(verdict.issues).toEqual([]);
    expect(verdict.arbiter_checks).toEqual([
      expect.objectContaining({ name: "applicability", status: "skip" }),
    ]);
    expect(isArbiterApplicable("brand-compliance,wcag,design-spec")).toBe(false);
  });

  test("still rejects malformed TSX under code criteria", async () => {
    const verdict = await runArbiter("export const View = () => <div>;", "correctness,typescript");

    expect(verdict.pass).toBe(false);
    expect(verdict.issues.some((issue) => issue.startsWith("Syntax error:"))).toBe(true);
    expect(verdict.arbiter_checks.find((check) => check.name === "syntax")?.status).toBe("fail");
    expect(isArbiterApplicable("correctness,typescript")).toBe(true);
  });
});
