import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  distEntrypoints,
  ensureDeployRootReady,
  findWorkspaceRoot,
  parseWorkspaceGlobs,
  readinessGaps,
  resolveWorkspacePackages,
} from "./deploy-root-readiness";

const roots: string[] = [];

function makeRoot(workspaceYaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "deploy-root-readiness-"));
  roots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), workspaceYaml);
  return root;
}

function addPackage(root: string, dir: string, pkg: Record<string, unknown>): string {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, "package.json"), JSON.stringify(pkg));
  return full;
}

function materialize(dir: string, relative: string): void {
  const path = join(dir, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** The exact workspace file the conveyor deploy roots carry. */
const PRODUCTION_WORKSPACE = `packages:
  - 'packages/*'
  - 'cli'
  - 'plugins/*'
  - 'tui'
  - 'Projects/software-template-library'
`;

describe("workspace parsing", () => {
  test("parses the production pnpm-workspace.yaml globs in order", () => {
    expect(parseWorkspaceGlobs(PRODUCTION_WORKSPACE)).toEqual([
      "packages/*",
      "cli",
      "plugins/*",
      "tui",
      "Projects/software-template-library",
    ]);
  });

  test("ignores comments and stops at the next top-level key", () => {
    const yaml = `packages:\n  - 'packages/*' # star\n  - 'cli'\nother:\n  - 'ignored'\n`;
    expect(parseWorkspaceGlobs(yaml)).toEqual(["packages/*", "cli"]);
  });

  test("expands star globs and literal paths, skipping dirs without a package.json", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    addPackage(root, "packages/workflow", { name: "zouroboros-workflow" });
    addPackage(root, "packages/swarm", { name: "zouroboros-swarm" });
    mkdirSync(join(root, "packages/not-a-package"), { recursive: true });
    addPackage(root, "Projects/software-template-library", { name: "software-template-library" });

    const dirs = resolveWorkspacePackages(root, parseWorkspaceGlobs(PRODUCTION_WORKSPACE));
    expect(dirs).toEqual(
      [
        join(root, "Projects/software-template-library"),
        join(root, "packages/swarm"),
        join(root, "packages/workflow"),
      ].sort(),
    );
  });

  test("finds the workspace root from a nested scripts directory", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    const scripts = join(root, "Projects/zouroboros-software-factory/scripts");
    mkdirSync(scripts, { recursive: true });
    expect(findWorkspaceRoot(scripts)).toBe(root);
  });
});

describe("dist entrypoint extraction", () => {
  test("collects nested export conditions, main, module and types", () => {
    expect(
      distEntrypoints({
        main: "./dist/index.js",
        types: "./dist/index.d.ts",
        exports: {
          ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
          "./plan-gate": { import: "./dist/plan-gate/index.js", types: "./dist/plan-gate/index.d.ts" },
        },
      }),
    ).toEqual(["dist/index.d.ts", "dist/index.js", "dist/plan-gate/index.d.ts", "dist/plan-gate/index.js"]);
  });

  test("ignores entrypoints that are not built artifacts", () => {
    expect(distEntrypoints({ main: "./src/index.ts", exports: { ".": "./index.js" } })).toEqual([]);
  });
});

describe("readiness gaps", () => {
  /**
   * ZOU-1457 regression. A deploy root is a git worktree, so tracked files are
   * present while node_modules and dist are not. This is the exact production
   * signature: template-library could not resolve ajv, and swarm could not
   * resolve zouroboros-workflow/plan-gate because dist was never built.
   */
  test("reports the production signature of an uninstalled deploy root", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    addPackage(root, "Projects/software-template-library", {
      name: "software-template-library",
      dependencies: { ajv: "8.17.1" },
    });
    addPackage(root, "packages/workflow", {
      name: "zouroboros-workflow",
      dependencies: { yaml: "^2.9.0" },
      exports: { "./plan-gate": { import: "./dist/plan-gate/index.js" } },
    });

    const gaps = readinessGaps(root);
    expect(gaps.filter((g) => g.kind === "node_modules").map((g) => g.workspacePackage).sort()).toEqual([
      "software-template-library",
      "zouroboros-workflow",
    ]);
    expect(gaps.filter((g) => g.kind === "dist_entrypoint").map((g) => g.workspacePackage)).toEqual([
      "zouroboros-workflow",
    ]);
  });

  test("reports nothing once install and build have materialized everything", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    const lib = addPackage(root, "Projects/software-template-library", {
      name: "software-template-library",
      dependencies: { ajv: "8.17.1" },
    });
    mkdirSync(join(lib, "node_modules"), { recursive: true });
    const workflow = addPackage(root, "packages/workflow", {
      name: "zouroboros-workflow",
      dependencies: { yaml: "^2.9.0" },
      exports: { "./plan-gate": { import: "./dist/plan-gate/index.js" } },
    });
    mkdirSync(join(workflow, "node_modules"), { recursive: true });
    materialize(workflow, "dist/plan-gate/index.js");

    expect(readinessGaps(root)).toEqual([]);
  });

  test("a package declaring no dependencies never needs node_modules", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    addPackage(root, "packages/personas", { name: "zouroboros-personas" });
    expect(readinessGaps(root)).toEqual([]);
  });

  test("a dist entrypoint gap is reported even when node_modules is present", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    const workflow = addPackage(root, "packages/workflow", {
      name: "zouroboros-workflow",
      dependencies: { yaml: "^2.9.0" },
      exports: { ".": { import: "./dist/index.js" } },
    });
    mkdirSync(join(workflow, "node_modules"), { recursive: true });

    expect(readinessGaps(root)).toEqual([
      { kind: "dist_entrypoint", workspacePackage: "zouroboros-workflow", path: join(workflow, "dist/index.js") },
    ]);
  });
});

describe("ensureDeployRootReady", () => {
  test("external roots cannot report ready or heal without a pinned profile", () => {
    const result = ensureDeployRootReady('/home/.z/factory/releases/factory-conveyor-state-boundary-unbound/scripts', {});
    expect(result.ok).toBe(false);
    expect(result.healed).toBe(false);
    expect(result.detail).toContain('pinned Factory profile');
  });
  test("fails closed without healing when healing is disabled", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    addPackage(root, "Projects/software-template-library", {
      name: "software-template-library",
      dependencies: { ajv: "8.17.1" },
    });
    const scripts = join(root, "Projects/zouroboros-software-factory/scripts");
    mkdirSync(scripts, { recursive: true });

    const result = ensureDeployRootReady(scripts, { FACTORY_SMOKE_NO_HEAL: "1" });
    expect(result.ok).toBe(false);
    expect(result.healed).toBe(false);
    expect(result.root).toBe(root);
    expect(result.detail).toContain("software-template-library");
    expect(result.detail).toContain("healing disabled");
  });

  test("passes without healing when the root is already ready", () => {
    const root = makeRoot(PRODUCTION_WORKSPACE);
    addPackage(root, "packages/personas", { name: "zouroboros-personas" });
    const scripts = join(root, "Projects/zouroboros-software-factory/scripts");
    mkdirSync(scripts, { recursive: true });

    const result = ensureDeployRootReady(scripts, { FACTORY_SMOKE_NO_HEAL: "1" });
    expect(result.ok).toBe(true);
    expect(result.healed).toBe(false);
    expect(result.gaps).toEqual([]);
  });

  test("degrades to a pass when there is no workspace above the scripts directory", () => {
    const bare = mkdtempSync(join(tmpdir(), "deploy-root-readiness-bare-"));
    roots.push(bare);
    const result = ensureDeployRootReady(bare, { FACTORY_SMOKE_NO_HEAL: "1" });
    expect(result.ok).toBe(true);
    expect(result.gaps).toEqual([]);
  });
});
