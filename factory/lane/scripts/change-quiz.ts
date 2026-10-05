import { createHash } from "node:crypto";

export const CHANGE_QUIZ_MARKER = "CHANGE_QUIZ_ANSWERS_JSON:";
export const DEFAULT_CHANGE_QUIZ_THRESHOLD = 0.7;
export const CHANGE_QUIZ_ADVISORY_DAYS = 5;
export const CHANGE_QUIZ_MIN_REAL_SAMPLES = 5;

export type ChangeQuizMode = "off" | "advisory" | "enforce";
export type ChangeQuizQuestionKind = "factual" | "semantic";

export interface ChangeQuizAnswers {
  files_modified: string[];
  primary_change: string;
  scope_not_changed: string;
  side_effects: string;
  control_flags: string[];
}

export interface ChangeQuizQuestion {
  id: "files_modified" | "primary_change" | "scope_not_changed" | "side_effects" | "control_flags";
  kind: ChangeQuizQuestionKind;
  prompt: string;
  weight: number;
  expected: string[] | null;
}

export interface SemanticGrade {
  scores: Record<string, number>;
  model_id: string;
  cost_usd: number | null;
}

export interface SemanticGradeInput {
  task_description: string;
  diff: string;
  questions: ChangeQuizQuestion[];
  answers: ChangeQuizAnswers;
}

export type SemanticGrader = (input: SemanticGradeInput) => Promise<SemanticGrade>;

export interface ChangeQuizArtifact {
  schema_version: 1;
  execution_id: string;
  identifier: string;
  mode: Exclude<ChangeQuizMode, "off">;
  diff_sha256: string;
  files_modified: string[];
  questions: ChangeQuizQuestion[];
  answers: ChangeQuizAnswers | null;
  scores: Record<string, number>;
  score: number;
  threshold: number;
  passed: boolean;
  blocking: boolean;
  grader_model: string | null;
  grader_cost_usd: number | null;
  error: string | null;
  evaluated_at: string;
}

export interface ChangeQuizRollout {
  advisory_started_at: string | null;
  advisory_age_days: number;
  real_samples: number;
  passed_samples: number;
  pass_rate: number | null;
  eligible_for_enforcement: boolean;
  reasons: string[];
}

interface ParsedDiff {
  files: string[];
  key_file: string | null;
  control_flags: string[];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeDiffPath(value: string): string | null {
  let path = value.trim();
  if (!path || path === "/dev/null") return null;
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      path = path.slice(1, -1);
    }
  }
  return path.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(diff: string): ParsedDiff {
  const files: string[] = [];
  const changedLines = new Map<string, number>();
  const flags = new Set<string>();
  let currentFile: string | null = null;
  let oldFile: string | null = null;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      currentFile = normalizeDiffPath(match?.[2] ?? "");
      oldFile = normalizeDiffPath(match?.[1] ?? "");
      if (currentFile ?? oldFile) files.push((currentFile ?? oldFile)!);
      continue;
    }
    if (line.startsWith("--- ")) {
      oldFile = normalizeDiffPath(line.slice(4).split("\t", 1)[0]);
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile = normalizeDiffPath(line.slice(4).split("\t", 1)[0]) ?? oldFile;
      if (currentFile) files.push(currentFile);
      continue;
    }
    if (!currentFile || line.startsWith("+++")) continue;
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("---")) {
      changedLines.set(currentFile, (changedLines.get(currentFile) ?? 0) + 1);
    }
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      for (const match of line.matchAll(/\bFACTORY_[A-Z0-9_]+\b/g)) flags.add(match[0]);
    }
  }

  const sortedFiles = uniqueSorted(files);
  const keyFile = [...changedLines.entries()]
    .sort(([fileA, countA], [fileB, countB]) => countB - countA || fileA.localeCompare(fileB))[0]?.[0]
    ?? sortedFiles[0]
    ?? null;
  return { files: sortedFiles, key_file: keyFile, control_flags: [...flags].sort() };
}

export function resolveChangeQuizMode(
  env: Record<string, string | undefined> = process.env,
): ChangeQuizMode {
  const raw = (env.FACTORY_CHANGE_QUIZ ?? "advisory").trim().toLowerCase();
  if (["off", "0", "false"].includes(raw)) return "off";
  if (!["on", "1", "true", "advisory", "enforce"].includes(raw)) {
    throw new Error(`FACTORY_CHANGE_QUIZ must be off|advisory|enforce, got ${raw}`);
  }
  const enforce = (env.FACTORY_CHANGE_QUIZ_ENFORCE ?? "0").trim().toLowerCase();
  if (!["0", "1", "false", "true", "off", "on"].includes(enforce)) {
    throw new Error(`FACTORY_CHANGE_QUIZ_ENFORCE must be 0|1, got ${enforce}`);
  }
  return raw === "enforce" || ["1", "true", "on"].includes(enforce) ? "enforce" : "advisory";
}

export function generateChangeQuiz(diff: string): ChangeQuizQuestion[] {
  const parsed = parseUnifiedDiff(diff);
  const semanticWeight = parsed.control_flags.length > 0 ? 1 / 6 : 0.2;
  const keyFile = parsed.key_file ?? "the primary changed file";
  const questions: ChangeQuizQuestion[] = [
    {
      id: "files_modified",
      kind: "factual",
      prompt: "Which repository-relative files were modified?",
      weight: 0.4,
      expected: parsed.files,
    },
    {
      id: "primary_change",
      kind: "semantic",
      prompt: `What is the primary behavioral change in ${keyFile}?`,
      weight: semanticWeight,
      expected: null,
    },
    {
      id: "scope_not_changed",
      kind: "semantic",
      prompt: "What adjacent behavior was intentionally left unchanged?",
      weight: semanticWeight,
      expected: null,
    },
    {
      id: "side_effects",
      kind: "semantic",
      prompt: "What could break or regress as a side effect of this diff?",
      weight: semanticWeight,
      expected: null,
    },
  ];
  if (parsed.control_flags.length > 0) {
    questions.push({
      id: "control_flags",
      kind: "factual",
      prompt: "Which factory flags control behavior introduced or changed by this diff?",
      weight: 0.1,
      expected: parsed.control_flags,
    });
  }
  return questions;
}

function jsonObjectAfterMarker(value: string, marker: string): Record<string, unknown> | null {
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = value.indexOf("{", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(value.slice(start, index + 1)) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function extractChangeQuizAnswers(value: string): ChangeQuizAnswers | null {
  const raw = jsonObjectAfterMarker(value, CHANGE_QUIZ_MARKER);
  if (!raw) return null;
  const strings = (key: string): string[] | null => Array.isArray(raw[key])
    && raw[key].every((item) => typeof item === "string")
    ? uniqueSorted(raw[key] as string[])
    : null;
  const text = (key: string): string | null => typeof raw[key] === "string" && raw[key].trim()
    ? raw[key].trim()
    : null;
  const files = strings("files_modified");
  const flags = strings("control_flags");
  const primary = text("primary_change");
  const scope = text("scope_not_changed");
  const sideEffects = text("side_effects");
  if (!files || !flags || !primary || !scope || !sideEffects) return null;
  return {
    files_modified: files,
    primary_change: primary,
    scope_not_changed: scope,
    side_effects: sideEffects,
    control_flags: flags,
  };
}

export function changeQuizAnswerInstructions(): string[] {
  return [
    "Before any prose response, emit exactly one single-line author-comprehension record:",
    `${CHANGE_QUIZ_MARKER} {"files_modified":["<exact repo-relative path>"],"primary_change":"<what behavior changed>","scope_not_changed":"<adjacent behavior intentionally unchanged>","side_effects":"<credible regression risk>","control_flags":["<exact FACTORY_* flag, or empty>"]}`,
    "Ground this record in the final on-disk diff. Do not copy the ticket wording when the implementation differs.",
  ];
}

function exactSetScore(actual: string[], expected: string[]): number {
  const left = uniqueSorted(actual);
  const right = uniqueSorted(expected);
  return left.length === right.length && left.every((value, index) => value === right[index]) ? 1 : 0;
}

function boundedScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

export async function evaluateChangeQuiz(input: {
  execution_id: string;
  identifier: string;
  mode: Exclude<ChangeQuizMode, "off">;
  diff: string;
  task_description: string;
  answers: ChangeQuizAnswers | null;
  threshold?: number;
  evaluated_at: string;
}, grader: SemanticGrader): Promise<ChangeQuizArtifact> {
  const threshold = input.threshold ?? DEFAULT_CHANGE_QUIZ_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`change-quiz threshold must be between 0 and 1, got ${threshold}`);
  }
  const questions = generateChangeQuiz(input.diff);
  const parsed = parseUnifiedDiff(input.diff);
  const scores: Record<string, number> = {};
  let grade: SemanticGrade | null = null;
  let error: string | null = null;

  if (input.answers) {
    scores.files_modified = exactSetScore(input.answers.files_modified, parsed.files);
    if (parsed.control_flags.length > 0) {
      scores.control_flags = exactSetScore(input.answers.control_flags, parsed.control_flags);
    }
    try {
      grade = await grader({
        task_description: input.task_description,
        diff: input.diff,
        questions: questions.filter((question) => question.kind === "semantic"),
        answers: input.answers,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  } else {
    error = "structured executor answers missing or invalid";
  }

  for (const question of questions) {
    if (question.kind === "semantic") scores[question.id] = boundedScore(grade?.scores[question.id]);
  }
  const score = questions.reduce((total, question) => total + question.weight * (scores[question.id] ?? 0), 0);
  const rounded = Math.round(score * 10_000) / 10_000;
  const passed = input.answers !== null && error === null && rounded >= threshold;
  return {
    schema_version: 1,
    execution_id: input.execution_id,
    identifier: input.identifier,
    mode: input.mode,
    diff_sha256: createHash("sha256").update(input.diff).digest("hex"),
    files_modified: parsed.files,
    questions,
    answers: input.answers,
    scores,
    score: rounded,
    threshold,
    passed,
    blocking: input.mode === "enforce" && !passed,
    grader_model: grade?.model_id ?? null,
    grader_cost_usd: grade?.cost_usd ?? null,
    error,
    evaluated_at: input.evaluated_at,
  };
}

export function changeQuizRollout(
  artifacts: ChangeQuizArtifact[],
  now: string,
): ChangeQuizRollout {
  const latestByExecution = new Map<string, ChangeQuizArtifact>();
  for (const artifact of artifacts) {
    const current = latestByExecution.get(artifact.execution_id);
    if (!current || current.evaluated_at <= artifact.evaluated_at) latestByExecution.set(artifact.execution_id, artifact);
  }
  const real = [...latestByExecution.values()]
    .filter((artifact) => artifact.mode === "advisory" && artifact.files_modified.length > 0)
    .sort((a, b) => a.evaluated_at.localeCompare(b.evaluated_at));
  const started = real[0]?.evaluated_at ?? null;
  const nowMs = Date.parse(now);
  const startedMs = started ? Date.parse(started) : Number.NaN;
  const ageDays = Number.isFinite(nowMs) && Number.isFinite(startedMs)
    ? Math.max(0, (nowMs - startedMs) / 86_400_000)
    : 0;
  const passed = real.filter((artifact) => artifact.passed).length;
  const passRate = real.length > 0 ? passed / real.length : null;
  const reasons: string[] = [];
  if (ageDays < CHANGE_QUIZ_ADVISORY_DAYS) reasons.push(`advisory age ${ageDays.toFixed(2)}d < ${CHANGE_QUIZ_ADVISORY_DAYS}d`);
  if (real.length < CHANGE_QUIZ_MIN_REAL_SAMPLES) reasons.push(`real samples ${real.length} < ${CHANGE_QUIZ_MIN_REAL_SAMPLES}`);
  if (passRate === null || passRate < DEFAULT_CHANGE_QUIZ_THRESHOLD) {
    reasons.push(`pass rate ${passRate === null ? "unavailable" : passRate.toFixed(3)} < ${DEFAULT_CHANGE_QUIZ_THRESHOLD}`);
  }
  return {
    advisory_started_at: started,
    advisory_age_days: Math.round(ageDays * 100) / 100,
    real_samples: real.length,
    passed_samples: passed,
    pass_rate: passRate === null ? null : Math.round(passRate * 10_000) / 10_000,
    eligible_for_enforcement: reasons.length === 0,
    reasons,
  };
}
