import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseCascadeValidationCommands } from "./pool-queue";
import type { CascadeValidationCommand } from "./coding-cascade";

export const SCOPED_VALIDATION_ENV = "FACTORY_CODING_CASCADE_VALIDATION_COMMANDS_BY_REPOSITORY";
export const LEGACY_VALIDATION_ENV = "FACTORY_CODING_CASCADE_VALIDATION_COMMANDS";
export const LEGACY_REPOSITORY_ENV = "FACTORY_CODING_CASCADE_VALIDATION_REPOSITORY";

export function normalizeRepositoryIdentity(value: string): string {
  const trimmed = value.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const github = trimmed.match(/^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+)$/i);
  return github ? github[1].toLowerCase() : trimmed;
}

export function repositoryIdentityForDirectory(repository: string): string | null {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return normalizeRepositoryIdentity(result.stdout);
}

function canonicalRepositoryPath(repository: string): string {
  return resolve(realpathSync(repository));
}

function selectors(repository: string, identity: string | null): string[] {
  return [canonicalRepositoryPath(repository), ...(identity ? [normalizeRepositoryIdentity(identity)] : [])];
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveRepositoryValidationCommands(input: {
  repository: string;
  repositoryIdentity?: string | null;
  scopedJson?: string;
  legacyJson?: string;
  legacyRepository?: string;
}): CascadeValidationCommand[] {
  const identity = input.repositoryIdentity ?? repositoryIdentityForDirectory(input.repository);
  const candidates = selectors(input.repository, identity);

  if (input.scopedJson) {
    const parsed = parseJson(input.scopedJson, SCOPED_VALIDATION_ENV);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${SCOPED_VALIDATION_ENV} must be a JSON object keyed by repository path or owner/repo`);
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const matches = entries.filter(([key]) => {
      const normalized = key.startsWith("/") ? resolve(key) : normalizeRepositoryIdentity(key);
      return candidates.includes(normalized);
    });
    if (matches.length > 1) {
      throw new Error(`multiple repository validation routes match ${identity ?? candidates[0]}`);
    }
    if (matches.length === 1) {
      return parseCascadeValidationCommands(matches[0][1], `${SCOPED_VALIDATION_ENV}[${matches[0][0]}]`);
    }
  }

  if (input.legacyJson) {
    if (!input.legacyRepository?.trim()) {
      throw new Error(`${LEGACY_VALIDATION_ENV} requires ${LEGACY_REPOSITORY_ENV}; unscoped validators are unsafe`);
    }
    const binding = input.legacyRepository.startsWith("/")
      ? resolve(input.legacyRepository)
      : normalizeRepositoryIdentity(input.legacyRepository);
    if (candidates.includes(binding)) {
      return parseCascadeValidationCommands(
        parseJson(input.legacyJson, LEGACY_VALIDATION_ENV),
        LEGACY_VALIDATION_ENV,
      );
    }
  }

  throw new Error(
    `no coding-cascade validation route for repository ${identity ?? candidates[0]}; configure ${SCOPED_VALIDATION_ENV}`,
  );
}
