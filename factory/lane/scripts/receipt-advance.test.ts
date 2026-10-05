import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceReceipts, decideAdvance, readReceipts } from "./receipt-advance";
import type { DeliveryEvidenceResult } from "./delivery-evidence";
import type { HandoffEvidence } from "./handoff-contract";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "receipt-adv-"));
  dirs.push(dir);
  mkdirSync(join(dir, "state"), { recursive: true });
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function writeReceipt(base: string, receipt: Record<string, unknown>): string {
  const path = join(base, "state", `shipping-request-${receipt.execution_id}.json`);
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  return path;
}

function evidenceFor(twins: string[]): DeliveryEvidenceResult {
  return {
    ok: true,
    degraded_reason: null,
    byTwin: new Map(twins.map((twin) => [twin, {
      twin_identifier: twin,
      execution_id: `exec-${twin}`,
      state: "merged" as const,
      source: "lifecycle_projection" as const,
      observed_at: "2026-07-26T12:00:00.000Z",
    }])),
  };
}

const COMPLETE_HANDOFF: HandoffEvidence = {
  deployment_commit: "7bc6f66c",
  service_health: { ok: true, detail: "ok" },
  production_smoke: { ok: true, detail: "17/17" },
  operator_runbook: "docs/runbook.md",
  dashboard: "Zouroboros dashboard",
  access_mode: "private",
  named_consumer: "Operations view",
};

describe("receipt advancement policy (FH-13)", () => {
  const receipt = { execution_id: "exec-d50452ec", identifier: "ZOU-933", outcome: "merge_queued", status: "succeeded" };

  test("merge_queued advances to merged once the merge is proven", () => {
    const decision = decideAdvance(receipt, true);
    expect(decision).toMatchObject({ from: "merge_queued", to: "merged", advanced: true });
  });

  test("without merge evidence nothing advances", () => {
    expect(decideAdvance(receipt, false)).toMatchObject({ to: null, advanced: false });
  });

  test("merged plus a satisfied handoff reaches accepted", () => {
    expect(decideAdvance(receipt, true, COMPLETE_HANDOFF)).toMatchObject({ to: "accepted", advanced: true });
  });

  test("an incomplete handoff is never rounded up to accepted", () => {
    const decision = decideAdvance(receipt, true, { ...COMPLETE_HANDOFF, named_consumer: null });
    expect(decision.to).toBe("deployed");
    expect(decision.reason).toContain("named_consumer");
  });

  test("merged with no deployment evidence stops at merged", () => {
    const decision = decideAdvance(receipt, true, { deployment_commit: null, service_health: null });
    expect(decision.to).toBe("merged");
  });

  test("an already terminal receipt is a no-op", () => {
    expect(decideAdvance({ ...receipt, outcome: "accepted" }, true, COMPLETE_HANDOFF))
      .toMatchObject({ advanced: false, reason: "already terminal (accepted)" });
  });
});

describe("receipt advancement over the state directory (FH-13)", () => {
  test("resolves the ZOU-933 receipt that froze at merge_queued", () => {
    const base = scratch();
    const path = writeReceipt(base, {
      version: 1,
      execution_id: "exec-d50452ec",
      identifier: "ZOU-933",
      status: "succeeded",
      outcome: "merge_queued",
      pr_number: 400,
    });

    const report = advanceReceipts({ base, evidence: evidenceFor(["ZOU-933"]) });
    expect(report.ok).toBe(true);
    expect(report.advanced).toBe(1);

    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.outcome).toBe("merged");
    expect(written.terminal_evidence.execution_id).toBe("exec-ZOU-933");
    // Fields it did not own are preserved.
    expect(written.pr_number).toBe(400);
  });

  test("is idempotent — a second run advances nothing", () => {
    const base = scratch();
    writeReceipt(base, { execution_id: "e1", identifier: "ZOU-933", outcome: "merge_queued", status: "succeeded" });
    const evidence = evidenceFor(["ZOU-933"]);
    expect(advanceReceipts({ base, evidence }).advanced).toBe(1);
    expect(advanceReceipts({ base, evidence }).advanced).toBe(0);
  });

  test("degraded evidence fails closed rather than asserting a terminal state", () => {
    const base = scratch();
    writeReceipt(base, { execution_id: "e1", identifier: "ZOU-933", outcome: "merge_queued", status: "succeeded" });
    const report = advanceReceipts({
      base,
      evidence: { ok: false, degraded_reason: "journal unreadable", byTwin: new Map() },
    });
    expect(report.ok).toBe(false);
    expect(report.advanced).toBe(0);
    expect(JSON.parse(readFileSync(join(base, "state", "shipping-request-e1.json"), "utf8")).outcome)
      .toBe("merge_queued");
  });

  test("--dry-run computes the plan without writing", () => {
    const base = scratch();
    const path = writeReceipt(base, { execution_id: "e1", identifier: "ZOU-933", outcome: "merge_queued", status: "succeeded" });
    const report = advanceReceipts({ base, evidence: evidenceFor(["ZOU-933"]), apply: false });
    expect(report.advanced).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe("merge_queued");
  });

  test("a corrupt receipt does not stop the others from advancing", () => {
    const base = scratch();
    writeFileSync(join(base, "state", "shipping-request-broken.json"), "{ not json");
    writeReceipt(base, { execution_id: "e1", identifier: "ZOU-933", outcome: "merge_queued", status: "succeeded" });
    expect(readReceipts(base)).toHaveLength(1);
    expect(advanceReceipts({ base, evidence: evidenceFor(["ZOU-933"]) }).advanced).toBe(1);
  });

  test("handoff evidence carries a receipt all the way to accepted", () => {
    const base = scratch();
    const path = writeReceipt(base, { execution_id: "e1", identifier: "ZOU-933", outcome: "merge_queued", status: "succeeded" });
    advanceReceipts({
      base,
      evidence: evidenceFor(["ZOU-933"]),
      handoff: new Map([["ZOU-933", COMPLETE_HANDOFF]]),
    });
    expect(JSON.parse(readFileSync(path, "utf8")).outcome).toBe("accepted");
  });

  test("a receipt with no merge evidence is reported, not silently skipped", () => {
    const base = scratch();
    writeReceipt(base, { execution_id: "e1", identifier: "ZOU-999", outcome: "merge_queued", status: "succeeded" });
    const report = advanceReceipts({ base, evidence: evidenceFor(["ZOU-933"]) });
    expect(report.evaluated).toBe(1);
    expect(report.advanced).toBe(0);
    expect(report.results[0].reason).toContain("no merge evidence");
  });
});
