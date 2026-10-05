import { describe, expect, test } from "bun:test";
import { CORPUS_SHA256, fullReplayPrerequisites, runReplay } from "./factory-hardening-replay";

describe("factory hardening replay", () => {
  test("Wave 1 production adapters pass their four owned incidents", () => {
    const report = runReplay("wave1");
    expect(report.corpus_valid).toBe(true);
    expect(report.corpus_sha256).toBe(CORPUS_SHA256);
    expect(report.passed).toBe(4);
    expect(report.failed).toBe(0);
    expect(report.deferred).toBe(1);
    expect(report.cases.find((entry) => entry.case_id === "ORI-INC-005")?.reason).toContain("outside the Wave 1");
  });

  test("full replay passes all five frozen incidents once every workstream has evidence", () => {
    const prerequisites = fullReplayPrerequisites();
    expect(Object.values(prerequisites).every(Boolean)).toBe(true);
    const report = runReplay("full");
    expect(report.verdict).toBe("PASS");
    expect(report.passed).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.deferred).toBe(0);
    const shipGate = report.cases.find((entry) => entry.case_id === "ORI-INC-005");
    expect(shipGate?.evidence.first_emitted_events).toBe(1);
    expect(shipGate?.evidence.second_emitted_events).toBe(0);
    expect(shipGate?.evidence.auto_merge).toBe(false);
  });
});
