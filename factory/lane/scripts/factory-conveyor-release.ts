import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  FACTORY_STATE_NAMESPACE,
  FACTORY_STATE_SCHEMA_VERSION,
  resolveFactoryStateOverride,
  validateFactoryStateMarker,
  type FactoryStateMarker,
} from "./factory-state-root";
import { buildIncumbentAdapterCatalog, conveyorAdapterContractHash } from "./factory-conveyor-adapters";
import {
  CONVEYOR_RUNNER_SCHEMA_VERSION,
  CONVEYOR_RUNNER_VERSION,
  ConveyorRunnerError,
  canonicalJson,
  conveyorPlanHash,
  sha256,
} from "./factory-conveyor-runner";
import {
  runtimeKey,
  type RuntimeMaterializationAttestation,
} from "./runtime-materialize";

export const CONVEYOR_RELEASE_SCHEMA_VERSION = 1 as const;
export const CONVEYOR_RELEASE_ACTIVATION_CEILING = "parity_shadow" as const;

export interface ConveyorReleaseManifest {
  schema_version: typeof CONVEYOR_RELEASE_SCHEMA_VERSION;
  release_id: string;
  created_at: string;
  runtime: RuntimeMaterializationAttestation;
  runner_version: typeof CONVEYOR_RUNNER_VERSION;
  runner_schema_version: typeof CONVEYOR_RUNNER_SCHEMA_VERSION;
  runner_plan_hash: string;
  adapter_contract_hash: string;
  state_namespace: typeof FACTORY_STATE_NAMESPACE;
  state_schema_version: typeof FACTORY_STATE_SCHEMA_VERSION;
  state_root_id: string;
  state_generation: number;
  activation_ceiling: typeof CONVEYOR_RELEASE_ACTIVATION_CEILING;
  previous_release_hash: string | null;
  manifest_hash: string;
}

export interface ConveyorRollbackPlan {
  schema_version: typeof CONVEYOR_RELEASE_SCHEMA_VERSION;
  from_release_id: string;
  from_manifest_hash: string;
  to_release_id: string;
  to_manifest_hash: string;
  state_root_id: string;
  state_generation: number;
  preserves_state: true;
  activation_ceiling: typeof CONVEYOR_RELEASE_ACTIVATION_CEILING;
  plan_hash: string;
}

export interface PreparedConveyorRelease {
  manifest: ConveyorReleaseManifest;
  manifest_path: string;
  record_status: "created" | "existing";
}

const HASH = /^[0-9a-f]{64}$/;
const GIT_HASH = /^[0-9a-f]{40}$/;
const RELEASE_ID = /^rel-[0-9a-f]{24}$/;

function assertHash(value: string, field: string): void {
  if (!HASH.test(value)) throw new ConveyorRunnerError("release_hash_invalid", `${field} must be a lowercase SHA-256 digest`);
}

function assertRuntimeAttestation(runtime: RuntimeMaterializationAttestation): void {
  if (runtime.path_profile_sha256 !== undefined) assertHash(runtime.path_profile_sha256, "path_profile_sha256");
  if (runtime.candidate_root.startsWith('/home/.z/factory/releases/') && !runtime.path_profile_sha256) throw new ConveyorRunnerError("release_profile_missing", "external release requires a pinned path profile");
  if (runtime.version !== 1) throw new ConveyorRunnerError("release_runtime_schema", "unsupported runtime attestation version");
  if (!GIT_HASH.test(runtime.merge_commit) || !GIT_HASH.test(runtime.merge_tree)) {
    throw new ConveyorRunnerError("release_runtime_git_identity", "runtime commit and tree must be exact Git object ids");
  }
  for (const [field, value] of [
    ["package_json_sha256", runtime.package_json_sha256],
    ["pnpm_lock_sha256", runtime.pnpm_lock_sha256],
    ["pnpm_workspace_sha256", runtime.pnpm_workspace_sha256],
    ["normalized_dependency_graph_sha256", runtime.normalized_dependency_graph_sha256],
    ["runtime_key_sha256", runtime.runtime_key_sha256],
  ] as const) assertHash(value, field);
  if (!runtime.tracked_clean) throw new ConveyorRunnerError("release_runtime_dirty", "release runtime must be tracked-clean");
  if (runtime.runtime_key_sha256 !== runtimeKey(runtime)) {
    throw new ConveyorRunnerError("release_runtime_key_mismatch", "runtime attestation key does not match its immutable inputs");
  }
}

function manifestUnsigned(manifest: Omit<ConveyorReleaseManifest, "manifest_hash">): unknown {
  return manifest;
}

export function planHistoricalRollback(input: {
  from: ConveyorReleaseManifest;
  historicalRuntime: RuntimeMaterializationAttestation;
  historicalConfigSha256: string;
  stateMarker: FactoryStateMarker;
}): { historical_runtime: RuntimeMaterializationAttestation; historical_config_sha256: string; from_manifest_hash: string; state_root_id: string; state_generation: number; activation_ceiling: typeof CONVEYOR_RELEASE_ACTIVATION_CEILING; preserves_state: true; plan_hash: string } {
  validateReleaseManifest(input.from);
  assertRuntimeAttestation(input.historicalRuntime);
  assertHash(input.historicalConfigSha256, 'historical_config_sha256');
  if (input.historicalRuntime.path_profile_sha256 !== undefined) throw new ConveyorRunnerError('historical_profile_invalid', 'historical rollback must retain the original legacy runtime evidence');
  if (input.from.state_root_id !== input.stateMarker.root_id || input.from.state_generation !== input.stateMarker.generation) throw new ConveyorRunnerError('rollback_state_mismatch', 'historical rollback must preserve the exact state identity and generation');
  const unsigned = {
    historical_runtime: input.historicalRuntime,
    historical_config_sha256: input.historicalConfigSha256,
    from_manifest_hash: input.from.manifest_hash,
    state_root_id: input.stateMarker.root_id,
    state_generation: input.stateMarker.generation,
    activation_ceiling: CONVEYOR_RELEASE_ACTIVATION_CEILING,
    preserves_state: true as const,
  };
  return { ...unsigned, plan_hash: sha256(canonicalJson(unsigned)) };
}

function releaseId(runtimeKeySha256: string): string {
  return `rel-${runtimeKeySha256.slice(0, 24)}`;
}

function assertTimestamp(value: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new ConveyorRunnerError("release_timestamp_invalid", "created_at must be an RFC 3339 timestamp");
  }
}

export function createReleaseManifest(input: {
  runtime: RuntimeMaterializationAttestation;
  adapterContractHash: string;
  stateMarker: FactoryStateMarker;
  createdAt?: string;
  previousReleaseHash?: string | null;
}): ConveyorReleaseManifest {
  assertRuntimeAttestation(input.runtime);
  assertHash(input.adapterContractHash, "adapter_contract_hash");
  if (input.stateMarker.namespace !== FACTORY_STATE_NAMESPACE || input.stateMarker.schema_version !== FACTORY_STATE_SCHEMA_VERSION) {
    throw new ConveyorRunnerError("release_state_schema", "release requires the exact supported factory state schema");
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  assertTimestamp(createdAt);
  const previousReleaseHash = input.previousReleaseHash ?? null;
  if (previousReleaseHash !== null) assertHash(previousReleaseHash, "previous_release_hash");
  const unsigned: Omit<ConveyorReleaseManifest, "manifest_hash"> = {
    schema_version: CONVEYOR_RELEASE_SCHEMA_VERSION,
    release_id: releaseId(input.runtime.runtime_key_sha256),
    created_at: createdAt,
    runtime: input.runtime,
    runner_version: CONVEYOR_RUNNER_VERSION,
    runner_schema_version: CONVEYOR_RUNNER_SCHEMA_VERSION,
    runner_plan_hash: conveyorPlanHash(),
    adapter_contract_hash: input.adapterContractHash,
    state_namespace: input.stateMarker.namespace,
    state_schema_version: input.stateMarker.schema_version,
    state_root_id: input.stateMarker.root_id,
    state_generation: input.stateMarker.generation,
    activation_ceiling: CONVEYOR_RELEASE_ACTIVATION_CEILING,
    previous_release_hash: previousReleaseHash,
  };
  return { ...unsigned, manifest_hash: sha256(canonicalJson(manifestUnsigned(unsigned))) };
}

export function validateReleaseManifest(manifest: ConveyorReleaseManifest): void {
  if (manifest.schema_version !== CONVEYOR_RELEASE_SCHEMA_VERSION) throw new ConveyorRunnerError("release_schema_incompatible", "unsupported release schema");
  if (!RELEASE_ID.test(manifest.release_id)) throw new ConveyorRunnerError("release_id_invalid", "release_id is invalid");
  assertTimestamp(manifest.created_at);
  assertRuntimeAttestation(manifest.runtime);
  if (manifest.release_id !== releaseId(manifest.runtime.runtime_key_sha256)) throw new ConveyorRunnerError("release_id_mismatch", "release id does not match runtime identity");
  if (manifest.runner_version !== CONVEYOR_RUNNER_VERSION || manifest.runner_schema_version !== CONVEYOR_RUNNER_SCHEMA_VERSION) {
    throw new ConveyorRunnerError("release_runner_incompatible", "release runner version is incompatible");
  }
  if (manifest.runner_plan_hash !== conveyorPlanHash()) throw new ConveyorRunnerError("release_plan_incompatible", "release plan hash is incompatible");
  assertHash(manifest.adapter_contract_hash, "adapter_contract_hash");
  if (manifest.state_namespace !== FACTORY_STATE_NAMESPACE || manifest.state_schema_version !== FACTORY_STATE_SCHEMA_VERSION) {
    throw new ConveyorRunnerError("release_state_schema", "release state schema is incompatible");
  }
  if (!Number.isSafeInteger(manifest.state_generation) || manifest.state_generation < 0) {
    throw new ConveyorRunnerError("release_state_generation", "release state generation is invalid");
  }
  if (manifest.activation_ceiling !== CONVEYOR_RELEASE_ACTIVATION_CEILING) {
    throw new ConveyorRunnerError("release_activation_unauthorized", "this release may not exceed parity shadow");
  }
  if (manifest.previous_release_hash !== null) assertHash(manifest.previous_release_hash, "previous_release_hash");
  assertHash(manifest.manifest_hash, "manifest_hash");
  const { manifest_hash, ...unsigned } = manifest;
  if (manifest_hash !== sha256(canonicalJson(manifestUnsigned(unsigned)))) {
    throw new ConveyorRunnerError("release_manifest_hash_mismatch", "release manifest hash mismatch");
  }
}

function releaseRoot(stateDir?: string): string {
  return join(resolveFactoryStateOverride(stateDir), "conveyor-runner", "releases");
}

export function conveyorReleaseManifestPath(releaseId: string, stateDir?: string): string {
  if (!RELEASE_ID.test(releaseId)) throw new ConveyorRunnerError("release_id_invalid", "release_id is invalid");
  return join(releaseRoot(stateDir), "manifests", `${releaseId}.json`);
}

export function readConveyorReleaseManifest(path: string): ConveyorReleaseManifest {
  let manifest: ConveyorReleaseManifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8")) as ConveyorReleaseManifest;
  } catch (error) {
    throw new ConveyorRunnerError("release_manifest_read", `release manifest is unreadable: ${String(error)}`);
  }
  validateReleaseManifest(manifest);
  return manifest;
}

function readRuntimeAttestation(path: string): RuntimeMaterializationAttestation {
  let runtime: RuntimeMaterializationAttestation;
  try {
    runtime = JSON.parse(readFileSync(path, "utf8")) as RuntimeMaterializationAttestation;
  } catch (error) {
    throw new ConveyorRunnerError("release_runtime_read", `runtime attestation is unreadable: ${String(error)}`);
  }
  assertRuntimeAttestation(runtime);
  return runtime;
}

export function prepareConveyorRelease(input: {
  runtimeAttestationPath: string;
  stateDir?: string;
  previousManifestPath?: string;
  createdAt?: string;
}): PreparedConveyorRelease {
  const runtime = readRuntimeAttestation(input.runtimeAttestationPath);
  const stateRoot = resolveFactoryStateOverride(input.stateDir);
  const stateMarker = validateFactoryStateMarker(stateRoot);
  const catalog = buildIncumbentAdapterCatalog({
    factoryRoot: runtime.candidate_root,
    stateDir: stateRoot,
    artifactRoot: "/tmp",
    cycleToken: "release-contract",
  });
  const previous = input.previousManifestPath
    ? readConveyorReleaseManifest(input.previousManifestPath)
    : null;
  if (previous && (
    previous.state_namespace !== stateMarker.namespace
    || previous.state_schema_version !== stateMarker.schema_version
    || previous.state_root_id !== stateMarker.root_id
    || previous.state_generation !== stateMarker.generation
  )) {
    throw new ConveyorRunnerError("release_previous_state_mismatch", "previous release is not bound to the active factory state identity");
  }
  const adapterContractHash = conveyorAdapterContractHash(catalog);
  const manifest = createReleaseManifest({
    runtime,
    adapterContractHash,
    stateMarker,
    createdAt: input.createdAt,
    previousReleaseHash: previous?.manifest_hash ?? null,
  });
  const manifestPath = conveyorReleaseManifestPath(manifest.release_id, stateRoot);
  if (existsSync(manifestPath)) {
    const existing = readConveyorReleaseManifest(manifestPath);
    if (
      existing.runtime.runtime_key_sha256 !== runtime.runtime_key_sha256
      || existing.adapter_contract_hash !== adapterContractHash
      || existing.state_root_id !== stateMarker.root_id
      || existing.state_generation !== stateMarker.generation
      || existing.previous_release_hash !== (previous?.manifest_hash ?? null)
    ) {
      throw new ConveyorRunnerError("release_prepare_conflict", "recorded release conflicts with the current immutable runtime, adapter, state, or lineage binding");
    }
    return { manifest: existing, manifest_path: manifestPath, record_status: "existing" };
  }
  const recordStatus = recordReleaseManifest(manifest, stateRoot);
  return {
    manifest,
    manifest_path: manifestPath,
    record_status: recordStatus,
  };
}

function writeImmutable(path: string, value: unknown): "created" | "existing" {
  const body = `${canonicalJson(value)}\n`;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === body) return "existing";
    throw new ConveyorRunnerError("release_immutable_conflict", `immutable release record conflicts at ${path}`);
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
    return "created";
  } catch (error) {
    if (existsSync(path) && readFileSync(path, "utf8") === body) return "existing";
    throw new ConveyorRunnerError("release_write_failed", `failed to write release record ${path}: ${String(error)}`);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function recordReleaseManifest(manifest: ConveyorReleaseManifest, stateDir?: string): "created" | "existing" {
  validateReleaseManifest(manifest);
  const root = resolveFactoryStateOverride(stateDir);
  const marker = validateFactoryStateMarker(root);
  if (
    marker.root_id !== manifest.state_root_id
    || marker.generation !== manifest.state_generation
    || marker.namespace !== manifest.state_namespace
    || marker.schema_version !== manifest.state_schema_version
  ) {
    throw new ConveyorRunnerError("release_state_identity_mismatch", "release manifest is not bound to the active state identity");
  }
  return writeImmutable(conveyorReleaseManifestPath(manifest.release_id, stateDir), manifest);
}

export function planRollback(input: {
  from: ConveyorReleaseManifest;
  to: ConveyorReleaseManifest;
}): ConveyorRollbackPlan {
  validateReleaseManifest(input.from);
  validateReleaseManifest(input.to);
  if (input.from.previous_release_hash !== input.to.manifest_hash) {
    throw new ConveyorRunnerError("rollback_lineage_mismatch", "rollback target is not the exact predecessor release");
  }
  if (
    input.from.state_namespace !== input.to.state_namespace
    || input.from.state_schema_version !== input.to.state_schema_version
    || input.from.state_root_id !== input.to.state_root_id
    || input.from.state_generation !== input.to.state_generation
  ) {
    throw new ConveyorRunnerError("rollback_state_incompatible", "rollback cannot cross factory state identity or generation");
  }
  const unsigned: Omit<ConveyorRollbackPlan, "plan_hash"> = {
    schema_version: CONVEYOR_RELEASE_SCHEMA_VERSION,
    from_release_id: input.from.release_id,
    from_manifest_hash: input.from.manifest_hash,
    to_release_id: input.to.release_id,
    to_manifest_hash: input.to.manifest_hash,
    state_root_id: input.from.state_root_id,
    state_generation: input.from.state_generation,
    preserves_state: true,
    activation_ceiling: CONVEYOR_RELEASE_ACTIVATION_CEILING,
  };
  return { ...unsigned, plan_hash: sha256(canonicalJson(unsigned)) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (command !== "prepare") {
    throw new ConveyorRunnerError("release_usage", "usage: factory-conveyor-release.ts prepare --runtime-attestation <path> --state-dir <path> [--previous-manifest <path>]");
  }
  const runtimeAttestationPath = value("--runtime-attestation");
  const stateDir = value("--state-dir");
  if (!runtimeAttestationPath || !stateDir) {
    throw new ConveyorRunnerError("release_usage", "prepare requires --runtime-attestation and --state-dir");
  }
  console.log(JSON.stringify(prepareConveyorRelease({
    runtimeAttestationPath,
    stateDir,
    previousManifestPath: value("--previous-manifest"),
  }), null, 2));
}
