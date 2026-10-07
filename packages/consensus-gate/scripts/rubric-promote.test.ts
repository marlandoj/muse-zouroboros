import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGovernanceArtifact } from "./dataset-governance";

const tmpPaths: string[] = [];

describe("rubric-promote CLI", () => {
  afterEach(() => {
    for (const path of tmpPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test("requires explicit approval, then emits a promoted immutable rubric artifact", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rubric-promote-"));
    tmpPaths.push(tmp);
    const proposed = join(tmp, "rubric.v2.proposed.md");
    writeFileSync(proposed, "candidate rubric\n");
    const cases = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`, source_consensus_id: `trace-${index}`, expected_pass: true,
      annotated_by: "human", annotated_at: "2026-07-01T00:00:00.000Z",
    }));
    const governance = buildGovernanceArtifact({
      train: [], calibration: cases, holdout: cases.slice(0, 3),
      versions: { train: "1.0.0", calibration: "1.0.0", holdout: "1.0.0" },
      sourceTraceIds: cases.map((item) => item.source_consensus_id),
      rubricVersion: "2.0.0-proposed", rubricContent: "candidate rubric\n",
      generatedAt: "2026-07-11T00:00:00.000Z",
    });
    const request = join(tmp, "request.json");
    const evidence = join(tmp, "evidence.json");
    writeFileSync(request, JSON.stringify({ governance, proposed_rubric_path: proposed }));
    writeFileSync(evidence, JSON.stringify({
      calibration: { samples: 20, baseline_accuracy: 0.8, candidate_accuracy: 0.81 },
      holdout: { samples: 3, baseline_accuracy: 0.67, candidate_accuracy: 0.67, content_sha256: governance.manifests.holdout.content_sha256 },
    }));

    const rejected = Bun.spawnSync(["bun", join(import.meta.dir, "rubric-promote.ts"), "--request", request, "--evidence", evidence, "--by", "Marlandoj"]);
    expect(rejected.exitCode).toBe(1);
    expect(existsSync(join(tmp, "rubric.v2.promoted.md"))).toBe(false);

    const promoted = Bun.spawnSync(["bun", join(import.meta.dir, "rubric-promote.ts"), "--request", request, "--evidence", evidence, "--by", "Marlandoj", "--approve"]);
    expect(promoted.exitCode).toBe(0);
    expect(readFileSync(join(tmp, "rubric.v2.promoted.md"), "utf8")).toBe("candidate rubric\n");

    writeFileSync(proposed, "tampered rubric\n");
    const tampered = Bun.spawnSync(["bun", join(import.meta.dir, "rubric-promote.ts"), "--request", request, "--evidence", evidence, "--by", "Marlandoj", "--approve"]);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.stderr.toString()).toContain("proposed rubric hash mismatch");
  });
});
