import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACTORY_STATE_MARKER,
  FACTORY_STATE_NAMESPACE,
  FACTORY_STATE_SCHEMA_VERSION,
  FACTORY_HELP_ONLY_STATE_ROOT,
  FactoryStateRootError,
  factoryStatePath,
  factoryStatePathForProject,
  factoryStateRoot,
  isFactoryHelpOnlyInvocation,
  legacyFactoryStateRoot,
  resolveFactoryStateOverride,
  validateFactoryStateMarker,
} from "./factory-state-root";

const savedEnv = { ...process.env };
let tempRoot = "";

function writeMarker(root: string, overrides: Record<string, unknown> = {}): void {
  const device = statSync(root).dev;
  writeFileSync(join(root, FACTORY_STATE_MARKER), JSON.stringify({
    namespace: FACTORY_STATE_NAMESPACE,
    schema_version: FACTORY_STATE_SCHEMA_VERSION,
    root_id: "33ae3d26-bc0a-4b03-9c91-df93f9d228e8",
    canonical_path: root,
    generation: 1,
    device,
    created_at: "2026-08-11T00:00:00.000Z",
    ...overrides,
  }));
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "factory-state-root-"));
  process.env.FACTORY_STATE_MODE = "production";
  process.env.FACTORY_STATE_DIR = tempRoot;
  delete process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT;
  writeMarker(tempRoot);
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

describe("factory state root", () => {
  test("recognizes only exact allowlisted help-only invocations", () => {
    for (const entrypoint of ["swarm-exec.ts", "dispatcher.ts", "auto-merge-lane.ts"]) {
      expect(isFactoryHelpOnlyInvocation(`/checkout/scripts/${entrypoint}`, ["--help"])).toBe(true);
      expect(isFactoryHelpOnlyInvocation(`/checkout/scripts/${entrypoint}`, ["-h"])).toBe(true);
      expect(isFactoryHelpOnlyInvocation(`/checkout/scripts/${entrypoint}`, ["--help", "-h"])).toBe(true);
      expect(isFactoryHelpOnlyInvocation(`/checkout/scripts/${entrypoint}`, [])).toBe(false);
      expect(isFactoryHelpOnlyInvocation(`/checkout/scripts/${entrypoint}`, ["--help", "status"])).toBe(false);
    }
    expect(isFactoryHelpOnlyInvocation("/checkout/scripts/factory-state-root.ts", ["--help"])).toBe(false);
    expect(isFactoryHelpOnlyInvocation("/checkout/scripts/swarm-exec.ts.backup", ["--help"])).toBe(false);
  });

  test("returns the non-production sentinel only when options and state configuration are absent", () => {
    const savedArgv = [...process.argv];
    delete process.env.FACTORY_STATE_DIR;
    delete process.env.FACTORY_STATE_MODE;
    delete process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT;
    process.argv.splice(0, process.argv.length, savedArgv[0]!, "/checkout/scripts/swarm-exec.ts", "--help");
    try {
      expect(factoryStateRoot()).toBe(FACTORY_HELP_ONLY_STATE_ROOT);
      expect(() => factoryStateRoot({})).toThrow(FactoryStateRootError);
      expect(() => factoryStateRoot({ env: {} })).toThrow(FactoryStateRootError);
    } finally {
      process.argv.splice(0, process.argv.length, ...savedArgv);
    }
  });

  test("resolves a marked external root and contained child", () => {
    expect(factoryStateRoot()).toBe(tempRoot);
    expect(factoryStatePath("pool", "queue.json")).toBe(join(tempRoot, "pool", "queue.json"));
    expect(validateFactoryStateMarker(tempRoot).generation).toBe(1);
  });

  test("fails closed when production root or marker is missing", () => {
    delete process.env.FACTORY_STATE_DIR;
    try {
      factoryStateRoot();
      throw new Error("expected factory state root resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(FactoryStateRootError);
      expect((error as FactoryStateRootError).code).toBe("root_required");
    }
    process.env.FACTORY_STATE_DIR = tempRoot;
    rmSync(join(tempRoot, FACTORY_STATE_MARKER));
    expect(() => factoryStateRoot()).toThrow(/marker is missing/);
  });

  test("rejects relative, noncanonical, runtime-contained, and traversal input", () => {
    process.env.FACTORY_STATE_DIR = "relative/state";
    expect(() => factoryStateRoot()).toThrow(/absolute/);
    process.env.FACTORY_STATE_DIR = `${tempRoot}/`;
    expect(() => factoryStateRoot()).toThrow(/canonical/);
    process.env.FACTORY_STATE_DIR = "/home/workspace/.runtime/factory-conveyor-test/Projects/zouroboros-software-factory/state";
    expect(() => factoryStateRoot({ requireMarker: false })).toThrow(/independent/);
    process.env.FACTORY_STATE_DIR = tempRoot;
    expect(() => factoryStatePath("../escape")).toThrow(/escapes/);
  });

  test("rejects a symlink root and mismatched identity", () => {
    const target = mkdtempSync(join(tmpdir(), "factory-state-target-"));
    const link = `${target}-link`;
    symlinkSync(target, link);
    process.env.FACTORY_STATE_DIR = link;
    expect(() => factoryStateRoot()).toThrow(/real directory/);
    rmSync(link);
    rmSync(target, { recursive: true, force: true });

    process.env.FACTORY_STATE_DIR = tempRoot;
    writeMarker(tempRoot, { canonical_path: `${tempRoot}-other` });
    expect(() => factoryStateRoot()).toThrow(/identity/);
  });

  test("requires production overrides to remain contained", () => {
    const child = join(tempRoot, "pool");
    mkdirSync(child);
    expect(resolveFactoryStateOverride(child)).toBe(child);
    expect(() => resolveFactoryStateOverride(join(tmpdir(), "outside"))).toThrow(/beneath/);
  });

  test("permits explicit compatibility and test-only outside-root modes", () => {
    process.env.FACTORY_STATE_MODE = "compatibility";
    delete process.env.FACTORY_STATE_DIR;
    expect(factoryStateRoot()).toBe(legacyFactoryStateRoot());
    expect(factoryStatePathForProject(join(tmpdir(), "compat-checkout"), "pool", "queue.json"))
      .toBe(join(tmpdir(), "compat-checkout", "state", "pool", "queue.json"));

    process.env.FACTORY_STATE_MODE = "test";
    process.env.FACTORY_STATE_DIR = tempRoot;
    process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
    expect(resolveFactoryStateOverride(join(tmpdir(), "outside"))).toBe(join(tmpdir(), "outside"));
    expect(factoryStatePathForProject(join(tmpdir(), "checkout"), "pool", "queue.json"))
      .toBe(join(tmpdir(), "checkout", "state", "pool", "queue.json"));

    delete process.env.FACTORY_STATE_DIR;
    expect(factoryStateRoot()).toBe(legacyFactoryStateRoot());
  });

  test("permits unmarked roots only in test mode unless marker validation is explicit", () => {
    rmSync(join(tempRoot, FACTORY_STATE_MARKER));
    process.env.FACTORY_STATE_MODE = "test";
    expect(factoryStateRoot()).toBe(tempRoot);
    expect(() => factoryStateRoot({ requireMarker: true })).toThrow(/marker is missing/);
  });

  test("ignores checkout-local roots in production mode", () => {
    expect(factoryStatePathForProject(join(tmpdir(), "other-checkout"), "pool", "queue.json"))
      .toBe(join(tempRoot, "pool", "queue.json"));
  });
});
