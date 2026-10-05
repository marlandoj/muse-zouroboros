/**
 * Deploy-root dependency readiness (ZOU-1457).
 *
 * A conveyor deploy root is a git worktree cut from canonical main. `git
 * worktree add` materializes tracked files only, so `node_modules/` and every
 * built `dist/` entrypoint are absent until someone runs install + build. The
 * conveyor never did, so a freshly rotated root aborted at step 0 on
 * unresolvable modules for as long as it stayed live.
 *
 * The gaps are DERIVED from the workspace rather than hardcoded, so a package
 * added later is covered without touching this file:
 *   - every workspace package that declares dependencies needs `node_modules/`
 *   - every `dist/` entrypoint a package advertises via main/module/types/exports
 *     needs to exist on disk
 *
 * Healing is `pnpm install --frozen-lockfile` then `pnpm -r build`, both
 * idempotent, and runs only when a gap is present.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalFactoryPath, EXTERNAL_FACTORY_RELEASES, insideFactoryPath, loadFactoryPathProfile } from "../../../packages/swarm/src/transport/factory-path-profile";

export const INSTALL_TIMEOUT_MS = 300_000;
export const BUILD_TIMEOUT_MS = 300_000;

export interface ReadinessGap {
  kind: "node_modules" | "dist_entrypoint";
  workspacePackage: string;
  path: string;
}

export interface ReadinessResult {
  ok: boolean;
  root: string;
  gaps: ReadinessGap[];
  healed: boolean;
  detail: string;
}

/** Walk up from a directory to the workspace root (the dir holding pnpm-workspace.yaml). */
export function findWorkspaceRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse the flat `packages:` list out of pnpm-workspace.yaml.
 * The file is a single sequence of quoted globs; a YAML dependency here would
 * itself be an unresolvable module in exactly the state this check detects.
 */
export function parseWorkspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const m = inPackages ? line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/) : null;
    if (m) globs.push(m[1]);
  }
  return globs;
}

/** Resolve workspace globs to existing package directories. Supports a trailing `/*`. */
export function resolveWorkspacePackages(root: string, globs: string[]): string[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const parent = join(root, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent)) {
        const dir = join(parent, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) dirs.push(dir);
      }
      continue;
    }
    const dir = join(root, glob);
    if (existsSync(join(dir, "package.json"))) dirs.push(dir);
  }
  return dirs.sort();
}

/** Collect every `./dist/...` entrypoint a package advertises. */
export function distEntrypoints(pkg: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const consider = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("./dist/")) found.add(value.slice(2));
      return;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) consider(nested);
    }
  };
  consider(pkg.main);
  consider(pkg.module);
  consider(pkg.types);
  consider(pkg.exports);
  return [...found].sort();
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasDeclaredDependencies(pkg: Record<string, unknown>): boolean {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && Object.keys(deps as object).length > 0) return true;
  }
  return false;
}

/** Enumerate everything install + build should have materialized but did not. */
export function readinessGaps(root: string): ReadinessGap[] {
  const workspaceFile = join(root, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) return [];
  const dirs = resolveWorkspacePackages(root, parseWorkspaceGlobs(readFileSync(workspaceFile, "utf-8")));
  const gaps: ReadinessGap[] = [];
  for (const dir of dirs) {
    const pkg = readPackageJson(dir);
    if (!pkg) continue;
    const name = typeof pkg.name === "string" ? pkg.name : dir.slice(root.length + 1);
    if (hasDeclaredDependencies(pkg) && !existsSync(join(dir, "node_modules"))) {
      gaps.push({ kind: "node_modules", workspacePackage: name, path: join(dir, "node_modules") });
    }
    for (const entry of distEntrypoints(pkg)) {
      const path = join(dir, entry);
      if (!existsSync(path)) gaps.push({ kind: "dist_entrypoint", workspacePackage: name, path });
    }
  }
  return gaps;
}

function describe(gaps: ReadinessGap[]): string {
  const missingModules = gaps.filter((g) => g.kind === "node_modules").map((g) => g.workspacePackage);
  const missingDist = gaps.filter((g) => g.kind === "dist_entrypoint").map((g) => g.workspacePackage);
  const parts: string[] = [];
  if (missingModules.length > 0) parts.push(`node_modules absent for ${[...new Set(missingModules)].join(", ")}`);
  if (missingDist.length > 0) parts.push(`unbuilt dist entrypoints for ${[...new Set(missingDist)].join(", ")}`);
  return parts.join("; ");
}

function run(command: string, args: string[], cwd: string, timeout: number, env: NodeJS.ProcessEnv): { code: number; detail: string } {
  const r = spawnSync(command, args, { cwd, encoding: "utf-8", timeout, env });
  if (r.status === 0) return { code: 0, detail: "" };
  const stderr = (r.stderr ?? "").trim().split("\n").slice(-4).join(" | ");
  const reason = r.signal ? `signal ${r.signal}` : r.error ? String(r.error.message) : `exit ${r.status ?? 1}`;
  return { code: r.status ?? 1, detail: `${command} ${args.join(" ")} failed (${reason})${stderr ? `: ${stderr}` : ""}` };
}

/**
 * Verify the deploy root is dependency-ready, healing it once when it is not.
 * Set FACTORY_SMOKE_NO_HEAL=1 to report gaps without attempting to close them.
 */
export function ensureDeployRootReady(from: string, env: NodeJS.ProcessEnv = process.env): ReadinessResult {
  const external = insideFactoryPath(EXTERNAL_FACTORY_RELEASES, resolve(from));
  if (external) {
    try {
      if (!loadFactoryPathProfile(env)) throw new Error("external readiness requires a pinned Factory profile");
      canonicalFactoryPath(from);
    } catch (error) {
      return { ok: false, root: from, gaps: [], healed: false, detail: String(error) };
    }
  }
  const root = findWorkspaceRoot(from);
  if (!root) {
    return { ok: !external, root: from, gaps: [], healed: false, detail: "no pnpm workspace above scripts directory" };
  }
  if (external && dirname(root) !== EXTERNAL_FACTORY_RELEASES) return { ok: false, root, gaps: [], healed: false, detail: "release workspace is outside the pinned namespace" };
  const gaps = readinessGaps(root);
  if (gaps.length === 0) return { ok: true, root, gaps: [], healed: false, detail: "" };

  if (env.FACTORY_SMOKE_NO_HEAL === "1") {
    return { ok: false, root, gaps, healed: false, detail: `${describe(gaps)} (healing disabled)` };
  }

  const install = run("pnpm", ["install", "--frozen-lockfile", ...(external ? ["--offline", "--ignore-scripts"] : [])], root, INSTALL_TIMEOUT_MS, env);
  if (install.code !== 0) return { ok: false, root, gaps, healed: false, detail: install.detail };
  const build = run("pnpm", ["-r", ...(external ? ["--workspace-concurrency=1"] : []), "build"], root, BUILD_TIMEOUT_MS, env);
  if (build.code !== 0) return { ok: false, root, gaps, healed: false, detail: build.detail };

  const remaining = readinessGaps(root);
  if (remaining.length > 0) {
    return { ok: false, root, gaps: remaining, healed: true, detail: `install and build left ${describe(remaining)}` };
  }
  return { ok: true, root, gaps, healed: true, detail: `healed ${gaps.length} gap(s) via install + build` };
}
