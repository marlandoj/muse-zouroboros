import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGovernanceArtifact,
  decideRubricPromotion,
  sha256,
  type GovernedCase,
} from "./dataset-governance";

const annotated = (id: string, source: string, expectedPass: boolean): GovernedCase => ({
  id,
  source_consensus_id: source,
  expected_pass: expectedPass,
  annotated_by: "reviewer@example.com",
  annotated_at: "2026-07-01T00:00:00.000Z",
  code: `case-${id}`,
});

describe("versioned reconciliation governance", () => {
  test("pins train, calibration, holdout, annotation, and rubric provenance", () => {
    const artifact = buildGovernanceArtifact({
      train: [annotated("t1", "trace-1", true)],
      calibration: [annotated("c1", "trace-2", false)],
      holdout: [annotated("h1", "trace-3", true)],
      versions: { train: "1.0.0", calibration: "2.0.0", holdout: "1.0.0" },
      sourceTraceIds: ["trace-1", "trace-2", "trace-3", "trace-4"],
      rubricVersion: "2.0.0-proposed",
      rubricContent: "rubric body",
      generatedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(artifact.manifests.holdout.immutable).toBe(true);
    expect(artifact.manifests.train.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.provenance).toHaveLength(3);
    expect(artifact.report.annotation_coverage).toBe(0.75);
    expect(artifact.report.oldest_annotation_days).toBe(10);
    const drifted = buildGovernanceArtifact({
      train: [annotated("t1", "trace-1", true), annotated("t2", "trace-5", false)],
      calibration: [annotated("c1", "trace-2", false)],
      holdout: [annotated("h1", "trace-3", true)],
      versions: { train: "1.1.0", calibration: "2.0.0", holdout: "1.0.0" },
      sourceTraceIds: ["trace-1", "trace-2", "trace-3", "trace-5"],
      rubricVersion: "2.0.0-proposed", rubricContent: "rubric body",
      generatedAt: "2026-07-11T00:00:00.000Z",
      previousManifests: artifact.manifests,
    });
    expect(drifted.report.manifests_drifted).toEqual(["train"]);
  });

  test("promotion is manual, evidence-bounded, and regression deterministic", () => {
    const cases = Array.from({ length: 20 }, (_, index) => annotated(`c${index}`, `trace-${index}`, index % 2 === 0));
    const holdout = cases.slice(0, 3).map((item, index) => ({ ...item, id: `h${index}` }));
    const governance = buildGovernanceArtifact({
      train: [], calibration: cases, holdout,
      versions: { train: "1.0.0", calibration: "2.1.0", holdout: "1.0.0" },
      sourceTraceIds: cases.map((item) => item.source_consensus_id!),
      rubricVersion: "2.0.0-proposed", rubricContent: "candidate rubric",
      generatedAt: "2026-07-11T00:00:00.000Z",
    });
    const evidence = {
      calibration: { samples: 20, baseline_accuracy: 0.8, candidate_accuracy: 0.85 },
      holdout: { samples: 3, baseline_accuracy: 0.67, candidate_accuracy: 0.67, content_sha256: governance.manifests.holdout.content_sha256 },
    };
    expect(decideRubricPromotion({ governance, evidence, human: { approved: false, reviewed_by: "", reviewed_at: "" } }).status).toBe("rejected");
    expect(decideRubricPromotion({ governance, evidence, human: { approved: true, reviewed_by: "Marlandoj", reviewed_at: "2026-07-11T01:00:00.000Z" } }).status).toBe("promoted");
    expect(decideRubricPromotion({
      governance,
      evidence: { ...evidence, calibration: { ...evidence.calibration, candidate_accuracy: 0.79 } },
      human: { approved: true, reviewed_by: "Marlandoj", reviewed_at: "2026-07-11T01:00:00.000Z" },
    }).reasons).toContain("calibration regression");
  });

  test("fixture-backed promotion evaluation never mutates the immutable holdout", () => {
    const source = join(import.meta.dir, "../data/calibration/reconciled-holdout.json");
    const tmp = mkdtempSync(join(tmpdir(), "governed-holdout-"));
    const copy = join(tmp, "holdout.json");
    writeFileSync(copy, readFileSync(source));
    const before = sha256(readFileSync(copy, "utf8"));
    const doc = JSON.parse(readFileSync(copy, "utf8")) as { cases: GovernedCase[] };
    const governance = buildGovernanceArtifact({
      train: [], calibration: [], holdout: doc.cases,
      versions: { train: "1.0.0", calibration: "1.0.0", holdout: "1.0.0" },
      sourceTraceIds: doc.cases.map((item) => item.source_consensus_id!).filter(Boolean),
      rubricVersion: "fixture", rubricContent: "fixture rubric",
      generatedAt: "2026-07-11T00:00:00.000Z",
    });
    decideRubricPromotion({
      governance,
      evidence: {
        calibration: { samples: 0, baseline_accuracy: 0, candidate_accuracy: 0 },
        holdout: { samples: doc.cases.length, baseline_accuracy: 1, candidate_accuracy: 1, content_sha256: governance.manifests.holdout.content_sha256 },
      },
      human: { approved: true, reviewed_by: "fixture", reviewed_at: "2026-07-11T01:00:00.000Z" },
    });
    expect(sha256(readFileSync(copy, "utf8"))).toBe(before);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("checked-in cohort manifest pins the current calibration and holdout fixtures", () => {
    const data = join(import.meta.dir, "../data/calibration");
    const baseline = JSON.parse(readFileSync(join(data, "cohort-manifests.v1.json"), "utf8"));
    const calibration = JSON.parse(readFileSync(join(data, "test-cases.json"), "utf8"));
    const holdout = JSON.parse(readFileSync(join(data, "reconciled-holdout.json"), "utf8"));
    const built = buildGovernanceArtifact({
      train: [], calibration: calibration.cases, holdout: holdout.cases,
      versions: { train: "1.0.0", calibration: calibration.version, holdout: holdout.version },
      sourceTraceIds: holdout.cases.map((item: GovernedCase) => item.source_consensus_id!),
      rubricVersion: baseline.rubric.version,
      rubricContent: readFileSync(join(import.meta.dir, "../data/prompt-versions/rubric.v1.md"), "utf8"),
      generatedAt: baseline.generated_at,
    });
    expect(built.manifests).toEqual(baseline.manifests);
    expect(built.rubric).toEqual(baseline.rubric);
    expect(built.provenance).toEqual(baseline.provenance);
  });
});
