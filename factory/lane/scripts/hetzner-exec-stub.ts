/**
 * hetzner-exec-stub.ts — Local stand-in for packages/hetzner-exec's
 * ephemeral-worker module.
 *
 * The upstream module (packages/hetzner-exec/src/ephemeral-worker.ts) is not
 * vendored in this distribution. Two behaviors are preserved:
 *
 * - `loadManifest` / `validateManifest`: pure manifest validation,
 *   reimplemented faithfully (no cloud access involved).
 * - `runEphemeralWorker`: FAILS FAST. It provisions Hetzner cloud servers via
 *   the Hetzner API — there is no local equivalent. Callers may inject a
 *   working implementation via options.workerRun; the default refuses rather
 *   than attempting cloud provisioning it cannot perform.
 */

import { readFileSync } from "node:fs";

export interface ExternalComputeManifest {
  version: 1;
  commands: string[];
  verification?: "optional" | "remote-required";
  artifacts?: string[];
  excludes?: string[];
  server_type?: string;
  image?: string;
  location?: string;
  ttl_minutes?: number;
  max_cost_usd?: number;
}

export interface EphemeralWorkerEvidence {
  version: 1;
  run_id: string;
  status: "passed" | "failed";
  server: {
    id: number;
    name: string;
    type: string;
    image: string;
    location: string;
  };
  limits: {
    ttl_minutes: number;
    max_cost_usd: number;
    hourly_cost_usd: number;
  };
  [key: string]: unknown;
}

export interface WorkerRunOptions {
  workdir: string;
  manifest: ExternalComputeManifest;
  evidenceDir: string;
  env?: Record<string, string | undefined>;
  remoteEnv?: Record<string, string | undefined>;
  now?: () => Date;
}

const DEFAULT_TTL_MINUTES = 120;
const MAX_TTL_MINUTES = 1440;
const DEFAULT_MAX_COST_USD = 1;

function validateRelativePath(path: string, field: string): void {
  if (typeof path !== "string" || !path.trim() || path.startsWith("/") || path.includes("..")) {
    throw new Error(`external compute manifest ${field} must be relative paths without ..`);
  }
}

export function validateManifest(input: unknown): ExternalComputeManifest {
  if (!input || typeof input !== "object") throw new Error("external compute manifest must be an object");
  const value = input as Partial<ExternalComputeManifest>;
  if (value.version !== 1) throw new Error("external compute manifest version must be 1");
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error("external compute manifest commands must be a non-empty string array");
  }
  if (value.commands.length > 20) throw new Error("external compute manifest supports at most 20 commands");
  if (value.verification !== undefined && value.verification !== "optional" && value.verification !== "remote-required") {
    throw new Error("verification must be optional or remote-required");
  }
  for (const path of value.artifacts ?? []) validateRelativePath(path, "artifacts");
  for (const path of value.excludes ?? []) validateRelativePath(path, "excludes");

  const ttl = value.ttl_minutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > MAX_TTL_MINUTES) {
    throw new Error(`ttl_minutes must be an integer between 5 and ${MAX_TTL_MINUTES}`);
  }
  const maxCost = value.max_cost_usd ?? DEFAULT_MAX_COST_USD;
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 5) {
    throw new Error("max_cost_usd must be greater than 0 and no more than 5");
  }
  return {
    version: 1,
    commands: [...value.commands],
    verification: value.verification ?? "optional",
    ...(value.artifacts ? { artifacts: [...value.artifacts] } : {}),
    ...(value.excludes ? { excludes: [...value.excludes] } : {}),
    ...(value.server_type ? { server_type: value.server_type } : {}),
    ...(value.image ? { image: value.image } : {}),
    ...(value.location ? { location: value.location } : {}),
    ttl_minutes: ttl,
    max_cost_usd: maxCost,
  };
}

export function loadManifest(path: string): ExternalComputeManifest {
  return validateManifest(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Fail-fast: ephemeral Hetzner workers require the hetzner-exec package and
 * Hetzner cloud credentials. Inject options.workerRun to provide one, or use
 * local harness executors.
 */
export async function runEphemeralWorker(_options: WorkerRunOptions): Promise<EphemeralWorkerEvidence> {
  throw new Error(
    "hetzner-exec is not vendored in this distribution — cannot provision ephemeral Hetzner workers; " +
      "inject options.workerRun or use local harness executors",
  );
}
