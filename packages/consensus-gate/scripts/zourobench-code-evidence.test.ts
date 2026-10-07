import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadZourobenchCodeEvidence } from "./zourobench-code-evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "zbc-evidence-"));
  roots.push(value);
  return value;
}

const categories = ["bug-fix", "feature", "integration", "refactor", "test-creation"];

function artifact(fold: number, options: { sandbox?: "bubblewrap" | "fixture"; manifest?: string } = {}) {
  const tasks = Array.from({ length: 4 }, (_, offset) => {
    const index = (fold - 1) * 4 + offset;
    return {
      taskId: `task-${index + 1}`,
      category: categories[index % categories.length],
      status: "pass",
      executorSuccess: true,
      scores: { overall: 80 + fold },
    };
  });
  return {
    schema_version: 1,
    run: { run_id: `run-${fold}`, benchmark: "ZouroBench-Code", timestamp: `2026-08-0${fold}T00:00:00.000Z`, shadow_only: true },
    cohort: { cohort_id: "cohort-a", fold_index: fold, fold_seed: 1000 + fold, minimum_folds: 5 },
    provenance: { harness_version: "1.0.0", corpus_version: "v1", manifest_sha256: options.manifest ?? "sha256:manifest" },
    execution: { model: "or:z-ai/glm-5.2", executor: "opencode", sandbox: options.sandbox ?? "bubblewrap" },
    totals: { tasks: 4, passed: 4, failed: 0 },
    scores: { overall: 80 + fold },
    tasks,
  };
}

function writeFold(directory: string, fold: number, options: { sandbox?: "bubblewrap" | "fixture"; manifest?: string } = {}): void {
  fs.writeFileSync(path.join(directory, `ZouroBench-Code-f${fold}.json`), JSON.stringify(artifact(fold, options)));
}

describe("ZouroBench Code shadow evidence", () => {
  test("qualifies one fresh complete five-fold cohort", () => {
    const directory = root();
    for (let fold = 1; fold <= 5; fold++) writeFold(directory, fold);
    const evidence = loadZourobenchCodeEvidence({ roots: [directory], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary).toMatchObject({
      shadowOnly: true,
      reachableFromProductionRanking: false,
      parsedRuns: 5,
      qualifiedModels: 1,
      underpoweredCohorts: 0,
    });
    const model = evidence.byCanonicalModel.get("glm-5.2");
    expect(model).toMatchObject({ executor: "opencode", folds: 5, tasks: 20, shadowOnly: true });
    expect(model?.coder.mean).toBe(83);
  });

  test("holds incomplete cohorts out of evidence", () => {
    const directory = root();
    for (let fold = 1; fold <= 4; fold++) writeFold(directory, fold);
    const evidence = loadZourobenchCodeEvidence({ roots: [directory], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary).toMatchObject({ qualifiedModels: 0, underpoweredCohorts: 1 });
  });

  test("excludes fixture controls from publishable shadow evidence", () => {
    const directory = root();
    for (let fold = 1; fold <= 5; fold++) writeFold(directory, fold, { sandbox: "fixture" });
    const evidence = loadZourobenchCodeEvidence({ roots: [directory], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary).toMatchObject({ fixtureArtifacts: 5, parsedRuns: 0, qualifiedModels: 0 });
  });

  test("rejects mixed corpus fingerprints within a cohort", () => {
    const directory = root();
    for (let fold = 1; fold <= 5; fold++) writeFold(directory, fold, { manifest: fold === 5 ? "sha256:other" : "sha256:manifest" });
    const evidence = loadZourobenchCodeEvidence({ roots: [directory], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary).toMatchObject({ qualifiedModels: 0, underpoweredCohorts: 1 });
  });

  test("rejects artifacts containing executor failures", () => {
    const directory = root();
    for (let fold = 1; fold <= 5; fold++) {
      const value = artifact(fold);
      if (fold === 3) value.tasks[0]!.executorSuccess = false;
      fs.writeFileSync(path.join(directory, `ZouroBench-Code-f${fold}.json`), JSON.stringify(value));
    }
    const evidence = loadZourobenchCodeEvidence({ roots: [directory], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary).toMatchObject({ parsedRuns: 4, qualifiedModels: 0, underpoweredCohorts: 1 });
  });
});
