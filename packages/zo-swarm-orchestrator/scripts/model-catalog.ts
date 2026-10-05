import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import {
  buildModelCatalog,
  DEFAULT_MODEL_CATALOG_PATH,
  publishModelCatalog,
  readModelCatalogSync,
  type CatalogTier,
  type ModelCatalog,
} from '../src/routing/model-catalog.js';

const workspace = process.env.SWARM_WORKSPACE ?? process.env.ZOUROBOROS_WORKSPACE_ROOT ?? '/home/workspace';
const runtimeRoot = `${workspace}/.runtime/zouroboros-model-intelligence/v1/current`;
const registryPath = `${workspace}/packages/swarm/src/executor/registry/executor-registry.json`;
const outputPath = process.env.SWARM_MODEL_CATALOG_PATH ?? DEFAULT_MODEL_CATALOG_PATH;
const eventsPath = `${dirname(outputPath)}/events.jsonl`;

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(flag: string): string {
  const result = value(flag);
  if (!result) throw new Error(`Missing ${flag}`);
  return result;
}

function tier(valueToParse: string): CatalogTier {
  if (valueToParse !== 'light' && valueToParse !== 'mid' && valueToParse !== 'heavy') {
    throw new Error(`Invalid tier '${valueToParse}'. Use light, mid, or heavy.`);
  }
  return valueToParse;
}

function json(valueToPrint: unknown): void {
  console.log(JSON.stringify(valueToPrint, null, 2));
}

function event(type: string, details: Record<string, unknown>): void {
  mkdirSync(dirname(eventsPath), { recursive: true });
  appendFileSync(eventsPath, `${JSON.stringify({ type, at: new Date().toISOString(), ...details })}\n`);
}

function usage(): void {
  console.log(`Usage:
  bun packages/swarm/scripts/model-catalog.ts build [--json]
  bun packages/swarm/scripts/model-catalog.ts status [--json]
  bun packages/swarm/scripts/model-catalog.ts resolve --executor <id> --tier <light|mid|heavy>
  bun packages/swarm/scripts/model-catalog.ts qualify --executor <id> --tier <light|mid|heavy> --model <id> --probe-command <cmd> --canary-command <cmd> [--evidence <text>]

build ranks current model-intelligence records and preserves prior qualification evidence.
qualify requires a real bridge probe and a three-task canary command before promotion.`);
}

async function build(): Promise<void> {
  const existing = readModelCatalogSync(outputPath);
  const catalog = await buildModelCatalog({
    registryPath,
    openRouterPath: `${runtimeRoot}/openrouter.json`,
    artificialAnalysisPath: `${runtimeRoot}/artificial-analysis.json`,
    joinedPath: `${runtimeRoot}/joined.json`,
    existingCatalog: existing,
  });
  await publishModelCatalog(catalog, outputPath);
  event('catalog_built', {
    output: outputPath,
    generated_at: catalog.generated_at,
    source_generation: catalog.source_generation,
    routes: Object.keys(catalog.routes).length,
    content_sha256: catalog.content_sha256,
  });
  json({ ok: true, output: outputPath, generated_at: catalog.generated_at, source_generation: catalog.source_generation, routes: Object.keys(catalog.routes).length, content_sha256: catalog.content_sha256 });
}

function status(): void {
  const catalog = readModelCatalogSync(outputPath);
  if (!catalog) {
    json({ ok: false, output: outputPath, reason: 'catalog_unavailable' });
    process.exitCode = 1;
    return;
  }
  json({
    ok: true,
    output: outputPath,
    generated_at: catalog.generated_at,
    source_generation: catalog.source_generation,
    routes: Object.fromEntries(Object.entries(catalog.routes).map(([executor, route]) => [executor, route.qualification])),
    content_sha256: catalog.content_sha256,
  });
}

function resolveModel(): void {
  const catalog = readModelCatalogSync(outputPath);
  if (!catalog) throw new Error(`Catalog unavailable at ${outputPath}`);
  const executor = required('--executor');
  const selectedTier = tier(required('--tier'));
  const route = catalog.routes[executor];
  if (!route) throw new Error(`Executor '${executor}' is not present in the catalog`);
  json({ executor, tier: selectedTier, winner: route.winner[selectedTier], qualification: route.qualification[selectedTier], candidates: route.candidates[selectedTier] });
}

function qualify(): void {
  const catalog = readModelCatalogSync(outputPath);
  if (!catalog) throw new Error(`Catalog unavailable at ${outputPath}`);
  const executor = required('--executor');
  const selectedTier = tier(required('--tier'));
  const model = required('--model');
  const probeCommand = required('--probe-command');
  const canaryCommand = required('--canary-command');
  const route = catalog.routes[executor];
  if (!route) throw new Error(`Executor '${executor}' is not present in the catalog`);
  if (!route.candidates[selectedTier].some((candidate) => candidate.model === model || candidate.sourceModel === model)) {
    throw new Error(`Model '${model}' is not a ranked candidate for ${executor}/${selectedTier}`);
  }

  const environment = {
    ...process.env,
    SWARM_RESOLVED_MODEL: model,
    SWARM_TIER: `swarm-${selectedTier}`,
    SWARM_QUALIFICATION_EXECUTOR: executor,
  };
  const probe = spawnSync(probeCommand, { shell: true, env: environment, stdio: 'inherit' });
  if (probe.status !== 0) throw new Error(`Bridge probe failed with exit code ${probe.status ?? 'unknown'}`);
  const canary = spawnSync(canaryCommand, { shell: true, env: environment, stdio: 'inherit' });
  if (canary.status !== 0) throw new Error(`Three-task canary failed with exit code ${canary.status ?? 'unknown'}`);

  const evidence = value('--evidence') ?? `bridge-probe-and-three-task-canary:${new Date().toISOString()}`;
  const updated: ModelCatalog = {
    ...catalog,
    routes: {
      ...catalog.routes,
      [executor]: {
        ...route,
        qualification: {
          ...route.qualification,
          [selectedTier]: { model, qualified: true, evidence, qualifiedAt: new Date().toISOString() },
        },
      },
    },
  };
  const { content_sha256: _ignored, ...withoutHash } = updated;
  updated.content_sha256 = createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex');
  mkdirSync(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.qualification-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(updated, null, 2)}\n`);
  renameSync(tempPath, outputPath);
  event('model_promoted', { executor, tier: selectedTier, model, evidence, content_sha256: updated.content_sha256 });
  json({ ok: true, executor, tier: selectedTier, model, evidence, content_sha256: updated.content_sha256 });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === 'help') return usage();
  if (command === 'build') return build();
  if (command === 'status') return status();
  if (command === 'resolve') return resolveModel();
  if (command === 'qualify') return qualify();
  throw new Error(`Unknown command '${command}'`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
