import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LINEUP_PROFILES,
  refreshAllLineups,
  runLineupPersist,
  shouldSkipPinnedRefresh,
  summarizeLineups,
  verifyPersistedArtifact,
  type LineupArtifactVerifier,
  type LineupSpawner,
} from "./catalog-refresh-all";
import type { PersistedLineup } from "./lineup-picker";

const encoder = new TextEncoder();
const acceptArtifact: LineupArtifactVerifier = () => null;

function result(exitCode: number, stdout: string, stderr = "") {
  return {
    exitCode,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  };
}

function validOutput(profile: string) {
  return JSON.stringify({
    valid: true,
    profile,
    lineup: {
      proposers: ["one", "two", "three"],
      aggregator: "four",
      generatedAt: `2026-07-11T00:00:00.000Z-${profile}`,
    },
  });
}

describe("runLineupPersist", () => {
  test("preserves valid operator-pinned artifacts", () => {
    const persisted = {
      valid: true,
      lineup: { pinned: true },
    } as PersistedLineup;
    expect(shouldSkipPinnedRefresh(persisted)).toBe(true);
    expect(shouldSkipPinnedRefresh({ ...persisted, valid: false })).toBe(false);
    expect(shouldSkipPinnedRefresh({
      ...persisted,
      lineup: { ...persisted.lineup, pinned: false },
    })).toBe(false);
  });

  test("requires exit zero and valid=true", () => {
    const spawn: LineupSpawner = () => result(0, validOutput("fast"));

    expect(runLineupPersist("fast", spawn, acceptArtifact)).toEqual({
      profile: "fast",
      ok: true,
      output: validOutput("fast"),
      error: null,
    });
  });

  test("fails closed on invalid JSON", () => {
    const refresh = runLineupPersist("coder", () => result(0, "not-json"), acceptArtifact);

    expect(refresh.ok).toBe(false);
    expect(refresh.error).toStartWith("invalid JSON:");
  });

  test("fails closed when the picker reports valid=false", () => {
    const refresh = runLineupPersist(
      "open-weights",
      () => result(0, JSON.stringify({ valid: false, profile: "open-weights", lineup: {} })),
      acceptArtifact,
    );

    expect(refresh).toMatchObject({
      profile: "open-weights",
      ok: false,
      error: "picker reported valid=false",
    });
  });

  test("preserves picker blockers when a profile cannot be regenerated", () => {
    const refresh = runLineupPersist(
      "coder",
      () => result(0, JSON.stringify({
        valid: false,
        profile: "coder",
        blockers: [
          "coder pool has 1 distinct proposer families; need 3",
          "coder pool needs one additional family for a distinct aggregator; available families=1",
        ],
        lineup: {},
      })),
      acceptArtifact,
    );

    expect(refresh.error).toBe(
      "picker reported valid=false: coder pool has 1 distinct proposer families; need 3; " +
      "coder pool needs one additional family for a distinct aggregator; available families=1",
    );
  });

  test("rejects malformed lineup envelopes and profile mismatches", () => {
    const malformed = runLineupPersist(
      "fast",
      () => result(0, JSON.stringify({
        valid: true,
        profile: "fast",
        lineup: { proposers: [], aggregator: "", generatedAt: "now" },
      })),
      acceptArtifact,
    );
    const mismatched = runLineupPersist(
      "coder",
      () => result(0, validOutput("fast")),
      acceptArtifact,
    );
    const mismatchedFlagship = runLineupPersist(
      "flagship",
      () => result(0, validOutput("fast")),
      acceptArtifact,
    );

    expect(malformed.error).toBe("picker lineup has invalid proposers");
    expect(mismatched.error).toBe("picker profile mismatch: expected coder, got fast");
    expect(mismatchedFlagship.error).toBe("picker profile mismatch: expected flagship, got fast");
  });

  test("requires persisted-artifact readback verification", () => {
    const refresh = runLineupPersist(
      "fast",
      () => result(0, validOutput("fast")),
      () => "artifact fingerprint mismatch",
    );

    expect(refresh).toMatchObject({ ok: false, error: "artifact fingerprint mismatch" });
  });

  test("verifies the persisted profile artifact and generatedAt fingerprint", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineup-refresh-"));
    const artifactPath = path.join(dir, "lineup.fast.json");
    const pickerOutput = JSON.parse(validOutput("fast"));
    fs.writeFileSync(artifactPath, JSON.stringify({
      ...pickerOutput,
      members: [],
      persistedAt: "2026-07-11T00:00:01.000Z",
    }));

    try {
      expect(verifyPersistedArtifact("fast", pickerOutput, () => artifactPath)).toBeNull();
      fs.writeFileSync(artifactPath, JSON.stringify({
        ...pickerOutput,
        lineup: { ...pickerOutput.lineup, generatedAt: "stale" },
      }));
      expect(verifyPersistedArtifact("fast", pickerOutput, () => artifactPath)).toContain(
        "artifact fingerprint mismatch",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshAllLineups", () => {
  test("runs each supported profile independently with explicit CLI arguments", () => {
    const calls: string[][] = [];
    const spawn: LineupSpawner = (args) => {
      calls.push(args);
      const profile = args[args.indexOf("--profile") + 1];
      return result(0, validOutput(profile));
    };

    const refreshes = refreshAllLineups(spawn, acceptArtifact);
    const summary = summarizeLineups(refreshes);

    expect(LINEUP_PROFILES).toEqual(["flagship", "open-weights", "fast", "coder", "judge"]);
    expect(new Set(LINEUP_PROFILES).size).toBe(5);
    expect(refreshes.map(({ profile, ok }) => ({ profile, ok }))).toEqual(
      LINEUP_PROFILES.map((profile) => ({ profile, ok: true })),
    );
    expect(calls.map((args) => args.slice(-3))).toEqual(
      LINEUP_PROFILES.map((profile) => ["--profile", profile, "--json"]),
    );
    expect(summary).toEqual({
      lineup_ok: true,
      lineup_profiles: LINEUP_PROFILES.map((profile) => ({ profile, ok: true, error: null })),
    });
  });

  test("continues after one profile fails and preserves other successes", () => {
    const calls: string[] = [];
    const spawn: LineupSpawner = (args) => {
      const profile = args[args.indexOf("--profile") + 1];
      calls.push(profile);
      return profile === "fast"
        ? result(1, "", "fast picker failed")
        : result(0, validOutput(profile));
    };

    const refreshes = refreshAllLineups(spawn, acceptArtifact);
    const summary = summarizeLineups(refreshes);

    expect(calls).toEqual([...LINEUP_PROFILES]);
    expect(refreshes.find((item) => item.profile === "fast")).toMatchObject({
      ok: false,
      error: "picker exited 1",
    });
    expect(refreshes.filter((item) => item.profile !== "fast").every((item) => item.ok)).toBe(true);
    expect(summary.lineup_ok).toBe(false);
    expect(summary.lineup_profiles.find((item) => item.profile === "fast")).toEqual({
      profile: "fast",
      ok: false,
      error: "picker exited 1",
    });
  });

  test("continues remaining profiles when one spawn throws", () => {
    const calls: string[] = [];
    const spawn: LineupSpawner = (args) => {
      const profile = args[args.indexOf("--profile") + 1];
      calls.push(profile);
      if (profile === "open-weights") throw new Error("spawn unavailable");
      return result(0, validOutput(profile));
    };

    const refreshes = refreshAllLineups(spawn, acceptArtifact);

    expect(calls).toEqual([...LINEUP_PROFILES]);
    expect(refreshes.find((item) => item.profile === "open-weights")).toEqual({
      profile: "open-weights",
      ok: false,
      output: "",
      error: "picker spawn failed: spawn unavailable",
    });
    expect(refreshes.filter((item) => item.profile !== "open-weights").every((item) => item.ok)).toBe(true);
  });
});
