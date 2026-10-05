#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type AssumptionRisk = "low" | "medium" | "high" | "forbidden";
export type AssumptionDecision = "retain" | "revise" | "remove" | "insufficient_data";

export interface HarnessAssumption {
  id: string;
  statement: string;
  owner: string;
  evidence: string[];
  model_generation: string;
  estimated_cost_usd: number;
  review_date: string;
  risk: AssumptionRisk;
  domains: string[];
}

export interface AssumptionRegistry {
  schema_version: 1;
  assumptions: HarnessAssumption[];
}

export interface AblationSample {
  quality: number;
  cost_usd: number;
  latency_ms: number;
  rework: boolean;
}

export interface AblationComparison {
  assumption_id: string;
  baseline_n: number;
  ablation_n: number;
  quality_delta: number | null;
  cost_delta_usd: number | null;
  latency_delta_ms: number | null;
  rework_rate_delta: number | null;
  decision: AssumptionDecision;
  rollback: string;
}

export const DEFAULT_ASSUMPTION_REGISTRY = join(import.meta.dir, "..", "harness-assumptions.json");
const FORBIDDEN_DOMAINS = new Set(["security", "permissions", "merge-policy"]);

export function validateRegistry(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["registry must be an object"];
  const registry = raw as AssumptionRegistry;
  if (registry.schema_version !== 1) errors.push("schema_version must be 1");
  if (!Array.isArray(registry.assumptions)) return [...errors, "assumptions must be an array"];
  const ids = new Set<string>();
  for (const [index, assumption] of registry.assumptions.entries()) {
    const prefix = `assumptions[${index}]`;
    if (!assumption.id || !/^[a-z0-9][a-z0-9-]*$/.test(assumption.id)) errors.push(`${prefix}.id invalid`);
    if (ids.has(assumption.id)) errors.push(`${prefix}.id duplicate`);
    ids.add(assumption.id);
    for (const field of ["statement", "owner", "model_generation", "review_date"] as const) {
      if (typeof assumption[field] !== "string" || assumption[field].trim() === "") errors.push(`${prefix}.${field} required`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(assumption.review_date) || Number.isNaN(Date.parse(`${assumption.review_date}T00:00:00Z`))) errors.push(`${prefix}.review_date must be YYYY-MM-DD`);
    if (!Array.isArray(assumption.evidence) || assumption.evidence.length === 0) errors.push(`${prefix}.evidence required`);
    if (!Array.isArray(assumption.domains) || assumption.domains.length === 0) errors.push(`${prefix}.domains required`);
    if (!["low", "medium", "high", "forbidden"].includes(assumption.risk)) errors.push(`${prefix}.risk invalid`);
    if (typeof assumption.estimated_cost_usd !== "number" || assumption.estimated_cost_usd < 0) errors.push(`${prefix}.estimated_cost_usd invalid`);
    if (assumption.domains.some((domain) => FORBIDDEN_DOMAINS.has(domain)) && assumption.risk !== "forbidden") {
      errors.push(`${prefix}.risk must be forbidden for security, permissions, or merge-policy`);
    }
  }
  return errors;
}

export function loadRegistry(path = DEFAULT_ASSUMPTION_REGISTRY): AssumptionRegistry {
  const registry = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateRegistry(registry);
  if (errors.length) throw new Error(`invalid harness assumption registry: ${errors.join("; ")}`);
  return registry as AssumptionRegistry;
}

export function registryHash(registry: AssumptionRegistry): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(registry)).digest("hex")}`;
}

export function staleAssumptions(registry: AssumptionRegistry, now = new Date()): HarnessAssumption[] {
  return registry.assumptions.filter((assumption) => Date.parse(`${assumption.review_date}T23:59:59Z`) < now.getTime());
}

export function selectShadowAblation(registry: AssumptionRegistry, now = new Date()): HarnessAssumption | null {
  return registry.assumptions
    .filter((assumption) => assumption.risk === "low" && !assumption.domains.some((domain) => FORBIDDEN_DOMAINS.has(domain)))
    .sort((a, b) => Date.parse(a.review_date) - Date.parse(b.review_date) || a.id.localeCompare(b.id))
    .find((assumption) => Date.parse(assumption.review_date) <= now.getTime()) ?? null;
}

function mean(samples: AblationSample[], pick: (sample: AblationSample) => number): number {
  return samples.reduce((sum, sample) => sum + pick(sample), 0) / samples.length;
}

export function compareAblation(
  assumption: HarnessAssumption,
  baseline: AblationSample[],
  ablation: AblationSample[],
  minSamples = 5,
): AblationComparison {
  if (!Number.isInteger(minSamples) || minSamples < 1) throw new Error("minSamples must be a positive integer");
  if (assumption.risk !== "low" || assumption.domains.some((domain) => FORBIDDEN_DOMAINS.has(domain))) {
    throw new Error(`assumption ${assumption.id} is not eligible for shadow ablation`);
  }
  const insufficient = baseline.length < minSamples || ablation.length < minSamples;
  const qualityDelta = insufficient ? null : mean(ablation, (s) => s.quality) - mean(baseline, (s) => s.quality);
  const costDelta = insufficient ? null : mean(ablation, (s) => s.cost_usd) - mean(baseline, (s) => s.cost_usd);
  const latencyDelta = insufficient ? null : mean(ablation, (s) => s.latency_ms) - mean(baseline, (s) => s.latency_ms);
  const reworkDelta = insufficient ? null : mean(ablation, (s) => Number(s.rework)) - mean(baseline, (s) => Number(s.rework));
  let decision: AssumptionDecision = "insufficient_data";
  if (!insufficient) {
    if ((qualityDelta ?? 0) < -0.02 || (reworkDelta ?? 0) > 0.05) decision = "retain";
    else if ((costDelta ?? 0) < 0 && (latencyDelta ?? 0) <= 0) decision = "remove";
    else decision = "revise";
  }
  return {
    assumption_id: assumption.id,
    baseline_n: baseline.length,
    ablation_n: ablation.length,
    quality_delta: qualityDelta,
    cost_delta_usd: costDelta,
    latency_delta_ms: latencyDelta,
    rework_rate_delta: reworkDelta,
    decision,
    rollback: `restore assumption ${assumption.id}; no production policy is changed by shadow evaluation`,
  };
}

if (import.meta.main) {
  const registry = loadRegistry(process.argv[2] || DEFAULT_ASSUMPTION_REGISTRY);
  const stale = staleAssumptions(registry);
  const candidate = selectShadowAblation(registry);
  console.log(JSON.stringify({ schema_version: 1, registry_hash: registryHash(registry), stale: stale.map((a) => a.id), shadow_candidate: candidate?.id ?? null }, null, 2));
  process.exit(stale.length > 0 ? 1 : 0);
}
