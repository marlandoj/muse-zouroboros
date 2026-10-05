import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTAMINATION_THRESHOLD,
  ROTATE_AFTER_MS,
  createHoldoutFingerprint,
  evaluateHoldoutContamination,
  expireHoldouts,
  finalizeHoldoutManifest,
  readHoldoutState,
  recordHoldoutAccess,
  validateAccessLedger,
  validateHoldoutManifest,
  writeHoldoutState,
  type HoldoutState,
} from "./heldout-cohort";

const CREATED = "2026-01-01T00:00:00.000Z";
const TEXT = "operator reviews a failed deployment receipt before admitting a deterministic scenario into the protected evaluation cohort";

let root = "";
let state: HoldoutState;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heldout-cohort-"));
  state = {
    manifest: finalizeHoldoutManifest([
      createHoldoutFingerprint({ itemId: "heldout-001", version: "v1", plaintext: TEXT, createdAt: CREATED }),
    ]),
    accessLedger: [],
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("evaluator-only holdout custody", () => {
  test("fingerprints deterministically without retaining plaintext", () => {
    const again = createHoldoutFingerprint({ itemId: "heldout-001", version: "v1", plaintext: TEXT, createdAt: CREATED });
    expect(again).toEqual(state.manifest.items[0]);
    expect(JSON.stringify(state)).not.toContain(TEXT);
    expect(state.manifest.items[0].contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.manifest.items[0].normalized8GramHashes.length).toBeGreaterThan(0);
    expect(validateHoldoutManifest(state.manifest)).toEqual([]);
  });

  test("persists only verified hashes with owner-only permissions", () => {
    const path = join(root, "holdouts.json");
    writeHoldoutState(path, state);
    const bytes = readFileSync(path, "utf8");
    expect(bytes).not.toContain(TEXT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readHoldoutState(path)).toEqual(state);
  });

  test("rejects tampered manifest and access chains", () => {
    const brokenManifest = structuredClone(state.manifest);
    brokenManifest.items[0].exposureCount = 1;
    expect(validateHoldoutManifest(brokenManifest)).toContain("manifest hash mismatch");

    const first = recordHoldoutAccess(state, { itemId: "heldout-001", actor: "evaluator", purpose: "inspect", ts: "2026-01-02T00:00:00.000Z" });
    const brokenLedger = structuredClone(first.accessLedger);
    brokenLedger[0].actor = "intruder";
    expect(validateAccessLedger(brokenLedger)).toContain("access ledger record hash mismatch at 0");
    const held = recordHoldoutAccess({ manifest: first.manifest, accessLedger: brokenLedger }, { itemId: "heldout-001", actor: "evaluator", purpose: "evaluate", ts: "2026-01-03T00:00:00.000Z" });
    expect(held.decision).toBe("hold");
  });
});

describe("access, rotation, and exclusion policy", () => {
  test("hash-chains allowed access and requires rotation after two exposures", () => {
    const first = recordHoldoutAccess(state, { itemId: "heldout-001", actor: "evaluator", purpose: "inspect", ts: "2026-01-02T00:00:00.000Z" });
    expect(first.decision).toBe("allow");
    expect(first.manifest.items[0].exposureCount).toBe(1);
    expect(first.manifest.items[0].state).toBe("active");

    const second = recordHoldoutAccess(first, { itemId: "heldout-001", actor: "evaluator", purpose: "evaluate", ts: "2026-01-03T00:00:00.000Z" });
    expect(second.decision).toBe("allow");
    expect(second.manifest.items[0].exposureCount).toBe(2);
    expect(second.manifest.items[0].state).toBe("rotation_required");
    expect(second.manifest.items[0].rotationReasons).toContain("exposure_limit");
    expect(validateAccessLedger(second.accessLedger)).toEqual([]);

    const third = recordHoldoutAccess(second, { itemId: "heldout-001", actor: "evaluator", purpose: "evaluate", ts: "2026-01-04T00:00:00.000Z" });
    expect(third.decision).toBe("hold");
  });

  test("holds excluded and unknown purposes while preserving audit evidence", () => {
    const excluded = recordHoldoutAccess(state, { itemId: "heldout-001", actor: "generator", purpose: "scenario_generation", ts: "2026-01-02T00:00:00.000Z" });
    expect(excluded.decision).toBe("hold");
    expect(excluded.reasons).toContain("purpose is excluded");
    expect(excluded.accessLedger[0].decision).toBe("hold");

    const unknown = recordHoldoutAccess(excluded, { itemId: "heldout-001", actor: "generator", purpose: "surprise", ts: "2026-01-03T00:00:00.000Z" });
    expect(unknown.decision).toBe("hold");
    expect(unknown.reasons).toContain("purpose is unknown");
    expect(validateAccessLedger(unknown.accessLedger)).toEqual([]);
  });

  test("requires rotation on contamination or age and expires at the custody deadline", () => {
    const contaminated = recordHoldoutAccess(state, { itemId: "heldout-001", actor: "evaluator", purpose: "contamination_check", ts: "2026-01-02T00:00:00.000Z", contaminationSignal: true });
    expect(contaminated.manifest.items[0].state).toBe("rotation_required");
    expect(contaminated.manifest.items[0].rotationReasons).toContain("contamination_signal");

    const beforeExpiry = new Date(Date.parse(CREATED) + ROTATE_AFTER_MS).toISOString();
    const aged = expireHoldouts(state, beforeExpiry);
    expect(aged.manifest.items[0].state).toBe("expired");
    expect(aged.accessLedger.at(-1)?.purpose).toBe("expire");
    expect(validateAccessLedger(aged.accessLedger)).toEqual([]);
  });
});

describe("contamination comparison", () => {
  test("quarantines exact content hash overlap", () => {
    const result = evaluateHoldoutContamination(TEXT, state.manifest, "2026-01-02T00:00:00.000Z");
    expect(result.disposition).toBe("quarantine");
    expect(result.exactMatch).toBe(true);
    expect(result.matchedItemId).toBe("heldout-001");
  });

  test("quarantines normalized 8-gram overlap at the binding threshold", () => {
    const candidate = `${TEXT} with one additional harmless suffix`;
    const result = evaluateHoldoutContamination(candidate, state.manifest, "2026-01-02T00:00:00.000Z");
    expect(result.maximumOverlap).toBeGreaterThanOrEqual(CONTAMINATION_THRESHOLD);
    expect(result.disposition).toBe("quarantine");
    expect(result.exactMatch).toBe(false);
  });

  test("clears disjoint content and holds stale or invalid manifests", () => {
    const clear = evaluateHoldoutContamination("a completely unrelated synthetic contract describing bounded arithmetic verification and nothing else", state.manifest, "2026-01-02T00:00:00.000Z");
    expect(clear.disposition).toBe("clear");

    const stale = evaluateHoldoutContamination("unrelated", state.manifest, "2026-04-02T00:00:00.000Z");
    expect(stale.disposition).toBe("hold");

    const invalid = structuredClone(state.manifest);
    invalid.manifestHash = "0".repeat(64);
    expect(evaluateHoldoutContamination("unrelated", invalid, "2026-01-02T00:00:00.000Z").disposition).toBe("hold");
  });
});
