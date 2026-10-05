#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  compareAblation,
  loadRegistry,
  registryHash,
  selectShadowAblation,
  type AblationComparison,
  type AblationSample,
} from "./harness-assumptions";

export interface HarnessAblationRecord extends AblationComparison {
  schema_version: 1;
  registry_hash: string;
  evaluated_at: string;
  mode: "shadow";
  production_policy_changed: false;
}

export const DEFAULT_ABLATION_LEDGER = factoryStatePath("harness-ablation-ledger.jsonl");

function parseSamples(path: string): AblationSample[] {
  if (!existsSync(path)) throw new Error(`sample file missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`sample file must contain an array: ${path}`);
  for (const [index, sample] of parsed.entries()) {
    if (!sample || typeof sample !== "object" || typeof sample.quality !== "number" || !Number.isFinite(sample.quality) || sample.quality < 0 || sample.quality > 1 || typeof sample.cost_usd !== "number" || !Number.isFinite(sample.cost_usd) || sample.cost_usd < 0 || typeof sample.latency_ms !== "number" || !Number.isFinite(sample.latency_ms) || sample.latency_ms < 0 || typeof sample.rework !== "boolean") {
      throw new Error(`invalid sample at ${path}[${index}]`);
    }
  }
  return parsed as AblationSample[];
}

export function evaluateShadowAblation(input: {
  assumption_id: string;
  baseline: AblationSample[];
  ablation: AblationSample[];
  min_samples?: number;
  now?: string;
  ledger_path?: string;
}): HarnessAblationRecord {
  const registry = loadRegistry();
  const assumption = registry.assumptions.find((candidate) => candidate.id === input.assumption_id);
  if (!assumption) throw new Error(`unknown harness assumption: ${input.assumption_id}`);
  const compared = compareAblation(assumption, input.baseline, input.ablation, input.min_samples);
  const record: HarnessAblationRecord = {
    schema_version: 1,
    ...compared,
    registry_hash: registryHash(registry),
    evaluated_at: input.now ?? new Date().toISOString(),
    mode: "shadow",
    production_policy_changed: false,
  };
  const ledger = input.ledger_path ?? DEFAULT_ABLATION_LEDGER;
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify(record)}\n`);
  return record;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      assumption: { type: "string" }, baseline: { type: "string" }, ablation: { type: "string" },
      "min-samples": { type: "string" }, ledger: { type: "string" },
    },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (command === "plan") {
    const registry = loadRegistry();
    const candidate = selectShadowAblation(registry);
    console.log(JSON.stringify({ schema_version: 1, mode: "shadow", candidate: candidate?.id ?? null, registry_hash: registryHash(registry), production_policy_changed: false }, null, 2));
    process.exit(0);
  }
  if (command !== "evaluate" || !values.assumption || !values.baseline || !values.ablation) {
    console.error("usage: harness-ablation-runner.ts plan | evaluate --assumption <id> --baseline <samples.json> --ablation <samples.json> [--min-samples 5] [--ledger path]");
    process.exit(2);
  }
  const minSamples = values["min-samples"] === undefined ? undefined : Number(values["min-samples"]);
  if (minSamples !== undefined && (!Number.isInteger(minSamples) || minSamples < 1)) {
    console.error("--min-samples must be a positive integer");
    process.exit(2);
  }
  const record = evaluateShadowAblation({
    assumption_id: values.assumption,
    baseline: parseSamples(values.baseline),
    ablation: parseSamples(values.ablation),
    min_samples: minSamples,
    ledger_path: values.ledger,
  });
  console.log(JSON.stringify(record, null, 2));
}
