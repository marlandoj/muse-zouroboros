/**
 * Executor registry loader
 * 
 * Loads executor configurations from JSON registry files.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { ExecutorRegistryEntry } from '../types.js';

export const EXECUTOR_REGISTRY_RELATIVE = 'packages/swarm/src/executor/registry/executor-registry.json';

/** One precedence policy for the factory, CC runtime, doctor, and registry tools. */
export function resolveExecutorRegistryPath(
  customPath?: string,
  workspaceRoot?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const explicitWorkspace = workspaceRoot ?? env.SWARM_WORKSPACE ?? env.ZOUROBOROS_WORKSPACE_ROOT;
  const workspace = explicitWorkspace ?? getWorkspaceRoot();
  const override = customPath ?? env.SWARM_EXECUTOR_REGISTRY;
  if (override) return isAbsolute(override) ? override : resolve(workspace, override);
  if (explicitWorkspace) return resolve(workspace, EXECUTOR_REGISTRY_RELATIVE);
  // Installed packages ship this same registry alongside the loader.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'executor', 'registry', 'executor-registry.json');
}

export interface Registry {
  executors: ExecutorRegistryEntry[];
  description?: string;
}

export function loadRegistry(customPath?: string): Registry {
  const fullPath = resolveExecutorRegistryPath(customPath);
  if (existsSync(fullPath)) {
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const parsed = JSON.parse(content) as Registry & {
        executors: Array<ExecutorRegistryEntry & { best_for?: string[] }>;
      };
      return {
        ...parsed,
        executors: parsed.executors.map(entry => {
          const legacyEntry = entry as ExecutorRegistryEntry & { best_for?: string[] };
          return {
            ...legacyEntry,
            bestFor: legacyEntry.bestFor ?? legacyEntry.best_for ?? [],
          };
        }),
      };
    } catch (err) {
      console.warn(`Failed to load registry from ${fullPath}:`, err);
    }
  }

  // Return empty registry if none found
  return { executors: [], description: 'Empty default registry' };
}

export function findExecutor(registry: Registry, executorId: string): ExecutorRegistryEntry | undefined {
  return registry.executors.find(e => e.id === executorId);
}

export function listExecutors(registry: Registry): ExecutorRegistryEntry[] {
  return registry.executors;
}

export function getLocalExecutors(registry: Registry): ExecutorRegistryEntry[] {
  return registry.executors.filter(e => e.executor === 'local');
}

export function isExecutorAutoRoutingEnabled(
  entry: ExecutorRegistryEntry,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const gate = entry.rollout?.autoRoutingEnv;
  return !gate || env[gate] === '1';
}

export function getAutoRoutableExecutors(registry: Registry): ExecutorRegistryEntry[] {
  return getLocalExecutors(registry).filter(entry => isExecutorAutoRoutingEnabled(entry));
}
