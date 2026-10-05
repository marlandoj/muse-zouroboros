import { describe, expect, test } from "bun:test";
import { runShadowQualification } from "./modal-shadow-qualification";

describe("Modal integrated shadow qualification", () => {
  test("passes at least 50 reviewed Factory and Swarm decisions with zero dispatch", async () => {
    const report = await runShadowQualification();
    expect(report.passed).toBe(true);
    expect(report.fixtureCount).toBe(60);
    expect(report.decisionCount).toBe(120);
    expect(report.workloadClasses.length).toBeGreaterThanOrEqual(4);
    expect(report.agreementCount).toBe(120);
    expect(report.adapterCalls).toBe(0);
    expect(report.providerSpendUsd).toBe(0);
    expect(report.noDispatch).toBe(true);
  });
});
