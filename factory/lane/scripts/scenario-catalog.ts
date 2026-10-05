#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BUILTIN_ARCHETYPES } from "./archetype-allowlist";

export const FR06_SCENARIOS = [
  { id: "credential-absence", spec: "fr06/credential-absence.yaml", coverage: ["credential_absence"] },
  { id: "provider-failure", spec: "fr06/provider-failure.yaml", coverage: ["provider_failure"] },
  { id: "stale-lease-duplicate-claim", spec: "fr06/stale-lease-duplicate-claim.yaml", coverage: ["stale_lease", "duplicate_claim"] },
  { id: "dirty-tree", spec: "fr06/dirty-tree.yaml", coverage: ["dirty_tree"] },
  { id: "ci-failure", spec: "fr06/ci-failure.yaml", coverage: ["ci_failure"] },
  { id: "rollback", spec: "fr06/rollback.yaml", coverage: ["rollback"] },
  { id: "interrupted-conveyor", spec: "fr06/interrupted-conveyor.yaml", coverage: ["interrupted_conveyor"] },
  { id: "linear-pull-smoke", spec: "linear-pull-smoke.yaml", coverage: ["linear_twin"] },
] as const;

const ARCHETYPE_SCENARIOS: Record<string, readonly string[]> = {
  dependency_bump: ["credential-absence", "provider-failure", "ci-failure", "rollback"],
  lint_codemod: ["dirty-tree", "stale-lease-duplicate-claim", "interrupted-conveyor"],
  doc_fix: ["linear-pull-smoke", "dirty-tree", "rollback"],
  test_addition: ["provider-failure", "stale-lease-duplicate-claim", "ci-failure", "interrupted-conveyor"],
};

export interface ScenarioCatalogEntry {
  id: string;
  path: string;
  coverage: readonly string[];
}

function projectDir(): string {
  return join(import.meta.dir, "..");
}

export function scenarioCatalog(base = projectDir()): ScenarioCatalogEntry[] {
  return FR06_SCENARIOS.map((entry) => ({
    id: entry.id,
    path: join(base, "scenarios", entry.spec),
    coverage: entry.coverage,
  }));
}

export function scenariosForArchetype(archetype: string, base = projectDir()): ScenarioCatalogEntry[] {
  const ids = ARCHETYPE_SCENARIOS[archetype];
  if (!ids) return [];
  const byId = new Map(scenarioCatalog(base).map((entry) => [entry.id, entry]));
  return ids.map((id) => byId.get(id)).filter((entry): entry is ScenarioCatalogEntry => entry !== undefined);
}

export function catalogManifestSha256(entries: readonly ScenarioCatalogEntry[], base = projectDir()): string {
  const manifest = entries
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => {
      if (!existsSync(entry.path)) throw new Error(`scenario catalog spec missing: ${entry.path}`);
      const specHash = createHash("sha256").update(readFileSync(entry.path)).digest("hex");
      const relativePath = relative(base, entry.path);
      return { id: entry.id, path: relativePath, spec_sha256: specHash, coverage: [...entry.coverage].sort() };
    });
  return createHash("sha256").update(JSON.stringify({ schema_version: 1, scenarios: manifest })).digest("hex");
}

export function requiredCoverage(entries: readonly ScenarioCatalogEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.coverage))].sort();
}

export function builtinArchetypesWithScenarioCoverage(): string[] {
  return BUILTIN_ARCHETYPES.filter((archetype) => scenariosForArchetype(archetype).length > 0);
}

