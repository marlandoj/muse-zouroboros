#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const FACTORY_RELATIVE_DIR = join("Projects", "zouroboros-software-factory");
const STATE_MARKER = ".factory-state-root.json";
const COPY_DIRECTORIES = ["scripts", "contracts", "fixtures", "scenarios"] as const;
const COPY_FILES = ["package.json", "README.md", "MVP_PATH.md", "OPERATORS_MANUAL.md", "LICENSE"] as const;
const REQUIRED_FACTORY_FILES = [
  "package.json",
  "scripts/factory-package-cli.ts",
  "scripts/factory-mvp.ts",
  "scripts/dispatcher.ts",
  "scripts/prespec-runner.ts",
  "scripts/swarm-exec.ts",
  "scripts/runtime-config.ts",
  "contracts/factory-runtime-state-v1.md",
  "config/factory-state-owners-v1.json",
  "config/runtime-flags.json",
] as const;

interface ParsedArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

export interface InstallOptions {
  root: string;
  factoryDir?: string;
  stateDir?: string;
  force?: boolean;
  resetConfig?: boolean;
  sourceRoot?: string;
}

export interface InstallResult {
  root: string;
  factory_dir: string;
  state_dir: string;
  package_version: string;
  config: "created" | "preserved" | "reset";
  copied_files: number;
  scheduler_configured: false;
}

export interface DoctorCheck {
  status: "PASS" | "WARN" | "FAIL";
  label: string;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  root: string;
  factory_dir: string;
  checks: DoctorCheck[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function stringFlag(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return typeof value === "string" ? value : undefined;
}

function canonicalPath(path: string, label: string): string {
  if (!path || path.includes("\0")) throw new Error(`${label} must be a non-empty path`);
  const canonical = resolve(path);
  if (canonical === sep) throw new Error(`${label} must not be the filesystem root`);
  return canonical;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) throw new Error(`path escapes destination: ${candidate}`);
}

function readPackageVersion(sourceRoot = PACKAGE_ROOT): string {
  const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version) throw new Error("factory package version is missing");
  return manifest.version;
}

function writeAtomic(path: string, content: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content);
  if (mode !== undefined) chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function copyTree(sourceRoot: string, source: string, destinationRoot: string, destination: string): number {
  assertContained(sourceRoot, source);
  assertContained(destinationRoot, destination);
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error(`refusing to package symlink: ${source}`);
  if (sourceStat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    let count = 0;
    for (const entry of readdirSync(source).sort()) {
      count += copyTree(sourceRoot, join(source, entry), destinationRoot, join(destination, entry));
    }
    return count;
  }
  if (!sourceStat.isFile()) throw new Error(`unsupported package entry: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  copyFileSync(source, temporary);
  chmodSync(temporary, sourceStat.mode & 0o777);
  renameSync(temporary, destination);
  return 1;
}

function initializeStateRoot(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const stateStat = lstatSync(stateDir);
  if (!stateStat.isDirectory() || stateStat.isSymbolicLink()) throw new Error("factory state root must be a real directory");
  if (realpathSync(stateDir) !== stateDir) throw new Error("factory state root must be canonical");
  const markerPath = join(stateDir, STATE_MARKER);
  if (existsSync(markerPath)) return;
  if (readdirSync(stateDir).length > 0) throw new Error("refusing to claim a non-empty unmarked factory state directory");
  writeAtomic(markerPath, `${JSON.stringify({
    namespace: "zouroboros-software-factory",
    schema_version: 1,
    root_id: randomUUID(),
    canonical_path: stateDir,
    generation: 0,
    device: stateStat.dev,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`, 0o600);
}

function safeRuntimeConfig(sourceRoot: string, root: string, stateDir: string): string {
  const template = readFileSync(join(sourceRoot, "templates", "config", "runtime-flags.json"), "utf8");
  const materialized = template
    .replaceAll("/__FACTORY_STATE_DIR__", stateDir)
    .replaceAll("/__ZOUROBOROS_ROOT__", root);
  const parsed = JSON.parse(materialized) as { updated_at: string; flags: Record<string, string> };
  parsed.updated_at = new Date().toISOString();
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertZouroborosRoot(root: string): void {
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "packages"))) {
    throw new Error(`${root} is not a Zouroboros checkout; expected package.json and packages/`);
  }
}

export function installFactory(options: InstallOptions): InstallResult {
  const sourceRoot = canonicalPath(options.sourceRoot ?? PACKAGE_ROOT, "source root");
  const root = canonicalPath(options.root, "Zouroboros root");
  assertZouroborosRoot(root);
  const factoryDir = canonicalPath(options.factoryDir ?? join(root, FACTORY_RELATIVE_DIR), "factory directory");
  assertContained(root, factoryDir);
  const stateDir = canonicalPath(
    options.stateDir ?? join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "zouroboros", "factory"),
    "factory state directory",
  );
  const existing = existsSync(factoryDir) && readdirSync(factoryDir).length > 0;
  if (existing && !options.force) throw new Error(`${factoryDir} already exists; use --force for a code-only update`);

  mkdirSync(factoryDir, { recursive: true });
  let copiedFiles = 0;
  for (const directory of COPY_DIRECTORIES) {
    copiedFiles += copyTree(sourceRoot, join(sourceRoot, directory), factoryDir, join(factoryDir, directory));
  }
  for (const file of COPY_FILES) {
    copiedFiles += copyTree(sourceRoot, join(sourceRoot, file), factoryDir, join(factoryDir, file));
  }
  copiedFiles += copyTree(
    sourceRoot,
    join(sourceRoot, "config", "factory-state-owners-v1.json"),
    factoryDir,
    join(factoryDir, "config", "factory-state-owners-v1.json"),
  );

  initializeStateRoot(stateDir);
  const configPath = join(factoryDir, "config", "runtime-flags.json");
  let config: InstallResult["config"] = "created";
  if (existsSync(configPath) && !options.resetConfig) {
    config = "preserved";
  } else {
    config = existsSync(configPath) ? "reset" : "created";
    writeAtomic(configPath, safeRuntimeConfig(sourceRoot, root, stateDir), 0o600);
  }

  const envPath = join(factoryDir, "factory.env");
  if (!existsSync(envPath) || options.resetConfig) {
    writeAtomic(envPath, [
      `export ZOUROBOROS_ROOT=${shellQuote(root)}`,
      `export ZOUROBOROS_WORKSPACE=${shellQuote(root)}`,
      `export FACTORY_STATE_DIR=${shellQuote(stateDir)}`,
      "",
    ].join("\n"), 0o600);
  }

  const packageVersion = readPackageVersion(sourceRoot);
  writeAtomic(join(factoryDir, ".factory-package.json"), `${JSON.stringify({
    schema_version: 1,
    package: "zouroboros-factory",
    package_version: packageVersion,
    installed_at: new Date().toISOString(),
    root,
    factory_dir: factoryDir,
    state_dir: stateDir,
    scheduler_configured: false,
    excluded: ["state", "evaluations", "investigations", "serial promotions", "executor credentials", "experiment artifacts"],
  }, null, 2)}\n`, 0o600);

  return {
    root,
    factory_dir: factoryDir,
    state_dir: stateDir,
    package_version: packageVersion,
    config,
    copied_files: copiedFiles,
    scheduler_configured: false,
  };
}

function executableCheck(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function validateStateMarker(stateDir: string): string | null {
  try {
    const stat = lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(stateDir) !== stateDir) return "state root is not a canonical real directory";
    const marker = JSON.parse(readFileSync(join(stateDir, STATE_MARKER), "utf8")) as Record<string, unknown>;
    if (marker.namespace !== "zouroboros-software-factory" || marker.schema_version !== 1) return "state marker identity is invalid";
    if (marker.canonical_path !== stateDir || marker.device !== stat.dev) return "state marker does not match the state root";
    if (typeof marker.root_id !== "string" || !/^[0-9a-f-]{36}$/i.test(marker.root_id)) return "state marker root_id is invalid";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function doctorFactory(rootInput: string, factoryDirInput?: string): DoctorResult {
  const root = canonicalPath(rootInput, "Zouroboros root");
  const factoryDir = canonicalPath(factoryDirInput ?? join(root, FACTORY_RELATIVE_DIR), "factory directory");
  const checks: DoctorCheck[] = [];
  checks.push({ status: executableCheck("bun") ? "PASS" : "FAIL", label: "Bun runtime", detail: executableCheck("bun") ? "available" : "bun is not on PATH" });
  checks.push({ status: executableCheck("git") ? "PASS" : "FAIL", label: "Git runtime", detail: executableCheck("git") ? "available" : "git is not on PATH" });
  for (const file of REQUIRED_FACTORY_FILES) {
    checks.push({ status: existsSync(join(factoryDir, file)) ? "PASS" : "FAIL", label: file, detail: existsSync(join(factoryDir, file)) ? "present" : "missing" });
  }

  let stateDir = "";
  try {
    const manifest = JSON.parse(readFileSync(join(factoryDir, ".factory-package.json"), "utf8")) as { state_dir?: unknown };
    stateDir = typeof manifest.state_dir === "string" ? canonicalPath(manifest.state_dir, "manifest state directory") : "";
  } catch {
    checks.push({ status: "FAIL", label: "install manifest", detail: ".factory-package.json is missing or invalid" });
  }
  if (stateDir) {
    const markerError = validateStateMarker(stateDir);
    checks.push({ status: markerError ? "FAIL" : "PASS", label: "state boundary", detail: markerError ?? stateDir });
  }

  const runtimeValidation = spawnSync("bun", [join(factoryDir, "scripts", "runtime-config.ts"), "validate"], {
    cwd: factoryDir,
    env: { ...process.env, FACTORY_STATE_DIR: stateDir || process.env.FACTORY_STATE_DIR || "", FACTORY_STATE_MODE: "production" },
    encoding: "utf8",
  });
  checks.push({
    status: runtimeValidation.status === 0 ? "PASS" : "FAIL",
    label: "runtime configuration",
    detail: runtimeValidation.status === 0 ? runtimeValidation.stdout.trim() : (runtimeValidation.stderr || runtimeValidation.stdout).trim().slice(0, 500),
  });

  for (const path of ["packages/zo-swarm-orchestrator", "packages/workflow", "Skills/tier-resolver", "Skills/zouroboros-governance"]) {
    checks.push({
      status: existsSync(join(root, path)) ? "PASS" : "WARN",
      label: path,
      detail: existsSync(join(root, path)) ? "integration source available" : "optional advanced integration unavailable",
    });
  }
  checks.push({
    status: "WARN",
    label: "conveyor trigger",
    detail: "not configured by this package; wire a scheduler or automation only after smoke verification and operator approval",
  });
  return { ok: checks.every((check) => check.status !== "FAIL"), root, factory_dir: factoryDir, checks };
}

export function packageCheck(sourceRoot = PACKAGE_ROOT): { ok: boolean; checks: DoctorCheck[] } {
  const root = canonicalPath(sourceRoot, "source root");
  const checks: DoctorCheck[] = [];
  for (const path of [...COPY_DIRECTORIES, ...COPY_FILES, "templates/config/runtime-flags.json", "config/factory-state-owners-v1.json"]) {
    checks.push({ status: existsSync(join(root, path)) ? "PASS" : "FAIL", label: path, detail: existsSync(join(root, path)) ? "packaged" : "missing" });
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  const unsafe = ["state", "evaluations", "config/runtime-flags.json", "config/serial-promotions"];
  for (const path of unsafe) {
    const included = (manifest.files ?? []).some((entry) => entry === path || entry.startsWith(`${path}/`));
    checks.push({ status: included ? "FAIL" : "PASS", label: `exclude ${path}`, detail: included ? "unsafe runtime material is publishable" : "excluded" });
  }
  const template = JSON.parse(readFileSync(join(root, "templates", "config", "runtime-flags.json"), "utf8")) as { flags: Record<string, string> };
  const activationValues = new Set(["1", "shadow", "enforce", "act", "labeled", "unlabeled"]);
  const activated = Object.entries(template.flags).filter(([key, value]) =>
    activationValues.has(value) && !["SF003_POOL_MAX_DISPATCH", "SF_PRESPEC_TOP_N", "SF_PRESPEC_COOLDOWN_HOURS", "FACTORY_INFLIGHT_CAP"].includes(key),
  );
  checks.push({
    status: activated.length === 0 ? "PASS" : "FAIL",
    label: "safe runtime defaults",
    detail: activated.length === 0 ? "all execution and promotion lanes default off" : activated.map(([key]) => key).join(", "),
  });
  return { ok: checks.every((check) => check.status !== "FAIL"), checks };
}

function smokeFactory(rootInput: string): number {
  const root = canonicalPath(rootInput, "Zouroboros root");
  assertZouroborosRoot(root);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "zouroboros-factory-package-"));
  try {
    writeFileSync(join(temporaryRoot, "package.json"), "{\"name\":\"factory-smoke\",\"private\":true}\n");
    symlinkSync(join(root, "packages"), join(temporaryRoot, "packages"), "dir");
    if (existsSync(join(root, "Skills"))) symlinkSync(join(root, "Skills"), join(temporaryRoot, "Skills"), "dir");
    if (existsSync(join(root, "node_modules"))) symlinkSync(join(root, "node_modules"), join(temporaryRoot, "node_modules"), "dir");
    const installed = installFactory({
      root: temporaryRoot,
      sourceRoot: PACKAGE_ROOT,
      stateDir: join(temporaryRoot, "factory-state"),
    });
    const result = spawnSync("bun", [join(installed.factory_dir, "scripts", "factory-mvp.ts"), "smoke"], {
      cwd: installed.factory_dir,
      env: {
        ...process.env,
        ZOUROBOROS_WORKSPACE: temporaryRoot,
        FACTORY_STATE_MODE: "compatibility",
        FACTORY_PERSONA_ROUTING_MODE: "off",
        FACTORY_MODEL_REVIEW: "off",
      },
      encoding: "utf8",
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    return result.status ?? 1;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function findZouroborosRoot(start = process.cwd()): string {
  let candidate = resolve(start);
  while (true) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, "packages"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("cannot locate a Zouroboros checkout; pass --root <path>");
}

function usage(): string {
  return `Zouroboros Factory\n\nCommands:\n  install [--root <checkout>] [--dir <factory-dir>] [--state-dir <dir>] [--force] [--reset-config] [--json]\n  doctor [--root <checkout>] [--dir <factory-dir>] [--json]\n  smoke [--root <checkout>]\n  package-check [--json]\n`;
}

function printChecks(checks: DoctorCheck[]): void {
  for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.label}: ${check.detail}`);
}

export async function runFactoryPackageCli(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help" || parsed.flags.has("help")) {
    console.log(usage());
    return 0;
  }
  const root = canonicalPath(stringFlag(parsed.flags, "root") ?? findZouroborosRoot(), "Zouroboros root");
  if (parsed.command === "install") {
    const result = installFactory({
      root,
      factoryDir: stringFlag(parsed.flags, "dir"),
      stateDir: stringFlag(parsed.flags, "state-dir"),
      force: parsed.flags.has("force"),
      resetConfig: parsed.flags.has("reset-config"),
    });
    if (parsed.flags.has("json")) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Installed zouroboros-factory ${result.package_version} to ${result.factory_dir}`);
      console.log(`State root: ${result.state_dir}`);
      console.log(`Runtime config: ${result.config}; conveyor trigger: not configured`);
    }
    return 0;
  }
  if (parsed.command === "doctor") {
    const result = doctorFactory(root, stringFlag(parsed.flags, "dir"));
    if (parsed.flags.has("json")) console.log(JSON.stringify(result, null, 2));
    else printChecks(result.checks);
    return result.ok ? 0 : 1;
  }
  if (parsed.command === "smoke") return smokeFactory(root);
  if (parsed.command === "package-check") {
    const result = packageCheck();
    if (parsed.flags.has("json")) console.log(JSON.stringify(result, null, 2));
    else printChecks(result.checks);
    return result.ok ? 0 : 1;
  }
  console.error(`unknown command: ${parsed.command}\n\n${usage()}`);
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await runFactoryPackageCli();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
