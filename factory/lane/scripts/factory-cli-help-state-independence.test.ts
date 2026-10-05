import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_HELP_ONLY_STATE_ROOT, legacyFactoryStateRoot } from "./factory-state-root";

const tempRoots: string[] = [];
const entrypoints = ["swarm-exec.ts", "dispatcher.ts", "auto-merge-lane.ts"];

type StateEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; size: number; contentSha256: string }
  | { path: string; kind: "symlink"; mode: number; target: string }
  | { path: string; kind: "other"; mode: number; size: number };

type StateSnapshot =
  | { kind: "absent" }
  | { kind: "present"; entries: StateEntry[] };

function snapshotStatePath(root: string): StateSnapshot {
  try {
    lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }

  const entries: StateEntry[] = [];
  const visit = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relativePath, kind: "symlink", mode: stat.mode, target: readlinkSync(path) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relativePath, kind: "directory", mode: stat.mode });
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name));
      return;
    }
    if (stat.isFile()) {
      const content = readFileSync(path);
      entries.push({
        path: relativePath,
        kind: "file",
        mode: stat.mode,
        size: stat.size,
        contentSha256: createHash("sha256").update(content).digest("hex"),
      });
      return;
    }
    entries.push({ path: relativePath, kind: "other", mode: stat.mode, size: stat.size });
  };

  visit(root, ".");
  return { kind: "present", entries };
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("Factory CLI help state independence", () => {
  test("real help entrypoints exit zero without Factory state and create no state path", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "factory-help-state-independence-"));
    tempRoots.push(sandbox);
    const cwd = join(sandbox, "cwd");
    const home = join(sandbox, "home");
    const runtimeTmp = join(sandbox, "tmp");
    mkdirSync(cwd);
    mkdirSync(home);
    mkdirSync(runtimeTmp);

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: runtimeTmp };
    delete env.FACTORY_STATE_DIR;
    delete env.FACTORY_STATE_MODE;
    delete env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT;

    const watchedStatePaths = [
      FACTORY_HELP_ONLY_STATE_ROOT,
      legacyFactoryStateRoot(),
      join(cwd, "state"),
    ];
    const before = watchedStatePaths.map(snapshotStatePath);

    for (const entrypoint of entrypoints) {
      const result = spawnSync("bun", [join(import.meta.dir, entrypoint), "--help"], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, `${entrypoint}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/usage/i);
      expect(watchedStatePaths.map(snapshotStatePath)).toEqual(before);
    }

    expect(readdirSync(cwd)).toEqual([]);
  });

  test("an explicit invalid production root is never bypassed by help", () => {
    const missingRoot = join(tmpdir(), `factory-help-missing-${process.pid}`);
    expect(existsSync(missingRoot)).toBe(false);
    const result = spawnSync("bun", [join(import.meta.dir, "swarm-exec.ts"), "--help"], {
      env: {
        ...process.env,
        FACTORY_STATE_DIR: missingRoot,
        FACTORY_STATE_MODE: "production",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("factory state root does not exist");
    expect(existsSync(missingRoot)).toBe(false);
  });
});
