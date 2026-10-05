import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShipReadyItem } from "./ship-ready-scan";
import {
  appendEmittedFingerprint,
  attachFingerprint,
  planDraftPr,
  readEmittedFingerprints,
  selectNewShipReadyEvents,
  shipReadyFingerprint,
} from "./ship-ready-core";

function item(over: Partial<ShipReadyItem> = {}): ShipReadyItem {
  return {
    identifier: "ZOU-901",
    execution_id: "exec-aaaa1111",
    branch_name: "factory/zou-901",
    completed_at: "2026-07-13T00:00:00.000Z",
    age_minutes: 90,
    ...over,
  };
}

describe("shipReadyFingerprint", () => {
  test("is stable for the same build across scans", () => {
    expect(shipReadyFingerprint(item())).toBe(shipReadyFingerprint(item()));
  });

  test("a retry (new execution_id) is a new event", () => {
    expect(shipReadyFingerprint(item())).not.toBe(shipReadyFingerprint(item({ execution_id: "exec-bbbb2222" })));
  });

  test("a different branch is a new event", () => {
    expect(shipReadyFingerprint(item())).not.toBe(shipReadyFingerprint(item({ branch_name: "factory/other" })));
  });

  test("a null branch does not throw and is stable", () => {
    const a = shipReadyFingerprint(item({ branch_name: null }));
    expect(a).toBe(shipReadyFingerprint(item({ branch_name: null })));
  });
});

describe("selectNewShipReadyEvents", () => {
  test("emits nothing already in the ledger — single actionable event (AC#3)", () => {
    const it = item();
    const fp = shipReadyFingerprint(it);
    expect(selectNewShipReadyEvents([it], new Set())).toHaveLength(1);
    expect(selectNewShipReadyEvents([it], new Set([fp]))).toHaveLength(0);
  });

  test("dedups within a single scan", () => {
    const out = selectNewShipReadyEvents([item(), item()], new Set());
    expect(out).toHaveLength(1);
  });

  test("keeps distinct builds", () => {
    const out = selectNewShipReadyEvents([item(), item({ identifier: "ZOU-902", execution_id: "exec-cccc3333" })], new Set());
    expect(out).toHaveLength(2);
  });

  test("attaches the fingerprint to each event", () => {
    const [event] = selectNewShipReadyEvents([item()], new Set());
    expect(event.fingerprint).toBe(shipReadyFingerprint(item()));
  });
});

describe("planDraftPr", () => {
  test("plans a draft-only PR that never enables auto-merge", () => {
    const plan = planDraftPr(attachFingerprint(item()));
    expect(plan.draft).toBe(true);
    expect(plan.auto_merge).toBe(false);
    expect(plan.branch).toBe("factory/zou-901");
    expect(plan.title).toContain("ZOU-901");
    expect(plan.body).toContain("auto-merge is intentionally NOT enabled");
  });

  test("throws when there is no branch to open against", () => {
    expect(() => planDraftPr(attachFingerprint(item({ branch_name: null })))).toThrow(/no branch/);
  });

  test("honors caller-supplied title and body", () => {
    const plan = planDraftPr(attachFingerprint(item()), { title: "custom", body: "b" });
    expect(plan.title).toBe("custom");
    expect(plan.body).toBe("b");
  });
});

describe("emitted-fingerprint ledger", () => {
  test("round-trips through the persisted ledger and dedups across process boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipready-"));
    try {
      expect(readEmittedFingerprints(dir).size).toBe(0);
      const it = item();
      const [event] = selectNewShipReadyEvents([it], readEmittedFingerprints(dir));
      appendEmittedFingerprint(event, dir);

      // Simulate a fresh scan: the persisted ledger now suppresses the same build.
      const emitted = readEmittedFingerprints(dir);
      expect(emitted.has(event.fingerprint)).toBe(true);
      expect(selectNewShipReadyEvents([it], emitted)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing ledger reads as empty (fail-open)", () => {
    expect(readEmittedFingerprints(join(tmpdir(), "does-not-exist-shipready-xyz")).size).toBe(0);
  });
});
