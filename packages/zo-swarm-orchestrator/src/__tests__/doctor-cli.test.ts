import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "../../scripts/orchestrate-v5.ts");
const fixtureRoots: string[] = [];

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function createFixture(): { home: string; memoryDb: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "swarm-doctor-"));
  fixtureRoots.push(root);
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const memoryDb = join(root, "memory.db");
  const bridge = join(workspace, "packages/swarm/src/executor/bridges/test-bridge.sh");

  mkdirSync(dirname(bridge), { recursive: true });
  writeFileSync(bridge, "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(memoryDb, "");
  writeJson(
    join(workspace, "packages/swarm/src/executor/registry/executor-registry.json"),
    {
      executors: [
        {
          id: "test-executor",
          name: "Test Executor",
          executor: "local",
          bridge: "packages/swarm/src/executor/bridges/test-bridge.sh",
        },
      ],
    },
  );
  writeJson(
    join(workspace, "Skills/zo-swarm-orchestrator/assets/persona-registry.json"),
    { personas: [{ id: "developer", name: "Developer" }] },
  );

  return { home, memoryDb, workspace };
}

async function runDoctor(fixture: ReturnType<typeof createFixture>) {
  const proc = Bun.spawn(["bun", SCRIPT, "doctor"], {
    env: {
      ...process.env,
      HOME: fixture.home,
      SWARM_WORKSPACE: fixture.workspace,
      ZO_MEMORY_DB: fixture.memoryDb,
      ZOUROBOROS_MEMORY_DB: fixture.memoryDb,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("swarm doctor CLI", () => {
  test("passes when required state is healthy and agency personas are absent", async () => {
    const result = await runDoctor(createFixture());
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Optional agency personas not configured");
    expect(result.stdout).toContain("Doctor complete");
  });

  test("prefers the canonical monorepo persona registry over the legacy skill copy", async () => {
    const fixture = createFixture();
    const monorepoRegistry = join(fixture.workspace, "packages/swarm/assets/persona-registry.json");
    writeJson(monorepoRegistry, {
      personas: [{ id: "gamedev-game-designer", name: "GameDev · Game Designer" }],
    });
    rmSync(join(fixture.workspace, "Skills/zo-swarm-orchestrator/assets/persona-registry.json"));
    const result = await runDoctor(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(monorepoRegistry);
    expect(result.stdout).toContain("Doctor complete");
  });

  test("fails when a required registry is missing", async () => {
    const fixture = createFixture();
    rmSync(
      join(fixture.workspace, "packages/swarm/src/executor/registry/executor-registry.json"),
    );
    const result = await runDoctor(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Executor registry");
    expect(result.stdout).toContain("Doctor failed");
  });

  test("fails when a registered executor bridge is missing", async () => {
    const fixture = createFixture();
    rmSync(join(fixture.workspace, "packages/swarm/src/executor/bridges/test-bridge.sh"));
    const result = await runDoctor(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("test-executor");
    expect(result.stdout).toContain("Doctor failed");
  });
});
