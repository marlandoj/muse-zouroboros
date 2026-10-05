import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseActorSystemManifest } from "./actor-system-twin.ts";
import { buildSyntheticScenarioSourceQualification } from "./scenario-source-comparison-cohort.ts";
import { evaluateScenarioSourceComparison } from "./scenario-source-comparison-runner.ts";

const FIXTURE = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");

describe("scenario source synthetic qualification cohort", () => {
  test("derives the first ten sorted contracts across all three registered seeds", () => {
    const manifest = parseActorSystemManifest(JSON.parse(readFileSync(FIXTURE, "utf8")));
    const expectedIds = manifest.contracts.map((entry) => entry.id).sort().slice(0, 10);
    const { protocol, observations } = buildSyntheticScenarioSourceQualification(FIXTURE);
    expect(protocol.pairs).toHaveLength(30);
    expect(observations).toHaveLength(60);
    expect([...new Set(protocol.pairs.map((entry) => entry.pair_id.split(":")[0]))]).toEqual(expectedIds);
    expect([...new Set(protocol.pairs.map((entry) => entry.seed))]).toEqual([...manifest.replicateSeeds].sort((a, b) => a - b));
  });

  test("is deterministic and keeps synthetic review records claim-ineligible", () => {
    const first = buildSyntheticScenarioSourceQualification(FIXTURE);
    const second = buildSyntheticScenarioSourceQualification(FIXTURE);
    expect(first).toEqual(second);
    expect(first.protocol.evidence_class).toBe("synthetic_qualification");
    expect(first.protocol.pairs.every((entry) => entry.receipt_derived_lineage.review_evidence_kind === "simulated_fixture")).toBe(true);
    const summary = evaluateScenarioSourceComparison(first.protocol, first.observations);
    expect(summary.disposition).toBe("NULL_OR_NEGATIVE");
    expect(summary.reasons).toContain("synthetic qualification evidence is not eligible for a Phase D benefit claim");
    expect(summary.advisory_only).toBe(true);
    expect(summary.policy_mutations).toEqual([]);
  });
});
