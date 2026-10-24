/**
 * Bridge resolvability (F4).
 *
 * orchestrate-v5 starts every executor through a bridge script named by the
 * executor's registry entry (`bridge`, resolved against the orchestrator
 * home). An entry whose bridge is missing or not on disk cannot run anything,
 * so it must never be routable — and it must never take the whole swarm down
 * either. This module answers "which executors can this host start, and why
 * not the others", in words the operator can act on.
 *
 * Pure: no console output, no process state. orchestrate-v5 prints/logs the
 * exclusions and records them in the results file (`excludedExecutors`).
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export interface BridgeExclusion {
  /** Executor id as requested (registry id or a task's pin). */
  executor: string;
  /** Machine-readable cause. */
  cause: "no_bridge" | "bridge_missing" | "not_registered";
  /** Plain-language reason (no fix). */
  reason: string;
  /** What the operator can do about it. */
  action: string;
  /** Tasks that asked for this executor (filled in by pre-flight). */
  tasks?: string[];
}

export interface BridgeAudit {
  /** executor id -> absolute bridge path, for every executor that resolves. */
  resolvable: Map<string, string>;
  /** Local executors named by a registry whose bridge does not resolve. */
  excluded: BridgeExclusion[];
}

export interface BridgeAuditInput {
  orchestratorHome: string;
  registryPath: string;
  personaRegistryPath?: string;
}

const CANONICAL_BRIDGE_DIR = "packages/zo-swarm-orchestrator/src/executor/bridges";

function readEntries(path: string | undefined, key: "executors" | "personas"): any[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.[key];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function shown(home: string, path: string): string {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** Why one registry entry's bridge does not resolve (null = it resolves). */
export function entryBridgeProblem(
  entry: { id?: string; bridge?: unknown },
  orchestratorHome: string,
  registryPath: string,
): { path: string } | Omit<BridgeExclusion, "executor" | "tasks"> {
  const id = String(entry.id ?? "");
  const where = shown(orchestratorHome, registryPath);
  const ref = typeof entry.bridge === "string" ? entry.bridge.trim() : "";
  if (!ref) {
    const conventional = `${CANONICAL_BRIDGE_DIR}/${id}-bridge.sh`;
    const hint = existsSync(join(orchestratorHome, conventional))
      ? `set "bridge": "${conventional}" on the ${id} entry in ${where} (that script is already on this server)`
      : `set "bridge" on the ${id} entry in ${where} to its bridge script`;
    return {
      cause: "no_bridge",
      reason: `its registry entry names no bridge script, so the swarm has no way to start it`,
      action: `say 'Update the workshop' to get the fixed registry, or ${hint}`,
    };
  }
  const abs = isAbsolute(ref) ? ref : join(orchestratorHome, ref);
  if (!existsSync(abs)) {
    return {
      cause: "bridge_missing",
      reason: `its bridge script ${shown(orchestratorHome, abs)} is not on this server`,
      action: `say 'Update the workshop' to restore it, or correct the ${id} entry's "bridge" path in ${where}`,
    };
  }
  return { path: abs };
}

/**
 * Audit every local executor in the executor registry (and the persona
 * registry, which may also carry local bridges). An executor resolves when
 * ANY source gives it a bridge that exists; otherwise it is excluded with the
 * executor registry's reason (the persona registry's when it is the only one
 * naming the executor).
 */
export function auditRegistryBridges(input: BridgeAuditInput): BridgeAudit {
  const resolvable = new Map<string, string>();
  const problems = new Map<string, Omit<BridgeExclusion, "executor" | "tasks">>();
  const sources: Array<[string | undefined, "executors" | "personas"]> = [
    [input.registryPath, "executors"],
    [input.personaRegistryPath, "personas"],
  ];
  for (const [path, key] of sources) {
    for (const entry of readEntries(path, key)) {
      if (!entry?.id || entry.executor !== "local") continue;
      const r = entryBridgeProblem(entry, input.orchestratorHome, path!);
      if ("path" in r) {
        if (!resolvable.has(entry.id)) resolvable.set(entry.id, r.path);
      } else if (!problems.has(entry.id)) {
        problems.set(entry.id, r);
      }
    }
  }
  const excluded: BridgeExclusion[] = [];
  for (const [executor, p] of problems) {
    if (!resolvable.has(executor)) excluded.push({ executor, ...p });
  }
  return { resolvable, excluded };
}

/** Exclusion for a pin to an executor no registry names at all. */
export function notRegisteredExclusion(executor: string, registryPath: string, orchestratorHome: string, available: string[]): BridgeExclusion {
  return {
    executor,
    cause: "not_registered",
    reason: `no executor named '${executor}' is registered on this server (${shown(orchestratorHome, registryPath)})`,
    action: available.length
      ? `check the executor name; this server can run: ${available.join(", ")}`
      : `check the executor name, then register and install it`,
  };
}

/** One plain-language line per exclusion. */
export function describeExclusion(x: BridgeExclusion): string {
  const who = x.tasks?.length ? ` (asked for by ${x.tasks.join(", ")})` : "";
  return `${x.executor} is left out of this swarm${who}: ${x.reason}. To fix: ${x.action}.`;
}
