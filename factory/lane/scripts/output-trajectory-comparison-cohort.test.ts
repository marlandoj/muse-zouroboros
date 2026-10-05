import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseActorSystemManifest } from "./actor-system-twin.ts";
import { buildSyntheticOutputTrajectoryQualification } from "./output-trajectory-comparison-cohort.ts";
import { CASE_CLASSES } from "./output-trajectory-comparison-contract.ts";
import { evaluateOutputTrajectoryComparison } from "./output-trajectory-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("output trajectory synthetic qualification cohort", () => {
  test("derives the first ten sorted contracts across all three registered seeds", () => {
    const manifest = parseActorSystemManifest(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const expectedIds = manifest.contracts.map((entry) => entry.id).sort().slice(0, 10);
    const { protocol, observations } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    expect(protocol.pairs).toHaveLength(30);
    expect(observations).toHaveLength(60);
    expect([...new Set(protocol.pairs.map((entry) => entry.pair_id.split(":")[0]))]).toEqual(expectedIds);
    expect([...new Set(protocol.pairs.map((entry) => entry.seed))]).toEqual([...manifest.replicateSeeds].sort((a, b) => a - b));
  });

  test("covers all case classes exactly six times with two opaque cells each", () => {
    const { protocol, observations } = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    for (const caseClass of CASE_CLASSES) expect(protocol.pairs.filter((pair) => pair.case_class === caseClass)).toHaveLength(6);
    expect(new Set(protocol.pairs.flatMap((pair) => Object.values(pair.blind_ids))).size).toBe(60);
    expect(new Set(observations.map((entry) => entry.blind_id)).size).toBe(60);
  });

  test("is deterministic, prerecorded-only, advisory, and benefit-ineligible", () => {
    const first = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    const second = buildSyntheticOutputTrajectoryQualification(FIXTURE);
    expect(first).toEqual(second);
    expect(first.protocol.live_model_calls).toBe(0);
    const summary = evaluateOutputTrajectoryComparison(first.protocol, first.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.advisory_only).toBe(true);
    expect(summary.policy_mutations).toEqual([]);
  });
});
