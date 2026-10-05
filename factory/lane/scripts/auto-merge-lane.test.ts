import { describe, expect, test } from "bun:test";
import { promotionEvidenceExpiry } from "./auto-merge-lane";

describe("promotion evidence expiry", () => {
  test("never outlives the bound certification validation evidence", () => {
    const generated = new Date("2026-08-28T12:00:00.000Z");
    expect(promotionEvidenceExpiry(generated, "2026-08-28T13:00:00.000Z")).toBe("2026-08-28T13:00:00.000Z");
    expect(promotionEvidenceExpiry(generated, "2026-08-28T15:00:00.000Z")).toBe("2026-08-28T14:00:00.000Z");
  });

  test("rejects expired or malformed certification evidence", () => {
    const generated = new Date("2026-08-28T12:00:00.000Z");
    expect(() => promotionEvidenceExpiry(generated, "2026-08-28T11:59:59.999Z")).toThrow(/expired or has an invalid expiry/);
    expect(() => promotionEvidenceExpiry(generated, "not-a-timestamp")).toThrow(/expired or has an invalid expiry/);
  });
});
