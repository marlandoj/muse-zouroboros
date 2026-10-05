import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseActorSystemManifest } from "./actor-system-twin.ts";
import { buildSyntheticSilentSuccessQualification } from "./silent-success-comparison-cohort.ts";
import { FAILURE_CLASSES } from "./silent-success-comparison-contract.ts";
import { evaluateSilentSuccessComparison } from "./silent-success-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("silent-success synthetic qualification cohort", () => {
  test("derives the first ten sorted contracts across all three registered seeds", () => {
    const manifest = parseActorSystemManifest(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const expectedIds = manifest.contracts.map((entry) => entry.id).sort().slice(0, 10);
    const { protocol, observations } = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(protocol.pairs).toHaveLength(30);
    expect(observations).toHaveLength(90);
    expect([...new Set(protocol.pairs.map((entry) => entry.pair_id.split(":")[0]))]).toEqual(expectedIds);
    expect([...new Set(protocol.pairs.map((entry) => entry.seed))]).toEqual([...manifest.replicateSeeds].sort((a, b) => a - b));
  });

  test("covers all nine failure classes at the exact preregistered counts", () => {
    const { protocol, observations } = buildSyntheticSilentSuccessQualification(FIXTURE);
    for (const [index, failureClass] of FAILURE_CLASSES.entries()) {
      expect(protocol.pairs.filter((pair) => pair.failure_class === failureClass)).toHaveLength(index < 3 ? 4 : 3);
    }
    expect(new Set(protocol.pairs.flatMap((pair) => Object.values(pair.blind_ids))).size).toBe(90);
    expect(new Set(observations.map((entry) => entry.blind_id)).size).toBe(90);
    expect(protocol.pairs.every((pair) => pair.incident_input_sha256 !== pair.matched_control_sha256)).toBe(true);
  });

  test("is deterministic, prerecorded-only, advisory, redacted, and benefit-ineligible", () => {
    const first = buildSyntheticSilentSuccessQualification(FIXTURE);
    const second = buildSyntheticSilentSuccessQualification(FIXTURE);
    expect(second).toEqual(first);
    expect(first.protocol.live_system_calls).toBe(0);
    expect(first.observations.every((entry) => entry.redaction_valid && entry.redaction_manifest_sha256.length === 64)).toBe(true);
    const summary = evaluateSilentSuccessComparison(first.protocol, first.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.advisory_only).toBe(true);
    expect(summary.policy_mutations).toEqual([]);
  });
});
