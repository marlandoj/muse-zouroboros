import { describe, expect, test } from "bun:test";
import {
  CHANGE_QUIZ_MARKER,
  changeQuizRollout,
  evaluateChangeQuiz,
  extractChangeQuizAnswers,
  generateChangeQuiz,
  resolveChangeQuizMode,
  type ChangeQuizAnswers,
  type ChangeQuizArtifact,
  type SemanticGrader,
} from "./change-quiz";

const diff = [
  "diff --git a/scripts/example.ts b/scripts/example.ts",
  "index 1111111..2222222 100644",
  "--- a/scripts/example.ts",
  "+++ b/scripts/example.ts",
  "@@ -1,2 +1,4 @@",
  " export const unchanged = true;",
  "+export const FACTORY_CHANGE_QUIZ = process.env.FACTORY_CHANGE_QUIZ;",
  "+export function changed() { return true; }",
  "diff --git a/scripts/example.test.ts b/scripts/example.test.ts",
  "--- /dev/null",
  "+++ b/scripts/example.test.ts",
  "@@ -0,0 +1 @@",
  "+test('changed', () => expect(changed()).toBe(true));",
].join("\n");

const answers: ChangeQuizAnswers = {
  files_modified: ["scripts/example.test.ts", "scripts/example.ts"],
  primary_change: "Adds a flag-gated changed function and its regression test.",
  scope_not_changed: "The existing unchanged export and unrelated execution paths remain intact.",
  side_effects: "A malformed flag value could alter whether the new behavior is active.",
  control_flags: ["FACTORY_CHANGE_QUIZ"],
};

const passingGrader: SemanticGrader = async ({ questions }) => ({
  scores: Object.fromEntries(questions.map((question) => [question.id, 0.9])),
  model_id: "test-semantic-grader",
  cost_usd: 0.001,
});

describe("change quiz generation", () => {
  test("generates five weighted questions when the diff adds a factory flag", () => {
    const questions = generateChangeQuiz(diff);
    expect(questions).toHaveLength(5);
    expect(questions.map((question) => question.id)).toEqual([
      "files_modified",
      "primary_change",
      "scope_not_changed",
      "side_effects",
      "control_flags",
    ]);
    expect(questions[0].expected).toEqual(["scripts/example.test.ts", "scripts/example.ts"]);
    expect(questions.at(-1)?.expected).toEqual(["FACTORY_CHANGE_QUIZ"]);
    expect(questions.reduce((sum, question) => sum + question.weight, 0)).toBeCloseTo(1);
  });

  test("still generates four questions for an empty unified diff", () => {
    const questions = generateChangeQuiz("");
    expect(questions).toHaveLength(4);
    expect(questions[0].expected).toEqual([]);
    expect(questions.reduce((sum, question) => sum + question.weight, 0)).toBeCloseTo(1);
  });

  test("accounts for deleted and binary files from diff headers", () => {
    const questions = generateChangeQuiz([
      "diff --git a/old.ts b/old.ts",
      "--- a/old.ts",
      "+++ /dev/null",
      "-export const FACTORY_OLD_FLAG = true;",
      "diff --git a/image.png b/image.png",
      "Binary files a/image.png and b/image.png differ",
    ].join("\n"));
    expect(questions[0].expected).toEqual(["image.png", "old.ts"]);
    expect(questions.at(-1)?.expected).toEqual(["FACTORY_OLD_FLAG"]);
  });
});

describe("structured author answers", () => {
  test("extracts the single-line executor record and canonicalizes arrays", () => {
    const output = `${CHANGE_QUIZ_MARKER} ${JSON.stringify({
      ...answers,
      files_modified: [...answers.files_modified].reverse(),
    })}\nImplementation complete.`;
    expect(extractChangeQuizAnswers(output)).toEqual(answers);
  });

  test("rejects missing or malformed answer fields", () => {
    expect(extractChangeQuizAnswers("ordinary summary")).toBeNull();
    expect(extractChangeQuizAnswers(`${CHANGE_QUIZ_MARKER} {"files_modified":[]}`)).toBeNull();
  });
});

describe("change quiz scoring", () => {
  test("scores factual questions deterministically and semantic questions through the injected grader", async () => {
    const artifact = await evaluateChangeQuiz({
      execution_id: "exec-test",
      identifier: "ZOU-TEST",
      mode: "advisory",
      diff,
      task_description: "Add a flag-gated function.",
      answers,
      evaluated_at: "2026-08-10T00:00:00.000Z",
    }, passingGrader);
    expect(artifact.scores.files_modified).toBe(1);
    expect(artifact.scores.control_flags).toBe(1);
    expect(artifact.score).toBeCloseTo(0.95);
    expect(artifact.passed).toBe(true);
    expect(artifact.blocking).toBe(false);
    expect(artifact.grader_cost_usd).toBe(0.001);
  });

  test("wrong factual scope cannot be rescued by perfect semantic prose", async () => {
    const artifact = await evaluateChangeQuiz({
      execution_id: "exec-test",
      identifier: "ZOU-TEST",
      mode: "enforce",
      diff,
      task_description: "Add a flag-gated function.",
      answers: { ...answers, files_modified: ["scripts/example.ts"], control_flags: [] },
      evaluated_at: "2026-08-10T00:00:00.000Z",
    }, async ({ questions }) => ({
      scores: Object.fromEntries(questions.map((question) => [question.id, 1])),
      model_id: "test",
      cost_usd: null,
    }));
    expect(artifact.score).toBeCloseTo(0.5);
    expect(artifact.passed).toBe(false);
    expect(artifact.blocking).toBe(true);
  });

  test("missing answers and grader failures fail closed while retaining an artifact", async () => {
    const missing = await evaluateChangeQuiz({
      execution_id: "exec-missing",
      identifier: "ZOU-MISSING",
      mode: "advisory",
      diff,
      task_description: "test",
      answers: null,
      evaluated_at: "2026-08-10T00:00:00.000Z",
    }, passingGrader);
    expect(missing.passed).toBe(false);
    expect(missing.error).toContain("answers missing");

    const failed = await evaluateChangeQuiz({
      execution_id: "exec-failed",
      identifier: "ZOU-FAILED",
      mode: "enforce",
      diff,
      task_description: "test",
      answers,
      evaluated_at: "2026-08-10T00:00:00.000Z",
    }, async () => {
      throw new Error("grader unavailable");
    });
    expect(failed.passed).toBe(false);
    expect(failed.blocking).toBe(true);
    expect(failed.error).toBe("grader unavailable");
  });
});

describe("rollout policy", () => {
  function artifact(day: number, passed: boolean): ChangeQuizArtifact {
    return {
      schema_version: 1,
      execution_id: `exec-${day}`,
      identifier: `ZOU-${day}`,
      mode: "advisory",
      diff_sha256: "a".repeat(64),
      files_modified: ["file.ts"],
      questions: [],
      answers,
      scores: {},
      score: passed ? 0.9 : 0.2,
      threshold: 0.7,
      passed,
      blocking: false,
      grader_model: "test",
      grader_cost_usd: null,
      error: null,
      evaluated_at: `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    };
  }

  test("requires five elapsed days, five real samples, and a 0.7 pass rate", () => {
    const records = [artifact(1, true), artifact(2, true), artifact(3, true), artifact(4, true), artifact(5, false)];
    const early = changeQuizRollout(records, "2026-08-05T23:59:59.000Z");
    expect(early.eligible_for_enforcement).toBe(false);
    const mature = changeQuizRollout(records, "2026-08-06T00:00:00.000Z");
    expect(mature).toMatchObject({
      real_samples: 5,
      passed_samples: 4,
      pass_rate: 0.8,
      eligible_for_enforcement: true,
    });
  });

  test("counts a retried execution only once", () => {
    const retry = { ...artifact(1, false), evaluated_at: "2026-08-02T12:00:00.000Z" };
    const rollout = changeQuizRollout([artifact(1, true), retry], "2026-08-10T00:00:00.000Z");
    expect(rollout).toMatchObject({ real_samples: 1, passed_samples: 0, pass_rate: 0 });
  });
});

describe("flag resolution", () => {
  test("defaults to advisory and keeps enforcement separately gated", () => {
    expect(resolveChangeQuizMode({})).toBe("advisory");
    expect(resolveChangeQuizMode({ FACTORY_CHANGE_QUIZ: "off" })).toBe("off");
    expect(resolveChangeQuizMode({ FACTORY_CHANGE_QUIZ: "on", FACTORY_CHANGE_QUIZ_ENFORCE: "1" })).toBe("enforce");
    expect(() => resolveChangeQuizMode({ FACTORY_CHANGE_QUIZ: "maybe" })).toThrow("off|advisory|enforce");
  });
});
