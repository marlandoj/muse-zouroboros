import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RELEASE_GRANT_TTL_MS,
  consumeReleaseGrant,
  loadReleaseGrant,
  normalizeGrantTier,
  releaseGrantPath,
  writeReleaseGrant,
} from "./release-grant";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "release-grant-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-08-30T00:00:00.000Z");

function grantFor(identifier = "ZOU-1566", tier = "high") {
  return writeReleaseGrant(
    {
      identifier,
      ticket_id: "b844c930-c053-4cfd-897f-3d0301e32288",
      source_execution_id: "exec-c06dbee6",
      tier,
      granted_by: "marlandoj",
      note: "operator sign-off",
    },
    stateDir,
    NOW,
  );
}

describe("writeReleaseGrant", () => {
  test("persists a single-use grant with TTL expiry", () => {
    const grant = grantFor();
    expect(grant.tier).toBe("high");
    expect(grant.consumed_by).toBeNull();
    expect(Date.parse(grant.expires_at) - Date.parse(grant.granted_at)).toBe(RELEASE_GRANT_TTL_MS);
    const onDisk = loadReleaseGrant("ZOU-1566", stateDir);
    expect(onDisk).toEqual(grant);
  });

  test("replaces a prior grant for the same ticket", () => {
    grantFor("ZOU-1566", "medium");
    const second = grantFor("ZOU-1566", "high");
    const onDisk = loadReleaseGrant("ZOU-1566", stateDir);
    expect(onDisk?.tier).toBe("high");
    expect(onDisk?.granted_at).toBe(second.granted_at);
  });

  test("sanitizes hostile identifiers into the state dir", () => {
    const grant = writeReleaseGrant(
      { identifier: "../evil", ticket_id: null, source_execution_id: "x", tier: "low", granted_by: "op" },
      stateDir,
      NOW,
    );
    expect(grant.identifier).toBe("../evil");
    const path = releaseGrantPath("../evil", stateDir);
    expect(path.startsWith(stateDir)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

describe("consumeReleaseGrant", () => {
  test("consumes a valid grant exactly once", () => {
    grantFor();
    const first = consumeReleaseGrant("ZOU-1566", "high", "exec-new-1", stateDir, NOW + 1000);
    expect(first.grant).not.toBeNull();
    expect(first.grant?.consumed_by).toBe("exec-new-1");
    const second = consumeReleaseGrant("ZOU-1566", "high", "exec-new-2", stateDir, NOW + 2000);
    expect(second.grant).toBeNull();
    expect(second.reason).toContain("already consumed by exec-new-1");
  });

  test("records consumption durably on disk", () => {
    grantFor();
    consumeReleaseGrant("ZOU-1566", "high", "exec-new-1", stateDir, NOW + 1000);
    const onDisk = JSON.parse(readFileSync(releaseGrantPath("ZOU-1566", stateDir), "utf-8"));
    expect(onDisk.consumed_by).toBe("exec-new-1");
    expect(onDisk.consumed_at).toBe(new Date(NOW + 1000).toISOString());
  });

  test("returns null when no grant exists", () => {
    const result = consumeReleaseGrant("ZOU-9999", "high", "exec-x", stateDir, NOW);
    expect(result.grant).toBeNull();
    expect(result.reason).toBe("no grant on file");
  });

  test("refuses an expired grant", () => {
    grantFor();
    const result = consumeReleaseGrant("ZOU-1566", "high", "exec-x", stateDir, NOW + RELEASE_GRANT_TTL_MS + 1);
    expect(result.grant).toBeNull();
    expect(result.reason).toContain("expired");
  });

  test("refuses when risk escalated beyond the granted tier", () => {
    grantFor("ZOU-1566", "medium");
    const result = consumeReleaseGrant("ZOU-1566", "high", "exec-x", stateDir, NOW + 1000);
    expect(result.grant).toBeNull();
    expect(result.reason).toContain("risk escalated beyond grant");
    const onDisk = loadReleaseGrant("ZOU-1566", stateDir);
    expect(onDisk?.consumed_by).toBeNull();
  });

  test("allows a lower-tier verdict against a higher-tier grant", () => {
    grantFor("ZOU-1566", "high");
    const result = consumeReleaseGrant("ZOU-1566", "medium", "exec-x", stateDir, NOW + 1000);
    expect(result.grant).not.toBeNull();
  });

  test("treats an unknown verdict tier as high (fail-closed against low grants)", () => {
    expect(normalizeGrantTier("bogus")).toBe("high");
    grantFor("ZOU-1566", "medium");
    const result = consumeReleaseGrant("ZOU-1566", "bogus", "exec-x", stateDir, NOW + 1000);
    expect(result.grant).toBeNull();
  });

  test("propagates corrupt grant files as errors for fail-closed callers", () => {
    writeFileSync(releaseGrantPath("ZOU-1566", stateDir), "{not json");
    expect(() => consumeReleaseGrant("ZOU-1566", "high", "exec-x", stateDir, NOW)).toThrow();
  });
});
