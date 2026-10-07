import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorFactory, installFactory, packageCheck } from "./factory-package-cli";

const roots: string[] = [];

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-package-test-"));
  roots.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });
  const transport = join(root, 'packages/zo-swarm-orchestrator/src/transport');
  mkdirSync(transport, { recursive: true });
  copyFileSync(join(import.meta.dir, '../../../packages/zo-swarm-orchestrator/src/transport/factory-path-profile.ts'), join(transport, 'factory-path-profile.ts'));
  mkdirSync(join(root, "Skills"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{\"name\":\"test-checkout\",\"private\":true}\n");
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("factory package", () => {
  test("publishable boundary excludes runtime material", () => {
    const result = packageCheck();
    expect(result.ok, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.filter((check) => check.status === "FAIL")).toEqual([]);
  });

  test("installer materializes safe components and independent state", () => {
    const root = checkout();
    const stateDir = join(root, "factory-state");
    const result = installFactory({ root, stateDir });
    expect(result.scheduler_configured).toBe(false);
    expect(existsSync(join(result.factory_dir, "scripts", "dispatcher.ts"))).toBe(true);
    expect(existsSync(join(result.factory_dir, "contracts", "factory-runtime-state-v1.md"))).toBe(true);
    expect(existsSync(join(result.factory_dir, "evaluations"))).toBe(false);
    expect(existsSync(join(result.factory_dir, "state"))).toBe(false);
    const config = JSON.parse(readFileSync(join(result.factory_dir, "config", "runtime-flags.json"), "utf8"));
    expect(config.flags.SF_LINEAR_SYNC).toBe("0");
    expect(config.flags.SF010_AUTOMERGE).toBe("0");
    expect(config.flags.FACTORY_MODEL_REVIEW).toBe("off");
    expect(config.flags.FACTORY_RECEIPT_SHADOW_DB_PATH.startsWith(stateDir)).toBe(true);
    expect(existsSync(join(stateDir, ".factory-state-root.json"))).toBe(true);
  });

  test("code update preserves operator runtime configuration", () => {
    const root = checkout();
    const stateDir = join(root, "factory-state");
    const first = installFactory({ root, stateDir });
    const configPath = join(first.factory_dir, "config", "runtime-flags.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.flags.SF004_METRICS = "1";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => installFactory({ root, stateDir })).toThrow("already exists");
    const updated = installFactory({ root, stateDir, force: true });
    expect(updated.config).toBe("preserved");
    expect(JSON.parse(readFileSync(configPath, "utf8")).flags.SF004_METRICS).toBe("1");
  });

  test("doctor validates the required package and state boundary", () => {
    const root = checkout();
    const installed = installFactory({ root, stateDir: join(root, "factory-state") });
    const result = doctorFactory(root, installed.factory_dir);
    expect(result.ok).toBe(true);
    expect(result.checks.some((check) => check.label === "conveyor trigger" && check.status === "WARN")).toBe(true);
  });
});
