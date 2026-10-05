import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { loadFactoryPathProfile } from "../../../packages/swarm/src/transport/factory-path-profile";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const FACTORY_STATE_ENV = "FACTORY_STATE_DIR";
export const FACTORY_STATE_MODE_ENV = "FACTORY_STATE_MODE";
export const FACTORY_STATE_OUTSIDE_ROOT_ENV = "FACTORY_STATE_ALLOW_OUTSIDE_ROOT";
export const FACTORY_STATE_MARKER = ".factory-state-root.json";
export const FACTORY_STATE_SCHEMA_VERSION = 1;
export const FACTORY_STATE_NAMESPACE = "zouroboros-software-factory";
export const FACTORY_HELP_ONLY_STATE_ROOT = resolve(sep, ".zouroboros-factory-help-only-no-state");

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const LEGACY_STATE_ROOT = join(PROJECT_ROOT, "state");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HELP_ONLY_ENTRYPOINTS = new Set(["swarm-exec.ts", "dispatcher.ts", "auto-merge-lane.ts"]);

export type FactoryStateMode = "production" | "compatibility" | "test";

export interface FactoryStateMarker {
  namespace: typeof FACTORY_STATE_NAMESPACE;
  schema_version: typeof FACTORY_STATE_SCHEMA_VERSION;
  root_id: string;
  canonical_path: string;
  generation: number;
  device: number;
  created_at: string;
}

export interface FactoryStateOptions {
  env?: Record<string, string | undefined>;
  mode?: FactoryStateMode;
  requireMarker?: boolean;
}

export class FactoryStateRootError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FactoryStateRootError";
  }
}

function stateMode(options: FactoryStateOptions): FactoryStateMode {
  if (options.mode) return options.mode;
  const raw = (options.env ?? process.env)[FACTORY_STATE_MODE_ENV];
  if (!raw) return "production";
  if (raw === "production" || raw === "compatibility" || raw === "test") return raw;
  throw new FactoryStateRootError("invalid_mode", `${FACTORY_STATE_MODE_ENV} must be production, compatibility, or test`);
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function rejectRuntimeContainedRoot(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.includes("/Projects/zouroboros-software-factory/state") ||
    /\/\.runtime\/factory-conveyor(?:\/|-)/.test(normalized) ||
    normalized === "/home/.z/factory/releases" || normalized.startsWith("/home/.z/factory/releases/") ||
    /\/\.factory-worktrees\//.test(normalized) ||
    /\/\.codex-worktrees\//.test(normalized)
  ) {
    throw new FactoryStateRootError("runtime_contained", "factory state root must be independent of every checkout and conveyor runtime");
  }
}

export function normalizeFactoryStateRoot(raw: string): string {
  if (!raw || raw.includes("\0") || !isAbsolute(raw)) {
    throw new FactoryStateRootError("invalid_root", `${FACTORY_STATE_ENV} must be a non-empty absolute path`);
  }
  const canonical = resolve(raw);
  if (canonical === sep || canonical !== raw) {
    throw new FactoryStateRootError("noncanonical_root", `${FACTORY_STATE_ENV} must be canonical and may not be the filesystem root`);
  }
  rejectRuntimeContainedRoot(canonical);
  return canonical;
}

export function validateFactoryStateMarker(root: string): FactoryStateMarker {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new FactoryStateRootError("root_missing", `factory state root does not exist: ${root}`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new FactoryStateRootError("root_not_directory", "factory state root must be a real directory, not a symlink");
  }
  if (realpathSync(root) !== root) {
    throw new FactoryStateRootError("root_realpath_mismatch", "factory state root realpath does not match its canonical path");
  }

  const markerPath = join(root, FACTORY_STATE_MARKER);
  if (!existsSync(markerPath)) throw new FactoryStateRootError("marker_missing", `factory state marker is missing: ${markerPath}`);
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new FactoryStateRootError("marker_not_file", "factory state marker must be a regular file");
  }

  let marker: FactoryStateMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8")) as FactoryStateMarker;
  } catch {
    throw new FactoryStateRootError("marker_invalid_json", "factory state marker is not valid JSON");
  }
  if (marker.namespace !== FACTORY_STATE_NAMESPACE || marker.schema_version !== FACTORY_STATE_SCHEMA_VERSION) {
    throw new FactoryStateRootError("marker_identity_mismatch", "factory state marker namespace or schema version is invalid");
  }
  if (!UUID.test(marker.root_id) || marker.canonical_path !== root) {
    throw new FactoryStateRootError("marker_root_mismatch", "factory state marker root identity does not match the requested root");
  }
  if (!Number.isSafeInteger(marker.generation) || marker.generation < 0 || marker.device !== rootStat.dev) {
    throw new FactoryStateRootError("marker_generation_mismatch", "factory state marker generation or device is invalid");
  }
  if (!marker.created_at || Number.isNaN(Date.parse(marker.created_at))) {
    throw new FactoryStateRootError("marker_timestamp_invalid", "factory state marker created_at is invalid");
  }
  return marker;
}

export function isFactoryHelpOnlyInvocation(
  entrypoint = process.argv[1] ?? "",
  args: readonly string[] = process.argv.slice(2),
): boolean {
  return HELP_ONLY_ENTRYPOINTS.has(basename(entrypoint))
    && args.length > 0
    && args.every((arg) => arg === "--help" || arg === "-h");
}

export function factoryStateRoot(options?: FactoryStateOptions): string {
  if (
    options === undefined
    && process.env[FACTORY_STATE_ENV] === undefined
    && process.env[FACTORY_STATE_MODE_ENV] === undefined
    && process.env[FACTORY_STATE_OUTSIDE_ROOT_ENV] === undefined
    && isFactoryHelpOnlyInvocation()
  ) {
    return FACTORY_HELP_ONLY_STATE_ROOT;
  }

  const resolvedOptions = options ?? {};
  const env = resolvedOptions.env ?? process.env;
  const profile = loadFactoryPathProfile(env);
  const mode = stateMode(resolvedOptions);
  if (profile && (mode === "compatibility" || env[FACTORY_STATE_ENV] !== profile.state_root)) throw new FactoryStateRootError("profile_state_mismatch", "profiled Factory requires the exact independent state binding");
  if (mode === "compatibility") return LEGACY_STATE_ROOT;

  const raw = env[FACTORY_STATE_ENV];
  if (!raw && mode === "test") return LEGACY_STATE_ROOT;
  if (!raw) throw new FactoryStateRootError("root_required", `${FACTORY_STATE_ENV} is required outside compatibility mode`);
  const root = normalizeFactoryStateRoot(raw);
  if (resolvedOptions.requireMarker ?? mode === "production") validateFactoryStateMarker(root);
  return root;
}

function validateSegment(segment: string): void {
  if (!segment || segment.includes("\0") || isAbsolute(segment)) {
    throw new FactoryStateRootError("invalid_segment", "factory state path segments must be non-empty relative paths");
  }
  const normalized = resolve(sep, segment);
  if (normalized === sep || normalized.startsWith(`${sep}..${sep}`) || segment.split(/[\\/]/).includes("..")) {
    throw new FactoryStateRootError("path_traversal", `factory state path escapes the root: ${segment}`);
  }
}

export function factoryStatePath(...segments: string[]): string {
  const root = factoryStateRoot();
  for (const segment of segments) validateSegment(segment);
  const path = resolve(root, ...segments);
  if (!isContained(root, path)) throw new FactoryStateRootError("path_escape", "factory state path escapes the canonical root");
  return path;
}

export function resolveFactoryStateOverride(explicit: string | undefined, ...fallbackSegments: string[]): string {
  const root = factoryStateRoot();
  if (!explicit) return fallbackSegments.length ? factoryStatePath(...fallbackSegments) : root;
  if (!explicit || explicit.includes("\0") || !isAbsolute(explicit) || resolve(explicit) !== explicit) {
    throw new FactoryStateRootError("invalid_override", "factory state override must be a canonical absolute path");
  }
  const candidate = resolve(explicit);
  if (isContained(root, candidate)) return candidate;
  const env = process.env;
  if (stateMode({ env }) === "test" && env[FACTORY_STATE_OUTSIDE_ROOT_ENV] === "1") return candidate;
  throw new FactoryStateRootError("override_outside_root", "factory state override must remain beneath FACTORY_STATE_DIR");
}

export function factoryStatePathForProject(projectRoot: string, ...segments: string[]): string {
  for (const segment of segments) validateSegment(segment);
  const mode = stateMode({ env: process.env });
  if (
    mode === "compatibility" ||
    (mode === "test" && process.env[FACTORY_STATE_OUTSIDE_ROOT_ENV] === "1")
  ) {
    return resolve(projectRoot, "state", ...segments);
  }
  return factoryStatePath(...segments);
}

export function factoryStateMarkerPath(root = factoryStateRoot({ requireMarker: false })): string {
  return join(root, FACTORY_STATE_MARKER);
}

export function legacyFactoryStateRoot(): string {
  return LEGACY_STATE_ROOT;
}
