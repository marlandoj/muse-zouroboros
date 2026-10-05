import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeDredge,
  normalizeStubScanOutcome,
  redactAndBoundExcerpt,
  runDredgeCli,
  type StubScanOutcome,
  writeDredgeReport,
} from "./dredge";

const temporaryDirectories: string[] = [];
const fixedNow = "2026-08-10T20:00:00.000Z";

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "dredge-test-"));
  temporaryDirectories.push(path);
  return path;
}

function analyze(record: Record<string, unknown>, logText: string | null = null) {
  return analyzeDredge({
    executionRecordText: JSON.stringify(record, null, 2),
    executionRecordPath: "/state/exec-test.json",
    logText,
    logPath: logText === null ? null : "/logs/executor.log",
  }, { now: () => fixedNow });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Dredge classification", () => {
  test("classifies explicit timeout", () => {
    const report = analyze({ execution_id: "exec-timeout", status: "failed", error: "deadline exceeded" });
    expect(report.classification.category).toBe("timeout");
    expect(report.evidence.some((item) => item.code === "timeout.explicit")).toBe(true);
  });

  test("classifies exhausted timeout budget", () => {
    const report = analyze({
      execution_id: "exec-budget",
      status: "failed",
      executor_timeout_ms: 60_000,
      duration_ms: 60_000,
    });
    expect(report.classification.category).toBe("timeout");
    expect(report.evidence.some((item) => item.code === "timeout.budget-exhausted")).toBe(true);
  });

  test("classifies idle timeout as stall", () => {
    const report = analyze({ execution_id: "exec-idle", status: "failed" }, "executor idle timeout after no progress for 480 seconds");
    expect(report.classification.category).toBe("stall");
    expect(report.evidence.some((item) => item.code === "stall.idle-timeout")).toBe(true);
  });

  test("classifies stale heartbeat as stall", () => {
    const report = analyze({
      execution_id: "exec-heartbeat",
      status: "executing",
      executor_idle_timeout_ms: 600_000,
      last_heartbeat_at: "2026-08-10T19:40:00.000Z",
    });
    expect(report.classification.category).toBe("stall");
    expect(report.evidence.some((item) => item.code === "stall.heartbeat-inactive")).toBe(true);
  });

  test("classifies reaper output as stall", () => {
    const report = analyze({
      execution_id: "exec-reaped",
      status: "failed",
      error: "[reaper] failed orphaned 'executing' record (reaped: stale 45m, no live process)",
    });
    expect(report.classification.category).toBe("stall");
    expect(report.evidence.some((item) => item.code === "stall.reaper")).toBe(true);
  });

  test("classifies explicit OOM with highest precedence", () => {
    const report = analyze(
      { execution_id: "exec-oom", status: "failed", error: "heap out of memory after deadline exceeded" },
      "TypeError: worker failed",
    );
    expect(report.classification.category).toBe("OOM");
  });

  test("classifies exit 137 only with memory context", () => {
    const withContext = analyze({ execution_id: "exec-137", status: "failed" }, "worker exit code 137 after memory pressure");
    const withoutContext = analyze({ execution_id: "exec-137-plain", status: "failed" }, "worker exit code 137");
    expect(withContext.classification.category).toBe("OOM");
    expect(withoutContext.classification.category).toBe(null);
  });

  test("classifies explicit exception", () => {
    const report = analyze({ execution_id: "exec-error", status: "failed" }, "TypeError: cannot read property\n    at run (/src/worker.ts:12:4)");
    expect(report.classification.category).toBe("exception");
    expect(report.evidence.some((item) => item.code === "exception.explicit")).toBe(true);
  });

  test("classifies a failed record with an otherwise unknown error as exception", () => {
    const report = analyze({ execution_id: "exec-failed", status: "failed", error: "worker returned malformed output" });
    expect(report.classification.category).toBe("exception");
    expect(report.evidence.some((item) => item.code === "exception.failed-record-error")).toBe(true);
  });

  test("leaves an execution unclassified without deterministic evidence", () => {
    const report = analyze({ execution_id: "exec-clean", status: "complete" }, "worker finished normally");
    expect(report.status).toBe("unclassified");
    expect(report.classification.category).toBe(null);
    expect(report.evidence).toEqual([]);
  });
});

describe("Dredge evidence handling", () => {
  const scanner: StubScanOutcome = {
    mode: "advisory",
    result: {
      ok: false,
      findings: [{
        detector: "not-implemented",
        file: "src/worker.ts",
        line: 8,
        evidence: "throw new Error('not implemented')",
        reason: "placeholder implementation",
      }],
      reason: "one finding",
    },
  };

  test("normalizes the optional scanner outcome", () => {
    expect(normalizeStubScanOutcome(scanner)).toEqual(scanner);
  });

  test("reads a scanner sidecar wrapper", () => {
    const report = analyzeDredge({
      executionRecordText: JSON.stringify({ execution_id: "exec-sidecar", status: "failed", error: "TypeError: failed" }),
      executionRecordPath: "/state/exec-sidecar.json",
      scannerSidecarText: JSON.stringify({ stub_scan: scanner }),
      scannerSidecarPath: "/state/exec-sidecar.stub-scan.json",
    }, { now: () => fixedNow });
    expect(report.scanner_evidence).toEqual(scanner);
    expect(report.artifacts.scanner_sidecar).toBe("/state/exec-sidecar.stub-scan.json");
  });

  test("falls back to embedded consensus scanner evidence", () => {
    const report = analyze({
      execution_id: "exec-embedded",
      status: "failed",
      error: "TypeError: failed",
      consensus: { stub_scan: scanner },
    });
    expect(report.scanner_evidence).toEqual(scanner);
  });

  test("warns instead of crashing on malformed artifacts", () => {
    const report = analyzeDredge({
      executionRecordText: "{broken",
      executionRecordPath: "/state/exec-malformed.json",
      logText: "TypeError: still classifiable\0",
      logPath: "/logs/malformed.log",
      scannerSidecarText: "{}",
      scannerSidecarPath: "/state/scanner.json",
    }, { now: () => fixedNow });
    expect(report.classification.category).toBe("exception");
    expect(report.warnings.some((item) => item.includes("malformed JSON"))).toBe(true);
    expect(report.warnings.some((item) => item.includes("NUL bytes"))).toBe(true);
    expect(report.warnings.some((item) => item.includes("StubScanOutcome"))).toBe(true);
  });

  test("redacts secrets and bounds excerpts", () => {
    const secret = "ghp_1234567890abcdef";
    const excerpt = redactAndBoundExcerpt(`authorization=Bearer ${secret} ${"x".repeat(500)}`);
    expect(excerpt).not.toContain(secret);
    expect(excerpt).toContain("[REDACTED]");
    expect(excerpt.length).toBeLessThanOrEqual(240);
  });

  test("emits a stable structured report", () => {
    const report = analyze({ identifier: "ZOU-937", status: "failed", error: "deadline exceeded" });
    expect(report.schema_version).toBe(1);
    expect(report.execution_id).toBe("test");
    expect(report.identifier).toBe("ZOU-937");
    expect(report.generated_at).toBe(fixedNow);
    expect(report.artifacts.execution_record).toBe("/state/exec-test.json");
  });
});

describe("Dredge report writing and CLI", () => {
  test("writes atomically and refuses an accidental clobber", () => {
    const dir = temporaryDirectory();
    const path = join(dir, "nested", "report.json");
    const report = analyze({ execution_id: "exec-write", status: "failed", error: "deadline exceeded" });
    expect(writeDredgeReport(report, path)).toBe(path);
    expect(JSON.parse(readFileSync(path, "utf8")).execution_id).toBe("exec-write");
    expect(readdirSync(join(dir, "nested"))).toEqual(["report.json"]);
    expect(() => writeDredgeReport(report, path)).toThrow("refusing to clobber");
  });

  test("CLI reads artifacts and writes a JSON report", () => {
    const dir = temporaryDirectory();
    const execPath = join(dir, "exec-cli.json");
    const logPath = join(dir, "executor.log");
    const outPath = join(dir, "exec-cli.autopsy.json");
    writeFileSync(execPath, JSON.stringify({ execution_id: "exec-cli", status: "failed" }));
    writeFileSync(logPath, "worker timed out after 300 seconds");
    expect(runDredgeCli(["--exec", execPath, "--log", logPath, "--out", outPath])).toBe(0);
    const report = JSON.parse(readFileSync(outPath, "utf8"));
    expect(report.execution_id).toBe("exec-cli");
    expect(report.classification.category).toBe("timeout");
  });
});
