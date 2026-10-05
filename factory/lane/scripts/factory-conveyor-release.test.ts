import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIncumbentAdapterCatalog, conveyorAdapterContractHash } from "./factory-conveyor-adapters";
import {
  createReleaseManifest,
  conveyorReleaseManifestPath,
  planRollback,
  planHistoricalRollback,
  prepareConveyorRelease,
  readConveyorReleaseManifest,
  recordReleaseManifest,
  validateReleaseManifest,
} from "./factory-conveyor-release";
import {
  FACTORY_STATE_MARKER,
  FACTORY_STATE_NAMESPACE,
  FACTORY_STATE_SCHEMA_VERSION,
  type FactoryStateMarker,
} from "./factory-state-root";
import { runtimeKey, type RuntimeMaterializationAttestation } from "./runtime-materialize";

const savedEnv = { ...process.env };
const roots: string[] = [];
let stateRoot = "";
let marker: FactoryStateMarker;

function runtime(seed: string, candidateRoot = `/home/workspace/.runtime/factory-conveyor-state-boundary-test-${seed}`): RuntimeMaterializationAttestation {
  const keyInput = {
    merge_commit: seed.repeat(40),
    merge_tree: seed.repeat(40),
    package_json_sha256: seed.repeat(64),
    pnpm_lock_sha256: seed.repeat(64),
    pnpm_workspace_sha256: seed.repeat(64),
    pnpm_version: "8.15.0",
    bun_version: Bun.version,
    os: "linux",
    arch: "x64",
    install_flags: ["--offline", "--frozen-lockfile", "--ignore-scripts"],
    normalized_dependency_graph_sha256: seed.repeat(64),
    template_library_ajv_entrypoint: ".pnpm/ajv@8.17.1/node_modules/ajv/dist/2020.js",
    template_library_ajv_version: "8.17.1",
  };
  return {
    version: 1,
    candidate_root: candidateRoot,
    ...keyInput,
    runtime_key_sha256: runtimeKey(keyInput),
    dependency_link_count: 10,
    tracked_clean: true,
  };
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-release-"));
  roots.push(stateRoot);
  marker = {
    namespace: FACTORY_STATE_NAMESPACE,
    schema_version: FACTORY_STATE_SCHEMA_VERSION,
    root_id: "c75f9077-354d-4b25-b0fb-c7d0914511b5",
    canonical_path: stateRoot,
    generation: 1,
    device: statSync(stateRoot).dev,
    created_at: "2026-08-28T00:00:00.000Z",
  };
  writeFileSync(join(stateRoot, FACTORY_STATE_MARKER), `${JSON.stringify(marker)}\n`);
  process.env.FACTORY_STATE_MODE = "test";
  process.env.FACTORY_STATE_DIR = stateRoot;
  process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("factory conveyor release boundary", () => {
  test("historical rollback preserves original attestation without fabricating a manifest", () => {
    const from = createReleaseManifest({ runtime: runtime("a"), adapterContractHash: "b".repeat(64), stateMarker: marker });
    const historicalRuntime = runtime("c");
    const plan = planHistoricalRollback({ from, historicalRuntime, historicalConfigSha256: "d".repeat(64), stateMarker: marker });
    expect(plan.historical_runtime).toEqual(historicalRuntime);
    expect(plan.preserves_state).toBe(true);
    expect(plan.activation_ceiling).toBe('parity_shadow');
    expect(() => planHistoricalRollback({ from, historicalRuntime, historicalConfigSha256: "d".repeat(64), stateMarker: { ...marker, generation: marker.generation + 1 } })).toThrow('state identity');
    expect(() => planHistoricalRollback({ from, historicalRuntime: { ...historicalRuntime, merge_commit: '0'.repeat(40) }, historicalConfigSha256: "d".repeat(64), stateMarker: marker })).toThrow('immutable inputs');
  });
  test("normalizes cycle-specific adapter catalog values into one contract hash", () => {
    const repository = join(import.meta.dir, "../../..");
    const first = buildIncumbentAdapterCatalog({ factoryRoot: repository, stateDir: stateRoot, artifactRoot: "/tmp/a", cycleToken: "cycle-a" });
    const otherState = mkdtempSync(join(tmpdir(), "factory-conveyor-release-state-"));
    roots.push(otherState);
    const second = buildIncumbentAdapterCatalog({ factoryRoot: repository, stateDir: otherState, artifactRoot: "/tmp/b", cycleToken: "cycle-b" });
    expect(first.catalog_hash).not.toBe(second.catalog_hash);
    expect(conveyorAdapterContractHash(first)).toBe(conveyorAdapterContractHash(second));
  });

  test("creates and validates an exact runtime and state-bound release manifest", () => {
    const manifest = createReleaseManifest({
      runtime: runtime("a"),
      adapterContractHash: "b".repeat(64),
      stateMarker: marker,
      createdAt: "2026-08-28T05:00:00.000Z",
    });
    expect(() => validateReleaseManifest(manifest)).not.toThrow();
    expect(manifest.activation_ceiling).toBe("parity_shadow");
    expect(manifest.previous_release_hash).toBeNull();
  });

  test("records immutable manifests idempotently against the active state identity", () => {
    const manifest = createReleaseManifest({ runtime: runtime("a"), adapterContractHash: "b".repeat(64), stateMarker: marker });
    expect(recordReleaseManifest(manifest, stateRoot)).toBe("created");
    expect(recordReleaseManifest(manifest, stateRoot)).toBe("existing");
    const path = join(stateRoot, "conveyor-runner", "releases", "manifests", `${manifest.release_id}.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(manifest);
  });

  test("prepares an immutable release from the candidate runtime and replays idempotently", () => {
    const repository = join(import.meta.dir, "../../..");
    const attestationPath = join(stateRoot, "runtime-attestation.json");
    writeFileSync(attestationPath, `${JSON.stringify(runtime("a", repository), null, 2)}\n`);
    const first = prepareConveyorRelease({
      runtimeAttestationPath: attestationPath,
      stateDir: stateRoot,
      createdAt: "2026-08-28T06:00:00.000Z",
    });
    expect(first.record_status).toBe("created");
    expect(first.manifest.adapter_contract_hash).toBe(
      conveyorAdapterContractHash(buildIncumbentAdapterCatalog({
        factoryRoot: repository,
        stateDir: stateRoot,
        artifactRoot: "/tmp",
        cycleToken: "another-cycle",
      })),
    );
    expect(first.manifest_path).toBe(conveyorReleaseManifestPath(first.manifest.release_id, stateRoot));
    expect(readConveyorReleaseManifest(first.manifest_path)).toEqual(first.manifest);

    const replay = prepareConveyorRelease({ runtimeAttestationPath: attestationPath, stateDir: stateRoot });
    expect(replay.record_status).toBe("existing");
    expect(replay.manifest).toEqual(first.manifest);
  });

  test("rejects a runtime attestation whose immutable key was altered", () => {
    const altered = { ...runtime("a"), merge_tree: "c".repeat(40) };
    expect(() => createReleaseManifest({ runtime: altered, adapterContractHash: "b".repeat(64), stateMarker: marker })).toThrow(/runtime attestation key/);
  });

  test("builds a state-preserving rollback plan only to the exact predecessor", () => {
    const previous = createReleaseManifest({ runtime: runtime("a"), adapterContractHash: "b".repeat(64), stateMarker: marker });
    const current = createReleaseManifest({
      runtime: runtime("c"),
      adapterContractHash: "d".repeat(64),
      stateMarker: marker,
      previousReleaseHash: previous.manifest_hash,
    });
    expect(planRollback({ from: current, to: previous })).toMatchObject({
      from_release_id: current.release_id,
      to_release_id: previous.release_id,
      state_root_id: marker.root_id,
      preserves_state: true,
      activation_ceiling: "parity_shadow",
    });
  });

  test("fails closed when rollback would cross a state generation", () => {
    const previous = createReleaseManifest({ runtime: runtime("a"), adapterContractHash: "b".repeat(64), stateMarker: marker });
    const nextMarker = { ...marker, generation: 2 };
    const current = createReleaseManifest({
      runtime: runtime("c"),
      adapterContractHash: "d".repeat(64),
      stateMarker: nextMarker,
      previousReleaseHash: previous.manifest_hash,
    });
    expect(() => planRollback({ from: current, to: previous })).toThrow(/state identity or generation/);
  });

  test("fails closed when the active state marker differs from the release binding", () => {
    const manifest = createReleaseManifest({ runtime: runtime("a"), adapterContractHash: "b".repeat(64), stateMarker: marker });
    const changed = { ...marker, generation: 2 };
    writeFileSync(join(stateRoot, FACTORY_STATE_MARKER), `${JSON.stringify(changed)}\n`);
    expect(() => recordReleaseManifest(manifest, stateRoot)).toThrow(/active state identity/);
  });
});
