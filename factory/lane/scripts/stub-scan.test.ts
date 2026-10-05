import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ADVISORY_RUNS,
  defaultStubScanOutcome,
  parseUnifiedDiff,
  resolveScanMode,
  scanDiffForStubs,
  type StubDetector,
} from "./stub-scan";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "stub-scan-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Build a unified diff for a single new file from its added lines. */
function newFileDiff(path: string, lines: string[]): string {
  const body = lines.map((l) => "+" + l).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    "",
  ].join("\n");
}

/** Build a diff whose hunk mixes context and added lines. */
function mixedDiff(path: string, start: number, rows: Array<[" " | "+", string]>): string {
  const added = rows.filter(([p]) => p === "+").length;
  const contextAndAdded = rows.length;
  const body = rows.map(([p, l]) => p + l).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${contextAndAdded - added} +${start},${contextAndAdded} @@`,
    body,
    "",
  ].join("\n");
}

function detectors(diff: string): StubDetector[] {
  return scanDiffForStubs(diff).findings.map((f) => f.detector).sort();
}

describe("stub-scan — detectors", () => {
  test("stub-body: TS function whose only statement is bare return", () => {
    const diff = newFileDiff("src/foo.ts", ["export function foo() {", "  return;", "}"]);
    const r = scanDiffForStubs(diff);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.detector).toBe("stub-body");
    expect(r.findings[0]!.file).toBe("src/foo.ts");
    expect(r.findings[0]!.line).toBe(1);
  });

  test("stub-body: TS arrow with a bare `return`", () => {
    const diff = newFileDiff("src/a.ts", ["export const run = () => {", "  return;", "};"]);
    expect(detectors(diff)).toEqual(["stub-body"]);
  });

  test("stub-body: Python def with only `pass`", () => {
    const diff = newFileDiff("svc/x.py", ["def handler(req):", "    pass"]);
    expect(detectors(diff)).toEqual(["stub-body"]);
  });

  test("stub-body: Python def with only `...`", () => {
    const diff = newFileDiff("svc/y.py", ["def handler(req):", "    ..."]);
    expect(detectors(diff)).toEqual(["stub-body"]);
  });

  test("not-implemented: throw new Error(\"not implemented\")", () => {
    const diff = newFileDiff("src/b.ts", ["export function b() {", "  throw new Error(\"not implemented\");", "}"]);
    expect(scanDiffForStubs(diff).findings.some((f) => f.detector === "not-implemented")).toBe(true);
  });

  test("not-implemented: raise NotImplementedError", () => {
    const diff = newFileDiff("svc/z.py", ["def z():", "    raise NotImplementedError"]);
    expect(scanDiffForStubs(diff).findings.some((f) => f.detector === "not-implemented")).toBe(true);
  });

  test("stub-marker: TODO: implement", () => {
    const diff = newFileDiff("src/c.ts", ["export function c() {", "  // TODO: implement", "  doWork();", "}"]);
    expect(detectors(diff)).toEqual(["stub-marker"]);
  });

  test("stub-marker: STUB comment", () => {
    const diff = newFileDiff("src/d.ts", ["// STUB: fill this in later", "export const d = 1;"]);
    expect(detectors(diff)).toEqual(["stub-marker"]);
  });

  test("stub-marker: critical FIXME (plain FIXME is not flagged)", () => {
    const critical = newFileDiff("src/e.ts", ["// FIXME critical: broken auth", "export const e = 1;"]);
    expect(detectors(critical)).toEqual(["stub-marker"]);
    const plain = newFileDiff("src/e2.ts", ["// FIXME: tidy this later", "export const e = 1;"]);
    expect(scanDiffForStubs(plain).ok).toBe(true);
  });

  test("empty-catch: TS empty catch block", () => {
    const diff = newFileDiff("src/f.ts", ["export function f() {", "  try { risky(); } catch (e) {}", "}"]);
    expect(scanDiffForStubs(diff).findings.some((f) => f.detector === "empty-catch")).toBe(true);
  });

  test("empty-catch: Python except: pass", () => {
    const diff = newFileDiff("svc/g.py", ["try:", "    risky()", "except Exception:", "    pass"]);
    expect(scanDiffForStubs(diff).findings.some((f) => f.detector === "empty-catch")).toBe(true);
  });

  test("skipped-test: it.skip / describe.skip / xit / pytest.mark.skip", () => {
    for (const line of ["  it.skip(\"x\", () => {});", "  describe.skip(\"y\", () => {});", "  xit(\"z\", () => {});", "@pytest.mark.skip"]) {
      const diff = newFileDiff("src/h.test.ts", [line]);
      expect(scanDiffForStubs(diff).findings.some((f) => f.detector === "skipped-test")).toBe(true);
    }
  });
});

describe("stub-scan — allowlist (no false positives)", () => {
  test("abstract method with no body is not flagged", () => {
    const diff = newFileDiff("src/base.ts", ["export abstract class Base {", "  abstract handle(x: number): void;", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("interface declaration is not flagged", () => {
    const diff = newFileDiff("src/i.ts", ["export interface Store {", "  get(key: string): string;", "  set(key: string, value: string): void;", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test(".d.ts declaration files are skipped entirely", () => {
    const diff = newFileDiff("types/globals.d.ts", ["export declare function f(): void;", "export function g() {", "  return;", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("generated files (path) are skipped", () => {
    const diff = newFileDiff("dist/bundle.js", ["function x() {", "  return;", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("generated files (banner) are skipped", () => {
    const diff = newFileDiff("src/schema.ts", ["// @generated by codegen — DO NOT EDIT", "export function f() {", "  return;", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("a real function body is not flagged", () => {
    const diff = newFileDiff("src/add.ts", ["export function add(a: number, b: number) {", "  return a + b;", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("an empty constructor / no-op body is not flagged", () => {
    const diff = newFileDiff("src/ctor.ts", ["export class C {", "  constructor() {}", "}"]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("a control block (if/for) with a bare return is not misread as a stub body", () => {
    const diff = newFileDiff("src/ctl.ts", [
      "export function pick(xs: number[]) {",
      "  for (const x of xs) {",
      "    if (x > 0) {",
      "      return;",
      "    }",
      "  }",
      "  return xs.length;",
      "}",
    ]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });
});

describe("stub-scan — diff scoping", () => {
  test("only added lines count: a pre-existing stub shown as context is not flagged", () => {
    const diff = mixedDiff("src/ctx.ts", 10, [
      [" ", "export function old() {"],
      [" ", "  return;"],
      [" ", "}"],
      ["+", "export const added = 1;"],
    ]);
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("a stub introduced among context is flagged with the right new-file line", () => {
    const diff = mixedDiff("src/ctx2.ts", 10, [
      [" ", "const header = 1;"],
      ["+", "export function fresh() {"],
      ["+", "  return;"],
      ["+", "}"],
    ]);
    const r = scanDiffForStubs(diff);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.detector).toBe("stub-body");
    expect(r.findings[0]!.line).toBe(11);
  });

  test("deletions (+++ /dev/null) produce no findings", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-export function gone() {",
      "-  return;",
      "-}",
      "",
    ].join("\n");
    expect(scanDiffForStubs(diff).ok).toBe(true);
  });

  test("reason string carries file:line and detector for the retry brief", () => {
    const diff = newFileDiff("src/r.ts", ["export function r() {", "  return;", "}"]);
    const r = scanDiffForStubs(diff);
    expect(r.reason).toContain("src/r.ts:1");
    expect(r.reason).toContain("stub-body");
  });

  test("findings are deterministically ordered by file, line, detector", () => {
    const diff = newFileDiff("src/multi.ts", [
      "export function b() {",
      "  throw new Error(\"not implemented\");",
      "}",
      "export function a() {",
      "  return;",
      "}",
    ]);
    const lines = scanDiffForStubs(diff).findings.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((x, y) => x - y));
  });
});

describe("stub-scan — parseUnifiedDiff", () => {
  test("reconstructs new-side line numbers across context and additions", () => {
    const diff = mixedDiff("src/p.ts", 5, [
      [" ", "a"],
      ["+", "b"],
      [" ", "c"],
    ]);
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const flat = files[0]!.hunks.flat();
    expect(flat.map((l) => [l.lineNo, l.text, l.added])).toEqual([
      [5, "a", false],
      [6, "b", true],
      [7, "c", false],
    ]);
  });
});

describe("stub-scan — mode resolution", () => {
  test("env override wins in every direction", () => {
    expect(resolveScanMode({ env: "off", runCount: 999 })).toBe("off");
    expect(resolveScanMode({ env: "advisory", runCount: 999 })).toBe("advisory");
    expect(resolveScanMode({ env: "enforce", runCount: 0 })).toBe("enforce");
    expect(resolveScanMode({ env: "1", runCount: 0 })).toBe("enforce");
    expect(resolveScanMode({ env: "0", runCount: 0 })).toBe("off");
  });

  test("advisory-first: below threshold advisory, at/above threshold enforce", () => {
    expect(resolveScanMode({ runCount: 0 })).toBe("advisory");
    expect(resolveScanMode({ runCount: DEFAULT_ADVISORY_RUNS - 1 })).toBe("advisory");
    expect(resolveScanMode({ runCount: DEFAULT_ADVISORY_RUNS })).toBe("enforce");
    expect(resolveScanMode({ runCount: 2, advisoryRuns: 2 })).toBe("enforce");
  });
});

describe("stub-scan — default outcome producer", () => {
  const stubDiff = newFileDiff("src/o.ts", ["export function o() {", "  return;", "}"]);

  test("off mode: byte-identical no-op — no findings surfaced, counter untouched", () => {
    const dir = scratch();
    const outcome = defaultStubScanOutcome(stubDiff, { stateDir: dir, env: { SF_STUB_SCAN: "off" } });
    expect(outcome.mode).toBe("off");
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.findings).toHaveLength(0);
    expect(() => readFileSync(join(dir, "stub-scan-runs.json"), "utf8")).toThrow();
  });

  test("advisory mode: findings surfaced and the run counter advances", () => {
    const dir = scratch();
    const first = defaultStubScanOutcome(stubDiff, { stateDir: dir, env: { SF_STUB_SCAN: "advisory" } });
    expect(first.mode).toBe("advisory");
    expect(first.result.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "stub-scan-runs.json"), "utf8")).count).toBe(1);
    defaultStubScanOutcome(stubDiff, { stateDir: dir, env: { SF_STUB_SCAN: "advisory" } });
    expect(JSON.parse(readFileSync(join(dir, "stub-scan-runs.json"), "utf8")).count).toBe(2);
  });

  test("enforce mode: findings surfaced and rejected", () => {
    const dir = scratch();
    const outcome = defaultStubScanOutcome(stubDiff, { stateDir: dir, env: { SF_STUB_SCAN: "enforce" } });
    expect(outcome.mode).toBe("enforce");
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.reason).toContain("stub-body");
  });

  test("counter drives auto-enforce once the advisory window closes", () => {
    const dir = scratch();
    const env = { SF_STUB_SCAN_ADVISORY_RUNS: "2" };
    expect(defaultStubScanOutcome(stubDiff, { stateDir: dir, env }).mode).toBe("advisory"); // count 0 -> 1
    expect(defaultStubScanOutcome(stubDiff, { stateDir: dir, env }).mode).toBe("advisory"); // count 1 -> 2
    expect(defaultStubScanOutcome(stubDiff, { stateDir: dir, env }).mode).toBe("enforce");  // count 2 -> enforce
  });
});
