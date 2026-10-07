import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadZourobenchEvidence } from "./zourobench-lineup-evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zourobench-lineup-"));
  roots.push(root);
  return root;
}

function artifact(input: {
  runId: string;
  model: string;
  cohortId: string;
  index: number;
  timestamp?: string;
  minimumN?: number;
  overall?: number;
  procedural?: number;
  transfer?: number;
  swarm?: number;
  questionSet?: string;
  answered?: number;
}) {
  return {
    schema_version: 2,
    run: {
      run_id: input.runId,
      benchmark: "ZouroBench",
      timestamp: input.timestamp ?? `2026-08-0${input.index}T00:00:00.000Z`,
    },
    cohort: {
      cohort_id: input.cohortId,
      replicate_index: input.index,
      replicate_seed: input.index,
      minimum_n: input.minimumN ?? 5,
    },
    provenance: {
      adapter_version: "2.0.0",
      dataset_sha256: "sha256:dataset",
      question_set_sha256: input.questionSet ?? "sha256:questions-a",
    },
    execution: {
      answer_model: input.model,
      judge_model: { value: "gpt-judge", availability_reason: null },
      embedding_model: { value: "embedding", availability_reason: null },
      truncation_guard_enabled: true,
      generation_timeout_ms: { value: 60_000, availability_reason: null },
      max_tokens: 512,
    },
    totals: { total_questions: 54, answered: input.answered ?? 54 },
    scores: {
      overall_accuracy: input.overall ?? 90,
      by_category: {
        "procedural-recall": { correct: 1, total: 1, accuracy: input.procedural ?? 90 },
        "cross-persona-transfer": { correct: 1, total: 1, accuracy: input.transfer ?? 80 },
        "swarm-context-propagation": { correct: 1, total: 1, accuracy: input.swarm ?? 100 },
      },
    },
  };
}

function writeCohort(root: string, input: {
  model: string;
  cohortId: string;
  scores?: number[];
  minimumN?: number;
  questionSet?: string;
  timestamp?: string;
}): void {
  const scores = input.scores ?? [90, 91, 92, 93, 94];
  scores.forEach((score, offset) => {
    const index = offset + 1;
    fs.writeFileSync(path.join(root, `ZouroBench-${input.cohortId}-r${index}.json`), JSON.stringify(artifact({
      runId: `${input.cohortId}-${index}`,
      model: input.model,
      cohortId: input.cohortId,
      index,
      minimumN: input.minimumN,
      overall: score,
      procedural: score,
      transfer: score - 5,
      swarm: score + 5,
      questionSet: input.questionSet,
      timestamp: input.timestamp,
    })));
  });
}

describe("ZouroBench lineup evidence", () => {
  test("qualifies a fresh publishable cohort and derives proposer and aggregator scores", () => {
    const root = tempRoot();
    writeCohort(root, { model: "kimi:kimi-k3", cohortId: "kimi", scores: [90, 92, 94, 96, 98] });

    const evidence = loadZourobenchEvidence({ roots: [root], now: new Date("2026-08-06T00:00:00Z") });
    const model = evidence.byCanonicalModel.get("kimi-k3");

    expect(evidence.summary).toMatchObject({
      scannedFiles: 5,
      parsedRuns: 5,
      deduplicatedRuns: 5,
      qualifiedCohorts: 1,
      qualifiedModels: 1,
      underpoweredCohorts: 0,
      staleCohorts: 0,
      unsupportedRoles: ["coder"],
    });
    expect(model).toMatchObject({
      canonicalModel: "kimi-k3",
      family: "kimi",
      replicates: 5,
      requiredReplicates: 5,
    });
    expect(model?.roles.proposer?.mean).toBe(94);
    expect(model?.roles.aggregator?.mean).toBe(94);
    expect(model?.roles.coder).toBeUndefined();
    expect(model?.roles.proposer!.selectionFloor).toBeLessThan(model?.roles.proposer!.mean ?? 0);
  });

  test("holds underpowered and incomplete cohorts out of ranking", () => {
    const root = tempRoot();
    writeCohort(root, { model: "byok:fable", cohortId: "fable", scores: [99], minimumN: 5 });
    fs.writeFileSync(path.join(root, "ZouroBench-incomplete.json"), JSON.stringify(artifact({
      runId: "incomplete",
      model: "or:test/incomplete",
      cohortId: "incomplete",
      index: 1,
      minimumN: 1,
      answered: 53,
    })));

    const evidence = loadZourobenchEvidence({ roots: [root], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary.underpoweredCohorts).toBe(1);
    expect(evidence.summary.parsedRuns).toBe(1);
    expect(evidence.summary.qualifiedModels).toBe(0);
  });

  test("deduplicates copied artifacts by run id", () => {
    const first = tempRoot();
    const second = tempRoot();
    writeCohort(first, { model: "kimi:kimi-k3", cohortId: "kimi" });
    for (const file of fs.readdirSync(first)) fs.copyFileSync(path.join(first, file), path.join(second, file));

    const evidence = loadZourobenchEvidence({ roots: [first, second], now: new Date("2026-08-06T00:00:00Z") });
    expect(evidence.summary).toMatchObject({ scannedFiles: 10, parsedRuns: 10, deduplicatedRuns: 5, qualifiedModels: 1 });
  });

  test("excludes stale cohorts", () => {
    const root = tempRoot();
    writeCohort(root, {
      model: "kimi:kimi-k3",
      cohortId: "old",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const evidence = loadZourobenchEvidence({ roots: [root], now: new Date("2026-08-06T00:00:00Z"), maxAgeDays: 30 });
    expect(evidence.summary).toMatchObject({ staleCohorts: 1, qualifiedModels: 0 });
  });

  test("selects the comparable context covering the most distinct models", () => {
    const root = tempRoot();
    writeCohort(root, { model: "kimi:kimi-k3", cohortId: "kimi-a", questionSet: "sha256:a" });
    writeCohort(root, { model: "or:z-ai/glm-5.2", cohortId: "glm-a", questionSet: "sha256:a" });
    writeCohort(root, { model: "or:deepseek/deepseek-r1", cohortId: "deepseek-b", questionSet: "sha256:b" });

    const evidence = loadZourobenchEvidence({ roots: [root], now: new Date("2026-08-06T00:00:00Z") });
    expect([...evidence.byCanonicalModel.keys()].sort()).toEqual(["glm-5.2", "kimi-k3"]);
    expect(evidence.summary).toMatchObject({ qualifiedCohorts: 2, qualifiedModels: 2, incomparableCohorts: 1 });
  });
});
