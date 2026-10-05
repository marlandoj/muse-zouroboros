import { createHash } from "node:crypto";

export type HoldoutMode = "off" | "shadow" | "enforce";

export interface HoldoutScenario {
  id: string;
  expect: string;
  rationale: string;
  weight: number;
}

export interface CriterionOutcome {
  id: string;
  passed: boolean;
  weight: number;
}

export interface HoldoutEvaluation {
  schema_version: 1;
  mode: HoldoutMode;
  public_score: number;
  holdout_score: number | null;
  combined_score: number;
  threshold: number;
  would_pass: boolean;
  enforced: boolean;
  holdout_count: number;
  holdout_digest: string;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function parseHoldoutScenarios(value: unknown, source: string): HoldoutScenario[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`holdout_scenarios must be an array: ${source}`);
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`holdout_scenarios[${index}] must be an object: ${source}`);
    const raw = entry as Record<string, unknown>;
    const id = nonEmpty(raw.id, `holdout_scenarios[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate holdout scenario ${id}: ${source}`);
    ids.add(id);
    const weight = raw.weight === undefined ? 0.5 : Number(raw.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new Error(`holdout scenario ${id} weight must be in (0,1]: ${source}`);
    }
    return {
      id,
      expect: nonEmpty(raw.expect, `holdout scenario ${id}.expect`),
      rationale: nonEmpty(raw.rationale, `holdout scenario ${id}.rationale`),
      weight,
    };
  });
}

function weightedScore(outcomes: CriterionOutcome[]): number {
  if (outcomes.length === 0) return 0;
  const denominator = outcomes.reduce((sum, item) => sum + item.weight, 0);
  return outcomes.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0) / denominator;
}

export function evaluateHoldouts(input: {
  mode?: HoldoutMode;
  publicOutcomes: CriterionOutcome[];
  holdoutOutcomes: CriterionOutcome[];
  holdouts: HoldoutScenario[];
  threshold?: number;
}): HoldoutEvaluation {
  const mode = input.mode ?? "off";
  const threshold = input.threshold ?? 0.8;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error("holdout threshold must be in (0,1]");
  const publicScore = weightedScore(input.publicOutcomes);
  const holdoutScore = input.holdoutOutcomes.length === 0 ? null : weightedScore(input.holdoutOutcomes);
  const combined = weightedScore([...input.publicOutcomes, ...input.holdoutOutcomes]);
  const digest = createHash("sha256").update(JSON.stringify(input.holdouts)).digest("hex");
  return {
    schema_version: 1,
    mode,
    public_score: publicScore,
    holdout_score: holdoutScore,
    combined_score: combined,
    threshold,
    would_pass: input.holdouts.length > 0 && input.holdoutOutcomes.length === input.holdouts.length && combined >= threshold,
    enforced: mode === "enforce",
    holdout_count: input.holdouts.length,
    holdout_digest: digest,
  };
}
